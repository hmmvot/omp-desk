# Commit hashes in Chat replies are links

Status: **accepted** after one independent architecture review (see Review); implemented in source, unreleased, installed-window check not run. Date: 2026-10-17. Requested by the maintainer: "a hash becomes a link when a commit with that hash exists; the link opens Source Control and selects the commit in Commits".

## Problem

An assistant reply names commits by hash, most often in inline code (`` `c7398070` ``) and sometimes in prose. They are plain text: to look one up the user copies it and finds the commit by hand. The same exchange already links files, code symbols and OMP's internal URLs ([code-symbol links](2026-10-10-code-symbol-links.md)); a hash is one more thing a reply names that the window can prove and show.

## Evidence

Read from installed bundles and manifests only; no window was started.

- **What "Commits" is on the maintainer's machine.** `code --list-extensions` lists GitLess 11.7.2 (a fork of GitLens 11.7; its manifest contributes `gitlens.views.commits`, named "Commits", to the `scm` container, which is Source Control, and registers the `gitlens.*` commands), Git Graph 1.30.0, and VS Code 1.142.0 with its built-in Git extension. So "Commits" in Source Control is the GitLens Commits view.
- **GitLens (11.7 bundle `dist/gitlens.js`).** `gitlens.revealCommitInView` is the class `ShowQuickCommitCommand` run with `revealInView`: arguments `{ repoPath, sha }` (the same object GitLens' own Markdown command links carry); it calls `git.getCommit(repoPath, sha)` and `CommitsView.reveal(commit, { select: true, focus: true, expand: true })`, which shows the Source Control container. `CommitsView.findCommit` finds a node only when `git.branchContainsCommit(repoPath, <current branch>, sha)` holds: for any other commit the command returns **silently without selecting anything**. `gitlens.showCommitsInView` (class `ShowCommitsInViewCommand`) takes `{ repoPath, refs: [sha] }` and shows the commit in the Search & Compare view of Source Control; it has no branch condition. GitLens keys repositories by `normalizePath(folder)`: `\` becomes `/`, no trailing `/`, a lower-case drive letter on Windows.
- **Built-in Source Control Graph (1.142 workbench bundle).** The commands are `workbench.scm.action.graph.*` (pick repository, pick refs, refresh, `revealCurrentHistoryItem`, view changes, open file, …) and `scm.graph.*` settings; none takes a commit hash, and the one that reveals reveals the current HEAD only. The built-in Git extension's `git.viewCommit` (arguments: a repository selector such as the repository's root `Uri`, then a hash) opens the commit's changes in a multi-file diff editor.
- **Git Graph 1.30.0.** `git-graph.view` takes a repository only (`loadViewTo` carries `{ repo }`); it cannot select a commit.
- **Git extension API (version 1, built in).** `getAPI(1).repositories[i].getCommit(ref)` (a `git show -s`; it rejects for an unknown or **ambiguous** abbreviation) and `getMergeBase(ref1, ref2)`. `getCommit` resolves a branch named like a hash first, so the answer's hash must be compared with the hex asked.
- **A contributed command is not a registered one.** `vscode.commands.getCommands()` lists a command only after its extension activated; GitLens activates on `onCommand:gitlens.revealCommitInView`. Existence is therefore "registered, or contributed by an installed enabled extension" (`extension.packageJSON.contributes.commands`).

## Decision

### Which text is a hash

Page and host run the same grammar (`src/shared/commit-links.ts`).

- **Inline code:** a span that is, whitespace aside, 7 to 40 hex digits (either case; the target is lower case). Digits only or letters only qualify: in code the span is the evidence and the host decides (a chance match of an ordinary integer needs a commit with that prefix: about one in $10^5$ for seven digits in a repository of ten thousand commits).
- **Prose:** lower case only (git prints it so; an upper-case run is a constant), 7 to 40 hex digits with **at least one digit and one letter** (so neither a number nor a word of hex letters such as `defaced` is a candidate), a whole word that does not continue a path, URL, file name, version or identifier: not after a word character, `. - / \ : # @ $ % + ~` and not before `-` or `.` or `:` plus a word character, `/ \ @ % + ~` (`/commit/abc1234`, `abc1234.ts`, `abc1234-rc1`, `0xdeadbeef1`, `#c7398070` are not hashes; `commit c7398070: fixed` is). At most 32 per text. Inside a URL or an internal-URL match a hash is part of that match only.
- Only the **assistant's reply text** asks (`AssistantReplyContext`, like code symbols): user text, tool output, notices and thinking never do. No setting: a link exists only when the commit does.
- 7 is git's default abbreviation length; 64-digit SHA-256 names are not recognised (the brief fixed 40).

### Exchange

No new message. A candidate is asked as the file-link validate request with the target `commit://<hex>`; a click is the open request with the same target (`TerminalLinkClient.openCommit`: no `folders`, no `action`). `extension.ts` routes a request whose target `parseCommitLinkTarget` accepts to `handleCommitLink` (`src/host/commit-links.ts`) before the internal-URL and file handlers, so a commit target is never taken for a file. The answer is the usual `valid` boolean: found is a link, none and ambiguous are plain text (a link to a guessed commit would be wrong; there is no search to offer).

### Which repository, and what counts as found

`src/wiring/commit-links.ts` reads `vscode.git`'s API (activating it; disabled or missing gives no repositories and so no links). `CommitLinkResolver` takes the repositories whose root contains **this session's folder** (host-owned `cwd`, never the page's word; Windows containment rules), the deepest first, at most four: a nested checkout answers before its parent, a repository elsewhere in the window is never asked, and a repository opened below the folder is not the session's. In each it calls `getCommit(hex)`; a hit is a commit whose full hash starts with the hex asked (this refuses an ambiguous abbreviation, which git rejects, and a ref named like a hash that points elsewhere). Bounds: one lookup per hash however many spans ask, two `git show` calls at once, 3 s for a whole lookup, the wait for a free slot included (below the page's own 4 s validation deadline; a timeout is not cached, and a lookup that timed out while it waited starts no `git show`), 512 cached answers, a found commit remembered for 60 s and a miss for 3 s (the page's own cache keeps a miss for 5 s, so a commit made just now becomes a link soon), all dropped when a repository opens or closes. The page asks after the text settles for 200 ms, like file links. A code span that is also a code symbol (`parseCodeSymbol` refuses bare all-lowercase words, so this is a mixed-case hash such as `BadFace1`, or an upper-case one) is asked as a commit first and falls back to the symbol lookup only on "none", so a real commit never causes a workspace-symbol query.

### What a click does

`openCommit` first runs `workbench.view.scm` (Source Control opens; a failure is ignored), then the first route this window has, each verified with the "registered or contributed" rule:

1. **GitLens, commit on the checked-out branch** (a branch is checked out, which `repository.state.HEAD` says by a branch-type ref, and `getMergeBase(hash, "HEAD")` equals the full hash): `gitlens.revealCommitInView { repoPath, sha }`, which selects the commit in the Commits view.
2. **GitLens, any other commit:** `gitlens.showCommitsInView { repoPath, refs: [hash] }`: the Commits view cannot show it (see Evidence), so Source Control's Search & Compare view lists it.
3. **No GitLens, or GitLens refused (a rejected command):** `git.viewCommit <root Uri> <hash>`: the commit's changes in one editor. The built-in Graph cannot select a given commit, so there is no Graph route.

A click that finds no commit (it vanished since the proof) or whose every route fails shows a notice. The host looks the hash up again on every click: the page names a hash, never a repository, path or command.

### Presentation

The same look as other code links (`omp-file-link`, class `omp-commit-link`, `role="link"`, focusable, Enter or Space activates, a drag that selected text is no click), title `Commit <hex> / Show in Source Control`, no file context menu (there is no path), and the characters on screen never change.

## Authority and failure

The page never supplies a path, repository or command. A forged `valid` reply could create only a link whose click looks the hash up again and refuses. The Git extension runs `git` itself; OMP Desk starts no process. The GitLens argument shapes and the repository key are GitLens 11.7 internals read from its bundle: a version that renames them fails the command, which falls to route 3. A GitLens command that succeeds without selecting anything cannot be detected, so route 1 is taken only where GitLens' own condition holds (a checked-out branch that contains the commit, tested with the Git extension's `getMergeBase(hash, "HEAD")`); a repository state this check cannot see (for example a commit that the branch gained between the check and the command) is not covered.

## Alternatives considered

- **A new request/resolution pair** with `found / none / ambiguous` and a full hash (like code symbols). Rejected: the answer is one bit, the validate path already caches, bounds and de-duplicates, and a new pair adds a message type to the page, protocol, bridge and dispatcher allow-lists for nothing.
- **Spawning `git cat-file`/`rev-parse` from OMP Desk.** Rejected: the API suffices, and it reuses the repositories the window already has open.
- **Searching all repositories of the window.** Rejected: a hash from a session about one repository could then link to a commit of another; the session's folder is the scope everywhere else.
- **Prose without the digit-and-letter rule**, or code without verification. Rejected: ordinary numbers and words would cost a lookup each.
- **Selecting in Git Graph or the built-in Graph.** Not possible (see Evidence).

## Tests

`src/shared/commit-links.test.ts` (grammar and boundaries), `src/host/commit-links.test.ts` (fake Git API and fake command registry: repository choice, ambiguity, look-alike refs, cache, bounds, route choice, stale document), `src/webview/commit-links.test.ts` (rendered markup, never altered characters, symbol fall-back, click message), `src/webview/chat-ui.test.ts` (Chromium: link only after the proof, click and Enter post the open request, a symbol lookup only for a span that is no commit).

## Not verified

No isolated VS Code window ran: the GitLens command behaviour is read from its bundle, not observed. The installed-window check (click a real hash in a Chat, see the Commits view select it, on a commit of the current branch and of another branch) remains for the maintainer or a later isolated proof.

## Review

One independent review pass (a separate reviewer agent, 2026-10-17; it re-read the installed GitLess, Git Graph and VS Code bundles and checked the design against the code): **accept with changes**. Evidence, grammar (including a linear-time check of the prose pattern), exchange, repository scope, bounds, authority model and page hooks were confirmed. One material finding: route 1's guard was "an ancestor of HEAD", not GitLens' own condition (the commit is contained in the **current branch**), so with a detached HEAD, also at a tagged commit, the click would run a command that selects nothing and report success; fixed: `CommitRepository.currentBranch()` (only a branch-type HEAD counts, never a tag-typed detached HEAD) must exist for route 1, and a detached HEAD uses route 2; test added. One should-fix: the host's 8 s lookup bound (with the wait for a slot outside it) outlived the page's 4 s validation deadline, so a slow lookup would be answered after the page had given up, cached there as a miss and sent a real commit to the symbol lookup; fixed: the whole lookup, queue wait included, ends after 3 s, and a lookup that timed out while waiting starts no `git show`; test added. Recorded without change: a repository's remembered answers are dropped when one opens or closes, but a lookup already running may still store its (correct) answer afterwards; an ambiguous abbreviation in the deepest repository does not stop the search of an enclosing one (nested layouts only); fenced code is never linked (it does not go through prose or span rendering) and a modifier on a commit click is the same plain open.
