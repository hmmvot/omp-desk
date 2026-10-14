// The esbuild options of the lazily loaded diagram renderer, `media/mermaid.js`.
//
// Kept out of `esbuild.mjs` so the chat-UI tests build the same bundle the extension ships
// (`src/webview/mermaid-ui.test.ts`) without running the whole build.
//
// `elkjs` (1.6 MB, EPL-2.0) and `katex` (needs a stylesheet and fonts the chat page does not ship) are
// replaced by stubs that throw; `src/webview/mermaid/entry.ts` fixes the layout to `dagre` and forbids a
// diagram from changing it, so ELK is never asked for. See docs/designs/2026-10-13-chat-mermaid-diagrams.md.
import { fileURLToPath } from "node:url";

const source = relative => fileURLToPath(new URL(`../src/webview/mermaid/${relative}`, import.meta.url));

/** @type {import("esbuild").BuildOptions} */
export const mermaidBuildOptions = {
  entryPoints: [source("entry.ts")],
  outfile: "media/mermaid.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    "elkjs/lib/elk.bundled.js": source("elk-stub.ts"),
    katex: source("katex-stub.ts"),
  },
  // Nothing debugs the renderer through a map, and a map of this bundle is about ten times its size.
  sourcemap: false,
};

/**
 * The diagram tab's own page script, `media/mermaid-preview.js`: the small page around the renderer (a status line, a toolbar, the
 * image). It does not contain mermaid; its document loads `media/mermaid.js` first.
 * @type {import("esbuild").BuildOptions}
 */
export const mermaidPreviewBuildOptions = {
  entryPoints: [fileURLToPath(new URL("../src/webview/mermaid-preview/main.ts", import.meta.url))],
  outfile: "media/mermaid-preview.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  define: { "process.env.NODE_ENV": '"production"' },
  sourcemap: false,
};
