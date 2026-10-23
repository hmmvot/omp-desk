/**
 * CPU saturation for the loaded variants of a scenario: N processes that spin until stopped.
 * The suite runs on developers' working machines, so the loaded variants are opt-in: they run only
 * with `OMP_DESK_E2E_CPU_LOAD=1` (a dedicated machine), and are skipped otherwise.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpus } from "node:os";

export interface Load {
	readonly workers: number;
	stop(): void;
}

/** Whether the loaded variants may run; scenarios skip them otherwise. */
export const cpuLoadAllowed = process.env.OMP_DESK_E2E_CPU_LOAD === "1";
export const CPU_LOAD_SKIP_REASON = "saturates the CPU; set OMP_DESK_E2E_CPU_LOAD=1 on a dedicated machine to run it";

/** Defaults to twice the logical processors, which is what keeps PowerShell and Node start-ups visibly slow. */
export function startCpuLoad(workers = cpus().length * 2): Load {
	if (!cpuLoadAllowed) throw new Error(`startCpuLoad: ${CPU_LOAD_SKIP_REASON}`);
	const children: ChildProcess[] = [];
	for (let index = 0; index < workers; index++) {
		children.push(spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore", windowsHide: true }));
	}
	return {
		workers,
		stop: () => {
			for (const child of children) child.kill();
		},
	};
}
