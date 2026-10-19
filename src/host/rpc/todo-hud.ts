/**
 * The clock behind the Chat's TODO row: it clears the row of a list whose every task is closed after OMP's
 * `tasks.todoClearDelay`, as OMP's terminal UI does (`interactive-mode.ts` `#syncTodoHudState`), and never writes to the
 * session file (the terminal UI records a `todo_hud_state` entry; Desk only reads one, see `src/chat/todo-hud.ts`).
 *
 * `sync()` judges the list the model holds now. A list that is the same as the one judged last changes nothing, so a timer
 * runs undisturbed through the frames that do not touch the list; any other list cancels the timer and starts again, the
 * terminal UI's generation and snapshot check. The delay is read from OMP once per list, when its timer is first needed,
 * because the user may have changed it since the last list. What the session file records (a dismissal or a reveal, and when
 * the list was written) can arrive after the list does, because the file is read alongside the child's first answer:
 * `historyChanged()` judges the same list again with it, keeping the delay already read.
 */
import { todoClearDelayMs, todoFingerprint, todoListClosed, type TodoHudHistory } from "../../chat/todo-hud.ts";
import type { TodoProjection } from "../../chat/todos.ts";

export interface TodoHudPorts {
	readonly timers: {
		now(): number;
		setTimeout(handler: () => void, ms: number): unknown;
		clearTimeout(handle: unknown): void;
	};
	/** The list the model holds now. */
	current(): TodoProjection | null;
	/** What the session file records about the latest durable list, as the history reader last found it. */
	history(): TodoHudHistory | null;
	/**
	 * OMP's effective `tasks.todoClearDelay` in seconds, read for this session's profile and folder. Resolve to `undefined` when it
	 * cannot be read (OMP's default then applies); a rejection counts the same. Omitted: the default applies.
	 */
	readDelay: (() => Promise<unknown>) | undefined;
	/** Apply the `todo_hud_hide` frame. */
	hide(): void;
}

export class TodoHudClock {
	readonly #ports: TodoHudPorts;
	/** The list object judged last, to skip the comparison while the model's list is untouched. */
	#seen: TodoProjection | null = null;
	/** `JSON.stringify` of the judged list: the terminal UI's snapshot key. */
	#key: string | null = null;
	/** When this window learned of the judged list: the start of its delay unless the session file dates it earlier. */
	#learnedAt = 0;
	/** The facts of the session file the judgement used, as a comparable string. */
	#facts = "";
	/** OMP's delay for the judged list, read once. */
	#delay: Promise<unknown> | null = null;
	#generation = 0;
	#timer: unknown = null;
	#disposed = false;

	constructor(ports: TodoHudPorts) {
		this.#ports = ports;
	}

	/** Judge the list the model holds now; call after any change to the model. */
	sync(): void {
		if (this.#disposed) return;
		const todo = this.#ports.current();
		if (todo === this.#seen) return;
		this.#seen = todo;
		this.#judge(todo);
	}

	/** The session file's facts were read again: judge the list with them even though the list is the same. */
	historyChanged(): void {
		if (this.#disposed) return;
		this.#seen = this.#ports.current();
		this.#judge(this.#seen);
	}

	dispose(): void {
		this.#disposed = true;
		this.#cancel();
	}

	#judge(todo: TodoProjection | null): void {
		const key = todo === null ? null : JSON.stringify(todo.phases);
		const history = this.#ports.history();
		// A recorded choice applies only to the list it was written for; the list the model holds may since have changed.
		const recorded = todo !== null && history !== null && history.fingerprint === todoFingerprint(todo.phases) ? history : null;
		const facts = recorded === null ? "" : `${recorded.visibility ?? ""}|${recorded.changedAt ?? ""}`;
		if (key === this.#key && facts === this.#facts) return;
		this.#cancel();
		if (key !== this.#key) {
			this.#key = key;
			this.#learnedAt = this.#ports.timers.now();
			this.#delay = null;
		}
		this.#facts = facts;
		if (todo === null || key === null || todo.hidden || !todoListClosed(todo.phases)) return;
		if (recorded?.visibility === "dismissed") {
			this.#ports.hide();
			return;
		}
		if (recorded?.visibility === "revealed") return;
		// A list read from the session file has been closed since that entry was written, not since this window learned of it.
		void this.#arm(this.#generation, key, Math.min(this.#learnedAt, recorded?.changedAt ?? this.#learnedAt));
	}

	#cancel(): void {
		this.#generation += 1;
		if (this.#timer !== null) this.#ports.timers.clearTimeout(this.#timer);
		this.#timer = null;
	}

	async #arm(generation: number, key: string, closedAt: number): Promise<void> {
		this.#delay ??= (async (): Promise<unknown> => {
			try {
				return await this.#ports.readDelay?.();
			} catch {
				return undefined;
			}
		})();
		const seconds = await this.#delay;
		if (this.#disposed || generation !== this.#generation) return;
		const delay = todoClearDelayMs(seconds);
		if (delay === null) return;
		const wait = Math.min(delay, Math.max(0, closedAt + delay - this.#ports.timers.now()));
		this.#timer = this.#ports.timers.setTimeout(() => {
			this.#timer = null;
			if (this.#disposed || generation !== this.#generation) return;
			const todo = this.#ports.current();
			if (todo === null || todo.hidden || JSON.stringify(todo.phases) !== key) return;
			this.#ports.hide();
		}, wait);
	}
}
