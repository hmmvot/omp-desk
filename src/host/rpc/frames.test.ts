/**
 * Behavioral tests for rpc-ui framing: UTF-8 line splitting, v2 chunk reassembly, and the reattach rule that a
 * chunk train may begin mid-way. Runner: `node --test src/host/rpc/frames.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RPC_CHUNK_PAYLOAD_BYTES, RpcFrameDecoder, RpcFrameReader, Utf8LineSplitter } from "./frames.ts";

/** The physical lines OMP writes for one logical frame in protocol v2 (`byteLength` must be >= 1 MiB). */
function chunkLines(frame: Record<string, unknown>, chunkId = "c1"): string[] {
	const bytes = Buffer.from(JSON.stringify(frame), "utf8");
	const count = Math.ceil(bytes.length / RPC_CHUNK_PAYLOAD_BYTES);
	const lines: string[] = [];
	for (let index = 0; index < count; index += 1) {
		lines.push(
			JSON.stringify({
				type: "rpc_chunk",
				chunkId,
				index,
				count,
				byteLength: bytes.length,
				data: bytes.subarray(index * RPC_CHUNK_PAYLOAD_BYTES, (index + 1) * RPC_CHUNK_PAYLOAD_BYTES).toString("base64"),
			}),
		);
	}
	return lines;
}

const BIG = { type: "response", id: "int:1", command: "get_entries", success: true, data: { pad: "é✓".repeat(400_000) } };

describe("Utf8LineSplitter", () => {
	it("does not cut a multi-byte character that straddles two chunks", () => {
		const splitter = new Utf8LineSplitter();
		const bytes = Buffer.from('{"t":"é✓ 🙂"}\n{"t":2}\n', "utf8");
		const lines: string[] = [];
		for (let index = 0; index < bytes.length; index += 1) lines.push(...splitter.push(bytes.subarray(index, index + 1)));
		assert.deepEqual(lines, ['{"t":"é✓ 🙂"}', '{"t":2}']);
	});

	it("holds an incomplete last line and strips a carriage return", () => {
		const splitter = new Utf8LineSplitter();
		assert.deepEqual(splitter.push(Buffer.from("one\r\ntw")), ["one"]);
		assert.deepEqual(splitter.push(Buffer.from("o\n")), ["two"]);
	});

	it("drops an oversize line whole, counts it, and keeps the next line", () => {
		const splitter = new Utf8LineSplitter(16);
		const lines = splitter.push(Buffer.from(`${"x".repeat(40)}\nok\n`));
		assert.deepEqual(lines, ["ok"]);
		assert.equal(splitter.oversizeLines, 1);
		// The overflow can also straddle chunks.
		assert.deepEqual(splitter.push(Buffer.from("y".repeat(20))), []);
		assert.deepEqual(splitter.push(Buffer.from("y".repeat(20))), []);
		assert.deepEqual(splitter.push(Buffer.from("\nagain\n")), ["again"]);
		assert.equal(splitter.oversizeLines, 2);
	});
});

describe("RpcFrameDecoder", () => {
	it("reassembles a chunk train into the logical frame", () => {
		const decoder = new RpcFrameDecoder();
		const lines = chunkLines(BIG);
		assert.ok(lines.length >= 4);
		const results = lines.map(line => decoder.push(JSON.parse(line)));
		assert.deepEqual(results.slice(0, -1), new Array(lines.length - 1).fill(undefined));
		assert.deepEqual(results.at(-1), BIG);
		assert.equal(decoder.inTrain, false);
	});

	it("passes an ordinary frame through and rejects one that interrupts a train", () => {
		const decoder = new RpcFrameDecoder();
		assert.deepEqual(decoder.push({ type: "agent_start" }), { type: "agent_start" });
		const lines = chunkLines(BIG);
		decoder.push(JSON.parse(lines[0]!));
		assert.throws(() => decoder.push({ type: "agent_start" }), /interrupted/);
		assert.equal(decoder.inTrain, false, "an error leaves no partial train");
	});

	it("rejects a train that does not start at index 0, bad base64, and a length mismatch", () => {
		const lines = chunkLines(BIG);
		assert.throws(() => new RpcFrameDecoder().push(JSON.parse(lines[1]!)), /index 0/);
		const bad = { ...JSON.parse(lines[0]!), data: "***" };
		assert.throws(() => new RpcFrameDecoder().push(bad), /chunk data/);
		const decoder = new RpcFrameDecoder();
		const short = lines.map(line => JSON.parse(line) as Record<string, unknown>);
		short[1] = { ...short[1], data: Buffer.from("abcd").toString("base64") };
		assert.throws(() => {
			for (const chunk of short) decoder.push(chunk);
		}, /length mismatch|exceeds/);
	});
});

describe("RpcFrameReader", () => {
	it("counts stray stdout and broken JSON separately and keeps reading", () => {
		const reader = new RpcFrameReader();
		assert.deepEqual(reader.pushLine("hello from an extension"), { kind: "stray" });
		assert.deepEqual(reader.pushLine("{oops"), { kind: "error", error: "parse" });
		assert.deepEqual(reader.pushLine('{"type":"agent_start"}'), { kind: "frame", frame: { type: "agent_start" } });
		assert.deepEqual({ ...reader.counters }, { frames: 1, strayLines: 1, parseErrors: 1, chunkErrors: 0, droppedChunks: 0 });
	});

	it("drops mid-train chunks after a reset until an index-0 chunk, then decodes the next whole train", () => {
		const reader = new RpcFrameReader();
		const first = chunkLines(BIG, "old");
		// A reattach begins in the middle of a train whose head was not retained.
		reader.reset();
		for (const line of first.slice(2)) assert.deepEqual(reader.pushLine(line), { kind: "none" });
		assert.equal(reader.counters.droppedChunks, first.length - 2);
		const second = chunkLines({ ...BIG, id: "int:2" }, "new");
		let result = reader.pushLine(second[0]!);
		for (const line of second.slice(1)) result = reader.pushLine(line);
		assert.equal(result.kind, "frame");
		assert.equal(result.kind === "frame" && result.frame.id, "int:2");
		assert.equal(reader.counters.chunkErrors, 0);
	});

	it("reports a chunk-contract violation once and resumes dropping until the next train start", () => {
		const reader = new RpcFrameReader();
		const lines = chunkLines(BIG);
		reader.pushLine(lines[0]!);
		assert.deepEqual(reader.pushLine('{"type":"agent_start"}'), { kind: "error", error: "chunk" });
		assert.deepEqual(reader.pushLine(lines[2]!), { kind: "none" });
		assert.equal(reader.counters.chunkErrors, 1);
		assert.deepEqual(reader.pushLine('{"type":"agent_start"}'), { kind: "frame", frame: { type: "agent_start" } });
	});
});
