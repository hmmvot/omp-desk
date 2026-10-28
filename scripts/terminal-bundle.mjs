// The esbuild options of the lazily loaded terminal renderer, `media/terminal.js`.
//
// Kept out of `esbuild.mjs` so the chat-UI tests build the same bundle the extension ships
// (`src/webview/chat-ui.test.ts`) without running the whole build.
//
// xterm.js, its fit and Unicode 11 addons and xterm.css (imported as text: the renderer puts it in a nonce'd `<style>` element)
// live only here; `guest.js` and `shell.js` carry none of them (`esbuild.mjs` fails the build otherwise).
import { fileURLToPath } from "node:url";

/** @type {import("esbuild").BuildOptions} */
export const terminalBuildOptions = {
  entryPoints: [fileURLToPath(new URL("../src/webview/terminal/entry.ts", import.meta.url))],
  outfile: "media/terminal.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: false,
  loader: { ".css": "text" },
  define: { "process.env.NODE_ENV": '"production"' },
};
