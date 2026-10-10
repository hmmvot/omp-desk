/**
 * The window registry against a real temporary directory: what is published, who counts as
 * live, in what order, and what is cleaned up (ADR-0056). Time and process liveness are
 * injected, so expiry is tested without waiting for a lease.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
	WINDOW_REGISTRY_DIRECTORY,
	WindowRegistry,
	boundWindowSnapshot,
	parseWindowRecord,
	processExists,
	sessionIncarnation,
} from "./window-registry.ts";
import type { WindowRecord, WindowSnapshot } from "./window-registry.ts";

const LEASE = 60_000;
const BASE = Date.parse("2026-10-10T10:00:00.000Z");

describe("window registry", () => {
	let storage: string;
	let directory: string;
	let clock = BASE;

	/** Give a file the modification time it would have `ageMs` before the injected clock. */
	function ageFile(file: string, ageMs: number): void {
		const at = new Date(clock - ageMs);
		fs.utimesSync(file, at, at);
	}

	const alive = new Set<number>();
	const registries: WindowRegistry[] = [];
	const errors: string[] = [];

	before(() => {
		storage = fs.mkdtempSync(path.join(os.tmpdir(), "omp-window-registry-"));
		directory = path.join(storage, WINDOW_REGISTRY_DIRECTORY);
	});

	afterEach(() => {
		for (const registry of registries.splice(0)) registry.dispose();
		fs.rmSync(directory, { recursive: true, force: true });
		clock = BASE;
		alive.clear();
		errors.length = 0;
	});

	after(() => {
		fs.rmSync(storage, { recursive: true, force: true });
	});

	function windowOf(holderId: string, pid: number, startedAt: string, snapshot: Partial<WindowSnapshot> = {}): WindowRegistry {
		alive.add(pid);
		const registry = new WindowRegistry({
			storageDir: storage,
			holderId,
			pid,
			startedAt,
			now: () => clock,
			leaseMs: LEASE,
			pidAlive: candidate => alive.has(candidate),
			writeDebounceMs: 5,
			heartbeatMs: 1_000_000,
			watchDebounceMs: 20,
			onError: detail => errors.push(detail),
		});
		registries.push(registry);
		registry.setSnapshot({ windowUri: null, label: holderId, folders: [], liveCwds: [], rows: {}, ...snapshot });
		return registry;
	}

	async function publish(...all: WindowRegistry[]): Promise<void> {
		for (const registry of all) await registry.flush();
		for (const registry of all) await registry.refresh();
	}

	it("gives every window the same union in window start order, with each window's own folders in its own order", async () => {
		const late = windowOf("late", 3, "2026-10-10T09:30:00.000Z", { folders: ["C:/late-1", "C:/late-2"] });
		const early = windowOf("early", 1, "2026-10-10T09:00:00.000Z", { folders: ["C:/early"] });
		const tied = windowOf("tied-b", 2, "2026-10-10T09:30:00.000Z", { folders: ["C:/tied"] });
		await publish(late, early, tied);
		const shape = (registry: WindowRegistry) => registry.windows().map(window => [window.holderId, window.folders]);
		assert.deepEqual(shape(early), [["early", ["C:/early"]], ["late", ["C:/late-1", "C:/late-2"]], ["tied-b", ["C:/tied"]]]);
		assert.deepEqual(shape(late), shape(early));
		assert.deepEqual(shape(tied), shape(early));
		assert.deepEqual(late.windows().map(window => window.here), [false, true, false], "each window only flags itself");
	});

	it("reads the others' rows, labels and URIs back exactly as published", async () => {
		const owner = windowOf("owner", 1, "2026-10-10T09:00:00.000Z", {
			windowUri: "file:///c%3A/work/app",
			label: "app",
			liveCwds: ["C:/work/app"],
			rows: { "tab:1": { status: "working", incarnation: "inc-1", binding: "slot.1", lastActivityAt: "2026-10-10T09:01:00.000Z" } },
		});
		const reader = windowOf("reader", 2, "2026-10-10T09:05:00.000Z");
		await publish(owner, reader);
		const seen = reader.windowOf("owner");
		assert.ok(seen !== undefined && !seen.here);
		assert.deepEqual([seen.windowUri, seen.label, seen.liveCwds, seen.rows], ["file:///c%3A/work/app", "app", ["C:/work/app"], { "tab:1": { status: "working", incarnation: "inc-1", binding: "slot.1", lastActivityAt: "2026-10-10T09:01:00.000Z" } }]);
	});

	it("drops a window whose process is gone, and sweeps its file once the file is stale too", async () => {
		const stays = windowOf("stays", 1, "2026-10-10T09:00:00.000Z", { folders: ["C:/a"] });
		const crashes = windowOf("crashes", 2, "2026-10-10T09:01:00.000Z", { folders: ["C:/b"] });
		await publish(stays, crashes);
		assert.equal(stays.windows().length, 2);
		alive.delete(2);
		ageFile(path.join(directory, "crashes.window"), 0);
		assert.equal(await stays.refresh(), true, "the change is reported");
		assert.deepEqual(stays.windows().map(window => window.holderId), ["stays"]);
		assert.ok(fs.existsSync(path.join(directory, "crashes.window")), "a fresh file is not swept yet: the owner could be a slow, not a dead, process");
		const file = path.join(directory, "crashes.window");
		ageFile(file, 2 * LEASE);
		await stays.refresh();
		assert.ok(!fs.existsSync(file), "dead and stale: swept by any window");
	});

	it("drops a window that stopped renewing its lease even though its pid exists, and cleans it eventually", async () => {
		const stays = windowOf("stays", 1, "2026-10-10T09:00:00.000Z");
		const hung = windowOf("hung", 2, "2026-10-10T09:01:00.000Z", { folders: ["C:/hung"] });
		await publish(stays, hung);
		clock += LEASE + 1;
		assert.deepEqual(stays.windows().map(window => window.holderId), ["stays"], "synchronous reads honor the lease without any disk read");
		const file = path.join(directory, "hung.window");
		ageFile(file, 2 * LEASE);
		await stays.refresh();
		assert.ok(!fs.existsSync(file), "an unchanged expired record is removed although an unrelated process now holds its pid");
		assert.equal(stays.windows().length, 1);
	});

	it("renews the lease on every write, so a quiet window never expires", async () => {
		const quiet = windowOf("quiet", 1, "2026-10-10T09:00:00.000Z");
		const reader = windowOf("reader", 2, "2026-10-10T09:05:00.000Z");
		await publish(quiet, reader);
		clock += LEASE - 1_000;
		await quiet.flush();
		clock += LEASE - 1_000;
		await reader.refresh();
		assert.deepEqual(reader.windows().map(window => window.holderId), ["quiet", "reader"]);
	});

	it("does not trust a record stamped far in the future, such as after a backward clock change", async () => {
		const writer = windowOf("writer", 1, "2026-10-10T09:00:00.000Z");
		const reader = windowOf("reader", 2, "2026-10-10T09:05:00.000Z");
		clock = BASE + 3 * 3_600_000;
		await publish(writer, reader);
		assert.equal(reader.windows().length, 2);
		clock = BASE;
		await reader.refresh();
		assert.deepEqual(reader.windows().map(window => window.holderId), ["reader"]);
	});

	it("ignores corrupt, mislabeled, oversized and alien files, and removes stale ones", async () => {
		const reader = windowOf("reader", 1, "2026-10-10T09:00:00.000Z");
		await publish(reader);
		const forged: WindowRecord = {
			version: 1, holderId: "forged", pid: 9, startedAt: "2026-10-10T09:00:00.000Z", updatedAt: new Date(clock).toISOString(),
			windowUri: null, label: "", folders: [], liveCwds: [], rows: {},
		};
		alive.add(9);
		const bad = ["corrupt.window", "other-name.window", "huge.window"];
		fs.writeFileSync(path.join(directory, "corrupt.window"), "{ not json");
		fs.writeFileSync(path.join(directory, "other-name.window"), JSON.stringify(forged), "utf8");
		fs.writeFileSync(path.join(directory, "huge.window"), "x".repeat(600 * 1024));
		fs.writeFileSync(path.join(directory, "notes.txt"), "not a record");
		for (const name of bad) ageFile(path.join(directory, name), 0);
		await reader.refresh();
		assert.deepEqual(reader.windows().map(window => window.holderId), ["reader"]);
		assert.ok(fs.existsSync(path.join(directory, "notes.txt")), "files that are not records are none of its business");
		for (const name of bad) assert.ok(fs.existsSync(path.join(directory, name)), `${name} is not swept while fresh`);
		for (const name of bad) ageFile(path.join(directory, name), 2 * LEASE);
		await reader.refresh();
		for (const name of bad) assert.ok(!fs.existsSync(path.join(directory, name)), name);
	});

	it("validates records strictly", () => {
		const valid: WindowRecord = {
			version: 1, holderId: "abc", pid: 5, startedAt: "2026-10-10T09:00:00.000Z", updatedAt: "2026-10-10T09:00:01.000Z",
			windowUri: "file:///c%3A/x", label: "x", folders: ["C:/x"], liveCwds: [], rows: { t: { status: "running", incarnation: "g", binding: "slot.1", lastActivityAt: null } },
		};
		assert.deepEqual(parseWindowRecord(JSON.stringify(valid), "abc"), valid);
		const broken = (patch: object) => parseWindowRecord(JSON.stringify({ ...valid, ...patch }), "abc");
		assert.equal(broken({ version: 2 }), null);
		assert.equal(broken({ pid: 0 }), null);
		assert.equal(broken({ pid: 1.5 }), null);
		assert.equal(broken({ updatedAt: "yesterday" }), null);
		assert.equal(broken({ windowUri: "vscode://command/x" }), null, "navigation is a local file URI and nothing else");
		assert.equal(broken({ folders: Array.from({ length: 65 }, () => "x") }), null);
		assert.equal(broken({ rows: { t: { status: "exploded", incarnation: "g", binding: "slot.1", lastActivityAt: null } } }), null);
		assert.equal(broken({ rows: { t: { status: "running", incarnation: "bad incarnation!", binding: "slot.1", lastActivityAt: null } } }), null);
		assert.equal(broken({ rows: { t: { status: "running", incarnation: "g", binding: "slot.1", lastActivityAt: "never" } } }), null);
		assert.equal(broken({ rows: { t: { status: "running", incarnation: "g" } } }), null, "a row states its activity or says null");
		assert.equal(broken({ rows: { t: { status: "running", incarnation: "g", binding: "not a binding!", lastActivityAt: null } } }), null, "a binding is a slot and generation token");
		assert.equal(broken({ rows: { t: { status: "running", incarnation: "g", lastActivityAt: null } } }), null, "a row states its binding generation");
		assert.equal(parseWindowRecord(JSON.stringify(valid), "other"), null, "the file name must name the record's holder");
		assert.equal(parseWindowRecord(JSON.stringify({ ...valid, holderId: "../escape" }), "../escape"), null);
	});

	it("bounds what it publishes so every reader accepts it", () => {
		const rows: WindowSnapshot["rows"] = Object.fromEntries(Array.from({ length: 600 }, (_unused, at) => [`tab:${at}`, { status: "running" as const, incarnation: "g", binding: "slot.1", lastActivityAt: null }]));
		const bounded = boundWindowSnapshot({
			windowUri: "https://example.invalid/not-a-file", label: "l".repeat(10_000),
			folders: Array.from({ length: 100 }, (_unused, at) => `C:/f${at}`), liveCwds: [], rows,
		});
		assert.equal(bounded.windowUri, null);
		assert.equal(bounded.label.length, 4096);
		assert.equal(bounded.folders.length, 64);
		assert.equal(Object.keys(bounded.rows).length, 512);
	});

	it("never alters a path: one that is too long, or over the byte budget, is left out whole", () => {
		const long = `C:/${"d".repeat(5_000)}`;
		const bounded = boundWindowSnapshot({ windowUri: null, label: "", folders: ["C:/keep", long, "C:/also"], liveCwds: [long], rows: {} });
		assert.deepEqual(bounded.folders, ["C:/keep", "C:/also"]);
		assert.deepEqual(bounded.liveCwds, []);
		// 64 folders and 256 cwds of the longest accepted path would not fit one record: what is kept always does.
		const path4k = (at: number) => `C:/${String(at).padStart(5, "0")}${"p".repeat(4_000)}`;
		const fat = boundWindowSnapshot({
			windowUri: null, label: "", folders: Array.from({ length: 64 }, (_unused, at) => path4k(at)),
			liveCwds: Array.from({ length: 256 }, (_unused, at) => path4k(1_000 + at)), rows: {},
		});
		const text = JSON.stringify({ version: 1, holderId: "abc", pid: 5, startedAt: "2026-10-10T09:00:00.000Z", updatedAt: "2026-10-10T09:00:00.000Z", ...fat });
		assert.ok(Buffer.byteLength(text) <= 512 * 1024, "the written record is within what every reader reads");
		assert.ok(parseWindowRecord(text, "abc") !== null, "and every reader accepts it");
		assert.ok(fat.folders.every(folder => folder.length === 4_008), "no path was shortened");
		assert.equal(fat.folders.length, 64, "folders are kept first");
	});

	it("names a run by the claim's owner generation and the catalog's launch of it", () => {
		const entry = (generation: string | null, host: { startedAt: string; pid: number | null } | null) =>
			({ ownership: generation === null ? null : { ownerGeneration: generation }, host });
		const first = sessionIncarnation(entry("gen-1", { startedAt: "2026-10-10T09:00:00.000Z", pid: 11 }));
		assert.ok(first !== null && /^[A-Za-z0-9._:-]{1,300}$/.test(first));
		assert.notEqual(first, sessionIncarnation(entry("gen-1", { startedAt: "2026-10-10T09:30:00.000Z", pid: 12 })), "stop and resume keep the generation but are another run");
		assert.notEqual(first, sessionIncarnation(entry("gen-1", { startedAt: "2026-10-10T09:00:00.000Z", pid: 99 })));
		assert.equal(first, sessionIncarnation(entry("gen-1", { startedAt: "2026-10-10T09:00:00.000Z", pid: 11 })));
		assert.notEqual(first, sessionIncarnation(entry("gen-2", { startedAt: "2026-10-10T09:00:00.000Z", pid: 11 })));
		assert.equal(sessionIncarnation(entry(null, null)), null);
	});

	it("does not read an oversized or special file in full", async () => {
		const reader = windowOf("reader", 1, "2026-10-10T09:00:00.000Z");
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, "huge.window"), "x".repeat(600 * 1024));
		fs.mkdirSync(path.join(directory, "dir.window"));
		await reader.refresh();
		assert.deepEqual(reader.windows().map(window => window.holderId), ["reader"]);
	});

	it("reports a changed view when another window starts, changes and leaves, and not when only its lease is renewed", async () => {
		const reader = windowOf("reader", 1, "2026-10-10T09:00:00.000Z");
		const other = windowOf("other", 2, "2026-10-10T09:05:00.000Z", { folders: ["C:/one"] });
		await reader.refresh();
		assert.equal(await reader.refresh(), false, "nothing changed");
		await other.flush();
		assert.equal(await reader.refresh(), true, "a window appeared");
		clock += 5_000;
		await other.flush();
		assert.equal(await reader.refresh(), false, "a renewed lease is not a change");
		other.setSnapshot({ windowUri: null, label: "other", folders: ["C:/one", "C:/two"], liveCwds: [], rows: {} });
		await other.flush();
		assert.equal(await reader.refresh(), true, "its folders changed");
		other.removeSync();
		assert.equal(await reader.refresh(), true, "it left");
		assert.deepEqual(reader.windows().map(window => window.holderId), ["reader"]);
	});

	it("repaints other windows through the directory watch, and a normal close removes the record at once", async () => {
		const reader = windowOf("reader", 1, "2026-10-10T09:00:00.000Z");
		const other = windowOf("other", 2, "2026-10-10T09:05:00.000Z", { folders: ["C:/watched"] });
		let changes = 0;
		reader.start({ onChange: () => { changes++; } });
		await reader.flush();
		const until = async (predicate: () => boolean) => {
			for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
			assert.ok(predicate());
		};
		await other.flush();
		await until(() => reader.windows().some(window => window.holderId === "other"));
		assert.ok(changes >= 1);
		other.removeSync();
		assert.ok(!fs.existsSync(path.join(directory, "other.window")));
		await until(() => reader.windows().every(window => window.holderId === "reader"));
		assert.deepEqual(errors, []);
	});

	it("never resurrects its record after removeSync, even from a write that was in flight", async () => {
		const closing = windowOf("closing", 1, "2026-10-10T09:00:00.000Z");
		const inFlight = closing.flush();
		closing.removeSync();
		await inFlight;
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.ok(!fs.existsSync(path.join(directory, "closing.window")));
	});

	it("never resurrects its record when removeSync lands while the write is awaiting the file system", async () => {
		const closing = windowOf("closing", 1, "2026-10-10T09:00:00.000Z");
		const inFlight = closing.flush();
		await new Promise(resolve => setImmediate(resolve));
		await new Promise(resolve => setTimeout(resolve, 1));
		closing.removeSync();
		await inFlight;
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.ok(!fs.existsSync(path.join(directory, "closing.window")));
		assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith(".tmp")), [], "no staged file is left behind either");
	});

	it("tells a live pid from a gone one", () => {
		assert.equal(processExists(process.pid), true);
		assert.equal(processExists(0), false);
		assert.equal(processExists(-5), false);
		assert.equal(processExists(2 ** 22 + 12_345), false);
	});
});
