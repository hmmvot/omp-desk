---
status: accepted
date: 2026-10-13
---

# ADR-0067: Highlight Chat code with highlight.js scopes matched against the active theme's rules, resolved by the host

## Context and Problem Statement

Chat's fenced code blocks should be coloured like the editor, with the active colour theme's token colours. Two choices are lasting and have real alternatives: where the theme's token colours come from, and which tokenizer runs in the page. See [the design](../designs/2026-10-13-chat-code-highlighting.md) for the flow, limits and tests.

Constraints: a Webview has no token colour variables; the guest document's CSP allows no `unsafe-eval`, no `wasm-unsafe-eval` and no network; the page runs one IIFE bundle (1.10 MB minified before this change) on the main thread that also renders a streaming transcript; the languages that matter are ts/tsx/js, json, py, cs, ps1, bash/sh, html, css, md, yaml, diff, rust, go and c/cpp.

## Considered Options

Measured on this repository with esbuild `--minify` (IIFE, es2022) and Node 24 on the maintainer's machine:

| Option | Size added to the page bundle | Startup and per-block cost | CSP | Scope quality |
|---|---|---|---|---|
| **highlight.js 11.12 core + 15 languages** | 81.5 KB (26.6 KB gzip) | grammars compile on first use of a language; tens of milliseconds for 20 KB | none needed | token classes (`keyword`, `title.function`, `string`, `attr` …); TextMate names must be derived |
| Prism 1.30, same languages | 55.0 KB (19.7 KB gzip) | similar | none needed | coarser token classes than highlight.js (one `keyword`, no `built_in`/`title` split) |
| Lezer (`@lezer/highlight` plus the language packages) | not bundled | – | none needed | has no C#, PowerShell, shell or diff parser; tags, not TextMate scopes |
| Shiki 4.5 core + JS regex engine + 16 TextMate grammars | 2,038 KB (235 KB gzip) | 93 ms to create, **498 ms first TypeScript block (8,000 chars), 1,166 ms first C++ block, 458 ms for 64 KB of TSX** on the main thread | JS engine needs none; the Oniguruma engine needs `wasm-unsafe-eval` (not granted) | **exact**: the grammars VS Code ships, real scope stacks |
| `vscode-textmate` in the host (optionally in a `worker_threads` worker), styled runs sent to the page | 0 in the page | a request and reply per block and per settle round through the bridge, a staged entry file (ADR-0012), grammars of installed extensions to find; a worker avoids blocking the shared extension host but not the plumbing | none | exact, and every installed language; highest cost and risk, the documented way to higher fidelity |
| Shiki in a page `Worker` from a `blob:` URL | as Shiki | off the main thread | needs `worker-src blob:` and, for the Oniguruma wasm, `wasm-unsafe-eval` or the JS regex engine | exact; a CSP addition that needs security acceptance |

Theme colour source:

- **Host resolves the active theme's rules and sends them** (the settings, the contributing extension's theme JSON with its `include` chain, `editor.tokenColorCustomizations`).
- Fixed palettes per theme kind: ignores the user's theme.
- Page-side access: impossible, no such variables or API exist in a Webview.

## Decision Outcome

1. **The host resolves the themes that may be active to bounded lists of TextMate rules and sends them to every Chat page** (`omp:chat-code-theme`, up to three themes keyed by settings id, carried by the `ChatRuntime` page routes, posted when a page attaches and on every resend whether or not a conversation exists, and re-sent on change). The host does not decide which is active: VS Code picks a `preferred…` setting from OS state, not from the theme's kind, so inferring it is wrong in a common configuration and fails silently. The page knows the exact theme (`data-vscode-theme-id` on `<body>`, rewritten by VS Code on every theme change; already observed by the terminal renderer) and uses the entry with that id; an id with no entry gives plain code. It is the only route that follows the user's theme and customizations. The core is `vscode`-free (`src/host/code-theme.ts`), the wiring thin.
2. **The page tokenizes with highlight.js and names each token with the TextMate scopes the language's grammar in VS Code gives it**, then matches the theme's rules with the algorithm of `vscode-textmate`. Shiki and the TextMate grammars are exact but cost 25 times the bytes and half a second to over a second of main-thread stall on the first block; the stall cannot be hidden on a page that must stay responsive and the wasm engine is not permitted. highlight.js beats Prism on scope granularity (the theme colours `if`, `const`, `public` and a class name differently) at 26 KB more, and has every required language, unlike Lezer.
3. The cost of option 2 is **fidelity**, and it depends on the theme. Against Shiki with VS Code's grammars (Shiki's normalised copies) and the same theme, character colours agree on 94.1 % (Dark Modern), 89.9 % (Light Modern), 88.9 % (High Contrast) and 89.9 % (High Contrast Light) of a 14-language, 8,000-character sample on which the scope tables were tuned (in-sample); the architecture review measured **82.3 % in Dark 2026 and 84.9 % in Light 2026**, the default themes of the installed VS Code, because those themes colour scopes (`meta.*`, parameters, properties, member functions, access modifiers) the page does not emit. A held-out sample and marketplace themes are not measured. This gap is accepted, recorded and reported to the maintainer; the per-language tables are data that can be improved against the same measurement, and host-side tokenization (optionally in a worker thread) is the documented way out if it proves too wide.

### Consequences

- Positive: Chat code follows any installed theme and the user's token customizations; the bundle grows by about 82 KB; no CSP change; highlighting is synchronous, cached and cheap enough to run lazily; languages not listed stay plain.
- Positive: the matcher is the editor's own algorithm, so scopes the page emits colour exactly as the editor would colour the same scopes.
- Negative: classification is an approximation of the TextMate grammars (about one character in ten differs from the editor in the tuned sample, about one in six in the 2026 themes); a new highlight.js release can change classification, so the version is pinned and scopes are asserted by tests; highlight.js regexes run on untrusted model output, so blocks are capped (10,000 characters, 400 lines); a runtime dependency (BSD-3-Clause) joins `THIRD_PARTY_NOTICES.txt`.
- Negative: the host reads other extensions' theme files (bounded, validated, read-only); the theme picker's preview is not followed (the previewed theme is not among the candidates, so code is plain until the choice is made); `data-vscode-theme-id` is a webview DOM contract, not `vscode.d.ts` API.

## Amendment 2026-10-13: the language set

The first cut covered 15 fence languages. It grew to 43 canonical ids (40 highlight.js grammars; `gitignore` and `hcl` have none, so two small scanners in `code-mini-languages.ts` emit highlight.js's HTML shape and share the one classifier). The selection follows what Chat shows: the most used languages of the Stack Overflow Developer Survey 2024 and the GitHub Octoverse language ranking that highlight.js can tokenize (Java, Kotlin, Swift, PHP, Ruby, SQL, Scala, Dart, R, Perl, Lua, Haskell, Elixir, Objective-C, Groovy), plus the configuration and build formats agents write constantly (Dockerfile, Makefile, TOML, INI/`.editorconfig`, `.properties`, HCL/Terraform, Nginx, Windows batch, `.gitignore`/`.dockerignore`, GraphQL, Protocol Buffers). Aliases are matched case-insensitively against the first word of the fence info (`ps1`, `cmd`, `Dockerfile`, `tf`, `kt`, `rb`, `yml`, …); `text`, `plaintext`, `txt`, `mermaid` and unknown ids stay plain (`mermaid` is handled by the diagram renderer, not by highlighting).

- **Fidelity**, same method as above (agreement of non-blank character colours with Shiki and Dark Modern, tolerance 12/255, hand-written samples per language): Dockerfile 95 %, INI 97 %, `.properties` 93 %, Nginx 91 %, R 91 %, PHP 91 %, Scala 91 %, Lua 86 %, HCL 85 %, SQL 84 %, Kotlin 83 %, Java 81 %, Ruby 79 %, TOML 79 %, GraphQL 79 %, Dart 78 %, Perl 77 %, Protobuf 76 %, Groovy 73 %, Haskell 72 %, Swift 71 %, Bat 70 %, Elixir 65 %, Makefile 63 %, Objective-C 64 %; 81.7 % over the 25 new languages (the first 14 stay at 93 % to 96 % in-sample). Shiki has no `.gitignore` grammar and VS Code's builtin one colours only `#` comments, so negation and glob colours there are this project's convention. VS Code has no builtin grammar for Kotlin, Scala, Haskell, Elixir, GraphQL, Protobuf, Nginx, HCL, TOML or Dart; their scope conventions come from the marketplace grammars Shiki ships. The weak languages (Makefile, Objective-C, Elixir, Haskell) are those whose highlight.js grammar is coarse; they are still better than plain text and are documented here rather than hidden.
- **Cost and loading**: `media/guest.js` grew from 1,207,273 to 1,283,657 bytes (+76 KB, gzip 345,918 to 369,453, +23 KB) for the 25 grammars and the scope tables. Grammars are registered on first use (`engineFor`), so the parse and compile cost is paid only for languages a conversation shows; the bytes are still in the IIFE bundle because the Webview bundle has no code splitting under the CSP.

## Amendment 2026-10-13: tool cards

Code in tool cards is highlighted by the same mechanism, because the same reader sees file content as tool results as in fenced blocks. Scope: the content of Write and Create (also while streaming), Read and Find snippets, Edit and patch diff lines, Eval cells, Grep and symbol match lines, and a bash, python or powershell command in the card header. The language is chosen from the file name, then the extension, through the fence alias table (`languageForPath`); unknown stays plain. The caps do not move: within 10,000 characters and 400 lines the whole text is tokenized once (cached, queued after first paint, settled for 400 ms while it streams); beyond them only the visible window is tokenized, up to the caps. A diff is tokenized as two files, the old side (context and removed lines) and the new side (context and added lines), so multi-line constructs hold inside a hunk; across a gap between hunks they are cut, which can mis-colour a few lines after an unterminated string or comment that opens in a different hunk. Highlighting adds only coloured spans inside the existing line elements, so line numbers, signs, diff backgrounds, wrapping, Copy and expansion are unchanged.

## Related Documents

- [Design: syntax highlighting in Chat code blocks](../designs/2026-10-13-chat-code-highlighting.md)
- [ADR-0065](0065-enforce-one-import-direction-between-source-layers.md): the layering the host core and wiring follow.

## Architecture Review

- Reviewer: architect (independent, read-only)
- Outcome: accepted after fixes
- Notes: First pass found four material issues, all resolved in this version: (1) the host guessed the active theme from settings and kind (wrong for a non-default high-contrast theme, incomplete aliases), so the page now picks by `data-vscode-theme-id` among host-sent candidates; (2) fidelity was reported in-sample and for Dark Modern only, now stated per theme with the 2026 results and escalated to the maintainer; (3) the 20,000 character cap measured about 100 ms per task, now 10,000 characters and 400 lines; (4) delivery depended on a conversation existing, now posted from `attachPage` and the top of `resend`. Minor findings applied: theme file reading rules, fair alternatives, streaming prefix and remount behaviour, inline code scope, scope of Markdown consumers. Not done: a held-out fidelity sample and a marketplace theme (recorded as not measured); no second confirmation pass was run.
