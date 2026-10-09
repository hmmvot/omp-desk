import assert from "node:assert/strict";
import { it } from "node:test";
import { BRIDGE_MAX_PLAINTEXT_BYTES, terminalPushFrame } from "./bridge-protocol.ts";
import { BridgeMessageAssembler, BRIDGE_FRAGMENT_TIMEOUT_MS, BRIDGE_MAX_MESSAGE_BYTES, fragmentBridgeMessage } from "./bridge-fragments.ts";

const route = "a".repeat(32);
const partsOf = (payload: unknown) => [...fragmentBridgeMessage(payload, route)] as Record<string, unknown>[];
const fresh = () => new BridgeMessageAssembler(() => assert.fail("unexpected fragment timeout"));

it("keeps every large tool/image/Unicode fragment under the sealed plaintext ceiling", () => {
	for (const payload of [{ text: "t".repeat(950 * 1024), details: { intact: true } },
		{ type: "image", data: "a".repeat(900 * 1024), mimeType: "image/png" }, { text: "😀".repeat(150_000) }]) {
		const parts = partsOf(payload);
		assert.ok(parts.length > 1);
		const assembler = fresh();
		for (let index = 0; index < parts.length; index++) {
			assert.ok(Buffer.byteLength(terminalPushFrame(new Uint8Array(16), new Uint8Array(16), parts[index])) < BRIDGE_MAX_PLAINTEXT_BYTES);
			const value = assembler.accept(parts[index], route);
			if (index < parts.length - 1) assert.equal(value, null);
			else assert.deepEqual(value, payload);
		}
	}
});

it("passes small DTOs unchanged without opening an assembly", () => {
	const payload = { type: "omp:chat-state", text: "こんにちは😀" };
	assert.deepEqual(partsOf(payload), [payload]);
	assert.deepEqual(fresh().accept(payload, route), payload);
});

it("refuses malformed, stale, oversized and out-of-order fragments and discards their partial row", () => {
	const payload = { text: "x".repeat(300_000) };
	const parts = partsOf(payload);
	for (const bad of [
		{ ...parts[1], index: 0 }, // duplicate start while the first row is incomplete
		{ ...parts[1], messageId: "b".repeat(32) },
		{ ...parts[1], routeGeneration: "b".repeat(32) },
		{ ...parts[1], index: 2 }, // missing middle
		{ ...parts[1], totalBytes: BRIDGE_MAX_MESSAGE_BYTES + 1 },
		{ ...parts[1], parts: 1025 },
		{ ...parts[1], totalBytes: 300_100 },
		{ ...parts[1], data: "!" },
		{ ...parts[1], data: "eA==" },
		{ type: "omp:chat-state" }, // a live push may not interleave one DTO
	]) {
		const assembler = fresh();
		assert.equal(assembler.accept(parts[0], route), null);
		assert.throws(() => assembler.accept(bad, route));
		assert.throws(() => assembler.accept(parts[1], route), "a refused partial must not survive");
		let complete: unknown;
		for (const part of parts) complete = assembler.accept(part, route);
		assert.deepEqual(complete, payload, "a new complete train can be accepted after refusal");
	}
	assert.throws(() => fresh().accept(parts[0], null));
	assert.throws(() => fresh().accept(parts[1], route));
});

it("refuses invalid UTF-8 and JSON without exposing a completed value", () => {
	for (const data of ["/w==", "eA=="]) {
		assert.throws(() => fresh().accept({ type: "omp:bridge-fragment", messageId: "b".repeat(32),
			routeGeneration: route, index: 0, parts: 1, totalBytes: 1, data }, route));
	}
});

it("drops missing final chunks at an absolute deadline and on connection/route reset", context => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	let expired = 0;
	const assembler = new BridgeMessageAssembler(() => expired++);
	const parts = partsOf({ text: "x".repeat(300_000) });
	assert.equal(assembler.accept(parts[0], route), null);
	context.mock.timers.tick(BRIDGE_FRAGMENT_TIMEOUT_MS - 1);
	assert.equal(expired, 0);
	assert.equal(assembler.accept(parts[1], route), null);
	context.mock.timers.tick(1);
	assert.equal(expired, 1, "later chunks must not extend the absolute deadline");
	assert.throws(() => assembler.accept(parts[2], route));
	assert.equal(assembler.accept(parts[0], route), null);
	assembler.reset();
	assert.throws(() => assembler.accept(parts[1], route));
	context.mock.timers.tick(BRIDGE_FRAGMENT_TIMEOUT_MS);
	assert.equal(expired, 1, "reset must cancel the old timer");
	context.mock.timers.reset();
});
