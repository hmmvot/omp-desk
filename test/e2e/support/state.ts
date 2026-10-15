/** What global setup publishes to the test workers (as the JSON file named by `OMP_E2E_STATE`). */
import { readFileSync } from "node:fs";
import type { LayoutName } from "./layout.ts";

export interface RunState {
	/** Launcher environment name; also the folder name under `root`. */
	readonly name: string;
	readonly root: string;
	readonly base: string;
	readonly agentDir: string;
	/** The window's own home folder (`test-vscode.ps1 -IsolateHome`): `~` of VS Code, OMP and OMP Desk in the test window. */
	readonly homeDir: string;
	readonly dataDir: string;
	readonly cdpPort: number;
	readonly mockUrl: string;
	/** Two workspace folders, one per window. */
	readonly folderA: string;
	readonly folderB: string;
	readonly vsix: string;
	/** Directory for traces, screenshots and reports. */
	readonly resultsDir: string;
	/** The window layout the profile was prepared with (`E2E_LAYOUT`, see layout.ts). */
	readonly layout: LayoutName;
}

export const STATE_ENV = "OMP_E2E_STATE";

export function readState(): RunState {
	const file = process.env[STATE_ENV];
	if (!file) throw new Error(`${STATE_ENV} is not set: run the suite through \`npm run test:e2e\` (global setup publishes the state).`);
	return JSON.parse(readFileSync(file, "utf8"));
}
