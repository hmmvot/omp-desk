import assert from "node:assert/strict";
import { test } from "node:test";
import { buildView, groupViews, projectConfiguration } from "../../protocol/desk-settings.ts";
import type { SettingGroupView } from "../../protocol/desk-settings.ts";
import { initialPageState, leaveDecision, needsWrite, readyToSave, reducePage } from "./page-state.ts";
import type { PageEvent, PageState } from "./page-state.ts";

const DESCRIPTORS = projectConfiguration({
	title: "T",
	properties: { "t.a": { type: "boolean" }, "t.b": { type: "boolean" }, "t.n": { type: "integer", minimum: 1 } },
});
const WORKSPACE = { available: true, name: "w" };

function snapshot(values: { a?: boolean; b?: boolean; n?: number; nSource?: "user" | "workspace" }): SettingGroupView[] {
	const layers = (key: string) => key === "t.n" && values.n !== undefined
		? { defaultValue: 3, ...(values.nSource === "workspace" ? { workspaceValue: values.n } : { globalValue: values.n }) }
		: { defaultValue: false };
	const effective = (key: string) => key === "t.a" ? values.a ?? false : key === "t.b" ? values.b ?? false : values.n ?? 3;
	return groupViews(DESCRIPTORS.map(descriptor => ({ descriptor, view: buildView(descriptor, layers(descriptor.key), effective(descriptor.key), WORKSPACE, []) })));
}
const run = (events: readonly PageEvent[], from: PageState = initialPageState): PageState => events.reduce(reducePage, from);
const state = (groups: SettingGroupView[], editing: string | null = null): PageEvent => ({ type: "state", groups, workspace: WORKSPACE, editing });

test("a write is shown at once, and an unrelated snapshot does not roll it back", () => {
	const afterWrite = run([state(snapshot({})), { type: "write", key: "t.b", requestId: "r1", value: true }]);
	// Another setting changed (A's own write confirmed): B's host write has not finished.
	const unrelated = reducePage(afterWrite, state(snapshot({ a: true })));
	assert.equal(unrelated.pending["t.b"]?.value, true, "B's intent survives A's snapshot");
});

test("a write is settled by its own result and then confirmed by the next snapshot, in either order", () => {
	const base = run([state(snapshot({})), { type: "write", key: "t.a", requestId: "r1", value: true }]);
	// Snapshot first (the configuration event beats the result), then the result, then the push that follows every result.
	const eventFirst = run([state(snapshot({ a: true })), { type: "result", requestId: "r1", key: "t.a", ok: true, message: "Saved to User settings." }], base);
	assert.equal(eventFirst.pending["t.a"]?.settled, true);
	assert.equal(reducePage(eventFirst, state(snapshot({ a: true }))).pending["t.a"], undefined, "the following snapshot confirms it");
	// Result first, then the snapshot.
	const resultFirst = run([{ type: "result", requestId: "r1", key: "t.a", ok: true, message: "ok" }, state(snapshot({ a: true }))], base);
	assert.equal(resultFirst.pending["t.a"], undefined);
	assert.equal(resultFirst.notes["t.a"]?.message, "ok");
});

test("a failed write returns the control to the stored value; an older failure does not clear a newer intent", () => {
	const twice = run([
		state(snapshot({})),
		{ type: "write", key: "t.a", requestId: "r1", value: true },
		{ type: "write", key: "t.a", requestId: "r2", value: false },
		{ type: "result", requestId: "r1", key: "t.a", ok: false, message: "could not save" },
	]);
	assert.equal(twice.pending["t.a"]?.requestId, "r2", "the newer write still shows its value");
	assert.equal(twice.notes["t.a"], undefined, "a superseded request's result is not presented");
	const failed = reducePage(twice, { type: "result", requestId: "r2", key: "t.a", ok: false, message: "could not save" });
	assert.equal(failed.pending["t.a"], undefined);
});

test("a success note fades only if it is still that request's note; a later failure stays", () => {
	const afterSuccess = run([{ type: "write", key: "t.a", requestId: "r1", value: true }, { type: "result", requestId: "r1", key: "t.a", ok: true, message: "Saved." }]);
	const afterFailure = run([{ type: "write", key: "t.a", requestId: "r2", value: false }, { type: "result", requestId: "r2", key: "t.a", ok: false, message: "Could not save." }], afterSuccess);
	assert.equal(reducePage(afterFailure, { type: "expire", key: "t.a", requestId: "r1" }).notes["t.a"]?.message, "Could not save.");
	assert.equal(reducePage(afterFailure, { type: "expire", key: "t.a", requestId: "r2" }).notes["t.a"]?.message, "Could not save.", "failures never fade");
	assert.equal(reducePage(afterSuccess, { type: "expire", key: "t.a", requestId: "r1" }).notes["t.a"], undefined);
});

test("a draft survives a snapshot while the field is being edited and is dropped once it equals the stored value", () => {
	const typing = run([state(snapshot({})), { type: "draft", key: "t.n", draft: { text: "7", base: "3" } }]);
	assert.deepEqual(reducePage(typing, state(snapshot({}), "t.n")).drafts["t.n"], { text: "7", base: "3" });
	assert.equal(reducePage(typing, state(snapshot({ n: 7 }), "t.n")).drafts["t.n"], undefined, "saved: the stored value now equals the draft");
	// Changed elsewhere while typing: kept while the field has the focus, dropped when the field is not being edited.
	assert.ok(reducePage(typing, state(snapshot({ n: 9 }), "t.n")).drafts["t.n"]);
	assert.equal(reducePage(typing, state(snapshot({ n: 9 }), null)).drafts["t.n"], undefined);
});

test("leaving a field whose value changed elsewhere adopts the current value instead of overwriting it", () => {
	assert.equal(leaveDecision(undefined, "3"), "none");
	assert.equal(leaveDecision({ text: "7", base: "3" }, "3"), "save");
	assert.equal(leaveDecision({ text: "7", base: "3" }, "9"), "adopt");
	const adopted = run([{ type: "draft", key: "t.n", draft: { text: "7", base: "3" } }, { type: "adopt", key: "t.n" }]);
	assert.equal(adopted.drafts["t.n"], undefined);
	assert.match(adopted.notes["t.n"]!.message, /changed elsewhere/);
	// Escape and Reset forget everything about the row.
	assert.deepEqual(run([{ type: "draft", key: "t.n", draft: { text: "7", base: "3" } }, { type: "forget", key: "t.n", requestId: "r9" }]).drafts, {});
});

test("a no-op is judged against the selected layer, not only the value in effect", () => {
	const groups = snapshot({ n: 2, nSource: "workspace" });
	const view = groups.flatMap(group => group.settings).find(row => row.key === "t.n")!;
	assert.equal(view.source, "workspace");
	assert.equal(needsWrite(view, 2, "workspace"), false, "the workspace layer already holds it");
	assert.equal(needsWrite(view, 2, "user"), true, "the user layer is set deliberately although the workspace value wins");
	assert.equal(needsWrite(view, 5, "workspace"), true);
	const plain = snapshot({}).flatMap(group => group.settings).find(row => row.key === "t.n")!;
	assert.equal(needsWrite(plain, 3, "user"), false, "typing the default back changes nothing");
});

test("the field's own save coming back does not discard what the user kept typing", () => {
	const typing = run([
		state(snapshot({})),
		{ type: "draft", key: "t.n", draft: { text: "7", base: "3" } },
		{ type: "write", key: "t.n", requestId: "r1", value: 7 },
		{ type: "draft", key: "t.n", draft: { text: "8", base: "3" } },
	]);
	// Snapshot first, then the result; the user is still in the field.
	const snapshotFirst = run([state(snapshot({ n: 7 }), "t.n"), { type: "result", requestId: "r1", key: "t.n", ok: true, message: "Saved to User settings." }], typing);
	assert.deepEqual(snapshotFirst.drafts["t.n"], { text: "8", base: "7" }, "the draft continues from the saved value");
	assert.equal(leaveDecision(snapshotFirst.drafts["t.n"], "7"), "save", "leaving the field saves 8; it is not an outside change");
	// Result first.
	const resultFirst = run([{ type: "result", requestId: "r1", key: "t.n", ok: true, message: "Saved to User settings." }, state(snapshot({ n: 7 }), "t.n")], typing);
	assert.deepEqual(resultFirst.drafts["t.n"], { text: "8", base: "7" });
	// A genuinely outside value is still adopted on leaving.
	const outside = reducePage(typing, state(snapshot({ n: 9 }), "t.n"));
	assert.equal(leaveDecision(outside.drafts["t.n"], "9"), "adopt");
});

test("only the latest request of a row is presented, including Reset and open actions", () => {
	const afterReset = run([
		{ type: "write", key: "t.a", requestId: "r1", value: true },
		{ type: "forget", key: "t.a", requestId: "r2" },
		{ type: "result", requestId: "r1", key: "t.a", ok: true, message: "Saved." },
	]);
	assert.equal(afterReset.notes["t.a"], undefined, "the write's late result does not replace the reset's feedback");
	assert.equal(reducePage(afterReset, { type: "result", requestId: "r2", key: "t.a", ok: true, message: "Reset." }).notes["t.a"]?.message, "Reset.");
	const opened = run([{ type: "request", key: "t.a", requestId: "r3" }, { type: "result", requestId: "r3", key: "t.a", ok: false, message: "Could not open it." }]);
	assert.equal(opened.notes["t.a"]?.message, "Could not open it.");
	// A result for a request this document never sent (an earlier document of the view) is ignored.
	assert.deepEqual(reducePage(initialPageState, { type: "result", requestId: "old", key: "t.a", ok: false, message: "stale" }).notes, {});
});

test("a result always settles its own pending write even when an open action became the row's latest request", () => {
	const failed = run([
		state(snapshot({})),
		{ type: "write", key: "t.a", requestId: "r1", value: true },
		{ type: "request", key: "t.a", requestId: "r2" },
		{ type: "result", requestId: "r1", key: "t.a", ok: false, message: "could not save" },
	]);
	assert.equal(failed.pending["t.a"], undefined, "the failed write no longer masks the stored value");
	assert.equal(failed.notes["t.a"], undefined, "its note is not presented over the newer action");
	const succeeded = run([
		{ type: "write", key: "t.a", requestId: "r1", value: true },
		{ type: "request", key: "t.a", requestId: "r2" },
		{ type: "result", requestId: "r1", key: "t.a", ok: true, message: "Saved." },
		state(snapshot({ a: true })),
	]);
	assert.equal(succeeded.pending["t.a"], undefined, "settled by its own result, confirmed by the snapshot");
});

test("only a write that is unfinished can explain a stored value as this document's own save", () => {
	const draftAgainst9 = (events: PageEvent[]) => run([
		state(snapshot({})),
		...events,
		{ type: "draft", key: "t.n", draft: { text: "10", base: "9" } },
	]);
	// 7 and 9 were saved and read back long ago; another window now sets the value back to 7: an outside change.
	const reused = draftAgainst9([
		{ type: "write", key: "t.n", requestId: "r1", value: 7 },
		{ type: "result", requestId: "r1", key: "t.n", ok: true, message: "Saved." },
		state(snapshot({ n: 7 })),
		{ type: "write", key: "t.n", requestId: "r2", value: 9 },
		{ type: "result", requestId: "r2", key: "t.n", ok: true, message: "Saved." },
		state(snapshot({ n: 9 })),
	]);
	const outside = reducePage(reused, state(snapshot({ n: 7 }), "t.n"));
	assert.equal(leaveDecision(outside.drafts["t.n"], "7"), "adopt", "7 is not this document's own write any more");
	// A write that failed never explains a stored value.
	const failedValue = draftAgainst9([
		{ type: "write", key: "t.n", requestId: "r1", value: 7 },
		{ type: "result", requestId: "r1", key: "t.n", ok: false, message: "could not save" },
	]);
	assert.equal(leaveDecision(reducePage(failedValue, state(snapshot({ n: 7 }), "t.n")).drafts["t.n"], "7"), "adopt");
});

test("a value that matches an unanswered write is not attributed to it: if the write then fails the draft is not rebased", () => {
	const typing = run([
		state(snapshot({})),
		{ type: "draft", key: "t.n", draft: { text: "7", base: "3" } },
		{ type: "write", key: "t.n", requestId: "r1", value: 7 },
		{ type: "draft", key: "t.n", draft: { text: "8", base: "3" } },
	]);
	// Another window writes 7 while r1 is in flight; the snapshot arrives first.
	const snapshotFirst = reducePage(typing, state(snapshot({ n: 7 }), "t.n"));
	assert.deepEqual(snapshotFirst.drafts["t.n"], { text: "8", base: "3" }, "not rebased on an unanswered request");
	const failed = reducePage(snapshotFirst, { type: "result", requestId: "r1", key: "t.n", ok: false, message: "could not save" });
	assert.equal(leaveDecision(failed.drafts["t.n"], "7"), "adopt", "the outside value is adopted, never overwritten by 8");
	// Its success counterpart: the acknowledgement arrives after the readback and rebases the draft then.
	const succeeded = reducePage(snapshotFirst, { type: "result", requestId: "r1", key: "t.n", ok: true, message: "Saved." });
	assert.deepEqual(succeeded.drafts["t.n"], { text: "8", base: "7" });
	// Leaving the field before the answer waits for it instead of discarding the newer text.
	assert.equal(leaveDecision(snapshotFirst.drafts["t.n"], "7", true), "defer");
	const left = reducePage(snapshotFirst, { type: "defer", key: "t.n" });
	assert.equal(left.drafts["t.n"]?.left, true);
	assert.deepEqual(readyToSave(left), [], "nothing is saved while the save is unanswered");
	const okLeft = reducePage(left, { type: "result", requestId: "r1", key: "t.n", ok: true, message: "Saved." });
	assert.deepEqual(okLeft.drafts["t.n"], { text: "8", base: "7", left: true });
	assert.deepEqual(readyToSave(okLeft), ["t.n"], "success: the newer draft is saved");
	const failLeft = reducePage(left, { type: "result", requestId: "r1", key: "t.n", ok: false, message: "could not save" });
	assert.equal(failLeft.drafts["t.n"], undefined, "failure plus an outside change: the stored value is adopted");
	assert.equal(failLeft.notes["t.n"]?.ok, false, "the failure of the save is what the row reports");
});

test("a deferred save is submitted once, and only its own failure decides the deferred draft", () => {
	const left = run([
		state(snapshot({})),
		{ type: "draft", key: "t.n", draft: { text: "7", base: "3" } },
		{ type: "write", key: "t.n", requestId: "r1", value: 7 },
		{ type: "draft", key: "t.n", draft: { text: "8", base: "3" } },
		state(snapshot({ n: 7 }), "t.n"),
		{ type: "defer", key: "t.n" },
	]);
	// An unrelated failed action and a result of an unknown request leave the waiting draft alone.
	const unrelated = run([{ type: "request", key: "t.n", requestId: "r2" }, { type: "result", requestId: "r2", key: "t.n", ok: false, message: "Could not open it." }, { type: "result", requestId: "old", key: "t.n", ok: false, message: "stale" }], left);
	assert.equal(unrelated.drafts["t.n"]?.left, true);
	// r1 succeeds: the draft is ready once; submitting it consumes the intent, so a later unchanged-effective readback does not re-arm it.
	const ready = run([{ type: "result", requestId: "r1", key: "t.n", ok: true, message: "Saved." }], left);
	assert.deepEqual(readyToSave(ready), ["t.n"]);
	const submitted = run([{ type: "write", key: "t.n", requestId: "r3", value: 8 }, { type: "result", requestId: "r3", key: "t.n", ok: true, message: "Saved to User settings, but this workspace's own value overrides it here." }, state(snapshot({ n: 7 }), null)], ready);
	assert.deepEqual(readyToSave(submitted), [], "no second automatic write");
});

test("a Test keeps its own result, ignores an older Test's answer, and never touches the row's notes or pending writes", () => {
	const afterFirst = run([state(snapshot({})), { type: "test", key: "t.a", requestId: "t1", tested: "C:\\a\\omp.exe" }]);
	assert.deepEqual(afterFirst.tests["t.a"], { requestId: "t1", tested: "C:\\a\\omp.exe", status: "running" });
	const second = reducePage(afterFirst, { type: "test", key: "t.a", requestId: "t2", tested: "" });
	// The first Test answers after the second was started: its answer is not presented.
	const late = reducePage(second, { type: "test-result", key: "t.a", requestId: "t1", ok: false, message: "old" });
	assert.deepEqual(late.tests["t.a"], { requestId: "t2", tested: "", status: "running" });
	const done = reducePage(late, { type: "test-result", key: "t.a", requestId: "t2", ok: true, message: "from PATH" });
	assert.deepEqual(done.tests["t.a"], { requestId: "t2", tested: "", status: "done", ok: true, message: "from PATH" });
	assert.deepEqual(done.notes, {});
	assert.deepEqual(done.pending, {});
	// A snapshot (the setting changed elsewhere) does not erase the Test result of what was typed.
	assert.deepEqual(reducePage(done, state(snapshot({ a: true }))).tests["t.a"], done.tests["t.a"]);
	// An answer for a Test this document never started (an earlier document of the view) is ignored.
	assert.deepEqual(reducePage(initialPageState, { type: "test-result", key: "t.a", requestId: "old", ok: true, message: "x" }).tests, {});
});

test("moving focus to the row's Test button keeps the draft unsaved, so a Test never writes the setting", () => {
	const draft = { text: "C:\\new\\omp.exe", base: "C:\\old\\omp.exe" };
	assert.equal(leaveDecision(draft, "C:\\old\\omp.exe", false, true), "none", "the draft is kept, nothing is saved");
	assert.equal(leaveDecision(draft, "C:\\old\\omp.exe"), "save", "leaving to anywhere else still saves");
	assert.equal(leaveDecision(draft, "C:\\elsewhere\\omp.exe", true, true), "none", "not even a deferred decision is made");
});
