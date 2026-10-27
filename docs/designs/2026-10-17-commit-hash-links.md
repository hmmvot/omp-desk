# Commit hashes in Chat replies are links

Status: **accepted** after one independent architecture review (see Review); implemented; **amended 2026-10-17 (twice): a click uses only VS Code's own Source Control, with no GitLens or GitLess; and a hash is a link only while it is the current commit (HEAD), because the built-in Graph can select nothing else; amended 2026-10-27 by the maintainer's decision: every commit that exists is a link, and a click opens the commit's changes with the Git extension's `git.viewCommit`, so the HEAD-only rule, the Graph selection and the Graph-filter read are superseded** (see Amendment 2026-10-27, Decision and Why the GitLens routes were dropped). Date: 2026-10-17. Requested by the maintainer: "a hash becomes a link when a commit with that hash exists; the link opens Source Control and shows the commit", then (2026-10-17): "a click opens the commit in the Graph; if it can't, don't show the link. No diff, ever.", then (2026-10-27): every commit is a link and a click opens the commit as a diff.

## Problem

An assistant reply names commits by hash, most often in inline code (`` `c7398070` ``) and sometimes in prose. They are plain text: to look one up the user copies it and finds the commit by hand. The same exchange already links files, code symbols and OMP's internal URLs ([code-symbol links](2026-10-10-code-symbol-links.md)); a hash is one more thing a reply names that the window can prove and show.

## Amendment 2026-10-27: every commit is a link; a click opens its changes

The maintainer decided on 2026-10-27, after seeing that a reply names older commits far more often than the current one:

- **A hash is a link whenever it names a commit that exists** in the session's repository (same repository choice, grammar, bounds, cache and untrusted-page rules as before), HEAD or not. This supersedes "Why only HEAD is a link" and the "no diff, ever" decision of 2026-10-17 (the reason stays true: the built-in Graph still cannot select any other commit, and no command of it takes a hash, re-checked in VS Code 1.143.1).
- **A click on any commit link, HEAD included, runs the built-in Git extension's `git.viewCommit`** and opens the commit's changes as a multi-file diff editor. There is no Graph selection any more.
- **Removed as obsolete** (a clean cutover, nothing kept as a fallback): HEAD-only validation and the `repository.status()` refresh before it; HEAD-move tracking (`state.onDidChange` watchers, the 150 ms coalescing) and the host-to-page signal `omp:terminal-link-commits-changed` with its parser, protocol entry, `ChatFileLinks.onCommitsChanged` and `ValidationCache.forget`; the Graph commands path (`workbench.scm.history.focus`, `workbench.scm.action.graph.revealCurrentHistoryItem`, the "has the Graph" check); `src/host/graph-filter.ts` with its `state.vscdb` read through `node:sqlite` (nothing else used it) and the filtered-Graph notice; the `commitAskers` bookkeeping in `extension.ts`.
- **Link title** is `Commit <hex>` / `Open the commit's changes`.
- **Log and notices.** Every click writes one info line: `commit link <hash12>: view commit`, `commit link <hash12>: view commit failed: <reason>` or `commit link <hex>: nothing shown, no such commit in this session's repository`. A commit that no longer exists, or a `git.viewCommit` that fails, shows a notice (`cannot show commit <hex>: …`) and leaves the link as it is.

### What `git.viewCommit` takes (read from VS Code 1.143.1, the Git extension's `dist/main.js`)

The command is declared in the extension's `package.json` (`command: git.viewCommit`, hidden from the palette by `when: false`, title `%command.viewCommit%`) and registered through the extension's `@command("git.viewCommit", { repository: true })`. Its wrapper resolves the **first argument** with `model.getRepository(arg)` (accepts a `Uri` anywhere inside an open repository's root, the repository object, or a string path; for a `Uri` it takes the deepest open repository that contains it) and **only when that finds nothing opens a repository picker** (`pickRepository`). The command body is `viewCommit(repository, hash, revealUri?)`: it runs `repository.getCommit(hash)`, takes the first parent (or the empty tree for a root commit), and calls `_workbench.openMultiDiffEditor` with the title `<short hash> - <subject>` and the changed files of `parent..hash`; the optional third argument is a resource to reveal. An error inside it is reported by the wrapper as a modal error dialog.

Arguments chosen: `executeCommand("git.viewCommit", repository.rootUri, <full hash>)`:

- the repository's own root `Uri` from the Git extension API, so the repository is the one the lookup found, never one the page or the session's folder picks, and the picker cannot appear for a repository the Git extension has open;
- the **full lower-case hash the lookup returned** (the page's text is only used to look the commit up, so a malformed or stale target from the page never reaches the Git extension), no third argument;
- before the call the wiring checks that the Git extension still has a repository with that root open (a found commit is remembered for a minute and a repository can be closed meanwhile), and throws `the repository is no longer open in this window` otherwise instead of letting the command show a picker.

## Evidence

Read from installed bundles and manifests; the 2026-10-27 amendment also ran the command in a real window (see Observed 2026-10-27).

- **What the maintainer's machine has.** `code --list-extensions` listed GitLess 11.7.2 (a fork of GitLens 11.7 that registers the `gitlens.*` commands), Git Graph 1.30.0 and VS Code 1.142.0 with its built-in Git extension. The first version of this design drove GitLess' Commits view; the maintainer then decided that commit links depend on no extension but VS Code's own (see Why the GitLens routes were dropped). The 2026-10-27 amendment was checked against VS Code 1.143.1.
- **GitLens / GitLess 11.7 (`dist/gitlens.js`, read from its bundle and its source map).** Not used any more; what was learned from it is in Why the GitLens routes were dropped.
- **Built-in Source Control Graph (1.142 workbench bundle; no graph command takes a hash in 1.143.1 either).** The view id is `workbench.scm.history`. Its commands are `workbench.scm.action.graph.*` (pick repository, pick refs, refresh, `revealCurrentHistoryItem`, view changes, open file, …) and `scm.graph.*` settings; none takes a commit hash, and the one that reveals, `revealCurrentHistoryItem`, is a view action that selects the **current HEAD item** only. Not used since 2026-10-27.
- **Built-in Git extension's `git.viewCommit`.** See "What `git.viewCommit` takes" above.
- **Git Graph 1.30.0.** `git-graph.view` takes a repository only (`loadViewTo` carries `{ repo }`); it cannot select a commit.
- **Git extension API (version 1, built in).** `getAPI(1).repositories[i].getCommit(ref)` (a `git show -s`; it rejects for an unknown or **ambiguous** abbreviation) and `rootUri`. `getCommit` resolves a branch named like a hash first, so the answer's hash must be compared with the hex asked.

## Decision

### Which text is a hash

Page and host run the same grammar (`src/shared/commit-links.ts`).

- **Inline code:** a span that is, whitespace aside, 7 to 40 hex digits (either case; the target is lower case). Digits only or letters only qualify: in code the span is the evidence and the host decides (a chance match of an ordinary integer needs a commit with that prefix: about one in $10^5$ for seven digits in a repository of ten thousand commits).
- **Prose:** lower case only (git prints it so; an upper-case run is a constant), 7 to 40 hex digits with **at least one digit and one letter** (so neither a number nor a word of hex letters such as `defaced` is a candidate), a whole word that does not continue a path, URL, file name, version or identifier: not after a word character, `. - / \ : # @ $ % + ~` and not before `-` or `.` or `:` plus a word character, `/ \ @ % + ~` (`/commit/abc1234`, `abc1234.ts`, `abc1234-rc1`, `0xdeadbeef1`, `#c7398070` are not hashes; `commit c7398070: fixed` is). At most 32 per text. Inside a URL or an internal-URL match a hash is part of that match only.
- Only the **assistant's reply text** asks (`AssistantReplyContext`, like code symbols): user text, tool output, notices and thinking never do. No setting: a link exists only when the host says a commit exists (see Which repository, and what counts as found).
- 7 is git's default abbreviation length; 64-digit SHA-256 names are not recognised (the brief fixed 40).

### Exchange

Nothing new on the wire since 2026-10-27. A candidate is asked as the file-link validate request with the target `commit://<hex>`; a click is the open request with the same target (`TerminalLinkClient.openCommit`: no `folders`, no `action`). `extension.ts` routes a request whose target `parseCommitLinkTarget` accepts to `handleCommitLink` (`src/host/commit-links.ts`) before the internal-URL and file handlers, so a commit target is never taken for a file. The answer is the usual `valid` boolean: a commit that exists is a link; none and ambiguous are plain text. The answer no longer depends on where HEAD is, so the host sends the page nothing else (the 2026-10-17 design added `omp:terminal-link-commits-changed`, host to page, for HEAD moves; it is removed). The page-side cache (`ValidationCache`) keeps a found answer for 30 s and a refusal for 5 s as for every link, one question per target however many spans there are, at most eight in flight; a commit made just now becomes a link within the host's 3 s miss memory plus the page's 5 s.

### Which repository, and what counts as found

`src/wiring/commit-links.ts` reads `vscode.git`'s API (activating it; disabled or missing gives no repositories and so no links). `CommitLinkResolver` takes the repositories whose root contains **this session's folder** (host-owned `cwd`, never the page's word; Windows containment rules), the deepest first, at most four: a nested checkout answers before its parent, a repository elsewhere in the window is never asked, and a repository opened below the folder is not the session's. In each it calls `getCommit(hex)`; a hit is a commit whose full hash starts with the hex asked (this refuses an ambiguous abbreviation, which git rejects, and a ref named like a hash that points elsewhere). Bounds: one lookup per hash however many spans ask, two `git show` calls at once, 3 s for a whole lookup, the wait for a free slot included (below the page's own 4 s validation deadline; a timeout is not cached, and a lookup that timed out while it waited starts no `git show`), 512 cached answers, a found commit remembered for 60 s and a miss for 3 s. The page asks after the text settles for 200 ms, like file links. A code span that is also a code symbol (`parseCodeSymbol` refuses bare all-lowercase words, so this is a mixed-case hash such as `BadFace1`, or an upper-case one) is asked as a commit first and falls back to the symbol lookup only on "none", so a real commit never causes a workspace-symbol query.

A commit that exists is a link, with no further condition: no HEAD comparison, no `repository.status()`, no check for the Graph. A found commit remembered for a minute can be gone (repository closed, history rewritten and collected) when it is clicked: the click shows the notice instead.

### What a click does

A click on a link looks the hash up again (the resolver's answers; at most a minute old for a found commit) and then:

1. no commit (the miss is fresh, or the page asked about a hash that never existed): a notice (`cannot show commit <hex>: this session's repository has no commit with that hash.`), nothing opens, one log line;
2. otherwise `git.viewCommit` with the repository's root `Uri` and the full hash found (see above): the commit's changes open in a multi-file diff editor. The same for HEAD and for any older commit. A failure (the repository was closed meanwhile, or the command rejects) is a notice with the reason and a log line; the link stays.

No Source Control view is focused or changed; the Graph is not involved.

### Presentation

The same look as other code links (`omp-file-link`, class `omp-commit-link`, `role="link"`, focusable, Enter or Space activates, a drag that selected text is no click), title `Commit <hex> / Open the commit's changes`, no file context menu (there is no path), and the characters on screen never change.

## Authority and failure

The page never supplies a path, repository or command. The page's `commit://<hex>` is parsed again on the host (`parseCommitLinkTarget`: lower-case hex of 7 to 40 digits only), looked up, and only the full hash the lookup found and the root `Uri` of the repository that found it reach `git.viewCommit`; a forged `valid` reply can create only a link whose click looks the hash up again and shows a notice when no commit has it. The Git extension runs `git` itself; OMP Desk starts no process. The one command a click runs is a fixed constant of VS Code's own Git extension; a VS Code that renames it fails the click, which is logged and refused with a notice.

## Alternatives considered

- **A new request/resolution pair** with `found / none / ambiguous` and a full hash (like code symbols). Rejected: the answer is one bit, the validate path already caches, bounds and de-duplicates, and a new pair adds a message type to the page, protocol, bridge and dispatcher allow-lists for nothing.
- **Spawning `git cat-file`/`rev-parse` from OMP Desk.** Rejected: the API suffices, and it reuses the repositories the window already has open.
- **Searching all repositories of the window.** Rejected: a hash from a session about one repository could then link to a commit of another; the session's folder is the scope everywhere else.
- **Prose without the digit-and-letter rule**, or code without verification. Rejected: ordinary numbers and words would cost a lookup each.
- **Selecting an arbitrary commit in Git Graph or the built-in Graph.** Not possible (see Evidence); this is why the 2026-10-17 design linked only HEAD.
- **Selecting HEAD in the Graph and the diff for the rest.** Rejected on 2026-10-27: two different behaviours for one kind of link, and the Graph's own filter made the HEAD case unreliable (it needed a read of VS Code's private `state.vscdb`); one command for every commit is simpler and has no VS Code internals.
- **Showing a non-HEAD commit by its changes (`git.viewCommit`).** Built in the 2026-10-17 amendment before the HEAD-only one, removed by the maintainer's decision "no diff, ever", and **restored for every commit on 2026-10-27** by the maintainer's decision.
- **GitLens' or GitLess' Commits and Search & Compare views.** Used by the first version, dropped by the maintainer's decision (see below).

## Tests

`src/shared/commit-links.test.ts` (grammar and boundaries), `src/host/commit-links.test.ts` (fake Git API: repository choice, ambiguity, look-alike refs, cache, bounds, validation true for HEAD and non-HEAD commits and false for a missing one, a click opening the full hash in the deepest repository that has it, a missing commit's notice, a failing `viewCommit`'s notice and log, the log lines, stale document, a malformed target never looked up), `src/webview/lib/chat-file-links.test.ts` (a commit target is validated by the same pair and a click posts a plain open request), `src/webview/commit-links.test.ts` (rendered markup and title, never altered characters, symbol fall-back, click message), `src/webview/chat-ui.test.ts` (Chromium: link only after the proof, HEAD or not, click and Enter post the open request, the title, a symbol lookup only for a span that is no commit). The wiring (`createCommitLinkResolver`, the real `git.viewCommit` call) is covered by the real-window observation below, not by a unit test.

## Why the GitLens routes were dropped

The first version revealed the commit in GitLens' Commits view (`gitlens.revealCommitInView`) or its Search & Compare view. In an isolated window with GitLess 11.7.2 it landed in the Branches view or nowhere for a commit made a moment ago (3 of 12 tries; 0 of 11 after resetting the view with `gitlens.views.commits.refresh`), and for the repository's first commit and every commit after it until the view was reset. The causes are inside GitLens 11's `CommitsView.findCommit` (it searches only the log the view loaded, and a failed page load marks the log complete). The maintainer decided that commit links should not depend on an extension that OMP Desk cannot control, so every `gitlens.*` route, the reset, the first-commit special case and the merge-base probe were removed. `git.viewCommit` (the built-in Git extension's own command) is not an extension dependency of that kind; it was used again from 2026-10-27.

## Superseded by the 2026-10-27 amendment (kept as history)

These parts of the 2026-10-17 and 2026-10-19 design no longer exist in the code; they explain the removed modules.

- **HEAD-only links ("Why only HEAD is a link").** Read from the VS Code 1.142 bundle: the Graph's only reveal command was the view action `revealCurrentHistoryItem` (the current HEAD item, and only while the Graph has history items and its filter includes the current ref), and no command or API of the Source Control view, the Git extension or the Graph takes a hash to select. A commit other than HEAD could therefore not be shown in the Graph, and the maintainer decided then that it must not be shown any other way. Showable then meant: the commit is the one HEAD points at (`repository.state.HEAD.commit`, read after `repository.status()` because the Git extension's state lags a commit made a moment ago) and this VS Code has the Graph's commands.
- **HEAD moves.** `wiring/commit-links.ts` subscribed to each repository's `state.onDidChange` (and to repositories opening and closing), compared `state.HEAD.commit` with the last one it saw, dropped the resolver's answers and reported once (coalesced 150 ms); `extension.ts` sent every slot whose page had asked `omp:terminal-link-commits-changed`, and `ChatFileLinks` forgot every `commit://` answer so the commit spans asked again. The Git extension reported a commit 1.4 to 5 s after the git command.
- **The click.** Re-check HEAD and the Graph's commands, `workbench.scm.history.focus`, then `workbench.scm.action.graph.revealCurrentHistoryItem`; a stale link got a notice and a re-validation.
- **The Graph's filter (amendment 2026-10-19).** The selection action does nothing, silently, while the Graph's reference filter hides the current branch (precondition: the view's context key `scmCurrentHistoryItemRefInFilter`, set inside the Graph view and unreadable by an extension). `src/host/graph-filter.ts` read the filter from `scm.graphView.referencesFilter` in the workspace's `state.vscdb` with `node:sqlite` on every click, and a click the filter hid showed a notice instead of selecting; an unreadable filter selected as before. VS Code internals, checked in 1.142 only. Removed together with the Graph selection, because nothing else read that row.

## Observed (isolated window, no GitLens or GitLess installed, 2026-10-17; superseded behaviour)

A hidden VS Code (`scripts/test-vscode.ps1`, own profile; the only extension besides the built-in ones was a scratch one that ran the built code on request) on a four-commit repository: validation answered true for HEAD and false for older commits; a click on HEAD opened Source Control, showed the Graph, selected HEAD there and opened no editor tab; a click on an older commit changed nothing and warned; a commit, an amend and a checkout each produced exactly one HEAD-moved report 1.4 to 5 s after the git command. The filtered-Graph notice was driven the same way on 2026-10-19 (VS Code 1.142). This is the behaviour the 2026-10-27 amendment removes.

## Observed 2026-10-27 (isolated window, VS Code 1.143.1)

A hidden VS Code (`scripts/test-vscode.ps1`, own profile, CDP on a local port, no foreground, one window) opened on this repository's own checkout (many commits, a dirty working tree, branch `main`). The only extension besides the built-in ones was a scratch one, outside the repository tree, that bundled the real `createCommitLinkResolver` (`src/wiring/commit-links.ts`) and `handleCommitLink` (`src/host/commit-links.ts`) and ran a request that a script wrote to a file, replying through a recording host (the Chat page and `extension.ts`'s `showWarning` were not in the loop). Results:

- validation of the HEAD commit's 7-digit hash: `valid: true`; of an older commit's (`f56d979`, the 0.4.10 release commit): `valid: true`; of a hash no commit has: `valid: false`;
- open of the older commit: the log line `commit link f56d9790a5db: view commit`, and the editor area showed one preview tab `f56d979 - OMP Desk 0.4.10 (3 files)` whose content was the multi-file diff of that commit (the first file, CHANGELOG.md, was on screen with the added line drawn; the commit changes CHANGELOG.md, package.json and package-lock.json);
- open of the HEAD commit: `commit link 51d6c20e090d: view commit` and the tab `51d6c20 - Chat: a message OMP accepted and then failed on comes back as an unsent message instead of disappearing (15 files)`;
- open of the missing hash: the notice text `cannot show commit 1234567: this session's repository has no commit with that hash.` and the log line `commit link 1234567: nothing shown, no such commit in this session's repository`; no tab;
- the side bar stayed on Explorer through all of it: no Source Control or Graph view was focused. No picker appeared.

## Not verified

- The click inside a real Chat webview was not driven in the isolated window: the page's click handler and the validate/open messages are covered in Chromium by `src/webview/chat-ui.test.ts` and `src/webview/commit-links.test.ts`, the host's routing by `src/host/commit-links.test.ts`, and the call of `git.viewCommit` by the observation above; `extension.ts`'s toast for a notice (`showWarning`) was not seen.
- The branch of `viewCommit` that refuses a repository the Git extension no longer has open (a found commit remembered for a minute, the repository closed meanwhile) is covered only by the host test's fake failure, not by closing a repository in a real window. A repository nested below another was not observed either (the deepest-first rule is unit-tested).
- `git.viewCommit` is a hidden command of the built-in Git extension, not API: a VS Code release that renames it or changes its arguments fails the click with a notice (the link and its validation keep working). The argument shape was read from, and run on, VS Code 1.143.1 only.

## Review

One independent review pass (a separate reviewer agent, 2026-10-17; it re-read the installed GitLess, Git Graph and VS Code bundles and checked the design against the code): **accept with changes**. Evidence, grammar (including a linear-time check of the prose pattern), exchange, repository scope, bounds, authority model and page hooks were confirmed. One material finding: route 1's guard was "an ancestor of HEAD", not GitLens' own condition (the commit is contained in the **current branch**), so with a detached HEAD, also at a tagged commit, the click would run a command that selects nothing and report success; fixed: `CommitRepository.currentBranch()` (only a branch-type HEAD counts, never a tag-typed detached HEAD) must exist for route 1, and a detached HEAD uses route 2; test added. One should-fix: the host's 8 s lookup bound (with the wait for a slot outside it) outlived the page's 4 s validation deadline, so a slow lookup would be answered after the page had given up, cached there as a miss and sent a real commit to the symbol lookup; fixed: the whole lookup, queue wait included, ends after 3 s, and a lookup that timed out while waiting starts no `git show`; test added. Recorded without change: an ambiguous abbreviation in the deepest repository does not stop the search of an enclosing one (nested layouts only); fenced code is never linked (it does not go through prose or span rendering) and a modifier on a commit click is the same plain open.

*Superseded in part (2026-10-17 amendment):* the review's finding about route 1 concerned GitLens' Commits view, which is no longer used.

*The 2026-10-27 amendment is the maintainer's own decision and removes code and states (HEAD tracking, the signal, the Graph path and the filter read) while adding one fixed command call; it had no separate independent review pass.*
