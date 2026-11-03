---
status: proposed
date: 2026-11-03
---

# The Chat draft survives Reload Window: the page saves it to a private host store per editor slot and gets it back when its document is ready

## Problem

The composer's unsent message (text, image and file attachments, commands and skills as chips, quotes, recovery cards) lives only in the page's memory: in the Draft value of [the Draft module](2026-10-23-composer-draft-module.md), whose cell the composer owns. Reload Window, a window restart or any other loss of the page document throws it away. The hand-off of ADR-0050 covers a replacement of one document by another while the host lives and can ask the old page for its draft; it cannot help when the page is destroyed with the window. The maintainer's request (2026-10-23): keep the draft, text and attachments, across a window reload; do it after the Draft module exists (it does: groups 0 to 3 landed).

## Goals and Non-goals

- Goals:
  - After Reload Window the composer of a Chat editor shows what it held a moment before: the text (so every marker, quote, `@path`, `/command` chip and `/skill:name` chip, which are all derived from the text, comes back with it), the images, the attached files (held text and linked paths), the recovery cards and a message that was awaiting admission (as an unconfirmed card, like the hand-off).
  - Nothing is saved while there is nothing to save; a sent, cleared or dismissed draft leaves nothing on disk.
  - The draft never reaches the log, the profile catalog, its backup under `%LOCALAPPDATA%` or VS Code's webview state.
- Non-goals:
  - The composer's undo history, caret and scroll position are not kept (the text is restored as a fresh start, like the hand-off's).
  - Images of a recovery card are counted, not carried (the card says to attach them again, as after a hand-off).
  - No change to the hand-off between documents of one editor (ADR-0050); a draft it carries is saved by the page like any other.
  - No cross-machine sync, no draft for a terminal-mode editor (it has no composer).
  - No setting. Keeping an unsent draft on the user's own disk is the behaviour of every editor that survives a reload; the content is private to the profile and bounded in age and size (section 5). A switch would be a second state to test and explain for a failure mode (a lost draft) that has no benefit.

## Current State

- The page holds the draft in a `DraftCell` (`src/webview/lib/draft/cell.ts`); `captureOf` and `restoreHandoff` (`draft/handoff.ts`) already turn it into `DraftHandoffContent` (text, number of images not carried, recovery records, documents: linked ones by host reference, held ones with their text) and back. Images are never carried by the hand-off.
- The host asks the page (`omp:draft-request`, `omp:draft-reply`) only when it is about to replace the document (`captureDraft`, `carryDraftFrom` in `src/wiring/guest-dispatcher.ts`) and keeps the answer in the window's memory (`draftRestores`, by editor slot) until the successor says `omp:ready`.
- VS Code revives a Desk Chat editor after Reload Window through a `WebviewPanelSerializer` (registered in `src/wiring/window.ts`, with the dynamic view types through the bridge host), and the page's own `setState` carries only the editor identity (`src/shared/panel-identity.ts`: "it deliberately carries no capability and no session facts").
- The unit that VS Code restores is the editor, not the session: its slot id (`slot` in the dispatcher and the tab records) is the immutable id of the editor and is what the serializer revives. Two editors of one session tab (Open in New Editor) are two slots; each has its own composer.
- A linked file (attached by path) is a host reference in a per-tab registry in the host's memory (`AttachedFileRegistry`, `src/host/attached-files.ts`); the page never knows the path. After a reload the registry is empty.
- The page's route to the host is the panel route (`postMessage`) in a normal window; after a host-only restart a surviving page talks over the authenticated bridge, which refuses every message type that is not one of its named operations (`bridgeOperation` in `src/webview/bridge.ts`).
- Budgets (`src/protocol/messages.ts`, `src/shared/attach-limits.ts`): images at most `MAX_CHAT_IMAGES_BYTES` (10 MiB raw, about 13.4 MB of base64) per draft, at most `MAX_ATTACH_ITEMS` attachments, the text and every held file at most `MAX_DRAFT_HANDOFF_CHARS` (2 000 000 characters) together.

## Proposed Design

### 1. Where it is kept: a private store in the extension's global storage, written by the host, one record per editor slot

Decision: files under `<globalStorage>/drafts/`, written by the extension host from messages the page sends, one record per editor slot, read back by the host when that slot's document says it is ready.

Why a record per slot and not per session tab: a record per tab would let two editors of one tab overwrite each other and hand one editor the other's draft; the slot is what the serializer restores, so slot and revived editor correspond one to one.

Why not the webview's `setState`: (a) the draft is the user's own text, possibly with secrets, and `setState` data is serialised by VS Code into the workbench's editor layout, a store the extension neither sizes nor controls and that is rewritten with the layout (image bytes of up to 13 MB would travel with every layout flush; [INFERENCE] not measured here); (b) the identity state is an exact, versioned contract of two sides (`panel-identity.ts`) that must not grow a payload; (c) the invariant of the hand-off module says the draft never reaches webview state. Why not `workspaceState`/`globalState` Mementos: they are JSON in VS Code's SQLite state database, read whole at start, and have no file-size discipline; image bytes do not belong there. Why not the profile catalog: it is shared by every window and is backed up outside VS Code's storage (ADR-0034, ADR-0081); a draft is neither.

Key: `sha256(slot)` in hex (the first 32 characters) as the file stem, so the name carries no identity and no path can be injected. Per slot two files, written with `replaceFileAtomic` (`src/wire/atomic-file.ts`, owner-only creation mode, one rename):

- `<key>.draft.json`: `{ version: 1, owner, savedAt, imagesKey, draft, files }` where `draft` is the content of the hand-off (text, `attachments` = images not carried, recovery records, documents) and `files` maps each linked document's reference to `{ path }` as the slot's tab registry knew it at the save; `owner` is the slot, checked at load;
- `<key>.images.json`: `{ version: 1, owner, key, images }`, written only when the images change, and written first.

Splitting them is what keeps a text edit cheap: a keystroke burst rewrites a small file, the multi-megabyte image file only when an image is added or removed. The content file records the key of the image file it expects; a mismatch at load (a crash between the two, or a tampered file) drops the images and counts them as not carried. Operations of one slot run in the order they were asked, so a late clear cannot erase a save asked after it.

The record's rules at load (a record that breaks one is deleted and treated as absent): a regular file within the byte ceiling; valid JSON of the exact version and shape; `owner` equal to the asked slot; content valid under `parseDraftHandoffContent`; every `files` key a reference of the documents' grammar naming a linked document of the content, every path a bounded string; the images valid under `parsePersistedDraftImages` and their key equal to the one the content names. A recall whose linked path no longer reads as text is not a load failure: the read happens at send, as for any linked document.

### 2. The page saves, the host acknowledges

The page side is `src/webview/lib/draft-persistence.ts` (no React): it watches the cell, builds a snapshot with `snapshotOf(draft)` of the Draft module and posts it over the panel route.

- **When**: a snapshot is posted at most once per 400 ms of quiet and at the latest 2 s after the first unsaved change, immediately when the page becomes hidden or is being unloaded (`visibilitychange`, `pagehide`), immediately when the draft has just become empty after it held something (a send, an emptied composer, a dismissed card: the record of text that was already sent is deleted without waiting), and again when the route changes back to the panel while a change is unsaved. The page watches the fields that matter (text, images, documents, recovery cards, the message in flight, lost-image count) by reference, so reads in flight, the caret and the history walk cost nothing.
- **What is saved**: the text, the images whose marker is in the text (a deleted image kept only for Undo is not saved), the documents whose marker is in the text, the cards, the message awaiting admission as an unconfirmed card, the not-carried count.
- **Armed**: a composer that has just mounted is empty because its draft has not been restored yet, not because the user cleared it. The page posts nothing until the draft has held content once on this page (the revision alone does not arm it: a no-op edit of an empty composer is not news), so an empty page can never erase the record it is about to be given.
- **One in flight**: the next snapshot waits for `omp:draft-saved`. An answer that does not come within 10 s is given up, the images are sent whole again with the next snapshot, and after two unanswered saves in a row the page stops asking until the draft changes again.
- **Images by key**: an image set has a key (the ids of its images in number order; ids are never reused within a page document). A snapshot carries the image array only when its key differs from the key the host last acknowledged; otherwise `images: null` and the key. The host's acknowledgement states the key it now holds, so a lost or refused image write corrects itself: the page does not send again a set the host answered with another key until the images change (the draft's `attachments` then includes those images, which is what a recall reports).
- **Validation before posting**: the page checks its own snapshot with `parseDraftHandoffContent` and does not post one the boundary would refuse whole (text over its bound, a control character), because no answer would come.
- Protocol: `omp:draft-save`, `omp:draft-saved` and `omp:draft-recall` (new messages of the guest vocabulary; the save from the page, the other two from the host; panel route only; `GUEST_PROTOCOL_VERSION` unchanged because both ends ship in one package, as `omp:page-health` did). Validation is `parseDraftHandoffContent` plus the images (a supported MIME type, canonical base64, the draft budgets, the byte count equal to the decoded length, numbers that never repeat) and the key (digits and commas, as many ids as images).
- A snapshot that is empty (no text, no images, no documents, no cards, nothing not carried) tells the host to delete the record. That is how a send, an emptied composer and a dismissed card clear it, with no other signal.
- The host accepts a save only from the panel that serves the slot now and for the tab the editor shows, and never logs it.

### 3. Getting it back

On the page's `omp:ready`, for a Chat document of a slot that has a record, and only when no hand-off draft waits for the slot (the hand-off's text is newer than any record), the host reads the two files, re-registers each linked path in the tab's registry (a new reference per path, registered as a dropped path: a record is not proof that the user chose a network path, so such a path is not opened on the host's own account; a document whose reference was not in `files` is dropped and its marker becomes ordinary text), and posts `omp:draft-recall` (the content, the images, the key) once per document. The read takes time: when it ends, the host posts only if the editor still shows the same document and tab.

The page holds a recall that arrives before the composer mounts (the pattern of `lib/draft-handoff.ts`) and applies it with `restorePersisted`: if the draft is still pristine (empty, never edited) the recalled draft replaces it, the images get new ids and numbers continue after the recalled ones; if the user already typed, the composer keeps its text and the recalled text comes as a recovery card; if the cell is held by a hand-off capture the recall waits until it lets go. The restored draft is saved again by the page, which deletes nothing it should keep.

### 4. When it is cleared

| Event | Result |
| --- | --- |
| Send accepted, text deleted, cards dismissed (the draft becomes empty) | the page posts the empty snapshot, the host deletes both files |
| A send in flight when the page dies | the message is saved as an unconfirmed card, the same sentence the hand-off uses ("OMP did not confirm this message… may already have been accepted") |
| The user closes the editor | the editor's `onDidDispose` calls `forgetDraft(slot)`; the record is deleted. A reload does not close the editor, so it keeps the record (to be checked in a real window; see Risks) |
| The session's row leaves the catalog (Delete, Forget) | the editor of its tab closes, and with it the record |
| Untouched for 14 days | the sweep deletes it |

The sweep runs in the window at its first save or recall and then at most every 6 hours, and deletes a record whose file is older than 14 days and the images file of a save that never finished. The age is the only rule: the host cannot tell a slot of an editor VS Code still restores from one it forgot, so no rule about the slot's liveness is applied. An unreadable, over-sized or malformed file is refused at load and deleted.

### 5. Limits and privacy

- A file is read through `readBoundedFile` (a regular file, at most 24 MiB); a save over the bounds of the message grammar is refused whole by the parser, and a disk failure is logged as a warning (the slot's hash prefix and a code, never content) and acknowledged with the key the host still holds.
- Images are carried within the draft's own budget (10 MiB raw); there is no second cap, so a draft the composer accepted can be saved. The host's per-file ceiling is a defence, not a rule the user meets.
- Content never reaches the log: the host logs the hash prefix of the slot, counts and outcomes only. The files are created with the owner-only mode in the profile's global storage, which other OS users cannot read; the user's own OS account can, as with the session files OMP keeps. They are not part of the catalog backup (ADR-0081 copies the catalog and broker records only).
- A linked file's path is on disk in the record (the page never knew it).
- A host-only restart leaves the page alive and on the bridge route, which cannot carry a save (it refuses what is not a named operation). A draft typed after such a restart is saved again when the route returns to the panel (the page sees the route change) or when the page leaves; if the window is reloaded while the bridge route is the only one, that last stretch of typing is lost. Accepted: the window of loss is the one in which the host itself was down.

### 6. Module placement

- Draft module (`src/webview/lib/draft/persist.ts`, exported by the entry `draft.ts`): `snapshotOf`, `restorePersisted`; pure, node-tested.
- Page: `src/webview/lib/draft-persistence.ts` (timers, transport), started by `useDraft`; branches in `App.tsx`' host-message handler route the two inbound messages.
- Protocol: `src/protocol/messages.ts` (types and parsers; the budgets stay where they are).
- Host: `src/host/draft-store.ts` (files, vscode-free), `src/wiring/draft-persistence.ts` (maps references to paths, sweep), called from `src/wiring/guest-dispatcher.ts` (`omp:draft-save`, after `omp:ready`, and `forgetDraft`). The real code of the window is `src/wiring/window.ts` (`src/extension.ts` is a thin entry): the only change there is the call of `forgetDraft(slot)` in the editor's `onDidDispose`.

## Alternatives Considered

1. **`vscode.setState` of the page.** Rejected above (size, shared layout storage, the identity contract, the module's own invariant).
2. **Save on shutdown only** (the host asks the page for the draft with `omp:draft-request` when the window closes). Rejected: Reload Window gives the host no moment to ask and no page to answer; the host cannot know it is about to die.
3. **The host keeps a mirror in memory and writes on `deactivate`.** Rejected for the same reason (deactivation is not guaranteed and is bounded to a few seconds) and because a crash loses everything.
4. **Keep images out and restore only text and files.** Rejected: the maintainer asked for text and attachments, and a screenshot is the attachment people lose.
5. **A single file with images inside.** Rejected: a one-character edit would rewrite up to 13 MB on the host's thread.
6. **Keep the record when the editor is closed (age only).** Rejected: closing an editor is the user's statement that the work in it is done, and an unsent message of a closed editor would otherwise come back in a new editor of nothing (the slot is gone), as an orphan that only ages out.
7. **A record per session tab.** Rejected in section 1.

## Risks and Open Questions

- **`onDidDispose` at Reload Window**: the design relies on the editor's `onDidDispose` not firing when the window reloads or closes (the extension host is stopped and VS Code revives the editor). [INFERENCE] until verified in a real window; the end-to-end scenario checks that the draft is back after a reload, which fails if the record were deleted by the reload.
- **Another window writes the same slot**: an editor is bound to one window; Move to This Window creates a new slot. No record is shared.
- **Disk load**: at most one write per page per 400 ms burst, one small file normally. Image bytes are written once per change of the image set.
- **The hand-off's images**: a draft carried by the hand-off arrives without images (ADR-0050 never carried them), so the record loses them at the next save, as the live draft already did.
- **Restore is not instant**: the recall waits for a disk read of up to 14 MB after `omp:ready`; a user typing in those milliseconds gets the card, not a merge.

## Rollout and Verification

One commit (design, Draft-module functions, protocol, store, page, dispatcher, tests, CHANGELOG, guide, architecture) plus the one-line call in `window.ts` made by the owner of that file. Checks: `npm run typecheck`, the node tests of the touched modules (`persist.test.ts`, `draft-store.test.ts`, `draft-persistence.test.ts` of the page and of the wiring, `messages.test.ts`, `guest-dispatcher.test.ts`, `draft.test.ts`), the whole `chat-ui.test.ts`, and one end-to-end scenario in a real window: attach, type, Reload Window, the draft is back, send, reload, the composer is empty.

## Related Decisions

- [Composer Draft module](2026-10-23-composer-draft-module.md): the value and the operations this design adds two functions to; its non-goal "no draft persistence" is lifted here.
- [ADR-0050](../decisions/0050-retain-uncertain-input-and-confirm-exact-file-restart.md): the hand-off; its capture shape is reused, its restore wins over a record.
- [ADR-0034](../decisions/0034-store-sessions-in-one-profile-catalog.md), [ADR-0081](../decisions/0081-keep-a-private-backup-of-the-catalog-and-broker-records-outside-vs-codes-storage-and-restore-it-over-a-missing-catalog.md): why drafts stay out of the catalog and its backup.
- [ADR-0023](../decisions/0023-reconnect-surviving-webviews-through-an-authenticated-bridge.md): the bridge route does not carry a save; the page saves again on the panel route.
- [Document attachments](2026-10-16-chat-document-attachments.md): linked and held documents, the registry.

## Architecture Review

- Reviewer: an independent reviewer examined the first version (2026-11-03) and accepted it with changes: a record per editor slot instead of per tab, the armed rule, explicit refusal rules, validation by the page before posting, the recall's recheck, immediate deletion when the draft becomes empty, no `origin` kept for linked paths, no setting (rationale recorded), the limits of the bridge route, the real file map and names, an age-only sweep, matching of the acknowledgement by save id and a recall kept apart from the hand-off. All are applied above; a confirmation pass of this version follows.
