---
status: accepted
date: 2026-10-09
---

# ADR-0054: Verify Private Windows Storage With Security Identifiers From Module-Free .NET

## Context and Problem Statement

OMP Desk 0.1.0 rejects legitimate private storage on localized Windows. Its `icacls` listing is decoded as UTF-8 although the tool writes console OEM bytes, and the allowlist compares English account names. Russian Administrators therefore appears as twelve replacement characters and remains refused even if decoded correctly. Owner and current-account names have the same encoding problem.

[ADR-0006](0006-host-generated-key-peer-verified-pipe.md)'s same-user boundary and [ADR-0012](0012-run-child-process-entries-from-staged-copies.md)'s storage/carrier policy must remain equally strict. Identity spelling must never decide trust. This decision narrowly amends ADR-0012's owner-read fallback, not its carrier or volume-root policy.

## Considered Options

- Decode OEM output and enumerate localized names: rejected; spelling/domain ambiguity remains and each language requires another security allowlist.
- Translate console-tool names to SIDs: rejected; translation depends on exact untruncated decoding, while `dir /q` can truncate owners.
- Read SIDs through Windows PowerShell's module-free .NET file/directory security APIs: selected; owners, token users and rules carry stable SIDs and numeric access masks. Explicit UTF-8 preserves diagnostic names and paths.
- Keep `Get-Acl` with the `dir /q` fallback: rejected; the fallback exists for images that block the security module, and direct .NET needs no such module. If policy also blocks PowerShell/.NET, refuse rather than guess.

## Decision Outcome

1. Read `Directory.GetAccessControl` or `File.GetAccessControl` directly, `GetOwner(SecurityIdentifier)` and `GetAccessRules(true, true, SecurityIdentifier)`. Obtain the current account SID from `WindowsIdentity.GetCurrent().User`. Batch ACL paths in one bounded process per pass; read owners independently in another. Missing, empty, failed or malformed reports refuse admission.
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

## Related Documents

- [ADR-0006](0006-host-generated-key-peer-verified-pipe.md): same-user trust boundary.
- [ADR-0007](0007-native-file-evidence-and-guarded-restore.md): storage admission before capture.
- [ADR-0012](0012-run-child-process-entries-from-staged-copies.md): staged copies and carrier verification.
- [Architecture](../architecture.md): private storage and staged runtime assets.

## Architecture Review

- Reviewer: independent reviewer agent (read-only architecture/security review, 2026-10-09).
- Outcome: accept; no material architecture/security finding. Static review is not runtime proof.
- Notes: the review covered the proposed decision and frozen source/test revision. Four non-blocking observations were triaged: stale pre-rewrite ACL snapshots are corrected by refreshing remaining paths after a rewrite; the final verification reuses the already resolved token SID; the bounded batch's availability risk is recorded above without adding an unrequested chunking protocol; signed generic-mask, unreadable-owner and real single/multi-path coverage was added. Timeout/oversize and malformed outer-batch branches were not separately runtime-exercised by that review. Subsequent functional diagnosis corrected PowerShell's nested JSON-array enumeration without changing the accepted design.
