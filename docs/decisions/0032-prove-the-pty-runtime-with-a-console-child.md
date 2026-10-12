---
status: accepted
date: 2026-09-28
---

# ADR-0032: Prove the staged PTY runtime with a console child's own markers, not the native exit code

> Narrowly amended by the [rpc-ui design](../designs/2026-09-29-rpc-ui-chat-and-sessions.md) (ADR-0038), section 1, "Attach does not wait on runtime staging": the runtime proof below still gates every path that *starts* a child under the staged tree. Attaching to an already-running broker no longer waits for it; it needs only the staged, verified identity probe and the record's token handshake.

> Decision Outcome amended 2026-10-12 (accepted after independent architecture review): a run that only ran out of time is *inconclusive* and admits a launch provisionally, without being kept as proof; see [Amendment 2026-10-12](#amendment-2026-10-12-a-timeout-with-no-observed-fault-is-inconclusive).

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

## Amendment 2026-10-12: a timeout with no observed fault is inconclusive

### Context

With the machine saturated, a whole self-check run was measured at up to 14 s against about 4 s idle, and a phase that missed the 15-second deadline refused the runtime with exit code 7 (`the pipe child did not finish within the self-check deadline`). Every session start in that window failed, although nothing about the tree was wrong. A deadline that passes with nothing observed is absence of evidence: it cannot tell a healthy late runtime from a hung one.

### Decision

A run now ends one of three ways, reported by the entry as `outcome` and by its exit code:

- **proven** (exit 0): unchanged — both markers, the backend's exit report and the pipe-child echo. An exit-0 answer is validated as before; it needs no `outcome` field, so an older entry's success is still accepted.
- **broken** (exit 7): a fault was *observed* — a nonzero exit code the backend reported, a completed run without its markers, a pipe-child write error, an echo that is not exactly the line given plus `\n` (checked on every chunk and again at close), a pipe child that exited with any code other than 0, an addon that did not load, a malformed answer. A timeout after an observed fault is still broken.
- **inconclusive** (exit 8): the default 15-second deadline of a phase passed and nothing observed contradicts the runtime.

The host admits lateness only on a consistent answer: exit 8 *and* `ok: false` *and* `outcome: "inconclusive"` *and* no nonzero `childExitCode` reported beside it, for a run given the default deadline. Any other nonzero exit — including an older entry's answer without `outcome`, or `inconclusive` under exit 7 — is a refusal. The host's own kill bound (both phases' deadlines plus 30 s) counts as lateness only when the entry printed nothing at all; an answer it did print outranks the kill.

The host (`src/host/pty-runtime.ts`, `src/host/pty-runtime-proof.ts`) treats them so:

- a proven answer is kept for the activation, as before;
- an inconclusive answer admits the launch as `ready: true, proven: false` from the staged, re-verified tree, is **not** cached as proof, and is logged (`PTY runtime admitted unproven`). One background re-run with the extended **90-second** deadline per phase starts 20 s later; at that deadline a timeout is never inconclusive (the entry reports it as broken and the host refuses an `inconclusive` answer to it), so the re-run either proves the tree (kept) or refuses it. A re-run that cannot even be started is retried twice more at 20-second intervals; if all three fail, the provisional admission is dropped and the next launch runs a fresh first probe;
- a refusal from that re-run is held for 60 s, so the following launches get the fault instead of another provisional admission from a fresh short probe; after the hold a new probe runs, because the refusal can itself be a probe starved past its deadline;
- a refusal from the first probe is not held, as before.

Attaching to an already-running broker is unaffected (see the note at the top).

### Consequences

- Positive: a slow machine no longer fails session starts; a fault the runtime actually showed is still a refusal at once.
- Negative: a genuinely hung or output-less backend is admitted provisionally until the re-run refuses it. The console and pipe phases each get 90 s, and the host kills the entry after 210 s, so the refusal arrives about 20 s plus up to 180 s (210 s if the entry never answers) after the admission. Sessions started in that window run on a tree that was never proven and are neither stopped nor repaired by the later refusal; their own spawn reports its own failure. The refusal blocks only later launches.
- Negative: 90 s per phase is an operational bound, not proof that CPU starvation cannot last longer; a re-run starved past it refuses a healthy tree for the 60-second hold.

### Review

- Reviewer: architect (separate, disposable read-only agent), against the source, tests and this text.
- Outcome: accepted after three passes. Round 1 found two major defects — the host admitted any nonzero exit labelled `inconclusive` (including exit 7 and an answer to the extended re-run), and a pipe-child write error was discarded so a later timeout was excused — and four claim mismatches: re-runs that kept throwing left the runtime provisional forever, the older-answer rule, the per-phase time bound, and the exact-echo rule on normal completion. All were fixed in code, tests and this text. Round 2 found one remaining gap (an `inconclusive` answer that also reported a nonzero child exit was admitted); fixed with a regression test. Round 3 confirmed no remaining findings.
- The choice itself (inconclusive admits provisionally, an extended re-run settles it) was not in question.

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
