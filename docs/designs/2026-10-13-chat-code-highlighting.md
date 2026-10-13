---
status: accepted
date: 2026-10-13
---

# Syntax highlighting in Chat code blocks, coloured by the active editor theme

## Problem

Fenced code in Chat is plain text (`<pre><code>`), so a TypeScript or C# reply reads very differently from the same code in the editor. The maintainer wants the fenced blocks highlighted with **the colours of the active VS Code colour theme**, so code in Chat looks like code in the editor in any theme, keeping the code block background as it is. A second decision from the maintainer belongs to the same theme-colour work: inline code (a back-ticked span) takes the theme's string colour on a tint of it, and looks the same before and after it becomes a file or symbol link.

Two facts shape the design:

- A Webview is given workbench colours as `--vscode-*` CSS variables, **never token colours**. The editor's TextMate token colours are not reachable from page code.
- Highlighting runs on the page main thread, inside a transcript that is virtualised and streams, in a document whose CSP allows no `unsafe-eval`, no `wasm-unsafe-eval` and no network.

## Goals and Non-goals

- **Goals**
  - Fenced blocks in the common languages (ts/tsx/js/jsx, json, py, cs, ps1, bash/sh, html/xml, css, md, yaml, diff, rust, go, c/cpp) show the active theme's token colours and font styles. Unknown or absent languages stay plain.
  - The host resolves the themes that may be active (with the user's customizations) and sends them to every page; the page uses the one VS Code says is active, by its theme id. A theme the host did not send gives plain code, never a wrong one.
  - Large blocks never stall the page; a block that is still streaming costs nothing until it settles; the transcript layout does not move when a block is coloured.
  - High Contrast keeps the theme's own colours; Copy copies the plain text; the file/symbol link features of inline code keep working.
  - Inline code: text in the theme's `string` colour on the same colour at 14 % (item B below).
- **Non-goals**
  - Semantic token colours (the editor gets them from a language server; Chat has none) and the editor's bracket-pair colourisation, indent guides or `editor.fontLigatures`.
  - TextMate-exact tokenization. The token classification approximates the editor's grammars; the measured agreement is recorded below and the gap is stated, not hidden.
  - A setting to turn highlighting off, new languages beyond the list, highlighting in tool-result bodies (plain `pre`), diffs of Edit rows, or the terminal.
  - `.tmTheme` (plist) themes referenced from `tokenColors`: such a theme is left out (VS Code loads a string `tokenColors` as a plist, which Desk does not read); other themes still go.

## Current State

- `Markdown.tsx` (`parseBlockRange`) renders a fence as `<div class="omp-code-block"><pre><code data-language="…">source</code></pre><CopyButton text={source}/></div>`. `parseMarkdown` reuses the blocks of the previous parse while a reply streams, so only the unfinished tail is parsed again. `pre` has `overflow-x: auto` and no wrapping.
- Fenced code has no file or symbol links ("fenced code stays text" is asserted in `chat-ui.test.ts`); the link features belong to inline code spans (`.omp-md code .omp-file-link`, `.omp-file-link > code`, `.omp-symbol-search`).
- Host to page delivery of window-level presentation (`omp:terminal-font`, `omp:chat-display-preferences`) goes through the pages a `ChatRuntime` has attached for a conversation: the editor panel, the bridge route that survives Reload Window, and detail tabs. A page is re-sent its state on `omp:ready` and on a route re-ack (`ChatRuntime.resend`). `omp:chat-display-preferences` is re-sent on every state change and every snapshot, so it is the wrong carrier for a 10 to 25 KB theme.
- The guest CSP is `style-src 'nonce-…' ${cspSource}; style-src-attr 'unsafe-inline'; script-src 'nonce-…' ${cspSource}; connect-src 'none'`. A single IIFE bundle (`media/guest.js`, 1.10 MB minified at this commit) is the only script.

## Proposed Design

### A. Fenced code

#### A1. Where the colours come from (host)

VS Code's extension API exposes the **kind** of the active theme and nothing else about it. Verified against `@types/vscode` 1.110 and the installed workbench source (`resources/app/out/vs/workbench/workbench.desktop.main.js`):

| Fact | Where verified | Use |
|---|---|---|
| `window.activeColorTheme: ColorTheme` has only `kind` (Light, Dark, HighContrast, HighContrastLight); `window.onDidChangeActiveColorTheme` fires with it | `vscode.d.ts` | cross-check of the resolved theme's kind; change trigger |
| The theme is named by settings: `workbench.colorTheme`; with `window.autoDetectColorScheme` the OS scheme picks `workbench.preferredDarkColorTheme` or `…LightColorTheme`; with `window.autoDetectHighContrast` an OS high-contrast mode picks `…HighContrastColorTheme` or `…HighContrastLightColorTheme` | workbench `getPreferredColorScheme`, the `Zyr` kind-to-setting map | which setting names the active theme |
| A contributed theme's settings name is `id ?? label ?? basename(path)`; `Default Dark Modern`, `Default Light Modern`, `Default Dark+`, `Default Light+` are legacy aliases of `Dark Modern`, `Light Modern`, `Dark+`, `Light+` | workbench `fromExtensionTheme`, `Zft` | finding the contribution |
| Themes come from extensions: `extension.packageJSON.contributes.themes[]` (`id?`, `label`, `uiTheme`, `path`) and `extension.extensionPath`; `extensions.onDidChange` fires on install, update and removal | `vscode.d.ts`; built-in `theme-defaults/package.json` has `id` and `uiTheme` for each theme | enumeration |
| A theme file is JSONC. `include` (relative to the including file) is loaded **before** the file's own rules, so the file's rules come later; `tokenColors` is an array, or a string path to another file; the legacy `settings` array is also accepted; a rule without `scope` sets the editor's default colours, not a token colour | workbench `Han` | resolution order |
| Token rules are `[ default, …theme rules, …customization rules ]`. `editor.tokenColorCustomizations` supplies, in this order: the group shorthands (`comments`, `strings`, `keywords`, `numbers`, `types`, `functions`, `variables`, each a colour string or a settings object, expanded to fixed scope lists), then `textMateRules`; then the same two for every `[Theme Name]` key that matches the theme's settings name (`*` wildcards at either end) | workbench `tokenColors`, `addCustomTokenColors`, `getThemeSpecificColors`, `Pan` | customization |

The host core (`src/host/code-theme.ts`, no `vscode` import) takes plain inputs (the kind, the settings values, the customizations value, the list of contributed themes with their extension paths, a `readFile`) and returns the candidate `CodeTheme[]` (possibly empty):

1. Collect the candidate settings names: `workbench.colorTheme` first, then `workbench.preferredDarkColorTheme`, `…LightColorTheme`, `…HighContrastColorTheme` and `…HighContrastLightColorTheme`. The host does **not** decide which one is active: VS Code picks a `preferred…` setting from the operating system's state (`autoDetectHighContrast`, `autoDetectColorScheme`), not from the theme's kind, so inferring it from the kind is wrong for a non-default high-contrast theme chosen while the OS is not in high contrast. The page knows the exact theme: VS Code writes the active theme's settings id to `data-vscode-theme-id` on every webview's `<body>` on every theme change (the terminal renderer and the measured rows already observe it). Legacy aliases (`Default Dark Modern` → `Dark Modern`, `Experimental Dark` → `Dark 2026` and the like) only map a setting's value to a contribution.
2. Find each contribution whose settings name matches (`id ?? label ?? basename(path)`, extension kept, as VS Code names it; manifests are already translated when extensions are scanned, so no `%key%` lookup). Keep the contributions whose `uiTheme` matches the active kind: that bounds the message to at most three themes and drops a stale preferred theme of another kind. The result is deduplicated by settings id.
3. Load each file and its `include` chain with a JSONC reader (comments and trailing commas; depth ≤ 8, a visited-set against cycles, a regular file of at most 1 MiB checked with `stat` before reading). A missing or unreadable file, a JSON error, a non-object, or a string `tokenColors` (VS Code reads that as a plist) makes **that theme** unusable and it is left out (no half theme); the others still go. A legacy `settings` array makes the file's own `colors` and `tokenColors` ignored, as in VS Code.
4. Append the customization rules in VS Code's order: all matching `[Theme]` blocks are merged first (arrays concatenated, single values last-wins; a key may name several themes, `[A][B]`), then the group shorthands, then `textMateRules`.
5. Normalise every rule: string scopes split at commas and trimmed (array elements are not split), `foreground` only as a hex colour, `fontStyle` reduced to the four known words (any string sets the field, `""` or `normal` clears), rules that set neither dropped, rules without a scope dropped, `fontFamily`, `fontSize` and `lineHeight` ignored. A rule with more than 64 selectors is split into several rules in order. Bound the result (1,500 rules, 200 characters per selector, 96 KiB serialised per theme); over a bound that theme is left out.

`src/wiring/code-theme-wiring.ts` is the thin part: it reads `vscode.workspace.getConfiguration`, `vscode.extensions.all` and `vscode.window.activeColorTheme`, calls the core with `fs.readFile`, and re-resolves (debounced 100 ms, latest resolution wins by generation counter, result compared with the last one) on `onDidChangeConfiguration` for the settings above and `editor.tokenColorCustomizations`, `onDidChangeActiveColorTheme` and `extensions.onDidChange`. It writes one Output line per resolution (the ids and rule counts, or why there is none) and never reads or writes anything the user did not already configure.

**Known limits:** while the theme picker previews a theme, VS Code rewrites `data-vscode-theme-id` without writing a setting, so the previewed theme is not among the candidates and Chat shows plain code until the choice is made or cancelled. The attribute is a webview DOM contract, not part of `vscode.d.ts`; if a future VS Code drops it, the first candidate is used.

#### A2. The message and its delivery

```ts
interface CodeThemeRule { scopes: string[]; foreground?: string; fontStyle?: string }
interface CodeTheme { id: string; rules: CodeThemeRule[] }
type ChatCodeThemeMessage = { type: "omp:chat-code-theme"; themes: CodeTheme[] }   // chat-messages.ts, host to page
```

`src/chat/code-theme.ts` holds the types and the validator, used on the host before sending and on the page on arrival (the themes are an extension's JSON, so untrusted data: colours are hex literals only, selectors a bounded character class; at most three themes with distinct ids). The message is not epoch-bound. `ChatRuntime` gets an optional `readCodeThemes()`; it posts the message to a page in `attachPage` and at the top of `resend`, **independent of whether a conversation exists yet** (so on `omp:ready`, a route re-ack and a bridge rebind, with the editor panel, the surviving bridge route and detail tabs all covered by the one path), and `refreshCodeThemes()` posts it to every attached page. The runtime port exposes `refreshCodeThemes()` next to `refreshDisplayPreferences()`. The page treats the same themes arriving again as a no-op. A page that has not received the message (an older host, an empty list) highlights nothing.

#### A3. Tokenizing and colouring (page)

- **Tokenizer: highlight.js 11 (`highlight.js/lib/core` plus the 15 languages).** Alternatives and measurements are in the ADR. It tokenizes; `src/webview/lib/code-tokens.ts` then **names tokens with TextMate scopes** (`keyword.control.ts`, `entity.name.function.ts`, `support.type.property-name.json`, `string.quoted.double.html` …) from per-language tables in `code-languages.ts` and a classifier for the words highlight.js leaves unmarked (a call, a member, a type, a constant, a shell command or option). Every scope carries the language suffix a TextMate scope has, and the stack starts with the language root (`source.ts`), so rules such as `source.powershell variable.other.member` apply.
- **Matcher: `code-theme-style.ts`** implements the matching of `vscode-textmate`, the code that colours the editor: dotted-prefix scope match, descendant and `>` selectors against the enclosing scopes, specificity (longer scope, then more enclosing segments), a later rule overriding the fields it sets on the same selector, a more specific scope starting from the less specific rules, and a token's style being its innermost scope's rule over the style of the outer scopes. Results are cached per scope stack.
- **Fidelity, measured, and theme-dependent.** The page pipeline was compared character by character (non-blank characters, colour within 12/255 per channel and font style) with Shiki 4.5 using its own (normalised) copies of the TextMate grammars VS Code ships, against the same theme file, on a hand-written 14-language sample set of about 8,000 characters. The scope tables were tuned on these samples against Dark Modern, so the Dark Modern figures are in-sample: Dark Modern 94.1 %, Light Modern 89.9 %, High Contrast (black) 88.9 %, High Contrast Light 89.9 %. By language in Dark Modern: json 98.5, yaml 99.2, diff 100, py 98.6, css 98.3, html 97.1, ts 95.3, sh 94.6, cpp 93.1, go 92.9, cs 91.1, md 89.8, ps1 89.5, rust 87.3. The architecture review reran the oracle with the 2026 themes that are this VS Code build's defaults: **Dark 2026 82.3 %** (cpp 66.4, rust 72.1, ps1 76.1, ts 77.9) and **Light 2026 84.9 %**. Those themes colour scopes the page never emits (the enclosing `meta.block`, `meta.object.member`, `meta.brace.round` get a near-default grey; parameters, properties, member functions and access modifiers get their own hues). Painting everything in the default colour scores 18 % to 16 %, so the metric is meaningful. Semantic token colours (Dark Modern and Dark 2026 enable them in the editor) are not counted, so "differs" means differs from the editor's TextMate layer. The consequence is stated plainly: Chat shows **the theme's colours with the editor's usual scope-to-colour mapping, approximated**, roughly 94 % of characters in the theme the tables were tuned on and 82 % to 85 % in the 2026 themes. A held-out sample and a marketplace theme are not measured; the per-language tables are data that can be improved against the same oracle, and host-side tokenization is the documented way to higher fidelity (see the ADR).

#### A4. Rendering: lazy, bounded, streaming-safe, layout-stable

`CodeBlock.tsx` replaces the inline `<pre>` of `Markdown.tsx`.

- **Plain first, always.** The block renders exactly today's markup (`<pre><code data-language>{source}</code></pre>` and Copy) on first paint; colouring only changes `color`, `font-style`, `font-weight` (monospace: same advance width) and `text-decoration` of spans, never line breaks or heights, so the transcript does not jump. `source` is never altered: the spans' text concatenated is the source (asserted by a test for every language), and Copy still receives the plain `source`.
- **Lazy.** Tokenizing runs in a task queue, one block per task (a zero-delay timer task), started after the first paint, newest first so the block the user is looking at is coloured before older history; a block that unmounts withdraws its queued task, and a block whose tokens are cached renders coloured at once on remount. The result is cached by `(language, source)` (bounded, 64 entries) so scrolling, virtualisation remounts and theme changes never tokenize twice. A theme change re-styles from the cache.
- **Size cap and task budget.** A block over 10,000 characters or 400 lines stays plain. One tokenize is one uninterrupted task and cannot be split by an idle callback; measured on the development machine in Node 24, a TypeScript or HTML block at 20,000 characters takes about 100 ms (first run) and 60 to 75 ms warm, over the 50 ms a task may take before typing and scrolling stutter, so the cap holds a block to about half of that. The budget is "at most about 50 ms per task"; a longer block would need chunked tokenizing, which highlight.js 11 cannot resume, so it stays plain.
- **Streaming.** A fence that is still open (no closing line yet) is highlighted only after its text has not changed for 400 ms; a fence that has closed is highlighted at the next queued task. While an open block grows after being coloured, the coloured prefix stays (only while the new text starts with the text that was coloured) and the new tail is plain until the next settle, so a paused stream does not flicker; the last word of the prefix may change class at the next settle. A reply that ends inside an unclosed fence settles through the same timer.
- **Theme and language absent.** No theme message, an empty list, a page id with no entry, an unknown language or a tokenizer failure render the plain block. The page never throws from highlighting. `Markdown` (so `CodeBlock`) also renders in the Ask dialog, child transcripts and detail views; fenced code there is coloured the same way. Tool-result bodies are plain `pre` blocks and stay plain.
- **High Contrast.** The theme's own rules apply unchanged (the High Contrast themes ship token colours designed for their black or white editor); `pre` keeps its background. Colours are not derived or mixed, so no contrast the theme guarantees is lowered. Plain text inside a coloured block uses `--vscode-editor-foreground`, the colour the editor uses for unscoped text.

### B. Inline code (maintainer decision, 2026-10-13)

`.omp-md code` takes `--omp-inline-code` as its text colour and `color-mix(in srgb, var(--omp-inline-code) 14%, transparent)` as its background. The page sets `--omp-inline-code` on the document root from the active theme: the colour of the scope `string.quoted.double` from the same matcher (a rule for `string`, `string.quoted` or `string.quoted.double` applies). Until a theme arrives, or when it has no string colour, the CSS default is `var(--vscode-debugTokenExpression-string)` and then the preformatted-text colours. `debugTokenExpression.string` is a registered workbench colour (defaults `#ce9178` dark, `#a31515` light, `#f48771` High Contrast dark, `#a31515` High Contrast Light, read from the workbench source) that VS Code writes as a CSS variable for every registered colour; no shipped theme file defines it. Fenced `code` also matches `.omp-md code`, so `.omp-md pre code` resets colour and background explicitly.

A link inside code, or code inside a link (`.omp-md code .omp-file-link`, `.omp-file-link > code`, `.omp-web-link > code`, `.omp-symbol-search`), keeps the same colour and background; the link is marked only by an underline (`text-decoration-color: color-mix(in srgb, currentColor 55%, transparent)`, `text-underline-offset: 2px`, dotted for symbol search, solid `currentColor` on hover). Plain and linked inline code therefore compute the same colour and background, and a span that is linked after it first appears does not change.

High Contrast (`.vscode-high-contrast`, `.vscode-high-contrast-light`) keeps today's look: no tint, theme colours (`--vscode-textPreformat-foreground` text). Contrast of the string colour on the code span (the string colour over the panel with 14 % of itself mixed in) is checked for WCAG AA in Dark Modern and Light Modern during implementation; a failing combination is reported with the smallest adjustment rather than changed silently.

## Alternatives

Colour source:

- **Read the colours in the page.** Impossible: no token colour variables exist and a Webview cannot read the workbench's token map.
- **Fixed palettes per theme kind** (what the built-in Markdown preview does with highlight.js stylesheets). Zero host work, but it does not follow Monokai, Solarized, a user's `tokenColorCustomizations` or any marketplace theme, which is the request.
- **The host tokenizes** with VS Code's own grammars (`contributes.grammars` of installed extensions) and sends styled runs. Highest fidelity and every installed language, but it needs a TextMate engine and an Oniguruma implementation in the extension host bundle, runs per block on the extension host's shared event loop (which also runs the session runtime), and needs a request/response per block, per settle and per reconnect through the bridge. Rejected for cost and risk; remains the way to a higher fidelity if the measured gap proves too wide.
- **Carry the theme in `omp:chat-display-preferences`.** Free delivery, but that message is re-sent on every conversation state change and snapshot; a 10 to 25 KB theme there is repeated needlessly.

Tokenizer (detail and numbers in the ADR): Shiki or `vscode-textmate` with the VS Code grammars in the page (exact scopes; 2.0 MB minified for 16 grammars, a 0.5 s main-thread stall on the first TypeScript block and 1.2 s on C++, an Oniguruma wasm needing `wasm-unsafe-eval` or a JS regex translation engine); Prism (smaller, coarser scopes, no change in maintenance prospects); Lezer (no C#, PowerShell, shell or diff parsers); a project-owned tokenizer per language (the maintenance of 15 grammars).

## Risks and Open Questions

- **Approximation.** Roughly one character in ten differs from the editor; the differences are concentrated in languages the maintainer reads less often in Chat (Rust 87 %, PowerShell 89 %, C# 91 %). A theme rule for a scope the page does not emit does not apply. Mitigation: the per-language tables are data, improved against the same measurement; the measurement is a documented, repeatable procedure.
- **highlight.js grammar changes.** Pinned to an exact version; the tests assert the scopes of fixed snippets per language, so an upgrade that changes classification fails visibly.
- **Theme file reading.** Theme JSON is arbitrary extension content: bounded sizes, include depth and cycle guard, validation on both sides, and `null` on any doubt.
- **Remote and non-local extensions.** OMP Desk is a Windows `ui` extension; a theme contributed only by an extension in a remote host is not in `extensions.all` of the UI host and gives plain code.
- **Live theme switch.** Event handling is covered by wiring tests with a fake `vscode`; a real window switching theme has to be observed separately (not done at design time).
- **CSS variable of the registered colour.** `--vscode-debugTokenExpression-string` is expected in a Webview because VS Code writes every registered colour; the headless harness supplies its own variables, so the real value in a window has to be confirmed in an installed run.

## Rollout and Verification

1. Contract and tokenizer: `src/chat/code-theme.ts`, the message and its parser, `code-theme-style.ts`, `code-languages.ts`, `code-tokens.ts`, `highlight.js` pinned in `package.json`, `THIRD_PARTY_NOTICES.txt`.
2. Host: `src/host/code-theme.ts` (core) with tests (include chains, precedence, customizations, `[Theme]` blocks, wrong kind, missing theme), `src/wiring/code-theme-wiring.ts`, `ChatRuntime` and port methods, `extension.ts` wiring.
3. Page: the theme store, `CodeBlock.tsx`, `.omp-md pre` styles, inline code styles (B).
4. Tests: matcher and tokens-to-colours per language; streaming and settle; a `chat-ui.test.ts` harness test that a `ts` block renders coloured spans for a supplied theme and Copy yields the plain text; a `theme-ui.test.ts` or `chat-ui.test.ts` check that plain and linked inline code compute the same colour and background.
5. Visual proof: headless screenshots of ts, py and json blocks in Dark Modern, Light Modern and High Contrast, compared with the colours of the real theme files under the VS Code installation.
6. Docs: `architecture.md`, `CHANGELOG.md` (one Added line for both items), this design's status.

## Related Decisions

- [ADR-0067: Highlight Chat code with highlight.js scopes matched against the active theme's rules, resolved by the host](../decisions/0067-highlight-chat-code-with-highlightjs-and-host-resolved-theme-rules.md)
- [Chat visual refresh](2026-10-13-chat-visual-refresh.md): R4 keeps the editor code-block background, which this design leaves unchanged.

## Architecture Review

- Reviewer: architect (independent, read-only), one pass
- Outcome: accepted after fixes; see the ADR's Architecture Review for the findings and what was applied
- Notes: the page now picks the active theme by `data-vscode-theme-id`; fidelity is stated per theme; caps follow a 50 ms task budget; delivery no longer depends on a conversation. Open for the maintainer: accepting that fidelity is about 94 % on the tuned Dark Modern sample and 82 % to 85 % on the 2026 default themes.
