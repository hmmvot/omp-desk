import type { ReactNode } from "react";
import type { AgentActivity, RunningAgent } from "../../chat/agents";

export interface ToolRenderContext {
	name: string;
	args: Record<string, unknown>;
	details: Record<string, unknown>;
	text: string;
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
	/** Native collapsed body row budget; "none" means the family emits its own compact rows. */
	preview?: number | { tail: number } | "none";
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
