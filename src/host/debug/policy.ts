/**
 * What the debugger tools may do, as the user configured it (design section 4). The values live in `application`
 * scope settings, so a repository cannot change them; the real reader is in `index.ts`, tests inject their own.
 */

export type StartMode = "ask" | "allow";
export type ExpressionMode = "off" | "ask" | "allow";

export interface ConsentRequest {
	/** Short headline of the prompt. */
	readonly title: string;
	/** What exactly will run, one fact per line. */
	readonly lines: readonly string[];
	/** The setting an "Always Allow" answer switches to `allow`, so later requests of this kind are not asked. */
	readonly setting: "start" | "expressions";
}

export interface DebugPolicy {
	/** `ompDesk.agentDebugger.enabled`. */
	enabled(): boolean;
	/** `ompDesk.agentDebugger.start`. */
	startMode(): StartMode;
	/** `ompDesk.agentDebugger.expressions`. */
	expressionsMode(): ExpressionMode;
	/** One blocking confirmation; resolves `false` when declined or dismissed. */
	confirm(request: ConsentRequest): Promise<boolean>;
}

/** A configuration Desk offers besides the user's `launch.json` (design section 6). */
export interface DebugPreset {
	readonly id: string;
	readonly label: string;
	/** Appended to the `vscode_debug_start` description while the preset is available. */
	readonly description: string;
	available(): boolean;
	/** The configuration for the given arguments, or the reason they are not valid. */
	build(args: { readonly endPoint?: string; readonly projectPath?: string }): { readonly configuration: Record<string, unknown> } | { readonly error: string };
}
