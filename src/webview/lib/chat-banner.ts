/**
 * The one line a conversation shows about its own state, by phase.
 *
 * The extension never forwards arbitrary child text: a failure arrives as a bounded machine
 * `code` and the page picks the fixed sentence (`RPC_ERROR_SENTENCES`). A code this build does
 * not know gets the generic sentence, so a newer host can add codes without the page showing
 * nothing or raw text.
 */
// Explicit `.ts` specifiers: this module is imported by the node:test runner.
import type { ChatModel } from "../../chat/model.ts";
import { isRecoverableRpcFailure, RPC_ERROR_SENTENCES } from "../../host/rpc/protocol.ts";
import type { RpcErrorCode } from "../../host/rpc/protocol.ts";

export interface ChatBanner {
	level: "info" | "warn" | "error";
	text: string;
	icon: string;
	/** An in-place remedy the page can offer next to the sentence. */
	action?: "reconnect";
}

const GENERIC_FAILURE = "The session is not available.";
const LEGACY_TEXT =
	"This tab belongs to a previous version of the extension and cannot show this session. Close the tab and open the session from the Sessions panel.";
const STOPPED_TEXT = "Session stopped. Resume to continue.";

/** The fixed sentence for `code`, or the generic one. */
export function errorSentence(code: string | null): string {
	if (code !== null && Object.hasOwn(RPC_ERROR_SENTENCES, code)) return RPC_ERROR_SENTENCES[code as RpcErrorCode];
	return GENERIC_FAILURE;
}

/** The banner for a model, or `null` when a live, writable conversation needs none. */
export function chatBanner(model: Pick<ChatModel, "phase" | "code" | "readOnlyReason">): ChatBanner | null {
	switch (model.phase) {
		case "starting":
			return { level: "info", icon: "debug-start", text: "Starting the session…" };
		case "attaching":
			return { level: "info", icon: "plug", text: "Connecting to the session…" };
		case "resyncing":
			return { level: "info", icon: "sync", text: "Catching up with the session…" };
		case "live":
			return model.readOnlyReason === null ? null : { level: "warn", icon: "warning", text: model.readOnlyReason };
		case "stopped":
		case "view-only":
			return { level: "info", icon: "debug-stop", text: STOPPED_TEXT };
		case "failed":
			return isRecoverableRpcFailure(model.code) ? { level: "error", icon: "error", text: errorSentence(model.code), action: "reconnect" } : { level: "error", icon: "error", text: errorSentence(model.code) };
		case "blocked":
			return { level: "warn", icon: "warning", text: model.readOnlyReason ?? "This session is open elsewhere. You can read its saved history here." };
		case "legacy":
			return { level: "warn", icon: "warning", text: LEGACY_TEXT };
	}
}
