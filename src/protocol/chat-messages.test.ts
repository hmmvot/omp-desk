/**
 * Tests for the boundary that carries the host-owned chat: what the page accepts from the
 * host, what the host accepts from the page, and the chunked snapshot transport.
 *
 * The regressions defended are the silent ones. A dialog shape the page cannot render must
 * be refused (a page that swallowed it would leave OMP waiting for an answer nobody can
 * give), a page command naming two answers must be refused (the host could not settle it
 * unambiguously), and a snapshot must never be applied half-assembled (the user would see a
 * transcript with a hole in it that looks complete).
 *
 * Runner: `node --test src/protocol/chat-messages.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { MAX_ATTACH_ITEMS } from "../shared/attach-limits.ts";
import { createChatModel, reduceChatFrame, snapshotOf } from "../chat/model.ts";
import type { ChatSnapshotPayload } from "../chat/model.ts";
import {
	ChatSnapshotAssembler,
	MAX_CHAT_IMAGE_BASE64_CHARS,
	MAX_CHAT_IMAGES_BASE64_CHARS,
	MAX_CHAT_IMAGE_BYTES,
	MAX_CHAT_IMAGES_BYTES,
	MAX_CHAT_TEXT_LENGTH,
	isChatRequestId,
	parseChatEventFrame,
	parseChatUiRequest,
	parseChatHostMessage,
	parseChatWebviewMessage,
	splitChatSnapshot,
} from "./chat-messages.ts";
import { PTY_RPC_MAX_WRITE_BYTES } from "../host/pty-protocol.ts";

const EPOCH = { nonce: "host-a", counter: 1 };
const REQUEST_ID = "0123456789abcdef0123456789abcdef";
const PNG = "iVBORw0KGgo=";

/** Send a value through JSON the way `postMessage` does, so `undefined` fields vanish. */
function wire(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

function row(id: string, text = "hello"): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-29T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1_700_000_000_000 },
	};
}

function payload(entries: readonly SessionEntry[], patch: Partial<ChatSnapshotPayload> = {}): ChatSnapshotPayload {
	return { ...snapshotOf(createChatModel(), EPOCH), phase: "live", entries, ...patch };
}

describe("isChatRequestId", () => {
	it("accepts only the 128-bit lowercase hex the page mints", () => {
		assert.equal(isChatRequestId(REQUEST_ID), true);
		for (const refused of ["", REQUEST_ID.slice(1), `${REQUEST_ID}0`, REQUEST_ID.toUpperCase(), 7, null, undefined]) {
			assert.equal(isChatRequestId(refused), false, String(refused));
		}
	});
});

describe("command argument metadata", () => {
	it("retains usage at the page boundary and refuses oversized or malformed usage", () => {
		const command = {name:"mcp",inputHint:"<action>",subcommands:[{name:"add",description:"Add server",usage:"/mcp add <name>"}]};
		assert.deepEqual(parseChatEventFrame({type:"available_commands_update",commands:[command]}), {type:"available_commands_update",commands:[command]});
		for (const usage of [7, "x".repeat(501)]) assert.equal(parseChatEventFrame({type:"available_commands_update",commands:[{...command,subcommands:[{name:"add",usage}]}]}), null);
	});
});

describe("parseChatHostMessage", () => {
	const state = {
		type: "omp:chat-state",
		epoch: EPOCH,
		phase: "view-only",
		code: null,
		sessionId: "s1",
		cwd: "D:/w",
		title: null,
		readOnlyReason: "stopped",
	};

	it("accepts a state and drops undeclared fields", () => {
		assert.deepEqual(parseChatHostMessage({ ...state, extra: 1 }), state);
	});

	it("carries the pending operation of a tab as closed ids and numbers, and refuses anything else", () => {
		const running = { type: "omp:chat-operation", operation: { kind: "resume", step: "ownership", elapsedMs: 1200, requestId: REQUEST_ID, still: false } };
		assert.deepEqual(parseChatHostMessage({ ...running, extra: 1 }), running);
		assert.deepEqual(parseChatHostMessage({ type: "omp:chat-operation", operation: null }), { type: "omp:chat-operation", operation: null });
		const ended = { type: "omp:chat-operation", operation: null, ended: { kind: "resume", requestId: null, status: "refused" } };
		assert.deepEqual(parseChatHostMessage(ended), ended);
		for (const patch of [
			{ operation: { ...running.operation, kind: "reboot" } },
			{ operation: { ...running.operation, step: "somewhere" } },
			{ operation: { ...running.operation, elapsedMs: -1 } },
			{ operation: { ...running.operation, elapsedMs: Number.NaN } },
			{ operation: { ...running.operation, requestId: "not a request id with spaces" } },
			{ operation: { ...running.operation, still: "no" } },
			{ operation: undefined },
			{ ended: { kind: "resume", requestId: null, status: "exploded" } },
		]) {
			assert.equal(parseChatHostMessage({ ...running, ...patch }), null, JSON.stringify(patch));
		}
	});

	it("refuses a phase or epoch the page does not know instead of guessing", () => {
		assert.equal(parseChatHostMessage({ ...state, phase: "running" }), null);
		assert.equal(parseChatHostMessage({ ...state, epoch: { nonce: "", counter: 1 } }), null);
		assert.equal(parseChatHostMessage({ ...state, epoch: { nonce: "h", counter: -1 } }), null);
		assert.equal(parseChatHostMessage({ ...state, epoch: undefined }), null);
		assert.equal(parseChatHostMessage({ ...state, readOnlyReason: 5 }), null);
	});

	it("carries a dialog of each renderable method and refuses one it cannot render", () => {
		const requests = [
			{ id: "d1", method: "select", title: "Pick", options: [{ label: "a" }, { label: "b", description: "second" }] },
			{ id: "d2", method: "confirm", title: "Sure?", message: "really" },
			{ id: "d3", method: "input", title: "Name", placeholder: "x" },
			{ id: "d4", method: "editor", title: "Edit", prefill: "text" },
		];
		for (const request of requests) {
			const parsed = parseChatHostMessage({ type: "omp:chat-ui-request", epoch: EPOCH, request });
			assert.deepEqual(parsed, { type: "omp:chat-ui-request", epoch: EPOCH, request });
		}
		for (const request of [
			{ id: "d5", method: "notify", title: "t" },
			{ id: "", method: "confirm", title: "t", message: "m" },
			{ id: "d6", method: "select", title: "t", options: [{ label: 5 }] },
			{ id: "d7", method: "select", title: "t", options: "a" },
			{ id: "d8", method: "confirm", title: "t" },
		]) {
			assert.equal(parseChatHostMessage({ type: "omp:chat-ui-request", epoch: EPOCH, request }), null, JSON.stringify(request));
		}
	});

	it("carries only a correlated text-admission status, without trusting undeclared host prose", () => {
		for (const status of ["accepted", "refused", "unconfirmed", "explained"]) {
			const message = { type: "omp:chat-send-result", epoch: EPOCH, requestId: REQUEST_ID, status };
			assert.deepEqual(parseChatHostMessage({ ...message, reason: "untrusted details", extra: 1 }), message);
			for (const patch of [{ requestId: "" }, { requestId: 7 }, { status: "running" }, { status: true }, { epoch: null }]) {
				assert.equal(parseChatHostMessage({ ...message, ...patch }), null);
			}
		}
	});

	it("carries a Stop's hand-back of queued messages, bounded, with what could not be carried flagged", () => {
		const message = { type: "omp:chat-abort-result", epoch: EPOCH, requestId: REQUEST_ID, status: "accepted", entries: [{ text: "steer" }, { text: "follow", images: [{ type: "image", mimeType: "image/png", data: "AA==" }] }], truncated: true };
		assert.deepEqual(parseChatHostMessage(message), message);
		assert.deepEqual(parseChatHostMessage({ ...message, entries: [{ text: "x", images: "nope" }] }), { ...message, entries: [{ text: "x" }], imagesDropped: true }, "an unreadable image is reported dropped, the text kept");
		assert.deepEqual(parseChatHostMessage({ ...message, status: "refused", entries: [], truncated: undefined }), { type: "omp:chat-abort-result", epoch: EPOCH, requestId: REQUEST_ID, status: "refused", entries: [] });
		assert.equal(parseChatHostMessage({ ...message, status: "refused" }), null, "a refused stop withdrew nothing");
		assert.equal(parseChatHostMessage({ ...message, entries: Array.from({ length: 65 }, () => ({ text: "x" })) }), null);
		assert.equal(parseChatHostMessage({ ...message, entries: [{ text: 7 }] }), null);
	});

	it("carries promotion results and the remembered transcript defaults", () => {
		const result = { type: "omp:chat-queue-result", epoch: EPOCH, requestId: REQUEST_ID, purpose: "promote", results: [{ status: "removed" }, { status: "gone" }] };
		assert.deepEqual(parseChatHostMessage(result), result);
		assert.equal(parseChatHostMessage({ ...result, purpose: "send" }), null);
		const preferences = { type: "omp:chat-display-preferences", epoch: EPOCH, toolCallDetail: "overview", accessibilitySupport: false, thinkingExpanded: true, toolsMode: "groups" };
		assert.deepEqual(parseChatHostMessage(preferences), preferences);
		assert.equal(parseChatHostMessage({ ...preferences, thinkingExpanded: "yes" }), null);
		assert.equal(parseChatHostMessage({ ...preferences, toolsMode: true }), null, "the old boolean is not a mode");
		assert.equal(parseChatHostMessage({ ...preferences, toolsMode: "everything" }), null);
		assert.deepEqual(parseChatHostMessage({ ...preferences, toolIntent: true }), { ...preferences, toolIntent: true }, "the tool-intent setting rides along");
		assert.equal(parseChatHostMessage({ ...preferences, toolIntent: "on" }), null);
	});

	it("carries the effective key of each empty-state command with its conflicts, drops undeclared fields, and refuses the rest whole", () => {
		const keys = { type: "omp:chat-keys", keys: [
			{ command: "ompDesk.toggleThinking", key: "Alt+T", conflicts: [{ by: "IntelliJ IDEA Keymap", command: "git.sync" }], more: 2 },
			{ command: "ompDesk.stopTurn", key: null, conflicts: [], more: 0 },
		] };
		assert.deepEqual(parseChatHostMessage({ ...keys, extra: 1 }), keys);
		assert.deepEqual(parseChatHostMessage({ type: "omp:chat-keys", keys: [] }), { type: "omp:chat-keys", keys: [] });
		const [first] = keys.keys;
		const bad = (patch: Record<string, unknown>) => ({ ...keys, keys: [{ ...first, ...patch }] });
		for (const message of [
			{ ...keys, keys: "Alt+T" },
			bad({ command: "workbench.action.quit" }),
			bad({ key: 7 }),
			bad({ key: "Alt+\nT" }),
			bad({ key: "" }),
			bad({ conflicts: [{ by: "x", command: "y" }, { by: "x", command: "y" }, { by: "x", command: "y" }, { by: "x", command: "y" }] }),
			bad({ conflicts: [{ by: 3, command: "y" }] }),
			bad({ conflicts: [{ by: "x", command: "y\u001b" }] }),
			bad({ more: -1 }),
			{ ...keys, keys: [first, first] },
		]) {
			assert.equal(parseChatHostMessage(message), null, JSON.stringify(message).slice(0, 100));
		}
	});

	it("requires a target id to withdraw a dialog", () => {
		assert.equal(parseChatHostMessage({ type: "omp:chat-ui-cancel", epoch: EPOCH }), null);
	});

	it("refuses a frame of a type this page does not know, and a malformed message frame", () => {
		assert.equal(parseChatHostMessage({ type: "omp:chat-event", epoch: EPOCH, frame: { type: "from_the_future" } }), null);
		assert.equal(
			parseChatHostMessage({ type: "omp:chat-event", epoch: EPOCH, frame: { type: "message_start", messageId: "m1", message: { role: "assistant" } } }),
			null,
		);
	});

	it("refuses rows without an id or with an unrenderable message instead of dropping them silently", () => {
		const entries = { type: "omp:chat-entries", epoch: EPOCH, leafId: "a", entries: [row("a")] };
		assert.equal(parseChatHostMessage({ ...entries, entries: [{ ...row("a"), id: "" }] }), null);
		assert.equal(parseChatHostMessage({ ...entries, entries: [{ ...row("a"), message: { role: "user" } }] }), null);
		assert.equal(parseChatHostMessage({ ...entries, entries: "a" }), null);
		assert.equal(parseChatHostMessage({ type: "omp:chat-older", epoch: EPOCH, entries: [row("a")], olderCount: -1 }), null);
	});

	it("refuses anything that is not an omp:chat message", () => {
		assert.equal(parseChatHostMessage({ type: "omp:connect", link: "x" }), null);
		assert.equal(parseChatHostMessage("omp:chat-state"), null);
		assert.equal(parseChatHostMessage(null), null);
	});
});

describe("parseChatWebviewMessage", () => {
	it("accepts a prompt, steer and follow-up with text alone", () => {
		for (const type of ["omp:chat-prompt", "omp:chat-steer", "omp:chat-follow-up"]) {
			assert.deepEqual(parseChatWebviewMessage({ type, requestId: REQUEST_ID, text: "go", extra: 1 }), {
				type,
				requestId: REQUEST_ID,
				text: "go",
			});
		}
	});

	it("refuses a command without a minted request id", () => {
		for (const requestId of [undefined, "abc", "1", REQUEST_ID.toUpperCase(), 3]) {
			assert.equal(parseChatWebviewMessage({ type: "omp:chat-abort", requestId }), null, String(requestId));
		}
	});

	it("refuses a message that asks OMP for nothing or for too much", () => {
		assert.equal(parseChatWebviewMessage({ type: "omp:chat-prompt", requestId: REQUEST_ID, text: "   " }), null);
		assert.equal(parseChatWebviewMessage({ type: "omp:chat-prompt", requestId: REQUEST_ID, text: 4 }), null);
		assert.equal(
			parseChatWebviewMessage({ type: "omp:chat-prompt", requestId: REQUEST_ID, text: "x".repeat(MAX_CHAT_TEXT_LENGTH + 1) }),
			null,
		);
	});

	it("accepts an image-only message and holds images to their format and budget", () => {
		const image = { type: "image", mimeType: "image/png", data: PNG };
		assert.deepEqual(parseChatWebviewMessage({ type: "omp:chat-prompt", requestId: REQUEST_ID, text: "", images: [image] }), {
			type: "omp:chat-prompt",
			requestId: REQUEST_ID,
			text: "",
			images: [image],
		});
		const refused = [
			[],
			[{ ...image, mimeType: "image/svg+xml" }],
			[{ ...image, data: "not base64!" }],
			[{ ...image, data: "" }],
			[{ ...image, data: "A".repeat(MAX_CHAT_IMAGE_BASE64_CHARS + 4) }],
			Array.from({ length: MAX_ATTACH_ITEMS + 1 }, () => image),
			"image",
		];
		for (const images of refused) {
			assert.equal(parseChatWebviewMessage({ type: "omp:chat-prompt", requestId: REQUEST_ID, text: "x", images }), null);
		}
	});

	it("accepts as many images as the structural guard allows, whatever their count, and refuses one more", () => {
		const image = { type: "image", mimeType: "image/png", data: PNG };
		const prompt = (count: number) => parseChatWebviewMessage({ type: "omp:chat-prompt", requestId: REQUEST_ID, text: "x", images: Array.from({ length: count }, () => image) });
		const full = prompt(MAX_ATTACH_ITEMS);
		assert.ok(full !== null && full.type === "omp:chat-prompt");
		assert.equal(full.images?.length, MAX_ATTACH_ITEMS);
		assert.notEqual(prompt(9), null, "nine images are no longer over a count rule");
		assert.equal(prompt(MAX_ATTACH_ITEMS + 1), null);
	});

	it("accepts a full byte budget carried by the most images the guard allows, though each rounds up to a base64 group", () => {
		// Two large images and the rest one byte each: every 1-byte image costs 4 characters for 1 byte, so the total passes
		// the sum of the bytes' own base64 and only the rounding slack of the bound lets the prompt through.
		const small = MAX_ATTACH_ITEMS - 2;
		const large = Math.floor((MAX_CHAT_IMAGES_BYTES - small) / 2);
		assert.ok(large <= MAX_CHAT_IMAGE_BYTES, "each large image is within its own budget");
		const image = (bytes: number) => ({ type: "image", mimeType: "image/png", data: Buffer.alloc(bytes, 7).toString("base64") });
		const images = [image(large), image(large), ...Array.from({ length: small }, () => image(1))];
		const chars = images.reduce((sum, { data }) => sum + data.length, 0);
		assert.ok(chars > Math.ceil(MAX_CHAT_IMAGES_BYTES / 3) * 4, "this set is over the unpadded base64 of the budget, the case the slack exists for");
		assert.ok(chars <= MAX_CHAT_IMAGES_BASE64_CHARS);
		const message = parseChatWebviewMessage({ type: "omp:chat-prompt", requestId: REQUEST_ID, text: "x", images });
		assert.ok(message !== null && message.type === "omp:chat-prompt");
		assert.equal(message.images?.length, MAX_ATTACH_ITEMS);
	});

	it("carries a rewound draft's images whole within the byte budget and counts every image of a set over it as lost", () => {
		const draft = (images: unknown[]) => parseChatHostMessage({ type: "omp:chat-navigate-result", requestId: REQUEST_ID, status: "done", kind: "rewind", summarized: false, draft: { text: "look", images, unavailableImages: 1 } });
		const small = { type: "image", mimeType: "image/png", data: PNG };
		const nine = draft(Array.from({ length: 9 }, () => small));
		assert.ok(nine !== null && nine.type === "omp:chat-navigate-result");
		assert.deepEqual(nine.draft, { text: "look", images: Array.from({ length: 9 }, () => small), unavailableImages: 1 });
		const big = { type: "image", mimeType: "image/png", data: Buffer.alloc(MAX_CHAT_IMAGE_BYTES, 7).toString("base64") };
		const over = draft([big, big, big]);
		assert.ok(over !== null && over.type === "omp:chat-navigate-result");
		assert.deepEqual(over.draft, { text: "look", images: [], unavailableImages: 1 + 3 }, "three 5 MiB images are over the prompt budget: all three are lost, not one");
	});

	it("carries a 5 MiB image and a 10 MiB prompt, refuses one byte over either, and the longest such command fits the broker's stdin line", () => {
		const image = (bytes: number) => ({ type: "image", mimeType: "image/png", data: Buffer.alloc(bytes, 7).toString("base64") });
		const prompt = (images: unknown[]) => parseChatWebviewMessage({ type: "omp:chat-prompt", requestId: REQUEST_ID, text: "x", images });
		const one = image(MAX_CHAT_IMAGE_BYTES);
		assert.deepEqual(prompt([one]), { type: "omp:chat-prompt", requestId: REQUEST_ID, text: "x", images: [one] }, "a 5 MiB image is accepted whole (the base64 check has no recursion depth)");
		assert.equal(prompt([image(MAX_CHAT_IMAGE_BYTES + 3)]), null, "one base64 group over its bound");
		const half = image(MAX_CHAT_IMAGES_BYTES / 2);
		assert.notEqual(prompt([half, half]), null, "two 5 MiB images are exactly the prompt budget");
		assert.notEqual(prompt([half, half, image(3)]), null, "a base64 group over the budget fits the rounding slack the guard of 1000 images can add up to");
		assert.equal(prompt([half, half, image(3 * 1001)]), null, "more than that slack over the prompt budget is refused");
		assert.equal(prompt([one, one, one]), null, "three 5 MiB images are over the prompt budget though each is within its own");
		// The command OMP receives for the largest admissible prompt: the longest text with every character escaped to six bytes,
		// and the whole base64 bound carried by the most images the guard allows.
		const groups = MAX_CHAT_IMAGES_BASE64_CHARS / 4;
		const perImage = Math.floor(groups / MAX_ATTACH_ITEMS);
		const extra = groups - perImage * MAX_ATTACH_ITEMS;
		const line = JSON.stringify({
			id: `vsc:${"f".repeat(32)}`,
			type: "prompt",
			message: "\u0001".repeat(MAX_CHAT_TEXT_LENGTH),
			images: Array.from({ length: MAX_ATTACH_ITEMS }, (_, index) => ({ type: "image", data: "A".repeat((perImage + (index < extra ? 1 : 0)) * 4), mimeType: "image/webp" })),
			streamingBehavior: "followUp",
		});
		assert.ok(Buffer.byteLength(line) < PTY_RPC_MAX_WRITE_BYTES, `${Buffer.byteLength(line)} bytes against ${PTY_RPC_MAX_WRITE_BYTES}`);
		assert.ok(PTY_RPC_MAX_WRITE_BYTES - Buffer.byteLength(line) > 512 * 1024, "with room to spare for the fields this test does not model");
	});

	it("accepts exactly canonical base64 and refuses the rest, without a recursion limit", () => {
		const accepted = ["AAAA", "AAA=", "AA==", "iVBORw0KGgo=", "a+/9"];
		const refused = ["", "AAA", "AAAAA", "AA=A", "A===", "=AAA", "AA=\n", "AA A", "AAA*", "AAAA=", "AAAA\u00e9"];
		for (const data of accepted) assert.notEqual(parseChatWebviewMessage({ type: "omp:chat-prompt", requestId: REQUEST_ID, text: "x", images: [{ type: "image", mimeType: "image/png", data }] }), null, data);
		for (const data of refused) assert.equal(parseChatWebviewMessage({ type: "omp:chat-prompt", requestId: REQUEST_ID, text: "x", images: [{ type: "image", mimeType: "image/png", data }] }), null, JSON.stringify(data));
	});

	it("accepts exactly one answer per dialog response", () => {
		const base = { type: "omp:chat-ui-response", requestId: REQUEST_ID };
		assert.deepEqual(parseChatWebviewMessage({ ...base, response: { id: "d1", value: "a" } }), { ...base, response: { id: "d1", value: "a" } });
		assert.deepEqual(parseChatWebviewMessage({ ...base, response: { id: "d1", confirmed: false } }), {
			...base,
			response: { id: "d1", confirmed: false },
		});
		assert.deepEqual(parseChatWebviewMessage({ ...base, response: { id: "d1", cancelled: true } }), {
			...base,
			response: { id: "d1", cancelled: true },
		});
	});

	it("refuses an ambiguous, empty or malformed dialog response", () => {
		const base = { type: "omp:chat-ui-response", requestId: REQUEST_ID };
		for (const response of [
			{ id: "d1" },
			{ id: "d1", value: "a", confirmed: true },
			{ id: "d1", confirmed: true, cancelled: true },
			{ id: "d1", confirmed: "yes" },
			{ id: "d1", cancelled: false },
			{ id: "d1", value: 3 },
			{ value: "a" },
			{ id: "", value: "a" },
			"d1",
		]) {
			assert.equal(parseChatWebviewMessage({ ...base, response }), null, JSON.stringify(response));
		}
	});

	it("carries an ask answer with one entry per question and refuses a malformed one", () => {
		const base = { type: "omp:chat-ui-response", requestId: REQUEST_ID };
		const answers = [{ id: "q1", selectedOptions: ["A"] }, { id: "q2", selectedOptions: [], customInput: "mine" }];
		assert.deepEqual(parseChatWebviewMessage({ ...base, response: { id: "a1", answers } }), { ...base, response: { id: "a1", answers } });
		for (const response of [
			{ id: "a1", answers: [] },
			{ id: "a1", answers: "A" },
			{ id: "a1", answers: [{ id: "q1", selectedOptions: "A" }] },
			{ id: "a1", answers: [{ id: "q1", selectedOptions: [1] }] },
			{ id: "a1", answers: [{ selectedOptions: [] }] },
			{ id: "a1", answers: [{ id: "q1", selectedOptions: [], customInput: 3 }] },
			{ id: "a1", answers, cancelled: true },
			{ id: "a1", answers, value: "x" },
		]) {
			assert.equal(parseChatWebviewMessage({ ...base, response }), null, JSON.stringify(response));
		}
	});

	it("parses an ask request with every question and refuses one it cannot render", () => {
		const question = { id: "q1", question: "Scope?", header: "Scope", multi: false, recommended: 0, options: [{ label: "A", description: "first" }, { label: "B" }] };
		const request = { id: "a1", method: "ask", title: "Scope?", questions: [question] };
		assert.deepEqual(parseChatUiRequest(request), request);
		for (const bad of [
			{ ...request, questions: [] },
			{ ...request, questions: [{ ...question, multi: undefined }] },
			{ ...request, questions: [{ ...question, recommended: 2 }] },
			{ ...request, questions: [{ ...question, options: [{ description: "no label" }] }] },
			{ ...request, questions: "Scope?" },
		]) {
			assert.equal(parseChatUiRequest(bad), null, JSON.stringify(bad));
		}
	});

	it("carries load-older, resume and abort, and refuses a load-older without an anchor", () => {
		assert.deepEqual(parseChatWebviewMessage({ type: "omp:chat-load-older", requestId: REQUEST_ID, beforeId: "e1" }), {
			type: "omp:chat-load-older",
			requestId: REQUEST_ID,
			beforeId: "e1",
		});
		assert.equal(parseChatWebviewMessage({ type: "omp:chat-load-older", requestId: REQUEST_ID }), null);
		assert.deepEqual(parseChatWebviewMessage({ type: "omp:chat-resume", requestId: REQUEST_ID }), {
			type: "omp:chat-resume",
			requestId: REQUEST_ID,
		});
		assert.deepEqual(parseChatWebviewMessage({ type: "omp:chat-reconnect", requestId: REQUEST_ID }), {
			type: "omp:chat-reconnect",
			requestId: REQUEST_ID,
		});
		assert.equal(parseChatWebviewMessage({ type: "omp:chat-reconnect" }), null);
		const restart = { type: "omp:chat-restart", requestId: REQUEST_ID, epoch: EPOCH };
		assert.deepEqual(parseChatWebviewMessage(restart), restart);
		assert.equal(parseChatWebviewMessage({ ...restart, epoch: undefined }), null);
		assert.equal(parseChatWebviewMessage({ ...restart, epoch: { nonce: "", counter: -1 } }), null);
		assert.equal(parseChatWebviewMessage({ type: "omp:connect", requestId: REQUEST_ID }), null);
	});
});

describe("snapshot transport", () => {
	const rows = Array.from({ length: 12 }, (_, index) => row(`e${index}`, "x".repeat(200)));

	it("splits rows across chunks within the byte budget and reassembles them in order", () => {
		const source = payload(rows);
		const { snapshot, chunks } = splitChatSnapshot(source, "snap-1", 1_000);
		assert.ok(chunks.length > 1, "a small budget must split");
		assert.equal(snapshot.chunks, chunks.length);
		for (const chunk of chunks) {
			assert.ok(JSON.stringify(chunk.entries).length <= 1_000 + 300, "a chunk stays near the budget");
		}

		const assembler = new ChatSnapshotAssembler();
		assert.equal(assembler.begin(snapshot), null);
		let complete: ChatSnapshotPayload | null = null;
		// Delivery order is the host's; the page must not depend on it.
		for (const chunk of [...chunks].reverse()) complete = assembler.add(chunk) ?? complete;
		assert.deepEqual(
			complete?.entries.map(entry => entry.id),
			rows.map(entry => entry.id),
		);
		assert.deepEqual(complete?.epoch, EPOCH);
	});

	it("produces messages the page's own parser accepts", () => {
		const { snapshot, chunks } = splitChatSnapshot(payload(rows), "snap-1", 1_000);
		assert.deepEqual(parseChatHostMessage(wire(snapshot)), wire(snapshot));
		for (const chunk of chunks) assert.deepEqual(parseChatHostMessage(wire(chunk)), wire(chunk));
		const unconfirmed = { ...snapshot, head: { ...snapshot.head, unconfirmedClearBoundaryId: "b1" } };
		assert.deepEqual(parseChatHostMessage(wire(unconfirmed)), wire(unconfirmed));
	});

	it("holds a snapshot of no rows as a single message", () => {
		const { snapshot, chunks } = splitChatSnapshot(payload([]), "snap-2");
		assert.equal(chunks.length, 0);
		const applied = new ChatSnapshotAssembler().begin(snapshot);
		assert.deepEqual(applied?.entries, []);
	});

	it("never returns a payload while a chunk is missing", () => {
		const { snapshot, chunks } = splitChatSnapshot(payload(rows), "snap-1", 1_000);
		const assembler = new ChatSnapshotAssembler();
		assembler.begin(snapshot);
		for (const chunk of chunks.slice(0, -1)) assert.equal(assembler.add(chunk), null);
	});

	it("ignores a duplicate chunk, a chunk of another snapshot, and a chunk of another epoch", () => {
		const { snapshot, chunks } = splitChatSnapshot(payload(rows), "snap-1", 1_000);
		const assembler = new ChatSnapshotAssembler();
		assembler.begin(snapshot);
		assert.equal(assembler.add({ ...chunks[0]!, snapshotId: "other" }), null);
		assert.equal(assembler.add({ ...chunks[0]!, epoch: { nonce: "host-b", counter: 1 } }), null);
		assert.equal(assembler.add(chunks[0]!), null);
		assert.equal(assembler.add(chunks[0]!), null, "a repeat must not count as progress");
		let complete: ChatSnapshotPayload | null = null;
		for (const chunk of chunks.slice(1)) complete = assembler.add(chunk) ?? complete;
		assert.equal(complete?.entries.length, rows.length);
	});

	it("drops the chunks of a train a newer snapshot abandoned", () => {
		const first = splitChatSnapshot(payload(rows), "snap-1", 1_000);
		const second = splitChatSnapshot(payload(rows.slice(0, 2)), "snap-2", 1_000);
		const assembler = new ChatSnapshotAssembler();
		assembler.begin(first.snapshot);
		assembler.add(first.chunks[0]!);
		assembler.begin(second.snapshot);
		for (const chunk of first.chunks) assert.equal(assembler.add(chunk), null, "the old train is dead");
		let complete: ChatSnapshotPayload | null = null;
		for (const chunk of second.chunks) complete = assembler.add(chunk) ?? complete;
		assert.equal(complete?.entries.length, 2);
	});

	it("drops a chunk that names no open train", () => {
		const { chunks } = splitChatSnapshot(payload(rows), "snap-1", 1_000);
		assert.equal(new ChatSnapshotAssembler().add(chunks[0]!), null);
	});
});

it("the page stays paused until authoritative all-work idle and retains its completion clock", () => {
	let model = reduceChatFrame(createChatModel(), { type: "agent_start" }, { now: 1000 });
	const apply = (frame: unknown, now: number) => {
		const parsed = parseChatHostMessage(wire({ type: "omp:chat-event", epoch: EPOCH, frame }));
		assert.ok(parsed?.type === "omp:chat-event");
		model = reduceChatFrame(model, parsed.frame, { now });
	};
	apply({ type: "agent_end", awaitingAsyncWork: true, yielded: true, outcome: "stop" }, 2000);
	assert.equal(model.asyncPaused, true, "awaiting-async metadata must survive the host/page boundary");
	assert.equal(model.lastAgentOutcome, "stop");
	const state = { model: null, thinkingLevel: null, isStreaming: false, isCompacting: false, queuedMessageCount: 0, hasPendingAsyncWork: true, isSettled: false };
	apply({ type: "state_update", state, todoSeed: null }, 3000);
	assert.equal(model.settled, false);
	assert.equal(model.displayTurns[0]?.complete, false);
	assert.equal(parseChatHostMessage({ type: "omp:chat-event", epoch: EPOCH, frame: { type: "state_update", state: { ...state, hasPendingAsyncWork: "false" }, todoSeed: null } }), null);
	apply({ type: "state_update", state: { ...state, hasPendingAsyncWork: false, isSettled: true }, todoSeed: null }, 5000);
	assert.equal(model.asyncPaused, false);
	assert.equal(model.displayTurns[0]?.completedAt, 5000);
});
