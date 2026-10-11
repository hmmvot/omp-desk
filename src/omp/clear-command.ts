/** Combined Chat clear (ADR-0059): boundary + public reload, then host-driven /fresh, then confirmation.
 * The sole private dependency is SessionManager.appendResetBoundary. A boundary without the final marker
 * is not proof of live reset. This is not full resetSessionContext parity; see the ADR's residual-state inventory.
 */
import { CLEAR_COMMAND, CLEAR_MARKER_TYPE, clearError, parseClearArgs, type ClearMarkerData } from "../chat/clear.ts";
import { isLiveSubagentRef, type AgentLivenessApi } from "./agent-liveness.ts";

/** The session manager members the command uses; `appendResetBoundary` is the one OMP does not type for extensions. */
export interface ClearSessionManager {
	getSessionId(): string | null | undefined;
	appendResetBoundary?: () => unknown;
}

export interface ClearAsyncJobSnapshot {
	readonly running: readonly unknown[];
	readonly delivery: { readonly queued: number; readonly delivering: boolean; readonly pendingJobIds: readonly string[] };
}

/** `ExtensionCommandContext`, as far as this command uses it. */
export interface ClearCommandContext {
	readonly mode?: string;
	readonly sessionManager: ClearSessionManager;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	getAsyncJobSnapshot?: () => ClearAsyncJobSnapshot | null;
	reload?: () => Promise<void>;
}

/** The `pi` members the registration uses. */
export interface ClearCommandApi {
	on(event: string, handler: (event: unknown, ctx: { readonly mode?: string }) => unknown): void;
	registerCommand?(name: string, options: { description?: string; handler: (args: string, ctx: ClearCommandContext) => Promise<void> }): void;
	appendEntry?(customType: string, data?: unknown): void;
}

/** Prepare a boundary/reload or confirm the host's completed fresh phase. Failures after mutation are non-atomic. */
export async function runClearCommand(
	args: string,
	ctx: ClearCommandContext,
	appendEntry: (customType: string, data: ClearMarkerData) => void,
	pending: Map<string, ClearMarkerData>,
	registryBusy: () => boolean | null,
): Promise<ClearMarkerData> {
	const request = parseClearArgs(args);
	if (request === null) throw clearError("bad-request");
	if (ctx.mode !== "rpc") throw clearError("mode");
	const sessions = ctx.sessionManager;
	const appendBoundary = sessions.appendResetBoundary;
	const reload = ctx.reload;
	// Checked before anything else can write: without both members the command does nothing at all.
	if (typeof appendBoundary !== "function" || typeof reload !== "function") throw clearError("unsupported");
	if (!ctx.isIdle() || ctx.hasPendingMessages()) throw clearError("busy");
	let jobs: ClearAsyncJobSnapshot | null;
	try { jobs = ctx.getAsyncJobSnapshot?.() ?? null; } catch { throw clearError("work-unavailable"); }
	const registry = registryBusy();
	if (jobs == null || !Array.isArray(jobs.running) || jobs.delivery == null ||
		typeof jobs.delivery.queued !== "number" || typeof jobs.delivery.delivering !== "boolean" ||
		!Array.isArray(jobs.delivery.pendingJobIds) || registry === null) throw clearError("work-unavailable");
	if (jobs.running.length > 0 || jobs.delivery.queued > 0 || jobs.delivery.delivering || jobs.delivery.pendingJobIds.length > 0 || registry) throw clearError("jobs");
	if (sessions.getSessionId() !== request.sessionId) throw clearError("session");
	if (request.phase === "confirm") {
		const marker = pending.get(request.requestId);
		if (marker === undefined) throw clearError("failed");
		appendEntry(CLEAR_MARKER_TYPE, marker);
		pending.delete(request.requestId);
		return marker;
	}
	const boundaryId = appendBoundary.call(sessions);
	try {
		await reload.call(ctx);
	} catch {
		throw clearError("reload-failed");
	}
	// A malformed boundary id cannot be proven, even if reload returned.
	if (typeof boundaryId !== "string" || boundaryId.length === 0) throw clearError("failed");
	const marker: ClearMarkerData = { v: 1, requestId: request.requestId, boundaryId };
	pending.set(request.requestId, marker);
	return marker;
}

/**
 * Register the command once, from the first `session_start` of an RPC-mode session: the native TUI loads the same
 * module and must not list an internal command. A `pi` without `registerCommand`/`appendEntry` registers nothing,
 * and the host then refuses `/clear` as unsupported because the command is absent from the live catalog.
 */
export function registerClearCommand(pi: ClearCommandApi & AgentLivenessApi): void {
	const register = pi.registerCommand;
	const append = pi.appendEntry;
	if (typeof register !== "function" || typeof append !== "function") return;
	let registered = false;
	const pending = new Map<string, ClearMarkerData>();
	const registryBusy = (): boolean | null => {
		try {
			const refs = pi.pi?.AgentRegistry?.global?.().list?.();
			return Array.isArray(refs) ? refs.some(isLiveSubagentRef) : null;
		} catch { return null; }
	};
	pi.on("session_start", (_event, ctx) => {
		if (registered || ctx.mode !== "rpc") return;
		registered = true;
		register.call(pi, CLEAR_COMMAND, {
			description: "OMP Desk internal: clear this session's context in place",
			handler: async (args, commandContext) => {
				await runClearCommand(args, commandContext, (customType, data) => append.call(pi, customType, data), pending, registryBusy);
			},
		});
	});
}
