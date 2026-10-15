/**
 * The VS Code side of the pending-operation display (`src/host/pending-display.ts`): the Sessions tree's rows, the Sessions view's
 * progress bar and the status bar's window progress. Presentation only; nothing here decides what an action does.
 */
import * as vscode from "vscode";
import type { PendingDisplayShell, PendingProgress } from "../host/pending-display.ts";
import type { SessionTreeProvider } from "../views/session-tree.ts";

export interface PendingShellDeps {
	/** The Sessions tree provider this window created, when it has one. */
	provider(): Pick<SessionTreeProvider, "setPending"> | undefined;
	/** The Sessions view's id, for its own progress bar. */
	readonly sessionsViewId: string;
}

export function pendingDisplayShell(deps: PendingShellDeps): PendingDisplayShell {
	return {
		setRows: rows => deps.provider()?.setPending(rows),
		beginProgress(location, text): PendingProgress {
			const finished = Promise.withResolvers<void>();
			let report: ((message: string) => void) | null = null;
			let latest = text;
			const options: vscode.ProgressOptions = location === "view"
				? { location: { viewId: deps.sessionsViewId } }
				: { location: vscode.ProgressLocation.Window, title: "OMP Desk" };
			void vscode.window.withProgress(options, progress => {
				report = message => progress.report({ message });
				if (latest !== "") report(latest);
				return finished.promise;
			});
			return {
				update: next => {
					latest = next;
					if (location === "window") report?.(next);
				},
				end: () => finished.resolve(),
			};
		},
	};
}
