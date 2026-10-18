# Send code to a session

- Use **Add File to Session** from the editor tab, editor, or Explorer context menu or the Command Palette.
- Pick the session. OMP Desk inserts an `@path` reference into its Chat or Terminal.
- It never sends the prompt for you.

**Add Selection to Session** (`Alt+Shift+K`) was removed in 0.4.7: to put selected code into a Chat draft, use `Alt+Q` or **Quote Selection to Session**, which carries the file, the lines and the text as a quote, and with nothing selected inserts a reference to the caret's line (`` `src/app.ts:42` ``); see [quoting Chat text](chat.md#quoting-chat-text) and [Keyboard shortcuts](keyboard-shortcuts.md). An `@path` mention of a file made an idle OMP read the whole file, which is why a line is referenced as inline code.
