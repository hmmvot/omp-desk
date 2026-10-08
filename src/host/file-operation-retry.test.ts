import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { retryWindowsFileOperation } from "./file-operation-retry.ts";

const failure = (code: string) => Object.assign(new Error(code), { code });

describe("Windows atomic replacement retries", () => {
	it("keeps the old target complete until sharing failures clear, then atomically publishes the successor", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "omp-atomic-retry-"));
		const target = path.join(root, "claim");
		const staged = path.join(root, "claim.staged");
		await writeFile(target, "old-owner");
		await writeFile(staged, "new-owner");
		const delays: number[] = [];
		let calls = 0;
		try {
			await retryWindowsFileOperation(async () => {
				const code = ["EPERM", "EBUSY", "EACCES"][calls++];
				if (code !== undefined) throw failure(code);
				await rename(staged, target);
			}, { platform: "win32", wait: async ms => {
				delays.push(ms);
				assert.equal(await readFile(target, "utf8"), "old-owner");
				assert.equal(await readFile(staged, "utf8"), "new-owner");
			} });
			assert.equal(await readFile(target, "utf8"), "new-owner");
			await assert.rejects(readFile(staged), { code: "ENOENT" });
			assert.deepEqual(delays, [25, 50, 100]);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("exhausts a bounded backoff and propagates the original failure", async () => {
		const denied = failure("EPERM");
		let calls = 0;
		const waits: number[] = [];
		await assert.rejects(retryWindowsFileOperation(async () => { calls++; throw denied; }, {
			platform: "win32", wait: async ms => { waits.push(ms); },
		}), error => error === denied);
		assert.equal(calls, 7);
		assert.deepEqual(waits, [25, 50, 100, 200, 250, 250]);
	});

	it("never retries other errors or non-Windows permissions", async () => {
		for (const [platform, code] of [["win32", "ENOSPC"], ["linux", "EPERM"]] as const) {
			let calls = 0;
			await assert.rejects(retryWindowsFileOperation(async () => { calls++; throw failure(code); }, {
				platform, wait: async () => { assert.fail("must not wait"); },
			}), { code });
			assert.equal(calls, 1);
		}
	});
});
