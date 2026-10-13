---
status: accepted
date: 2026-10-13
---

# ADR-0069: Render Chat's mermaid blocks with the `mermaid` package loaded lazily from its own local script, shown as isolated SVG images

## Context and Problem Statement

Chat should draw fenced ```` ```mermaid ```` blocks. Lasting choices with real alternatives: which renderer, how it reaches the page without enlarging the chat bundle or the document policy, how its output is isolated from untrusted model text, and what the page does while a block streams. See [the design](../designs/2026-10-13-chat-mermaid-diagrams.md) for the flow, limits, measurements and tests.

Constraints: the guest document allows scripts only from its nonce and the extension's resource origin, styles only through a nonce or that origin plus style attributes, images from that origin and `data:`, no `unsafe-eval` and no network; every panel's `localResourceRoots` is `media/`; the chat page is one 1.2 MB IIFE that already renders a streaming transcript; model output is untrusted; one render is a single uninterruptible main-thread task.

## Considered Options

| Option | Bytes (minified IIFE) | Verdict |
|---|---|---|
| **`mermaid` 12.2.0, ELK and KaTeX stubbed, own lazy IIFE `media/mermaid.js`** | 3,480,667 (965,484 gzip) | chosen |
| `mermaid` 12.2.0 unmodified, own lazy IIFE | 5,255,690 (1,484,452 gzip) | adds EPL-2.0 `elkjs` and unusable KaTeX for +0.5 MB gzip; ELK is a new default of 12.x |
| `mermaid` 11.x | smaller, dagre by default | not the maintained line; the build already pins the layout and stubs ELK |
| `@mermaid-js/tiny` | 2,804,485 | CDN artefact, no mindmap/architecture, outside the lockfile, no notices of its contents |
| `beautiful-mermaid` | 1,632,629 | six diagram types, different look from every other mermaid renderer, depends on `elkjs` |
| Mermaid inside `guest.js` | +3.5 MB on every chat page | rejected: pays for it on every page |
| ESM + code splitting (106 chunks) | 5.2 MB over 106 files | needs module loading of 106 files from a webview resource origin (CORS requests), unproven in VS Code |
| `securityLevel: "sandbox"` | – | needs `frame-src` in the document policy and an iframe per diagram |
| Render in a Worker | – | impossible: mermaid measures text with `getBBox` on live DOM |
| Click to render | – | safest, but the ask is that diagrams appear |
| Host-side rendering | – | needs a DOM in the host or a hidden webview |
| Inline SVG in the page | – | model-influenced markup in the page DOM; safety rests on one sanitizer |

## Decision Outcome

1. **Library**: the `mermaid` package at an exact version, bundled by esbuild as a separate IIFE `media/mermaid.js` from `src/webview/mermaid/entry.ts` (options in `scripts/mermaid-bundle.mjs`), with `elkjs` and `katex` aliased to stubs that throw. The layout is `dagre`, and `layout` is in mermaid's `secure` list, so a diagram cannot ask for ELK. A diagram needing ELK or math is shown as source with a muted line. The build fails if ELK or KaTeX enter the renderer or mermaid enters the page bundle. This narrows ADR-0067's premise that the chat page is one bundle: one extra file, loaded only on demand.
2. **Delivery**: the chat page loads `mermaid.js` on the first closed mermaid block, as a nonce'd classic script whose URL is the sibling of the page's own script (`document.currentScript.src`). No change to `createGuestHtml`, to the document policy or to `localResourceRoots`; no new message, setting or command. A one-integer `contract` on `ompMermaid` makes a page and a renderer from different builds refuse each other.
3. **CSP**: no `unsafe-eval` and no network (neither occurs in the bundle; all diagram types probed rendered with zero violations). Mermaid's injected `<style>` is stamped by the existing `adoptNonceForCreatedStyles` (ADR-0028), without which the same render raises style-src-elem violations; no directive changes.
4. **Security**: `securityLevel: "strict"`, `htmlLabels: false`, `suppressErrorRendering`, a source limit of **8,000 characters and 80 statements** (newline- or `;`-separated parts) checked before mermaid is loaded, and block diagrams (`block-beta`) are not drawn at all (measured 3 to 6 s however small the source), `maxEdges: 200` for flowcharts, a refusal of an SVG over 1,500,000 characters or 10,000 CSS pixels on a side, and `secure` extended with `theme`, `themeVariables`, `themeCSS`, `layout`, `look`, `fontFamily`, `fontSize`, `htmlLabels`, `darkMode`. The SVG is re-serialized as XML (an HTML-serialized `&nbsp;` would break the image) and displayed as a `data:image/svg+xml` `<img>`, never inserted into the page DOM. Only the assistant's own reply text is eligible; user messages, thinking and tool results keep the code block. Rendering itself happens in the page's document (it needs layout) in an off-screen container that is emptied afterwards; the isolation is the image plus the document policy, not a sandbox.
5. **Theme**: mermaid `base` with `themeVariables` computed on the page from the VS Code CSS variables read on `<body>` (concrete colours, alpha flattened, mixed in JS), a theme key (including reduced motion) in the cache, and re-render when a `MutationObserver` on `<html>`/`<body>` or the motion media query sees the key change; the previous image stays until the new one is ready.
6. **Streaming and cache**: only a closed fence is rendered; an unclosed block is the ordinary code block. Results (also failures) are cached by `(theme key, source)` in a bounded LRU; renders are serialized, one task each. The swap from source to image is **one accepted reflow**; after it the image has explicit geometry, and remounts read the cache synchronously. A theme change or an eviction draws again.
7. **Fallback and UX**: any failure shows the code block and one muted line, never a throw; Diagram | Source toggle and Copy of the source; the image fits the width and opens full size with scrolling on click or from the keyboard.

### Consequences

- Positive: all mermaid diagram types the dagre layout supports; the chat bundle grows only by about 12 KB of glue; pages without a diagram load nothing; no policy change; the diagram is never inserted into the page's DOM as markup (it is rendered in an off-screen container of the page and shown as an image); theme, streaming and failure behaviour are explicit and tested.
- Negative: the VSIX grows by about 0.97 MB (gzip, on 3.08 MB) and the install by 3.5 MB; the first diagram of a page pays about 170 to 200 ms of load and parse plus the render; a render blocks the page (measured at the limits, warm: 0.3 to 0.45 s for 80 statements in the flowchart, class and state types measured; a theme change repeats it per diagram); sources over 80 statements or 8,000 characters, and block diagrams, stay code with no override, because larger ones measured up to 7 s; the caps bound the types measured, not every type; ELK and KaTeX are unsupported on purpose; a diagram is an image (not selectable); the dependency tree of `mermaid` (61 packages, one release line per month) enters `THIRD_PARTY_NOTICES.txt` and the build's metafile check needs revisiting on every upgrade; behaviour inside a real VS Code webview origin is not exercised by the headless tests.

## Related Documents

- [Design: render mermaid blocks in Chat](../designs/2026-10-13-chat-mermaid-diagrams.md)
- [ADR-0028](0028-stamp-document-nonce-on-renderer-created-styles.md), [ADR-0041](0041-allow-terminal-style-attributes-under-nonce-stylesheets.md): the nonce-stamped style and style-attribute rules this relies on.
- [ADR-0067](0067-highlight-chat-code-with-highlightjs-and-host-resolved-theme-rules.md): the code block used for the source view and the fallback.

## Architecture Review

- Reviewer: architect
- Outcome: accepted after fixes
- Notes: three passes. First: type-independent source limits, XML re-serialization of the SVG (`&nbsp;`), assistant-only rendering, test detector control, SVG size caps, reduced motion, build boundary check, honest isolation wording, more alternatives. Second: limits count statements (`;` splits a line), block diagrams are not drawn, failures are cached by source. Third: the block refusal also uses mermaid's own detected type (`mermaid.parse`) and a line-anchored front matter pattern, so a `---` inside a header value cannot hide a block diagram. Left open by agreement: the bundle boundary check does not run under `--watch`; a real VS Code window was not exercised.
