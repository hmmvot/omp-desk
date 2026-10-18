/**
 * MCP tools as OMP's terminal UI frames them (`pi-tui/src/tools/mcp.ts`): titled `server/tool`, with a one-line
 * summary of the arguments as the head's target. Pure and DOM-free.
 *
 * An MCP tool is identified by its minted name alone: OMP mints `mcp__<server>_<tool>` for every MCP tool and no native
 * tool starts with `mcp__` (`pi-coding-agent/src/mcp/tool-bridge.ts`, `mintMCPToolName`). The result's `details`
 * (`serverName`, `mcpToolName`) name the real server and tool, because the minted name is lower-cased and sanitised.
 */
import { isRecord } from "../shared/guards.ts";

const MCP_TOOL_NAME_PREFIX = "mcp__";

export function isMcpToolName(name: string): boolean {
	return name.startsWith(MCP_TOOL_NAME_PREFIX) && name.length > MCP_TOOL_NAME_PREFIX.length;
}

/**
 * `server/tool` of an MCP call, or `null` for any other tool. The result's details win; while the call is pending (and for a
 * result without them) the minted name is split at its first underscore, as OMP's `parseMCPToolName` does, and a name that
 * does not split is shown whole.
 */
export function mcpToolLabel(name: string, details: Record<string, unknown>): string | null {
	if (!isMcpToolName(name)) return null;
	const { serverName, mcpToolName } = details;
	if (typeof serverName === "string" && serverName !== "" && typeof mcpToolName === "string" && mcpToolName !== "") return `${serverName}/${mcpToolName}`;
	const rest = name.slice(MCP_TOOL_NAME_PREFIX.length);
	const underscore = rest.indexOf("_");
	return underscore > 0 && underscore < rest.length - 1 ? `${rest.slice(0, underscore)}/${rest.slice(underscore + 1)}` : name;
}

/** The arguments a call shows: OMP's intent field and the streaming bookkeeping key are not arguments. */
export function visibleMcpArgs(args: Record<string, unknown>): Record<string, unknown> {
	const visible: Record<string, unknown> = {};
	for (const key in args) if (Object.hasOwn(args, key) && key !== "i" && key !== "__partialJson") visible[key] = args[key];
	return visible;
}

/** The summary's budget in characters and one value's, OMP's `MCP_ARGS_SUMMARY_CHARS` and `formatScalar(…, 24)`. */
const SUMMARY_CHARS = 160;
const SCALAR_CHARS = 24;

function summaryScalar(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") {
		// Only the start of a long string can show; bounding it first keeps the cost off the argument's size.
		const escaped = value.slice(0, SCALAR_CHARS * 4).replace(/\n/g, "\\n").replace(/\t/g, "\\t");
		return `"${escaped.length > SCALAR_CHARS || value.length > escaped.length ? `${escaped.slice(0, SCALAR_CHARS - 1)}…` : escaped}"`;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (isRecord(value)) return `{${Object.keys(value).length} keys}`;
	return String(value);
}

/** `key="value", count=3, …`: the first arguments that fit in 160 characters, then an ellipsis; empty without arguments. */
export function mcpArgsSummary(args: Record<string, unknown>): string {
	const pairs: string[] = [];
	let length = 0;
	for (const key in args) {
		if (!Object.hasOwn(args, key) || key === "i" || key === "__partialJson") continue;
		const pair = `${key}=${summaryScalar(args[key])}`;
		const added = pair.length + (pairs.length > 0 ? 2 : 0);
		if (length + added > SUMMARY_CHARS && pairs.length > 0) {
			pairs.push("…");
			break;
		}
		pairs.push(pair);
		length += added;
	}
	return pairs.join(", ");
}

/**
 * The notice OMP appends to a truncated result's text (`[Showing lines …]`, `[Full output was not saved …]`, a limit or a
 * column cut), when the result's `details.meta` says there is one. The card's footer shows the same facts from `details`; the
 * output is shown without them, so a JSON result still parses.
 */
const TRAILING_NOTICE = /\n\n\[(?:Showing |Some lines |Full output |\d+ (?:matches|results) )[^\]\n]*\]$/;
export function mcpOutputText(text: string, details: Record<string, unknown>): string {
	const trimmed = text.trimEnd();
	const meta = details.meta;
	const noticed = isRecord(meta) && (isRecord(meta.truncation) || meta.artifactError !== undefined || isRecord(meta.limits));
	return noticed ? trimmed.replace(TRAILING_NOTICE, "").trimEnd() : trimmed;
}
