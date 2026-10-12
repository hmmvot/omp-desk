/**
 * Tests for the session-file readers: the JSONL header (title slot, first-prompt
 * summary, stamp-keyed re-reads), the last-conversation activity scan, and the
 * working-directory normalizers.
 *
 * Runner: `node:test`. Run with
 * `node --test --experimental-strip-types src/host/session-files.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
	isAbsoluteWorkspaceDirectory,
	normalizeWorkspaceDirectory,
	parseSessionFileHeader,
	readSessionFileActivity,
	readSessionFileHeader,
	readSessionFileHeaderReading,
} from "./session-files.ts";

// ── Session file header ─────────────────────────────────────────────────────

describe("session file header", () => {
	/** The physical shape OMP 18.3.0 writes: title slot, then the session header. */
	function body(options: { slotTitle?: string; headerTitle?: string; extra?: string[] }): string {
		const slot = JSON.stringify({
			type: "title",
			v: 1,
			title: options.slotTitle ?? "",
			source: "auto",
			updatedAt: "2026-09-24T10:00:00.000Z",
			pad: " ".repeat(8),
		});
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "S-HEADER",
			timestamp: "2026-09-24T10:00:00.000Z",
			cwd: "C:\\projects\\one",
			...(options.headerTitle === undefined ? {} : { title: options.headerTitle }),
		});
		return [slot, header, ...(options.extra ?? [])].join("\n") + "\n";
	}

	it("reads the title OMP keeps in the fixed-width slot", () => {
		assert.deepEqual(parseSessionFileHeader(body({ slotTitle: "View omp stats" })), {
			sessionId: "S-HEADER",
			cwd: "C:\\projects\\one",
			title: "View omp stats",
		});
	});

	it("prefers the title slot, including an explicit cleared name, and reads legacy header titles", () => {
		// OMP's current slot is authoritative even when it clears an older header name.
		assert.equal(parseSessionFileHeader(body({ slotTitle: "renamed", headerTitle: "old" }))?.title, "renamed");
		assert.equal(parseSessionFileHeader(body({ headerTitle: "old header name" }))?.title, null);
		assert.equal(parseSessionFileHeader(JSON.stringify({ type: "session", id: "legacy", title: "Legacy title" }))?.title, "Legacy title");
		// An unnamed session reports no title at all rather than an empty one.
		assert.equal(parseSessionFileHeader(body({}))?.title, null);
	});

	it("reports no title for a candidate the slot never named", () => {
		// A `title_change` entry is a log entry, not the slot: reading it would
		// report a title OMP's own listing would not.
		const withChange = body({
			extra: [
				JSON.stringify({
					type: "title_change",
					id: "0b05dd58",
					parentId: "aacc56ca",
					timestamp: "2026-09-24T10:05:00.000Z",
					title: "appended by a rename",
					source: "user",
				}),
			],
		});
		assert.equal(parseSessionFileHeader(withChange)?.title, null);
		// A slot from a future version is not read as this one.
		const futureSlot = `${JSON.stringify({ type: "title", v: 2, title: "from the future" })}\n${JSON.stringify({
			type: "session",
			id: "S-FUTURE",
			cwd: "C:\\projects\\one",
		})}\n`;
		assert.equal(parseSessionFileHeader(futureSlot)?.title, null);
	});

	it("needs a session header, not only a title slot", () => {
		assert.equal(parseSessionFileHeader(""), null);
		assert.equal(parseSessionFileHeader(`${JSON.stringify({ type: "title", v: 1, title: "orphan" })}\n`), null);
	});

	it("summarizes only the first user prompt and leaves native and user titles authoritative", () => {
		const messages = [
			JSON.stringify({ type: "message", message: { role: "assistant", content: "Not a prompt" } }),
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "  Fix the login\n layout  " }, { type: "image", data: "ignored" }] } }),
			JSON.stringify({ type: "message", message: { role: "user", content: "Not the first prompt" } }),
		];
		assert.equal(parseSessionFileHeader(body({ extra: messages }))?.promptTitle, "Fix the login layout");
		assert.equal(parseSessionFileHeader(body({ slotTitle: "User title", extra: messages }))?.title, "User title");
		assert.equal(parseSessionFileHeader(body({ slotTitle: "User title", extra: messages }))?.promptTitle, undefined);
		const long = parseSessionFileHeader(body({ extra: [JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(100) } })] }))?.promptTitle;
		assert.equal(long?.length, 60);
	});

	it("finds the first prompt even beyond the bounded header prefix", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "omp-prompt-title-"));
		try {
			const file = path.join(root, "session.jsonl");
			await writeFile(file, body({ extra: [
				JSON.stringify({ type: "metadata", content: "x".repeat(70_000) }),
				JSON.stringify({ type: "message", message: { role: "user", content: "A descriptive session" } }),
			] }));
			assert.equal((await readSessionFileHeader(file))?.promptTitle, "A descriptive session");
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("re-reads a file only when its stamp changed, which a title rewritten in place does by mtime alone", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "omp-header-stamp-"));
		try {
			const file = path.join(root, "session.jsonl");
			await writeFile(file, body({ slotTitle: "One" }));
			const first = await readSessionFileHeaderReading(file, null);
			assert.equal(first?.header?.title, "One");
			assert.equal(await readSessionFileHeaderReading(file, first), first, "an unchanged file is not read again");
			// OMP rewrites the slot in place: the same byte count, a newer mtime.
			await writeFile(file, body({ slotTitle: "Two" }));
			await utimes(file, new Date("2026-10-12T12:00:00Z"), new Date("2026-10-12T12:00:00Z"));
			const second = await readSessionFileHeaderReading(file, first);
			assert.equal(second?.size, first?.size);
			assert.equal(second?.header?.title, "Two");
			assert.equal(await readSessionFileHeaderReading(path.join(root, "missing.jsonl"), first), null);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("does not reuse a reading whose first-prompt scan failed, so the next call finds the prompt title", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "omp-header-scan-failure-"));
		try {
			const file = path.join(root, "session.jsonl");
			await writeFile(file, body({ extra: [
				JSON.stringify({ type: "metadata", content: "x".repeat(70_000) }),
				JSON.stringify({ type: "message", message: { role: "user", content: "A descriptive session" } }),
			] }));
			const failing = () => new Readable({ read() { this.destroy(new Error("read failed")); } });
			const degraded = await readSessionFileHeaderReading(file, null, failing);
			assert.equal(degraded?.header?.promptTitle, undefined, "the failed scan leaves the header without its prompt title");
			// The file is unchanged, yet the degraded reading must not stand in for a read.
			const healed = await readSessionFileHeaderReading(file, degraded);
			assert.notEqual(healed, degraded);
			assert.equal(healed?.header?.promptTitle, "A descriptive session");
			assert.equal(await readSessionFileHeaderReading(file, healed), healed, "a completed reading is reused again");
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});

describe("session file activity", () => {
	/** One entry as OMP 18.6.3 serializes it: `type`, then `id`, `parentId`, `timestamp`, then the payload. */
	function entry(type: string, timestamp: string, payload: Record<string, unknown> = {}): string {
		return JSON.stringify({ type, id: timestamp.slice(11, 19), parentId: null, timestamp, ...payload });
	}
	/** A custom message as OMP writes it: the payload comes first and the common fields last. */
	function customMessage(timestamp: string, content: string): string {
		return JSON.stringify({ type: "custom_message", customType: "async-result", content, display: true, details: { timestamp: "1999-01-01T00:00:00.000Z" }, attribution: "agent", id: "c1", parentId: null, timestamp });
	}
	const head = [
		JSON.stringify({ type: "title", v: 1, title: "Named" }).padEnd(255, " "),
		JSON.stringify({ type: "session", version: 3, id: "S-ACTIVITY", timestamp: "2026-10-08T09:00:00.000Z", cwd: "C:\\projects\\one" }),
	];

	async function withFile(lines: readonly string[], check: (file: string) => Promise<void>, trailingNewline = true): Promise<void> {
		const root = await mkdtemp(path.join(tmpdir(), "omp-activity-"));
		try {
			const file = path.join(root, "session.jsonl");
			await writeFile(file, `${lines.join("\n")}${trailingNewline ? "\n" : ""}`);
			await check(file);
		} finally { await rm(root, { recursive: true, force: true }); }
	}

	it("reports the last conversation entry, not the bookkeeping OMP appends after it", async () => {
		await withFile([
			...head,
			entry("model_change", "2026-10-08T09:00:01.000Z", { model: "anthropic/claude" }),
			entry("message", "2026-10-08T10:00:00.000Z", { message: { role: "user", content: "hello" } }),
			entry("message", "2026-10-08T10:01:00.000Z", { message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
			// A host exit, a resume and a model switch: none of them is the conversation.
			entry("custom", "2026-10-08T12:00:00.000Z", { customType: "session_exit", data: { reason: "dispose", kind: "normal" } }),
			entry("thinking_level_change", "2026-10-08T12:05:00.000Z", { thinkingLevel: "high" }),
			entry("service_tier_change", "2026-10-08T12:05:00.000Z", { serviceTier: null }),
			entry("model_change", "2026-10-08T12:06:00.000Z", { model: "openai/gpt" }),
		], async file => {
			assert.equal((await readSessionFileActivity(file))?.lastConversationAt, "2026-10-08T10:01:00.000Z");
		});
	});

	it("reads entries across chunk boundaries, including a payload-first custom message and an unterminated last line", async () => {
		const bulky = (minute: number) => entry("custom", `2026-10-08T11:${String(minute).padStart(2, "0")}:00.000Z`, {
			customType: "tool_execution_start", data: { args: "x".repeat(30_000) },
		});
		await withFile([
			...head,
			entry("message", "2026-10-08T10:00:00.000Z", { message: { role: "assistant", content: "y".repeat(150_000) } }),
			customMessage("2026-10-08T10:05:00.000Z", "z".repeat(200_000)),
			bulky(1), bulky(2), bulky(3), bulky(4), bulky(5),
			entry("custom", "2026-10-08T12:00:00.000Z", { customType: "session_exit" }).slice(0, 40),
		], async file => {
			assert.equal((await readSessionFileActivity(file))?.lastConversationAt, "2026-10-08T10:05:00.000Z");
		}, false);
		await withFile([
			...head,
			entry("message", "2026-10-08T10:00:00.000Z", { message: { role: "assistant", content: "y".repeat(150_000) } }),
			bulky(1), bulky(2), bulky(3),
		], async file => {
			assert.equal((await readSessionFileActivity(file))?.lastConversationAt, "2026-10-08T10:00:00.000Z");
		});
	});

	it("tells a file without conversation from a missing one, and re-reads only a changed file", async () => {
		await withFile([...head, entry("model_change", "2026-10-08T09:00:01.000Z", { model: "anthropic/claude" })], async file => {
			const empty = await readSessionFileActivity(file);
			assert.equal(empty?.lastConversationAt, null);
			assert.equal(await readSessionFileActivity(file, empty), empty, "an unchanged file is not read again");
			await writeFile(file, `${entry("message", "2026-10-08T10:00:00.000Z", { message: { role: "user", content: "next" } })}\n`, { flag: "a" });
			assert.equal((await readSessionFileActivity(file, empty))?.lastConversationAt, "2026-10-08T10:00:00.000Z");
			assert.equal(await readSessionFileActivity(path.join(path.dirname(file), "missing.jsonl")), null);
		});
	});
});

// ── Working directories ─────────────────────────────────────────────────────

describe("working directory normalization", () => {
	const windows = process.platform === "win32";

	it("keeps a drive or POSIX root instead of stripping it away", () => {
		if (windows) {
			assert.equal(normalizeWorkspaceDirectory("C:\\"), "c:\\");
			assert.equal(normalizeWorkspaceDirectory("C:/"), "c:\\");
			assert.equal(normalizeWorkspaceDirectory("C:\\Projects\\"), "c:\\projects");
			assert.equal(isAbsoluteWorkspaceDirectory("C:\\"), true);
			assert.equal(isAbsoluteWorkspaceDirectory("\\\\server\\share"), true, "a UNC share is an absolute directory");
		} else {
			assert.equal(normalizeWorkspaceDirectory("/"), "/");
			assert.equal(normalizeWorkspaceDirectory("/Projects/"), "/Projects");
			assert.equal(isAbsoluteWorkspaceDirectory("/"), true);
		}
		assert.equal(
			isAbsoluteWorkspaceDirectory("\\foo"),
			false,
			"a drive-less rooted path is drive-relative, so it is not an absolute directory",
		);
	});

	it("keeps a value that is not absolute instead of resolving it against this process", () => {
		const host = normalizeWorkspaceDirectory(process.cwd());
		for (const value of ["", "   ", "C:", "relative", "relative/dir", "\\foo"]) {
			assert.notEqual(
				normalizeWorkspaceDirectory(value),
				host,
				`${JSON.stringify(value)} must never become this process's own folder`,
			);
			assert.equal(isAbsoluteWorkspaceDirectory(value), false, `${JSON.stringify(value)} is not an absolute directory`);
		}
		assert.equal(normalizeWorkspaceDirectory(""), "");
		assert.equal(normalizeWorkspaceDirectory("C:"), windows ? "c:" : "C:");
		assert.equal(normalizeWorkspaceDirectory("\\foo"), "\\foo");
	});
});
