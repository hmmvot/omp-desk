import * as vscode from "vscode";
import { chainKeyEntries, modelPickEntries, thinkingPickEntries } from "./settings-pick-items.ts";
import type { ModelPickInput, PickEntry, PickSnapshot } from "./settings-pick-items.ts";

interface Item extends vscode.QuickPickItem { readonly value?: string; readonly available?: boolean; readonly current?: boolean }
interface ChooseOptions {
  readonly title: string;
  readonly placeholder: string;
  readonly signal?: AbortSignal;
  /** Adds a title-bar toggle that rebuilds the rows with unavailable models shown or hidden. */
  readonly toggleUnavailable?: boolean;
  /** A reason the accepted row cannot be used; the picker stays open and shows it. */
  readonly refuse?: (entry: { value: string; available: boolean }) => string | undefined;
}

/**
 * One searchable settings QuickPick. `createQuickPick` rather than `showQuickPick`: it can match
 * descriptions and details, carry the unavailable-models toggle, refuse a row without closing and
 * close when its editor goes away. Resolves with the chosen value, or undefined when dismissed.
 */
export function chooseSetting(build: (showUnavailable: boolean) => readonly PickEntry[], options: ChooseOptions): Promise<string | undefined> {
  const picker = vscode.window.createQuickPick<Item>();
  picker.title = options.title;
  picker.placeholder = options.placeholder;
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  let showUnavailable = false;
  const render = (): void => {
    const items: Item[] = build(showUnavailable).map(entry => "separator" in entry
      ? { label: entry.separator, kind: vscode.QuickPickItemKind.Separator }
      : { label: entry.label, description: entry.description, detail: entry.detail, value: entry.value, available: entry.available, current: entry.current });
    picker.items = items;
    const current = items.find(item => item.current);
    if (current) picker.activeItems = [current];
    if (options.toggleUnavailable) picker.buttons = [{ iconPath: new vscode.ThemeIcon(showUnavailable ? "eye-closed" : "eye"), tooltip: showUnavailable ? "Hide unavailable models" : "Show unavailable models" }];
  };
  render();
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  let done = false;
  const finish = (value?: string): void => {
    if (done) return;
    done = true;
    for (const subscription of subscriptions) subscription.dispose();
    options.signal?.removeEventListener("abort", abort);
    picker.dispose();
    resolve(value);
  };
  const abort = (): void => finish();
  const subscriptions = [
    picker.onDidTriggerButton(() => { showUnavailable = !showUnavailable; render(); }),
    picker.onDidAccept(() => {
      const item = picker.selectedItems[0];
      if (item?.value === undefined) return;
      const refusal = options.refuse?.({ value: item.value, available: item.available !== false });
      if (refusal === undefined) { finish(item.value); return; }
      picker.title = `${options.title} — ${refusal}`;
    }),
    picker.onDidHide(() => finish()),
  ];
  if (options.signal?.aborted) { finish(); return promise; }
  options.signal?.addEventListener("abort", abort, { once: true });
  picker.show();
  return promise;
}

export function pickSettingsModel(input: Omit<ModelPickInput, "showUnavailable">, title: string, signal?: AbortSignal): Promise<string | undefined> {
  return chooseSetting(showUnavailable => modelPickEntries({ ...input, showUnavailable }), {
    title, signal, toggleUnavailable: true,
    placeholder: input.purpose === "role" ? "Search models by id, name or role" : input.purpose === "fallback-entry" ? "Search models or providers" : "Search models, or type @ for roles",
    // OMP assigns roles only from available models; fallback and agent patterns may name a provider to log in to later.
    refuse: entry => input.purpose === "role" && !entry.available ? "log in to its provider before assigning it" : undefined,
  });
}

export function pickSettingsThinking(efforts: readonly string[], current: string, title: string, signal?: AbortSignal): Promise<string | undefined> {
  return chooseSetting(() => thinkingPickEntries(efforts, current), { title, signal, placeholder: "Thinking level" });
}

export function pickFallbackChainKey(snapshot: PickSnapshot, configured: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  return chooseSetting(() => chainKeyEntries(snapshot, configured), { title: "New fallback chain: which requests does it cover?", placeholder: "Search roles, providers or models", signal });
}
