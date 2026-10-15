---
status: accepted
date: 2026-10-09
---

# ADR-0054: Verify Private Windows Storage With Security Identifiers From Module-Free .NET

> **Narrowly amended by [ADR-0076](0076-call-win32-in-process-through-a-staged-koffi-module-instead-of-starting-powershell.md):** the module-free .NET reader (decision 1) and the rejected "native in-process reader" are replaced by an in-process native reader (`GetNamedSecurityInfoW` through a staged `koffi.node`), with the same refusal semantics, SID rule and 20 s bound; a NULL DACL reads as an Everyone entry and an unknown ACE type refuses.

> **Narrow amendment ([ADR-0076](0076-call-win32-in-process-through-a-staged-koffi-module-instead-of-starting-powershell.md), decision 11):** the verification of the staged native module's own layout is reused on a warm start, on a recorded stat proof that expires after 24 hours and is bound to the account and to a local fixed NTFS volume, instead of being repeated by a child process at every window start; the carrier replace-rights rule and the owner rule are judged again natively by the loading activation before the module is shared, so the cache lifts this ADR's reservation of verdict caching for this layout only (see ADR-0076, decision 11). Every other store is verified at every use as here.

## Context and Problem Statement

OMP Desk 0.1.0 rejects legitimate private storage on localized Windows. Its `icacls` listing is decoded as UTF-8 although the tool writes console OEM bytes, and the allowlist compares English account names. Russian Administrators therefore appears as twelve replacement characters and remains refused even if decoded correctly. Owner and current-account names have the same encoding problem.

[ADR-0006](0006-host-generated-key-peer-verified-pipe.md)'s same-user boundary and [ADR-0012](0012-run-child-process-entries-from-staged-copies.md)'s storage/carrier policy must remain equally strict. Identity spelling must never decide trust. This decision narrowly amends ADR-0012's owner-read fallback, not its carrier or volume-root policy.

## Considered Options

- Decode OEM output and enumerate localized names: rejected; spelling/domain ambiguity remains and each language requires another security allowlist.
- Translate console-tool names to SIDs: rejected; translation depends on exact untruncated decoding, while `dir /q` can truncate owners.
- Read SIDs through Windows PowerShell's module-free .NET file/directory security APIs: selected; owners, token users and rules carry stable SIDs and numeric access masks. Explicit UTF-8 preserves diagnostic names and paths.
- Keep `Get-Acl` with the `dir /q` fallback: rejected; the fallback exists for images that block the security module, and direct .NET needs no such module. If policy also blocks PowerShell/.NET, refuse rather than guess.

## Decision Outcome

1. Read `Directory.GetAccessControl` or `File.GetAccessControl` directly, `GetOwner(SecurityIdentifier)` and `GetAccessRules(true, true, SecurityIdentifier)`. Obtain the current account SID from `WindowsIdentity.GetCurrent().User`. Batch ACL paths in one bounded process per pass; read owners independently in another (**amended 2026-10-13: the SID, the access lists and the owners are now read in one process per pass, see the amendment below**). Missing, empty, failed or malformed reports refuse admission.
2. Compare only SIDs: current user, SYSTEM (`S-1-5-18`), Administrators (`S-1-5-32-544`), TrustedInstaller (`S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464`), CREATOR OWNER (`S-1-3-0`), OWNER RIGHTS (`S-1-3-4`) and SELF (`S-1-5-10`). Optional `NTAccount` translation is diagnostic only: failure leaves the SID visible without changing admission. Everyone, Users, Authenticated Users and foreign/unresolved SIDs remain refused for stores. A placeholder cannot bypass independent refusal of an untrusted owner.
3. Explicit and inherited deny ACEs do not grant access. Mandatory labels belong to the SACL, not the access-rule collection. Carrier reads permit foreign read/execute/create/data/attribute writes only without replacement or re-permission rights. Delete, delete-child, write-DACL, write-owner, generic-all, maximum access and unknown mask bits refuse; Modify includes Delete and therefore refuses.
4. Emit bounded JSON with numeric masks, SID-prefixed diagnostic principals and deny flags; explicitly set console output to UTF-8. No OEM account output remains parsed. Keep the non-recursive `icacls` rewrite with numeric `*SID` grants. Ignore its localized stdout; its exit status and independent readback decide success. Retire the name parser and truncated owner-column fallback rather than maintaining two identity conventions.

### Consequences

- Positive: Russian and other localized account names neither weaken nor falsely fail the boundary. Diagnostics show a stable SID plus the resolved display name when known.
- Positive: images that cannot load the `Get-Acl` module can use direct .NET without lossy columns.
- Negative: policy that disallows Windows PowerShell or security API calls leaves storage unavailable, explicitly fail-closed. Direct .NET does not claim to bypass constrained-language restrictions.
- Negative: optional name translation shares the read's finite timeout. A delayed/unavailable security reader remains an availability refusal.
- Negative: each ACL batch retains a 64 KiB output limit, a 20-second timeout and Windows' environment-size bound. A sufficiently large store or slow domain name resolution can therefore remain unavailable, not accepted with incomplete evidence. No unbounded reader or permissive fallback is introduced.
- Unchanged: path checks, non-recursive rewriting, carrier ownership, volume-root trust and verify-then-use races are not redesigned. Arbitrary same-user code remains outside ADR-0006's boundary.

## Verification

Focused fixtures cover English and Russian identities, Windows-encoded CP866 bytes and UTF-8 SID readback, Users/Everyone/Authenticated Users/foreign/unresolved refusal, display-name collisions, trusted owner placeholders with a foreign owner, malformed reports and numeric replacement rights. A Windows-only test uses a real private directory, a `chcp 866` / `icacls` invocation, and a real Users read grant that must refuse. Repository builds do not claim installed-extension acceptance.

**Observed on the development machine (2026-10-09), by a separate verifier:** typecheck and build passed; the full suite passed 2,245 tests with one platform skip and no failures or cancellations. The real-directory test accepted the restricted store, preserved an already-clean inheriting child, read single/multiple ACL paths and owners as SIDs, and refused an added Users read grant by `S-1-5-32-545`. The forced-code-page command ran successfully, but its captured stdout did **not** contain the expected CP866 bytes of the Cyrillic path (`Cyrillic path bytes present=false`); this is an attempted console-path observation, not proof of genuine Russian-Windows output. Russian-name acceptance/refusal is covered by captured CP866 fixtures and UTF-8 SID readback. Native Russian Windows, constrained-language images and separately driven timeout/oversize branches remain unexercised. No VSIX was built or installed by this package.

## Amendment 2026-10-13: Read the SID, every access list and every owner in one process per pass

**Status: accepted after independent architecture review (accept with required changes; all addressed, see "Amendment Review" below).**

### Context

Decision 1 batches the ACL paths in one process per pass and reads the owners "independently in another"; the account SID is a third process. A bare verification pass was therefore three PowerShell starts, and a `restrictPrivateStorage` call four (SID, directory ACLs for the rewrite decision, store and carrier ACLs, owners). Every attach of a restored session waits for the broker state-directory pass (it runs once per window, and each attach awaits it), and staging a runtime tree runs two restrictions (`stageRuntimeTree`: before and after the copies), so the identity probe helper costs eight starts. On a loaded machine a start takes 3.5–7 s instead of 0.3–0.6 s, and a Reload Window of three windows spent 15–22 s per window in the state-directory pass alone (analysis in `.omp/workspace/notes/reload-restore-timing-2026-10-13.md`; not a permanent record). The per-start cost is what scales with load, not the reads.

What the "independently in another" clause protected is that a failed owner read cannot be mistaken for an access list, and the reverse. It never relied on the two reads being different processes: both ran the same trusted `powershell.exe` as the same account against the same .NET calls.

### Considered options

- Keep the owners in a separate process but start both at once: rejected; it saves wall time, not process starts, and the starts are the cost that grows with load.
- A persistent PowerShell worker per window: rejected here; it adds a long-lived child, an IPC protocol and staleness questions, and replaces ADR-0012's "bytes re-read before every spawn" with a process that outlives the check. It would need its own threat review.
- Cache verdicts across passes or windows: rejected here; ADR-0035's and ADR-0032's 2026-10-13 amendments reserve it for a separate review of the other-account boundary.
- A native in-process reader: rejected; ADR-0006 deliberately ships no native security binary.
- A chunked reading protocol for large trees: not added; an oversize reading refuses (decision 3).
- One process per pass: selected.

### Decision

1. **One process, three independently judged reads.** A single module-free script emits one UTF-8 JSON document `{ sid, reports: [{ path, entries, owner }] }` for the union of the paths a pass needs (the store, its directories, the verified files and every carrier, each once). Per path the descriptor is read once (`GetAccessControl`) and both the rules (`GetAccessRules(true, true, SecurityIdentifier)`) and the owner (`GetOwner(SecurityIdentifier)`) are taken from it, each in its own `try`: `entries: null` is an unreadable access list, `owner: null` an unreadable owner, `sid: null` an unreadable token. Each channel is judged exactly as the separate readers were: a null, empty, malformed or foreign-SID access list refuses; a null or untrusted owner refuses; a missing SID refuses. Display names are translated once per distinct SID inside the process.
2. **Whole-reading failures refuse everything.** A process that fails to start, exits non-zero, times out, exceeds the output cap or prints something that is not that document (not JSON, no `reports` array), and a document that names a path twice (case-insensitively), leaves the SID, every access list and every owner unread, so every check that consults them refuses. A path the document omits is unread. Probes (`readAcl`, `readOwners`, `currentSid`) still replace exactly the read they name; a pass whose reads are all supplied starts no process.
3. **Bounds.** The 20 s timeout and the 64 KiB output cap now cover the whole reading instead of each of three. Output is about 0.5 KB per path (4.7 KB measured for nine paths; the packaged runtime tree is 24 files, so a staging pass is about 20 KB). A tree that outgrows the cap is refused (fail-closed), never read partially.
4. **`restrictPrivateStorage` verifies first.** A store already limited to the owner, SYSTEM and Administrators needs no rewrite, and a verification pass proves that on its own: every directory the rewrite may touch is in the set the pass reads, and the pass refuses when any of them has a principal outside the permitted set, which is the rewrite's own test. So the restriction runs the verification pass first and returns its readiness when it passes: one process. When the pass refuses, the rewrite decides from that refusal's own reading (no access rule was written since; the pass may have created and removed its probe file, which changes none), or, when the pass stopped before it read anything (a link, a store inside the workspace, a path that is not plain), from one fresh read of the directories. It rewrites the directories that are not limited and re-reads the remaining ones after each rewrite that can change inherited rules (one process each). **If nothing was rewritten the refusal stands**: this call wrote nothing since the refused pass, so the same checks are not run again (a transient refusal, such as a failed probe write, a verified file that vanished or one descriptor read failing once, is therefore not retried here; `verifyPtyStateAccess` keeps its own retry for vanished files, and a caller may call again). **If a rewrite happened, a closing pass from a fresh reading decides.** When the one reading failed as a whole there is no account SID, and the call leaves the access rules untouched (decision 6). The verification pass writes its probe file only after every access check has passed, so no byte is written into a store that was not already limited; ADR-0007's "restricted before the first byte" holds unchanged.
5. **Nothing else changes.** SIDs only, the permitted set, deny handling, the carrier replace-rights rule, owner-must-be-trusted, non-recursive numeric `icacls` grants, ignoring `icacls` stdout, the volume-root anchor, UTF-8 output, and ADR-0012's "bytes re-read before every use" are as before. This is not a cache across operations: every verification pass takes its own reading, nothing is kept between passes or calls (ADR-0035's and ADR-0032's amendments name caching of these verdicts as needing a separate review, and it remains so). Inside one `restrictPrivateStorage` call two things are reused, and neither can admit: the refused pass's reading chooses which directories to rewrite (a stale reading can only cause a redundant rewrite, or a skipped one that the closing pass then refuses), and a refusal with nothing rewritten is returned as it stands.
6. **The remedial rewrite needs the SID.** When the whole reading fails there is no account SID, so the restriction returns "the owning account could not be resolved, so the access rules were left untouched" after that one reading, without repeating a timed-out read. At the previous revision the SID was read in its own process, so a failure of only the directory read still allowed the rewrite to tighten every directory. Admission is unaffected (such a store was refused either way); over-broad directories stay as they are until a later pass reads successfully.

### Consequences

- Positive: a bare pass is one start instead of three, a restriction one instead of four, and staging two instead of eight; the state-directory gate every restored session waits on is one start. Measured by the package owner on the development machine on 2026-10-13, idle but not otherwise quiesced, with a counting `spawn` wrapper over a scratch store (`.omp/workspace/tmp`, not permanent): state-directory pass 4 starts / 1.5–1.8 s → 1 start / 0.41–0.49 s; probe-helper staging of an already staged tree 8 starts / 2.8–3.3 s → 2 starts / 1.0 s; first-time establishment of the rules 5 starts / 1.9 s → 3 / 0.86 s. Under load the gap widens because the per-start cost scales.
- Positive: a path's access list and owner come from one descriptor snapshot, so they cannot disagree because the file changed between two reads; a path reported twice now also invalidates the owners (before, duplicate owner lines were last-one-wins).
- Negative: a single failure channel (timeout, oversize, malformed document) takes the SID, the access lists and the owners down together, where before an owner-process failure left the ACL verdicts standing. Every consumer refuses in all those cases; the one behavioural loss is decision 6. Name translation of all rules and owners shares one 20 s budget (each distinct SID is translated once to keep it small).
- Negative: a refusal the rewrite repairs costs the refused pass, the directory rewrites and a closing pass; a refusal nothing can repair costs one pass and is not retried inside the call (decision 4).
- Unchanged: the ADR's other negatives (policy blocking PowerShell/.NET leaves storage unavailable; verify-then-use races are not redesigned).

### Verification

Behaviour tests (`private-storage.test.ts`, `rpc-reconcile.test.ts`, `pty-attach-identity.test.ts`): one reading serves a pass (a counting probe) and a probe replaces only the read it names; a wrong owner, an unreadable owner, a path the process left out, an extra ACE on the store, a replace right on a carrier, an unreadable and an empty access list, a process failure and a timeout *result* (`parseStorageSecurity` fed an `ok:false` timeout result; the real timeout and oversize branches of the process runner were not run), and each malformed document (empty, not JSON, `null`, an array, no `reports`, `reports` not an array, SID missing or not a SID, a path reported twice) all refuse; a good document is admitted by the same path; `restrictPrivateStorage` costs one reading for a limited store and no `icacls`, decides a rewrite from the refused pass's reading, verifies again from a fresh one, refuses a rewrite that did not take, returns an unrepairable refusal after one reading, and does not repeat a timed-out reading; a Windows-only test starts exactly one real PowerShell for a limited real store and traces it with a purpose, a pid and a duration. The CP866/Users-grant smoke test passes with its readback assertions migrated from the removed `readStorageAcls`/`readStorageOwners` to `readStorageSecurity` (its refusal of a real Users read grant and the preserved clean child are unchanged assertions). Static and focused-test evidence only; installed-extension acceptance is separate.

## Related Documents

- [ADR-0006](0006-host-generated-key-peer-verified-pipe.md): same-user trust boundary.
- [ADR-0007](0007-native-file-evidence-and-guarded-restore.md): storage admission before capture.
- [ADR-0012](0012-run-child-process-entries-from-staged-copies.md): staged copies and carrier verification.
- [Architecture](../architecture.md): private storage and staged runtime assets.

## Architecture Review

- Reviewer: independent reviewer agent (read-only architecture/security review, 2026-10-09).
- Outcome: accept; no material architecture/security finding. Static review is not runtime proof.
- Notes: the review covered the proposed decision and frozen source/test revision. Four non-blocking observations were triaged: stale pre-rewrite ACL snapshots are corrected by refreshing remaining paths after a rewrite; the final verification reuses the already resolved token SID; the bounded batch's availability risk is recorded above without adding an unrequested chunking protocol; signed generic-mask, unreadable-owner and real single/multi-path coverage was added. Timeout/oversize and malformed outer-batch branches were not separately runtime-exercised by that review. Subsequent functional diagnosis corrected PowerShell's nested JSON-array enumeration without changing the accepted design.


## Amendment Review

- Reviewer: independent architect agent (`AdrAmendmentReviewer`, read-only, static review of the 2026-10-13 amendment and its working-tree implementation, 2026-10-13).
- Verdict: **accept with required changes.** Merging the reads weakens no admission check; the verify-first restriction keeps ADR-0007's ordering; the reused reading is not the cross-operation caching ADR-0035/0032 reserve; no caller can admit on partial evidence.
- Required change (material F1): the code gained an early return (nothing rewritten, so the refusal stands) while the review ran, and the amendment, `architecture.md` and the function's comment still said every call ends with a fresh closing pass. Addressed: decisions 4 and 5, Consequences, Verification, `architecture.md` and the comment now describe it, and a test covers it.
- Non-material findings addressed: the pre-read refusal case and "no access-rule write" wording (decision 4); the lost remedial rewrite when the whole reading fails (decision 6, Consequences, changelog); rejected alternatives (Considered options); the smoke-test and attribution wording and the unexercised real timeout/oversize branches (Verification, Consequences); the pointer from decision 1 and the documentation index; the three-versus-four-start and once-per-window wording (Context); the stale `readiness` comment; name translation made once per distinct SID.
- Second round (static, 2026-10-13): the reviewer re-read the amended ADR, `architecture.md`, README entry and `private-storage.ts` and confirmed the text matches the code (decisions 4–6), with no material finding; `accepted` is justified. Its optional notes were taken: decision 4 says "nothing this call wrote" rather than "nothing changed", and a null owner SID in the name cache throws inside the owner `try`, so the owner stays null and the path refuses, as before. No code was run by the reviewer.