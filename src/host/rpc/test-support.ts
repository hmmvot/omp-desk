/** Shared builders for the rpc core tests. Not imported by production code. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatEntry, ChatMessage } from "../../chat/messages.ts";
import type { RpcSessionTimers } from "./session.ts";

export const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };

export function isoOf(ms: number): string {
	return new Date(ms).toISOString();
}

export function userMessage(text: string, timestamp: number): ChatMessage {
	return { role: "user", content: text, timestamp };
}

export function assistantMessage(text: string, timestamp: number): ChatMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "m",
		usage: USAGE,
		stopReason: "stop",
		timestamp,
	};
}

export function toolResultMessage(toolCallId: string, timestamp: number, toolName = "read", details?: unknown): ChatMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp,
		...(details === undefined ? {} : { details }),
	};
}

/** A durable message entry; `timestamp` here is the message's own epoch-ms (the reconciliation key). */
export function messageEntry(id: string, parentId: string | null, message: ChatMessage): ChatEntry {
	return { type: "message", id, parentId, timestamp: isoOf(message.timestamp + 2_000), message };
}

export function jsonl(lines: readonly unknown[]): string {
	return `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
}

export interface SessionFileSpec {
	id?: string;
	cwd?: string;
	version?: number;
	title?: string;
	entries: readonly unknown[];
	/** Extra bytes appended verbatim (e.g. an incomplete last line). */
	trailer?: string;
}

/** Text of a session file: fixed-width `title` slot, `session` header, then entries. */
export function sessionFileText(spec: SessionFileSpec): string {
	const title = { type: "title", v: 1, title: spec.title ?? "T", source: "auto", updatedAt: isoOf(0), pad: " ".repeat(40) };
	const header = {
		type: "session",
		...(spec.version === undefined ? { version: 3 } : spec.version === 0 ? {} : { version: spec.version }),
		id: spec.id ?? "sess-1",
		timestamp: isoOf(0),
		cwd: spec.cwd ?? "D:\\scratch",
	};
	return jsonl([title, header, ...spec.entries]) + (spec.trailer ?? "");
}

export class ScratchDir {
	readonly dir: string;
	private constructor(dir: string) {
		this.dir = dir;
	}
	static async create(): Promise<ScratchDir> {
		return new ScratchDir(await mkdtemp(path.join(tmpdir(), "omp-rpc-test-")));
	}
	async file(name: string, text: string): Promise<string> {
		const file = path.join(this.dir, name);
		await writeFile(file, text);
		return file;
	}
	async remove(): Promise<void> {
		await rm(this.dir, { recursive: true, force: true });
	}
}

/** Manual clock + timers: nothing fires until `advance`. */
export class ManualTimers implements RpcSessionTimers {
	#now = 1_000_000;
	#next = 1;
	#timers = new Map<number, { at: number; handler: () => void }>();
	now(): number {
		return this.#now;
	}
	setTimeout(handler: () => void, ms: number): unknown {
		const id = this.#next++;
		this.#timers.set(id, { at: this.#now + ms, handler });
		return id;
	}
	clearTimeout(handle: unknown): void {
		this.#timers.delete(handle as number);
	}
	get pending(): number {
		return this.#timers.size;
	}
	advance(ms: number): void {
		const target = this.#now + ms;
		for (;;) {
			let due: [number, { at: number; handler: () => void }] | undefined;
			for (const item of this.#timers) if (item[1].at <= target && (due === undefined || item[1].at < due[1].at)) due = item;
			if (due === undefined) break;
			this.#timers.delete(due[0]);
			this.#now = Math.max(this.#now, due[1].at);
			due[1].handler();
		}
		this.#now = target;
	}
}

/** Let queued microtasks and I/O callbacks run. */
export async function tick(rounds = 8): Promise<void> {
	for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setImmediate(resolve));
}

/**
 * Let I/O run until `condition` holds. A fixed number of turns is too few on a loaded
 * machine; the wall-clock bound only turns a hang into a failure, so the caller still
 * asserts the state it waited for.
 */
export async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) await tick(2);
}
