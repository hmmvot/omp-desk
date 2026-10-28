/**
 * The webview build maps `.css` imports to their text.
 *
 * `scripts/terminal-bundle.mjs` gives the terminal renderer bundle a `text` loader for `.css`, so
 * `@xterm/xterm/css/xterm.css` arrives as a string inside `media/terminal.js` and is
 * injected into a nonce'd `<style>` element (`./lib/terminal-renderer.ts`). TypeScript
 * has no notion of that mapping, so this is the one declaration that states it.
 */
declare module "*.css" {
	const stylesheet: string;
	export default stylesheet;
}
