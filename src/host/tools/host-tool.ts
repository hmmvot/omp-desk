/**
 * Contract between the host tool channel (`RpcSession`) and the capabilities Desk exposes to OMP through
 * `set_host_tools` (docs/designs/2026-10-10-agent-debugger-tools.md section 1, ADR-0055).
 *
 * Shapes follow the installed OMP's `RpcHostToolDefinition` / `AgentToolResult` (`modes/rpc/rpc-types.ts`).
 */

/** Mirrors OMP's `ToolLoadMode`. */
export type HostToolLoadMode = "discoverable" | "essential";

/** Text content plus an error flag, as carried by `host_tool_update.partialResult` and `host_tool_result.result`. */
export interface HostToolResult {
  readonly content: readonly { type: "text"; text: string }[];
  readonly isError?: boolean;
  readonly details?: unknown;
}

export interface HostToolContext {
  /** Aborted on OMP cancel or local cancellation. */
  readonly signal: AbortSignal;
  /** Progress (`host_tool_update`). Dropped after the call is cancelled by OMP. */
  update(partial: HostToolResult): void;
  /** Throws `HostToolRefusal` if the executor gate or the settings no longer admit this call. */
  checkExecutor(): void;
  /** OMP session file id of the calling Chat (for control grants). */
  readonly conversationId: string;
}

export interface HostToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** JSON Schema. */
  readonly parameters: Record<string, unknown>;
  readonly loadMode: HostToolLoadMode;
  execute(args: unknown, ctx: HostToolContext): Promise<HostToolResult>;
}

/** Thrown by `checkExecutor()` and by tools that refuse a call; the message becomes the error result text. */
export class HostToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostToolRefusal";
  }
}

/** Supplies the current tool set; `changed` fires when settings change the set (re-registration). */
export interface HostToolProvider {
  tools(): readonly HostToolDefinition[];
  readonly changed: (listener: () => void) => { dispose(): void };
}
