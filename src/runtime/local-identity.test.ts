/**
 * Identity binding when the process serves a conversation another tab already owns: the tab says so once and keeps
 * retrying, so it binds when the other conversation releases the file.
 *
 * Runner: `node --test src/runtime/local-identity.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionHostRuntime } from "../host/native-session.ts";
import type { SessionIndex } from "../host/session-index.ts";
import { recordingLogger } from "../shared/logger.ts";
import type { LoggedLine } from "../shared/logger.ts";
import { LocalIdentity } from "./local-identity.ts";
import type { IdentityWindow } from "./local-identity.ts";
import type { RuntimeRecords } from "./runtime-record.ts";

const TAB = "tab:draft";
const FILE = "C:\\sessions\\taken.jsonl";

describe("binding a draft to the file its process reported", () => {
	it("tells the user once while another conversation owns that file, then binds once it is released", async t => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const runtime = {} as unknown as SessionHostRuntime;
		const events: string[] = [];
		const conflicts: string[] = [];
		const lines: LoggedLine[] = [];
		let foreignClaim = true;
		const index = {
			lifecycle: { run: <T>(_tab: string, work: (lease: object) => Promise<T>): Promise<T> => work({}) },
			recordHostSessionId: async () => true,
			get: () => ({ sessionFile: null }),
			promoteDraft: async () => foreignClaim
				? { status: "claim-conflict", detail: "This conversation is already open in another window." }
				: { status: "promoted" },
		} as unknown as SessionIndex;
		const records = { get: () => ({ runtime }) } as unknown as RuntimeRecords;
		const window: IdentityWindow = {
			bound: () => { events.push("bound"); },
			conflict: (_tab, detail) => { conflicts.push(detail); },
			refresh: () => { events.push("refresh"); },
		};
		const identity = new LocalIdentity({ index, window, records, log: recordingLogger(lines) });

		await identity.bind(TAB, runtime, FILE, "S-OTHER");

		assert.equal(conflicts.length, 1);
		assert.match(conflicts[0] ?? "", /already open in another window.*Stop or Kill/s);
		assert.equal(events.includes("bound"), false, "nothing was bound");
		assert.ok(lines.some(line => line.level === "error" && line.message.includes(FILE)));

		t.mock.timers.setTime(750);
		await identity.retry(TAB);
		assert.equal(conflicts.length, 1, "the same conflict is not reported again on every retry");
		assert.equal(events.includes("bound"), false);

		foreignClaim = false;
		t.mock.timers.setTime(1500);
		await identity.retry(TAB);
		assert.equal(events.includes("bound"), true, "the retained retry binds once the foreign claim is gone");
	});
});
