# Commit hashes in Chat replies are links

Status: **accepted** after one independent architecture review (see Review); implemented in source, unreleased; **amended 2026-10-17 (twice): a click uses only VS Code's own Source Control, with no GitLens or GitLess; and a hash is a link only while it is the current commit (HEAD), because the built-in Graph can select nothing else** (see Decision and Why the GitLens routes were dropped). Date: 2026-10-17. Requested by the maintainer: "a hash becomes a link when a commit with that hash exists; the link opens Source Control and shows the commit", then: "a click opens the commit in the Graph; if it can't, don't show the link. No diff, ever."

## Problem

An assistant reply names commits by hash, most often in inline code (`` `c7398070` ``) and sometimes in prose. They are plain text: to look one up the user copies it and finds the commit by hand. The same exchange already links files, code symbols and OMP's internal URLs ([code-symbol links](2026-10-10-code-symbol-links.md)); a hash is one more thing a reply names that the window can prove and show.

## Evidence

Read from installed bundles and manifests only; no window was started.

- **What the maintainer's machine has.** `code --list-extensions` lists GitLess 11.7.2 (a fork of GitLens 11.7 that registers the `gitlens.*` commands), Git Graph 1.30.0 and VS Code 1.142.0 with its built-in Git extension. The first version of this design drove GitLess' Commits view; the maintainer then decided that commit links depend on no extension but VS Code's own (see Why the GitLens routes were dropped).
- **GitLens / GitLess 11.7 (`dist/gitlens.js`, read from its bundle and its source map).** Not used any more; what was learned from it is in Why the GitLens routes were dropped.
- **Built-in Source Control Graph (1.142 workbench bundle).** The view id is `workbench.scm.history`, so `workbench.scm.history.focus` shows it. Its commands are `workbench.scm.action.graph.*` (pick repository, pick refs, refresh, `revealCurrentHistoryItem`, view changes, open file, …) and `scm.graph.*` settings; none takes a commit hash, and the one that reveals, `revealCurrentHistoryItem`, is a view action that selects the **current HEAD item** only. The built-in Git extension's `git.viewCommit` (arguments: a repository selector such as the repository's root `Uri`, then a hash) is hidden from the palette but callable, and opens the commit's changes in a multi-file diff editor.
- **Git Graph 1.30.0.** `git-graph.view` takes a repository only (`loadViewTo` carries `{ repo }`); it cannot select a commit.
- **Git extension API (version 1, built in).** `getAPI(1).repositories[i].getCommit(ref)` (a `git show -s`; it rejects for an unknown or **ambiguous** abbreviation), `state.HEAD.commit` (the commit HEAD points at; the state lags a commit made a moment ago) and `status()` (refreshes the state). `getCommit` resolves a branch named like a hash first, so the answer's hash must be compared with the hex asked.

## Decision

### Which text is a hash

Page and host run the same grammar (`src/shared/commit-links.ts`).

- **Inline code:** a span that is, whitespace aside, 7 to 40 hex digits (either case; the target is lower case). Digits only or letters only qualify: in code the span is the evidence and the host decides (a chance match of an ordinary integer needs a commit with that prefix: about one in $10^5$ for seven digits in a repository of ten thousand commits).
- **Prose:** lower case only (git prints it so; an upper-case run is a constant), 7 to 40 hex digits with **at least one digit and one letter** (so neither a number nor a word of hex letters such as `defaced` is a candidate), a whole word that does not continue a path, URL, file name, version or identifier: not after a word character, `. - / \ : # @ $ % + ~` and not before `-` or `.` or `:` plus a word character, `/ \ @ % + ~` (`/commit/abc1234`, `abc1234.ts`, `abc1234-rc1`, `0xdeadbeef1`, `#c7398070` are not hashes; `commit c7398070: fixed` is). At most 32 per text. Inside a URL or an internal-URL match a hash is part of that match only.
- Only the **assistant's reply text** asks (`AssistantReplyContext`, like code symbols): user text, tool output, notices and thinking never do. No setting: a link exists only when the host says it is showable (see Which repository, and what counts as found).
- 7 is git's default abbreviation length; 64-digit SHA-256 names are not recognised (the brief fixed 40).

### Exchange

One new host-to-page message, nothing new from the page. A candidate is asked as the file-link validate request with the target `commit://<hex>`; a click is the open request with the same target (`TerminalLinkClient.openCommit`: no `folders`, no `action`). `extension.ts` routes a request whose target `parseCommitLinkTarget` accepts to `handleCommitLink` (`src/host/commit-links.ts`) before the internal-URL and file handlers, so a commit target is never taken for a file. The answer is the usual `valid` boolean: showable is a link, none, ambiguous and not-HEAD are plain text. Because the answer depends on where HEAD is, the host also sends `omp:terminal-link-commits-changed` (exactly that type, no fields; `shared/commit-links.ts`, accepted by `parseGuestHostMessage`) to every slot whose page asked about a commit: when HEAD moves, and to the slot that clicked a link that turned out stale. The page (`ChatFileLinks`) drops every answer, and every question under way, for a `commit://` target (`ValidationCache.forget`) and tells the commit spans, which ask again after their usual 200 ms settle: only `commit://` targets are re-asked, never a file or a symbol, one question per target however many spans there are, at most eight in flight. The previous verdict stays on screen until the new one arrives, so a repaint never flickers. The page-side cache keeps a showable answer for 30 s and a refusal for 5 s as for every link, so the signal is what makes a move visible at once.

### Which repository, and what counts as found

`src/wiring/commit-links.ts` reads `vscode.git`'s API (activating it; disabled or missing gives no repositories and so no links). `CommitLinkResolver` takes the repositories whose root contains **this session's folder** (host-owned `cwd`, never the page's word; Windows containment rules), the deepest first, at most four: a nested checkout answers before its parent, a repository elsewhere in the window is never asked, and a repository opened below the folder is not the session's. In each it calls `getCommit(hex)`; a hit is a commit whose full hash starts with the hex asked (this refuses an ambiguous abbreviation, which git rejects, and a ref named like a hash that points elsewhere). Bounds: one lookup per hash however many spans ask, two `git show` calls at once, 3 s for a whole lookup, the wait for a free slot included (below the page's own 4 s validation deadline; a timeout is not cached, and a lookup that timed out while it waited starts no `git show`), 512 cached answers, a found commit remembered for 60 s and a miss for 3 s (the page's own cache keeps a miss for 5 s, so a commit made just now becomes a link soon), all dropped when a repository opens or closes. The page asks after the text settles for 200 ms, like file links. A code span that is also a code symbol (`parseCodeSymbol` refuses bare all-lowercase words, so this is a mixed-case hash such as `BadFace1`, or an upper-case one) is asked as a commit first and falls back to the symbol lookup only on "none", so a real commit never causes a workspace-symbol query.

**Showable.** A commit that exists is a link only when it is **the commit HEAD points at** (`repository.state.HEAD.commit`, a detached HEAD included, compared with the full hash) and this VS Code has the Graph's commands (`workbench.scm.history.focus` and `workbench.scm.action.graph.revealCurrentHistoryItem` in `vscode.commands.getCommands`; the Git extension always provides the Graph's history provider, and a VS Code without the Graph has no such commands). HEAD is read after `repository.status()`, shared by concurrent readers: the Git extension's state lags a commit made a moment ago, and a link for the previous HEAD would otherwise be drawn and a link for the new one withheld. A branch with no commit has no HEAD commit and so no links. Only what the host can see is checked: the Graph's own filter (`scm.graphView.referencesFilter`, picked by the user) can hide the current branch, in which case the action selects nothing and the click cannot tell.

**HEAD moves.** `wiring/commit-links.ts` subscribes to each repository's `state.onDidChange` (and to repositories opening and closing), compares `state.HEAD.commit` with the last one it saw and, only when it differs, drops the resolver's answers and reports once, coalescing a burst for 150 ms. Changes of the index, the working tree or the branch's upstream report nothing. `extension.ts` turns the report into the page signal. The Git extension reports a commit after its own file watching and refresh (measured 1.4 to 5 s in a hidden window under BelowNormal priority); a click or a validation in between reads HEAD fresh by `status()`, so a stale link is refused (and made plain) rather than selecting the previous commit.

### What a click does

A click on a link:

1. looks the hash up again and re-checks it: the commit still exists, is still HEAD (read after `status()`) and the Graph's commands are there. If not, **nothing is shown**: no editor, no diff, no Graph change. The user gets a short notice (`commit <hex> is no longer the current commit, so the Graph cannot select it.`, or that the commit has no match, or that this VS Code has no Source Control Graph) and the page is told to re-validate, which turns the span back into plain text;
2. otherwise shows the Graph (`workbench.scm.history.focus`; a failure is logged and the selection is still tried);
3. and selects the commit there (`workbench.scm.action.graph.revealCurrentHistoryItem`, the view action that selects the current HEAD item). A refusal by the action is a notice (`cannot show commit <hex>: …`).

`git.viewCommit` and every editor are gone: there is no diff of a commit, ever. One line per click goes to the OMP Desk log at info level, for example `commit link 1759608a5521: HEAD, graph, select in graph`, or `commit link 23b0e0655350: nothing shown, not HEAD (HEAD is 42db024a943d)`, with `failed: <message>` on a step that threw.

### Why only HEAD is a link

Read from the VS Code 1.142 bundle: the Graph's only reveal command is the view action `revealCurrentHistoryItem` (the current HEAD item, and only while the Graph has history items and its filter includes the current ref), and no command or API of the Source Control view, the Git extension or the Graph takes a hash to select. A commit other than HEAD can therefore not be shown in the Graph, and the maintainer decided that it must not be shown any other way: its hash stays text.


### Presentation

The same look as other code links (`omp-file-link`, class `omp-commit-link`, `role="link"`, focusable, Enter or Space activates, a drag that selected text is no click), title `Commit <hex> / Show in the Source Control Graph`, no file context menu (there is no path), and the characters on screen never change.

## Authority and failure

The page never supplies a path, repository or command. A forged `valid` reply could create only a link whose click looks the hash up again, re-checks HEAD and refuses; a forged `omp:terminal-link-commits-changed` makes the page ask the host again about its commit spans and nothing else. The Git extension runs `git` itself; OMP Desk starts no process. The commands a click runs are two fixed constants of VS Code's own Source Control; a VS Code that lacks them has no links, and one that renames them fails the step, which is logged and refused with a notice.

## Alternatives considered

- **A new request/resolution pair** with `found / none / ambiguous` and a full hash (like code symbols). Rejected: the answer is one bit, the validate path already caches, bounds and de-duplicates, and a new pair adds a message type to the page, protocol, bridge and dispatcher allow-lists for nothing. The one added message is host-to-page only and carries nothing: it is what a HEAD-dependent answer needs (the existing symbol retry signal is for parked symbol tokens, not a verdict that changes).
- **Spawning `git cat-file`/`rev-parse` from OMP Desk.** Rejected: the API suffices, and it reuses the repositories the window already has open.
- **Searching all repositories of the window.** Rejected: a hash from a session about one repository could then link to a commit of another; the session's folder is the scope everywhere else.
- **Prose without the digit-and-letter rule**, or code without verification. Rejected: ordinary numbers and words would cost a lookup each.
- **Selecting an arbitrary commit in Git Graph or the built-in Graph.** Not possible (see Evidence and Why only HEAD is a link).
- **Showing a non-HEAD commit by its changes (`git.viewCommit`).** Built in the amendment before this one and removed by the maintainer's decision: no diff, ever; a link that cannot show its commit in the Graph is not drawn.
- **GitLens' or GitLess' Commits and Search & Compare views.** Used by the first version, dropped by the maintainer's decision (see below).

## Tests

`src/shared/commit-links.test.ts` (grammar and boundaries, the signal's shape), `src/host/commit-links.test.ts` (fake Git API and fake command registry: repository choice, ambiguity, look-alike refs, cache, bounds, HEAD-only validation and a HEAD move flipping the old and the new commit, no Graph no link, a click running the Graph's two commands and no other, a stale click refused with a notice and a re-validation, a failing step, the log line, stale document), `src/webview/lib/chat-file-links.test.ts` (the signal forgets only commit answers, tells the spans, drops a late answer), `src/webview/commit-links.test.ts` (rendered markup, never altered characters, symbol fall-back, click message), `src/webview/chat-ui.test.ts` (Chromium: link only after the proof, click and Enter post the open request, a HEAD move turns the old link into text and the new span into a link and re-asks only commit spans, a symbol lookup only for a span that is no commit).

## Why the GitLens routes were dropped

The first version revealed the commit in GitLens' Commits view (`gitlens.revealCommitInView`) or its Search & Compare view. In an isolated window with GitLess 11.7.2 it landed in the Branches view or nowhere for a commit made a moment ago (3 of 12 tries; 0 of 11 after resetting the view with `gitlens.views.commits.refresh`), and for the repository's first commit and every commit after it until the view was reset. The causes are inside GitLens 11's `CommitsView.findCommit` (it searches only the log the view loaded, and a failed page load marks the log complete). The maintainer decided that commit links should not depend on an extension that OMP Desk cannot control, so every `gitlens.*` route, the reset, the first-commit special case and the merge-base probe were removed. The next amendment dropped the diff the same way.

## Observed (isolated window, no GitLens or GitLess installed, 2026-10-17)

A hidden VS Code (`scripts/test-vscode.ps1`, own profile; the only extension besides the built-in ones was a scratch one that runs the built `createCommitLinks` and `handleCommitLink` on request) on a four-commit repository, with the Source Control side bar and the editor tabs read over CDP, under the foreground watchdog (no violation). Starting from Explorer: validation answered true for HEAD and false for older commits; a click on HEAD opened Source Control, showed the Graph, selected HEAD there and **opened no editor tab**; a click on an older commit changed nothing, warned that it is no longer the current commit and counted one re-validation request; after a new commit, the new HEAD validated true and the previous one false, and a click on a commit made a moment ago selected it in the Graph. A commit, an amend and a checkout each produced exactly one HEAD-moved report, while staging a file and editing a file produced none; the report came 1.4 to 5 s after the git command (the Git extension's own refresh), and a click or validation inside that gap read HEAD fresh.

## Not verified

The click inside a real Chat webview was not driven in the isolated window (the page's click handler, the signal and the re-asking of commit spans are covered in Chromium by `src/webview/chat-ui.test.ts`, the host's routing by `src/host/commit-links.test.ts`). A Graph whose filter hides the current branch was not tried.

## Review

One independent review pass (a separate reviewer agent, 2026-10-17; it re-read the installed GitLess, Git Graph and VS Code bundles and checked the design against the code): **accept with changes**. Evidence, grammar (including a linear-time check of the prose pattern), exchange, repository scope, bounds, authority model and page hooks were confirmed. One material finding: route 1's guard was "an ancestor of HEAD", not GitLens' own condition (the commit is contained in the **current branch**), so with a detached HEAD, also at a tagged commit, the click would run a command that selects nothing and report success; fixed: `CommitRepository.currentBranch()` (only a branch-type HEAD counts, never a tag-typed detached HEAD) must exist for route 1, and a detached HEAD uses route 2; test added. One should-fix: the host's 8 s lookup bound (with the wait for a slot outside it) outlived the page's 4 s validation deadline, so a slow lookup would be answered after the page had given up, cached there as a miss and sent a real commit to the symbol lookup; fixed: the whole lookup, queue wait included, ends after 3 s, and a lookup that timed out while waiting starts no `git show`; test added. Recorded without change: a repository's remembered answers are dropped when one opens or closes, but a lookup already running may still store its (correct) answer afterwards; an ambiguous abbreviation in the deepest repository does not stop the search of an enclosing one (nested layouts only); fenced code is never linked (it does not go through prose or span rendering) and a modifier on a commit click is the same plain open.

*Superseded in part (2026-10-17 amendment):* the review's finding about route 1 concerned GitLens' Commits view, which is no longer used.
