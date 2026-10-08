---
status: proposed
date: 2026-09-24
---

# ADR-0010: Use the installed, verified OMP 18.3.0 as the single runtime target

> Replaced on 2026-09-24 by [ADR-0011: Run the currently installed OMP without a runtime version gate](0011-use-installed-omp-without-version-gate.md). The user replaced the exact-release policy proposed here **before this record was accepted**, so it is neither an accepted nor a formally superseded decision: it stays `proposed` and is retained unchanged for its rationale and evidence.

## Context and Problem Statement

The user runs exactly one OMP: the global Bun installation of `@oh-my-pi/pi-coding-agent`, whose `omp` on `PATH` reports `omp/18.3.0` and is already authenticated. The user explicitly chose that installed runtime and refused both a second, separate 18.2.11 installation and any change to the global package.

The extension integrates with OMP through internal contracts rather than a stable public SDK: the Collab guest wire grammar (`@oh-my-pi/pi-wire`), the local Collab registry JSON of `omp collab list|link --json`, and the in-process extension API behind the host-control channel. The accepted [development design](../designs/2026-09-24-omp-vscode-development.md) and [ADR-0003](0003-native-host-control-pipe.md)–[ADR-0009](0009-read-only-native-tools-until-atomic-selection.md) recorded that evidence against OMP 18.2.11, and the launcher resolution gate accepted exactly that version. Repointing the gate is not a cosmetic bump: every such contract has to hold for the release actually running, or the extension must refuse visibly instead of degrading inside a live session.

Verified against the contents of the installed 18.3.0 packages:

- `@oh-my-pi/pi-wire` 18.3.0 declares `COLLAB_PROTO = 3`, and the host compares the guest's `hello` `proto` against it, answering `protocol mismatch` and dropping the peer (installed `src/collab/host.ts`). That is a protocol-**number** match only: it does not inspect the guest bundle's age, provenance or behavior, so a stale or drifted guest that still advertises 3 passes `hello`. Compatibility therefore needs behavior validation, not just an equal number. Version 2 introduced the metadata-only `welcome` (header/state/agents/entryCount) followed by ordered `snapshot-chunk` frames terminated by `final: true`; version 3 adds the `ui-request`/`ui-request-end` host frames answered by `ui-response`, which is how native `ask`, select and editor dialogs are answered from the GUI.
- `COLLAB_REGISTRY_VERSION` is still `1`, and `omp collab list --json` / `omp collab link --json` keep the shapes the extension parses (`instanceId`, `generation`, `pid`, `cwd`, `access`; a control link must match the listed generation).
- The per-run config overlay keys the extension writes, `collab.relayUrl` and `collab.autoStart`, still exist in the 18.3.0 settings schema.
- Known 18.3.0 deltas relevant to planned parity: the model-facing `hub` tool is deprecated in favour of `wait`, `write` and `proc://` (the Collab `agent-cmd` chat/kill/revive frames the GUI uses remain), the edit-mode syntax replaced its `SM:` headers, and `irc.timeoutMs` was removed.

The strict gate already produces a real refusal on this machine rather than a hypothetical one: the official launcher-directory candidate (`omp\omp.exe` under the user's local application data directory) is checked before the Bun-installed release and is rejected by the version check instead of being launched, after which resolution continues with the next candidate. Nothing is installed, downloaded or updated by that refusal. The landed refusal text is explicit and non-mutating: it names the required release and each rejected candidate, and tells the user to install that exact release with the package manager that owns it and put it first on `PATH` — the extension itself never performs that install or update.

Both [ADR-0002](0002-local-collab-gui-native-omp.md)'s feasibility predicates and the design's open questions already require pinning a compatible OMP release and failing visibly on mismatch; the choice below is only about *which* release that is.

## Considered Options

- **Target the installed 18.3.0 and pin the matching 18.3.0 wire build dependency.** One runtime, exactly the release the user authenticated; the wire grammar, registry shapes and API surface come from the same release the host runs.
- **Accept a broad version range or feature-detect at runtime.** The wire, registry and API surfaces carry no compatibility declaration, and migration proof is inherently per-release; a permissive gate would let unverified hosts reach the guest, the relay and the host-control pipe. Rejected: it trades a visible refusal for silent misbehavior.
- **Install and pin a separate 18.2.11 runtime for the extension.** Rejected by the user: it duplicates the agent and separates the extension's runtime from the installation the user administers — its own copy, profile and session state — and it contradicts the extension-only boundary the design already assumes. The user's choice is on its own sufficient grounds for rejection.
- **Vendor or freeze the wire grammar inside the extension instead of using the installed package.** Rejected for maintenance reasons, not because it disables a check: a frozen copy still sends the same `hello`, and the host's protocol-number comparison works regardless of where the grammar came from. The real cost is manual maintenance and silent drift from the upstream grammar with no automatic signal when the snapshot or UI-request lifecycle changes.

## Decision Outcome

The supported runtime is exactly the installed OMP **18.3.0**. The launcher resolution gate keeps accepting a single exact version — now `18.3.0` — and keeps refusing every other version with a visible, actionable error that names the required release and the launcher paths it rejected. The extension never installs, downloads or bundles a second agent, never mutates or upgrades the global package, and never runs an update on the user's behalf.

The extension's build depends on the one OMP package it compiles against, `@oh-my-pi/pi-wire`, pinned to the matching **18.3.0**, so the packaged guest advertises `COLLAB_PROTO = 3` through its dependency instead of a hardcoded number, and consumes the metadata-only `welcome` plus `snapshot-chunk` transcript train instead of the protocol-1 inline welcome. Three things must stay distinct: the **global runtime** is the release the user installs and the extension launches (`omp` 18.3.0) — never installed, downloaded, upgraded or bundled by the extension; the **project install dependency** is `@oh-my-pi/pi-wire` 18.3.0, the only OMP package in `package.json` (there is no direct dependency on the agent package); and the **VSIX** ships only built bundles, since `vsce package --no-dependencies` with `node_modules/**` and `src/**` ignored means the agent package itself is never shipped and the only OMP code inside the extension is the pinned wire grammar compiled into the guest bundle. An equal `COLLAB_PROTO` is necessary but not sufficient: the guest is validated against the host's snapshot and UI-request lifecycle, because the number match detects neither a stale bundle nor a behavior change.

Every native-contract statement inherited from the 18.2.11 baseline — extension API methods behind the host-control pipe, the names-only tool catalogue, `tool_call`/`tool_result` observation hooks, Bun-shim and PID identity, PTY behaviour, and the Collab registry fields — is re-verified against 18.3.0 before it is relied on. For the guest that covers the snapshot lifecycle (metadata-only `welcome`, ordered `snapshot-chunk` train ending in `final: true`, and the empty-snapshot case) and the `ui-request`/`ui-request-end`/`ui-response` settlement path, none of which an equal `COLLAB_PROTO` demonstrates. Anything not yet re-verified stays explicitly unverified rather than being counted as working.

Status: this record is **not in force**. Its review ran and its findings were corrected, but before acceptance the user superseded the fixed-single-version policy proposed here, choosing to run whichever OMP version is installed and to repair compatibility as it is encountered, accepting the regression risk. It is retained as history and evidence pending a replacement decision; acceptance of the replacement, not this record, will govern. The installed-VSIX and actual VS Code Webview acceptance gates remain open regardless.

### Consequences

- Positive: one runtime, one authentication and one set of session files; the guest, relay and host-control channel are matched to the release the host actually runs.
- Positive: the strict gate keeps verification per-release and prevents an unverified OMP build from reaching the host-control pipe or a full-control Collab room.
- Negative: the same strict gate turns every future OMP release into a re-verification task — pin, re-run the native-contract checks, re-verify the installed VSIX — before it can be used, and a user whose `omp` is any other release gets a refusal. That refusal must name the exact required release and the launcher paths it rejected, and must leave the remedy to the user: the extension never performs a global install, an `omp update`, or a version switch on the user's behalf, and its guidance must not imply one.
- Negative: the migration invalidates 18.2.11-only proof; earlier findings must be re-established rather than inherited, including the read-only tool-selection finding of [ADR-0009](0009-read-only-native-tools-until-atomic-selection.md) and the startup-preset finding of [ADR-0008](0008-native-tool-selection-at-session-start.md).
- Constraint: no document may claim the 18.3.0 target is verified end to end until the acceptance evidence exists.

## Related Documents

- [Development design](../designs/2026-09-24-omp-vscode-development.md)
- [ADR-0002: Local Collab guest for native OMP GUI](0002-local-collab-gui-native-omp.md)
- [ADR-0003: Native OMP host control through an authenticated pipe](0003-native-host-control-pipe.md)
- [ADR-0006: Host-generated key over a peer-verified pipe](0006-host-generated-key-peer-verified-pipe.md)
- [Current architecture](../architecture.md)

## Architecture Review

- Reviewer: architect, independent of the author (separate ADR-0010 review)
- Outcome: reviewed with two material findings (F1, F2); both were corrected in this record. It was **not** accepted: the user superseded the fixed-single-version policy on 2026-09-24 in favour of running whichever OMP version is installed and repairing compatibility as it is encountered. The record is retained as history and evidence pending a replacement decision.
- Notes: F1 required separating the user's global runtime, the project install dependency and the VSIX/bundle contents, and required not asserting that the agent package is absent from the dependency graph; the record now states that `@oh-my-pi/pi-wire` 18.3.0 is the only OMP dependency, that no direct agent dependency exists, and that the agent is never shipped. F2 required narrowing the `hello` guarantee to the host's protocol-number comparison (it does not detect a stale guest bundle) and rejecting vendoring for manual maintenance and drift rather than for disabling that check, plus an explicit requirement to validate guest behavior beyond `COLLAB_PROTO`. The reviewer supported the 18.3.0 choice itself and required no change to the security boundary or acceptance criteria. The installed-VSIX and actual VS Code Webview gates, and the native-contract re-verification, remain open.
