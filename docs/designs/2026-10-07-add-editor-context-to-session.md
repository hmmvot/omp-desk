---
status: accepted
date: 2026-10-07
---

# Add editor selection or files to an OMP session as references

## Problem

Competing OMP/agent extensions can send what the user is looking at to a session. This extension cannot: the user copies a path by hand into the Chat composer or the native TUI. Because several sessions are normally open at once, an implicit target is unsafe — the first draft of this feature defaulted to the most recently focused session, and the user's objection was that "it may be unclear which session the text goes to".

## Goals and Non-goals

- Goals:
  - Two commands, `OMP: Add Selection to Session` (`omp.sendSelection`) and `OMP: Add File to Session` (`omp.sendFile`), reachable from the editor context menu, Explorer, editor-tab context menu and Command Palette, with a default keybinding for the selection command.
  - Insert a **reference** (`@path`, with a line note for a selection), never file contents, into the Chat composer or the native TUI prompt of a session the user explicitly chooses.
  - Never submit. Reveal and focus the destination, put the caret in its input and say where the text went.
- Non-goals: pasting file contents or diagnostics; sending to a session another window owns; a "send" for non-file resources (untitled, `git:`, output panels); a new webview→host reply protocol; any change to what OMP does with a mention.

## Current State

`src/host/file-mentions.ts` already turns workspace files into `@path` completions for the Chat composer's `@` popup (`mentionPath`), and `src/webview/messages.ts` owns the mention grammar (`mentionTokenForPath`, `mentionQueryAt`). The extension already posts one-shot actions to the focused page (`omp:webview-action`), restores a draft into a fresh document (`omp:draft-restore`) and reveals/starts sessions through `openSession`/`openTab`. The native pane's keystrokes and pastes reach the PTY only through the page, as the broker's visible input owner (`TerminalPipeline.input`).

## Proposed Design

### What is inserted: a reference, verified against the installed OMP

Verified against OMP 18.6.3 (the installed `@oh-my-pi/pi-coding-agent` and `pi-tui` packages; paths below are relative to the coding-agent package's `src/` directory unless stated):

- `@path`, `@"quoted path"` and `@'quoted path'` are the only mention syntax: `FILE_MENTION_REGEX` and the boundary/edge-punctuation rules are `src/utils/file-mentions.ts:33-36`. A mention counts only after whitespace or an opening bracket/quote (`isMentionBoundary`, `:44`).
- **There is no line-range syntax.** `resolveMentionPath` (`:57-72`) passes the token to `resolveReadPath(filePath, cwd)` (`:65`) with no selector split and treats anything that does not exist as prose, so `@src/a.ts:12-30` names a file called `a.ts:12-30`, matches nothing and the file is not read at all. (`#L12-30` fails for the same reason.) The `read` tool's own `path:12-30` selector is applied by that tool, not by mention expansion.
- Expansion runs inside `AgentSession.prompt` on the submitted text (`src/session/agent-session.ts:7723-7733`), which both `omp --mode rpc-ui` (`src/modes/rpc/rpc-mode.ts:843,1836`) and the TUI call, so Chat and Terminal behave identically for a prompt sent while the session is idle, apart from the TUI expanding emoticons at submit. The base directory is the **session's cwd**, which is why the path is made relative against the *target session's* cwd with `mentionPath` and stays absolute (forward-slashed) when the file is outside it.

So a selection is inserted as `@src/a.ts [lines 12-30]` (`[line 7]` for one line; `[lines 12-30, 45]` for several ranges): the mention makes OMP read the file, the note tells the model which part matters. Several files from an Explorer multi-selection are one mention each, space-separated, in selection order, de-duplicated. A path the mention grammar cannot express (both quote kinds, or a control character) refuses the whole insertion with a message instead of inserting a mention that names nothing. One insertion is a single line of at most 900 characters: the native TUI collapses a paste above 1,000 characters or ten lines into a `[Paste #N]` marker and may open its large-paste menu (`pi-tui/src/components/editor.ts:3208`), which is not the prompt input. Chat uses the same bound so one gesture inserts the same text in both views. Pure formatting is `src/host/editor-context.ts` (`formatReference`, `composeInsertion`).

A selection that ends at column 0 of a later line stops at the previous line; multiple selections in one editor merge into one note.

### Which session: always the user's choice

There is no default target. Every command shows a `QuickPick` (built-in filtering over description and detail) listing:

- sessions this window **runs** whose input is free (running, working, waiting for subagents, unread, waiting for you), with or without an open editor;
- **stopped or draft** sessions that have an editor open here; choosing one starts it through the same `openSession` path the Sessions view's Open uses (ownership is rechecked there);
- finally `New session in <folder>`, the workspace folder holding the file, else the file's directory, in the profile's default view. Choosing it is the explicit act of adding that folder to the launcher, since a session is never started in an unlisted folder.

Each row shows title, folder, mode (Chat/Terminal) and the Sessions view's own status word. Rows are ordered most-recently-focused editor first (and that row is preselected), then running before stopped, then by title. Recency is the order in which this window's OMP editors became active (`EditorRecency`, fed by `onDidChangeViewState`); a session whose editor is closed is simply unranked.

Never offered: a session that is **blocked** or held by another window or writer; a **question** row (its composer or TUI input is covered by the dialog); starting, stopping, checking and restoring rows; an editor that is passive for its session; stopped sessions with no open editor here (history belongs to the Sessions view).

`insertAvailability(state, {running, open})` decides this from `sessionItemState`, the single source of row status.

### Delivery

After the choice the extension composes the text for the chosen session's cwd (a refusal happens before anything is opened), opens or reveals the session, then waits (bounded, 30 s) until its input exists:

- **Chat**: the editor's page must have announced itself (`omp:ready` for its current document, `readyDocuments`); the host then posts `omp:insert-text`. The page inserts at the textarea caret (over a selection) through the editing command stack, so Undo removes it, with a space before unless whitespace is there and a space after; with the textarea unmounted it appends to the draft. It never submits. An insertion that reaches a page before its composer mounts is held (at most eight) and delivered to the first composer.
- **Terminal**: `TerminalPipeline.pasteText` writes `ESC[200~` + ` text ` + `ESC[201~` as the visible input owner, with no CR or LF, and only while the program itself has enabled bracketed paste (DECSET 2004, tracked from live output and, for a pipeline created after the program started, one screen snapshot). The native TUI sets that mode when it takes the terminal (`pi-tui/src/terminal.ts:1086`) and clears it when it leaves, so a shell prompt or a still-starting program never receives the text. Verified paste handling: `CustomEditor.handleInput` assembles the bracketed paste and inserts it at the caret through `pasteText` (`pi-tui/src/prompt/custom-editor.ts:1538-1570`), submission happens only on a submit key (`input-controller.ts:942`), and a paste that does not parse as explicit absolute/relative image paths is plain text; an `@…` paste never matches those. The leading space makes the mention start after whitespace; the TUI trims the prompt on submit. Write failure, a hidden pane, a pane that does not own input and a pending dialog are named, not papered over.

On success the destination has been revealed (`panel.reveal`), the caret is in its input (the composer focuses on insertion; the native pane gets the same activation intent as a click via `activateNativeEditor`) and the status bar says `Added @src/a.ts [lines 12-30] to «Title»` for 6 s (`N file references` for several). On failure a warning says nothing was added and offers **Copy reference**.

### Surface

`package.json` contributes both commands (category `OMP`), the editor context menu (`omp.sendSelection` when there is a selection, `omp.sendFile` when there is none), `explorer/context`, `editor/title/context`, and the keybinding `alt+shift+k` (`editorTextFocus && editorHasSelection && resourceScheme == file`) for `omp.sendSelection`. The chord is not an OMP or VS Code default as far as checked (see Rollout).

## Alternatives

- **Silent default to the most recently focused session** (first draft; rejected by the user): it makes the destination ambiguous, and a wrong guess puts text in an unrelated conversation.
- **`@path:12-30` / `#L12-30` syntax:** unsupported by OMP (above); it would silently disable the file read.
- **Pasting the selected code:** loses the file read and the line context, bloats the prompt and, in the TUI, hits the large-paste menu.
- **Writing through `vscode.window.terminal.sendText` or a page-originated paste:** the managed terminal is not a VS Code terminal, and a page-originated paste would depend on the page's keyboard focus and on the xterm instance's own idea of the mode; the pipeline already owns authoritative ordering, ownership and the PTY mode.
- **A webview→host acknowledgement for chat insertion:** every page→host message crosses the route-aware bridge table (`bridge.ts`, `bridge-listener.ts`, the lifecycle harness). The same reliability comes from posting only after the document's `omp:ready` and a page-side holding queue; `postMessage`'s own result reports a page that is gone.
- **Listing every stopped session in the catalog:** hundreds of history rows would bury the open ones; Sessions already opens them.

## Risks and Open Questions

- The hidden DECSET 2004 assumption is unobserved on a real ConPTY session until the isolated-window proof; it is covered headlessly by the pipeline's fake writer and the real TUI source above.
- A page that survives a host-only restart has no panel handle to reveal or write to, so such a session is not offered in the picker; Sessions' own Open reconnects it.
- The line note is bracketed (`[lines 12-30]`), not parenthesised: the TUI expands emoticons at submit, and a bare `8)` after whitespace is read as one, so a parenthesised range such as `(lines 8)` could be rewritten.
- OMP expands `@` mentions only in a prompt sent while the session is idle: a steering message or a follow-up queued during a running turn is sent verbatim (`agent-session.ts:7723-7733` is inside `prompt()`). The status bar says so when the target is mid-turn.
- `@` mentions read the file from disk: unsaved editor changes are not included, and a picker/status notice says so. OMP reads only the head of a large file.
- Which component the TUI has focused may be a selector rather than the prompt; a paste then goes there. The host paste is also not ordered against keystrokes typed in the page at the same instant.
- Choosing "New session in <folder>" registers a folder the launcher did not list; the picker row says "adds this folder to OMP folders" in that case.
- A session whose composer is replaced by an ask dialog between the pick and delivery refuses with a message; its draft is never written.
- `alt+shift+k` can be taken by a user's other extension; it is a default, rebindable.

## Rollout and Verification

Implemented with focused tests (`editor-context.test.ts`, `terminal-pipeline.test.ts`, `lib/insert-text.test.ts`, `messages.test.ts`, one `chat-ui.test.ts` scenario in owned Chromium), the full suite, then an isolated installed-window proof: a selection added to a Chat and a Terminal session, the picker with two sessions and the status message.

## Related Decisions

None new: the work reuses [ADR-0039](../decisions/0039-refuse-only-on-a-verified-live-writer-the-extension-owns.md) (ownership), [ADR-0040](../decisions/0040-switch-one-editor-between-rpc-chat-and-native-pty.md) (one editor, two modes) and [ADR-0043](../decisions/0043-place-session-mode-actions-in-editor-title.md).

## Architecture Review

- Reviewer: architect
- Outcome: changes required (resolved) — the architect found seven must-fix items (boot-time subscription for `omp:insert-text`, ready tracking for a passive-then-active page, bracketed note format, panel-less sessions offered, repeated reveal, mention expansion limits, unsaved files) and eleven minors. All were addressed in this change and the architect then confirmed the fixes in a short re-check, with no material findings left (non-blocking nits applied; orchestration tests for the passive-ready, panel-less and reveal-once fixes are not written).
- Notes: see Risks and Open Questions for the limits that remain documented rather than removed.
