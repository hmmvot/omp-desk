/**
 * OMP Desk — the Processes view.
 *
 * A thin `TreeDataProvider` over the latest {@link BrokerProcessSnapshot}: one flat
 * row per background broker process, in the order the model sorted them. The provider
 * derives nothing about a process: what it hosts, whether it is orphaned or idle, and
 * whether it can be stopped here all come from the row (`src/host/broker-processes.ts`).
 * It only chooses words, icons and the menu context from those facts, and it never
 * runs a command on click: stopping is an explicit action from the row's menu or inline button.
 *
 * `contextValue` is `ompProcess.<stoppable|fixed>.<session|terminal>.<orphaned|idle|inuse|unknown>`;
 * the menu conditions in `package.json` match on its segments, so the order is part of
 * the contract.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type { BrokerProcessRow, BrokerProcessSnapshot } from "../host/broker-processes";
import { fmtDuration } from "../webview/lib/format";
import { relativeAge } from "./session-tree";

type ProcessState = "orphaned" | "idle" | "inuse" | "unknown";

/** Orphaned beats idle beats unchecked, the order the model sorts by; a live, referenced process is in use. */
function processState(row: BrokerProcessRow): ProcessState {
	if (row.status === "orphaned") return "orphaned";
	if (row.child === "exited") return "idle";
	return row.status === "in-use" ? "inuse" : "unknown";
}

const STATE_WORD: Record<ProcessState, string> = {
	orphaned: "Orphaned",
	idle: "Idle",
	inuse: "Running",
	unknown: "Unchecked",
};

const STATE_EXPLANATION: Record<ProcessState, string> = {
	orphaned: "No session or terminal uses this background process.",
	idle: "Its session or terminal has ended.",
	inuse: "Its session or terminal is still running.",
	unknown: "Refresh to check whether a session or terminal uses it.",
};

function stateWord(row: BrokerProcessRow, state: ProcessState): string {
	if (state === "inuse" && row.window !== "none") {
		return row.window === "this-window" ? "Open in this window" : "Open in another window";
	}
	return state === "inuse" && row.child === "unknown" ? "Unchecked" : STATE_WORD[state];
}

function processLabel(row: BrokerProcessRow): string {
	const { host } = row;
	if (row.kind === "stats") return "Stats dashboard";
	if (host?.kind === "session") return host.title;
	if (host?.kind === "terminal") return `Terminal: ${path.win32.basename(host.folder) || host.folder}`;
	if (row.title !== null && row.title !== "") return row.title;
	return row.kind === "session" ? "Session process" : "Terminal process";
}

function processDescription(row: BrokerProcessRow, state: ProcessState): string {
	const parts = [stateWord(row, state), row.kind === "stats" ? "Stats dashboard" : row.kind, `up ${row.uptimeMs === null ? "unknown" : fmtDuration(row.uptimeMs)}`];
	if (row.olderBuild) parts.push("older build");
	if (row.source === "predecessor") parts.push("previous build");
	return parts.join(" · ");
}

function processIcon(row: BrokerProcessRow, state: ProcessState): vscode.ThemeIcon {
	if (state === "orphaned") return new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
	if (state === "idle") return new vscode.ThemeIcon("circle-slash");
	if (row.source === "predecessor") return new vscode.ThemeIcon("history");
	if (state === "inuse") return new vscode.ThemeIcon(row.kind === "stats" ? "graph" : row.kind === "session" ? "comment-discussion" : "terminal");
	return new vscode.ThemeIcon("question");
}

function processTooltip(row: BrokerProcessRow, state: ProcessState, label: string): string {
	const now = Date.now();
	const started = new Date(row.startedAt);
	const startedText = Number.isNaN(started.getTime()) ? "unknown" : `${started.toLocaleString()} (${relativeAge(row.startedAt, now)})`;
	const lines = [
		`Kind: ${row.kind === "stats" ? "Stats dashboard" : row.kind === "session" ? "Session" : "Terminal"}`,
		`Hosts: ${row.host === null ? "No session or terminal" : label.replace(/\r\n|\r|\n/g, " ")}`,
		`Started: ${startedText}`,
		`Uptime: ${row.uptimeMs === null ? "unknown" : fmtDuration(row.uptimeMs)}`,
		`${stateWord(row, state)}. ${row.kind === "stats" ? (row.child === "exited" ? "The dashboard has exited." : row.child === "unknown" ? "Refresh to check whether the dashboard still runs." : "The dashboard keeps running when its editor closes.") : row.child === "unknown" && state === "inuse" ? "Its session or terminal status has not been checked." : STATE_EXPLANATION[state]}`,
	];
	if (!row.stop.available) lines.push("Cannot stop here. Copy Diagnostics for details.");
	return lines.join("\n");
}

/** One background broker process. */
export class ProcessTreeItem extends vscode.TreeItem {
	readonly row: BrokerProcessRow;
	get diagnostics(): string {
		return JSON.stringify(this.row, null, 2);
	}

	constructor(row: BrokerProcessRow) {
		const label = processLabel(row);
		super(label, vscode.TreeItemCollapsibleState.None);
		this.row = row;
		this.id = row.id;
		const state = processState(row);
		this.description = processDescription(row, state);
		this.iconPath = processIcon(row, state);
		this.tooltip = processTooltip(row, state, label);
		this.contextValue = ["ompProcess", row.stop.available ? "stoppable" : "fixed", row.kind, state].join(".");
	}
}

export class ProcessTreeProvider implements vscode.TreeDataProvider<ProcessTreeItem>, vscode.Disposable {
	readonly #changes = new vscode.EventEmitter<ProcessTreeItem | undefined | void>();
	readonly onDidChangeTreeData = this.#changes.event;
	#snapshot: BrokerProcessSnapshot | null = null;

	/** Replace the rows. `null` means no reading has finished yet. */
	setSnapshot(snapshot: BrokerProcessSnapshot | null): void {
		this.#snapshot = snapshot;
		this.#changes.fire();
	}

	getTreeItem(item: ProcessTreeItem): ProcessTreeItem {
		return item;
	}

	getChildren(element?: ProcessTreeItem): ProcessTreeItem[] {
		if (element !== undefined || this.#snapshot === null) return [];
		return this.#snapshot.rows.map(row => new ProcessTreeItem(row));
	}

	getParent(): undefined {
		return undefined;
	}

	dispose(): void {
		this.#changes.dispose();
	}
}
