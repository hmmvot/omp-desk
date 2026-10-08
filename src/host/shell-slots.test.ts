/**
 * The durable folder-shell slot registry.
 *
 * Runner: `node --test src/host/shell-slots.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	SHELL_SLOT_LIMIT,
	createShellSlotId,
	createShellSlotStore,
	isShellSlotId,
	reconnectableShellSlots,
	shellClosePrompt,
	shellLaunchOutcome,
	shellSlotsForFolder,
} from "./shell-slots.ts";
import type { ShellMemento, ShellSlotRecord } from "./shell-slots.ts";

function memento(initial: unknown = null): ShellMemento & { readonly writes: readonly unknown[] } {
	const writes: unknown[] = [];
	let value = initial;
	return {
		writes,
		get(_key: string, fallback: unknown) {
			return value ?? fallback;
		},
		update(_key: string, next: unknown) {
			value = next;
			writes.push(next);
			return Promise.resolve();
		},
	};
}

const SLOT = "shell:8c2f0f0a-1c2b-4f3e-9a4d-5e6f708192a3";

describe("shell slot ids", () => {
	it("mints the exact shape the page accepts and rejects everything else", () => {
		const minted = createShellSlotId();
		assert.equal(isShellSlotId(minted), true);
		assert.equal(isShellSlotId(`shell:${minted.slice(6).toUpperCase()}`), true, "case-insensitive like the page");
		for (const bad of ["", "shell:", "shell:not-a-uuid", "tab:8c2f0f0a-1c2b-4f3e-9a4d-5e6f708192a3", `${minted}-extra`]) {
			assert.equal(isShellSlotId(bad), false, `accepted ${bad}`);
		}
	});
});

describe("shell slot store", () => {
	it("records a slot before its editor exists and keeps it across a reload", async () => {
		const backing = memento();
		const store = createShellSlotStore(backing, () => 1_700_000_000_000);
		const added = await store.add({ slot: SLOT, cwd: "C:\\work", folderKey: "c:\\work", label: "work" });
		assert.equal(added.ok, true);
		const record = added.ok ? added.record : null;
		assert.equal(record?.detachedAt, null, "a new shell is carried by the editor it was created for");
		assert.equal(record?.createdAt, new Date(1_700_000_000_000).toISOString());

		const reloaded = createShellSlotStore(backing, () => 1_700_000_000_000);
		assert.deepEqual(reloaded.get(SLOT)?.cwd, "C:\\work");
	});

	it("keeps a detached slot until its process tree is proven gone", async () => {
		const store = createShellSlotStore(memento(), () => 1);
		assert.equal((await store.add({ slot: SLOT, cwd: "C:\\work", folderKey: "c:\\work", label: "work" })).ok, true);
		const detached = await store.update(SLOT, { detachedAt: "2026-09-27T00:00:00.000Z" });
		assert.equal(detached?.detachedAt, "2026-09-27T00:00:00.000Z");
		// A dismissed prompt or a failed stop is exactly this state: still retained.
		assert.equal(store.get(SLOT)?.detachedAt, "2026-09-27T00:00:00.000Z");
		assert.equal(await store.remove(SLOT), true);
		assert.equal(store.get(SLOT), null);
		assert.equal(await store.remove(SLOT), false, "removing an absent slot is not a change");
	});

	it("ignores a malformed persisted record instead of trusting it", () => {
		const store = createShellSlotStore(
			memento([
				{ slot: "not-a-shell", cwd: "C:\\work", folderKey: "c:\\work", label: "work", createdAt: "x", detachedAt: null, lastGeneration: null },
				{ slot: SLOT, cwd: "", folderKey: "c:\\work", label: "work", createdAt: "x", detachedAt: null, lastGeneration: null },
				{ slot: SLOT, cwd: "C:\\work", folderKey: "c:\\work", label: "work", createdAt: "x", detachedAt: "bad", lastGeneration: null },
				{ slot: SLOT, cwd: "C:\\work", folderKey: "c:\\work", label: "work", createdAt: "x", detachedAt: null, lastGeneration: null },
			]),
		);
		assert.deepEqual(store.list().map(record => record.slot), [SLOT]);
	});

	it("refuses a new shell at the bound instead of evicting a recoverable slot", async () => {
		const store = createShellSlotStore(memento(), () => 1);
		const slots: string[] = [];
		for (let index = 0; index < SHELL_SLOT_LIMIT; index++) {
			const slot = createShellSlotId();
			slots.push(slot);
			const added = await store.add({ slot, cwd: `C:\\work${index}`, folderKey: `c:\\work${index}`, label: `work${index}` });
			assert.equal(added.ok, true);
			// Every slot here is detached: these are exactly the records a Reconnect
			// action must still be able to reach, so none of them may be evicted.
			await store.update(slot, { detachedAt: "2026-09-27T00:00:00.000Z" });
		}
		const refused = await store.add({ slot: createShellSlotId(), cwd: "C:\\one-more", folderKey: "c:\\one-more", label: "one-more" });
		assert.equal(refused.ok, false, "a full registry must refuse rather than drop a live shell's record");
		if (!refused.ok) assert.match(refused.reason, /Reconnect or terminate/);
		assert.equal(store.list().length, SHELL_SLOT_LIMIT);
		for (const slot of slots) assert.notEqual(store.get(slot), null, `lost ${slot}`);

		// Replacing the same slot is not growth, so it stays allowed at the bound.
		const replaced = await store.add({ slot: slots[0]!, cwd: "C:\\work0", folderKey: "c:\\work0", label: "again" });
		assert.equal(replaced.ok, true);
		assert.equal(store.list().length, SHELL_SLOT_LIMIT);
	});

	it("does not remember a slot a failed write never made durable", async () => {
		let fail = true;
		const durable: unknown[] = [];
		let value: unknown = null;
		const store = createShellSlotStore({
			get: (_key, fallback) => value ?? fallback,
			update: (_key, next) => {
				if (fail) return Promise.reject(new Error("the workspace state could not be written"));
				durable.push(next);
				value = next;
				return Promise.resolve();
			},
		});
		await assert.rejects(() => store.add({ slot: SLOT, cwd: "C:\\work", folderKey: "c:\\work", label: "work" }));
		// The rejected record must not look durable: a later window would not find it, so
		// a Reconnect offered for it would lead nowhere.
		assert.equal(store.get(SLOT), null);
		fail = false;
		assert.equal((await store.add({ slot: SLOT, cwd: "C:\\work", folderKey: "c:\\work", label: "work" })).ok, true);
		assert.equal(durable.length, 1);
	});
});

describe("shell slot references", () => {
	const valid = { slot: SLOT, cwd: "C:\\work", folderKey: "c:\\work", label: "work", createdAt: "x", detachedAt: null, lastGeneration: null };

	it("lists the recorded slots and is complete for an empty or fully parsed value", () => {
		assert.equal(createShellSlotStore(memento()).references().complete, true);
		const store = createShellSlotStore(memento([valid]));
		assert.deepEqual(store.references().records.map(record => record.slot), [SLOT]);
		assert.equal(store.references().complete, true);
	});

	it("reports a dropped element or a non-list value as incomplete until reloaded", () => {
		const dropped = createShellSlotStore(memento([valid, { slot: "not-a-shell" }]));
		assert.deepEqual(dropped.references().records.map(record => record.slot), [SLOT]);
		assert.equal(dropped.references().complete, false);
		assert.equal(createShellSlotStore(memento({ not: "a list" })).references().complete, false);
	});
});

describe("folder shell lookup", () => {
	const records: readonly ShellSlotRecord[] = [
		{ slot: SLOT, cwd: "C:\\work", folderKey: "c:\\work", label: "work", createdAt: "x", detachedAt: null, lastGeneration: null },
		{ slot: createShellSlotId(), cwd: "C:\\work", folderKey: "c:\\work", label: "work", createdAt: "y", detachedAt: "z", lastGeneration: null },
	];

	it("matches one folder's slots by canonical key", () => {
		assert.equal(shellSlotsForFolder(records, "c:\\work").length, 2);
		assert.equal(shellSlotsForFolder(records, "c:\\other").length, 0);
	});

	it("offers a reconnect only for slots no live editor is showing", () => {
		const bound = records[0]!.slot;
		const reconnectable = reconnectableShellSlots(records, "c:\\work", slot => slot === bound);
		assert.deepEqual(reconnectable.map(record => record.slot), [records[1]!.slot]);
		// With nothing bound, both are reconnect targets: the process may still be running
		// in either, and only the user may end it.
		assert.equal(reconnectableShellSlots(records, "c:\\work", () => false).length, 2);
	});
});

describe("folder shell close prompt", () => {
	it("identifies the terminal by its display label without exposing its working directory", () => {
		for (const liveness of ["running", "unreachable"] as const) {
			const prompt = shellClosePrompt({ label: "Project terminal", liveness });
			assert.ok(prompt.message.includes("Project terminal"));
			assert.equal(prompt.confirmLabel, "Terminate");
			assert.equal(prompt.message.includes("/"), false);
			assert.equal(prompt.detail.includes("/"), false);
		}
	});

	it("distinguishes a known live terminal from an unreachable one", () => {
		const running = shellClosePrompt({ label: "Project terminal", liveness: "running" });
		const unreachable = shellClosePrompt({ label: "Project terminal", liveness: "unreachable" });
		assert.notEqual(running.detail, unreachable.detail);
	});
});

/**
 * What a folder keeps when a shell launch does not hand back a handle.
 *
 * The pre-recorded slot is the recovery route, so these cases check whether the folder
 * still offers that exact slot afterwards, not just what the decision function returns.
 * They run the production decision against a real `ShellSlotStore` and assert through
 * `reconnectableShellSlots` that an uncertain launch leaves the slot discoverable, that
 * no second shell is started for it, and that only a verdict proving nothing was ever
 * started removes the record.
 */
describe("folder shell launch uncertainty", () => {
	const RECORD = { slot: "shell:11111111-1111-1111-1111-111111111111", cwd: "/tmp/alpha", folderKey: "/tmp/alpha", label: "alpha" };

	async function afterLaunch(verdict: { readonly state: "running" | "slot-occupied" | "not-started" | "unconfirmed"; readonly brokerPid: number | null }) {
		const store = createShellSlotStore(memento());
		await store.add(RECORD);
		const outcome = shellLaunchOutcome(verdict);
		if (!outcome.retain) await store.remove(RECORD.slot);
		const live = new Set<string>();
		const offered = reconnectableShellSlots(store.list(), "/tmp/alpha", slot => live.has(slot));
		return { outcome, store, offered };
	}

	it("keeps the exact slot reconnectable when the broker merely published late", async () => {
		const { outcome, store, offered } = await afterLaunch({ state: "unconfirmed", brokerPid: 4242 });
		assert.equal(outcome.retain, true);
		assert.equal(store.get(RECORD.slot)?.slot, RECORD.slot, "the recovery record must survive an uncertain launch");
		assert.deepEqual(offered.map(record => record.slot), [RECORD.slot], "the folder must still offer that exact slot");
		// No second shell was started: nothing re-recorded the slot or handed it an editor.
		assert.equal(store.get(RECORD.slot)?.lastGeneration ?? null, null);
		assert.match(outcome.detail, /may still be starting/);
	});

	it("keeps the slot for an occupied slot and for a not-started verdict that spawned a process", async () => {
		for (const verdict of [{ state: "slot-occupied", brokerPid: null }, { state: "slot-occupied", brokerPid: 77 }, { state: "not-started", brokerPid: 77 }] as const) {
			const { outcome, offered } = await afterLaunch(verdict);
			assert.equal(outcome.retain, true, JSON.stringify(verdict));
			assert.deepEqual(offered.map(record => record.slot), [RECORD.slot], JSON.stringify(verdict));
		}
	});

	it("removes the record only when the verdict proves nothing was ever started", async () => {
		const { outcome, store, offered } = await afterLaunch({ state: "not-started", brokerPid: null });
		assert.equal(outcome.retain, false);
		assert.equal(store.get(RECORD.slot), null);
		assert.deepEqual(offered, [], "a terminal that was never started is not a reconnect route");
	});
});
