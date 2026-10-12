import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsDefault from "node:fs/promises";
import * as fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, mock } from "node:test";
import {
	FILE_OPERATION_BACKOFF_MS,
	RENAME_BACKOFF_MS,
	renameReplacing,
	replaceFileAtomic,
	retryFileOperation,
	stageBeside,
} from "./atomic-file.ts";

const sharing = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
const failure = (code: string) => Object.assign(new Error(code), { code });

async function withDirectory(body: (directory: string) => Promise<void>): Promise<void> {
	const directory = await fsp.mkdtemp(path.join(tmpdir(), "omp-atomic-file-"));
	try {
		await body(directory);
	} finally {
		await fsp.rm(directory, { recursive: true, force: true });
	}
}

describe("rename retry policy", () => {
	it("waits about two seconds in all, with growing pauses", () => {
		const total = RENAME_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0);
		assert.ok(total >= 2000 && total <= 2200, `total ${total}`);
		assert.deepEqual([...RENAME_BACKOFF_MS], [...RENAME_BACKOFF_MS].sort((a, b) => a - b));
	});

	it("retries a blocked rename until it lands", async () => {
		let failures = 3;
		const waits: number[] = [];
		await renameReplacing(async () => { if (failures-- > 0) throw sharing("EPERM"); }, async ms => { waits.push(ms); });
		assert.deepEqual(waits, RENAME_BACKOFF_MS.slice(0, 3));
	});

	it("gives up after the whole window and throws the last sharing error", async () => {
		const waits: number[] = [];
		let attempts = 0;
		await assert.rejects(renameReplacing(async () => { attempts++; throw sharing("EBUSY"); }, async ms => { waits.push(ms); }), /EBUSY/);
		assert.equal(attempts, RENAME_BACKOFF_MS.length + 1);
		assert.deepEqual(waits, [...RENAME_BACKOFF_MS]);
	});

	it("does not retry an error that is not a sharing violation", async () => {
		let attempts = 0;
		await assert.rejects(renameReplacing(async () => { attempts++; throw sharing("ENOENT"); }, async () => {}), /ENOENT/);
		assert.equal(attempts, 1);
	});
});

describe("Windows file operation retries", () => {
	it("waits about a second in all over seven attempts, with growing pauses", () => {
		assert.deepEqual([...FILE_OPERATION_BACKOFF_MS], [25, 50, 100, 200, 250, 250]);
	});

	it("keeps the old target complete until sharing failures clear, then atomically publishes the successor", async () => {
		await withDirectory(async root => {
			const target = path.join(root, "claim");
			const staged = path.join(root, "claim.staged");
			await fsp.writeFile(target, "old-owner");
			await fsp.writeFile(staged, "new-owner");
			const delays: number[] = [];
			let calls = 0;
			await retryFileOperation(async () => {
				const code = ["EPERM", "EBUSY", "EACCES"][calls++];
				if (code !== undefined) throw failure(code);
				await fsp.rename(staged, target);
			}, FILE_OPERATION_BACKOFF_MS, { platform: "win32", wait: async ms => {
				delays.push(ms);
				assert.equal(await fsp.readFile(target, "utf8"), "old-owner");
				assert.equal(await fsp.readFile(staged, "utf8"), "new-owner");
			} });
			assert.equal(await fsp.readFile(target, "utf8"), "new-owner");
			await assert.rejects(fsp.readFile(staged), { code: "ENOENT" });
			assert.deepEqual(delays, [25, 50, 100]);
		});
	});

	it("exhausts a bounded backoff and propagates the original failure", async () => {
		const denied = failure("EPERM");
		let calls = 0;
		const waits: number[] = [];
		await assert.rejects(retryFileOperation(async () => { calls++; throw denied; }, FILE_OPERATION_BACKOFF_MS, {
			platform: "win32", wait: async ms => { waits.push(ms); },
		}), error => error === denied);
		assert.equal(calls, 7);
		assert.deepEqual(waits, [25, 50, 100, 200, 250, 250]);
	});

	it("runs as many attempts as the budget it is given has waits, plus one", async () => {
		let calls = 0;
		await assert.rejects(retryFileOperation(async () => { calls++; throw failure("EBUSY"); }, FILE_OPERATION_BACKOFF_MS.slice(0, 2), {
			platform: "win32", wait: async () => {},
		}), { code: "EBUSY" });
		assert.equal(calls, 3);
	});

	it("never retries other errors or non-Windows permissions", async () => {
		for (const [platform, code] of [["win32", "ENOSPC"], ["linux", "EPERM"]] as const) {
			let calls = 0;
			await assert.rejects(retryFileOperation(async () => { calls++; throw failure(code); }, FILE_OPERATION_BACKOFF_MS, {
				platform, wait: async () => { assert.fail("must not wait"); },
			}), { code });
			assert.equal(calls, 1);
		}
	});
});

describe("stageBeside", () => {
	it("writes a private sibling named for the process, flushed on request, and returns its path", async () => {
		await withDirectory(async root => {
			const target = path.join(root, "record.json");
			const staged = await stageBeside(target, "text", { sync: true });
			assert.equal(path.dirname(staged), root);
			assert.match(path.basename(staged), new RegExp(`^record\\.json\\.${process.pid}\\.[0-9a-f-]{36}\\.tmp$`));
			assert.equal(await fsp.readFile(staged, "utf8"), "text");
			const binary = await stageBeside(target, new Uint8Array([0, 255, 1]));
			assert.notEqual(binary, staged);
			assert.deepEqual([...await fsp.readFile(binary)], [0, 255, 1]);
			await assert.rejects(fsp.stat(target), { code: "ENOENT" });
		});
	});

	it("stages in another directory, keeping the target's name, when asked", async () => {
		await withDirectory(async root => {
			const area = path.join(root, "area");
			await fsp.mkdir(area);
			const staged = await stageBeside(path.join(root, "blob"), "x", { stagingDirectory: area });
			assert.equal(path.dirname(staged), area);
			assert.match(path.basename(staged), /^blob\./);
		});
	});

	it("never reuses or overwrites an entry that already has the staged name", async () => {
		await withDirectory(async root => {
			const target = path.join(root, "record.json");
			const fixed = "00000000-0000-4000-8000-000000000000";
			const foreign = `${target}.${process.pid}.${fixed}.tmp`;
			await fsp.writeFile(foreign, "someone else's");
			mock.method(crypto, "randomUUID", () => fixed);
			syncBuiltinESMExports();
			try {
				await assert.rejects(stageBeside(target, "mine"), { code: "EEXIST" });
			} finally {
				mock.restoreAll();
				syncBuiltinESMExports();
			}
			assert.equal(await fsp.readFile(foreign, "utf8"), "someone else's");
		});
	});
});

describe("replaceFileAtomic", () => {
	it("creates the file and its directory, then replaces the content leaving no staged entry", async () => {
		await withDirectory(async root => {
			const target = path.join(root, "nested", "record.json");
			await replaceFileAtomic(target, "first");
			assert.equal(await fsp.readFile(target, "utf8"), "first");
			await replaceFileAtomic(target, new Uint8Array(Buffer.from("second")), { sync: true, mode: 0o600 });
			assert.equal(await fsp.readFile(target, "utf8"), "second");
			assert.deepEqual(await fsp.readdir(path.dirname(target)), ["record.json"]);
		});
	});

	it("does not create a directory when told the directory exists", async () => {
		await withDirectory(async root => {
			await assert.rejects(replaceFileAtomic(path.join(root, "missing", "record.json"), "x", { createDirectory: false }), { code: "ENOENT" });
			await assert.rejects(fsp.stat(path.join(root, "missing")), { code: "ENOENT" });
		});
	});

	it("leaves the target alone and removes the staged entry when the rename fails", async () => {
		await withDirectory(async root => {
			const target = path.join(root, "occupied");
			await fsp.mkdir(target);
			await fsp.writeFile(path.join(target, "inner"), "keep");
			await assert.rejects(replaceFileAtomic(target, "new", { backoff: [] }));
			assert.equal(await fsp.readFile(path.join(target, "inner"), "utf8"), "keep");
			assert.deepEqual(await fsp.readdir(root), ["occupied"]);
		});
	});

	it("does not touch a staged entry another writer made, and fails instead", async () => {
		await withDirectory(async root => {
			const target = path.join(root, "record.json");
			await fsp.writeFile(target, "old");
			const fixed = "11111111-1111-4111-8111-111111111111";
			const foreign = `${target}.${process.pid}.${fixed}.tmp`;
			await fsp.writeFile(foreign, "someone else's");
			mock.method(crypto, "randomUUID", () => fixed);
			syncBuiltinESMExports();
			try {
				await assert.rejects(replaceFileAtomic(target, "new"), { code: "EEXIST" });
			} finally {
				mock.restoreAll();
				syncBuiltinESMExports();
			}
			assert.equal(await fsp.readFile(target, "utf8"), "old");
			assert.equal(await fsp.readFile(foreign, "utf8"), "someone else's");
		});
	});

	it("waits out the backoff it is given, one attempt more than it has waits", { skip: process.platform !== "win32" }, async () => {
		await withDirectory(async root => {
			const target = path.join(root, "record.json");
			const original = fsDefault.rename;
			let attempts = 0;
			mock.method(fsDefault, "rename", async (from: string, to: string) => {
				attempts++;
				if (attempts <= 2) throw sharing("EPERM");
				return original(from, to);
			});
			syncBuiltinESMExports();
			try {
				await replaceFileAtomic(target, "landed", { backoff: [1, 1] });
				assert.equal(attempts, 3);
				attempts = 0;
				await assert.rejects(replaceFileAtomic(path.join(root, "second.json"), "never", { backoff: [1] }), { code: "EPERM" });
				assert.equal(attempts, 2);
			} finally {
				mock.restoreAll();
				syncBuiltinESMExports();
			}
			assert.equal(await fsp.readFile(target, "utf8"), "landed");
			assert.deepEqual((await fsp.readdir(root)).sort(), ["record.json"]);
		});
	});

	it("stages in the directory it is given and renames from there", async () => {
		await withDirectory(async root => {
			const area = path.join(root, "tmp");
			const records = path.join(root, "records");
			await fsp.mkdir(area);
			await fsp.mkdir(records);
			await replaceFileAtomic(path.join(records, "a.json"), "a", { sync: true, createDirectory: false, stagingDirectory: area });
			assert.equal(await fsp.readFile(path.join(records, "a.json"), "utf8"), "a");
			assert.deepEqual(await fsp.readdir(records), ["a.json"]);
			assert.deepEqual(await fsp.readdir(area), []);
		});
	});
});
