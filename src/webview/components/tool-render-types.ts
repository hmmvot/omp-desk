import type { ReactNode } from "react";
import type { AgentActivity, RunningAgent } from "../../chat/agents";

export interface ToolRenderContext {
	name: string;
	args: Record<string, unknown>;
	details: Record<string, unknown>;
	text: string;
	/** The card shows everything (its "Show all" state): row windows are then unbounded (paged or windowed). Otherwise they are previews. */
	expanded: boolean;
	partial: boolean;
	hasResult: boolean;
	isError: boolean;
	stream: Record<string, unknown>;
	callId?: string;
	agents?: ReadonlyMap<string, RunningAgent>;
	agentActivity?: ReadonlyMap<string, AgentActivity>;
	renderChild?: (id: string) => ReactNode;
	cwd?: string;
}
export interface ToolSemanticView {
	title: string;
	icon?: string;
	target?: string;
	meta?: readonly string[];
	tone?: "error" | "warning" | "info";
	/** Blocks of what was asked that the head cannot carry (a long or multi-line command, eval code): shown above the output bar. */
	input?: readonly ToolInputBlock[];
	/** The output bar's label (default `Output`) and what Copy puts on the clipboard (default the result text without OMP's notices). */
	output?: { readonly label?: string; readonly copy?: string; /** The text a format is detected in (JSON, newline-delimited JSON): the output the `OutputText` block of the body shows. */ readonly structured?: string };
	/** One-line face extras rendered in the collapsed header after the target. */
	inline?: ReactNode;
	/** Right-aligned header slot, after every other face element (a component may own a clock). */
	trailing?: ReactNode;
	/** False when the expanded body would only repeat the header and tooltip: the row is then not a disclosure. Absent means expandable. */
	expandable?: boolean;
	/** Full header tooltip, for facts the one-line face truncates. */
	tooltip?: string;
	body: ReactNode;
	family: string;
}
/** One block of a call's input: a label, the rows, and the exact text Copy puts on the clipboard. */
export interface ToolInputBlock {
	readonly label: string;
	readonly node: ReactNode;
	readonly copy: string;
}
