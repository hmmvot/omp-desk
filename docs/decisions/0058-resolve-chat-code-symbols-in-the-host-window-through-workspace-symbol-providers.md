---
status: accepted
date: 2026-10-10
---

# ADR-0058: Resolve Chat code symbols in the host window through workspace symbol providers

## Context and Problem Statement

A Chat reply names code symbols in inline code (`Ability`, `AbilityData.Cast()`, `[AllowedOn]`). The model is asked to link them to their definition line, and does so for only some of them. Making every resolvable symbol a link needs something that knows where a symbol is defined. Candidates for that knowledge: the model, OMP's own `lsp` tool, VS Code's language providers, or an index of our own. The decision has lasting effects: it adds a page-triggered call into VS Code's language providers, a maintained bridge operation, and a visible promise ("a link means exactly one definition") that users and later changes will rely on. It must not be confused with the rejected agent-facing language-provider bridge ([ADR-0013](0013-authenticated-reverse-rpc-for-vscode-language-providers.md)).

## Considered Options

- **Model-authored links only (status quo).** No new mechanism; coverage depends on what the model saw and remembered, and was observed to miss type names mentioned from usages, symbols in tables and lists, repeats and method names known only by file.
- **Ask OMP's `lsp` tool for each symbol.** Costs agent turns or a second OMP channel, belongs to the session's process rather than to the window that renders the transcript, and would reopen what ADR-0013 rejected in the other direction.
- **Own index (a text search for declarations).** Language-specific, wrong for partial classes, overloads and generics, and duplicates what the installed language extensions already maintain.
- **Host-owned resolution through `vscode.executeWorkspaceSymbolProvider`, presentation only.** The extension host window that renders the transcript asks the providers it already has, answers the page over the existing authenticated terminal-link exchange, and links only an unambiguous match inside the session's folders. Uses every language VS Code has a provider for; cost is the provider's search semantics (ranked, possibly capped, not exhaustive).

## Decision Outcome

Chosen: host-owned resolution through the workspace symbol providers, for presentation only.

- The page asks (`omp:terminal-link-symbols`) and the host answers (`omp:terminal-link-symbol-resolution`) over the same panel and bridge routes as file-link validation; the host repeats candidate parsing, derives scope from the session itself (never from the page), re-checks document currency and the setting after the provider answers, and opens nothing: a click is the ordinary link open, re-validated against the session folder.
- A link to a definition is made only when exactly one matching declaration inside the session's folders is reported, and only in assistant reply text. A token with several different definitions links to VS Code's workspace symbol search for its name (`omp:terminal-link-open` with `search: true`; the host re-parses the token and runs only `workbench.action.quickOpen` with `#<name>`), never to one of them (maintainer decision, 2026-10-10). The parts of one symbol (the partial parts of a type, the overloads of a member in one container) are one declaration, opened at the type's own file or the first location by path and line (maintainer decision, 2026-10-10); no heuristic chooses among distinct symbols (same-named types in different containers), except that exactly one lying inside the session cwd is taken; the further maintainer-approved preference is that, for a bare capitalized name, type-like entries are counted alone when any matches (a class `Ability` is not made ambiguous by a property `Ability`). A declaration without a position is its own declaration: unresolved overloads are never merged. Everything uncertain stays plain code. The accepted residual risk is that a workspace symbol search is not an exhaustive index: providers may cap and rank results, so a hidden second declaration is possible for a common name in a very large workspace. This follows the maintainer's brief and is disclosed to users. A cut that Desk makes itself (more than 1000 entries in one answer) is known, and never yields a unique match.
- Bounded and fenced: a window-wide limiter on actual provider calls that releases a slot only when the provider settles; a waiting line of 64 whose entries give up after the query timeout, with overflow refused at once; a generation counter, bumped by file-system, saved-document and workspace-folder changes, that fences cached, in-flight and queued work (the setting is not fenced by it: the handler re-reads it after the provider answers and the page stops asking for 30 s once told it is off, with no configuration listener); short cache lifetimes; a per-window readiness rule (an empty answer is not a verdict until some query has returned a symbol; a full queue and a timeout are not verdicts either: such tokens are parked as `pending` and the host signals the pages to ask again when the provider is ready or its queue has drained, see the design); and a user setting (`omp.linkCodeSymbols`).
- No information flows to OMP and no tool is registered: the agent's language tools stay native OMP `lsp` (ADR-0013 stays rejected history, and this record neither revives nor amends it). The record is additive to [ADR-0023](0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md) and [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md); neither is superseded.

### Consequences

- Positive: most symbols the model names become links in any language VS Code supports, without more agent turns; the prompt rule only needs to help, not to be exhaustive; the exchange adds no opening authority and no session mutation.
- Negative: a link means "one matching declaration in the provider's answer", not a proof of uniqueness; coverage depends on the language extension being loaded and indexed (a TypeScript server starts lazily; C# Dev Kit needs its project loaded); positions are as precise as the provider's locations; unsaved edits are visible to the provider but not to this feature's invalidation until a save or file-system change; an extra bridge operation and message pair must be kept in step with the terminal-link family.

## Related Documents

[Design](../designs/2026-10-10-code-symbol-links.md); [ADR-0013](0013-authenticated-reverse-rpc-for-vscode-language-providers.md); [ADR-0023](0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md); [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md).

## Architecture Review

- Reviewer: architect
- Outcome: accept (fourth pass of the design's review, which covered this record); earlier passes required the ADR and then aligned its wording with the implementation.
- Notes: none open.
