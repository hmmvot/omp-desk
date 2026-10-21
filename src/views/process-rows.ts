/**
 * OMP Desk — the background-process rows of the Sessions view.
 *
 * A `ProcessTreeItem` is one live broker of this profile: a session's process, a folder terminal, the
 * Stats dashboard or an orphan. The Terminals group holds the rows that no session row stands for in
 * the flat and folders layouts; the `terminals` layout serves every row at the root. The rows derive
 * nothing about a process: what it hosts, whether it is orphaned or idle and whether it can be stopped
 * all come from the row of `src/host/broker-processes.ts` (words and labels from `session-processes.ts`).
 *
 * `contextValue` is `ompProcess.<stoppable|fixed>.<session|terminal|stats>.<orphaned|idle|inuse|unknown>`;
 * the menu conditions in `package.json` match on its segments, so the order is part of the contract.
 */
import * as vscode from "vscode";
import type { BrokerProcessRow } from "../host/broker-processes";
import { fmtDuration } from "../shared/format";
import { relativeAge } from "../shared/relative-age";
import {
	PROCESS_STATE_EXPLANATION,
	processDescription,
	processFolder,
	processKindWord,
	processLabel,
	processState,
	processStateWord,
} from "./session-processes";
import type { ProcessOpenTarget, ProcessState } from "./session-processes";

function processIcon(row: BrokerProcessRow, state: ProcessState): vscode.ThemeIcon {
	if (state === "unmanaged") return new vscode.ThemeIcon("debug-disconnect", new vscode.ThemeColor("list.warningForeground"));
	if (state === "orphaned") return new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
	if (state === "idle") return new vscode.ThemeIcon("circle-slash");
	if (row.source === "predecessor") return new vscode.ThemeIcon("history");
	if (state === "inuse") return new vscode.ThemeIcon(row.kind === "stats" ? "graph" : row.kind === "session" ? "comment-discussion" : "terminal");
	return new vscode.ThemeIcon("question");
}

function processTooltip(row: BrokerProcessRow, state: ProcessState, label: string, now: number): string {
	const started = new Date(row.startedAt);
	const startedText = Number.isNaN(started.getTime()) ? "unknown" : `${started.toLocaleString()} (${relativeAge(row.startedAt, now)})`;
	const folder = processFolder(row);
	const lines = [
		`Kind: ${row.kind === "stats" ? "Stats dashboard" : row.kind === "session" ? "Session" : "Terminal"}`,
		`Hosts: ${row.host === null ? "No session or terminal" : label.replace(/\r\n|\r|\n/g, " ")}`,
		...(folder === null ? [] : [`Folder: ${folder}`]),
		`Started: ${startedText}`,
		`Uptime: ${row.uptimeMs === null ? "unknown" : fmtDuration(row.uptimeMs)}`,
		`${processStateWord(row, state)}. ${row.kind === "stats" ? (row.child === "exited" ? "The dashboard has exited." : row.child === "unknown" ? "Refresh to check whether the dashboard still runs." : "The dashboard keeps running when its editor closes.") : row.child === "unknown" && state === "inuse" ? "Its session or terminal status has not been checked." : PROCESS_STATE_EXPLANATION[state]}`,
		...(row.unmanaged === undefined ? [] : [`Slot: ${row.unmanaged.slot}`, ...(row.unmanaged.sessionFile === null ? [] : [`Session file: ${row.unmanaged.sessionFile}`]), `Process id: ${row.brokerPid}`]),
	];
	if (!row.stop.available) lines.push(row.source === "unmanaged" ? "Cannot be stopped from here; use Kill." : "Cannot stop here. Copy Diagnostics for details.");
	return lines.join("\n");
}

/**
 * One background broker process. The row's own click (`ompDesk.openProcess`) opens what it stands for;
 * a row that stands for nothing a click can open has no command, and selecting it does nothing.
 */
export class ProcessTreeItem extends vscode.TreeItem {
	row!: BrokerProcessRow;
	/** What a click opens, or `null` when it opens nothing. */
	openTarget!: ProcessOpenTarget | null;
	get diagnostics(): string {
		return JSON.stringify(this.row, null, 2);
	}

	constructor(row: BrokerProcessRow, folderLabel: string | null, openTarget: ProcessOpenTarget | null, now: number) {
		super("", vscode.TreeItemCollapsibleState.None);
		this.id = row.id;
		this.update(row, folderLabel, openTarget, now);
	}

	/** Repaint in place: the tree keeps the instance it knows, as for a session row. */
	update(row: BrokerProcessRow, folderLabel: string | null, openTarget: ProcessOpenTarget | null, now: number): void {
		const label = processLabel(row, folderLabel);
		this.row = row;
		this.openTarget = openTarget;
		this.label = label;
		const state = processState(row);
		this.description = processDescription(row, state);
		this.iconPath = processIcon(row, state);
		this.tooltip = processTooltip(row, state, label, now);
		this.contextValue = ["ompProcess", row.stop.available ? "stoppable" : "fixed", row.kind, state].join(".");
		this.accessibilityInformation = {
			label: `${label}, ${processKindWord(row)} process, ${processStateWord(row, state)}${row.stop.available ? "" : ", cannot be stopped here"}`,
		};
		// No argument, as for a session row: VS Code disposes the delegate of a command with arguments the moment the row is
		// repainted, and this row is repainted whenever its uptime words change. The click reads the view's selection.
		this.command = openTarget === null ? undefined : { command: "ompDesk.openProcess", title: "Open" };
	}
}

/**
 * The flat and folders layouts' group of processes that no session row stands for: terminals, orphans,
 * idle session processes, the Stats dashboard. The `terminals` layout does not use it.
 */
export class TerminalsGroupTreeItem extends vscode.TreeItem {
	static readonly ID = "omp.terminalsGroup";
	rows: readonly ProcessTreeItem[];

	constructor(rows: readonly ProcessTreeItem[]) {
		super("Terminals", vscode.TreeItemCollapsibleState.Collapsed);
		this.id = TerminalsGroupTreeItem.ID;
		this.iconPath = new vscode.ThemeIcon("terminal", new vscode.ThemeColor("descriptionForeground"));
		this.contextValue = "ompTerminalsGroup";
		this.rows = rows;
		this.update(rows);
	}

	update(rows: readonly ProcessTreeItem[]): void {
		this.rows = rows;
		this.description = String(rows.length);
		this.tooltip = "Terminals and other background processes that no session above stands for.";
		this.accessibilityInformation = { label: `Terminals, ${rows.length} background ${rows.length === 1 ? "process" : "processes"}` };
	}
}
