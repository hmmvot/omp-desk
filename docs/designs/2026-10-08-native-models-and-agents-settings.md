---
status: implemented
date: 2026-10-08
---

# Native Models and Agents settings editors

## Problem

Frequent `/models` and `/agents` users need native, searchable VS Code editor tabs rather than a hosted terminal dashboard. RPC supports the active model but does not offer role or agent configuration CRUD. The extension must own narrow, safe configuration writes without turning these editors into session writers.

## Goals and Non-goals

- Native **Models** and **Agents** webview editor tabs using the existing nonce-gated resources and VS Code theme variables; commands, Sessions title actions and intercepted Chat `/models` / `/agents` submissions open them.
- Cover the installed dashboards' complete configuration behaviour, including custom roles, thinking suffixes, fallback chains, cycle order, model presets, provider/model browsing and agent generation/creation.
- Global active-profile and project scope are explicit. Show persisted values, effective values and their source separately.
- Non-goals: a second session lifecycle, a hosted TUI dashboard, changing already-spawned subagents, or inventing an RPC configuration API.

### Product boundary change

The user decision of 2026-10-08 explicitly reopens native settings editing for Models and Agents. Update the earlier no-settings-editor wording in `product.md` and `architecture.md` and add the new document to the documentation map. The removed Collab-era Agents Hub roster is not reinstated.

## Current State and Installed Contract

Source discovery targets the installed OMP interface, not a bundled implementation. The model hub host contract is `pi-tui/overlays/model-hub.ts`; its source is `pi-coding-agent/modes/model-browser-source.ts`. The agents contract is `pi-tui/overlays/agents-hub.ts`, implemented by `modes/agents-hub-deps.ts` and `task/discovery.ts`.

Built-in role keys are `default`, `smol`, `slow`, `vision`, `plan`, `commit`, `tiny`, `memory`, `task`, `advisor`, `image`, `web`, `speech`, `dictation`, `judge`. Custom assignments, tags and cycle entries also introduce roles. `modelRoles` stores selectors, including thinking suffixes; there is no separate per-role thinking record. `modelRoleStorage` selects global/project default role storage, `cycleOrder` defaults to smol/default/slow, `retry.fallbackChains` supports role, exact-model and provider-wildcard keys, and `modelPresets` saves complete roles plus `defaultThinkingLevel`.

The model browser shows provider/model metadata, kinds, search, recent usage, performance and availability. `modelProviderOrder`, `disabledProviders`, `enabledModels`, `enabledProviders` and `modelRoleStorage` are read-only preferences here: the installed hub does not mutate them. Path-scoped entries are shown with provenance, not flattened or overwritten.

Agents are discovered by OMP itself with project/user/plugin/bundled name precedence, not by a parallel filesystem scanner. The hub edits `task.disabledAgents`, `task.agentModelOverrides`, `task.agentPrewalk`, and `task.agentAdvisor`. Model overrides accept pattern lists; prewalk/advisor accept on/off/model patterns. The hub does not edit existing definition bodies: it generates a new specification using OMP's architect prompts, allows review, then creates project/user Markdown with YAML name/description frontmatter and a system prompt. Existing definition files may be opened in VS Code without implying dashboard editing parity.

Settings precedence is environment/runtime/overlay/project/global/default as applicable to each setting. Global config accepts `config.yml` or `config.yaml`; project roles use `.omp/config.yml`. OMP's serializer parses and reserializes YAML: **comments are not preserved**. Its writer preserves unknown values, merges targeted edits under an OS-backed advisory file lock, stages/fsyncs/atomically replaces, and resolves symlink targets. Its global settings instance watches source directories with a 200 ms keep-last-good reload. Disk role edits do not automatically change the current model; current default-role changes in the TUI explicitly call setModel. Agent settings affect future dispatch/resolution, not already-running children.

## Proposed Design

### Host and installed-runtime boundary

A dedicated controller owns editors keyed by kind/profile/cwd and a host-derived optional launching Chat identity. Commands and Sessions actions choose a window folder explicitly; Chat uses its recorded cwd/profile. Panels are independent of session slots/claims. The page sends typed actions, never arbitrary paths, modules or commands. A short-lived Bun worker loads the resolved installed package source; it is an extension-owned adapter, not an OMP extension or dashboard. The worker entry is content-addressed, staged and verified before spawning, with explicit profile activation and the session's cwd/Bun environment conventions. Compiled-only installs without importable sources fail visibly.

The worker owns direct YAML mutations rather than persisting through Settings setters. It uses OMP's exact existing-file realpath and native OS-backed lock key, rereads under the lock and edits the migrated global layer obtained by the installed read-only loader. Conflict granularity is one record entry or one whole array. Project edits are modelRoles entries only and project clears write null tombstones. Unknown data survives the same migrations OMP applies; malformed YAML is refused without quarantine. Rewriting removes comments, matching OMP. Existing targets are staged, fsynced, checked again and replaced with the extension's bounded Windows retry helper, never unlinking. Dangling links and removed/retargeted observed files are refused. Missing-target lock spelling is not universally shared, so first creation publishes exclusively with no replacement. New agent Markdown uses the same exclusive complete-file publication.

Every edited entry or array is validated through the installed setting handle's `assertWritable` before staging; model selectors, preset contents and agent specifications receive the corresponding native semantic validation.

Opening an editor uses Settings.loadReadOnly and binds it with initializeWithSettings before agent discovery. It never calls Settings.init/loadIsolated, catalogue refresh, command credential resolution or extension loading on open. Existing agent.db and models.db are opened with SQLite readonly mode; credentials are cloned to an in-memory native store and catalogue cache initialization operates on an owned temporary copy retained for that editor's lifetime. MRU/performance reads use existing tables directly, without migration, backfill or flushing another process's samples. Legacy models.json conversion is refused on open. Only editor-owned settings and sanitized display metadata reach the page; credentials, model headers and unknown configuration data do not. Explicit Refresh and Generate use OMP's own persistent AuthStorage API, with the same credential migration and token-refresh side effects as the native TUI, disclosed before either action. Snapshot credentials never perform refresh. Catalogue refresh updates only the editor's private temporary cache, not OMP's models.db.

### Models surface

Searchable model browsing supports All/Recent/provider/kind filters, availability, metadata and explicit refresh/login. Role scope selection is offered only when the effective modelRoleStorage is project, defaulting to project; otherwise role writes are global. Other dashboard writes always use global scope and expose inherited shadows. Roles show explicit/effective selection and source, per-role thinking suffixes, clear and custom creation. Ordered fallback chains and cycle membership/order are editable. Presets save effective roles plus defaultThinkingLevel and apply only after validating the default. Multi-entry changes are atomic per file; project roles followed by global thinking are ordered across files with an explicit partial-success result if the second file fails. Default auto-thinking assignments include the global defaultThinkingLevel change. Every successful write reports effective shadowing.

### Agents surface

Search/filter discovered agents by source, inspect descriptions/prompts and edit enabled/model/prewalk/advisor overrides in global config, with native pattern suggestions and effective resolution. New agent uses the installed architect prompts and identical tool-free SDK options, but deliberately supplies SessionManager.inMemory and read-only Settings so generation creates no stray history session. Generate explicitly discloses its provider call, catalogue refresh and native usage recording; generation is not an on-open read. The preview is read-only, matching the hub, with project/global destination and duplicate refusal. Creating cwd/.omp/agents is disclosed because it can shadow an ancestor project agents directory. Existing definitions open in the ordinary file editor.

The private generated-spec parser is reproduced exactly and pinned by tests against the installed source: JSON/fenced JSON extraction, two-to-six-word lowercase hyphenated identifier, the native description prefix and a nonempty system prompt.

### Sessions and application status

Bare /model and /models, plus /agents (whose TUI ignores arguments), open native tabs before any prompt/steering/follow-up dispatch. /model or /models with selector arguments keep the installed RPC semantics unchanged. Opening binds the Chat's recorded cwd/profile without granting the page session authority. Explicit Apply default to this session resolves the effective default, not a shadowed saved value, and uses existing RPC model/thinking operations only while the same Chat identity remains live and idle. RPC cannot express auto thinking or upstream routing; report those limits instead of claiming application. Running sessions watch and reload saved roles, fallbacks and agent overrides for future resolution unless runtime picks mask them. The current model and already-running children remain unchanged until an applicable explicit operation; Terminal receives no invented RPC mutation.

## Alternatives

- Host the TUI: rejected by the requested native UX.
- RPC-only editor: cannot manage roles, presets or agent overrides.
- Reimplement registry/discovery: duplicates profile, provider and plugin semantics and drifts from installed OMP.
- Persist with installed Settings setters: couples editor writes to migration/storage side effects and delayed saves; direct narrow writes give explicit conflict outcomes.

## Risks and Open Questions

Installed-source coupling is deliberate and reported when unavailable. Locks are advisory: a non-cooperating writer can still race the final replacement; generation checks reduce but cannot eliminate that window. Reload does not prove current-session application. Path-scoped and inherited values require separate persisted/effective projections. Provider refresh and generation may involve network/credential activity, only on explicit actions.

## Rollout and Verification

Implement worker/store behavioural tests, then controller/webview/commands and composer interception; update product, architecture, documentation map, README and changelog. Run typecheck and focused configuration/slash tests, not the full suite. Build/package in a private worktree from HEAD with this package's changed files copied in; peers continue writing the shared tree. Grant a Verifier an exclusive operation lock over that fixed artifact and a uniquely named isolated installation. Change a role and agent override through the installed UI in an owned profile, observe fresh OMP readback, capture both tabs and shut down owned processes. Check an on-open fixture has no changes outside owned temporary snapshots. Never modify the main profile or existing sessions.

### Completed Verification

Typecheck and 43 focused configuration, native worker, slash-completion and Chat-runtime tests passed without skips. The worker fixture covers read-only opening, native scopes, unknown-value preservation, conflicts, preset switching, agent overrides, exclusive definition creation and absent-config publication.

The coordinator subsequently authorized the package owner to execute installed acceptance directly against a frozen private Windows VSIX, rather than handing that operation to a Verifier. Both native editor tabs were observed in a new isolated VS Code installation. A role model and an agent model override were changed through their rendered forms, then independently confirmed by freshly loaded installed OMP Settings and AgentsHubDeps, without the extension worker. Typing and submitting `/models` and `/agents` from a visibly active Chat opened the corresponding tabs; repeat opens reused the profile/folder-bound editors.

The acceptance used only owned native configuration and provider metadata fixtures, with no real credentials. Live provider Refresh/Generate were not exercised. Native Stop and its scoped confirmation ended the owned Chat; the isolated window, broker and descendants exited, and owned profiles, fixtures and temporary harnesses were removed. Screenshots, frozen packaging evidence and native readback records were retained separately.

## Related Decisions

[ADR-0048](../decisions/0048-write-omp-settings-directly-under-native-file-locks.md).

## Architecture Review

- Reviewer: architect
- Outcome: accepted after revision; the independent revised-contract review confirmed the eleven findings and required three final clarifications, all incorporated.
- Notes: direct writes, product reversal, side-effect inventory, in-memory generation, migrated-layer validation, lock identity, native scope limits, read-only browser preferences, multi-file outcomes, aliases, truthful live apply and staged workers were reviewed. Explicit native persistent credential refresh was approved by the coordinator under a read-only-on-open boundary.
