/**
 * OMP Desk — the activity-bar launcher.
 *
 * The launcher shows this window's folders and the user's pinned ones (ADR-0045), with
 * deliberately separate authorities:
 *
 * - **Folders** — the merged list built by `src/views/launcher-folders.ts`: the folders
 *   VS Code has open here, the pinned list of `src/views/workspace-folders.ts` and
 *   folders kept visible by a live session. A folder node is a navigation heading: it
 *   is never derived from a session, and unpinning one touches no session.
 * - **Rows** — every indexed conversation, running or stopped, whose recorded
 *   working directory is exactly the folder's. A row is *not* tied to an open
 *   editor: closing an editor detaches a frontend, and the conversation keeps its
 *   own durable row (ADR-0025). A discovered file that `SessionIndex` does not
 *   track is not a row here; a folder's Resume action discovers those on demand.
 *   The index remains the only session identity and claim authority, and VS Code
 *   remains the only authority for which editors are open.
 *
 * Nothing here invents session state, starts a process, imports a file or mirrors
 * the per-tab panel/terminal map that `src/extension.ts` owns; anything that can
 * start, focus or stop something is delegated back to it. A row click
 * opens stopped history without a writer; a rapid second click or Open launches it.
 * A fileless draft has nothing to view, so its click requests Open instead.
 *
 * Two arrangements share the same rows (`omp.sessionsGrouping`): the folder tree above,
 * and a flat list — the default — with one row per session of the same folders, labelled
 * `folder · title`, ordered by `src/views/session-order.ts` (live rows unread first then by
 * last activity, stopped rows last) and ended by a New Session row. A row is *unread* when
 * the agent finished or asked and the user has not looked since (`src/host/session-unread.ts`);
 * both arrangements mark it with a dot in the description.
 *
 * Rows never delete anything themselves. "Forget" drops a row and no file;
 * "Delete" is decided and performed by `src/host/session-lifecycle.ts`, which
 * re-reads every proof under an exclusive claim at the moment it acts.
 * Provenance does not decide whether Delete is offered: an imported row and one
 * this extension created use the same action (ADR-0027).
 *
 * Session titles come from OMP itself: the fixed-width title slot of the exact
 * session file the index recorded, which is what OMP's own listing resolves, with
 * the header's own `title` field as the fallback for a file written without one,
 * the last title this extension observed as the next fallback, and a stable
 * per-conversation `New session N` label last — never the folder name, so two
 * untitled conversations in one folder stay distinguishable.
 *
 * Rows expose icon, description and tooltip for the same state precedence:
 * ownership uncertainty or stopped intent, a structured question, a streaming
 * turn (Working), background work, then proven idle (unread information is
 * supplementary). A question mark in prose is never an actionable question;
 * unavailable work detail stays Running.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { readSessionFileActivity, readSessionFileHeader } from "../host/session-index";
import type { RestoreOutcome, SessionFileActivity, SessionFileHeader, SessionIndexEntry } from "../host/session-index";
import { folderOwnsCwd } from "./workspace-folders";
import type { LauncherFolder } from "./launcher-folders";
import type { WorkspaceFolder } from "./workspace-folders";
import { isUnread } from "../host/session-unread";
import { sessionIncarnation } from "../host/window-registry";
import type { PublishedRowStatus } from "../host/window-registry";
import { activityMillis, flatFolderLabels, flatRowLabel, orderFlatRows } from "./session-order";
import type { FlatOrderFacts, SessionsGrouping } from "./session-order";

/**
 * Agent activity of an attached live session, as its guest reports it.
 *
 * All of it is per-window and none of it is persisted here: the durable
 * conversation identities live in the index, the live turn state lives in the
 * guest. `trailingQuestion` is explicitly the guest's own heuristic flag, so this
 * module never derives a question from message text.
 */
export interface SessionActivityFacts {
	/** A structured question/approval is pending in the guest. */
	readonly pendingQuestion: boolean;
	/** A turn is streaming. */
	readonly working: boolean;
	readonly backgroundWork: boolean;
	readonly settled: boolean;
	/** The guest's heuristic: the completed reply ends with a question mark. */
	readonly trailingQuestion: boolean;
	/** Stable identity of the last completed reply, or `null`. */
	readonly lastCompletedReplyId: string | null;
	/** Stable identity of the last reply actually displayed, or `null`. */
	readonly lastSeenReplyId: string | null;
}

/** Per-tab facts the durable index cannot know: they belong to this window. */
export interface SessionLauncherFacts {
	/** A Webview panel for this slot is open in this window. */
	readonly open: boolean;
	/**
	 * The view this window's open editor currently shows for the row: the kind of the
	 * runtime it serves. `null` when no editor is open here or no runtime is attached,
	 * in which case the menu cannot name a view the session is "not" shown in.
	 */
	readonly viewMode?: "chat" | "terminal" | null;
	/** This window's native OMP host for this conversation is running. */
	readonly running: boolean;
	/** This window is actively recording/executing the row's launch attempt. */
	readonly launching?: boolean;
	/** A confirmed stop is awaiting its broker/ownership verdict. */
	readonly stopping?: boolean;
	/** Last restore outcome observed for this tab in this window, if any. */
	readonly outcome: RestoreOutcome | null;
	/**
	 * This window's startup pass is still re-adopting this row's recorded host. Until it
	 * settles the row cannot be told from a writer this window does not own, so it says
	 * "Restoring" instead of "Blocked" for that bounded time.
	 */
	readonly restoring?: boolean;
	/** A current claim read proves another live window holds this conversation. */
	readonly heldElsewhere?: boolean;
	/** The claim holder id and owner generation of that other window. */
	readonly heldBy?: string | null;
	readonly heldGeneration?: string | null;
	readonly switchableWindow?: boolean;
	/**
	 * A plain `omp` process this extension does not own holds this session's OMP lease
	 * (ADR-0046). Never set for a row this window runs, for a verified extension-owned
	 * writer, or for a row another window of this extension holds: those win.
	 */
	readonly externalOmp?: boolean;
	/** Fresh authenticated broker witness for a writer not attached in this window. */
	readonly ownedWriterPid?: number | null;
	readonly ownershipChecked?: boolean;
	/** No ownership observation has completed for this binding yet. */
	readonly checking?: boolean;
	readonly legacyWriter?: boolean;
	/**
	 * Activity of an attached live guest, or `null` when none is attached. A row
	 * that is not running in this window ignores it entirely.
	 */
	readonly activity?: SessionActivityFacts | null;
}

/**
 * Read-only view of the world the launcher renders. Folder membership comes from
 * the merged folder list (this window's VS Code folders plus the pinned ones),
 * session identity from the index, and open/closed from this window; the launcher is
 * never a source of any of the three.
 */
export interface SessionLauncherSource {
	/** The folders to show, in display order. */
	folders(): readonly LauncherFolder[];
	/** Every indexed conversation, in durable `ordinal` order. */
	entries(): readonly SessionIndexEntry[];
	/**
	 * Conversation of the last native TreeView selection.
	 *
	 * It is the index's active tab, kept current by the view's own selection event,
	 * so it survives focus moving to an unrelated editor.
	 */
	activeTabId(): string | null;
	/** Pure local facts: reading these never performs I/O. */
	facts(tabId: string): SessionLauncherFacts;
	/** An identity for this window's current runtime binding, not its activity. */
	runtimeIdentity(tabId: string): string | null;
	/** Display-only ownership observations; lifecycle commands recheck their own authority. */
	observeOwnership(tabId: string): Promise<SessionOwnershipFacts>;
	/**
	 * Whether this folder currently has a detached, recoverable folder-shell slot.
	 *
	 * A folder shell is a separate terminal whose process outlived its frontend;
	 * it is **not** an OMP session and never enters {@link entries} — this is a
	 * presentation fact the launcher only forwards, so the folder's menu can offer
	 * Reconnect Terminal when there is something to reconnect to (several detached
	 * shells are the caller's own picker concern). Optional: a source that knows
	 * nothing about folder shells reports none, and the folder's action stays
	 * "Open Terminal", which always starts a new shell.
	 */
	hasRecoverableShell?(folder: WorkspaceFolder): boolean;
	/** How rows are arranged now; a source that omits it keeps the folder tree. */
	grouping?(): SessionsGrouping;
	/**
	 * What the window registry knows about the live window holding a row this window does not
	 * run (`holderId` is the claim's holder, or `null` when unknown). A source that omits it
	 * shows such a row as Running.
	 */
	peer?(tabId: string, holderId: string | null, incarnation: string | null): PeerRow | null;
}

export type SessionOwnershipFacts = Pick<SessionLauncherFacts,
	"heldElsewhere" | "heldBy" | "heldGeneration" | "switchableWindow" | "externalOmp" | "ownedWriterPid" | "ownershipChecked" | "legacyWriter">;

interface RowObservation {
	identity: string;
	value: SessionOwnershipFacts | null;
	dirty: boolean;
	inFlight: boolean;
}

interface HeaderObservation {
	identity: string;
	file: string;
	value: SessionFileHeader | null;
	dirty: boolean;
	inFlight: boolean;
}

/** The session file's last conversation entry, re-checked by `fstat` on every external refresh. */
interface ConversationObservation {
	file: string;
	value: SessionFileActivity | null;
	dirty: boolean;
	inFlight: boolean;
}

/**
 * When a row's conversation last advanced, as its tooltip reports it: `lastAt` is
 * the last conversation entry's timestamp, or `null` when there is none yet (a
 * draft without a file, or a file holding no conversation).
 */
export interface SessionConversation {
	readonly lastAt: string | null;
}

export type SessionItemState =
	| "otherWindow"
	| "externalOmp"
	| "blocked"
	| "restoring"
	| "starting"
	| "stopping"
	| "checking"
	| "stopped"
	| "draft"
	| "question"
	| "working"
	| "background"
	| "unread"
	| "waiting"
	| "running";

/**
 * The URI scheme of a session row's `resourceUri`. It exists only so a decoration provider can badge
 * the row: a row label is truncated by a long title and takes its description with it, a badge is not.
 */
export const SESSION_DECORATION_SCHEME = "omp-session";
/** The badge after the status of a row another window runs: two joined squares, one character. */
const OTHER_WINDOW_BADGE = "\u29C9";
type RowBadge = "unread" | "other" | "unread-other";

const STATE_LABEL: Record<SessionItemState, string> = {
	otherWindow: "Open in another window",
	externalOmp: "Open in another OMP process",
	blocked: "Blocked",
	restoring: "Restoring",
	starting: "Starting",
	stopping: "Stopping",
	checking: "Checking",
	stopped: "Stopped",
	draft: "Idle",
	question: "Needs your answer",
	working: "Working",
	background: "Waiting for subagents",
	unread: "Unread reply",
	waiting: "Idle",
	running: "Running",
};

/** The row's status word as the Sessions view shows it, for other pickers that name the same session. */
export function sessionStateLabel(state: SessionItemState): string {
	return STATE_LABEL[state];
}

const STATE_ICON: Record<SessionItemState, vscode.ThemeIcon> = {
	otherWindow: new vscode.ThemeIcon("multiple-windows", new vscode.ThemeColor("charts.purple")),
	externalOmp: new vscode.ThemeIcon("terminal", new vscode.ThemeColor("charts.orange")),
	blocked: new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground")),
	restoring: new vscode.ThemeIcon("sync", new vscode.ThemeColor("descriptionForeground")),
	starting: new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("descriptionForeground")),
	stopping: new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("descriptionForeground")),
	checking: new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("descriptionForeground")),
	stopped: new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("descriptionForeground")),
	draft: new vscode.ThemeIcon("edit", new vscode.ThemeColor("descriptionForeground")),
	question: new vscode.ThemeIcon("question", new vscode.ThemeColor("charts.orange")),
	working: new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.green")),
	background: new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.green")),
	unread: new vscode.ThemeIcon("bell-dot", new vscode.ThemeColor("charts.blue")),
	waiting: new vscode.ThemeIcon("circle-outline", new vscode.ThemeColor("descriptionForeground")),
	running: new vscode.ThemeIcon("play", new vscode.ThemeColor("charts.green")),
};

/** Menu visibility is only an invitation; the index rechecks ownership before forgetting. */
const FORGETTABLE_STATE: Record<SessionItemState, boolean> = {
	otherWindow: false,
	externalOmp: false,
	blocked: false,
	restoring: false,
	starting: false,
	stopping: false,
	checking: false,
	stopped: true,
	draft: true,
	question: false,
	working: false,
	background: false,
	unread: false,
	waiting: false,
	running: false,
};

/**
 * Menu visibility is not deletion permission: a blocked imported bookmark may
 * ask for deletion, but the native transaction must still prove its file free.
 *
 * `state` is the last observation this index stored, and a host can start between
 * a render and a click, so `src/host/session-lifecycle.ts` re-reads the host, the
 * claim and the reconciler's verdict under an exclusive claim at the moment it
 * acts and refuses anything it cannot prove. A row not offered here is never
 * deleted; a row offered here can still be refused.
 */
const DELETABLE_STATE: Record<SessionItemState, boolean> = {
	otherWindow: false,
	externalOmp: false,
	blocked: false,
	restoring: false,
	starting: false,
	stopping: false,
	checking: false,
	stopped: true,
	draft: false,
	question: false,
	working: false,
	background: false,
	unread: false,
	waiting: false,
	running: false,
};


/**
 * Decide one row's state.
 *
 * This window's own facts come first: it knows exactly what it runs and what it
 * has open. Then ownership that this extension could not resolve, then the durable
 * run intent — which overrides agent activity, so a stopped row never looks busy.
 * Only an attached live row is presented with agent activity at all.
 */
export function sessionItemState(entry: SessionIndexEntry, facts: SessionLauncherFacts): SessionItemState {
	if (facts.stopping === true) return "stopping";
	// A live rival holder is not a stopped session or a releasable stale attempt: another
	// VS Code window of this extension has the session open. Nothing here may launch it.
	if (facts.heldElsewhere === true) return "otherWindow";
	// The durable null-child reservation is recovery metadata, not evidence that
	// a launch still executing in this window has been abandoned.
	if (facts.launching === true && !facts.running) return "starting";
	// A live or unresolved row this window's startup pass is still re-adopting is not a
	// refusal: the pass either attaches it (and the row becomes running) or records the
	// conflict that makes it blocked.
	if (facts.restoring === true && !facts.running && entry.availability === "live") {
		if (facts.ownershipChecked !== true || facts.ownedWriterPid != null) return "restoring";
	}
	// A plain OMP outside this extension writes the session. Nothing here may launch it without
	// the user's confirmation, and this window runs nothing for the row.
	if (!facts.running && facts.externalOmp === true && facts.ownedWriterPid == null) return "externalOmp";
	if (!facts.running && facts.checking === true) return "checking";
	if (!facts.running && facts.ownedWriterPid != null) return "running";
	if (!facts.running && facts.ownershipChecked !== true && entry.availability === "live") return "running";
	if (entry.availability === "failed") return "blocked";
	// A saved legacy row can retain old running intent after its host has gone.
	// Availability describes what is here now; never label that row as running.
	if (!facts.running && (entry.availability === "saved" || facts.ownershipChecked === true)) return entry.sessionFile === null ? "draft" : "stopped";
	if (!facts.running && entry.runIntent === "stopped") return entry.kind === "draft" ? "draft" : "stopped";
	const activity = facts.running ? facts.activity : null;
	if (activity == null) return "running";
	if (activity.pendingQuestion) return "question";
	if (activity.working) return "working";
	if (activity.backgroundWork) return "background";
	if (!activity.settled) return "running";
	if (activity.lastCompletedReplyId !== null && activity.lastCompletedReplyId !== activity.lastSeenReplyId) {
		return "unread";
	}
	return "waiting";
}

/**
 * The stable label of one untitled conversation.
 *
 * `ordinal` is minted once per conversation and never reused, so this label is
 * stable across restarts, editor closes and native switches, and two untitled
 * sessions in one folder never share it.
 */
export function untitledSessionHeadline(ordinal: number): string {
	return `New session ${ordinal}`;
}

/**
 * What this conversation is called: OMP's own stored title, the last one this
 * extension observed, or the stable ordinal label.
 */
export function sessionHeadline(entry: SessionIndexEntry, header: SessionFileHeader | null): string {
	const stored = displaySessionTitle(header?.title ?? "");
	if (stored.length > 0) return stored;
	const cached = displaySessionTitle(entry.title ?? "");
	if (cached.length > 0) return cached;
	const prompt = displaySessionTitle(header?.promptTitle ?? "");
	if (prompt.length > 0) return prompt;
	return untitledSessionHeadline(entry.ordinal);
}

/** Unicode private-use areas: the BMP area and both supplementary planes. */
const PRIVATE_USE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

/**
 * A stored OMP title as VS Code UI surfaces (tree rows, tab titles, dialogs,
 * pickers) can show it. OMP 18.8 heads generated titles with a card icon
 * (`<icon> CODE: title`), and under the `nerd` symbol preset that icon is a
 * Nerd Font private-use glyph, which the workbench UI font renders as a box.
 * Private-use characters are dropped and the spacing they leave collapsed, so
 * `<glyph> GREET: Fix x` shows as `GREET: Fix x`; emoji icons are kept. OMP's
 * stored title is never changed.
 */
export function displaySessionTitle(title: string): string {
	return title.replace(PRIVATE_USE, "").replace(/\s+/g, " ").trim();
}

/** Short file name for the explicit session picker, not the Sessions tree row. */
export function sessionFileLabel(entry: SessionIndexEntry): string {
	return entry.sessionFile === null ? "no session file yet" : path.basename(entry.sessionFile);
}

/** What a folder node is called: the last path component, or the path itself at a root. */
export function folderHeadline(folderPath: string): string {
	return path.basename(folderPath) || folderPath;
}

/** Bounded tree description: retain the drive/root and the most useful path tail. */
export function folderPathDescription(folderPath: string): string {
	const budget = 40;
	if (folderPath.length <= budget) return folderPath;
	const root = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\?|\/)/.exec(folderPath)?.[0] ?? "";
	const prefixLength = Math.min(Math.max(root.length, 8), 16);
	return `${folderPath.slice(0, prefixLength)}…${folderPath.slice(-(budget - prefixLength - 1))}`;
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/**
 * How long ago a timestamp was, in the coarsest honest unit.
 *
 * Used by a session row's tooltip and by the folder resume picker, so a session's
 * age reads the same wherever the launcher shows it.
 */
export function relativeAge(iso: string, now: number): string {
	const at = new Date(iso).getTime();
	if (Number.isNaN(at)) return "unknown";
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return relativeTimeFormatter.format(-seconds, "second");
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return relativeTimeFormatter.format(-minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (hours < 48) return relativeTimeFormatter.format(-hours, "hour");
	return relativeTimeFormatter.format(-Math.round(hours / 24), "day");
}

/** A session file's size in the coarsest honest unit, as the picker shows it. */
export function sizeText(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * `conversation` is `null` while the session file has not been read, or cannot be:
 * the tooltip then names no activity rather than a bookkeeping time.
 */
function sessionTooltip(
	entry: SessionIndexEntry,
	state: SessionItemState,
	header: SessionFileHeader | null,
	conversation: SessionConversation | null,
	now: number,
	unread = false,
	where: string | null = null,
): string {
	const lines = [
		sessionHeadline(entry, header).replace(/\r\n|\r|\n/g, " "),
		STATE_LABEL[state],
	];
	if (conversation !== null) {
		lines.push(conversation.lastAt === null ? "No activity yet" : `Last activity: ${relativeAge(conversation.lastAt, now)}`);
	}
	if (unread && state !== "unread") lines.push("Unread reply");
	if (where !== null) lines.push(where);
	if (state === "stopped" || state === "draft") lines.push("Resume to send a message.");
	if (state === "externalOmp") lines.push("Open here to choose whether to continue separately.");
	return lines.join("\n");
}

/** The latest conversation timestamp among these, or `null` when none has one. */
function latestConversationAt(times: readonly (string | null)[]): string | null {
	return times.reduce<string | null>((latest, at) =>
		at !== null && (latest === null || Date.parse(at) > Date.parse(latest)) ? at : latest, null);
}

function folderTooltip(folder: LauncherFolder, latest: string | null, hasRecoverableShell: boolean, now: number): string {
	const where = folder.openHere && folder.openElsewhere ? "Open in this and another window"
		: folder.openHere ? "Open in this window" : folder.openElsewhere ? "Open in another window" : null;
	const lines = [
		folderHeadline(folder.path).replace(/\r\n|\r|\n/g, " "),
		folder.pinned ? `Pinned${where === null ? "" : ` · ${where}`}` : where ?? "Kept while a session runs in it",
		latest === null ? "No session activity yet" : `Last activity: ${relativeAge(latest, now)}`,
		...(folder.openedPaths === undefined || folder.openedPaths.length === 0 ? [] : [
			`Shown instead of the opened ${folder.openedPaths.map(opened => `"${opened}"`).join(", ")} because the repository's agent files are here.`,
		]),
	];
	if (hasRecoverableShell) lines.push("Reconnect Terminal to reopen its terminal.");
	return lines.join("\n");
}

/** Everything one conversation row is painted from, besides its index entry and state. */
interface SessionRowPresentation {
	header: SessionFileHeader | null;
	conversation: SessionConversation | null;
	facts: SessionLauncherFacts;
	active: boolean;
	now: number;
	/** The flat list's folder name in front of the title, or `null`/absent under a folder node. */
	folderLabel?: string | null;
	/** The agent finished or asked and the user has not looked since (see `src/host/session-unread.ts`). */
	unread?: boolean;
	/** The window another window's claim shows holding this row: its published status and name, or `null` when unknown. */
	peer?: PeerRow | null;
}

/** What the registry knows about the window that holds a row this window does not run. */
export interface PeerRow {
	/** The status that window publishes for the row; `null` until it has published one for this run. */
	readonly status: PublishedRowStatus | null;
	/** The conversation activity that window published for this run (ISO); `null` when none. */
	readonly lastActivityAt: string | null;
	/** That window's VS Code workspace name, for the tooltip; empty when unknown. */
	readonly window: string;
}

/**
 * The status a row shows: its own state, or for a row another window holds, the status that
 * window published for the exact claim generation, with the shared unread marker applied the
 * way the owner applies it (a settled, idle session with an unread reply is Unread reply).
 * Without a matching publication the holder is known to run it and nothing more: Running.
 */
export function shownSessionState(state: SessionItemState, peer: PeerRow | null, unread: boolean): SessionItemState {
	if (state !== "otherWindow") return state;
	const status = peer?.status ?? "running";
	return status === "waiting" && unread ? "unread" : status;
}

/** Which window the row is open in, for its tooltip; `null` when it is open in none this view knows of. */
function hold(state: SessionItemState, row: SessionRowPresentation): string | null {
	if (state === "otherWindow") return `Open in another window${row.peer?.window ? `: ${row.peer.window}` : ""}. Click to switch to it.`;
	return row.facts.running ? "Open in this window" : null;
}

/**
 * One conversation row.
 *
 * The provider keeps the instances it created until the next refresh, so
 * `TreeView.reveal` always receives an element the view already knows; commands
 * receive the same instance as their argument and read `tabId` from it.
 */
export class SessionTreeItem extends vscode.TreeItem {
	readonly tabId: string;
	/** The session's own name, without the flat list's folder in front of it. */
	headline!: string;
	entry!: SessionIndexEntry;
	state!: SessionItemState;
	/** Whether "Forget" may be offered for this row. */
	forgettable!: boolean;
	/** Whether "Delete" may be offered for this row (see {@link DELETABLE_STATE}). */
	deletable!: boolean;
	/** Whether this row can request an explicit launch. */
	resumable!: boolean;
	/** The conversation's own last activity, or `null` while it is unknown (see {@link SessionConversation}). */
	conversation!: SessionConversation | null;
	/** Whether the row carries the unread mark. */
	unread!: boolean;
	#diagnosticFacts!: SessionLauncherFacts;
	#diagnosticActive = false;

	get diagnostics(): string {
		return JSON.stringify({ entry: this.entry, state: this.state, conversation: this.conversation, facts: this.#diagnosticFacts, active: this.#diagnosticActive }, null, 2);
	}

	constructor(
		entry: SessionIndexEntry,
		state: SessionItemState,
		row: SessionRowPresentation,
	) {
		super("", vscode.TreeItemCollapsibleState.None);
		this.tabId = entry.tabId;
		this.id = entry.tabId;
		// Commands and TreeView.reveal retain this element across presentation changes.
		this.command = { command: "omp.clickSession", title: "Open", arguments: [this] };
		this.update(entry, state, row);
	}

	update(
		entry: SessionIndexEntry,
		state: SessionItemState,
		row: SessionRowPresentation,
	): void {
		const headline = sessionHeadline(entry, row.header);
		this.headline = headline;
		this.label = row.folderLabel == null ? headline : flatRowLabel(row.folderLabel, headline);
		this.unread = row.unread === true;
		this.entry = entry;
		this.state = state;
		this.conversation = row.conversation;
		const missingTranscript = state === "blocked" && entry.availability === "failed";
		this.forgettable = !row.facts.running && (FORGETTABLE_STATE[state] || missingTranscript);
		this.deletable = entry.sessionFile !== null &&
			(DELETABLE_STATE[state] || state === "running" || row.facts.running);
		this.resumable = state === "stopped" || state === "draft" || state === "running" || state === "checking" || row.facts.running;
		// A row another window holds is shown as that window shows it: its published status, so
		// every window reads the same text and icon. `state` stays "otherWindow" for the menu
		// contract, and the tooltip names the window.
		const shown = shownSessionState(state, row.peer ?? null, this.unread);
		const status = STATE_LABEL[shown];
		this.description = this.unread && shown !== "unread" ? `Unread · ${status}` : status;
		this.tooltip = sessionTooltip(entry, shown, row.header, row.conversation, row.now, this.unread, hold(state, row));
		this.#diagnosticFacts = row.facts;
		this.#diagnosticActive = row.active;
		this.iconPath = STATE_ICON[shown];
		// The menu conditions in package.json match on these segments, so the order is
		// part of the contract:
		// `ompSession.forgettable|held.<state>.<resumable|live-only>.<deletable|file-kept>.<materialized|fileless>.view-<chat|terminal|none>`.
		// `materialized` is the exact session file's existence, which is what a Reload
		// needs: visibility is an invitation, and the command still re-checks.
		// `view-*` is the view an open editor shows now, so a live row offers only the other one.
		this.contextValue = [
			"ompSession",
			this.forgettable ? "forgettable" : "held",
			state,
			this.resumable ? "resumable" : "live-only",
			this.deletable ? "deletable" : "file-kept",
			entry.sessionFile === null ? "fileless" : "materialized",
			`view-${row.facts.open && row.facts.viewMode != null ? row.facts.viewMode : "none"}`,
		].join(".");
		if (state === "otherWindow" && row.facts.switchableWindow === true) this.contextValue += ".window-switchable";
		const accessibilityLabel = `${row.folderLabel == null ? "" : `${row.folderLabel}, `}${headline}, ${STATE_LABEL[shown]}${this.unread && shown !== "unread" ? ", unread" : ""}${row.active ? ", selected session" : ""}`;
		this.accessibilityInformation = { label: accessibilityLabel };
		this.resourceUri = vscode.Uri.from({ scheme: SESSION_DECORATION_SCHEME, path: `/${entry.tabId}` });
	}
}

/**
 * One folder the launcher shows: the launcher's root node.
 *
 * Its `id` is the stable folder id, which is what the folder's commands receive, and
 * its collapsible state is built from the saved value — durable for a pinned folder,
 * per window otherwise — so a refresh repaints a deliberately collapsed folder as
 * collapsed instead of expanding it. A folder is collapsible whether or not it holds a
 * row: an empty folder still gets the native expand/collapse affordance, which lets the
 * user set the preference before the first session appears and keeps every folder
 * uniform. A pinned folder carries the pin icon.
 */
export class WorkspaceFolderTreeItem extends vscode.TreeItem {
	/** Stable registry id: what every folder-scoped command receives. */
	readonly folderId: string;
	folder!: LauncherFolder;
	rows!: readonly SessionTreeItem[];
	get diagnostics(): string {
		return JSON.stringify({ folder: this.folder, sessionCount: this.rows.length, hasRecoverableShell: this.hasRecoverableShell }, null, 2);
	}
	/**
	 * Whether a detached folder terminal of this folder can be reconnected.
	 *
	 * Presentation only, and never a session: it decides whether the folder's menu
	 * offers Reconnect Terminal (see the context-value token below) and nothing
	 * else. Open Terminal always starts a new shell whatever this says.
	 */
	hasRecoverableShell!: boolean;

	constructor(folder: LauncherFolder, rows: readonly SessionTreeItem[], hasRecoverableShell = false, now = Date.now()) {
		super("", vscode.TreeItemCollapsibleState.None);
		this.folderId = folder.id;
		this.id = folder.id;
		this.update(folder, rows, hasRecoverableShell, now);
	}

	/** The folder's "Last activity" is the latest of its rows' conversations. */
	update(folder: LauncherFolder, rows: readonly SessionTreeItem[], hasRecoverableShell: boolean, now: number): void {
		this.label = folderHeadline(folder.path);
		this.collapsibleState = folder.collapsed
			? vscode.TreeItemCollapsibleState.Collapsed
			: vscode.TreeItemCollapsibleState.Expanded;
		this.folder = folder;
		this.rows = rows;
		this.hasRecoverableShell = hasRecoverableShell;
		this.iconPath = new vscode.ThemeIcon(folder.pinned ? "pinned" : "folder", new vscode.ThemeColor("descriptionForeground"));
		this.description = folderPathDescription(folder.path);
		this.tooltip = folderTooltip(folder, latestConversationAt(rows.map(row => row.conversation?.lastAt ?? null)), hasRecoverableShell, now);
		// The menu contract, exactly as the folder menus expect it:
		// `ompWorkspaceFolder.[shells.]<collapsed|expanded>.<pinned|unpinned>`. A folder with a
		// recoverable detached shell carries the `shells` segment so the Reconnect Terminal
		// condition can match `^ompWorkspaceFolder\.shells\.`; the final segment selects Pin or
		// Unpin; every folder still matches the plain `^ompWorkspaceFolder\.` conditions.
		this.contextValue =
			`ompWorkspaceFolder.${hasRecoverableShell ? "shells." : ""}${folder.collapsed ? "collapsed" : "expanded"}.${folder.pinned ? "pinned" : "unpinned"}`;
		this.accessibilityInformation = {
			label: `${folderHeadline(folder.path)}, ${folder.path}, OMP folder, ${folder.pinned ? "pinned, " : ""}${rows.length === 0 ? "no session" : `${rows.length} session(s)`}`,
		};
	}
}

/** An empty folder still offers a direct, folder-scoped launch. */
export class EmptySessionTreeItem extends vscode.TreeItem {
	readonly folderId: string;
	constructor(folder: WorkspaceFolderTreeItem) {
		super("No sessions yet — New Session", vscode.TreeItemCollapsibleState.None);
		this.folderId = folder.folderId;
		this.id = `${folder.folderId}.empty`;
		this.iconPath = new vscode.ThemeIcon("add");
		this.command = { command: "omp.newSession", title: "New Session", arguments: [folder] };
	}
}

/** A default-profile onboarding action, not a session or folder. */
export class ProviderLoginTreeItem extends vscode.TreeItem {
	constructor() {
		super("Log in to a model provider to start", vscode.TreeItemCollapsibleState.None);
		this.id = "omp.providerLogin";
		this.iconPath = new vscode.ThemeIcon("account");
		this.command = { command: "omp.loginProvider", title: "Log In to Provider" };
	}
}

/**
 * The flat list's row after the sessions: it asks for a folder and opens a new session there through
 * `omp.newSession`, exactly as the view's own New Session action does.
 */
export class NewSessionTreeItem extends vscode.TreeItem {
	constructor() {
		super("New Session…", vscode.TreeItemCollapsibleState.None);
		this.id = "omp.newSessionRow";
		this.iconPath = new vscode.ThemeIcon("add");
		this.command = { command: "omp.newSession", title: "New Session" };
		this.contextValue = "ompNewSession";
		this.accessibilityInformation = { label: "New Session, choose a folder to start a session in" };
	}
}

/**
 * The flat list's row under New Session…: it asks for a folder, then lists that folder's saved
 * sessions through `omp.resumeWorkspaceFolder`, exactly as the view's own Resume Session action does.
 */
export class ResumeSessionTreeItem extends vscode.TreeItem {
	constructor() {
		super("Resume Session…", vscode.TreeItemCollapsibleState.None);
		this.id = "omp.resumeSessionRow";
		this.iconPath = new vscode.ThemeIcon("history");
		this.command = { command: "omp.resumeWorkspaceFolder", title: "Resume Session" };
		this.contextValue = "ompResumeSession";
		this.accessibilityInformation = { label: "Resume Session, choose a folder to resume a saved session from" };
	}
}

export type LauncherTreeItem =
	| WorkspaceFolderTreeItem | SessionTreeItem | EmptySessionTreeItem | ProviderLoginTreeItem | NewSessionTreeItem | ResumeSessionTreeItem;

/**
 * Catalog-first projection. Membership and local activity are synchronous;
 * independent bounded queues enrich ownership, file titles and the conversation's
 * last activity afterwards. Tree elements survive refreshes, but an observation
 * survives only its exact binding. Root/folder publication barriers keep automatic
 * reveal out of VS Code's cancellable parent fetches.
 *
 * "Last activity" is the session file's last conversation entry
 * ({@link readSessionFileActivity}), never the index's bookkeeping time. Every
 * {@link refresh} re-checks it with one `fstat` per file, reading the tail only
 * when the file changed, and re-renders a tooltip whose relative age changed.
 */
export class SessionTreeProvider implements vscode.TreeDataProvider<LauncherTreeItem>, vscode.Disposable {
	readonly #source: SessionLauncherSource;
	readonly #now: () => number;
	readonly #onObservationError: (error: unknown) => void;
	readonly #changes = new vscode.EventEmitter<LauncherTreeItem | undefined | void>();
	readonly onDidChangeTreeData = this.#changes.event;
	readonly #served = new vscode.EventEmitter<void>();
	readonly onDidServeTree = this.#served.event;
	readonly #observed = new vscode.EventEmitter<void>();
	/** A row's conversation activity was read and differs from before. */
	readonly onDidObserveConversation = this.#observed.event;
	#items: WorkspaceFolderTreeItem[] = [];
	#byTabId = new Map<string, SessionTreeItem>();
	#observations = new Map<string, RowObservation>();
	#headers = new Map<string, HeaderObservation>();
	#conversations = new Map<string, ConversationObservation>();
	#presentation = new Map<string, string>();
	#folderVersions = new Map<string, number>();
	#servedFolders = new Map<string, number>();
	#rootVersion = 0;
	#servedRoot = -1;
	#initialized = false;
	#disposed = false;
	#scheduled = false;
	#ownershipActive = 0;
	#headersActive = 0;
	#conversationsActive = 0;
	#revealLocks = 0;
	#projectionPending = false;
	readonly #providerLogin = new ProviderLoginTreeItem();
	#providerLoginRequired = false;
	#grouping: SessionsGrouping = "folders";
	#flatRows: SessionTreeItem[] = [];
	/** The folder name of every row, in either grouping: what the session picker shows. */
	#folderNames = new Map<string, string>();
	#flatSignature = "";
	readonly #decorationChanges = new vscode.EventEmitter<vscode.Uri[]>();
	#badges = new Map<string, RowBadge>();
	/**
	 * Registered by the extension; badges a row after its status: an unread dot (blue), and, in a
	 * window that does not run the session, a "held elsewhere" glyph. The row's own icon is always
	 * its status icon, whichever window shows it.
	 */
	readonly decorations: vscode.FileDecorationProvider = {
		onDidChangeFileDecorations: this.#decorationChanges.event,
		provideFileDecoration: uri => {
			const badge = uri.scheme === SESSION_DECORATION_SCHEME ? this.#badges.get(uri.path.slice(1)) : undefined;
			if (badge === undefined) return undefined;
			if (badge === "other") return new vscode.FileDecoration(OTHER_WINDOW_BADGE, "Open in another window");
			const decoration = new vscode.FileDecoration(badge === "unread" ? "●" : `●${OTHER_WINDOW_BADGE}`, badge === "unread" ? "Unread reply" : "Unread reply; open in another window", new vscode.ThemeColor("charts.blue"));
			return decoration;
		},
	};
	readonly #newSessionRow = new NewSessionTreeItem();
	readonly #resumeSessionRow = new ResumeSessionTreeItem();

	constructor(source: SessionLauncherSource, options: {
		readonly now?: () => number;
		readonly onObservationError?: (error: unknown) => void;
	} = {}) {
		this.#source = source;
		this.#now = options.now ?? (() => Date.now());
		this.#onObservationError = options.onObservationError ?? console.error;
	}

	setProviderLoginRequired(required: boolean): void {
		if (this.#disposed || this.#providerLoginRequired === required) return;
		this.#providerLoginRequired = required;
		this.#rootVersion++;
		this.#changes.fire();
	}

	refresh(options: { readonly ownership?: boolean } = {}): void {
		if (this.#disposed) return;
		if (options.ownership === true) {
			for (const observation of this.#observations.values()) observation.dirty = true;
			// A transcript that appeared, vanished or changed its title is read again too.
			for (const header of this.#headers.values()) header.dirty = true;
		}
		for (const conversation of this.#conversations.values()) conversation.dirty = true;
		this.#project();
	}

	/** Lookup does not claim that VS Code has served this element's parents. */
	async itemFor(tabId: string): Promise<SessionTreeItem | undefined> {
		if (!this.#initialized) this.#project();
		return this.#byTabId.get(tabId);
	}

	/**
	 * Every session of the shown folders in the flat list's order — live rows unread first then by
	 * activity, stopped rows last — whichever grouping the view uses, with its folder's name.
	 */
	listedSessions(): readonly { readonly item: SessionTreeItem; readonly folder: string }[] {
		if (!this.#initialized) this.#project();
		return this.#flatRows.map(item => ({ item, folder: this.#folderNames.get(item.tabId) ?? "" }));
	}

	/**
	 * Re-read the ownership of these rows only, without rebuilding anything else.
	 *
	 * Another window opening or releasing a session changes one claim; only the rows
	 * filed under it need a new observation. The current value stays on screen until
	 * the new one arrives, so a row does not flicker through Checking. A row this
	 * window runs, and a tab the view does not show, are skipped by the enrichment pass.
	 */
	refreshOwnership(tabIds: ReadonlySet<string>): void {
		if (this.#disposed) return;
		let marked = false;
		for (const tabId of tabIds) {
			const observation = this.#observations.get(tabId);
			if (observation === undefined) continue;
			observation.dirty = true;
			marked = true;
		}
		if (marked) this.#scheduleEnrichment();
	}

	/** The state the view currently shows for this row, or `undefined` when it shows none. */
	displayedState(tabId: string): SessionItemState | undefined {
		return this.#byTabId.get(tabId)?.state;
	}

	/** The observed file name also supplies Processes and newly opened detail tabs. */
	headlineFor(tabId: string): string | undefined {
		const row = this.#byTabId.get(tabId);
		return row === undefined ? undefined : sessionHeadline(row.entry, this.#headers.get(tabId)?.value ?? null);
	}

	/**
	 * Reserve a fully served reveal path. Structural publications wait until
	 * release so they cannot cancel the fetch/reveal already walking that path.
	 *
	 * A row inside a folder the user collapsed is reserved only when `expand` says this
	 * reveal is the answer to the user activating that session: revealing expands the
	 * folder, which is exactly what that moment asks for. Without it the collapse stands,
	 * because ordinary activity must never undo a collapse the registry recorded. A
	 * collapsed folder's children are not fetched by VS Code, so only the root is
	 * required to have been served for it.
	 */
	beginReveal(tabId: string, options: { readonly expand?: boolean } = {}): { item: SessionTreeItem; pathKey: string; release(): void } | undefined {
		const item = this.#byTabId.get(tabId);
		if (item === undefined || this.#servedRoot !== this.#rootVersion) return undefined;
		let pathKey: string;
		if (this.#grouping === "flat") {
			if (!this.#flatRows.includes(item)) return undefined;
			pathKey = JSON.stringify([tabId, this.#rootVersion, "flat"]);
		} else {
			const parent = this.getParent(item);
			if (!(parent instanceof WorkspaceFolderTreeItem)) return undefined;
			if (parent.folder.collapsed ? options.expand !== true :
				this.#servedFolders.get(parent.folderId) !== this.#folderVersions.get(parent.folderId)) return undefined;
			pathKey = JSON.stringify([tabId, this.#rootVersion, parent.folderId, this.#folderVersions.get(parent.folderId)]);
		}
		this.#revealLocks++;
		let released = false;
		return { item, pathKey, release: () => {
			if (released) return;
			released = true;
			this.#revealLocks--;
			if (this.#revealLocks === 0 && this.#projectionPending) this.#project();
		} };
	}

	getChildren(element?: LauncherTreeItem): LauncherTreeItem[] {
		if (!this.#initialized) this.#project();
		if (element === undefined) {
			const version = this.#rootVersion;
			// Provider return precedes the extension host's child registration.
			// Notify on the next event-loop turn, after that registration's microtasks.
			setImmediate(() => {
				if (this.#disposed || version !== this.#rootVersion) return;
				this.#servedRoot = version;
				this.#served.fire();
			});
			const head = this.#providerLoginRequired ? [this.#providerLogin] : [];
			// With no folder at all the flat list is empty, so the view's welcome content shows.
			if (this.#grouping === "flat") {
				return this.#items.length === 0 ? head : [...head, ...this.#flatRows, this.#newSessionRow, this.#resumeSessionRow];
			}
			return [...head, ...this.#items];
		}
		if (this.#grouping === "flat" || !(element instanceof WorkspaceFolderTreeItem)) return [];
		const version = this.#folderVersions.get(element.folderId);
		setImmediate(() => {
			if (this.#disposed || version !== this.#folderVersions.get(element.folderId) ||
				!this.#items.includes(element) || version === undefined) return;
			this.#servedFolders.set(element.folderId, version);
			this.#served.fire();
		});
		return element.rows.length === 0 ? [new EmptySessionTreeItem(element)] : [...element.rows];
	}

	getTreeItem(element: LauncherTreeItem): vscode.TreeItem { return element; }

	getParent(element: LauncherTreeItem): LauncherTreeItem | undefined {
		if (this.#grouping === "flat" || element instanceof WorkspaceFolderTreeItem || element instanceof ProviderLoginTreeItem ||
			element instanceof NewSessionTreeItem || element instanceof ResumeSessionTreeItem) return undefined;
		if (element instanceof EmptySessionTreeItem) return this.#items.find(folder => folder.folderId === element.folderId);
		return this.#items.find(folder => folder.rows.includes(element));
	}

	/** The conversation's last activity as this window read it, for the owner to publish; `null` until read. */
	lastActivityOf(tabId: string): string | null {
		return this.#conversations.get(tabId)?.value?.lastConversationAt ?? null;
	}

	dispose(): void {
		this.#disposed = true;
		this.#items = [];
		this.#flatRows = [];
		this.#byTabId.clear();
		this.#observations.clear();
		this.#headers.clear();
		this.#conversations.clear();
		this.#decorationChanges.dispose();
		this.#changes.dispose();
		this.#observed.dispose();
		this.#served.dispose();
	}

	#identity(entry: SessionIndexEntry): string {
		return JSON.stringify([entry.sessionFile, entry.sessionId, entry.ownership,
			entry.host, entry.runIntent, this.#source.runtimeIdentity(entry.tabId)]);
	}

	#project(): void {
		if (this.#disposed) return;
		const entries = this.#source.entries();
		const folders = this.#source.folders();
		const activeTabId = this.#source.activeTabId();
		const grouping = this.#source.grouping?.() ?? "folders";
		const folderLabels = flatFolderLabels(folders);
		const folderNames = new Map<string, string>();
		const now = this.#now();
		const inputs = folders.map(folder => ({
			folder,
			hasRecoverableShell: this.#source.hasRecoverableShell?.(folder) === true,
			rows: entries.filter(entry => folderOwnsCwd(folder, folders, entry.cwd)).map(entry => {
				const identity = this.#identity(entry);
				let observation = this.#observations.get(entry.tabId);
				if (observation === undefined) {
					observation = { identity, value: null, dirty: true, inFlight: false };
					this.#observations.set(entry.tabId, observation);
				} else if (observation.identity !== identity) {
					observation.identity = identity;
					observation.value = null;
					observation.dirty = true;
				}
				let header = this.#headers.get(entry.tabId);
				const headerIdentity = JSON.stringify([entry.sessionFile, entry.title]);
				if (entry.sessionFile === null) this.#headers.delete(entry.tabId);
				else if (header === undefined) {
					header = { identity: headerIdentity, file: entry.sessionFile, value: null, dirty: true, inFlight: false };
					this.#headers.set(entry.tabId, header);
				} else if (header.identity !== headerIdentity) {
					header.identity = headerIdentity;
					header.file = entry.sessionFile;
					header.value = null;
					header.dirty = true;
				}
				// A draft has no file, so no conversation yet; a file's is unknown until read.
				let conversation: SessionConversation | null = { lastAt: null };
				if (entry.sessionFile === null) this.#conversations.delete(entry.tabId);
				else {
					let observed = this.#conversations.get(entry.tabId);
					if (observed === undefined || observed.file !== entry.sessionFile) {
						// A flight for another file finishes against its own record and is discarded.
						observed = { file: entry.sessionFile, value: null, dirty: true, inFlight: false };
						this.#conversations.set(entry.tabId, observed);
					}
					conversation = observed.value === null ? null : { lastAt: observed.value.lastConversationAt };
				}
				const local = this.#source.facts(entry.tabId);
				const facts = local.running ? local : {
					...observation.value, ...local,
					checking: observation.value?.ownershipChecked !== true,
				};
				const state = sessionItemState(entry, facts);
				// The unread marker is shared catalog state, so every window shows it; only a plain OMP
				// process outside this extension (not a window) is not this window's to read.
				const peer = state === "otherWindow" ? this.#source.peer?.(entry.tabId, facts.heldBy ?? null, sessionIncarnation(entry)) ?? null : null;
				// A row another window runs is ordered, and its age shown, from what its owner published for this
				// run (nothing published means no activity, not this window's own reading), so every window agrees.
				if (peer?.status != null) conversation = { lastAt: peer.lastActivityAt };
				return { entry, header: entry.sessionFile === null ? null : header?.value ?? null,
					conversation, facts, state, active: entry.tabId === activeTabId, peer,
					folderLabel: grouping === "flat" ? folderLabels.get(folder.id) ?? null : null,
					unread: isUnread(entry) && state !== "externalOmp" };
			}).sort((left, right) => {
				const stopped = (state: SessionItemState) => state === "stopped" || state === "draft" ? 1 : 0;
				return stopped(left.state) - stopped(right.state) || left.entry.ordinal - right.entry.ordinal;
			}),
		})).map(input => ({
			...input,
			tooltip: folderTooltip(input.folder, latestConversationAt(input.rows.map(row => row.conversation?.lastAt ?? null)),
				input.hasRecoverableShell, now),
		}));
		// One row per session of every shown folder, in the flat order: the flat list's rows, and the
		// session picker's in either grouping.
		const flatOrder: string[] = [];
		const flatFacts = new Map<string, FlatOrderFacts>();
		for (const input of inputs) {
			for (const row of input.rows) {
				if (flatFacts.has(row.entry.tabId)) continue;
				folderNames.set(row.entry.tabId, folderLabels.get(input.folder.id) ?? "");
				flatFacts.set(row.entry.tabId, {
					tabId: row.entry.tabId, ordinal: row.entry.ordinal, unread: row.unread,
					stopped: row.state === "stopped" || row.state === "draft",
					lastActivityAt: activityMillis(row.conversation?.lastAt, row.entry.lastActiveAt),
				});
			}
		}
		for (const row of orderFlatRows([...flatFacts.values()])) flatOrder.push(row.tabId);
		const flatSignature = JSON.stringify([flatOrder, inputs.length === 0]);
		const rootChanged = grouping === "flat"
			? this.#grouping !== "flat" || flatSignature !== this.#flatSignature
			: this.#grouping !== "folders" || inputs.length !== this.#items.length ||
				inputs.some((input, position) => this.#items[position]?.folderId !== input.folder.id);
		const changedFolders = inputs.filter(input => {
			const old = this.#items.find(item => item.folderId === input.folder.id);
			return old === undefined || old.folder.path !== input.folder.path ||
				old.folder.collapsed !== input.folder.collapsed ||
				old.folder.pinned !== input.folder.pinned ||
				old.folder.open !== input.folder.open ||
				old.folder.openHere !== input.folder.openHere ||
				old.folder.openElsewhere !== input.folder.openElsewhere ||
				old.hasRecoverableShell !== input.hasRecoverableShell ||
				old.rows.length !== input.rows.length ||
				input.rows.some((row, position) => old.rows[position]?.tabId !== row.entry.tabId);
		});
		// A folder whose hover text alone changed is repainted in place, children kept.
		const repaintedFolders = new Set(inputs.filter(input => !changedFolders.includes(input) &&
			this.#items.find(item => item.folderId === input.folder.id)?.tooltip !== input.tooltip).map(input => input.folder.id));
		// Folder nodes are not on screen in the flat list, so only its own order is structural there.
		const structuralChange = grouping === "flat" ? rootChanged
			: rootChanged || changedFolders.length > 0 || repaintedFolders.size > 0;
		if (this.#revealLocks > 0 && structuralChange) {
			this.#projectionPending = true;
			return;
		}
		this.#projectionPending = false;
		const previousRows = this.#byTabId;
		const byTabId = new Map<string, SessionTreeItem>();
		const rowChanges: SessionTreeItem[] = [];
		const newItems = inputs.map(input => {
			const rows = input.rows.map(({ entry, header, conversation, facts, state, active, folderLabel, unread, peer }) => {
				// The relative age is part of the key, so a refresh repaints a stale "x minutes ago".
				const age = conversation?.lastAt == null ? null : relativeAge(conversation.lastAt, now);
				const key = JSON.stringify([entry, header, conversation, age, facts, active, folderLabel, unread, peer]);
				let row = previousRows.get(entry.tabId);
				if (row === undefined) row = new SessionTreeItem(entry, state, { header, conversation, facts, active, now, folderLabel, unread, peer });
				else if (this.#presentation.get(entry.tabId) !== key) {
					row.update(entry, state, { header, conversation, facts, active, now, folderLabel, unread, peer });
					rowChanges.push(row);
				}
				this.#presentation.set(entry.tabId, key);
				byTabId.set(entry.tabId, row);
				return row;
			});
			let item = this.#items.find(previous => previous.folderId === input.folder.id);
			if (item === undefined) item = new WorkspaceFolderTreeItem(input.folder, rows, input.hasRecoverableShell, now);
			else item.update(input.folder, rows, input.hasRecoverableShell, now);
			return item;
		});
		this.#items = newItems;
		this.#byTabId = byTabId;
		const badges = new Map<string, RowBadge>();
		for (const [tabId, row] of byTabId) {
			const other = row.state === "otherWindow";
			if (row.unread) badges.set(tabId, other ? "unread-other" : "unread");
			else if (other) badges.set(tabId, "other");
		}
		const decorated = [...badges].filter(([tabId, badge]) => this.#badges.get(tabId) !== badge).map(([tabId]) => tabId)
			.concat([...this.#badges.keys()].filter(tabId => !badges.has(tabId)));
		this.#badges = badges;
		if (decorated.length > 0) this.#decorationChanges.fire(decorated.map(tabId => vscode.Uri.from({ scheme: SESSION_DECORATION_SCHEME, path: `/${tabId}` })));
		this.#flatRows = flatOrder.map(tabId => byTabId.get(tabId)!);
		this.#folderNames = folderNames;
		this.#grouping = grouping;
		this.#flatSignature = flatSignature;
		for (const tabId of this.#observations.keys()) {
			if (byTabId.has(tabId)) continue;
			const observation = this.#observations.get(tabId)!;
			// Keep an active flight's slot until it finishes, even across remove/re-add.
			observation.identity = "";
			observation.value = null;
			observation.dirty = false;
			if (!observation.inFlight) this.#observations.delete(tabId);
			this.#headers.delete(tabId);
			this.#conversations.delete(tabId);
			this.#presentation.delete(tabId);
		}
		const initialized = this.#initialized;
		this.#initialized = true;
		if (rootChanged) {
			this.#rootVersion++;
			this.#servedRoot = -1;
			this.#servedFolders.clear();
		}
		for (const input of changedFolders) {
			this.#folderVersions.set(input.folder.id, (this.#folderVersions.get(input.folder.id) ?? 0) + 1);
			this.#servedFolders.delete(input.folder.id);
		}
		if (initialized) {
			if (rootChanged) this.#changes.fire();
			else if (grouping === "flat") {
				for (const row of rowChanges) this.#changes.fire(row);
			} else {
				const structural = new Set(changedFolders.map(input => input.folder.id));
				for (const folder of this.#items) {
					if (structural.has(folder.folderId) || repaintedFolders.has(folder.folderId)) this.#changes.fire(folder);
				}
				for (const row of rowChanges) {
					const parent = this.getParent(row) as WorkspaceFolderTreeItem | undefined;
					if (parent !== undefined && !structural.has(parent.folderId) && !repaintedFolders.has(parent.folderId)) this.#changes.fire(row);
				}
			}
		}
		this.#scheduleEnrichment();
	}

	#scheduleEnrichment(): void {
		if (this.#scheduled || this.#disposed) return;
		this.#scheduled = true;
		setImmediate(() => {
			this.#scheduled = false;
			if (this.#disposed) return;
			for (const [tabId, observation] of this.#observations) {
				if (this.#ownershipActive >= 4) break;
				if (!observation.dirty || observation.inFlight || !this.#byTabId.has(tabId) ||
					this.#source.facts(tabId).running) continue;
				observation.dirty = false;
				observation.inFlight = true;
				this.#ownershipActive++;
				void this.#observe(tabId, observation);
			}
			for (const [tabId, header] of this.#headers) {
				if (this.#headersActive >= 4) break;
				if (!header.dirty || header.inFlight) continue;
				header.dirty = false;
				header.inFlight = true;
				this.#headersActive++;
				void this.#readHeader(tabId, header);
			}
			for (const [tabId, conversation] of this.#conversations) {
				if (this.#conversationsActive >= 4) break;
				if (!conversation.dirty || conversation.inFlight) continue;
				conversation.dirty = false;
				conversation.inFlight = true;
				this.#conversationsActive++;
				void this.#readConversation(tabId, conversation);
			}
		});
	}

	async #observe(tabId: string, observation: RowObservation): Promise<void> {
		const identity = observation.identity;
		try {
			const value = await this.#source.observeOwnership(tabId);
			const current = this.#source.entries().find(entry => entry.tabId === tabId);
			if (!this.#disposed && current !== undefined && this.#byTabId.has(tabId) &&
				observation.identity === identity && this.#identity(current) === identity &&
				!this.#source.facts(tabId).running) {
				observation.value = value;
				this.#project();
			}
		} catch (error) {
			if (!this.#disposed) this.#onObservationError(error);
		} finally {
			observation.inFlight = false;
			this.#ownershipActive--;
			if (!this.#byTabId.has(tabId) && this.#observations.get(tabId) === observation) this.#observations.delete(tabId);
			this.#scheduleEnrichment();
		}
	}

	async #readHeader(tabId: string, header: HeaderObservation): Promise<void> {
		const identity = header.identity;
		try {
			const value = await readSessionFileHeader(header.file);
			if (!this.#disposed && this.#headers.get(tabId) === header && header.identity === identity) {
				header.value = value;
				this.#project();
			}
		} catch (error) {
			if (!this.#disposed) this.#onObservationError(error);
		} finally {
			header.inFlight = false;
			this.#headersActive--;
			this.#scheduleEnrichment();
		}
	}

	/** An unchanged file costs one `fstat` and repaints nothing. */
	async #readConversation(tabId: string, conversation: ConversationObservation): Promise<void> {
		try {
			const previous = conversation.value;
			const value = await readSessionFileActivity(conversation.file, previous);
			if (!this.#disposed && this.#conversations.get(tabId) === conversation) {
				conversation.value = value;
				if ((previous === null) !== (value === null) || previous?.lastConversationAt !== value?.lastConversationAt) {
					this.#project();
					this.#observed.fire();
				}
			}
		} catch (error) {
			if (!this.#disposed) this.#onObservationError(error);
		} finally {
			conversation.inFlight = false;
			this.#conversationsActive--;
			this.#scheduleEnrichment();
		}
	}
}
