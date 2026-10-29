/**
 * The runtime's record of one conversation (ADR-0066, cut 7): the process this window runs for it, the verified
 * control channel, the admission fence and what the window shows of a stopped or failed host. The runtime owns
 * the records; the window reaches them through {@link RuntimeRecords} and keeps only what an editor is (panel,
 * document, bridge) in its own tab record. A record is filed under the conversation and moves with it when a
 * native handover renames the conversation.
 */
import type { HostControlClient } from "../host/control-client.ts";
import type { ControlHostSnapshot } from "../wire/control-protocol.ts";
import type { SessionHostRuntime } from "../host/native-session.ts";
import type { StopRecord } from "./local-stop.ts";

/** A verified host-control channel of one conversation. */
export interface RuntimeControl {
	readonly client: HostControlClient;
	/** Last snapshot read back from the host. */
	snapshot: ControlHostSnapshot | null;
	/** Positive local launch capability; absence never permits probing an older server. */
	readonly activity: boolean;
	/** Positive local staged-host capability for the additive work response. */
	readonly work?: boolean;
	/** Positive local staged-host capability for the registry `subagentWork` request. */
	readonly subagents?: boolean;
}

export interface RuntimeRecord extends StopRecord {
	/** The editor slot that serves the conversation; it moves with the record on a native handover. */
	slotId: string;
	runtime: SessionHostRuntime | null;
	control: RuntimeControl | null;
	/** Why host control is currently unavailable, shown rather than hidden. */
	controlFailure: string | null;
	/** What the terminal pane says when it asks for a writer that ended (killed, crashed). */
	endedNotice: string | null;
	nativeWatch: (() => void) | null;
	readonly pipeline: { noteReadOnly(reason: string): void; noteProcessGone(): void } | null;
}

/** What a record says of its conversation's terminal frontend, which belongs to an editor, not to the runtime. */
export interface PipelineView { noteReadOnly(reason: string): void; noteProcessGone(): void }

/** The record of one conversation. Created by the window when an editor first shows the conversation. */
export class ConversationRecord implements RuntimeRecord {
	/** The conversation; moves on a native handover. */
	tabId: string;
	slotId: string;
	runtime: SessionHostRuntime | null = null;
	control: RuntimeControl | null = null;
	controlFailure: string | null = null;
	endedNotice: string | null = null;
	nativeWatch: (() => void) | null = null;
	transitioning = false;
	readonly #pipeline: (record: ConversationRecord) => PipelineView | null;

	constructor(tabId: string, slotId: string, pipeline: (record: ConversationRecord) => PipelineView | null) {
		this.tabId = tabId;
		this.slotId = slotId;
		this.#pipeline = pipeline;
	}

	get pipeline(): PipelineView | null {
		return this.#pipeline(this);
	}
}

/** The runtime's records, filed by conversation. */
export class RuntimeRecords {
	readonly #records = new Map<string, ConversationRecord>();
	readonly #pipeline: (record: ConversationRecord) => PipelineView | null;

	constructor(pipeline: (record: ConversationRecord) => PipelineView | null) {
		this.#pipeline = pipeline;
	}

	get(conversation: string | null): ConversationRecord | undefined {
		return conversation === null ? undefined : this.#records.get(conversation);
	}

	/** The record of a conversation, created on first use for the editor slot that serves it. */
	acquire(conversation: string, slotId: string): ConversationRecord {
		let record = this.#records.get(conversation);
		if (record === undefined) {
			record = new ConversationRecord(conversation, slotId, this.#pipeline);
			this.#records.set(conversation, record);
		}
		return record;
	}

	/** A native handover renamed the conversation, or another editor now serves it: the record follows. */
	move(from: string, to: string, slotId: string): ConversationRecord | undefined {
		const record = this.#records.get(from);
		if (record === undefined) return undefined;
		if (from !== to) {
			this.#records.delete(from);
			this.#records.set(to, record);
		}
		record.tabId = to;
		record.slotId = slotId;
		return record;
	}

	drop(conversation: string): void {
		this.#records.delete(conversation);
	}

	all(): IterableIterator<ConversationRecord> {
		return this.#records.values();
	}
}
