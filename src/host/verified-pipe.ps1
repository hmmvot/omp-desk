<#
OMP host-control peer verification bridge (ADR-0006).

Two modes, both driven by `control-client.ts` with `-NoProfile -NonInteractive`:

  -Mode generation -TargetPid <n>
      Print `!GENERATION <filetime>` for that process, the kernel creation time as
      a FILETIME decimal string. The extension records it right after the
      terminal's process id resolves.

  -Mode bridge -PipeName <name> -ExpectPid <n> [-ExpectCreation <filetime>]
               [-TimeoutSeconds <n>]
      Open the named pipe ONCE, read the server PID from that very handle
      (`GetNamedPipeServerProcessId`), open a query-limited process handle and
      read its kernel creation time, refuse unless both match the expected
      values, then print `!PEER_VERIFIED <pid> <filetime>` and relay bytes between
      the pipe and this process's private stdio:

        stdin  : one base64 line per chunk, decoded and written to the pipe
        stdout : one base64 line per chunk read from the pipe

      Control lines start with `!`; data lines are base64 and never start with
      `!`. Nothing else is ever written to stdout, and frame contents are never
      sent to the PowerShell pipeline, formatting or logging.

Exit codes: 0 normal; 10 pipe unreachable/timeout; 11 connect failed;
12 server PID unavailable; 13 PID mismatch; 14/15 process query failed;
16 generation mismatch; 20 bad arguments.

All of this is a visible refusal path: there is no unchecked fallback, and the
caller must treat EOF or an exit here as an unknown mutation result.
#>
[CmdletBinding()]
param(
	[ValidateSet('generation', 'bridge')]
	[string]$Mode = 'bridge',
	[int]$TargetPid = 0,
	[string]$PipeName = '',
	[int]$ExpectPid = 0,
	[string]$ExpectCreation = '',
	[int]$TimeoutSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::ASCII

$source = @'
using System;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class OmpControlPeer
{
    private const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const int MaxChunkBytes = 65536;
    private const int MaxLineChars = 512 * 1024;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint serverPid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int access, bool inherit, uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static Stream Stdout;
    private static readonly object StdoutLock = new object();

    private static void Emit(string line)
    {
        byte[] bytes = Encoding.ASCII.GetBytes(line + "\n");
        lock (StdoutLock)
        {
            Stdout.Write(bytes, 0, bytes.Length);
            Stdout.Flush();
        }
    }

    private static string CreationTimeOf(uint pid)
    {
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle == IntPtr.Zero) return null;
        try
        {
            long creation, exit, kernel, user;
            if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) return null;
            return creation.ToString(CultureInfo.InvariantCulture);
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    public static int Generation(int pid, Stream stdout)
    {
        Stdout = stdout;
        if (pid <= 0)
        {
            Emit("!ERROR BAD_ARGUMENTS");
            return 20;
        }
        string creation = CreationTimeOf((uint)pid);
        if (creation == null)
        {
            Emit("!ERROR PROCESS_QUERY_FAILED");
            return 15;
        }
        Emit("!GENERATION " + creation);
        return 0;
    }

    public static int Bridge(string pipeName, int expectPid, string expectCreation, int timeoutSeconds, Stream stdin, Stream stdout)
    {
        Stdout = stdout;
        if (pipeName.Length == 0 || expectPid <= 0)
        {
            Emit("!ERROR BAD_ARGUMENTS");
            return 20;
        }

        NamedPipeClientStream pipe;
        try
        {
            pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        }
        catch (Exception)
        {
            Emit("!ERROR PIPE_UNREACHABLE");
            return 11;
        }

        using (pipe)
        {
            try
            {
                pipe.Connect(timeoutSeconds > 0 ? timeoutSeconds * 1000 : 15000);
            }
            catch (TimeoutException)
            {
                Emit("!ERROR PIPE_UNREACHABLE");
                return 10;
            }
            catch (Exception)
            {
                Emit("!ERROR PIPE_UNREACHABLE");
                return 11;
            }

            uint serverPid;
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out serverPid))
            {
                Emit("!ERROR PIPE_SERVER_PID_UNAVAILABLE");
                return 12;
            }
            if ((int)serverPid != expectPid)
            {
                // The pipe is served by a different process than the launched one.
                Emit("!ERROR PIPE_PID_MISMATCH");
                return 13;
            }

            // The process handle is retained for the whole connection: it is the
            // generation proof, not a one-off reading.
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, serverPid);
            if (process == IntPtr.Zero)
            {
                Emit("!ERROR PROCESS_QUERY_FAILED");
                return 14;
            }
            try
            {
                long creation, exit, kernel, user;
                if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
                {
                    Emit("!ERROR PROCESS_QUERY_FAILED");
                    return 15;
                }
                string filetime = creation.ToString(CultureInfo.InvariantCulture);
                if (expectCreation.Length > 0 && !string.Equals(filetime, expectCreation, StringComparison.Ordinal))
                {
                    Emit("!ERROR PIPE_GENERATION_MISMATCH");
                    return 16;
                }

                Emit("!PEER_VERIFIED " + ((int)serverPid).ToString(CultureInfo.InvariantCulture) + " " + filetime);
                Pump(stdin, stdout, pipe);
            }
            finally
            {
                CloseHandle(process);
            }
        }
        return 0;
    }

    private static void Pump(Stream stdin, Stream stdout, NamedPipeClientStream pipe)
    {
        Task toPipe = Task.Run(async () =>
        {
            StreamReader reader = new StreamReader(stdin, Encoding.ASCII, false, 4096, true);
            try
            {
                while (true)
                {
                    string line = await reader.ReadLineAsync().ConfigureAwait(false);
                    if (line == null) break;
                    if (line.Length == 0) continue;
                    if (line.Length > MaxLineChars) break;
                    byte[] bytes;
                    try
                    {
                        bytes = Convert.FromBase64String(line);
                    }
                    catch (FormatException)
                    {
                        break;
                    }
                    if (bytes.Length > MaxChunkBytes) break;
                    await pipe.WriteAsync(bytes, 0, bytes.Length).ConfigureAwait(false);
                    await pipe.FlushAsync().ConfigureAwait(false);
                }
            }
            catch (Exception)
            {
                // A closed pipe ends this direction; the other direction ends too.
            }
            finally
            {
                try { pipe.Close(); } catch (Exception) { }
            }
        });

        Task fromPipe = Task.Run(async () =>
        {
            byte[] buffer = new byte[MaxChunkBytes];
            try
            {
                while (true)
                {
                    int read;
                    try
                    {
                        read = await pipe.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                    }
                    catch (Exception)
                    {
                        break;
                    }
                    if (read <= 0) break;
                    Emit(Convert.ToBase64String(buffer, 0, read));
                }
            }
            finally
            {
                try { pipe.Close(); } catch (Exception) { }
            }
        });

        Task.WaitAny(new Task[] { toPipe, fromPipe });
        try { pipe.Dispose(); } catch (Exception) { }
        try { Task.WaitAll(new Task[] { toPipe, fromPipe }, 1000); } catch (Exception) { }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp | Out-Null

$stdout = [Console]::OpenStandardOutput()
$code = 0

if ($Mode -eq 'generation') {
	$code = [OmpControlPeer]::Generation($TargetPid, $stdout)
} else {
	$stdin = [Console]::OpenStandardInput()
	$code = [OmpControlPeer]::Bridge($PipeName, $ExpectPid, $ExpectCreation, $TimeoutSeconds, $stdin, $stdout)
}

exit $code
