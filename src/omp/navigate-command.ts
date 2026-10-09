/**
 * The `omp-desk-navigate` extension command (ADR-0051): an in-place, compare-and-swap leaf move that the Desk host
 * sends through the ordinary RPC `prompt`.
 *
 * OMP 18.8.5 exposes `navigateTree` to extensions only on `ExtensionCommandContext`, which exists only while a
 * registered command runs (pi-coding-agent `extensibility/extensions/types.ts` `ExtensionCommandContext`,
 * `session/agent-session.ts` `#tryExecuteExtensionCommand`). The leaf it sets is memory-only until the next append
 * (`session/session-manager.ts` `#setLeaf`, index `insert`), so a real move is followed by one `custom` marker entry:
 * it makes the move durable, proves the outcome to the host by request id, and names the tip Undo returns to.
 *
 * Refusals throw `omp-desk-navigate:<code>` from a fixed vocabulary; OMP reports a thrown command as an
 * `extension_error` frame and still completes the prompt. The surface is declared structurally, like the rest of
 * this module's OMP use, because the installed OMP is not a compile-time dependency.
 */
import {
	NAVIGATE_COMMAND,
	NAVIGATION_MARKER_TYPE,
	navigateError,
	parseNavigateArgs,
	leafReaches,
	undoMarker,
	type NavigationMarkerData,
} from "../chat/rewind.ts";

/** The read-only session manager members the command reads (`ReadonlySessionManager`). */
export interface NavigateSessionManager {
	getSessionId(): string | null | undefined;
	getLeafId(): string | null;
	getEntry(id: string): unknown;
	getBranch(fromId?: string): readonly unknown[];
}

/** `ExtensionCommandContext`, as far as this command uses it. */
export interface NavigateCommandContext {
	readonly mode?: string;
	readonly sessionManager: NavigateSessionManager;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>;
}

/** The `pi` members the registration uses. */
export interface NavigateCommandApi {
	on(event: string, handler: (event: unknown, ctx: { readonly mode?: string }) => unknown): void;
	registerCommand?(name: string, options: { description?: string; handler: (args: string, ctx: NavigateCommandContext) => Promise<void> }): void;
	appendEntry?(customType: string, data?: unknown): void;
}

/** What OMP's `session_tree` event reported for the move (`SessionTreeEvent`). */
export interface TreeObservation {
	oldLeafId: string | null;
	newLeafId: string | null;
	summarized: boolean;
}

/** Collects the `session_tree` events of one command run. */
export interface TreeObserver {
	begin(): void;
	/** The last event since {@link begin}, or null; ends the collection. */
	take(): TreeObservation | null;
}

/** A `session_tree` event payload, or null for anything else. */
export function treeObservation(event: unknown): TreeObservation | null {
	if (typeof event !== "object" || event === null) return null;
	const record = event as Record<string, unknown>;
	const leaf = (value: unknown): value is string | null => value === null || typeof value === "string";
	if (!leaf(record.oldLeafId) || !leaf(record.newLeafId)) return null;
	return { oldLeafId: record.oldLeafId, newLeafId: record.newLeafId, summarized: typeof record.summaryEntry === "object" && record.summaryEntry !== null };
}

function isUserMessage(entry: unknown): boolean {
	if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message" || !("message" in entry)) return false;
	const message = entry.message;
	return typeof message === "object" && message !== null && "role" in message && message.role === "user";
}

function idOf(entry: unknown): string | null {
	return typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string" ? entry.id : null;
}

/**
 * Run one navigation request. Every refusal throws a coded error before anything moved. Once `navigateTree` ran,
 * a leaf that moved always gets its marker, even when the call threw or another append raced it: the move is real
 * and must survive a restart. `from`/`to` are the leaves OMP reported (`session_tree`), not the ones checked before
 * the awaits, so Undo returns to the tip that was really left; a disagreement is flagged `raced`. Exported for tests.
 */
export async function runNavigateCommand(
	args: string,
	ctx: NavigateCommandContext,
	appendEntry: (customType: string, data: NavigationMarkerData) => void,
	tree: TreeObserver,
): Promise<NavigationMarkerData> {
	const request = parseNavigateArgs(args);
	if (request === null) throw navigateError("bad-request");
	if (ctx.mode !== "rpc") throw navigateError("mode");
	if (!ctx.isIdle() || ctx.hasPendingMessages()) throw navigateError("busy");
	const sessions = ctx.sessionManager;
	if (sessions.getSessionId() !== request.sessionId) throw navigateError("session");
	const checked = sessions.getLeafId();
	// The leaf the request saw, or only OMP's own bookkeeping (`model_usage`) appended after it.
	if (checked !== request.expectedLeafId && !leafReaches(sessions.getBranch().filter((entry): entry is object => typeof entry === "object" && entry !== null), request.expectedLeafId)) throw navigateError("stale");
	const target = sessions.getEntry(request.targetId);
	if (target === undefined || target === null) throw navigateError("target");
	const onBranch = (): boolean => sessions.getBranch().some(entry => idOf(entry) === request.targetId);
	if (request.kind === "rewind") {
		if (!isUserMessage(target) || !onBranch()) throw navigateError("target");
	} else if (request.kind === "switch") {
		// A target on the current branch would be an unlabelled rewind without its prompt.
		if (onBranch()) throw navigateError("target");
	} else {
		// Undo returns exactly to the tip the branch's marker recorded, nothing else.
		if (undoMarker(sessions.getBranch().filter((entry): entry is object => typeof entry === "object" && entry !== null))?.from !== request.targetId) throw navigateError("stale");
	}
	tree.begin();
	let cancelled = false;
	let failed = false;
	try {
		cancelled = (await ctx.navigateTree(request.targetId, { summarize: request.summarize })).cancelled;
	} catch {
		failed = true;
	}
	const observed = tree.take();
	const to = sessions.getLeafId();
	const from = observed?.oldLeafId ?? checked;
	if (to === from) throw navigateError(failed ? "failed" : cancelled ? "cancelled" : "unchanged");
	const raced = observed === null || observed.oldLeafId !== checked || observed.newLeafId !== to;
	const marker: NavigationMarkerData = {
		v: 1,
		requestId: request.requestId,
		kind: request.kind,
		from,
		target: request.targetId,
		to,
		summarized: observed?.summarized === true,
		...(raced ? { raced: true as const } : {}),
	};
	appendEntry(NAVIGATION_MARKER_TYPE, marker);
	return marker;
}

/**
 * Register the command once, from the first `session_start` of an RPC-mode session: the native TUI loads the same
 * module and must not list an internal command. A `pi` without `registerCommand`/`appendEntry` registers nothing,
 * and the host then refuses Rewind as unsupported because the command is absent from the live catalog. The
 * command needs only this module loaded with a usable bootstrap; it does not use the host-control pipe.
 */
export function registerNavigateCommand(pi: NavigateCommandApi): void {
	const register = pi.registerCommand;
	const append = pi.appendEntry;
	if (typeof register !== "function" || typeof append !== "function") return;
	let registered = false;
	let collected: TreeObservation[] | null = null;
	const tree: TreeObserver = {
		begin() { collected = []; },
		take() { const last = collected?.at(-1) ?? null; collected = null; return last; },
	};
	pi.on("session_tree", event => {
		const observation = treeObservation(event);
		if (collected !== null && observation !== null) collected.push(observation);
	});
	pi.on("session_start", (_event, ctx) => {
		if (registered || ctx.mode !== "rpc") return;
		registered = true;
		register.call(pi, NAVIGATE_COMMAND, {
			description: "OMP Desk internal: rewind this session in place",
			handler: async (args, commandContext) => {
				await runNavigateCommand(args, commandContext, (customType, data) => append.call(pi, customType, data), tree);
			},
		});
	});
}
