---
status: accepted
date: 2026-10-14
---

# ADR-0075: Carry Bun's runtime flags by launcher kind and probe before using an environment carrier

## Context and Problem Statement

Every launch put Bun's `--define <name>:<public recipient>` and `--preload <host-control module>` first on the command line ([ADR-0006](0006-host-generated-key-peer-verified-pipe.md), [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md), [ADR-0049](0049-intercept-stats-browser-opener-via-preload.md)). A launch that is Bun's own CLI running OMP's entry (`bun.exe <cli.js>`, the Bun global install) takes them. OMP's own compiled program (`bun build --compile`: the winget portable package `can1357.oh-my-pi`, the `omp.sh` / `install.ps1` binary install when Bun is absent, a mise install) has a command line that is OMP's alone, so it reads them as its own unknown flags and exits with code 2 before a session starts: `OMP exited with code 2. Error: unknown flags: --define, --preload`. Reproduced with the official OMP 18.10.3 `omp-windows-x64.exe` (SHA-256 identical to the winget manifest's), and in an isolated VS Code window with the 0.4.1 build.

Observed with that program (Bun 1.4.3 inside): the same flags in the `BUN_OPTIONS` environment variable work. A preloaded module runs and a `--define` reaches it, and the module loaded afterwards by OMP's own `-e` sees the define. `BUN_BE_BUN=1` turns the program into plain `bun` (`--version` prints `1.4.3`). ADR-0049 recorded that an *earlier* compiled runtime ignored an environment-only preload. Whether that was the build or the quoting (a quoted `--preload "path"` in `BUN_OPTIONS` is silently ignored, an escaped one works) is not known, so whether a given executable honours `BUN_OPTIONS` is observed, never assumed.

The resolver already admits only a recognised bun shim or a file that carries OMP's own program; every other form (`.cmd`, `.ps1`, npm or package-manager shims, foreign `.exe`) is refused with a reason before anything starts, so those never reach a launch.

## Considered Options

- Pass the flags to every launcher on the command line (status quo): fails for OMP's own program.
- Never use Bun flags for a compiled program; run it with no host control: loses model readback, subagent work indicators and Terminal status for the users who installed OMP with the winget package or the binary install, although their OMP can carry them.
- `BUN_BE_BUN=1` with the embedded entry: the embedded entry path is private to the build, the variable is inherited by every `omp` OMP starts (they would turn into `bun`), and it changes the process OMP's own code sees.
- `BUN_OPTIONS` for every launcher: works, but leaves the variable in the environment of everything the session starts, and a user's own `BUN_OPTIONS` must be merged.
- Choose the carrier by launcher kind, use `BUN_OPTIONS` only where the command line cannot carry the flags and only after an observed probe, restore the variable once Bun has read it: chosen.

## Decision Outcome

1. **Classification.** The resolver records what a launch is (`OmpBinary.launcher`): `bun-shim` (Bun's own CLI running OMP's entry) or `program` (OMP's compiled executable). A value built by hand has none and is treated as unknown.
2. **Carrier.** `bun-shim`: command line, as always, no probe. `program` and unknown: never the command line; `BUN_OPTIONS` after a probe; otherwise nothing. A launch that gets nothing runs OMP alone, still with `-e` for Chat (Rewind, Clear, the Chat prompt and agent liveness need no control channel), does not connect to a control pipe, and shows one notice per executable and kind (refused, or could not be checked) that host control is unavailable.
3. **Probe.** `omp --version` runs once with the staged `media/runtime-probe.mjs` preloaded and a random nonce defined, both carried exactly as a launch carries them; only the nonce coming back (the probe module writes it to stderr), with exit code 0, admits `BUN_OPTIONS`. A run that exits 0 either shows the nonce (honoured) or not (refused); both are remembered per executable identity (path, size, modification time) for the window, so an updated file is probed again, and concurrent first launches share one probe. A run that timed out, could not be created, was ended by a signal or exited non-zero (on Windows an external kill or a crash is an exit code, not a signal) says nothing about the executable: it is not remembered, that launch runs without the flags, and the next launch asks again. No real recipient is sent to a launcher that has not proven itself. The probe is a warm `--version` run of tens of milliseconds, bounded at 15 s for a cold start. The Stats opener preload is probed by its own code (`planStatsPreload`: its installation marker, 5 s, on every dashboard start, for a bun shim as well) and uses the same carrier rule.
4. **Environment hygiene.** `BUN_OPTIONS` splits on white space, reads a backslash as an escape and silently ignores a quoted `--preload` value, so every character outside `[A-Za-z0-9_./:-]` is escaped with a backslash (paths with spaces, non-ASCII letters and Windows separators). A value the user already had stays in front and is passed in `OMP_VSCODE_BUN_OPTIONS_BASE`; the first preloaded Desk module puts it back (deleting the variable when it was unset) and deletes the marker, so no process OMP starts inherits Desk's flags or needs the staged module to still exist. Deleting the variable from Bun's `process.env` reaches the Windows environment block (checked with `GetEnvironmentVariableW` in Bun 1.4.0 and in the Bun 1.4.3 inside OMP 18.10.3), so native code that starts processes inherits the restored value too.
5. **Secrets.** Only the public recipient is carried, in argv or in `BUN_OPTIONS`, as before ([ADR-0006](0006-host-generated-key-peer-verified-pipe.md)); the control key and the private recipient never are. `BUN_OPTIONS` is read by Bun at startup, before any JavaScript runs, so a later change of the environment cannot substitute the recipient; the module still reads it as a lexical `--define` constant. A value placed in front *before* start comes from the extension host's own environment, which code in the same extension host could change: the same exposure as an inherited `BUN_OPTIONS` has on a bun-shim launch, limited to refusing a launch (the recipient fingerprint in the rendezvous no longer matches) and inside ADR-0006's stated same-user trust boundary. This narrows ADR-0006's decision 1 (the carrier clause: argv is not the only one, and "do not reread the recipient from mutable `process.env`" stays true of the module).

### Consequences

- Positive: OMP's own compiled program starts and keeps host control when its Bun honours `BUN_OPTIONS`; one that does not still runs Chat and says so once; the Bun global install is launched exactly as before.
- Negative: a first launch of a program pays one `--version` run; a probe is evidence about that executable, not about every future one, which the file-identity key and the per-launch exit-reason display cover. A future OMP whose launcher stops honouring `BUN_OPTIONS` degrades to the no-control form with a notice instead of failing.
- Without host control a Terminal session loses what rides the channel: native `/resume` tracking, authenticated Stop and the Terminal/Chat switch facts, and the check that a native process already serves a file. Stop and Kill fall back to the broker routes that never needed it. The same state already existed when a recipient could not be prepared; it is now also the designed outcome for a launcher that cannot carry it, and a launch records why (`RecordedControlProcess.withheld`) so a reload, the native watch and a reattach stay quiet instead of looking for a channel that was never offered. Chat keeps Rewind, Clear, the Chat prompt and agent liveness, which need no channel.
- ADR-0049's rule that the stats preload is installed only after its marker was observed is kept; its sentence excluding any environment preload is narrowed to this probed, scrubbed, launcher-kind-bound carrier.

### Amendment note (2026-10-14, after merging with ADR-0074)

[ADR-0074](0074-run-chat-brokers-on-the-sessions-own-bun-runtime-with-code-exe-as-fallback.md) reads the same `OmpBinary.launcher` to choose the runtime of a Chat's broker, and changes nothing here. Only a `bun-shim` launch can have its broker on that `bun.exe`; a `program` or unknown launch (the ones that use the `BUN_OPTIONS` carrier above) always has a `Code.exe` broker, so the environment carrier is never in the environment of a broker that runs on Bun, and a `bun-shim` Chat's flags stay on the command line a Bun broker passes to the OMP child. The probe cache above (per OMP executable) and ADR-0074's proof, trust read and hold (per `bun.exe` file) are independent.

## Related Documents

- [Architecture: Launch](../architecture.md)
- [ADR-0006](0006-host-generated-key-peer-verified-pipe.md), [ADR-0011](0011-use-installed-omp-without-version-gate.md), [ADR-0012](0012-run-child-process-entries-from-staged-copies.md), [ADR-0049](0049-intercept-stats-browser-opener-via-preload.md)

## Architecture Review

- Reviewer: architect
- Outcome: pending
- Notes: not yet reviewed.
