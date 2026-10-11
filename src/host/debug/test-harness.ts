import type { AgentDebuggerParts } from "./assemble.ts";
import { assembleAgentDebugger } from "./assemble.ts";
import type { DebugLimits } from "./coordinator.ts";
import { FakeDebugApi } from "./fake-debug-api.ts";
import type { ConsentRequest, DebugPolicy, DebugPreset, ExpressionMode, StartMode } from "./policy.ts";
import type { HostToolContext, HostToolDefinition, HostToolResult } from "../tools/host-tool.ts";
import { HostToolRefusal } from "../tools/host-tool.ts";

/** A policy tests can change at any time; `confirm` answers from a queue or an injected function. */
export class FakePolicy implements DebugPolicy {
	isEnabled = true;
	start: StartMode = "allow";
	expressions: ExpressionMode = "allow";
	readonly confirmations: ConsentRequest[] = [];
	answer: (request: ConsentRequest) => Promise<boolean> = async () => true;

	enabled(): boolean { return this.isEnabled; }
	startMode(): StartMode { return this.start; }
	expressionsMode(): ExpressionMode { return this.expressions; }
	async confirm(request: ConsentRequest): Promise<boolean> {
		this.confirmations.push(request);
		return await this.answer(request);
	}
}

export interface Harness {
	readonly api: FakeDebugApi;
	readonly policy: FakePolicy;
	readonly parts: AgentDebuggerParts;
	tool(name: string): HostToolDefinition;
	/** Runs a tool as one conversation. */
	call(name: string, args: unknown, options?: CallOptions): Promise<HostToolResult>;
	context(options?: CallOptions): HostToolContext;
	dispose(): void;
}

export interface CallOptions {
	readonly conversationId?: string;
	readonly signal?: AbortSignal;
	/** Throws from `checkExecutor` once this returns true. */
	readonly gateLost?: () => boolean;
	readonly updates?: HostToolResult[];
}

export const FAST_LIMITS: Partial<DebugLimits> = { requestTimeoutMs: 150, transitionTimeoutMs: 250, launchTimeoutMs: 400, markerGraceMs: 80 };

export function createHarness(options: { limits?: Partial<DebugLimits>; presets?: DebugPreset[]; beforeCoordinator?: (api: FakeDebugApi) => void } = {}): Harness {
	const api = new FakeDebugApi();
	options.beforeCoordinator?.(api);
	const policy = new FakePolicy();
	const parts = assembleAgentDebugger(api, policy, () => options.presets ?? [], { breakpointSettleMs: 0, waitTickMs: 40 });
	// The coordinator reads its limits at construction; tests that need short timeouts replace the instance's limits.
	Object.assign(parts.coordinator.limits, FAST_LIMITS, options.limits);
	const tools = parts.provider.tools();
	const find = (name: string): HostToolDefinition => {
		const tool = tools.find(candidate => candidate.name === name);
		if (!tool) throw new Error(`no tool ${name}`);
		return tool;
	};
	const context = (call: CallOptions = {}): HostToolContext => ({
		signal: call.signal ?? new AbortController().signal,
		update: partial => { call.updates?.push(partial); },
		checkExecutor: () => {
			if (call.gateLost?.()) throw new GateLost();
		},
		conversationId: call.conversationId ?? "conv-1",
	});
	return {
		api,
		policy,
		parts,
		tool: find,
		call: (name, args, call) => find(name).execute(args, context(call)),
		context,
		dispose: () => parts.dispose(),
	};
}

/** What the real `checkExecutor` throws: a refusal that is not an expected failure of a debugger operation. */
export class GateLost extends HostToolRefusal {
	constructor() {
		super("The executor gate no longer admits this call.");
	}
}

export function text(result: HostToolResult): string {
	return result.content.map(part => part.text).join("\n");
}

export function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}
