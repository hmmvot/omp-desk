/** CPU saturation for the loaded variants of a scenario: N processes that spin until stopped. */
import { spawn, type ChildProcess } from "node:child_process";
import { cpus } from "node:os";

export interface Load {
	readonly workers: number;
	stop(): void;
}

/** Defaults to twice the logical processors, which is what keeps PowerShell and Node start-ups visibly slow. */
export function startCpuLoad(workers = cpus().length * 2): Load {
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
