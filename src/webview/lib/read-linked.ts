/**
 * The send-time read of the files a draft holds by reference (docs/designs/2026-10-16-chat-document-attachments.md,
 * *Proposed Design* 2 and 5): the page posts `omp:read-files` and waits for the matching `omp:files-read`. A host that
 * does not answer, or a route that cannot carry the request, refuses the send; nothing here ever reads a path.
 */
import type { GuestFileText, GuestHostMessage, GuestReadFileRef, GuestWebviewMessage } from "../../protocol/messages.ts";

/** The part of the guest transport this needs. */
export interface ReadTransport {
	post(message: GuestWebviewMessage): boolean;
	subscribe(listener: (message: GuestHostMessage) => void): () => void;
}

/** What the host read, or the sentence for why the send is refused. */
export type LinkedRead =
	| { readonly ok: true; readonly files: ReadonlyMap<number, GuestFileText> }
	| { readonly ok: false; readonly reason: string };

/** The wait for the host's answer: a base, and a little more for each file. */
export function readTimeoutMs(count: number): number {
	return Math.min(60_000, 20_000 + 50 * count);
}

/** Names of the documents by number, for a refusal that must name a file the host could not. */
export type NamesByNumber = ReadonlyMap<number, string>;

/** A failure's sentence: the host's own when it names the file, else prefixed with the file's name from the draft. */
function failureSentence(reason: string, name: string): string {
	return name.length === 0 || reason.includes(name) ? reason : `${name}: ${reason}`;
}

/**
 * Ask the host for the text of `files` within `budget` characters. `names` maps a document's number to its name, for the
 * sentences. A failure of any file is a refusal of the whole read.
 */
export function readLinkedFiles(transport: ReadTransport, requestId: number, files: readonly GuestReadFileRef[], budget: number, names: NamesByNumber): Promise<LinkedRead> {
	const { promise, resolve } = Promise.withResolvers<LinkedRead>();
	const unsubscribe = transport.subscribe(message => {
		if (message.type !== "omp:files-read" || message.requestId !== requestId) return;
		finish(message.failures.length > 0
			? { ok: false, reason: message.failures.map(failure => failureSentence(failure.reason, failure.name.length > 0 ? failure.name : names.get(failure.number) ?? "")).join(" ") }
			: { ok: true, files: new Map(message.files.map(file => [file.number, file])) });
	});
	const timer = setTimeout(() => finish({ ok: false, reason: "The extension host did not answer, so nothing was sent. Your draft was kept; try again." }), readTimeoutMs(files.length));
	const finish = (result: LinkedRead): void => {
		clearTimeout(timer);
		unsubscribe();
		resolve(result);
	};
	if (transport.post({ type: "omp:read-files", requestId, files: [...files], budget }) === false) {
		const unreadable = files.map(file => `${names.get(file.number) ?? "An attached file"} cannot be read over this connection; reload the window and attach it again.`);
		finish({ ok: false, reason: unreadable.join(" ") });
	}
	return promise;
}
