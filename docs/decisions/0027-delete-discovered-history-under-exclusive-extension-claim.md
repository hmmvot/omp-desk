---
status: accepted
date: 2026-09-26
---

# ADR-0027: Delete discovered OMP history under an exclusive extension claim

> Ownership clauses narrowed by [ADR-0039](0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md): absence-proof, unreadable/stale-claim and explicit-release prerequisites are superseded. Delete blocks only a positive live extension writer; local/legacy writers offer one confirmed stop-and-delete. Exact-path freezing, scoped cleanup and truthful partial results survive.

> Narrowed by [ADR-0033](0033-release-stale-ownership-of-an-unidentified-launch-explicitly.md), as narrowly amended by [ADR-0036](0036-release-an-unresolvable-launch-attempt-explicitly.md): deleting a row whose unresolvable recorded launch attempt — no recorded process id, no matched room, or a current `owner-unknown` reading — the user explicitly released is authorized by that release rather than by proof its writer is gone, and the confirmation says so. Every other requirement below is unchanged and still mandatory, including the exclusive claim held through finalization, target freezing/validation, deletion scope and partial-failure recovery; the transaction additionally re-reconciles the live target under its own held claim before removing anything.

## Context and problem statement

Folder Resume includes native OMP session files irrespective of origin. ADR-0018 allows exact-file interactive Resume of external history but formerly refused its destructive deletion. The user requires one visually unified Resume list and a per-file trash action including externally created files. No extension can prove that independently started OMP, or **a user's native `/resume` in another managed TUI**, will not enter this file during deletion. The user explicitly accepts responsibility for native terminal commands; do not block unrelated live OMP sessions or create additional native-command admission machinery to protect this action. Warn clearly about that risk. The current lifecycle's claim is not held through its final row cleanup and does not durably distinguish partial artifact cleanup, so it must change rather than be cited as already satisfying the new contract.

## Considered options

- Keep imported files nondeletable and present a source distinction: protects against accidental external-history deletion but violates the requested unified history action.
- Check a picker path and unlink after a confirmation without an exclusive extension claim: small change, but even a normal extension-issued Resume could race the deletion.
- Use the same exact-file deletion transaction for indexed and discovered files; hold exclusive extension ownership across finalization, warn of native-user/independent-writer residual risk: selected. It excludes known extension-issued competing actions, not native TUI keystrokes or outside OMP processes.

## Decision outcome

Display the exact native JSONL path before confirmation. Explain that OMP deletion also recursively removes the sibling artifact directory named by removing `.jsonl` (including its nested contents) and all adjacent backup files matching `<transcript basename>.*.bak`; this is a **family of targets**, not only one `.bak`, and some may appear after the dialog. Warn that both independently launched OMP and user-controlled `/resume`/similar commands in managed native terminals may enter this file and that deletion during their writes can lose/corrupt history. Provenance does not change eligibility; a known live/held extension owner, uncertain known writer, changed/unverifiable target or concurrent extension-side operation still blocks deletion. Other unrelated managed hosts are not a blanket deletion veto.

Freeze the confirmed canonical file/header/profile identity, then acquire the canonical exclusive deletion claim and the matching local per-session lifecycle gate. Revalidate exact target and known writer/holder facts **under that ownership** immediately before destructive I/O. For an unindexed Resume candidate establish equivalent per-file local serialization before import/claim so the same holder cannot adopt/resume it concurrently. Keep the deletion claim through transcript removal, all related artifact/backup removal and **row finalization**; permit finalizing the row using the exact held deletion authority instead of requiring early claim release. Release only after finalization and recorded result. Neither a stale picker snapshot nor a closed editor is writer-absence proof. This changes the existing lifecycle, which currently releases the claim before its final file/row check.

Match OMP's **target scope** without claiming identical failure ordering: native OMP stops backup cleanup if artifact deletion fails, whereas this extension may continue attempts but must report each actual outcome accurately. Persist native-deletion transaction evidence separately from the raw recorder: frozen target, operation owner/claim generation, transcript removed/not removed, artifact directory cleanup, backup-family cleanup, and finalization status. If transcript is gone but related cleanup is incomplete, report **partial deletion** with the exact leftover category, retain the durable transaction/evidence and do not report full success or silently discard the last recovery pointer. An explicit subsequent recovery can finish verified leftovers under a new exclusive claim; never rerun blind JSONL deletion against a changed file. A completed deletion removes its indexed row, while Forget alone removes only navigation metadata and leaves the file discoverable through Resume.

This supersedes **only** ADR-0018's imported-file deletion prohibition; its exact-file interactive Resume, extension-scoped writer exclusion for extension-issued operations and outside-writer incident rationale remain. ADR-0026 specifies the latest explicit user-responsibility boundary for native TUI switches. An exclusive claim cannot prevent an undetected user-typed native switch into the file, and neither this decision nor a posthoc conflicting-tab error implies that it can.

### Consequences

- Positive: one Delete action for every eligible OMP history file, with exact extension-side exclusion and transparent risk consent.
- Negative: a user-controlled native TUI or independent OMP can still enter/write a file during deletion, potentially losing data. This is not a claim-system defect that the extension can prevent without changing the user's terminal autonomy.
- Negative: ownership-bearing partial-removal state and per-file local serialization add lifecycle work; transcript absence alone no longer means all backups/artifacts were removed or a successful native deletion completed.

## Related documents

[Sessions and in-tab terminal design](../designs/2026-09-26-sessions-and-in-tab-terminal.md); [ADR-0018](0018-resume-imported-history-under-extension-claims.md); [ADR-0026](0026-best-effort-native-tui-switch-ownership.md); [Product context](../product.md).

## Architecture review

- Reviewer: independent architect (initial review and corrective review).
- Outcome: accepted after specifying held claim through finalization, full native target scope, durable partial-failure evidence and user-owned native-command risk.
- Notes: This is a decision contract, not evidence that existing deletion code already holds the claim to finalization.
