import * as vscode from "vscode";
import { buildUsageStatus } from "../host/usage-status.ts";
import type { UsageSeverity, UsageStatusModel, UsageStatusSource } from "../host/usage-status.ts";

/** Click target of the item; also in the Command Palette. */
export const USAGE_STATUS_REFRESH_COMMAND = "ompDesk.refreshUsageStatus";
const ITEM_ID = "omp.usageStatus";
const TICK_MS = 60_000;
/** Left side, after the items other extensions and VS Code itself put there. */
const PRIORITY = -100;

/** What the extension supplies: the active Chat tab's reading, and a forced refresh of its provider usage. */
export interface UsageStatusDeps {
	source(): UsageStatusSource | null;
	refresh(): void;
}
/** The call `extension.ts` makes when a reading or the active tab may have changed. */
export interface UsageStatusHandle extends vscode.Disposable {
	update(): void;
}

const BACKGROUND: Record<UsageSeverity, string | undefined> = {
	none: undefined,
	warning: "statusBarItem.warningBackground",
	error: "statusBarItem.errorBackground",
};

/**
 * The provider-usage status bar item (`src/host/usage-status.ts` decides everything it shows). A one-minute
 * timer runs only while the item is visible, so the countdown moves and a passed reset is noticed.
 */
export function registerUsageStatus(context: vscode.ExtensionContext, deps: UsageStatusDeps): UsageStatusHandle {
	const item = vscode.window.createStatusBarItem(ITEM_ID, vscode.StatusBarAlignment.Left, PRIORITY);
	item.name = "OMP Desk Provider Usage";
	item.command = USAGE_STATUS_REFRESH_COMMAND;
	let timer: NodeJS.Timeout | undefined;
	let shown: UsageStatusModel | null = null;
	const stopTimer = (): void => {
		clearInterval(timer);
		timer = undefined;
	};
	const update = (): void => {
		const model = buildUsageStatus(deps.source(), Date.now());
		if (model === null) {
			stopTimer();
			shown = null;
			item.hide();
			return;
		}
		if (shown?.text !== model.text) item.text = `$(pulse) ${model.text}`;
		if (shown?.tooltip !== model.tooltip) item.tooltip = model.tooltip;
		if (shown?.severity !== model.severity) {
			const background = BACKGROUND[model.severity];
			item.backgroundColor = background === undefined ? undefined : new vscode.ThemeColor(background);
		}
		if (shown === null) item.show();
		shown = model;
		timer ??= setInterval(update, TICK_MS);
	};
	const subscriptions = [item, vscode.commands.registerCommand(USAGE_STATUS_REFRESH_COMMAND, () => deps.refresh())];
	context.subscriptions.push(...subscriptions, { dispose: stopTimer });
	update();
	return { update, dispose: () => { stopTimer(); for (const subscription of subscriptions) subscription.dispose(); } };
}
