/** The two row shapes the reducer keeps beside the durable entries; a leaf so the transcript projection can name them without importing the model. */
import type { ChatMessage } from "./messages.ts";
import type { TranscriptPosition } from "./projection.ts";

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	/** Latest `tool_stream_update.update` projection (e.g. a diff preview). */
	streamUpdate?: unknown;
	startedAt: number;
}

/** A message that ended live and whose durable entry has not been seen yet. */
export interface PendingRow extends TranscriptPosition {
	/** The synthetic entry id, `live:<messageId>`; also the key in the model's `pending` map. */
	entryId: string;
	messageId: string;
	role: ChatMessage["role"];
	timestamp: number;
	toolCallId: string | null;
	customType?: string;
	/** Hidden context is persisted and reconciled, but never receives a visible unsaved warning. */
	hidden?: boolean;
	/** Custom rows only: customType + content + details, the identity that survives a differing persist timestamp. */
	fingerprint?: string;
	/** True once the reconcile attempts ran out after the session settled: shown as *not yet saved*. */
	unsaved: boolean;
}
