import type { GuestHostMessage, GuestWebviewMessage } from "../../protocol/messages.ts";
import type { FileLinkAction, WebLinkMode } from "../../shared/terminal-links.ts";

// Mounts can change within one document while an older stat is still in flight.
let nextTerminalLinkRequestId = 0;

/** A mounted pane owns its pending validations; responses never cross a document. */
export class TerminalLinkClient {
	#pending = new Map<number, { resolve(valid: boolean): void; timer: NodeJS.Timeout }>();
	#disposed = false;
	#unsubscribe: () => void;
	readonly #post: (message: GuestWebviewMessage) => boolean;
	constructor(transport: { post(message: GuestWebviewMessage): boolean; subscribe(listener: (message: GuestHostMessage) => void): () => void }) {
		this.#post = message => transport.post(message);
		this.#unsubscribe = transport.subscribe(message => {
			if (message.type !== "omp:terminal-link-validation") return;
			const pending = this.#pending.get(message.requestId);
			if (!pending) return;
			this.#pending.delete(message.requestId); clearTimeout(pending.timer); pending.resolve(message.valid);
		});
	}
	/** `folders` asks whether `target` names an existing file or folder (Chat); without it, a file only (Terminal). */
	validate(target: string, folders = false): Promise<boolean> {
		if (this.#disposed) return Promise.resolve(false);
		const requestId = nextTerminalLinkRequestId++;
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => { this.#pending.delete(requestId); resolve(false); }, 4000);
		this.#pending.set(requestId, { resolve, timer });
		if (!this.#post({ type: "omp:terminal-link-validate", requestId, target, ...(folders ? { folders: true as const } : {}) })) {
			clearTimeout(timer); this.#pending.delete(requestId); resolve(false);
		}
		return promise;
	}
	/** `mode` says where a web link opens; a file reference carries none. */
	open(target: string, mode?: WebLinkMode): void {
		this.#post({ type: "omp:terminal-link-open", requestId: nextTerminalLinkRequestId++, target, ...(mode === undefined ? {} : { mode }) });
	}
	/** Open a Chat file or folder reference; `action` is what a modified click adds or does instead. */
	openPath(target: string, action?: FileLinkAction): void {
		this.#post({ type: "omp:terminal-link-open", requestId: nextTerminalLinkRequestId++, target, folders: true, ...(action === undefined ? {} : { action }) });
	}
	/** Open an internal OMP URL of this conversation's session (`agent://Name`); the host proves it again and opens an existing read-only view, or with `action: "os"` shows the file behind it. */
	openInternal(target: string, action?: FileLinkAction): void {
		this.#post({ type: "omp:terminal-link-open", requestId: nextTerminalLinkRequestId++, target, ...(action === undefined ? {} : { action }) });
	}
	/** Open the changes of a commit of this conversation's repository (`commit://<hex>`); the host looks the hash up again before it shows anything. */
	openCommit(target: string): void {
		this.#post({ type: "omp:terminal-link-open", requestId: nextTerminalLinkRequestId++, target });
	}
	/** Open a user link rule's URL in the external browser (`link-rule://<rule>/<matched text>`, `linkRuleTarget`); the host finds the rule itself and builds the URL, the page names none. */
	openLinkRule(target: string): void {
		this.#post({ type: "omp:terminal-link-open", requestId: nextTerminalLinkRequestId++, target });
	}
	/**
	 * Ask the host to open VS Code's workspace symbol search prefilled with the name of `symbol`, a code symbol with several definitions;
	 * with `files`, `symbol` is a bare file name span that several files carry and the host lets the user choose one.
	 */
	openSymbolSearch(symbol: string, files = false): void {
		this.#post({ type: "omp:terminal-link-open", requestId: nextTerminalLinkRequestId++, target: symbol, search: files ? "file" : true });
	}
	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe();
		for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.resolve(false); }
		this.#pending.clear();
	}
}
