---
status: accepted
date: 2026-10-19
---

# Chat: turn totals, served-model marker, thinking time and the provider-error frame

Gap closing against OMP's terminal UI (TUI), 2026-10-19: Chat showed less around a reply than the TUI does by default. Verified in the installed OMP 18.11.1 sources (`pi-tui/src/overlays/usage-row.ts`, `pi-tui/src/chat/served-model-marker.ts`, `pi-tui/src/chat/assistant-message.ts`, `pi-ai/src/types.ts`).

## Problem

1. The TUI draws `12.4s · 19K tok · $0.02 this turn` under a finished answer (default on). Chat's reply footer showed only a duration, a time of day and Copy.
2. The TUI marks a reply whose provider served another model (`served X · requested Y · via provider/upstream`, default on). Chat showed nothing, although `upstreamModel`/`upstreamProvider` are already on the parsed message.
3. The TUI titles a thinking block `Thinking… 7s` while it streams and `Thought for 7s` after. Chat titled it `Thinking` always.
4. A failed request was one line (`Provider error` and the text) plus Retry. The TUI's frame has the HTTP status, the message once, Copy error, Switch model and Retry.

## Goals and Non-goals

- Goals: the four TUI behaviours above, as in the TUI's default settings, without a false marker: a substitution is shown only when the installed OMP's own classifier says the served model is another model.
- Non-goals: the TUI's opt-in per-request usage strip, per-request turn time and cache-miss marker (default off in `settings.ts:660-690`); a marker for an id the classifier cannot classify; changing what OMP records.

## Current State

Chat's reply footer (`ReplyFooter.tsx`) showed the turn's duration, a time of day and Copy; the parsed assistant message already carries `usage`, `upstreamModel`, `upstreamProvider`, `errorMessage` and `errorStatus`; the thinking block's title was a fixed `Thinking`.

## Proposed Design


### Turn totals

Same sums as `TurnUsageTally`: prompt = input + cache writes + orchestration input (cache reads are not a total), output + orchestration output, cost = billed total; no line when no tokens and no cost; the cost is omitted at zero and reads `<$0.01` below half a cent. The footer already has the turn's duration, so the line is `19K tok · $0.02 this turn`; the tooltip has the exact in/out/cache-write/cache-read counts and the request count.

The totals are computed from **all loaded entries**, not from the cards in the window (`turnMeta` in `chat/reply-turns.ts`): a request that is only tool calls has no row, and a long turn can start above the window. Turns are the footers' own (observed invocation by message key, else the interval since the user's last prompt), and the result is keyed by the entry of every request, so a footer finds its turn through its host message's entry. Per-request detail (time to first token, tokens per second) is not shown: the TUI hides it by default (`settings.ts`), and the footer's tooltip already carries what a turn adds up to.

### Served-model marker

Whether two ids are the same model is OMP's `classifyModel`, a rule table of several hundred lines that changes with OMP releases. Desk has no compile-time dependency on OMP, and a port or a textual rule produces false positives (dated snapshots, gateway prefixes, aliases, codenames). So the verdict comes from the installed OMP, the way the slash registry already does it (`media/slash-registry.mjs`, `host/slash-registry.ts`): a staged Bun helper (`media/served-model.mjs`, run from a staged copy under [ADR-0012](../decisions/0012-run-child-process-entries-from-staged-copies.md)) imports the installed agent's classifier and applies the TUI's rule (`detectServedModelMismatch`: same class, same family, compatible revision is the same model; either side unclassifiable is `unknown`). The page asks only about pairs whose served id differs textually from the requested id (`omp:served-models-request`, at most 8 pairs, answered by `omp:served-models` with one verdict per pair); the host memoises per installed package and version and does not cache a failed read. `mismatch` is the only verdict that draws anything; no answer, `same`, `unknown` and a bridge route (which cannot carry the exchange) draw nothing.

The marker goes into the footer of the reply that holds the first request with a `mismatch` verdict for each distinct (provider, requested, served), in transcript order and not in arrival order of the answers, like the TUI's `ServedModelTracker`. A turn without a footer (no finished text) carries no marker.

No new ADR: the helper repeats the slash registry's accepted pattern (installed OMP, Bun helper, staged copy) and adds no dependency.

### Thinking time

The wire carries no duration for a thinking block. The page measures it as the TUI does: from when the block is first seen streaming until a later block appears or the message ends (`chat/thinking-clock.ts`, fed by the transcript from the stream). A block is keyed by its request's own stamp (timestamp, provider, model) and position, so the time survives the message becoming a saved entry. A block the page did not watch begin has **no time and reads `Thought`**: saved history, a block first seen already passed over, and a block first seen together with a fresh snapshot of the session (detected by the entries changing in the same commit as the stream appearing; a stream's own updates leave the entries alone). A mistaken "attached" is the safe direction: it only drops a time. While streaming the title ticks once a second and shows no number below one second.

A static thinking block (a saved reply) used to be titled `Thinking`; it is `Thought`, as the TUI says for a finished block of unknown length.

### Provider-error frame

`errorStatus` (pi-ai `AssistantMessage.errorStatus`, set by every provider's catch block) gives the status chip; absent or not 100–599, there is no chip, and the text is never scraped. The body is cut to three lines past 240 characters or three lines, with Show all / Show less kept in the transcript's disclosure state. Copy error copies `HTTP 429: message`. Switch model and Retry belong to the newest failed reply of an idle session; Switch model calls the composer footer's own model picker through a small registry (`lib/model-picker.ts`) that the composer footer fills while it can open one (it is unavailable when the footer's model button is), so there is one implementation of the picker's host exchange.

## Alternatives

- **Port `classifyModel`** into Desk: rejected, a second copy of a moving rule table with a false-positive tail.
- **Compare ids textually** (strip a vendor prefix and a date suffix): rejected, aliases and codenames are exactly where it is wrong, and the requirement is no false positives.
- **Totals from the cards**: rejected, tool-only requests have no card and the window cuts turns.
- **Scrape the HTTP status from `errorMessage`**: rejected, `errorStatus` exists.

## Risks and Open Questions

- **The rule is partly duplicated.** The helper takes the classifier table from the installed OMP but composes the comparison itself (class, family, compatible revision, as `detectServedModelMismatch` does). A change of that composition in a future OMP would diverge silently until Desk follows. The host test pins the helper's verdicts against the installed OMP for a pair table; it does not compare the two rules.
- **A failed read is one-shot for a Chat page.** When the helper cannot be staged or run, the host answers `unknown` for the pairs, remembers nothing, and logs it; the page keeps that answer and asks again only after the Chat is reopened or the window reloaded. The cost is a hidden substitution after a broken read, never a false marker.
- **A thinking time is the page's measurement**, from its own first sight of the block, so it can be shorter than the model's, and a Chat attached mid-block shows none.
- OMP releases after 18.11.1 may rename `errorStatus` or the identity module; each failure degrades to no chip or no marker, never to an error.

## Rollout and Verification

One change, no flag. Verified by the unit, host, protocol and dispatcher tests and the Chromium page test below.

### Tests

`src/chat/reply-usage.test.ts`, `reply-meta.test.ts` (totals incl. tool-only requests, no usage, zero cost, windowed turn, steered observed turn, recovered request), `served-model.test.ts`, `thinking-clock.test.ts`, `provider-error.test.ts`; `src/host/served-model.test.ts` (answer validation, memo, the installed OMP's real verdicts), protocol and dispatcher tests; `src/webview/reply-meta-ui.test.ts` in Chromium (totals text and tooltip, window cut, served marker once per pair with snapshot/codename/unanswered cases, live and replayed thinking time, the error frame's chip, clamp, copy, Switch model and Retry).

## Related Decisions

- [ADR-0011](../decisions/0011-use-installed-omp-without-version-gate.md): Desk works with the installed OMP without a version gate; the marker degrades to nothing when the installed OMP cannot answer.
- [ADR-0012](../decisions/0012-run-child-process-entries-from-staged-copies.md): the helper runs from a staged copy.
- No new ADR. The choice to ask the installed OMP instead of porting its classifier is the slash registry's established pattern (`media/slash-registry.mjs`, which [ADR-0052](../decisions/0052-answer-terminal-only-commands-and-restore-the-queue-on-stop.md) relies on), applied to a second question; it adds no dependency and no new trust boundary (a Bun script from the extension, run from a staged copy, over the OMP the user already installed).

## Architecture Review

- Reviewer: reviewer (separate agent)
- Outcome: one review; one material finding (a failed read is not retried by the page while the doc promised no caching: resolved by stating the one-shot behaviour above) and three should-fix items (partly duplicated rule recorded as a risk, template sections, the ADR rationale) addressed in this text
- Notes: the review verified the sums, the wording, `errorStatus` and the marker rule against OMP 18.11.1 and ran the helper against the installed package.
