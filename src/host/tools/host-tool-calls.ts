/**
 * The host tool call ledger of one `RpcSession` ([ADR-0055](../../../docs/decisions/0055-expose-vscode-capabilities-as-rpc-host-tools-run-by-the-owning-window.md),
 * design section 1).
 *
 * OMP sends `host_tool_call { id, toolName, arguments }` and waits, without a timeout, for one `host_tool_result` with
 * that id (or cancels it with `host_tool_cancel`). This class decides whether the session may run a call and makes
 * sure every admitted call that OMP does not cancel produces exactly one result:
 *
 * - **Executor gate.** A call runs only while the session has finished its resync (verified identity), holds broker
 *   input on its current connection, has not diverged and still has the tool registered and enabled. A call that
 *   arrives while another window holds input is *not* answered (a read-only subscriber neither executes nor
 *   answers); it is kept as `unadmitted` and answered with the earlier-attachment error only if this session later
 *   holds the gate.
 * - **States** per call id: `buffered` (arrived before the resync finished), `queued`, `running`, `completed` (the
 *   result is not yet accepted by the broker), `delivered`, `cancelled` (by OMP).
 * - **Replay boundary.** A call at or before the `latestSeq` of the attach it arrived under was not seen live: it is
 *   answered with an error and never executed.
 * - **Two cancellations.** OMP's cancel is terminal: the call never starts or its signal aborts, updates stop, an
 *   undelivered result is retired, nothing is answered. Local cancellation (gate loss, disabled tools, a new
 *   attachment) leaves OMP waiting, so the call gets one terminal error result that stays in the outbox until the
 *   broker accepts it, OMP cancels, or the child exits.
 * - **Outbox.** A completed result is re-sent after every reconnect, once the gate holds, until `writeLine` resolves.
 *   OMP ignores a result for an id it no longer waits for, so a duplicate is harmless. Nothing is ever re-run.
 */

import { isRecord } from "../../shared/guards.ts";
import type { Logger } from "../../shared/logger.ts";
import { writeErrorCode } from "../../protocol/rpc.ts";
import { HostToolRefusal, type HostToolContext, type HostToolDefinition, type HostToolResult } from "./host-tool.ts";

export const HOST_TOOL_EARLIER_ATTACHMENT_ERROR =
	"This request was received from an earlier attachment; Desk did not execute or re-execute it.";

export type HostToolCallState = "buffered" | "queued" | "running" | "completed" | "delivered" | "cancelled";

/** Calls running at once; the rest wait in `queued`. */
export const HOST_TOOL_MAX_RUNNING = 8;
/** After a local cancellation, how long a running tool may take to settle before Desk answers for it. */
export const HOST_TOOL_LOCAL_CANCEL_GRACE_MS = 5_000;
/** Undelivered results above this are logged (a soft threshold; none is evicted). */
export const HOST_TOOL_OUTBOX_WARN = 32;
/** Delivered and OMP-cancelled ids kept only to ignore a replayed call. */
export const HOST_TOOL_CLOSED_CACHE = 256;
/** Calls seen while another window held input, kept to be answered if this session later holds the gate. */
const UNADMITTED_CACHE = 256;
/** Text of one result or update above this many UTF-8 bytes is cut (a result line must fit the broker's write bound). */
export const HOST_TOOL_MAX_RESULT_BYTES = 512 * 1024;
const MAX_DETAILS_BYTES = 128 * 1024;

export interface HostToolTimers {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface HostToolCallPorts {
	/** The calling Chat's identity (its bound session file); read when a call starts. */
	conversationId(): string;
	/** Write one whole stdin line; rejects with an error whose `code` is an `RpcWriteErrorCode`. */
	writeLine(line: string): Promise<void>;
	/** Whether this session holds broker input on its current connection, and the generation of that fact. */
	inputOwned(): boolean;
	ownerGeneration(): number;
	/** The tools the settings allow right now. */
	tools(): readonly HostToolDefinition[];
	readonly timers: HostToolTimers;
	readonly log: Logger;
	readonly maxRunning?: number;
	readonly localCancelGraceMs?: number;
}

interface Call {
	readonly id: string;
	readonly toolName: string;
	readonly args: unknown;
	readonly seq: number;
	state: HostToolCallState;
	readonly controller: AbortController;
	tool: HostToolDefinition | null;
	admission: { readonly owner: number; readonly attach: number } | null;
	slot: boolean;
	localReason: string | null;
	graceTimer: unknown;
	/** The encoded `host_tool_result` line while `completed`. */
	line: string | null;
	update: { sending: boolean; pending: string | null };
}

type Outcome = { readonly kind: "result"; readonly result: HostToolResult } | { readonly kind: "threw"; readonly error: unknown } | { readonly kind: "timeout" };

const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");

export class HostToolCalls {
	readonly #ports: HostToolCallPorts;
	readonly #calls = new Map<string, Call>();
	readonly #closedIds: string[] = [];
	readonly #unadmitted = new Map<string, number>();
	readonly #queue: Call[] = [];
	#running = 0;
	#boundary = 0;
	#attachGeneration = 0;
	#ready = false;
	#diverged = false;
	#ended = false;
	#registered: ReadonlySet<string> = new Set();
	#flushing: Promise<void> | null = null;
	#flushAgain = false;
	#overflowLogged = false;
	#malformed = 0;

	constructor(ports: HostToolCallPorts) {
		this.#ports = ports;
	}

	/** The state of one call id (`unadmitted` for a call this session saw while it was read-only); `undefined` when unknown. */
	stateOf(id: string): HostToolCallState | "unadmitted" | undefined {
		return this.#calls.get(id)?.state ?? (this.#unadmitted.has(id) ? "unadmitted" : undefined);
	}

	/** The call lines that were not a call (no string id). */
	get malformedCount(): number {
		return this.#malformed;
	}

	/** Results written to nobody yet. */
	get outstandingResults(): number {
		let count = 0;
		for (const call of this.#calls.values()) if (call.state === "completed") count += 1;
		return count;
	}

	/** The tool names the child confirmed; only these may run. */
	setRegistered(names: ReadonlySet<string>): void {
		this.#registered = names;
	}

	/** Settings removed tools: calls of a tool that is no longer allowed stop (locally cancelled), and the registered set shrinks. */
	retract(allowed: ReadonlySet<string>): void {
		const kept = new Set<string>();
		for (const name of this.#registered) if (allowed.has(name)) kept.add(name);
		this.#registered = kept;
		for (const call of [...this.#calls.values()]) {
			if ((call.state === "queued" || call.state === "running") && !allowed.has(call.toolName)) {
				this.#cancelLocally(call, "the tool was disabled");
			}
		}
	}

	/** A (re)attach was answered: calls up to `latestSeq` were not seen live, and nothing admitted earlier may continue. */
	attached(latestSeq: number): void {
		this.#attachGeneration += 1;
		this.#boundary = latestSeq;
		this.closeGate("this window attached to the session again");
	}

	/** The resync verified the identity: buffered calls are decided in arrival order, the outbox is delivered. */
	open(): void {
		if (this.#ended || this.#diverged) return;
		this.#ready = true;
		this.#decideBuffered();
		this.#answerUnadmitted();
		this.#flush();
	}

	/** The session left the verified state (new attachment, failure): admitted calls stop locally, the outbox stays. */
	closeGate(reason: string): void {
		this.#ready = false;
		this.#cancelAllLocally(reason);
	}

	/** The conversation's identity diverged: nothing runs on this session again. */
	diverged(): void {
		this.#diverged = true;
		this.closeGate("the conversation's identity changed");
	}

	/** Broker input changed owner: losing it stops admitted calls; regaining it delivers what is owed. */
	ownerChanged(): void {
		if (this.#ended) return;
		if (!this.#ports.inputOwned()) {
			this.#cancelAllLocally("another window took over this session or released it");
			return;
		}
		if (!this.#ready || this.#diverged) return;
		this.#answerUnadmitted();
		this.#flush();
	}

	/** The child exited: OMP waits for nobody, so every call stops and nothing is delivered. */
	childExited(): void {
		if (this.#ended) return;
		this.#ended = true;
		for (const call of this.#calls.values()) {
			this.#clearGrace(call);
			if (call.state === "queued" || call.state === "running") call.controller.abort(new HostToolRefusal("the OMP process exited"));
			call.line = null;
		}
		this.#queue.length = 0;
		this.#unadmitted.clear();
		this.#calls.clear();
		this.#closedIds.length = 0;
		this.#running = 0;
	}

	/** This window stops serving the session: running tools abort; their results cannot be delivered from here. */
	dispose(): void {
		if (this.#ended) return;
		this.#ready = false;
		this.#ended = true;
		for (const call of this.#calls.values()) {
			this.#clearGrace(call);
			if (call.state === "queued" || call.state === "running") call.controller.abort(new HostToolRefusal("this window stopped serving the session"));
		}
		this.#queue.length = 0;
	}

	/** `host_tool_call` from OMP, folded at line `seq`. */
	onCall(frame: Record<string, unknown>, seq: number): void {
		const id = frame.id;
		if (typeof id !== "string" || id.length === 0) {
			this.#malformed += 1;
			return;
		}
		if (this.#ended || this.#diverged || this.#calls.has(id) || this.#unadmitted.has(id)) return;
		const call: Call = {
			id,
			toolName: typeof frame.toolName === "string" ? frame.toolName : "",
			args: frame.arguments,
			seq,
			state: "buffered",
			controller: new AbortController(),
			tool: null,
			admission: null,
			slot: false,
			localReason: null,
			graceTimer: null,
			line: null,
			update: { sending: false, pending: null },
		};
		if (!this.#ready) {
			this.#calls.set(id, call);
			return;
		}
		this.#admit(call);
	}

	/** `host_tool_cancel` from OMP: terminal for a known call, nothing to answer. */
	onCancel(frame: Record<string, unknown>): void {
		const targetId = frame.targetId;
		if (typeof targetId !== "string") return;
		if (this.#unadmitted.delete(targetId)) return;
		const call = this.#calls.get(targetId);
		if (call === undefined) return;
		switch (call.state) {
			case "buffered":
				this.#retire(call);
				return;
			case "queued": {
				const at = this.#queue.indexOf(call);
				if (at >= 0) this.#queue.splice(at, 1);
				this.#retire(call);
				return;
			}
			case "running":
				call.controller.abort(new HostToolRefusal("OMP cancelled this tool call"));
				this.#retire(call);
				this.#pump();
				return;
			case "completed":
				this.#retire(call);
				return;
			default:
				return;
		}
	}

	#gateHolds(): boolean {
		return this.#ready && !this.#diverged && !this.#ended && this.#ports.inputOwned();
	}

	#decideBuffered(): void {
		const buffered = [...this.#calls.values()].filter(call => call.state === "buffered");
		for (const call of buffered) {
			this.#calls.delete(call.id);
			this.#admit(call);
		}
	}

	#admit(call: Call): void {
		if (!this.#gateHolds()) {
			// Another window holds input (or the session is not serving): not ours to execute or answer.
			this.#calls.delete(call.id);
			this.#unadmitted.set(call.id, call.seq);
			while (this.#unadmitted.size > UNADMITTED_CACHE) {
				const oldest = this.#unadmitted.keys().next();
				if (oldest.done === true) break;
				this.#unadmitted.delete(oldest.value);
			}
			return;
		}
		if (call.seq <= this.#boundary) {
			this.#refuse(call, HOST_TOOL_EARLIER_ATTACHMENT_ERROR);
			return;
		}
		const tool = this.#toolFor(call.toolName);
		if (typeof tool === "string") {
			this.#refuse(call, tool);
			return;
		}
		call.tool = tool;
		call.admission = { owner: this.#ports.ownerGeneration(), attach: this.#attachGeneration };
		call.state = "queued";
		this.#calls.set(call.id, call);
		this.#queue.push(call);
		this.#pump();
	}

	/** The definition of an allowed, registered tool, or the sentence refusing the call. */
	#toolFor(name: string): HostToolDefinition | string {
		const tool = this.#ports.tools().find(candidate => candidate.name === name);
		if (tool !== undefined && this.#registered.has(name)) return tool;
		return `Desk's host tool "${name}" is not available in this session: it is disabled, or Desk could not register it with OMP. Nothing was executed.`;
	}

	#refuse(call: Call, text: string): void {
		this.#calls.set(call.id, call);
		this.#finalize(call, errorResult(text));
	}

	#answerUnadmitted(): void {
		if (this.#unadmitted.size === 0 || !this.#gateHolds()) return;
		const pending = [...this.#unadmitted];
		this.#unadmitted.clear();
		for (const [id, seq] of pending) {
			const call = this.#newOwed(id, seq);
			this.#calls.set(id, call);
			this.#finalize(call, errorResult(HOST_TOOL_EARLIER_ATTACHMENT_ERROR));
		}
	}

	#newOwed(id: string, seq: number): Call {
		return {
			id,
			toolName: "",
			args: undefined,
			seq,
			state: "buffered",
			controller: new AbortController(),
			tool: null,
			admission: null,
			slot: false,
			localReason: null,
			graceTimer: null,
			line: null,
			update: { sending: false, pending: null },
		};
	}

	#pump(): void {
		const limit = this.#ports.maxRunning ?? HOST_TOOL_MAX_RUNNING;
		while (this.#running < limit) {
			const call = this.#queue.shift();
			if (call === undefined) return;
			if (call.state !== "queued") continue;
			if (!this.#stillAdmitted(call)) {
				this.#finalize(call, errorResult("Desk stopped this tool call before it started: the session or its settings changed while it waited. Nothing was executed."));
				continue;
			}
			this.#start(call);
		}
	}

	#stillAdmitted(call: Call): boolean {
		return (
			this.#gateHolds() &&
			call.admission !== null &&
			call.admission.owner === this.#ports.ownerGeneration() &&
			call.admission.attach === this.#attachGeneration &&
			this.#registered.has(call.toolName) &&
			this.#ports.tools().some(tool => tool.name === call.toolName)
		);
	}

	#start(call: Call): void {
		const tool = call.tool;
		if (tool === null) return;
		call.state = "running";
		call.slot = true;
		this.#running += 1;
		const context: HostToolContext = {
			signal: call.controller.signal,
			conversationId: this.#ports.conversationId(),
			update: partial => this.#sendUpdate(call, partial),
			checkExecutor: () => this.#checkExecutor(call),
		};
		void (async (): Promise<void> => {
			let outcome: Outcome;
			try {
				this.#checkExecutor(call);
				outcome = { kind: "result", result: await tool.execute(call.args, context) };
			} catch (error) {
				outcome = { kind: "threw", error };
			}
			this.#settle(call, outcome);
		})();
	}

	#checkExecutor(call: Call): void {
		if (call.state !== "running") throw new HostToolRefusal("This tool call is no longer running.");
		if (call.localReason !== null) throw new HostToolRefusal(`Desk stopped this tool call: ${call.localReason}.`);
		if (call.controller.signal.aborted) throw new HostToolRefusal("This tool call was cancelled.");
		if (!this.#gateHolds()) throw new HostToolRefusal("This window no longer holds the session's input or the session is not ready; the call was not continued.");
		const admission = call.admission;
		if (admission === null || admission.owner !== this.#ports.ownerGeneration() || admission.attach !== this.#attachGeneration) {
			throw new HostToolRefusal("This window lost and regained the session's input; the call was not continued.");
		}
		if (!this.#registered.has(call.toolName) || !this.#ports.tools().some(tool => tool.name === call.toolName)) {
			throw new HostToolRefusal(`Desk's host tool "${call.toolName}" was disabled; the call was not continued.`);
		}
	}

	#settle(call: Call, outcome: Outcome): void {
		if (call.state !== "running") return;
		this.#clearGrace(call);
		if (call.localReason !== null) {
			this.#finalize(call, errorResult(localCancelText(call.localReason, outcome)));
			return;
		}
		if (outcome.kind === "timeout") return;
		if (outcome.kind === "threw") {
			this.#finalize(call, errorResult(thrownText(outcome.error)));
			return;
		}
		this.#finalize(call, outcome.result);
	}

	/** Turn the call's outcome into its one terminal result and try to deliver it. */
	#finalize(call: Call, result: unknown): void {
		const queued = this.#queue.indexOf(call);
		if (queued >= 0) this.#queue.splice(queued, 1);
		this.#releaseSlot(call);
		this.#clearGrace(call);
		call.line = encodeResult(call.id, result);
		call.state = "completed";
		const outstanding = this.outstandingResults;
		if (outstanding > HOST_TOOL_OUTBOX_WARN) {
			if (!this.#overflowLogged) this.#ports.log.warn(`${outstanding} host tool results are waiting for delivery (soft limit ${HOST_TOOL_OUTBOX_WARN}); none is dropped.`);
			this.#overflowLogged = true;
		} else this.#overflowLogged = false;
		this.#pump();
		this.#flush();
	}

	#cancelAllLocally(reason: string): void {
		for (const call of [...this.#calls.values()]) {
			if (call.state === "queued" || call.state === "running") this.#cancelLocally(call, reason);
		}
	}

	#cancelLocally(call: Call, reason: string): void {
		if (call.state === "queued") {
			this.#finalize(call, errorResult(`Desk stopped this tool call before it started: ${reason}. Nothing was executed.`));
			return;
		}
		if (call.state !== "running" || call.localReason !== null) return;
		call.localReason = reason;
		call.controller.abort(new HostToolRefusal(reason));
		// A tool that ignores its signal must not leave OMP waiting: Desk answers for it after a grace period.
		call.graceTimer = this.#ports.timers.setTimeout(() => {
			call.graceTimer = null;
			this.#settle(call, { kind: "timeout" });
		}, this.#ports.localCancelGraceMs ?? HOST_TOOL_LOCAL_CANCEL_GRACE_MS);
	}

	/** OMP cancelled the call (or it is otherwise over without an answer): it leaves every queue and keeps only its id. */
	#retire(call: Call): void {
		this.#releaseSlot(call);
		this.#clearGrace(call);
		call.line = null;
		call.state = "cancelled";
		call.update.pending = null;
		this.#remember(call);
	}

	#remember(call: Call): void {
		this.#closedIds.push(call.id);
		while (this.#closedIds.length > HOST_TOOL_CLOSED_CACHE) {
			const evicted = this.#closedIds.shift();
			if (evicted === undefined) break;
			const old = this.#calls.get(evicted);
			if (old !== undefined && (old.state === "delivered" || old.state === "cancelled")) this.#calls.delete(evicted);
		}
	}

	#releaseSlot(call: Call): void {
		if (!call.slot) return;
		call.slot = false;
		this.#running -= 1;
	}

	#clearGrace(call: Call): void {
		if (call.graceTimer === null) return;
		this.#ports.timers.clearTimeout(call.graceTimer);
		call.graceTimer = null;
	}

	/** Deliver completed results, oldest first, one at a time, while the gate holds. */
	#flush(): void {
		if (this.#flushing !== null) {
			this.#flushAgain = true;
			return;
		}
		this.#flushing = this.#deliver().finally(() => {
			this.#flushing = null;
			if (this.#flushAgain) {
				this.#flushAgain = false;
				this.#flush();
			}
		});
	}

	async #deliver(): Promise<void> {
		for (;;) {
			if (!this.#gateHolds()) return;
			let next: Call | undefined;
			for (const call of this.#calls.values()) {
				if (call.state === "completed") {
					next = call;
					break;
				}
			}
			if (next === undefined || next.line === null) return;
			try {
				await this.#ports.writeLine(next.line);
			} catch (error) {
				// Not accepted: it stays in the outbox. A closed connection or lost ownership delivers it after the
				// next resync; a dead child ends the wait for good.
				if (writeErrorCode(error) === "child-exited") this.childExited();
				return;
			}
			if (next.state === "completed") {
				next.line = null;
				next.state = "delivered";
				this.#remember(next);
			}
		}
	}

	#sendUpdate(call: Call, partial: HostToolResult): void {
		if (call.state !== "running" || call.localReason !== null || !this.#gateHolds()) return;
		const content = textContent(partial);
		if (content === null) return;
		const details = boundedDetails(partial.details);
		const line = JSON.stringify({
			type: "host_tool_update",
			id: call.id,
			partialResult: { content: capContent(content), ...(details === undefined ? {} : { details }) },
		});
		if (call.update.sending) {
			call.update.pending = line;
			return;
		}
		this.#writeUpdate(call, line);
	}

	#writeUpdate(call: Call, line: string): void {
		call.update.sending = true;
		this.#ports.writeLine(line).then(
			() => undefined,
			() => undefined,
		).finally(() => {
			call.update.sending = false;
			const pending = call.update.pending;
			call.update.pending = null;
			if (pending !== null && call.state === "running" && call.localReason === null && this.#gateHolds()) this.#writeUpdate(call, pending);
		});
	}
}

function errorResult(text: string): HostToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

function thrownText(error: unknown): string {
	if (error instanceof HostToolRefusal) return error.message;
	const message = error instanceof Error ? error.message : String(error);
	return `The Desk host tool failed: ${message}`;
}

function localCancelText(reason: string, outcome: Outcome): string {
	const head = `Desk stopped this tool call: ${reason}.`;
	if (outcome.kind === "result") {
		const text = textContent(outcome.result)?.map(block => block.text).join("\n") ?? "";
		return `${head} The tool had already produced a result, which Desk did not trust: ${text}`.trim();
	}
	if (outcome.kind === "threw" && outcome.error instanceof HostToolRefusal && outcome.error.message.length > 0 && outcome.error.message !== reason) {
		return `${head} ${outcome.error.message} A request the tool had already sent was not undone; its effect is unknown.`;
	}
	return `${head} A request the tool had already sent was not undone; its effect is unknown.`;
}

/** The text blocks of a well-formed tool result, or `null`. */
function textContent(result: unknown): { type: "text"; text: string }[] | null {
	if (!isRecord(result) || !Array.isArray(result.content)) return null;
	const blocks: { type: "text"; text: string }[] = [];
	for (const block of result.content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return null;
		blocks.push({ type: "text", text: block.text });
	}
	return blocks;
}

function capContent(blocks: readonly { type: "text"; text: string }[]): { type: "text"; text: string }[] {
	let budget = HOST_TOOL_MAX_RESULT_BYTES;
	const out: { type: "text"; text: string }[] = [];
	for (const block of blocks) {
		if (budget <= 0) break;
		const size = utf8(block.text);
		if (size <= budget) {
			out.push(block);
			budget -= size;
			continue;
		}
		const cut = Buffer.from(block.text, "utf8").subarray(0, budget).toString("utf8").replace(/\uFFFD$/u, "");
		out.push({ type: "text", text: `${cut}\n[Desk cut this result at ${HOST_TOOL_MAX_RESULT_BYTES} bytes]` });
		budget = 0;
	}
	return out;
}

function boundedDetails(details: unknown): unknown {
	if (details === undefined) return undefined;
	try {
		const text = JSON.stringify(details);
		if (text === undefined || utf8(text) > MAX_DETAILS_BYTES) return undefined;
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The `host_tool_result` line for a tool's result; a malformed one becomes an error. `type` leads so the broker's head peek reads it. */
function encodeResult(id: string, result: unknown): string {
	const content = textContent(result);
	if (content === null || !isRecord(result)) {
		return JSON.stringify({ type: "host_tool_result", id, result: { content: [{ type: "text", text: "The Desk host tool returned a malformed result." }] }, isError: true });
	}
	const details = boundedDetails(result.details);
	return JSON.stringify({
		type: "host_tool_result",
		id,
		result: { content: capContent(content), ...(details === undefined ? {} : { details }) },
		...(result.isError === true ? { isError: true } : {}),
	});
}
