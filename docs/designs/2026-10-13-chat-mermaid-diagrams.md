---
status: accepted
date: 2026-10-13
---

# Render `mermaid` fenced blocks in Chat as diagrams

## Problem

Agents in the maintainer's sessions answer with ```` ```mermaid ```` fenced blocks (8 so far, mostly flowcharts and sequence diagrams). Chat shows them as code, so the reader has to render the diagram in their head. Chat should draw them, follow the VS Code theme, stay safe with untrusted model output, and never make the page heavier for the replies that have no diagram.

## Goals and Non-goals

- Goals:
  - A closed ```` ```mermaid ```` block in the **assistant's reply text** becomes an inline diagram; an unfinished block, a broken diagram, an unsupported diagram type, a source over the limits and a renderer that cannot load all stay a code block, with one muted line saying why where there is a reason. The same fence in a user message, in thinking or in a tool result is shown exactly as before.
  - The renderer is loaded from the extension's own files only when the first diagram needs it. `media/guest.js`, the document policy and `localResourceRoots` do not change.
  - Dark, Light, High Contrast and High Contrast Light themes follow the VS Code theme and re-render on a theme change; a reader who asked for reduced motion gets no edge animation.
  - Diagram | Source toggle, Copy copies the source, a wide diagram scales to the width and opens full size on click or from the keyboard.
- Non-goals: opening a diagram in its own editor tab, exporting SVG/PNG, editing a diagram, rendering `mermaid` in user messages, thinking, tool results or the terminal, KaTeX math in labels, the ELK layout engine, interactivity of any kind (`click`, tooltips, links).

## Current State

- `Markdown.tsx` parses a fence to `<CodeBlock language source closed>`; `closed` is false while the closing fence has not arrived. `CodeBlock` colours the text with highlight.js scopes against the active theme (ADR-0067) and has a hover Copy button.
- The guest document (`createGuestHtml`, `createDetailHtml`) carries `default-src 'none'; img-src ${cspSource} data:; font-src ${cspSource}; style-src 'nonce-N' ${cspSource}; style-src-attr 'unsafe-inline'; script-src 'nonce-N' ${cspSource}; connect-src …`. No `unsafe-eval`, no network. Every chat/detail/shell panel uses `localResourceRoots: [media]`.
- `adoptNonceForCreatedStyles` (ADR-0028) already stamps the document nonce on `<style>` elements script creates with `document.createElement`.
- esbuild builds one IIFE per document (`media/guest.js` was 1,207,273 bytes before this work); `.vscodeignore` ships `media/**` except maps; `media/guest.*` is Git-ignored.

## Proposed Design

### Library and delivery

Use the **`mermaid` npm package, pinned (12.2.0), bundled as its own IIFE `media/mermaid.js`**, built by a new esbuild target from `src/webview/mermaid/entry.ts` (its options live in `scripts/mermaid-bundle.mjs`, which the UI test builds from too). The entry imports mermaid, fixes its configuration (below) and publishes one global, `ompMermaid = { contract, render }`. Nothing in `guest.js` imports `mermaid` at run time, only the page-side loader, theme reader, cache and block (about 12 KB minified of the page's 1.3 MB; the rest of the growth of `guest.js` since the baseline is other work). The build **fails** if the `mermaid` target's metafile contains an input under `node_modules/elkjs` or `node_modules/katex`, or if the `guest` target's contains `node_modules/mermaid` or `node_modules/@mermaid-js`.

Two upstream pieces are excluded at bundle time by esbuild `alias` to stubs that throw:

- **ELK** (`elkjs`, 1.6 MB, EPL-2.0). Mermaid 12.2.0 defaults to the `elk` layout; the build sets `layout: "dagre"` and puts `layout` in mermaid's `secure` list, so no diagram can ask for ELK. `dagre-d3-es` is MIT and is what mermaid used before 12.
- **KaTeX** (268 KB, needs `katex.css` and fonts the page does not ship). A label with `$$…$$` fails to render and falls back to source.

Measured (esbuild `--minify --format=iife --target=es2022`, Windows, Node 24):

| Candidate | Bytes | gzip | Diagram types | Notes |
|---|---|---|---|---|
| **mermaid 12.2.0, ELK and KaTeX stubbed** | 3,480,667 | 965,484 | all of mermaid except ELK layout and math | chosen |
| mermaid 12.2.0 as published | 5,255,690 | 1,484,452 | all | adds EPL-2.0 `elkjs` and KaTeX; default ELK layout |
| `@mermaid-js/tiny` 12.2.0 (prebuilt) | 2,804,485 | 740,865 | no mindmap, architecture, KaTeX | a CDN artefact "not meant to be installed from npm", built outside this repository's lockfile, no source map or notices for what it contains |
| `beautiful-mermaid` 1.1.3 | 1,632,629 | 492,549 | flowchart, state, sequence, class, ER, XY chart | different renderer, no gantt/pie/journey/git/timeline; depends on `elkjs` (EPL-2.0); one year of releases |
| mermaid, ESM with `splitting` (106 chunk files) | 5,220,166 total | – | all | loads only needed chunks, but needs `type=module`/`import()` of 106 files from a webview resource origin, where a module script is a CORS request with its own failure modes; unproven in VS Code, and 106 files in the VSIX |

A single classic script loads exactly as `guest.js` does. The cost of the choice is VSIX size (+0.97 MB gzip on a 3.08 MB package) and one 3.5 MB parse on first use; the measured first use in Edge is 173 to 200 ms for load plus parse, then the render itself (below). Pages that never meet a diagram pay nothing. ADR-0069 narrows ADR-0067's premise that the highlighter must be one bundle: mermaid is the one dependency large enough to justify a second file, and the split needs no change to the document or the host.

The page finds the file as a sibling of its own script: at start-up the loader reads `document.currentScript.src` (the same mechanism `readCspNonce` uses) and resolves `mermaid.js` against it. No host change, no new meta tag, no new command. The script is added with the document nonce (`script.nonce`), which `script-src 'nonce-N' ${cspSource}` accepts, and from `${cspSource}` in any case.

`ompMermaid.contract` is a small integer both sides compile in. A page whose `guest.js` is older than `mermaid.js` (a same-version reinstall while the page stayed open) refuses the mismatched renderer and shows the block as source with "Diagram renderer is out of date. Reload the window."

### CSP findings (measured in Edge against the exact `guestCsp` string)

| Question | Result |
|---|---|
| `unsafe-eval` | Not needed. No `eval`, no `new Function(…)` in the bundle. Three `Function("return this")()` occurrences are lodash's global lookup, behind `typeof self == "object" && self…`, which is true in a page, so they never run. No CSP violation was reported while rendering flowchart, sequence, class, state, ER, gantt, pie, mindmap and architecture diagrams (a hand-written probe page carrying the exact `guestCsp` string). |
| Network | No `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, dynamic `import(` in the bundle; ELK's `new Worker` is gone with the ELK stub. `connect-src` is untouched. |
| `<style>` | Mermaid creates one `<style>` per render with `document.createElement("style")` (and one in the measuring container). **Without** the nonce hook: 9 `style-src-elem` violations for 5 renders and the styles do not apply (hand-written probe, exact `guestCsp`). **With** `adoptNonceForCreatedStyles` already installed by the guest: 0 violations, both in the probe and in `mermaid-ui.test.ts`, which serves the extension's own `createGuestHtml` document. A negative control in that test inserts a nonce-less `<style>` and requires the violation to be recorded, so "0 violations" is a reading of a working detector. |
| Style attributes | Mermaid writes `style="…"` attributes; `style-src-attr 'unsafe-inline'` (ADR-0041) already allows them. |
| Images | `img-src … data:` allows the `data:image/svg+xml` image the diagram is shown as. |
| Scripts in output | `securityLevel: "strict"`: no `onclick`, no `click` callbacks, no `javascript:` links in the output of the probes; `<img onerror>` and `<script>` in labels were escaped. A `click A "https://…"` line still yields an `<a xlink:href>` in the SVG; inside an `<img>` a link is inert, and the test requires only that no handler and no script-scheme link is present. |

The CSP therefore needs no change; `media/mermaid.js` is within `localResourceRoots: [media]` of every guest panel.

### Security

The model's text is untrusted at four layers, each meant to hold if the next fails:

1. **Input limits**: a source over **8,000 characters or 80 statements** (non-blank parts of the text split on newlines and `;`) is never handed to mermaid (mermaid's own `maxTextSize` replaces an oversized text with a red "Maximum text size exceeded" diagram, so the page checks first; the renderer checks again). The statement cap is independent of the diagram type: a `maxEdges: 200` flowchart cap alone left class, state and mindmap diagrams unbounded (a 20,000-character source took 0.8 s to 7.4 s depending on type), and counting lines alone let a flowchart packed with `;` on one line cost 2.1 s. `block` diagrams (`block-beta`) are **not drawn** (refused by the page from the first keyword, and again by the renderer from the type mermaid itself detects): a line holds any number of blocks and 42 to 80 lines took 3.2 to 6.2 s, so no cap on lines or characters bounds them. The measured cost of the caps is in "Main-thread cost" below; it is a bound for the types measured, not a proof for every type, and the page can still be blocked for that long. `maxEdges` stays as a flowchart-only second bound. The SVG that comes back is refused over 1,500,000 characters or a `viewBox` side over 10,000 CSS pixels (a hostile `nodeSpacing: 100000` produced a 100,320 px canvas).
2. **Configuration**: `securityLevel: "strict"`, `htmlLabels: false` (no `foreignObject` in the flowchart, class and state diagrams; sequence diagrams have none either, other types are not claimed), `startOnLoad: false`, `suppressErrorRendering: true`. The `secure` list is extended with `theme`, `themeVariables`, `themeCSS`, `layout`, `look`, `fontFamily`, `fontSize`, `htmlLabels` and `darkMode`, so a diagram's own `%%{init}%%` or front matter cannot choose a theme, inject CSS, pick ELK or change the security level. Measured: `%%{init: {'theme':'forest','themeVariables':{…},'themeCSS':'…','layout':'elk'}}%%` and `securityLevel: loose` left the output unchanged.
3. **Display as an image**: the SVG string is never put into the page's DOM. It is shown as `<img src="data:image/svg+xml;charset=utf-8,…">`: scripts do not run in an SVG image, it cannot load a resource, reach the page's DOM or collide with its ids and CSS. Before that the renderer re-serializes the markup with `DOMParser` + `XMLSerializer` (mermaid returns HTML-serialized text, so a non-breaking space comes out as `&nbsp;`, which is not XML and makes the image fail to load) and removes the `nonce` attribute mermaid copies onto its `<style>`. The page decodes the image (`img.decode()`) before it is shown, so a bad image is a failure with the code kept, not a blank box.
4. **Document policy**: inline script and handlers are refused by `script-src` whatever the SVG contains; the page has no network.

What the renderer does **not** isolate: while it runs, mermaid builds the diagram in the page's own document (it measures text with `getBBox`, which needs layout, so a Worker or a detached document cannot do it). The measuring container is off screen, never focused, and emptied after every render (`replaceChildren`); mermaid's `<style>` there takes the page nonce through ADR-0028. The isolation is the image the page shows afterwards and the document policy during the render, not a sandbox around the render. Renders are serialized because mermaid's configuration is global as well as because of cost.

### Theme

The page resolves its theme on the page, because mermaid's `themeVariables` need concrete colours, not `var(…)`:

- The reader (`lib/mermaid-theme.ts`) resolves `--vscode-editor-background`, `--vscode-editor-foreground`, `--vscode-editorWidget-background`, `--vscode-panel-border`, `--vscode-contrastBorder`, `--vscode-textLink-foreground`, `--vscode-editorInfo-foreground`, `--vscode-font-family`, `--vscode-font-size` from `getComputedStyle(document.body)` (`<body>` inherits what VS Code sets on `<html>`, so a rule on either is seen), parses `#rgb[a]`, `#rrggbb[aa]` and `rgb[a]()`, flattens alpha on the background and mixes in JS (computed `color-mix()` results are `color(srgb …)`, which khroma, mermaid's colour library, cannot read). It also reads `prefers-reduced-motion`; when set, `themeCSS` switches off the edge animations (`animate: true` edges) and the media query is watched like the theme.
- Mermaid `base` theme with `darkMode` from the background's luminance. Node fill is the widget background (the editor background in High Contrast), node border and cluster border the panel border (the contrast border in High Contrast), lines and arrow heads 70 % foreground (100 % in High Contrast), text the editor foreground, label backgrounds the editor background, notes and actors drawn from the same few colours. Pie, gantt and git slices come from mermaid's own derivation from the primary, secondary and tertiary colours, which are tints of one accent.
- A **theme key** (all the resolved values joined, plus the motion preference) names the theme in the cache; a result is cached under the theme the render was **requested** in, never the one current when it finished. A `MutationObserver` on `<html>` (`style`, `class`) and `<body>` (`class`, `data-vscode-theme-id`), the elements VS Code rewrites on a theme change, recomputes the key and, when it changed, notifies every mounted diagram. A diagram keeps showing its previous image until the one for the new theme is ready, so a theme change does not blank the transcript. A theme change during a render lets that render finish under its own key and then draws the diagram again in the new theme (tested with a 300 ms render).

### Streaming, cache and layout

- `Markdown.tsx` passes the existing `closed` flag. An unclosed block is a plain code block (no render, no toggle, no Copy difference): the source of a growing block changes on every token, and one render is up to half a second.
- A closed block renders once per `(theme key, source)` **while its result stays in the cache**. Results, including failures, are kept in a bounded map (8 MB of SVG text, least recently used first). A remount (the transcript unmounts rows that leave the window, a tab switch with `retainContextWhenHidden`) reads the cache synchronously in its first render, so a diagram that was drawn does not flicker or draw again. A theme change, or an entry evicted for room, draws the diagram again: that cost repeats.
- Renders run **one at a time**, in the order the blocks were first asked for, each in its own task, so the transcript keeps taking input between diagrams. A block that unmounts before its turn withdraws its request.
- **Layout**: the block shows its source while the chunk loads and the diagram renders, and swaps to the image once. That is **one reflow per diagram, accepted**: the height of a diagram is only known after layout, and a reserved placeholder of a guessed height would be wrong for most diagrams and jump anyway. After it, the image has explicit `width`/`height` from the SVG's `viewBox`, so a remount or a theme change keeps the geometry. The transcript's measured rows (`MeasuredRows`) already re-measure on a height change.
- The first mermaid block of a page loads `mermaid.js` once (a failed load is remembered and not retried in that page; the block says "Diagram renderer unavailable").

### UX

- A closed, rendered block is `.omp-mermaid`: the image in a bordered box that scales to the width (`max-width: 100%; height: auto`), a toolbar at the top right with **Diagram | Source** (two toggle buttons, `aria-pressed`) and **Copy** (copies the source, never the SVG). The image is itself a button: click, Enter or Space toggles **full size** (natural size, horizontal scroll, `aria-pressed`); it is disabled while the diagram already fits.
- Source view is the ordinary `CodeBlock` (so it is highlighted when ADR-0067's tokenizer knows mermaid, plain otherwise) without its own Copy button (the toolbar has it).
- The choice (Diagram or Source, fit or full size) is remembered per source text for the life of the page, so scrolling a row away and back keeps it.
- Failure: the code block and one muted line under it: `Diagram not rendered: <first line of mermaid's message, 160 characters at most>`; the over-limit case says `The source is over 8,000 characters` or `…over 80 statements`, and `Block diagrams are not drawn`; a diagram too large says `The diagram is too large`; the renderer failure says `Diagram renderer unavailable`. `role` is not `alert`: this is a normal state of a reply, not an error of the product.
- High Contrast: the image box has the contrast border; the diagram's own colours are the theme's foreground and background.
- `alt` text: `Mermaid <kind> diagram`, where kind is the first keyword after any front matter, `%%{init}%%` directive or `%%` comment (`flowchart`, `sequenceDiagram`, …), and `diagram` when there is none. The model's source is **not** put in `title` or `alt`; the toolbar offers Source for a reader who wants the text.

### Tests

- `src/webview/lib/mermaid-theme.test.ts` (node): colour parsing and mixing, High Contrast, light and dark `darkMode`, a missing variable, reduced motion.
- `src/webview/mermaid-ui.test.ts` (owned Edge/Chrome, the extension's own `createGuestHtml` document and policy, the renderer built from the same options as `npm run build`): flowchart and sequence render as an `<img>` whose SVG is a real diagram; a source with U+00A0 decodes (the `&nbsp;` regression); a broken diagram and an unknown diagram show source plus one muted line; the toggle and Copy; the zoom control by click and by keyboard; an unclosed block shows source and loads nothing; a transcript with no mermaid block never requests `mermaid.js`; a remount and the same source do not re-render; another theme draws again, and a theme change during a render ends in the new theme; an over-limit source is refused without loading mermaid; a missing renderer (404) and a contract mismatch are reported once; the same fence in a user message, thinking and a tool result stays code; a hostile diagram leaves no script, handler or `foreignObject` in the image; no `securitypolicyviolation` is reported, after a negative control that proves the detector sees one.
- `src/webview/markdown.test.ts` covers the eligibility context (`AssistantReplyContext`) that the block reads.
- Screenshots of the same diagrams in Dark Modern, Light Modern, High Contrast and High Contrast Light, committed under `.omp/workspace/notes/assets/mermaid/` (local notes).

## Alternatives

- **A page-side mermaid inside `guest.js`**: +3.5 MB (about 3 times) on every chat page for a feature most replies do not use. Rejected by the task.
- **Render in the host and send SVG**: the host would need a DOM (no `jsdom` is bundled) or a hidden webview; a second renderer to keep alive and a protocol type for results. Rejected.
- **Inline SVG instead of `<img>`**: selectable text and the page's font inheritance, but the model-influenced markup then lives in the page DOM, shares its ids and CSS, and its safety rests on DOMPurify alone. Rejected for isolation; the measured visual result is the same.
- **`securityLevel: "sandbox"`** (mermaid renders into an `<iframe sandbox>`): needs `frame-src` in the document policy (a `data:` or `blob:` source) and a second document per diagram. Rejected: it widens the policy this design keeps unchanged, and the `<img>` already gives the isolation that matters.
- **mermaid 11.x** (dagre by default, no ELK dependency, a smaller bundle): considered because 12.x made ELK the default. 12.x is the maintained line, the build already pins the layout and stubs ELK, and 11.x would trade a stated configuration for a line that receives no new diagram types. Staying on 12.2.0.
- **Rendering in a Worker**: mermaid measures text with `getBBox` on live DOM, which a Worker does not have. Impossible without a different renderer.
- **Mermaid's native `startOnLoad` / `mermaid.run` on a DOM node**: mutates the page's DOM and cannot be cached by source and theme. Rejected.
- **A click-to-render button** (or "Render anyway" above the limits): safest and the cheapest, but the ask is that the diagrams appear. A block over the limits stays source; no override is offered, so an unusually large diagram can never freeze the page.

## Risks and Open Questions

- **A real VS Code webview was not exercised**: the CSP, the nonce hook and the data-URI image are measured in Edge against the exact policy string and the extension's own `createGuestHtml`, not inside VS Code's `vscode-cdn` webview origin. The remaining differences (the origin of `cspSource`, service-worker resource loading, `retainContextWhenHidden`) apply equally to `guest.js`. Unlike `guest.js`, the renderer is a script the page inserts itself and finds through its own script's URL, so those two steps (and the nonce on the inserted script) are exercised only by the owned-browser harness. `media/mermaid.js` is deliberately not in the package-drift file list: only the page uses it, the `contract` number covers a mismatch, and hashing 3.5 MB at activation is wasted work.
- **Main-thread cost**: a render is one uninterruptible task in the page and cannot move to a Worker. Measured on the shipped bundle in Edge, warm, with 80 statements (the cap): a flowchart of 80 edges 450 ms, a class diagram 411 ms, block 331 ms, state 324 ms; 120 lines of class or state 1.0 to 1.2 s (over the cap, so refused); a 20,000-character source 0.8 s to 7.4 s depending on type (mindmap 7.4 s, class 4.7 s, state 4.3 s), which is why the caps are on characters and statements, and block diagrams are refused by type. The first diagram of a page adds 173 to 200 ms of load and parse. A failure (a parse error, "too large") is cached by source alone, so a theme change does not repeat it; a theme change repeats the cost for every mounted diagram, one at a time, and an entry evicted from the cache repeats it when the block returns.
- **Product decision (reported to Main)**: the alternative to a lower limit was to render large sources and accept a disclosed freeze (or show a "Render anyway" button). This design chose the lower limit and no override: a reply with 81 statements of mermaid stays readable source.
- **Upstream**: mermaid changes defaults between majors (12.x chose ELK); the version is pinned and the configuration states every behaviour it depends on. Licences of the 61 packages in the mermaid bundle's dependency tree are recorded in `THIRD_PARTY_NOTICES.txt`; the build's metafile check keeps ELK and KaTeX out of the renderer and mermaid out of the page.

## Rollout and Verification

0. Not done: a check in a real VS Code window (an ADR-0064 end-to-end scenario or an installed isolated profile). It is the open verification item.

1. esbuild target `mermaid`, entry and contract; `.gitignore`, package dependency, notices.
2. Theme reader, loader and cache, `MermaidBlock`, `Markdown.tsx` branch, styles.
3. Tests and screenshots; `npm run typecheck`, the focused tests, `npm run build`.
4. CHANGELOG, architecture, README.

## Related Decisions

- [ADR-0069](../decisions/0069-load-mermaid-as-a-separate-local-script-and-show-diagrams-as-svg-images.md)
- [ADR-0028](../decisions/0028-stamp-document-nonce-on-renderer-created-styles.md), [ADR-0041](../decisions/0041-allow-terminal-style-attributes-under-nonce-stylesheets.md): the style rules mermaid relies on.
- [ADR-0067](../decisions/0067-highlight-chat-code-with-highlightjs-and-host-resolved-theme-rules.md): the Chat code block this block falls back to.

## Architecture Review

- Reviewer: architect
- Outcome: accepted after fixes
- Notes: three passes. First: type-independent source limits, XML re-serialization of the SVG (`&nbsp;`), assistant-only rendering, test detector control, SVG size caps, reduced motion, build boundary check, honest isolation wording, more alternatives. Second: limits count statements (`;` splits a line), block diagrams are not drawn, failures are cached by source. Third: the block refusal also uses mermaid's own detected type (`mermaid.parse`) and a line-anchored front matter pattern, so a `---` inside a header value cannot hide a block diagram. Left open by agreement: the bundle boundary check does not run under `--watch`; a real VS Code window was not exercised.
