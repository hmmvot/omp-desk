---
status: superseded
date: 2026-09-25
---

# ADR-0018: Resume imported OMP history under extension-scoped claims

> Ownership clauses narrowed by [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): imported Resume/Delete/Forget need no absence proof or explicit release; only verified-live extension holders/writers exclude. External-writer risk remains the user's responsibility. Earlier retained-uncertainty clauses are historical.

> Narrowed by [ADR-0033](0033-release-stale-ownership-of-an-unidentified-launch-explicitly.md), as narrowly amended by [ADR-0036](0036-release-an-unresolvable-launch-attempt-explicitly.md): the retained-uncertainty rule this record carries for an unaccounted extension launch does not apply to an unresolvable recorded launch attempt — one that recorded no process id, no matched room, or a current `owner-unknown` reading — whose reservation one explicit user action may release after a fresh best-effort target check. Its exact-file interactive imported Resume and extension-scoped writer exclusion remain unchanged.

## Context and Problem Statement

[ADR-0011](0011-use-installed-omp-without-version-gate.md) also recorded an always-read-only rule for session files discovered outside this extension. It followed a real incident: an extension-started OMP and a separate user-started OMP both wrote one file. Installed OMP has no durable per-session writer marker; its registry and filesystem cannot reliably prove an arbitrary external writer absent. A subsequent implementation put `unmanaged` history behind a read-only editor route, even after the file moved from History into Sessions.

The user has now explicitly corrected that boundary: the application must open **any** OMP session for interactive chat. It must exclude simultaneous writers **within the extension**; concurrency with OMP processes started outside it remains the user's responsibility. This is already the stated product constraint in `docs/product.md`. The read-only rule, not the absence of an external-process detector, caused the reported failure.

## Considered Options

- **Resume the exact history file through the existing claim/GUI route (chosen):** meets the interactive contract and preserves exclusion among extension windows. An unrelated OMP process can still write the file concurrently, by the user's explicit choice.
- **Keep the text transcript or make a read-only chat replica:** avoids a second writer, but refuses the required interactive continuation.
- **Launch without an extension claim:** opens chat but allows two extension windows to append to one transcript; unacceptable.
- **Block on guesses about external OMP ownership:** cannot establish a reliable file-specific absence signal and contradicts the user's ownership boundary.

## Decision Outcome

A discovered OMP session retains the exact file, profile, working directory, recorded host and tab provenance; opening it uses the same Webview panel, local Collab guest, native `omp --resume <exact file>` integration and canonical-file claim as any saved session. Existing adopted rows become eligible on upgrade without replacing their tab IDs or discarding an earlier extension host/claim record. A live per-extension-host holder of the same claim blocks a second window. If an earlier extension launch remains unaccounted, the claim and uncertainty remain; a missing or unreadable claim is never interpreted as an absent extension writer. A file with no recorded extension host has no extension writer to reconcile, but **that says nothing about an outside OMP process**. No extra warning, veto or external-process scan is added.

Import provenance remains separate from interactive permission. Merely opening an externally created file does not grant `Delete Session` the authority to unlink it; this decision changes interactive resume only. Normal stop and Forget operations must nevertheless account for any extension-owned writer the imported row acquired. The old transcript-only editor route is removed rather than kept as an alias.

On acceptance, this ADR supersedes ADR-0011 as the operative record. It replaces only ADR-0011's always-read-only imported-history prohibition; all other operative policies and invariants remain in force unchanged by reference: resolve and re-resolve the user's installed OMP through PATH safely against process identity, apply the pinned guest grammar and supported compatibility checks, do not impose a numeric version gate or install/upgrade/bundle OMP, surface protocol mismatches, and retain ADR-0011's F1–F3 ownership and review invariants. The original incident and rationale remain in ADR-0011 as historical context.

### Consequences

- Positive: History and Sessions clicks open the same interactive GUI for the exact imported file, including after a VS Code restart.
- Positive: extension-created and imported chats share one extension-only claim/holder exclusion path, rather than two security mechanisms.
- Negative: an external OMP instance may still write the same file; this is explicitly the user's responsibility and is not presented as safely excluded.
- Constraint: an imported row's provenance still blocks destructive native-history deletion merely from opening it, and unaccounted earlier extension processes still block a competing extension launch.

## Related Documents

- [Interactive history resume design](../designs/2026-09-25-interactive-history-resume.md) (accepted).
- [ADR-0011: Run installed OMP without a version gate](0011-use-installed-omp-without-version-gate.md) (superseded; version/runtime policy and invariants retained).
- [Product context](../product.md) (user-accepted extension-only single-writer scope).
- [ADR-0026](0026-best-effort-native-tui-switch-ownership.md) narrowly supersedes unconditional writer exclusion for commands typed directly in a managed native OMP terminal. Exact-file extension-issued Resume and external-writer responsibility remain.
- [ADR-0027](0027-delete-discovered-history-under-exclusive-extension-claim.md) supersedes only the imported-provenance prohibition on native-history deletion in Decision Outcome and Consequences; the original incident and exact-file interactive claim path remain.

## Architecture Review

- Reviewer: separate architect.
- Outcome: reviewed; the conditional supersession finding was resolved by explicit replacement and incorporation of surviving ADR-0011 contracts.
- Notes: Acceptance retires the contradictory old history rule without erasing its incident history.
