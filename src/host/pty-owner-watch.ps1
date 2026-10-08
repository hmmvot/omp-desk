<#
Owner watcher for the extension-owned PTY broker (ADR-0030, ADR-0012).

The broker starts this file from the content-addressed staged runtime tree and drives
it over stdin/stdout for the lifetime of one broker. It exists to answer one question
the broker cannot answer for itself: *is the VS Code main process that owns a folder
shell still alive?* A process id read from an environment variable is a hint, not an
identity, so nothing here trusts one: a candidate is admitted only after this helper
has read the kernel facts itself, through handles it opened for that purpose.

What is proved before a candidate is admitted as the owning main process:

  * the live extension host's role — exact command-line arguments identify either a
    legacy extensionHost or a NodeService utility whose own process environment
    names the extensionHost role and extensionHostProcess entrypoint;
  * the extension host's **actual** parent, read from the kernel (not from a
    process-table walk), equals both the candidate main process id and the parent id
    the extension host reported;
  * the candidate's kernel creation FILETIME, read through this helper's own handle,
    is strictly *older* than the extension host's;
  * the candidate's executable image is the same file as the extension host's image,
    which is what ties them to one installed application rather than to two;
  * the candidate's role is a main process (its command line carries no `--type=`),
    which excludes the host itself, renderers and utility children;
  * the candidate is neither this helper, this broker, nor the extension host.

Only then does this helper keep a `SYNCHRONIZE` handle on the candidate open and wait
on it. The wait is what makes the answer an identity rather than a number: a handle
that a live process holds signals when *that* process ends, while a numeric id read
later cannot tell an exit from a reused id. Nothing is ever opened with terminate
rights and nothing is ever signalled.

Every reading is a direct Win32 call rather than a process-table or WMI query: a WMI
read of one process measured ~3.4s on the machine this was developed on, which is a
visible delay in an attach, and a process-table parent link is a snapshot's opinion
rather than the kernel's own record. Memory reads cover the command line and, for a
modern utility host, only recognition of two role environment markers. Reads are
bounded; unrelated environment values are neither materialized nor reported. These
mutable same-user markers are role evidence, not a tamper-proof security boundary.

Protocol (one ASCII line each way; `N` is a request number the broker chooses):

  -> admit N <mainPid> <hostPid> <expectedParentPid>
  -> quit
  <- !READY <helperPid>
  <- !ADMITTED N <mainPid> <creationFiletime>
  <- !UNSUPPORTED N <CODE>
  <- !SIGNAL <mainPid> <creationFiletime>
  <- !FAILED <CODE> <mainPid>
  <- !BYE
  <- !ERROR <CODE>

`!UNSUPPORTED` is final for that candidate: it means the topology could not be
positively attested, which is exactly the case that must leave a shell alone.
`!SIGNAL` is only ever emitted when the kernel answered `WAIT_OBJECT_0` for that
generation's retained handle: a failed, abandoned or timed-out wait is reported as
`!FAILED` instead, because a failed wait is not an exit and must never authorize a stop.
A helper that cannot compile, cannot read, or is killed is *loss of the watch* to the
broker — never the exit of an owner — so the broker disarms automatic stopping instead
of guessing. When this helper's stdin closes (the broker died) it exits by itself, so a
crashed broker cannot leave a helper behind holding handles.
#>
[CmdletBinding()]
param(
	# The broker that started this helper; a candidate equal to it is refused.
	[int]$BrokerPid = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::ASCII

$source = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class OwnerWatch
{
	private const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
	private const int PROCESS_QUERY_INFORMATION = 0x0400;
	private const int PROCESS_VM_READ = 0x0010;
	private const int SYNCHRONIZE = 0x00100000;
	private const uint INFINITE = 0xFFFFFFFF;
	private const uint WAIT_OBJECT_0 = 0x00000000;
	private const uint WAIT_FAILED = 0xFFFFFFFF;
	/// Live generations this helper waits on at once. A signaled generation's entry is
	/// removed (its handle is closed), so this bounds concurrent waits rather than the
	/// broker's own history of the admitted set.
	private const int MaxOwners = 8;
	private const int MaxCommandLineChars = 32768;
	private const int MaxEnvironmentBytes = 1024 * 1024;

	private static readonly object Gate = new object();
	private static readonly Dictionary<string, Owner> Owners = new Dictionary<string, Owner>();
	private static int brokerPid;

	private sealed class Owner
	{
		public string Key;
		public int Pid;
		public string CreationTime;
		public IntPtr Handle;
	}

	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern IntPtr OpenProcess(int access, bool inheritHandle, int processId);

	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern bool CloseHandle(IntPtr handle);

	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);

	[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "QueryFullProcessImageNameW")]
	private static extern bool QueryFullProcessImageName(IntPtr handle, int flags, StringBuilder buffer, ref int size);

	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, [Out] byte[] buffer, IntPtr size, out IntPtr read);

	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

	[DllImport("ntdll.dll")]
	private static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, [Out] byte[] buffer, int length, out int returnedLength);

	[DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
	private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);

	[DllImport("kernel32.dll")]
	private static extern IntPtr LocalFree(IntPtr memory);

	[StructLayout(LayoutKind.Sequential)]
	private struct MemoryBasicInformation
	{
		public IntPtr BaseAddress;
		public IntPtr AllocationBase;
		public uint AllocationProtect;
		public UIntPtr RegionSize;
		public uint State;
		public uint Protect;
		public uint Type;
	}

	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern UIntPtr VirtualQueryEx(IntPtr process, IntPtr address,
		out MemoryBasicInformation information, UIntPtr length);

	public static void SetBrokerPid(int pid)
	{
		brokerPid = pid;
	}

	/// One whole line under one lock, so a signal from a waiter thread can never
	/// interleave with an answer on the main thread.
	public static void Emit(string line)
	{
		lock (Gate)
		{
			Console.Out.Write(line);
			Console.Out.Write("\n");
			Console.Out.Flush();
		}
	}

	private static string Text(int value)
	{
		return value.ToString(CultureInfo.InvariantCulture);
	}

	/// A retained generation is named by its process id *and* its creation time: a
	/// reused id is a different process, and answering one for the other would be a
	/// false lifetime proof.
	private static string GenerationKey(int pid, string creationTime)
	{
		return Text(pid) + "|" + creationTime;
	}

	private static string CreationTimeOf(IntPtr handle)
	{
		long creation;
		long exit;
		long kernel;
		long user;
		if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) return null;
		return creation.ToString(CultureInfo.InvariantCulture);
	}

	private static string ImagePathOf(IntPtr handle)
	{
		int size = 4096;
		StringBuilder buffer = new StringBuilder(size);
		if (!QueryFullProcessImageName(handle, 0, buffer, ref size)) return null;
		return buffer.ToString();
	}

	/// The base information the kernel keeps for a process: only two fields are read,
	/// at the offsets each pointer width lays them out at.
	private static byte[] BasicInformation(IntPtr handle)
	{
		byte[] basic = new byte[IntPtr.Size == 8 ? 48 : 24];
		int returned;
		if (NtQueryInformationProcess(handle, 0, basic, basic.Length, out returned) != 0) return null;
		return basic;
	}

	private static IntPtr ReadPointer(IntPtr handle, IntPtr address)
	{
		byte[] buffer = new byte[IntPtr.Size];
		IntPtr read;
		if (!ReadProcessMemory(handle, address, buffer, (IntPtr)buffer.Length, out read) ||
			read.ToInt64() != buffer.Length) return IntPtr.Zero;
		long value = IntPtr.Size == 8 ? BitConverter.ToInt64(buffer, 0) : BitConverter.ToInt32(buffer, 0);
		return new IntPtr(value);
	}

	/// The parent the kernel records for a process, which is what a hint has to match.
	private static int ParentPidOf(IntPtr handle)
	{
		byte[] basic = BasicInformation(handle);
		if (basic == null) return 0;
		long value = IntPtr.Size == 8 ? BitConverter.ToInt64(basic, 40) : BitConverter.ToInt32(basic, 20);
		return (int)value;
	}

	/// The command line the operating system holds in the process's own parameters.
	private static string CommandLineOf(IntPtr handle, out IntPtr parameters)
	{
		parameters = IntPtr.Zero;
		byte[] basic = BasicInformation(handle);
		if (basic == null) return null;
		long peb = IntPtr.Size == 8 ? BitConverter.ToInt64(basic, 8) : BitConverter.ToInt32(basic, 4);
		if (peb == 0) return null;
		parameters = ReadPointer(handle, new IntPtr(peb + (IntPtr.Size == 8 ? 0x20 : 0x10)));
		if (parameters == IntPtr.Zero) return null;
		IntPtr command = new IntPtr(parameters.ToInt64() + (IntPtr.Size == 8 ? 0x70 : 0x40));
		byte[] header = new byte[IntPtr.Size == 8 ? 16 : 8];
		IntPtr read;
		if (!ReadProcessMemory(handle, command, header, (IntPtr)header.Length, out read) ||
			read.ToInt64() != header.Length) return null;
		int length = BitConverter.ToUInt16(header, 0);
		if (length <= 0 || (length & 1) != 0 || length > MaxCommandLineChars * 2) return null;
		long buffer = IntPtr.Size == 8 ? BitConverter.ToInt64(header, 8) : BitConverter.ToInt32(header, 4);
		if (buffer == 0) return null;
		byte[] text = new byte[length];
		if (!ReadProcessMemory(handle, new IntPtr(buffer), text, (IntPtr)text.Length, out read) ||
			read.ToInt64() != text.Length) return null;
		return Encoding.Unicode.GetString(text);
	}

	/// Compare parsed argv without allocating a managed string for every argument.
	private static bool ArgumentMatches(IntPtr argument, string expected, bool prefix)
	{
		for (int index = 0; index < expected.Length; index++)
		{
			char actual = (char)Marshal.ReadInt16(argument, index * 2);
			if (Char.ToUpperInvariant(actual) != Char.ToUpperInvariant(expected[index])) return false;
		}
		return prefix || Marshal.ReadInt16(argument, expected.Length * 2) == 0;
	}

	/// One marker at a time: retain match bits, never other environment strings.
	private struct EnvironmentMarker
	{
		public string Name;
		public string Value;
		public int Seen;
		private bool nameMatches;
		private bool valueMatches;

		public EnvironmentMarker(string name, string value)
		{
			Name = name;
			Value = value;
			Seen = 0;
			nameMatches = true;
			valueMatches = true;
		}

		public void Add(char character, int index)
		{
			if (index < Name.Length)
				nameMatches &= Char.ToUpperInvariant(character) == Char.ToUpperInvariant(Name[index]);
			else
			{
				int valueIndex = index - Name.Length;
				valueMatches &= valueIndex < Value.Length && character == Value[valueIndex];
			}
		}

		public bool End(int length)
		{
			bool valid = true;
			if (nameMatches && length >= Name.Length)
			{
				Seen++;
				valid = Seen == 1 && valueMatches && length == Name.Length + Value.Length;
			}
			nameMatches = true;
			valueMatches = true;
			return valid;
		}
	}

	/// Read only committed readable regions, under a finite cap and one reused buffer.
	/// Missing, duplicate, conflicting, oversized or unreadable markers refuse a host.
	private static bool HasExtensionHostEnvironment(IntPtr handle, IntPtr parameters)
	{
		if (parameters == IntPtr.Zero) return false;
		IntPtr environment = ReadPointer(handle,
			new IntPtr(parameters.ToInt64() + (IntPtr.Size == 8 ? 0x80 : 0x48)));
		long address = environment.ToInt64();
		if (address <= 0 || (address & 1) != 0) return false;
		byte[] buffer = new byte[4096];
		EnvironmentMarker role = new EnvironmentMarker("VSCODE_CRASH_REPORTER_PROCESS_TYPE=", "extensionHost");
		EnvironmentMarker entry = new EnvironmentMarker("VSCODE_ESM_ENTRYPOINT=", "vs/workbench/api/node/extensionHostProcess");
		int position = 0;
		int total = 0;
		UIntPtr regionInformationSize = new UIntPtr((uint)Marshal.SizeOf(typeof(MemoryBasicInformation)));
		while (total < MaxEnvironmentBytes)
		{
			MemoryBasicInformation region;
			if (VirtualQueryEx(handle, new IntPtr(address), out region,
				regionInformationSize) == UIntPtr.Zero) return false;
			// MEM_COMMIT, no guard, and a readable page protection.
			if (region.State != 0x1000 || (region.Protect & 0x100) != 0 ||
				(region.Protect & 0xEE) == 0) return false;
			long start = region.BaseAddress.ToInt64();
			ulong size = region.RegionSize.ToUInt64();
			if (start < 0 || start > address || size > (ulong)(Int64.MaxValue - start)) return false;
			long available = start + (long)size - address;
			int length = (int)Math.Min(Math.Min(available, buffer.Length), MaxEnvironmentBytes - total);
			if (length <= 0 || (length & 1) != 0) return false;
			IntPtr read;
			if (!ReadProcessMemory(handle, new IntPtr(address), buffer, (IntPtr)length, out read) ||
				read.ToInt64() != length) return false;
			for (int index = 0; index < length; index += 2)
			{
				char character = (char)(buffer[index] | (buffer[index + 1] << 8));
				if (character == '\0')
				{
					if (position == 0) return role.Seen == 1 && entry.Seen == 1;
					if (!role.End(position) || !entry.End(position)) return false;
					position = 0;
				}
				else
				{
					role.Add(character, position);
					entry.Add(character, position);
					position++;
				}
			}
			address += length;
			total += length;
		}
		return false;
	}

	private static bool IsExtensionHost(IntPtr handle, IntPtr parameters, string commandLine)
	{
		if (commandLine == null) return false;
		int count;
		IntPtr arguments = CommandLineToArgvW(commandLine, out count);
		if (arguments == IntPtr.Zero) return false;
		try
		{
			int types = 0;
			int subtypes = 0;
			bool legacy = false;
			bool utility = false;
			bool nodeService = false;
			// argv[0] is the executable, never a role marker.
			for (int index = 1; index < count; index++)
			{
				IntPtr argument = Marshal.ReadIntPtr(arguments, index * IntPtr.Size);
				if (ArgumentMatches(argument, "--type=", true))
				{
					types++;
					legacy = ArgumentMatches(argument, "--type=extensionHost", false);
					utility = ArgumentMatches(argument, "--type=utility", false);
				}
				if (ArgumentMatches(argument, "--utility-sub-type=", true))
				{
					subtypes++;
					nodeService = ArgumentMatches(argument, "--utility-sub-type=node.mojom.NodeService", false);
				}
			}
			return types == 1 && ((legacy && subtypes == 0) ||
				(utility && subtypes == 1 && nodeService && HasExtensionHostEnvironment(handle, parameters)));
		}
		finally
		{
			LocalFree(arguments);
		}
	}

	/// Wait on one retained generation's handle and answer exactly one outcome.
	///
	/// Only `WAIT_OBJECT_0` means the process ended. Every other answer — a failed wait,
	/// an abandoned wait, a timeout, or an exception — means this helper *cannot* say
	/// that the process ended, and a failed wait must never be reported as a signal: the
	/// broker treats a signal as the proof that authorizes an automatic stop. The entry's
	/// handle is closed and a bounded failure line is emitted instead, which the broker
	/// reads as loss of the watch (it disarms rather than guessing).
	private static void Waited(Owner owner)
	{
		uint outcome;
		try
		{
			outcome = WaitForSingleObject(owner.Handle, INFINITE);
		}
		catch (Exception)
		{
			outcome = WAIT_FAILED;
		}
		CloseHandle(owner.Handle);
		owner.Handle = IntPtr.Zero;
		if (outcome != WAIT_OBJECT_0)
		{
			lock (Gate)
			{
				Owners.Remove(owner.Key);
			}
			Emit("!FAILED SIGNAL_WAIT_FAILED " + Text(owner.Pid));
			return;
		}
		lock (Gate)
		{
			// The generation is over; the broker keeps its own history of the admitted set.
			Owners.Remove(owner.Key);
		}
		Emit("!SIGNAL " + Text(owner.Pid) + " " + owner.CreationTime);
	}

	/// Attest one candidate owning main generation, retain a handle on it, and answer.
	public static void Admit(int requestId, int mainPid, int hostPid, int expectedParentPid)
	{
		if (mainPid <= 0 || hostPid <= 0 || expectedParentPid <= 0)
		{
			Refuse(requestId, "BAD_ARGUMENTS");
			return;
		}
		if (mainPid == hostPid) { Refuse(requestId, "MAIN_IS_HOST"); return; }
		if (mainPid == System.Diagnostics.Process.GetCurrentProcess().Id) { Refuse(requestId, "MAIN_IS_HELPER"); return; }
		if (brokerPid > 0 && mainPid == brokerPid) { Refuse(requestId, "MAIN_IS_BROKER"); return; }

		IntPtr hostHandle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, hostPid);
		if (hostHandle == IntPtr.Zero) { Refuse(requestId, "HOST_UNREADABLE"); return; }
		string hostCreation;
		string hostImage;
		string hostCommandLine;
		int hostParentPid;
		bool hostRole;
		IntPtr hostParameters;
		try
		{
			hostCreation = CreationTimeOf(hostHandle);
			hostImage = ImagePathOf(hostHandle);
			hostCommandLine = CommandLineOf(hostHandle, out hostParameters);
			hostRole = IsExtensionHost(hostHandle, hostParameters, hostCommandLine);
			hostParentPid = ParentPidOf(hostHandle);
		}
		finally
		{
			CloseHandle(hostHandle);
		}
		if (hostCreation == null || hostImage == null) { Refuse(requestId, "HOST_UNREADABLE"); return; }
		if (hostCommandLine == null) { Refuse(requestId, "HOST_CMDLINE_UNREADABLE"); return; }
		if (hostParentPid <= 0) { Refuse(requestId, "HOST_PARENT_UNREADABLE"); return; }
		if (!hostRole)
		{
			Refuse(requestId, "HOST_ROLE_NOT_EXTENSION_HOST");
			return;
		}
		if (hostParentPid != mainPid || expectedParentPid != mainPid)
		{
			Refuse(requestId, "PARENT_MISMATCH");
			return;
		}

		IntPtr mainRead = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, mainPid);
		if (mainRead == IntPtr.Zero) { Refuse(requestId, "MAIN_UNREADABLE"); return; }
		string mainCreation;
		string mainImage;
		string mainCommandLine;
		IntPtr mainParameters;
		try
		{
			mainCreation = CreationTimeOf(mainRead);
			mainImage = ImagePathOf(mainRead);
			mainCommandLine = CommandLineOf(mainRead, out mainParameters);
		}
		finally
		{
			CloseHandle(mainRead);
		}
		if (mainCreation == null || mainImage == null) { Refuse(requestId, "MAIN_UNREADABLE"); return; }
		if (mainCommandLine == null) { Refuse(requestId, "MAIN_CMDLINE_UNREADABLE"); return; }
		if (mainCommandLine.IndexOf("--type=", StringComparison.OrdinalIgnoreCase) >= 0)
		{
			Refuse(requestId, "MAIN_ROLE_IS_CHILD");
			return;
		}
		long hostTicks;
		long mainTicks;
		if (!Int64.TryParse(hostCreation, NumberStyles.None, CultureInfo.InvariantCulture, out hostTicks) ||
			!Int64.TryParse(mainCreation, NumberStyles.None, CultureInfo.InvariantCulture, out mainTicks))
		{
			Refuse(requestId, "MAIN_UNREADABLE");
			return;
		}
		if (mainTicks >= hostTicks)
		{
			Refuse(requestId, "MAIN_NOT_OLDER");
			return;
		}
		if (!String.Equals(mainImage, hostImage, StringComparison.OrdinalIgnoreCase))
		{
			Refuse(requestId, "MAIN_IMAGE_MISMATCH");
			return;
		}

		// Only now is a handle kept, and only for waiting: no read and no write right.
		IntPtr mainWait = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, mainPid);
		if (mainWait == IntPtr.Zero) { Refuse(requestId, "MAIN_UNREADABLE"); return; }
		string key = GenerationKey(mainPid, mainCreation);
		Owner owner = new Owner();
		owner.Key = key;
		owner.Pid = mainPid;
		owner.CreationTime = mainCreation;
		owner.Handle = mainWait;
		lock (Gate)
		{
			Owner existing;
			if (Owners.TryGetValue(key, out existing))
			{
				// Exactly this generation is already watched: keep the handle that is already
				// waiting and answer with the reading just taken, so a restarted extension
				// host of the same instance cannot stack a second waiter on one process. The
				// answer is the *fresh* creation time, never a retained one: a process id
				// that now names a different process is a different generation, and it gets
				// its own waiter below rather than being answered with the old lifetime.
				CloseHandle(mainWait);
				Emit("!ADMITTED " + Text(requestId) + " " + Text(mainPid) + " " + mainCreation);
				return;
			}
			if (Owners.Count >= MaxOwners)
			{
				CloseHandle(mainWait);
				Emit("!UNSUPPORTED " + Text(requestId) + " TOO_MANY_OWNERS");
				return;
			}
			Owners[key] = owner;
		}
		Thread waiter = new Thread(delegate() { Waited(owner); });
		waiter.IsBackground = true;
		waiter.Start();
		Emit("!ADMITTED " + Text(requestId) + " " + Text(mainPid) + " " + mainCreation);
	}

	private static void Refuse(int requestId, string code)
	{
		Emit("!UNSUPPORTED " + Text(requestId) + " " + code);
	}
}
'@

function Emit([string]$line) {
	[Console]::Out.Write($line + "`n")
	[Console]::Out.Flush()
}

try {
	Add-Type -TypeDefinition $source -Language CSharp
} catch {
	Emit "!ERROR COMPILE_FAILED"
	exit 21
}

[OwnerWatch]::SetBrokerPid($BrokerPid)
Emit ("!READY " + $PID)

# Reading stdin until it closes is what ties this helper's lifetime to the broker's:
# when the broker dies the pipe ends, ReadLine returns nothing, and this process exits
# without leaving handles behind.
while ($true) {
	$line = [Console]::In.ReadLine()
	if ($null -eq $line) { break }
	$line = $line.Trim()
	if ($line.Length -eq 0) { continue }
	$parts = $line.Split(' ')
	if ($parts[0] -eq 'quit') {
		Emit "!BYE"
		break
	}
	if ($parts[0] -ne 'admit' -or $parts.Count -ne 5) {
		# A command this helper does not know means the broker and this file disagree
		# about the protocol: refusing to guess is the only safe answer, and the broker
		# reads this as loss of the watch.
		Emit "!ERROR BAD_COMMAND"
		break
	}
	$requestId = 0
	if (-not [int]::TryParse($parts[1], [ref]$requestId)) {
		Emit "!ERROR BAD_REQUEST_ID"
		break
	}
	$mainPid = 0
	$hostPid = 0
	$expectedParentPid = 0
	if (-not [int]::TryParse($parts[2], [ref]$mainPid) -or -not [int]::TryParse($parts[3], [ref]$hostPid) -or -not [int]::TryParse($parts[4], [ref]$expectedParentPid)) {
		[OwnerWatch]::Emit("!UNSUPPORTED " + $requestId + " BAD_ARGUMENTS")
		continue
	}
	try {
		[OwnerWatch]::Admit($requestId, $mainPid, $hostPid, $expectedParentPid)
	} catch {
		[OwnerWatch]::Emit("!UNSUPPORTED " + $requestId + " HELPER_ERROR")
	}
}
