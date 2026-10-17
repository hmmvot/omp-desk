/**
 * In-memory `RpcChannel` with a scripted rpc-ui child, for `RpcSession` tests (and any slice that needs a channel
 * without a broker). Not imported by production code.
 *
 * It models what the broker gives a client: a per-child line `seq`, a retained ring replayed after `attach`
 * (responses are not retained, except small `vsc:` ones, exactly like the broker), and live delivery afterwards.
 * The scripted child answers the commands `RpcSession` sends from its own `entries`/`state`.
 */
import type {
	RpcAttachResult,
	RpcChannel,
	RpcChannelEvent,
	RpcChildStatus,
	RpcWriteErrorCode,
} from "../../protocol/rpc.ts";
import type { RunningAgent } from "../../chat/agents.ts";
import type { TodoPhase } from "../../chat/todos.ts";
import { isRecord } from "../../shared/guards.ts";

export const READY_LINE = JSON.stringify({
	type: "ready",
	protocolVersion: 1,
	supportedProtocolVersions: [1, 2],
	maxFrameBytes: 1048576,
	maxReassembledFrameBytes: 67108864,
});

export interface FakeChildModel {
	sessionFile: string | null;
	sessionId: string;
	/** Durable entries in file order (what `get_entries` serves). */
	entries: Record<string, unknown>[];
	leafId: string | null;
	isStreaming: boolean;
	model: Record<string, unknown> | null;
	thinkingLevel: string | undefined;
	todoPhases: readonly TodoPhase[];
	subagents: readonly RunningAgent[];
	/** What `get_state` reports as context usage; omitted from the answer while undefined. */
	contextUsage?: { tokens: number | null; contextWindow: number | null; percent: number | null };
}

export type CommandHandler = (command: Record<string, unknown>) => Record<string, unknown> | "drop" | undefined;

export function responseLine(id: string | undefined, command: string, success: boolean, rest: Record<string, unknown>): string {
	return JSON.stringify({ ...(id === undefined ? {} : { id }), type: "response", command, success, ...rest });
}

export class FakeRpcChannel implements RpcChannel {
	readonly child: FakeChildModel;
	/** Every parsed stdin line the session wrote, in order (commands and `extension_ui_response`). */
	readonly written: Record<string, unknown>[] = [];
	readonly attachRequests: number[] = [];
	readonly handlers = new Map<string, CommandHandler>();
	ready: string | null = READY_LINE;
	rpcProtocol: 1 | 2 | null = 2;
	/** The broker has seen `ready` and awaits the child's answer to its protocol negotiation. */
	negotiating = false;
	childState: RpcChildStatus["state"] = "running";
	childExitCode = 0;
	childStderrTail: string | undefined;
	writeError: RpcWriteErrorCode | null = null;
	attachError = false;
	autoRespond = true;
	disconnects = 0;
	/** The attach answer's `hostToolRetention`: `false` models a broker from an earlier build. */
	hostToolRetention = true;
	hostCallOverflow = false;
	/** Whether `attach` wins the broker's input claim; `false` models a window that attaches while another one holds input. */
	inputClaimable = true;
	/** What `set_host_tools` answers: the requested names, or a rejection (script a timeout with `handlers.set("set_host_tools", () => "drop")`). */
	hostToolsAnswer: "names" | "reject" = "names";
	#owned = true;
	#ownerGeneration = 0;
	#seq = 0;
	#ring: { seq: number; line: string }[] = [];
	#listeners = new Set<(event: RpcChannelEvent) => void>();
	#attached = false;

	constructor(child: Partial<FakeChildModel> = {}) {
		this.child = {
			sessionFile: null,
			sessionId: "sess-1",
			entries: [],
			leafId: null,
			isStreaming: false,
			model: { provider: "p", id: "m", name: "M", contextWindow: 1000 },
			thinkingLevel: "off",
			todoPhases: [],
			subagents: [],
			...child,
		};
	}

	get lastSeq(): number {
		return this.#seq;
	}

	get inputOwned(): boolean {
		return this.#owned;
	}

	get ownerGeneration(): number {
		return this.#ownerGeneration;
	}

	/** Change input ownership as the broker would report it (takeover by another window, release, loss). */
	setOwned(owned: boolean): void {
		if (owned === this.#owned) return;
		this.#owned = owned;
		this.#ownerGeneration += 1;
		this.#deliver({ type: "input-owner", owned, generation: this.#ownerGeneration });
	}

	onEvent(listener: (event: RpcChannelEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	disconnect(): void {
		this.disconnects += 1;
		this.#attached = false;
		this.setOwned(false);
	}

	async attach(request: { sinceSeq: number }): Promise<RpcAttachResult> {
		this.attachRequests.push(request.sinceSeq);
		if (this.attachError) throw new Error("attach refused");
		this.#attached = true;
		this.setOwned(this.inputClaimable);
		const replay = this.#ring.filter(line => line.seq > request.sinceSeq);
		const result: RpcAttachResult = {
			fromSeq: request.sinceSeq,
			oldestSeq: this.#ring[0]?.seq ?? this.#seq,
			latestSeq: this.#seq,
			truncated: false,
			pinnedOverflow: false,
			hostToolRetention: this.hostToolRetention,
			hostCallOverflow: this.hostCallOverflow,
			rpcProtocol: this.rpcProtocol,
			ready: this.ready,
			negotiating: this.negotiating,
			child: { state: this.childState, pid: 1234, exitCode: this.childState === "exited" ? this.childExitCode : null, ...(this.childStderrTail === undefined ? {} : { stderrTail: this.childStderrTail }) },
		};
		queueMicrotask(() => {
			for (const line of replay) this.#deliver({ type: "line", seq: line.seq, line: line.line });
		});
		return result;
	}

	async writeLine(line: string): Promise<void> {
		if (this.writeError !== null) {
			if (this.writeError === "input-not-owner") this.setOwned(false);
			throw Object.assign(new Error("write refused"), { code: this.writeError });
		}
		const parsed: unknown = JSON.parse(line);
		const command = parsed as Record<string, unknown>;
		// The broker refuses every stdin write from a window without the claim. Only the writes host tools make are
		// refused here, so a test can keep an otherwise ordinary session running on a window that lost input.
		if (!this.#owned && (command.type === "set_host_tools" || command.type === "host_tool_result" || command.type === "host_tool_update")) {
			throw Object.assign(new Error("write refused"), { code: "input-not-owner" });
		}
		this.written.push(command);
		// The broker stops replaying a host call once its result is written (or OMP cancels it).
		if (command.type === "host_tool_result" && typeof command.id === "string") this.#releaseHostCall(command.id);
		if (!this.autoRespond || command.type === "extension_ui_response" || command.type === "host_tool_result" || command.type === "host_tool_update") return;
		queueMicrotask(() => this.#answer(command));
	}

	/** Push one stdout line: retained in the ring (unless a response) and delivered live when attached. */
	emit(frame: Record<string, unknown> | string): number {
		const line = typeof frame === "string" ? frame : JSON.stringify(frame);
		this.#seq += 1;
		const seq = this.#seq;
		const isResponse = line.includes('"type":"response"');
		const retained = !isResponse || (line.includes('"id":"vsc:') && line.length <= 4096);
		if (retained) this.#ring.push({ seq, line });
		if (typeof frame !== "string" && frame.type === "host_tool_cancel" && typeof frame.targetId === "string") this.#releaseHostCall(frame.targetId);
		if (this.#attached) this.#deliver({ type: "line", seq, line });
		return seq;
	}

	/** OMP asks the host to run a registered tool. */
	emitHostCall(id: string, toolName: string, args: Record<string, unknown> = {}): number {
		return this.emit({ type: "host_tool_call", id, toolCallId: `tc-${id}`, toolName, arguments: args });
	}

	/** OMP aborts a pending host call. */
	emitHostCancel(targetId: string): number {
		return this.emit({ type: "host_tool_cancel", id: `cancel-${targetId}`, targetId });
	}

	#releaseHostCall(id: string): void {
		const at = this.#ring.findIndex(line => line.line.includes('"type":"host_tool_call"') && line.line.includes(`"id":"${id}"`));
		if (at >= 0) this.#ring.splice(at, 1);
	}

	/** Deliver the child's `ready` after the attach answered (the broker's late `rpc-ready`), outside the line ring. */
	emitLateReady(rpcProtocol: 1 | 2 | null = this.rpcProtocol): void {
		this.rpcProtocol = rpcProtocol;
		if (this.#attached) this.#deliver({ type: "ready", line: this.ready ?? READY_LINE, rpcProtocol });
	}

	/** Emit a message lifecycle frame with the process-local `messageId` last, as OMP does. */
	emitMessage(type: "message_start" | "message_update" | "message_end", messageId: string, message: Record<string, unknown>): number {
		return this.emit(`{"type":"${type}","message":${JSON.stringify(message)},"messageId":"${messageId}"}`);
	}

	closeLink(reason: "child-exited" | "disconnected" | "stopped"): void {
		this.#attached = false;
		this.#deliver({ type: "closed", reason });
	}

	exitChild(exitCode = 0, stderrTail?: string): void {
		this.childState = "exited";
		this.childExitCode = exitCode;
		this.childStderrTail = stderrTail;
		this.#deliver({ type: "child", status: { state: "exited", pid: 1234, exitCode, ...(stderrTail === undefined ? {} : { stderrTail }) } });
	}

	commandsOfType(type: string): Record<string, unknown>[] {
		return this.written.filter(command => command.type === type);
	}

	#deliver(event: RpcChannelEvent): void {
		for (const listener of [...this.#listeners]) listener(event);
	}

	#answer(command: Record<string, unknown>): void {
		const type = command.type as string;
		const id = typeof command.id === "string" ? command.id : undefined;
		const custom = this.handlers.get(type)?.(command);
		if (custom === "drop") return;
		const rest = custom ?? this.#defaultResponse(command);
		this.emit(responseLine(id, type, (rest.success as boolean | undefined) !== false, stripSuccess(rest)));
	}

	#defaultResponse(command: Record<string, unknown>): Record<string, unknown> {
		switch (command.type) {
			case "set_host_tools": {
				if (this.hostToolsAnswer === "reject") return { success: false, error: "host tools refused" };
				const tools = Array.isArray(command.tools) ? command.tools : [];
				return { data: { toolNames: tools.map(tool => (isRecord(tool) ? String(tool.name) : "")) } };
			}
			case "set_subagent_subscription":
				return {};
			case "get_subagents":
				return { data: { subagents: this.child.subagents } };
			case "get_state":
				return {
					data: {
						model: this.child.model ?? undefined,
						thinkingLevel: this.child.thinkingLevel,
						isStreaming: this.child.isStreaming,
						isCompacting: false,
						sessionFile: this.child.sessionFile ?? undefined,
						sessionId: this.child.sessionId,
						queuedMessageCount: 0,
						messageCount: this.child.entries.length,
						isSettled: !this.child.isStreaming,
						todoPhases: this.child.todoPhases,
						...(this.child.contextUsage === undefined ? {} : { contextUsage: this.child.contextUsage }),
					},
				};
			case "get_entries": {
				const since = command.since;
				if (typeof since === "string") {
					const at = this.child.entries.findIndex(entry => entry.id === since);
					if (at < 0) return { success: false, error: "unknown cursor", code: "unknown_since" };
					return { data: { entries: this.child.entries.slice(at + 1), leafId: this.child.leafId } };
				}
				return { data: { entries: this.child.entries, leafId: this.child.leafId } };
			}
			case "prompt":
				return { data: { agentInvoked: true } };
			case "set_model":
				return { data: { provider: command.provider, id: command.modelId, name: String(command.modelId), contextWindow: 2000 } };
			case "get_available_models":
				return { data: { models: [{ provider: "p", id: "m", name: "M", contextWindow: 1000 }] } };
			case "get_available_thinking_levels":
				return { data: { levels: ["off", "low", "high"] } };
			default:
				return {};
		}
	}
}

function stripSuccess(rest: Record<string, unknown>): Record<string, unknown> {
	const { success: _success, ...others } = rest;
	return others;
}
