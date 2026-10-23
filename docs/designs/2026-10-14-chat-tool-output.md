---
status: implemented
date: 2026-10-14
---

# Chat tool output: bounded preview, result gist, structured JSON and a windowed full view

## Problem

A tool call, once opened in Chat, is one wrapped monospace blob. The user's example is `Bash` with newline-delimited JSON output: no structure, no preview-versus-full choice, no exit code, line count or duration in the body, JSON uncoloured. Four findings from the research ([README](../../.omp/workspace/notes/assets/tool-output-2026-10-14/README.md), `research/desk-today.md`, 561,137 real results) shape the design:

- A card has exactly two states, a closed head and a fully open body. `ToolSemanticView.preview` is set by 18 renderers and read by none, and every `expanded=false` branch of the primitives (`PreviewWindow`, `lines=`, `fileLimit`, `LimitedList`) is dead. Output that is not text, code or a diff is rendered whole (grep, glob, LSP) or cut with no way to see the rest (MCP output at 12 lines, a job result at 4, LSP references at 3 per file).
- The facts a collapsed row cannot answer ("did it work, how long, how big") appear only after the first expand, and the renderer's chips, title and target change when the card opens.
- OMP appends its notices to the result text (`Wall time: 4.67 seconds`, `Command exited with code 2`, `[Showing lines 1-387 and 3761-4147 of 4147 … Read artifact://69 for full output]`, `[raw output: artifact://N]`, `Backgrounded as job …`). They make a pretty JSON result invalid JSON and are stripped today only for bash and only to hide them.
- OMP strips ANSI before a result is stored (0 ESC bytes in 561,137 real results), so colour must come from structure (JSON tokens, diff signs, error lines, links), not from escapes. JSON is the one format ADR-0067's caps (10,000 characters, 400 lines) leave uncoloured at exactly the sizes that hurt.

The maintainer reviewed an interactive proposal with five variants against today's look and **accepted variant E** with the recommended answers to its open questions (see [Decisions](#decisions)).

## Goals and Non-goals

- **Goals**
  - An opened call rests in a **12-row preview** (tail for bash and eval, head for everything else, exact "N earlier lines" and "N more lines" markers); **Show all** opens a **windowed full view** in the normal flow of the transcript, with a filter, a wrap switch and a sticky **Collapse**.
  - A **result gist** in the head, identical closed and open: `exit 2 · 11 lines · 205 ms`, `+14 −3`, `12 matches · 3 files`, `failed`, `≈ 4.2 s`; a live elapsed counter and line count while a call streams. Digest members carry it too.
  - **Notices as one footer line** (truncation with the artifact id, a timeout, a background job); exit code and duration leave the body text.
  - **Formats**: JSON as a folding tree, **newline-delimited JSON as one foldable row per record** (the user's example), tables (`ls -l`, `Format-Table`), stack traces with dimmed frames and path links, and a light tint for error, warning and pass lines. Every detector falls back to Text and has a **Formatted | Text** switch where it can be wrong.
  - **Copy** output and command; Raw result and details, Copy details and **Open full output** behind `⋯`; an artifact route that opens `artifact://N` read-only in an editor tab.
  - Keyboard access, the three themes at 360 px, `Ctrl+O` / `Ctrl+Shift+O` ([tool display mode](../architecture.md)), ADR-0067 highlighting and the existing copy and link behaviours stay.
- **Non-goals**
  - Any change to OMP, to what a tool result carries, or to the wire size bounds of tool frames (`protocol/chat-messages.ts`: `args`, `result` and `partialResult` are not size-bounded by Desk today, and still are not).
  - A nested scroll box (variant C), a Summary/Preview/Full density control (D) and the TUI's literal 3/6/10-row limits (A).
  - New settings. **Detailed** keeps its present meaning: no digest groups, every call a flat row.
  - Re-rendering the rich layouts of `task`, `wait`, `todo`, `ask` and `web_search` in a new shape; they keep their renderers and gain only the head gist, the footer, Copy and a clamp (see [per-tool table](#per-tool-behaviour)).
  - `[shaken ~N tokens — recover: artifact://N]` pruned-result placeholders (`prunedAt`): the notice parser leaves them as text. Recorded here for a later change.

## Decisions

The maintainer accepted the README's recommended answers to its §8 questions. **Where `proposal.html` and the README disagree, the README wins** and the case is listed.

| # | Question | Decision |
|---|---|---|
| 1 | Resting state | An opened call shows a **12-row preview** (per-tool limits of [the table](#per-tool-behaviour) where E gives one, input blocks 6 to 12 rows). **Show all** resets when the card collapses (a re-open starts at the preview). |
| 2 | Result gist in the head | **Yes**, as E shows it, including **silent success**: no gist part for an exit code of 0, for an empty result, or for a duration under 1.5 s that is only derived. |
| 3 | Durations | `≈` only where E shows it: a duration derived from timestamps (result minus the assistant **entry**) and only above 1.5 s. Exact times (bash `details.wallTimeMs`, eval `cell.durationMs`, wait `jobs[].durationMs`, a live call's `ActiveTool.startedAt`, and the duration the page observed live) carry no `≈`. |
| 4 | Nested scroll | **One outer scroller**: the transcript. The full view windows its rows inside the normal flow; no bounded scroll box anywhere. |
| 5 | Colouring plain output | **E's light tint** for error, warning and pass lines and **path links**; no other colour in plain text. |
| 6 | Raw view | **Yes**, behind `⋯`: View raw result and details, Copy details as JSON. |
| 7 | Artifacts | **Yes**: one host route opens `artifact://N` read-only in an editor tab. |
| 8 | Detailed | **Keeps its current meaning** (no digest). |
| 9 | ANSI | Stripped defensively in tool cards; ANSI rendering stays only where user `!` executions use it. |
| 10 | Streaming | A **live elapsed counter** and line count in the head while a call runs. |
| 11 | ADR-0067 | **Amended**: JSON and NDJSON use a linear tokenizer exempt from the 10,000-character / 400-line caps (bounded by a size cap instead, see [JSON](#json-and-ndjson)). |
| 12 | Read content | **Stays shown**, now as the 12-row preview. |
| 13 | Scope | E's per-tool table (§6 of the README). |

**Proposal and README disagree:**

1. **Collapse.** `proposal.html`'s sticky Collapse in the full view returns to the preview; the README's table says `Show all → Full; Collapse → closed (Preview is the resting open state)`. The README wins: **Collapse closes the card** (and resets Show all), returns focus to its head and scrolls the head into view. A reader who wants the preview again opens the card.
2. **Edit gist.** The proposal puts `+A −R` in the gist; Desk's head already shows coloured `+N −N` (`DiffStatSpans`), so the gist adds nothing for edit.
3. **Head chips.** The proposal has no renderer chips (`12 matches`, scope, `case:insensitive`) in the head. Desk's renderers produce them only after expanding. They move to the output bar of the open body so no information is lost; the head carries the gist only.
4. **Arguments fold depth.** The README's table opens MCP and unknown arguments to depth 1; this design opens them to depth 2 (the same default as a result). An open body used to show six levels, so depth 1 would hide, behind one fold, keys the reader used to see at once; depth 2 keeps the first two levels open and puts only the deeper ones one fold away. Maintainer's call; recorded here.

## Current State

- `ToolCard.tsx` mounts the body when `expanded || autoExpanded || retained || liveDetail` and calls `describeTool({ expanded: showBody })` only then; `describeTool` is **also called closed** for wait, debug and ask, whose head the renderer builds. Every `c.expanded` in a mounted body is therefore `true` today; the collapsed head is built from the chat layer's `toolPresentation` (title, target, `failed`, `stats`, `counter`), and the renderer's title, target and `meta` chips replace it once open.
- Primitives in `tool-renderer-primitives.tsx`: `TextPreview` (ANSI-parsed, `AnsiLines`), `CodePreview`, `DiffPreview`, `MatchOutput`, `LimitedList`, `JsonOutput` (depth 6, 200 lines, 2,000-character scalars, uncoloured), `Section`, and `OutputLines`, the only pagination (200 head plus 20 tail lines, `Show N more` / `Show all`).
- `OutputMetadata` turns `details.meta.truncation` / `limits` / `artifactId` into one warning paragraph; `bashOutput` strips four bash notices from the text.
- ADR-0067 and `use-highlighted-runs.ts`: one tokenizer, 10,000 characters and 400 lines per tokenize, 64-entry cache, newest-first queue, 400 ms settle while text grows; a long text is coloured only in the window that is visible.
- Disclosure state lives in `Transcript`'s `disclosures` map (`call:<conversation>:<callId>`, `run:<id>`); `Ctrl+O` and `Ctrl+Shift+O` set a default mode and forget the per-block states (`withToolDefault`, `clearToolDisclosures`). The transcript is virtualised (measured rows; unmounted rows keep an estimate of 26 px closed, 260 px open) with one outer scroller, `.omp-transcript`.
- Page to host exchanges that open things (`omp:open-detail`, `omp:terminal-link-open`, `omp:chat-subagent-read`) are validated message types parsed in `protocol/messages.ts` and handled in **three** places: the guest dispatcher, `handlePassiveSlotMessage` in `extension.ts`, and the detail-tab allow-list; a page on a surviving bridge route has a fixed allow-list and cannot send them (`useDetailOpener().available`).

## Proposed Design

### Three states and one place for the state

A call is **closed** (the head only), **open** (preview) or **full**. The card owns `full`; the transcript keeps it, with the other per-card view state, in a small store keyed `call:<conversation>:<callId>` (`lib/tool-view-state.ts`, bounded, forgotten when the card closes or when `Ctrl+O` / `Ctrl+Shift+O` change the default), so a card that virtualisation unmounts and remounts keeps its fold, format and filter state while it stays open. `autoExpanded` (a live edit) is unchanged.

**Freeze versus Show all (M1).** `retained` (focus or selection inside the body freezes the card open) was a latch; pressing **Show all** moves focus into the body, which would freeze a card whose full view the user then cannot leave with `Esc`. The rule: a card is frozen only while `retained && retainedState === viewState`, where `retainedState` is the view-state object the freeze was taken against (identity, not equality); any change of view state (Show all, a fold, a filter) lifts the freeze, and **Collapse** moves focus to the head, clears the selection and calls `setRetained(false)` **before** it closes, so the card cannot be held open by its own button. Tests press with real CDP mouse events, because a synthetic `click()` does not move focus.

`describeTool` receives `expanded = full`. The renderer's `expanded` therefore **means "show everything"** (see [the migration](#renderer-migration-expanded-now-means-full)).

### The head: one face, closed or open

The head is built from the chat layer (`toolPresentation` plus a new `toolGist`), so it does not change when the card opens, except for **wait, debug and ask**, whose faces the renderer still builds in both states (`describeTool` is called closed for those three today, and keeps being). Two facts that lived only in renderers move to the chat layer: bash's `cd <cwd> && ENV=… command` target and `Bash · <name>` title, and edit's `Create` / `Delete` title by `op` with `a → b` rename.

`src/chat/tool-gist.ts` (pure, no DOM, in the shared chat layer) maps `{ name, args, details, text, isError, status, live?, endedAt?, startedAt? }` to ordered parts `{ text, tone, optional }` with tones `plain`, `err`, `warn`. `optional` parts drop below 460 px of head width. Rules (from `proposal.html`'s `describe`, with the edit change above):

| Tool | Parts |
| --- | --- |
| bash | `exit N` (err, only ≠ 0), `timed out` (warn), `background`, `N lines` (optional, only when the output is non-empty), duration (`details.wallTimeMs`, else the `Wall time:` notice) |
| read | `N lines` (total from `details`, else shown), `truncated` (warn); URL: lines; directory: entries; image: size |
| write | `N lines` (optional) |
| grep / ast_grep | `N matches`, `N files` (optional), `truncated` (warn) |
| glob | `N files`, `limit reached` (warn) |
| find | `N hits`, cost (optional) |
| eval | language (optional), `exit N`, `cell.durationMs`, `N cells` |
| task | `N agents`, `background` |
| wait | `N jobs settled` or `interrupted`; the longest duration among the settled jobs (the jobs wait together) |
| web_search | provider (optional), `N sources` |
| ask | `N questions` |
| MCP / unknown | `failed`, else `JSON` or `N lines` (optional) |
| lsp, debug | `failed` |
| any | `failed` first when the call failed and no part is already an error; a **duration**: exact when known, else derived and shown only above 1.5 s as `≈ 4.2 s` |

**Durations.** The derived duration is the result's timestamp minus the **assistant entry's** timestamp (`ProjectedTool.startedAt`, from `Date.parse(entry.timestamp)`), not the message's own, which can precede the entry by the model's whole generation. Where a call was watched live the page records its **observed** duration (`lib/tool-view-state.ts`, `recordObservedToolMs`, written when a live call leaves `activeTools`); an observed duration is exact (no `≈`) and is recorded only for a call whose `tool_execution_start` the model saw (`ActiveTool.startObserved`); a record that began at an update has no true start. A reattached page restarts a live call's clock from the moment of reattach; accepted, and that call's settled gist then carries the derived `≈` figure.

A running call shows a spinner, the **live elapsed** time (`ActiveTool.startedAt`, ticked by the page's shared second tick) and, when the stream carries output, its line count; the gist appears when it settles. `N lines` in the gist is the number of lines **shown** of the cleaned text (a read's total comes from its `details`). **Head failure** is the chat layer's `failed` plus a renderer's `tone: error` (a `warning` tone, such as zero matches, is not a failure and stays out of the head), kept because some tools (task, debug, eval) know their failure only from `details`; the task and debug counters (`2 failed`, `stopped`) stay renderer chips in the output bar, not in the chat layer. Edit and todo keep their own `+N −N` and `done/total` head items.

### Body anatomy

```
head
body
  input        only when the head cannot carry it: a multi-line or >100-character command, eval code, write content,
               MCP/unknown arguments (JSON tree, default depth 2), task context, edit script (under ⋯)
  output bar   label · format badge · exit chip · renderer chips · [Formatted|Text] · fold all · filter + wrap (full) · Copy · ⋯
  output       the renderer's blocks, preview or full
  footer       one quiet line of notices
  Collapse     in the full view, in a sticky toolbar
```

The output bar belongs to `ToolCard`; a renderer describes it through new optional fields of `ToolSemanticView` (`input`, `output: { label, copy, format }`). A renderer that returns none gets the default bar (label `Output`, Copy of the cleaned result text).

### Preview, full and markers

A block of rows (`<OutputRows>`; `TextPreview`, `CodePreview`, `DiffPreview`, `MatchOutput`, `LimitedList` and the JSON tree are built on it) renders:

- **Preview**: at most 12 rows, bash and eval from the **tail** with the marker on top (`… (771 earlier lines, showing 12 of 783)`, plus `· live` while streaming), everything else from the **head** with the marker below (`… 5 more lines`, for a diff `… (2 more hunks, 31 more lines)`, for NDJSON `… 5 more records`). **A hidden remainder of 3 rows or fewer is shown instead of a marker.** The marker carries the **Show all N lines** button. A preview row does not wrap: code scrolls sideways (`white-space: pre`, amended 2026-10-14; wrapping was asked for inline code in paragraphs, not for blocks), and a row of more than 400 characters is cut with a note, so the height of a preview is bounded.
- **Full**: windowed (below). Wrap is off whatever the size of the output, and the toolbar's Wrap switch is the reader's explicit choice per card (amended 2026-10-14; it was on up to 120 rows); wrap on renders at most 1,500 rows and says so.

Preview DOM is bounded by 12 rows plus markers, so a 786-line result costs what a 12-line one does. Streaming text is shown as the tail window of plain rows with no detectors until it settles (400 ms, as ADR-0067); detection, the gist and the footer arrive then.

### The windowed full view

A fixed-row-height list in normal flow: one spacer of `n × rowHeight`, only the rows in the transcript scroller's visible range plus 20 above and below in the DOM. The row height is the computed line height read once per block. There is no inner vertical scroller (`overflow-y: hidden` is explicit, because `overflow-x: auto` computes the other axis to `auto`); wide lines scroll horizontally inside the block only, over a content width set in `ch` from the longest row so every window is as wide as the whole. This **supersedes Paseo rule 6 ("no inner window") for the Full view only**: the transcript still has one scroller. The rest of the contract:

- **Scroll owner.** `useWindowedRows` picks the nearest ancestor whose `overflow-y` is `auto` or `scroll` (the transcript), not a fixed class; `.omp-tool` uses `overflow: clip` (not `hidden`) so the sticky toolbar still sticks.
- **Transcript layout.** A call's row revision and its height estimate include `full` (260 px open, an estimate for a windowed full block of `min(n, 60) × rowHeight`); `MeasuredRows` already resets heights on width, font and theme change.
- **Wrap.** Off by default at any size (amended 2026-10-14: code scrolls sideways, and wrapping is only the reader's explicit choice per card); with wrap on at most 1,500 wrapped rows with a notice.
- **Highlighting.** Code rows are coloured in aligned chunks (`codeWindow` tokenizes whole chunks of 100 lines, so a row's colours do not change as the window moves) and `useHighlightedRuns` keeps the previous colours until the new ones are ready (no flicker); JSON rows use the lexer.
- **Selection and find.** A selection keeps the rows holding its two endpoints mounted; rows between them are plain text, so a native copy across a long selection yields the whole selection. **Screen-reader mode** (`editor.accessibilitySupport`, a settings message the page already receives for the composer) renders the full DOM of a result up to 5,000 rows, since a windowed list is unreadable to a reader, and says so in the toolbar.
- **Keyboard.** The filter field, wrap switch and Collapse are ordinary controls; `Esc` clears a filter before it collapses (see [the digest](#the-digest)).

Filter ("Filter lines") and Copy work on the whole text, not on the DOM, so a filter narrows the row array and the window follows. The sticky toolbar (Collapse, filter, wrap, Copy, `⋯`) sticks to the top of the scroller.

**As built (slice 3).** Rows of one height (plain and code text, diffs, JSON and NDJSON rows: `OutputRows` with `fixed`) are windowed; list items, grouped search output and prose keep the 200-head-plus-20-tail paging of slice 1, because their rows have no common height. `useWindowedRows` (`lib/use-windowed-rows.ts`) keeps 20 rows beyond the visible range, moves in steps of 10 rows, and holds the rows a selection reached (the range only grows while a selection stands inside the block). The row height is `round(1.5 × the block's font size)`, set as `--omp-row-h` on the block, so rows and spacer agree. A row is its own element, keyed by its index, so a row that stays mounted keeps its selection endpoints. Filter and wrap state, the line count of the output (`rows`, from which the transcript estimates the height of a full card it has not measured: `90 + rows × 18` px) and the folds live in the per-call view store and are forgotten when the card closes. The toolbar reaches back over the transcript's top padding (`--omp-transcript-pad-top`), because a sticky element sticks inside the padding of its scroller. A filter on a JSON document lists the matching rows with the rows that open the containers around them; on NDJSON it lists the matching records; both stop folding while the filter stands. The browser's own find sees only the rows in the page; the filter is the way to search the rest.

**Amendment 2026-10-17 (Find in Chat).** The sentence above is superseded for search: `Ctrl+F` opens a page-owned find bar that searches every loaded call's output text, opens the group and the card that hold a match and highlights it. A long output still paints only the rows its card shows (the match's row is marked), so the filter stays the way to narrow a long output. See `2026-10-17-chat-find.md`.

**As built (slice 4).** `lib/output-rows.ts` holds the three detectors; `lib/output-format.ts` runs the JSON detectors first, then the rows one, on settled text of at most 1 MiB, cached by text. Tables: runs of two or more `ls -l` lines (seven columns), or a `Format-Table` title line over a rule of dashes (the rule gives the column starts; the rows run to the first blank line); at most 5,000 rows; a numeric column is right-aligned; every line of the output stays a row, so the preview, the full view, the filter and Copy work as on any text. A table is a CSS grid of `ch` widths on the row, so the characters are the characters of the text. Stack traces need two frames (JS `at f (path:l:c)`, Python `File "p", line n`, .NET `in p:line n`); a frame is dim, its location is wrapped by `FileLinkText` as an explicit link (`path:line:column`, proof `path`), so the host decides whether it is a file, and `node:` frames are never links. Tint: error, warning and pass lines by their words and marks, in `errorForeground`, `editorWarning-foreground` and `testing-iconPassed`, on plain text only (no expression has a nested quantifier; lines over 400 characters are not tinted). The badge names what was detected (`Table · 12 rows`, `Stack trace · 7 frames`) and the Formatted | Text switch gives the text as it came.

### JSON and NDJSON

Detection runs once per settled result, on the text with notices removed and a fence stripped:

- **JSON**: the text with notices removed and a fence stripped is one object or array, and is at most **1 MiB**. `JSON.parse` is used only as a validator under that bound (`JSON.parse`, the line split and the bracket index together were measured at 21 to 50 ms at 4 MiB and 5 to 13 ms at 1 MiB (Node 24, warm, three synthetic shapes): 4 MiB already reaches the 50 ms an ADR-0067-style task may take on a fast machine, before any row is built, and 1 MiB leaves about four times that headroom for a slower machine, a cold page and row building; so the bound is 1 MiB and the same bound applies to NDJSON detection; the bracket index and the re-indent of a compact document are one pass at detection, only colouring is per row). **The formatted view is never `JSON.stringify` of the parsed value**, which silently loses big integers, turns `1e400` into `null` and `-0` into `0`: it is built from the **original text** by the lexer. A single-line (compact) document is re-indented by tokens only (two spaces, one token run per row, spelling of every number and string untouched); an already indented document keeps its own rows. Containers carry matching-bracket indexes: each container row folds into `{ … 5 keys }` / `[ … 12 items ]`, default fold depth 2 (a record opened from newline-delimited JSON: 1; arguments keep depth 2, so the keys of a nested object an open body used to show still show); Expand all and Collapse all in the bar; folds are state in the view store. The preview shows the first 12 rows of the folded tree. **Column-cut output**: when OMP cut long lines (`Some lines truncated to N chars`, lines ending in `…`), a row that ends in an ellipsis closes its string for display, the document is **not valid JSON**, so it is shown Formatted by the lexer's tolerant mode with a `lines cut` badge and never offered as parsed data. (Of the three fixtures over 400 lines, the one that is JSON, `bash-json-long-columntruncated`, is of this kind.)
- **NDJSON**: at least two non-blank lines, at most 1 MiB, and at least 80 % of them are an object or array (each line validated with `JSON.parse` under the bound). One row per record (the compact text, cut at 400 characters for display), a fold button that opens the record as a JSON tree (depth 1); a line that is not JSON stays a raw row; Show all and Copy give every record. Rows carry the record number as gutter. The user's example (25 lines, 3,049 characters, a Bash result) is this case.
- A **Formatted | Text** switch and a badge (`JSON · 531 lines`, `NDJSON · 25 records`, `JSON · lines cut`) appear for either; Text is the cleaned original text. **The rule for a column-cut document**: valid JSON is JSON; otherwise the result is shown as `JSON · lines cut` only when it starts with `{` or `[`, has a line that ends in `…`, and every bracket of its rows balances at the end; anything else, including output with missing middle lines (`Showing lines a-b and c-d`), is Text. An undetected, oversized or unparsable result is Text with no badge. **Filter on a folded tree** matches the rows of the whole tree, not only the visible ones, and the matching rows' ancestors open for the duration of the filter.

Colours come from `lib/json-tokens.ts`, **a linear lexer over the original text** (a single pass with an index, string literals scanned to their closing quote, no regular expression with a nested quantifier) that classifies keys, strings, numbers, `true` / `false` / `null` and punctuation per row, and styles them with the active theme's own JSON scopes through the existing styler (`support.type.property-name.json`, `string.quoted.double.json`, `constant.numeric.json`, `constant.language.json`), so Formatted JSON follows the theme like fenced JSON does. It is **not** subject to ADR-0067's 10,000-character and 400-line caps; its cost is linear, and each row is tokenized once when it first enters the window. The bound on work is the 1 MiB detection cap (above), and a row longer than 400 characters is cut for display with its remainder one fold or Copy away. Beyond the cap the result is plain Text (**ADR-0067 amendment**, decision 11).

### Other formats (all with a Text fallback)

- **Tables**: `ls -l` listings (mode, size, modified, name) and PowerShell `Format-Table` (a header over a dashed rule) become column-aligned rows (`display: grid` per row, widths in `ch`, numeric columns right-aligned), still windowable; fewer than 2 rows or more than 5,000 stay text.
- **Stack traces**: a result with at least 2 recognised frames (`at … (path:line:col)`, `File "…", line N`, `… in path:line N`) dims the frames; paths link through `FileLinkText` (host-validated, ADR conventions of the Chat file links), dimmer inside frames.
- **Line tint**: error lines (`✖ ✘ ×`, `not ok`, `FAIL`, `error:`, `…Error:`, `Traceback`, `npm ERR`, `fatal:`, `: error TS1234`), warnings (`⚠`, `warning`, `WARN`) and passes (`✔ ✓ ok PASS`) are tinted with the theme's `errorForeground`, `editorWarning-foreground` and `testing-iconPassed`. Colour is never the only carrier: error and warning rows keep their own words; High Contrast keeps the theme's own colours.
- **Diff, code, search**: edit diffs keep their sign and line gutters and highlighting; `read`, `write` and `find` content is highlighted by path (ADR-0067); grep rows are grouped per file with the match rows tinted and the line numbers linked; glob rows are directory-muted paths.

### Notices as one footer line

`src/chat/tool-notices.ts` (pure) reads the notices OMP appends to the result text and the ones in `details` (truncation, limits, `artifactId`, `artifactError`, `async`) and returns the cleaned text and a notice list: `wall`, `exit`, `timeout`, `truncated` (with the shown ranges and the artifact id), `columns` (`Some lines truncated to N chars`), `raw` (artifact), `background` (job id). Exit and wall feed the gist and the exit chip; the rest become one footer line, for example `⚠ Output truncated · Showing lines 1-387 and 3761-4147 of 4147 · full output artifact://69 · running in background as bg_59`. Notices from text and from `details` that name the same artifact or truncation are merged, not repeated. The cleaned text is what detectors, Copy and the preview see; Raw shows the original.

### Copy, `⋯` and Raw

- **Copy** (icon button, `aria-label` "Copy output", a `role="status"` announcement "Copied output (783 lines, 21 KB)", exactly the text, never rendered HTML): the cleaned output in the active format; the command, the content of an input block and every block in Raw have their own.
- **`⋯`** (a menu button with `aria-haspopup="menu"`, a `role="menu"` list, arrow keys, Esc closes and returns focus to the button, a click outside closes): Copy command, Copy output, Copy details as JSON, View raw result and details, Open full output (artifact). Items that do not apply are absent or disabled with a reason.
- **Raw** is two blocks under the body: the result text exactly as the model sees it, and `details` as a JSON tree with long strings (over 300 characters) and long arrays (over 12 items) cut and marked. Copy details as JSON copies the whole object with strings over 20,000 characters cut and marked, never an image payload. `details` may be large and may contain paths; it is shown only on request.

### The artifact route

`omp:open-artifact { artifactId, epoch }` is a new fire-and-forget page→host message, validated in `protocol/messages.ts` (`artifactId` is 1 to 9 ASCII digits; `epoch` is the conversation epoch the page was rendered for, as `omp:chat-subagent-read` carries it, and the host drops a message whose epoch is not the current one). It has **three entry points**, all of which must handle it: the guest dispatcher (`guest-dispatcher.ts`), the passive-slot handler in `extension.ts` (`handlePassiveSlotMessage`) and the read-only detail-tab allow-list (`detail-tabs.ts`); a surviving bridge page cannot send it (`useDetailOpener().available`), so its menu item is disabled with the reason. The host derives the artifacts directory the way OMP does (`<session>.jsonl` minus `.jsonl`); for a sub-agent transcript it is the directory the transcript file sits in, which is the parent's. It lists that directory (no recursion), takes the regular file named `<id>.<type>.<ext>` (never a symlink or a directory reparse point, checked with `lstat` and a containment test) and opens a URI of the `omp-artifact:` scheme in a read-only editor; the URI always carries the conversation's root session file (a sub-agent's card resolves against the parent's file, whose directory it shares). The URI carries the transcript path, encoded (`omp-artifact:/<id>/<title>?session=<encoded path of the .jsonl>`; the title segment, `Full output · <tool> · artifact <id>`, names the editor tab). The route builds it; a `TextDocumentContentProvider` serves it. A tab restored by Reload Window reaches the provider directly and never the route, so **the route and the provider share one lookup, `src/host/artifact-lookup.ts`, and the provider runs all of it on every read**: the session path ends in `.jsonl`, is a regular file and starts with an OMP session header line; the artifacts directory comes from the same session file layout as above (`sessionFileLayout` in `session-lifecycle.ts`); the directory is listed without recursion for the name `^\d{1,9}\.[A-Za-z0-9_-]+\.[A-Za-z0-9]+$`; the entry is a regular file by `lstat` (never a symlink) and its real path is inside the real path of the directory; at most 16 MiB are read, with an explicit "too large" document beyond it, decoded as UTF-8 with replacement. `omp-artifact:` is a read-only scheme by construction. The provider is registered **synchronously at the start of `activate`** and `package.json` gains `onFileSystem:omp-artifact`, so a restored editor tab of that scheme resolves after a reload. The same lookup serves the footer's `artifact://N` link.

**As built (slice 5).** `host/artifact-lookup.ts` (pure Node, no `vscode`) holds the URI parts, `findArtifact` (absolute `.jsonl` path with an OMP session header, a non-recursive listing, the one name shape, `lstat` regular file, `realpath` containment), `readArtifact` (16 MiB cap; a larger file is named in the document, not read) and `artifactDocumentText`, which never throws and never answers an empty text. `wiring/artifact-documents.ts` registers the read-only `omp-artifact:` content provider as the first thing `activate` does (`onFileSystem:omp-artifact` in `activationEvents`) and opens a document with `preview: true`. The provider runs the same lookup on every read, so a tab restored by Reload Window is served exactly like one just opened. `omp:open-artifact` is parsed in `protocol/messages.ts` and handled by one function, `GuestDispatcher.openArtifact(tabId, request)`, which checks `sameEpoch` against `conversations().stateOf(tabId)`, takes the session file from the index (`sessionFileOf`) and warns with the reason on a refusal; the guest dispatcher, `handlePassiveSlotMessage` and `DetailTabsHost.openArtifact` all call it. On the page `lib/artifact-opener.ts` supplies the epoch (`ArtifactEpochContext`, set by the session view and the detail view) and the reason a surviving bridge page cannot ask; `components/ToolMenu.tsx` is the menu (menu button, `role="menu"`, roving focus, the shared `useDismissibleLayer` for `Esc` and outside press, reported to the host as a popup so `Esc` does not also stop the turn). The menu is in the output bar and, in the full view, in the sticky toolbar next to Copy. Raw is state of the card (`ToolViewState.raw`, forgotten when the card closes): the result text exactly as received and `details` through `lib/raw-details.ts` (view: strings over 300 and arrays over 12 cut; copy: strings over 20,000 cut; an image payload is never carried).

### The digest

Unchanged grouping, summary text and independent member disclosure. Added: an `Expand all N` / `Collapse all` pair at the top of the open group (sets each member's disclosure to open at the preview, or to closed; it does not change the global tool mode), member rows carry the gist (they are the same `ToolCard`), and ↑ / ↓ / Home / End move focus between the heads and group rows that are mounted; the keys act only when focus is on a head or group row, never inside a body, a filter field or a menu. **`Esc` order**: an open `⋯` menu or a non-empty filter closes or clears first (they use the shared `useDismissibleLayer`), only then does `Esc` collapse the card as today. `Ctrl+O` and `Ctrl+Shift+O` keep their three-mode meaning; the **Expand all** mode now opens each call at its preview (every card used to open to everything), and `Ctrl+O` forgets per-card view state as it forgot disclosures.

**As built (slice 6).** `ToolOverview` shows the pair for an open group whose members include calls: `Expand all N` and `Collapse all` as two buttons, each `aria-disabled` when it would change nothing (so focus is never lost to a button that disables itself). They call the existing member disclosure (`call:<conversation>:<call id>`) of every call of the run, which the tool display mode (`Ctrl+O`, `Ctrl+Shift+O`) leaves alone. `lib/tool-navigation.ts` holds the head selector (`button.omp-tool-head, button.omp-overview-head`), `isHeadNavigation` and `nextHead`; the transcript's `onKeyDown` moves focus among the heads of its own transcript that are mounted and not inside a body, and `lib/transcript-scroll.ts` no longer takes those keys on a head as a request to scroll (it already ignored inputs and menus). Arrows at the first or last head stay there. The `Esc` order needed no new code: the menu (shared dismissible layer) and the filter stop the event first, the card's own handler collapses it, and the transcript's handler then closes the group.

### Accessibility, themes, width

Every disclosure is a real `<button>` with `aria-expanded` and `aria-controls`; the body is a focusable `role="region"`; the filter field and wrap toggle keep focus while the list re-renders; fold buttons announce the container they open. Colours come from theme variables only (the three shipped themes, `High Contrast` keeping its contrast border on blocks and selection outlines). At 360 px the body indent drops from 30 to 16 px, the optional gist parts and fold-all hide, the badge and the Formatted | Text switch stay on one line, wrapped long lines break in the preview and scroll horizontally in the full view.

## Per-tool behaviour

Preview limit is 12 rows unless noted; "tail" shows the last rows. Input blocks use their own cap.

| Tool | Input shown | Preview | Notes |
| --- | --- | --- | --- |
| bash | command only when multi-line or > 100 characters (cap 6) | tail; JSON, NDJSON, table, trace, diff aware | notices in the footer; exit chip |
| read | none | head, numbered, highlighted by path; URL: metadata then content; directory: tree; image: placeholder | `a–b of N` in the gist |
| write | the content, numbered (cap 12) | the result note and diagnostics | |
| edit | none (hashline script under `⋯`) | head of the diff, `⋯` gaps, per-file header rows | |
| grep / ast_grep | none | head, grouped per file, match rows tinted | |
| glob / find | none | head | |
| eval | code (cap 8) | tail of the printed text (OMP 18.12.1 removed `display()`; the tables, trees and figures it now shows for a printed value are not drawn in Chat) | |
| task / wait | shared context, clamped | agent cards or job rows; a long report clamped at about 14 lines with a reveal | rich renderers unchanged |
| web_search / URL | none | answer clamped, sources list | |
| ask / todo | none | in full (short) | unchanged |
| MCP / unknown | arguments as a JSON tree (depth 2) | JSON tree at depth 2, or the head of the text | `server / tool` split in the head |
| lsp / debug | request key/values | text | references and diagnostics get the generic row bound with a reveal |

### Renderer migration: `expanded` now means full

Every `c.expanded` branch in the renderers was dead (always `true` once the body was mounted), so reviving them is a behaviour change for every renderer, audited once. The rule: **everything an open body showed keeps showing in the preview; only rows behind an exact marker are hidden.** A fixture test renders every real call closed (`expanded: false`) and full and asserts that the preview has every section title of the full view, except group titles that are themselves rows behind a marker (grep files past the 12th).

| Renderer family | Preview (12 rows, marker for the rest) | Only in Full |
| --- | --- | --- |
| bash, eval, github failed logs | tail of the text; eval code 8 rows, bash command 6 | everything |
| read, write, CodePreview | head of the numbered code | everything |
| edit, ast_edit | head of the diff by rows, whole change groups for ast_edit; per-file sections all present | the remaining rows and hunks |
| grep, ast_grep, find, lsp symbols, MatchOutput | head rows of the match groups, the file rows all present until the 12-row bound | the remaining groups and matches |
| glob, LimitedList users (retain, process, irc receipts, github runs, find hits, web sources) | first 12 items | the rest |
| lsp references and diagnostics | 12 files, 3 locations per file | all locations |
| task, wait, todo, web_search answer, vibe, recall, retain, resolution, think, config, help | the content their open body showed, prose clamped at about 14 lines (`wait` job reports, `task` context) with a reveal | the clamped remainder |
| unknown, MCP | arguments as a tree, output as JSON tree or head of the text | everything |

## Alternatives

- **A, TUI-faithful** (10/6/3-row limits, framed cards): cheapest, but plain text stays plain, JSON stays a wall and the limits, tuned for 80 columns, under-use a wide panel. Its limits are not adopted; its markers and tail-first rule are.
- **B, Structured only**: fixes the user's example but leaves the long-output and "no way to see the rest" problems and has no Copy or Raw.
- **C, Input | Output | Raw tabs** with a bounded scroll box: shows everything at once, but its nested scroller contradicts the accepted one-outer-scroller rule of the [Paseo design](2026-10-04-paseo-style-chat.md) and costs chrome on the common three-line result. Its Raw is adopted behind `⋯`.
- **D, Summary / Preview / Full ladder**: adds a state machine without improving what each state shows. Its windowed Full, filter and wrap are adopted.
- **A webview detail tab for artifacts** (like the TODO and Agents tabs): needs its own find, selection and virtualisation. A native text document gets them free and is read-only by construction.
- **Per-card windowing with an inner scroll box**: simpler windowing maths, rejected with C.

## Risks and Open Questions

- **Wrong detection.** A heuristic can misread text (a log that happens to be 80 % JSON lines). Mitigation: only the two JSON detectors, tables and traces change the layout; each has a badge and a Text switch; the original text is never lost; detectors run on settled results only.
- **Windowing and virtualisation interplay.** The transcript already measures rows and keeps estimates for unmounted ones; a windowed block has a fixed height, so it should not disturb measurement, but a card remounted at the bottom of a long list must not jump. Tests assert DOM row count, a stable scroll position on opening and a held body while focused.
- **The ≈ duration** is the assistant **entry's** timestamp to the result's, so a call that queued behind others of the same reply reads longer than it ran. It is shown only above 1.5 s and only with `≈`, as accepted. A duration the page observed is exact and has no `≈`, but it is held to the same 1.5 s floor: below it the head stays silent, like a derived one.
- **`details` in Raw** can hold large strings and paths; bounded as above, on request only.
- **Row height** is read from the computed style once per block (the font-size token can raise it); a diff, code and JSON row share one line height.
- **Gist rules drift.** They duplicate knowledge of each tool's `details`; tests pin them against the 37 real calls in `src/webview/fixtures/tool-calls.json`.

## Rollout and Verification

Six slices, one commit each, every one shippable. Tests are `chat-ui` behaviour tests against real calls from `examples.json` (copied sanitised into `src/webview/fixtures/tool-calls.json`: 37 calls), the focused `tool-renderers` tests and `npm run typecheck`.

1. **Preview, gist, footer, Copy, output bar.** Revive the preview branches (`expanded = full`), the 12-row rule with markers, the head gist (chat layer, closed and open), live elapsed, notices as one footer line, ANSI stripped, the output bar (label, exit chip, renderer chips, Copy output) and Copy command. Full is the existing 200 + 20 paging for now.
2. **JSON and NDJSON** (with the ADR-0067 amendment): lexer over the original text, fold tree, NDJSON records, Formatted | Text, args as a tree. Before slice 3 lands, a tree's Show all uses the slice 1 paging (200 head rows plus 20 tail rows, `Show N more`) over the **visible** rows of the tree only, so a 4 MiB document never materialises as DOM; the windowed Full replaces the paging in slice 3.
3. **Windowed full view**: fixed-row windowing in the flow, filter, wrap, sticky Collapse, screen-reader mode.
4. **Other detectors**: tables, stack-trace links, error and pass tint. Implemented.
5. **`⋯`, Raw and the artifact route**: menu, Raw, Copy details, `omp:open-artifact`, `omp-artifact:` provider. Implemented.
6. **Digest**: Expand all / Collapse all, arrow-key navigation, gist on members asserted. Implemented.

Acceptance per the user's brief: preview limits per tool, Show all and Collapse, the gist for exit 0 and ≠ 0, NDJSON rendering of the user's example, JSON over 400 lines coloured, windowing (DOM rows bounded), Copy contents, the Raw menu, artifact open, streaming, the digest; screenshots in Dark Modern, Light Modern and High Contrast at 360 and 720 px.

## Related Decisions

- [ADR-0067](../decisions/0067-highlight-chat-code-with-highlightjs-and-host-resolved-theme-rules.md), amended 2026-10-14 for JSON and NDJSON.
- [Paseo-style chat](2026-10-04-paseo-style-chat.md) (one outer scroller, flat tools), [Chat visual refresh](2026-10-13-chat-visual-refresh.md) (calm rows, silent success), [Chat code highlighting](2026-10-13-chat-code-highlighting.md), [TODO and Agents rows](2026-10-06-todo-agents-rows.md) (read-only detail tabs).
- [ADR-0065](../decisions/0065-enforce-one-import-direction-between-source-layers.md): `tool-gist.ts` and `tool-notices.ts` live in `src/chat`, the page code in `src/webview`, the artifact provider in `src/host`.

## Architecture Review

- Reviewer: architect (independent, read-only)
- Outcome: **accepted** after the second pass (`ToolOutputReview1`, pass 2: four material findings, all wording, resolved; one sentence of measurements corrected to the reviewer's own figures)
- Notes: First pass (`ToolOutputReview1`) returned **changes required** with six material findings and several minor ones; each is resolved in this version: M1 [freeze rule](#three-states-and-one-place-for-the-state), M2 [renderer migration](#renderer-migration-expanded-now-means-full), M3 [windowed full view](#the-windowed-full-view), M4 [JSON from the original text](#json-and-ndjson), M5 [durations](#the-head-one-face-closed-or-open), M6 [artifact route](#the-artifact-route).
