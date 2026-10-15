import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { recordingLogger, type LoggedLine } from "../shared/logger.ts";
import { loadWin32Native, peMachineOf, setWin32NativeForTest, startWin32Native, win32Native } from "./win32-native.ts";
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

	it("loads the real staged copy once", { skip: process.platform !== "win32" }, async () => {
		const asset = await installedAddonAsset();
		assert.equal(createHash("sha256").update(await readFile(asset.path)).digest("hex"), asset.sha256);
		const native = await startWin32Native(async () => asset);
		assert.notEqual(native, null);
		assert.strictEqual(await win32Native(), native);
	});
});
