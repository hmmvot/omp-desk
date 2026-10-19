---
status: proposed
date: 2026-10-19
---

# Magic keywords in Chat: OMP's gradient on the standalone words of the composer and of sent messages

Requested by the maintainer (2026-10-19) as part of closing the gaps between OMP Desk's Chat and OMP's terminal UI (TUI). Implemented in the working tree; the independent architecture review this repository requires (`docs/README.md`, Required review) has not happened yet, so the status stays `proposed`.

## Problem

OMP has **magic keywords**: standalone lowercase prose words in a user prompt. When a prompt holds one, OMP appends a hidden notice to the turn (`ultrathink` also asks for the highest thinking level). Its TUI paints the word with a per-character hue gradient, animated while it stands in the editor and static in a sent message.

OMP does the first half for RPC prompts too, so a Chat user who types `orchestrate` gets the behaviour. Desk Chat showed nothing: the user could not tell that a word was acted on, nor that a word they meant as plain text was.

## What OMP does

Read from the installed OMP 18.12.2 sources:

- The table and the settings: `coding-agent` `src/modes/magic-keywords.ts` (`MAGIC_KEYWORDS`) and the `magicKeywords.*` settings of `src/modes/settings.ts`. Four keywords, each with a settings key (its id) and a trigger word; the id and the word differ only for `workflow`, which is triggered by `workflowz`:

  | id | word | hue sweep (degrees) | tools the notice needs |
  |---|---|---|---|
  | `ultrathink` | `ultrathink` | 0 to 330 | none |
  | `orchestrate` | `orchestrate` | 150 to 280 | `task` |
  | `workflow` | `workflowz` | 30 to 150 | `task`, `eval` |
  | `jevify` | `jevify` | 300 to 420 | `eval` |

  `magicKeywords.enabled` is the master switch; each keyword has its own `magicKeywords.<id>`. All five default to on.
- The matcher: `pi-tui` `src/prompt/magic-keywords.ts` (the two boundary patterns, `magicKeywordRanges`, `containsMagicKeyword`) over the text with code and markup masked out by `src/prompt/markdown-prose.ts` (`maskNonProse`). A word is case-sensitive and counts only as standalone prose: not after a letter, digit, `_`, `.`, `/`, `\` or `-` or after `::`; not before a letter, digit, `_`, `/`, `\` or `-`, before `.` and a word character, or before `(`; never inside a Markdown code span (any backtick count), a fenced block (backticks or tildes, up to three spaces of indentation, with the closing-fence rules) or an HTML/XML tag, section or comment.
- The paint: `pi-tui` `src/prompt/gradient-highlight.ts`: 14 stops, stop `k` has hue `round((from + k/14 * (to - from)) mod 360)` and the colour `hsl(hue, 90%, 62%)`; character `i` of an `n`-character word takes stop `floor(((i/n + phase) mod 1) * 14) mod 14`. The editor (`src/prompt/custom-editor.ts`) animates the phase while it has the keyboard focus and a keyword is painted: a frame every 70 ms, one sweep in 1800 ms. A sent message is painted with phase 0.
- The TUI paints a keyword whether or not the tools its notice needs are enabled.

## Goals and Non-goals

Goals:

- The composer and the user's own sent messages paint the same words by the same rule as OMP, with OMP's hues.
- Follow OMP's own settings: a keyword OMP is set not to act on is not painted.
- Read as well as ordinary text on every VS Code theme kind.
- Change nothing about how the composer edits or how a message is rendered.

Non-goals:

- A keyword inside a command, skill or attachment chip of the composer (a chip is not prose).
- Synthetic (agent-attributed) input, skill-invocation cards and collab cards: only the user's own prompt is painted, as in OMP's message bubbles.
- Telling the user whether the notice's required tools are enabled (the TUI does not either).
- Painting where the Custom Highlight API is missing.

## Design as built

### 1. Modules

- `src/shared/magic-keywords.ts` (pure, no DOM): the table, `findMagicKeywords`, `containsMagicKeyword`, `hasMagicKeyword`, `maskNonProse` (adapted from `markdown-prose.ts`, MIT; provenance header and `THIRD_PARTY_NOTICES.txt`), `enabledMagicKeywords(values)` from the five settings, and the gradient arithmetic (`magicStopHue`, `magicStopAt`, `magicPhaseAt`; `MAGIC_GRADIENT_STOPS` = 14, `MAGIC_TUI_SATURATION` = 90, `MAGIC_TUI_LIGHTNESS` = 62, `MAGIC_SHIMMER_FRAME_MS` = 70, `MAGIC_SHIMMER_PERIOD_MS` = 1800).
- `src/shared/magic-colour.ts` (pure): HSL to RGB, WCAG luminance and contrast ratio, `MAGIC_THEME_DESIGN`, `magicStopColour`, `magicGradient` (§7).
- Page: `src/webview/lib/magic-keyword-settings.ts` (the store of enabled ids and the throttled question), `magic-keyword-scan.ts`, `magic-keyword-paint.ts`, `magic-keyword-views.ts` (`ComposerKeywords`, `mountBubbleKeywords`), `use-magic-keywords.ts`; `src/webview/magic-keyword-styles.ts` generates the `::highlight()` rules. Mounted in `components/DraftEditor.tsx` and `components/NativeMessage.tsx` (`UserMessageView`).
- Host: `ChatRuntime` (`src/host/chat-runtime.ts`), the wiring in `src/extension.ts` and `src/host/omp-setting-read.ts`.
- Drift pin: `src/omp/magic-keywords-recorder.ts`, `magic-keywords-corpus.ts`, `fixtures/omp-magic-keywords.json`, `magic-keywords.test.ts`, `magic-keywords.live.test.ts` (§4).

### 2. Protocol and the settings read

Two messages, both in the chat vocabulary (`src/protocol/chat-messages.ts`, mirrored in the guest vocabulary of `src/protocol/messages.ts`):

- page to host `omp:chat-magic-keywords-read`: no fields, no request id, no epoch. Whatever else a page adds is dropped by the parser.
- host to page `omp:chat-magic-keywords { keywords: MagicKeywordId[] }`: the keywords OMP acts on, in table order without duplicates, `[]` for none; not bound to a conversation epoch (the settings belong to the profile and folder, not to one session). It answers only the asking page.

The host serves the question in `ChatRuntime.handleMessage` **before** the checks that refuse a tab with no session or a read-only route, so a detail tab, a view-only history and a tab with no live conversation are answered too. It writes nothing and does not touch the session. The wiring `readMagicKeywords(tabId, cwd)` in `src/extension.ts` (next to `readTodoClearDelay`) runs `readOmpSettings`, one `omp config list --json` for the five keys, in the tab's conversation folder (a tab with no conversation: its indexed folder, else the first workspace folder, else the home folder) and with the tab's profile, and gives the values to `enabledMagicKeywords`: a keyword is on only when the master switch **and** its own switch are `true`; a key OMP does not report (an OMP before the feature) counts as off, so such an OMP answers `[]` and nothing is painted.

Cost control, because that call starts a process:

- **Lazy.** The page asks only when a keyword word stands in the composer or in a sent message, and on the composer's or the window's focus while one does. A page that never shows a keyword never starts the CLI. The host is not asked on every page announce and no config file is watched.
- **Throttled on the page.** `requestMagicKeywordSettings` posts at most once per 30 s (`MAGIC_KEYWORD_REFRESH_MS`); a post that provably went nowhere does not count as asked.
- **Shared and reused on the host.** Concurrent askers of a tab (with the same folder) share one read; a successful answer is reused for 5 s (`MAGIC_KEYWORDS_REUSE_MS`). A failed read is not cached.
- **Failure.** A read that cannot be made, a non-zero exit or output that is not a settings object logs a warning, and the host answers nothing: the page keeps what it has.

Until the host answers (and on a route that cannot carry the question) the page counts every keyword as on, as OMP's terminal does before it has judged. A setting changed in OMP is therefore picked up the next time a keyword is on screen and the page asks: at least 30 s after the last question, or on the composer's or window's focus.

Routes: the question is also allowed on the surviving-bridge route (`chat-magic-keywords-read` in `bridge-listener.ts` and the matching table of `extension.ts`, outside the one-mutation slot), through the detail-tab gate (`src/host/detail-tabs.ts`, which forwards it to the conversation under the tab's own conversation id whatever the page names) and `src/wiring/guest-dispatcher.ts`. It is a presentation read, never a writer mutation.

### 3. Matcher fidelity

`findMagicKeywords` repeats OMP's boundary patterns (`LEFT_BOUNDARY`, `RIGHT_BOUNDARY`) and `maskNonProse` exactly: the same Unicode classes, the same masking of code spans, fences and markup. `orchestrate` is painted; `orchestrate()`, `foo-orchestrate`, `path/orchestrate`, `orchestrate.md`, `orchestrates`, `Orchestrate` and `` `orchestrate` `` are not. The module deliberately has no ideas of its own about what prose is: a word OMP does not act on is never painted.

### 4. The drift pin

OMP's behaviour is an outside fact, so it is recorded from OMP rather than restated by hand, the pattern `config-schema-recorder.ts` / `omp-schema.json` already use:

- `src/omp/magic-keywords-recorder.ts` (run on Bun: OMP's own code produces the answers) and `magic-keywords-corpus.ts` record into `src/omp/fixtures/omp-magic-keywords.json`: the table, the five settings, the shimmer constants, the 14-stop palette and the paintings of a corpus of 1562 texts.
- `magic-keywords.test.ts` is offline: `src/shared/magic-keywords.ts` replays the recorded corpus and must reproduce every answer.
- `magic-keywords.live.test.ts` re-records the installed OMP and compares it with the fixture, so a change in OMP fails a test instead of drifting silently. `UPDATE_OMP_MAGIC_KEYWORDS_FIXTURE=1` rewrites the fixture after the difference has been reviewed.

### 5. The paint: the CSS Custom Highlight API

`magic-keyword-paint.ts` paints with `CSS.highlights`: one `Highlight` per keyword and gradient stop, named `omp-magic-<id>-<stop>`, each with priority `-1`. Every place that shows keywords (the composer, each sent message) owns a `MagicKeywordLayer` that holds a `Range` per painted character; the highlights are rebuilt once per microtask burst from all layers. A highlight changes colours (and underline) only, so a keyword keeps its size, weight, layout and caret, and Find in the conversation (priorities 0 and 1) paints its own colours over a keyword it matches. Where `canHighlight()` is false nothing is painted.

Why not the alternatives:

- **An overlay or mirror layer** (a second element behind the contenteditable repeating its text with coloured spans, the way textarea highlighters work) must reproduce the surface's wrapping, scroll, font, chips and selection pixel by pixel, drifts under IME composition and zoom, and doubles what a screen reader sees.
- **Wrapping the word in a `<span>` inside the composer** edits the DOM the contenteditable surface owns: it moves the caret, breaks the IME composition window, the undo stack, paste and quoting, and has to be taken out again before the draft is read back as Markdown (ADR-0077: the draft is one Markdown string rendered by the surface).
- **The same for a sent message**: spans inside the rendered Markdown would collide with React's rows and the transcript's windowing.

### 6. Composer, bubbles and the scan

`magic-keyword-scan.ts` reads the DOM and never changes it:

- `scanComposer`: the draft's text nodes, `DIV`/`P` and `BR` as line breaks, every chip (`isChip`: a command, a skill, an image or file marker) as one space, so a keyword beside a chip keeps its boundary and one inside a chip is never found.
- `scanBubble`: the Markdown a sent message renders (its `.omp-md` elements), blocks as line breaks, and code, controls, icons, `svg`, screen-reader-only text and `aria-hidden` content as one space. An inline element does not end a word, so the rendered text can read a word the prompt does not hold (`[ultra](url)think`); `mountBubbleKeywords` therefore paints only a keyword that OMP's matcher also finds in the message's raw text (by id) and that lies in one text node, because OMP matches the raw text and paints a message one Markdown text run at a time. The cost of that rule is on the other side: a word the raw text holds but an adjacent element's text joins to a longer word (`[ultrathink](url)think`) is missed rather than painted wrongly.
- `placeKeywords` maps each matched character back to a `Range` in its text node, across nodes where a word is split (an IME or an inline element can do that).

`ComposerKeywords` (mounted by `DraftEditor` next to the surface, without touching `DraftSurface`) rescans from a `MutationObserver` after any change to the composer's DOM, whoever made it: a keystroke rendered by the surface, an IME composition, undo, paste. A text with none of the four words skips the mask and the match (`mayHoldMagicKeyword`: one `includes` probe per word); the walk that builds the text still runs. `mountBubbleKeywords` does the same for a sent message from `useMagicKeywords`, a layout effect so a keyword is painted in the frame its message first shows; a message whose raw text holds no keyword word mounts nothing, and agent-attributed (`synthetic`) input is not painted.

Shimmer: while the composer has the keyboard focus in a window that has it (`document.hasFocus()`, resynced on the window's `focus` and `blur`: a window the operating system deactivates keeps `activeElement` and stays visible), the page is visible, a keyword is painted and neither reduced motion nor forced colours is on, `ComposerKeywords` sets the layer's phase to `magicPhaseAt(Date.now())` every 70 ms. Otherwise there is no timer and the phase is 0. A sent message is always static.

### 7. Colours and the theme solver

OMP paints every stop at `hsl(hue, 90%, 62%)`, made for a dark terminal. On a dark VS Code theme a blue at that lightness is only about 2.7:1 against the input background, and a light or high-contrast theme asks for more again. Desk keeps OMP's hues and solves **each stop's lightness per theme kind** (`magicStopColour`): OMP's colour when it is readable on the kind's surfaces, otherwise the same hue with the lightness moved the least that works, up on a dark kind and down on a light one.

The target is ordinary text: contrast of at least 4.5:1 on the dark and light kinds, 7:1 on the two high-contrast kinds (WCAG 2.1, 1.4.3 and 1.4.6). A theme's exact colours are unknown when the stylesheet is built, so each kind is solved against the hardest surface it can have (`MAGIC_THEME_DESIGN`): dark `#3c3c3c` (the lightest input of the built-in dark themes), light `#cddcec` (a message bubble's focus-border tint, about `#d1e2f2` on Light Modern), high contrast `#000000` and `#1a1a1a`, high contrast light `#ffffff` and `#f2f2f2`. A stop that passes there passes on every easier surface. `magic-keyword-styles.ts` writes one rule per keyword, stop and kind: the dark palette is the base and `.vscode-light`, `.vscode-high-contrast` and `.vscode-high-contrast-light` (the body classes VS Code gives its theme) override it.

A fixed palette is rejected in the alternatives below.

### 8. Accessibility

- **The DOM is never changed**: no extra element or attribute. The contenteditable surface, its caret, selection, IME composition window, undo stack, paste, quoting and slash completion, and the screen-reader text of a message, are untouched. The paint is presentation only and adds nothing a screen reader reads.
- **Reduced motion** (`prefers-reduced-motion: reduce`) and **forced colours** (`forced-colors: active`): the gradient is static and there is no timer. A hidden page has no timer either. Changes of either preference, of focus and of visibility are followed.
- **High Contrast** themes (dark and light): the keyword is underlined as well as coloured. **Forced colours** (Windows contrast themes): it is underlined too, in a `@media (forced-colors: active)` rule, because colour is not the only cue there.
- Highlights carry colour (and underline) only; size, weight and layout do not change.

### 9. Failure behaviour

| Failure | Result |
|---|---|
| No Custom Highlight API | Nothing is painted. |
| The host cannot read the settings (OMP not runnable, non-zero exit, unparseable output, a host without `readMagicKeywords`) | No answer; the page keeps the set it has (every keyword until the first answer). |
| OMP before the feature | The keys are absent, the answer is `[]`, nothing is painted. |
| A route that does not carry the question | The page keeps counting every keyword. |
| A keyword in a chip, in code, in synthetic input, in a skill-invocation or collab card | Not painted. |

## Alternatives

- **An overlay or mirror layer behind the composer.** Rejected: see §5.
- **Spans inside the contenteditable.** Rejected: see §5.
- **Read the settings eagerly on every page announce, or watch OMP's config files.** Rejected: every Chat page and detail tab would start `omp config list` at open although most never show a keyword, and watching the global and project config of every tab's folder and profile is machinery for a setting that is changed rarely. The lazy, throttled question starts nothing until a keyword is on screen and bounds the staleness to the period.
- **A fixed palette (OMP's `hsl(hue, 90%, 62%)` everywhere, or one hand-picked list).** Rejected: OMP's colour is made for a dark terminal and a blue stop of it is only about 2.7:1 against Dark+'s input background (§7), below the 4.5:1 of ordinary text, and the two high-contrast kinds ask for 7:1; one list cannot serve four kinds whose backgrounds sit on both sides of the colour. A solver that keeps OMP's hues and moves only lightness per kind keeps the identity of the gradient and the contrast guarantee, and is testable against the real theme token sets.
- **Solving per custom theme at runtime.** Not done: it would need the exact input and bubble backgrounds of the active theme in the page; the worst-case surface per kind is a conservative, static substitute (see Limits).

## Limits

- The Custom Highlight API is required (VS Code's Chromium has it).
- A keyword inside a command, skill or attachment chip is not painted; synthetic input, skill-invocation cards and collab cards are not painted.
- The colours are solved against worst-case surfaces per theme kind, not each custom theme's exact background: on a theme whose surface is easier the keyword reads better than needed, and a custom theme whose surface is harder than the design surface of its kind may read worse.
- A setting changed in OMP shows up only when the page asks again: while a keyword is on screen, at least 30 s after the last question (or on focus), and the host may answer from a 5 s reuse.
- OMP paints regardless of whether its notice's tools are enabled and so does Desk; a painted word does not prove the notice was added.
- The shimmer is a 70 ms timer while the composer has the focus and shows a keyword: one rebuild of the highlights per frame.

## Tests

- Pure: `src/shared/magic-keywords.test.ts`, `src/shared/magic-colour.test.ts`.
- OMP pin: `src/omp/magic-keywords.test.ts` (offline replay of the fixture) and `src/omp/magic-keywords.live.test.ts` (re-record and compare against the installed OMP).
- Protocol and host: `src/protocol/chat-messages.test.ts`, `src/protocol/messages.test.ts`, `src/host/chat-runtime-magic-keywords.test.ts`, `src/host/omp-setting-read.test.ts`, `src/host/detail-tabs.test.ts`, `src/host/bridge-listener.test.ts`.
- Page store: `src/webview/lib/magic-keyword-settings.test.ts`.
- Page, in an owned headless Chromium: `src/webview/magic-keywords-ui.test.ts` (composer boundaries, chips, DOM unchanged, typing, undo and paste, IME composition, bubbles, the settings switch, the throttle, the shimmer and reduced motion, contrast on the four real VS Code theme token sets, no Highlight API).

## Related Decisions

- [Composer contenteditable surface](2026-10-15-composer-contenteditable-surface.md) and [ADR-0077](../decisions/0077-edit-the-chat-draft-in-a-contenteditable-surface-rendered-from-the-markdown-string.md): the surface this paint leaves untouched.
- [Commands and skills as blocks in the Chat composer](2026-10-18-composer-command-skill-chips.md): the chips the scan treats as one space.
- [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): the host-owned conversation and the `omp:chat-*` family the new pair joins.
- [ADR-0023](../decisions/0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md): the surviving-bridge route whose allow-list now also carries the read.

No new ADR: the lasting choices here (a per-theme-kind solved palette, a lazy page-driven settings read, a Highlight API paint with no DOM change) are local to one feature, add no dependency and follow existing decisions; this design records them, as the `/btw` and `/fork` designs do.

## Architecture Review

Not yet done. This design must go to an independent architecture reviewer before it is set to `accepted` (`docs/README.md`, Required review).

Two independent code reviews of the implementation (2026-10-19, read-only, against the installed OMP 18.12.2's own source) found the matcher, the mask, the gradient arithmetic, the settings gate and the read-only exchange faithful and no leak in the page's observers, timers and highlights. Their findings are resolved in the code and in this text:

- A sent message painted a keyword the rendered text joins across an inline element (`[ultra](url)think`) when another keyword mounted its layer, and the `useMagicKeywordSettings` hook had no consumer: the bubble now paints a keyword only if OMP's matcher finds it in the raw text and it lies in one text node (section 6), and the hook and its test are deleted.
- The composer's shimmer kept running while the operating system had deactivated the window: it now also needs `document.hasFocus()` and resyncs on the window's `focus` and `blur`.
- The host's 5 s answer and its in-flight read were keyed by tab and folder only, so a tab rebound to another profile reused the earlier profile's answer: they are keyed by the resolved profile as well, and a replaced conversation drops them.
- The section 6 cost sentence said one `includes` probe per word; the walk that builds the text still runs, and the sentence now says so.
