import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGuestWebviewMessage } from "./messages.ts";
import { PAGE_EVENT_RING_SIZE, PAGE_LONG_TASK_SCRIPTS } from "./page-health.ts";

const beat = { type: "omp:page-health", reason: "beat", seq: 3, visible: true, lateMs: 12, events: [{ kind: "rx:omp:chat-event", count: 40, agoMs: 5 }, { kind: "key", count: 1, agoMs: 0 }] };
const longTask = {
	...beat,
	reason: "long-task",
	longTask: {
		durationMs: 1300,
		name: "self",
		container: "window",
		scripts: [{ invoker: "event-listener:BUTTON.onclick", source: "guest.js:812345", fn: "renderRows", durationMs: 1250 }],
	},
};

describe("the page health report", () => {
	it("carries a beat through the guest vocabulary with every field it names", () => {
		assert.deepEqual(parseGuestWebviewMessage(beat), beat);
		assert.deepEqual(parseGuestWebviewMessage({ ...beat, reason: "visibility", visible: false, events: [] }), { ...beat, reason: "visibility", visible: false, events: [] });
	});

	it("carries a long task with its attribution, and drops a field the page invented", () => {
		assert.deepEqual(parseGuestWebviewMessage(longTask), longTask);
		assert.deepEqual(parseGuestWebviewMessage({ ...beat, text: "hello", conversation: "tab:b" }), beat);
	});

	it("requires a long task exactly for the long-task reason", () => {
		assert.equal(parseGuestWebviewMessage({ ...longTask, longTask: undefined }), null);
		assert.equal(parseGuestWebviewMessage({ ...beat, longTask: longTask.longTask }), null);
	});

	it("refuses an unknown reason, a field of the wrong kind and a number out of range", () => {
		for (const bad of [
			{ ...beat, reason: "frozen" },
			{ ...beat, reason: "constructor" },
			{ ...beat, seq: -1 },
			{ ...beat, seq: 1.5 },
			{ ...beat, seq: 2_147_483_648 },
			{ ...beat, visible: "yes" },
			{ ...beat, lateMs: 86_400_001 },
			{ ...beat, lateMs: Number.NaN },
			{ ...beat, events: "none" },
			{ ...beat, events: [{ kind: "key", count: 0, agoMs: 0 }] },
			{ ...beat, events: [{ kind: "key", count: 1, agoMs: -1 }] },
			{ ...beat, events: [{ kind: "key", count: 1 }] },
		]) assert.equal(parseGuestWebviewMessage(bad), null, JSON.stringify(bad));
	});

	it("bounds the ring and the scripts", () => {
		const entry = { kind: "key", count: 1, agoMs: 0 };
		assert.notEqual(parseGuestWebviewMessage({ ...beat, events: Array.from({ length: PAGE_EVENT_RING_SIZE }, () => entry) }), null);
		assert.equal(parseGuestWebviewMessage({ ...beat, events: Array.from({ length: PAGE_EVENT_RING_SIZE + 1 }, () => entry) }), null);
		const script = longTask.longTask.scripts[0]!;
		assert.notEqual(parseGuestWebviewMessage({ ...longTask, longTask: { ...longTask.longTask, scripts: Array.from({ length: PAGE_LONG_TASK_SCRIPTS }, () => script) } }), null);
		assert.equal(parseGuestWebviewMessage({ ...longTask, longTask: { ...longTask.longTask, scripts: Array.from({ length: PAGE_LONG_TASK_SCRIPTS + 1 }, () => script) } }), null);
	});

	it("takes an event kind from a closed list or a host message type, and nothing else", () => {
		const withKind = (kind: string) => ({ ...beat, events: [{ kind, count: 1, agoMs: 0 }] });
		for (const kind of ["render", "key", "pointer", "input", "paste", "drop", "visible", "hidden", "rx:other", "rx:omp:chat-snapshot", `rx:omp:${"a".repeat(40)}`]) {
			assert.notEqual(parseGuestWebviewMessage(withKind(kind)), null, kind);
		}
		for (const kind of ["hello world", "key\nrender", "a\u0000b", "<script>", "say \"hi\"", "", "ключ", "scroll", "rx:omp:Upper", "rx:omp:", `rx:omp:${"a".repeat(41)}`, "rx:other2", "rx:custom:x", "Key"]) {
			assert.equal(parseGuestWebviewMessage(withKind(kind)), null, JSON.stringify(kind));
		}
	});

	it("takes a long task's name and container from the browser's fixed values", () => {
		const patched = (patch: Record<string, unknown>) => ({ ...longTask, longTask: { ...longTask.longTask, ...patch } });
		for (const name of ["self", "same-origin-ancestor", "cross-origin-unreachable", "multiple-contexts", "unknown"]) assert.notEqual(parseGuestWebviewMessage(patched({ name })), null, name);
		for (const name of ["two words", "custom", "Self", ""]) assert.equal(parseGuestWebviewMessage(patched({ name })), null, JSON.stringify(name));
		for (const container of ["window", "iframe", "embed", "object"]) assert.notEqual(parseGuestWebviewMessage(patched({ container })), null, container);
		for (const container of ["a b", "tab", "", 3]) assert.equal(parseGuestWebviewMessage(patched({ container })), null, JSON.stringify(container));
		assert.notEqual(parseGuestWebviewMessage(patched({ container: undefined })), null, "a task with no container");
	});

	it("takes a script from shapes this extension defines: no URL, folder, element identity, text or unknown invoker type", () => {
		const withScript = (patch: Record<string, unknown>) => ({ ...longTask, longTask: { ...longTask.longTask, scripts: [{ ...longTask.longTask.scripts[0]!, ...patch }] } });
		for (const good of [
			{ invoker: "-" }, { invoker: "user-callback:TimerHandler:setTimeout" }, { invoker: "resolve-promise:Promise.then" }, { invoker: "classic-script:-" },
			{ invoker: "module-script:-" }, { invoker: "event-listener:Window.onmessage" }, { source: "-" }, { source: "guest.js" }, { fn: "-" }, { fn: "$a_1" },
		]) assert.notEqual(parseGuestWebviewMessage(withScript(good)), null, JSON.stringify(good));
		for (const bad of [
			{ source: "C:\\Users\\someone\\guest.js:1" },
			{ source: "folder/guest.js:1" },
			{ source: "https://host/guest.js" },
			{ source: "guest.js:12345678901" },
			{ source: "x".repeat(49) },
			{ fn: "has space" },
			{ fn: "1abc" },
			{ fn: "a".repeat(49) },
			{ invoker: "x".repeat(65) },
			{ invoker: "event-listener:IMG[src=data:image/svg+xml" },
			{ invoker: "event-listener:BUTTON#private-title.onclick" },
			{ invoker: "mystery-type:Promise.then" },
			{ invoker: "has space" },
			{ invoker: "" },
		]) assert.equal(parseGuestWebviewMessage(withScript(bad)), null, JSON.stringify(bad));
	});
});
