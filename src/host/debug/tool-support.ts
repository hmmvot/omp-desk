import { isRecord } from "../../guards.ts";
import type { HostToolContext, HostToolResult } from "../tools/host-tool.ts";
import { HostToolRefusal } from "../tools/host-tool.ts";
import type { DebugCoordinator, SessionView } from "./coordinator.ts";
import {
	DebugRequestCancelled,
	DebugRequestFailed,
	DebugRequestTimeout,
	isUnsupportedMessage,
	OperationCancelledError,
	SessionGoneError,
	SessionNotStoppedError,
	StaleGenerationError,
} from "./coordinator.ts";
import type { DebugApi } from "./debug-api.ts";
import type { DebugPolicy, DebugPreset } from "./policy.ts";

/** The returned text of one tool call is cut here, so a large reply never floods the model. */
export const MAX_RESULT_CHARS = 24_000;

export function textResult(text: string, details?: Record<string, unknown>): HostToolResult {
	return { content: [{ type: "text", text: limitText(text) }], ...(details ? { details } : {}) };
}

export function errorResult(text: string, details?: Record<string, unknown>): HostToolResult {
	return { content: [{ type: "text", text: limitText(text) }], isError: true, ...(details ? { details } : {}) };
}

export function limitText(text: string): string {
	if (text.length <= MAX_RESULT_CHARS) return text;
	return `${text.slice(0, MAX_RESULT_CHARS)}\n... [${text.length - MAX_RESULT_CHARS} more characters not shown]`;
}

/** `not supported by this debugger (<type>)`, the one wording for an operation an adapter does not implement. */
export function unsupported(type: string): string {
	return `not supported by this debugger (${type})`;
}

/**
 * Turns the expected failures of a debugger operation into an error result; anything unexpected, and a refusal by the
 * executor gate, propagates so the channel can answer it.
 */
export function failureResult(error: unknown, sessionType?: string): HostToolResult {
	if (error instanceof HostToolRefusal) throw error;
	if (error instanceof DebugRequestFailed) {
		if (sessionType !== undefined && isUnsupportedMessage(error.message)) return errorResult(`${unsupported(sessionType)}: ${error.message}`);
		return errorResult(`The debug adapter reported an error: ${error.message}`);
	}
	if (
		error instanceof DebugRequestTimeout || error instanceof DebugRequestCancelled || error instanceof StaleGenerationError
		|| error instanceof SessionGoneError || error instanceof SessionNotStoppedError || error instanceof OperationCancelledError || error instanceof GrantError
	) {
		return errorResult(error.message);
	}
	throw error;
}

/** Validated view of the `unknown` arguments OMP passes. */
export class Args {
	readonly #values: Record<string, unknown>;

	constructor(raw: unknown) {
		if (!isRecord(raw)) throw new ArgumentError("The arguments must be an object.");
		this.#values = raw;
	}

	string(key: string): string | undefined {
		const value = this.#values[key];
		if (value === undefined || value === null) return undefined;
		if (typeof value !== "string") throw new ArgumentError(`"${key}" must be a string.`);
		return value;
	}

	requiredString(key: string): string {
		const value = this.string(key);
		if (value === undefined || value === "") throw new ArgumentError(`"${key}" is required.`);
		return value;
	}

	/** An integer in `[min, max]`. */
	integer(key: string, min: number, max: number): number | undefined {
		const value = this.#values[key];
		if (value === undefined || value === null) return undefined;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
			throw new ArgumentError(`"${key}" must be an integer from ${min} to ${max}.`);
		}
		return value;
	}

	oneOf<T extends string>(key: string, allowed: readonly T[]): T | undefined {
		const value = this.string(key);
		if (value === undefined) return undefined;
		if (!(allowed as readonly string[]).includes(value)) throw new ArgumentError(`"${key}" must be one of: ${allowed.join(", ")}.`);
		return value as T;
	}

	requiredOneOf<T extends string>(key: string, allowed: readonly T[]): T {
		const value = this.oneOf(key, allowed);
		if (value === undefined) throw new ArgumentError(`"${key}" is required (${allowed.join(", ")}).`);
		return value;
	}
}

export class ArgumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArgumentError";
	}
}

/** Runs one tool body; an argument error becomes an error result, every other failure follows `failureResult`. */
export async function guarded(sessionType: () => string | undefined, body: () => Promise<HostToolResult>): Promise<HostToolResult> {
	try {
		return await body();
	} catch (error) {
		if (error instanceof ArgumentError) return errorResult(error.message);
		return failureResult(error, sessionType());
	}
}

/** Everything a debugger tool needs; one instance serves all of them. */
export interface DebugToolEnv {
	readonly api: DebugApi;
	readonly coordinator: DebugCoordinator;
	readonly policy: DebugPolicy;
	readonly presets: () => readonly DebugPreset[];
	/** How long `add` waits for adapters to verify a new breakpoint before reporting what they said. */
	readonly breakpointSettleMs: number;
	/** Progress cadence of `vscode_debug_wait`. */
	readonly waitTickMs: number;
}

/**
 * The checks every tool repeats right before a side effect, after every user confirmation and when a queued action
 * leaves its queue: cancellation, the executor gate, and the current setting.
 */
export function admit(env: DebugToolEnv, ctx: HostToolContext): void {
	if (ctx.signal.aborted) throw new OperationCancelledError();
	ctx.checkExecutor();
	if (!env.policy.enabled()) throw new HostToolRefusal("The agent debugger tools are disabled (setting omp.agentDebugger.enabled).");
}

/** A mutating action on a tracked session needs the conversation's grant; reads never do. */
export function requireGrant(env: DebugToolEnv, ctx: HostToolContext, sessionId: string): SessionView {
	const view = env.coordinator.session(sessionId);
	if (!view) throw new SessionGoneError(sessionId);
	if (!view.tracked) {
		throw new GrantError(`Debug session ${sessionId} was started before this window's debugger tools were active; its debugger state is not available in this extension-host lifetime, so it is read-only to the agent.`);
	}
	if (view.state.kind === "terminated") throw new SessionGoneError(sessionId, "has ended");
	if (!env.coordinator.canControl(sessionId, ctx.conversationId)) {
		const why = view.handedOff
			? "it was handed off to the user"
			: view.origin === "user" ? "the user started it" : "another conversation started it";
		throw new GrantError(`This conversation cannot change debug session ${sessionId} (${why}). Only a session started through vscode_debug_start by this conversation can be controlled; reads stay allowed.`);
	}
	return view;
}

export class GrantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GrantError";
	}
}

/**
 * Breakpoint conditions, log messages and `evaluate` all run code in the debuggee, so they share one setting.
 * Returns the reason when the expression may not run; `undefined` means allowed. After a confirmation the
 * cancellation, executor gate and setting are checked again, because the user may have taken a long time.
 */
export async function expressionDenial(env: DebugToolEnv, ctx: HostToolContext, lines: readonly string[]): Promise<string | undefined> {
	const mode = env.policy.expressionsMode();
	if (mode === "off") return "Running expressions in the debuggee is switched off (setting omp.agentDebugger.expressions).";
	if (mode === "allow") return undefined;
	const confirmed = await env.policy.confirm({ title: "Allow the agent to run code in the debuggee?", setting: "expressions", lines });
	admit(env, ctx);
	if (!confirmed) return "The user declined to run this expression in the debuggee.";
	if (env.policy.expressionsMode() === "off") return "Running expressions in the debuggee was switched off while the confirmation was open.";
	return undefined;
}

/** The promise's value, or `"timeout"` if it does not settle in time. A timeout never cancels work already started. */
export async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), ms); });
	try {
		return await Promise.race([promise, timedOut]);
	} finally {
		clearTimeout(timer);
	}
}
