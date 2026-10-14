---
status: accepted
date: 2026-10-14
---

# Chat brokers on the session's own Bun runtime

## Problem

Every session lives in an OMP process that a detached broker keeps alive when VS Code closes. The broker is the extension host's own executable run as Node (`Code.exe` with `ELECTRON_RUN_AS_NODE=1`). VS Code's updater ("Restart to Update", Inno Updater) terminates every `Code.exe` of the install that is still running after about 30 s, so a VS Code update ends every broker and, with it, the OMP process of every Chat (an `rpc` child lives on its broker's pipe). The restored window relaunches those sessions from their files; whatever the agent was doing at that moment is lost. Observed 2026-10-13, VS Code 1.141.0 to 1.141.1: five session brokers and the stats broker terminated.

The Chat OMP process itself is `bun.exe` (a bun-installed OMP runs as `bun.exe <entry>`), which the updater never touches. If the Chat broker ran on that same `bun.exe`, nothing the updater captures would be in the Chat's process tree.

## Goals and Non-goals

- Goals:
  - A Chat (`managed-rpc`) broker runs on the same `bun.exe` the session's OMP launch uses, so a running Chat survives a VS Code update and a fresh window re-adopts it, with its transcript, through the existing record and token.
  - `Code.exe` stays the automatic fallback whenever Bun cannot be used, with the reason logged.
  - A setting forces `Code.exe` (an escape hatch; the default is Bun when eligible).
  - An existing `Code.exe` broker keeps working after an upgrade; a downgraded extension adopts a Bun broker through its record.
  - The proof that replaces the PTY self-check for this runtime and the trust rule for the `bun.exe` path are stated against ADR-0012 and ADR-0054.
- Non-goals:
  - Terminal (`managed-omp`), folder-shell and Stats (`stats-dashboard`) brokers stay on `Code.exe`. They need `node-pty`, whose input pipe Bun 1.4.0 to 1.4.2 destroys (fixed upstream in 1.4.3, not exercised through Desk's PTY broker); they end in an update as before.
  - Standalone `omp.exe` installs (a `bun build --compile` program) stay on `Code.exe`. Running such a program as a Bun CLI with `BUN_BE_BUN=1` works on the official 18.10.4 build, but the mode is not an OMP contract; it is not used.
  - Preventing the updater from ending `Code.exe` processes (it cannot be prevented), and shielding Terminal sessions.

## Current State

`PtyBrokerClient` (`src/host/pty-client.ts`) owns one runtime for the whole window: `ensurePtyRuntime` stages the packaged broker tree (`out/pty`, ADR-0012), proves it with `--self-check` (a console child through a real pseudo console, a pipe child; ADR-0032) and `spawnPtyBroker` starts `process.execPath` detached, with `ELECTRON_RUN_AS_NODE=1`. The proof is stored per key (tree digest, runtime version, executable path/size/mtime, versions, OS build) in `pty-proof/`. A broker publishes a record once (`PtyBrokerRecord`: protocol and runtime versions, tree digest, ids, port, token, pid, creation time); re-adoption reads the record, connects with the token, compares the hello with the record and attests the broker by its own creation-time statement. Nothing in an attach, a stop or a kill looks at the broker's image. `docs/architecture.md` ("What ends a broker") and `src/wiring/updater-notice.ts` say all brokers are `Code.exe`.

`launchRpcHost` (`src/host/rpc-launch.ts`) resolves the OMP launch per session (`resolveOmpBinary`: a bun shim resolves to `bun.exe <entry>`, a direct program to the program itself; the shim's `bun.exe` may itself come from a PATH search) and asks the client for a `managed-rpc` slot.

## Proposed Design

### Runtime selection (per launch, Chat only)

`launchRpcHost` passes the resolved launch to `client.launchRpc(spec, { ompBinary })`. The client decides only when a broker has to be started (a slot that holds a record is adopted or reported, never given a plan), in `startBroker`, under the slot lock. `OmpBinary` gains `launcher: "bun-shim" | "program"`, set where the candidate is built. The plan is eligible only when every condition holds; otherwise it carries the first failing reason:

1. `ompDesk.chatBrokerRuntime` is `auto` (`vscode` forces `Code.exe`; reason `setting`);
2. the host is Windows x64 (ARM64 is not verified; reason `platform`);
3. the launch is a bun shim whose command is an absolute `bun.exe` (reasons `launcher`, `executable`); its `realpath` is the file that is judged and started;
4. the executable passes the trust rule below (reason `trust`);
5. the pipe-only proof of this broker tree on that file passes (reason `proof`; an answer that does not hold is a refusal, a check that ran out of time is held, below), and the file reports itself: the check prints `process.execPath`, and `realpath(execPath)` must equal the judged path, so a launcher that starts another image is never a broker runtime (reason `runtime-mismatch`, added in the 2026-10-14 amendment; the first build logged it as `launcher`);
6. the proof reports Bun 1.4.0 or newer (reason `version`; 1.4.0 is the oldest version the full verification covers and the Bun this machine runs; 1.3.14 also passed the real-broker suite but is not claimed. The Chat broker never loads `node-pty`, so the 1.4.0-1.4.2 `node-pty` defect does not apply to it. There is no upper bound; the setting is the lever).

The client then stages the same broker tree (ADR-0012, unchanged) and starts the broker with the file and `--no-install` (so a stray `bunfig.toml` or `package.json` cannot trigger package installs), without `ELECTRON_RUN_AS_NODE`. Terminal, folder-shell and Stats launches never receive a plan and use `this.ready()` and `process.execPath` exactly as today. Selection is per launch: one window can hold Bun-hosted Chats, `Code.exe`-hosted Chats and `Code.exe` terminals at once.

### Fallback

Any ineligible plan, and any failure before a broker exists, starts the Chat broker on `Code.exe` through the unchanged full path (`ready()` with the PTY self-check). A Bun broker is retried once on `Code.exe`, inside the same `startBroker` call, under the same slot lock and launch id, only when the spawn threw, or the process exited **and** a fresh `readPtyRecord` finds no record (`none`, not `invalid`). The safety argument: a broker claims its record with an exclusive create before it spawns its child, so a broker that exits without a record never had a child, and a late publisher cannot become a second writer. A broker that published a record owns the slot and is never replaced (ADR-0024 rules stand); a broker still alive at the 30 s deadline is `unconfirmed` and never retried. A proof computed in this window is not withdrawn (ADR-0032); only a stored proof another window wrote is deleted, and only the pipe-only in-process proofs are cleared with it.

A file that failed that way is held off the Bun path until its identity (size, modification time, file id) changes. The same hold follows a Bun broker that published a record and then could not be attached, or that was still silent at the deadline: that Chat is `unconfirmed` and never retried, and the file stays off the Bun path for the next Chat (until it changes if the broker exited, for 10 minutes if it is still alive). A file whose check ran out of time is held for 10 minutes. So a Bun that cannot host a broker costs one Chat, not every Chat. A check that ran and refused (a failed self-check, `runtime-mismatch`, `version`) is not held: each launch repeats it, for the price of one self-check. The fallback reason is logged on every Chat launch that starts a broker (`Chat broker runtime: VS Code (Code.exe), because <reason>; a VS Code update ends it.`) and a Bun launch logs `Chat broker runtime: Bun <version> (<path>); a VS Code update does not end it.` once the broker is running. A fallback is not a user-facing notice: the session works either way.

### The record knows the runtime

The broker reports itself. `PtyBrokerRecord` gains an optional `runtime: { engine: "bun" | "electron" | "node", version: string }` taken from the broker's own `process.versions` and written with the rest of the record (still written once; `PTY_RECORD_VERSION` and `PTY_RUNTIME_VERSION` are unchanged). `parsePtyBrokerRecord` accepts its absence, and drops a malformed one rather than refusing the record (as `attestationOf` does for its field); an absent `runtime` means a broker of an earlier build, which was always `Code.exe`. Re-adoption logs name `record.runtime`; no attach, stop or kill path reads it.

### Setting

`ompDesk.chatBrokerRuntime`, enum `auto` (default) | `vscode`, `scope: "machine"` (a Bun install belongs to one machine and the setting must not sync to another; as with `ompDesk.executablePath`, a workspace cannot choose). The client's policy object reads it at each launch, so a change applies to brokers started afterwards; a running broker is never restarted for it. To move a running Chat onto the other runtime, stop it and open it again. It is in the README settings table and the Settings view (ADR-0062) from the schema.

### The self-check: pipe-only

`pty-broker.js --self-check --pipe-only` starts the staged entry on the candidate runtime, loads nothing from `node-pty`, opens no console, and proves:

- the runtime runs the entry and a real pipe child (`--pipe-echo`) carries a JSONL line through stdin and stdout pipes and ends when its stdin closes: the transport a `managed-rpc` slot runs on;
- the runtime's loopback sockets carry the broker's line framing under load: an in-process server and client exchange about 724 KB (2,048 short lines and one 200,000-character line, in one write) through `createLineReader`, every echo whole and in order. This is the shape of an RPC stream of tool output and the case where a runtime with larger socket chunks than Node once broke the line reader (Bun delivers chunks up to 512 KiB on loopback, Node at most 64 KiB);
- which executable ran it (`execPath`) and which Bun version.

It does not prove the handshake, the record publication, the helper's creation-time reading, or behaviour over time (backpressure, handle liveness, memory): the e2e suite (run on the developer's Bun) and the version floor (there is no upper bound) cover those, so a newer Bun that passes this check but cannot host a broker is found by its first Chat, which ends `unconfirmed` and is not retried, and the hold above keeps the next Chat on `Code.exe`. The proof's answer says `pipeOnly: true`, `childOutput: false`, so it can never be taken for the full one:

- the stored-proof key gains `pipeOnly: true` (a different file; every existing key keeps its hash), and the Bun version belongs to the stored answer and is checked against the gate on every hit;
- the in-process proof is held per (executable path, size, modification time, file id), so a `bun upgrade` between launches is proven afresh by the next launch;
- `ready()` for terminal kinds is untouched and still demands the full proof on `Code.exe`;
- an inconclusive (timed-out) check is not admitted provisionally: the launch falls back and the file is held for 10 minutes.

### Trust rule for the `bun.exe` path (against ADR-0012 and ADR-0054)

ADR-0012 stages the broker's own entry tree because it is code this extension ships and must run from content-addressed, owner-only copies; ADR-0024 puts the whole native runtime load tree under that rule. The runtime executable is never staged: `Code.exe` runs in place from the VS Code install, and `bun.exe` would run in place from the user's Bun directory. Copying a 100 MB `bun.exe` per release was rejected (Alternatives). The rule that stands in for staging is ADR-0054's, applied to the executable's path, with these parts:

- The executable is the path the OMP launch resolved, judged at its real path, and condition 5 above holds the file the check actually ran as to that path.
- One security read (`readStorageSecurity`, the module-free .NET reader ADR-0054 specifies) covers the file, its folder and every folder above it below the volume root. Principals and owners are judged with `isPermittedAclPrincipal` (current account, SYSTEM, Administrators, TrustedInstaller and the owner placeholders: ADR-0054's set, so a `C:\Program Files` chain passes).
- On the file and on its own folder, any other principal may hold read and execute rights only (`mask & ~0xA01200A9` refuses): a write to the file changes the code the broker runs, and the application folder is the first place Windows looks for a DLL. The folders above are pass-through folders under `permissionsPermitReplacement`: another principal may add entries but not replace or re-permission the folder. Every owner must be a permitted principal. A refusal falls back with reason `trust`.
- The read runs on every Bun-eligible launch, after the slot is known to hold no record and concurrently with staging and the proof (on a miss, with the self-check itself, so `bun.exe` runs before the verdict; the OMP child runs the same file unchecked, below); its verdict is not kept (ADR-0054 and ADR-0032 reserve keeping access verdicts for a separate review). Cost: two PowerShell starts per Chat start, one for this read and one for the staged tree's access pass (about 0.5 s each idle, several seconds on a loaded machine); that is a trade against an adopt or reopen path, which pays nothing.
- The file's size, modification time and file id are re-read just before the spawn; a change falls back (reason `changed`). This is an identity check, not a content check; protection against another account comes from the access rule. The gap between that reading and `CreateProcess` is the non-atomic verify-then-execute ADR-0012 already accepts, usable only by principals the rule admits.
- The executable's Authenticode signature is not checked: the official `bun.exe` is signed but locally built or package-manager Bun builds vary, and a signature gate would refuse legitimate installs without adding to a same-user threat model ADR-0006 already draws. The Bun version the proof reports is the compatibility gate.

What the rule is and is not: the rule keeps another account from changing what the broker runs; content addressing is not reproduced, and the same-user residual is ADR-0006's. It is defence in depth: the OMP child runs the same file unchecked today, so a refusal moves Desk's broker off a file another account could change; it does not protect the session. A broker on `bun.exe` adds one more long-lived process of that image, whose authentication surface (loopback port plus the owner-only record's token) is identical to a `Code.exe` broker's. Global `~/.bunfig.toml` preloads and `BUN_OPTIONS` of the extension host's environment apply to the broker as they apply to the OMP child, and the self-check runs under that same environment when it runs. The stored proof is not keyed to them: its key covers the staged tree, the Bun version and the executable's path, size and modification time, and it is reused across windows for up to 24 hours, so a change of `BUN_OPTIONS` or `~/.bunfig.toml` that would break the broker is found by the first Chat that fails, not by a fresh check (same-user residual; the setting is the lever).

### What survives the updater

The Inno updater captures `Code.exe` processes whose full image path equals the install's `Code.exe` (name `Code.exe`, then `QueryFullProcessImageNameW`) and terminates them after renaming `Code.exe`. A Bun-hosted Chat's tree is `bun.exe` (broker) and `bun.exe` (OMP child): neither matches, neither is captured, and the Restart Manager's file-in-use listing for the install names only `Code.exe` processes. After the update a fresh window finds the record, attaches with the token and re-adopts the same OMP process with the same transcript. Everything that stays `Code.exe` (terminals, folder shells, Stats, any Chat that fell back) still ends in an update, so `docs/architecture.md` ("What ends a broker") and the updater notice describe the split; the notice works from the pids the updater's log names (only `Code.exe` processes: "Code.exe, pid N is still running, attempting termination"), so a Bun broker's descriptor matches it only if its recorded pid was reused by a `Code.exe` after the broker ended, the same edge a `Code.exe` broker's descriptor already has. Residual risk: if a future updater captured by directory or by process tree, Bun brokers would be captured (the broker is a child of the extension host that started it: `detached` removes the console group, not the parent pid); the emulated-updater e2e scenario (`90`) is the regression guard. A user who installs OMP as a standalone binary, or whose `bun.exe` fails any condition, keeps `Code.exe` brokers; OMP's own `omp update` for a bun install runs `bun install -g` and never replaces `bun.exe`, but a switch to the standalone binary moves new Chats to `Code.exe` with reason `launcher`.

### Mixed generations

- **Upgrade to this build.** A broker started by an earlier build has no `runtime` in its record and a different tree digest. Attach does not read either for admission (the digest only sets `buildMatches`, which already governs the one existing behaviour: a live broker of another build keeps its slot and is reported, never replaced). Existing `Code.exe` Chat and Terminal brokers are therefore re-adopted as today. A later restart of such a Chat starts a new broker, which is Bun-hosted when eligible.
- **Downgrade to an earlier build.** The earlier build's parser ignores the unknown `runtime` field, the handshake and protocol are unchanged, and no earlier path compares the broker's image; it adopts a Bun broker through its record exactly like another build's broker (same tree-digest rule). The isolated proof installs the earlier VSIX over a profile holding a live Bun-hosted Chat and records the result. Neither `PTY_RECORD_VERSION` nor `PTY_RUNTIME_VERSION` is bumped: bumping the runtime version would make this build refuse every surviving `Code.exe` broker, the opposite of the requirement.
- **A `bun upgrade` or reinstall with a live Bun broker.** The Bun updater renames a running `bun.exe` aside (`bun.exe.outdated`) and installs the new one; live processes keep running the old image. A second upgrade while an old process still holds the renamed file fails cleanly (`EPERM`) and corrupts nothing. This already happens with a long-lived OMP child, which is the same image. A broker can outlive its session (a broker whose child's tree could not be proven empty is kept as recovery metadata), so it can hold the old image longer than the session; Stop or Kill All ends it. The README and the architecture document say so.

### Memory

Measured with real OMP behind each broker (36 turns, each with a large tool output, 16 MB through the broker): working set and private working set match `Code.exe`'s (82.6/42.3 MB against 80.6/47.3 MB after load); **commit** is about 110 MB higher (201 MB against 90 MB) because Bun reserves heap up front. The user accepted that cost on 2026-10-14; physical memory is unchanged. One Bun broker is about a tenth of a session's own footprint (the OMP child was 438 MB working set, 864 MB commit).

### Logging and diagnostics

One line per Chat launch (runtime and reason, above); one line per attach that names the record's runtime; no separate proof log for the pipe-only check (its refusal reason is in the launch line). No new user-visible UI.

## Alternatives

- **A stable per-install copy of the broker host** (copy `Code.exe` to storage and run the broker from it): the updater captures by path, so a copy survives, but it duplicates 200+ MB per VS Code release, keeps the Electron memory profile and needs its own update and cleanup story. Rejected.
- **Copy `bun.exe` into storage (content-addressed, like the tree).** Satisfies ADR-0012 literally, but 100 MB per Bun release, hashing on each stage, and the user's `bun upgrade` would not apply to brokers. Rejected; the ADR-0054 path rule gives protection against another account for one PowerShell read.
- **Drop the trust rule** (the OMP child runs the same file unchecked): defensible, but a correct rule is cheap and keeps Desk from choosing a file another account can change.
- **Cache the trust verdict per window** to save the PowerShell start per launch: would amend ADR-0054's and ADR-0032's reservation on keeping access verdicts; not taken.
- **Bun for Terminal kinds too.** Needs `node-pty` on Bun, which works on Bun 1.4.3 and later in isolated tests but not through Desk's PTY broker; and a terminal is not the work the user loses in an update. Deferred.
- **`omp.exe` with `BUN_BE_BUN=1`.** Works on the official build, but unsigned, version-coupled to whatever Bun OMP embedded, and a mode OMP does not promise. Out of scope.
- **Always Bun, no setting.** Rejected: the user needs an escape hatch if a Bun update breaks the broker.
- **Persist the choice in the host, not the record.** A window or a downgraded build could not know what it re-adopted; the broker's own statement cannot go stale.
- **Provisional admission of a timed-out Bun check, as `Code.exe` has.** Rejected: Bun is the unproven runtime here and `Code.exe` is the safe fallback.

## Risks and Open Questions

- Commit memory (+~110 MB per Chat broker): accepted; if a user keeps tens of Chats the commit charge matters; the setting is the lever.
- Bun regressions: the 1.4.0 PTY bug shows Bun can break between releases; the version gate and the pipe-only proof guard the launch, not an already-running broker.
- ARM64 is unverified; the plan is x64 only.
- Only the updater's kill was emulated (an Inno-style capture of a scratch VS Code copy); the real Inno updater was not run.
- Diagnosed on this branch (see Verification results): the earlier `80-full-exit` full-run timeouts came from the user's VS Code holding the "vscode-updating" mutex while a new window started, not from Bun, and the earlier scenario `90` transcript timeout came from a hard kill leaving no restored editor tab for the Chat. Neither is a Bun defect.
- After this change the real OMP in the e2e suite is a bun shim, so the suite runs Bun brokers; `Code.exe` Chat brokers are exercised by scenario `90` with `E2E_EXPECT_BROKER=code`, and by the full run at 3a805f0, which predates the change.

## Rollout and Verification

1. Broker: `--pipe-only` (pipe child, loopback lines, `execPath`), `runtime` in the record. Host: record parser, `launcher` on `OmpBinary`, per-launch selection, trust read, proof key, hold, fallback in `PtyBrokerClient`, setting, docs.
2. Unit tests: eligibility per reason, trust rule (injected security read), proof key separation, record parse with and without `runtime`, fallback on spawn failure and early exit, no replacement of a recorded slot, the hold; real-broker tests on a real Bun (skipped when absent).
3. e2e: the full sequence with the default setting (Bun brokers) and with `ompDesk.chatBrokerRuntime: vscode` (the `Code.exe` control), scenario `90` on a scratch VS Code copy (the Bun-hosted Chat survives and is re-adopted with its transcript); the two earlier open results are diagnosed (Risks).
4. Isolated upgrade proof over the installed build: existing `Code.exe`-hosted Chat and Terminal sessions survive; a new Chat gets a Bun broker (process tree); the emulated updater kill; the fallback with the setting and with `bun.exe` unavailable; the earlier VSIX over a profile with a live Bun Chat; clean logs.

## Verification results (2026-10-14, Bun 1.4.0, the machine's own)

- Unit suite: 4,658 passed, 0 failed, 6 skipped. `npm run typecheck` (both tsconfigs and the import check) clean.
- Real-broker suite on Bun 1.4.0: pass (1.3.14 also passed it with the floor lowered; not claimed).
- e2e on a scratch VS Code copy with its own mutex name (`E2E_VSCODE_DIR`): all 14 scenarios passed with Bun brokers, including `90` (the emulated updater kill left the Bun broker and OMP child alive, the reopened window re-adopted the same pids and the transcript, and a new turn was answered). Scenario `90` with `E2E_EXPECT_BROKER=code` also passed: the `Code.exe` broker and OMP child ended and the session row stayed.
- Isolated upgrade proof over the installed 0.4.1 build (evidence: `.omp/workspace/notes/assets/bun-broker-impl-2026-10-14/`): the `Code.exe` Chat and Terminal brokers and their children survived the install and Reload Window with identical pids, and the old Chat kept its transcript and answered; a new Chat got a Bun broker and the log said so; the emulated updater kill ended the `Code.exe` brokers and left the Bun Chat running, re-adopted by a restarted window with the same pids, transcript and a new answered turn; the setting `vscode` gave a `Code.exe` broker with the reason logged; the earlier build installed over the profile kept the Bun Chat and the `Code.exe` Chat adopted (same pids), both transcripts and new turns answered; no OMP Desk error in the log (only the existing "native completion signals unavailable" retry notice of a Terminal).
- Not exercised in a window: `bun.exe` unavailable (covered by the real-broker tests: no bun launch, not a `bun.exe`, compiled program, refused trust read, platform), ARM64, the real Inno Updater, an installed (non-scratch) VS Code.

## Amendment (2026-10-14, merge with ADR-0075 and the levelled logger)

Written when the branch was merged into `main`, which had meanwhile shipped 0.4.2 with [ADR-0075](../decisions/0075-carry-bun-runtime-flags-by-launcher-kind-and-probe-before-using-an-environment-carrier.md) and a levelled `Logger` for every log sink. Nothing above changed in kind; the changes are stated against the merged code. Review: independent architecture review (one pass) of the composition; its text corrections are applied.

- **One launcher kind.** `main` had added `OmpBinary.launcher` (`bun-shim` | `program`) independently, with the same values and the same resolver sites this design's "Runtime selection" section names. The merge keeps one definition, in `src/host/chat-broker-runtime.ts` (a leaf module, so `native-terminal.ts` can import it without a cycle), re-exported by `native-terminal.ts`. The design's non-goal "standalone `omp.exe` installs stay on `Code.exe`" is now the `launcher` reason for `program` and for a value with no kind, and its fallback line says so in words (`OMP's own compiled program (a standalone install; the Bun inside it is private to it)`). ADR-0075's `BUN_OPTIONS` carrier is only ever used by launches whose broker is `Code.exe`, so a Bun broker never needs it. A `bun-shim` launch's command-line flags pass through the Bun broker to the OMP child unchanged (a real-broker test covers it); the child inherits the broker's own environment (scrubbed) plus the spec's changes, and the broker never applies those changes to itself. The caches are keyed independently: ADR-0075's probe per OMP executable (path, size, mtime); this design's stored proof by executable path, size and mtime, its in-process proof and failure hold also by file id, and the trust read not kept.
- **A new reason, `runtime-mismatch`.** A pipe-only check whose `execPath` does not resolve to the judged `bun.exe` (a forwarding shim first on PATH) is logged as `runtime-mismatch` at `warn`, not as `launcher`: the file had passed every earlier step, so it is a Bun that was eligible and was not used.
- **Logging.** The design's "Logging and diagnostics" text predates the `Logger`. `PtyBrokerClient` takes `log: Logger` (the `onRuntimeEvent` sink is gone) and writes the runtime line at the level [architecture](../architecture.md) maps ("Levels of the Chat broker runtime line"; `chatBrokerChoiceLevel` is the code side). It writes one line per launch, once the outcome is known: for Bun when a Bun broker exists (running, or started and not yet confirmed), for a fallback with its reason; a refused Bun start logs only the fallback line, so no line ever says a VS Code update does not end a broker that was then not used. The start timings (`runtime check`, `verify`, `broker spawn`, `handshake`) that `main` added to a new session's launch line are measured per runtime (for a Bun broker `runtime check` is the whole plan: setting, launch, trust read and pipe-only proof), and the time of a refused Bun attempt is its own phase, `bun attempt`.
- **Verification state.** The unit and real-broker results in "Verification results" above were measured on the branch before the merge. After the merge the focused suites that cover the merged modules were rerun, and the merged build passed an isolated-window proof over the installed build (a Bun-hosted Chat surviving an emulated update, a standalone `omp.exe` Chat, a reload restore); that run's evidence is not kept in this repository.

## Related Decisions

[ADR-0074](../decisions/0074-run-chat-brokers-on-the-sessions-own-bun-runtime-with-code-exe-as-fallback.md), which narrowly amends ADR-0012 (the runtime-executable rule), ADR-0024 (the native runtime load tree and the matching runtime/ABI proof) and ADR-0032 (a pipe-only proof for a Chat-only runtime); ADR-0006, ADR-0030, ADR-0031, ADR-0038, ADR-0054, ADR-0062.

## Architecture Review

- Reviewer: architect (two independent read-only passes)
- Outcome: accepted after corrections
- Notes: the first pass found five material and twelve minor findings, all addressed. The second pass (code and text, with file and line evidence) found no race (no path starts a second broker for a slot or lets a Bun broker replace a recorded one) and two material findings, both fixed: a Bun broker that published a record and then could not be attached, or stayed silent, now holds the file off the Bun path for the next Chat; the updater notice no longer says every session host is a `Code.exe`. Its minor findings are applied (two PowerShell starts per launch, the trust read running beside the self-check, hold semantics, no pipe-only proof log, README and architecture wording, owner placeholders, the unhandled asynchronous spawn error). Optional ones not taken: a single-flight holder for the pipe-only readiness, and the file id in the stored proof key.
