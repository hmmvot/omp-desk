/**
 * The page's Rewind interaction state (design `docs/designs/2026-10-09-chat-rewind.md`): picking a prompt in the
 * transcript, then one navigation in flight. Pure, so the keyboard rules are tested without a DOM.
 *
 * Picking is pinned to the leaf it started from: a snapshot that moves the leaf (a turn, another window's rewind)
 * or drops the selected prompt from the loaded branch ends it, so a navigation is never sent against a transcript
 * the user did not see.
 */
import { NAVIGATE_COMMAND, NAVIGATE_REFUSAL_SENTENCES, type NavigationKind, type RewindTarget } from "../../chat/rewind.ts";
import type { ChatModel } from "../../chat/model.ts";

/**
 * Why this page cannot rewind now, in the host's own sentences, or null. The same facts the host checks
 * (`RpcSession.#navigationRefusal`), so the bar explains a refusal before the user asks for it.
 */
export function rewindBlockedReason(model: ChatModel): string | null {
	if (model.phase !== "live") return NAVIGATE_REFUSAL_SENTENCES["not-live"];
	if (model.readOnlyReason !== null) return model.readOnlyReason;
	if (model.state?.isCompacting === true || model.maintenance?.status === "working") return NAVIGATE_REFUSAL_SENTENCES.compacting;
	if (model.working || model.uiRequest !== null || !model.settled || model.asyncPaused || (model.state?.queuedMessageCount ?? 0) > 0) return NAVIGATE_REFUSAL_SENTENCES.busy;
	if (!model.commands.some(command => command.name === NAVIGATE_COMMAND && command.source === "extension")) return NAVIGATE_REFUSAL_SENTENCES.unsupported;
	return null;
}

export type RewindMode =
	| { kind: "idle" }
	| { kind: "picking"; targetId: string; leafId: string | null }
	| { kind: "pending"; action: NavigationKind; targetId: string; leafId: string | null; summarize: boolean };

export type RewindAction =
	/** Enter picking on `targetId`, or on the newest prompt. Ignored when nothing can be targeted. */
	| { type: "start"; targets: readonly RewindTarget[]; leafId: string | null; targetId?: string }
	| { type: "move"; targets: readonly RewindTarget[]; to: "previous" | "next" | "first" | "last" }
	| { type: "select"; targets: readonly RewindTarget[]; targetId: string }
	| { type: "cancel" }
	/** The picked target is sent; Undo and branch switches go straight to pending from idle. */
	| { type: "submit"; action: NavigationKind; targetId: string; leafId: string | null; summarize: boolean }
	| { type: "settled" }
	| { type: "snapshot"; targets: readonly RewindTarget[]; leafId: string | null };

export const REWIND_IDLE: RewindMode = { kind: "idle" };

export function reduceRewind(mode: RewindMode, action: RewindAction): RewindMode {
	switch (action.type) {
		case "start": {
			if (mode.kind === "pending" || action.targets.length === 0) return mode;
			const targetId = action.targetId !== undefined && action.targets.some(target => target.id === action.targetId) ? action.targetId : action.targets.at(-1)!.id;
			return { kind: "picking", targetId, leafId: action.leafId };
		}
		case "move": {
			if (mode.kind !== "picking" || action.targets.length === 0) return mode;
			const at = action.targets.findIndex(target => target.id === mode.targetId);
			const last = action.targets.length - 1;
			const next = action.to === "first" ? 0 : action.to === "last" ? last : action.to === "previous" ? Math.max(0, (at < 0 ? last : at) - 1) : Math.min(last, (at < 0 ? last : at) + 1);
			const targetId = action.targets[next]!.id;
			return targetId === mode.targetId ? mode : { ...mode, targetId };
		}
		case "select":
			return mode.kind === "picking" && action.targets.some(target => target.id === action.targetId) ? { ...mode, targetId: action.targetId } : mode;
		case "cancel":
			return mode.kind === "picking" ? REWIND_IDLE : mode;
		case "submit":
			return mode.kind === "pending" ? mode : { kind: "pending", action: action.action, targetId: action.targetId, leafId: action.leafId, summarize: action.summarize };
		case "settled":
			return mode.kind === "pending" ? REWIND_IDLE : mode;
		case "snapshot":
			if (mode.kind !== "picking") return mode;
			return mode.leafId !== action.leafId || !action.targets.some(target => target.id === mode.targetId) ? REWIND_IDLE : mode;
	}
}
