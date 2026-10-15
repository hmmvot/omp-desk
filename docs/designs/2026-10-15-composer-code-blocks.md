---
status: accepted
date: 2026-10-15
---

# Code blocks in the Chat composer

## Problem

The Chat composer is a plain `<textarea>` where `Enter` sends. A message that carries a snippet (a diff hunk, a stack trace, an `omp-vscode` source excerpt) cannot be typed in it comfortably:

- Every line of a snippet needs `Shift+Enter`, and one slip sends half a message.
- `Tab` moves the focus out of the composer, so indentation cannot be typed.
- The snippet is shown in the proportional UI font, so alignment is lost.

The wire format is already right: OMP receives plain Markdown, and a fenced block in it is a code block. Only the editing experience is missing.

## Goals and Non-goals

- Goals:
  - A fenced block is a line of three or more backticks with an optional language, up to a closing fence line (at least as many backticks, nothing else on the line), or up to the end of the draft while it is unclosed.
  - Inside it `Enter` inserts a newline (keeping the current line's indentation) and `Tab` indents like a text editor; neither sends nor moves the focus. `Shift+Tab` outdents; `Tab` over several lines indents them all.
  - A key still sends from inside a block (`Ctrl+Enter`), and the composer says so while the caret is in a block.
  - A keyboard way out of the Tab capture exists, for keyboard-only and screen-reader users.
  - The block is visibly set apart and shown in a monospace font while editing.
  - Slash, argument and `@` completions do not open inside a block.
  - Native Undo/Redo, IME composition, caret, selection, scrolling, auto-grow, image markers, drag and drop, paste and the Terminal mode keep working. The text that is sent does not change.
- Non-goals:
  - Syntax highlighting while typing, a language picker, or line numbers.
  - Following `editor.tabSize` / `editor.insertSpaces` (see "Indentation").
  - A rich-text or WYSIWYG composer; another fence syntax (`~~~`, indented code).
  - Changing what the Terminal mode does with the keyboard.

## Current State

- `src/webview/components/Composer.tsx` renders one `<textarea class="omp-textarea">`, transparent over the dock's background, and an optional mirror layer behind it (`.omp-textarea-mirror`, `aria-hidden`, transparent text) that paints a chip behind every `[Image #N, WxH]` marker. The mirror has the textarea's metrics (same padding, line height, wrapping, scroll offset, scrollbar gutter), which `syncMirror` keeps equal.
- `onPromptKeyDown` sends on `Enter` unless `Shift` is held or an IME composition is active (`shouldSubmitOnEnter`); `Ctrl+Enter` therefore also sends, and the host's `ompDesk.sendPrompt` keybinding (`Ctrl+Enter` when a session editor is focused) runs the same `send`. `Alt+Enter` is a follow-up while a turn runs.
- `Tab` is not handled and moves the focus; an open completion popup takes `Tab`/`Enter` first.
- Edits that must be undoable go through `replaceRange`, which uses `document.execCommand("insertText" | "delete")` so the browser's own Undo/Redo covers them.
- Completions come from `slashQueryAt`, `slashArgumentAt` and `mentionQueryAt` on `(text, caret)`.
- VS Code's webview script passes every `keydown` to the workbench's own key handling, even when the page called `preventDefault()`. A chord the page wants for itself must therefore be one the workbench does not bind: `Escape` stops a running turn (`ompDesk.stopTurn`), and `Ctrl+M` is the workbench's global Tab-Moves-Focus toggle.
- The editor's `editor.tabSize` / `editor.insertSpaces` do not reach the webview; the host sends display preferences (`omp:chat-display-preferences`) with two values only.

## Proposed Design

### 1. Recognising a block (`src/webview/lib/code-fence.ts`, pure)

`findFencedBlocks(text)` scans lines (`\n`, the textarea's normalised form) once:

- An opening fence is `^ {0,3}` + a run of at least three backticks + an info string without backticks (CommonMark's rule, so the text the message carries is read the same way by the model and by the transcript renderer).
- A block closes at the first following line that is zero to three blanks, a run of at least as many backticks, and trailing blanks only.
- A block with no closing line runs to the end of the draft.
- Each block records `start` (first character of the opening fence line), `openEnd` (end of that line), `closeStart` (start of the closing line or `null`) and `end` (end of the closing line, or the end of the draft).

The caret (or both ends of the selection) is **inside** a block when `start <= offset <= end`. The fence lines belong to it. The first offset after the closing line's newline is outside. A selection that starts in one range and ends in another counts as outside, so `Enter` keeps its present meaning there.

The scan is linear. The composer recomputes it per render from `text` (`useMemo`) and, for key handling, from the live `value` and selection on each `keydown`, so a state that lags a frame can never decide a key.

### 2. Keys inside a block (`Composer.tsx`, before the popup and send rules)

Skipped while an IME composition is active (`isComposing`, the tracked flag, or `keyCode 229`), while the draft is held for a restore (`captureRef`), and for `Ctrl`/`Alt`/`Meta`-modified `Tab`. All edits go through `replaceRange` (`execCommand('insertText')`), then one `setSelectionRange`, so every key is one native undo step. Such an edit is marked, so the image-marker repair that inspects a diff between two drafts does not read a line edit that spans an untouched marker as damage to it.

| Key (caret or selection inside a block) | Result |
| --- | --- |
| `Enter`, `Shift+Enter`, `Alt+Enter` | newline plus the leading blanks of the caret's line up to the caret (a selection is replaced). Fence lines get no indentation. Only `Ctrl`/`Cmd` turns `Enter` into a send, so `Alt+Enter` (a follow-up send outside a block) is a newline here and a follow-up is `Ctrl+Alt+Enter`. |
| `Enter` at the end of an opening fence line that has no closing fence | inserts `\n\n` and a closing fence of the same length in **one** edit and puts the caret on the empty middle line. Undo removes the whole insertion in one step. |
| `Tab`, one line or a caret | spaces up to the next multiple of four columns (a selection within one line is replaced). On a fence line it does nothing, because indenting an opening fence by four columns would end the block. |
| `Tab`, selection over several lines | four spaces added to every non-blank, non-fence line it touches (a selection that ends at a line start leaves that last line alone, as VS Code does); the selection keeps covering the same text. |
| `Shift+Tab` | removes one tab, or the spaces back to the previous tab stop (a whole step when already on one), from the caret's line or every selected non-fence line. **When there is nothing to remove it is not handled, and the browser moves the focus to the previous control: this is the keyboard's way out.** |
| `Ctrl+Enter` (and `Cmd+Enter`) | sends, with the delivery `Enter` would have had: `Alt` still means follow-up while a turn runs. This is `ompDesk.sendPrompt`'s own chord, so the VS Code keybinding and the textarea agree. |

Outside a block nothing changes: `Enter` sends, `Shift+Enter` is a newline, `Tab` moves the focus.

While the caret is in a block, a one-line hint below the input (`.omp-composer-hint`, `role="status"`, so a screen reader announces it when it appears, and linked from the textarea by `aria-describedby`) reads: `Code block · Ctrl+Enter: send · Enter: new line · Tab: indent · Shift+Tab: outdent, or leave when there is nothing to outdent`. The row exists as long as the draft holds a block and only its words come and go with the caret, so a click into a block never moves the text under the pointer; the line does not wrap (ellipsis, full text in `title`).

### 3. Rendering

**Decision: the textarea keeps painting its own text, the whole draft switches to the editor font while it contains a fenced block, and the existing mirror layer paints a band behind each block.**

- While `findFencedBlocks(text)` is non-empty, the textarea and the mirror both take `font-family: var(--omp-mono)` (the editor's font, already a Chat token) at the editor's font size capped at 15 px, `tab-size: 4` and the same `line-height: 20px`. Row height, padding and auto-grow stay as they are, so only the glyph widths change and the text re-wraps once, when a fence line first appears (or, typed or deleted backtick by backtick, when the last one disappears).
- The mirror (today rendered only when the draft has image markers) is rendered when it has markers **or** blocks. It becomes a stack of block-level pieces: ordinary pieces and one piece per fenced block. A block piece has the code-block background (`--vscode-textCodeBlock-background`) and reaches the textarea's full width through a negative margin and equal padding, so the text inside keeps the exact wrapping width of the textarea. The newline that separates a piece from the next is consumed by the block boundary, so exactly one newline separates two boxes: two adjacent blocks have no piece between them, and an empty line next to a block is an empty piece. Each piece ends in a zero-width space so an empty last line keeps its height. Markers are painted inside whichever piece contains them.
- The text is **not** copied into the mirror's paint: the mirror's text stays transparent, as for the image chips. The textarea still draws glyphs, caret, selection, IME composition underline and spell state.
- Forced colors (High Contrast) paint the band as `Canvas` with a `CanvasText` border instead of a tinted background.

Why the whole draft and not only the block: a `<textarea>` has one font, and the caret, the selection and a click's hit test all come from the textarea's own layout. Any scheme that paints the block's glyphs in a different font than the textarea lays them out in desynchronises the caret (a monospace glyph is wider than most proportional ones, so the offset error grows along a line and moves wrap points). The alternatives are in the next section. **Open for the maintainer:** whether "the block is shown in a monospace font" may be read as the whole draft being monospace while a block exists, with the band marking which part is the block.

### 4. Completions

`slashQueryAt`, `slashArgumentAt` and `mentionQueryAt` are not asked while the caret is inside a block (`completionsEnabled` is false there), so no popup opens, no file search request is sent, and `Tab`/`Enter` never accept a suggestion there. Text typed or pasted inside a block that happens to look like `/cmd` or `@file` stays text.

### 5. Indentation

The webview cannot read `editor.tabSize` / `editor.insertSpaces`: they are per-language and per-resource, and a Chat has neither. The host could read a language-scoped value from the fence's language, but that needs a new protocol field, a host read per language and a configuration listener for what is a convenience in a chat message. **Decision: four spaces, tab stops every four columns, no tab characters** (a pasted tab renders four wide, `tab-size: 4` on the textarea and the layer). Spaces keep the text readable when the transcript renders it and when the model quotes it back. The constant is one named value (`CODE_INDENT`) so a per-language rule has one place to change.

### 6. What is not touched

- The text sent is `compactForSend(text).trim()` as before; no fence is added, removed or normalised on send, so an unclosed block is sent unclosed.
- Terminal mode has no composer; nothing there changes.
- Queue editing, history recall (`ArrowUp` on the first row), restore, rewind, and "Add Selection to Session" insert text through the same `text` state and are not special-cased; a block they create or complete is recognised from the text like any other.
- Drag and drop and paste of files and images are unchanged: a marker inside a block is an atomic marker there too.
- `editor.tabFocusMode` (VS Code's persistent Tab-Moves-Focus setting) is not read; the Shift+Tab way out does not depend on it.

## Alternatives

1. **Transparent-text textarea over an overlay that paints the text, per-range fonts.** The overlay can show a proportional prose font and a monospace block font. Rejected: the textarea must still lay the text out for caret, selection and hit testing, and it has one font, so the two layouts differ and the caret drifts (see the decision above). Matching them would need glyph-by-glyph positioning of the overlay on the textarea's advances (which stretches monospace glyphs into proportional slots). It would also lose the browser's own IME composition rendering (the transparent text hides it; the overlay cannot know the candidate string until commit), forced-colors correctness (system colours override `transparent`), and native selection contrast.
2. **`contenteditable="plaintext-only"` with styled spans.** Per-range fonts are natural. Rejected: re-rendering the spans after every input discards the browser's undo history; everything built on `selectionStart` / `setSelectionRange` / `caretRowEdges` (history navigation, marker snapping, completions, restore) would be rewritten; paste and IME differ between engines.
3. **Hidden input plus a painted editor (Monaco/CodeMirror style).** Full control, including per-range fonts. Rejected as disproportionate: it re-implements caret, selection, bidi, wrapping, accessibility and every existing composer interaction for one feature.
4. **Several stacked textareas, one per segment.** Native per-segment fonts. Rejected: caret and selection cannot cross segments, Undo is per element, and the composer's draft model is one string.
5. **A monospace font only while the caret is in a block.** Rejected: the text would re-wrap every time the caret crosses a fence.
6. **Auto-closing fence on type** (without waiting for `Enter`). Rejected: the closing fence would appear under the user's hands while the third backtick is still being typed, and Undo would take two steps.
7. **`Escape` then `Tab` as the way out** (the usual ARIA-authoring pattern). Rejected after review: VS Code forwards the `Escape` keydown to its own keybindings even when the page handled it, and `Escape` stops a running turn (`ompDesk.stopTurn`, `when: ompDesk.streaming && !ompDesk.composerPopupOpen`), so a keyboard user leaving the box while drafting a follow-up would abort the agent. A context key to exclude it would add host plumbing for a worse chord.
8. **`Ctrl+M` as a Tab-Moves-Focus toggle, as in VS Code's editors.** Rejected after review: in the workbench it is a global command (`editor.action.toggleTabFocusMode`) whose state the extension cannot read, so a composer flag would drift from the workbench's after a toggle elsewhere or a reload, and one press would flip both. Following it properly needs the `editor.tabFocusMode` setting in the display preferences and still cannot see the toggle.
9. **A hint that only shows with the caret, taking space as it appears.** Rejected: the dock grows as the caret enters a block, which moved the text under a clicking pointer (found by the layout test); the row is kept while a block exists.

## Risks and Open Questions

- **Prose changes font while a block exists.** This is the cost of Decision 3, shown plainly: the draft is monospace as a whole while a fence is present, and the band marks which part is the block. If users want proportional prose beside a monospace block, the only faithful way is Alternative 3, a separate project. The maintainer's reading of the wording is still to be confirmed.
- **Re-wrap at a fence.** Typing or deleting a backtick on a fence line switches the font of the whole draft and re-wraps it. The caret keeps its offset (the browser keeps the selection in the value), and the scroll is re-clamped by the existing `autosize`/`syncMirror` pass.
- **A literal triple backtick message.** A message that is only a fence line cannot be sent with `Enter`; `Ctrl+Enter` sends it. The hint says so.
- **Auto-closing surprises.** `Enter` after an opening fence inserts a closing fence even if the user did not want one; one Undo removes it. Text after the caret leaves the block as a consequence.
- **The way out goes backwards only.** `Shift+Tab` on an unindented line moves the focus to the previous control (the transcript side); there is no forward exit to the toolbar, and a user who presses `Shift+Tab` once too often leaves the box (the caret and selection are kept; `Ctrl+Shift+L` returns to the composer, and `Ctrl+Enter` sends from inside).
- **Screen readers.** Capturing `Tab` is the usual editor trade; the hint is announced when it appears (`role="status"`), and the exit is documented in the README.
- **A line that ends in blanks at the wrap width next to a block boundary** is laid out by the same `white-space: pre-wrap` rules in the textarea and in the layer; the owned-Chromium layout test covers a wrapped line, the boundaries, adjacent blocks and empty lines, not every width.

## Rollout and Verification

1. `code-fence.ts` with unit tests (`node --test`): fence grammar (info strings, longer fences, indented, unclosed, backtick-in-info, adjacent blocks), caret-in-block ranges, and the edit functions (newline with indentation, auto-close, indent/outdent single and multi-line with selection mapping, fence lines untouched, previous tab stop).
2. Composer integration: key handling, completions gate, font class, mirror pieces, hint, `Shift+Tab` exit.
3. Owned-Chromium scenarios in `src/webview/chat-ui.test.ts`: keys inside and outside a block (nothing sent, focus kept, `Ctrl+Enter` sends, `Shift+Enter`/`Alt+Enter` newlines, a straddling selection still sends), `Tab`/`Shift+Tab` on a caret and on a selection, native Undo after Enter, Tab and the auto-close, IME composition leaves the keys alone, slash/`@` completions suppressed inside and working outside, the band and the wrap point against the textarea's own hit tests at the top and scrolled (with the scrollbar gutter), the text not moving as the hint changes, adjacent blocks and empty lines (the layer has the textarea's row count), an image marker inside a block, proportional again without a fence, and the Shift+Tab exit.
4. A smoke in one hidden test window with screenshots of a draft with a code block, README and `CHANGELOG` `[Unreleased]`, then a VSIX from a clean worktree.

## Related Decisions

None. The rendering choice is recorded here rather than in an ADR because it touches one component and can be replaced without migration; if Alternative 3 is ever taken, that change gets its own ADR.

## Architecture Review

- Reviewer: independent architecture reviewer (`MergeArchReview`), one pass on the first proposed text.
- Outcome: accepted after the findings were resolved.
- Notes: the review confirmed the argument against per-range fonts, the IME and Undo handling, the block-boundary rules and the wrapping equality of the band layer, and found two material issues and four should-fix items, all applied here. M1: `Escape` then `Tab` would abort a running turn (the workbench receives the `Escape` keydown): the exit was dropped (Alternative 7). M2: `Ctrl+M` is the workbench's own global toggle, not editor-local as the first text claimed: the composer flag was dropped (Alternative 8), and `Shift+Tab` with nothing to outdent is the way out. S1: adjacent blocks added a phantom row to the layer (the pieces rule and a test). S2: the hint is a `role="status"` region. S3: `Alt+Enter` inside a block is specified. S4: the closing fence's indentation is stated. The nits (previous tab stop, `tab-size` on both layers, the font-size wording) are applied. The reviewer left the reading of "the block is shown in a monospace font" as a product question for the maintainer, recorded under Risks.

## Smoke

`test/e2e/scenarios/36-chat-code-blocks.spec.ts` ran once in a hidden VS Code test window (mock model) and passed (46.7 s). It types a prose line and a `ts` fence, sees `Enter` supply the closing fence, types a function of `omp-vscode` with `Enter`, `Tab` and `Shift+Tab` (value, focus and band checked; the screenshot shows the whole draft in the editor font, the band behind the block and the hint row under it), sends with `Ctrl+Enter`, and checks that `Tab` outside a block leaves the composer while `Shift+Tab` with nothing to outdent inside one does too. It shows that no workbench binding answers a key the page handled.