/** The page's cancel of background jobs through OMP's own `/jobs kill`. Runner: `node --test src/webview/lib/jobs-ui.test.ts`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChatModel } from "../../chat/model.ts";
import type { EphemeralItem } from "../../chat/projection.ts";
import type { ChatSendResult } from "./chat-client.ts";
import { JOBS_NOT_A_COMMAND, JOBS_NOT_WRITABLE, JOBS_SILENT, JOBS_UNCONFIRMED, JobsUi, type JobsUiOptions } from "./jobs-ui.ts";

type Client = ConstructorParameters<typeof JobsUi>[0];

const output = (id: string, text: string): EphemeralItem => ({ id, kind: "command_output", anchorId: null, seq: 1, timestamp: 1, payload: { text } });
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** A client whose send runs `onSend` (which may add rows) and answers `result`. */
function harness(options: { result?: ChatSendResult; onSend?: (add: (item: EphemeralItem) => void) => void; writable?: boolean; ephemeral?: EphemeralItem[] } & JobsUiOptions = {}) {
	let snapshot = { ...createChatModel(), phase: options.writable === false ? "resyncing" as const : "live" as const, readOnlyReason: null, ephemeral: options.ephemeral ?? [] };
	const listeners = new Set<() => void>();
	const sent: string[] = [];
	const add = (item: EphemeralItem): void => {
		snapshot = { ...snapshot, ephemeral: [...snapshot.ephemeral, item] };
		for (const listener of [...listeners]) listener();
	};
	const release = Promise.withResolvers<void>();
	let gate: Promise<void> | null = null;
	const client = {
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		sendPrompt: async (text: string): Promise<ChatSendResult> => {
			sent.push(text);
			if (gate !== null) await gate;
			options.onSend?.(add);
			return options.result ?? { ok: true, explained: true };
		},
	} as unknown as Client;
	const ui = new JobsUi(client, { replyWaitMs: options.replyWaitMs ?? 30, outcomeMs: options.outcomeMs ?? 30 });
	return { ui, sent, add, listeners, hold: () => { gate = release.promise; }, open: () => release.resolve() };
}

describe("JobsUi cancel", () => {
	it("sends /jobs kill and reports OMP's own answer", async () => {
		const { ui, sent } = harness({ onSend: add => add(output("r1", "Cancelled background job bg_1.")) });
		const states: (string | null)[] = [];
		ui.subscribe(() => states.push(ui.getState().pending));
		await ui.cancel("bg_1", "c1");
		assert.deepEqual(sent, ["/jobs kill bg_1"]);
		assert.deepEqual(ui.getState().outcome, { target: "bg_1", result: { kind: "cancelled", text: "Cancelled background job bg_1." } });
		assert.equal(ui.getState().pending, null);
		assert.deepEqual(states, ["bg_1", null], "pending while the command is open, cleared with its outcome");
		assert.equal(ui.getState().gone.size, 0);
	});

	it("records a job OMP says is not running as gone, for the call it meant", async () => {
		const { ui } = harness({ onSend: add => add(output("r1", "No running background job with id \"bg_1\".")) });
		await ui.cancel("bg_1", "c1");
		assert.equal(ui.getState().outcome?.result.kind, "gone");
		assert.deepEqual([...ui.getState().gone], [["bg_1", "c1"]]);
	});

	it("keeps the old gone entries and never records `all` as gone", async () => {
		const first = harness({ onSend: add => add(output("r1", "No running background jobs to cancel.")) });
		await first.ui.cancel("all");
		assert.equal(first.ui.getState().outcome?.result.kind, "gone");
		assert.equal(first.ui.getState().gone.size, 0);
	});

	it("reports a failed cancel and OMP's unavailable sentence as failed; they stay until dismissed", async () => {
		for (const text of ["Could not cancel background job bg_1.", "Async background jobs are unavailable in this session."]) {
			const { ui } = harness({ outcomeMs: 5, onSend: add => add(output("r1", text)) });
			await ui.cancel("bg_1");
			assert.equal(ui.getState().outcome?.result.kind, "failed", text);
			await wait(30);
			assert.equal(ui.getState().outcome?.result.kind, "failed", "no auto-dismiss");
			ui.dismiss();
			assert.equal(ui.getState().outcome, null);
		}
	});

	it("never counts a rewritten answer as a success: such a row is not this command's reply at all", async () => {
		const { ui } = harness({ replyWaitMs: 10, onSend: add => add(output("r1", "Stopped bg_1 for you.")) });
		await ui.cancel("bg_1");
		assert.equal(ui.getState().outcome?.result.kind, "silent");
		assert.equal(ui.getState().outcome?.result.text, JOBS_SILENT);
		assert.equal(ui.getState().gone.size, 0);
	});

	it("is refused without sending when the conversation is not writable", async () => {
		const { ui, sent } = harness({ writable: false });
		await ui.cancel("bg_1");
		assert.deepEqual(sent, []);
		assert.deepEqual(ui.getState().outcome, { target: "bg_1", result: { kind: "refused", text: JOBS_NOT_WRITABLE } });
		assert.equal(ui.getState().pending, null);
	});

	it("reports a refused or unconfirmed send", async () => {
		const refused = harness({ result: { ok: false, reason: "busy" } });
		await refused.ui.cancel("bg_1");
		assert.deepEqual(refused.ui.getState().outcome?.result, { kind: "refused", text: "Not cancelled: busy" });
		const unconfirmed = harness({ result: { ok: false, reason: "timeout", unconfirmed: true } });
		await unconfirmed.ui.cancel("bg_1");
		assert.deepEqual(unconfirmed.ui.getState().outcome?.result, { kind: "unconfirmed", text: JOBS_UNCONFIRMED });
	});

	it("says OMP took the text as a message when the send was not explained as a command", async () => {
		const { ui, sent } = harness({ result: { ok: true } });
		await ui.cancel("bg_1");
		assert.equal(sent.length, 1);
		assert.deepEqual(ui.getState().outcome?.result, { kind: "refused", text: JOBS_NOT_A_COMMAND });
	});

	it("goes silent when no answer comes within replyWaitMs", async () => {
		const { ui, listeners } = harness({ replyWaitMs: 15 });
		const started = Date.now();
		await ui.cancel("bg_1");
		assert.ok(Date.now() - started >= 10);
		assert.equal(ui.getState().outcome?.result.kind, "silent");
		assert.equal(listeners.size, 0, "the wait leaves nothing subscribed");
	});

	it("ignores rows that are not this command's answer: other commands, other ids, rows from before the send", async () => {
		const { ui } = harness({
			ephemeral: [output("old", "Cancelled background job bg_1.")],
			onSend: add => {
				add(output("o1", "Slash command output"));
				add(output("o2", "Cancelled background job bg_2."));
				add({ ...output("o3", "Cancelled background job bg_1."), kind: "notice" });
				add(output("mine", "Could not cancel background job bg_1."));
			},
		});
		await ui.cancel("bg_1");
		assert.equal(ui.getState().outcome?.result.kind, "failed", "the old row is not used, nor the other id's");
		const bare = harness({ ephemeral: [output("old", "Cancelled background job bg_1.")], replyWaitMs: 10 });
		await bare.ui.cancel("bg_1");
		assert.equal(bare.ui.getState().outcome?.result.kind, "silent", "a row that was there before the send is never its answer");
	});

	it("takes an answer that arrives after the send resolved, through subscribe", async () => {
		const { ui, add } = harness({ replyWaitMs: 500 });
		const done = ui.cancel("bg_1");
		await wait(10);
		assert.equal(ui.getState().pending, "bg_1");
		add(output("late", "Cancelled background job bg_1."));
		await done;
		assert.equal(ui.getState().outcome?.result.kind, "cancelled");
	});

	it("runs one cancel at a time", async () => {
		const { ui, sent, hold, open } = harness({ onSend: add => add(output("r", "Cancelled background job bg_1.")) });
		hold();
		const first = ui.cancel("bg_1");
		await wait(5);
		await ui.cancel("bg_2");
		await ui.cancel("all");
		assert.deepEqual(sent, ["/jobs kill bg_1"]);
		open();
		await first;
		assert.equal(ui.getState().outcome?.target, "bg_1");
	});

	it("sends only `all` or a valid job id", async () => {
		const { ui, sent } = harness({ onSend: add => add(output("r", "Cancelled 2 background jobs.")) });
		for (const target of ["x; rm -rf", "bg 1", "", "bg_1\n/jobs kill all", "-x", "a/b"]) await ui.cancel(target);
		assert.deepEqual(sent, []);
		assert.equal(ui.getState().outcome, null);
		await ui.cancel("all");
		assert.deepEqual(sent, ["/jobs kill all"]);
		assert.equal(ui.getState().outcome?.result.kind, "cancelled");
	});

	it("clears a cancelled or gone outcome after outcomeMs and leaves the others", async () => {
		const { ui } = harness({ outcomeMs: 10, onSend: add => add(output("r", "Cancelled background job bg_1.")) });
		await ui.cancel("bg_1");
		assert.equal(ui.getState().outcome?.result.kind, "cancelled");
		await wait(40);
		assert.equal(ui.getState().outcome, null);
		const gone = harness({ outcomeMs: 10, onSend: add => add(output("r", "No running background job with id \"bg_1\".")) });
		await gone.ui.cancel("bg_1");
		await wait(40);
		assert.equal(gone.ui.getState().outcome, null);
		assert.equal(gone.ui.getState().gone.size, 1, "dismissing the message does not bring the job back");
		const refused = harness({ outcomeMs: 5, writable: false });
		await refused.ui.cancel("bg_1");
		await wait(30);
		assert.equal(refused.ui.getState().outcome?.result.kind, "refused");
	});

	it("starts the next cancel with a clean slate: the previous outcome and its timer go", async () => {
		let n = 0;
		const { ui } = harness({ outcomeMs: 15, onSend: add => add(output(`r${++n}`, n === 1 ? "Cancelled background job bg_1." : "Could not cancel background job bg_2.")) });
		await ui.cancel("bg_1");
		await ui.cancel("bg_2");
		await wait(40);
		assert.equal(ui.getState().outcome?.target, "bg_2", "the first outcome's timer did not dismiss the second");
	});
});

describe("JobsUi focus", () => {
	it("opens the row with a new nonce per request, sends nothing, and releases", () => {
		const { ui, sent } = harness();
		let notified = 0;
		const stop = ui.subscribe(() => { notified += 1; });
		ui.focus("bg_1");
		const first = ui.getState().focus;
		ui.focus("bg_1");
		assert.equal(first?.id, "bg_1");
		assert.notEqual(ui.getState().focus?.nonce, first?.nonce, "a repeated request is a new one");
		ui.focus(null);
		assert.equal(ui.getState().focus?.id, null);
		ui.release();
		assert.equal(ui.getState().focus, null);
		const before = notified;
		ui.release();
		assert.equal(notified, before, "releasing nothing notifies nobody");
		stop();
		ui.focus("bg_2");
		assert.equal(notified, before, "an unsubscribed listener hears nothing");
		assert.deepEqual(sent, []);
	});

	it("dismiss clears the outcome and notifies only when there was one", () => {
		const { ui } = harness();
		let notified = 0;
		ui.subscribe(() => { notified += 1; });
		ui.dismiss();
		assert.equal(notified, 0);
	});
});
