---
status: implemented
date: 2026-10-13
---

# Chat visual refresh: derived tokens, calm tool rows, quiet composer, notices and an empty state

## Problem

A visual comparison of the Chat page with eight other products (Claude Code, Copilot Chat, Cursor, Codex, Paseo, Zed and others), measured on the baseline build in Dark Modern, Light Modern and High Contrast, found that the transcript has almost no visual hierarchy, mostly because of CSS and a few renderer details:

- `--omp-muted` is the theme's `descriptionForeground`, which **equals the foreground in Light Modern**, so everything we call muted (status row, thinking label, reply footer, tool digests) is not muted there. The user prompt card is 1.01:1 against the page in dark and its border 1.27:1.
- Tool rows are heavy: three icons (chevron, success check, type icon), a bold name, a blue path on every row and a 37.5 px pitch. The Edit head shows an absolute path that its body repeats in 10 px capitals; `+N −N` is uncoloured; several TODO calls read just "TODO"; the Task and Agents rows print raw sub-agent text.
- The composer toolbar is six bordered boxes, a washed-out disabled Send (opacity .45) and two focus rings (card and textarea).
- Prose flaws: inline code at the editor font size inside smaller prose, a full-grid table, a bordered Copy button under every reply (the shared secondary-button rule re-adds the border its own rule removes).
- Noise: "Aborted" plus "Interrupted by user", a monospace `Handed off` divider, a motionless working row, a three-bordered-control ask dialog, queue and TODO labels 22 px apart, six corner radii (0, 3, 4, 6, 8, 10) on one screen, and an empty chat that is one italic line.

The maintainer reviewed an interactive proposal (before/after panes with toggles R1 to R14, built from the real webview CSS and markup) and accepted R1 to R13 with the variants recorded under [Decisions](#decisions-recorded-by-the-maintainer). R14 (a files-changed card, a "Worked for" divider) was not rated and is out of scope.

## Goals and Non-goals

- **Goals**
  - Ship R1 to R13 with exactly the accepted variants, as the real stylesheet and renderers, not as override layers on top of the old rules.
  - Keep every theme coherent: Dark Modern, Light Modern, Dark High Contrast and High Contrast Light. Tokens derived with `color-mix` must never lower High Contrast contrast.
  - Keep accessibility: success stays announced when its mark is hidden, one visible focus ring, reduced motion honoured, accessible names on icon-only controls.
  - Durations stay in whole seconds (`fmtDuration`).
- **Non-goals**
  - R14, any new tool-call data from OMP, any change to the OMP protocol, the broker, claims or the session index format.
  - Re-theming the folder-shell document beyond the shared tokens it already imports from `base-styles.ts`.
  - New settings. The refresh is not switchable; the proposal's variants are decided.

## Current State

- `src/webview/lib/base-styles.ts` defines `--omp-gap`, `--omp-radius` (4 px), `--omp-border` (`widget-border`), `--omp-muted` (`descriptionForeground`), `--omp-surface`, and the mono tokens. It is shared by the chat document and the folder shell.
- `src/webview/styles.ts` (one string, split with `tool-styles.ts`, `hud-styles.ts`, `queue-styles.ts`) holds the chat rules. `ToolCard.tsx` renders every tool row; `tool-renderers.tsx` supplies per-tool views (`title`, `target`, `meta`, `body`); `Transcript.tsx` renders the empty line, the Aborted/Provider-error blocks and the recovery notice; `NativeMessage.tsx` renders the `Handed off` divider; `ReplyFooter.tsx`, `WorkingStatus.tsx`, `AskDialog.tsx`, `Composer.tsx`, `TodoHud.tsx`, `RunningAgents.tsx` and `QueuedMessages.tsx` render the rest.
- Page to host messages go through the guest bridge. A page on a surviving bridge route has a fixed allow-list; `post()` drops unrouted types there and panel-only exchanges (detail tabs, `@` completion) are disabled and say so. `omp:open-detail` is a fire-and-forget message; `omp:complete-files` is the request/reply exchange.
- A tool row has two faces. The collapsed head is built from `toolPresentation()` (`src/chat/tool-presentation.ts`: title, target, paths, `failed`), which carries no meta; the per-tool renderer in `tool-renderers.tsx` (`describeTool`) runs only when the body is shown (or for wait, ask and debug rows). The bare "TODO" row is that collapsed head (its title is `TODO` and it has no target); an Edit head is already workspace-relative when collapsed (normalized `paths`) and absolute only once expanded.
- Headless Chromium tests (`chat-ui.test.ts`, `todo-agents-ui.test.ts`, `theme-ui.test.ts`, `queued-messages-ui.test.ts`) drive the real bundle against theme fixtures (`theme-ui-fixtures.ts`: Dark Modern, Light Modern, High Contrast, High Contrast Light).

## Proposed Design

### Tokens (R1, R13)

`base-styles.ts` is the one place tokens change, so the chat page and the folder shell move together.

| Token | Normal themes | High Contrast (`.vscode-high-contrast`, `.vscode-high-contrast-light`) |
|---|---|---|
| `--omp-muted` | `color-mix(in srgb, var(--vscode-foreground) 72%, var(--vscode-editor-background))` | `var(--vscode-descriptionForeground, var(--vscode-foreground))` (the theme's own, as today) |
| `--omp-border` | `color-mix(in srgb, var(--vscode-foreground) 18%, transparent)` | `var(--vscode-contrastBorder, var(--vscode-widget-border))` |
| `--omp-radius` | 4 px (controls) | same |
| `--omp-radius-card` | 6 px (cards, code blocks, the user bubble, the ask dialog, rewind bar, popovers) | same |
| `--omp-radius-composer` | 10 px (the composer card only) | same |

- The 72 % and 18 % values are the maintainer's choices. With the baseline theme fixtures they give 5.9:1 (dark) and about 4.8:1 (light) for muted text on the page background and 1.54:1 / 1.37:1 for the border, against 1.27:1 today; Light Modern now actually dims.
- **Every muted text uses the token.** Rules that read `descriptionForeground` directly (the tool meta, the context percentage, branch name, history pages, queue/HUD dim text, `.omp-ask-review-a--none`, todo and agent dim text) move to `var(--omp-muted)`, whose High Contrast branch already resolves to `descriptionForeground`; without that, those texts stay undimmed in Light Modern. A grep for `descriptionForeground` in the webview stylesheets must find only the token definition and the placeholder fallback.
- **Hover surfaces.** At 72 % the Light Modern muted colour is 4.8:1 on the page but 4.3:1 on the row hover colour (`list-hoverBackground`). Rows whose text is muted and that take a hover surface (tool head, HUD and queue rows, Overview head, recents) switch that text to the foreground on `:hover` and `:focus-visible`. The contrast test measures muted text on every surface it sits on in the four fixtures (page, editor widget, hover) and the `+N`/`−N` colours, and asserts 4.5:1 for each that is not switched to the foreground.
- High Contrast keeps the theme's own colours: `color-mix` of two near-black/near-white values would lower the separation HC themes guarantee, and HC borders must stay the opaque `contrastBorder`.
- `--omp-border` moves from an opaque theme colour to a translucent mix, so every hairline that uses it gets slightly stronger (dividers, the rewind bar, ask options, attachment chips). R6, R11 and R13 absorb the places where that is too much (ask options and tabs become flat, see R11).
- The report's third token, a "raised" surface (`foreground` 6 % over the background), is **not introduced**. The accepted R6 variant is the tinted bubble from VS Code's chat tokens and R4 keeps the editor code-block background, so no accepted rule would consume it; a token without a consumer is dead weight. If a later change needs a raised surface it adds the token with its consumer.
- Radius scale (R13): the literals 0/2/3/4/8 px in `styles.ts`, `tool-styles.ts`, `hud-styles.ts` and `queue-styles.ts` become `var(--omp-radius)` (controls: buttons, chips, inputs, tabs, rows, small boxes), `var(--omp-radius-card)` (user bubble, `pre`, ask dialog and its answer rows, rewind bar, popovers, the composer's inner textarea) or `var(--omp-radius-composer)` (the composer card). Circles (`50%`) and pills (`999px`: the chip, the branch-point toggle and the Send pill) are shapes, not scale steps, and stay; no other literal radius is kept. The token definitions are in `:root`, and the HC overrides sit on the `.vscode-high-contrast` / `.vscode-high-contrast-light` classes VS Code puts on `body`.

### Per recommendation

**R2 Calm tool rows** (accepted: pitch 26 px, success mark hidden, regular muted name, neutral path with link colour on hover, Edit head path workspace-relative, coloured +N/−N, duplicate body title hidden).

- Pitch: `.omp-row--assistant` rows that hold only a native tool have no vertical padding, `.omp-tool` has no margin, `.omp-native-tool .omp-tool-head` pads 3 px 8 px (head 20 px + 6 px). The expanded body pads `4px 12px 8px 30px`.
- Success mark: `ToolCard` does not render the state icon when the call is `complete` **and not failed** (`state === "complete" && !failed`, in the bare and the normal face alike). A call can be settled and failed (a bash exit code, a per-file edit error), and it keeps its error icon; running, queued, failed and skipped rows keep theirs. The success status stays announced by the existing `role="status"` sr-only text in the head, so a screen-reader user loses nothing. The icon is already `aria-hidden`, so the point of omitting the markup rather than hiding it with CSS is only that no empty slot is left in the row. The visible consequence is accepted as in the proposal: a settled row's name starts one icon width left of a running or failed row's.
- Name and digest: `.omp-tool-name` is regular weight in `--omp-muted`; the digest (the target, which is what the reader scans) is in the foreground; the type icon is 14 px muted. File links inside the head are foreground, and the link colour appears on `:hover` of the head and on `:focus-visible` of the link.
- Both faces show the same facts. What the collapsed head needs is computed in the chat layer, in `toolPresentation()`, so it does not depend on the renderer running: the relative Edit target (already there), `stats: { added, removed }` for edit calls (a pure `diffStats` over the call's per-file diffs, `src/chat/diff-stats.ts`, which the Edit renderer also uses for streamed previews), the TODO operation sentence as the target of a `todo` call and its `done/total` as `counter`. `ToolCard` renders `stats` and `counter` from the presentation in both faces. The title stays `TODO`.
- Edit (expanded): the renderer computes its target with `normalizeToolPath(path, cwd)`, for the one-file head, a rename source and each multi-file section title. `ToolTargetText` then links the relative path exactly as it links a Read row's path. `+N −N` is rendered as two spans (`.omp-diff-stat--add`, `.omp-diff-stat--del`, coloured with `gitDecoration-addedResourceForeground` / `deletedResourceForeground`, falling back to `testing-iconPassed` / `errorForeground`) with text signs, so colour is never the only carrier. The expanded section of a one-file edit renders no title (it repeated the head): nothing is lost, because the head already says Edit, Create or Delete, shows a rename as `source → target` and links the path at the first changed line; a multi-file edit keeps one relative-path title per file because the titles are what tell the files apart.
- Overview mode rows and the Task/Wait/Bash renderers keep their structure; they inherit pitch, name and colour rules.

**R4 Prose.** Inline code `.92em` with `0 4px` padding (fenced code keeps the editor size), paragraphs `8px 0`, headings `16px 0 4px` at weight 600 (h2 `1.2em`), tables with horizontal rules at 18 % foreground and a muted 600 header, blockquote with a 3 px rule in `--omp-border` and no band, `pre` padded `10px 12px` with the card radius. In HC the table rules and the blockquote rule use `--omp-border` (the contrast border).

**R5 Copy.** `ReplyFooter` renders an icon-only Copy button (`.omp-reply-copy`, codicon `copy`, `aria-label="Copy reply"`, the existing `title`), 70 % opacity with the toolbar hover surface; `.omp-reply-copy` leaves the shared secondary-button rule at the end of `styles.ts` and the footer reads `duration · time` with a CSS separator. The element, its class and its `role="status"` copy result stay, so the existing interaction tests still apply.

**R6 User prompt.** `.omp-row--user .omp-body-block` uses `var(--vscode-chat-requestBubbleBackground, color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent))` with a 1 px transparent border (so the box is the same size in every theme) and the card radius. In HC it is transparent with a `contrastBorder` border (a tint would not be distinguishable and a border is).

**R3 Composer.** Model, effort, context and attach controls lose their resting border and fill and are `--omp-muted` text and icons that take the toolbar hover surface; `contrastBorder` is kept in HC. Send is the one filled control, a pill with its label (the narrow-panel rules that already make it icon-only below 460 px stay); disabled Send is neutral (secondary background, `disabledForeground`, opacity 1; an 8 % foreground mix in light themes). Focus: `.omp-composer:focus-within` takes `focusBorder` and the textarea draws no outline of its own, so there is one ring, on the card; HC keeps the orange `focusBorder`. The ask dialog keeps the toolbar (maintainer's variant). Additional maintainer request, same step: the **Tools output chip** (`.omp-tools-trigger`, `ChatFooter`'s `toolsOutput`, `ChatClient.chooseToolCallDetail`) is removed from the toolbar; the density is changed only in Settings (`omp.toolCallDetail`), whose display-preference path stays. The now-dead host path for the chip's page message (`omp:chat-tool-detail`) is removed by the runtime-port owner in its own step.

**R7 Empty state** (accepted: hints and recents). See [Empty state and recents](#empty-state-and-recents-r7).

**R8 TODO, Task and Agents rows.**

- TODO operation: `todoOperationText(ops, op)` in `src/chat/todos.ts` maps each op of `args.ops` (falling back to `details.op`) to a sentence: `init` "Planned N tasks", `start` "Started “task”", `done` "Done “task”", `drop` "Dropped “task”", `rm` "Removed “task”", `append` "Added N tasks", `note` "Noted on “task”", `view` "Viewed list", an unknown op its own word with its task; several ops join with `, `. `toolPresentation()` uses it as the target of a `todo` call (so the collapsed row reads it too) and puts `done/total` (closed over all tasks of `details.phases`) in `counter`, a right-aligned tabular meta that replaces the expanded `N/M closed` and phase-count metas. Pure functions, defended by host-free tests.
- Task row: the digest is `N agents: Name1, Name2` (names, never the sub-agent prompt), built where `ToolCard` already builds its compact task target; the per-agent `name · agent · status` list moves to the digest's tooltip and stays in the expanded rows.
- Agents row (bottom block): `agentsSummary` becomes `N running[, M completed…]: Name1, Name2` (up to the existing `AGENTS_SUMMARY_NAMES`, `+k` for the rest) and returns the old "who is doing what" fragments as `detail`, which becomes the row's tooltip (the TODO/Agents tabs already show them in full).

**R9 Working status.** The 24 px row keeps its fixed height. A codicon `loading` glyph (`::before`, 8-step spin) precedes the text and the text carries a muted-to-foreground shimmer (`background-clip: text`). Both stop under `prefers-reduced-motion: reduce`, and the shimmer is dropped (plain `--omp-muted`) in High Contrast and under `forced-colors: active`, where text must stay a system colour. The sr-only live region is unchanged.

**R10 Notices.** An aborted reply renders one muted line (`circle-slash` icon plus the reply's own message, "Aborted" when it has none; `role="status"`) instead of the bold "Aborted" block plus the message paragraph. `Handed off · 48.4k → 9.4k tokens` is set in the UI font at 12 px, muted. A provider error is one line: bold "Provider error" and its message inline, in the error colour, wrapping only when the panel is narrow. Retry stays where it is.

**R11 Ask.** The options, answered-state and tabs are flat rows: only the checked option and the active tab keep a `focusBorder` edge; Cancel and Stop are text buttons (no resting border or fill, hover surface) and Next/Submit stay the one primary control. The composer toolbar stays visible (maintainer's variant). HC keeps `contrastBorder` on every control.

**R12 HUD and queue.** The queue title reserves the 16 px chevron slot so its label aligns with the TODO and Agents labels; the HUD "open" button and "Queue all" are the same flat control (no resting border; `contrastBorder` in HC), and `.omp-hud-open` leaves the shared secondary-button rule.

### Empty state and recents (R7)

`Transcript` renders `EmptyState` instead of the italic line when there is nothing to show (no rows, no stream, not working). While `phase` is joining it keeps the one-line "joining the session…". `EmptyState` shows:

1. The folder name (basename of `cwd`) with the model name and thinking level already on the page (`snapshot.state.model`, `thinkingLevel`).
2. A static "Start" list: `/` commands and skills, `@` attach a file, `Alt+Enter` queue a follow-up, `Esc Esc` rewind. No data. (`@` completes files only; the proposal's "or a symbol" is not shipped.)
3. "Recent in this folder": up to three sessions of the same folder, each a row with a history icon, the title and a relative age (`2h`, `1d`); clicking a row does what a click on that row in Sessions does.

The recents are the only part that needs host data. The decision, as an additive request/reply pair beside `omp:complete-files`:

- Page to host `omp:recent-sessions-request { requestId }`; host to page `omp:recent-sessions { requestId, items: [{ title: string, updatedAt: number /* epoch ms */ }] }` (at most three, titles collapsed to one line and bounded to 120 characters); page to host `omp:open-recent { requestId, index }`. Both directions are parsed strictly in `src/protocol/messages.ts` (integer ids, bounded arrays, finite timestamps, no extra fields trusted). The messages are additive: no `GUEST_PROTOCOL_VERSION` bump, and on a bridge route `post()` already drops types the route does not carry.
- Authority stays in the host. The folder is the sending editor's own conversation folder, never a field of the message. The reply carries no session id, file path or tab id: `omp:open-recent` names an item by the answer's `requestId` and ordinal `index`, which the host resolves only against the last answer it gave that document. The host keeps that answer in a per-document table keyed like the dispatcher's draft captures (slot, panel, document) and cleared when the document is rebound or disposed. Those key types belong to `src/wiring/guest-dispatcher.ts`, and views may not import wiring, so the table and the two operations live in a new wiring module `src/wiring/recent-sessions.ts` over a small dependency interface (the tree's listed sessions, `itemFor`, the click, an info message); the dispatcher only gains two cases that delegate to it, plus a line in its header. An unknown, stale or out-of-range pair is refused with the same "not listed in Sessions any more" message a stale process row gives, not silently.
- Selection comes from what Sessions already shows, not from a second reader. `SessionTreeProvider.listedSessions()` already carries every listed row's headline (title, preferring the file's own title slot) and conversation last activity (`SessionTreeItem.conversation.lastAt`, the last conversation entry, not file mtime), kept current by the tree's own bounded enrichment; it lists only the folders Sessions shows, so recents come only from those. A pure function `recentSessionsOf(rows, cwd, selfTabId, limit)` in `src/views/recent-sessions.ts` keeps the rows whose entry is a session in the same folder (both folders compared with `normalizeSessionIdentityKey`; index folders are already normalized), is not the editor's own conversation and has a last activity, sorts newest first and takes three. The host layer may not import views, so nothing here lives in `src/host/`. Rows whose title or activity the tree has not read yet are skipped.
- Opening: the item is resolved to its `SessionTreeItem` through `launcherProvider().itemFor(tabId)` (the path `openProcess` takes for a process row) and passed to `sessionActions.click`, so window switching, ownership refusal and mode follow the existing rules and no second open path exists. A session the tree cannot return gets the same "not listed" message.
- The page asks when the empty state mounts on a panel route, when the conversation's folder changes and when the route moves from bridge to panel; a late or mismatched reply is dropped by `requestId`. The tree reads activity asynchronously, so a chat that opens on a cold tree would be answered with fewer rows than exist: while the empty state is open and an answer holds fewer than three items, the page asks again at most twice (after 1.5 s and 4 s), then keeps what it has. On a bridge route it sends nothing and shows hints only; a timeout, an empty list or a failure also yields hints only, never an error line.
- Host wiring touches `src/wiring/guest-dispatcher.ts` (two dependencies or delegating cases and a header line) and `src/extension.ts` (constructing the recents module over `launcherProvider()` and `sessionActions`). Both files belong to the SessionRuntime port work; the lines are agreed with its owner and made by whoever is not editing the file at that moment (recorded in the implementation notes), never written concurrently.
- Tools output chip compatibility: the page stopped sending `omp:chat-tool-detail` (commit 8c98f62) and the runtime-port owner removed the host half (db425b7): the message type and parser, the bridge operation, the dispatcher allow-list entry and the QuickPick. There is no `GUEST_PROTOCOL_VERSION` bump. **Compat note:** a page of an older build that survives an extension-host restart (the bridge keeps a document alive across it) still carries the chip and can send the removed request; the restarted host no longer knows that operation and refuses it, so the chip does nothing there until the window is reloaded. `omp.toolCallDetail` and the host's readback of it to every panel and bridge route are unchanged, so the density can still be changed in Settings.

### Accessibility

- The status text of a settled tool (`complete`) stays in the head's sr-only `role="status"`; only the visual mark goes. Failure, running, queued and skipped keep both icon and text. Tests assert the mark is absent and the status text is present.
- One focus ring: the composer card shows `focusBorder` on `:focus-within`; every other control keeps its own `:focus-visible` outline (the quiet chips lose only their resting border). The tool head keeps its inset outline, and the file link inside it a visible outline on `:focus-visible` (link colour appears on focus as on hover).
- Colour is never the only carrier: `+N −N` has signs, status has text, the Send pill has its label, icon-only controls (Copy, narrow Send) have `aria-label`.
- High Contrast: tokens fall back to the theme's own values; every control that loses a resting border in normal themes keeps `contrastBorder` in HC; the tinted user bubble, the quiet table rules and the shimmer have explicit HC branches (border, `--omp-border`, plain text).
- Motion: spinner and shimmer stop under `prefers-reduced-motion: reduce`; the existing turn-progress bar rule already does.

## Alternatives

- **Ship the proposal's override layers as a separate stylesheet.** Rejected: it would leave the old rules in place and every later change would have to know both. The rules are rewritten in place.
- **Hide the success check with CSS.** Rejected: `display: none` leaves the markup behind for nothing; omitting it for a clean call is as small a change. (The settled-versus-running alignment shift is the same either way.)
- **Hide the Edit body title with CSS for every edit.** Rejected: a multi-file edit needs its per-file titles; single-file titles are omitted in the renderer.
- **A "raised" token for the user bubble and code blocks.** Not needed by the accepted variants (see Tokens).
- **Recents through a page request that names a session id/path.** Rejected: it would let a page name a session to open. The ordinal-against-last-answer shape keeps the page without authority.
- **Recents pushed with every state snapshot.** Rejected: it would put an index scan on every connection for a block that is visible only in an empty chat.

## Risks and Open Questions

- Third-party themes with unusual foregrounds: a 72 % mix keeps muted text readable but is verified only on the four built-in fixtures.
- `:has()` (tool-only row padding, previously used for the ask composer) needs Chromium 105+, which VS Code's Electron provides.
- `--omp-border` strengthening can make a surface too busy; R11 and R12 flatten the known cases, and the screenshots in Dark Modern, Light Modern and High Contrast are the check.
- OMP's real `todo` call shape is read from the renderer's current assumptions (`ops: [{ op, task, phase, items }]`) and tests; an unknown op falls back to its own word, so a different shape degrades to today's information, not to nothing.
- Recents depend on the Sessions tree having read the rows' titles and activity (its own bounded enrichment). A tree that has not finished yields fewer than three rows, or none, and the page shows hints only; no extra file read is added.

## Rollout and Verification

Committed steps, each with `npm run typecheck` and the focused tests of its area (never the full suite):

1. Tokens and radius scale (R1, R13).
2. Prose, Copy and user prompt (R4, R5, R6).
3. Tool rows including Edit path/stats and silent success (R2).
4. Composer (R3), then, as its own step, the removal of the Tools output chip from the page (the host half is removed by the runtime-port owner afterwards).
5. TODO operation, Task and Agents names, HUD and queue alignment (R8, R12).
6. Working status (R9).
7. Notices (R10).
8. Ask (R11).
9. Empty state and recents, with the host wiring (R7).
10. Architecture and changelog.

Tests: tests that pinned the old visuals are removed or rewritten (the old check mark, the "Aborted" block, the bordered Copy button, incidental wording), not re-pinned. Behaviour tests added: the relative Edit path computation, the TODO operation sentences, the Agents names, the recents selection and the empty state's click action, the hidden success mark with the sr-only status kept, and a four-theme contrast check of muted text. Headless Chromium screenshots (Conversation, Working, Ask, Notices, Agents, Empty; Dark Modern, Light Modern, High Contrast) are compared against the proposal's After pane with the same variants and stored under `.omp/workspace/notes/assets/chat-visual-2026-10-13/implemented/`; differences are listed in the implementation notes.

## Decisions recorded by the maintainer

R1 muted 72 %, border 18 %. R2 pitch 26 px, success mark hidden, regular muted name, neutral path with link on hover, workspace-relative Edit path, coloured +N/−N, duplicate title hidden. R3 quiet chips, Send pill with label, neutral disabled Send, one ring on the card. R4 inline code .92em, horizontal-rule tables, 8 px paragraphs. R5 icon-only Copy. R6 tinted bubble. R7 hints plus recents. R8 TODO operation plus task, Agents names. R9 spinner and shimmer. R10 one muted aborted line, sans muted Handed off, one-line provider error. R11 toolbar kept, text Cancel/Stop, flat options. R12 and R13 as proposed. R14 out of scope.

## Implementation

Commits: 62e9cbe (R1, R13), 09562c3 (R4, R5, R6), 48a465d (R2 and the TODO operation part of R8), 8c98f62 (Tools chip removed from the page), 24e6f7d (R3), d80fbe6 (R8 Agents names), eff5d9c (R7 host half: protocol messages, `src/views/recent-sessions.ts`, `src/wiring/recent-sessions.ts`, dispatcher cases and the one `extension.ts` hunk), then the page commit (R7 empty state, R8 Task digest, R9-R12) and the docs commit. Host files owned by the runtime-port work were edited only in small hunks, with that owner's agreement and while it was not editing them.

Differences from the proposal's After pane, with the variants above: see `.omp/workspace/notes/assets/chat-visual-2026-10-13/implemented/README.md` next to the screenshots.

## Related Decisions

It narrows no ADR. It follows [Paseo-style chat with OMP-native semantics](2026-10-04-paseo-style-chat.md) and adds the recents exchange next to the existing page requests. It amends one statement of [Tool-style TODO and Agents rows](2026-10-06-todo-agents-rows.md): the collapsed Agents row names the running agents (`2 running: A, B`) instead of "who is doing what"; the fixed row heights, one-line clipping and the detail-tab contract of that design are unchanged, and the fragments move to the row's tooltip.

## Architecture Review

- Reviewer: architect (an independent agent that did not write this design), one round on 2026-10-13.
- Outcome: accept after fixing the material findings; all five were resolved in this text and the status was then set to accepted. A second review round was not needed because no choice changed, only where facts are computed and which existing source recents read.
- Notes: (1) the collapsed face of a tool row comes from `toolPresentation()`, not the renderer, so the TODO sentence, `done/total` and the Edit `+N −N` are computed in the chat layer; Current State corrected. (2) The success mark is omitted only for a call that is complete and not failed (a settled call can still have failed). (3) Muted text that read `descriptionForeground` directly moves to `--omp-muted`, or Light Modern would stay undimmed. (4) Muted text on the row hover colour is 4.3:1 in Light Modern, so such rows switch to the foreground on hover and the contrast test covers every surface muted text sits on. (5) Recents are selected from the Sessions tree's own projection (titles and conversation activity it already keeps), opened through its `SessionTreeItem` and `sessionActions.click`; no new session-file reader. Minor: the host's last-answer table is per document and lives in the recents module, strict parsing in both directions, no protocol version bump, ask again when the route moves from bridge to panel, stale clicks are reported, `omp:open-detail` is fire-and-forget, and `@` completes files only.
