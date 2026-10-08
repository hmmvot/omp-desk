/**
 * Write selected terminal text to the user's clipboard from inside the Webview.
 *
 * The user's keystroke is the gesture: the asynchronous Clipboard API accepts it in a
 * focused document, and the legacy `copy` command (which makes xterm put its own
 * selection on the clipboard) covers a webview host that refuses the former. A program
 * in the terminal can never reach either: the escape sequence that would write the
 * clipboard has no handler in the renderer.
 */
export async function writeTerminalClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		try {
			return document.execCommand("copy");
		} catch {
			return false;
		}
	}
}
