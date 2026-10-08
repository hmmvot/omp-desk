import assert from "node:assert/strict";
import { test } from "node:test";
import { shellCleanupDescription, shellEditorTitle, watchShellOwnerStop } from "./shell-title.ts";
import type { ShellOwnerStopSource } from "./shell-title.ts";
import type { PtyHandleEvent } from "./pty-client.ts";
import type { PtyOwnerStopStatus } from "./pty-protocol.ts";

test("shell titles stay compact while cleanup descriptions reflect the verdict", () => {
	assert.equal(shellEditorTitle("alpha"), "Terminal: alpha");
	assert.notEqual(shellCleanupDescription("armed"), shellCleanupDescription("disarmed"));
	assert.equal(shellCleanupDescription("disarmed"), shellCleanupDescription("not-applicable"));
});

test("cleanup transitions publish immediately, deduplicate unchanged verdicts and unsubscribe", () => {
	let listener: ((event: PtyHandleEvent) => void) | null = null;
	const source: ShellOwnerStopSource = { statusValue: null, subscribe(next) { listener = next; return () => { listener = null; }; } };
	const seen: Array<string | null> = [];
	const stop = watchShellOwnerStop(source, "alpha", (title, status) => { assert.equal(title, "Terminal: alpha"); seen.push(status?.state ?? null); });
	const push = (state: PtyOwnerStopStatus["state"]) => listener?.({ type: "owner-stop", status: { state, detail: "", owners: [], graceRemainingMs: null } });
	push("disarmed"); push("disarmed"); push("armed");
	assert.deepEqual(seen, [null, "disarmed", "armed"]);
	stop(); push("disarmed");
	assert.equal(seen.length, 3);
});
