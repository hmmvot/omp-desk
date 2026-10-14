import { useState } from "react";
import type { ReactNode } from "react";
import type { AgentOutcome, ConfigEdit, SettingsAgent, SettingsScope, SettingsSnapshot } from "../../protocol/settings-model";
import { agentCounts, agentMatchesFilter, agentPill, at, disabledAgentsAfterToggle, patternList, rolePill, roleStripIds, withEntry } from "./model";
import type { AgentFilter } from "./model";
import { Badge, Chain, EntryStatusText, Icon, IconButton, InlineStatus, ListBox, Meter, ModelChip, OrderedList, SourcePill, Trace, Unsaved, useDrafts } from "./common";
import type { Pick, Send, SurfaceProps } from "./common";
import { SignIn } from "./health";

type AgentField = "enabled" | "model" | "prewalk" | "advisor";
interface AgentDraft { readonly layer: SettingsScope; readonly enabled: boolean; readonly model: readonly string[]; readonly prewalk: string; readonly advisor: string; readonly dirty: readonly AgentField[] }
const AGENT_SETTINGS = { model: "agentModelOverrides", prewalk: "agentPrewalk", advisor: "agentAdvisor" } as const;
const FILTERS: readonly (readonly [AgentFilter, string])[] = [["all", "All"], ["override", "Overridden"], ["role", "Follow a role"], ["problems", "Problems"], ["disabled", "Disabled"]];
const LAYER_NAMES: Record<SettingsScope, string> = { project: "project", global: "global" };

/** The roles most agents depend on, always in view, so `@task` needs no lookup; every other role an agent names joins them. */
function RoleStrip({ snapshot }: { snapshot: SettingsSnapshot }) {
  const ids = roleStripIds(snapshot);
  return <section className="role-strip" aria-label="Roles agents follow"><span className="eyebrow">Roles agents follow</span>
    {ids.map(id => { const role = snapshot.roles.find(item => item.id === id)!; return <span key={id} className="strip-item" title={`Role ${id}${role.selector ? `: ${role.selector}` : ""}`}>
      <strong className="small">@{id}</strong><ModelChip model={role.resolution.model} /><Meter thinking={role.resolution.thinking} bare /><SourcePill pill={rolePill(role)} /></span>; })}
  </section>;
}
/** The agents of a snapshot with their model, thinking level and where the model comes from, and the editor of the selected one. */
export function Agents(props: SurfaceProps) {
  const { snapshot, revision } = props;
  const [query, setQuery] = useState(""); const [source, setSource] = useState(""); const [filter, setFilter] = useState<AgentFilter>("all");
  const [selected, setSelected] = useState(snapshot.agents[0]?.name ?? "");
  const [drafts, setDraft] = useDrafts<AgentDraft>(revision);
  const needle = query.trim().toLowerCase();
  const agents = snapshot.agents.filter(agent => (!source || agent.source === source) && agentMatchesFilter(agent, filter)
    && `${agent.name} ${agent.description} ${agent.effectiveModel.join(" ")} ${agent.resolution.model.model ?? agent.resolution.model.wanted ?? ""}`.toLowerCase().includes(needle));
  // A filter never swaps the editor away from the agent being edited.
  const agent = snapshot.agents.find(agent => agent.name === selected) ?? agents[0];
  const sources: Record<string, number> = {};
  for (const item of snapshot.agents) sources[item.source] = (sources[item.source] ?? 0) + 1;
  const counts = agentCounts(snapshot.agents);
  return <>
    <RoleStrip snapshot={snapshot} />
    <div className="toolbar">
      <input type="search" aria-label="Search agents" placeholder="Search agents or models" value={query} onChange={event => setQuery(event.target.value)} />
      <select aria-label="Filter agent source" title="Agents with the same name resolve project, then user, plugin and bundled." value={source} onChange={event => setSource(event.target.value)}>
        <option value="">All sources ({snapshot.agents.length})</option>{Object.entries(sources).map(([name, total]) => <option key={name} value={name}>{name} ({total})</option>)}</select>
      <div role="group" aria-label="Show agents" className="chips">{FILTERS.map(([id, label]) =>
        <button key={id} type="button" className={filter === id ? "" : "secondary"} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label} <span className="pill">{counts[id]}</span></button>)}</div>
      <span className="small muted" role="status">{agents.length === snapshot.agents.length ? `${agents.length} agents` : `${agents.length} of ${snapshot.agents.length} agents`}</span>
    </div>
    <div className="master-detail">
      <section className="card list-card"><h2>Agents</h2>
        {agents.length ? <ListBox label="Agents" selected={agent?.name} onSelect={setSelected} options={agents.map(item => ({ id: item.name, dim: item.disabled, title: item.description, content: <div className="lrow">
          <div className="option-row"><strong className="ellipsis">{item.name}</strong>{drafts[item.name]?.dirty.length ? <Unsaved /> : null}{item.disabled && <Badge tone="warning">off</Badge>}<span className="push"><SourcePill pill={agentPill(item)} /></span></div>
          <div className="option-row"><ModelChip model={item.resolution.model} /><span className="push"><Meter thinking={item.resolution.thinking} /></span></div>
        </div> }))} /> : <div className="empty">{snapshot.agents.length ? "No agents match." : "OMP discovered no agents."}</div>}
        {agent && agents.length > 0 && !agents.includes(agent) && <p className="small muted">{agent.name} stays open in the editor but is hidden by the filter.</p>}
      </section>
      {agent && <AgentDetail key={agent.name} {...props} agent={agent} draft={drafts[agent.name]} onDraft={draft => setDraft(agent.name, draft)} />}
    </div>
  </>;
}
const SWITCH_MODES = [["inherit", "Inherit"], ["off", "Off"], ["on", "On"]] as const;
/**
 * Prewalk and advisor as OMP stores them: no override inherits the definition, `off`, `on` (the agent's own
 * model, else the role default) or a role/model pattern, which turns it on with that model.
 */
function ModelSwitch({ label, purpose, value, onChange, pick, fallback, effective }: { label: string; purpose: "prewalk" | "advisor"; value: string; onChange(value: string): void; pick: Pick; fallback: string; effective: ReactNode }) {
  const mode = value === "" ? "inherit" : value === "off" ? "off" : "on";
  const choose = async (): Promise<void> => {
    const next = await pick({ action: "pick-model", purpose, ...(mode === "on" ? { current: value } : {}) }, "agent");
    if (next) onChange(next);
  };
  return <div className="field">
    <div className="field-row">
      <span className="field-title">{label}</span>
      <div role="group" aria-label={label} className="segmented">{SWITCH_MODES.map(([id, text]) =>
        <button key={id} type="button" aria-pressed={mode === id} className={mode === id ? "" : "secondary"} onClick={() => onChange(id === "inherit" ? "" : id === "off" ? "off" : mode === "on" ? value : "on")}>{text}</button>)}</div>
      {mode === "on" && <>
        <span className="small">Model: {value === "on" ? <>agent default <span className="muted">(its own model, else {fallback})</span></> : <code>{value}</code>}</span>
        <button type="button" className="secondary" aria-label={`Choose ${label.toLowerCase()} model`} onClick={() => void choose()}><Icon name="symbol-variable" />Choose model…</button>
      </>}
    </div>
    <p className="small muted">{effective}</p>
  </div>;
}
function Outcome({ outcome }: { outcome: AgentOutcome }) {
  return <span className="outcome"><ModelChip model={outcome.model} /><Meter thinking={outcome.thinking} bare /></span>;
}
/** The sentence that says what a model that cannot run means for a subagent. */
function Unusable({ agent, snapshot, send }: { agent: SettingsAgent; snapshot: SettingsSnapshot; send: Send }) {
  const { model } = agent.resolution;
  if (model.status === "ok" || model.status === "none") return null;
  // A disabled agent is not in use: say so quietly, with no warning.
  if (agent.disabled) return <p className="small muted"><Icon name="info" /> Disabled, so it is not in use. Its model {model.wanted} {model.status === "login" ? "would need login" : model.status === "missing" ? "is not a model OMP knows" : "is not available"}.</p>;
  const provider = model.provider ? snapshot.providers.find(item => item.id === model.provider) : undefined;
  const what = model.status === "login" ? "needs login" : model.status === "missing" ? "is not a model OMP knows" : "is not available";
  return <div className="banner inner"><Icon name="warning" /><div className="grow"><strong>{model.wanted}</strong> {what}. Until that changes, this agent runs on the model of the session that spawns it.</div>
    {model.status === "login" && provider && !provider.available && <SignIn provider={provider.id} send={send} label="Sign in" />}</div>;
}
function AgentDetail({ snapshot, send, pick, folder, agent, draft, onDraft }: SurfaceProps & { agent: SettingsAgent; draft?: AgentDraft; onDraft(draft: AgentDraft | undefined): void }) {
  const { resolution } = agent;
  const writable: readonly SettingsScope[] = folder === null ? ["global"] : ["project", "global"];
  // The layer a save goes to starts as the one holding the agent's override, so editing it changes what is in effect.
  const defaultLayer: SettingsScope = resolution.layer && writable.includes(resolution.layer) ? resolution.layer : "global";
  const persisted = (layer: SettingsScope, field: keyof typeof AGENT_SETTINGS) => at(snapshot[layer], ["task", AGENT_SETTINGS[field], agent.name]);
  const persistedSwitch = (layer: SettingsScope, field: "prewalk" | "advisor"): string => { const value = persisted(layer, field); return typeof value === "string" ? value : ""; };
  const base = (layer: SettingsScope): AgentDraft => ({ layer, enabled: !agent.disabled, model: patternList(persisted(layer, "model")), prewalk: persistedSwitch(layer, "prewalk"), advisor: persistedSwitch(layer, "advisor"), dirty: [] });
  const current = draft ?? base(defaultLayer);
  const layer = current.layer;
  const set = (field: AgentField, value: AgentDraft[AgentField]): void => onDraft({ ...current, [field]: value, dirty: current.dirty.includes(field) ? current.dirty : [...current.dirty, field] });
  const addModel = async (): Promise<void> => {
    const value = await pick({ action: "pick-model", purpose: "agent-override", exclude: [...current.model] }, "agent");
    if (value) set("model", withEntry(current.model, value));
  };
  const dirty = current.dirty.length > 0;
  const save = (): void => {
    const edits: ConfigEdit[] = [];
    if (current.dirty.includes("enabled")) edits.push({ path: ["task", "disabledAgents"], value: disabledAgentsAfterToggle(at(snapshot.global, ["task", "disabledAgents"]), agent.name, current.enabled) });
    // One model is stored as a string, several as OMP's ordered list.
    if (current.dirty.includes("model")) edits.push({ path: ["task", AGENT_SETTINGS.model, agent.name], ...(current.model.length ? { value: current.model.length === 1 ? current.model[0] : [...current.model] } : {}) });
    for (const field of ["prewalk", "advisor"] as const) {
      if (current.dirty.includes(field)) edits.push({ path: ["task", AGENT_SETTINGS[field], agent.name], ...(current[field] ? { value: current[field] } : {}) });
    }
    send({ action: "save", scope: layer, edits }, "agent");
  };
  const clear = (field: keyof typeof AGENT_SETTINGS, label: string) => <IconButton icon="close" label={`Clear ${layer} ${label} override`} disabled={persisted(layer, field) === undefined || dirty}
    title={dirty ? "Save or discard pending changes first" : `Clear ${layer} ${label} override`} onClick={() => send({ action: "save", scope: layer, edits: [{ path: ["task", AGENT_SETTINGS[field], agent.name] }] }, "agent")} />;
  const disabledSource = snapshot.provenance["task.disabledAgents"];
  const resets = (Object.entries(resolution.ifReset) as [SettingsScope, AgentOutcome][]);
  const switchText = (field: "prewalk" | "advisor", effective?: { value: string; from: string }): string => effective ? `In effect: ${effective.value} (from ${effective.from === "definition" ? "the definition" : `the ${effective.from} config`}).` : "In effect: off.";
  return <section className="card detail">
    <div className="card-head">
      <h2>{agent.name}<Badge>{agent.source}</Badge>{agent.disabled && <Badge tone="warning">Disabled</Badge>}{dirty && <Badge tone="warning">Unsaved</Badge>}</h2>
      {agent.hasFile && <button type="button" className="secondary" onClick={() => send({ action: "open-agent", agent: agent.name }, "agent")}><Icon name="go-to-file" />Open definition</button>}
    </div>
    <p className="muted description">{agent.description}</p>
    <div className="effective">
      <div className="eyebrow">This agent runs on</div>
      <div className="effective-line"><span className="big"><ModelChip model={resolution.model} full /></span><Meter thinking={resolution.thinking} /></div>
      <div className="small muted">Prewalk <strong>{resolution.prewalk?.value ?? "off"}</strong>{resolution.prewalk && ` (${resolution.prewalk.from})`} · advisor <strong>{resolution.advisor?.value ?? "off"}</strong>{resolution.advisor && ` (${resolution.advisor.from})`}</div>
      <Unusable agent={agent} snapshot={snapshot} send={send} />
    </div>
    <h3>Decided by <span className="muted small">first match wins</span></h3>
    <Trace steps={resolution.trace} label={`How the model of ${agent.name} was decided`} />
    {resets.length > 0 && <div className="banner inner info" role="status">{resets.map(([from, outcome]) => <div key={from} className="grow small"><strong>If you reset the {LAYER_NAMES[from]} override</strong>: <Outcome outcome={{ source: resolution.source, layer: resolution.layer, model: resolution.model, thinking: resolution.thinking }} /> <Icon name="arrow-right" /> <Outcome outcome={outcome} /> <span className="muted">({outcome.source === "override" ? `the ${outcome.layer} override` : outcome.source === "definition" ? "the definition" : "the session's model"})</span></div>)}</div>}
    <form onSubmit={event => { event.preventDefault(); save(); }}>
      <h3>Overrides</h3>
      {writable.length > 1
        ? <label className="inline-label">Save to<select aria-label="Agent override write scope" value={layer} disabled={dirty} title={dirty ? "Save or discard pending changes first" : undefined} onChange={event => onDraft(base(event.target.value as SettingsScope))}>
          <option value="project">Project config · this folder</option><option value="global">Global config · active profile</option></select></label>
        : <p className="small muted">Saved to the global config. To save project overrides, choose a project folder in the scope control.</p>}
      <label className="check"><input type="checkbox" aria-label={`${agent.name} enabled`} checked={current.enabled} disabled={layer === "project" && !current.dirty.includes("enabled")} onChange={event => set("enabled", event.target.checked)} />Enabled</label>
      <p className="small muted">{layer === "project" ? "The disabled list is global-only: switch Save to to Global config to change it." : "Saved in the global disabled list."}{disabledSource && !["default", "global"].includes(disabledSource) ? ` The effective list comes from the ${disabledSource} config.` : ""}</p>
      <div className="field-head"><span className="field-title">Model override</span><span className="small muted grow">{layer} config · tried in order</span>{clear("model", "model")}</div>
      <OrderedList label={`${agent.name} model override, tried in order`} entries={current.model} onChange={next => set("model", next)} empty="No override: the definition or the session's model decides."
        describe={entry => <EntryStatusText entry={entry} snapshot={snapshot} />} />
      <div className="toolbar"><button type="button" className="secondary" onClick={() => void addModel()}><Icon name="add" />Add model or role…</button></div>
      <p className="small muted">{(["project", "global"] as const).filter(item => resolution.overrides[item] !== undefined && (item === "global" || folder !== null)).map(item => `${item}: ${resolution.overrides[item]}`).join(" · ") || "No override in any layer, so the definition or the session's model decides."}</p>
      <div className="field-pair">
        <ModelSwitch label="Prewalk" purpose="prewalk" value={current.prewalk} onChange={value => set("prewalk", value)} pick={pick} fallback="@smol" effective={switchText("prewalk", resolution.prewalk)} />{clear("prewalk", "prewalk")}
      </div>
      <div className="field-pair">
        <ModelSwitch label="Advisor" purpose="advisor" value={current.advisor} onChange={value => set("advisor", value)} pick={pick} fallback="@advisor" effective={switchText("advisor", resolution.advisor)} />{clear("advisor", "advisor")}
      </div>
      <div className="toolbar"><button type="submit" disabled={!dirty}>Save overrides</button>{dirty && <button type="button" className="secondary" onClick={() => onDraft(undefined)}>Discard changes</button>}</div>
      <InlineStatus origin="agent" />
    </form>
    <details><summary>Definition (read-only)</summary>
      <dl className="small"><dt>Model</dt><dd><Chain items={typeof agent.model === "string" ? [agent.model] : agent.model ?? []} empty="Not set" /></dd>
        <dt>Prewalk</dt><dd><code>{agent.prewalk === undefined ? "Not set" : String(agent.prewalk === true ? "on" : agent.prewalk === false ? "off" : agent.prewalk)}</code></dd>
        <dt>Advisor</dt><dd><code>{agent.advisor === undefined ? "Not set" : String(agent.advisor === true ? "on" : agent.advisor === false ? "off" : agent.advisor)}</code></dd>
        <dt>Thinking level</dt><dd><code>{agent.thinkingLevel ?? "Not set"}</code></dd></dl>
      <h3>System prompt</h3><pre className="scroll">{agent.systemPrompt}</pre>
    </details>
  </section>;
}
