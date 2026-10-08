---
status: accepted
date: 2026-10-07
---

# ADR-0046: Detect an outside OMP writer by opening OMP's own session-lease mutex, read-only

## Context and Problem Statement

The extension only knows the writers it owns. A plain `omp` in a terminal writing the same session is invisible to it, so the row reads "Stopped" and Open starts a second writer. OMP protects the file itself (it moves the second writer to a sibling file), but the user is told nothing. Installed OMP exposes exactly one exact, kernel-maintained signal of "a live process is writing this session": its session ownership lease. The signal relies on an OMP-internal detail, which is why this choice needs a record.

Requirements: exact (no heuristics on timestamps or command lines); provably unable to block or disturb OMP; wrong only in safe directions; a user override; no effect on this extension's own writers.

## Considered Options

- **Open the lease's named mutex with `SYNCHRONIZE` access and close it at once (chosen).** Exact and kernel-backed; the kernel drops it when the holder dies. Depends on OMP's name derivation.
- **Acquire the lease and release it.** Same exactness, but taking the lease makes a concurrently starting OMP lose it and fall back to a sibling file. A probe that can interfere is not acceptable.
- **Infer from the session file's modification time or from the process list.** No dependence on OMP internals, but wrong in both directions (an idle terminal has no recent write; a finished one does; a command line does not name the session).
- **Use OMP's native module from the extension.** Needs the 190 MB addon and an acquiring API; no read-only entry point.
- **No detection; keep relying on OMP's sibling-file fallback.** Nothing to maintain, but the user learns of the duplicate afterwards.

## Decision Outcome

Open the lease mutex read-only, through a staged PowerShell helper (`Mutex.TryOpenExisting(name, Synchronize)`, handle closed immediately), batched per refresh, and treat only "the named object exists" (or an access-denied answer, which only an existing object gives) as "held". The result is a distinct row state and a confirmation (**Open Anyway** / **Cancel**) before an explicit launch that can start a writer; it never refuses.

### The derivation (verified against OMP 18.6.3)

1. **Session id.** From the session file's header (`type: "session"`, `id`). The lease name is the id when it matches `^[A-Za-z0-9_-]{1,128}$`; OMP hashes any other id with a hash this extension does not reproduce, so such an id is "unknown".
2. **Lock path.** `path.resolve(path.join(<owners dir>, <name>)) + ".lock"`. The owners directory is `<home>/<PI_CONFIG_DIR or ".omp">/run/session-owners` (OMP `getSessionOwnersDir`, profile-independent; XDG redirection applies on Linux only).
3. **Mutex name.** `Global\omp-file-lock-` + `hex16(xxh64(utf8(lockPath), 0x4f4d502d4c4f434b))` + `hex16(xxh64(utf8(lockPath), 0x50492d46494c454c))` (two 64-bit XXH64 values with those seeds, each as 16 lower-case hex digits). No case folding, separator normalization or canonicalization applies; the hash is case-sensitive over the exact UTF-8 string.
4. **Semantics.** The native lock creates the mutex without initial ownership and reads `ERROR_ALREADY_EXISTS` as "someone else holds it", so the lease is held exactly while the object exists; the last handle closing removes it.
5. **When.** OMP takes the lease on the first write of a session and keeps it until the process exits or switches session. A process that merely resumed a session holds none.

**How it was verified.** The native source is not shipped; the construction was recovered from the shipped native binary (the two seeds are immediates in the function that builds the name, followed by two calls of an XXH64 routine and a hex format) and then checked empirically: 15 lock paths (lengths 0 to 83 bytes covering both the short and the 32-byte-stripe XXH64 paths, a non-ASCII home directory, another drive) were acquired through OMP's own `FileLock.tryAcquire`, their names read back from the kernel object directory and compared with the derivation; and the name derived for a real session id matched the object a real `omp --mode rpc` process created for it after its first write, was visible to the production helper while that process lived and absent after it exited. The recorded vectors are in `src/host/omp-session-lease.test.ts`. OMP 18.0.4 (standalone) created no such mutex for a written session, and the id-keyed lease first appears in OMP 18.5.0's changelog, so only 18.6.3 is a verified positive. Re-verification is manual on each OMP update (the recorded vectors are constants and keep passing); there is deliberately no version gate ([ADR-0011](0011-use-installed-omp-without-version-gate.md)).

### Safe-direction failure modes

- **Derivation changes after an OMP update.** The probe then looks for a name nothing creates: "absent", the behavior before this decision. OMP still moves a second writer to a sibling file. No data loss.
- **Probe cannot run** (helper missing or changed, PowerShell blocked or in Constrained Language Mode, timeout of 5 s, malformed output): unknown; rows unchanged; one log line.
- **False "held".** A transient handle on the name (a concurrent `omp gc`, a probe in flight); a child of this extension that no claim or broker record can verify (a surviving child of a dead broker, a writer left running by a reloaded window, unreadable claim storage); or a copied session file with the same id as a row this window runs. The row says "Another OMP process that this window does not run", which is accurate for these cases too: a live writer exists. The cost is a row label and a dialog the user answers with **Open Anyway**; nothing is blocked and no state is written.
- **False "absent".** A terminal that has not yet written; a `PI_CONFIG_DIR` set in the user's shell but not in the extension host's environment, or only in OMP's own `.env`; `PI_TEST_SESSION_OWNERS_DIR`; an id OMP hashes. Today's behavior.
- **Interference.** The helper only opens and closes a handle; it can neither block nor take the lease. With negligible probability (the holder exits and a new OMP tries the lease within the microseconds the handle is open) that OMP sees the lease taken and moves its writes to a needless sibling file. No data is lost, and the requirement "cannot disturb OMP" is met except for that window.

### This extension's own processes

Its brokers' `omp` children hold leases too. The observation is skipped, and the row keeps its ordinary state, when another window's live claim exists (**Open in another window** wins), when this window holds a live claim, when a verified writer exists under one of this extension's brokers, and for any row this window runs. A writer that none of those can verify is reported as the outside writer it cannot be told from. No signal is sent to anything and no lease is taken.

### Where the confirmation applies

An explicit attempt asks when it can start a writer: a Resume, and an Open or click of a row whose run intent is not stopped. A stopped row's plain Open is a history view and never asks. Add to Session on such a row asks the same question, and Cancel adds nothing. **Known limitation:** a restored editor and the activation pass's automatic relaunch do not consult the lease and never prompt; if an outside process holds the session then, OMP moves the relaunched writer to a sibling file. Making those paths decline silently needs an index-level port and is a separate change under ADR-0039's automatic gate.

### Consequences

- Positive: the user sees that a terminal is writing a session before opening it a second time; the confirmation covers every explicit launch that can start a writer; the probe cannot block OMP; a wrong guess degrades to the old behavior.
- Negative: a dependency on an undocumented derivation that must be re-verified when OMP changes its native lock; no detection until the other process has written; one PowerShell run per refresh pass (one run for all rows, cached 2 s); an explicit launch waits for one fresh helper run (a PowerShell start, bounded at 5 s) before its editor opens; the row clears when the view is next refreshed (focus, visibility or click), not at the instant the terminal exits.

## Related Documents

- [Detecting a session another OMP process is writing](../designs/2026-10-07-external-omp-session-lease.md)
- [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md) (the refusal policy is unchanged), [ADR-0045](0045-derive-window-folders-per-window-and-pin-with-identity-ids.md), [ADR-0012](0012-run-child-process-entries-from-staged-copies.md)

## Architecture Review

- Reviewer: architect
- Outcome: accepted with changes
- Notes: no blockers. Resolved: confirmation predicate widened beyond the verb (M1, restore/automatic gap recorded as a known limitation); dialog, tooltip and design wording no longer claim the writer is provably outside the extension (M2); Add to Session cancels cleanly (M3); probe bounded at 5 s and the latency cost stated (M4); interference and drift statements corrected, drift is checked manually (M5); access-denied reads as held and the failure table gained the missing causes (m2, m5); wording and count fixes (m1). Left as decided: a click on an external row asks rather than showing history (ADR-0045 precedent, m3); Forget stays hidden and Delete is unchanged (m4).
