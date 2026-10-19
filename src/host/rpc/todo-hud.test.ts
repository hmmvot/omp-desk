/** The clock that clears the Chat's TODO row of a fully closed list (`src/host/rpc/todo-hud.ts`), on a manual clock. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { todoFingerprint, type TodoHudHistory } from "../../chat/todo-hud.ts";
import type { TodoPhase, TodoProjection, TodoStatus } from "../../chat/todos.ts";
import { TodoHudClock } from "./todo-hud.ts";
import { ManualTimers, tick } from "./test-support.ts";

function list(...statuses: readonly TodoStatus[]): TodoProjection {
	const phases: TodoPhase[] = [{ name: "Work", tasks: statuses.map((status, index) => ({ content: `Task ${index}`, status })) }];
	return { phases, entryId: null, hidden: false };
}

function rig(options: { delay?: () => Promise<unknown>; history?: TodoHudHistory | null } = {}) {
	const timers = new ManualTimers();
	const state = { todo: null as TodoProjection | null, history: options.history ?? null, hides: [] as number[], reads: 0 };
	const clock = new TodoHudClock({
		timers,
		current: () => state.todo,
		history: () => state.history,
		readDelay: async () => {
			state.reads += 1;
			return options.delay === undefined ? 60 : options.delay();
		},
		hide: () => {
			state.hides.push(timers.now());
			if (state.todo !== null) state.todo = { ...state.todo, hidden: true };
			clock.sync();
		},
	});
	const show = async (todo: TodoProjection | null): Promise<void> => {
		state.todo = todo;
		clock.sync();
		await tick();
	};
	return { timers, state, clock, show };
}

describe("TodoHudClock", () => {
	it("clears a fully closed list after the delay and not before", async () => {
		const { timers, state, show } = rig();
		await show(list("completed", "completed"));
		timers.advance(59_999);
		assert.equal(state.hides.length, 0);
		timers.advance(1);
		assert.equal(state.hides.length, 1);
		assert.equal(state.todo?.hidden, true);
		timers.advance(600_000);
		assert.equal(state.hides.length, 1, "it hides once");
	});

	it("counts an abandoned task as closed and an open one as not", async () => {
		const { timers, state, show } = rig();
		await show(list("completed", "abandoned"));
		timers.advance(60_000);
		assert.equal(state.hides.length, 1);
		for (const open of ["pending", "in_progress", "blocked"] as const) {
			const next = rig();
			await next.show(list("completed", open));
			next.timers.advance(3_600_000);
			assert.equal(next.state.hides.length, 0, `${open} keeps the row`);
			assert.equal(next.state.reads, 0, "no timer, so no read of OMP's setting");
		}
		const empty = rig();
		await empty.show(list());
		empty.timers.advance(3_600_000);
		assert.equal(empty.state.hides.length, 0, "a list without tasks is not a closed list");
	});

	it("restarts from a change to the list and cancels when a task opens again", async () => {
		const { timers, state, show } = rig();
		await show(list("completed", "completed"));
		timers.advance(40_000);
		await show(list("completed", "completed", "abandoned"));
		timers.advance(59_999);
		assert.equal(state.hides.length, 0, "the old timer was cancelled; the new list waits its own delay");
		timers.advance(1);
		assert.equal(state.hides.length, 1);
		assert.equal(state.todo?.phases[0]?.tasks.length, 3);

		const reopened = rig();
		await reopened.show(list("completed"));
		reopened.timers.advance(30_000);
		await reopened.show(list("completed", "pending"));
		reopened.timers.advance(3_600_000);
		assert.equal(reopened.state.hides.length, 0);
		await reopened.show(list("completed", "completed"));
		reopened.timers.advance(60_000);
		assert.equal(reopened.state.hides.length, 1, "closing it again starts a new delay");
	});

	it("does not restart for the same list, and a note counts as a change as it does in the terminal UI", async () => {
		const { timers, state, show } = rig();
		const closed = list("completed");
		await show(closed);
		timers.advance(30_000);
		await show({ ...closed, entryId: "entry-1" });
		await show({ phases: JSON.parse(JSON.stringify(closed.phases)) as TodoPhase[], entryId: null, hidden: false });
		timers.advance(30_000);
		assert.equal(state.hides.length, 1, "an equal list kept the running timer");

		const noted = rig();
		await noted.show(list("completed"));
		noted.timers.advance(30_000);
		const withNote = list("completed");
		await noted.show({ ...withNote, phases: [{ name: "Work", tasks: [{ content: "Task 0", status: "completed", notes: ["why"] }] }] });
		noted.timers.advance(30_000);
		assert.equal(noted.state.hides.length, 0);
		noted.timers.advance(30_000);
		assert.equal(noted.state.hides.length, 1);
	});

	it("takes the delay from OMP's setting: negative, NaN, non-numbers and a delay too long for a timer mean never; zero means at once", async () => {
		for (const never of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5", null, 2_200_000]) {
			const { timers, state, show } = rig({ delay: async () => never });
			await show(list("completed"));
			timers.advance(2_200_000_000);
			assert.equal(state.hides.length, 0, `${String(never)} never hides`);
			assert.equal(timers.pending, 0);
		}
		const instant = rig({ delay: async () => 0 });
		await instant.show(list("completed"));
		instant.timers.advance(0);
		assert.equal(instant.state.hides.length, 1);
		const custom = rig({ delay: async () => 300 });
		await custom.show(list("completed"));
		custom.timers.advance(299_999);
		assert.equal(custom.state.hides.length, 0);
		custom.timers.advance(1);
		assert.equal(custom.state.hides.length, 1);
	});

	it("falls back to OMP's default of 60 seconds when the setting cannot be read", async () => {
		for (const delay of [async () => undefined, async () => { throw new Error("omp failed"); }]) {
			const { timers, state, show } = rig({ delay });
			await show(list("completed"));
			timers.advance(59_999);
			assert.equal(state.hides.length, 0);
			timers.advance(1);
			assert.equal(state.hides.length, 1);
		}
	});

	it("ignores a delay that was read for a list that has since changed", async () => {
		const gate = Promise.withResolvers<unknown>();
		let call = 0;
		const { timers, state, show } = rig({ delay: () => (call += 1) === 1 ? gate.promise : Promise.resolve(10) });
		await show(list("completed"));
		await show(list("completed", "completed"));
		gate.resolve(1);
		await tick();
		timers.advance(1_000);
		assert.equal(state.hides.length, 0, "the stale answer (1 s) set no timer");
		timers.advance(9_000);
		assert.equal(state.hides.length, 1);
		assert.equal(state.todo?.phases[0]?.tasks.length, 2);
	});

	describe("a list the session file recorded", () => {
		const closed = list("completed", "abandoned");
		const recorded = (visibility: TodoHudHistory["visibility"], changedAt: number | null, phases: readonly TodoPhase[] = closed.phases): TodoHudHistory => ({ fingerprint: todoFingerprint(phases), changedAt, visibility });

		it("stays hidden when the terminal UI dismissed exactly this list, and shows again when it changed", async () => {
			const { state, show, timers } = rig({ history: recorded("dismissed", 0) });
			await show(closed);
			assert.equal(state.hides.length, 1, "hidden at once, with no timer and no read of OMP");
			assert.equal(state.reads, 0);
			assert.equal(timers.pending, 0);
			await show(list("completed", "abandoned", "completed"));
			assert.equal(state.todo?.hidden, false, "a changed list is not covered by the old dismissal");
			timers.advance(60_000);
			assert.equal(state.hides.length, 2, "it is judged afresh by the clock");
		});

		it("never clears a list the terminal UI revealed, and does not apply a choice written for another list", async () => {
			const revealed = rig({ history: recorded("revealed", 0) });
			await revealed.show(closed);
			revealed.timers.advance(3_600_000);
			assert.equal(revealed.state.hides.length, 0);
			const other = rig({ history: recorded("dismissed", 0, list("completed").phases) });
			await other.show(closed);
			assert.equal(other.state.hides.length, 0);
			other.timers.advance(60_000);
			assert.equal(other.state.hides.length, 1);
		});

		it("clears at once a list that has been closed for longer than the delay when the window opens", async () => {
			const probe = rig();
			const long = rig({ history: recorded(null, probe.timers.now() - 120_000) });
			await long.show(closed);
			long.timers.advance(0);
			assert.equal(long.state.hides.length, 1);
			assert.deepEqual(long.state.hides, [long.timers.now()], "at the very moment, not a delay later");
		});

		it("waits only the rest of the delay for a list closed a while ago, and a full delay for one the file does not date", async () => {
			const partway = rig();
			partway.state.history = recorded(null, partway.timers.now() - 45_000);
			await partway.show(closed);
			partway.timers.advance(14_999);
			assert.equal(partway.state.hides.length, 0);
			partway.timers.advance(1);
			assert.equal(partway.state.hides.length, 1);
			const undated = rig({ history: recorded(null, null) });
			await undated.show(closed);
			undated.timers.advance(59_999);
			assert.equal(undated.state.hides.length, 0);
			undated.timers.advance(1);
			assert.equal(undated.state.hides.length, 1);
		});

		it("counts a list that differs from the recorded one from the moment this window learned of it", async () => {
			const { timers, state, show } = rig();
			state.history = recorded(null, timers.now() - 600_000);
			await show(list("completed", "completed", "completed"));
			timers.advance(59_999);
			assert.equal(state.hides.length, 0, "the recorded list is another list: its date does not apply");
			timers.advance(1);
			assert.equal(state.hides.length, 1);
		});

		it("judges the same list again when the file's facts arrive after it, keeping the delay already read", async () => {
			const late = rig();
			await late.show(closed);
			late.timers.advance(20_000);
			late.state.history = recorded(null, late.timers.now() - 100_000);
			late.clock.historyChanged();
			await tick();
			late.timers.advance(0);
			assert.equal(late.state.hides.length, 1, "the file says it has been closed for 2 minutes");
			assert.equal(late.state.reads, 1, "OMP's setting was read once for this list");

			const dismissed = rig();
			await dismissed.show(closed);
			dismissed.state.history = recorded("dismissed", 0);
			dismissed.clock.historyChanged();
			assert.equal(dismissed.state.hides.length, 1, "a dismissal found late hides at once");
			assert.equal(dismissed.timers.pending, 0);

			const revealed = rig();
			await revealed.show(closed);
			revealed.state.history = recorded("revealed", 0);
			revealed.clock.historyChanged();
			revealed.timers.advance(3_600_000);
			assert.equal(revealed.state.hides.length, 0, "a reveal found late cancels the timer");

			const unchanged = rig();
			await unchanged.show(closed);
			unchanged.timers.advance(30_000);
			unchanged.clock.historyChanged();
			await tick();
			unchanged.timers.advance(29_999);
			assert.equal(unchanged.state.hides.length, 0);
			unchanged.timers.advance(1);
			assert.equal(unchanged.state.hides.length, 1, "facts that say nothing new do not restart the delay");
		});
	});

	it("stops everything on dispose", async () => {
		const { timers, state, show, clock } = rig();
		await show(list("completed"));
		clock.dispose();
		timers.advance(3_600_000);
		assert.equal(state.hides.length, 0);
		assert.equal(timers.pending, 0);
	});
});
