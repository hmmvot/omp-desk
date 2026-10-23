---
status: accepted
date: 2026-10-23
---

# One Draft module owns the composer's rules: an immutable value, pure operations, one cell that writes to the surface and one send composition

## Problem

The Chat composer's draft has one invariant: an attachment exists exactly while its marker is in the text. Nothing owns it. The text lives in `DraftSurface` (the ADR-0077 field adapter), mirrored by `textRef` and `text` state in `Composer.tsx`; images and documents are two parallel React lists with their own refs, counters and byte reservations; the invariant is rebuilt at a dozen call sites from shallow helpers (`activeImages`, `activeDocuments`, `referencedNumbers`, `pruneInactive*`). The send composition (`compactForSend` + `activeDocuments` + `composeFileBlocks`) exists three times in the component: the send, the Rewind hold of the previous draft and the "Add to draft" comparison. About a dozen external writers (typing aside) replace the text through one local function, `writeDraft`, or bypass it for the surface's `apply`, `replaceRange` and `removeRanges`, each with its own convention for undo, focus, deferral during an IME composition and the hand-off freeze.

The consequences are visible in the history: composer-rule fixes land one by one in a 1,964-line view (a multi-line paste into a quote, one Backspace removing a chip, a quote the host sent while the session starts, Undo on non-Latin layouts), and every rule can be tested only in Chromium: 81 contiguous subtests of `chat-ui.test.ts` (and 25 neighbours) exercise the draft in a browser, while about 190 node unit tests test the helpers one function at a time and never the rules composed. There is no vocabulary either: `draft`, `marker`, `attachment`, `chip`, `quote`, `capture` each mean two things in the code.

## Goals and Non-goals

- Goals:
  - One module, `src/webview/lib/draft/` with the entry `draft.ts`, owns every draft rule: the value (text, attachments, counters, bookkeeping), the pure operations that change it, the budgets and refusals, the markers and quotes, the completions' splicing, the refills, the hand-off capture, the send composition, and the **cell**, the one place that decides when a change may be written (composition, hand-off) and writes it through a field port. It has no React and no DOM; node tests cross its interface.
  - `Composer.tsx` imports no draft helper and composes no send. It translates events into operations and renders the value.
  - `DraftSurface` stays the field adapter of ADR-0077: it owns the string in the DOM, the selection and the text-only undo history. Every write from outside it goes through the cell and one port adapter.
  - The rule tests move to node tests of the Draft interface (one per operation of the inventory in *Current State*); the replaced browser subtests and helper tests are deleted. Chromium keeps layout, IME, focus, DOM paste and drop, and one end-to-end check.
  - A glossary, `docs/GLOSSARY.md`, fixes the words.
- Non-goals:
  - No user-visible behaviour change. A bug found on the way is fixed in a separate commit with its own CHANGELOG entry, **before** the restructuring so the restructuring stays a pure move (one is already known, see Risks).
  - No change to the surface's DOM behaviour, to the Markdown string, to the wire (`<file>` blocks, `[Image #N]` positional pairing), to the hand-off protocol (ADR-0050) or to any host code.
  - No draft persistence across a reload. The draft is lost on reload today; whether to persist it belongs to the backlog.
  - The Commands list (`command-list.ts`, `CommandsMenu`) keeps its rows, availability and picking; only the `insert` row's text edit (`insertCommandIntoDraft`) becomes the Draft operation `insertCommand`. The DOM capture of a transcript selection (`quote-capture.ts`, `quote-selection.ts`), the quote sink registry and the quote hold stay where they are.

## Current State

(Evidence: `Composer.tsx` at `0d4b655`; line numbers drift.) State owners: `DraftSurface` (string, DOM, selection, undo), `Composer` state and refs (`text`, `images`, `documents`, `textRef`, `imagesRef`, `documentsRef`, `nextNumberRef`, `nextDocumentNumberRef`, `imageSeqRef`, `reservedRef`, `reservedCharsRef`, `readingRef`, `draftRevisionRef`, `rewoundRef`, `historyRef`, `recoverableRef`, `recoverySeqRef`, `pendingOriginalRef`, `lostAttachmentsRef`, `caretRef`, `deferredRef`, `captureRef`), and the host's `draftRestores` map for the hand-off between documents.

Inventory of every operation that changes the draft (each becomes an operation of the interface or stays on the surface):

- Typing, native delete, cut, paste of text, drop of text, IME composition: `DraftSurface` (stay).
- Editing inside a fenced block and on a quote line (Enter, Tab, Shift+Tab, Backspace, Delete): a `TextEdit` computed in `Composer` and applied as one `"block"` step.
- Attachments: paste, drop of OS files, drop from VS Code's Explorer (host-read), the Attach button, the thumbnail ×, markers inserted at the caret, budget, duplicate, count and size refusals, concurrent reads sharing one reservation.
- Quotes: a transcript selection, an editor selection from the host, a held quote while the session starts, the Remove quote button.
- Completions: `/command`, `/skill:name`, `@path`, command argument; the Commands row `insert`.
- Refills: prompt history ↑/↓, `set_editor_text`, host-inserted `@path` and `path:N`, queued-message edit and `Alt+↑`, history-search recall, Stop's returned messages (ADR-0082), Rewind's prompt and Undo of it, the hand-off restore into a new document, the recovery card's "Add to draft".
- Send and clear: the send composition and its validation, delivery choice, the refused-or-uncertain outcome, the clear after an accepted unchanged revision, `/rewind` typed alone, the hand-off capture that freezes everything.

**The revision today** (`draftRevisionRef`) goes up on exactly four things: a text write (`writeDraft`), the publication of an attachment list (`publishImages`, `publishDocuments`), a user edit reported by the surface (`onEdit`) and a composition window opening (`onWindowOpen`). It does not go up on reservations, reads in flight, the in-flight original, recovery cards, the history walk or lost attachments. The send's "clear only an unedited draft", the refused send's "keep or card" and the Rewind/Stop "unedited" latch (`rewoundRef`) are judged by comparing it.

**Undo** is the surface's only: `DraftHistory` snapshots `{text, anchor, focus}`; attachments follow because the marker is text and deleted attachments are retained until the budget forces their release. `Composer` never touches the history; each external write states `"record"` or `"reset"`. `apply`, `replaceRange`, `removeRanges`, undo and redo report the new text through `onEdit` synchronously; `setText` never does, whether it applies at once or from the queue at the close of a composition window; `apply` and `removeRanges` refuse (`false`) while frozen or inside a window, `setText` refuses nothing (it drops the text while frozen and queues it inside a window).

**Today's per-writer timing** (while an IME composition window is open / while the hand-off holds the draft; "checked at run" means after the deferral):

| Writer | Composition open | Draft held |
| --- | --- | --- |
| completion accepted | skipped | skipped |
| markers of an attach | waits | dropped (checked at run) |
| thumbnail × | waits | dropped (checked at run) |
| host-inserted `@path` / `path:N` | waits | waits (re-deferred at run) |
| queued-message edit, Stop refill | waits | waits |
| Rewind refill and its Undo | waits | waits |
| `/rewind` typed alone (clears the text) | not reached (the key handler does not run) | refused by the send's gate |
| Remove quote | waits | dropped (checked at run) |
| a quote | waits | refused with a notice |
| `set_editor_text` | written now (the surface queues the text) | waits (the effect re-runs on release) |
| fence and quote keys | not claimed | not claimed |
| prompt-history ↑/↓ | not claimed | **not checked** (a defect, see Risks) |
| hand-off restore, send clear, Commands `insert` | written now | send waits for the release; the others are not reached |

**Tests:** all draft rules are browser-only; the helper tests (21 files, about 190 tests) test one function each. Every browser subtest of the draft was classified for this design (14 port, 48 split, 44 keep, of 106).

## Proposed Design

### 1. Seams and layers

```
 DraftEditor / Composer (React)            node tests
   │ events → operations, cell as store         │
   ▼                                            ▼
 ┌─────────────── seam: src/webview/lib/draft/draft.ts ─────────────────┐
 │ Draft value · pure operations · compose · attach(cell, reader)        │
 │ createDraftCell(port): timing, deferred work, hand-off capture        │
 │ (image-references, draft-documents, command-chips, quote-*, restore,  │
 │  completion tokens, file-blocks use … all internal)                   │
 └───────────────┬────────────────────────────────────────┬─────────────┘
   FieldPort (the 2nd seam)                    AttachReader (the 3rd seam)
                 ▼                                        ▼
  lib/draft-write.ts → DraftSurface           lib/attach-reader.ts (File readers)
  (the real field)  /  a fake in node         /  a fake in node (File and Blob exist in node, so the real
                                                 reader is node-tested too)
```

Three seams, each with two adapters, so each is real:

- **`DraftCell` / `FieldPort`.** The cell holds the value, decides *when* a change may be written and performs it through the port: `{ mounted(), composing(), selection(), write(write): boolean, freeze(), thaw() }`. The real port is `lib/draft-write.ts` over `DraftSurface`; the test port records writes and simulates a composition window and a refusal. The cell is plain TypeScript in `draft/`, so the timing rules (the top risk below) are node-tested, and the hand-off rule of ADR-0050 (a capture freezes every change) is testable without a browser. React reads the cell with `useSyncExternalStore`.
- **`AttachReader`**: `{ classify(file), readImage(file, key), readDocument(file) }`. The real reader (`lib/attach-reader.ts`, `File` and `Blob` only; `createImageBitmap` is guarded, so only the pixel size is missing in node) keeps its own node tests; the fake gives controllable timing and failure to the algorithm's tests. An `AttachEntry` carries a `File` value that only passes through to the reader; the module itself never reads the DOM.
- The surface is the field behind the port; its pure rules reach the module through `fieldRules` (below).

The module imports only `src/shared`, `src/protocol`, `src/chat`, `@oh-my-pi/pi-wire` types and the catalogue and grammar modules `slash-completion.ts` and `code-fence.ts` (the latter also serves the transcript's quote capture); never React, a `.tsx` file, `components/`, the bridge, the client or any surface file. It lives in the `webview` layer (ADR-0065) because its value types are the page's.

**Enforcement** in `scripts/check-imports.mjs`, with cases in `check-imports.test.mjs`: **R-draft-1** a non-test file outside `src/webview/lib/draft/` may import from that directory only `draft/draft.ts`; **R-draft-2** a non-test file inside it may import only files of the directory, `src/shared`, `src/protocol`, `src/chat`, the two modules named above and type-only `@oh-my-pi/pi-wire`, and never `react`, `react-dom` or a `.tsx` file. Test files are exempt from both (internal seams are tested beside the module). Both rules are recorded as an amendment of ADR-0077 and in `architecture.md`.

### 2. The value

```ts
interface Draft {
  readonly text: string;                         // the Markdown string; the only text
  readonly images: readonly DraftImage[];        // every attached image, including ones whose marker was deleted and Undo can bring back
  readonly documents: readonly DraftDocument[];  // same for files (linked: read at send; held: text on the page)
  readonly next: { image: number; document: number; key: number; card: number };  // never reused within a draft; image and document reset on `cleared` and Rewind's Undo; key and card never reset
  readonly reserved: { bytes: number; chars: number };  // held by reads in flight, so overlapping attaches budget against one total
  readonly reading: number;                      // reads in flight (attach and host-read drops); the linked read at send is not one
  readonly lostImages: number;                   // images a hand-off could not carry
  readonly revision: number;                     // see below
  readonly unedited: number | null;              // the revision right after a Rewind or Stop refill; Undo of that refill clears the draft only while it still holds
  readonly walk: HistoryCursor | null;           // the ↑/↓ prompt-history walk in progress
  readonly recoverable: readonly Recoverable[];  // recovery cards: a refused or uncertain send, the draft a Rewind held
  readonly inFlight: { text: string; images: readonly ImageContent[] } | null;  // the message awaiting admission (a capture carries it as unconfirmed)
}
```

This goes beyond the maintainer's short list ({text, images, documents, counters}); every extra field is there because a rule the module owns needs it (`reserved` and `reading` for `attach`, `revision` and `unedited` for the send's clear and the latch, `walk` for recall, `recoverable`, `inFlight` and `lostImages` for the capture and the card rules) and today each already lives in a component ref. `reading`, `reserved` and `inFlight` are ignored by `captureOf`, `sameAs` and `compose`.

**The revision keeps today's meaning exactly, and `commit` is the only place that increases it** (a pure operation never sets `revision`): it increases, once, for a change that carries a `text`, `edit` or `remove` write (an `edit` applied to the value alone while no field is mounted included), or whose image list or document list differs; and in the cell for `windowOpened()` and for a user `edited()`. It does **not** increase on `reading`, `reserved`, `inFlight`, `recoverable`, `walk`, `lostImages`, a change of `next` alone, a `caret` write, or the echo of the cell's own surface write (the echo only reconciles the text, see 3). Operations that set `unedited` carry a `text` write, which does not echo, and `commit` stores the revision it produced.

Undo history is not in the value (it is the surface's, text only; ADR-0077 stays). Retention is unchanged: a deleted marker's attachment stays in the lists until the budget forces its release (`pruneInactive*`) or a send or clear empties them, so Undo restores the attachment with its marker. *Why the value and not the surface owns the attachments:* the surface renders text and cannot know images, counters or budgets; the value is what node tests and the send need.

### 3. Operations, writes and the cell

Every operation is a pure function `(draft, …inputs) → Change | result` with no clock, no randomness and no I/O. An operation that must run when the cell says so (`perform`) is written as a factory of an `Op` (`insertText(reference)`, `quote(request, context)`): the cell passes it the draft and the selection as they are at that moment. What is read from the DOM today (selection, caret) is an input.

```ts
interface Change { readonly draft: Draft; readonly writes: readonly Write[]; }
type Write =                                                                        // what the field must do; data, never a callback
  | { kind: "text";   text: string; caret?: number; history: "record" | "reset"; focus: boolean }               // setText
  | { kind: "edit";   edit: { from: number; to: number; insert: string; selection?: Selection }; as: EditKind; focus: boolean }  // apply: one undo step; no selection lets the field widen over a marker
  | { kind: "remove"; ranges: readonly { from: number; to: number }[]; focus: boolean }                         // removeRanges: one step
  | { kind: "caret";  at: number; focus: boolean };                                                              // setSelectionRange

type Op<R> = (draft: Draft, at: { selection: Selection; mounted: boolean }) => { change: Change | null; result: R } | null;
type Timing = { composing: "wait" | "skip" | "now"; held: "wait" | "drop" };
type Outcome<R> = { kind: "applied"; result: R } | { kind: "refused"; result: R } | { kind: "dropped" };

interface DraftCell {
  getState(): { draft: Draft; caret: number; held: boolean };  subscribe(listener): () => void;  read(): Draft;
  commit(change: Change): boolean;                                      // value now, then the writes through the port; refused → the value is restored and false
  perform<R>(op: Op<R>, when: Timing, then?: (outcome: Outcome<R>) => void): void;
  edited(text: string): void;  windowOpened(): void;  settled(): void;  moved(): void; // the field reports: a user edit, a composition window opening, its close, a selection move (the caret mirror)
  capture(requestId: number): DraftCapture | null;  release(requestId: number): boolean;  held(): Promise<void> | null;
  alive(): boolean;  dispose(): void;
}
```

`commit` sets the value, then performs the writes in order through the port. **A change has at most one refusable write and it comes first** (`apply`/`remove` while frozen or composing, `text` while frozen); every later write is a `caret` move, which is never refused (`insertText`, an `edit` then a `caret`, is the only multi-write change today). A refusal restores the previous value and `commit` returns `false`, so the surface and the value never disagree. **While the draft is held `commit` refuses every change** (`false`, nothing written), value-only ones included (dismissing a recovery card or the lost-images warning, adding a card): this is the ADR-0050 rule in one place; the cell's own `capture` and `release` are not commits. A surface write that echoes (`apply`, `remove`, undo, redo) calls `edited(text)`; while the cell performs its own write the echo only reconciles `text := surface text` (this is how a widened edit corrects the prediction) and does not touch the revision; any other `edited` is a user edit and increases it. After every echo and every `caret` write the caret is read from the port (as `onEdit` calls `syncCaret` today); a `text` write does not echo, so the cell sets the caret itself (`caret ?? (changed ? text.length : unchanged)`), as `writeDraft` does. `getState()` returns a cached snapshot that is replaced only when the state changes, so `useSyncExternalStore` sees a stable reference.

`perform` is the one place the timing rules live. It runs `op` with the selection **at the moment it runs** (the end of the text when no field is mounted, with `mounted: false`: an `edit` write then updates the value only, `remove` and `caret` writes are dropped, a quote refuses itself). While a composition window is open the work waits for `settled()` (`wait`), is skipped (`skip`) or is written now (`now`: the surface queues a `text` write itself); while the hand-off holds the draft the work is dropped or waits for `release`. The per-writer `Timing` is exactly today's table above, carried by the call sites (`Composer` and `attach`); a deferred item that finds the draft held again is re-deferred, as the insert and restore handlers do today; `settled()` and `release()` run what was deferred in arrival order, once (`splice(0)`), so work deferred while running waits for the next flush. `then` receives the outcome (the quote's refusal sentence, the alerts of a restore) so no result is lost to the deferral; it is called synchronously for `dropped` and `refused`, and later, when the work runs, for a deferred one; an `op` that returns `null` is `dropped`. When no field is mounted `removeAttachment` and `removeQuote` return `null` rather than commit a value-only change (both unreachable today). `capture` returns `null` (a refusal) while reads are in flight, a composition is open, deferred work waits (the host's own pending flag is checked by the caller), or a capture is already held; otherwise it builds the capture from the value, freezes the port and marks the cell held; `release(requestId)` thaws, runs the deferred work and resolves `held()`.

The real port is `lib/draft-write.ts` (`DraftSurface` calls; `write` returns `false` for a `text` write on a frozen surface). It remembers a `freeze()` it received while no surface is attached and applies it when one mounts (today a layout effect does this for a field that mounts while the hand-off holds the draft). `release(requestId)` that arrives after `dispose()` (the registry calls it from its unmount cleanup) still thaws and resolves `held()`, and runs nothing. Rendering stays the composer's: it calls `surface.refresh()` when the attachments or the catalogue change, and the cell calls it after `settled()` through the port's `redraw()`, as `onSettled` does today. `writeDraft` is deleted and the comments that name it (`DraftEditor`, `Composer`) are updated.

### 4. The operations

| Group | Operation | Replaces | Notes |
| --- | --- | --- | --- |
| value | `emptyDraft`; `viewOf(draft, caret)` → `{ images, documents, blocks, quote, caretBlock, caretInQuote, hasContent, untouched }`; `knowsReference(draft, kind, number, name)` | the `useMemo`s, the Esc Esc idle check | `untouched` is today's raw-lists-and-text-empty check (not `hasContent`) |
| field | `fieldRules(known, resolve)` → `{ chips, atomic, layout, snap, deletion, repair, pasteEdit }` | the surface's imports of the marker, chip, quote and fence rules | the lookups are **live**: the real ones read `cell.read()`, so a widening right after a publish never sees a stale set |
| 1 | `attach(cell, entries, reader, earlier, events)` (async) | `attach`, `insertMarkers`, `rejectionSummary`, reservations | below |
| 1 | `removeAttachment(kind, number)` → `Op<void>` | `removeAttachment` | one `remove` write, run by `cell.perform` with `Timing` wait/drop; the operation takes the draft and the selection from `perform` |
| 2 | `keyEdit(draft, selection, key, context)` → `{ claimed: true, change } \| { claimed: false, inBlock }` | the fence and quote branches of `onPromptKeyDown` | `claimed: false` = not claimed (`inBlock`: the caret is in a fenced block, where no popup key applies either); `change: null` = claimed with no edit (Tab on a fence line is claimed so the focus stays); `context` = `{ composing, held, sendWith }` |
| 2 | `completionAt(draft, caret, commands, enabled)`, `acceptCompletion(caret, selected, commands)` → `Op<void>` | the token queries and splices | `visible` rows stay the view's, from the catalogue |
| 2 | `insertCommand(draft, name)` → `Change` | `insertCommandIntoDraft` | the Commands row `insert` plan; the caret-only case is a `caret` write |
| 2 | `recall(draft, prompts, direction, held)` → `Change \| null` | the ↑/↓ branch | owns `walk`, the held documents of a recalled prompt, and the gate "no image at all, retained ones included" |
| 2 | `setEditorText(draft, text)` → `Change`, `insertText(reference)` → `Op<void>` | the `set_editor_text` effect, the inserted-text handler | `insertText` is an `edit` without a selection, then a `caret` write when a blank follows |
| 2 | `restoreQueued(entries)` → `Op<Alerts>` | `mergeRestoredQueued` and the prunes | owns the lone-withdrawn-message latch |
| 2 | `rewind(answer)` → `Op<Alerts>` | the navigation effect | holds the previous draft as a recovery card, replaces, or undoes an unedited refill; **every** finished navigation clears `unedited` (a switch, or a rewind with no prompt, is a change that only clears it) |
| 2 | `clearText(draft)`, `undoRefill` is inside `rewind`, `cleared(draft)` | three different clears today | `/rewind` typed alone clears the text only (attachments and counters stay); Rewind's Undo clears text, attachments, counters and the attach alert, keeping the walk; an accepted send clears all of that and the walk. They stay three, as they are |
| 2 | `captureOf(draft)` (inside `cell.capture`), `restoreHandoff(draft, capture)` → `Change`, `dismissLost(draft)` → `Change` | the hand-off provider and the restore effect | numbers bump past restored markers; recovery cards are rebuilt from the capture |
| 2 | `quote(request, context)` → `Op<QuoteResult>`, `removeQuote(start)` → `Op<void>` | `use-quote-draft`'s edit, `removeQuote` | the notice sentences and refusals in one place; `context` carries what only the page knows (`writable`, `settling`); the hand-off and the composition window are the cell's `Timing`, and a host-sent editor quote while the session settles is a `hold` result the hook keeps |
| 2 | `heldMessage(draft)` (internal to `rewind`), `addRecoverable(draft, card)`, `dismissRecoverable(draft, id)` | the Rewind hold, `publishRecoverable` | built on the same internal composition `compose` uses (introduced in group 2) |
| 3 | `compose(draft, context, contents?)` → `Composition` | the three copies of the composition and the send's validation | two-phase, below |
| 3 | `settleSend(draft, outgoing, result)` | the send's tail | accepted unchanged → `cleared`; refused → keep or a card |
| 3 | `sameAs(draft, original)`, `addToDraft(draft, id)` → `{ change, alerts }` | the "Add to draft" comparison and its lost-images arithmetic | uses `compose`'s own text; a linked file never matches |

`alerts` is `{ attach?: string | null; send?: string | null }` (`undefined` = leave): the sentences the composer shows in its two alert rows.

**`attach`.** `attach(cell, entries, reader, earlier, events)` is today's algorithm against the cell. Preconditions the composer keeps: the draft is not held and the session is writable. Then, once per call: nothing to attach (no entries and no earlier refusals) returns; the **guard** (`attachGuardRefusal` over the active attachments and all entries) refuses the whole batch with its own sentence and drops the host's earlier refusals; `reading` rises by `entries.length`; `events.started()` runs (the composer clears its send notice). Per entry, in order: a **linked** document is checked for a duplicate (against the active documents and this call's accepted ones), then for room, then reserved, never read; a **file** is classified by its first bytes; an **image** is sized against `active bytes + reserved`, reserved, then read (the image key is allocated before the read, a failed read releases exactly what it reserved); a **text** is read first, then judged for room and reserved. In a `finally` the call releases exactly its own reservations and its share of `reading`. Then, if the cell is still alive and with no await in between, the accepted attachments are numbered, pruned against the budget (`pruneInactive*`, the new ones protected) and published in one value-only commit, and the markers are inserted by a `perform(insertMarkers, { composing: "wait", held: "drop" })` (an `edit` write without a selection, one space apart, spaces around unless whitespace is there; with no field the markers are appended). It resolves `{ alert }` (the rejection summary, `undefined` to leave the alert alone). Every step reads `cell.read()` afresh, so overlapping attaches see each other's reservations.

**What stays on the surface.** Typing, native deletes, cut, plain-text paste and drop, IME windows, selection snapping, undo and redo, focus, the widening of an edit over a marker. The surface calls `fieldRules` for the pure part of each. DataTransfer handling (`filesFrom`, `dragCarries`, `droppedFileUris`, `fileFromAttached`; moved out of `attachments.ts` in group 1 to `lib/attach-dom.ts` together with their tests) and the host's attach and pick requests stay with the composer's DOM events; `attach-reader.ts` holds the `File` readers (`classifyFile`, `readDocumentFile`, `readImageAttachment`).

### 5. Send composition, two phases

```ts
interface SendContext { commands: readonly ChatSlashCommand[]; rewindAvailable: boolean }
type Composition =
  | { kind: "empty" }                                          // nothing to send: no effect
  | { kind: "rewind" }                                         // /rewind or /branch typed alone: the composer opens Rewind, after clearText
  | { kind: "refused"; reason: string; reopenCompletion: boolean }
  | { kind: "read"; files: readonly { number: number; ref: string }[]; names: ReadonlyMap<number, string>; budget: number }  // linked files must be read first
  | { kind: "ready"; message: OutgoingMessage };
interface OutgoingMessage { text: string; prose: string; images: ImageContent[]; revision: number; unsaved: readonly string[] }
```

`compose(draft, context)` is phase 1. In this order and with today's sentences: empty; a typed `/rewind` or `/branch` with no attachments and `rewindAvailable`; a command that needs an argument (`reopenCompletion`); images over the budget; a `/command` carrying files (a `/skill:` may); known characters over `MAX_MESSAGE_CHARS`. If a linked file must be read it returns `read` with the budget (the remaining characters after the held ones); otherwise it builds the blocks and checks the escaped length (`ready`). The composer performs the read (`readLinkedFiles`, host I/O) and calls `compose(draft, context, contents)` with the **same draft value and the same context**: the value is immutable, so the message is the draft as it was at Enter even if the user kept typing, and `revision` is the one at Enter. Phase 2 skips the phase-1 checks (a catalogue that changed during the read cannot flip a refusal), refuses a file whose contents did not arrive (`<name> could not be read.`), and re-checks the length. Gating stays in the composer, which owns the client: the draft is held, a pending dialog, not live, reads in flight, a send in flight, the live re-check after the read, and delivery (idle `prompt`, running `steer` or `follow_up`).

`settleSend(draft, outgoing, result)` encodes the tail and returns `{ change, alerts, notice }`: an accepted send sets the unsaved-file notice and clears the draft (`cleared`: counters, attachments, walk, a `reset` write) only when `draft.revision === outgoing.revision`, otherwise it leaves everything; a refused send whose result is unconfirmed, or whose draft changed meanwhile, becomes a recovery card, otherwise it is an alert and the draft stays. It runs after the capture wait, as today. `inFlight` is set by the composer's commit just before delivery and cleared by `settleSend`; it does not touch the revision, so an accepted send still clears. `heldMessage` (Rewind's hold: held documents only, linked ones counted as lost) and `sameAs` ("Add to draft": equal text and image bytes) use the same internal composition, which is what removes the three copies.

### 6. Migration groups

Four commits after this document, each leaving the tree green, each with no dual path: when a rule moves, its old call sites are gone in the same commit, the helper tests and the replaced browser subtests are deleted in the same commit, and the node tests of the new operation are added in it.

0. **Mechanical move.** `git mv` into `draft/` of the modules that belong to the Draft whole (`image-references`, `draft-documents`, `attachments`, `attached-documents`, `command-chips`, `quote-lines`, `quote-edits`, `quote-draft`) with their tests, plus `draft.ts`, a **barrel** that re-exports what the current importers use; every importer is rewritten to import `draft.ts`; `EditKind`, `HistoryMode` and `Selection` types move to `draft/` (the surface imports them from the entry; `draft/` never imports a surface file); `file-block-rows.ts`'s `utf8Length` moves to `src/shared`; R-draft-1 and R-draft-2 are added with their tests, and the ADR-0077 amendment that records them is written in this commit. No behaviour, no new operation. The barrel is the **ledger of transitional exports**: each is listed in `draft.ts` with the group that removes it, and a node test pins the exact export list per group (the last group's list is the interface of section 4); it sees value exports by importing the entry and type exports by scanning its source. The `queue-restore`, `insert-text` and `slash-completion` files are split in group 2, not here.
1. **Markers and attachments.** The value, `edit`, `windowOpened`, `viewOf`, `knowsReference`, the cell and its `FieldPort` (`draft-write.ts`), `fieldRules` (chips, snap, deletion, repair), `attach`, `removeAttachment`, `attach-reader.ts` (the `File` readers out of `attachments.ts` and `attached-documents.ts`) and `attach-dom.ts` (the DataTransfer helpers). The other writers (queue restore, Rewind, recall, the hand-off restore, the send's clear, the recovery cards) still change attachments, counters and the bookkeeping fields, so the barrel carries a transitional `withState(draft, patch)` covering **every** value field whose writer has not moved yet (so a capture taken between groups 1 and 3 still carries the cards and the in-flight message) and the helpers those writers call (`pruneInactive*`, `referencedNumbers`, `mergeRestoredQueued` …); each is listed in the ledger with the group that removes it. The attachment strip becomes `AttachmentStrip.tsx` with the document labels.
2. **External writes and quotes.** Every other writer becomes a named operation (the group-2 rows), moving `quote-*` further, the merge half of `queue-restore`, the token half of `slash-completion`, `spaceInsertion` of `insert-text` and `QuoteRequest`/`RestoredQueued` into `draft/` (the registries stay outside and import the types from the entry: `queue-handover.ts` is the registry half of `queue-restore.ts`, renamed, with the importers `QueuedMessages.tsx`, `queue-view.ts` (the type) and `Composer`; `insert-text.ts` keeps the registry and loses `spaceInsertion` and `followedByBlank`, which move together; `quote-sink.ts`, `draft-handoff.ts`); `fieldRules` gains `layout` and `pasteEdit`; the transitional exports of group 1 go. `use-quote-draft.ts` shrinks to the page-only refusals (`writable`, `settling`, the hold, the notice).
3. **Send composition.** `compose`, `settleSend`, `sameAs`, `addToDraft`; `Composer.send` becomes gating + `compose` + the read + `client.send*` + `settleSend`; the three copies are gone. The export list is final.

At the end `Composer.tsx` imports `lib/draft/draft.ts` for the draft and no other draft module, and the checker proves it.

### 7. Test plan

Node tests live in `src/webview/lib/draft/*.test.ts` and cross the interface with `emptyDraft`, the in-memory cell with a recording `FieldPort`, and a fake `AttachReader`; the real `AttachReader` keeps node tests of its own (classification, sentences) using node's `File` and `Blob`. Each operation of the inventory has a test of its main rule and of every refusal sentence it can produce. The browser subtests were classified one by one before this design was written (14 port, 48 split, 44 keep, of 106; the classification is kept with the implementation notes, not in Git); a **subtest is deleted only after the node test of its rule exists, and the helper tests are removed per assertion**: an assertion is deleted when the same rule is asserted through the interface; a test of a grammar or catalogue module that stays outside (`code-fence`, `slash-completion`'s catalogue half, `file-blocks` in `src/shared`, `draft-history`, `draft-text`, `quote-hold`, `typing-activity`, `queue-view`, `read-linked`, `send-with`, `editor-quote`, `draft-handoff`, the registries) is kept.

- Group 1: typing mirror and the revision rule (what bumps and what does not); `fieldRules` (snap, deletion widening, repair of a damaged marker, a marker without an attachment is prose, a file marker counts only with its whole label); `viewOf`; `attach` (image and text classification outcomes, every refusal sentence, a duplicate linked file, the count guard, byte and character budgets, two overlapping attaches sharing one reservation, a failed read releasing exactly its share, markers one space apart and surrounded by the right spaces, retention for Undo with pruning against the budget, an unmounted cell); `removeAttachment`; the cell (every `Timing` combination, a refused write restoring the value, echo reconciliation, deferred work in order and once, the capture rules and the freeze).
- Group 2: `keyEdit` (every fence and quote key rule, claimed-with-no-edit), `completionAt` and `acceptCompletion` (slash, skill, argument, mention, a quoted path, the gate inside a block or quote or after a command or shell sigil), `insertCommand`, `recall`, `setEditorText`, `insertText`, `restoreQueued` (every Stop refill rule of ADR-0082), `rewind`, `captureOf` and `restoreHandoff`, `quote` and `removeQuote` (every refusal and notice), the chip rule over text plus catalogue (the real 18.11.1 catalogue fixture moves to node).
- Group 3: `compose` (each validation in order, linked read and its budget, escaping, renumbering, image order, phase 2), `settleSend` (clear, keep, card), `heldMessage`, `sameAs`, `addToDraft`.

Chromium keeps: the surface (typing, native delete, cut, IME windows, selection snapping with real clicks and arrows, undo and redo, clipboard and drag events, accessibility attributes), rendering (chips, bands, strip, hints, popup layout, themes), focus, the real paste of files and drop of OS files and VS Code URIs, the transcript Range quote capture, the composer-only behaviour that is not draft arithmetic (the choice of prompt, steer and follow-up, the live re-check after a linked read, the capture wait during admission, attaching while no field is mounted, the Stop notices, scroll behaviour after a send), the reduced residue of the 48 split subtests, and **one end-to-end check**: a real authoring round trip (a fenced block and a quote typed, a pasted image, a dropped linked document, a Tab-accepted completion, a Ctrl+Enter send), asserted on the wire (compacted text with `[Image #1, WxH]`, one `<file>` block, image bytes once, draft cleared) and once in the DOM. The final report lists the numbers of tests removed and added.

## Alternatives

- **Leave the rules where they are and extract a `useDraft` hook.** Moves the state, not the rules: the hook is still a React module, the rules are still testable only with a DOM, the three composition copies still sit side by side. Rejected: depth stays shallow.
- **A mutable `DraftStore` class that owns the surface.** One object, fewer concepts, but the rules and the DOM share a lifetime, so node tests need a surface fake and the module imports `DraftSurface`. Rejected: ADR-0077's surface is an adapter and stays one. (The cell is the part of this idea that survives: it owns the value and the timing, and reaches the surface only through a port.)
- **The cell inside the React adapter.** The timing rules would live twice (the real hook and the test double) and could not be node-tested, although they are the top risk. Rejected after review.
- **One reducer `apply(draft, action)`.** The smallest interface and very testable, but results differ per operation (`Composition`, `{ refusal }`, `{ change } | null`), so the union of results is as wide as the list of functions and call sites unwrap tagged unions for nothing. Named operations keep each signature honest.
- **Put the attachments into the surface.** It renders text; images, counters and budgets do not belong to a DOM adapter.
- **Keep reading and reserving in the component.** The budget and reservation rules are exactly the invariant the module exists to hold.
- **Regroup so group 1 carries every writer that touches attachments (no mechanical group 0).** One commit would move all of the composer's writers at once; the mechanical move first keeps each behavioural commit reviewable.
- **Move all helper tests as they are.** Rejected by the maintainer: one-function tests that never compose the rules, and the browser subtests left as duplicates.

## Risks and Open Questions

- **Behaviour drift.** A rule moved is a rule that can change. Mitigation: each operation is ported from the exact code (same order of checks, same sentences), its node test is written from the browser subtest it replaces, and the full `chat-ui` suite runs after every group.
- **A defect in today's code, fixed first.** Prompt-history ↑/↓ writes the value while the surface drops the text during a hand-off capture, because `writeDraft` has no capture check (the surface ignores `setText` while frozen). The cell's rule (a refused write restores the value) would fix it silently, so it is fixed in its own commit **before** group 0, with its own CHANGELOG entry, and the restructuring then preserves the fixed behaviour. [INFERENCE: it needs a keydown to reach the frozen field; freezing does not blur it.]
- **Behaviour that is kept on purpose.** `set_editor_text` is written even during a composition (the surface queues it); the three clears stay three; `insertMarkers` and `insertText` still let the field widen over a marker. Changing any of them is a separate decision.
- **The surface echo.** The cell's write and the surface's echo are reconciled by the rule in section 3, so the revision is bumped once; the cell's node tests simulate a port that echoes and one that widens.
- **Interface width.** About twenty operations plus `fieldRules`, the cell and `attach`, grouped by migration group and consumer. The deletion test holds (without the module, the rules reappear across the composer, the quote hook, the surface and the registries). `fieldRules` is a factory because it needs the same two live lookups on every call.
- **Test removal loses coverage.** Mitigation: the classification, the node test first, the per-assertion deletion rule, and the numbers in the report.
- **Open (not blocking):** persisting the draft across a reload; belongs to the backlog.

## Rollout and Verification

Order: this document and `docs/GLOSSARY.md` (reviewed, accepted); the small fix commit; groups 0, 1, 2, 3 as separate commits. After each: typecheck, `node scripts/check-imports.mjs` and `node --test scripts/check-imports.test.mjs`, the node tests of the touched area, and the full `chat-ui.test.ts` (Idle priority, bounded concurrency). After the last: the privacy check `node scripts/check-privacy.mjs --range origin/main..HEAD --tree HEAD`, `docs/architecture.md` updated (the composer paragraphs name the new module and the two rules; the ADR-0077 amendment is written with group 0), and the dev VSIX built and installed from the final commit with `.omp/workspace/tools/pack-commit.ps1`. No CHANGELOG line for the restructuring (internal); the fix commit gets its own entry.

## Related Decisions

- [ADR-0077](../decisions/0077-edit-the-chat-draft-in-a-contenteditable-surface-rendered-from-the-markdown-string.md): the surface stays the field adapter; the Markdown string stays the only source of truth; every programmatic write states `record` or `reset` (the `Write` does). Amended for R-draft-1 and R-draft-2 in group 0.
- [ADR-0050](../decisions/0050-retain-uncertain-input-and-confirm-exact-file-restart.md): the capture freezes every change; kept by the cell's `held` rule and the surface's `freeze()`.
- [ADR-0082](../decisions/0082-stop-takes-a-message-back-out-of-the-conversation-when-nothing-was-answered-or-done.md): the Stop refill and its un-edited latch move into `restoreQueued`.
- [ADR-0065](../decisions/0065-enforce-one-import-direction-between-source-layers.md): the layers; R-draft-1 and R-draft-2 are rules inside the `webview` layer.
- Designs: [composer contenteditable surface](2026-10-15-composer-contenteditable-surface.md), [code blocks](2026-10-15-composer-code-blocks.md), [quote selection](2026-10-15-quote-chat-selection.md), [document attachments](2026-10-16-chat-document-attachments.md), [command and skill chips](2026-10-18-composer-command-skill-chips.md), [edit queued messages](2026-10-07-edit-queued-messages.md), [Rewind](2026-10-09-chat-rewind.md): their rules are unchanged; this design moves where they live.
- [Glossary](../GLOSSARY.md).

## Architecture Review

- Reviewer: architect (an independent agent that did not write the document), two passes.
- Outcome: accepted after the findings were resolved. First pass: accept with changes, two material findings (the revision rule would have changed when an accepted send clears the draft and when the Rewind/Stop latch holds; group 1 was not executable under the import rule) and eleven should-fix items (the cell's timing and commit rules had no node-testable home, the write vocabulary could not express today's writers, the attach algorithm was misdescribed, the import inventory and type placement, the three different clears, the stray rules without a home, the test plan, a defect in recall under a hand-off capture). Confirmation pass: accept with changes, one material finding (the revision must be increased in one place, `commit`, or a quote added during a send's admission would be erased) and five should-fix items (at most one refusable write per change, a held draft refuses value-only changes too, the freeze of a late-mounted field and a release after dispose, the DataTransfer helpers' destination, a capture between groups 1 and 3) plus nits; all applied in the text above. The reviewer stated that no further full pass was needed once they were applied.
- Notes: the maintainer's earlier decisions stand; the value fields beyond {text, images, documents, counters} and the mechanical group 0 before the three agreed groups are the author's local decisions, reported to the maintainer with the result.
