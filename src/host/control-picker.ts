import * as vscode from "vscode";
import type { ControlModelRef } from "./control-protocol.ts";
import type { ChatDisplayPreferences } from "../webview/chat-messages.ts";

type ToolCallDetail = ChatDisplayPreferences["toolCallDetail"];

interface Choice<T> extends vscode.QuickPickItem { value?: T; current?: boolean }
let active: { tabId?: string; finish(): void } | null = null;
export function cancelControlPicker(tabId?: string): void {
	if (tabId === undefined || active?.tabId === tabId) active?.finish();
}

/** Uses `createQuickPick` rather than `showQuickPick` so the picker can be cancelled from outside and match on descriptions and details. */
function choose<T>(title: string, items: readonly Choice<T>[], stillCurrent: () => boolean, tabId?: string): Promise<T | undefined> {
	cancelControlPicker();
	const picker = vscode.window.createQuickPick<Choice<T>>();
	picker.title = title;
	picker.placeholder = "Type to search";
	picker.matchOnDescription = true;
	picker.matchOnDetail = true;
	picker.items = items;
	picker.activeItems = items.filter(item => item.current);
	const { promise, resolve } = Promise.withResolvers<T | undefined>();
	let completed = false;
	const finish = (value?: T): void => {
		if (completed) return;
		completed = true;
		resolve(stillCurrent() ? value : undefined);
		accept.dispose(); hide.dispose(); picker.dispose();
		if (active?.finish === finish) active = null;
	};
	const accept = picker.onDidAccept(() => finish(picker.selectedItems[0]?.value));
	const hide = picker.onDidHide(() => finish());
	active = { tabId, finish };
	picker.show();
	return promise;
}

const modelOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function pickControlModel(models: readonly ControlModelRef[], current: ControlModelRef | null, stillCurrent: () => boolean, tabId?: string): Promise<ControlModelRef | undefined> {
	const names = new Map<string, number>();
	for (const model of models) { const name = model.name ?? model.id; names.set(name, (names.get(name) ?? 0) + 1); }
	const items: Choice<ControlModelRef>[] = [];
	let provider: string | undefined;
	for (const model of [...models].sort((a, b) => modelOrder.compare(a.provider, b.provider) || modelOrder.compare(a.id, b.id))) {
		if (provider !== model.provider) {
			provider = model.provider;
			items.push({ label: provider, kind: vscode.QuickPickItemKind.Separator });
		}
		const selected = model.provider === current?.provider && model.id === current?.id;
		items.push({ label: `${selected ? "$(check) " : ""}${model.name ?? model.id}`,
			description: selected ? "current" : (names.get(model.name ?? model.id) ?? 0) > 1 ? model.id : undefined,
			value: model, current: selected });
	}
	return choose("Model", items, stillCurrent, tabId);
}

const THINKING_DESCRIPTION: Readonly<Record<string, string>> = {
	off: "No reasoning", minimal: "Fastest reasoning", low: "Light reasoning",
	medium: "Balanced reasoning", high: "Thorough reasoning", xhigh: "Extra thorough reasoning", max: "Maximum reasoning",
};

export function pickControlThinking(levels: readonly string[], current: string | null, stillCurrent: () => boolean, tabId?: string): Promise<string | undefined> {
	return choose("Thinking level", levels.map(level => ({
		label: `${level === current ? "$(check) " : ""}${level}`,
		description: THINKING_DESCRIPTION[level],
		value: level, current: level === current,
	})), stillCurrent, tabId);
}

/** The Tools output choices; the descriptions say what each does to the transcript, the check marks the one in force. */
const TOOL_DETAIL_CHOICES: readonly { value: ToolCallDetail; label: string; description: string }[] = [
	{ value: "overview", label: "Overview", description: "Group routine tool calls into one-line summaries" },
	{ value: "detailed", label: "Detailed", description: "Show every tool call as its own row" },
];

export function pickToolCallDetail(current: ToolCallDetail, stillCurrent: () => boolean, tabId?: string): Promise<ToolCallDetail | undefined> {
	return choose("Tools output", TOOL_DETAIL_CHOICES.map(choice => ({ label: choice.label, description: choice.description,
		detail: choice.value === current ? "$(check) Current tools output" : undefined, value: choice.value, current: choice.value === current })), stillCurrent, tabId);
}
