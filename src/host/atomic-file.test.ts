import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RENAME_BACKOFF_MS, renameReplacing } from "./atomic-file.ts";

const sharing = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

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
