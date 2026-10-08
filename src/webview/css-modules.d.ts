/**
 * The webview build maps `.css` imports to their text.
 *
 * `esbuild.mjs` gives the webview bundles a `text` loader for `.css`, so
 * `@xterm/xterm/css/xterm.css` arrives as a string inside the single bundle and is
 * injected into a nonce'd `<style>` element (`./lib/terminal-styles.ts`). TypeScript
 * has no notion of that mapping, so this is the one declaration that states it.
 */
declare module "*.css" {
	const stylesheet: string;
	export default stylesheet;
}
