/**
 * The OMP Desk output channel of every window of the profile, read from the log files VS Code keeps for it
 * (<data>/logs/<session>/window<N>/exthost/output_logging_*\/<n>-OMP Desk.log). Reading the files keeps the tests off
 * the Output panel; each window has its own extension host and its own file.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface WindowLog {
	/** `window<N>` directory name: N counts windows in the order they were opened. */
	readonly window: string;
	readonly lines: readonly string[];
}

export function readDeskLogs(dataDir: string): WindowLog[] {
	const logs = join(dataDir, "logs");
	const out: WindowLog[] = [];
	for (const entry of readdirSync(logs, { recursive: true })) {
		const relative = String(entry);
		if (!relative.endsWith("OMP Desk.log")) continue;
		const window = /window\d+/.exec(relative)?.[0] ?? relative;
		out.push({ window, lines: readFileSync(join(logs, relative), "utf8").split(/\r?\n/) });
	}
	return out;
}

/** Every line of every window's log that matches, tagged with its window. */
export function deskLogLines(dataDir: string, pattern: RegExp): string[] {
	return readDeskLogs(dataDir).flatMap(log => log.lines.filter(line => pattern.test(line)).map(line => `${log.window}: ${line}`));
}
