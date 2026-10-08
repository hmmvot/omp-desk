---
status: accepted
date: 2026-10-08
---

# ADR-0048: Write OMP settings directly under native file locks

## Context and Problem Statement

Native Models/Agents editor tabs must persist the configuration the installed TUI dashboards manage. RPC exposes active-model changes, not role, fallback, preset or per-agent settings writes. Hosting the TUI is explicitly not the chosen user experience. Configuration belongs to OMP profiles and projects, not VS Code settings.

The user decision of 2026-10-08 supersedes the earlier product boundary excluding a settings editor for these two native dashboards only. The deleted Collab-era Agents Hub roster remains deleted.

## Considered Options

- Host the TUI dashboards: retains implementation parity but violates the native-editor requirement.
- Add an extension-specific settings mirror: creates conflicting sources of truth and does not configure plain OMP.
- Call installed Settings setters: reuses behaviour but introduces asynchronous persistence, migration and storage effects into editor transactions.
- Extension-owned direct writes using installed path/serialization/locking primitives: narrow and auditable mutations with explicit conflicts while retaining OMP's source of truth.

## Decision Outcome

Choose extension-owned direct writes to host-resolved OMP profile YAML and new Markdown agent files, with project model-role writes only when OMP's role storage is project. All other hub settings persist globally. A staged, verified, short-lived Bun adapter imports the selected installed source. Opening uses read-only Settings and SQLite snapshots; no migrations, extension loading, provider refresh or command credentials run on open. Native generation uses installed prompts and tool-free SDK options with an in-memory SessionManager to avoid stray history. Configuration persistence belongs to extension transactions, not Settings setters or a TUI component.

Only explicit Refresh/Generate use OMP's native persistent AuthStorage API, including its credential migration and lease/CAS token-refresh effects, with a brief disclosure. The extension never writes the credential database itself and a read-only credential snapshot never refreshes OAuth tokens. Catalogue refresh updates the editor's private temporary copy, not OMP's models.db.

Resolve existing physical targets exactly as OMP does and use its OS-backed advisory lock. Reread the migrated global layer under lock, compare edited record entries or whole arrays with their baseline, retain unrelated keys, stage/fsync and replace with the extension's bounded Windows retry helper, never unlinking. Project clears use null tombstones. Missing-target lock identity cannot be universally guaranteed, so first creation publishes exclusively without replacement. Malformed input, unsupported links, lost observed files and overlapping changes refuse visibly. Multi-file changes are ordered and report partial persistence. Comments are removed, matching OMP's serializer; non-cooperating writer exclusion is not claimed.

Current-session application resolves the effective default, with existing identity/busy-guarded RPC readback. RPC cannot express auto thinking or upstream routing; those limits are reported. Saved role/fallback/agent changes reload for future use unless runtime overrides mask them, but do not change the current model or already-running children.

### Consequences

- Positive: plain OMP consumes the settings; scopes, unknown data and conflicts remain explicit; no new daemon or second session writer.
- Negative: installed-source interfaces and Bun are required for full discovery/generation; compiled-only installs report unavailable capabilities. YAML comments are not retained, matching OMP. Advisory locks cannot eliminate a last-moment non-cooperating writer race.

## Related Documents

[Native Models and Agents settings editors](../designs/2026-10-08-native-models-and-agents-settings.md).

## Architecture Review

- Reviewer: architect
- Outcome: accepted after revision; chosen approach retained and all material invariants corrected.
- Notes: the independent revised-contract review confirmed the eleven findings; its final validation, generated-spec and credential-refresh clarifications are incorporated in the linked accepted design.
