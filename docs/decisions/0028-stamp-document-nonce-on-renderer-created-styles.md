---
status: accepted
date: 2026-09-27
---

# ADR-0028: Guard nonce stamping to this Webview document's created styles

> Narrowly amended by [ADR-0041](0041-allow-terminal-style-attributes-under-nonce-stylesheets.md): chat/native and shell documents also declare `style-src-attr 'unsafe-inline'` for renderer style attributes. This record's nonce/resource `style-src`, rejection of `style-src 'unsafe-inline'`, and owning-document `createElement` hook remain operative.

## Context and Problem Statement

The accepted [Sessions design](../designs/2026-09-26-sessions-and-in-tab-terminal.md) renders the real OMP terminal with xterm.js inside the existing Collab Webview. The guest CSP allows nonce-bearing styles and trusted extension resources, but not `unsafe-inline`. xterm 6.0.0's DOM renderer creates `<style>` elements at runtime for rows, viewport and theme. A headless Chromium check under this exact style policy found that a newly created style without the document nonce did not apply; with the nonce it did. CSSOM and adopted stylesheets applied, but xterm has no renderer option here to supply a nonce or redirect all of its internal stylesheets. Without a remedy, the terminal mounts but renders incorrectly.

The guest currently serves one bundled script with a per-document nonce; `script-src` also permits trusted extension resources through VS Code's `cspSource`. Terminal bytes are rendered as terminal data, not as script or HTML. Any JavaScript already executing in this document could mutate CSSOM, so the nonce on a script-created style is not intended as a separate privilege from executing trusted script.

## Considered Options

- Allow `style-src 'unsafe-inline'`: simple but broadens style execution for markup that the trusted bundle did not create; reject.
- Fork/patch xterm or replace its DOM renderer to inject a nonce or adopted stylesheet: narrower integration in principle, but maintenance and version drift disproportionate to one guarded document-level hook; reject until the renderer provides a supported nonce option.
- Before mounting xterm, wrap `Document.prototype.createElement` with an owning-document receiver check: only `<style>` elements created through that document's `createElement` call, and lacking a nonce, receive its nonce. This preserves the existing CSP without a dependency fork; choose it with a narrowly scoped implementation and browser proof. An instance-level wrapper is narrower still, but the receiver-guarded hook retains the renderer's normal document API and makes other documents in the realm unaffected.

## Decision Outcome

The Webview bundle reads the nonce from its own nonce-bearing script tag and, before constructing the renderer, installs an idempotent `createElement` wrapper. It delegates to the original and stamps only previously unnonced `<style>` elements when the receiver is the captured owning document. The hook is installed on that realm's prototype once; its module-local idempotence assumes one document per Webview bundle instance. It does not intercept `createElementNS`, parser or `innerHTML` creation, `cloneNode`, `importNode`, or documents in other realms; such elements may nevertheless have a nonce for independent reasons. It is not a sanitizer or a provenance check. The host retains exactly one nonce-bearing guest script, `script-src` allows that nonce and trusted extension resources via `cspSource`, and `style-src` remains nonce-bound with trusted extension resources but no `unsafe-inline`; the existing restrictive `connect-src` remains. A separate folder-shell Webview has its own document, realm and nonce. No nonce or terminal data is persisted in Webview state.

### Consequences

- Positive: under the existing CSP, an isolated headless Chromium smoke test of the terminal Webview observed four style elements with none missing the nonce, rendered a terminal snapshot and subsequent output text, and measured one xterm row span as `display: inline-block`. This does not prove that every renderer, theme or scrollbar rule applied.
- Negative: replacing a DOM prototype method is a realm-wide compatibility hook, with a receiver guard for this document only. Keep it idempotent, test a second document in the same realm and actual CSP behavior, and revisit it when xterm gains a supported nonce/style injection API or changes its renderer. The extension's own stylesheet injector also creates styles through this path. JavaScript already executing in this document can read the nonce through DOM APIs and manipulate CSSOM; stamping its created styles is not a separate security boundary. Trust in the nonce-bearing bundle and permitted extension-resource scripts remains the security boundary.
- Limit: a headless browser proof is not proof that the installed VS Code Webview rendered correctly; that remains a separate acceptance gate.

## Related Documents

[Sessions design](../designs/2026-09-26-sessions-and-in-tab-terminal.md), [ADR-0024](0024-own-omp-pty-for-in-tab-terminal.md), [ADR-0023](0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md).

## Architecture Review

- Reviewer: independent architect (initial and corrective reviews).
- Outcome: accepted after receiver-scope, trust-boundary and evidence corrections.
- Notes: The hook now checks the installing document as receiver; source comments acknowledge permitted extension-resource scripts and non-intercepted creation APIs; browser evidence is limited to four observed styles and a representative xterm rule. Reviewer found no remaining material architecture issue. Installed VS Code rendering is still unverified.
