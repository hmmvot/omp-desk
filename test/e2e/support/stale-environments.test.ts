import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createdAtOf, environmentProcesses, LEGACY_ABANDONED_AGE_MS, MIN_STALE_AGE_MS, namesPath, OWNER_FILE, ownerRuns, parseProcessList, readOwner,
	selectAbandonedEnvironments, selectStaleEnvironments, selfAndAncestors, type EnvironmentOwner, type ProcessInfo,
} from "./stale-environments.ts";

const ROOT = "C:\\Users\\someone\\AppData\\Local\\omp-desk-test";
const NOW = Date.parse("2026-10-15T12:00:00Z");
const named = (age: number) => `e2e-run-${(NOW - age).toString(36)}`;
const entry = (name: string, owner?: EnvironmentOwner) => ({ name, modifiedAt: NOW, owner });
const proc = (pid: number, commandLine: string | undefined, extra: Partial<ProcessInfo> = {}): ProcessInfo => ({ pid, parentPid: 0, name: "x.exe", commandLine, startedAt: NOW - 60_000, ...extra });
const select = { root: ROOT, keep: undefined, now: NOW };

describe("namesPath", () => {
	const base = `${ROOT}\\e2e-run-abc`;

	it("finds the folder as a path of its own wherever it stands in a command line, in any case and with either separator", () => {
		assert.ok(namesPath(base, `"C:\\Code.exe" --user-data-dir=${base}\\data --remote-debugging-port=9222`));
		assert.ok(namesPath(base, `bun.exe broker --state "${base}"`));
		assert.ok(namesPath(base, `omp.exe --cwd ${base}`));
		assert.ok(namesPath(base, `omp.exe --cwd '${base}'`));
		assert.ok(namesPath(base, `x ${base.toLowerCase().replaceAll("\\", "/")}/agent`));
		assert.ok(namesPath(base, `x ${base.toUpperCase()}\\ws`));
	});

	it("does not take a longer name, a parent folder or a sibling for it", () => {
		assert.equal(namesPath(base, `Code.exe --user-data-dir=${base}-other\\data`), false);
		assert.equal(namesPath(base, `Code.exe --user-data-dir=${base}2`), false);
		assert.equal(namesPath(base, `Code.exe ${ROOT}`), false);
		assert.equal(namesPath(base, `Code.exe ${ROOT}\\e2e-run-ab\\data`), false);
		assert.equal(namesPath(base, undefined), false);
		assert.equal(namesPath(base, ""), false);
	});

	it("finds a later occurrence after a longer name that starts with the folder", () => {
		assert.ok(namesPath(base, `x ${base}-other ${base}\\data`));
	});
});

describe("environmentProcesses", () => {
	const base = `${ROOT}\\e2e-run-abc`;

	it("takes everything that names the folder and everything those started, whatever the image and the depth", () => {
		const processes = [
			proc(10, `"C:\\Code.exe" --user-data-dir=${base}\\data`, { name: "Code.exe" }),
			proc(11, "Code.exe --type=renderer", { parentPid: 10 }),
			proc(20, `bun.exe ${base}\\data\\broker.js`, { parentPid: 999, name: "bun.exe" }),
			proc(21, "omp.exe --mode rpc-ui", { parentPid: 20 }),
			proc(22, "conhost.exe 0xffffffff -ForceV1", { parentPid: 21 }),
			proc(23, undefined, { parentPid: 22 }),
			proc(30, `omp.exe --cwd ${base}\\ws\\alpha-desk`, { parentPid: 1 }),
			proc(40, "notepad.exe"),
			proc(41, `Code.exe --user-data-dir=${base}-other`),
			proc(42, "child of another environment", { parentPid: 41 }),
		];
		assert.deepEqual(environmentProcesses(base, processes).map(item => item.pid).sort((a, b) => a - b), [10, 11, 20, 21, 22, 23, 30]);
	});

	it("does not follow a pid that a dead member left to a process that started earlier than the member", () => {
		const processes = [
			proc(10, `Code.exe ${base}\\data`, { startedAt: NOW }),
			proc(50, "unrelated, reused the pid of a parent", { parentPid: 10, startedAt: NOW - 1_000 }),
			proc(51, "a real child", { parentPid: 10, startedAt: NOW + 1_000 }),
			proc(52, "unknown start time follows its parent", { parentPid: 10, startedAt: undefined }),
		];
		assert.deepEqual(environmentProcesses(base, processes).map(item => item.pid), [10, 51, 52]);
	});

	it("never takes the processes it is told to leave out, nor what only they started", () => {
		const processes = [
			proc(10, `powershell.exe -Command "dir ${base}"`),
			proc(11, "its child", { parentPid: 10 }),
			proc(12, `Code.exe ${base}\\data`),
		];
		assert.deepEqual(environmentProcesses(base, processes, new Set([10])).map(item => item.pid), [12]);
	});

	it("finds this process and its ancestors, and stops at a cycle or a missing parent", () => {
		const processes = [proc(1, "a", { parentPid: 2 }), proc(2, "b", { parentPid: 3 }), proc(3, "c", { parentPid: 99 }), proc(4, "d", { parentPid: 1 })];
		assert.deepEqual([...selfAndAncestors(processes, 1)].sort(), [1, 2, 3, 99]);
		assert.deepEqual([...selfAndAncestors([proc(1, "a", { parentPid: 2 }), proc(2, "b", { parentPid: 1 })], 1)].sort(), [1, 2]);
		assert.deepEqual([...selfAndAncestors([], 7)], [7]);
	});
});

describe("ownerRuns", () => {
	const owner: EnvironmentOwner = { pid: 77, startedAt: NOW - 600_000, keep: false };

	it("is true for the owner's pid started when the owner file says", () => {
		assert.equal(ownerRuns(owner, [proc(77, "node", { startedAt: NOW - 600_000 })]), true);
		assert.equal(ownerRuns(owner, [proc(77, "node", { startedAt: NOW - 600_000 + 500 })]), true, "the two readings differ by rounding");
	});

	it("is false when the pid is gone or belongs to a process that started later (a reused pid)", () => {
		assert.equal(ownerRuns(owner, [proc(78, "node")]), false);
		assert.equal(ownerRuns(owner, []), false);
		assert.equal(ownerRuns(owner, [proc(77, "node", { startedAt: NOW - 60_000 })]), false);
	});

	it("takes a live pid for the owner when either start time is unknown", () => {
		assert.equal(ownerRuns({ ...owner, startedAt: undefined }, [proc(77, "node")]), true);
		assert.equal(ownerRuns(owner, [proc(77, "node", { startedAt: undefined })]), true);
	});
});

describe("selectAbandonedEnvironments", () => {
	const old = named(MIN_STALE_AGE_MS + 60_000);
	const live = [proc(10, `"C:\\Code.exe" --user-data-dir=${ROOT}\\${old}\\data`), proc(11, `bun.exe broker --state "${ROOT}\\${old}"`)];
	const gone: EnvironmentOwner = { pid: 77, startedAt: NOW - 3_600_000, keep: false };

	it("returns an environment that still has processes when its owner is gone, and nothing when the owner runs", () => {
		assert.deepEqual(selectAbandonedEnvironments([entry(old, gone)], { ...select, processes: live }), [old]);
		const owner = proc(77, "node playwright", { startedAt: NOW - 3_600_000 });
		assert.deepEqual(selectAbandonedEnvironments([entry(old, gone)], { ...select, processes: [...live, owner] }), []);
	});

	it("returns an environment whose only process is an OMP or a broker, and one whose owner pid was reused", () => {
		const onlyOmp = [proc(30, `omp.exe --cwd ${ROOT}\\${old}\\ws\\alpha-desk`)];
		assert.deepEqual(selectAbandonedEnvironments([entry(old, gone)], { ...select, processes: onlyOmp }), [old]);
		const reused = proc(77, "something else", { startedAt: NOW - 1_000 });
		assert.deepEqual(selectAbandonedEnvironments([entry(old, gone)], { ...select, processes: [...live, reused] }), [old]);
	});

	it("leaves an environment without processes, a kept one, the one a kept run reuses, and a folder of another name", () => {
		assert.deepEqual(selectAbandonedEnvironments([entry(old, gone)], { ...select, processes: [proc(1, "notepad.exe")] }), []);
		assert.deepEqual(selectAbandonedEnvironments([entry(old, { ...gone, keep: true })], { ...select, processes: live }), []);
		assert.deepEqual(selectAbandonedEnvironments([entry(old, gone)], { ...select, keep: old, processes: live }), []);
		assert.deepEqual(selectAbandonedEnvironments([entry("notes", gone)], { ...select, processes: [proc(1, `x ${ROOT}\\notes`)] }), []);
	});

	it("never takes the asking run or its ancestors for the processes of an environment", () => {
		const asker = [proc(5, `node ${ROOT}\\${old}\\x.js`, { parentPid: 4 }), proc(4, `cmd ${ROOT}\\${old}`)];
		assert.deepEqual(selectAbandonedEnvironments([entry(old, gone)], { ...select, processes: asker, selfPid: 5 }), []);
	});

	it("waits a long time before it ends an environment no owner file describes: it may be a live run of an older checkout", () => {
		const young = named(LEGACY_ABANDONED_AGE_MS - 60_000);
		const ancient = named(LEGACY_ABANDONED_AGE_MS + 60_000);
		const processes = [proc(10, `Code.exe --user-data-dir=${ROOT}\\${young}\\data`), proc(11, `Code.exe --user-data-dir=${ROOT}\\${ancient}\\data`)];
		assert.deepEqual(selectAbandonedEnvironments([entry(young), entry(ancient)], { ...select, processes }), [ancient]);
	});

	it("returns nothing when the processes could not be read", () => {
		assert.deepEqual(selectAbandonedEnvironments([entry(old, gone)], { ...select, processes: undefined }), []);
	});
});

describe("selectStaleEnvironments", () => {
	const old = named(MIN_STALE_AGE_MS + 60_000);
	const gone: EnvironmentOwner = { pid: 77, startedAt: NOW - 3_600_000, keep: false };

	it("keeps a folder a running process names, whatever its age or owner", () => {
		const live = proc(10, `"C:\\Code.exe" --user-data-dir=${ROOT}\\${old}\\data --remote-debugging-port=9222`);
		assert.deepEqual(selectStaleEnvironments([entry(old)], { ...select, processes: [live] }), []);
		assert.deepEqual(selectStaleEnvironments([entry(old, gone)], { ...select, processes: [live] }), []);
		const bun = proc(11, `bun.exe broker --state "${ROOT}\\${old}"`);
		assert.deepEqual(selectStaleEnvironments([entry(old)], { ...select, processes: [bun] }), []);
		const lower = proc(12, `x ${(ROOT + "\\" + old).toLowerCase()}/agent`);
		assert.deepEqual(selectStaleEnvironments([entry(old)], { ...select, processes: [lower] }), []);
	});

	it("returns an old folder nothing runs in, and leaves a younger one, even with no process yet", () => {
		const young = named(MIN_STALE_AGE_MS - 60_000);
		const unrelated = [proc(1, `"C:\\Code.exe" --user-data-dir=${ROOT}\\${old}-other\\data`), proc(2, "notepad.exe")];
		assert.deepEqual(selectStaleEnvironments([entry(old), entry(young)], { ...select, processes: unrelated }), [old]);
	});

	it("returns a folder whose owner is gone at any age, and leaves one whose owner runs, however old", () => {
		const young = named(1_000);
		assert.deepEqual(selectStaleEnvironments([entry(young, gone)], { ...select, processes: [] }), [young]);
		const owner = proc(77, "node playwright", { startedAt: NOW - 3_600_000 });
		assert.deepEqual(selectStaleEnvironments([entry(old, gone)], { ...select, processes: [owner] }), []);
	});

	it("treats the folder of a kept run by age only: its owner is meant to be gone", () => {
		const kept: EnvironmentOwner = { ...gone, keep: true };
		assert.deepEqual(selectStaleEnvironments([entry(named(1_000), kept)], { ...select, processes: [] }), []);
		assert.deepEqual(selectStaleEnvironments([entry(old, kept)], { ...select, processes: [] }), [old]);
	});

	it("never returns the kept environment, a folder of another name, or anything when the processes could not be read", () => {
		const other = { name: "notes", modifiedAt: 0 };
		assert.deepEqual(selectStaleEnvironments([entry(old), other], { ...select, keep: old, processes: [] }), []);
		assert.deepEqual(selectStaleEnvironments([entry(old)], { ...select, processes: undefined }), []);
	});

	it("dates a folder by the time in its name, and by its modification time when the name has none", () => {
		assert.equal(createdAtOf(entry(named(5_000))), NOW - 5_000);
		assert.equal(createdAtOf({ name: "e2e-run-abc", modifiedAt: 42 }), 42);
		assert.deepEqual(selectStaleEnvironments([{ name: "e2e-run-abc", modifiedAt: NOW - MIN_STALE_AGE_MS - 1 }], { ...select, processes: [] }), ["e2e-run-abc"]);
	});
});

describe("readOwner", () => {
	function withEnvironment(content: string | undefined, check: (base: string) => void): void {
		const base = mkdtempSync(join(tmpdir(), "omp-owner-"));
		try {
			mkdirSync(base, { recursive: true });
			if (content !== undefined) writeFileSync(join(base, OWNER_FILE), content);
			check(base);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	}

	it("reads what a run wrote, with or without a start time", () => {
		withEnvironment(JSON.stringify({ pid: 12, startedAt: 5, keep: true }), base => assert.deepEqual(readOwner(base), { pid: 12, startedAt: 5, keep: true }));
		withEnvironment(JSON.stringify({ pid: 12, keep: false }), base => assert.deepEqual(readOwner(base), { pid: 12, startedAt: undefined, keep: false }));
	});

	it("has no owner for a missing, unreadable or foreign file", () => {
		withEnvironment(undefined, base => assert.equal(readOwner(base), undefined));
		withEnvironment("{not json", base => assert.equal(readOwner(base), undefined));
		withEnvironment("null", base => assert.equal(readOwner(base), undefined));
		withEnvironment(JSON.stringify({ pid: "12" }), base => assert.equal(readOwner(base), undefined));
		withEnvironment(JSON.stringify({ pid: 0 }), base => assert.equal(readOwner(base), undefined));
	});
});

describe("parseProcessList", () => {
	it("reads the array PowerShell prints for many processes and the bare object it prints for one", () => {
		const row = { pid: 4, parentPid: 1, name: "a.exe", commandLine: "a.exe -x", startedAt: 9 };
		assert.deepEqual(parseProcessList(JSON.stringify([row, { pid: 5, parentPid: 4, name: "b.exe", commandLine: null, startedAt: null }])), [row, { pid: 5, parentPid: 4, name: "b.exe", commandLine: undefined, startedAt: undefined }]);
		assert.deepEqual(parseProcessList(JSON.stringify(row)), [row]);
	});

	it("reads nothing from output that is not a process list", () => {
		assert.equal(parseProcessList(""), undefined);
		assert.equal(parseProcessList("Access denied"), undefined);
		assert.equal(parseProcessList(JSON.stringify([{ pid: "4" }])), undefined);
		assert.equal(parseProcessList(JSON.stringify(["a.exe"])), undefined);
	});
});
