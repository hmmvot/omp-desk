---
status: accepted
date: 2026-10-27
---

# Chat link rules: the user's own patterns turn text of a reply into links that open a web address

Requested by the maintainer (2026-10-27): some text in Chat replies (for example the issue keys of a tracker) should be drawn as links that open a web address in the external browser. The patterns are personal and must never reach the repository: the repository carries only a generic mechanism, and the patterns live in the user's own `settings.json`.

## Problem

Chat already links what OMP Desk can prove: file paths and code symbols (the host looks them up), commit hashes, OMP's `agent://`/`artifact://`/`local://`/`proc://` addresses, and web URLs the reply writes out. Text that only the user knows is a reference (`#123`, a tracker key, a ticket number) is plain text, and the user copies it into a browser by hand.

## Goals and Non-goals

Goals:

- A rule is a regular expression and a URL template (capture groups substituted, URL-encoded). Matching text of an assistant reply is a link; a click opens the built `http(s)` URL in the external browser.
- The rules come only from trusted configuration: the user's own settings, never a repository the user opened.
- A rule link adds no new class of target: the page never supplies a *rule* URL; the host finds the rule itself, re-runs it and builds the URL, with a static host. (The existing web-link route, where a page names an `http(s)` URL and the host re-validates its scheme, is unchanged and is not made safer or weaker by this design.)
- No character on screen changes; a link is keyboard reachable and its tooltip shows the URL.
- An invalid rule is reported once and skipped; a change of the setting reaches every open Chat page at once.
- A generic mechanism: nothing about any tracker, project or person is in the repository (docs, tests and the setting's description use placeholders).

Non-goals:

- Opening files, running commands or opening an editor tab (Simple Browser) from a rule. Only the external browser, as the maintainer asked.
- A link in the user's own messages, in tool output, in thinking or in a fenced code block.
- A rule editor in the Settings view (arrays of objects are shown read-only there and edited in `settings.json`, as the view already does for every such setting).
- Proof that a pattern cannot be slow, or a time limit on a match. JavaScript has no regular-expression time limit and the page runs the rules synchronously while Markdown parses; the design bounds the cost of a mistake to a measured ceiling (see Validation and Risks) and relies on the setting being the user's own.

## Current State

- Chat text is drawn by `src/webview/components/Markdown.tsx`. `plain()` splits a prose text into web URLs, internal OMP addresses, `proc://` addresses and commit hashes (`textLinks()`), and gives the rest to `FileLinkText`, which asks the host about path-shaped tokens. `codeSpan()` does the same for a whole inline code span (symbols, files, commits).
- A link is a focusable `<span role="link">`, never an `<a href>` (`WebLinks.tsx`, `CommitLinks.tsx`); activation goes through `claimLinkActivation`. Only the assistant's own reply text opts in, through `AssistantReplyContext`.
- A click is `omp:terminal-link-open` with a `target` string; `src/extension.ts` `handleTerminalGuestMessage` routes by the shape of the target (`commit://`, internal OMP addresses, a file). The target of a web link is the URL itself and the host re-validates it with `webLinkUrl` (`http(s)` only) before `openWebLink`.
- Window-wide settings the page needs arrive in epoch-free messages the host sends when a page announces itself and when the data changes: `omp:chat-code-theme`, `omp:chat-keys` (`ChatRuntime.refreshKeyHints()` is the model for this design), and a module-level page store attached in `main.tsx` before `omp:ready` (`key-hints-store.ts`).
- The Settings view (`docs/designs/2026-10-12-settings-view.md`) shows array and object settings as read-only JSON and sends the user to `settings.json`.

## Proposed Design

### The setting `ompDesk.chatLinkRules`

An array of at most 20 objects:

| property | meaning |
| --- | --- |
| `pattern` (required) | a JavaScript regular expression, at most 256 characters |
| `url` (required) | the address template, at most 1024 characters |
| `ignoreCase` | `false` by default |
| `name` | a label shown above the URL in the tooltip |

Example (placeholders, not an address): `{ "name": "Issue", "pattern": "#(\\d+)\\b", "url": "https://github.com/<owner>/<repo>/issues/$1" }`.

**Scope: `application`, and the host reads only `inspect().globalValue`.** `application` settings are read from the user's settings and ignored in a workspace, a multi-root `.code-workspace` and a folder, so a cloned repository's `.vscode/settings.json` cannot add a link (a link to a look-alike address in a reply the model wrote is the attack: the model's text would carry a key that the repository's rule turns into a phishing link). Declaring the scope is not trusted alone: the host reads `globalValue` of `inspect()` and nothing else (no default, no workspace, no folder, no language override), which also holds on a VS Code whose scope handling differs: `globalValue` is the user layer by the definition of the extension API's `inspect`, so the guarantee is that read, and the scope declaration adds the editor's own refusal of a workspace value and keeps the setting out of workspace Settings. The setting is therefore also not available per workspace on purpose: a personal tracker rule is the same in every window. Settings Sync carries it with the user's other application settings.

No `resource`/`window` scope and no workspace-trust gate: trust is about code the workspace runs, and a link rule is data that a workspace must not be able to supply at all.

### Validation (`src/shared/link-rules.ts`, one copy for host and page)

Each rule is compiled by `compileLinkRule(raw, id)`; the rule's `id` is its position in the setting, so skipping an invalid rule does not renumber the others.

- Shape: an object with only the four properties above (an unknown property, such as a mistyped `ignorecase`, is reported rather than ignored).
- `pattern` is compiled with the flags `g` and, with `ignoreCase`, `i` (not `u`, so ordinary escapes of a hand-written pattern are valid); it is refused when it does not compile or **matches the empty text** (it would match everywhere); a zero-length match is skipped at run time too.
- **Pattern screen** (`screenPattern`, a scan of the source that skips escapes, character classes and group prefixes and tracks groups): refused are back-references (`\1`, `\k<name>`); a **group that holds a repeat or an alternative being repeated** in any way but `?` (`(a+)+`, `(\w+\s?)*`, `(a|a)+`, `(a|ab)*`, `(a?){30}`, `(a|b){2}`; `[ab]{2}` and `(?:ab){2}` are fine); repeats that cost more than a budget of 9 (an unbounded repeat, `*`, `+`, `{n,}` or `{n,m}` with `m` over 40, costs 4; `{n,m}` up to 40 costs 3, `?` costs 1 (a chain of optionals doubles the search each time): so two unbounded, or one of each, or three ranged, are allowed and `\w+\w{1,40}\w{1,40}`, which took 12 s in a confirmation measurement, is not) and more than 8 quantifiers of any kind. The quantifier is read from the whole rest of the pattern, so a `{n,}` with many leading zeros is not missed. This removes the exponential families (nested repeats, repeated alternatives, optional chains) and leaves polynomial ones: two unbounded repeats over the same characters are cubic in the length of a failing text, three bounded ones of 40 are about as slow (see Risks for the measured ceiling). It is a limit on the cost of a mistake, not a proof.
- **Bounded scans**: a text is read up to its first 2000 characters, **in pieces of at most 500 characters cut at whitespace** (a hard cut inside a word drops a match that ends there, since it might have been longer, and a match with whitespace in it that straddles a cut is lost; the whitespace a piece is cut at begins the next piece, so a match that starts with it is kept): a backtracking pattern costs most on a long run of one kind of character, and the pieces make the cost per piece, not per text, cubic at worst. At most 32 rule links per text; a match longer than 200 characters is not a link. `encodeURIComponent` is given text with unpaired surrogates replaced by U+FFFD, since it throws on one and a reply may hold one.
- **URL template**: must start with `http://` or `https://` and name its host directly after `//`; a `$` may not stand in the host (so the text of a reply can pick a path or a query but never the site: `https://$1.example.test/` is refused, so are `https:///$1` and `https://\$1`, which the URL parser reads with the host taken from after the slashes); placeholders are `$0` (whole match), `$1` to `$9` (a group the pattern has) and `$$`; any other `$x` is refused. With every placeholder replaced by a letter the template must parse as an `http(s)` URL with a host.
- **URL building** (`buildLinkRuleUrl`): the rule is run on the matched characters alone and must match all of them; each substituted value is `encodeURIComponent`ed as one component; the result must pass `webLinkUrl` (the same `http(s)` check every web link uses), be at most 2048 characters and still have the template's host. A match that depends on the characters around it (a look-ahead) therefore links nothing, on the page as on the host, rather than something the host would refuse.
- Overlap between rules: the earlier rule of the setting wins.

**Reporting.** `createLinkRuleSource` (`src/host/link-rules.ts`) reads the setting when a page announces itself and when it changes, compiles it, and reports problems **once per distinct value**: a Warn line in the OMP Desk log and one warning notice that names the rules (numbered from 1) and the reasons. The valid rules still apply. A window that never opens a Chat never reports.

### Host to page: `omp:chat-link-rules`

An epoch-free, window-wide message `{ type, rules: LinkRuleEntry[] }` (`id`, `pattern`, `url`, `ignoreCase`, `name`), parsed by `parseChatHostMessage`. `ChatRuntime` sends it, before the state, every time a page announces itself (the empty list included: a document that outlives an extension-host restart may still hold rules the user has since removed; the page store ignores an identical list) and `refreshLinkRules()` sends it to every attached page of every tab when `ompDesk.chatLinkRules` changes (an empty list included, so removing the last rule removes the links). `onDidChangeConfiguration` for the key calls it; the runtime port gains `refreshLinkRules()` beside `refreshKeyHints()`.

The page keeps the rules in a module-level store (`link-rules-store.ts`, attached in `main.tsx` before `omp:ready`) and **compiles every entry again with the same `compileLinkRule`**: a rule that fails the shared checks is dropped whatever the host sent. `Markdown` reads the store's version with `useSyncExternalStore`; when it changes the text is parsed again from scratch (not from the previous parse's kept blocks), so open transcripts follow the setting at once.

### Page to host: the click

A rule link is `<span class="omp-web-link omp-rule-link" role="link" tabindex="0" data-rule-target title>` (`LinkRules.tsx`): the look of a web link, a click or Enter or Space activates it, and its title is the rule's name (when set), the URL the host will build and `Click to open in your browser`. The page builds that URL only for the title.

A click posts the existing `omp:terminal-link-open` with `target = link-rule://<rule position>/<encoded matched text>` and nothing else: no `url`, no `mode`, no `action`. No new wire message and no change to `parseTerminalLinkRequest`: like `commit://`, a target shape is routed in `handleTerminalGuestMessage` before the file and internal-address branches (`handleLinkRuleOpen`). The host:

1. parses the target (a position of at most 3 digits, the text at most 200 characters, a failing decode refuses it);
2. reads the **current** rules from the user's settings, finds the rule by position (a rule that is gone, or another rule now at that position, is simply not matched);
3. runs `buildLinkRuleUrl(rule, text)`; a result of `null` opens nothing and shows one warning ("This text no longer matches a link rule of ompDesk.chatLinkRules, so nothing was opened");
4. checks that the page is still the current document, as every link open does, and calls `openPageWebLink(url, "external")` (`vscode.env.openExternal`); only the origin is logged.

The page cannot cause any other URL to open: every URL comes from the host's own rule and the page's text only fills encoded placeholders after the host. A `validate` request for such a target gets no reply and opens nothing (the page never sends one).

### Where it applies and precedence

- Only the assistant's own reply text (`AssistantReplyContext`) in a page that can open links (`WebLinksContext`): user messages, tool output, thinking, notices and fenced code blocks stay text, as do detail tabs without a link client.
- In prose (`textLinks()` in `Markdown.tsx`): a web URL, internal OMP address or `proc://` address that contains the match wins (a key inside a URL is part of the URL); then rule matches; then commit hashes. So **a user rule beats a commit hash** (it is the user's own statement of what the text is), and the rest of the text is offered to the file-link proof as before.
- A rule match **inside a longer path-shaped token** (`src/PROJ-9/a.ts`) is left to the path: a rule never splits a file reference, even one the host later finds does not exist.
- A Markdown link's label is never linked again; inline code is linked only when a rule matches the **whole span** (trimmed), before the commit rule and the symbol/file lookups; a span with more text stays code.
- The link wraps exactly the matched characters; copy, Find and the quote feature read the same text.
- No right-click menu: the web-link context menu carries a page-supplied URL for the host to open, and a rule link has none.

### Files

`src/shared/link-rules.ts` (rules, screen, building, matching, the target codec), `src/host/link-rules.ts` (source, report, `handleLinkRuleOpen`), `src/wiring/link-rules.ts` (the `globalValue` read, the notice), `src/protocol/chat-messages.ts` (the message), `src/host/chat-runtime.ts` and `src/runtime/` (the send and the refresh), `src/webview/lib/link-rules-store.ts`, `src/webview/components/LinkRules.tsx`, `Markdown.tsx`, `terminal-link-client.ts` (`openLinkRule`), `main.tsx`, `package.json` (the setting).

## Alternatives

- **Allow the setting per workspace.** Rejected: the rules are personal and a repository's settings are not trusted input; trust prompts do not apply to data, and the attack (a link to an address the repository chose, over text the model wrote) needs no code.
- **The page sends the URL.** Rejected: the page is untrusted by the project's rule. The page sends a rule position and the matched characters and the host builds the URL. The existing web-link route (the page's URL, re-validated as `http(s)`) already lets a page ask for any web address, so this is not a new capability; the point is that a rule's URL, its static host and its encoding are the user's and are produced in one place, which a page cannot change.
- **Detect on the host.** The host would need the text of every reply and an asynchronous round trip per text, and `Markdown` renders synchronously; detection on the page with the host re-running the rule on a click gives the same trust at no latency.
- **A new wire message for the click.** Rejected: `omp:terminal-link-open` with a target shape is what commit and internal links already do; a second validated message would duplicate the routing, the bridge allow-list and the dispatcher.
- **A time-limited or non-backtracking regex engine.** A `vm` timeout on the host does not reach the page, where detection runs; RE2 is a native or WASM dependency for a personal setting. **A Worker in the page** can be terminated and so is the only real containment: it was not chosen because `Markdown` parses synchronously and a worker makes detection asynchronous (a second render pass for every text, with the characters shown before and after), needs its own script under the nonce policy (as `mermaid.js` has) and a message protocol, all for a setting the user wrote about their own text. Revisit if a rule ever comes from anywhere but the user's own settings.
- **Only a cap on the number of unbounded repeats.** Rejected after review: it passes `(a|a)+$` and `(a|ab)+c`, which are exponential. The screen therefore refuses any repeat of a group that holds a repeat or an alternative.
- **Implicit word boundaries around every pattern.** Rejected: it would stop a rule like `#(\d+)` from matching at all (`\b` before `#` fails after a space) and take control of the pattern from the user.
- **Fixed rule kinds** (`github`, `jira`) instead of a regex. Rejected: the maintainer asked for a generic mechanism and any tracker name would belong to some user's configuration.
- **A `flags` string.** Rejected for `ignoreCase`: the other flags (`g`, `m`, `s`, `y`, `u`) either break the scan or have no use here.

## Risks and Open Questions

- A slow pattern the screen does not catch. Measured with Node 24 (V8) on this machine, on the worst input (one 2000-character word) scanned in pieces of 500, for the combinations the budget still allows: `.*.*x` 0.2 s, `\w+\w{1,40}x` 0.3 s, `\w+\w+x` 0.4 s, `\w{1,40}\w{1,40}\w{1,40}!` 1.2 s (the same patterns on text with spaces: below 0.1 s). Unchunked, the same word took 0.8 to 15 s, and `(a|a)+$`, `.*.*.*x` and `\w+\w{1,40}\w{1,40}!` (all refused now) take 10 s to hours. So the ceiling is about a second or two of frozen page for a deliberately slow pattern on a crafted text of one unbroken word, and not a containment (the budget is a measured judgement, and a machine under load is slower); ordinary prose, whose words are short, costs nothing measurable.
- The page and the host compile the rules separately; a click between a setting change and the page receiving it names a position the host now reads differently, and then opens nothing and warns, or, if the other rule matches the same characters, opens that rule's URL. Both are the user's own current rules.
- A rule that needs the characters around its match (a look-ahead) links nothing, because a link must be reproducible from its own characters; the setting's description says so.
- Remote windows: `application` settings are the local user's; this extension is Windows-only and runs locally, so no remote case exists today.
- Open question: whether a rule should be allowed in an `omp.detail` tab (a subagent's transcript). It is not: those pages have no link client; revisit if requested.

## Rollout and Verification

One change: the setting, the shared module, the host source and handler, the message and its refresh, the page store, the component and the Markdown integration, with the guide, the architecture description and the changelog.

Verification: unit tests of the screen, compilation, URL building, matching limits, boundaries and the target codec (`src/shared/link-rules.test.ts`); the source's reporting and the open handler, including that a page-supplied URL and a text that no longer matches open nothing (`src/host/link-rules.test.ts`); the runtime's send and refresh and the parser (`src/host/chat-runtime-link-rules.test.ts`); static renders of the precedence rules (`src/webview/link-rules.test.ts`); the real page in Chromium: links appear, a click and keys post the target only, a changed setting follows at once, user text and fenced code stay text (`src/webview/link-rules-ui.test.ts`); `npm run typecheck`. Not observed: a real VS Code window (the settings read, the notice and `openExternal` are exercised only through their injected seams, and a workspace-settings rule being ignored rests on `inspect().globalValue` being the user layer by definition, a contract of the extension API that was not checked in the installed VS Code's own sources); the package did not build or install a VSIX, so the isolated-window smoke (`scripts/test-vscode.ps1`) belongs to the integration step.

## Related Decisions

[Commit hash links](2026-10-17-commit-hash-links.md) (the `commit://` target shape this reuses), [Chat keys and empty state](2026-10-18-chat-keys-and-empty-state.md) (the epoch-free window-wide message and page store this follows), [Settings view](2026-10-12-settings-view.md) (arrays shown read-only).

## Architecture Review

- Reviewer: independent `reviewer` agent, two passes (first review, then a confirmation pass that ran probes against the real modules; a re-check followed the last fixes).
- Outcome: **accepted with changes, all applied**.
- Notes: first pass: one must-fix (the claim that the pattern screen contains catastrophic patterns was wrong; the screen was tightened to the group and repeat rules above, text is scanned in 500-character pieces, and the measured worst cases are recorded in Risks), a should-fix (an alternation inside a repeated group was not tracked), a nit on unpaired surrogates, threat-model wording, and a rule that the list is posted on every announce. Confirmation passes found three more things, all fixed with tests: a `{n,}` quantifier with many leading zeros was invisible to the screen; the separate repeat caps allowed products of repeats (`\w+\w{1,40}\w{1,40}!`), so one repeat-cost budget replaced them; a `?` was free although a chain of them doubles the search, so it costs 1; and the whitespace a piece is cut at belonged to no piece. The remaining limit is stated in Risks: the screen is a measured judgement, not a containment, and a deliberately slow pattern of the user's own can freeze their own page for a second or two on a crafted text.
