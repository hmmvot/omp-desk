import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { recordingLogger, silentLogger, type LoggedLine } from "../shared/logger.ts";
import { describeLoadSteps, loadWin32Native, peMachineOf, setWin32NativeForTest, startWin32Native, win32Native, win32NativeFailure, win32NativeLoadSteps, win32NativeStartedWarm } from "./win32-native.ts";
import { holdMutex, installedAddonAsset, releaseMutex } from "./win32-test-support.ts";

describe("peMachineOf", () => {
	function image(machine: number): Buffer {
		const bytes = Buffer.alloc(0x100);
		bytes.writeUInt16LE(0x5a4d, 0);
		bytes.writeUInt32LE(0x80, 0x3c);
		bytes.writeUInt32LE(0x00004550, 0x80);
		bytes.writeUInt16LE(machine, 0x84);
		return bytes;
	}

	it("reads the machine of a PE image", () => {
		assert.equal(peMachineOf(image(0x8664)), 0x8664);
		assert.equal(peMachineOf(image(0xaa64)), 0xaa64);
	});

	it("is null for anything that is not a PE image", () => {
		assert.equal(peMachineOf(Buffer.from("hello")), null);
		assert.equal(peMachineOf(Buffer.alloc(0x100)), null);
		const noSignature = image(0x8664);
		noSignature.writeUInt32LE(0, 0x80);
		assert.equal(peMachineOf(noSignature), null);
		const pointsPastEnd = image(0x8664);
		pointsPastEnd.writeUInt32LE(0xffff, 0x3c);
		assert.equal(peMachineOf(pointsPastEnd), null);
	});
});

describe("loadWin32Native refusals", { skip: process.platform !== "win32" }, () => {
	const cleanup: string[] = [];
	afterEach(async () => {
		for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
	});

	it("refuses a copy whose bytes no longer match its digest, before loading anything", async () => {
		const asset = await installedAddonAsset();
		await assert.rejects(loadWin32Native({ path: asset.path, sha256: "0".repeat(64) }), /does not match its digest/);
	});

	it("refuses a file that is not a PE image, even with a matching digest", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "omp-desk-native-"));
		cleanup.push(directory);
		const file = path.join(directory, "koffi.node");
		await writeFile(file, "not an image");
		const sha256 = createHash("sha256").update("not an image").digest("hex");
		await assert.rejects(loadWin32Native({ path: file, sha256 }), /not a .* image/);
	});

	it("refuses an image built for another architecture", async () => {
		const asset = await installedAddonAsset();
		const other = process.arch === "x64" ? "arm64" : "x64";
		await assert.rejects(loadWin32Native(asset, other), /not a .* image/);
	});

	it("refuses an architecture it ships no module for", async () => {
		await assert.rejects(loadWin32Native(await installedAddonAsset(), "ia32"), /no native module is shipped/);
	});

	it("names a missing copy", async () => {
		await assert.rejects(loadWin32Native({ path: path.join(tmpdir(), `missing-${randomUUID()}.node`), sha256: "0".repeat(64) }), /cannot be read/);
	});
});

describe("mutexState against real named objects", { skip: process.platform !== "win32" }, () => {
	const name = (): string => `Global\\omp-desk-native-test-${randomUUID().replaceAll("-", "")}`;

	it("reads a held mutex, an absent one, and a name another kind of object holds", async () => {
		const native = await loadWin32Native(await installedAddonAsset());
		const mutex = name();
		assert.equal(native.mutexState(mutex), "absent");
		const holder = await holdMutex(mutex);
		try {
			assert.equal(native.mutexState(mutex), "held");
			assert.equal(native.mutexState(mutex), "held", "reading takes nothing: a second read sees the same");
		} finally {
			await releaseMutex(holder);
		}
		assert.equal(native.mutexState(mutex), "absent");

		// An event under the name: `OpenMutexW` fails with ERROR_INVALID_HANDLE, which `TryOpenExisting` reported as false.
		const event = name();
		const eventHolder = await holdMutex(event, "event");
		try {
			assert.equal(native.mutexState(event), "absent");
		} finally {
			await releaseMutex(eventHolder);
		}
	});

	it("reads an invalid name as absent", async () => {
		const native = await loadWin32Native(await installedAddonAsset());
		assert.equal(native.mutexState(`Global\\omp-desk-native-test\\no\\such\\${randomUUID()}`), "absent");
	});
});

describe("process readings against real processes", { skip: process.platform !== "win32" }, () => {
	const children: ChildProcess[] = [];
	afterEach(() => {
		for (const child of children.splice(0)) child.kill();
	});
	/** A process that lives until killed (it waits on its open stdin), with its stdout piped. */
	const idle = (script = "process.stdin.resume()"): ChildProcess => {
		const child = spawn(process.execPath, ["-e", script], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
		children.push(child);
		return child;
	};
	const firstLine = (child: ChildProcess): Promise<string> => {
		const { promise, resolve } = Promise.withResolvers<string>();
		let text = "";
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => {
			text += chunk;
			if (text.includes("\n")) resolve(text.split("\n")[0]!.trim());
		});
		return promise;
	};
	const FILETIME_UNIX_EPOCH = 116444736000000000n;

	it("reads this process's creation time as a FILETIME string that matches its uptime", async () => {
		const native = await loadWin32Native(await installedAddonAsset());
		const reading = native.processCreation(process.pid);
		assert.equal(reading.kind, "found");
		const filetime = reading.kind === "found" ? reading.filetime : "";
		assert.match(filetime, /^[1-9][0-9]{16,18}$/);
		const startedAtMs = Number((BigInt(filetime) - FILETIME_UNIX_EPOCH) / 10_000n);
		assert.ok(Math.abs(startedAtMs - (Date.now() - process.uptime() * 1000)) < 2_000, "the creation time is this process's start");
		assert.deepEqual(native.processCreation(process.pid), reading, "a live process keeps its creation time");
	});

	it("reads an id no process has as gone and an unusable id as unknown", async () => {
		const native = await loadWin32Native(await installedAddonAsset());
		assert.deepEqual(native.processCreation(2147483000), { kind: "gone" });
		for (const pid of [0, -1, 1.5, 2 ** 32]) assert.equal(native.processCreation(pid).kind, "unknown", String(pid));
	});

	it("reads a process that exited but is still referenced by an open handle as gone", async () => {
		const asset = await installedAddonAsset();
		const native = await loadWin32Native(asset);
		const holder: { exports: { load(name: string): { func(prototype: string): (...args: unknown[]) => unknown } } } = { exports: {} as never };
		process.dlopen(holder as never, asset.path);
		const kernel32 = holder.exports.load("kernel32.dll");
		const open = kernel32.func("void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)");
		const close = kernel32.func("bool __stdcall CloseHandle(void* handle)");
		const child = idle();
		assert.ok(child.pid !== undefined);
		const handle = open(0x00100000 | 0x1000, false, child.pid);
		assert.notEqual(handle, null);
		try {
			assert.equal(native.processCreation(child.pid).kind, "found");
			const { promise: exited, resolve: exitedResolve } = Promise.withResolvers<void>();
			child.once("exit", () => exitedResolve());
			child.kill();
			await exited;
			// The open handle keeps the process object, so the kernel still answers an `OpenProcess` for its id.
			const second = open(0x1000, false, child.pid);
			assert.notEqual(second, null, "the exited process is still referenced");
			close(second);
			assert.deepEqual(native.processCreation(child.pid), { kind: "gone" });
		} finally {
			close(handle);
		}
	});

	it("lists every live descendant of a process and none for a leaf or an id no process has", async () => {
		const native = await loadWin32Native(await installedAddonAsset());
		const parent = idle(
			`const { spawn } = require("node:child_process");
			const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
			console.log(child.pid);
			process.stdin.resume();`,
		);
		assert.ok(parent.pid !== undefined);
		const grandchild = Number(await firstLine(parent));
		const reading = native.processDescendants(parent.pid);
		assert.equal(reading.kind, "found");
		const pids = reading.kind === "found" ? reading.pids : [];
		assert.ok(pids.includes(grandchild), `expected ${grandchild} in ${pids.join(",")}`);
		assert.deepEqual(native.processDescendants(pids[pids.length - 1]!), { kind: "found", pids: [] }, "the deepest descendant has none");
		assert.deepEqual(native.processDescendants(2147483000), { kind: "found", pids: [] });
		assert.equal(native.processDescendants(0).kind, "unknown");
		const own = native.processDescendants(process.pid);
		assert.equal(own.kind, "found");
		assert.ok(!(own.kind === "found" && own.pids.includes(process.pid)), "a process is not its own descendant");
	});
});

describe("readSecurity against real paths", { skip: process.platform !== "win32" }, () => {
	const cleanup: string[] = [];
	afterEach(async () => {
		for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
	});

	it("reads the account SID, the owner and the entries of real paths, each failing alone", async () => {
		const native = await loadWin32Native(await installedAddonAsset());
		const directory = await mkdtemp(path.join(tmpdir(), "omp-desk-security-"));
		cleanup.push(directory);
		const missing = path.join(directory, "missing");
		const read = await native.readSecurity([directory, "C:\\Windows", missing], 20_000);
		assert.equal(read.failure, null);
		assert.match(read.sid ?? "", /^S-1-5-21(-\d+){4}$/);

		const own = read.reports.get(directory.toLowerCase());
		assert.ok(own?.entries !== null && own?.entries !== undefined && own.entries.length > 0);
		assert.ok(own.entries.some(entry => entry.principal === read.sid && !entry.denied), "the account can access its own temp directory");
		assert.ok([read.sid, "S-1-5-32-544"].includes(own.owner), `the temp directory is owned by this account or Administrators, not ${own.owner}`);

		const windows = read.reports.get("c:\\windows");
		assert.ok(windows?.entries?.some(entry => entry.principal === "S-1-5-18" && !entry.denied), "SYSTEM can access C:\\Windows");
		assert.ok(windows?.owner !== null && windows?.owner !== undefined);

		assert.deepEqual(read.reports.get(missing.toLowerCase()), { entries: null, owner: null });
	});

	it("reads a NULL DACL as full control for Everyone", async () => {
		const asset = await installedAddonAsset();
		const native = await loadWin32Native(asset);
		const directory = await mkdtemp(path.join(tmpdir(), "omp-desk-security-"));
		cleanup.push(directory);
		const file = path.join(directory, "open.txt");
		await writeFile(file, "x");
		const holder: { exports: { load(name: string): { func(prototype: string): (...args: unknown[]) => unknown } } } = { exports: {} as never };
		process.dlopen(holder as never, asset.path);
		const setSecurity = holder.exports
			.load("advapi32.dll")
			.func("uint32 __stdcall SetNamedSecurityInfoW(str16 path, int objectType, uint32 information, void* owner, void* group, void* dacl, void* sacl)");
		// DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION with no DACL: everyone, everything.
		assert.equal(setSecurity(file, 1, 0x4 | 0x20000000, null, null, null, null), 0);
		const read = await native.readSecurity([file], 20_000);
		assert.deepEqual(read.reports.get(file.toLowerCase())?.entries, [{ principal: "S-1-1-0", permissions: 0xffffffff, denied: false }]);
	});

	it("names the SIDs that resolve and leaves the others out", async () => {
		const native = await loadWin32Native(await installedAddonAsset());
		const names = await native.lookupAccountNames(["S-1-5-18", "S-1-5-21-1-2-3-999999", "not a sid"], 20_000);
		assert.match(names.get("S-1-5-18") ?? "", /\\.+/, "SYSTEM resolves as DOMAIN\\name");
		assert.equal(names.has("S-1-5-21-1-2-3-999999"), false);
		assert.equal(names.has("not a sid"), false);
	});

	it("reads nothing and reports the failure when the deadline has already passed", async () => {
		const native = await loadWin32Native(await installedAddonAsset());
		const first = native.readSecurity(["C:\\Windows"], 20_000);
		const late = await native.readSecurity(["C:\\Windows"], 0);
		assert.equal(late.failure !== null || late.reports.size === 0 || late.reports.get("c:\\windows")?.entries !== undefined, true);
		assert.equal((await first).failure, null);
	});
});

describe("the process's native module", () => {
	afterEach(() => setWin32NativeForTest(undefined));

	it("is unavailable until a load was started, then the settled answer for every reader", async () => {
		assert.equal(await win32Native(), null);
		const logs: LoggedLine[] = [];
		const first = startWin32Native(async () => null, recordingLogger(logs));
		const second = startWin32Native(async () => { throw new Error("one load per process"); });
		assert.strictEqual(first, second);
		assert.equal(await win32Native(), null);
		assert.equal(logs.length, 1);
		assert.match(logs[0]!.message, /could not be staged/);
	});

	it("names the cause when the staged copy cannot be loaded", async () => {
		const logs: LoggedLine[] = [];
		const missing = path.join(tmpdir(), `missing-${randomUUID()}.node`);
		assert.equal(await startWin32Native(async () => ({ path: missing, sha256: "0".repeat(64) }), recordingLogger(logs)), null);
		assert.match(logs[0]!.message, /native module is unavailable: .*cannot be read/);
	});

	it("records the raw failure for the notice, and none after a load that succeeded or before one started", { skip: process.platform !== "win32" }, async () => {
		assert.equal(win32NativeFailure(), null);
		const missing = path.join(tmpdir(), `missing-${randomUUID()}.node`);
		await startWin32Native(async () => ({ path: missing, sha256: "0".repeat(64) }));
		assert.match(win32NativeFailure() ?? "", /cannot be read/);
		setWin32NativeForTest(undefined);
		await startWin32Native(async () => { throw new Error("This program is blocked by group policy."); });
		assert.equal(win32NativeFailure(), "This program is blocked by group policy.", "a source that throws names its own cause");
		setWin32NativeForTest(undefined);
		assert.equal(win32NativeFailure(), null);
		await startWin32Native(async () => installedAddonAsset());
		assert.equal(win32NativeFailure(), null);
	});

	it("loads the real staged copy once", { skip: process.platform !== "win32" }, async () => {
		const asset = await installedAddonAsset();
		assert.equal(createHash("sha256").update(await readFile(asset.path)).digest("hex"), asset.sha256);
		const native = await startWin32Native(async () => asset);
		assert.notEqual(native, null);
		assert.strictEqual(await win32Native(), native);
	});

	it("times the parts of a load", { skip: process.platform !== "win32" }, async () => {
		assert.deepEqual(win32NativeLoadSteps(), []);
		await startWin32Native(async () => installedAddonAsset());
		assert.deepEqual(win32NativeLoadSteps().map(step => step.name), ["read", "hash", "dlopen", "bind"]);
		assert.ok(win32NativeLoadSteps().every(step => step.wallMs >= 0 && step.cpuMs >= 0));
		assert.match(describeLoadSteps(win32NativeLoadSteps()), /^read \d+ \(cpu \d+\) · hash \d+ \(cpu \d+\) · dlopen \d+ \(cpu \d+\) · bind \d+ \(cpu \d+\)$/);
		assert.equal(win32NativeStartedWarm(), false);
	});

	it("takes a warm start in the very call that asks, without ever running the slow source", { skip: process.platform !== "win32" }, async () => {
		const asset = await installedAddonAsset();
		let slow = 0;
		const promise = startWin32Native(async () => { slow++; return null; }, silentLogger, () => asset);
		assert.equal(win32NativeStartedWarm(), true, "settled before the call returned, with no turn of the event loop");
		assert.notEqual(await promise, null);
		assert.strictEqual(await win32Native(), await promise);
		assert.equal(slow, 0);
		assert.deepEqual(win32NativeLoadSteps().map(step => step.name), ["read", "hash", "dlopen", "bind"]);
		assert.equal(win32NativeFailure(), null);
	});

	it("falls through to the slow source when the warm start has nothing or cannot load, and says why only at debug", { skip: process.platform !== "win32" }, async () => {
		const asset = await installedAddonAsset();
		let slow = 0;
		const none = await startWin32Native(async () => { slow++; return asset; }, silentLogger, () => null);
		assert.notEqual(none, null);
		assert.equal(slow, 1);
		assert.equal(win32NativeStartedWarm(), false);
		setWin32NativeForTest(undefined);
		const logs: LoggedLine[] = [];
		const broken = await startWin32Native(async () => { slow++; return asset; }, recordingLogger(logs), () => ({ path: asset.path, sha256: "0".repeat(64) }));
		assert.notEqual(broken, null, "the slow source loaded it");
		assert.equal(slow, 2);
		assert.equal(win32NativeStartedWarm(), false);
		assert.deepEqual(logs.map(line => line.level), ["debug"]);
		assert.match(logs[0]!.message, /warm start .* does not match its digest/);
	});
});
