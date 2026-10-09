/**
 * Rewind, Undo and branch-switch vocabulary shared by the OMP-side command, the host and the page
 * (design `docs/designs/2026-10-09-chat-rewind.md`, ADR-0051).
 *
 * Everything here is pure: the wire codec of `/omp-desk-navigate`, the navigation marker the command appends, the
 * rewind targets and consequences a page or the host QuickPick shows, the Undo offer derived from the marker, and
 * the branch points of the active path.
 */
import type { ImageContent } from "@oh-my-pi/pi-wire";
import { isRecord } from "../guards.ts";
import type { ChatEntry } from "./messages.ts";
import { toolPresentation } from "./tool-presentation.ts";
import { projectTranscript, rendersTranscriptEntry, type ProjectedTool } from "./transcript.ts";

/** The extension command the host-control module registers in RPC mode. */
export const NAVIGATE_COMMAND = "omp-desk-navigate";
/** `customType` of the `custom` entry the command appends after a real leaf move. */
export const NAVIGATION_MARKER_TYPE = "omp-desk/navigation";
/** Every refusal the command throws starts with this, then one {@link NavigateRefusalCode}. */
export const NAVIGATE_ERROR_PREFIX = `${NAVIGATE_COMMAND}:`;
/** `extension_error.extensionPath` of a refusal or failure thrown by the command handler. */
export const NAVIGATE_ERROR_PATH = `command:${NAVIGATE_COMMAND}`;

export type NavigationKind = "rewind" | "undo" | "switch";
const KINDS: Record<string, true> = { rewind: true, undo: true, switch: true };

/** The fixed refusal vocabulary of the OMP-side handler; child text is never forwarded. */
export type NavigateRefusalCode = "bad-request" | "mode" | "busy" | "session" | "stale" | "target" | "cancelled" | "unchanged" | "failed";
const CODES: Record<string, true> = { "bad-request": true, mode: true, busy: true, session: true, stale: true, target: true, cancelled: true, unchanged: true, failed: true };

const REQUEST_ID = /^[0-9a-f]{32}$/;
const MAX_ID_LENGTH = 256;

/** The compare-and-swap request the host sends and the handler re-checks. */
export interface NavigateArgs {
	v: 1;
	requestId: string;
	kind: NavigationKind;
	sessionId: string;
	/** The leaf the request was made against; the handler refuses `stale` when the live leaf differs. */
	expectedLeafId: string | null;
	targetId: string;
	summarize: boolean;
}

const entryId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;

/** The prompt text that runs the command. */
export function encodeNavigateCommand(args: NavigateArgs): string {
	return `/${NAVIGATE_COMMAND} ${JSON.stringify(args)}`;
}

/** Parse the command's argument string (everything after the name). `null` for anything malformed. */
export function parseNavigateArgs(text: string): NavigateArgs | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(value) || value.v !== 1) return null;
	const { requestId, kind, sessionId, expectedLeafId, targetId, summarize } = value;
	if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return null;
	if (typeof kind !== "string" || KINDS[kind] !== true) return null;
	if (!entryId(sessionId) || !entryId(targetId) || (expectedLeafId !== null && !entryId(expectedLeafId))) return null;
	if (typeof summarize !== "boolean") return null;
	return { v: 1, requestId, kind: kind as NavigationKind, sessionId, expectedLeafId, targetId, summarize };
}

/** The error message a refusal throws. */
export function navigateError(code: NavigateRefusalCode): Error {
	return new Error(`${NAVIGATE_ERROR_PREFIX}${code}`);
}

/** The refusal code in an `extension_error` text; any other text from the command is a plain `failed`. */
export function navigateErrorCode(message: unknown): NavigateRefusalCode {
	if (typeof message !== "string" || !message.startsWith(NAVIGATE_ERROR_PREFIX)) return "failed";
	const code = message.slice(NAVIGATE_ERROR_PREFIX.length).trim();
	return CODES[code] === true ? code as NavigateRefusalCode : "failed";
}

/** The data of the marker entry. */
export interface NavigationMarkerData {
	v: 1;
	requestId: string;
	kind: NavigationKind;
	/** The leaf before the move, as OMP's `session_tree` event reported it: Undo returns here. */
	from: string | null;
	target: string;
	/** The leaf the move produced, before the marker itself was appended. */
	to: string | null;
	/** Whether a `branch_summary` entry was actually appended (OMP skips an empty summary). */
	summarized: boolean;
	/** The session moved between the request's checks and the marker (`from` or `to` differ from what was checked). */
	raced?: true;
}

/**
 * Why a navigation did not happen, decided by the host before writing or reported back by the OMP-side guard
 * (`RpcSession.navigate`). `unconfirmed` is not a refusal and has its own sentence.
 */
export type NavigateRefusal = "not-live" | "not-owner" | "busy" | "compacting" | "unsupported" | "stale" | "target" | "session" | "cancelled" | "unchanged" | "bad-request-id" | "failed";

/** One fixed sentence per refusal; nothing from the child is ever shown. */
export const NAVIGATE_REFUSAL_SENTENCES: Readonly<Record<NavigateRefusal | "unconfirmed", string>> = {
	"not-live": "Rewind needs a running session. Resume it first.",
	"not-owner": "Another window controls this session.",
	busy: "Rewind is unavailable while OMP is working. Wait for the turn to finish or stop it.",
	compacting: "Rewind is unavailable while the conversation is being compacted.",
	unsupported: "This chat process cannot rewind: it was started by an earlier OMP Desk. Restart the chat to use Rewind.",
	stale: "The conversation changed meanwhile. Pick the message again.",
	target: "That message is no longer on this branch. Pick another one.",
	session: "The session changed under this chat. Nothing was rewound.",
	cancelled: "An OMP extension cancelled the rewind.",
	unchanged: "The conversation is already at that point.",
	"bad-request-id": "OMP did not rewind the conversation.",
	failed: "OMP did not rewind the conversation.",
	unconfirmed: "OMP did not confirm the rewind. The transcript shows what happened.",
};

export interface NavigationMarker extends NavigationMarkerData {
	/** The marker entry's own id. */
	id: string;
	parentId: string | null;
}

/** The marker an entry is, or `null`. Accepts a parsed chat entry or a raw `get_entries` record. */
export function navigationMarker(entry: object): NavigationMarker | null {
	if (!("type" in entry) || entry.type !== "custom" || !("customType" in entry) || entry.customType !== NAVIGATION_MARKER_TYPE) return null;
	if (!("id" in entry) || !entryId(entry.id)) return null;
	const data = "data" in entry ? entry.data : undefined;
	if (!isRecord(data) || data.v !== 1 || typeof data.requestId !== "string" || !REQUEST_ID.test(data.requestId)) return null;
	if (typeof data.kind !== "string" || KINDS[data.kind] !== true || !entryId(data.target)) return null;
	if ((data.from !== null && !entryId(data.from)) || (data.to !== null && !entryId(data.to))) return null;
	const parentId = "parentId" in entry ? entry.parentId : null;
	return {
		id: entry.id,
		parentId: typeof parentId === "string" ? parentId : null,
		v: 1,
		requestId: data.requestId,
		kind: data.kind as NavigationKind,
		from: data.from as string | null,
		target: data.target,
		to: data.to as string | null,
		summarized: data.summarized === true,
		...(data.raced === true ? { raced: true as const } : {}),
	};
}

// Targets and consequences

export interface RewindTarget {
	id: string;
	parentId: string | null;
	/** First non-empty line of the prompt, bounded; image markers kept. */
	preview: string;
	images: number;
	timestamp: string;
}

const PREVIEW_CHARS = 160;

function promptText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	let text = "";
	for (const block of content) if (isRecord(block) && block.type === "text" && typeof block.text === "string") text += block.text;
	return text;
}

/** First non-empty line, collapsed and bounded. */
export function promptPreview(text: string): string {
	const line = text.split(/\r?\n/).find(candidate => candidate.trim().length > 0)?.trim() ?? "";
	return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
}

/** Whether an entry is a user prompt Rewind can target: a durable `message` with role `user`. */
export function isRewindTarget(entry: ChatEntry): boolean {
	return entry.type === "message" && entry.message.role === "user";
}

/** The user prompts of the loaded active branch, oldest first. `entries` are durable rows only. */
export function rewindTargets(entries: readonly ChatEntry[]): RewindTarget[] {
	const targets: RewindTarget[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const images = typeof content === "string" ? 0 : content.filter(block => block.type === "image").length;
		targets.push({ id: entry.id, parentId: entry.parentId, preview: promptPreview(promptText(content)) || (images > 0 ? `${images} image${images === 1 ? "" : "s"}` : "(empty prompt)"), images, timestamp: entry.timestamp });
	}
	return targets;
}

export interface RewindPreview {
	/** Rendered transcript rows that leave the active branch (the target prompt included). */
	messages: number;
	/** User prompts that leave the active branch (the target included). */
	prompts: number;
	/** Distinct paths written by edit/write tools after the target, in first-seen order. */
	files: readonly string[];
	/** Shell, Python and eval calls after the target. */
	commands: number;
}

/** What leaves the active branch when `targetId` (a prompt on it) is rewound. `null` when it is not loaded. */
export function rewindPreview(entries: readonly ChatEntry[], targetId: string, cwd?: string): RewindPreview | null {
	const at = entries.findIndex(entry => entry.id === targetId);
	if (at < 0) return null;
	const leaving = entries.slice(at);
	let messages = 0;
	let prompts = 0;
	for (const entry of leaving) {
		if (rendersTranscriptEntry(entry)) messages += 1;
		if (isRewindTarget(entry)) prompts += 1;
	}
	const files: string[] = [];
	const seen = new Set<string>();
	let commands = 0;
	// A call can appear on its own card and again on a results card; count each call once.
	const tools = new Map<string, ProjectedTool>();
	for (const card of projectTranscript(leaving, cwd === undefined ? {} : { cwd })) {
		if (card.kind === "tool") tools.set(card.tool.call.id, card.tool);
		else if (card.kind === "results") for (const tool of card.tools) if (!tools.has(tool.call.id)) tools.set(tool.call.id, tool);
	}
	for (const tool of tools.values()) {
		const presentation = toolPresentation(tool, cwd);
		if (presentation.category === "command") commands += 1;
		if (presentation.category !== "edit") continue;
		for (const path of presentation.paths) {
			if (seen.has(path)) continue;
			seen.add(path);
			files.push(path);
		}
	}
	return { messages, prompts, files, commands };
}

/** The text and images a rewound prompt puts back into the composer. */
export interface RewindDraft {
	text: string;
	images: readonly ImageContent[];
	/** Images whose bytes were not available (an unresolved `blob:` reference); they cannot be restored. */
	unavailableImages: number;
}

/** The draft of a user prompt entry, or `null` for any other entry. */
export function rewindDraft(entry: ChatEntry): RewindDraft | null {
	if (entry.type !== "message" || entry.message.role !== "user") return null;
	const content = entry.message.content;
	if (typeof content === "string") return { text: content, images: [], unavailableImages: 0 };
	const images: ImageContent[] = [];
	let unavailableImages = 0;
	for (const block of content) {
		if (block.type !== "image") continue;
		if (block.data.startsWith("blob:")) unavailableImages += 1;
		else images.push({ type: "image", data: block.data, mimeType: block.mimeType });
	}
	return { text: promptText(content), images, unavailableImages };
}

/** The Undo a page offers: the newest conversation entry of the branch is a rewind or switch marker. */
export interface UndoOffer {
	markerId: string;
	/** The tip to return to. */
	from: string;
	kind: NavigationKind;
	summarized: boolean;
}

/**
 * Entry types Undo looks past: session metadata no conversation turn produced. OMP appends `session_exit` (a
 * `custom` entry) when the process ends, and settings changes or labels may follow a rewind without a new turn.
 */
const UNDO_TRANSPARENT: Record<string, true> = { custom: true, model_change: true, thinking_level_change: true, service_tier_change: true, mode_change: true, label: true };

/**
 * The marker Undo would reverse on `branch` (root first, ending at the leaf): walking back from the leaf past
 * metadata ({@link UNDO_TRANSPARENT}: `session_exit` after a restart, extension state, settings changes), the first
 * other entry must be a `rewind` or `switch` marker with a known `from`. Shared by the page, the host check and the
 * OMP-side handler, so Undo survives a reload or restart. Desk never sees `label`, `service_tier_change` or
 * `mode_change` under their own type (the history reader drops them, `parseChatEntry` makes them `unknown`), so
 * after one the page and host withhold Undo that the handler would accept: withheld, never wrong.
 */
export function undoMarker(branch: readonly object[]): NavigationMarker | null {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index]!;
		const marker = navigationMarker(entry);
		if (marker !== null) return marker.kind === "undo" || marker.from === null ? null : marker;
		if (!("type" in entry) || typeof entry.type !== "string" || UNDO_TRANSPARENT[entry.type] !== true) return null;
	}
	return null;
}

/** Undo is offered while {@link undoMarker} finds a marker on the loaded branch, which ends at `leafId`. */
export function undoOffer(entries: readonly ChatEntry[], leafId: string | null): UndoOffer | null {
	if (leafId === null || entries.at(-1)?.id !== leafId) return null;
	const marker = undoMarker(entries);
	return marker === null ? null : { markerId: marker.id, from: marker.from!, kind: marker.kind, summarized: marker.summarized };
}

/**
 * Bookkeeping OMP appends after a turn without changing the conversation (`model_usage` once a reply settled). It
 * can land after the leaf a page or the host last read, so the compare-and-swap looks past it.
 */
const LEAF_TRANSPARENT: Record<string, true> = { model_usage: true };

/**
 * Whether the leaf of `branch` (root first, ending at the leaf) is `expectedLeafId`, or only {@link LEAF_TRANSPARENT}
 * bookkeeping follows it. The navigation's compare-and-swap in the host and in OMP; a page that read the leaf before
 * OMP appended its usage record still names the conversation the user saw. Also reads an entry Desk parsed as
 * `unknown` by its native type.
 */
export function leafReaches(branch: readonly object[], expectedLeafId: string | null): boolean {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index]!;
		if ("id" in entry && entry.id === expectedLeafId) return true;
		const type = "type" in entry && typeof entry.type === "string" ? entry.type : null;
		const native = type === "unknown" && "nativeType" in entry && typeof entry.nativeType === "string" ? entry.nativeType : type;
		if (native === null || LEAF_TRANSPARENT[native] !== true) return false;
	}
	return expectedLeafId === null;
}

// Branch points

/** One node of the session tree, as cheap as the history index can provide it. */
export interface BranchNode {
	id: string;
	parentId: string | null;
	/** `user` or `assistant` for a message entry of that role; anything else is not a counted message. */
	role: string | null;
	/** {@link promptPreview} of a user prompt, when the reader has its body. */
	preview?: string;
}

/** One sibling branch that left the active path at a branch point. */
export interface BranchInfo {
	/** The newest entry of the branch (file order): the target a switch navigates to. */
	tipId: string;
	/** The first user prompt of the branch, when it has one. */
	firstPromptId: string | null;
	/** Its preview, when the reader had the body (a full `get_entries`, not the history index). */
	firstPrompt?: string;
	/** User and assistant messages in the branch. */
	messages: number;
	prompts: number;
}

/** An entry on the active path whose other children hold messages. `entryId` null: the branches are other roots. */
export interface BranchPoint {
	entryId: string | null;
	branches: readonly BranchInfo[];
}

export const MAX_BRANCH_POINTS = 200;
export const MAX_BRANCHES_PER_POINT = 20;

/** Roles whose entry is a conversation message a switch may land on. */
const TIP_ROLES: Record<string, true> = { user: true, assistant: true, toolResult: true };

/**
 * Off-path branches of the active `path` (ids, root first), from `nodes` in file order. Only a divergence the user
 * made is a branch: an off-path subtree whose first message, past metadata and markers (`role` null), is a user
 * prompt. OMP's own pruning (a discarded empty stop, a checkpoint rewind) leaves subtrees rooted at an assistant or
 * tool result message and is not shown; an append can never create a user-rooted sibling off the known leaf, so a
 * delta keeps the last value. The switch target is the newest user/assistant/tool-result message of the subtree.
 * Bounded by {@link MAX_BRANCH_POINTS} points (the newest kept) and {@link MAX_BRANCHES_PER_POINT} branches each.
 */
export function computeBranchPoints(nodes: readonly BranchNode[], path: readonly string[]): BranchPoint[] {
	if (path.length === 0 || nodes.length === 0) return [];
	const position = new Map<string, number>();
	const children = new Map<string | null, number[]>();
	nodes.forEach((node, index) => {
		position.set(node.id, index);
		const parent = node.parentId !== null && node.parentId.length > 0 ? node.parentId : null;
		const bucket = children.get(parent);
		if (bucket === undefined) children.set(parent, [index]);
		else bucket.push(index);
	});
	const onPath = new Set(path);
	const offPathChildren = (id: string | null): number[] => (children.get(id) ?? []).filter(index => !onPath.has(nodes[index]!.id));
	const points: BranchPoint[] = [];
	// A divergence below metadata Desk does not load (OMP's `model_usage` after a reply) is shown at the nearest
	// message at or before it on the path, which the transcript always holds.
	const pathIndex = new Map(path.map((id, index) => [id, index]));
	const anchorOf = (id: string | null): string | null => {
		for (let index = id === null ? -1 : pathIndex.get(id) ?? -1; index >= 0; index -= 1) {
			const at = position.get(path[index]!);
			if (at === undefined || nodes[at]!.role !== null) return path[index]!;
		}
		return null;
	};
	for (const parent of [null, ...path] as (string | null)[]) {
		const kids = offPathChildren(parent);
		if (kids.length === 0) continue;
		const branches: BranchInfo[] = [];
		for (const child of kids) {
			// The first messages below the root, past metadata: one of them must be a user prompt.
			let userRooted = false;
			const frontier = [child];
			const crossed = new Set<number>();
			while (frontier.length > 0 && !userRooted) {
				const current = frontier.pop()!;
				if (crossed.has(current)) continue;
				crossed.add(current);
				const role = nodes[current]!.role;
				if (role === "user") userRooted = true;
				else if (role === null) frontier.push(...offPathChildren(nodes[current]!.id));
			}
			if (!userRooted) continue;
			let tip = -1;
			let firstPrompt = -1;
			let messages = 0;
			let prompts = 0;
			const stack = [child];
			const seen = new Set<number>();
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (seen.has(current)) continue;
				seen.add(current);
				const node = nodes[current]!;
				if (node.role !== null && TIP_ROLES[node.role] === true && current > tip) tip = current;
				if (node.role === "user" || node.role === "assistant") messages += 1;
				if (node.role === "user") {
					prompts += 1;
					if (firstPrompt < 0 || current < firstPrompt) firstPrompt = current;
				}
				stack.push(...offPathChildren(node.id));
			}
			if (tip < 0) continue;
			const preview = firstPrompt < 0 ? undefined : nodes[firstPrompt]!.preview;
			branches.push({ tipId: nodes[tip]!.id, firstPromptId: firstPrompt < 0 ? null : nodes[firstPrompt]!.id, ...(preview ? { firstPrompt: preview } : {}), messages, prompts });
		}
		if (branches.length === 0) continue;
		const entryId = anchorOf(parent);
		const previous = points.at(-1)?.entryId === entryId ? points.pop()!.branches : [];
		const merged = [...previous, ...branches].sort((a, b) => (position.get(b.tipId) ?? 0) - (position.get(a.tipId) ?? 0));
		points.push({ entryId, branches: merged.slice(0, MAX_BRANCHES_PER_POINT) });
	}
	return points.length > MAX_BRANCH_POINTS ? points.slice(points.length - MAX_BRANCH_POINTS) : points;
}

/** The branch-node view of raw `get_entries` records. */
export function branchNodesOf(raw: readonly Record<string, unknown>[]): BranchNode[] {
	const nodes: BranchNode[] = [];
	for (const entry of raw) {
		if (typeof entry.id !== "string") continue;
		const message = entry.type === "message" && isRecord(entry.message) ? entry.message : null;
		const role = message !== null && typeof message.role === "string" ? message.role : null;
		const content = role === "user" ? message!.content : undefined;
		const preview = typeof content === "string" || Array.isArray(content) ? promptPreview(promptText(content as string | { type: string; text?: string }[])) : "";
		nodes.push({ id: entry.id, parentId: typeof entry.parentId === "string" ? entry.parentId : null, role, ...(preview ? { preview } : {}) });
	}
	return nodes;
}

/** Validate a branch-point list from the wire; anything malformed is dropped. */
export function parseBranchPoints(value: unknown): BranchPoint[] {
	if (!Array.isArray(value)) return [];
	const points: BranchPoint[] = [];
	for (const raw of value.slice(-MAX_BRANCH_POINTS)) {
		if (!isRecord(raw) || (raw.entryId !== null && !entryId(raw.entryId)) || !Array.isArray(raw.branches)) continue;
		const branches: BranchInfo[] = [];
		for (const branch of raw.branches.slice(0, MAX_BRANCHES_PER_POINT)) {
			if (!isRecord(branch) || !entryId(branch.tipId) || (branch.firstPromptId !== null && !entryId(branch.firstPromptId))) continue;
			const messages = branch.messages, prompts = branch.prompts;
			if (typeof messages !== "number" || !Number.isInteger(messages) || messages < 1 || typeof prompts !== "number" || !Number.isInteger(prompts) || prompts < 0) continue;
			const firstPrompt = typeof branch.firstPrompt === "string" && branch.firstPrompt.length > 0 ? promptPreview(branch.firstPrompt) : "";
			branches.push({ tipId: branch.tipId, firstPromptId: branch.firstPromptId as string | null, ...(firstPrompt ? { firstPrompt } : {}), messages, prompts });
		}
		if (branches.length > 0) points.push({ entryId: raw.entryId as string | null, branches });
	}
	return points;
}
