import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { GuestHostMessage, GuestWebviewMessage } from "../../protocol/messages.ts";
import { readLinkedFiles, readTimeoutMs, type ReadTransport } from "./read-linked.ts";

function transport(accept = true): { transport: ReadTransport; posted: GuestWebviewMessage[]; deliver: (message: GuestHostMessage) => void; listeners: () => number } {
	const posted: GuestWebviewMessage[] = [];
	const listeners = new Set<(message: GuestHostMessage) => void>();
	return {
		posted,
		deliver: message => {
			for (const listener of [...listeners]) listener(message);
		},
		listeners: () => listeners.size,
		transport: {
			post: message => {
				posted.push(message);
				return accept;
			},
			subscribe: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
	};
}

const REF = "AbCdEf012345";
const names = new Map([[1, "a.md"], [2, "b.md"]]);

describe("readLinkedFiles", () => {
	it("posts the request with the budget and resolves with the files the matching answer carries, unsubscribing", async () => {
		const t = transport();
		const pending = readLinkedFiles(t.transport, 7, [{ number: 1, ref: REF }], 1000, names);
		assert.deepEqual(t.posted, [{ type: "omp:read-files", requestId: 7, files: [{ number: 1, ref: REF }], budget: 1000 }]);
		t.deliver({ type: "omp:files-read", requestId: 6, files: [], failures: [{ number: 1, name: "x", reason: "stale" }] });
		t.deliver({ type: "omp:files-read", requestId: 7, files: [{ number: 1, label: "docs/a.md", content: "text", dirty: false }], failures: [] });
		const read = await pending;
		assert.equal(read.ok, true);
		assert.deepEqual(read.ok ? [...read.files.entries()] : [], [[1, { number: 1, label: "docs/a.md", content: "text", dirty: false }]]);
		assert.equal(t.listeners(), 0);
	});

	it("refuses the whole read with the host's sentences, adding the draft's name when the sentence lacks it", async () => {
		const t = transport();
		const pending = readLinkedFiles(t.transport, 1, [{ number: 1, ref: REF }, { number: 2, ref: REF }], 10, names);
		t.deliver({ type: "omp:files-read", requestId: 1, files: [], failures: [{ number: 1, name: "", reason: "it changed on disk." }, { number: 2, name: "b.md", reason: "b.md is gone." }] });
		const read = await pending;
		assert.deepEqual(read, { ok: false, reason: "a.md: it changed on disk. b.md is gone." });
	});

	it("refuses at once, naming each file, when the route cannot carry the request", async () => {
		const t = transport(false);
		const read = await readLinkedFiles(t.transport, 1, [{ number: 1, ref: REF }, { number: 2, ref: REF }], 10, names);
		assert.equal(read.ok, false);
		assert.match(read.ok ? "" : read.reason, /^a\.md cannot be read over this connection.* b\.md cannot be read/);
		assert.equal(t.listeners(), 0);
	});

	it("refuses with a retry sentence when the host stays silent past the bound", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const t = transport();
			const pending = readLinkedFiles(t.transport, 1, [{ number: 1, ref: REF }], 10, names);
			mock.timers.tick(readTimeoutMs(1));
			const read = await pending;
			assert.equal(read.ok, false);
			assert.match(read.ok ? "" : read.reason, /did not answer, so nothing was sent/);
			assert.equal(t.listeners(), 0);
		} finally {
			mock.timers.reset();
		}
	});

	it("waits longer for more files, to at most a minute", () => {
		assert.equal(readTimeoutMs(0), 20_000);
		assert.equal(readTimeoutMs(100), 25_000);
		assert.equal(readTimeoutMs(1000), 60_000);
	});
});
