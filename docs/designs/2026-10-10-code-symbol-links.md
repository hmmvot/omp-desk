---
status: accepted
date: 2026-10-10
---

# Link inline code symbols in Chat through VS Code's workspace symbol providers

## Problem

The Chat prompt asks the model to write each code symbol as a Markdown link to its definition line (`` [`App.start`](src/app.ts:12) ``). The model does this for most symbols, but a long answer still leaves many plain inline-code symbols (`Ability`, `AbilityData.Cast`, `UnitUseAbilityAbstract<T>`, `IAbilityCasterRestriction`, `[AllowedOn]`), because it did not see their definition line or simply did not link them. VS Code already knows where most of these are defined: every language extension that implements a workspace symbol provider (C# Dev Kit/Roslyn, TypeScript, Python, Go, ...) answers `vscode.executeWorkspaceSymbolProvider`. Desk can use that to link a symbol whenever the provider reports one matching definition, whatever the model wrote. The decision to do this in the host window is [ADR-0058](../decisions/0058-resolve-chat-code-symbols-in-the-host-window-through-workspace-symbol-providers.md).

## Goals and Non-goals

- Goals:
  - An inline code span in **assistant reply text** that is not already a link or a path, and looks like a code symbol (`Name`, `A.B`, `Name()`, `Name<T>`, `[Name]`), renders as a code-path link when the provider reports exactly one matching definition inside the session's folders. The link looks and acts like the existing code-path links: underlined code, a click opens the file at the definition's line and column, Ctrl+Click reveals it in the Explorer, Ctrl+Shift+Click shows it in File Explorer, the same right-click menu.
  - Never block rendering or streaming; bounded work per document, per window and per provider.
  - A setting, `omp.linkCodeSymbols` (default on), turns it off.
  - The model-facing `code-links` prompt rule is improved so the model links more symbols itself; the host resolution is the safety net.
- Non-goals:
  - No guessing: an unknown symbol stays plain code, and a symbol with several different definitions never links to one of them (it links to the workspace symbol search, see Ambiguous symbols). No ranking picks "the best" overload, partial declaration or same-named member. (One maintainer-approved exception: a bare capitalized name prefers type-like declarations over members, see Matching.)
  - No links into library or metadata documents, or into files outside the session's folders. A vendored library whose sources are inside those folders is not told apart from the project's own code.
  - User messages, tool rows, notices, thinking blocks, code blocks and link labels are unchanged. Only a whole inline code span of assistant reply text is a candidate, wherever it stands in that text, including inside bold, italic and strike-through (maintainer decision, 2026-10-10, once emphasis rendered code spans).
  - No new language service, no parsing of source files by Desk, no index of our own, nothing given to the agent (the language tools of the agent stay native OMP `lsp`, [ADR-0013](../decisions/0013-authenticated-reverse-rpc-for-vscode-language-providers.md)).
  - Unsaved edits: a symbol added in an unsaved buffer is seen by a provider but not by this feature's invalidation until a save, a file-system change or the cache lifetime passes.

## Current State

- Page: `Markdown.tsx` renders a code span through `codeSpan`: a span that is one path becomes `<code><FileLink/></code>`; `FileLink` asks the host to validate the path (`omp:terminal-link-validate`, `ChatFileLinks`, a per-document `ValidationCache`) and wraps the characters in an anchor (`omp-file-link`) once the host proves it; a click posts `omp:terminal-link-open`, which the host re-resolves against the session cwd.
- A Markdown link with a path destination (`` [`Name`](src/a.ts:12) ``) is the same anchor around the code, once the file exists.
- Host: `handleTerminalLink` (`src/host/terminal-links.ts`) answers validate/open from `extension.ts`'s `handleTerminalGuestMessage`, over the panel route and over the authenticated bridge (`terminal-link-*` operations, stream class), so a surviving page works after an extension-host restart. The open path accepts any existing absolute local file; it is not a workspace sandbox.
- Nothing asks a language provider anything today.

## Proposed Design

### Candidates (shared pure module `src/webview/code-symbols.ts`; page and host both run it)

`parseCodeSymbol(content)` normalizes one inline-code span and returns `{ segments, name, last, attribute, call }` or `null`. Alphabet: ASCII identifiers `[A-Za-z_$][A-Za-z0-9_$]*` only; a span with a non-ASCII letter is not a candidate. Order of steps:

1. Trim. Reject spans longer than 120 characters, or containing a backtick or a control character.
2. If the whole span is `[...]`, remove the brackets (`attribute`). If it then ends in a balanced `(...)`, remove that one argument list (`call`); argument contents are not interpreted, so `[AllowedOn(typeof(X))]` is `AllowedOn`.
3. Remove every balanced `<...>` group, whose inside may hold only type-argument characters (letters, digits, `_ $ . , ? * & :`, spaces, brackets); an unbalanced or otherwise filled group rejects the span (`a<b`, `Foo<a+b>`).
4. Remove trailing `[]` and `?` suffixes.
5. What remains must be one to four identifiers joined by `.`; anything else (space, operator, quote, path separator, `::`, `->`, `;`) rejects the span.
6. Reject: a last segment shorter than three characters (so `A.B` and `x.y.zz` are not candidates); a first segment that is `this`, `base`, `self`, `super` or `cls`; any segment that is a keyword or keyword-like type name (one constant list, case-sensitive: `string` is one, `String` is not).
7. A bare name made only of lowercase letters and digits (`main`, `json`, `sha256`) is prose and a candidate only with a call suffix (`parse()`). A name with a capital, `_` or `$`, and every dotted name, is a candidate. The call flag has no other effect on matching: it never selects an overload or a constructor.

The span's raw content is what the page sends, so the host runs the same function again.

### Order against path links

A span that already looks like a path (`isFileLinkCandidate`) keeps its file link. `A.Bcd` is also path-shaped (`.Bcd` looks like an extension), so a candidate that is also a path first waits for the host to prove or refuse the path (the existing validation) and asks about the symbol only when the path is refused. The symbol request is never sent for a proven path.

### Eligibility

Only assistant reply text opts in: `AssistantContentView` provides a React context (`SymbolLinksEligibleContext`) that the assistant text blocks read, and the thinking disclosure turns off again. User text, tool rows, notices, detail tabs and the rest of the transcript render exactly as before; file links keep working everywhere they do today.

### Wire protocol (new pair in the terminal-link family, same plumbing)

- Page to host `omp:terminal-link-symbols { requestId, tokens: string[] }`: 1 to 16 tokens, each 1 to 120 characters without control characters; the exact key set is enforced.
- Host to page `omp:terminal-link-symbol-resolution { requestId, disabled?, results: [{ token, status: "found" | "none" | "unavailable" | "pending", target? }] }`: one result per admitted token, `target` only with `found`, a link target of the existing grammar (`path:line:column`; relative to the session cwd inside it, absolute otherwise; the bare path when the provider gave no position). The page matches a result to its request by `requestId` and to a token by its text, and treats a token missing from the answer as `unavailable`; an answer for an unknown request is ignored.
- Integration surface (each is one small additive entry, all in the existing terminal-link seam): both message parsers and unions (`messages.ts`), the browser's `bridgeOperation` mapping, the host's presentation admission (`TERMINAL_PANEL_TYPES`, the Chat panel guard that lets link requests through in either mode), the bridge's stream-operation class and `BRIDGE_OPERATIONS` allow-list, the `handleTerminalGuestMessage` case with the same document/session/cwd currency check as validate/open, and the reply through `pushTerminalTo`. A bridge request that fails parsing or the route state is refused as for any other link request. No mutation slot is taken.
- A click is not new: the anchor posts the existing `omp:terminal-link-open` with the returned target; the host re-resolves it against the session cwd, requires an existing file, and opens it. The symbol exchange adds no opening authority; a forged resolution can produce only a link the existing open path would accept anyway.

### Host resolution (`src/host/symbol-links.ts`, pure and tested without VS Code)

`SymbolLinkResolver` takes a `SymbolSource` (`query(text): Promise<SymbolEntry[] | null>`; `null` for an error or timeout) and answers one candidate at a time.

**Adapter contract.** The VS Code adapter (`extension.ts`) calls only `vscode.executeWorkspaceSymbolProvider` with a candidate's name and keeps at most 1001 entries of the answer before converting any (one past the 1000 examined marks a cut answer). `symbolEntry` converts each `SymbolInformation`: only a `file`-scheme URI has a path (a metadata or library document gets no path and can never be inside a session folder); a name or container too long to match faithfully (over 256/512 characters) is never shortened into another identity: the entry matches nothing, and because it could be the hidden rival of a unique match (or the match itself) its presence in the folders makes the lookup `unavailable` unless an ambiguity was already seen; line and column are validated finite integers converted once to one-based; a location without a range, or an empty range at 0:0 that a provider substitutes for one it did not resolve, has no position, and the link then opens the file without a line (a click goes to the top of the file; a definition line is never invented).

**Scope.** Allowed files are those inside the session cwd or inside an open workspace folder that contains the cwd (a session started in a subfolder still links to the rest of its project). Containment is lexical, component-wise and case-insensitive (Windows); symlinks and junctions are not resolved. "No libraries" therefore means: no external or metadata locations.

**Steps.**

1. Cache lookup keyed by (session folder, canonical name, attribute flag), then in-flight sharing.
2. Query the provider for the **last segment** of the name. When a dotted name finds nothing, query the full dotted text once more, because a provider may understand a qualified query that the bare name's ranked list does not reach.
3. Keep entries inside the allowed folders.
4. Match: the entry's name with parameter and generic lists removed equals the last segment exactly and case-sensitively (an attribute candidate also matches `NameAttribute`, on a type only). For a dotted name, the entry's container (generic arguments removed, split on `.`/`:`) must end with the preceding segments, compared exactly; an entry without a container never matches a dotted name; an inherited member (declared in a base type) therefore does not match its derived type's name.
5. Kind matrix (`vscode.SymbolKind`):

| Kind | Bare name | Dotted name | Attribute |
|---|---|---|---|
| Class, Interface, Struct, Enum | match | match | match |
| Namespace, Module | match | match | no |
| Method, Function, Constructor, Property, Field, Variable, Constant, EnumMember, Event | match | match | no |
| File, Package, String, Number, Boolean, Array, Object, Key, Null, Operator, TypeParameter | never | never | never |

   Maintainer-approved exception: for a *bare capitalized* name, when at least one type-like entry matches, only the type-like entries are counted (so a class `Ability` is not made ambiguous by a property `Ability` elsewhere, and a constructor is not a rival of its class). Everything else is counted as it is.
6. Distinct declaration locations (path, line, column; path compared case-insensitively) are counted, keeping the first report of one location. Entries without a position carry no identity: each counts as its own declaration (two unresolved overloads in one file are two). The locations are then grouped into symbols (maintainer decision, 2026-10-10, after a C# solution left partial classes and overloaded methods plain): the partial parts of one type (same name, generic arity and container; a `.cs` type with no container, as in the global namespace, counts too, a container-less type of another language never does) and the overloads of one member (same container, same name, both method-like or both of the same kind) are one symbol. **One symbol: found**, opened at the type's own file (`Game.cs` for `Game`), else at the first location by path and line (a positioned location before an unpositioned one). Several symbols (same-named types in different containers, a method and a property, an interface and its implementation) are ambiguous (the page links them to the symbol search, with the number of symbols as `definitions`), unless exactly one of them lies inside the session's own cwd, which is then the one (the roots may be wider than the cwd). A dotted qualifier narrows through the container match above. Zero: none.
7. A query that throws, or an invalidated lookup, is `unavailable`; a query that times out or is refused, or an empty answer from a provider that has not yet answered any symbol, is `pending` (see Readiness and parking); an empty answer after readiness is none. `unavailable` ("no reliable target yet"; it makes no claim about the provider's health, because an empty list is also a valid answer for a name that matches nothing): never cached. The same holds when the qualified second query of step 2 fails: the lookup is `unavailable`, not a miss. The adapter keeps only the entries that could be a declaration of the symbol's last segment (exact name, parameter and generic lists ignored, or its `Attribute` form, or an entry too long to judge) before converting, so fuzzy neighbours (`GameManager` for `Game`) never crowd exact entries out of the 1000-entry bound. An answer Desk still had to cut (more than 1000 candidates) can show an ambiguity among the entries it examined (none), but never a unique match (`unavailable`), because the second declaration may lie in the part it discarded. An answer with no entry at all is `pending` until the provider is ready (a language server still loading) and none after; an answer of unrelated entries only is none.

**Guarantee and its limit.** *Found* means: among the entries the provider returned for the exact name, inside the allowed folders, exactly one matches. A workspace symbol search is a relaxed, ranked search whose providers may cap their results, not an exhaustive declaration index. The design relies on providers ranking exact name matches first, which the API does not promise, so a hidden second declaration is possible for a very common name in a very large workspace. This residual risk is accepted by the maintainer's brief ("link only when exactly one definition remains"; provider caps are to be reported as a limit) and is disclosed in the README and the architecture document. Desk's own 1000-entry cut is different: it is known to Desk, and a cut answer never yields a unique match.

**Bounds.**

- Window-wide limiter: at most 4 provider calls are in flight; a slot is released only when the provider's own call settles, never at the timeout, so a hung provider keeps its slot instead of letting invocations pile up. Beyond the 4 slots, at most 64 queries may wait, each at most one query timeout; a query that finds the line full is refused at once (`unavailable`), and one whose wait expires is dropped from the line, so no request state outlives a hung provider.
- Each query gives up (logically) after 8 s (a large solution's Roslyn can need seconds for a workspace symbol query). A lookup issues at most two queries and starts none after its generation was invalidated or after 15 s. A batch is answered within 15 s (the page waits 20 s) with whatever settled; the rest is `unavailable` while it may still finish into the cache.
- The page's own limits (16 tokens per request, 2 requests in flight, a 64-token budget) are courtesy, not security: the host enforces its own admission as above, works on at most 8 batches at once (panel and bridge routes together; a ninth is answered `unavailable` at once) and `parseSymbolLinksRequest` bounds every request (16 tokens of at most 120 characters, measured on the raw token like the page's parser).
- Cache: at most 1024 entries; found for 60 s, none for 15 s.

**Fencing.** Each lookup captures the resolver's generation. Any file-system change under the workspace folders (a lazily created `FileSystemWatcher("**/*")`), saved or renamed document and workspace-folder change bumps the generation, clears the cache and the in-flight table; a lookup of an older generation starts no further query (a query waiting for a slot checks the generation when its turn comes, and one dispatched is not used), returns `unavailable` and caches nothing; a call of the new generation never joins an old lookup. A batch captures the generation too: if it moved before the reply, every token is answered `unavailable`, so an answer buffered before a file change is never delivered. After the provider answers, the handler re-reads the setting and the allowed folders: a setting turned off yields `none` with `disabled`, a changed folder set yields `unavailable`; a replaced document, session or cwd yields no reply (the existing `isCurrent` check).

**Setting.** `omp.linkCodeSymbols` is read on each request and again after the provider answers; off means `disabled: true`, `none` for every token, and the page stops asking for 30 s. There is no configuration listener: the page learns of a change with its next request, and spans re-rendered meanwhile show plain code.

### Page (`src/webview/lib/chat-symbol-links.ts`, `FileLinks.tsx`)

`ChatSymbolLinks` is one per Chat document, created beside `ChatFileLinks` by `FileLinksProvider`. It batches unique tokens (a 40 ms window; at most 16 per request; at most 2 requests in flight; a 15 s timeout per request), caches answers (found 30 s, answered none 10 s), and retries an `unavailable` token twice, after 5 s and then after 20 s (a language server that is still loading). Admission is one budget: at most 64 tokens may be unsettled at once, whether queued, in flight or waiting for their retry; beyond it a token stays plain and uncached and is asked again when its span next renders. The budget is per document, not per message. After the retry the token is recorded as none for 60 s: a per-token cache entry, so remounts and new batches inside that minute do not restart the cycle (clearing the whole cache at its 1024-entry bound also clears cooldowns; the bound makes that a best-effort limit). Request ids are document-wide (like the terminal-link client's), and an answer is first matched to a live request, so an answer meant for another client of the same page, a late one or a made-up id changes nothing, not even the disabled state. A disabled answer settles queued tokens and cancels waiting retries. A code span component asks only after the span has been on screen once (`IntersectionObserver`, so history that was never scrolled into view does not query) and after the existing 200 ms settle that keeps a streaming reply quiet; before the answer arrives the code is exactly what Markdown produced, so text, selection and copy are unchanged. Answers are not polled: a span keeps the link it shows while its answer is expired, and the next render of the span asks again (a streaming update, a remount); while the host has the feature off, spans render as plain code. A stale link is harmless because the click re-validates through the open path (file existence, not that the symbol is still on that line).

### Prompt

The `code-links` rule is reworded (still one imperative rule under 280 characters): link every mention, tables and lists included; use the definition line seen in a read or search; when only the file is known, link the file; plain code only for symbols the model did not locate; never guess a line; no extra tool calls to find lines. The effect is measured by repeating one question before and after (see Verification).

### Readiness and parking (maintainer decision, 2026-10-10)

Observed in a real C# solution: while C# Dev Kit loaded 63 projects the provider answered no symbols, history rendered at once, and every visible token spent its retries; later a long reply overflowed the provider queue. Neither is a verdict about the symbol, so neither is final:

- **Readiness (per window).** Until some workspace-symbol query of the window returns at least one entry (any entry, exact or fuzzy; the provider's `total` before Desk's name filter), an empty answer means "not ready": the lookup is `pending` (log `parked (not ready)`), not unavailable and not none. A canary query (the name of a recently parked token, at most 8 remembered) probes with delays of 2 s doubling to 30 s for ten minutes; the first answer with an entry marks the provider ready, logs `code symbols: provider ready after N s, re-running M parked` and sends the retry signal. After readiness an empty answer is a real `none`. A change of the workspace folders resets readiness. Parked state is a bounded set of keys (1024) and at most 8 names, nothing is held per token.
- **Queue.** A full waiting line and a query timeout are `pending` too (log `parked (queue)`, `parked (timeout)`); when the provider's slots are all free again after such a refusal, the host sends the retry signal (at most one per 3 s, log `code symbols: provider queue drained, asking parked tokens again`).
- **Wire.** `pending` is a result status; `omp:terminal-link-symbols-retry` (host to page, no fields) goes to every page that has asked (a bounded set of slot ids, pruned when the slot is gone) over the same panel and bridge routes.
- **Page.** A `pending` token is not cached and is not asked again by re-rendering until the signal (or one minute); the signal forgets the parking and the cooldown of tokens that exhausted their retries and notifies every mounted span, so the spans without an answer ask again, visible ones only (the `IntersectionObserver` gate and the 64-token budget are unchanged). A page budget overflow notifies once when half of the budget is free again. No state is added per message.

### Ambiguous symbols (maintainer decision, 2026-10-10)

The user wants coverage: a token whose lookup finds several different definitions inside the session's folders (distinct symbols after the partial and overload grouping, and not narrowed to one by the cwd) is still a link, but never to a guessed location:

- **Wire.** The result is `{ token, status: "ambiguous", definitions: N }` (N is the number of distinct symbols, at least 2, at most 100000; `definitions` only with `ambiguous`). It is cached like `found` (60 s on the host, 30 s on the page); a later `found` replaces it when the answer changes.
- **Click.** The page posts the existing `omp:terminal-link-open` with `target` the symbol's own text and `search: true` (open only; the validate form refuses the key). The host re-parses the text with `parseCodeSymbol` (a non-symbol is refused with a notice, nothing runs) and executes the one fixed command `workbench.action.quickOpen` with the argument `#<last segment>`, in the window that owns the chat (the `handleTerminalLink` host, current-document checked). The webview never names a command. Ctrl+Click and Ctrl+Shift+Click do the same: there is no single file to reveal.
- **Query.** The last segment (`Run` for `Twin.Run()`), because every symbol provider accepts it and it lists every same-named symbol with its container, while a dotted query is not understood by all providers (TypeScript's does not) and a dead search would be worse than a broader list. The user chooses among the definitions the name has, which may include same-named symbols the page's qualifier excluded.
- **Look.** A span with class `omp-symbol-search` inside the code: link colour like other symbol links, underlined dotted rather than solid, title "N definitions — click to choose". It has no file context menu (no `data-vscode-context`) because there is no file target.
- `none`, `pending` and `unavailable` stay plain. The safety rule "never link a guessed definition" holds: the link goes to a search the user drives, not to a definition.

### Per-message reminder (maintainer decision, 2026-10-11)

The system-prompt rules (`file-links`, `code-links`) are followed less reliably deep into a long conversation. A second, per-message reminder reinforces both in one text (`LINK_REMINDER`, 343 characters): files and folders as paths in inline code, code symbols as links.

- **Mechanism.** The host-control `-e` module's `context` handler (OMP's extension `context` event; it runs on every provider request with a deep copy of the messages and returns the messages to send) inserts one `{ role: "user", synthetic: true, attribution: "agent", content: LINK_REMINDER }` message right after every user prompt (`role: "user"`, not `synthetic`, not a history rewrite), unless that message already follows it. The prompt is the same object as before. Nothing is persisted: the session file, Chat and a resumed session never contain the reminder. Same gating as the system prompt: `ctx.mode === "rpc"` and `ctx.agent.kind === "main"`; a subagent, the native TUI and every other mode send their messages untouched. The reminder takes its prompt's timestamp and the text is fixed, so request bytes are identical from one request to the next.
- **Why a separate message.** `emitContext` gives each cloned message its history index, and after the handlers it marks every message that differs from its stored form as per-call; the Anthropic provider never anchors a cache breakpoint on or before the first per-call message. Appending the text to the prompt made the prompt per-call, so a fresh session's first request had no breakpoint behind the system prompt and billed about 11–12k tokens uncached. Inserted messages leave every original message unmarked (alignment is by the carried index, not the position), so only the reminders are per-call and the breakpoint sits on the real prompt.
- **Setting.** `omp.linkReminder` (default off) is read when Desk launches the session and handed to the module as `OMP_VSCODE_LINK_REMINDER` (`1` or `0`); anything but `1` registers no `context` handler. Like other launch values it applies to sessions started or resumed afterwards. The system-prompt rules stay as they are.
- **Variants measured** (installed OMP 18.8.5, claude-opus-5-5, headless `--mode rpc` with the module, a four-file TypeScript fixture with the question "explain this small project ... Twin ... no ProcessRoutine", 8 to 16 runs each, run in parallel on the same day; mentions counted with `parseCodeSymbol` over the final reply):

| Variant | runs | linked symbols | plain symbols | plain share | request 1 (input / cache read / cache write) |
|---|---|---|---|---|---|
| no reminder | 8 | 81 | 87 | 52% | 4 / 28557 / 0 (warm) |
| appended to the prompt (the first implementation) | 8 | 101 | 63 | 38% | 11.5k–12.1k / 17169 / 0 |
| persisted custom message (`before_agent_start` `message`) | 8 | 104 | 68 | 40% | 2 / 28557 / 125 (writes it) |
| inserted developer message | 16 | 181 | 140 | 44% | 127 / 28557 / 0 |
| inserted synthetic user message (chosen) | 16 | 212 | 93 | 30% | 127 / 28557 / 0 |
| chosen, final code | 3 | 37 | 17 | 31% | 127 / 17169 / ~11.9k (a fresh cache) |

  File and folder mentions were inline-code paths in every run with and without the reminder (59–63 per 8 runs, 0 bare, 4 once): the question already makes the model name files, and `file-links` already works, so the fixture shows no change for paths. The differences between variants are within run-to-run noise except the appended and inserted-user variants against none; the developer role gave no better rate than appending, the user role the best. Cost: the reminder is about 123 tokens; it follows the breakpoint, so each prompt's first request bills it uncached once (about 120 tokens) and the next request writes it. Over a three-prompt session every request after the first read 29–30k tokens from cache. The persisted variant caches normally but stores the message in every session file and needs Chat to hide its `customType`; the inserted variant stores nothing.

## Alternatives

- **Resolve in the OMP process.** OMP has its own `lsp` tool, but the Chat page is rendered by the host window, not by OMP, and ADR-0013 rejected a reverse bridge from OMP to VS Code's providers. Resolution here serves only the transcript's links and returns nothing to OMP.
- **`vscode.executeDefinitionProvider` from a document position.** There is no document position for a span in a chat reply; it would need a synthetic source file.
- **Own index (ripgrep for `class Name`).** Language-specific, wrong for partial classes and overloads, and duplicates what the language server already knows.
- **Picking one result when ambiguous (most members, first path).** Explicitly rejected by the maintainer: a wrong link is worse than plain code. An ambiguous symbol links to the symbol search instead (Ambiguous symbols).
- **Treating a possibly capped result as unavailable.** Rejected: the cap cannot be observed through the API (a full list and a short list are indistinguishable from "that is everything"), so a threshold would also disable the common, correct case of a unique class in a large project. The limit is disclosed instead.
- **A new message family outside `terminal-link-*`.** The terminal-link exchange already has the panel and bridge plumbing, the document-currency checks and the cwd binding; a sibling message reuses all of it. The cost is the explicit integration list above.

## Risks and Open Questions

- Provider caps and ranking (see Guarantee and its limit). A common member name (`Start`) in a large C# project can have its other declarations cut off; most such names are ambiguous in practice and then also link nothing.
- Generics and overloads: `Foo<T>` and `Foo` are two types in C#; a provider that strips type arguments reports both as `Foo`: ambiguous, correctly. A generic method with overloads is ambiguous. A dotted `Type.Member` whose member is inherited resolves to nothing.
- A TypeScript server starts lazily; until a TypeScript or JavaScript file is open it may answer no workspace symbols (an unknown name then costs one extra query, five seconds later).
- Providers that return `SymbolInformation` locations without a range cannot give a definition line; the link opens the file at its top.
- C# was not available in the isolated test environment; its behavior rests on the provider contract and on unit tests with Roslyn-shaped entries.

## Rollout and Verification

1. Shared parser/protocol, host resolver and handler, page class and component, setting, prompt rule, docs.
2. Unit tests: candidate extraction and normalization (accept/reject table, nested generics, attribute calls, unbalanced delimiters, non-ASCII, digits), matching (exact, dotted container, attribute alias, ambiguity, kinds, partial classes, overloads, outside the workspace, no-position entries), the resolver (cache lifetimes, invalidation fencing, the slot limiter with hung providers and a full waiting line, unavailable not cached), the handler (disabled, setting/folder revocation, replaced document, batch deadline), protocol parsing, the page client (batching, budgets, retry, cooldown, disposal) and Markdown rendering (assistant-only, path-first, code blocks and labels).
3. Isolated VS Code environment with a TypeScript fixture and a real model reply: links only for resolvable symbols, a click opens the right line.
4. Prompt effect: the same question, with the old and the new rule, several runs each, counting links the model wrote versus symbols left plain. Measured on one fixture question (a table plus a bullet list about eight symbols, one of which does not exist), model GPT-5.6-Luna, three runs each, counting symbol mentions: old rule 47 linked and 8 plain (4, 1, 3 per run; 5 of the 8 were real symbols), new rule 43 linked and 6 plain (2, 3, 1 per run; 3 of the 6 were real symbols); the rest was the symbol that does not exist. The difference is within run-to-run variation: the reworded rule did not measurably change how many symbols the model links on this question, so the host resolution stays the main source of links (it linked what the model left plain in the isolated window), and bare lowercase method names (`run`, `cast`) are prose to the parser and stay plain.

## Related Decisions

[ADR-0058](../decisions/0058-resolve-chat-code-symbols-in-the-host-window-through-workspace-symbol-providers.md) (this design's decision). [ADR-0013](../decisions/0013-authenticated-reverse-rpc-for-vscode-language-providers.md) (rejected; language tools for the agent stay native OMP `lsp`; this feature registers no tool and returns nothing to OMP). [ADR-0023](../decisions/0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md) and [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) (additive: a presentation exchange over the existing authenticated routes; no transcript, broker or session change).

## Architecture Review

- Reviewer: architect
- Outcome: accept (fourth pass). Pass 1: accept with required changes (11 findings, ADR required); pass 2: accept with required changes (ten findings: waiting-query lifetime, generation fences, local truncation, unresolved locations, freshness, budgets, request correlation, fallback failure, ADR alignment, grammar); pass 3: accept with required changes (four findings: oversize metadata, host batch admission, refused-token retry, raw length); pass 4: no remaining findings. The reviewer inspected source and test definitions and ran no tests; runtime acceptance (isolated VS Code window, real model) is recorded separately.
- Notes: after acceptance the maintainer relaxed the ambiguity rule (partial parts and overloads are one symbol; the cwd narrows distinct symbols), the adapter filters fuzzy entries before the 1000 bound, timeouts were raised and retries doubled for slow Roslyn, and each lookup is logged; the safety envelope (host-owned, bounded, fenced, presentation only) is unchanged and no new review round was held. The maintainer-approved choices (provider caps reported as a limit, bare-capitalized-name type preference, file-only link when a provider gives no position) were accepted as contract; no mounted-component tests exist because the repository has no DOM test infrastructure.
