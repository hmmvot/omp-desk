/**
 * The send composition (docs/designs/2026-10-23-composer-draft-module.md, section 5): what a draft sends, in two phases, and what is done
 * with the draft when the host has answered. `compose` judges and builds the message with no I/O: when a file is linked by reference its
 * text is read from disk at send, so phase 1 answers `read` with what to read and the composer calls `compose` again, with the same draft
 * value and the same context, once the host has answered. The value is immutable, so the message is the draft as it was at Enter even if
 * the user kept typing during the read; `settleSend` then clears the draft only when it is still the draft that was sent.
 */
import type { ImageContent } from "@oh-my-pi/pi-wire";
import type { ChatSlashCommand } from "../../../chat/model.ts";
import { MAX_MESSAGE_CHARS } from "../../../shared/attach-limits.ts";
import { composeFileBlocks } from "../../../shared/file-blocks.ts";
import { formatBytes, groupedCount } from "../../../shared/file-size.ts";
import { isRewindCommand, missingRequiredArgument } from "../slash-completion.ts";
import { MAX_DRAFT_BYTES, rawTotal } from "./attachments.ts";
import { composedOf, wireImages } from "./composition.ts";
import { documentChars, type DraftDocument } from "./draft-documents.ts";
import type { Change } from "./field.ts";
import { cleared } from "./refill.ts";
import type { Alerts } from "./refill.ts";
import type { Draft } from "./value.ts";

export interface SendContext {
	readonly commands: readonly ChatSlashCommand[];
	/** Rewind can be opened from this editor: a typed `/rewind` or `/branch` opens it instead of being sent. */
	readonly rewindAvailable: boolean;
}

/** What the host read of one linked file. */
export interface LinkedContent {
	readonly label: string;
	readonly content: string;
	/** An open editor holds unsaved changes to this file; the saved text is what was read. */
	readonly dirty: boolean;
}

/** The message a draft sends. */
export interface OutgoingMessage {
	/** The prose with its files appended as `<file>` blocks: the text on the wire. */
	readonly text: string;
	/** The prose alone, as typed (the markers compacted): what a command check reads. */
	readonly prose: string;
	readonly images: ImageContent[];
	/** The draft's revision at Enter: `settleSend` clears the draft only while it still holds. */
	readonly revision: number;
	/** The sentences for the linked files whose editor holds unsaved changes. */
	readonly unsaved: readonly string[];
}

export type Composition =
	/** Nothing to send: no effect. */
	| { readonly kind: "empty" }
	/** `/rewind` or `/branch` typed alone: the composer clears the text and opens Rewind. */
	| { readonly kind: "rewind" }
	| { readonly kind: "refused"; readonly reason: string; readonly reopenCompletion: boolean }
	/** Linked files must be read first; `budget` is what is left of the message after the text the page holds. */
	| { readonly kind: "read"; readonly files: readonly { readonly number: number; readonly ref: string }[]; readonly names: ReadonlyMap<number, string>; readonly budget: number }
	| { readonly kind: "ready"; readonly message: OutgoingMessage };

/** Whether `text` starts with the `/skill:<name>` of an installed skill: a skill invocation, which may carry files. */
function startsInstalledSkill(commands: readonly ChatSlashCommand[], text: string): boolean {
	const token = /^\/(\S+)/.exec(text)?.[1];
	return token !== undefined && commands.some(command => command.source === "skill" && command.name === token);
}

/** The refusal for a message over the limit, with its real figures and, when it carries files, the largest one. */
function tooLongSentence(total: number, documents: readonly DraftDocument[]): string {
	const largest = documents.reduce<DraftDocument | null>((best, document) => (best === null || documentChars(document) > documentChars(best) ? document : best), null);
	const tail = largest === null ? "" : ` The largest file is ${largest.name} (${groupedCount(documentChars(largest))} characters).`;
	return `The message would be ${groupedCount(total)} characters; one message carries ${groupedCount(MAX_MESSAGE_CHARS)}.${tail}`;
}

function refused(reason: string, reopenCompletion = false): Composition {
	return { kind: "refused", reason, reopenCompletion };
}

/**
 * Phase 1 is `compose(draft, context)`, in this order and with these sentences: empty; a typed `/rewind` or `/branch` with no attachments
 * while Rewind is available; a command that needs an argument (`reopenCompletion`); images over the budget; a `/command` carrying files
 * (a `/skill:` may); the characters known so far over `MAX_MESSAGE_CHARS`. When a linked file must be read it returns `read`; otherwise
 * it builds the blocks and checks the escaped length. Phase 2 is `compose(draft, context, contents)` with the same draft and the same
 * context and the host's answer by file number: the same checks, then the blocks (a file the host did not return refuses by name) and the
 * escaped length.
 */
export function compose(draft: Draft, context: SendContext, contents?: ReadonlyMap<number, LinkedContent>): Composition {
	const { prose, images, files } = composedOf(draft);
	if (prose.length === 0 && images.length === 0 && files.length === 0) return { kind: "empty" };
	// Chat's own `/rewind` and `/branch` never reach OMP; both open the in-place Rewind.
	if (context.rewindAvailable && images.length === 0 && files.length === 0 && isRewindCommand(prose)) return { kind: "rewind" };
	if (missingRequiredArgument(context.commands, prose)) return refused("This command requires an argument.", true);
	// Restored queued messages can bring the draft past what one message may carry; say so instead of sending a message the host would refuse without a word.
	if (rawTotal(images) > MAX_DRAFT_BYTES) return refused(`the attached images are ${formatBytes(rawTotal(images))}, over the ${formatBytes(MAX_DRAFT_BYTES)} one message may carry; remove an image to send`);
	// A text that starts with `/` is a command to OMP, which does not take files; a skill invocation is the one that does.
	if (files.length > 0 && prose.startsWith("/") && !startsInstalledSkill(context.commands, prose)) return refused("A message that starts with / is a command and cannot carry files.");
	const known = files.reduce((sum, file) => sum + documentChars(file), prose.length);
	if (known > MAX_MESSAGE_CHARS) return refused(tooLongSentence(known, files));
	const linked = files.filter(file => file.source.kind === "linked");
	if (linked.length > 0 && contents === undefined) {
		const heldChars = files.reduce((sum, file) => sum + (file.source.kind === "held" ? file.source.content.length : 0), prose.length);
		return {
			kind: "read",
			files: linked.flatMap(file => (file.source.kind === "linked" ? [{ number: file.number, ref: file.source.ref }] : [])),
			names: new Map(linked.map(file => [file.number, file.name])),
			budget: Math.max(0, MAX_MESSAGE_CHARS - heldChars),
		};
	}
	const blocks: { number: number; name: string; label: string | null; content: string }[] = [];
	for (const file of files) {
		if (file.source.kind === "held") {
			blocks.push({ number: file.number, name: file.name, label: file.source.label, content: file.source.content });
			continue;
		}
		const read = contents?.get(file.number);
		if (read === undefined) return refused(`${file.name} could not be read.`);
		blocks.push({ number: file.number, name: file.name, label: read.label, content: read.content });
	}
	const text = composeFileBlocks(prose, blocks);
	// Escaping the files' text can add characters, and a text-only message was never checked at all.
	if (text.length > MAX_MESSAGE_CHARS) return refused(tooLongSentence(text.length, files));
	const unsaved = linked.filter(file => contents?.get(file.number)?.dirty === true).map(file => `${file.name} has unsaved changes in the editor; the saved version was sent.`);
	return { kind: "ready", message: { text, prose, images: wireImages(images), revision: draft.revision, unsaved } };
}

/** The message is on its way: the capture carries it as unconfirmed until the host answers. It touches no revision, so an accepted send still clears. */
export function beginSend(draft: Draft, message: OutgoingMessage): Change {
	return { draft: { ...draft, inFlight: { text: message.text, images: message.images } }, writes: [] };
}

/** What the host answered to a send. */
export type SendResult = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly unconfirmed?: boolean };

export interface Settled {
	readonly change: Change;
	readonly alerts: Alerts;
	/** The page's note about the send (a linked file with unsaved changes), `null` for none. Present only for an accepted send. */
	readonly notice?: string | null;
}

/**
 * The tail of a send, run after the capture wait. The message in flight is settled in every case. An accepted send sets the note about
 * unsaved files and clears the draft (`cleared`), but only when the draft is still the one that was sent (the same revision): admission
 * can finish after typing, attaching or restoring another draft, and that work is never erased. A refused send whose result is
 * unconfirmed, or whose draft changed meanwhile, becomes a recovery card and says nothing else; otherwise the reason is the alert and the
 * draft stays.
 */
export function settleSend(draft: Draft, message: OutgoingMessage, result: SendResult): Settled {
	const settled: Draft = { ...draft, inFlight: null };
	if (!result.ok) {
		if (result.unconfirmed === true || draft.revision !== message.revision) {
			const card = { id: settled.next.card, text: message.text, images: message.images, reason: result.reason, unconfirmed: result.unconfirmed === true };
			return { change: { draft: { ...settled, recoverable: [...settled.recoverable, card], next: { ...settled.next, card: settled.next.card + 1 } }, writes: [] }, alerts: { send: null } };
		}
		return { change: { draft: settled, writes: [] }, alerts: { send: result.reason } };
	}
	const notice = message.unsaved.length > 0 ? message.unsaved.join(" ") : null;
	if (draft.revision !== message.revision) return { change: { draft: settled, writes: [] }, alerts: { send: null }, notice };
	return { change: cleared(settled), alerts: { send: null, attach: null }, notice };
}
