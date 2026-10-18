---
status: accepted
date: 2026-10-19
---

# ADR-0078: Show LaTeX math as Unicode text from a project-owned converter

## Context and Problem Statement

Agents answer with LaTeX in Markdown (`$x^2$`, `$$\int_0^1 f$$`, `\(…\)`, `\[…\]`, bare `\begin{align}` blocks). OMP's terminal UI turns these into Unicode text (`x²`, `∫₀¹ f`) and, for display math, a small stacked layout (fractions over a rule, matrices with tall brackets). Chat shows the raw TeX, so the reader decodes it in their head. The design [Rich Markdown in Chat](../designs/2026-10-19-chat-rich-markdown.md) closes that gap and has to choose how math is drawn.

Constraints that make the choice lasting:

- The transcript's Find and Quote work on the **shown text**: Find searches `markdownShownText` and paints ranges over the DOM's text nodes, and Quote maps a selection of the DOM's text back to the source through the inline pieces (`lib/markdown-inline.ts`, `lib/quote-capture.ts`; [quote design](../designs/2026-10-15-quote-chat-selection.md) §3). Whatever draws a formula must keep "the text the DOM shows equals the text the model says it shows".
- The Chat page's policy allows scripts from its nonce and the extension's resource origin, stylesheets from the nonce or the extension, fonts from the extension only (`guestCsp` in `src/host/guest-webview.ts`). `media/guest.js` loads on every Chat open (1.49 MB minified at the time of writing).
- Math appears in model text, which is untrusted. The renderer must never produce markup from it that the page did not choose.
- `$` is also the dollar sign: "costs $5 and $10" must stay prose.

## Considered Options

- **KaTeX (`katex` 0.18.x, already in `node_modules` as a dependency of `mermaid`, which the Mermaid design stubs out for size).** Real typography. Costs: a direct dependency (lockfile, notices, version drift against mermaid's own copy); about 270 KB of minified JavaScript in `guest.js` or a second lazily loaded script with its own loader; its stylesheet and about 20 font files shipped in the VSIX, served through a `<link>` in each guest document (`guest-webview.ts`), because `font-src` allows only the extension's origin and a nonce `<style>` cannot resolve relative font URLs. Its default output (`htmlAndMathml`) is HTML plus a hidden MathML copy of every formula, so the DOM text is not the shown text: Find would paint ranges over text nobody sees or skip it (`[aria-hidden=true]`), and a Quote of a selection that touches a formula would degrade to garbage text or drop it. The other outputs do not restore the invariant: `output: "html"` is positioned glyph spans (no hidden copy, but the DOM text is still the glyphs, not the TeX), and `output: "mathml"` still arrives as a string. Every variant is a string, so drawing it needs `dangerouslySetInnerHTML`, which this renderer deliberately has none of (`Markdown.tsx` header): the safety of the whole transcript would rest on KaTeX's `trust: false` plus an `innerHTML` sink.
- **Native MathML from a project-owned TeX-to-MathML tree.** Chromium in VS Code renders MathML Core, so a React tree of `<math>` elements needs no font files, no stylesheet and no HTML string. Rejected: it means writing and maintaining a second, larger converter than the Unicode one (a TeX parser plus the MathML mapping of every construct) for display-only quality, and the DOM text of a MathML tree is still the operators and identifiers, not a line Find and Quote can map to the source.
- **A Unicode converter owned by the project (chosen).** Same delimiters, same anti-currency rules and the same Unicode targets for the common commands as the TUI. Zero dependencies, bytes in `guest.js` in the tens of KB, no CSP change, no fonts, no HTML sink: a formula is one `<span>` of plain text, so the shown text *is* the DOM text and Find and Quote need no new rules (a formula is an inline token like a code span: selecting all of it quotes the TeX, selecting part of it quotes the shown text). Costs: typography is plain text. Deep nesting (a fraction inside a root inside a script), large operators with limits stacked above and below, and wide matrices read less well than in KaTeX; an unknown command shows as its literal `\name`.
- **Import the TUI's converter (`@oh-my-pi/pi-tui`).** Desk declares no OMP renderer package: its only OMP dependency, `@oh-my-pi/pi-wire`, supplies TypeScript content types and no runtime code. Importing `pi-tui` would add a renderer dependency whose converter emits ANSI colour and imports terminal state, and would tie the page's bytes to OMP's release cadence.
- **A hybrid (Unicode first, KaTeX after load for display math).** Two renderers and two shown-text models for one feature; rejected as the cost of both options for the benefit of neither.

## Decision Outcome

Chosen: **a project-owned LaTeX-to-Unicode converter** (`src/webview/lib/latex-math.ts` for delimiters, `latex-unicode.ts` for the inline text, `latex-block.ts` for the display layout), no new dependency.

- Delimiters and anti-currency rules follow OMP's grammar, read from OMP 18.11.1 (`pi-utils/src/math-delimiters.ts` for the spans and own-line blocks; `pi-tui/src/components/markdown.ts` lines 1035–1106 (`BARE_ENV_BEGIN`, `bareMathEnvBlockLength`: a block whose `\begin{…}` sits within three spaces of a line start, on the first line or after one `lhs =` line, ends at its `\end{…}` and holds no blank line) and `pi-tui/src/latex-to-unicode.ts` for the bare math environments): `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, own-line `$$` / `\[` blocks, and bare math environments. An escaped opener is literal. A `$` opener must not be followed by space or `$`; its closer must not follow a space or precede a digit; a `$` preceded by a space ends the search. "costs $5 and $10" and "$5-$10" are prose. One deliberate divergence: Desk's span grammar is **line-local for every delimiter** (the inline scan is per line), while OMP's `\(…\)` and `\[…\]` closers may cross a soft line break; such a span is raw text here.
- An inline span becomes one `<span class="omp-math">` whose text is the converted line; an own-line block becomes a block whose lines are the stacked layout, in the code-block leaf shape so Find sees its text and Quote degrades to the shown text, as for any block whose records disagree with the source.
- Math is recognised in the model's Markdown (the renderer's `emphasis` mode: the reply, thinking, and model-written prose in tool output and notices, quotes included) and never in text the user typed, never inside code spans or fences. SVG figures and charts are the reply text only; math follows `emphasis` because Find and Quote read the inline pieces without a React context.
- Bounded work: a fragment over 8,000 characters or nested deeper than 24 is shown as written by the converter; the inline scan does not search a line over 4,000 characters.
- Where Desk's behaviour differs from the TUI's: layout is limited to fractions, matrices, cases and aligned rows (no stacked big-operator limits); an unknown command shows as `\name` (the TUI shows the bare name); colour commands show their text only. For the common commands the targets are the TUI's.

### Consequences

- Positive: no dependency, no CSP, packaging or font change; Find and Quote keep one invariant; no HTML sink; the page's bytes grow by the converter only; for the common commands a reader moving between the two surfaces sees the same formula.
- Negative: typography is limited to what Unicode offers; the symbol tables and layout rules are ours to maintain when OMP's converter learns new commands (the shared grammar is small, the tables are data); formulas that need real two-dimensional layout beyond the supported structures read flat. If readers later need typeset math, KaTeX can be added behind the same token boundary as a new ADR that supersedes this one for display math; the grammar module is reusable.

## Related Documents

- [Rich Markdown in Chat: SVG figures, table charts and math](../designs/2026-10-19-chat-rich-markdown.md)
- [Quote selected Chat text into the draft](../designs/2026-10-15-quote-chat-selection.md), [Find in the conversation](../designs/2026-10-17-chat-find.md)
- [Render `mermaid` fenced blocks in Chat as diagrams](../designs/2026-10-13-chat-mermaid-diagrams.md) (stubs KaTeX out of its bundle)

## Architecture Review

- Reviewer: architect
- Outcome: accepted
- Notes: A first independent review (a separate reviewer agent, together with the design; findings 7 to 10 and 17 concern this ADR) was resolved in this text. A confirmation pass found those findings resolved and no new finding on this ADR; verdict "accept after changes" (the remaining changes concern the design). Accepted.
