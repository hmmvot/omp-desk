---
status: accepted
date: 2026-09-28
---

# ADR-0032: Prove the staged PTY runtime with a console child's own markers, not the native exit code

> Narrowly amended by the [rpc-ui design](../designs/2026-09-29-rpc-ui-chat-and-sessions.md) (ADR-0038), section 1, "Attach does not wait on runtime staging": the runtime proof below still gates every path that *starts* a child under the staged tree. Attaching to an already-running broker no longer waits for it; it needs only the staged, verified identity probe and the record's token handshake.

## Context and Problem Statement

[ADR-0024](0024-own-omp-pty-for-in-tab-terminal.md) requires the broker runtime and its native
addon to be *proved* on packaged Windows before the PTY surface may be enabled, so an ABI or
backend mismatch is reported at startup instead of failing on the user's first session.
`pty-broker.js --self-check`, run by `src/host/pty-runtime.ts` against the staged tree, is that
proof.

The first implementation spawned **this runtime's own executable** (`process.execPath`, with `-e
<script>`) through the staged `node-pty` backend and took the child's reported exit code as the
verdict: zero admitted the tree, anything else — including an unreported code — refused it.

Three measurements on the installed host show that gate could not pass in the runtime it guards:

- The extension host is Electron and starts the broker with `ELECTRON_RUN_AS_NODE=1`, so
  `process.execPath` is `Code.exe`. An Electron-as-node child attached to a pseudo console
  **writes nothing at all** to that console, whatever the backend: measured with the bundled
  `conpty.dll` and with the OS console host, the child's script ran — it proved so through a side
  effect of its own — and the child exited, while the console delivered zero bytes (not even its
  own terminal queries) and the exit code came back `undefined`. The same script under plain node
  printed both markers. The gate therefore refused a working terminal stack, and did so
  deterministically: three consecutive runs of the staged entry under `Code.exe` all reported
  `ok:false`, and the user-visible symptom was `the runtime self-check failed with exit code 7`.
- The Windows ConPTY backend does not always report a child's exit code even when the child is not
  Electron (a `cmd.exe` child was measured exiting with `code=undefined` while its output arrived
  normally), so "the code must be zero" is not a property a correct runtime can guarantee.
- The backend's first flush of *child* output was measured about three seconds after the spawn —
  after its own terminal queries — and an exit report can therefore arrive **before** any output.
  Any verdict sampled at a fixed moment after the exit judges a healthy child too early.

The question is what positive evidence may admit a staged runtime, and what may not.

## Considered Options

- **Keep this runtime's own executable as the child, and require a zero exit code.** This is what
  the gate did. It is self-consistent, but it measures the child runtime rather than the console
  the broker owns, and an Electron child cannot report through that console at all. Reject.
- **Accept an unreported exit code as success.** Cheap, and it would clear the reported symptom,
  but it also admits a backend that started nothing or delivered nothing to the child: an exit
  report alone says only that *something* ended. Reject.
- **Print markers from the child and require both halves: the child's own bytes read back through
  the pseudo console, and the backend's exit report.** The console half proves the data path a
  session actually needs; the exit report is the backend's own notification that the child ended,
  which is what a still-running child would not produce. Neither half admits a tree on its own.
  Chosen.
- **Use a console client as the child (the platform's command interpreter) instead of this
  runtime's own executable.** The ABI question is about the **parent** — the broker loading the
  addon in the runtime a session runs under — and the child in production is the installed OMP
  executable, not this runtime. A terminal's own command interpreter is the child a folder shell
  runs, and it is what a console backend was measured to carry. Chosen.

## Decision Outcome

A staged runtime is admitted only when one run proves **both** halves through the staged backend:

- the child is a plain console client — on Windows the command interpreter, selected from
  `ComSpec`/`%SystemRoot%\System32\cmd.exe` and started as `cmd.exe /d /s /c "echo <start>&
  <pause>echo <end>"`, with `/d` suppressing machine AutoRun commands and the pause a system tool
  named by absolute path so a `PATH` entry cannot shadow it — and it prints two markers minted from
  a per-run token, separated by that pause, through its pseudo console;
- the backend reports the child's exit.

The exit *code* is not the proof: a code the backend does report must be zero, and an unreported
code is accepted only together with both markers. A nonzero code is refused even when both markers
arrived, and a marker or an exit report that never arrives is refused. The observation runs under
**one deadline** (15 s) covering both halves, because the measured first flush of child output
arrives about three seconds after the spawn and can follow the exit report; the host that started the
entry keeps a longer process bound of its own (60 s, after which it kills the entry). The reported
exit is this backend's own notification that the child ended — not an independently established
process or process-tree absence, which this proof does not claim. Refusals carry the entry's own
one-line reason to the host, which reports it instead of only the entry's status.

### Consequences

- Positive: the gate measures what a session needs (a console that carries a child's output) in the
  runtime that will run it, without depending on the child's runtime identity or on a native exit
  code the backend may not have.
- Positive: a refusal is diagnosable — the reason is the entry's own measurement, bounded to one
  line — so an operator does not have to reproduce the staging pass to learn why a tree was
  refused.
- Negative: a run costs about five seconds (the backend's own start plus the child's pause), and a
  broken tree costs its whole 15-second deadline; the host's 60-second kill bound sits outside it.
- Negative: the proof says nothing about POSIX PTYs, which this design has not measured; the gate
  refuses every non-Windows host before it runs.
- Negative: the markers prove the console carried the child's bytes and the backend reported the
  child's exit, not that any process is independently proven gone, and not that a session's own
  long-lived child will stream perfectly under every backend quirk.

## Related Documents

[ADR-0024](0024-own-omp-pty-for-in-tab-terminal.md);
[ADR-0012](0012-run-child-process-entries-from-staged-copies.md);
[ADR-0029](0029-report-uncontained-pty-tree-stop-as-unknown.md);
[broker-aware restart recovery design](../designs/2026-09-27-broker-aware-restart-recovery.md).

## Architecture Review

- Reviewer: architect (read-only review of the draft ADR against the current source and the linked
  records).
- Outcome: accepted after addressing two medium findings; the reviewed choice (a console child, and
  markers plus the backend's exit notification as the admission rule) was found sound for a bounded
  runtime smoke proof.
- Notes: (M1) the draft claimed one 15-second bound while the entry then waited 30 s for the exit
  and 15 s for the markers, with the host's 60 s kill outside both — the implementation now runs one
  shared deadline over both halves, and the host's separate process bound is stated. (M2) the draft
  called the exit report proof that the child was gone, while the staged dependency's public event
  fires when its output socket closes and the broker performs no independent process check — the
  rationale and the source comments now state the weaker claim they can support. Neither correction
  changes the chosen approach.
