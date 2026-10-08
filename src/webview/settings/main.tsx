import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { isRecord } from "../../guards";
import type { ConfigEdit, SettingsAgent, SettingsRole, SettingsScope, SettingsSnapshot } from "../../host/omp-settings-core";
import type { SettingsAction, SettingsMessage } from "./messages";
import { at, filteredModels, lines, roleChange, selectorBase, text } from "./model";
import { SETTINGS_CSS } from "./styles";

declare function acquireVsCodeApi(): { postMessage(message: SettingsAction): void; setState(state: { key: string }): void };
const vscode = acquireVsCodeApi();
type ActionRequest<T = SettingsAction> = T extends SettingsAction ? Omit<T, "requestId"> : never;
type Send = (action: ActionRequest) => void;
interface SurfaceProps { snapshot: SettingsSnapshot; send: Send; busy: boolean }
function useHost() {
  const [init, setInit] = useState<Extract<SettingsMessage, { type: "settings:init" }>>();
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<Extract<SettingsMessage, { type: "settings:preview" }>["spec"]>(null);
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState({ ok: true, message: "Reading the installed OMP settings…" });
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      // The paired host owns this named IPC contract; unrelated window messages are ignored.
      if (!isRecord(event.data) || typeof event.data.type !== "string") return;
      const message = event.data as unknown as SettingsMessage;
      switch (message.type) {
        case "settings:init": setInit(message); vscode.setState({ key: message.key }); break;
        case "settings:snapshot": setSnapshot(message.snapshot); setRevision(value => value + 1); break;
        case "settings:preview": setPreview(message.spec); break;
        case "settings:result": setBusy(false); setStatus({ ok: message.ok, message: message.message }); break;
      }
    };
    window.addEventListener("message", receive);
    vscode.postMessage({ action: "ready", requestId: crypto.randomUUID() });
    return () => window.removeEventListener("message", receive);
  }, []);
  const send: Send = action => { if (busy) return; setBusy(true); setStatus({ ok: true, message: action.action === "generate" ? "OMP is generating the agent specification…" : "Working…" }); vscode.postMessage({ ...action, requestId: crypto.randomUUID() }); };
  return { init, snapshot, revision, preview, busy, status, send };
}
function App() {
  const host = useHost();
  const [section, setSection] = useState("roles");
  const kind = host.init?.kind;
  useEffect(() => setSection(kind === "agents" ? "agents" : "roles"), [kind]);
  const snapshot = host.snapshot;
  return <main aria-busy={host.busy}>
    <div className="header"><div><h1>OMP {kind === "agents" ? "Agents" : "Models"}</h1><span className="muted">Native configuration · installed OMP</span></div>
      <div className="toolbar"><button className="secondary" disabled={host.busy} onClick={() => host.send({ action: "reload" })}>Reload</button>
        {snapshot && <><button className="secondary" disabled={host.busy} onClick={() => host.send({ action: "open-config", scope: "global" })}>Global config</button><button className="secondary" disabled={host.busy} onClick={() => host.send({ action: "open-config", scope: "project" })}>Project config</button></>}</div></div>
    {snapshot && <div className="context small muted"><div>Profile <strong>{snapshot.profile}</strong> · <code>{snapshot.cwd}</code></div><div>Global: <code>{snapshot.globalFile}</code></div><div>Project: <code>{snapshot.projectFile}</code></div>{kind === "agents" && <><div>New user agent: <code>{snapshot.agentDirectories.global}</code></div><div>New project agent: <code>{snapshot.agentDirectories.project}</code></div></>}</div>}
    <div role="status" aria-live="polite" className={`status ${host.status.ok ? "muted" : "error"}`}>{host.status.message}</div>
    {snapshot && <>
      <div className="notice small">Changes configure plain OMP too. YAML saves preserve unknown values but remove comments, matching OMP. Persisted and effective values may differ because of higher-priority settings. Existing children and the current session model are not changed by saving.</div>
      <nav className="tabs" role="tablist" aria-label="Settings sections">{(kind === "agents" ? [["agents", "Agents"], ["new", "New agent"]] : [["roles", "Roles & routing"], ["browse", "Model browser"], ["presets", "Presets"]]).map(([id, label]) => <button key={id} role="tab" aria-selected={section === id} onClick={() => setSection(id!)}>{label}</button>)}</nav>
      <fieldset disabled={host.busy} key={host.revision}>
        {kind === "models" && section === "roles" && <ModelsRoles snapshot={snapshot} send={host.send} busy={host.busy} />}
        {kind === "models" && section === "browse" && <ModelBrowser snapshot={snapshot} send={host.send} busy={host.busy} />}
        {kind === "models" && section === "presets" && <Presets snapshot={snapshot} send={host.send} busy={host.busy} />}
        {kind === "agents" && section === "agents" && <Agents snapshot={snapshot} send={host.send} busy={host.busy} />}
        {kind === "agents" && section === "new" && <NewAgent send={host.send} preview={host.preview} />}
      </fieldset>
      {kind === "models" && <div className="card"><h3>Current session</h3><p className="small muted">Saving does not switch an existing model. This explicit action applies the effective default only to the launching Chat, while its identity remains live and idle. Auto thinking and upstream routing are not representable by RPC.</p>
        <button disabled={host.busy || !host.init?.canApply} onClick={() => host.send({ action: "apply-default" })}>Apply default to {host.init?.sessionLabel ?? "launching Chat"}</button>
        {!host.init?.canApply && <p className="small muted">Open Models with /models from a running Chat to bind this action.</p>}</div>}
    </>}
  </main>;
}
function ModelSuggestions({ snapshot, id, accepts }: { snapshot: SettingsSnapshot; id: string; accepts?: readonly string[] }) {
  const accepted = useMemo(() => accepts ? new Set(accepts) : undefined, [accepts]);
  return <datalist id={id}>{snapshot.models.filter(model => model.available && (!accepted || accepted.has(`${model.provider}/${model.id}`))).map(model => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}{snapshot.roles.map(role => <option key={`role:${role.id}`} value={`@${role.id}`} />)}</datalist>;
}
function ModelsRoles(props: SurfaceProps) {
  const { snapshot, send } = props;
  const [selected, setSelected] = useState("default");
  const [custom, setCustom] = useState("");
  const [draftRole, setDraftRole] = useState<SettingsRole>();
  const [roleError, setRoleError] = useState("");
  const projectAllowed = snapshot.effective.modelRoleStorage === "project";
  const [scope, setScope] = useState<SettingsScope>(projectAllowed ? "project" : "global");
  const roles = draftRole && !snapshot.roles.some(role => role.id === draftRole.id) ? [...snapshot.roles, draftRole] : snapshot.roles;
  const role = roles.find(role => role.id === selected) ?? roles[0];
  return <>
    <div className="toolbar"><label>Role storage <select aria-label="Role write scope" value={scope} onChange={event => setScope(event.target.value as SettingsScope)}><option value="global">Global · active profile</option>{projectAllowed && <option value="project">Project · this folder</option>}</select></label><span className="muted small">Native modelRoleStorage: {String(snapshot.effective.modelRoleStorage)} ({snapshot.provenance.modelRoleStorage})</span></div>
    <div className="grid"><section className="card"><h2>Model roles</h2><div className="list">{roles.map(item => <button className={selected === item.id ? "selected" : ""} key={item.id} onClick={() => setSelected(item.id)}><strong>{item.id}</strong><span className="small">{item.resolved ?? item.selector ?? "Automatic"}</span><span className="small muted">{item.source} · {item.thinking ?? "native thinking"}</span></button>)}</div>
      <form onSubmit={event => { event.preventDefault(); const id = custom.trim(); if (!/^[a-zA-Z][\w-]*$/.test(id)) { setRoleError("Use a letter, then letters, digits, - or _."); return; } setDraftRole({ id, name: id, section: "Custom", source: "default", accepts: snapshot.models.filter(model => model.available && model.kind === "chat").map(model => `${model.provider}/${model.id}`), defaults: [] }); setSelected(id); setCustom(""); setRoleError(""); }}><label>Custom role <input className="wide" aria-label="Custom role name" value={custom} onChange={event => setCustom(event.target.value)} /></label><button className="secondary" type="submit">Add role</button><span className="small error">{roleError}</span></form></section>
      {role && <RoleEditor key={`${role.id}:${scope}`} {...props} role={role} scope={scope} />}</div>
    <Cycle {...props} /><Fallback {...props} />
  </>;
}
function RoleEditor({ snapshot, role, scope, send }: SurfaceProps & { role: SettingsRole; scope: SettingsScope }) {
  const persisted = at(snapshot[scope], ["modelRoles", role.id]);
  const [selector, setSelector] = useState(typeof persisted === "string" ? persisted : role.selector ?? "");
  const [effort, setEffort] = useState("");
  const model = snapshot.models.find(model => `${model.provider}/${model.id}` === selectorBase(selector)) ?? snapshot.models.find(model => `${model.provider}/${model.id}` === role.resolved);
  const save = (clear = false): void => send({ action: "save", scope, ...roleChange(role.id, clear ? "" : selector, effort, scope) });
  return <section className="card"><h2>{role.name} <span className="badge">{role.id}</span></h2><div className="kv small"><span>Persisted ({scope})</span><code>{persisted === null ? "Cleared (tombstone)" : text(persisted) || "Not set"}</code><span>Effective selector</span><code>{role.selector ?? "Automatic"}</code><span>Resolved model</span><code>{role.resolved ?? "Automatic / unavailable"}</code><span>Effective source</span><span>{role.source}</span><span>Effective thinking</span><span>{role.thinking ?? String(snapshot.effective.defaultThinkingLevel ?? "native default")}</span></div>
    <form onSubmit={event => { event.preventDefault(); save(); }}><label>Model selector<input className="wide" list="role-models" aria-label={`${role.id} model selector`} value={selector} onChange={event => setSelector(event.target.value)} placeholder="provider/model, @role or native pattern" /></label><ModelSuggestions snapshot={snapshot} id="role-models" accepts={role.accepts} />
      <label>Thinking selector<select aria-label={`${role.id} thinking effort`} disabled={!selector.trim() || !model?.reasoning} value={effort} onChange={event => setEffort(event.target.value)}><option value="">Keep entered selector</option>{[...new Set(["inherit", "auto", "off", ...(model?.efforts ?? [])])].map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>
      <p className="small muted">{role.id === "default" ? "Auto removes the selector suffix and saves global defaultThinkingLevel=auto. Project roles and global thinking are separate transactions." : "Thinking is saved as a suffix on this role's selector."}</p>
      <div className="toolbar"><button type="submit">Save role</button><button className="secondary" type="button" onClick={() => save(true)}>Clear {scope} assignment</button></div></form>
    {role.defaults.length > 0 && <details><summary className="small">Native priority defaults</summary><pre>{role.defaults.join("\n")}</pre></details>}
  </section>;
}
function Cycle({ snapshot, send }: SurfaceProps) {
  const effective = lines(text(snapshot.effective.cycleOrder));
  const [order, setOrder] = useState(effective);
  const [add, setAdd] = useState("default");
  const move = (index: number, step: number): void => { const next = [...order]; const other = index + step; if (other < 0 || other >= next.length) return; [next[index], next[other]] = [next[other]!, next[index]!]; setOrder(next); };
  return <section className="card"><h2>Model cycle order <span className="badge">Global</span></h2><p className="small muted">Effective source: {snapshot.provenance.cycleOrder}. Persisted global: {text(snapshot.global.cycleOrder).replace(/\n/g, " → ") || "Not set"}. Role order drives OMP's model cycling.</p>
    {order.map((role, index) => <div className="rows" key={`${role}:${index}`}><code>{index + 1}. {role}</code><button className="secondary" aria-label={`Move ${role} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button><button className="secondary" aria-label={`Move ${role} down`} disabled={index === order.length - 1} onClick={() => move(index, 1)}>↓</button><button className="secondary" onClick={() => setOrder(order.filter((_, i) => i !== index))}>Remove</button></div>)}
    <div className="toolbar"><select aria-label="Role to add to cycle" value={add} onChange={event => setAdd(event.target.value)}>{snapshot.roles.map(role => <option key={role.id}>{role.id}</option>)}</select><button className="secondary" onClick={() => { if (!order.includes(add)) setOrder([...order, add]); }}>Add</button><button onClick={() => send({ action: "save", scope: "global", edits: [{ path: ["cycleOrder"], value: order }] })}>Save order</button><button className="secondary" onClick={() => send({ action: "save", scope: "global", edits: [{ path: ["cycleOrder"] }] })}>Reset global order</button></div>
  </section>;
}
function Fallback({ snapshot, send }: SurfaceProps) {
  const effective = at(snapshot.effective, ["retry", "fallbackChains"]);
  const [key, setKey] = useState("default");
  const [chain, setChain] = useState(text(at(snapshot.effective, ["retry", "fallbackChains", "default"])));
  const [candidate, setCandidate] = useState("");
  const keys = isRecord(effective) ? Object.keys(effective) : [];
  return <section className="card"><h2>Retry fallback chains <span className="badge">Global</span></h2><p className="small muted">Keys may name a role, an exact model, a provider wildcard or *. One selector per line; top-to-bottom order is preserved. Effective record source: {snapshot.provenance["retry.fallbackChains"]}.</p>
    <label>Chain key<input list="fallback-keys" value={key} onChange={event => { setKey(event.target.value); setChain(text(at(snapshot.effective, ["retry", "fallbackChains", event.target.value]))); }} /></label><datalist id="fallback-keys">{[...new Set(["*", ...snapshot.roles.map(role => role.id), ...snapshot.providers.map(provider => `${provider.id}/*`), ...keys])].map(key => <option key={key}>{key}</option>)}</datalist>
    <p className="small muted">Persisted global: {text(at(snapshot.global, ["retry", "fallbackChains", key])).replace(/\n/g, " → ") || "Not set"}</p><textarea aria-label="Ordered fallback selectors" value={chain} onChange={event => setChain(event.target.value)} />
    <div className="toolbar"><input aria-label="Model to append to fallback" list="fallback-models" value={candidate} onChange={event => setCandidate(event.target.value)} placeholder="Model selector" /><ModelSuggestions snapshot={snapshot} id="fallback-models" /><button className="secondary" onClick={() => { if (candidate.trim()) { setChain([...lines(chain), candidate.trim()].join("\n")); setCandidate(""); } }}>Append</button><button disabled={!key.trim()} onClick={() => send({ action: "save", scope: "global", edits: [{ path: ["retry", "fallbackChains", key.trim()], ...(lines(chain).length ? { value: lines(chain) } : {}) }] })}>Save chain</button><button className="secondary" disabled={!key.trim()} onClick={() => send({ action: "save", scope: "global", edits: [{ path: ["retry", "fallbackChains", key.trim()] }] })}>Clear global chain</button></div>
  </section>;
}
function Presets({ snapshot, send }: SurfaceProps) {
  const [name, setName] = useState(snapshot.activePreset ?? snapshot.presetNames[0] ?? "");
  return <section className="card"><h2>Saved model presets <span className="badge">Global saves</span></h2><p className="muted small">Active: {snapshot.activePreset ?? "No exact match"}. Saving captures complete effective role assignments and default thinking. Applying uses native role storage, validates the effective default before writing and clears assignments the preset leaves out. Session application remains a separate action.</p>
    <label>Preset name<input aria-label="Preset name" list="presets" value={name} onChange={event => setName(event.target.value)} /></label><datalist id="presets">{snapshot.presetNames.map(name => <option key={name}>{name}</option>)}</datalist>
    <div className="toolbar"><button disabled={!name} onClick={() => send({ action: "preset", operation: "save", name })}>Save current as preset</button><button disabled={!snapshot.presetNames.includes(name)} onClick={() => send({ action: "preset", operation: "switch", name })}>Apply preset</button><button className="secondary" disabled={!isRecord(snapshot.global.modelPresets) || !Object.hasOwn(snapshot.global.modelPresets, name)} onClick={() => send({ action: "preset", operation: "delete", name })}>Delete global preset</button></div>
    <div className="spacer" /><h3>Persisted global entry</h3><pre>{JSON.stringify(at(snapshot.global, ["modelPresets", name]), null, 2) ?? "Not set"}</pre><h3>Effective entry</h3><pre>{JSON.stringify(at(snapshot.effective, ["modelPresets", name]), null, 2) ?? "Not set"}</pre><p className="small muted">Record source: {snapshot.provenance.modelPresets}. Same-name entries are owned whole by their highest-priority source. Inherited presets must be deleted in their source config.</p>
  </section>;
}
function ModelBrowser({ snapshot, send }: SurfaceProps) {
  const [query, setQuery] = useState(""); const [provider, setProvider] = useState(""); const [kind, setKind] = useState(""); const [recent, setRecent] = useState(false); const [page, setPage] = useState(0);
  const models = useMemo(() => filteredModels(snapshot.models, query, provider, kind, recent), [snapshot.models, query, provider, kind, recent]);
  const filtered = models.slice(page * 100, page * 100 + 100);
  const selectedProvider = snapshot.providers.find(item => item.id === provider);
  return <><section className="card"><h2>Model browser</h2><div className="toolbar"><input aria-label="Search models" value={query} placeholder="Search models and providers" onChange={event => { setQuery(event.target.value); setPage(0); }} /><select aria-label="Filter model provider" value={provider} onChange={event => { setProvider(event.target.value); setPage(0); }}><option value="">All providers</option>{snapshot.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.id} · {provider.status}</option>)}</select><select aria-label="Filter model kind" value={kind} onChange={event => { setKind(event.target.value); setPage(0); }}><option value="">All kinds</option>{[...new Set(snapshot.models.map(model => model.kind))].sort().map(kind => <option key={kind}>{kind}</option>)}</select><label className="small"><input type="checkbox" checked={recent} onChange={event => { setRecent(event.target.checked); setPage(0); }} /> Recent only</label></div>
    <p className="small muted">{models.length} models{selectedProvider ? ` · ${selectedProvider.id}: ${selectedProvider.status}` : ""}. Availability reflects configured credentials and native provider/membership filters.</p>
    <div className="notice small">Refresh is an explicit network/command-credential operation. OMP's own AuthStorage may migrate credentials or persist rotated tokens, just as the TUI does. Refreshed catalogue data stays in this editor's private cache. Login runs only in a visible native OMP terminal.</div>
    <div className="toolbar"><button onClick={() => send({ action: "refresh", ...(provider ? { provider } : {}) })}>Refresh {provider || "providers"}</button><button className="secondary" onClick={() => send({ action: "login", ...(provider ? { provider } : {}) })}>Login {provider || "provider"}</button></div>
    <table><thead><tr><th>Model</th><th>Provider / kind</th><th>Availability</th><th>Metadata</th></tr></thead><tbody>{filtered.map(model => <tr key={`${model.provider}/${model.id}`}><td><strong>{model.name}</strong><div className="small"><code>{model.id}</code></div></td><td>{model.provider}<div className="small muted">{model.kind}</div></td><td>{model.available ? "Available" : "Locked / filtered"}{model.recent >= 0 && <div className="small muted">Recent #{model.recent + 1}</div>}</td><td className="small"><div>Context {model.contextWindow?.toLocaleString() ?? "—"} · output {model.maxTokens?.toLocaleString() ?? "—"}</div><div className="muted">Input: {model.input?.join(", ") ?? "—"} · thinking: {model.efforts.join(", ") || "none"}</div><details><summary>Cost / performance / routing</summary><pre>{JSON.stringify({ cost: model.cost, performance: model.perf, upstreams: model.upstreams }, null, 2)}</pre></details></td></tr>)}</tbody></table>
    {!models.length && <div className="empty">No models match these filters.</div>}<div className="toolbar"><button className="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span className="small muted">{models.length ? page * 100 + 1 : 0}–{Math.min((page + 1) * 100, models.length)} of {models.length}</span><button className="secondary" disabled={(page + 1) * 100 >= models.length} onClick={() => setPage(page + 1)}>Next</button></div>
  </section><section className="card"><h3>Native browser preferences (read-only)</h3><p className="small muted">The installed model hub does not mutate these preferences. Path-scoped entries are retained; use their source config to change them.</p>{["modelProviderOrder", "enabledModels", "enabledProviders", "disabledProviders", "modelRoleStorage"].map(key => <details key={key}><summary>{key} · {snapshot.provenance[key]}</summary><pre>{JSON.stringify({ global: snapshot.global[key], project: snapshot.project[key], effective: snapshot.effective[key] }, null, 2)}</pre></details>)}</section></>;
}
function Agents(props: SurfaceProps) {
  const [query, setQuery] = useState(""); const [source, setSource] = useState(""); const [selected, setSelected] = useState(props.snapshot.agents[0]?.name ?? "");
  const agents = props.snapshot.agents.filter(agent => (!source || agent.source === source) && `${agent.name} ${agent.description}`.toLowerCase().includes(query.toLowerCase()));
  const agent = agents.find(agent => agent.name === selected) ?? agents[0];
  return <><div className="toolbar"><input aria-label="Search agents" placeholder="Search agents" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="Filter agent source" value={source} onChange={event => setSource(event.target.value)}><option value="">All sources</option>{[...new Set(props.snapshot.agents.map(agent => agent.source))].map(source => <option key={source}>{source}</option>)}</select><span className="small muted">{agents.length} discovered agents · project → user → plugin → bundled precedence</span></div><div className="spacer" /><div className="grid"><section className="card"><h2>Agents</h2><div className="list">{agents.map(item => <button key={item.name} className={item.name === agent?.name ? "selected" : ""} onClick={() => setSelected(item.name)}><strong>{item.name}</strong><span className="small">{item.description}</span><span className="small muted">{item.source} · {item.disabled ? "Disabled" : "Enabled"}</span></button>)}</div>{!agents.length && <div className="empty">No discovered agents match.</div>}</section>{agent && <AgentEditor key={agent.name} {...props} agent={agent} />}</div></>;
}
function AgentEditor({ snapshot, send, agent }: SurfaceProps & { agent: SettingsAgent }) {
  const [enabled, setEnabled] = useState(!agent.disabled);
  const [model, setModel] = useState(text(at(snapshot.global, ["task", "agentModelOverrides", agent.name])));
  const [prewalk, setPrewalk] = useState(text(at(snapshot.global, ["task", "agentPrewalk", agent.name])));
  const [advisor, setAdvisor] = useState(text(at(snapshot.global, ["task", "agentAdvisor", agent.name])));
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const mark = (key: string): void => setDirty(previous => new Set([...previous, key]));
  const clear = (setting: string): void => send({ action: "save", scope: "global", edits: [{ path: ["task", setting, agent.name] }] });
  const save = (): void => {
    const edits: ConfigEdit[] = [];
    if (dirty.has("enabled")) {
      const disabled = lines(text(at(snapshot.effective, ["task", "disabledAgents"]))).filter(name => name !== agent.name);
      if (!enabled) disabled.push(agent.name);
      edits.push({ path: ["task", "disabledAgents"], value: disabled });
    }
    for (const [setting, value] of [["agentModelOverrides", model], ["agentPrewalk", prewalk], ["agentAdvisor", advisor]] as const) {
      if (!dirty.has(setting)) continue;
      const patterns = lines(value);
      edits.push({ path: ["task", setting, agent.name], ...(patterns.length ? { value: setting === "agentModelOverrides" ? patterns.length === 1 ? patterns[0] : patterns : value.trim() } : {}) });
    }
    send({ action: "save", scope: "global", edits });
  };
  return <section className="card"><h2>{agent.name} <span className="badge">{agent.source}</span><p className="muted small">{agent.description}</p></h2><div className="kv small"><span>Effective model</span><code>{agent.effectiveModel.join(" → ") || "Native task role"}</code><span>Resolved model</span><code>{agent.resolvedModel ?? "Native automatic / unavailable"}</code><span>Effective prewalk</span><code>{agent.effectivePrewalk ?? "Off"}</code><span>Effective advisor</span><code>{agent.effectiveAdvisor ?? "Off"}</code><span>Effective enabled</span><span>{agent.disabled ? "Disabled" : "Enabled"}</span></div>
    <form onSubmit={event => { event.preventDefault(); save(); }}><label><input type="checkbox" aria-label={`${agent.name} enabled`} checked={enabled} onChange={event => { setEnabled(event.target.checked); mark("enabled"); }} /> Enabled <span className="muted small">Global disabled-list override; effective source: {snapshot.provenance["task.disabledAgents"]}</span></label>
      <label>Global model override<textarea aria-label={`${agent.name} model override`} value={model} onChange={event => { setModel(event.target.value); mark("agentModelOverrides"); }} placeholder="One native pattern per line; blank inherits" /></label><div className="toolbar"><input list="agent-patterns" aria-label="Suggested agent model pattern" placeholder="Model or @role suggestion" onChange={event => { setModel(event.target.value); mark("agentModelOverrides"); }} /><button className="secondary" type="button" onClick={() => clear("agentModelOverrides")}>Clear global model</button></div><ModelSuggestions snapshot={snapshot} id="agent-patterns" /><p className="small muted">Effective override: {agent.overrideModel ?? "definition / task role"} · record source: {snapshot.provenance["task.agentModelOverrides"]}</p>
      <label>Global prewalk override<input className="wide" list="agent-switches" aria-label={`${agent.name} prewalk override`} value={prewalk} onChange={event => { setPrewalk(event.target.value); mark("agentPrewalk"); }} placeholder="Blank inherits; on, off, @role or model pattern" /></label><button className="secondary" type="button" onClick={() => clear("agentPrewalk")}>Clear global prewalk</button><p className="small muted">Effective override: {agent.prewalkOverride ?? "definition / inherited"} · record source: {snapshot.provenance["task.agentPrewalk"]}</p>
      <label>Global advisor override<input className="wide" list="agent-switches" aria-label={`${agent.name} advisor override`} value={advisor} onChange={event => { setAdvisor(event.target.value); mark("agentAdvisor"); }} placeholder="Blank inherits; on, off, @role or model pattern" /></label><button className="secondary" type="button" onClick={() => clear("agentAdvisor")}>Clear global advisor</button><p className="small muted">Effective override: {agent.advisorOverride ?? "definition / inherited"} · record source: {snapshot.provenance["task.agentAdvisor"]}</p><datalist id="agent-switches"><option>on</option><option>off</option>{snapshot.roles.map(role => <option key={role.id}>@{role.id}</option>)}{snapshot.models.filter(model => model.available).map(model => <option key={`${model.provider}/${model.id}`}>{model.provider}/{model.id}</option>)}</datalist>
      <button type="submit" disabled={!dirty.size}>Save agent overrides</button></form><details><summary>Definition and system prompt (read-only)</summary><pre>{JSON.stringify({ model: agent.model, prewalk: agent.prewalk, advisor: agent.advisor }, null, 2)}</pre><pre>{agent.systemPrompt}</pre>{agent.hasFile && <button className="secondary" onClick={() => send({ action: "open-agent", agent: agent.name })}>Open definition in VS Code</button>}</details>
  </section>;
}
function NewAgent({ send, preview }: { send: Send; preview: Extract<SettingsMessage, { type: "settings:preview" }>["spec"] }) {
  const [description, setDescription] = useState(""); const [scope, setScope] = useState<SettingsScope>("project");
  return <section className="card"><h2>Generate a new agent</h2><div className="notice small">Generate calls the configured provider using OMP's architect prompts, records native usage and may refresh catalogues and persist rotated credentials through OMP's own AuthStorage. It creates no history session. No provider call runs when this tab opens.</div>
    <form onSubmit={event => { event.preventDefault(); send({ action: "generate", description }); }}><label>Describe the agent<textarea aria-label="Agent creation request" maxLength={32_000} value={description} onChange={event => setDescription(event.target.value)} placeholder="What should this agent specialize in, and when should it be used?" /></label><button disabled={!description.trim()} type="submit">Generate specification</button></form>
    {preview && <><div className="spacer" /><h3>Review generated specification (read-only)</h3><label>Identifier<input className="wide" readOnly value={preview.identifier} /></label><label>When to use<textarea readOnly value={preview.whenToUse} /></label><label>System prompt<textarea rows={14} readOnly value={preview.systemPrompt} /></label><label>Destination<select aria-label="New agent destination" value={scope} onChange={event => setScope(event.target.value as SettingsScope)}><option value="project">Project · this folder's .omp/agents</option><option value="global">User · active OMP profile</option></select></label><p className="small muted">Existing files are never overwritten. Creating this folder's .omp/agents can shadow an ancestor project's agents directory, matching native OMP discovery.</p><button onClick={() => send({ action: "create", scope })}>Create agent Markdown</button></>}
  </section>;
}
const style = document.createElement("style");
style.nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? "";
style.textContent = SETTINGS_CSS;
document.head.appendChild(style);
const root = document.getElementById("root");
if (!root) throw new Error("The settings page container is missing.");
createRoot(root).render(<App />);
