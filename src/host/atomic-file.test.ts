import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RENAME_BACKOFF_MS, renameReplacing, renameReplacingSync } from "./atomic-file.ts";

const sharing = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

describe("rename retry policy", () => {
	it("waits about two seconds in all, with growing pauses", () => {
		const total = RENAME_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0);
		assert.ok(total >= 2000 && total <= 2200, `total ${total}`);
		assert.deepEqual([...RENAME_BACKOFF_MS], [...RENAME_BACKOFF_MS].sort((a, b) => a - b));
	});

	it("retries a blocked rename until it lands (sync)", () => {
		let failures = 3;
		const waits: number[] = [];
		renameReplacingSync(() => { if (failures-- > 0) throw sharing("EPERM"); }, ms => { waits.push(ms); });
		assert.deepEqual(waits, RENAME_BACKOFF_MS.slice(0, 3));
	});

	it("gives up after the whole window and throws the last sharing error (sync)", () => {
		const waits: number[] = [];
		let attempts = 0;
		assert.throws(
			() => renameReplacingSync(() => { attempts++; throw sharing("EBUSY"); }, ms => { waits.push(ms); }),
			/EBUSY/,
		);
		assert.equal(attempts, RENAME_BACKOFF_MS.length + 1);
		assert.deepEqual(waits, [...RENAME_BACKOFF_MS]);
	});

	it("does not retry an error that is not a sharing violation", () => {
		let attempts = 0;
		assert.throws(() => renameReplacingSync(() => { attempts++; throw sharing("ENOENT"); }, () => {}), /ENOENT/);
		assert.equal(attempts, 1);
	});

	it("applies the same policy to the async rename", async () => {
		let failures = 2;
		const waits: number[] = [];
		await renameReplacing(async () => { if (failures-- > 0) throw sharing("EACCES"); }, async ms => { waits.push(ms); });
		assert.deepEqual(waits, RENAME_BACKOFF_MS.slice(0, 2));

		let attempts = 0;
		await assert.rejects(renameReplacing(async () => { attempts++; throw sharing("EPERM"); }, async () => {}), /EPERM/);
		assert.equal(attempts, RENAME_BACKOFF_MS.length + 1);
	});
});
