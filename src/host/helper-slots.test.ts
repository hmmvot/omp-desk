import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createHelperSlots, HELPER_SLOT_NAME } from "./helper-slots.ts";
import { ptySlotLockPath } from "./pty-registry.ts";

let storage = "";
before(async () => { storage = await mkdtemp(path.join(tmpdir(), "omp-helper-slots-")); });
after(async () => { await rm(storage, { recursive: true, force: true }); });

/** A fake clock the poll sleep advances, so a wait that runs out takes no real time. */
function clock() {
	const state = { now: 1_000, sleeps: 0 };
	return { state, now: () => state.now, sleep: async (ms: number) => { state.now += ms; state.sleeps += 1; } };
}

const locks = async (): Promise<string[]> => (await readdir(path.join(storage, "pty")).catch(() => [])).filter(name => name.endsWith(".lock"));

describe("helper slots", () => {
	it("grants as many slots as there are and refuses the next one after its wait; a released slot is granted again", async () => {
		const time = clock();
		const slots = createHelperSlots({ storageDir: storage, count: 2, ...time });
		const signal = new AbortController().signal;
		const first = await slots.acquire(signal, 1_000);
		const second = await slots.acquire(signal, 1_000);
		assert.ok(first && second, "two slots are free");
		assert.equal((await locks()).length, 2);
		const third = await slots.acquire(signal, 1_000);
		assert.equal(third, null, "none is free within the wait");
		assert.ok(time.state.sleeps > 0, "it polled while it waited");
		await first.release();
		assert.equal((await locks()).length, 1);
		const again = await slots.acquire(signal, 1_000);
		assert.ok(again, "the released slot is free");
		await again.release();
		await second.release();
		assert.deepEqual(await locks(), [], "every lock file is removed");
	});

	it("two windows share the same slots", async () => {
		const time = clock();
		const windowA = createHelperSlots({ storageDir: storage, count: 1, ...time });
		const windowB = createHelperSlots({ storageDir: storage, count: 1, ...time });
		const signal = new AbortController().signal;
		const held = await windowA.acquire(signal, 0);
		assert.ok(held);
		assert.equal(await windowB.acquire(signal, 0), null);
		await held.release();
		const taken = await windowB.acquire(signal, 0);
		assert.ok(taken);
		await taken.release();
	});

	it("takes over the slot of a window that is gone", async () => {
		const time = clock();
		const slots = createHelperSlots({ storageDir: storage, count: 1, name: "orphaned", ...time, isHolderAlive: () => false });
		const signal = new AbortController().signal;
		await slots.acquire(signal, 0);
		const taken = await slots.acquire(signal, 0);
		assert.ok(taken, "the first holder's process is not alive, so its lock is stale");
		await taken.release();
	});

	it("a lock released by another holder id is left alone", async () => {
		const time = clock();
		const slots = createHelperSlots({ storageDir: storage, count: 1, name: "foreign", ...time });
		const signal = new AbortController().signal;
		const mine = await slots.acquire(signal, 0);
		assert.ok(mine);
		await writeFile(ptySlotLockPath(storage, "foreign:0"), `${JSON.stringify({ holderId: "someone-else", pid: process.pid, creationTime: null, at: new Date().toISOString() })}\n`);
		await mine.release();
		assert.equal((await locks()).length > 0, true, "only the holder's own lock is removed");
		await rm(ptySlotLockPath(storage, "foreign:0"), { force: true });
	});

	it("answers null at once for an aborted wait, and when the slot files cannot be used", async () => {
		const time = clock();
		const aborted = new AbortController();
		aborted.abort();
		const slots = createHelperSlots({ storageDir: storage, count: 1, name: "aborted", ...time });
		assert.equal(await slots.acquire(aborted.signal, 60_000), null);
		// A file where the state directory should be: the lock cannot be created and the caller must not wait for it.
		const broken = await mkdtemp(path.join(tmpdir(), "omp-helper-slots-broken-"));
		try {
			await writeFile(path.join(broken, "pty"), "not a directory");
			const unusable = createHelperSlots({ storageDir: broken, count: 1, ...time });
			const before = time.state.now;
			assert.equal(await unusable.acquire(new AbortController().signal, 60_000), null);
			assert.equal(time.state.now, before, "it gave up without polling");
		} finally {
			await rm(broken, { recursive: true, force: true });
		}
	});

	it("has a default name that keeps its locks apart from the other PTY slot locks", () => {
		assert.match(HELPER_SLOT_NAME, /^omp-helper$/);
	});
});
