# Troubleshooting

- **OMP not found.** Make sure `omp --version` works in a new terminal, then reload the window. To use a specific program, set [`ompDesk.executablePath`](settings.md).
- **Something looks wrong.** Open **View > Output** and choose **OMP Desk**, and run **OMP Desk: Show Diagnostics**. Include both when you [report a bug](https://github.com/hmmvot/omp-desk/issues/new/choose). See [The OMP Desk log](#the-omp-desk-log).
- **Upgrading from an early local build.** See [Upgrading](upgrading.md#from-the-unpublished-local-build).
- **A message says Windows blocked OMP Desk's native module (or it is missing).** See [The native module is blocked or missing](#the-native-module-is-blocked-or-missing).

## The OMP Desk log

The log shows activation, restores, launches and failures at its default level (Info). One `window timing: restore tab … attached in N ms · admission … · reconcile … · attach … · persist …` line per restored Chat shows where a slow restore spent its time. One `window timing: new session <tab> start timeline, ms from the command: admission 5 · stage 25 · … · omp spawned 325 · omp control published 3825 · omp ready 24325 · host control verified 24425 · chat live 24625` line per session you start (`new session`, `resume`, `open`, `restart` or `view switch`) shows where a slow start went: every step is the milliseconds since you gave the command, in the order it happened, so a long gap between two steps is where the time was spent (a gap before `omp ready` is OMP itself starting). A Terminal start ends at `host control verified`, a Chat start at `chat live`. A start that fails or is cancelled writes the steps it reached and where it ended: `start ended after N ms, failed or cancelled at <step>; ms from the command: …`. The other per-step timings and diagnostics are at Debug: raise the level with the gear in the Output panel's toolbar, or run **Developer: Set Log Level…**, choose **OMP Desk** and then **Debug** (it applies at once and returns to Info when the window reloads; start VS Code with `--log=hmmvot.omp-desk:debug` to keep it).

The log is also a file that is written as it happens, whether or not the Output panel is open: `<VS Code logs folder>/<session>/window<N>/exthost/hmmvot.omp-desk/OMP Desk.log`, one file per window that every Reload appends to (**Developer: Open Logs Folder** opens the folder).

## The native module is blocked or missing

OMP Desk answers its Windows questions inside VS Code's extension host instead of starting PowerShell: whether another OMP holds a session, when a process started, and who owns and may read the folders it keeps its private state in. It does that through one prebuilt file, `koffi.node`, from the open-source [koffi](https://koffi.dev) foreign-function library (version 3.3.3, MIT). The file is shipped unmodified, pinned by its SHA-256, and koffi does not code-sign its binaries, so it is **not Authenticode-signed**. Neither is node-pty's `conpty.node`, which Terminals already depend on.

An organization that only allows signed code (AppLocker or Windows Defender Application Control, WDAC), or a security product that quarantines unknown DLLs, can refuse to load it. There is **no fallback**: OMP Desk would rather not start a session than start one it cannot check. While the module is unavailable:

- **Do not work:** New Session, Resume, and re-attaching a running Chat after a reload; the Sessions view cannot tell whether another OMP holds a session.
- **Still work:** the Sessions view and **Resume Session** still list your saved sessions, and a stopped session still opens, read-only, in its tab; the rest of VS Code is untouched.

Desk shows one message per window with the cause where Windows names it (policy block, missing or quarantined file, a stage that timed out, anything else) and three buttons: **Copy diagnostics**, **Open troubleshooting** (this section) and **Reload Window**, which stages and loads the module again once you have fixed the cause. The exact error is always in the **OMP Desk** output channel. A Windows that shows its errors in another language can make Desk report the cause as "not recognized"; the error text in the log and in the diagnostics is still the one to give your administrator.

### What to ask your administrator

Allow the file in both places it is loaded from. The extension folder copy is loaded by a short staging step at the start of every window; the staged copy is the one every window and session process then loads:

| Where | Path |
| --- | --- |
| Installed with the extension | `%USERPROFILE%\.vscode\extensions\hmmvot.omp-desk-<version>\out\native\koffi.node` |
| Staged copy in VS Code's global storage | `%APPDATA%\Code\User\globalStorage\hmmvot.omp-desk\runtime\<sha256>\koffi.node` |

(`Code - Insiders` and a custom `--user-data-dir` or `--extensions-dir` change the first part of the paths; **Copy diagnostics** has the exact ones.)

- **AppLocker (DLL rules must be enforced).** Add an *Allow* DLL rule with the condition **File hash**, pointing the rule wizard at the file, or from PowerShell: `Get-AppLockerFileInformation -Path "<path>" | New-AppLockerPolicy -RuleType Hash -User Everyone -Xml`. The rule applies to the file's contents, so one rule covers both locations. A **path** rule also works, but it trusts everything a user can write into those folders: use the wildcard `%USERPROFILE%\.vscode\extensions\hmmvot.omp-desk-*\out\native\koffi.node` and `%APPDATA%\Code\User\globalStorage\hmmvot.omp-desk\runtime\*\koffi.node` only if a hash rule is not possible.
- **WDAC.** Add a file rule at the **Hash** level for the file to your policy (for example `New-CIPolicyRule -DriverFilePath "<path>" -Level Hash`), or an allow rule by path if your policy format supports it.
- **Check that it is the file Desk ships.** `Get-FileHash -Algorithm SHA256 "<path>"` prints the file's SHA-256, which must equal the **Shipped SHA-256** line of **Copy diagnostics** (and the staged copy's name). The hash a policy tool computes for a program file is calculated over its executable image and can differ from this value, so let the tool compute it from the file rather than typing in the `Get-FileHash` value.
- **Antivirus.** Restore `koffi.node` from quarantine (in Windows Security: **Protection history**, then **Restore**) and add an exclusion for the extension folder `%USERPROFILE%\.vscode\extensions\hmmvot.omp-desk-*` and for `%APPDATA%\Code\User\globalStorage\hmmvot.omp-desk\runtime`. A product that holds the file for a long scan on first sight shows up as a stage that timed out: **Reload Window** after the scan.

**Updates.** The path of the extension folder changes with every OMP Desk version, so use the wildcard form there or re-add it. The file's hash changes only when OMP Desk moves to a different koffi version (the [changelog](../../CHANGELOG.md) says so), and differs between the x64 and arm64 builds; a hash rule written for one koffi version stops matching after such an update, and the message above returns until the rule is updated. Check **Copy diagnostics** after an update that shows it.
## My sessions and folders disappeared

If VS Code removed OMP Desk's storage folder (for example after a failed reinstall of the extension), OMP Desk restores the sessions, the folders and the reconnect records of running sessions on the next start from a private copy it keeps in `%LOCALAPPDATA%\omp-desk\recovery\<key>`, shows one notice with the age of the copy, and writes the restore to the **OMP Desk** log. If no usable copy exists, it says so once instead of starting silently empty, and names what it still sees (open editors for sessions that are gone, remembered sessions, running OMP processes with no record).

- **OMP processes still run but have no row.** They appear in the Sessions view (Terminals group) as *Unmanaged*. Desk cannot reconnect to them (their token was in the lost record); use **Kill** on the row to end one.
- **A restore is not wanted.** To reset OMP Desk completely, close every VS Code window, then delete both its storage folder and the recovery folder (`%LOCALAPPDATA%\omp-desk\recovery`).
- **Restoring older sessions by hand.** The recovery folder holds the previous copies of `catalog.json`. Close every window, copy the one you want over `<globalStorage>\hmmvot.omp-desk\catalog\v1\catalog.json` and start VS Code.
