---
status: accepted
date: 2026-10-06
---

# Tool-style TODO and Agents rows with separate detail tabs

## Problem

The two pinned HUDs above the transcript (`TodoHud`, `RunningAgents`) are the loudest chrome on the page. Collapsed, the TODO row carries a phase name, a task and two unlabeled counters (`1/4` and `2/9`); the Agents row is a bare count. Expanded, they show full phase lists with per-task status chips, blockers, details and notes, and per-agent child transcripts inline, inside an internal scroll region (`max-height: 28vh`/`35vh`, `overflow: auto`) that sits inside the transcript's own outer scroll owner. The user decided (2026-10-06) to present both HUDs like the flat tool rows: one-line collapsed summaries, TUI-dense bounded expanded lists, and full information in a **separate editor tab**.

## Goals and Non-goals

- **Goals**
  - Two rows, `TODO` and `Agents`, each a button with `aria-expanded` and a chevron, **at the bottom of the chat column, directly above the composer card** (see [Placement](#placement-bottom-block-above-the-composer); the first version pinned them above the transcript and the user corrected that, see the [addendum](#addendum-placement-correction-2026-10-06)).
  - Collapsed: one line. TODO shows the current task and **one** counter (`3/9`, title `3 of 9 tasks closed`). Agents shows the count and a compact "who is doing what".
  - Expanded: as dense as the OMP TUI (read from `packages/coding-agent/src/modes/interactive-mode.ts`, `#renderTodoList` / `#formatTodoLine` / `renderSubagentHudLines`): one line per task with a status glyph, phases as compact headers, no per-task status chip text, blockers and notes only as compact markers; one line per agent with glyph, id, type badge, description/activity and elapsed time. At most **8 content rows**, then a `+N more` row. No nested scroll region and no child transcript inline.
  - Click opens full details in a separate editor tab: the whole TODO (every phase, details, notes, blockers), the agent roster, or one agent's activity and read-only child transcript with live updates. One tab per `(session, kind, agent id)`; a second click reveals it. The tab ends with its session.
  - Keep native semantics: `todoHudSelection`, the active-agent description match (`todoMatchesDescriptions`) and `agentAvailability` (registry unavailable is stated, never shown as zero).
- **Non-goals**
  - No change to the OMP protocol, `RpcSession`, the broker, claims or bridge. No new host tools.
  - No write path from a detail tab (no prompt, abort, approval, todo edit or agent control).
  - Task/subagent tool rows inside the transcript keep their current renderer, including their lazily disclosed child transcript; they are transcript content, not the pinned rows.
  - Detail tabs are not restored across a window reload (see Lifecycle).
  - The TUI's auto-clear/dismiss of a closed TODO and its click-to-focus of an agent are not reproduced.

## Current State

- At the start of this work `src/webview/App.tsx` rendered `<RunningAgents/>` then `<TodoHud/>` above `<Transcript/>`, inside `.omp-main`, so they were pinned at the top (superseded by the [placement correction](#placement-bottom-block-above-the-composer)).
- `TodoHud.tsx` shows `phase.name · task · phaseClosed/phaseTotal · closed/total`, and when expanded every phase, every task with a status chip, an "active agent match" chip, blocker text, details Markdown and notes. `RunningAgents.tsx` shows `AGENTS` and `model.agents.size`, and when expanded every agent with a chip per status, `AgentProgressView` stats and a `ChildTranscript` `<details>`.
- `ChildTranscript.tsx` reads a bounded page (`SUBAGENT_PAGE_ROWS`) through `SubagentReader` → `ChatClient.readSubagent` → `omp:chat-subagent-read` → `ChatRuntime.#serveSubagent` → `RpcSession.subagentMessages` (registry- or retained-reference-gated, ids never path selectors), with explicit Refresh/Older.
- The extension host owns every conversation (`ChatRuntime`). A conversation has **pages**: routes that receive `omp:chat-*` messages (`ChatRuntime.attachPage`, `resend`, `readOnlyReason`). Today a page is an editor panel (`panelChatPage`) or a surviving bridge document (`bridgeChatPage`). Read-only routes already may issue `omp:chat-load-older` and `omp:chat-subagent-read`.
- `createGuestHtml` builds the one chat document: nonce CSP with `default-src 'none'`, `connect-src` naming only the document's own bridge port or `'none'`, one script (`media/guest.js`) and Codicons. Identity meta makes VS Code restore an editor ([ADR-0023](../decisions/0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md), [ADR-0019](../decisions/0019-vscode-owns-omp-editor-persistence.md)).

## Proposed Design

### Collapsed rows

```
 ▸ TODO     Wire the detail tab messages                         3/9   ⧉
 ▸ Agents   2 running · Explorer: read src/webview/App.tsx             ⧉
```

- `▸/▾` is a Codicon chevron. The whole left part is the disclosure `<button aria-expanded>`; `⧉` (codicon `link-external`, label "Open TODO in editor tab") is a second, separately focusable button that opens the roster/TODO detail tab. A button never nests another button.
- **TODO**: label `TODO`; current task = `todoHudSelection(phases).task?.content`, else `All tasks closed` when `closed === total`, else `No actionable task`. One counter chip `closed/total` with `title="N of M tasks closed"` and `aria-label` of the same text. The phase name, the per-phase counter and the "active agent match" chip are removed from the line (the phase header appears when expanded).
- **Agents**: label `Agents`; summary `N running` plus other states in fixed order (`pending`, `completed`, `failed`, `aborted`) joined by `, `, then ` · ` and up to two `id: activity` fragments for running agents ordered by registry index (activity is the live `currentTool · lastIntent` from progress or `agentActivity`, falling back to the spawn description, then the agent type). With `agentAvailability === "unavailable"` the summary is `registry unavailable` with a warning style, never `0`. The whole summary truncates with an ellipsis; the full text is the button's `title`.
- A row is rendered only when its data exists (`todoHudSelection.total > 0`, `agents.size > 0` or registry unavailable with a retained row), exactly as today.

### Expanded rows (TUI density, bounded)

```
 ▾ TODO     Wire the detail tab messages                         4/10  ⧉
     II. Build · 1/5
       ✓ Write the design doc
       ▶ Wire the detail tab messages ⁺²
       ○ Reducer tests
       ⚠ Docs (blocked)
       ○ Ship
     III. Verify · 0/2
     +5 more                                        (opens the TODO tab)

 ▾ Agents   2 running · Explorer: read src/webview/App.tsx       ⧉
     ◔ Explorer ⟨implementer⟩: Remove jitter · read src/App.tsx     41s
     ◔ MenuFixer ⟨implementer⟩: Menu fixes · edit Composer…         38s
```

TODO rows (from `#renderTodoList` / `#formatTodoLine`):

- Phase header only when there is more than one non-empty phase: `<roman>. <name> · closed/total` (muted; the current phase is foreground/bold). A single phase shows tasks without a header.
- Task line: glyph + content, no chip text. Glyphs: completed `check` (success colour, strikethrough), in progress `play` (accent colour), pending `circle-large-outline` (dim; accent when it matches a running agent description, as the TUI does), abandoned `circle-slash` (error colour, strikethrough), blocked `warning` followed by the text `(blocked)` as the TUI does. Notes: the TUI's compact marker `⁺ⁿ` (superscript plus and count) after the line. The blocker text, task details and note text are **not** inline: the blocker is in the row's `title`, everything is in the TODO tab. Status is also spelled for assistive technology (visually hidden word).
- Bound, reusing the TUI's own policy. When every phase header and task fits in **8 rows**, all of them show. Past that the expanded list is the TUI's walking viewport: the **current phase** header (the phase that holds the actionable task `todoHudSelection(...).task`, else `todoHudSelection(...).phase`), then `selectCollapsedTodos(current phase tasks, running-agent descriptions)` — open tasks with active work first and the last closed task as lead-in, closed history omitted — then **later phases as headers only**, all truncated to 8 rows. Earlier phases are omitted. Invariant: the actionable task is always among the rows. `+N more` is one extra row whose `N` is the number of **tasks** not shown (omitted history, hidden open tasks and tasks of header-only phases); it is a button opening the TODO tab. The 8-row cap does not count the `+N more` row.

Agent rows (from `renderSubagentHudLines`: `● Id ⟨role⟩: description`):

- Glyph by status (`loading` spinner for running, `clock` pending, `check`, `error`, `circle-slash`), the agent id in accent, the type badge `⟨type⟩` (omitted for the generic `task` type, like the TUI), `: description` (the spawn description, else the first line of the task/assignment, whitespace collapsed), then a muted current activity `tool · intent` when known, then elapsed time right-aligned. Elapsed starts from `progress.durationMs` (native); when the registry does not carry one the field is omitted, never estimated. Native progress arrives in bursts, so while an agent is `running` in a live session the displayed time is the last reported value plus the local clock since it arrived (`useAgentElapsed` in `lib/live-clock.ts`, shared with the Wait row and the Task rows): it advances once a second between progress events from one page-wide interval that exists only while a running time is on screen, never runs backwards, is replaced by any larger authoritative value, and stops at the final reported duration when the agent settles. The Agents tab and a single agent's tab use the same hook; a tab whose agent left the registry keeps the last value it showed. Tools/tokens/cost, which the TUI HUD does not show, appear only in the detail tab.
- Each row is one `<button>` that opens that agent's tab (accessible name `Open <id> in editor tab`). Rows are ordered by registry index.
- Bound: at most 8 agent rows, then `+N more` which opens the Agents roster tab.

No scroll region: the rows are in normal flow, the row section has no `overflow`/`max-height`, and the transcript remains the only vertical scroll owner. Each row is one line (`white-space: nowrap; overflow: hidden; text-overflow: ellipsis`) with the full text in `title`, so one expanded section is at most 1 + 9 line heights, and the combined height of both is capped (see Placement).

### Placement: bottom block above the composer

The rows are the top of the chat's **bottom block**, `.omp-dock`, which `App` renders as the last child of the chat column after the transcript body: `[transcript (flex 1, min-height 0)] → [HUD rows] → [composer card]`.

- **Same column as the transcript and dock.** The rows' stack has the composer's own sizing, `width: min(840px, calc(100% - 24px))` centred, so its left and right edges equal the composer card's and its left edge equals the transcript content's. At 320 px it follows the same 12 px gutters.
- **Flat tool rows.** No panel background, no border, no full-width band. The header has `.omp-tool-head`'s font (inherited), padding (`4px 8px`), gap (6 px), chevron/icon size and `--vscode-list-hoverBackground` hover; the label is bold, the summary muted, the counter right-aligned. Expanded lines indent to the text after the chevron.
- **Not part of the transcript.** The transcript viewport ends where the rows begin, so expanded rows never scroll with the history.
- **Bottom anchor.** The rows are measured as part of the dock: expanding, collapsing, appearing or disappearing one changes the transcript viewport's height exactly as a growing composer does, and `TranscriptScrollController` absorbs it. While following, the viewport stays pinned to the tail; while detached, the line crossing the viewport's bottom edge stays fixed relative to the top of the bottom block (≤ 1 px), the reading offset from the top absorbing the difference. No new scroll code: the existing resize handling is the mechanism, and the regression test proves it for the rows.
- **Height cap.** Rows have fixed heights (header 26 px, content line 20 px, list padding 4 px; `hud-summary.ts` constants, interpolated into `hud-styles.ts`), so the cap is computed, not measured. `HudDock` owns both rows' expansion and the viewport height; `hudSectionLines(viewport, visible, expanded)` gives each open row `floor((0.4 × viewport − stack padding − headers − list padding) / open rows / 20)` lines. A window that does not fit is rebuilt with one line fewer so `+N more` fits (`todoWindowWithin`, `agentWindowWithin`); the usual eight-row bound still applies first. Floor: one row plus `+N more` (the actionable task always shows; its phase header gives way first), so below about 330 px of viewport height the floor can exceed 40 %. Never a scroll region.

### Detail tab mechanism

**Decision: a new WebviewPanel type that reuses the guest bundle and an existing conversation page route; it is not a second implementation and not a new bundle.**

- **View type and key.** `omp.detail`. The type deliberately does not start with `omp.session`: package.json's editor-title (Switch to Terminal/Chat, Copy Screen) and Ctrl+Enter/Escape/focus-composer when-clauses match `activeWebviewPanelId =~ /^omp[.]session/`, and a detail tab is not a session editor ([ADR-0043](../decisions/0043-place-session-mode-actions-in-editor-title.md)); a test asserts that every `activeWebviewPanelId` regex in package.json misses it. It also stays outside the bridge view-type namespace. The host keeps `Map<string, DetailTab>` keyed by the JSON tuple `[tabId, kind, agentId|null]` (no id can collide with another key), `kind ∈ {todo, agents, agent}`. `todo` and `agents` have no agent id. A second `omp:open-detail` for an existing key calls `panel.reveal()`; it never creates a second editor.
- **Request.** New guest→host message `omp:open-detail` as a discriminated union (`kind: "todo" | "agents"`, or `kind: "agent"` with `agentId`), validated by `parseGuestWebviewMessage` (exact key set; `agentId` a non-empty string of at most 256 characters without control characters; the registry accepts any 1–256 character id, so an id with a control character simply cannot open a tab — intended). The host resolves the conversation from the **sending editor's slot**, never from the message, like chat commands, and accepts the request from controlling and passive editors (presentation only). It is handled explicitly in `handleGuestMessage` (before the chat-command routing) and in `handlePassiveSlotMessage`, **never** in the bridge handler, and is ignored when the editor is in Terminal mode or the conversation is legacy (nothing would arrive). The bridge allow-list is unchanged ([ADR-0023](../decisions/0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md)): a page on a surviving *bridge* route gets `false` from `guestTransport.post` (the operation is panel-only), so its detail buttons are disabled with an explanatory title ("Reload the window to open detail tabs"). The guest protocol version is unchanged: the message is additive and an older host drops it as unrecognized; a newer guest never runs against an older host (package drift withholds new documents).
- **Panel.** `createWebviewPanel("omp.detail", title, ViewColumn.Active, {enableScripts, retainContextWhenHidden, localResourceRoots: [media]})`; title `TODO · <session headline>`, `Agents · <headline>`, or `<agent id> · <headline>`, fixed at creation (a later rename of the session is not reflected; accepted). It is a normal editor tab in the sender's group.
- **Document.** `createDetailHtml` in `src/host/guest-webview.ts` shares the CSP builder with `createGuestHtml` and differs only by: `connect-src 'none'` (no bridge, ticket or port), **no** identity meta (so the page persists no state and VS Code has nothing to restore), and `<meta name="omp-detail" content="todo|agents|agent:<encodeURIComponent(id)>">`. The same single nonce'd script, resource-gated stylesheet and Codicon font apply; no network, no new permission, no new script ([ADR-0041](../decisions/0041-allow-terminal-style-attributes-under-nonce-stylesheets.md) and [ADR-0028](../decisions/0028-stamp-document-nonce-on-renderer-created-styles.md) are unaffected).
- **Data route and enforcement.** On the page's `omp:ready` (protocol must equal `GUEST_PROTOCOL_VERSION`, as for chat), the host calls `chat.attachPage(tabId, detailPage)` for the conversation and keeps the detach function; a document that announces itself again replaces the route. `detailPage.post` forwards to `panel.webview.postMessage` and drops when the panel is gone; `readOnlyReason` is a constant sentence. The page therefore receives the same epoch-bound `omp:chat-state`, chunked snapshot and `omp:chat-event` stream as a chat page (`ChatClient` is reused unchanged) and reads child history through the existing `omp:chat-subagent-read` exchange with its registry/reference gating and page bounds. **The detail panel's own message handler is the enforcement point, not the runtime's read-only overlay** (which still lets `omp:chat-tool-detail` write the global Tools preference and `omp:chat-resume` request admission): the handler accepts only `omp:ready` and `omp:chat-subagent-read` and drops everything else before any `runChatCommand`/`handleMessage` call. Host tests assert that prompt, abort, resume, tool-detail, load-older, open-detail and mode requests from a detail panel never reach the runtime.
- **Why a conversation page, not a host-pushed DTO.** The snapshot already carries `todo`, `agents`, `agentActivity`, `agentAvailability` and live frames with their reconciliation rules; a second DTO channel would duplicate the reducer contract and its epoch fences. The cost is that the detail tab receives the whole chat snapshot, which `ChatRuntime` already chunks and bounds per route.
- **Views.**
  - `todo`: header with `closed/total` and per-phase counters; every phase and task (no cap, normal document scroll) with status glyph **and** spelled status word, blocker ("Blocker: …"), details and notes as Markdown (the existing inert `Markdown`), and the active-agent match. The page scrolls normally as a document, with one scroll owner (the tab body).
  - `agents`: the roster, one row per agent with status, type, description, current activity and compact stats (`AgentProgressView`), each row a button that opens that agent's tab through the same `omp:open-detail`.
  - `agent`: header (id, type, status, elapsed), description, the assignment (collapsed disclosure), `AgentProgressView` stats, and a live read-only child transcript (`ChildTranscriptBody`, the existing lazy reader, bounded page and Older control). **Live updates**: after the first read the view refreshes incrementally (`fromByte = nextByte`) every 2 s while the agent is `running` (not `pending`); reads are serialized (one in flight), skipped while the user views an earlier page or `document.hidden`, and stopped on unmount; one last read follows when the agent leaves `running`. A failed refresh (changed epoch, stopped session, timeout) **keeps the rows already read** and shows a status note; only the first read may show the unavailable sentence, so a stop never blanks the transcript. If the agent leaves the registry, the last known header stays with a "no longer in the native registry" marker and the transcript stays readable while OMP still resolves retained references. The view subscribes to a stable slice of the conversation (phase, todo, agents, activity, availability, title), not to the whole snapshot, so streaming token deltas do not re-render it.
- **Lifecycle.** The tab is bound to the session by exactly two host hooks: `forgetConversationState(tabId)` (delete/forget) and the terminal branch of the chat→terminal switch (`chat.release` there) close its detail tabs. Explicit Stop and Chat Reload keep them: pages stay attached to the conversation, a stopped session publishes its `stopped`/`view-only` phase, and the tab shows the host's own phase banner, the last known data and "ended" markers; after a Chat→Chat reload an agent id that is gone shows the ended marker. **No serializer or activation event is registered for `omp.detail`**: nothing is persisted, and a detail webview that survives a window reload or a host-only restart has no way to learn that the host is gone (it has no bridge to lose). Instead activation sweeps `tabGroups.all` for webview tabs of this view type (the workbench prefixes the type with `mainThreadWebview-`) and closes them. Disposal detaches the page and clears the map entry.
- **Ownership and bridge rules.** No editor slot, binding, claim, bridge endpoint or lifecycle gate is created for a detail tab: it is a read-only presentation page of an existing conversation, like a passive editor's read-only view but without a slot. It cannot control the writer ([ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md), [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md)) and does not extend the bridge allow-list ([ADR-0023](../decisions/0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md)).

### Guest changes

- `App.tsx`: render `<DetailView client target/>` when `meta[name=omp-detail]` names a target (read once, immutable per document); in chat mode render `<HudDock/>` (`TodoHud` then `RunningAgents`, the TUI's order) inside `.omp-dock`, directly above `<Composer/>`.
- New components: `HudRows` primitives (`HudHeader`, `useDetailOpener`), compact `TodoHud`/`RunningAgents`, `DetailView` (`TodoDetail`, `AgentsDetail`, `AgentDetail`); pure view-model `src/chat/hud-summary.ts` (collapsed summaries, row windowing, glyph choice) shared by rows and tests. `ChildTranscript.tsx` exports its body with `refreshMs`/`keepOnFailure` options; the `<details>` wrapper stays for transcript task cards.
- Styles: a new `hud-styles.ts` string added to the guest stylesheet; the old `.omp-native-hud*`, `.omp-native-todo-*`, `.omp-native-agent-list` and nested-scroll rules are deleted.

### Accessibility

Rows are native buttons with `aria-expanded` (and `aria-controls` only while the list exists); the open-in-tab and `+N more` controls are buttons with explicit names; glyphs are `aria-hidden` and each task line carries a visually hidden status word so status is not colour- or glyph-only (the "no chip text" rule is visual: the word is `sr-only`). Keyboard: Tab order is toggle, open, then rows; Enter/Space activate. Focus styles use `--vscode-focusBorder`. Spinner animation honours `prefers-reduced-motion`. The detail tab is a document with a heading hierarchy (`h1` title, `h2` phases) and a Refresh button for the child transcript; it is reachable through normal editor navigation and tab order.

## Alternatives

1. **Inline expansion with larger bounds / internal scroll.** Rejected by the user (scroll-in-scroll, inline chat noise).
2. **A new, separate webview bundle and host-pushed DTOs.** A second reducer/projection contract with its own epoch fences and tests, and a second guest build entry, for the same data the conversation page already delivers. Rejected as duplicate infrastructure.
3. **A detail tab as a full editor slot (own binding, bridge ticket, restore identity).** Gives restore and bridge reconnect, but drags a presentation view into slot election, durable bindings, claim demotion and the bridge allow-list ([ADR-0015](../decisions/0015-serialize-tab-lifecycle-through-one-gate.md), [ADR-0025](../decisions/0025-bind-editor-slots-to-current-conversations.md)). Rejected: a detail tab has no writer authority and a bounded, session-tied life.
4. **A VS Code sidebar view or a read-only virtual document (`TextDocumentContentProvider`).** A virtual document cannot show live structured activity or the child transcript renderer; a view container changes the product's UI surface. Rejected.
5. **`vscode.window.createWebviewPanel` per click without a key map.** Duplicates tabs; rejected by the one-tab rule.

## Risks and Open Questions

- The detail tab receives the whole chat snapshot. It is bounded by existing chunking and the 100-card admission rule, but a very long history costs the tab memory proportional to the chat page. Its view re-renders only on a stable slice (not on token deltas). Accepted; a trimmed projection can be added later without changing the route.
- Polling the child transcript every 2 s uses the existing lazy read exchange (a registry- or reference-gated `get_subagent_messages`), one read in flight, only while the agent is `running`. `document.hidden` is a best-effort guard: whether VS Code reports it for a hidden `retainContextWhenHidden` webview is not verified, so the cost bound is the 2 s period and the one-in-flight rule. Event-driven refresh on `RunningAgent.lastUpdate` is a possible later refinement.
- Elapsed time depends on native `progress.durationMs`; if the native progress omits it the field is simply absent.
- `retainContextWhenHidden` keeps each open detail tab's context alive. The number of tabs is bounded by what the user opens; closing the tab releases it.
- Bridge-route pages cannot open detail tabs until Reload Window; the buttons are disabled with that explanation.
- Two expanded rows could pin up to 2 × (1 + 8 + 1) = 20 lines. Resolved by the placement correction: the combined height is capped at 40 % of the viewport by showing fewer rows plus `+N more`.
- The roster (`agents`) tab is an addition beyond the two tab kinds the user named: it is the target of the Agents row's open button and its `+N more`, and it lists each agent with full statistics.

## Rollout and Verification

1. This design, reviewed by `architect`.
2. Pure `hud-summary` module with unit tests (single counter and title, current-task selection, summary text rules, 8-row window and `+N more`, glyph mapping, agent activity fallback).
3. Guest rows and detail views; host: message parser, `createDetailHtml`, `DetailTabs` registry wired into `extension.ts`, activation sweep of leftover tabs, lifecycle hooks.
4. Focused tests: messages parser; document builder (same CSP as chat with `connect-src 'none'`, no identity/bridge meta, encoded detail meta); registry (reveal instead of duplicate, disposal on forget, protocol check, everything but `omp:ready`/`omp:chat-subagent-read` dropped before the runtime); package.json when-clauses miss `omp.detail`; owned-Chromium UI tests for collapsed/expanded rows, the 8-row bound and `+N more`, no scroll region in the pinned rows, `omp:open-detail` posts, keyboard operation and `aria-expanded`; detail views render the full TODO and an agent's transcript, live refresh, and a failed refresh keeping the rows already read.
5. Packaging proof once the earlier chat streaming and dock changes are committed: typecheck, full test run, VSIX; installation only into the isolated window, then a real session with a TODO list and two running subagents, with image-inspected screenshots of collapsed rows, expanded rows, the TODO tab and a live-updating agent tab.

## Related Decisions

[ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) (host-owned conversation and pages), [ADR-0023](../decisions/0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md) (bridge unchanged), [ADR-0019](../decisions/0019-vscode-owns-omp-editor-persistence.md) (no persistence for detail tabs), [ADR-0041](../decisions/0041-allow-terminal-style-attributes-under-nonce-stylesheets.md) and [ADR-0028](../decisions/0028-stamp-document-nonce-on-renderer-created-styles.md) (CSP/nonce unchanged), the [Paseo-style chat design](2026-10-04-paseo-style-chat.md) (flat rows, one outer scroll owner) and the [TUI parity design](2026-10-01-tui-parity-transcript.md) (native TODO/agent semantics).

## Architecture Review

- Reviewer: architect
- Outcome: accepted (round 1: accept with changes, with material and minor findings; round 2 after revision: accept, no new material finding)
- Notes: round 1 changed the view type to `omp.detail` (outside the `^omp[.]session` when-clauses), dropped the serializer for an activation sweep, limited the close hooks to forgetting and terminal takeover (Stop and Reload keep tabs), made a failed live refresh keep the last page, defined the TODO window as the TUI's walking viewport, and named the detail registry as the enforcement point. Round 2 verified each against the revised text and the sources and left five non-blocking cleanups (stale registry/bridge comments, a lone-surrogate agent id rejected by the parser, an invalid detail meta rendering an error instead of the session view, phrasing-only content inside the roster button), all applied. Escalated to the maintainer: the roster tab is an addition beyond the two kinds named, the 20-pinned-lines height risk on short windows, and the changed TODO window semantics.

## Implementation Evidence (completed 2026-10-06)

- Source: applied on top of the earlier chat streaming and dock changes (committed 2026-10-06). `npm run typecheck` clean; full `npm test` 1,515 tests, 1,512 pass, one platform skip. The one failure was the known load-sensitive `owning pane renders at its own fit…` assertion; `chat-ui.test.ts` alone then passed 85/85. An earlier full run also exposed that the lifecycle test harness's `reset` did not create `detailTabs`; it now does.
- Artifact: the packaged VSIX (not kept in the repository), SHA-256 `4e611841c59e55ab9bce5271fda79b010043347178e992090da586cb8ba3e78c`. Installed only into the isolated profile; the installed `out/extension.js` (`53f7a09c…`), `media/guest.js` (`461bbd2f…`) and `media/shell.js` (`777ab04e…`) equal the packaged build. Window reloaded through CDP.
- Real session in the isolated window (installed OMP, Chat view): a TODO list and two running `task` subagents. Screenshots were image-inspected; they are not kept in the repository.
  - Collapsed rows, one line each, one `1/5` counter.
  - Expanded rows (five tasks, two agent lines, no scroll region).
  - The TODO tab with phase, counts and status words.
  - Agent tab while running (header status, assignment, read-only note "live, refreshing every 2 s", the child's `Bash` call shown **running**). The first build showed that call as `skipped`; the child transcript now treats the last unanswered calls of a live agent as running, and shows them skipped again once the agent leaves the registry.
  - Same tab about 100 s later with no manual refresh: the call settled, the child's `done` reply and the background-job completion appeared, and the counters advanced.
- Not observed: the bridge-route disabled state (no live bridge in the isolated window), keyboard operation in the installed window (covered in Chromium by native `<button>` and `aria-expanded` assertions), Narrator.
- Incidents: an earlier CDP keystroke sequence typed `Developer: Reload Window` into an already focused OMP terminal session in the isolated window (a harmless prompt there); removing the worktree followed its `node_modules` junction and emptied the main tree's `node_modules`, restored with `npm ci` from the unchanged lockfile.

## Addendum: placement correction (2026-10-06)

**User correction.** The first version pinned the rows at the **top** of the chat as a separate full-width, edge-to-edge panel with its own background. The user's confirmed decision: the TODO and Agents rows sit at the **bottom**, directly above the composer dock, inside the chat column (the transcript's max width and horizontal alignment), styled exactly like flat tool rows (no panel background, no full-width band), and they do not scroll with the transcript, whose viewport ends above them. Collapsed and expanded content and behaviour (one counter, at most eight rows plus `+N more`, no nested scroll, detail-tab icons) are unchanged. See [Placement](#placement-bottom-block-above-the-composer).

**What changed.**

- `App.tsx` renders `<div class="omp-dock"><HudDock/><Composer/></div>` after the transcript body; the rows are no longer in `.omp-main`.
- `HudDock` owns both rows' expansion and the viewport height; `TodoHud`/`RunningAgents` are controlled and receive the lines the cap leaves them. `hud-summary.ts` gained the cap (`hudSectionLines`, `todoWindowWithin`, `agentWindowWithin`) and the row-height constants that `hud-styles.ts` interpolates.
- `hud-styles.ts`: the band background, border and 12 px font are gone; the header is `.omp-tool-head`'s box (padding `4px 8px`, gap 6 px, inherited font, 16 px chevron and the same icon the transcript's `todo`/`task` rows use, bold label, muted summary, right-aligned counter) with the same hover; the stack has the composer's `min(840px, 100% − 24px)` width. The agent id and badge may shrink with an ellipsis so the elapsed time stays inside the column at 320 px, and the colon sits on the id/badge (`WorkerE: Wait five minutes…`), not after a flex gap.
- No change to the scroll controller: the rows belong to the dock, so its existing resize handling is the bottom anchor.

**Evidence.**

- Source: `npm run typecheck` clean; full `npm test` 1,524 tests, 1,523 pass, one platform skip, no failure. Owned Chromium (`todo-agents-ui.test.ts`, new): DOM and layout order transcript → rows → composer inside `.omp-dock`; the stack's left/right equal the composer card's and its left equals the transcript content's; flat (transparent, no border); same font size, padding, chevron size and hover rule as `.omp-tool-head`; expanding/collapsing either row and both rows appearing/disappearing keep the bottom visible transcript line within 1 px of the bottom block's top, following (pinned to the tail) and detached (jump-to-latest stays); both rows open at 900/700/500/400 px viewport heights never exceed 40 % of it, show fewer rows plus an exact `+N more`, keep the actionable task and have no scroll region; at 320 px each header and row stays one line, summaries truncate with an ellipsis, nothing leaves the column. `hud-summary.test.ts`: cap arithmetic and window fitting. Two `chat-ui.test.ts` HUD subtests now ask for a 900 px viewport because the cap depends on it. At the unchanged HEAD the load-sensitive `owning pane renders at its own fit…` assertion also failed in this environment (the full run here passed it).
- Artifact: the packaged VSIX (not kept in the repository), SHA-256 `d25993624ab8d8835c1797a681186569f56ba5191f755aa1e80dbf718d6588b1`. Installed only into the isolated profile; installed, built and packaged `out/extension.js` (`53f7a09c…`), `media/guest.js` (`cef9e23b…`) and `media/shell.js` (`777ab04e…`) are equal. Window reloaded through CDP (F1, `Developer: Reload Window`, Enter, focus in a webview, not a terminal).
- Real session in the isolated window (installed OMP, Chat view, a TODO list with five tasks and two running `task` subagents, WorkerE and WorkerF; screenshots were image-inspected and are not kept in the repository):
  - Collapsed, rows directly above the composer inside the column.
  - Expanded (five tasks, two agent lines, combined 204 px of a 798 px viewport).
  - Expanding while reading detached (jump-to-latest shown): the bottom visible line stayed at −26.31 px from the bottom block's top while that top moved 605 → 501 → 457 → 561 → 605 px as TODO and Agents were expanded and collapsed.
- Not observed: Narrator, a 320 px installed window (covered in owned Chromium).

## Presentation refinement (2026-10-08)

The pinned TODO count is shown once in its header; expanded phase headings no longer repeat task counts. Agent types are muted words without angle brackets. The agent roster and individual tab show elapsed time once in the heading, not again in progress statistics, while retaining shared live-clock updates. Tool counts are pluralized and token/duration statistics use the common Chat format helpers. Child transcript controls keep Refresh and Older without an explanatory paging-jargon line.

## Closed-task contrast refinement (2026-10-08)

Completed and cancelled task text in the pinned row, TODO detail tab and transcript tool details uses `descriptionForeground` and strike-through, never the status-icon palette as a text color. The leading completed check alone uses `testing.iconPassed`; the cancelled circle-slash remains muted. This narrows the earlier success/error-color presentation without changing native task status or the one-counter policy.

Owned Chromium verification in all four built-in light/dark/high-contrast themes checks readable completed/cancelled prose in the real pinned TODO and full detail components, with image-inspected screenshots. The focused TODO/Agents UI regression also passes; installed-extension acceptance remains separate.


## Initial child-history loading refinement (2026-10-08)

A single-agent detail tab waits for the parent conversation's first authoritative snapshot and an initialized phase before mounting its child reader. Until then, and while the first read is in flight, it shows loading rather than interpreting a missing epoch as a stopped parent. A rejected read while the parent is running is described as a read failure; the stopped-parent explanation is reserved for a confirmed stopped or history-only parent. Existing serialized live refresh and retention of already-read rows are unchanged.

