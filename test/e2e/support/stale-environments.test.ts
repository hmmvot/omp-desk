import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createdAtOf, MIN_STALE_AGE_MS, selectStaleEnvironments } from "./stale-environments.ts";

const ROOT = "C:\\Users\\someone\\AppData\\Local\\omp-desk-test";
const NOW = Date.parse("2026-10-15T12:00:00Z");
const named = (age: number) => `e2e-run-${(NOW - age).toString(36)}`;
const entry = (name: string) => ({ name, modifiedAt: NOW });

describe("selectStaleEnvironments", () => {
	const old = named(MIN_STALE_AGE_MS + 60_000);

	it("keeps a folder a running process names, whatever its age", () => {
		const live = `"C:\\Code.exe" --user-data-dir=${ROOT}\\${old}\\data --remote-debugging-port=9222`;
		assert.deepEqual(selectStaleEnvironments([entry(old)], { root: ROOT, keep: undefined, now: NOW, commandLines: [live] }), []);
		const bun = `bun.exe broker --state "${ROOT}\\${old}"`;
		assert.deepEqual(selectStaleEnvironments([entry(old)], { root: ROOT, keep: undefined, now: NOW, commandLines: [bun] }), []);
		const lower = `x ${(ROOT + "\\" + old).toLowerCase()}/agent`;
		assert.deepEqual(selectStaleEnvironments([entry(old)], { root: ROOT, keep: undefined, now: NOW, commandLines: [lower] }), []);
	});

	it("returns an old folder nothing runs in, and leaves a younger one, even with no process yet", () => {
		const young = named(MIN_STALE_AGE_MS - 60_000);
		const unrelated = [`"C:\\Code.exe" --user-data-dir=${ROOT}\\${old}-other\\data`, "notepad.exe"];
		assert.deepEqual(selectStaleEnvironments([entry(old), entry(young)], { root: ROOT, keep: undefined, now: NOW, commandLines: unrelated }), [old]);
	});

	it("never returns the kept environment, a folder of another name, or anything when the processes could not be read", () => {
		const other = { name: "notes", modifiedAt: 0 };
		assert.deepEqual(selectStaleEnvironments([entry(old), other], { root: ROOT, keep: old, now: NOW, commandLines: [] }), []);
		assert.deepEqual(selectStaleEnvironments([entry(old)], { root: ROOT, keep: undefined, now: NOW, commandLines: undefined }), []);
	});

	it("dates a folder by the time in its name, and by its modification time when the name has none", () => {
		assert.equal(createdAtOf(entry(named(5_000))), NOW - 5_000);
		assert.equal(createdAtOf({ name: "e2e-run-abc", modifiedAt: 42 }), 42);
		assert.deepEqual(selectStaleEnvironments([{ name: "e2e-run-abc", modifiedAt: NOW - MIN_STALE_AGE_MS - 1 }], { root: ROOT, keep: undefined, now: NOW, commandLines: [] }), ["e2e-run-abc"]);
	});
});
