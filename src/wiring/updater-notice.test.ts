/**
 * The notice for sessions ended by VS Code's updater: what the updater's log is read as, which brokers count as its victims,
 * and that the user is told once. Log lines are the ones Inno Updater 0.26.0 wrote on 2026-10-13. Runner:
 * `node --test src/wiring/updater-notice.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { announceUpdaterTerminations, parseUpdaterLog, UPDATER_NOTICE_MAX_AGE_MS } from "./updater-notice.ts";
import type { BrokerDescriptor, UpdaterNoticePort } from "./updater-notice.ts";

const LOG = [
	"Oct 13 23:02:54.344 INFO 7 processes still running: [180700, 158360, 120040, 17240], waiting...",
	"Oct 13 23:03:24.060 INFO Gave up waiting for Code.exe to exit, 7 processes still running: [180700, 158360, 120040, 17240]",
	"Oct 13 23:03:24.060 INFO Attempting best-effort termination of 4 remaining Code.exe processes: [180700, 158360, 120040, 17240]",
	"Oct 13 23:03:24.060 INFO Code.exe, pid 180700 is still running, attempting termination",
	"Oct 13 23:03:24.062 INFO Termination requested for Code.exe, pid 180700, waiting for exit",
	"Oct 13 23:03:24.087 INFO Confirmed Code.exe, pid 180700 has exited",
	"Oct 13 23:03:24.087 INFO Code.exe, pid 158360 is still running, attempting termination",
	"Oct 13 23:03:24.118 INFO Confirmed Code.exe, pid 158360 has exited",
	"Oct 13 23:03:24.118 INFO Code.exe, pid 120040 is still running, attempting termination",
	"Oct 13 23:03:24.145 INFO Code.exe, pid 17240 is still running, attempting termination",
	"Oct 13 23:03:24.614 INFO Update completed successfully",
].join("\r\n");

const STARTED = Date.UTC(2026, 9, 13, 21, 2, 54);
const NAME = `vscode-inno-updater-${STARTED / 1000}.log`;

function port(overrides: Partial<UpdaterNoticePort> & { logs?: Record<string, string>; descriptors?: BrokerDescriptor[] } = {}): UpdaterNoticePort & { lines: string[]; notices: string[]; marked: string[] } {
	const lines: string[] = [];
	const notices: string[] = [];
	const marked: string[] = [];
	const logs = overrides.logs ?? { [NAME]: LOG };
	return {
		updaterLogNames: async () => Object.keys(logs),
		readUpdaterLog: async name => logs[name] ?? null,
		brokerDescriptors: async () => overrides.descriptors ?? [
			{ brokerPid: 158360, title: "OMP: omp-vscode-e2e", kind: "managed-rpc" },
			{ brokerPid: 17240, title: "OMP: omp-vscode-docs", kind: "managed-rpc" },
			{ brokerPid: 4242, title: "OMP: other", kind: "managed-rpc" },
		],
		announced: () => null,
		markAnnounced: async name => { marked.push(name); },
		now: () => STARTED + 90_000,
		log: line => lines.push(line),
		notify: message => notices.push(message),
		...overrides,
		lines, notices, marked,
	};
}

describe("the updater log", () => {
	it("names the processes the updater terminated and when, and nothing else", () => {
		assert.deepEqual(parseUpdaterLog(LOG), { stamp: "Oct 13 23:03:24", pids: [180700, 158360, 120040, 17240] });
	});

	it("is not a termination when the updater only waited and every process left in time", () => {
		assert.equal(parseUpdaterLog("Oct 13 19:28:18.543 INFO Starting update, silent = false\nOct 13 19:28:18.600 INFO Update completed successfully"), null);
	});
});

describe("the notice", () => {
	it("counts the brokers whose pid the updater terminated, logs them and tells the user once", async () => {
		const p = port();
		await announceUpdaterTerminations(p);
		assert.equal(p.lines.length, 1);
		assert.match(p.lines[0] ?? "", /terminated 4 Code\.exe processes at Oct 13 23:03:24, 2 of them background processes of this extension \(pids 158360, 17240\)/);
		assert.equal(p.notices.length, 1);
		assert.match(p.notices[0] ?? "", /the 2 processes of the sessions that were running at 23:03:24/);
		assert.deepEqual(p.marked, [NAME]);
	});

	it("says nothing when none of the terminated processes was one of this extension's brokers", async () => {
		const p = port({ descriptors: [{ brokerPid: 4242, title: null, kind: "managed-rpc" }] });
		await announceUpdaterTerminations(p);
		assert.deepEqual([p.lines, p.notices, p.marked], [[], [], []]);
	});

	it("does not repeat itself for a log the profile already announced", async () => {
		const p = port({ announced: () => NAME });
		await announceUpdaterTerminations(p);
		assert.deepEqual([p.lines, p.notices], [[], []]);
	});

	it("ignores an updater log older than the windows that just opened", async () => {
		const p = port({ now: () => STARTED + UPDATER_NOTICE_MAX_AGE_MS + 1_000 });
		await announceUpdaterTerminations(p);
		assert.deepEqual([p.lines, p.notices], [[], []]);
	});

	it("never throws: an unreadable temp directory is one log line", async () => {
		const p = port({ updaterLogNames: async () => { throw new Error("EPERM"); } });
		await announceUpdaterTerminations(p);
		assert.deepEqual(p.lines, ["updater notice: not checked: EPERM"]);
	});
});
