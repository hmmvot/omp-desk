import { liveOf, liveSignature, projectContext } from "./context-model.ts";
import type { ChatModel } from "../../chat/model.ts";
import type { CommandResult, RpcSessionOutput } from "../rpc/session.ts";
import type { ContextRead, ContextReportRead } from "./context-parse.ts";
import type { ContextLive, ContextViewModel } from "./context-model.ts";

/** What the controller needs of the session: the footer's own model, its outputs, the structured read and the explicit report request. `RpcSession` satisfies it. */
export interface ContextSession {
	readonly model: ChatModel;
	subscribe(listener: (output: RpcSessionOutput) => void): () => void;
	readContext(): Promise<ContextRead | null>;
	requestContextReport(): Promise<CommandResult<ContextReportRead>>;
}

/**
 * The editor the view describes: built from the inventory views' target (so the selection rule is theirs), plus the
 * tab and session. `key` and `generation` fence every asynchronous result.
 */
export interface ContextTarget {
	readonly key: object;
	readonly generation: string;
	readonly mode: "chat" | "terminal";
	readonly running: boolean;
	readonly title: string;
	readonly tabId: string;
	readonly session: ContextSession | null;
}

export interface ContextControllerDeps {
	target(): ContextTarget | null;
	publish(model: ContextViewModel, target: ContextTarget | null): void;
	/** A sentence for a request that did not run; the view has no other place to say it. */
	notify(message: string): void;
	schedule(handler: () => void, ms: number): unknown;
	cancel(handle: unknown): void;
	now(): number;
	log(message: string): void;
}

/** A deep read waits this long after the last change that asked for it. */
export const DEEP_READ_DEBOUNCE_MS = 750;

/** The sentence for an explicit `/context` request that gave no report. */
export function breakdownFailure(result: Exclude<CommandResult<unknown>, { status: "ok" }>): string {
	if (result.status === "unconfirmed") return "OMP did not report its context breakdown.";
	if (result.reason === "busy") return "OMP is busy with another request; read the breakdown again when it is idle.";
	if (result.reason === "not-live" || result.reason === "not-owner") return "This conversation is not accepting commands right now.";
	return "OMP did not run /context as a command, so no breakdown was read.";
}

/**
 * Owns what the Context view shows: visibility, the selected target, the live header, the deep read and the last
 * explicit breakdown. Reads only while visible; never on a timer of its own (the only timer is the debounce after a
 * session change); a result is dropped when the target's key or generation changed; at most one deep read runs per
 * selection, with one queued.
 */
export class ContextController {
	readonly #deps: ContextControllerDeps;
	#visible = false;
	#target: ContextTarget | null = null;
	#unsubscribe: (() => void) | null = null;
	#live: ContextLive | null = null;
	#signature = "";
	#read: ContextRead | null = null;
	#report: ContextReportRead | null = null;
	#reading = false;
	#again = false;
	#timer: unknown = null;
	/** Advances whenever the subscription, the debounce timer or an in-flight request stops being the current attachment (hide, selection change, a session starting or stopping). Results and events carry the value they started under. */
	#attachment = 0;
	/** Advances with every attachment and also when the conversation moves on under one: a turn begins, the identity changes. A result that started under an older value mixes moments and is discarded. */
	#revision = 0;
	#disposed = false;

	constructor(deps: ContextControllerDeps) { this.#deps = deps; }

	setVisible(visible: boolean): void {
		if (this.#disposed || visible === this.#visible) return;
		this.#visible = visible;
		if (visible) this.sync();
		else this.#release();
	}

	/** The selected editor, its session or its running state may have changed. */
	sync(): void {
		if (this.#disposed || !this.#visible) return;
		const next = this.#deps.target();
		const current = this.#target;
		const same = next !== null && current !== null && next.key === current.key && next.generation === current.generation;
		if (!same) {
			this.#release();
			this.#target = next;
			this.#attach(next);
			this.#publish();
			this.#schedule(0);
			return;
		}
		// The same editor and session generation: only its title or running flag can differ. The target object is replaced
		// (the extension builds a new one per call); nothing is fenced by its identity.
		const changed = next.running !== current.running || next.title !== current.title;
		this.#target = next;
		if (!changed) return;
		if (next.running !== current.running) {
			this.#detach();
			this.#attach(next);
			this.#schedule(0);
		}
		this.#publish();
	}

	/** Read again now (Refresh, a catalogue update, tab activation). */
	refresh(): void {
		if (this.#disposed || !this.#visible) return;
		this.sync();
		this.#schedule(0);
	}

	/** The user's explicit request for OMP's `/context` report; it runs in the viewed conversation. */
	async readBreakdown(): Promise<void> {
		const target = this.#target;
		const session = target?.session;
		if (this.#disposed || !this.#visible || target === null || session === null || session === undefined || target.mode !== "chat" || !target.running) return;
		const attachment = this.#attachment;
		const revision = this.#revision;
		let result: CommandResult<ContextReportRead>;
		try {
			result = await session.requestContextReport();
		} catch (error) {
			this.#deps.log(`context: breakdown request failed: ${error instanceof Error ? error.message : String(error)}`);
			result = { status: "unconfirmed" };
		}
		if (attachment !== this.#attachment || revision !== this.#revision) return;
		if (result.status === "ok") {
			this.#report = result.value;
			this.#publish();
		} else this.#deps.notify(breakdownFailure(result));
	}

	dispose(): void {
		this.#disposed = true;
		this.#release();
	}

	/** Stop observing: the subscription, the timer and every request in flight stop being current. */
	#detach(): void {
		this.#attachment += 1;
		this.#revision += 1;
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		if (this.#timer !== null) this.#deps.cancel(this.#timer);
		this.#timer = null;
		this.#reading = false;
		this.#again = false;
		this.#live = null;
		this.#signature = "";
	}

	/** Forget the selection and everything read for it; the next visible sync starts from nothing. */
	#release(): void {
		this.#detach();
		this.#target = null;
		this.#read = null;
		this.#report = null;
	}

	#attach(target: ContextTarget | null): void {
		const session = target?.session;
		if (target === null || session === null || session === undefined || target.mode !== "chat" || !target.running) return;
		this.#live = liveOf(session.model);
		this.#signature = liveSignature(this.#live);
		const attachment = this.#attachment;
		this.#unsubscribe = session.subscribe(output => this.#onOutput(attachment, session, output));
	}

	#onOutput(attachment: number, session: ContextSession, output: RpcSessionOutput): void {
		if (this.#disposed || this.#attachment !== attachment) return;
		if (output.type === "identity") {
			// A /clear, /new or a resumed identity: nothing read or requested before describes this conversation.
			this.#revision += 1;
			this.#read = null;
			this.#report = null;
			this.sync();
			if (this.#attachment !== attachment) return;
			this.#schedule(DEEP_READ_DEBOUNCE_MS);
			this.#publish();
			return;
		}
		if (output.type === "snapshot") {
			// A new epoch (reconnect, rewind, a replaced conversation) changes the target's generation: re-evaluate the selection.
			this.sync();
			if (this.#attachment !== attachment) return;
		} else if (output.type !== "model") return;
		const live = liveOf(session.model);
		const signature = liveSignature(live);
		if (signature === this.#signature) return;
		if (live.busy && this.#live?.busy !== true) this.#revision += 1;
		this.#live = live;
		this.#signature = signature;
		this.#publish();
		if (!live.busy) this.#schedule(DEEP_READ_DEBOUNCE_MS);
	}

	#schedule(ms: number): void {
		if (this.#timer !== null) this.#deps.cancel(this.#timer);
		const attachment = this.#attachment;
		this.#timer = this.#deps.schedule(() => {
			this.#timer = null;
			if (attachment === this.#attachment) void this.#run();
		}, ms);
	}

	async #run(): Promise<void> {
		const target = this.#target;
		const session = target?.session;
		if (this.#disposed || !this.#visible || target === null || session === null || session === undefined || target.mode !== "chat" || !target.running) return;
		if (this.#reading) { this.#again = true; return; }
		// A turn, a compaction or a pass is running: the change that ends it asks again.
		if (liveOf(session.model).busy) return;
		const attachment = this.#attachment;
		const revision = this.#revision;
		this.#reading = true;
		let read: ContextRead | null = null;
		try {
			read = await session.readContext();
		} catch (error) {
			this.#deps.log(`context: read failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		// The attachment changed: whoever changed it reset the reading flag and owns what follows.
		if (attachment !== this.#attachment) return;
		this.#reading = false;
		// A turn began or the identity changed while this read was in flight, even if it is idle again: the three sources
		// were not read at one moment of one conversation. The read is dropped whole and asked for again once idle.
		const overtaken = revision !== this.#revision;
		const busy = liveOf(session.model).busy;
		if (read !== null && !overtaken && !busy) this.#read = read;
		this.#publish();
		const again = this.#again || overtaken;
		this.#again = false;
		if (again && !busy) this.#schedule(DEEP_READ_DEBOUNCE_MS);
	}

	#publish(): void {
		const target = this.#target;
		const model = projectContext({
			subject: target === null ? null : { title: target.title, mode: target.mode, running: target.running },
			live: this.#live,
			read: this.#read,
			report: this.#report,
			now: this.#deps.now(),
		});
		this.#deps.publish(model, target);
	}
}
