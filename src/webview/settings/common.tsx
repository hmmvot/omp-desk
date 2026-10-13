import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { ResolvedModel, ResolvedThinking, SettingsScope, SettingsSnapshot, TraceStep } from "../../protocol/settings-model";
import type { SettingsAction, SettingsMessage } from "../../protocol/settings-messages";
import { entryStatus, LEVEL_BARS, moveEntry, sameList, thinkingWhy, withoutEntry } from "./model";
import type { Pill } from "./model";

export type ActionRequest<T = SettingsAction> = T extends SettingsAction ? Omit<T, "requestId"> : never;
/** `origin` names the card whose controls sent the action; its result is shown beside them. Returns the request id, or undefined while another operation runs. */
export type Send = (action: ActionRequest, origin?: string) => string | undefined;
/** Opens a host QuickPick and resolves with the chosen value, or null when dismissed or refused. */
export type Pick = (action: ActionRequest<Extract<SettingsAction, { action: "pick-model" | "pick-chain-key" }>>, origin?: string) => Promise<string | null>;
export type Init = Extract<SettingsMessage, { type: "settings:init" }>;
export type Preview = Extract<SettingsMessage, { type: "settings:preview" }>["spec"];
export type ConfigExists = Extract<SettingsMessage, { type: "settings:snapshot" }>["configExists"];
export interface Status { readonly ok: boolean; readonly pending: boolean; readonly message: string; readonly origin?: string }
export interface SurfaceProps { snapshot: SettingsSnapshot; send: Send; pick: Pick; revision: number; folder: string | null }
export const StatusContext = createContext<Status>({ ok: true, pending: false, message: "" });
export const NAME_PATTERN = /^[a-zA-Z][\w-]*$/;
export const NAME_HINT = "Use a letter, then letters, digits, - or _.";

/**
 * Unsaved per-item drafts, kept while the user moves between roles or agents and dropped by the next
 * snapshot: after any save or reload, editors start again from the values OMP read back.
 */
export function useDrafts<T>(revision: number) {
  const [state, setState] = useState<{ revision: number; drafts: Readonly<Record<string, T>> }>({ revision, drafts: {} });
  const drafts = state.revision === revision ? state.drafts : {};
  const setDraft = (key: string, draft: T | undefined): void => setState(previous => {
    const next = { ...(previous.revision === revision ? previous.drafts : {}) };
    if (draft === undefined) delete next[key]; else next[key] = draft;
    return { revision, drafts: next };
  });
  return [drafts, setDraft] as const;
}

export function InlineStatus({ origin }: { origin: string }) {
  const status = useContext(StatusContext);
  const shown = status.origin === origin && status.message;
  return <div id={`status-${origin}`} tabIndex={-1} role="status" className={`inline-status small ${status.ok ? "" : "error"}`}>
    {shown && <><span aria-hidden="true" className={`codicon codicon-${status.pending ? "loading codicon-modifier-spin" : status.ok ? "check" : "error"}`} />{status.message}</>}
  </div>;
}
export function Icon({ name }: { name: string }) { return <span aria-hidden="true" className={`codicon codicon-${name}`} />; }
export function Badge({ children, tone }: { children: ReactNode; tone?: "accent" | "warning" }) { return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>; }
export function Unsaved() { return <span className="unsaved" title="Unsaved changes" aria-label="Unsaved changes">●</span>; }
export function IconButton({ icon, label, disabled, onClick, title }: { icon: string; label: string; disabled?: boolean; onClick(): void; title?: string }) {
  return <button type="button" className="icon secondary" aria-label={label} title={title ?? label} disabled={disabled} onClick={onClick}><Icon name={icon} /></button>;
}
/** A long ordered chain: the first entries, then a count; the whole chain is in the tooltip. */
export function Chain({ items, empty }: { items: readonly string[]; empty: string }) {
  if (!items.length) return <code>{empty}</code>;
  return <code title={items.join(" → ")}>{items.slice(0, 3).join(" → ")}{items.length > 3 ? ` +${items.length - 3} more` : ""}</code>;
}

export function Tabs({ items, selected, onSelect }: { items: readonly (readonly [string, string])[]; selected: string; onSelect(id: string): void }) {
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const keyDown = (event: KeyboardEvent, index: number): void => {
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const id = items[(next + items.length) % items.length]![0];
    onSelect(id);
    tabs.current.get(id)?.focus();
  };
  return <div className="tabs" role="tablist" aria-label="Settings sections">{items.map(([id, label], index) =>
    <button key={id} type="button" role="tab" id={`tab-${id}`} aria-controls={`panel-${id}`} aria-selected={selected === id} tabIndex={selected === id ? 0 : -1}
      ref={element => { if (element) tabs.current.set(id, element); else tabs.current.delete(id); }} onClick={() => onSelect(id)} onKeyDown={event => keyDown(event, index)}>{label}</button>)}</div>;
}
export function Panel({ id, section, children }: { id: string; section: string; children: ReactNode }) {
  return <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} hidden={section !== id}>{children}</div>;
}

export interface ListOption { readonly id: string; readonly group?: string; readonly title?: string; readonly dim?: boolean; readonly content: ReactNode }
/** A single-tab-stop listbox: arrows, Page Up/Down, Home and End move the selection, as VS Code lists do; Enter or a double-click activates the selected option. */
export function ListBox({ label, options, selected, onSelect, onActivate }: { label: string; options: readonly ListOption[]; selected?: string; onSelect(id: string): void; onActivate?(id: string): void }) {
  const prefix = useId();
  const box = useRef<HTMLDivElement>(null);
  const index = options.findIndex(option => option.id === selected);
  const optionId = (id: string): string => `${prefix}-${encodeURIComponent(id)}`;
  const grouped = options.some(option => option.group !== undefined);
  // Scroll only the list itself: page scrolling belongs to the user.
  useEffect(() => {
    const list = box.current; const option = selected === undefined ? null : document.getElementById(optionId(selected));
    if (!list || !option) return;
    const header = grouped ? 24 : 0;
    if (option.offsetTop - header < list.scrollTop) list.scrollTop = option.offsetTop - header;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
  }, [selected]);
  const keyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && onActivate && selected !== undefined) { event.preventDefault(); onActivate(selected); return; }
    const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10, Home: -options.length, End: options.length };
    const step = steps[event.key];
    if (step === undefined || !options.length) return;
    event.preventDefault();
    onSelect(options[Math.max(0, Math.min(options.length - 1, (index < 0 ? 0 : index) + step))]!.id);
  };
  const groups: [string | undefined, ListOption[]][] = [];
  for (const option of options) {
    const last = groups.at(-1);
    if (last && last[0] === option.group) last[1].push(option); else groups.push([option.group, [option]]);
  }
  const render = (option: ListOption) => <div key={option.id} id={optionId(option.id)} role="option" aria-selected={option.id === selected} title={option.title}
    className={`option${option.id === selected ? " selected" : ""}${option.dim ? " dim" : ""}`} onClick={() => onSelect(option.id)} onDoubleClick={onActivate && (() => onActivate(option.id))}>{option.content}</div>;
  return <div ref={box} className="listbox" role="listbox" aria-label={label} tabIndex={0} aria-activedescendant={index >= 0 ? optionId(selected!) : undefined} onKeyDown={keyDown}>
    {groups.map(([group, items], position) => group === undefined ? items.map(render)
      : <div key={`${group}:${position}`} role="group" aria-labelledby={`${prefix}-group-${position}`}><div className="group-label" id={`${prefix}-group-${position}`}>{group}</div>{items.map(render)}</div>)}
  </div>;
}
/**
 * An ordered list edited without typing: Move up/down buttons or Alt+Up/Down on a focused row reorder it,
 * Remove or Delete drops an entry. Focus stays on the moved row or the pressed control.
 */
export function OrderedList({ label, entries, onChange, describe, empty }: { label: string; entries: readonly string[]; onChange(next: string[]): void; describe(entry: string): ReactNode; empty: string }) {
  const controls = useRef(new Map<string, HTMLElement>());
  const [focusKey, setFocusKey] = useState<string>();
  useEffect(() => { if (focusKey) { controls.current.get(focusKey)?.focus(); setFocusKey(undefined); } }, [focusKey]);
  const ref = (key: string) => (element: HTMLElement | null): void => { if (element) controls.current.set(key, element); else controls.current.delete(key); };
  const move = (index: number, step: number, control: "row" | "up" | "down"): void => {
    const next = moveEntry(entries, index, step);
    if (sameList(next, entries)) return;
    onChange(next);
    const entry = entries[index]!; const other = index + step;
    // At either end the pressed arrow disables itself; keep focus on the row through its other arrow.
    setFocusKey(control === "row" ? `${entry}:row` : other === 0 || other === next.length - 1 ? `${entry}:${step < 0 ? "down" : "up"}` : `${entry}:${control}`);
  };
  const remove = (index: number): void => {
    const next = withoutEntry(entries, index);
    onChange(next);
    setFocusKey(next.length ? `${next[Math.min(index, next.length - 1)]}:remove` : undefined);
  };
  const keyDown = (event: KeyboardEvent, index: number): void => {
    if (event.target !== event.currentTarget) return;
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) { event.preventDefault(); move(index, event.key === "ArrowUp" ? -1 : 1, "row"); }
    else if (event.key === "Delete") { event.preventDefault(); remove(index); }
  };
  if (!entries.length) return <p className="small muted">{empty}</p>;
  return <ol className="ordered" aria-label={label}>{entries.map((entry, index) =>
    <li key={entry} tabIndex={0} ref={ref(`${entry}:row`)} aria-label={`${index + 1}. ${entry}`} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Delete" onKeyDown={event => keyDown(event, index)}>
      <span className="ordinal">{index + 1}</span><code className="ellipsis" title={entry}>{entry}</code><span className="small muted ellipsis grow">{describe(entry)}</span>
      <button type="button" ref={ref(`${entry}:up`)} className="icon secondary" aria-label={`Move ${entry} up`} title="Move up (Alt+Up)" disabled={index === 0} onClick={() => move(index, -1, "up")}><Icon name="arrow-up" /></button>
      <button type="button" ref={ref(`${entry}:down`)} className="icon secondary" aria-label={`Move ${entry} down`} title="Move down (Alt+Down)" disabled={index === entries.length - 1} onClick={() => move(index, 1, "down")}><Icon name="arrow-down" /></button>
      <button type="button" ref={ref(`${entry}:remove`)} className="icon secondary" aria-label={`Remove ${entry}`} title="Remove (Delete)" onClick={() => remove(index)}><Icon name="close" /></button>
    </li>)}</ol>;
}
export function EntryStatusText({ entry, snapshot }: { entry: string; snapshot: SettingsSnapshot }) {
  const status = entryStatus(entry, snapshot);
  return <span className={status.ok ? "" : "warning-text"}>{status.ok ? "" : <Icon name="warning" />}{status.text}</span>;
}

/** `claude-opus` with a status dot, or a warning when the model cannot run: the icon and the words carry the state, not only the colour. */
export function ModelChip({ model, full }: { model: ResolvedModel; full?: boolean }) {
  const key = model.model ?? model.wanted;
  if (!key) return <span className="mchip none" title="No model is assigned">unassigned</span>;
  const [provider, ...rest] = key.split("/");
  const name = full || rest.length === 0 ? key : rest.join("/");
  if (model.status === "ok") return <span className="mchip" title={key}><i className="dot" aria-hidden="true" /><span className="mname">{full ? <><span className="prov">{provider}/</span>{rest.join("/")}</> : name}</span></span>;
  const why = model.status === "login" ? `${provider} is not signed in` : model.status === "missing" ? "OMP does not know this model" : "OMP does not list this model as available";
  return <span className="mchip bad" title={`${key}: ${why}`}><Icon name="warning" /><span className="mname">{name}</span><span className="small">{model.status === "login" ? "needs login" : model.status === "missing" ? "not found" : "unavailable"}</span></span>;
}
/** Five bars and the level's word; `auto` is OMP's per-turn choice and a missing level is a dash. */
export function Meter({ thinking, bare }: { thinking: ResolvedThinking; bare?: boolean }) {
  const { level } = thinking;
  const title = `Thinking ${level ?? "none"}: ${thinkingWhy(thinking)}`;
  if (!level) return <span className="meter none" role="img" aria-label="No thinking level" title={title}>—</span>;
  if (level === "auto") return <span className="meter auto" title={title}><Icon name="sparkle" />auto</span>;
  const bars = LEVEL_BARS[level] ?? 0;
  return <span className="meter" title={title} role="img" aria-label={`Thinking ${level}`}><span className="bars" aria-hidden="true">{[1, 2, 3, 4, 5].map(index => <i key={index} className={index <= bars ? "on" : ""} />)}</span>{!bare && <span aria-hidden="true">{level}</span>}</span>;
}
export function SourcePill({ pill }: { pill: Pill }) { return <span className={`src s-${pill.kind}`} title={pill.title}>{pill.text}</span>; }
const STATE_WORDS = { used: "used", shadowed: "overridden", unset: "not set" } as const;
/** How a value was decided: the layers OMP consulted, the winner marked and the shadowed ones struck. */
export function Trace({ steps, label }: { steps: readonly TraceStep[]; label: string }) {
  return <ol className="trace" aria-label={label}>{steps.map((step, index) => <li key={index} className={step.state}>
    <span className="bullet" aria-hidden="true">{step.state === "used" ? <Icon name="check" /> : step.state === "shadowed" ? "×" : index + 1}</span>
    <span className="lay">{step.title}<span className="sr-only"> — {STATE_WORDS[step.state]}</span></span>
    <span>{step.value && <code className="val">{step.value}</code>}{step.note && <div className="why">{step.note}</div>}</span>
  </li>)}</ol>;
}
