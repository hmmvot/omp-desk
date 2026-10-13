/**
 * One bounded diagnostic line per security or probe tool this extension starts.
 *
 * Restore waits on PowerShell starts (private-storage verification, the identity probe helper,
 * the session-lease probe), and a start that takes seconds on a loaded machine is otherwise
 * invisible: nothing says which spawn was slow or why it ran. Each spawn reports its fixed
 * purpose, its duration from spawn to exit and the child's pid, so a log attributes every second.
 *
 * ADR-0017: a trace carries a purpose chosen by this code from a fixed vocabulary, a count, a
 * number and an outcome class. It never carries a path, an argument, standard output, an error
 * message or any other text an outside process chose.
 */

/** How one spawned tool ended. */
export type ToolSpawnOutcome =
	| "ok"
	| "failed"
	| "timeout"
	| "output-too-large"
	| "start-failed"
	| "refused";

/** One finished tool run. */
export interface ToolSpawn {
	/** The tool: `powershell`, `icacls` or `ls`. */
	readonly tool: "powershell" | "icacls" | "ls";
	/** Why it ran, from a fixed vocabulary (e.g. `private-storage read (9 paths)`). */
	readonly purpose: string;
	/** The child's pid when it started; `null` when it never did. */
	readonly pid: number | null;
	/** Whole milliseconds from the call that started it to its end. */
	readonly ms: number;
	readonly outcome: ToolSpawnOutcome;
}

let observer: ((spawn: ToolSpawn) => void) | null = null;

/** Report every finished tool run (the extension logs them); `null` stops reporting. */
export function setToolSpawnObserver(next: ((spawn: ToolSpawn) => void) | null): void {
	observer = next;
}

/** Report one finished run; an observer that throws never affects the run. */
export function reportToolSpawn(spawn: ToolSpawn): void {
	if (observer === null) return;
	try {
		observer(spawn);
	} catch {
		// Diagnostics never change what a verification or a probe decides.
	}
}

/** The one line the extension writes for a run. */
export function formatToolSpawn(spawn: ToolSpawn): string {
	return `tool spawn: ${spawn.tool} ${spawn.purpose} ${spawn.pid === null ? "no pid" : `pid ${spawn.pid}`} ${spawn.ms} ms ${spawn.outcome}`;
}

/**
 * Time one run from now. `end` closes it; calling it twice reports once.
 * The clock is `performance.now` so a wall-clock change never produces a negative duration.
 */
export function startToolSpawnTrace(
	tool: ToolSpawn["tool"],
	purpose: string,
): (pid: number | null | undefined, outcome: ToolSpawnOutcome) => void {
	const started = performance.now();
	let reported = false;
	return (pid, outcome) => {
		if (reported) return;
		reported = true;
		reportToolSpawn({ tool, purpose, pid: pid ?? null, ms: Math.round(performance.now() - started), outcome });
	};
}
