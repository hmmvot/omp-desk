# Chat HTML pages: a closed `html` fence of a reply as a live, sandboxed page

- Status: accepted
- Date: 2026-10-19

## Problem

The model sometimes explains best with an interactive page (a chart, a calculator, a layout mockup), which Markdown cannot show. Chat shows an ```` ```html ```` fence as code. The user can copy it into a file and open a browser, which loses the context and is exactly the friction Chat should remove.

## Goals and Non-goals

Goals: a closed top-level `html` fence of the assistant's own reply text is shown as a live page inside the transcript, with a Page | Source toggle and Copy; the page can read the Chat's colours and fonts; a hostile page can do nothing outside its frame; the setting `ompDesk.chatHtmlPages` (default on) gates both the display and the model being told it may write one.

Non-goals: pages from user text, tool results or thinking; a fence inside a list or a quote; network access of any kind (no CDN, no fetch, no fonts); forms, popups, downloads, links out or navigation; module scripts and `src=` scripts; an API from the page to the host or to OMP; persistence of a page's state; a page larger than 200,000 characters.

## Current State

`Markdown.tsx` renders fences through `CodeBlock`; `svg` and `mermaid` fences already draw as images with a source toggle (`omp-mermaid` styles, [chat rich Markdown](2026-10-19-chat-rich-markdown.md)), none of which executes reply content. The guest document's policy is `default-src 'none'` with scripts and styles by the document's nonce or VS Code's resource origin, `style-src-attr 'unsafe-inline'` ([ADR-0028](../decisions/0028-stamp-document-nonce-on-renderer-created-styles.md)); `connect-src` names the bridge listener when the editor has one ([ADR-0023](../decisions/0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md)).

## Proposed Design

**Display.** `HtmlPageBlock` replaces the code block for a closed top-level `html` fence in the assistant's reply text while the setting is on and the document names a page frame; while the fence streams, in other message kinds, in lists and quotes, or with the setting off it is the unchanged code block. A source that is empty, over 200,000 characters or has a NUL or an unpaired surrogate stays code with one muted "Page not shown: …" line. The block is one bordered box: a **header row** of its own (a static, always visible row above the frame, not a hover overlay) with Page | Source and Copy, so nothing ever lies over the page; the frame; and, only when the page's content is taller than the cap, a **bottom row** with Show full page / Show less. The frame reports its content height; collapsed the frame is that height up to 800 px and the page scrolls inside, expanded it is the whole content height with no inner scroll and follows the content while it changes (the frame's reports keep arriving, capped at 30,000 px). The block's size change reaches the transcript through its rows' `ResizeObserver`, the path every growing row uses, so the reading position is kept by the existing anchoring. The Page|Source choice, the expansion and the last content height are remembered per source for the life of the page.

**Streaming and fallback source (amendment).** The code a block shows until it is a page (the fence still streaming; a closed one that is refused, has no frame or whose frame did not answer) is a small preview: `PREVIEW_ROWS` (12, the tool outputs' preview size) lines of the code block's own line height, in a box that scrolls inside (`CodeWithNote`, `.omp-htmlpage-streaming`). Source longer than that gets the tool outputs' control (`.omp-output-more`, "Show all N lines" / "Collapse"), which lifts the box to at most `HTML_PAGE_MAX_HEIGHT` (800 px), still scrolling inside, never unbounded. The box sticks to its bottom as the text grows unless the reader scrolled up inside it (within 4 px of the end counts as at the bottom). Growth is bounded by the preview or the cap, so the transcript's row `ResizeObserver` sees bounded changes; the closed page replaces it as before. Test: `html-page-ui.test.ts`, "a streaming fence of hundreds of lines is capped".

**Fixed height.** The prompt rule asks the model to keep the document height fixed when tabs, steps or states switch (reserve the tallest state in a fixed-height container), because a page that changes height makes the reply jump; and to expect Show full page beyond 800 px.

**Width.** The Chat column is at most 840 px, so a page is at most about 800 px wide and in a side panel as narrow as 320 px. The rule tells the model to use a fluid layout that wraps, never to scale a wider drawing down to fit (its text becomes unreadable or clipped), and to keep text at 12 px or larger. The rule's budget is 1,000 characters.

**Frame.** `<iframe sandbox="allow-scripts" allow="" src="http://127.0.0.1:<port>/page">`, an opaque origin. The document and its header policy are in [ADR-0079](../decisions/0079-serve-reply-html-pages-from-a-constant-loopback-frame-document-with-its-own-policy.md): constant bytes from a one-route loopback listener, a policy of `default-src 'none'` plus a hash for its one bootstrap script, `'unsafe-eval'`, inline styles and `data:` fonts and `data:`/`blob:` images and media, and `sandbox allow-scripts`. There is no nonce. The Chat document gains `frame-src http://127.0.0.1:<port>` and a `<meta name="omp-html-page-frame">` with the URL; nothing else changes in its policy.

**Messages.** Frame → Chat: `{ompHtmlPage:"ready"}` once its listener runs and `{ompHtmlPage:"size",height}` after layout changes. Chat → frame: one `{ompHtmlPage:"page",html,dark,variables}` after `ready`, and `{ompHtmlPage:"theme",dark,variables}` on a theme change. The Chat takes a message only from the block's own `iframe.contentWindow`; the frame only from `parent`. The Chat's host-message listener (`bridge.ts`) ignores any message whose source is a frame inside the Chat (`isFromEmbeddedFrame`), so a page cannot inject a host message into the channel that carries them.

**Rebuilding the page in the frame.** The bootstrap parses the source with `DOMParser` (inert), lifts its classic inline `<script>` bodies and its `on…=` attributes out, moves the rest into the live document, adds listeners made with `new Function` for the handlers, runs the scripts in order with indirect `eval`, then fires `DOMContentLoaded` and `load` for listeners the page registered. `src=`, `type=module`, `<base>`, `<meta http-equiv>` are not run or are dropped; clicks on links that do not start with `#` are cancelled.

**Theme.** Eighteen variables (`--bg`, `--fg`, `--muted`, `--border`, `--surface`, `--accent`, `--success`, `--warning`, `--error`, `--c1`…`--c6`, `--font`, `--font-size`, `--font-mono`) and `color-scheme`, from the figure palette and the page's theme, restricted to a safe value alphabet; defaults sit in a CSS layer so the page's own rules win.

**Focus.** A page cannot hold the keyboard against the composer: a focus it takes without the user's own pointer or Tab is taken back. While the browser still reports user activation from the user's last interaction in the Chat (a few seconds), a page's own `focus()` is indistinguishable from the user's click and is kept; that window is the guard's limit, not a boundary. Nothing there lets the page reach the Chat.

**Prompt.** With the setting on, one standing rule of at most 1,000 characters is added to Chat sessions' system prompt (`HTML_PAGE_INJECTION`, after the standing rules and before the tool-intent rule), telling the model when to use a page and what it cannot do. It is passed as `OMP_VSCODE_HTML_PAGES=1` at launch and applies to sessions started afterwards, like the tool-intent rule.

**Lifecycle.** The listener is bound at activation, only while the setting is on, before commands or serializers can build a chat document, and closed with the window. Turning the setting on later binds it; documents built earlier name no frame, so their blocks stay code with a note until the window is reloaded. A frame that does not say `ready` within six seconds is replaced by the code and a note.

## Alternatives

Recorded in ADR-0079: a `srcdoc` frame with the Chat's nonce (rejected: the nonce is readable by the page's JavaScript and the inherited policy lets it load any resource the Chat's policy allows), `data:`/`blob:` frames, an extension resource URL, and a separate editor webview.

## Risks and Open Questions

- Messages from the frame to `parent`, `parent.parent` and `top` are delivered whatever the policy. That they have no effect on the host page and the workbench is an observed property of VS Code 1.142 (its webview host relays only its own channel and acts on its own shapes), not something this change guards; the Chat's own channel is guarded by `isFromEmbeddedFrame`. Verified in a real window (below); re-verify after each VS Code major version.
- WebRTC is outside CSP; best effort removal in the frame; the page holds nothing of the user's.
- A page can burn CPU in its own frame process; no budget beyond the size cap.
- Loopback being blocked by a local firewall shows code with a note after six seconds.

## Rollout and Verification

Unit tests: the frame document and policy (`shared/html-page-frame.test.ts`), the listener (`host/html-page-server.test.ts`: one route, 404 for everything else, constant bytes, rebinds), the Chat document's `frame-src` and meta (`host/guest-webview.test.ts`, `wiring/editor-panels.test.ts`), the message shapes (`webview/lib/html-page.test.ts`), the sender guard (`embedded-frame.test.ts`), the prompt rule and the launch environment. Headless Chromium UI test (`webview/html-page-ui.test.ts`) with the real app and the real listener: scripts, handlers and styles run; the theme reaches the page and follows a theme change without reloading it; height follows content up to the cap; a hostile page that tries parent, top, storage, `fetch`/XHR/WebSocket/beacon/worker/import, forms, `window.open`, location changes, injected `<script>` (src, inline and `data:`), injected `<link>`, `<base>`, and forged host messages makes no request (every canary path counted zero) and changes nothing in the Chat; the focus guard; fall-backs (streaming, other messages, lists, quotes, setting off, no frame server, silent frame); a page that answered is never given up on after the timeout.

Real VS Code window (hidden desktop, `scripts/test-vscode.ps1`, VS Code 1.142): the page renders from a session file; the frame target is `http://127.0.0.1:<port>/page` with `self.origin === null`, no `[nonce]` and no policy `<meta>`, and the served header equals the policy above; a page that posts 14 shapes (host/webview protocol messages `omp:session-view` and `omp:chat-state`; VS Code webview channel messages `did-click-link` with an `https:` URL and a `command:` URL, `did-keydown` for Ctrl+W, `onmessage` wrapping a protocol message, `did-set-content-size`, `load-resource`, `did-load-resource`, `do-reload`, `did-blur`, `did-focus`, and two other shapes) to each of `parent`, `parent.parent` and `top`: message listeners installed in the Chat window, the webview host page and the workbench all received them (origin `null`), and afterwards the editor tabs, the window title, the Chat content and the notifications were unchanged, no dialog opened, and `parent.document`, `parent.parent.document` and `top.document` threw `SecurityError`.

Reproduction of the real-window check: package the VSIX (`node scripts/package-vsix.mjs win32-x64`), start `scripts/test-vscode.ps1 -Name <n> -Vsix <vsix> -Folder <folder> -RemoteDebuggingPort <p> -IsolateHome` detached, put a session file (header, one user message, one assistant message holding the probe page in an `html` fence; its `cwd` the folder's repository root) under the environment's `agent\sessions\<encoded cwd>\`, open it from Resume Session, attach over CDP to the workbench page and the webview host iframe (the Chat is the host's child frame: use `Page.createIsolatedWorld` there, the Chat's own policy forbids `eval`), install a `message` spy in each, remount the page (Source, then Page) and read the frame target's `window.__log` and the three spies. Observed on 2026-10-19: frame log `parent posted 14`, `parent.parent posted 14`, `top posted 14` and `SecurityError` for each `.document`; the frame's `self.origin` was `null` and its document carried no `[nonce]` and no policy `<meta>`; the three spies each listed the 14 messages with origin `null`; before and after the probe the editor tabs, the window title, the Chat text, the notifications and the dialog count were identical; the served header was the policy of ADR-0079. The first run of this check also found that a page that had answered was given up on once its six-second timer fired and the reader toggled Source and back; fixed and covered by the UI test.

Docs: `docs/guide/chat.md`, `docs/guide/settings.md`, `docs/architecture.md`, `CHANGELOG.md`.

## Related Decisions

[ADR-0079](../decisions/0079-serve-reply-html-pages-from-a-constant-loopback-frame-document-with-its-own-policy.md); ADR-0028, ADR-0023, ADR-0069, ADR-0078.

## Architecture Review

- Reviewer: a separate `reviewer` agent, one pass (ADR and design reviewed by two agents)
- Outcome: REVISE with no material finding; three should-fix and four nits applied in the text (the focus guard's real limit, the `parent.parent`/`top` claim recorded as an observation of VS Code, the ADR's request claim, the policy summaries, the limits, the reproduction of the real-window check), accepted
- Notes: asked to check the sandbox and policy claims, the sender guards on all three channels, the lifecycle of the listener, and that nothing in this design needs a nonce. The `parent.parent`/`top` claim is an observation of VS Code, recorded as such.
