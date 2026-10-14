---
status: accepted
date: 2026-10-13
---

# Models and Agents pages: master-detail lists that show what each role and agent runs on, and why

Amends [Native Models and Agents settings editors](2026-10-08-native-models-and-agents-settings.md) (the *Models surface*, *Agents surface* and *Page conventions* sections) and [ADR-0048](../decisions/0048-write-omp-settings-directly-under-native-file-locks.md) through [ADR-0072](../decisions/0072-resolve-roles-and-agents-in-the-worker-with-omps-own-functions-and-write-agent-overrides-to-either-layer.md). Everything else in the 2026-10-08 design (read-only open, locks, pickers, presets, browser, New agent, Chat slash routing) stays as it is.

## Problem

The user's complaint about the two pages is that the information that matters is not visible at once and that it is unclear which model each agent or role uses. Measured on the current pages with real data:

1. The Agents list shows name, source and a truncated description. To learn which model each of eleven agents uses, the user opens eleven detail panes. The thinking level never appears (`SettingsAgent` does not carry it).
2. The detail pane says the answer in pieces ("Model", "Resolves to", "Model override", "Effective override", a read-only "Definition") and never "this agent runs on X because Y overrides Z".
3. A role that follows another (`tiny` and `memory` follow `smol`; `smol` and `slow` follow `default`) looks the same as an assigned one, because the worker resolves only `modelRoles.<id>`, which is `undefined` for an unset role. The page then prints "auto".
4. Nothing links a role to the agents that follow it, or says that an agent override makes a role change irrelevant for that agent.
5. A model that needs login shows as "unavailable" with no provider, no cause and no action.
6. Env, project and global values of a role are never shown together.

The proposal that settled the shape is the 2026-10-13 settings UX proposal (four variants per page, rendered in Dark Modern, Light Modern and High Contrast down to 360 px). The user chose **M2** for Models and **A2** for Agents.

## Goals and Non-goals

- Goals:
  - List rows already show the effective model, the thinking level, a source pill (`env`, `project`, `global`, `inherited`, `built-in`, `override`, `definition`) and a needs-login warning.
  - A detail pane says what the item runs on now, how that was decided (a trace, winner ticked, overridden layers struck through), what it overrides, what depends on it, and for an agent what happens if its override is reset.
  - A **roles strip** ("Roles agents follow": `@default`, `@smol`, `@slow`, `@task` and any other role an agent names, each with model, thinking and source) on the **Agents** page only.
  - Agent model, prewalk and advisor overrides are writable in the **project** config as well as the global one.
  - The effective model, thinking level, source, trace and "if you reset" outcome are computed in the Bun worker with OMP's own functions and projected; the page renders them and never resolves.
  - A **Sign in** button on every needs-login warning, through an in-process port into GuiLogin's login flow, in the editor's exact profile.
  - Truthful text for roles with no model assigned.
  - Dark Modern, Light Modern and High Contrast, widths down to 360 px, keyboard access.
- Non-goals:
  - The model browser, presets, cycle order, fallback chains, current-session and New agent sections keep their behaviour and editing model. Only the Roles and Agents surfaces change.
  - Dense table variants (M1, A1), inheritance graph (M3), by-model and routing-board views (M4, A3, A4) are not built.
  - No live "after saving" preview of an unsaved draft: it would need a worker round trip per edit. The override editor keeps its per-entry status, and the trace and the "if you reset" outcome update after every save.
  - Hiding a global agent override inside one project (a project `null` tombstone for agent maps) is not offered; see [Project agent overrides](#project-agent-overrides).
  - `task.disabledAgents` stays global-only.
  - No change to the OMP settings editor, GuiLogin or the Chat.

## Current State

`src/omp/settings-worker.ts` builds the snapshot. For roles it calls `getKnownRoleIds`, `getModelRole`, `getModelRoleProvenance` and `resolveRoleSelection([id], …)`; for agents `createAgentsHubDeps(...).effectiveModelPatterns` and `resolvePatterns`. `resolveRoleSelection` reads `settings.getModelRole(role)` and returns nothing for an unassigned role (`pi-coding-agent/src/config/model-resolver.ts`, `resolveRoleSelection`), so followed and built-in resolutions never reach the page. The page (`src/webview/settings/main.tsx`) lists roles with `resolved` text, shows agent resolution in the detail only, and writes agent overrides to the global layer.

## Proposed Design

### Item 6: what OMP does at run time for a role with nothing assigned

Verified in the installed OMP 18.10.3 (`pi-coding-agent/src/…`; line numbers are that version's). The answer is per role: there is no single "Automatic".

How an unassigned role is read depends on the consumer. An **alias reader** (`@role` through `resolveModelRoleValue`, `expandRoleAlias`, `resolveConfiguredRolePattern`, `config/model-resolver.ts:1190-1237`) applies built-in fallbacks. A **raw reader** (`settings.getModelRole(role)`, `resolveRoleSelection`, `config/model-resolver.ts:1768-1784`) skips an unassigned role and applies none. Built-in priority lists live in `priority.json` and exist only for `smol, slow, image, web, speech, dictation, judge`; `advisor`, `tiny` and `memory` reuse another role's list (`ROLE_PRIORITY_ALIAS`, `model-resolver.ts:1116-1120`); `advisor→slow` (only while `slow` is configured), `memory→tiny` and `tiny→smol` also follow a role (`ROLE_CONFIGURED_FALLBACK`, `1128-1132`); `smol` and `slow` inherit a configured `default` before their list (`1102-1104`, `1186-1188`, `1226-1228`).

| Role | When unassigned | Evidence |
| --- | --- | --- |
| `default` | No fallback role. A session uses the restored session model, else the first available provider-default model (`pickDefaultAvailableModel`); with none authenticated it starts with "No default model selected". | `sdk.ts:2037-2044`, `3155-3244`; `model-resolver.ts:88-125`; `session/role-models.ts:76-80` |
| `smol`, `slow` | Alias readers: the configured `default` role, then the built-in list. Raw readers (edit auto-repair, sharpshooter) skip it. | `model-resolver.ts:1102-1104`, `1186`, `1226`; `edit/auto-repair.ts:349-350` |
| `tiny` | Follows `smol` even when `smol` is unset, then `default`, then `smol`'s list. | `model-resolver.ts:1128-1132`, `1215-1228` |
| `memory` | Follows `tiny`, then `smol`, then `default` if set, then `smol`'s list. With nothing it runs extraction without an LLM (a warning is logged). | `mnemopi/backend.ts:567-573`; `mnemopi/settings.ts:225-247` |
| `advisor` | The `slow` role if configured, else `slow`'s built-in list. It never uses `default` or the primary model. An advisor with no candidate is skipped (debug log only). | `model-resolver.ts:1116-1131`, `1215-1228`, `1794-1803`; `session/session-advisors.ts:1154-1162` |
| `vision` | No list, no inheritance. Image questions try `@vision`, `@default`, the active model, an image-capable model on the active provider, then any image-capable model; with none, the read tool reports "Configure a vision-capable model for modelRoles.vision". | `utils/image-question.ts:56-76`; `utils/image-vision-fallback.ts:37-39`, `129-134` |
| `plan` | No fallback. Plan mode does not switch models and runs on the active model. | `modes/interactive-mode.ts:4672-4674`, `4700-4704`; `plan-mode/model-transition.ts:45` |
| `commit` | First configured of `commit`, `smol`, then the other chat roles; none configured is an error ("No model available for commit generation"). | `commit/model-selection.ts:44-54`, `69-94` |
| `task` | `@task` is unresolvable, so a subagent whose definition says `@task` runs on the spawning session's active model, else the `default` role. | `task/agents.ts:54`; `model-resolver.ts:1296-1308` |
| `image` | Built-in list of image models; a candidate without credentials is skipped; none usable makes generation fail. The tool is off by default. | `tools/image-gen.ts:164-184`, `242-251`, `333-338` |
| `web` | Built-in list of web search providers (`web/…`), keyless ones last; none available returns "No web search model configured". | `web/search/index.ts:131-154`, `233-236`, `314-322` |
| `speech` | Built-in list (`local/kokoro`, xAI voices); the tool is off by default; none matching is an error. | `tools/tts.ts:55-71`, `201-206` |
| `dictation` | Built-in local speech-to-text model; an undefined model resolves to the default one. | `stt/stt-controller.ts:151-159`, `204-224` |
| `judge` | Built-in list, then `@tiny`, `@smol`, `@default`; the session model is appended when no candidate is native. | `judgment/index.ts:173-180`, `201-206`, `298` |
| custom role | No built-in behaviour. It matters only where `modelRoles.<name>`, `@name` or the cycle order refers to it. | `config/model-roles.ts:getKnownRoleIds` |

So the **mock's "Automatic: OMP chooses" is wrong for every role**, and the premise that `image`, `speech`, `dictation` and `judge` have no list is wrong in 18.10.3: only `default, vision, plan, commit, task` have none. The page never prints "Automatic". An unassigned role shows what it is following or using (`follows @smol`, `built-in list`) or, for the five roles that do neither, a one-line truthful statement taken from the table (for example *"not assigned · uses the active model"*), with the whole row of the table in the detail. The statements are static text keyed by built-in role id (`src/protocol/role-notes.ts`); what is derivable (whether a built-in list exists, whether an alias resolves) is projected from OMP and a live test fails if the table and OMP disagree.

Thinking follows the same rule: a role has a level only when its selector, or the role it follows, carries a `:level` suffix, or for `default` when `defaultThinkingLevel` applies at session start (`sdk.ts:2054-2077`). Other consumers pass nothing and the model's own level applies (`model-controls.ts:261-263`, `384-389`; `commit/model-selection.ts:24-29`). The pages therefore show `—` ("set by whoever uses the role") rather than the default level for those roles. A subagent's level is the caller's effort, else an explicit `:level` on the resolved selector, else the definition's `thinking-level`, else the model's default level, else `defaultThinkingLevel` (`task/executor.ts:4298-4299`; `sdk.ts:2054-2077`).

### Resolution is computed in the worker, with OMP's functions

The worker keeps opening OMP read-only (no change to the on-open side-effect inventory). It adds one pure module, `src/omp/resolution.ts`, that takes OMP's functions as arguments (so tests drive it with fixtures and with the live import) and returns, per role and agent:

- **Model**: for a role, **the function OMP's consumer calls**. The **alias readers** (smol, slow, tiny, advisor, and the agent hub) call `resolveModelRoleValue("@role", available, { settings })`. The **chain readers** (judge, memory, image, web, speech, dictation: `judgment/index.ts:202`, `mnemopi/backend.ts:568`, `tools/image-gen.ts:250`, `web/search/index.ts:183`, `tools/tts.ts:61`, `stt/stt-controller.ts:153-154`) call `resolveRoleChain(role, settings, pool)` over the models the role accepts (`roleCandidatePool`, `config/model-roles.ts:104-106`): the role's own selector, then `retry.fallbackChains[role]` or the built-in list. For those roles the worker calls `resolveRoleChain` and shows its first candidate, so an assignment that cannot be used and a chain that can are shown as OMP uses them (a *Fallback* step in the trace), and the rest of the chain is listed as "Then OMP tries, in order". `commit` and `plan` read the raw value (`commit/model-selection.ts:47-49`, `interactive-mode.ts:4673`) and `default`/`vision`/`task` have their own paths (the item 6 table); they use the alias form, which resolves their own selector only. For an agent the worker calls `resolveAgentModelPatterns` and `resolveModelOverride`. The same call against `registry.getAll()` finds the model that *would* be used if it were signed in, which classifies a failed resolution: provider with no credentials (`login`, with the provider), model in the catalogue but not usable (`unavailable`), pattern matching nothing (`missing`), nothing named at all (`none`). A provider that is merely disabled is `unavailable`, not `login`; only a provider with no stored credentials of any kind offers Sign in.
- **Source** of a role: `settings.getModelRoleProvenance` (`runtime`, `overlay`, `project`, `global`, `default`; `config/settings.ts:1834-1840`). The worker applies the `PI_SMOL_MODEL`, `PI_SLOW_MODEL` and `PI_PLAN_MODEL` environment overrides, as OMP's `main.ts:1949-1957` does at launch, to a **child view** of the settings (`Settings.overlay()`, `config/settings.ts:776-797`) that only the resolution reads. Roles' saved selectors, `effective`, provenance, presets, resolve-default, generate and every write stay on the unmodified instance, so no write or preset check can be built from a variable's value (a change to a role that an environment variable masks writes the persisted layer only and stays masked by the variable; the trace says so). `runtime` provenance is the `env` pill, whose title names the variable and says it is the environment of this window's extension host and of sessions it starts from now on: running sessions keep the environment they launched with, and the `--smol`, `--slow` and `--plan` command-line flags take precedence over the variables. For an unset role (`default` provenance) the source is `inherited`, `built-in` or none.
- **Layers** of a role: env, `getProjectModelRole`, `getGlobalModelRole`. A project `null` is shown as "cleared: the global value applies" (`projectLayerForMerge`, `config/settings.ts:285-297`; the earlier text "hides lower configs" was wrong).
- **What an unset role follows.** Only OMP's own function knows, and hops through unset roles cannot be observed through `ModelRoleLookup`. The worker therefore asks two questions of `resolveConfiguredModelPatterns("@role", lookup)`. **Used**: with sentinel selectors for exactly the roles that really are set, the first element of the result is the role whose value is used (a sentinel means that role; `[]` or the literal `@role` means none, which is also what an unset custom role returns; anything else is the built-in list, owned by the role `rolePriorityDefaults` names). **Consulted**: each other role R for which a probe with *only R* set returns R's sentinel is a role that would supply the value if it were set, ordered by pairwise probes. The trace shows the consulted roles up to the used one, unset hops labelled "not set". A cycle (`smol: @tiny` with `tiny` unset) falls back to the role's own list, which the first probe reports as built-in. A live test compares this with OMP over all 64 subsets of {default, smol, slow, tiny, memory, custom} and fails if OMP's rules change. Roles that end on the built-in list report it; roles with neither say so through `role-notes.ts`.
- **Followers**: roles whose `follows` contains the role, and agents whose effective selection names it (`resolveExplicitModelRole`), split into those that follow it now and those shielded by an override.
- **Thinking** and its source as above. For an agent: caller effort is not known to a settings page and is not shown; explicit `:level` on the override or the definition's model entry (`selector`), the definition's `thinking-level` (`definition`), the resolved model's `thinking.defaultLevel` (`model`), else `defaultThinkingLevel` (`setting`).
- **Agent ladder and "if you reset"**: three steps, first step that expands to patterns wins (an `@task` definition with the task role unset falls through) — 1 override (project, then global; OMP deep-merges `task.agentModelOverrides` per agent key with the project layer on top, `config/settings.ts:3923-3945`), 2 the definition's `model`, 3 the session model (no `model` in the definition: the spawning session's active model, else the `default` role, `model-resolver.ts:1268-1308`; `@default`, `*` and `default` mean the session model in a definition but the configured default role in an override; the page shows the `default` role's model and says a running session's own model is what a spawned agent really gets, `sdk.ts:2975-2979`, `3073-3092`). `ifReset` re-runs `resolveAgentModelPatterns` with the layer's override removed and the other layer's kept.
- **Prewalk and advisor**: the existing effective patterns plus the layer each came from.

The page never resolves anything. It aggregates (counts, filters, the health banner, the roles strip's role list) and renders. The unchanged `entryStatus` helper keeps describing the entries of an unsaved override list from catalogue data.

### Protocol (`src/protocol/settings-model.ts`, `settings-messages.ts`)

`SettingsRole` gains `resolution` and loses `source` and `thinking` (their consumers move to it); `SettingsAgent` gains `resolution` and loses `resolvedModel`:

```ts
type ResolvedStatus = "ok" | "login" | "unavailable" | "missing" | "none";
interface ResolvedModel { model?: string; status: ResolvedStatus; provider?: string; wanted?: string }
interface ResolvedThinking { level?: string; source: "selector" | "role" | "definition" | "setting" | "model" | "none" }
interface TraceStep { kind: "env" | "overlay" | "project" | "global" | "inherited" | "builtin" | "override" | "definition" | "session" | "none"; layer?: "project" | "global"; title: string; value?: string; note?: string; state: "used" | "shadowed" | "unset" }
interface RoleResolution { source: "env" | "overlay" | "project" | "global" | "inherited" | "builtin" | "none"; follows: string[]; model: ResolvedModel; thinking: ResolvedThinking; trace: TraceStep[]; followers: string[]; agents: { following: string[]; overridden: string[] }; envName?: string }
interface AgentResolution { source: "override" | "definition" | "session"; layer?: "project" | "global"; roles: string[]; model: ResolvedModel; thinking: ResolvedThinking; trace: TraceStep[]; ifReset: Partial<Record<"project" | "global", { source: …; model: ResolvedModel; thinking: ResolvedThinking }>>; prewalk?: { value: string; from: "project" | "global" | "definition" }; advisor?: { value: string; from: … } }
```

`SettingsAction` gains `{ action: "sign-in", provider }` (the provider must be one the snapshot lists) and `SettingsMessage` gains `settings:notice`. The review found that `ompDesk.loginProvider` honours a `profile` argument only for the default profile or a running session's, so it could store credentials in a profile other than the one the editor shows. Main decided on an **internal sign-in port**: `signInProvider` in `src/extension.ts` runs GuiLogin's same `runProviderAuth` flow (window guard, credential refresh in every window, outcome words) in the editor's exact profile and directory, and the editor host receives it as `SettingsEditorHost.signIn`. The public command keeps its restricted contract. The call returns `signed-in`, `cancelled`, `terminal`, `declined` (the provider takes an API key; the terminal was offered), `failed` or `busy`, can last minutes and does not hold the editor's one operation slot: the request returns at once, and when the flow settles the host posts `settings:notice` with the outcome in words and, if no other operation is running, re-reads the snapshot so the provider's models show as usable. The re-read uses the editor's private catalogue copy, so models that come only from online discovery appear after *Refresh*. The Browser tab's terminal `login` action stays as it is. The page does not import `provider-login-*`.

### Project agent overrides

See ADR-0072. Agent model, prewalk and advisor overrides can be saved to the project `.omp/config.yml` of the bound folder as well as the global config. OMP reads them from either layer with no restriction (`task/settings.ts`: plain `record` settings; deep merge per agent key, project over global; `discovery/builtin.ts:58-66`, `config/settings.ts:2437-2440`, `3900-3945`), and a running session sees a persisted project value at once (the `protocolDefault` pin on the three maps only holds `{}` while no layer sets them, `config/settings.ts:1005-1027`; the project config is watched, `1172-1178`). The project layer applies only to sessions whose working folder *is* the bound folder (`dirs.ts:624-626`). Rules:

- The worker's project-scope allow-list becomes: `modelRoles/<role>` (still only while `modelRoleStorage` is `project`) and `task/agentModelOverrides|agentPrewalk|agentAdvisor/<agent>`. Anything else (`task.disabledAgents`, cycle order, presets, fallback chains) is refused with the existing message.
- A project write of an agent key is refused, as for roles, when the raw project file and OMP's migrated project layer disagree for **that key** (another agent's entry in a file OMP also reads does not block it), with nothing changed. The three maps may live in different layers; a save writes the maps it changes in the layer chosen in *Save to*. **Enabled** is written to the global disabled list only, so it is disabled in the project view and cannot be part of a project save.
- ADR-0071's project-layer rules apply to every project write, role or agent: the home folder is never an OMP project and is refused; and the first project file is refused, with ADR-0071's sentence, when it would stop an ancestor's AGENTS.md, RULES.md or SYSTEM.md loading for sessions in the folder (`ancestorContextDir`). The trace takes its project layer from OMP's merged project settings, as the editor does. The editors also bind the project folder as the OMP settings editor does: with `ompDesk.ompSettings.useNearestAncestorOmpFolder` on, a workspace folder without its own `.omp` binds to its nearest ancestor with one (a Unity repository root), and with it off the page shows ADR-0071's notice that an ancestor `.omp` looks like the project, with a button to open the setting. All three editors therefore write the same folder.
- Reset in the project layer **removes** the key (and prunes a mapping it leaves empty, with the existing `pruneEmpty` option), so the global value shows through (OMP's deep merge skips only `undefined`; a `null` would hide the global entry, `agents-hub-deps.ts:74-77`). Role clears keep their `null` tombstone. The native `/agents` hub writes only the global layer, so once a project override exists a change made there is masked in that folder and cannot reset it; the page shows the project value as the winning layer.
- The transaction, lock identity, baseline conflict check, staging and replace are the existing `writeConfig` path.
- The page shows a "Save to" selector (Project config · this folder / Global config) on the agent editor when a folder is bound, defaulting to the layer that currently holds the agent's override (global when neither does). The selector is locked while the draft has unsaved changes. The Enabled switch is disabled in the project view with the reason.

### Pages

**Models → Roles & routing (M2).** Health banner when anything in use needs login (roles and non-disabled agents, with the provider and a *Sign in to <provider>* button per provider). Master list of roles grouped as today (Chat, Specialized, Custom), each row: name, source pill (`inherited` shows `inh.` and the target in the title), warning icon, model chip, thinking meter. Detail: header with name, role id, source pill and *Change model…*; **Effective now** (model, thinking and where it came from; the truthful unassigned text; a needs-login callout with *Sign in*); **How it was decided** (trace); the existing project/global scope selector and Clear buttons (with the corrected null wording); **Who depends on it** (agents following, agents overridden shown struck through, roles that follow it, cycle position, fallback chain); *Thinking…*; OMP's built-in candidates; the unassigned-behaviour details for the role. Below: current session, cycle order, fallback chains as today. The Browser and Presets tabs are unchanged.

**Agents → Agents (A2).** Health banner. **Roles strip**. Filters: search (name, description, model), source, and the chips All, Overridden, Follow a role, Problems, Disabled with counts. Master list rows: name, `off` when disabled, unsaved dot, source pill (`override`, `@role`, `definition`), model chip, thinking meter. Detail: header (name, origin badge, enable switch), description, **This agent runs on** (model, thinking, prewalk and advisor with their layers, needs-login callout with *Sign in* and the sentence "until you sign in this agent runs on the model of the session that spawns it", which is what `task/executor.ts:4221-4242` does and logs only a warning), **Decided by (first match wins)** — the ladder with shadowed steps dimmed and each step's file or setting, **If you reset the override** per layer (`X → Y`), the override editor (ordered model list with status per entry, prewalk and advisor Inherit/Off/On, *Save to* selector, Save/Discard, per-layer Reset), Definition (read-only) and Open definition.

**Current session** (Models, only when opened from a running Chat). The host reads the session's model and thinking level and resolves the effective default with the worker, and sends both with the snapshot. The block says in words what its button does: "Switch the Chat session “name” to provider/model · level", one line that settings apply to new sessions and this changes the open session now, and a button "Use <model> in this session". It is hidden when the session already uses that model (and level), is disabled with the reason while the session is busy, and names only what cannot be applied (auto thinking is skipped and the session keeps its level; an upstream-routed default is not applied). **Health banner:** a warning appears only when something in use is affected; a disabled agent whose model cannot run gets a muted line in its own detail, not a banner.

**Keyboard and screen readers.** Both master lists reuse the roving-tabindex `ListBox` (arrows, Page Up/Down, Home/End, Enter). Meters and source pills carry `aria-label` text (not only `title`); sources and warnings are words plus an icon, inherited is dashed, the winner of a trace is ticked and shadowed steps are struck through, so no signal is colour-only. Filter and save results go to an `aria-live` region. Forced-colors and High Contrast use outlines and a thick marker for the selected row, tab and winner.

**Widths.** At 760 px and below the detail stacks under the list; at 560 px the list rows keep model and meter on their own line; at 360 px nothing scrolls horizontally except `code` values, which wrap.

### Files

New: `src/omp/resolution.ts` (pure projection), `src/protocol/role-notes.ts` (item 6 text, the ids it covers and which roles OMP resolves as a chain), `src/webview/settings/{common,roles,agents,health}.tsx` (the page is split out of `main.tsx`, which keeps the host hook, the shell, the browser, presets and New agent). Changed: `src/omp/settings-worker.ts`, `src/omp/settings-contracts.ts` (and the worker's export-presence list: `resolveRoleChain`, `overlay`), `src/protocol/settings-model.ts`, `settings-messages.ts`, `settings-pick-items.ts`, `src/host/omp-settings-editor.ts`, `src/webview/settings/{main.tsx,model.ts,styles.ts}`. `src/omp/config-transaction.ts`, `src/host/omp-settings-core.ts` and everything of the OMP settings editor are not touched; `config-ancestor.ts` and `ancestorMessage` are reused.

## Alternatives

- **Resolve in the page** from `modelRoles`, agent definitions and a copy of OMP's inheritance table: fast, but drifts from OMP at every release (the table of followed roles already differs from the proposal's mock) and the page would carry a second resolver. Rejected by the user.
- **Copy `ROLE_CONFIGURED_FALLBACK`** into the worker instead of probing: simpler, but a hand-copied table of an unexported constant; kept only as the test oracle the probing result is compared against.
- **Dense tables (M1/A1)**: everything visible at once but about 900 px wide and a bigger rewrite; the user chose master-detail.
- **Project overrides read-only**: leaves "which project overrides exist" visible but not editable; rejected by the user.
- **A project `null` tombstone for agent maps** to hide a global override in one project: OMP honours it (`override ?? ""`), but it needs its own explanation in the UI and was not requested; not offered.

## Risks and Open Questions

- Probing depends on `resolveConfiguredModelPatterns` accepting any lookup with `getModelRole`; the 64-subset live test and the worker's export-presence check pin it.
- The `env` source reflects the extension host's environment, not a terminal's; the pill's title says so, and says that older sessions and the `--smol`/`--slow`/`--plan` flags differ.
- The unassigned-role text is OMP 18.10 behaviour; the live test names the roles whose built-in lists it relies on and fails if OMP changes them.
- The effective model of an agent is shown as resolved without a parent session; the real one can be the parent's model when the agent has no model of its own or its model cannot run, or the caller's explicit `model` (`structured-subagent.ts:399-400`).
- "In use" for the health banner means: every role with an assignment or that follows one, and every enabled agent. Roles OMP resolves from a built-in list are not reported (their list always has a usable fallback or none), and agents that are disabled are counted apart, so the off-by-default image and speech tools raise nothing.
- Project writes are refused when OMP's project layer merges other config files and disagrees with `.omp/config.yml`; this mirrors the existing role rule.

## Rollout and Verification

Worker projection and writes first (fixture agent directories and project, then the live import), protocol, host action, page. Focused tests: `resolution` fixtures and live OMP, worker project override write/reset/refusal, page rows (model, thinking, source pill, needs-login), Sign in wiring. Then an isolated window (hidden desktop) with a scratch agent directory and a scratch project, screenshots in the three themes at several widths.

## Related Decisions

[ADR-0072](../decisions/0072-resolve-roles-and-agents-in-the-worker-with-omps-own-functions-and-write-agent-overrides-to-either-layer.md); [ADR-0048](../decisions/0048-write-omp-settings-directly-under-native-file-locks.md); [GUI provider login](2026-10-13-gui-provider-login.md).

## Architecture Review

- Reviewer: architect (independent, read-only)
- Outcome: accepted after changes. The review confirmed the approach (resolve in the worker with OMP's own functions; project agent overrides reset by removing the key) and the item 6 table (checked against OMP 18.10.3 sources and `priority.json`), and found five material problems, all fixed above: (M1) six roles are resolved by OMP's consumers with `resolveRoleChain`, not the alias form; (M2) the probing walk was unsound, replaced by used/consulted probes pinned by a 64-subset live test; (M3) environment overrides leaked into saved selectors, presets and provenance, now applied to a child view; (M4) project writes bypassed ADR-0071's home-folder and ancestor-context rules, now applied; (M5) `ompDesk.loginProvider` honours `profile` only for known profiles, so Sign in uses an internal port that takes the editor's exact profile. Minor findings are folded into the sections above (thinking-level precedence, ladder wording, per-key disagreement check, ADR-0048 amendment, the TUI `/agents` masking, the two login paths).
- Main chose the internal sign-in port for M5 and confirmed adopting ADR-0071's project rules (including the `ompDesk.ompSettings.useNearestAncestorOmpFolder` folder choice and the ancestor-`.omp` notice) for the Models/Agents editors.
