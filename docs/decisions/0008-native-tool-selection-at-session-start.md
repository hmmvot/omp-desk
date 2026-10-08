---
status: rejected
date: 2026-09-24
---

# ADR-0008: Apply project tool defaults through native OMP startup flags

## Context and Problem Statement

The VS Code extension would like project tool defaults without a second OMP session writer or a startup race. OMP 18.2.11 exposes `--tools` and `--no-tools`, but its session constructor may add session-managed builtins and non-hidden registered/custom tools even for an explicit empty list. A public `session_start` hook is awaited but is not a fail-closed pre-input barrier and later Plan/Goal reconciliation can change the set. An OMP CLI tool list therefore cannot promise an exact project default. The user explicitly chose not to apply an inexact startup request on 2026-09-24.

## Considered Options

- Pass a cwd-scoped `--tools` or `--no-tools` request only for fresh sessions: simple and native, but not an exact selection; omitting flags on resume also does not prove OMP restores the previous active set.
- Apply the preset through live host-control after startup: would race the first prompt and a concurrent native session transition, and could mutate another session; the model/thinking waiver does not cover tools.
- Do not expose project tool presets until OMP offers a proven exact pre-input owner-session mechanism; preserve its native defaults.

## Decision Outcome

Reject project tool defaults through CLI flags and do not call the public live setter to approximate them. New and resumed sessions follow OMP's native startup behavior. The extension may observe and copy names of tools the exact authenticated host reports, but it neither claims a durable selection policy nor persists an inexact substitute. An exact project default needs a separately proven native pre-input contract; removing the flags also avoids silent fallback from malformed saved presets.

### Consequences

- Positive: the extension cannot misrepresent `--no-tools` as no enabled tools or promise an exact project default while native OMP adds tools. No extension reapplication changes resumed sessions.
- Negative: project tool defaults and cross-chat Paste remain unavailable until the owner-process API can satisfy the exact and safe contract. OMP users retain their normal native settings and TUI behavior.

## Related Documents

- [Development design](../designs/2026-09-24-omp-vscode-development.md)
- [Authenticated host-control pipe](0003-native-host-control-pipe.md)
- [Host-generated key and peer verification](0006-host-generated-key-peer-verified-pipe.md)
- [Best-effort model/thinking transitions](0004-best-effort-host-model-transitions.md)

## Architecture Review

- Reviewer: architect
- Outcome: independently reviewed; material defects led to rejection of this approach.
- Notes: The review established construction-time tool augmentation, a non-atomic live setter and unproven restoration of active selection on resume. The user chose not to apply inexact project flags or accept the separate live-tool transition race. The implementation removes these paths instead of documenting them as implemented.
