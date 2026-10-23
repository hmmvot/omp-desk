# Glossary

The words this project uses with one meaning. When code, a document or a conversation needs a term from this list, it uses it as written here. A term that means something else in another area says so in its own entry. This file starts with the Chat composer, whose vocabulary was overloaded; add the other areas as they are designed.

## The composer

**Draft.** The composer's unsent message: one Markdown string plus the attachments its markers name, and the counters, budgets and bookkeeping that keep them consistent. A value with pure operations, specified by the [Draft module design](designs/2026-10-23-composer-draft-module.md) (`src/webview/lib/draft/draft.ts` once that design is implemented). *Not* a fileless session of the catalog, which the Sessions code also calls a "draft" (`createDraft`, `restoreDrafts`): say *draft session* for that one.

**Surface.** The `contenteditable` field that renders the draft's Markdown string and owns the string in the DOM, the selection, the composition window and the text-only undo history (`DraftSurface`, [ADR-0077](decisions/0077-edit-the-chat-draft-in-a-contenteditable-surface-rendered-from-the-markdown-string.md)). The adapter between the Draft and the DOM.

**Marker.** The literal text `[Image #N, WxH]` or `[File #N: name]` in the draft that names an attachment. A marker is *known* when an attachment of the draft backs it (a file marker only with its whole label); an unknown one is ordinary prose. An attachment exists while its marker is in the text.

**Attachment.** An image or a document of the draft, held by value in the Draft: an *image* (`DraftImage`, base64 bytes) or a *document* (`DraftDocument`, a text file that is *linked*, read from disk at send, or *held*, its text on the page). A deleted marker's attachment is *retained* until the budget forces its release, a send or a clear, so Undo restores it.

**Chip.** What the surface draws as one atomic, non-editable span: a marker, or the command or skill token the draft names (a *bare* chip, still being typed, is edited as text). Chips are derived from the string; nothing stores one.

**Quote.** Text whose lines start with `>` (and, for a non-empty line, an optional blank), placed at the end of the draft from a transcript selection or an editor selection. A *run* is consecutive quote lines; the *band* is how the surface draws it. A quote is never a separate object: it is derived from the string. A *quote request* is the captured Markdown asking the composer to place one.

**Capture and hand-off.** The *hand-off* is the in-memory move of the draft (text, the texts of held documents and the references of linked ones, recovery cards, an image count) from one document of an editor to its successor (ADR-0050); the *capture* is the complete read of the draft that starts it and freezes every change until the host releases it. *Quote capture* is something else: reading a selection of the transcript (`captureSelection`).

**Recoverable.** A message kept as a recovery card instead of a draft: a send that was refused after the draft changed, one that OMP did not confirm, or the draft a Rewind held. The user adds it to the draft or dismisses it. Undo of a Rewind (the *Rewound · Undo* action) takes an unedited rewound prompt back out of the composer.

**Completion.** A suggestion the user accepts into the draft: a `/command`, a `/skill:name`, a command's first argument or an `@path`. *Accepting* splices the token into the text as one undo step.

**Composition.** Two meanings; the context says which. In the composer the *send composition* (`compose`) is the outgoing message built from the draft: compacted text, one image array and one `<file>` block per document. The *IME composition window* is the surface's period in which the browser owns the DOM.

**Send, steer, follow-up.** The delivery choice for a composed message: an idle session takes a `prompt`; a running one takes a `steer` (injected into the turn) or a `follow_up` (queued for after it). The `prompt` of OMP's wire is also the message text itself.

**Revision.** A counter of the Draft that grows once for every change the cell commits that writes text or changes an attachment list, and for a user edit and a composition window opening (not on reads in flight, reservations, recovery cards or the echo of the cell's own write); "the draft was edited meanwhile" is judged by comparing revisions.

**Cell.** The one place that holds the Draft value, decides when a change may be written (some wait for the end of an IME composition window; none is written while the hand-off holds the draft) and writes it to the field through a port. Every change from outside the surface goes through it.
