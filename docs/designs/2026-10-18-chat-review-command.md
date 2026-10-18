---
status: accepted
date: 2026-10-18
---

# `/review` in the Chat: a command that asks before it answers

Requested by the maintainer (2026-10-18): "Support the `/review` command." In OMP 18.11.1 `/review` is a bundled **custom command** (`extensibility/custom-commands/bundled/review/`: `index.ts`, `target.ts`, `diff.ts`, `prompt.ts`), not a terminal builtin.

## Problem

Whether Chat could run `/review` at all was unknown. The command is not a prompt template: it runs inside OMP's `prompt` command, asks the user what to review through `ctx.ui.select`, `ctx.ui.input`, `ctx.ui.editor`, `ctx.ui.notify` and `ctx.ui.setStatus`, runs `git` (and `gh` for pull requests), and returns the review prompt that becomes the turn. In RPC mode each `ctx.ui` call is an `extension_ui_request`.

## Measured behaviour before the change

Measured on the installed `omp` 18.11.1 and Desk at `5835e84`/`49bc4e3`, on a scratch repository (`main`, a `feature` branch one commit ahead, one uncommitted change), with OMP started in an isolated home so that a user-level `commands/review` could not replace the bundled command, first with a raw `omp --mode rpc-ui` client and then in a hidden VS Code window driven over CDP against the mock model server (`test/e2e/scenarios/44-chat-review-command.spec.ts`).

| Question | Answer |
| --- | --- |
| Is `/review` suggested? | Yes. `available_commands_update` lists `{name: "review", description: "Launch interactive code review", input: {hint: "arguments"}, source: "custom"}`; the popup showed `/review custom`, that description and the hint `arguments`. |
| Is it sent or refused? | Sent. It is not in OMP's builtin registry, so `tuiOnlyCommand` returns `null`; `classifySlashInput` does not deny it. |
| Which `extension_ui_request` methods arrive? | `select` (Review Mode, base branch, commit, pull request list), `input` (pull request search), `editor` (`prefill: "Review the following:\n\n"`, `promptStyle: true`), `setStatus` (key `review`), `notify` (`warning` for an empty diff, `error` for a failed `gh` lookup), `setWidget` (an unrelated extension). Desk already handles all of them: `normalizeUiRequest` renders `select`, `input`, `editor` and `ask` in the composer's dialog (`DialogBody`, `AskEditor`: a textarea, Shift+Enter for a newline, Submit), `setStatus` is the status line, `notify` `warning` is the notice line and `notify` `error` is the window's error message. |
| What does the user see on the happy path? | The Review Mode list; after a pick the review prompt as the user message ("Code Review Request / Mode / Changed Files / Diff…") and the model's answer. A base branch, a commit and the custom editor work the same way. A cancelled dialog leaves no row and no turn. |
| Does the missing `gh` get reported? | Yes. OMP's `notify` error ("Failed to resolve repository for PR picker: GitHub CLI (gh) is not installed. Install it from https://cli.github.com/.") is shown by Desk as the window's error toast; `/review <PR link>` without `gh` shows "Failed to fetch PR diff for …" the same way and sends nothing to the model. |

### What was wrong

1. **A dialog that stays open longer than 30 s reports a delivered message as unconfirmed.** OMP acknowledges the `prompt` only when the command returns, so while the picker waits for the user the acknowledgement does not come. Two fixed deadlines ran on: `RpcSession.#send` gives every command `DEFAULT_COMMAND_TIMEOUT_MS` (30 s) in the host, and `ChatClient.#sendText` gives a text send `SEND_RESULT_TIMEOUT_MS` (45 s) in the page. After a 35 s wait the Chat showed "OMP has not confirmed this message. Your draft was kept; sending it again could deliver it twice." while the review turn ran correctly, and after 150 s "The message may not have been delivered; check the transcript before sending it again." The draft `/review` stays in the composer and a resend runs the command twice. With the host deadline alone repaired, the 100 s scenario still showed the page's sentence: both are needed.
2. **The suggestion says nothing useful.** OMP's description and the hint `arguments` do not tell that the command opens pickers, needs the GitHub CLI for pull requests, or takes a link or a focus.

Not wrong, not changed: the editor dialog exists and is multi-line; no UI method is missing; the error toast is OMP's own `notify` error and Desk's existing, deliberate presentation of it (`extension-error`, "the host shows it as an error message rather than in the transcript").

## Design

### 1. A command's deadline does not run while a dialog is open (host and page)

A dialog that is open means OMP is waiting for the user, not that the link or the child is lost. The same rule is applied at both deadlines.

**Host.** In `RpcSession.#send` each pending command owns a deadline of its own limit (30 s by default, longer where a caller asks for it):

- when the deadline fires while a dialog is open (`model.uiRequest !== null`) it is armed again instead of failing the command;
- `#restartCommandDeadlines()` gives every pending command its whole deadline again whenever a dialog opens (`#onUiRequest`) and whenever one settles (`#dropDialog`: an answer, a Cancel, or OMP's `cancel`), so the time that counts is the time since the last dialog event, and a command that returns late after the answer still has its full deadline.

This covers every pending command except `get_state`: OMP runs `prompt` as a background task and answers `get_state` while a command waits (`modes/rpc/rpc-mode.ts`), so an unanswered state read, the watchdog's probe included, is evidence of a lost child and never of a user who is still reading a list; it keeps its own deadline and its `probe-timeout` recovery. A command that stays silent with no dialog open is reported exactly as before.

**Page.** In `ChatClient.#sendText` the 45 s send-result deadline is a restartable timer with the same two rules: it is armed again, not fired, while the page's model shows a dialog, and `#commit` restarts every pending send's deadline when the dialog on screen changes (opened, answered, withdrawn, or the next of the queue).

What it does not change: a closed link or an exited child still fails every pending command at once (`#failAllCommands`); the watchdog's silence rule, its probe and the reattach path are untouched; a send that never gets its acknowledgement and has no dialog open is `unconfirmed` after the same 30 s and 45 s as before. The composer's "Waiting for OMP to confirm this message" hint is not shown while a dialog is on screen, because the dialog is what OMP waits for.

### 2. A Desk description and hint for the bundled `/review`

`deskListed` in `src/webview/lib/slash-completion.ts` rewrites the catalogue entry of a **custom** command named `review` whose description is exactly OMP's bundled text, to "Review code: pick uncommitted changes, a branch diff, a commit or a pull request (needs the GitHub CLI), or write your own request" with the hint `[PR link] [what to focus on]` (optional: a bare `/review` is sent and OMP asks). A user's own `review` command, and any later OMP wording, keep their own text. Both the suggestions, the argument hint and the Commands list read through it.

## Alternatives

- **Raise the 30 s limit for `prompt`** or for slash text. Arbitrary: a picker can wait an hour, and a real loss of a plain prompt would then be reported late.
- **Disable the deadline for slash prompts.** Loses the report of a message OMP never acknowledged for the commands that do not ask anything.
- **A per-command allowlist** (`/review` only). Any extension command can ask through `ctx.ui`; the open dialog is the general signal, and it is already in the model.
- **Implement the pickers in Desk** (a host QuickPick, then send the prompt). A second implementation of OMP's target, diff and prompt logic that would drift from it; the Chat's dialog already carries every method `/review` uses.
- **Show the error `notify` in the transcript too.** Changes a deliberate, general presentation for one command.

## Risks and Open Questions

- A dialog nobody can answer (no page attached) holds the command pending as long as OMP holds it. OMP waits for the same answer, so the two stay consistent; the Chat shows the dialog when a page attaches (the broker replays pending dialogs).
- A user-level or project `commands/review` replaces the bundled command (`loadCustomCommands` loads the bundled commands first and lets a user or project command of the same name override them); Desk lists and sends whatever the session advertises, so the pickers and prompts of such a command are its own. The Desk text applies only when the advertised text is the bundled one.
- Hosts with a non-RPC UI are unaffected.

## Verification

- `src/host/rpc/session-dialog-deadline.test.ts` (failing before the change): the deadline does not run with a dialog open, restarts on answer, on cancel and on a second dialog, and a silent command with no dialog still ends `unconfirmed` one deadline after the last dialog event.
- `src/webview/lib/chat-client.test.ts` (failing before the change): the page's send-result deadline does not run while a dialog is open, starts over at the answer and at a withdrawn dialog, and still ends `unconfirmed` one deadline later when no acknowledgement comes.
- `src/host/rpc/session-review-command.test.ts`: the captured `/review` frames over the session (advertised as `custom`; Review Mode, base branch and commit selects; the editor dialog with its prefill; the search input; status; warning and error notifies; cancel ends without a turn).
- `src/host/slash-registry.test.ts`: `/review` is not a terminal-only builtin in the installed registry. `src/webview/lib/slash-completion.test.ts`: the Desk text, the user's own command and a later OMP text.
- `src/webview/chat-ui.test.ts`: the editor and input dialogs in Chromium (multi-line value returned as typed).
- `test/e2e/scenarios/44-chat-review-command.spec.ts`, a real `omp` in a hidden window with the mock model: uncommitted changes reach the review turn (the model's request carries the "Code Review Request" with the diff), base branch, commit, custom editor, `/review <focus>`, cancel, the missing `gh` (and `/review <PR link>`), a dialog left open for 100 s, the suggestion text.

## Related Decisions

- [ADR-0038](../decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): the chat protocol and the dialog frames.
- [Paseo-style chat](2026-10-04-paseo-style-chat.md): the semantic dialog rows and the slash picker.

## Architecture Review

One independent `reviewer` pass (2026-10-18): **accept with changes**. Material finding 1 (the dialog rule also suspended the watchdog's `get_state` probe, which would have disabled `probe-timeout` recovery while a picker is open, and the stated reason was wrong): fixed by exempting `get_state` (text above) with a test in `session-dialog-deadline.test.ts`. Should-fix 2 (test the probe path): added. 3 (the "Waiting for OMP to confirm" hint outliving the dialog): hidden while a dialog shows. 4 (status): set to `accepted` with this record. The OMP facts and the dialog entry and exit paths were confirmed.
