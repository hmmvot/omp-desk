import { isRecord } from "../../guards.ts";
import type { HostToolContext, HostToolDefinition, HostToolResult } from "../tools/host-tool.ts";
import type { SessionReader, SessionState } from "./coordinator.ts";
import { SessionNotStoppedError, StaleGenerationError } from "./coordinator.ts";
import { admit, Args, ArgumentError, errorResult, expressionDenial, guarded, requireGrant, textResult } from "./tool-support.ts";
import type { DebugToolEnv } from "./tool-support.ts";

const WHAT = ["threads", "stack", "scopes", "variables", "evaluate"] as const;
const EVALUATE_CONTEXTS = ["watch", "repl", "hover", "clipboard"] as const;

/** One inspection call is bounded by adapter requests and by reply bytes, as well as by the text it returns. */
const MAX_REQUESTS = 24;
const MAX_REPLY_BYTES = 512 * 1024;
const MAX_VALUE_CHARS = 400;

class BudgetExceeded extends Error {
	constructor() {
		super("The inspection limit for one call was reached.");
		this.name = "BudgetExceeded";
	}
}

/** Counts adapter requests and reply bytes of one call. */
class ReadBudget {
	#requests = 0;
	#bytes = 0;

	async request(reader: SessionReader, command: string, args: unknown): Promise<unknown> {
		if (this.#requests >= MAX_REQUESTS) throw new BudgetExceeded();
		this.#requests += 1;
		const body = await reader.request(command, args);
		this.#bytes += JSON.stringify(body)?.length ?? 0;
		if (this.#bytes > MAX_REPLY_BYTES) throw new BudgetExceeded();
		return body;
	}
}

function shorten(text: string, max = MAX_VALUE_CHARS): string {
	const single = text.replace(/\r?\n/g, "\\n");
	return single.length <= max ? single : `${single.slice(0, max)}...`;
}

const frameRef = (generation: number, id: number): string => `g${generation}:f${id}`;
const variableRef = (generation: number, reference: number): string => `g${generation}:v${reference}`;

/** A reference carries the generation it was produced under; an older one fails as a stale read. */
function parseRef(text: string, kind: "f" | "v", reader: SessionReader): number {
	const match = /^g(\d+):([fv])(\d+)$/.exec(text);
	if (!match || match[2] !== kind) throw new ArgumentError(`"${text}" is not a ${kind === "f" ? "frame" : "variables"} reference from this tool (expected ${kind === "f" ? "g<generation>:f<id>" : "g<generation>:v<id>"}).`);
	if (Number(match[1]) !== reader.generation) throw new StaleGenerationError();
	return Number(match[3]);
}

function array(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function sourceText(frame: Record<string, unknown>): string {
	const source = isRecord(frame.source) ? frame.source : undefined;
	const line = typeof frame.line === "number" ? frame.line : undefined;
	const hasLocalPath = source !== undefined && typeof source.path === "string" && !(typeof source.sourceReference === "number" && source.sourceReference > 0);
	if (!hasLocalPath) return "(source not available)";
	return `${source.path as string}${line !== undefined ? `:${line}` : ""}`;
}

/** The thread to act on: the one given, else the stopped thread, else the only thread. */
async function resolveThread(reader: SessionReader, state: SessionState, given: number | undefined, budget: ReadBudget): Promise<number> {
	if (given !== undefined) return given;
	if (state.kind === "stopped" && state.threadId !== undefined) return state.threadId;
	const threads = array((await budget.request(reader, "threads", {}) as Record<string, unknown> | undefined)?.threads);
	if (threads.length === 1 && typeof threads[0]!.id === "number") return threads[0]!.id;
	throw new ArgumentError(`"threadId" is required (the session has ${threads.length} thread(s); list them with what=threads).`);
}

async function threadsView(reader: SessionReader, state: SessionState, budget: ReadBudget): Promise<HostToolResult> {
	const body = await budget.request(reader, "threads", {});
	const threads = array(isRecord(body) ? body.threads : undefined);
	const stoppedThread = state.kind === "stopped" ? state.threadId : undefined;
	const lines = threads.map(thread => `${thread.id === stoppedThread ? "*" : " "} ${String(thread.id)}  ${String(thread.name ?? "")}`);
	return textResult(`${threads.length} thread(s) (generation ${reader.generation}; * = the thread that stopped):\n${lines.join("\n")}`, { what: "threads", generation: reader.generation, threads: threads.map(thread => ({ id: thread.id, name: thread.name })) });
}

async function stackView(reader: SessionReader, state: SessionState, args: Args, budget: ReadBudget): Promise<HostToolResult> {
	const threadId = await resolveThread(reader, state, args.integer("threadId", 0, 2_147_483_647), budget);
	const startFrame = args.integer("startFrame", 0, 100_000) ?? 0;
	const levels = args.integer("levels", 1, 50) ?? 20;
	const body = await budget.request(reader, "stackTrace", { threadId, startFrame, levels });
	const returned = array(isRecord(body) ? body.stackFrames : undefined);
	const total = isRecord(body) && typeof body.totalFrames === "number" ? body.totalFrames : undefined;
	// DAP lets an adapter ignore startFrame and levels (vstuc returns the whole stack), so the bounds are applied here too.
	const ignoredStart = startFrame > 0 && total !== undefined && returned.length >= total;
	const frames = (ignoredStart ? returned.slice(startFrame) : returned).slice(0, levels);
	const lines = frames.map((frame, index) => {
		const id = typeof frame.id === "number" ? frame.id : undefined;
		return `#${startFrame + index} ${String(frame.name ?? "?")} at ${sourceText(frame)}${id !== undefined ? ` [frame ${frameRef(reader.generation, id)}]` : ""}`;
	});
	const next = startFrame + frames.length;
	const more = total !== undefined ? (next < total ? `\n... ${total - next} more frame(s); call again with startFrame=${next} (and levels) to see them` : "") : frames.length === levels ? `\n... the adapter did not report the stack depth; there may be more frames: call again with startFrame=${next}` : "";
	return textResult(`Thread ${threadId}, generation ${reader.generation}, frames ${frames.length === 0 ? "none" : `${startFrame}-${startFrame + frames.length - 1}`}${total !== undefined ? ` of ${total}` : ""}:\n${lines.join("\n")}${more}`, {
		what: "stack",
		generation: reader.generation,
		threadId,
		frames: frames.map(frame => ({ name: frame.name, location: sourceText(frame), id: frame.id })),
	});
}

async function scopesView(reader: SessionReader, args: Args, budget: ReadBudget): Promise<HostToolResult> {
	const frameId = parseRef(args.requiredString("frameRef"), "f", reader);
	const body = await budget.request(reader, "scopes", { frameId });
	const scopes = array(isRecord(body) ? body.scopes : undefined);
	const lines = scopes.map(scope => `${String(scope.name ?? "?")}${scope.expensive === true ? " (expensive)" : ""}  [variables ${typeof scope.variablesReference === "number" ? variableRef(reader.generation, scope.variablesReference) : "?"}]`);
	return textResult(`${scopes.length} scope(s) of frame ${frameId} (generation ${reader.generation}):\n${lines.join("\n")}`, { what: "scopes", generation: reader.generation, scopes: scopes.map(scope => ({ name: scope.name, ref: typeof scope.variablesReference === "number" ? variableRef(reader.generation, scope.variablesReference) : undefined })) });
}

async function expand(reader: SessionReader, reference: number, depth: number, count: number, indent: string, lines: string[], budget: ReadBudget): Promise<void> {
	const body = await budget.request(reader, "variables", { variablesReference: reference, count });
	const variables = array(isRecord(body) ? body.variables : undefined);
	const shown = variables.slice(0, count);
	for (const variable of shown) {
		const child = typeof variable.variablesReference === "number" ? variable.variablesReference : 0;
		const type = typeof variable.type === "string" && variable.type !== "" ? ` (${variable.type})` : "";
		const marker = child > 0 && depth <= 1 ? ` [variables ${variableRef(reader.generation, child)}]` : "";
		lines.push(`${indent}${String(variable.name ?? "?")}: ${shorten(String(variable.value ?? ""))}${type}${marker}`);
		if (child > 0 && depth > 1) {
			try {
				await expand(reader, child, depth - 1, count, `${indent}  `, lines, budget);
			} catch (error) {
				if (!(error instanceof BudgetExceeded)) throw error;
				lines.push(`${indent}  ... [variables ${variableRef(reader.generation, child)}] (inspection limit reached)`);
				throw error;
			}
		}
	}
	if (variables.length > shown.length) lines.push(`${indent}... ${variables.length - shown.length} more not shown (use a smaller scope or count)`);
}

async function variablesView(reader: SessionReader, args: Args, budget: ReadBudget): Promise<HostToolResult> {
	const reference = parseRef(args.requiredString("ref"), "v", reader);
	const depth = args.integer("depth", 1, 3) ?? 1;
	const count = args.integer("count", 1, 200) ?? 50;
	const lines: string[] = [];
	let truncated = false;
	try {
		await expand(reader, reference, depth, count, "", lines, budget);
	} catch (error) {
		if (!(error instanceof BudgetExceeded)) throw error;
		truncated = true;
	}
	return textResult(`Variables (generation ${reader.generation}${truncated ? ", partial: the inspection limit for one call was reached" : ""}):\n${lines.join("\n") || "(none)"}`, { what: "variables", generation: reader.generation, truncated, lines: lines.length });
}

export function inspectTool(env: DebugToolEnv): HostToolDefinition {
	return {
		name: "vscode_debug_inspect",
		label: "Debug inspect",
		description: "Read a debug session's threads, stack, scopes and variables, or evaluate an expression. Use after a stop (vscode_debug_wait). `what`: threads; stack (threadId optional, defaults to the stopped thread; returns frame references); scopes (needs frameRef from stack); variables (needs ref from scopes or an earlier variables result; depth up to 3, count up to 200); evaluate (expression, optional frameRef; runs code in the debuggee, needs the user's permission and a session you started). References belong to one stop: after the program runs they fail and you must read the stack again. Frames without a local source file say the source is not available.",
		parameters: {
			type: "object",
			properties: {
				sessionId: { type: "string", description: "Debug session id from vscode_debug_configs or vscode_debug_start." },
				what: { type: "string", enum: [...WHAT] },
				threadId: { type: "integer", description: "Thread id (stack)." },
				startFrame: { type: "integer", minimum: 0, description: "First frame (stack)." },
				levels: { type: "integer", minimum: 1, maximum: 50, description: "Frame count (stack), default 20, at most 50; page with startFrame." },
				frameRef: { type: "string", description: "Frame reference from stack (scopes, evaluate)." },
				ref: { type: "string", description: "Variables reference from scopes or variables." },
				depth: { type: "integer", minimum: 1, maximum: 3, description: "Nesting depth (variables), default 1." },
				count: { type: "integer", minimum: 1, maximum: 200, description: "Variables per level, default 50." },
				expression: { type: "string", description: "Expression to evaluate (evaluate)." },
				context: { type: "string", enum: [...EVALUATE_CONTEXTS], description: "Evaluate context, default watch." },
			},
			required: ["sessionId", "what"],
			additionalProperties: false,
		},
		loadMode: "discoverable",
		async execute(raw, ctx) {
			const requested = isRecord(raw) && typeof raw.sessionId === "string" ? raw.sessionId : undefined;
			return await guarded(() => (requested !== undefined ? env.coordinator.session(requested)?.type : undefined), async () => {
				const args = new Args(raw);
				const sessionId = args.requiredString("sessionId");
				const what = args.requiredOneOf("what", WHAT);
				admit(env, ctx);
				if (what === "evaluate") return await evaluate(env, args, sessionId, ctx);
				const reader = env.coordinator.reader(sessionId, ctx.signal, { requireStopped: what !== "threads" });
				const state = env.coordinator.session(sessionId)!.state;
				const budget = new ReadBudget();
				switch (what) {
					case "threads": return await threadsView(reader, state, budget);
					case "stack": return await stackView(reader, state, args, budget);
					case "scopes": return await scopesView(reader, args, budget);
					case "variables": return await variablesView(reader, args, budget);
				}
			});
		},
	};
}

async function evaluate(env: DebugToolEnv, args: Args, sessionId: string, ctx: HostToolContext): Promise<HostToolResult> {
	const expression = args.requiredString("expression");
	const frameText = args.string("frameRef");
	const evalContext = args.oneOf("context", EVALUATE_CONTEXTS) ?? "watch";
	requireGrant(env, ctx, sessionId);
	const first = env.coordinator.reader(sessionId, ctx.signal, { requireStopped: true });
	const view = env.coordinator.session(sessionId)!;
	const denial = await expressionDenial(env, ctx, [`Debug session: ${view.type} "${view.name}" (${sessionId})`, `Expression: ${expression}`]);
	if (denial) return errorResult(denial);
	// The user may have continued the program while the confirmation was open.
	first.assertFresh();
	return await env.coordinator.mutate(sessionId, ctx.signal, async () => {
		admit(env, ctx);
		requireGrant(env, ctx, sessionId);
		first.assertFresh();
		const current = env.coordinator.session(sessionId)!;
		if (current.state.kind !== "stopped") throw new SessionNotStoppedError(sessionId, current.state);
		const budget = new ReadBudget();
		let frameId: number | undefined;
		if (frameText !== undefined) {
			frameId = parseRef(frameText, "f", first);
		} else {
			const threadId = await resolveThread(first, current.state, undefined, budget);
			const stack = await budget.request(first, "stackTrace", { threadId, startFrame: 0, levels: 1 });
			const top = array(isRecord(stack) ? stack.stackFrames : undefined)[0];
			if (top && typeof top.id === "number") frameId = top.id;
		}
		admit(env, ctx);
		const body = await budget.request(first, "evaluate", { expression, context: evalContext, ...(frameId !== undefined ? { frameId } : {}) });
		const result = isRecord(body) ? body : {};
		const child = typeof result.variablesReference === "number" && result.variablesReference > 0 ? ` [variables ${variableRef(first.generation, result.variablesReference)}]` : "";
		const type = typeof result.type === "string" && result.type !== "" ? ` (${result.type})` : "";
		return textResult(`${expression} = ${shorten(String(result.result ?? ""), 4000)}${type}${child}\nGeneration ${first.generation}.`, { what: "evaluate", generation: first.generation, expression });
	});
}
