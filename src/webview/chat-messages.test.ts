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
 * Runner: `node --test src/webview/chat-messages.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { createChatModel, reduceChatFrame, snapshotOf } from "../chat/model.ts";
import type { ChatSnapshotPayload } from "../chat/model.ts";
import {
	ChatSnapshotAssembler,
	MAX_CHAT_IMAGES,
	MAX_CHAT_IMAGE_BASE64_CHARS,
	MAX_CHAT_TEXT_LENGTH,
	isChatRequestId,
	parseChatEventFrame,
	parseChatUiRequest,
	parseChatHostMessage,
	parseChatWebviewMessage,
	splitChatSnapshot,
} from "./chat-messages.ts";

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
		for (const status of ["accepted", "refused", "unconfirmed"]) {
			const message = { type: "omp:chat-send-result", epoch: EPOCH, requestId: REQUEST_ID, status };
			assert.deepEqual(parseChatHostMessage({ ...message, reason: "untrusted details", extra: 1 }), message);
			for (const patch of [{ requestId: "" }, { requestId: 7 }, { status: "running" }, { status: true }, { epoch: null }]) {
				assert.equal(parseChatHostMessage({ ...message, ...patch }), null);
			}
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
			Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => image),
			"image",
		];
		for (const images of refused) {
			assert.equal(parseChatWebviewMessage({ type: "omp:chat-prompt", requestId: REQUEST_ID, text: "x", images }), null);
		}
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
