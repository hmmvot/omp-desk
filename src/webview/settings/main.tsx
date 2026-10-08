import { createContext, Fragment, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { isRecord } from "../../guards";
import type { ConfigEdit, SettingsAgent, SettingsRole, SettingsScope, SettingsSnapshot } from "../../host/omp-settings-core";
import type { SettingsAction, SettingsMessage } from "./messages";
import { appendLine, at, compactCount, count, disabledAgentsAfterToggle, displayValue, filteredModels, lines, perfLabel, priceLabel, providerStatus, roleChange, sameList, selectorBase, sourceLabel, text } from "./model";
import { SETTINGS_CSS } from "./styles";

declare function acquireVsCodeApi(): { postMessage(message: SettingsAction): void; setState(state: { key: string }): void };
const vscode = acquireVsCodeApi();
type ActionRequest<T = SettingsAction> = T extends SettingsAction ? Omit<T, "requestId"> : never;
/** `origin` names the card whose controls sent the action; its result is shown beside them. */
type Send = (action: ActionRequest, origin?: string) => void;
type Init = Extract<SettingsMessage, { type: "settings:init" }>;
type Preview = Extract<SettingsMessage, { type: "settings:preview" }>["spec"];
type ConfigExists = Extract<SettingsMessage, { type: "settings:snapshot" }>["configExists"];
interface Status { readonly ok: boolean; readonly pending: boolean; readonly message: string; readonly origin?: string }
interface SurfaceProps { snapshot: SettingsSnapshot; send: Send; revision: number }
const StatusContext = createContext<Status>({ ok: true, pending: false, message: "" });
const PAGE = 100;
const NAME_PATTERN = /^[a-zA-Z][\w-]*$/;
const NAME_HINT = "Use a letter, then letters, digits, - or _.";

const focusLabel = (element: Element): string => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
function useHost() {
  const [init, setInit] = useState<Init>();
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [configExists, setConfigExists] = useState<ConfigExists>({ global: false, project: false });
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<Preview>(null);
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState<Status>({ ok: true, pending: true, message: "Reading the installed OMP settings…" });
  const focus = useRef<{ tag: string; label: string; origin?: string } | undefined>(undefined);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      // The paired host owns this named IPC contract; unrelated window messages are ignored.
      if (!isRecord(event.data) || typeof event.data.type !== "string") return;
      const message = event.data as unknown as SettingsMessage;
      switch (message.type) {
        case "settings:init": setInit(message); vscode.setState({ key: message.key }); break;
        case "settings:snapshot": setSnapshot(message.snapshot); setConfigExists(message.configExists); setRevision(value => value + 1); break;
        case "settings:preview": setPreview(message.spec); break;
        case "settings:result": setBusy(false); setStatus(previous => ({ ok: message.ok, pending: false, message: message.message, origin: previous.origin })); break;
      }
    };
    window.addEventListener("message", receive);
    vscode.postMessage({ action: "ready", requestId: crypto.randomUUID() });
    return () => window.removeEventListener("message", receive);
  }, []);
  // A disabled fieldset and redrawn drafts drop focus to the body; return it to the control that acted, else to its result.
  useEffect(() => {
    const target = focus.current;
    if (busy || !target) return;
    focus.current = undefined;
    if (document.activeElement && document.activeElement !== document.body) return;
    const match = [...document.querySelectorAll<HTMLElement>(target.tag)].find(element => focusLabel(element) === target.label && !element.closest("[hidden]") && !element.matches(":disabled"));
    (match ?? (target.origin ? document.getElementById(`status-${target.origin}`) : null))?.focus();
  }, [busy]);
  const send: Send = (action, origin) => {
    if (busy) return;
    const active = document.activeElement;
    focus.current = active && active !== document.body ? { tag: active.tagName, label: focusLabel(active), origin } : undefined;
    setBusy(true);
    setStatus({ ok: true, pending: true, origin, message: action.action === "generate" ? "OMP is generating the agent specification…" : action.action === "refresh" ? "Refreshing the provider catalogue…" : action.action === "reload" ? "Reloading…" : action.action === "save" || action.action === "preset" ? "Saving…" : "Working…" });
    vscode.postMessage({ ...action, requestId: crypto.randomUUID() });
  };
  return { init, snapshot, configExists, revision, preview, busy, status, send };
}
/**
 * Unsaved per-item drafts, kept while the user moves between roles or agents and dropped by the next
 * snapshot: after any save or reload, editors start again from the values OMP read back.
 */
function useDrafts<T>(revision: number) {
  const [state, setState] = useState<{ revision: number; drafts: Readonly<Record<string, T>> }>({ revision, drafts: {} });
  const drafts = state.revision === revision ? state.drafts : {};
  const setDraft = (key: string, draft: T | undefined): void => setState(previous => {
    const next = { ...(previous.revision === revision ? previous.drafts : {}) };
    if (draft === undefined) delete next[key]; else next[key] = draft;
    return { revision, drafts: next };
  });
  return [drafts, setDraft] as const;
}

function InlineStatus({ origin }: { origin: string }) {
  const status = useContext(StatusContext);
  const shown = status.origin === origin && status.message;
  return <div id={`status-${origin}`} tabIndex={-1} role="status" className={`inline-status small ${status.ok ? "" : "error"}`}>
    {shown && <><span aria-hidden="true" className={`codicon codicon-${status.pending ? "loading codicon-modifier-spin" : status.ok ? "check" : "error"}`} />{status.message}</>}
  </div>;
}
function Icon({ name }: { name: string }) { return <span aria-hidden="true" className={`codicon codicon-${name}`} />; }
function Badge({ children, tone }: { children: ReactNode; tone?: "accent" | "warning" }) { return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>; }
function Unsaved() { return <span className="unsaved" title="Unsaved changes" aria-label="Unsaved changes">●</span>; }
function IconButton({ icon, label, disabled, onClick, title }: { icon: string; label: string; disabled?: boolean; onClick(): void; title?: string }) {
  return <button type="button" className="icon secondary" aria-label={label} title={title ?? label} disabled={disabled} onClick={onClick}><Icon name={icon} /></button>;
}
/** A long ordered chain: the first entries, then a count; the whole chain is in the tooltip. */
function Chain({ items, empty }: { items: readonly string[]; empty: string }) {
  if (!items.length) return <code>{empty}</code>;
  return <code title={items.join(" → ")}>{items.slice(0, 3).join(" → ")}{items.length > 3 ? ` +${items.length - 3} more` : ""}</code>;
}

const MODEL_SECTIONS = [["roles", "Roles & routing"], ["browse", "Model browser"], ["presets", "Presets"]] as const;
const AGENT_SECTIONS = [["agents", "Agents"], ["new", "New agent"]] as const;
function Tabs({ items, selected, onSelect }: { items: readonly (readonly [string, string])[]; selected: string; onSelect(id: string): void }) {
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
function Panel({ id, section, children }: { id: string; section: string; children: ReactNode }) {
  return <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} hidden={section !== id}>{children}</div>;
}

interface ListOption { readonly id: string; readonly group?: string; readonly title?: string; readonly dim?: boolean; readonly content: ReactNode }
/** A single-tab-stop listbox: arrows, Page Up/Down, Home and End move the selection, as VS Code lists do. */
function ListBox({ label, options, selected, onSelect }: { label: string; options: readonly ListOption[]; selected?: string; onSelect(id: string): void }) {
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
    className={`option${option.id === selected ? " selected" : ""}${option.dim ? " dim" : ""}`} onClick={() => onSelect(option.id)}>{option.content}</div>;
  return <div ref={box} className="listbox" role="listbox" aria-label={label} tabIndex={0} aria-activedescendant={index >= 0 ? optionId(selected!) : undefined} onKeyDown={keyDown}>
    {groups.map(([group, items], position) => group === undefined ? items.map(render)
      : <div key={`${group}:${position}`} role="group" aria-labelledby={`${prefix}-group-${position}`}><div className="group-label" id={`${prefix}-group-${position}`}>{group}</div>{items.map(render)}</div>)}
  </div>;
}

function App() {
  const host = useHost();
  const kind = host.init?.kind;
  const [section, setSection] = useState("roles");
  useEffect(() => setSection(kind === "agents" ? "agents" : "roles"), [kind]);
  const { snapshot } = host;
  const folder = snapshot?.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? snapshot?.cwd;
  const config = (scope: SettingsScope) => {
    const file = snapshot?.[scope === "global" ? "globalFile" : "projectFile"];
    return <button type="button" className="secondary" disabled={host.busy || !host.configExists[scope]} title={host.configExists[scope] ? file : `No ${scope} config exists yet (${file}); saving creates it.`}
      onClick={() => host.send({ action: "open-config", scope })}><Icon name="go-to-file" />{scope === "global" ? "Global config" : "Project config"}</button>;
  };
  return <StatusContext.Provider value={host.status}><main aria-busy={host.busy}>
    {host.busy && <div className="progress" aria-hidden="true" />}
    <header className="header">
      <div><h1>{kind === "agents" ? "Agents" : kind === "models" ? "Models" : "OMP settings"}</h1>
        {snapshot && <div className="muted small">OMP profile <strong>{snapshot.profile}</strong> · folder <span title={snapshot.cwd}>{folder}</span></div>}</div>
      <div className="toolbar">
        <button type="button" className="secondary" disabled={host.busy} onClick={() => host.send({ action: "reload" })}><Icon name="refresh" />Reload</button>
        {snapshot && <>{config("global")}{config("project")}</>}
      </div>
    </header>
    {snapshot || host.busy || host.status.ok
      ? <div role="status" className={`status small ${host.status.ok ? "muted" : "error"}`}>{host.status.origin === undefined && host.status.message}</div>
      : <div className="empty" role="alert"><Icon name="error" /><p>{host.status.message || "OMP settings could not be read."}</p><button type="button" onClick={() => host.send({ action: "reload" })}>Try again</button></div>}
    {snapshot && kind && <>
      <details className="notice small"><summary>Saving writes OMP's own config files, which plain OMP also reads. Running sessions keep their models.</summary>
        <p>Like OMP, saving removes YAML comments and keeps unknown values. Effective values can differ from saved ones when a higher-priority config sets them. Existing subagents are not changed.</p>
        <dl><dt>Global config</dt><dd><code>{snapshot.globalFile}</code></dd><dt>Project config</dt><dd><code>{snapshot.projectFile}</code></dd>
          {kind === "agents" && <><dt>New user agents</dt><dd><code>{snapshot.agentDirectories.global}</code></dd><dt>New project agents</dt><dd><code>{snapshot.agentDirectories.project}</code></dd></>}</dl>
      </details>
      <Tabs items={kind === "agents" ? AGENT_SECTIONS : MODEL_SECTIONS} selected={section} onSelect={setSection} />
      <fieldset disabled={host.busy}>
        {kind === "models" ? <>
          <Panel id="roles" section={section}><ModelsRoles snapshot={snapshot} send={host.send} revision={host.revision} init={host.init} /></Panel>
          <Panel id="browse" section={section}><ModelBrowser snapshot={snapshot} send={host.send} revision={host.revision} /></Panel>
          <Panel id="presets" section={section}><Presets snapshot={snapshot} send={host.send} revision={host.revision} /></Panel>
        </> : <>
          <Panel id="agents" section={section}><Agents snapshot={snapshot} send={host.send} revision={host.revision} /></Panel>
          <Panel id="new" section={section}><NewAgent send={host.send} preview={host.preview} directories={snapshot.agentDirectories} /></Panel>
        </>}
      </fieldset>
    </>}
  </main></StatusContext.Provider>;
}

function ModelSuggestions({ snapshot, id, accepts }: { snapshot: SettingsSnapshot; id: string; accepts?: readonly string[] }) {
  const accepted = useMemo(() => accepts ? new Set(accepts) : undefined, [accepts]);
  return <datalist id={id}>{snapshot.models.filter(model => model.available && (!accepted || accepted.has(`${model.provider}/${model.id}`))).map(model => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}{snapshot.roles.map(role => <option key={`role:${role.id}`} value={`@${role.id}`} />)}</datalist>;
}
const ROLE_GROUPS: Record<string, string> = { chat: "Chat roles", kind: "Specialized roles" };
interface RoleDraft { readonly selector: string; readonly effort: string }
function ModelsRoles(props: SurfaceProps & { init?: Init }) {
  const { snapshot, revision } = props;
  const [selected, setSelected] = useState("default");
  const [custom, setCustom] = useState("");
  const [draftRole, setDraftRole] = useState<SettingsRole>();
  const [roleError, setRoleError] = useState("");
  const [drafts, setDraft] = useDrafts<RoleDraft>(revision);
  const projectAllowed = snapshot.effective.modelRoleStorage === "project";
  const [chosenScope, setScope] = useState<SettingsScope>(projectAllowed ? "project" : "global");
  const scope = projectAllowed ? chosenScope : "global";
  const roles = draftRole && !snapshot.roles.some(role => role.id === draftRole.id) ? [...snapshot.roles, draftRole] : snapshot.roles;
  const role = roles.find(role => role.id === selected) ?? roles[0];
  const options = roles.map(item => ({ id: item.id, group: ROLE_GROUPS[item.section] ?? "Custom roles", content: <div className="option-row">
    <strong>{item.id}</strong>{Object.keys(drafts).some(key => key.startsWith(`${item.id}:`)) && <Unsaved />}
    <span className={`ellipsis small${item.resolved ? "" : " muted"}`}>{item.resolved ? `${item.resolved}${item.thinking ? ` · ${item.thinking}` : ""}` : item.selector ? "unavailable" : "auto"}</span>
  </div> }));
  const addRole = (): void => {
    const id = custom.trim();
    if (!NAME_PATTERN.test(id)) { setRoleError(NAME_HINT); return; }
    setDraftRole({ id, name: id, section: "custom", source: "default", accepts: snapshot.models.filter(model => model.available && model.kind === "chat").map(model => `${model.provider}/${model.id}`), defaults: [] });
    setSelected(id); setCustom(""); setRoleError("");
  };
  return <>
    <div className="grid">
      <section className="card"><h2>Model roles <span className="muted small">{snapshot.roles.filter(item => item.source !== "default").length} of {snapshot.roles.length} assigned</span></h2>
        <ListBox label="Model roles" options={options} selected={role?.id} onSelect={setSelected} />
        <form className="add-row" onSubmit={event => { event.preventDefault(); addRole(); }}>
          <input aria-label="New custom role name" placeholder="New custom role" value={custom} onChange={event => setCustom(event.target.value)} aria-invalid={Boolean(roleError)} />
          <button className="secondary" type="submit" disabled={!custom.trim()}><Icon name="add" />Add</button>
        </form>
        {roleError && <div className="small error">{roleError}</div>}
      </section>
      {role && <RoleEditor key={`${role.id}:${scope}`} {...props} role={role} scope={scope} projectAllowed={projectAllowed} setScope={setScope}
        draft={drafts[`${role.id}:${scope}`]} onDraft={draft => setDraft(`${role.id}:${scope}`, draft)} />}
    </div>
    <CurrentSession init={props.init} send={props.send} />
    <Cycle key={`cycle:${revision}`} {...props} />
    <Fallback {...props} />
  </>;
}
function RoleEditor({ snapshot, role, scope, projectAllowed, setScope, send, draft, onDraft }: SurfaceProps & { role: SettingsRole; scope: SettingsScope; projectAllowed: boolean; setScope(scope: SettingsScope): void; draft?: RoleDraft; onDraft(draft: RoleDraft | undefined): void }) {
  const persisted = at(snapshot[scope], ["modelRoles", role.id]);
  const persistedText = typeof persisted === "string" ? persisted : "";
  const initial = typeof persisted === "string" ? persisted : role.selector ?? "";
  const { selector, effort } = draft ?? { selector: initial, effort: "" };
  const dirty = selector !== initial || effort !== "";
  const model = snapshot.models.find(model => `${model.provider}/${model.id}` === selectorBase(selector.trim())) ?? snapshot.models.find(model => `${model.provider}/${model.id}` === role.resolved);
  const save = (clear = false): void => send({ action: "save", scope, ...roleChange(role.id, clear ? "" : selector, effort, scope) }, "role");
  return <section className="card">
    <h2>{role.name}{role.name !== role.id && <Badge>{role.id}</Badge>}{dirty && <Badge tone="warning">Unsaved</Badge>}</h2>
    <dl className="small">
      <dt>Current model</dt><dd><code>{role.resolved ?? (role.selector ? "No available model" : "Automatic")}</code>{role.thinking && <span className="muted"> · thinking {role.thinking}</span>} <Badge>{sourceLabel(role.source)}</Badge></dd>
      {role.selector && role.selector !== role.resolved && <><dt>Selector</dt><dd><code>{role.selector}</code></dd></>}
      {!role.thinking && <><dt>Thinking</dt><dd>{String(snapshot.effective.defaultThinkingLevel ?? "OMP default")} <span className="muted">(default thinking level)</span></dd></>}
      {persisted !== role.selector && <><dt>Saved in {scope} config</dt><dd>{persisted === null ? `Cleared in ${scope} config (hides lower configs)` : persistedText ? <code>{persistedText}</code> : "Not set"}</dd></>}
    </dl>
    <form onSubmit={event => { event.preventDefault(); save(); }}>
      {projectAllowed
        ? <label>Save to<select aria-label="Role write scope" value={scope} onChange={event => setScope(event.target.value as SettingsScope)}><option value="project">Project config · this folder</option><option value="global">Global config · active profile</option></select></label>
        : <p className="small muted">Saved to the global config, as OMP role storage is global.</p>}
      <div className="field-row">
        <label className="grow">Model<input list="role-models" aria-label={`${role.id} model selector`} value={selector} onChange={event => onDraft({ selector: event.target.value, effort })} placeholder="provider/model, @role or pattern" /></label>
        <label>Thinking<select aria-label={`${role.id} thinking effort`} disabled={!selector.trim() || !model?.reasoning} value={effort} onChange={event => onDraft({ selector, effort: event.target.value })}>
          <option value="">Keep suffix</option>{[...new Set(["inherit", "auto", "off", ...(model?.efforts ?? [])])].map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>
      </div>
      <ModelSuggestions snapshot={snapshot} id="role-models" accepts={role.accepts} />
      <p className="small muted">{model && !model.reasoning ? "This model has no thinking levels. " : ""}{role.id === "default" ? "Auto removes the suffix and sets the global default thinking level to auto." : "Thinking is saved as a suffix on this role's selector."}</p>
      <div className="toolbar">
        <button type="submit" disabled={!selector.trim() || selector.trim() === persistedText && !effort}>Save role</button>
        {dirty && <button className="secondary" type="button" onClick={() => onDraft(undefined)}>Discard changes</button>}
        <button className="secondary" type="button" disabled={persisted === null || persisted === undefined && scope === "global"} onClick={() => save(true)}>Clear {scope} assignment</button>
      </div>
      <InlineStatus origin="role" />
    </form>
    {role.defaults.length > 0 && <details><summary className="small">OMP's automatic candidates</summary><ol className="small plain-list">{role.defaults.map(item => <li key={item}><code>{item}</code></li>)}</ol></details>}
  </section>;
}
function CurrentSession({ init, send }: { init?: Init; send: Send }) {
  if (!init?.canApply) return <p className="small muted hint"><Icon name="info" /> Saved roles apply to new sessions. To switch a running Chat, open Models with <code>/models</code> from that Chat.</p>;
  return <section className="card"><h3>Current session</h3>
    <p className="small muted">Saving never switches a running session. This applies the effective default model to {init.sessionLabel ?? "the launching Chat"} while it is idle. RPC cannot apply auto thinking or upstream routing.</p>
    <button type="button" onClick={() => send({ action: "apply-default" }, "session")}>Apply default to {init.sessionLabel ?? "launching Chat"}</button>
    <InlineStatus origin="session" />
  </section>;
}
function Cycle({ snapshot, send }: SurfaceProps) {
  const effective = lines(text(snapshot.effective.cycleOrder));
  const [order, setOrder] = useState(effective);
  const addable = snapshot.roles.map(role => role.id).filter(id => !order.includes(id));
  const [chosen, setAdd] = useState("");
  const add = addable.includes(chosen) ? chosen : addable[0] ?? "";
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [focusKey, setFocusKey] = useState<string>();
  useEffect(() => { if (focusKey) { buttons.current.get(focusKey)?.focus(); setFocusKey(undefined); } }, [focusKey]);
  const move = (index: number, step: number): void => {
    const next = [...order]; const other = index + step;
    if (other < 0 || other >= next.length) return;
    [next[index], next[other]] = [next[other]!, next[index]!];
    setOrder(next);
    const role = order[index]!;
    // At either end the pressed arrow disables itself; keep focus on the row through its other arrow.
    setFocusKey(other === 0 || other === next.length - 1 ? `${role}:${step < 0 ? "down" : "up"}` : `${role}:${step < 0 ? "up" : "down"}`);
  };
  const remove = (index: number): void => {
    const next = order.filter((_, i) => i !== index);
    setOrder(next);
    setFocusKey(next.length ? `${next[Math.min(index, next.length - 1)]}:remove` : undefined);
  };
  const button = (role: string, action: string, icon: string, label: string, disabled: boolean, onClick: () => void) =>
    <button type="button" className="icon secondary" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      ref={element => { if (element) buttons.current.set(`${role}:${action}`, element); else buttons.current.delete(`${role}:${action}`); }}><Icon name={icon} /></button>;
  return <section className="card"><h2>Model cycle order <Badge>Global</Badge>{!sameList(order, effective) && <Badge tone="warning">Unsaved</Badge>}</h2>
    <p className="small muted">OMP's model cycling steps through these roles in this order. Effective order from {sourceLabel(snapshot.provenance.cycleOrder)}.</p>
    {order.length ? <ol className="cycle">{order.map((role, index) => <li key={role}>
      <span className="ordinal">{index + 1}</span><strong>{role}</strong><span className="small muted ellipsis grow">{snapshot.roles.find(item => item.id === role)?.resolved ?? "auto"}</span>
      {button(role, "up", "arrow-up", `Move ${role} up`, index === 0, () => move(index, -1))}
      {button(role, "down", "arrow-down", `Move ${role} down`, index === order.length - 1, () => move(index, 1))}
      {button(role, "remove", "close", `Remove ${role} from cycle`, false, () => remove(index))}
    </li>)}</ol> : <p className="small muted">No roles in the cycle.</p>}
    <div className="toolbar">
      <select aria-label="Role to add to cycle" value={add} disabled={!addable.length} onChange={event => setAdd(event.target.value)}>{addable.map(id => <option key={id}>{id}</option>)}</select>
      <button type="button" className="secondary" disabled={!add} onClick={() => setOrder([...order, add])}><Icon name="add" />Add</button>
      <span className="grow" />
      <button type="button" disabled={sameList(order, effective)} onClick={() => send({ action: "save", scope: "global", edits: [{ path: ["cycleOrder"], value: order }] }, "cycle")}>Save order</button>
      <button type="button" className="secondary" disabled={snapshot.global.cycleOrder === undefined} onClick={() => send({ action: "save", scope: "global", edits: [{ path: ["cycleOrder"] }] }, "cycle")}>Reset global order</button>
    </div>
    <InlineStatus origin="cycle" />
  </section>;
}
function Fallback({ snapshot, send, revision }: SurfaceProps) {
  const effective = at(snapshot.effective, ["retry", "fallbackChains"]);
  const configured = isRecord(effective) ? Object.keys(effective) : [];
  const [selected, setSelected] = useState(configured[0] ?? "");
  const [newKey, setNewKey] = useState("");
  const keys = selected && !configured.includes(selected) ? [...configured, selected] : configured;
  return <section className="card"><h2>Retry fallback chains <Badge>Global</Badge></h2>
    <p className="small muted">When a request fails, OMP retries with the chain's models from top to bottom. A chain belongs to a role, an exact model, a whole provider (<code>provider/*</code>) or everything (<code>*</code>). Effective chains from {sourceLabel(snapshot.provenance["retry.fallbackChains"])}.</p>
    <div className="grid">
      <div>
        {keys.length ? <ListBox label="Fallback chains" selected={selected} onSelect={setSelected} options={keys.map(key => ({ id: key, content: <div className="option-row">
          <span className="mono ellipsis">{key}</span><span className="small muted">{configured.includes(key) ? count(lines(text(at(snapshot.effective, ["retry", "fallbackChains", key]))).length, "model") : "new"}</span>
        </div> }))} /> : <p className="small muted">No fallback chains are configured.</p>}
        <form className="add-row" onSubmit={event => { event.preventDefault(); setSelected(newKey.trim()); setNewKey(""); }}>
          <input list="fallback-keys" aria-label="New fallback chain key" placeholder="Role, model, provider/* or *" value={newKey} onChange={event => setNewKey(event.target.value)} />
          <button className="secondary" type="submit" disabled={!newKey.trim()}><Icon name="add" />New chain</button>
        </form>
        <datalist id="fallback-keys">{[...new Set(["*", ...snapshot.roles.map(role => role.id), ...snapshot.providers.map(provider => `${provider.id}/*`)])].filter(key => !configured.includes(key)).map(key => <option key={key}>{key}</option>)}</datalist>
      </div>
      {selected ? <FallbackChain key={`${selected}:${revision}`} snapshot={snapshot} send={send} chainKey={selected} /> : <p className="small muted">Choose a chain, or create one for a role, model or provider.</p>}
    </div>
  </section>;
}
function FallbackChain({ snapshot, send, chainKey }: { snapshot: SettingsSnapshot; send: Send; chainKey: string }) {
  const persisted = at(snapshot.global, ["retry", "fallbackChains", chainKey]);
  const effective = text(at(snapshot.effective, ["retry", "fallbackChains", chainKey]));
  const [chain, setChain] = useState(effective);
  const [candidate, setCandidate] = useState("");
  const count = lines(chain).length;
  const save = (clear: boolean): void => send({ action: "save", scope: "global", edits: [{ path: ["retry", "fallbackChains", chainKey], ...(!clear && count ? { value: lines(chain) } : {}) }] }, "fallback");
  return <div>
    <h3><code>{chainKey}</code>{!sameList(lines(chain), lines(effective)) && <Badge tone="warning">Unsaved</Badge>}</h3>
    <p className="small muted">{persisted === undefined ? "Not set in the global config." : sameList(lines(text(persisted)), lines(effective)) ? "Saved in the global config." : "The global config has a different chain; a higher-priority config wins."}</p>
    <label>Models, one per line, tried in order<textarea aria-label="Ordered fallback selectors" rows={Math.min(16, Math.max(4, count + 1))} value={chain} onChange={event => setChain(event.target.value)} /></label>
    <form className="add-row" onSubmit={event => { event.preventDefault(); setChain(appendLine(chain, candidate)); setCandidate(""); }}>
      <input aria-label="Model to append to fallback" list="fallback-models" value={candidate} onChange={event => setCandidate(event.target.value)} placeholder="Model to append" />
      <button className="secondary" type="submit" disabled={!candidate.trim()}><Icon name="add" />Append</button>
    </form>
    <ModelSuggestions snapshot={snapshot} id="fallback-models" />
    <div className="toolbar">
      <button type="button" disabled={sameList(lines(chain), lines(text(persisted)))} onClick={() => save(false)}>Save chain</button>
      <button type="button" className="secondary" disabled={persisted === undefined} onClick={() => save(true)}>Clear global chain</button>
    </div>
    <InlineStatus origin="fallback" />
  </div>;
}
function PresetEntry({ entry }: { entry: unknown }) {
  if (!isRecord(entry)) return <p className="small muted">Not set</p>;
  const roles = isRecord(entry.modelRoles) ? Object.entries(entry.modelRoles) : [];
  return <dl className="small">
    {roles.map(([role, selector]) => <Fragment key={role}><dt>{role}</dt><dd><code>{displayValue(selector)}</code></dd></Fragment>)}
    <dt>Default thinking</dt><dd>{displayValue(entry.defaultThinkingLevel)}</dd>
  </dl>;
}
function Presets({ snapshot, send }: SurfaceProps) {
  // Until the user picks or types a name, follow the active preset of the latest snapshot.
  const [chosen, setName] = useState<string>();
  const name = chosen ?? snapshot.activePreset ?? snapshot.presetNames[0] ?? "";
  const exists = snapshot.presetNames.includes(name);
  const inGlobal = isRecord(snapshot.global.modelPresets) && Object.hasOwn(snapshot.global.modelPresets, name);
  const globalEntry = at(snapshot.global, ["modelPresets", name]);
  const effectiveEntry = at(snapshot.effective, ["modelPresets", name]);
  const valid = NAME_PATTERN.test(name);
  return <div className="grid">
    <section className="card"><h2>Model presets</h2>
      <p className="small muted">A preset stores every role assignment and the default thinking level.</p>
      {snapshot.presetNames.length ? <ListBox label="Saved presets" selected={exists ? name : undefined} onSelect={setName} options={snapshot.presetNames.map(preset => {
        const roles = at(snapshot.effective, ["modelPresets", preset, "modelRoles"]);
        return { id: preset, content: <div className="option-row"><strong>{preset}</strong>{preset === snapshot.activePreset && <Badge tone="accent">Active</Badge>}<span className="small muted">{isRecord(roles) ? count(Object.keys(roles).length, "role") : ""}</span></div> };
      })} /> : <p className="small muted">No saved presets. Save the current role assignments as a preset.</p>}
      <label>Preset name<input aria-label="Preset name" value={name} onChange={event => setName(event.target.value)} aria-invalid={Boolean(name) && !valid} /></label>
      {name && !valid && <div className="small error">{NAME_HINT}</div>}
    </section>
    <section className="card"><h2>{name || "New preset"}{name && name === snapshot.activePreset && <Badge tone="accent">Active</Badge>}</h2>
      <p className="small muted">Current roles match {snapshot.activePreset ? <strong>{snapshot.activePreset}</strong> : "no preset"}. Applying a preset uses OMP's role storage, checks the default model first and clears roles the preset leaves out. It does not switch running sessions.</p>
      <div className="toolbar">
        <button type="button" disabled={!exists} onClick={() => send({ action: "preset", operation: "switch", name }, "preset")}>Apply preset</button>
        <button type="button" className="secondary" disabled={!valid} onClick={() => send({ action: "preset", operation: "save", name }, "preset")}>{exists ? "Overwrite with current roles" : "Save current roles as preset"}</button>
        <button type="button" className="secondary" disabled={!inGlobal} onClick={() => send({ action: "preset", operation: "delete", name }, "preset")}>Delete from global config</button>
      </div>
      <InlineStatus origin="preset" />
      {exists && <><h3>Preset contents <span className="muted small">from {sourceLabel(snapshot.provenance.modelPresets)}</span></h3><PresetEntry entry={effectiveEntry} />
        {inGlobal && JSON.stringify(globalEntry) !== JSON.stringify(effectiveEntry) && <><h3>Saved in global config</h3><PresetEntry entry={globalEntry} /><p className="small muted">A higher-priority config owns this name. Delete it in that config to remove it.</p></>}</>}
    </section>
  </div>;
}
const PREFERENCES = ["modelProviderOrder", "enabledModels", "enabledProviders", "disabledProviders", "modelRoleStorage"] as const;
function ModelBrowser({ snapshot, send }: SurfaceProps) {
  const [query, setQuery] = useState(""); const [provider, setProvider] = useState(""); const [kind, setKind] = useState(""); const [recent, setRecent] = useState(false); const [availableOnly, setAvailableOnly] = useState(true); const [page, setPage] = useState(0);
  const table = useRef<HTMLDivElement>(null);
  const models = useMemo(() => filteredModels(snapshot.models, query, provider, kind, recent, availableOnly), [snapshot.models, query, provider, kind, recent, availableOnly]);
  const { availableCount, perProvider, usedBy } = useMemo(() => {
    const perProvider: Record<string, number> = {}; const usedBy: Record<string, string[]> = {};
    for (const model of snapshot.models) if (model.available) perProvider[model.provider] = (perProvider[model.provider] ?? 0) + 1;
    for (const role of snapshot.roles) if (role.resolved) (usedBy[role.resolved] ??= []).push(role.id);
    return { availableCount: Object.values(perProvider).reduce((sum, count) => sum + count, 0), perProvider, usedBy };
  }, [snapshot.models, snapshot.roles]);
  const pages = Math.max(1, Math.ceil(models.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = models.slice(current * PAGE, current * PAGE + PAGE);
  const selectedProvider = snapshot.providers.find(item => item.id === provider);
  const filter = (apply: () => void): void => { apply(); setPage(0); };
  const turn = (next: number): void => { setPage(next); table.current?.scrollIntoView({ block: "start" }); };
  const filtered = Boolean(query || provider || kind || recent);
  const pager = models.length > PAGE && <div className="toolbar pager">
    <IconButton icon="chevron-left" label="Previous page" disabled={current === 0} onClick={() => turn(current - 1)} />
    <span className="small muted">{current * PAGE + 1}–{Math.min((current + 1) * PAGE, models.length)} of {models.length}</span>
    <IconButton icon="chevron-right" label="Next page" disabled={current + 1 >= pages} onClick={() => turn(current + 1)} />
  </div>;
  return <>
    <section className="card"><h2>Model browser <span className="muted small">{availableCount} of {snapshot.models.length} available</span></h2>
      <div className="toolbar">
        <input type="search" aria-label="Search models" value={query} placeholder="Search models" onChange={event => filter(() => setQuery(event.target.value))} />
        <select aria-label="Filter model provider" value={provider} onChange={event => filter(() => setProvider(event.target.value))}><option value="">All providers</option>
          <optgroup label="Ready">{snapshot.providers.filter(item => item.available).map(item => <option key={item.id} value={item.id}>{item.id} ({perProvider[item.id] ?? 0})</option>)}</optgroup>
          <optgroup label="Not available">{snapshot.providers.filter(item => !item.available).map(item => <option key={item.id} value={item.id}>{item.id} — {providerStatus(item.status)}</option>)}</optgroup></select>
        <select aria-label="Filter model kind" value={kind} onChange={event => filter(() => setKind(event.target.value))}><option value="">All kinds</option>{[...new Set(snapshot.models.map(model => model.kind))].sort().map(kind => <option key={kind}>{kind}</option>)}</select>
        <label className="check"><input type="checkbox" checked={availableOnly} onChange={event => filter(() => setAvailableOnly(event.target.checked))} />Available only</label>
        <label className="check"><input type="checkbox" checked={recent} onChange={event => filter(() => setRecent(event.target.checked))} />Recently used</label>
      </div>
      <div className="provider-bar">
        <span className="small muted">{selectedProvider ? <><strong>{selectedProvider.id}</strong>: {providerStatus(selectedProvider.status)}. </> : null}Refresh contacts providers; OMP may store rotated credentials, as the TUI does. Refreshed catalogues stay in this editor's private cache. Login opens a visible OMP terminal.</span>
        <div className="toolbar">
          <button type="button" className="secondary" onClick={() => send({ action: "refresh", ...(provider ? { provider } : {}) }, "browser")}><Icon name="refresh" />Refresh {provider || "all providers"}</button>
          <button type="button" className="secondary" onClick={() => send({ action: "login", ...(provider ? { provider } : {}) }, "browser")}><Icon name="sign-in" />Log in{provider ? ` to ${provider}` : "…"}</button>
        </div>
      </div>
      <InlineStatus origin="browser" />
      <div className="toolbar between" ref={table}><span className="small muted">{models.length} {availableOnly ? "available " : ""}models{availableOnly && !filtered && availableCount < snapshot.models.length ? ` · ${snapshot.models.length - availableCount} locked hidden` : ""}</span>{pager}</div>
      {shown.length > 0 && <div className="table-wrap"><table className="models"><thead><tr><th>Model</th><th className="col-provider">Provider</th><th className="optional col-num">Context</th><th className="optional col-price">$/M in / out</th><th className="optional col-thinking">Thinking</th><th className="col-status">Status</th></tr></thead>
        <tbody>{shown.map(model => {
          const key = `${model.provider}/${model.id}`;
          return <tr key={key} className={model.available ? "" : "dim"}>
            <td><div className="option-row wrap"><strong>{model.name}</strong>{usedBy[key]?.map(role => <Badge key={role} tone="accent">{role}</Badge>)}</div>
              <div className="small muted ellipsis"><code title={model.id}>{model.id}</code>{(model.perf || model.upstreams?.length) ? ` · ${[perfLabel(model.perf), model.upstreams?.length ? `via ${model.upstreams.join(", ")}` : ""].filter(Boolean).join(" · ")}` : ""}</div></td>
            <td>{model.provider}<div className="small muted">{model.kind}{model.input?.includes("image") ? " · images" : ""}</div></td>
            <td className="optional">{compactCount(model.contextWindow)}<div className="small muted">out {compactCount(model.maxTokens)}</div></td>
            <td className="optional">{priceLabel(model.cost)}</td>
            <td className="optional small">{model.efforts.join(", ") || "—"}</td>
            <td>{model.available ? "Available" : <span title="No credentials, or hidden by provider and model filters">Locked</span>}{model.recent >= 0 && <div className="small muted">Recent #{model.recent + 1}</div>}</td>
          </tr>;
        })}</tbody></table></div>}
      {!shown.length && <div className="empty">{snapshot.models.length ? <><p>No models match these filters.</p>{(filtered || availableOnly) && <button type="button" className="secondary" onClick={() => { setQuery(""); setProvider(""); setKind(""); setRecent(false); setAvailableOnly(false); setPage(0); }}>Clear filters</button>}</>
        : <p>OMP reports no models. Log in to a provider or add models to models.yml, then Reload.</p>}</div>}
      {pager}
    </section>
    <section className="card"><h3>Browser preferences <span className="muted small">read-only</span></h3>
      <p className="small muted">OMP's model hub does not change these. Edit them in the config that sets them.</p>
      <div className="table-wrap"><table className="small"><thead><tr><th>Setting</th><th>Effective</th><th>Set by</th><th className="optional">Global</th><th className="optional">Project</th></tr></thead>
        <tbody>{PREFERENCES.map(key => <tr key={key}><td><code>{key}</code></td><td>{displayValue(snapshot.effective[key])}</td><td>{sourceLabel(snapshot.provenance[key])}</td><td className="optional">{displayValue(snapshot.global[key])}</td><td className="optional">{displayValue(snapshot.project[key])}</td></tr>)}</tbody></table></div>
    </section>
  </>;
}
interface AgentDraft { readonly enabled: boolean; readonly model: string; readonly prewalk: string; readonly advisor: string; readonly dirty: readonly AgentField[] }
type AgentField = "enabled" | "model" | "prewalk" | "advisor";
const AGENT_SETTINGS = { model: "agentModelOverrides", prewalk: "agentPrewalk", advisor: "agentAdvisor" } as const;
function Agents(props: SurfaceProps) {
  const { snapshot, revision } = props;
  const [query, setQuery] = useState(""); const [source, setSource] = useState(""); const [selected, setSelected] = useState(snapshot.agents[0]?.name ?? "");
  const [drafts, setDraft] = useDrafts<AgentDraft>(revision);
  const needle = query.trim().toLowerCase();
  const agents = snapshot.agents.filter(agent => (!source || agent.source === source) && `${agent.name} ${agent.description} ${agent.effectiveModel.join(" ")}`.toLowerCase().includes(needle));
  // A filter never swaps the editor away from the agent being edited.
  const agent = snapshot.agents.find(agent => agent.name === selected) ?? agents[0];
  const sources: Record<string, number> = {};
  for (const item of snapshot.agents) sources[item.source] = (sources[item.source] ?? 0) + 1;
  return <>
    <div className="toolbar">
      <input type="search" aria-label="Search agents" placeholder="Search agents" value={query} onChange={event => setQuery(event.target.value)} />
      <select aria-label="Filter agent source" title="Agents with the same name resolve project, then user, plugin and bundled." value={source} onChange={event => setSource(event.target.value)}>
        <option value="">All sources ({snapshot.agents.length})</option>{Object.entries(sources).map(([source, count]) => <option key={source} value={source}>{source} ({count})</option>)}</select>
      <span className="small muted">{agents.length === snapshot.agents.length ? `${agents.length} agents` : `${agents.length} of ${snapshot.agents.length} agents`}</span>
    </div>
    <div className="grid">
      <section className="card"><h2>Agents</h2>
        {agents.length ? <ListBox label="Agents" selected={agent?.name} onSelect={setSelected} options={agents.map(item => ({ id: item.name, dim: item.disabled, title: item.description, content: <>
          <div className="option-row"><strong className="ellipsis">{item.name}</strong>{drafts[item.name] && <Unsaved />}{item.disabled && <Badge tone="warning">Disabled</Badge>}<span className="muted small push">{item.source}</span></div>
          <div className="small muted ellipsis">{item.description}</div>
        </> }))} /> : <div className="empty">{snapshot.agents.length ? "No agents match." : "OMP discovered no agents."}</div>}
        {agent && agents.length > 0 && !agents.includes(agent) && <p className="small muted">{agent.name} stays open in the editor but is hidden by the filter.</p>}
      </section>
      {agent && <AgentEditor key={agent.name} {...props} agent={agent} draft={drafts[agent.name]} onDraft={draft => setDraft(agent.name, draft)} />}
    </div>
  </>;
}
const SWITCH_CHOICES = [["", "Inherit (definition)"], ["on", "On"], ["off", "Off"], ["custom", "Role or model…"]] as const;
/** Prewalk/advisor values as the native hub offers them: inherit, on, off, or a role/model pattern. */
function SwitchField({ label, value, onChange, effective }: { label: string; value: string; onChange(value: string): void; effective: ReactNode }) {
  const trimmed = value.trim();
  // "Role or model…" with nothing typed yet has no value of its own to derive the mode from.
  const [picked, setPicked] = useState(false);
  const mode = trimmed === "on" || trimmed === "off" || trimmed === "" && !picked ? trimmed : "custom";
  return <div className="field">
    <div className="field-row">
      <label>{label}<select aria-label={`${label} mode`} value={mode} onChange={event => { const next = event.target.value; setPicked(next === "custom"); onChange(next === "custom" ? (mode === "custom" ? value : "") : next); }}>
        {SWITCH_CHOICES.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>
      {mode === "custom" && <label className="grow">Pattern<input list="agent-switches" aria-label={`${label} pattern`} value={value} onChange={event => onChange(event.target.value)} placeholder="@role or model pattern" /></label>}
    </div>
    <p className="small muted">{effective}</p>
  </div>;
}
function AgentEditor({ snapshot, send, agent, draft, onDraft }: SurfaceProps & { agent: SettingsAgent; draft?: AgentDraft; onDraft(draft: AgentDraft | undefined): void }) {
  const persisted = (field: keyof typeof AGENT_SETTINGS) => at(snapshot.global, ["task", AGENT_SETTINGS[field], agent.name]);
  const current: AgentDraft = draft ?? { enabled: !agent.disabled, model: text(persisted("model")), prewalk: text(persisted("prewalk")), advisor: text(persisted("advisor")), dirty: [] };
  const set = (field: AgentField, value: string | boolean): void => onDraft({ ...current, [field]: value, dirty: current.dirty.includes(field) ? current.dirty : [...current.dirty, field] });
  const [candidate, setCandidate] = useState("");
  const append = (): void => { if (candidate.trim()) { set("model", appendLine(current.model, candidate)); setCandidate(""); } };
  const dirty = current.dirty.length > 0;
  const save = (): void => {
    const edits: ConfigEdit[] = [];
    if (current.dirty.includes("enabled")) edits.push({ path: ["task", "disabledAgents"], value: disabledAgentsAfterToggle(at(snapshot.global, ["task", "disabledAgents"]), agent.name, current.enabled) });
    for (const field of ["model", "prewalk", "advisor"] as const) {
      if (!current.dirty.includes(field)) continue;
      const value = current[field]; const patterns = lines(value);
      edits.push({ path: ["task", AGENT_SETTINGS[field], agent.name], ...(patterns.length ? { value: field === "model" ? patterns.length === 1 ? patterns[0] : patterns : value.trim() } : {}) });
    }
    send({ action: "save", scope: "global", edits }, "agent");
  };
  const clear = (field: keyof typeof AGENT_SETTINGS, label: string) => <IconButton icon="close" label={`Clear global ${label} override`} disabled={persisted(field) === undefined || dirty}
    title={dirty ? "Save or discard pending changes first" : `Clear global ${label} override`} onClick={() => send({ action: "save", scope: "global", edits: [{ path: ["task", AGENT_SETTINGS[field], agent.name] }] }, "agent")} />;
  // Record-level provenance explains an agent's override only when that agent has one.
  const from = (setting: string, value: string | undefined): string => { const source = snapshot.provenance[`task.${setting}`]; return value !== undefined && source && source !== "default" ? ` · ${sourceLabel(source)}` : ""; };
  const disabledSource = snapshot.provenance["task.disabledAgents"];
  return <section className="card">
    <div className="card-head">
      <h2>{agent.name}<Badge>{agent.source}</Badge>{agent.disabled && <Badge tone="warning">Disabled</Badge>}{dirty && <Badge tone="warning">Unsaved</Badge>}</h2>
      {agent.hasFile && <button type="button" className="secondary" onClick={() => send({ action: "open-agent", agent: agent.name }, "agent")}><Icon name="go-to-file" />Open definition</button>}
    </div>
    <p className="muted description">{agent.description}</p>
    <dl className="small">
      <dt>Model</dt><dd><Chain items={agent.effectiveModel} empty="Task role" /></dd>
      <dt>Resolves to</dt><dd><code>{agent.resolvedModel ?? "Automatic / unavailable"}</code></dd>
      <dt>Prewalk</dt><dd><code>{agent.effectivePrewalk ?? "off"}</code></dd>
      <dt>Advisor</dt><dd><code>{agent.effectiveAdvisor ?? "off"}</code></dd>
    </dl>
    <form onSubmit={event => { event.preventDefault(); save(); }}>
      <h3>Global overrides</h3>
      <label className="check"><input type="checkbox" aria-label={`${agent.name} enabled`} checked={current.enabled} onChange={event => set("enabled", event.target.checked)} />Enabled</label>
      <p className="small muted">Saved in the global disabled list.{disabledSource && !["default", "global"].includes(disabledSource) ? ` The effective list comes from the ${sourceLabel(disabledSource).toLowerCase()}.` : ""}</p>
      <label>Model override<textarea aria-label={`${agent.name} model override`} rows={Math.min(10, Math.max(3, lines(current.model).length + 1))} value={current.model} onChange={event => set("model", event.target.value)} placeholder="One pattern per line, tried in order; blank inherits" /></label>
      <div className="add-row">
        <input list="agent-patterns" aria-label="Model pattern to append" placeholder="Model or @role to append" value={candidate} onChange={event => setCandidate(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); append(); } }} />
        <button className="secondary" type="button" disabled={!candidate.trim()} onClick={append}><Icon name="add" />Append</button>
        {clear("model", "model")}
      </div>
      <ModelSuggestions snapshot={snapshot} id="agent-patterns" />
      <p className="small muted">Effective override: {agent.overrideModel ?? "none, so the definition or task role decides"}{from("agentModelOverrides", agent.overrideModel)}</p>
      <div className="field-pair">
        <SwitchField label="Prewalk" value={current.prewalk} onChange={value => set("prewalk", value)} effective={<>Effective override: {agent.prewalkOverride ?? "none"}{from("agentPrewalk", agent.prewalkOverride)}</>} />{clear("prewalk", "prewalk")}
      </div>
      <div className="field-pair">
        <SwitchField label="Advisor" value={current.advisor} onChange={value => set("advisor", value)} effective={<>Effective override: {agent.advisorOverride ?? "none"}{from("agentAdvisor", agent.advisorOverride)}</>} />{clear("advisor", "advisor")}
      </div>
      <datalist id="agent-switches">{snapshot.roles.map(role => <option key={role.id}>@{role.id}</option>)}{snapshot.models.filter(model => model.available).map(model => <option key={`${model.provider}/${model.id}`}>{model.provider}/{model.id}</option>)}</datalist>
      <div className="toolbar"><button type="submit" disabled={!dirty}>Save overrides</button>{dirty && <button type="button" className="secondary" onClick={() => onDraft(undefined)}>Discard changes</button>}</div>
      <InlineStatus origin="agent" />
    </form>
    <details><summary>Definition (read-only)</summary>
      <dl className="small"><dt>Model</dt><dd><Chain items={typeof agent.model === "string" ? [agent.model] : agent.model ?? []} empty="Not set" /></dd>
        <dt>Prewalk</dt><dd><code>{agent.prewalk === undefined ? "Not set" : String(agent.prewalk === true ? "on" : agent.prewalk === false ? "off" : agent.prewalk)}</code></dd>
        <dt>Advisor</dt><dd><code>{agent.advisor === undefined ? "Not set" : String(agent.advisor === true ? "on" : agent.advisor === false ? "off" : agent.advisor)}</code></dd></dl>
      <h3>System prompt</h3><pre className="scroll">{agent.systemPrompt}</pre>
    </details>
  </section>;
}
function NewAgent({ send, preview, directories }: { send: Send; preview: Preview; directories: SettingsSnapshot["agentDirectories"] }) {
  const [description, setDescription] = useState(""); const [scope, setScope] = useState<SettingsScope>("project");
  const generate = (): void => { if (description.trim()) send({ action: "generate", description }, "new-agent"); };
  return <section className="card"><h2>Generate a new agent</h2>
    <p className="small muted">Generating calls your configured provider with OMP's architect prompts, records usage like OMP and may refresh catalogues or store rotated credentials through OMP. It creates no history session. Nothing is sent until you choose Generate.</p>
    <form onSubmit={event => { event.preventDefault(); generate(); }}>
      <label>Describe the agent<textarea className="prose" aria-label="Agent creation request" maxLength={32_000} value={description} onChange={event => setDescription(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); generate(); } }} placeholder="What should this agent specialize in, and when should it be used?" /></label>
      <label>Destination<select aria-label="New agent destination" value={scope} onChange={event => setScope(event.target.value as SettingsScope)}><option value="project">Project · this folder</option><option value="global">User · active OMP profile</option></select></label>
      <p className="small muted">Creates a Markdown file in <code>{directories[scope]}</code>. Existing files are never overwritten.{scope === "project" ? " A new .omp/agents here can shadow an ancestor project's agents, as in OMP." : ""}</p>
      <div className="toolbar"><button className={preview ? "secondary" : ""} disabled={!description.trim()} type="submit"><Icon name="sparkle" />{preview ? "Regenerate" : "Generate specification"}</button><span className="small muted">Ctrl+Enter</span></div>
      <InlineStatus origin="new-agent" />
    </form>
    {preview && <div className="preview"><h3>Review the generated specification <span className="muted small">read-only</span></h3>
      <dl className="small"><dt>Identifier</dt><dd><code>{preview.identifier}</code></dd><dt>When to use</dt><dd>{preview.whenToUse}</dd></dl>
      <h3>System prompt</h3><pre className="scroll">{preview.systemPrompt}</pre>
      <div className="toolbar"><button type="button" onClick={() => send({ action: "create", scope }, "create-agent")}>Create agent in {scope === "project" ? "project" : "user"} agents</button></div>
      <InlineStatus origin="create-agent" />
    </div>}
  </section>;
}
const style = document.createElement("style");
style.nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? "";
style.textContent = SETTINGS_CSS;
document.head.appendChild(style);
const root = document.getElementById("root");
if (!root) throw new Error("The settings page container is missing.");
createRoot(root).render(<App />);
