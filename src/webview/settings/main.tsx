import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isRecord } from "../../shared/guards";
import type { SettingsScope, SettingsSnapshot } from "../../protocol/settings-model";
import type { SessionApply, SettingsAction, SettingsMessage } from "../../protocol/settings-messages";
import { at, compactCount, count, displayValue, filteredModels, patternList, perfLabel, priceLabel, problems, providerStatus, sameList, sourceLabel } from "./model";
import { SETTINGS_CSS } from "./styles";
import { Badge, Icon, IconButton, InlineStatus, ListBox, NAME_HINT, NAME_PATTERN, OrderedList, Panel, StatusContext, Tabs } from "./common";
import type { ConfigExists, Init, Pick, Preview, Send, Status, SurfaceProps } from "./common";
import { Agents } from "./agents";
import { HealthBanner } from "./health";
import { ModelsRoles } from "./roles";

declare function acquireVsCodeApi(): { postMessage(message: SettingsAction): void; setState(state: { key: string }): void };
const vscode = acquireVsCodeApi();
const PAGE = 100;
const PENDING: Partial<Record<SettingsAction["action"], string>> = {
  generate: "OMP is generating the agent specification…", refresh: "Refreshing the provider catalogue…", reload: "Reloading…", save: "Saving…", preset: "Saving…",
  "assign-role": "Choose in the picker; the role is saved when you pick…", "pick-model": "Choose in the picker…", "pick-chain-key": "Choose in the picker…", "pick-scope": "Choose the scope in the picker…",
};

const focusLabel = (element: Element): string => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
function useHost() {
  const [init, setInit] = useState<Init>();
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [configExists, setConfigExists] = useState<ConfigExists>({ global: false, project: false });
  const [revision, setRevision] = useState(0);
  const [session, setSession] = useState<SessionApply | null>(null);
  const [preview, setPreview] = useState<Preview>(null);
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState<Status>({ ok: true, pending: true, message: "Reading the installed OMP settings…" });
  // A pick resolves on its request's result, so a follow-up action is never refused as still running.
  const busyRef = useRef(true);
  const picks = useRef(new Map<string, { value: string | null; resolve(value: string | null): void }>());
  const focus = useRef<{ tag: string; label: string; origin?: string } | undefined>(undefined);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      // The paired host owns this named IPC contract; unrelated window messages are ignored.
      if (!isRecord(event.data) || typeof event.data.type !== "string") return;
      const message = event.data as unknown as SettingsMessage;
      switch (message.type) {
        case "settings:init": setInit(message); vscode.setState({ key: message.key }); break;
        case "settings:snapshot": setSnapshot(message.snapshot); setConfigExists(message.configExists); setSession(message.session ?? null); setRevision(value => value + 1); break;
        case "settings:preview": setPreview(message.spec); break;
        // A sign-in outlives the request that started it: its outcome has no request waiting.
        case "settings:notice": setStatus({ ok: message.ok, pending: false, message: message.message }); break;
        case "settings:picked": { const pending = picks.current.get(message.requestId); if (pending) pending.value = message.value; break; }
        case "settings:result": {
          busyRef.current = false;
          setBusy(false); setStatus(previous => ({ ok: message.ok, pending: false, message: message.message, origin: previous.origin }));
          const pending = picks.current.get(message.requestId);
          if (pending) { picks.current.delete(message.requestId); pending.resolve(message.ok ? pending.value : null); }
          break;
        }
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
    if (busyRef.current) return undefined;
    const active = document.activeElement;
    focus.current = active && active !== document.body ? { tag: active.tagName, label: focusLabel(active), origin } : undefined;
    busyRef.current = true;
    setBusy(true);
    setStatus({ ok: true, pending: true, origin, message: PENDING[action.action] ?? "Working…" });
    const requestId = crypto.randomUUID();
    vscode.postMessage({ ...action, requestId });
    return requestId;
  };
  const pick: Pick = (action, origin) => {
    const { promise, resolve } = Promise.withResolvers<string | null>();
    const requestId = send(action, origin);
    if (requestId === undefined) resolve(null); else picks.current.set(requestId, { value: null, resolve });
    return promise;
  };
  return { init, snapshot, configExists, session, revision, preview, busy, status, send, pick };
}
const MODEL_SECTIONS = [["roles", "Roles & routing"], ["browse", "Model browser"], ["presets", "Presets"]] as const;
const AGENT_SECTIONS = [["agents", "Agents"], ["new", "New agent"]] as const;
function App() {
  const host = useHost();
  const kind = host.init?.kind;
  const folder = host.init?.folder ?? null;
  const [section, setSection] = useState("roles");
  useEffect(() => setSection(kind === "agents" ? "agents" : "roles"), [kind]);
  const { snapshot } = host;
  const folderName = folder?.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
  const config = (scope: SettingsScope) => {
    const file = snapshot?.[scope === "global" ? "globalFile" : "projectFile"];
    return <button type="button" className="secondary" disabled={host.busy || !host.configExists[scope]} title={host.configExists[scope] ? file : `No ${scope} config exists yet (${file}); saving creates it.`}
      onClick={() => host.send({ action: "open-config", scope })}><Icon name="go-to-file" />{scope === "global" ? "Global config" : "Project config"}</button>;
  };
  const surface = snapshot && { snapshot, send: host.send, pick: host.pick, revision: host.revision, folder };
  return <StatusContext.Provider value={host.status}><main aria-busy={host.busy}>
    {host.busy && <div className="progress" aria-hidden="true" />}
    <header className="header">
      <div><h1>{kind === "agents" ? "Agents" : kind === "models" ? "Models" : "OMP settings"}</h1>
        {snapshot && <div className="muted small">OMP profile <strong>{snapshot.profile}</strong> · {folder === null ? kind === "agents" ? "global config, user and bundled agents" : "global config, no project layer" : <>project folder <span title={folder}>{folderName}</span></>}</div>}</div>
      <div className="toolbar">
        {host.init && <button type="button" className="secondary" disabled={host.busy} aria-label={`Scope: ${folder === null ? "Global" : folderName}. Change scope`} title="Show the global scope, or include one project folder's layer and agents"
          onClick={() => host.send({ action: "pick-scope" })}><Icon name={folder === null ? "globe" : "folder"} />{folder === null ? "Global" : folderName}<Icon name="chevron-down" /></button>}
        <button type="button" className="secondary" disabled={host.busy} onClick={() => host.send({ action: "reload" })}><Icon name="refresh" />Reload</button>
        {snapshot && <>{config("global")}{folder !== null && config("project")}</>}
      </div>
    </header>
    {snapshot || host.busy || host.status.ok
      ? <div role="status" className={`status small ${host.status.ok ? "muted" : "error"}`}>{host.status.origin === undefined && host.status.message}</div>
      : <div className="empty" role="alert"><Icon name="error" /><p>{host.status.message || "OMP settings could not be read."}</p><button type="button" onClick={() => host.send({ action: "reload" })}>Try again</button></div>}
    {surface && kind && <>
      <details className="notice small"><summary>Saving writes OMP's own config files, which plain OMP also reads. Running sessions keep their models.</summary>
        <p>Like OMP, saving removes YAML comments and keeps unknown values. Effective values can differ from saved ones when a higher-priority config sets them. Existing subagents are not changed.</p>
        <dl><dt>Global config</dt><dd><code>{surface.snapshot.globalFile}</code></dd>{folder !== null && <><dt>Project config</dt><dd><code>{surface.snapshot.projectFile}</code></dd></>}
          {kind === "agents" && <><dt>New user agents</dt><dd><code>{surface.snapshot.agentDirectories.global}</code></dd>{folder !== null && <><dt>New project agents</dt><dd><code>{surface.snapshot.agentDirectories.project}</code></dd></>}</>}</dl>
      </details>
      <HealthBanner problems={problems(surface.snapshot)} providers={surface.snapshot.providers} send={host.send} />
      <InlineStatus origin="health" />
      <Tabs items={kind === "agents" ? AGENT_SECTIONS : MODEL_SECTIONS} selected={section} onSelect={setSection} />
      <fieldset disabled={host.busy}>
        {kind === "models" ? <>
          <Panel id="roles" section={section}><ModelsRoles {...surface} init={host.init} session={host.session} /></Panel>
          <Panel id="browse" section={section}><ModelBrowser {...surface} /></Panel>
          <Panel id="presets" section={section}><Presets {...surface} /></Panel>
        </> : <>
          <Panel id="agents" section={section}><Agents {...surface} /></Panel>
          <Panel id="new" section={section}><NewAgent send={host.send} preview={host.preview} directories={surface.snapshot.agentDirectories} folder={folder} /></Panel>
        </>}
      </fieldset>
    </>}
  </main></StatusContext.Provider>;
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
function NewAgent({ send, preview, directories, folder }: { send: Send; preview: Preview; directories: SettingsSnapshot["agentDirectories"]; folder: string | null }) {
  const [description, setDescription] = useState(""); const [chosenScope, setScope] = useState<SettingsScope>(folder === null ? "global" : "project");
  // The global scope has no project folder to create agents in.
  const scope = folder === null ? "global" : chosenScope;
  const generate = (): void => { if (description.trim()) send({ action: "generate", description }, "new-agent"); };
  return <section className="card"><h2>Generate a new agent</h2>
    <p className="small muted">Generating calls your configured provider with OMP's architect prompts, records usage like OMP and may refresh catalogues or store rotated credentials through OMP. It creates no history session. Nothing is sent until you choose Generate.</p>
    <form onSubmit={event => { event.preventDefault(); generate(); }}>
      <label>Describe the agent<textarea className="prose" aria-label="Agent creation request" maxLength={32_000} value={description} onChange={event => setDescription(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); generate(); } }} placeholder="What should this agent specialize in, and when should it be used?" /></label>
      {folder === null
        ? <p className="small muted">Destination: user agents of the active OMP profile. Choose a project folder in the scope control to create a project agent.</p>
        : <label>Destination<select aria-label="New agent destination" value={scope} onChange={event => setScope(event.target.value as SettingsScope)}><option value="project">Project · this folder</option><option value="global">User · active OMP profile</option></select></label>}
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
