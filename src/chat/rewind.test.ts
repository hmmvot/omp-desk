import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, ChatEntry, ChatMessage, MessageContent } from "./messages.ts";
import {
	NAVIGATION_MARKER_TYPE,
	branchNodesOf,
	computeBranchPoints,
	encodeNavigateCommand,
	navigateErrorCode,
	navigationMarker,
	parseBranchPoints,
	parseNavigateArgs,
	rewindDraft,
	rewindPreview,
	rewindTargets,
	undoMarker,
	undoOffer,
	leafReaches,
	type BranchNode,
	type NavigateArgs,
} from "./rewind.ts";

const REQUEST = "0123456789abcdef0123456789abcdef";
const at = (n: number): string => new Date(Date.UTC(2026, 9, 9, 10, 0, n)).toISOString();
const message = (id: string, parentId: string | null, body: ChatMessage): ChatEntry => ({ type: "message", id, parentId, timestamp: at(body.timestamp), message: body });
const user = (id: string, parentId: string | null, content: MessageContent, n = 1): ChatEntry => message(id, parentId, { role: "user", timestamp: n, content });
const reply = (id: string, parentId: string | null, text: string): ChatEntry => message(id, parentId, { role: "assistant", timestamp: 2, model: "m", stopReason: "stop", content: [{ type: "text", text }] } as AssistantMessage);
const call = (id: string, parentId: string | null, callId: string, name: string, args: Record<string, unknown>): ChatEntry =>
	message(id, parentId, { role: "assistant", timestamp: 2, model: "m", stopReason: "toolUse", content: [{ type: "toolCall", id: callId, name, arguments: args }] } as AssistantMessage);
const result = (id: string, parentId: string | null, callId: string, name: string): ChatEntry =>
	message(id, parentId, { role: "toolResult", timestamp: 3, toolCallId: callId, toolName: name, isError: false, content: [] } as ChatMessage);
const marker = (id: string, parentId: string | null, data: Record<string, unknown>): ChatEntry =>
	({ type: "custom", id, parentId, timestamp: at(9), customType: NAVIGATION_MARKER_TYPE, data: { v: 1, requestId: REQUEST, kind: "rewind", from: "tip", target: "u2", to: "a1", summarized: false, ...data } }) as unknown as ChatEntry;
const custom = (id: string, parentId: string | null, customType: string): ChatEntry => ({ type: "custom", id, parentId, timestamp: at(9), customType }) as unknown as ChatEntry;

describe("navigate codec", () => {
	const args: NavigateArgs = { v: 1, requestId: REQUEST, kind: "switch", sessionId: "s", expectedLeafId: null, targetId: "t", summarize: true };

	it("round-trips the compare-and-swap request through the command text", () => {
		const text = encodeNavigateCommand(args);
		assert.ok(text.startsWith("/omp-desk-navigate {"));
		assert.deepEqual(parseNavigateArgs(text.slice("/omp-desk-navigate ".length)), args);
	});

	it("refuses anything malformed instead of guessing", () => {
		for (const bad of ["{", "null", "[]", JSON.stringify({ ...args, v: 2 }), JSON.stringify({ ...args, requestId: "ABC" }), JSON.stringify({ ...args, kind: "fork" }),
			JSON.stringify({ ...args, targetId: "" }), JSON.stringify({ ...args, expectedLeafId: 7 }), JSON.stringify({ ...args, summarize: "yes" }), JSON.stringify({ ...args, sessionId: "x".repeat(257) })]) {
			assert.equal(parseNavigateArgs(bad), null, bad);
		}
	});

	it("maps a thrown refusal to its fixed code and any other text to failed", () => {
		assert.equal(navigateErrorCode("omp-desk-navigate:stale"), "stale");
		assert.equal(navigateErrorCode("omp-desk-navigate:unknown-code"), "failed");
		assert.equal(navigateErrorCode("TypeError: x is undefined"), "failed");
		assert.equal(navigateErrorCode(undefined), "failed");
	});
});

describe("navigation marker and Undo", () => {
	it("parses only a well-formed marker", () => {
		assert.deepEqual(navigationMarker(marker("m", "a1", { raced: true })), { id: "m", parentId: "a1", v: 1, requestId: REQUEST, kind: "rewind", from: "tip", target: "u2", to: "a1", summarized: false, raced: true });
		assert.equal(navigationMarker(marker("m", "a1", { requestId: "nope" })), null);
		assert.equal(navigationMarker(marker("m", "a1", { kind: "fork" })), null);
		assert.equal(navigationMarker(custom("m", "a1", "other")), null);
		assert.equal(navigationMarker(reply("a", null, "hi")), null);
	});

	it("offers Undo past session_exit and settings changes after a restart, and not past a conversation entry", () => {
		const branch = [user("u1", null, "one"), reply("a1", "u1", "ok"), marker("m", "a1", {})];
		assert.equal(undoMarker(branch)?.from, "tip");
		const restarted = [...branch, custom("exit", "m", "session_exit"), { type: "model_change", id: "mc", parentId: "exit", timestamp: at(10), model: "p/m" } as unknown as ChatEntry];
		assert.equal(undoMarker(restarted)?.id, "m");
		assert.deepEqual(undoOffer(restarted, "mc"), { markerId: "m", from: "tip", kind: "rewind", summarized: false });
		assert.equal(undoOffer(restarted, "exit"), null, "the loaded branch must end at the leaf");
		assert.equal(undoMarker([...branch, user("u3", "m", "again")]), null);
		assert.equal(undoMarker([...branch.slice(0, 2), marker("m", "a1", { kind: "undo" })]), null, "an Undo is not undone");
		assert.equal(undoMarker([...branch.slice(0, 2), marker("m", "a1", { from: null })]), null);
	});
});

describe("rewind targets, preview and draft", () => {
	const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" };
	const entries = [
		user("u1", null, "first prompt\nsecond line"),
		reply("a1", "u1", "done"),
		user("u2", "a1", [{ type: "text", text: "  \nfix [Image #1, 1x1]" }, image, { type: "image", mimeType: "image/png", data: `blob:sha256:${"a".repeat(64)}` }], 4),
		call("c1", "u2", "e1", "edit", { path: "src/a.ts" }),
		result("r1", "c1", "e1", "edit"),
		call("c2", "r1", "b1", "bash", { command: "npm test" }),
		result("r2", "c2", "b1", "bash"),
		call("c3", "r2", "w1", "write", { path: "src/b.ts" }),
		result("r3", "c3", "w1", "write"),
		reply("a2", "r3", "all done"),
	];

	it("lists the loaded user prompts, oldest first, with a bounded first-line preview", () => {
		assert.deepEqual(rewindTargets(entries).map(target => [target.id, target.preview, target.images]), [["u1", "first prompt", 0], ["u2", "fix [Image #1, 1x1]", 2]]);
		assert.equal(rewindTargets([user("long", null, "x".repeat(400))])[0]!.preview.length, 160);
	});

	it("counts what leaves the branch and names the files changed after the target", () => {
		const preview = rewindPreview(entries, "u2");
		assert.ok(preview !== null);
		assert.equal(preview.prompts, 1);
		assert.deepEqual(preview.files, ["src/a.ts", "src/b.ts"]);
		assert.equal(preview.commands, 1);
		assert.ok(preview.messages >= 2);
		assert.equal(rewindPreview(entries, "missing"), null);
	});

	it("names files from OMP's hashline edit, whose path is only in the patch header and the result", () => {
		const hashline = [
			user("p", null, "add a comment"),
			call("e", "p", "h1", "edit", { i: "Adding comment", input: "[src/greeter.ts#D10F]\nPUT <1:\n+// Greets one person." }),
			message("er", "e", { role: "toolResult", timestamp: 3, toolCallId: "h1", toolName: "edit", isError: false, content: [], details: { op: "update", path: "C:\\demo\\src\\greeter.ts" } }),
			call("m", "er", "h2", "edit", { input: "[src/a.ts#AB12]\nPUT <1:\n+x\n[src/b.ts#CD34]\nPUT <1:\n+y" }),
		];
		assert.deepEqual(rewindPreview(hashline, "p", "C:\\demo")?.files, ["src/greeter.ts", "src/a.ts", "src/b.ts"]);
	});

	it("returns the prompt's text and inline images, counting stored references it could not carry", () => {
		assert.deepEqual(rewindDraft(entries[2]!), { text: "  \nfix [Image #1, 1x1]", images: [image], unavailableImages: 1 });
		assert.deepEqual(rewindDraft(entries[0]!), { text: "first prompt\nsecond line", images: [], unavailableImages: 0 });
		assert.equal(rewindDraft(entries[1]!), null);
	});
});

describe("branch points", () => {
	const node = (id: string, parentId: string | null, role: string | null, preview?: string): BranchNode => ({ id, parentId, role, ...(preview === undefined ? {} : { preview }) });

	it("shows a divergence the user made, rooted at a prompt or at a marker followed by one, with the newest message as the tip", () => {
		// u1 → a1 → [old: u2 → a2 → exit] / [new: m1 → u3 → a3]
		const nodes = [node("u1", null, "user"), node("a1", "u1", "assistant"), node("u2", "a1", "user", "old prompt"), node("a2", "u2", "assistant"), node("exit", "a2", null),
			node("m1", "a1", null), node("u3", "m1", "user"), node("a3", "u3", "assistant")];
		assert.deepEqual(computeBranchPoints(nodes, ["u1", "a1", "m1", "u3", "a3"]), [{ entryId: "a1", branches: [{ tipId: "a2", firstPromptId: "u2", firstPrompt: "old prompt", messages: 2, prompts: 1 }] }]);
		// After Undo the rewound side is the branch: rooted at its marker, then a prompt.
		assert.deepEqual(computeBranchPoints(nodes, ["u1", "a1", "u2", "a2", "exit"])[0]!.branches.map(branch => [branch.tipId, branch.firstPromptId]), [["a3", "u3"]]);
	});

	it("does not show OMP's own pruning: subtrees rooted at an assistant or tool result", () => {
		const nodes = [node("u1", null, "user"), node("a1", "u1", "assistant"), node("discarded", "u1", "assistant"), node("t", "a1", "toolResult"), node("retry", "a1", "toolResult"), node("a2", "t", "assistant")];
		assert.deepEqual(computeBranchPoints(nodes, ["u1", "a1", "t", "a2"]), []);
	});

	it("shows a divergence below OMP's usage record at the reply it follows, merging points that share it", () => {
		// u1 → a1 → usage → [old: u2 → a2] / [new: m1 → u3 → a3 → usage2 → (u4)]
		const nodes = [node("u1", null, "user"), node("a1", "u1", "assistant"), node("usage", "a1", null), node("u2", "usage", "user"), node("a2", "u2", "assistant"),
			node("m1", "usage", null), node("u3", "m1", "user"), node("a3", "u3", "assistant"), node("usage2", "a3", null), node("u4", "usage2", "user"), node("x", "a3", null), node("u5", "x", "user")];
		const points = computeBranchPoints(nodes, ["u1", "a1", "usage", "m1", "u3", "a3", "usage2"]);
		assert.deepEqual(points.map(point => [point.entryId, point.branches.map(branch => branch.tipId)]), [["a1", ["a2"]], ["a3", ["u5", "u4"]]]);
	});

	it("compares the leaf past OMP's usage record only, by native type when Desk parsed it as unknown", () => {
		const usage = { type: "model_usage", id: "mu", parentId: "a1" };
		const branch: object[] = [user("u1", null, "one"), reply("a1", "u1", "ok"), usage];
		assert.equal(leafReaches(branch, "a1"), true);
		assert.equal(leafReaches(branch, "mu"), true);
		assert.equal(leafReaches(branch, "u1"), false, "a conversation entry after the expected leaf is a real change");
		assert.equal(leafReaches([...branch.slice(0, 2), { type: "unknown", nativeType: "model_usage", id: "mu", parentId: "a1" }], "a1"), true);
		assert.equal(leafReaches([...branch.slice(0, 2), marker("m", "a1", {})], "a1"), false, "a navigation is a change");
		assert.equal(leafReaches([], null), true);
		assert.equal(leafReaches([usage], null), true, "a root that is only bookkeeping");
	});

	it("reads the index view of raw entries and validates wire input", () => {
		const raw = [{ type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "hello\nworld" }] } }, { type: "custom", id: "m", parentId: "u1" }];
		assert.deepEqual(branchNodesOf(raw), [{ id: "u1", parentId: null, role: "user", preview: "hello" }, { id: "m", parentId: "u1", role: null }]);
		const wire = [{ entryId: "a1", branches: [{ tipId: "t", firstPromptId: null, messages: 2, prompts: 0 }, { tipId: "", firstPromptId: null, messages: 1, prompts: 0 }, { tipId: "x", firstPromptId: null, messages: 0, prompts: 0 }] }, { entryId: 5, branches: [] }];
		assert.deepEqual(parseBranchPoints(wire), [{ entryId: "a1", branches: [{ tipId: "t", firstPromptId: null, messages: 2, prompts: 0 }] }]);
		assert.deepEqual(parseBranchPoints("nope"), []);
	});
});
