/**
 * Tests for the loss notices and the evidence aggregator (ADR-0081).
 *
 * Runner: `node --test src/host/catalog-loss.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BackupInspection } from "./catalog-backup.ts";
import {
	CatalogLossReporter,
	LOSS_GATHER_EXTENSION_MS,
	LOSS_GATHER_MS,
	NO_EVIDENCE,
	formatAge,
	hasEvidence,
	lossNotice,
	regressedNotice,
	restoredNotice,
} from "./catalog-loss.ts";
import type { CatalogLossDeps, LossNotice, LossNoticeKind } from "./catalog-loss.ts";

interface Harness {
	readonly reporter: CatalogLossReporter;
	readonly shown: LossNotice[];
	readonly logs: string[];
	readonly claimed: LossNoticeKind[];
	/** Advance the fake clock and run what is due. */
	advance(ms: number): Promise<void>;
}

function harness(backup: BackupInspection, claim = true): Harness {
	let now = 0;
	const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
	const shown: LossNotice[] = [];
	const logs: string[] = [];
	const claimed: LossNoticeKind[] = [];
	const deps: CatalogLossDeps = {
		inspectBackup: async () => backup,
		claimNotice: async kind => {
			claimed.push(kind);
			return claim;
		},
		show: notice => shown.push(notice),
		log: (level, message) => logs.push(`${level}: ${message}`),
		setTimer: (callback, ms) => {
			const timer = { at: now + ms, callback, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
	};
	return {
		reporter: new CatalogLossReporter(deps),
		shown,
		logs,
		claimed,
		async advance(ms) {
			now += ms;
			for (const timer of timers.filter(entry => !entry.cancelled && entry.at <= now)) {
				timer.cancelled = true;
				timer.callback();
			}
			await new Promise<void>(resolve => setImmediate(resolve));
			await new Promise<void>(resolve => setImmediate(resolve));
		},
	};
}

describe("notice texts", () => {
	it("names the age of the copy coarsely", () => {
		assert.equal(formatAge(10_000), "less than a minute");
		assert.equal(formatAge(60_000), "1 minute");
		assert.equal(formatAge(5 * 60_000), "5 minutes");
		assert.equal(formatAge(3 * 3_600_000), "3 hours");
		assert.equal(formatAge(5 * 86_400_000), "5 days");
	});

	it("says what was restored and what still runs without a record, naming the Sessions view", () => {
		const plain = restoredNotice({ rows: 40, folders: 3, ageMs: 4 * 60_000, brokersRestored: 0, unmanagedBrokers: 0 });
		assert.equal(plain.message, "OMP Desk found its saved sessions missing and restored 40 sessions and 3 folders from the backup made 4 minutes ago.");
		assert.deepEqual(plain.actions, ["show-log"]);
		const running = restoredNotice({ rows: 1, folders: 1, ageMs: 0, brokersRestored: 2, unmanagedBrokers: 1 });
		assert.match(running.message, /2 running sessions can be reconnected by opening them/);
		assert.match(running.message, /1 OMP process still runs without a record; it is listed in the Sessions view/);
		assert.deepEqual(running.actions, ["show-log", "show-sessions"]);
		assert.doesNotMatch(running.message, /Processes/);
	});

	it("distinguishes no backup from one that could not be used", () => {
		const evidence = { observations: 6, restoredEditors: 2, unmanagedBrokers: 7, recordFiles: 0 };
		const none = lossNotice("no-backup", evidence, null);
		assert.match(none.message, /no backup exists/);
		assert.match(none.message, /This window remembers 6 sessions; 2 open editors belong to sessions that are gone; 7 OMP processes still run without a record\./);
		assert.deepEqual(none.actions, ["show-log", "show-sessions"]);
		const unusable = lossNotice("backup-unusable", evidence, "the recovery folder cannot be shown owner-only");
		assert.match(unusable.message, /a backup exists but could not be used \(the recovery folder cannot be shown owner-only\)/);
		assert.doesNotMatch(unusable.message, /no backup exists/);
	});

	it("points a regression at the backup folder", () => {
		const notice = regressedNotice({ rows: 40, folders: 3 }, { rows: 2, folders: 1 });
		assert.match(notice.message, /2 sessions and 1 folder now, 40 and 3 before/);
		assert.deepEqual(notice.actions, ["show-log", "show-backup-folder"]);
	});
});

describe("loss reporter", () => {
	it("shows nothing for a first install: no evidence, no notice", async () => {
		const run = harness({ state: "none" });
		run.reporter.arm();
		run.reporter.add(NO_EVIDENCE);
		await run.advance(60_000);
		assert.equal(run.shown.length, 0);
		assert.deepEqual(run.logs, []);
	});

	it("shows one notice after the gather wait, with a warning in the log", async () => {
		const run = harness({ state: "none" });
		run.reporter.arm();
		run.reporter.add({ observations: 4 });
		await run.advance(LOSS_GATHER_MS - 1);
		assert.equal(run.shown.length, 0);
		await run.advance(2);
		assert.equal(run.shown.length, 1);
		assert.equal(run.shown[0]?.kind, "no-backup");
		assert.match(run.logs[0] ?? "", /^warn: catalog: the saved sessions are missing and could not be restored \(no backup\)/);
		assert.deepEqual(run.claimed, ["no-backup"]);
	});

	it("waits once more when evidence arrives inside the wait, and folds late evidence into the log only", async () => {
		const run = harness({ state: "unusable", reason: "damaged" });
		run.reporter.arm();
		run.reporter.add({ observations: 3 });
		await run.advance(LOSS_GATHER_MS - 500);
		run.reporter.add({ restoredEditors: 1 });
		await run.advance(LOSS_GATHER_MS);
		assert.equal(run.shown.length, 0, "the wait was extended");
		await run.advance(LOSS_GATHER_EXTENSION_MS);
		assert.equal(run.shown.length, 1);
		assert.equal(run.shown[0]?.kind, "backup-unusable");
		assert.match(run.shown[0]?.message ?? "", /1 open editor belongs/);

		run.reporter.add({ restoredEditors: 1 });
		await run.advance(60_000);
		assert.equal(run.shown.length, 1, "no second notice");
		assert.match(run.logs.at(-1) ?? "", /more evidence of lost sessions arrived after the notice/);
	});

	it("counts nothing unless armed, and shows nothing when another window already showed the notice", async () => {
		const unarmed = harness({ state: "none" });
		unarmed.reporter.add({ observations: 4 });
		await unarmed.advance(60_000);
		assert.equal(unarmed.shown.length, 0);

		const second = harness({ state: "none" }, false);
		second.reporter.arm();
		second.reporter.add({ observations: 4 });
		await second.advance(LOSS_GATHER_MS + 1);
		assert.equal(second.shown.length, 0);
		assert.equal(second.logs.length, 1, "it is still logged by this window");
	});

	it("reports no loss when a usable backup exists after all", async () => {
		const run = harness({ state: "available", copy: { name: "x", generation: 1, revision: 1, rows: 1, folders: 0, hash: "00000000" }, mtimeMs: 0 });
		run.reporter.arm();
		run.reporter.add({ observations: 1 });
		await run.advance(LOSS_GATHER_MS + 1);
		assert.equal(run.shown.length, 0);
	});

	it("knows evidence when it sees it", () => {
		assert.equal(hasEvidence(NO_EVIDENCE), false);
		assert.equal(hasEvidence({ ...NO_EVIDENCE, recordFiles: 1 }), true);
	});
});
