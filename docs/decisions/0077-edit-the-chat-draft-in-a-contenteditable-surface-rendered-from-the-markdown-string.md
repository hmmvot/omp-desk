---
status: accepted
date: 2026-10-15
---

# ADR-0077: Edit the Chat draft in a contenteditable surface rendered from the Markdown string

## Context and Problem Statement

The Chat composer was a `<textarea>` over a highlight layer. The maintainer decided (2026-10-15) that a fenced code block in the draft is shown in the editor font **while the prose around it stays proportional** ([design](../designs/2026-10-15-composer-contenteditable-surface.md)). A textarea has one font, and its caret, selection and hit tests come from its own layout, so a second font painted elsewhere drifts from them; the shipped compromise, the whole draft in the editor font while a block exists, is rejected.

Constraints that make this a lasting choice:

- The draft is a plain Markdown string that is stored, handed off between editors, restored and sent unchanged.
- IME composition must keep working, and the draft hand-off must freeze every content mutation (ADR-0050).
- VS Code's webview handles the editing shortcuts itself: its script cancels `Ctrl+Z`/`Ctrl+Y`/`Ctrl+X`/`Ctrl+C`/`Ctrl+V` and forwards them to the workbench, which answers with `execCommand(...)` on the page (verified on the installed 1.142), and it cancels the default of every drop. A page cannot rely on `historyUndo` or a native drop.
- The composer's existing features (completions, image markers, history, drag and drop, focus rules) must not regress, and no heavy dependency may enter the VSIX.

## Considered Options

- **Textarea, whole draft monospace while a block exists** (shipped): simplest and the most robust IME and accessibility host, but prose changes font.
- **Transparent textarea over a per-range-font overlay**: the overlay's glyph positions cannot match the textarea's single-font layout; hides IME composition rendering and breaks forced colours.
- **`contenteditable` edited natively, restyled afterwards**: native undo dies when nodes are replaced, and the browser's DOM structure has to be normalised after every key.
- **`contenteditable` rendered from the model, every edit intercepted at `beforeinput`, own undo stack** (chosen).
- **Canvas/hidden-input editor, or a rich-text library**: disproportionate, and a second source of truth.

## Decision Outcome

Chosen: the **contenteditable surface rendered from the model**. The Markdown string is the only source of truth; the DOM is a per-line rendering of it (code lines carry the editor font and band, prose the UI font, image markers are atomic non-editable inline chips). User edits are intercepted at `beforeinput`, applied to the model and re-rendered line by line; every programmatic write states whether it records or resets undo; the page keeps its own undo and redo stack of `{text, selection}` snapshots, driven by the keyboard; an IME composition is left entirely to the browser inside one *composition window* owned by the surface and read back, with every line replaced, when it settles; paste is plain text; copy and cut write the model slice, and cut deletes itself; the draft hand-off freezes the field with `contenteditable="false"`. Composer features keep their API and read the field through a surface object that mirrors the textarea members they used, including a retained selection.

The prototype measured the native-undo limitation that forces the own stack and exercised the main interactions (55 scripted checks); real-IME and assistive-technology behaviour remains a maintainer check recorded in the design.

### Consequences

- Positive: only the block is monospace; the band is a property of each line, so the mirror layer, `syncMirror`, `autosize` for this field and the clone-based `caret-row` measurement are removed; the model stays one string; every edit path, programmatic ones included, goes through one function that records or resets undo and keeps image markers atomic.
- Negative: the page owns undo and redo, so Edit > Undo and Edit > Redo are inert for the composer (verified mechanism, not a possibility); in-editor drag-move of selected text and native spell-check suggestions are lost; prompt-history recall, queued-message restore, `set_editor_text`, accepted completions and Commands-row inserts become undoable steps; plain-text drop at the pointer is new; a contenteditable is a less forgiving IME and screen-reader host than a textarea, so real-IME and assistive-technology checks are a standing cost; roughly 1 000 lines of editing code and a test migration replace a short native implementation.
- Rollback: revert the change. The stored and sent string is unchanged, so no data migration exists.

## Related Documents

- [Composer contenteditable surface design](../designs/2026-10-15-composer-contenteditable-surface.md)
- [Code blocks in the Chat composer](../designs/2026-10-15-composer-code-blocks.md): its Goals bullet "Native Undo/Redo", the `execCommand` mechanism of section 2, section 3, Alternatives 1 and 2, three Risks and part of Rollout and Smoke are superseded here (exact list in the design's header); its fence grammar, key rules, hint, completion gate and indentation rule stand.
- [Paseo-style chat](../designs/2026-10-04-paseo-style-chat.md): its *Composer* paragraph and native-undo mechanism are superseded here.
- [ADR-0050](0050-retain-uncertain-input-and-confirm-exact-file-restart.md): the capture freezes every content change; kept by `freeze()`.

## Architecture Review

- Reviewer: independent architect (`SurfaceArchReview`, a fresh agent), two passes together with the design.
- Outcome: accepted after the findings were resolved. First pass: accept with changes (five material findings, among them the undo policy of programmatic writes, the composition window, VS Code's own handling of the editing shortcuts, the retained selection and the ADR-0050 freeze); confirmation pass: accept with changes (two further material findings on composition and a pending send, and on a window that never closes), applied in the text.
- Notes: the full list of findings and their resolutions is recorded in the design's Architecture Review. The ADR's Consequences name the maintainer-visible losses (inert Edit-menu undo, no drag-move or spell-check suggestions) and gains.
