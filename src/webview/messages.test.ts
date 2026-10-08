/**
 * Tests for the boundary that carries `@` file completion, the OMP mention
 * grammar this panel inserts with, and the host-control exchange the controls
 * panel drives.
 *
 * The grammar is pinned to OMP's own parser (`pi-coding-agent src/utils/file-mentions.ts`,
 * `FILE_MENTION_REGEX = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g` plus its token
 * boundary and edge-punctuation rules). That matters because nothing else
 * validates a mention: the host resolves it with `resolveReadPath` and treats one
 * that does not resolve as prose, so a wrong quote or a stray trailing dot
 * silently sends the path as plain text instead of loading the file. The
 * round-trip assertions below re-parse what this module emits with a mirror of
 * OMP's parser on purpose — the oracle is the host's grammar, not our formatter.
 *
 * Runner: `bun test src/webview/messages.test.ts` or
 * `node --test src/webview/messages.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FILE_COMPLETION_LIMIT,
	MAX_DRAFT_TEXT_LENGTH,
	MAX_CONTROL_TEXT_LENGTH,
	MAX_FILE_PATH_LENGTH,
	MAX_FILE_QUERY_LENGTH,
	MAX_THINKING_LEVEL_LENGTH,
	MAX_TERMINAL_COLS,
	MAX_TERMINAL_DATA_BASE64_CHARS,
	MAX_TERMINAL_INPUT_BASE64_CHARS,
	MAX_TERMINAL_ROWS,
	MAX_TERMINAL_SNAPSHOT_BASE64_CHARS,
	MAX_TERMINAL_TEXT_LENGTH,
	isControlScope,
	isTerminalGeneration,
	mentionQueryAt,
	mentionTokenForPath,
	newControlScope,
	GUEST_PROTOCOL_VERSION,
	parseGuestHostMessage,
	parseGuestWebviewMessage,
	spliceMention,
} from "./messages.ts";

const FILE_MENTION_REGEX = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
const LEADING_PUNCTUATION_REGEX = /^[`"'([{<]+/;
const TRAILING_PUNCTUATION_REGEX = /[)\]}>.,;:!?"'`]+$/;
const MENTION_BOUNDARY_REGEX = /[\s([{<"'`]/;

function mentionsIn(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(FILE_MENTION_REGEX)) {
		const index = match.index ?? 0;
		if (!(index === 0 || MENTION_BOUNDARY_REGEX.test(text[index - 1] as string))) continue;
		const raw = match[1] ?? match[2] ?? match[3];
		if (raw === undefined) continue;
		const cleaned =
			match[1] !== undefined || match[2] !== undefined
				? raw.trim()
				: raw.trim().replace(LEADING_PUNCTUATION_REGEX, "").replace(TRAILING_PUNCTUATION_REGEX, "").trim();
		if (cleaned.length > 0) found.push(cleaned);
	}
	return [...new Set(found)];
}

/** The inserted token must read back as exactly the chosen path. */
function assertRoundTrip(path: string): void {
	const token = mentionTokenForPath(path);
	assert.deepEqual(mentionsIn(`look at ${token} please`), [path], `token ${token} for ${path}`);
	assert.deepEqual(mentionsIn(token), [path]);
}

describe("mentionTokenForPath", () => {
	it("leaves ordinary paths in the bare form", () => {
		assert.equal(mentionTokenForPath("src/omp-desk/a-b.ts"), "@src/omp-desk/a-b.ts");
		assert.equal(mentionTokenForPath("README.md"), "@README.md");
		assert.equal(mentionTokenForPath(".hidden/x.ts"), "@.hidden/x.ts");
		assertRoundTrip("src/omp-desk/a-b.ts");
		assertRoundTrip("README.md");
		assertRoundTrip(".hidden/x.ts");
	});

	it("quotes paths the bare form cannot carry", () => {
		for (const path of [
			"my notes/todo.md",
			"at@home/x.ts",
			"back`tick.ts",
			"(weird)/a.ts",
			"dir/file.",
			"dir/file,",
			"src/a'b.ts",
			"tab\tname.ts",
		]) {
			assert.equal(mentionTokenForPath(path), `@"${path}"`, path);
			assertRoundTrip(path);
		}
	});

	it("switches to single quotes when the path itself contains a double quote", () => {
		const path = 'odd"name.ts';
		assert.equal(mentionTokenForPath(path), `@'${path}'`);
		assertRoundTrip(path);
	});

	it("keeps separators and casing verbatim", () => {
		assert.equal(mentionTokenForPath("Src/Sub/File.TS"), "@Src/Sub/File.TS");
	});
});

describe("spliceMention", () => {
	it("replaces only the token under the caret and reports the new caret", () => {
		const text = "please read @sr then summarise";
		const spliced = spliceMention(text, 15, 12, "src/lib/app.ts");
		assert.equal(spliced.text, "please read @src/lib/app.ts  then summarise");
		assert.equal(spliced.caret, 12 + "@src/lib/app.ts ".length);
		assert.equal(spliced.text.slice(spliced.caret), " then summarise");
	});

	it("quotes when it must and leaves the rest — including newlines — untouched", () => {
		const text = "line one\n@notes\ttail with a tab and\ttrailing tab\nend";
		const caret = text.indexOf("\ttail");
		const spliced = spliceMention(text, caret, text.indexOf("@notes"), "my notes/a b.md");
		assert.equal(spliced.text, 'line one\n@"my notes/a b.md" \ttail with a tab and\ttrailing tab\nend');
		assert.equal(spliced.text.slice(spliced.caret), "\ttail with a tab and\ttrailing tab\nend");
	});

	it("handles a bare @ and text before and after it", () => {
		const spliced = spliceMention("x @ ", 3, 2, "a.ts");
		assert.equal(spliced.text, "x @a.ts  ");
		assert.equal(spliced.caret, 8);
		assert.deepEqual(mentionsIn(spliced.text), ["a.ts"]);
	});

	it("keeps the whole draft round-trippable for every inserted token", () => {
		for (const path of ["src/a.ts", "my notes/a b.md", "at@home/x.ts", "dir/file."]) {
			const spliced = spliceMention("before @q after", 9, 7, path);
			assert.deepEqual(mentionsIn(spliced.text), [path], spliced.text);
			assert.equal(spliced.text.startsWith("before "), true);
			assert.equal(spliced.text.endsWith(" after"), true);
		}
	});
});

describe("mentionQueryAt", () => {
	it("finds the token under the caret", () => {
		assert.deepEqual(mentionQueryAt("hello @src", 10), { start: 6, query: "src" });
		assert.deepEqual(mentionQueryAt("@src", 4), { start: 0, query: "src" });
		assert.deepEqual(mentionQueryAt("@", 1), { start: 0, query: "" });
		assert.deepEqual(mentionQueryAt("see (@lib/", 10), { start: 5, query: "lib/" });
		assert.deepEqual(mentionQueryAt('he said "@lib', 13), { start: 9, query: "lib" });
	});

	it("stops at the caret, not at the end of the line", () => {
		assert.deepEqual(mentionQueryAt("@src/lib.ts more", 4), { start: 0, query: "src" });
	});

	it("ignores tokens that are not at a mention boundary or not under the caret", () => {
		assert.equal(mentionQueryAt("mail@host", 9), null);
		assert.equal(mentionQueryAt("@a@b", 4), null);
		assert.equal(mentionQueryAt("@src foo", 8), null);
		assert.equal(mentionQueryAt("@a\nfoo", 6), null);
		assert.equal(mentionQueryAt('@"a b', 5), null);
		assert.equal(mentionQueryAt("no mention here", 5), null);
	});

	it("refuses carets outside the text and queries outside the bounds", () => {
		assert.equal(mentionQueryAt("abc", 99), null);
		assert.equal(mentionQueryAt("abc", -1), null);
		const overlong = `@${"a".repeat(MAX_FILE_QUERY_LENGTH + 1)}`;
		assert.equal(mentionQueryAt(overlong, overlong.length), null);
		assert.equal(mentionQueryAt(`@${"a".repeat(MAX_FILE_QUERY_LENGTH)}`, MAX_FILE_QUERY_LENGTH + 1)?.query.length, MAX_FILE_QUERY_LENGTH);
		assert.equal(mentionQueryAt("@a\u0007b", 4), null);
	});
});

describe("parseGuestWebviewMessage completion requests", () => {
	it("accepts a bounded query and drops undeclared fields", () => {
		const parsed = parseGuestWebviewMessage({ type: "omp:complete-files", requestId: 3, query: "src/li", extra: 1 });
		assert.deepEqual(parsed, { type: "omp:complete-files", requestId: 3, query: "src/li" });
		assert.deepEqual(parseGuestWebviewMessage({ type: "omp:complete-files", requestId: 0, query: "" }), {
			type: "omp:complete-files",
			requestId: 0,
			query: "",
		});
	});

	it("rejects malformed ids, queries and oversized requests", () => {
		const base = { type: "omp:complete-files", query: "src" };
		for (const requestId of [undefined, null, -1, 1.5, Number.NaN, "3", {}]) {
			assert.equal(parseGuestWebviewMessage({ ...base, requestId }), null, String(requestId));
		}
		assert.equal(parseGuestWebviewMessage({ type: "omp:complete-files", requestId: 1 }), null);
		assert.equal(parseGuestWebviewMessage({ type: "omp:complete-files", requestId: 1, query: 7 }), null);
		assert.equal(
			parseGuestWebviewMessage({ type: "omp:complete-files", requestId: 1, query: "a".repeat(MAX_FILE_QUERY_LENGTH + 1) }),
			null,
		);
		assert.equal(parseGuestWebviewMessage({ type: "omp:complete-files", requestId: 1, query: "a\nb" }), null);
	});

	it("still validates the pre-existing webview messages", () => {
		assert.deepEqual(parseGuestWebviewMessage({ type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION }), {
			type: "omp:ready",
			protocolVersion: GUEST_PROTOCOL_VERSION,
		});
		assert.equal(parseGuestWebviewMessage({ type: "omp:ready" }), null);
		assert.deepEqual(parseGuestWebviewMessage({ type: "omp:composer-popup", open: true, extra: 1 }), {
			type: "omp:composer-popup",
			open: true,
		});
		assert.equal(parseGuestWebviewMessage({ type: "omp:composer-popup", open: "yes" }), null);
	});

	it("no longer accepts the messages of the removed Collab and terminal-switch surfaces", () => {
		for (const type of ["omp:status", "omp:error", "omp:activity", "omp:terminal-seen", "omp:select-surface", "omp:raw-capture-batch"]) {
			assert.equal(parseGuestWebviewMessage({ type, phase: "live" }), null, type);
		}
	});
});

describe("parseGuestHostMessage completion answers", () => {
	it("accepts a bounded path list", () => {
		assert.deepEqual(parseGuestHostMessage({ type: "omp:file-completions", requestId: 3, paths: ["a.ts", "b/c.ts"] }), {
			type: "omp:file-completions",
			requestId: 3,
			paths: ["a.ts", "b/c.ts"],
		});
		assert.deepEqual(parseGuestHostMessage({ type: "omp:file-completions", requestId: 0, paths: [] }), {
			type: "omp:file-completions",
			requestId: 0,
			paths: [],
		});
	});

	it("rejects entries that could corrupt a draft or the boundary", () => {
		const base = { type: "omp:file-completions", requestId: 1 };
		assert.equal(parseGuestHostMessage({ ...base, paths: "a.ts" }), null);
		assert.equal(parseGuestHostMessage({ ...base, paths: [7] }), null);
		assert.equal(parseGuestHostMessage({ ...base, paths: [""] }), null);
		assert.equal(parseGuestHostMessage({ ...base, paths: ["a".repeat(MAX_FILE_PATH_LENGTH + 1)] }), null);
		assert.equal(parseGuestHostMessage({ ...base, paths: ["ok.ts", "bad\nname.ts"] }), null);
		assert.equal(parseGuestHostMessage({ ...base, requestId: "1", paths: [] }), null);
	});

	it("bounds the list even when the host overshoots", () => {
		const paths = Array.from({ length: FILE_COMPLETION_LIMIT + 5 }, (_, index) => `file-${index}.ts`);
		const parsed = parseGuestHostMessage({ type: "omp:file-completions", requestId: 1, paths });
		assert.notEqual(parsed, null);
		assert.equal(parsed?.type === "omp:file-completions" ? parsed.paths.length : -1, FILE_COMPLETION_LIMIT);
	});

	it("still validates the pre-existing host messages", () => {
		const restore = { type: "omp:draft-restore", requestId: 1, text: "hello", attachments: 0, recoverable: [] };
		assert.deepEqual(parseGuestHostMessage(restore), restore);
		assert.equal(parseGuestHostMessage({ type: "omp:anything" }), null);
	});

	it("no longer accepts the messages of the removed Collab link flow", () => {
		for (const type of ["omp:connect", "omp:disconnect", "omp:passive", "omp:surface", "omp:raw-capture-arm"]) {
			assert.equal(parseGuestHostMessage({ type, link: "ws://127.0.0.1:1/r/room.key", passive: true }), null, type);
		}
	});

	it("relays only the bare control invalidation, never a state it carries", () => {
		// The invalidation is an event, not a report: a payload riding along is
		// dropped, and the panel keeps asking through its own correlated request.
		assert.deepEqual(parseGuestHostMessage({ type: "omp:control-invalidate" }), { type: "omp:control-invalidate" });
		assert.deepEqual(
			parseGuestHostMessage({ type: "omp:control-invalidate", available: true, model: { provider: "p", id: "i" } }),
			{ type: "omp:control-invalidate" },
		);
	});
});

describe("bridge panel message hashes", () => {
	const hash = "a".repeat(64);
	const token = "b".repeat(32);
	const bind = {
		type: "omp:bridge-bind",
		hostGeneration: token,
		documentId: token,
		bootstrapId: token,
		editorId: token,
		workspace: hash,
		bindingHash: hash,
		tabId: "tab:11111111-2222-3333-4444-555555555555",
		origin: "vscode-webview://example",
		path: "/bridge",
		port: 45678,
		secret: "A".repeat(43),
	};

	it("accepts the host's SHA-256 hashes in a bridge bind and its acknowledgement", () => {
		const parsed = parseGuestHostMessage(bind);
		assert.deepEqual(parsed, bind);
		const ack = { type: "omp:bridge-ack", hostGeneration: token, documentId: token, bindingHash: parsed?.type === "omp:bridge-bind" ? parsed.bindingHash : "" };
		assert.deepEqual(parseGuestWebviewMessage(ack), ack);
	});

	it("refuses truncated and noncanonical workspace and binding hashes", () => {
		for (const malformed of [token, "A".repeat(64), "a".repeat(63), "a".repeat(65)]) {
			assert.equal(parseGuestHostMessage({ ...bind, workspace: malformed }), null);
			assert.equal(parseGuestHostMessage({ ...bind, bindingHash: malformed }), null);
			assert.equal(parseGuestWebviewMessage({ type: "omp:bridge-ack", hostGeneration: token, documentId: token, bindingHash: malformed }), null);
		}
	});
});

/** A v4 UUID in the canonical form the panel mints. */
const SCOPE = "9f1c3a5e-7b2d-4c6f-8a10-4d5e6f708192";

/** A whole state report, with the fields under test overridden. */
function stateReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "omp:control-state",
		scope: SCOPE,
		requestId: 2,
		available: true,
		model: { provider: "anthropic", id: "claude-x" },
		thinkingLevel: "high",
		mutationMode: "best-effort",
		...overrides,
	};
}

describe("control scope", () => {
	it("accepts the canonical UUID form the panel mints", () => {
		assert.equal(isControlScope(SCOPE), true);
		assert.equal(isControlScope(SCOPE.toUpperCase()), true);
		assert.equal(isControlScope(newControlScope()), true);
		assert.notEqual(newControlScope(), newControlScope());
	});

	it("refuses placeholders, truncated ids and versions it did not mint", () => {
		for (const scope of [
			"",
			"scope",
			SCOPE.slice(0, -1),
			`${SCOPE}0`,
			SCOPE.replaceAll("-", ""),
			"9f1c3a5e-7b2d-0c6f-8a10-4d5e6f708192",
			"9f1c3a5e-7b2d-4c6f-ca10-4d5e6f708192",
			undefined,
			7,
			{},
		]) {
			assert.equal(isControlScope(scope), false, String(scope));
		}
	});
});

describe("parseGuestWebviewMessage control requests", () => {
	it("accepts a snapshot that claims nothing else", () => {
		assert.deepEqual(parseGuestWebviewMessage({ type: "omp:control-request", scope: SCOPE, requestId: 0, action: "snapshot" }), {
			type: "omp:control-request",
			scope: SCOPE,
			requestId: 0,
			action: "snapshot",
		});
	});

	it("accepts one mutation field per action and drops undeclared fields", () => {
		assert.deepEqual(
			parseGuestWebviewMessage({
				type: "omp:control-request",
				scope: SCOPE,
				requestId: 4,
				action: "set-model",
				model: { provider: "anthropic", id: "claude-x" },
				actionSeq: "7",
			}),
			{
				type: "omp:control-request",
				scope: SCOPE,
				requestId: 4,
				action: "set-model",
				model: { provider: "anthropic", id: "claude-x" },
				actionSeq: "7",
			},
		);
		assert.deepEqual(
			parseGuestWebviewMessage({ type: "omp:control-request", scope: SCOPE, requestId: 5, action: "set-thinking", level: "xhigh", actionSeq: "8", extra: true }),
			{ type: "omp:control-request", scope: SCOPE, requestId: 5, action: "set-thinking", level: "xhigh", actionSeq: "8" },
		);
	});

	it("requires a document sequence for a mutation and refuses one where it does not belong", () => {
		// The host reserves this sequence once per document, so a change that carries
		// none cannot be admitted at all, and a read that carries one is a shape this
		// boundary never declares.
		assert.equal(
			parseGuestWebviewMessage({ type: "omp:control-request", scope: SCOPE, requestId: 6, action: "set-model", model: { provider: "anthropic", id: "claude-x" } }),
			null,
		);
		assert.equal(
			parseGuestWebviewMessage({ type: "omp:control-request", scope: SCOPE, requestId: 6, action: "set-thinking", level: "xhigh" }),
			null,
		);
		assert.equal(
			parseGuestWebviewMessage({ type: "omp:control-request", scope: SCOPE, requestId: 6, action: "set-model", model: { provider: "anthropic", id: "claude-x" }, actionSeq: "07" }),
			null,
			"a padded sequence is not canonical",
		);
		assert.equal(parseGuestWebviewMessage({ type: "omp:control-request", scope: SCOPE, requestId: 6, action: "snapshot", actionSeq: "1" }), null);
		assert.notEqual(parseGuestWebviewMessage({ type: "omp:control-request", scope: SCOPE, requestId: 6, action: "snapshot" }), null);
	});

	it("refuses a request that carries the other action's field", () => {
		// A snapshot carrying a model would read as a mutation, and a mutation
		// carrying both would leave the host guessing which change was meant.
		const snapshot = { type: "omp:control-request", scope: SCOPE, requestId: 1, action: "snapshot" };
		const setModel = { type: "omp:control-request", scope: SCOPE, requestId: 1, action: "set-model", model: { provider: "a", id: "b" } };
		const setThinking = { type: "omp:control-request", scope: SCOPE, requestId: 1, action: "set-thinking", level: "high" };
		assert.equal(parseGuestWebviewMessage({ ...snapshot, model: { provider: "a", id: "b" } }), null);
		assert.equal(parseGuestWebviewMessage({ ...snapshot, level: "high" }), null);
		assert.equal(parseGuestWebviewMessage({ ...setModel, level: "high" }), null);
		assert.equal(parseGuestWebviewMessage({ ...setThinking, model: null }), null);
	});

	it("refuses an action without its field, or with a malformed one", () => {
		const base = { type: "omp:control-request", scope: SCOPE, requestId: 1 };
		assert.equal(parseGuestWebviewMessage({ ...base, action: "set-model" }), null);
		assert.equal(parseGuestWebviewMessage({ ...base, action: "set-thinking" }), null);
		assert.equal(parseGuestWebviewMessage({ ...base, action: "set-thinking", level: "" }), null);
		assert.equal(
			parseGuestWebviewMessage({ ...base, action: "set-thinking", level: "a".repeat(MAX_THINKING_LEVEL_LENGTH + 1) }),
			null,
		);
		assert.equal(parseGuestWebviewMessage({ ...base, action: "set-thinking", level: "hi\ngh" }), null);
		assert.equal(parseGuestWebviewMessage({ ...base, action: "set-model", model: { provider: "", id: "claude-x" } }), null);
		assert.equal(
			parseGuestWebviewMessage({
				...base,
				action: "set-model",
				model: { provider: "anthropic", id: "x".repeat(MAX_CONTROL_TEXT_LENGTH + 1) },
			}),
			null,
		);
		assert.equal(parseGuestWebviewMessage({ ...base, action: "set-model", model: { provider: "anthropic" } }), null);
	});

	it("refuses a scope it did not mint, an unknown action and a malformed id", () => {
		const base = { type: "omp:control-request", scope: SCOPE, requestId: 1, action: "snapshot" };
		assert.equal(parseGuestWebviewMessage({ ...base, scope: "not-a-uuid" }), null);
		assert.equal(parseGuestWebviewMessage({ ...base, scope: undefined }), null);
		assert.equal(parseGuestWebviewMessage({ ...base, requestId: -1 }), null);
		assert.equal(parseGuestWebviewMessage({ ...base, requestId: 1.5 }), null);
		assert.equal(parseGuestWebviewMessage({ ...base, action: "set-something" }), null);
		assert.equal(parseGuestWebviewMessage({ type: "omp:control-request", scope: SCOPE, requestId: 1 }), null);
	});
});

describe("parseGuestHostMessage control reports", () => {
	it("keeps native selections separate from effective state", () => {
		const selectedModel = { provider: "openai-codex", id: "next" };
		const parsed = parseGuestHostMessage(stateReport({ selectedModel }));
		assert.equal(parsed?.type, "omp:control-state");
		if (parsed?.type !== "omp:control-state") return;
		assert.deepEqual(parsed.model, { provider: "anthropic", id: "claude-x" });
		assert.deepEqual(parsed.selectedModel, selectedModel);
		assert.equal(parseGuestHostMessage(stateReport({ selectedModel, selectedThinking: "high" })), null);
	});

	it("refuses an unavailable report claiming readback or a selection", () => {
		const unavailable = { available: false, model: null, thinkingLevel: null, mutationMode: "unavailable", reason: "No live session" };
		assert.notEqual(parseGuestHostMessage(stateReport(unavailable)), null);
		for (const broken of [
			{ model: { provider: "anthropic", id: "claude-x" } }, { thinkingLevel: "high" },
			{ selectedModel: { provider: "a", id: "b" } }, { selectedThinking: "high" },
			{ mutationMode: "best-effort" }, { reason: undefined }, { reason: "" },
		]) assert.equal(parseGuestHostMessage(stateReport({ ...unavailable, ...broken })), null);
	});

	it("rejects malformed correlation, effective values, selections and feedback", () => {
		for (const broken of [
			{ scope: "not-a-uuid" }, { requestId: -3 }, { requestId: "2" }, { mutationMode: "maybe" }, { available: "yes" },
			{ model: { provider: "anthropic" } }, { model: "claude-x" }, { model: undefined },
			{ thinkingLevel: "a".repeat(MAX_THINKING_LEVEL_LENGTH + 1) }, { thinkingLevel: "ta\u0000b" },
			{ selectedModel: { provider: "", id: "next" } }, { selectedThinking: "" }, { selectedThinking: "low\n" },
			{ notice: 7 }, { notice: "" },
		]) assert.equal(parseGuestHostMessage(stateReport(broken)), null);
	});
});

describe("native picker request boundary", () => {
	it("permits read-only picker requests but forbids mixing them with mutations", () => {
		const base = { type: "omp:control-request", scope: SCOPE, requestId: 3 };
		for (const picker of ["model", "thinking"]) assert.deepEqual(parseGuestWebviewMessage({ ...base, action: "snapshot", picker }), { ...base, action: "snapshot", picker });
		assert.equal(parseGuestWebviewMessage({ ...base, action: "snapshot", picker: "other" }), null);
		assert.equal(parseGuestWebviewMessage({ ...base, action: "snapshot", picker: "model", actionSeq: "1" }), null);
		assert.equal(parseGuestWebviewMessage({ ...base, action: "set-thinking", level: "low", picker: "thinking", actionSeq: "1" }), null);
	});
});

/**
 * The terminal contract's regressions are all silent ones. A frame of a
 * superseded generation that the boundary accepted would be written into the
 * screen of the process that replaced it, a stream whose sequence was not dense
 * would look complete while output was missing, and a payload budget that is only
 * checked *after* decoding would let a message allocate far more than the byte
 * count it claims. So the shapes below are checked exactly, and the byte budgets
 * are checked from the encoded length alone.
 */
const TERMINAL_GENERATION = "0123456789abcdef0123456789abcdef";

/** The state a host reports for a live terminal; each case varies one field. */
const TERMINAL_STATE = {
	type: "omp:terminal-state",
	generation: TERMINAL_GENERATION,
	seq: 7,
	phase: "attached",
	input: true,
	cols: 80,
	rows: 24,
	snapshot: "none",
};

describe("isTerminalGeneration", () => {
	it("accepts only the opaque token's exact shape", () => {
		assert.equal(isTerminalGeneration(TERMINAL_GENERATION), true);
		for (const refused of ["", "0123456789abcdef0123456789abcde", `${TERMINAL_GENERATION}f`, TERMINAL_GENERATION.toUpperCase(), 7, null]) {
			assert.equal(isTerminalGeneration(refused), false, `accepted ${String(refused)}`);
		}
	});
});

describe("parseGuestHostMessage terminal frames", () => {
	it("accepts the state a live terminal reports", () => {
		const parsed = parseGuestHostMessage({ ...TERMINAL_STATE, sessionLabel: "src/omp-desk", reason: "" });
		assert.deepEqual(parsed, { ...TERMINAL_STATE, sessionLabel: "src/omp-desk", reason: "" });
	});

	it("refuses a state whose generation, sequence, phase or grid is not one this boundary relays", () => {
		for (const refused of [
			{ ...TERMINAL_STATE, generation: "not-a-generation" },
			{ ...TERMINAL_STATE, seq: -1 },
			{ ...TERMINAL_STATE, seq: 1.5 },
			{ ...TERMINAL_STATE, phase: "running" },
			{ ...TERMINAL_STATE, input: "yes" },
			{ ...TERMINAL_STATE, snapshot: 0 },
			{ ...TERMINAL_STATE, cols: 1 },
			{ ...TERMINAL_STATE, cols: MAX_TERMINAL_COLS + 1 },
			{ ...TERMINAL_STATE, rows: 0 },
			{ ...TERMINAL_STATE, rows: MAX_TERMINAL_ROWS + 1 },
		]) {
			assert.equal(parseGuestHostMessage(refused), null, `accepted ${JSON.stringify(refused)}`);
		}
	});

	it("refuses a state whose display text is unusable instead of repairing it", () => {
		// A reason is text the user reads about their own terminal: one that cannot be
		// shown as-is (a control character, an over-long value) must not become a
		// truncated or sanitized explanation of a different state.
		for (const refused of [
			{ ...TERMINAL_STATE, sessionLabel: "a\u0000b" },
			{ ...TERMINAL_STATE, sessionLabel: "x".repeat(MAX_TERMINAL_TEXT_LENGTH + 1) },
			{ ...TERMINAL_STATE, reason: "a\u001bb" },
			{ ...TERMINAL_STATE, reason: "x".repeat(MAX_TERMINAL_TEXT_LENGTH + 1) },
		]) {
			assert.equal(parseGuestHostMessage(refused), null, `accepted ${JSON.stringify(refused)}`);
		}
	});

	it("accepts output and a screen up to their byte budgets and refuses one character more", () => {
		const data = { type: "omp:terminal-data", generation: TERMINAL_GENERATION, seq: 8, bytes: "A".repeat(MAX_TERMINAL_DATA_BASE64_CHARS) };
		assert.deepEqual(parseGuestHostMessage(data), data);
		assert.equal(parseGuestHostMessage({ ...data, bytes: `${data.bytes}A` }), null);

		const snapshot = { type: "omp:terminal-snapshot", generation: TERMINAL_GENERATION, seq: 8, bytes: "A".repeat(MAX_TERMINAL_SNAPSHOT_BASE64_CHARS) };
		assert.deepEqual(parseGuestHostMessage(snapshot), snapshot);
		assert.equal(parseGuestHostMessage({ ...snapshot, bytes: `${snapshot.bytes}A` }), null);
	});

	it("refuses a payload that is not base64 at all, and an empty one", () => {
		// The grammar is checked on the shape, so a payload that would decode to
		// nothing after an error is never handed to a decoder.
		for (const bytes of ["", "!!!!", "AAAA=", "AAA", "A".repeat(MAX_TERMINAL_DATA_BASE64_CHARS + 4)]) {
			assert.equal(parseGuestHostMessage({ type: "omp:terminal-data", generation: TERMINAL_GENERATION, seq: 1, bytes }), null, `accepted ${bytes.slice(0, 8)}`);
		}
	});

	it("accepts an exit and refuses a code or signal outside the shape", () => {
		assert.deepEqual(parseGuestHostMessage({ type: "omp:terminal-exit", generation: TERMINAL_GENERATION, seq: 9, code: 0, signal: null }), {
			type: "omp:terminal-exit",
			generation: TERMINAL_GENERATION,
			seq: 9,
			code: 0,
			signal: null,
		});
		assert.deepEqual(parseGuestHostMessage({ type: "omp:terminal-exit", generation: TERMINAL_GENERATION, seq: 9, code: null, signal: "SIGINT" }), {
			type: "omp:terminal-exit",
			generation: TERMINAL_GENERATION,
			seq: 9,
			code: null,
			signal: "SIGINT",
		});
		for (const refused of [
			{ type: "omp:terminal-exit", generation: TERMINAL_GENERATION, seq: 9, code: 256, signal: null },
			{ type: "omp:terminal-exit", generation: TERMINAL_GENERATION, seq: 9, code: -1, signal: null },
			{ type: "omp:terminal-exit", generation: TERMINAL_GENERATION, seq: 9, code: 1.5, signal: null },
			{ type: "omp:terminal-exit", generation: TERMINAL_GENERATION, seq: 9, code: null, signal: "" },
			{ type: "omp:terminal-exit", generation: TERMINAL_GENERATION, seq: 9, code: null, signal: "SIG\u0000INT" },
		]) {
			assert.equal(parseGuestHostMessage(refused), null, `accepted ${JSON.stringify(refused)}`);
		}
	});
});

describe("parseGuestWebviewMessage terminal frames", () => {
	it("accepts an attach with and without a generation the pane holds", () => {
		const identified = { type: "omp:terminal-attach", generation: TERMINAL_GENERATION, cols: 120, rows: 40 };
		assert.deepEqual(parseGuestWebviewMessage(identified), identified);
		const fresh = { type: "omp:terminal-attach", generation: null, cols: 120, rows: 40 };
		assert.deepEqual(parseGuestWebviewMessage(fresh), fresh);
	});

	it("refuses an attach that names a generation the host could not have minted, or asks for an impossible grid", () => {
		for (const refused of [
			{ type: "omp:terminal-attach", generation: "unknown", cols: 80, rows: 24 },
			{ type: "omp:terminal-attach", generation: null, cols: 0, rows: 24 },
			{ type: "omp:terminal-attach", generation: null, cols: 80, rows: MAX_TERMINAL_ROWS + 1 },
			{ type: "omp:terminal-attach", generation: null, cols: 80.5, rows: 24 },
		]) {
			assert.equal(parseGuestWebviewMessage(refused), null, `accepted ${JSON.stringify(refused)}`);
		}
	});

	it("accepts input up to its byte budget and refuses an over-long or non-base64 one", () => {
		const input = { type: "omp:terminal-input", generation: TERMINAL_GENERATION, data: "A".repeat(MAX_TERMINAL_INPUT_BASE64_CHARS) };
		assert.deepEqual(parseGuestWebviewMessage(input), input);
		assert.equal(parseGuestWebviewMessage({ ...input, data: `${input.data}A` }), null);
		assert.equal(parseGuestWebviewMessage({ ...input, data: "" }), null);
		assert.equal(parseGuestWebviewMessage({ ...input, data: "not base64" }), null);
		assert.equal(parseGuestWebviewMessage({ type: "omp:terminal-input", generation: null, data: "AAAA" }), null);
	});

	it("accepts a resize for a known generation and refuses an impossible grid", () => {
		const resize = { type: "omp:terminal-resize", generation: TERMINAL_GENERATION, cols: 80, rows: 24 };
		assert.deepEqual(parseGuestWebviewMessage(resize), resize);
		assert.equal(parseGuestWebviewMessage({ ...resize, cols: 1 }), null);
		assert.equal(parseGuestWebviewMessage({ ...resize, rows: 0 }), null);
		assert.equal(parseGuestWebviewMessage({ ...resize, generation: null }), null);
	});

	it("requires real focus intent separately from replayed presence", () => {
		assert.deepEqual(parseGuestWebviewMessage({ type: "omp:terminal-focus", focused: true, intent: true }), { type: "omp:terminal-focus", focused: true, intent: true });
		assert.deepEqual(parseGuestWebviewMessage({ type: "omp:terminal-visibility", visible: false }), {
			type: "omp:terminal-visibility",
			visible: false,
		});
		for (const refused of [
			{ type: "omp:terminal-focus", focused: true },
			{ type: "omp:terminal-focus", focused: true, intent: "yes" },
			{ type: "omp:terminal-focus", focused: "yes" },
			{ type: "omp:terminal-focus" },
			{ type: "omp:terminal-visibility", visible: 1 },
			{ type: "omp:terminal-visibility" },
		]) {
			assert.equal(parseGuestWebviewMessage(refused), null, `accepted ${JSON.stringify(refused)}`);
		}
	});
});

/**
 * A regression, and it is the user's own text: a draft that this boundary
 * accepted but could not carry whole would replace a document with part of what the
 * user typed. The bound is checked on the value, so a draft is refused rather than
 * truncated.
 */
describe("draft messages", () => {
	it("accepts a draft exactly as typed, newlines included, and refuses it whole when it is unusable", () => {
		const draft = "first line\n\tindented second line";
		const restore = { type: "omp:draft-restore", requestId: 3, text: draft, attachments: 2, recoverable: [{ text: "original draft", attachments: 1, unconfirmed: true }] };
		assert.deepEqual(parseGuestHostMessage(restore), restore);
		const reply = { ...restore, type: "omp:draft-reply", captured: true };
		assert.deepEqual(parseGuestWebviewMessage(reply), reply);
		const empty = { type: "omp:draft-reply", requestId: 4, captured: false, text: "", attachments: 0, recoverable: [] };
		assert.deepEqual(parseGuestWebviewMessage(empty), empty);

		// A carriage return, a NUL, an over-long value or a negative attachment count is
		// refused as a whole: half a draft is worse than none.
		const plain = { type: "omp:draft-reply", requestId: 1, captured: true, text: "ok", attachments: 0, recoverable: [] };
		for (const refused of [
			{ type: "omp:draft-restore", text: "a\rb" },
			{ type: "omp:draft-restore", text: `a\u0000b` },
			{ type: "omp:draft-restore", text: "x".repeat(MAX_DRAFT_TEXT_LENGTH + 1) },
			{ type: "omp:draft-restore" },
			{ ...plain, text: "a\rb" },
			{ ...plain, attachments: -1 },
			{ ...plain, captured: "true" },
			{ ...plain, recoverable: [{ text: "x".repeat(MAX_DRAFT_TEXT_LENGTH), attachments: 0, unconfirmed: true }] },
			{ ...plain, recoverable: [{ text: "original", attachments: -1, unconfirmed: true }] },
			{ ...plain, recoverable: [{ text: "original", attachments: 0, unconfirmed: "yes" }] },
			{ ...plain, recoverable: undefined },
			{ type: "omp:draft-reply", requestId: 1, captured: true, text: "ok" },
		]) {
			const parsed = parseGuestHostMessage(refused) ?? parseGuestWebviewMessage(refused);
			assert.equal(parsed, null, `accepted ${JSON.stringify(refused)}`);
		}
		assert.equal(parseGuestHostMessage({ type: "omp:draft-request", requestId: 0 })?.type, "omp:draft-request");
		assert.equal(parseGuestHostMessage({ type: "omp:draft-request", requestId: -1 }), null);
		assert.deepEqual(parseGuestHostMessage({ type: "omp:draft-release", requestId: 2 }), { type: "omp:draft-release", requestId: 2 });
		assert.deepEqual(parseGuestWebviewMessage({ type: "omp:draft-restored", requestId: 2 }), { type: "omp:draft-restored", requestId: 2 });
		assert.equal(parseGuestWebviewMessage({ type: "omp:draft-restored", requestId: -1 }), null);
	});
});

describe("composer command boundary", () => {
	it("relays only actions the composer can execute", () => {
		for (const action of ["send-prompt", "stop-turn", "focus-composer"]) {
			assert.deepEqual(parseGuestHostMessage({ type: "omp:webview-action", action }), { type: "omp:webview-action", action });
		}
		assert.equal(parseGuestHostMessage({ type: "omp:webview-action", action: "approve" }), null);
		assert.equal(parseGuestHostMessage({ type: "omp:webview-action" }), null);
	});
});

describe("editor reference insertion boundary", () => {
	it("relays one bounded line of text and nothing that could press Enter or end a paste", () => {
		const text = "@src/a.ts [lines 12-30]";
		assert.deepEqual(parseGuestHostMessage({ type: "omp:insert-text", text }), { type: "omp:insert-text", text });
		for (const bad of ["", "   ", "@a\n@b", "@a\r", "@a\u001b[201~", "x".repeat(901), null, 7]) {
			assert.equal(parseGuestHostMessage({ type: "omp:insert-text", text: bad }), null, JSON.stringify(bad));
		}
		assert.equal(parseGuestHostMessage({ type: "omp:insert-text" }), null);
	});
});

describe("same-editor session view boundary", () => {
	it("accepts only the two explicit modes and bounded truthful lifecycle projections", () => {
		const view = { type: "omp:session-view", mode: "terminal", title: "Native session", running: true, starting: false, stopping: false, canSwitch: true, reason: null };
		assert.deepEqual(parseGuestHostMessage(view), view);
		assert.deepEqual(parseGuestWebviewMessage({ type: "omp:session-mode", mode: "chat" }), { type: "omp:session-mode", mode: "chat" });
		assert.deepEqual(parseGuestWebviewMessage({ type: "omp:session-mode", mode: "terminal" }), { type: "omp:session-mode", mode: "terminal" });
		for (const mode of ["shell", "rpc", "", null, 1]) {
			assert.equal(parseGuestWebviewMessage({ type: "omp:session-mode", mode }), null);
			assert.equal(parseGuestHostMessage({ ...view, mode }), null);
		}
		for (const patch of [{ running: "yes" }, { starting: null }, { stopping: null }, { canSwitch: 1 }, { title: "bad\u0000title" }, { title: "x".repeat(MAX_TERMINAL_TEXT_LENGTH + 1) }, { reason: 7 }]) {
			assert.equal(parseGuestHostMessage({ ...view, ...patch }), null, JSON.stringify(patch));
		}
	});
});

describe("native screen clipboard boundary", () => {
	it("carries Unicode and terminal whitespace whole, but refuses UTF-8 and JSON-escaped overflow", () => {
		const requestId = "e".repeat(32);
		const reply = { type: "omp:terminal-copy-reply", requestId, generation: TERMINAL_GENERATION, text: "screen α🙂\r\n\tend" };
		assert.equal(parseGuestWebviewMessage(reply)?.type, "omp:terminal-copy-reply");
		assert.equal(parseGuestWebviewMessage({ ...reply, text: "🙂".repeat(62_000) }), null);
		assert.equal(parseGuestWebviewMessage({ ...reply, text: "\u0000".repeat(42_000) }), null);
		assert.equal(parseGuestWebviewMessage({ ...reply, requestId: "native output" }), null);
		assert.equal(parseGuestWebviewMessage({ ...reply, text: null })?.type, "omp:terminal-copy-reply");
	});
});

describe("detail tab request boundary", () => {
	it("accepts the three kinds and an agent id only for an agent", () => {
		assert.deepEqual(parseGuestWebviewMessage({ type: "omp:open-detail", kind: "todo" }), { type: "omp:open-detail", kind: "todo" });
		assert.deepEqual(parseGuestWebviewMessage({ type: "omp:open-detail", kind: "agents" }), { type: "omp:open-detail", kind: "agents" });
		assert.deepEqual(parseGuestWebviewMessage({ type: "omp:open-detail", kind: "agent", agentId: "Chat Jitter-2" }), { type: "omp:open-detail", kind: "agent", agentId: "Chat Jitter-2" });
		assert.deepEqual(parseGuestWebviewMessage({ type: "omp:open-detail", kind: "agent", agentId: "pair-\uD83D\uDE00" }), { type: "omp:open-detail", kind: "agent", agentId: "pair-\uD83D\uDE00" });
	});

	it("refuses unknown kinds, missing, empty, oversized or control-character ids and extra fields", () => {
		for (const message of [
			{ type: "omp:open-detail", kind: "plan" },
			{ type: "omp:open-detail" },
			{ type: "omp:open-detail", kind: "agent" },
			{ type: "omp:open-detail", kind: "agent", agentId: "" },
			{ type: "omp:open-detail", kind: "agent", agentId: "x".repeat(257) },
			{ type: "omp:open-detail", kind: "agent", agentId: "bad\u0000id" },
			{ type: "omp:open-detail", kind: "agent", agentId: "lone\uD800surrogate" },
			{ type: "omp:open-detail", kind: "agent", agentId: "lone\uDC00surrogate" },
			{ type: "omp:open-detail", kind: "todo", agentId: "Anna" },
			{ type: "omp:open-detail", kind: "agents", sessionFile: "D:\\secret.jsonl" },
		]) assert.equal(parseGuestWebviewMessage(message), null, JSON.stringify(message));
	});
});
