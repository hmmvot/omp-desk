/**
 * The window's per-editor record, seen through the fields the runtime reads and writes (ADR-0066,
 * cuts 4 and 5). `TabState` satisfies it structurally; the runtime never learns that an editor,
 * a panel or a document exists. Until the record is split (cut 7) the window's copy of the
 * runtime is the one copy there is, so the runtime reads and writes it here and nowhere else.
 */
import type { HostControlClient } from "../host/control-client.ts";
import type { ControlHostSnapshot } from "../host/control-protocol.ts";
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
	/** The immutable key the record is filed under; native handover moves a conversation under it. */
	readonly slotId: string;
	runtime: SessionHostRuntime | null;
	control: RuntimeControl | null;
	/** Why host control is currently unavailable, shown rather than hidden. */
	controlFailure: string | null;
	/** What the terminal pane says when it asks for a writer that ended (killed, crashed). */
	endedNotice: string | null;
	nativeWatch: (() => void) | null;
	readonly pipeline: { noteReadOnly(reason: string): void; noteProcessGone(): void } | null;
}
