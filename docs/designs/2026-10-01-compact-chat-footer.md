---
status: implemented
date: 2026-10-01
---

# Compact chat footer and native provider login

## Problem

The chat repeats session metadata above and below the transcript, exposes secondary configuration/tool/quota panels, and renders empty provider thinking as an empty disclosure. The user has decided to remove these surfaces, retaining only model/thinking controls, context, abnormal status and native provider login.

## Goals and Non-goals

- Suppress empty/whitespace thinking; preserve non-empty reasoning and redacted markers.
- Remove the notices history, header, Controls and Show panels and their exclusive protocol/CLI plumbing. Preserve command-output transcript cards and the phase banner.
- Place one compact row under the composer: model, thinking, context and abnormal statuses only.
- Preserve request correlation, host readback and mutation exclusion; never optimistically display a selection or retry an unknown mutation.
- Expose native provider login in the Command Palette and Sessions title overflow menu.
- Centre equally sized composer buttons against the input; describe folder rows with a bounded middle-truncated cwd and full-path tooltip.
- Non-goals: settings editing, quotas, tool inventory, additional onboarding, runtime ownership changes, VSIX installation or GUI interaction.

## Previous State

`App` previously rendered HeaderBar, hidden HostControls, Transcript, Notices, UsagePanel and Composer. HostControls owned the correlated model/thinking exchange, with embedded SettingsControls and ToolControls. The extension already launched provider login in a visible terminal. RpcSession owns model/thinking mutations and available-option/readback reads; the authenticated host-control pipe separately supplies process binding and file-evidence support.

## Implemented Design

A permanently mounted `ChatFooter` replaces HeaderBar, HostControls and UsagePanel. The chips render only the pushed host-owned chat state, never the requested value or a separate cached display state. The correlated control exchange retains increasing request ids, document action sequence, host mutation gating and outcomes. A lightweight snapshot reads gating without fetching catalogues. Options are read only when a picker opens, never on mount/live or in a mutation reply, and are invalidated on model/thinking/state changes. An invalidation while open coalesces behind the outstanding request. A response must match the newest scope/id. A request timeout briefly reports an unknown outcome but keeps mutation exclusion until that request answers; late matching responses clear the gate. No mutation is resent.

RpcSession uses only the parsed `set_model` response for model readback, reporting an unknown outcome without changing state if that response is unusable. Thinking state comes from OMP's effective `thinking_level_changed` event; an accepted response never overwrites a clamped level with the requested level. If no event is emitted, the state remains unchanged.
The independent extension status bar follows the same host-owned state: authoritative chat model events refresh it, so footer changes, native readback and effective thinking clamps cannot leave its label stale. It never uses the requested value.

Fixed host command refusals/unknown outcomes use a host-only `command_feedback` frame that the child-event mapper cannot produce, retaining one transient footer value, not history. Child notice, notify, retry and compaction/error history mappings are removed; rpc-frame-error diagnostics and resync remain. Command-output cards keep their existing page-held, non-snapshot semantics. The `setStatus`/`setWidget` composer hint remains unchanged.

Each picker uses an upward anchored themed listbox, current selection marker, dim provider labels, arrow navigation, Enter selection, Escape dismissal and outside-click dismissal. Mutation gates include non-live/read-only, unavailable host mutation, unavailable options and an outstanding request. Disabled chips explain the reason in a tooltip. Context uses only host context usage and context-window facts, leaving unreported values unknown. Right-side chips show working, read-only, nonzero queue and non-live phase with existing colours, never the live phase.

Remove removed UI-only message variants, handlers, CLI readers, config dump projection, usage aggregation and tests. Retain authenticated host-control binding, evidence machinery, and the independent palette commands (including Copy Active Tool Names and Show Host Controls without configuration). The pipe's names-only `listTools` therefore remains, while tool-state Webview plumbing is removed. Provider login keeps the existing executable/cwd/profile and visible-terminal implementation; only extension commands can initiate it. Folder descriptions use a 40-character display budget, preserving root/drive and tail text with one middle ellipsis; full cwd remains in the tooltip and the accessible label retains session count.

Removing the strict pipe config payload bumps `CONTROL_PROTOCOL_VERSION` to 3; changing the control DTO bumps `GUEST_PROTOCOL_VERSION` to 3. No tolerant parser, shim or dead config generator remains. A previous-build child must be explicitly Reloaded to regain verified host control (new evidence consent, Copy Tools and identity details); its rpc chat, bridge, shell and broker are unaffected. Already-consented child-side capture is expected to continue independently [INFERENCE]. An old page's existing mismatch gate asks for Reload Window. Broker/PTY versions are unchanged.

## Alternatives

- Hide existing panels: rejected by the clean-cutover requirement; it leaves dead protocol, CLI execution and maintenance burden.
- Native select elements: rejected because the requested anchored upward popup and keyboard presentation must be consistent with VS Code theme colours.
- Optimistic chip values or automatic mutation retries: rejected because an unknown or overtaken mutation cannot safely be assumed successful.

## Risks and Open Questions

- A model change may alter thinking capabilities: discard cached options and fetch only while the popup is open; never overwrite effective readback with the requested value.
- Host invalidation may arrive during a request: coalesce to one later snapshot without replacing or repeating that mutation.
- Pipe snapshot has independent identity/evidence callers: preserve binding verification rather than removing the pipe wholesale.
- Installed-window visual acceptance is a separate step; headless interaction and packaging do not claim installed verification.

## Rollout and Verification

Implement one coherent cutover across host/protocol/UI/commands/tree after architecture review. Cover empty-thinking suppression, popup selection/request/readback, keyboard dismissal, and path truncation boundaries with deterministic focused tests. Remove tests exclusive to removed surfaces. Run typecheck and the full suite once after all changes, then rebuild the VSIX and record its SHA-256 plus `out/extension.js` SHA-256. Exercise the rendered changed surface headlessly without controlling VS Code. No intermediate project-wide checks or installation.

## Related Decisions

- [RPC-UI chat and Sessions](2026-09-29-rpc-ui-chat-and-sessions.md) — narrowly superseded for notices, settings, tool inventory and usage panels; rpc chat and ownership remain.
- [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) — rpc mutation/readback and process ownership remain; this design removes the secondary UI specified there.

## Architecture Review

- Reviewer: architect
- Outcome: accepted after changes (independent architect review, 2026-10-01).
- Findings addressed: effective readback, one pushed display source with lazy catalogues, timeout exclusion, host-only transient command feedback, independent palette tool command retention, and explicit protocol-v3 upgrade effects. No competing product design was introduced.

## Implementation Evidence

- Real React headless Chromium exercised empty/whitespace suppression, expansion of non-empty/redacted thinking, model/thinking selection through requests and pushed readback, mismatched-reply rejection, pending invalidation without mutation replay, arrow/Enter/Escape and outside dismissal, upward popup placement, read-only gates, footer context/statuses and centred composer actions (`src/webview/chat-ui.test.ts`; scoped run passed).
- RpcSession tests prove clamped effective thinking readback and preserve prior model on unusable successful mutation responses. Tree tests cover the 40-character boundary, drive/Unix/UNC starts and tails, full tooltip and accessible path (`session.test.ts`, `session-tree.test.ts`; scoped runs passed after obsolete wording-test removal).
- Follow-up status-bar regression exercises the real footer control handler, RpcSession, ChatRuntime event consumer and ChatClient projection with an observed status item. Pending requests preserve old values; effective model/thinking readback updates both consumers, and an accepted response cannot overwrite a clamped level (`src/extension-lifecycle.test.ts`; scoped run passed).
- Final project-wide validation and VSIX hashes are recorded outside this document, not asserted as installed-Webview acceptance. No VS Code GUI or VSIX installation was performed.

## Native footer follow-up (implemented; review recorded below)

This follow-up supersedes the baseline's embedded pickers, quota non-goal and
usage-reader removal. It does not restore an account panel. HTML selects and
native VS Code QuickPicks are different alternatives; native search is now the
user's explicit choice.

### Native controls and readback

A correlated `snapshot` request names a model/thinking picker. The host lazily
reads OMP's catalogue and opens `window.createQuickPick`, with description/detail
matching enabled. Model labels are names, descriptions providers (plus ids for
duplicate names), and current items are marked in detail and made active.
Thinking lists only the current model's reported levels. The picker response
returns a selection separately from effective state; the page sends the existing
sequenced set-model/set-thinking request. Chips still display only pushed host
readback. Thinking shows only its level, and context has no `ctx` prefix.

One window-local picker registry cancels replaced pickers. Editor close, route
replacement, session replacement/drop and departure from live cancel the
affected picker. A model change cancels an outstanding choice; an overtaken
thinking choice reports a fixed notice. Page route/host-link changes release only
picker waits, reject late selections and request a plain snapshot; they never
replay mutations or reopen a picker. Catalogue failures/busy outcomes are brief
fixed feedback. Native pickers have no mutation timeout while the user is
choosing. Mutation timeouts keep the existing unknown-outcome exclusion.
Selection guards read the synchronous ChatClient reducer, not the last React
render: a state push and selection reply in the same task cannot apply an old
model's thinking level to its successor.

Guest protocol **4** removes page catalogue/read-gap fields, replaces
`includeOptions` with `picker`, and adds selected-value and footer-metadata fields.
Old pages use the existing Reload Window mismatch gate; pipe protocol 3 and
broker/PTY versions are unchanged.

### Follow-up (2026-10-08): native Tools output picker and hover-widget context card

The composer's **Tools output · Overview ▾** chip no longer opens an in-page
popover. A click posts the existing `omp:chat-tool-detail` request, which now
carries only the conversation epoch and a request id (the page never names a
value), and the host opens a native QuickPick titled `Tools output` through
the same picker registry as the model and thinking pickers. Rows are Overview
("Group routine tool calls into one-line summaries") and Detailed ("Show every
tool call as its own row"); the setting in force is marked
`Current tools output` and active, as in the thinking picker. The host writes
`omp.toolCallDetail` (global target) from the row chosen and rebroadcasts the
readback to every open Chat, so the chip label, its accessible name
(`Tools output: Overview` / `Tools output: Detailed`) and the transcript density
follow from the pushed preference, never optimistically. Dismissing the picker,
a stale epoch, a replaced picker or a departed conversation change nothing.

This deliberately does not use the model/thinking `snapshot` + `picker` control
request. That exchange is gated on a live, writable, host-controlled session;
the Tools setting is a global presentation preference that already worked from
read-only, stopped and non-controlling editors, and it must keep doing so. The
request therefore stays on the existing presentation route (bridge stream
operation and panel route, no writer admission) and the QuickPick is opened
from `ChatRuntime` through a host-supplied `pickToolCallDetail`. The popover
component, its CSS and its dismissal/`menu` Escape-owner wiring are deleted.

The context ring's hover card now looks like VS Code's own hover widgets:
`--vscode-editorHoverWidget-background` and `-foreground`, a 1px
`--vscode-editorHoverWidget-border` (falling back to
`--vscode-widget-border`) and `--vscode-widget-shadow`, instead of the composer's
input background, which made it nearly invisible against the chat panel.
No other composer popover needed the change: the slash/@path list already uses
suggest-widget tokens.

### Quota source, scope and account rule

Metadata is retained per conversation and replayed on every panel/bridge route
attach, including a forced `omp:ready` resend and passive editors.

The host runs the session's installed
`omp usage --json --redact --provider <current-provider>` asynchronously, using
its actual runtime cwd and explicit profile/default sentinel. `--provider` limits
the output projection; OMP may still probe other providers internally. The
in-memory cache and five-minute attempt throttle are keyed by executable command
and prefix arguments, effective profile, runtime cwd and provider. Concurrent
requests coalesce; failed exit/parse/spawn readings log fixed credential-free
diagnostics and preserve the last successful value. Raw stdout/stderr is neither
logged nor persisted. Start/live baseline and **agent_end** (not per-tool
`turn_end`) refresh usage. Effective model/provider changes immediately project
that scope's cached value or hide it, with refresh under the same throttle.

Only actual reported `usedFraction` measurements and existing windows reach the
chip; unmeasured/windowless limits are skipped. No remaining-percent inversion,
token extrapolation, reset-credit count or account-capacity aggregate is shown.
Window ids supply concise labels (`5h`, `7d`, `monthly`); daily aliases normalize
to `1d`. Monthly percentages floor; other windows round, matching TUI display.
Failures intentionally retain old readings even past a reset; the tooltip names
their reported reset time rather than pretending a fresh reading was obtained.

**Account rule and evidence:** installed OMP 18.4.4's TUI
`packages/tui/src/status-line/component.ts`, `#normalizeUsageReports`, filters by
`getActiveOAuthIdentity`/`limitMatchesActiveAccount`; it does **not** aggregate
accounts. Its scope priority is exact model before provider-wide, and untiered
before tiered within each specificity, with the first group winning a tie and
the first candidate per ordinary window. Cursor monthly dashboard rails retain
their TUI priority. `segments.ts`, `formatQuotaWindow`, supplies rounding policy.
Neither rpc-ui state nor `omp usage --json` exposes the live session's credential
affinity, so the actual account is not attributable when several reports exist.
The explicit fallback is the **first matching provider report in CLI order**;
within that account, the chip follows those TUI scope-group rules. This can
change when OMP filters a failed report and is not claimed as the active account.
The tooltip says that attribution is unavailable and lists **every reported
account's windows and resets**, using only masked CLI labels (email/accountId/
projectId ending in `*` without `@`) or anonymous `account N`. No unmasked
identity crosses the projection, even if a CLI ignores `--redact`. This follows
The maintainer's decision not to hide merely because multiple accounts exist.

### Session cwd Git and row actions

`vscode.git` is optional and activated lazily, with no new dependency or
`openRepository` call that would alter SCM membership. The deepest exposed
repository containing the actual session cwd owns branch readback and updates
on repository-state/open/close events. Detached HEAD shows the short commit.
Without an exposed repository, asynchronous
`git rev-parse --abbrev-ref HEAD` (then `--short HEAD` when detached) runs in cwd,
without a shell, with `GIT_OPTIONAL_LOCKS=0` and a five-second timeout. Outside a
repository the chip is hidden. Start/agent-end refresh this fallback; native
repository state outranks pending CLI results. Observation is disposed with the
conversation and callbacks recheck identity/cwd; unchanged branch values do not
republish.

The row context menu is Open (stopped/draft), Reload/Rename/Close (running),
Forget, Delete, in that order, retaining existing Forget/Delete eligibility.
Stop exists only for Blocked rows held by another verified window, never own
running rows. Palette titles are one word with category OMP. The obsolete
`omp.resumeSession` alias is removed; `omp.openSession` now launches. A separate
internal `omp.clickSession` command avoids counting context-menu/palette Open as
a tree click. Its injected-clock recognizer opens stopped history immediately,
then launches the same stopped tab/file on a second click within **400 ms**
(inclusive), through the existing gate after any first history open finishes.
Running/blocked/draft clicks and different identities clear the pair; running
clicks reveal, and fileless draft clicks retain immediate launch.
Click recognition uses the displayed row state synchronously, with a current
local-running override; asynchronous claim/broker probes remain in the admitted
open/launch path, never in the 400-ms clock measurement.

Stopped-row prompts and tooltips call the launch action **Open**, including the
verified-writer **Stop and Open** confirmation. The Chat composer's own button for
a stopped session is **Resume**, because inside an already open editor "Open" read
as opening something else. The folder-level history action remains **Resume
Session**; native resume terminology and internal wire verbs are unchanged.

### Alternatives and verification

Rejected: page popups (native search required), optimistic chip values (violates
readback authority), all-provider/account UI (not requested), periodic unbounded
polling (not requested), workspace-root Git (wrong cwd), delayed first click
(history must be immediate), quota aggregation (not TUI's account semantics).

Focused tests exercise native cancellation/name collisions/current focus,
thinking-model/route races, non-optimistic readback and failure exclusion,
provider/model/account/window projection, five-minute coalescing/retention, Git
containment/detached/state replacement and injected-clock boundaries/menu
eligibility. Headless Chromium exercised the rendered changed footer. A real
installed-OMP smoke returned current Codex `7d 73%`, its reported reset, one
account, a feature branch name in session cwd, and hidden Git outside a repository;
the second read reused the cache. The scratch runner was removed afterwards.
Final typecheck, full tests, VSIX build and hashes belong to the final validation
step. No VS Code GUI, installation or commit was performed by this follow-up.

### Follow-up architecture review

An independent architect reviewed the extension and
installed OMP interfaces: accepted after changes. The first group of findings is resolved in
the scope/cache/account/lifetime/replay/protocol/privacy/Git/click contracts above.
Three further findings use effective-provider projection, shared native palette
picker helpers and a reserved current-marker detail field. The hide-after-reset
suggestion is not adopted because failures must retain the last value; reset times stay visible.
Final independent architect confirmation accepted the clarified account fallback
with no material findings remaining.
Native-QuickPick appearance and tree behavior under
`workbench.list.openMode=doubleClick` remain visually unverified; scoped
headless/module evidence does not claim installed GUI acceptance.
