---
status: accepted
date: 2026-10-02
---

# ADR-0041: Allow terminal style attributes while retaining nonce-gated stylesheets

## Context and Problem Statement

The native-session and folder-shell webviews use xterm 6's DOM renderer. Its row factory applies RGB foreground/background and cell styling with `setAttribute("style", ...)`. The existing nonce-only `style-src` permits the stylesheet elements covered by [ADR-0028](0028-stamp-document-nonce-on-renderer-created-styles.md), but does not permit style attributes. In an isolated VS Code window, actual OMP output contained `color:#f84fcc` attributes while the CSS declaration was rejected and the computed color stayed gray; browser CSP violations confirmed the cause. This is color loss in the consumer, not missing ANSI bytes or an OMP color/environment setting.

## Considered Options

- Enable inline styles through `style-src`: ignored while a nonce is present, so it would require dropping the nonce and admitting every unnonced stylesheet element; broader than required. Attribute hashes cannot cover arbitrary renderer-computed RGB values.
- Rewrite renderer attributes, fork xterm, or interpose on `setAttribute`: private renderer coupling and redundant styling machinery; unnecessary.
- Switch to the public WebGL renderer: a separate rendering/dependency choice, not required to correct this demonstrated DOM/CSP mismatch; glyph parity is investigated separately.
- Explicitly allow style attributes while keeping the existing stylesheet, script and network policy: the direct correction for the renderer's supported behavior.

## Decision Outcome

Add `style-src-attr 'unsafe-inline'` only to the chat/native and shell documents. `style-src` remains nonce/resource-gated, as does `script-src`; `default-src`, images, fonts, bridge-only/no-connection policy, base URI and form policy remain unchanged. The bounded unavailable/explanation document is unchanged. Keep ADR-0028's owning-document stylesheet nonce hook.

This permission applies to **all style attributes in these documents**, not exclusively attributes created by xterm. Terminal bytes remain terminal data, never inserted as HTML or script. Trusted scripts could already change CSSOM; the change does not grant script execution or add an origin. It nevertheless permits attribute styling if markup reaches the document, so the distinction from nonce-gated stylesheet elements must stay explicit.

The user approved this bounded policy correction. Actual-factory-CSP Chromium coverage exercises ANSI 16-color theme palette, 256-color and RGB foreground/background through both snapshot and continuing-output paths. Installed-window verification remains a separate gate recorded in the design ledger.

### Consequences

- Positive: the genuine terminal's colors and cell style attributes can apply without altering OMP output or adding a renderer fork.
- Negative: style attributes are no longer nonce-restricted in chat/native and shell documents. Unnonced stylesheet elements and scripts remain restricted; markup/data separation remains important.
- Limit: this changes CSS permissions, not font coverage. A font without a requested Nerd Font codepoint still cannot render it.

## Related Documents

- [Same-editor Chat and native Terminal design](../designs/2026-10-02-same-editor-chat-and-native-terminal.md)
- [ADR-0028](0028-stamp-document-nonce-on-renderer-created-styles.md), amended only for the previously implicit style-attribute restriction; its stylesheet decision remains operative.

## Architecture Review

- Reviewer: independent architect.
- Outcome: accepted after reciprocal-amendment recording.
- Notes: No security/ownership boundary issue. F1 accepted: record the narrow amendment in ADR-0028, the index and the active design. F2 accepted: clarify that nonce-bearing `style-src` ignores `unsafe-inline`. Both documentation fixes are applied; the policy is unchanged and the reviewer requires no repeat review. The user's permission is separate from this review.
