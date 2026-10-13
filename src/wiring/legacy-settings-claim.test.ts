/**
 * The profile-wide claim on the User layer for the settings move: one holder at a time, released on purpose, taken over once
 * stale, and never a reason for the move not to run. Runner: `node --test src/wiring/legacy-settings-claim.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { CLAIM_STALE_MS, fileClaim } from "./legacy-settings-claim.ts";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "omp-claim-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

describe("the file claim", () => {
	it("is held by one window, refused to the next, and free again after the release", async () => {
		const file = path.join(dir, "nested", "settings-move.claim");
		const first = fileClaim(file);
		const second = fileClaim(file);
		const held = await first.claimUserLayer();
		assert.notEqual(held, null);
		assert.equal(await second.claimUserLayer(), null);
		await held?.release();
		assert.equal(await exists(file), false);
		const next = await second.claimUserLayer();
		assert.notEqual(next, null);
		await next?.release();
		await next?.release();
	});

	it("is taken over once it is stale: its holder died mid-move", async () => {
		const file = path.join(dir, "settings-move.claim");
		await writeFile(file, "{}");
		const old = new Date(Date.now() - CLAIM_STALE_MS - 5_000);
		await utimes(file, old, old);
		const claim = await fileClaim(file).claimUserLayer();
		assert.notEqual(claim, null);
		await claim?.release();
	});

	it("lets a waiter go the moment the holder releases, and gives up at its limit", async () => {
		const file = path.join(dir, "settings-move.claim");
		const holder = fileClaim(file);
		const waiter = fileClaim(file, { pollMs: 1 });
		assert.equal(await waiter.waitForRelease(50), true, "nothing is held");
		const held = await holder.claimUserLayer();
		let clock = 0;
		const patient = fileClaim(file, { pollMs: 1, now: () => (clock += 10) });
		assert.equal(await patient.waitForRelease(30), false, "the holder never let go");
		const waiting = waiter.waitForRelease(10_000);
		await held?.release();
		assert.equal(await waiting, true);
	});

	it("is granted without coordination when the storage refuses the file", async () => {
		const blocked = path.join(dir, "file-not-dir");
		await writeFile(blocked, "x");
		const claim = await fileClaim(path.join(blocked, "settings-move.claim")).claimUserLayer();
		assert.notEqual(claim, null, "a storage that cannot hold the claim must not stop the move");
		await claim?.release();
	});
});
