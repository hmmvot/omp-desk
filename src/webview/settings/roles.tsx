import { useEffect, useState } from "react";
import { isRecord } from "../../shared/guards";
import { modelKey, selectorBase } from "../../protocol/settings-pick-items";
import { roleNote } from "../../protocol/role-notes";
import type { RoleResolution, SettingsRole, SettingsScope, SettingsSnapshot } from "../../protocol/settings-model";
import type { SessionApply } from "../../protocol/settings-messages";
import { at, count, patternList, problems, rolePill, sameList, sessionBlock, sourceLabel, withEntry } from "./model";
import { Badge, EntryStatusText, Icon, InlineStatus, ListBox, Meter, ModelChip, NAME_HINT, NAME_PATTERN, OrderedList, SourcePill, Trace } from "./common";
import type { Init, Pick, Send, SurfaceProps } from "./common";
import { SignIn } from "./health";

const ROLE_GROUPS: Record<string, string> = { chat: "Chat roles", kind: "Specialized roles" };
/** A custom role the user just named: nothing resolves for it until it is saved and the next snapshot arrives. */
function placeholderRole(id: string, models: readonly string[]): SettingsRole {
  const resolution: RoleResolution = { source: "none", follows: [], model: { status: "none" }, thinking: { source: "none" }, trace: [], followers: [], agents: { following: [], overridden: [] } };
  return { id, name: id, section: "custom", accepts: models, defaults: [], resolution };
}
/** The roles a Models page lists: groups of built-in roles, then custom ones, each with its model, thinking level and source. */
export function ModelsRoles(props: SurfaceProps & { init?: Init; session?: SessionApply | null }) {
  const { snapshot, send, revision, folder } = props;
  const [selected, setSelected] = useState("default");
  const [custom, setCustom] = useState("");
  const [draftRole, setDraftRole] = useState<SettingsRole>();
  const [roleError, setRoleError] = useState("");
  const projectAllowed = folder !== null && snapshot.effective.modelRoleStorage === "project";
  const [chosenScope, setScope] = useState<SettingsScope>(projectAllowed ? "project" : "global");
  const scope = projectAllowed ? chosenScope : "global";
  const roles = draftRole && !snapshot.roles.some(role => role.id === draftRole.id) ? [...snapshot.roles, draftRole] : snapshot.roles;
  const role = roles.find(item => item.id === selected) ?? roles[0];
  const assign = (id: string, step: "model" | "thinking" = "model"): void => { send({ action: "assign-role", role: id, scope, step }, "role"); };
  const assigned = snapshot.roles.filter(item => item.resolution.source !== "none" && item.resolution.source !== "builtin" && item.resolution.source !== "inherited").length;
  const options = roles.map(item => ({ id: item.id, group: ROLE_GROUPS[item.section] ?? "Custom roles", title: "Enter or double-click to choose a model", content: <div className="lrow">
    <div className="option-row"><strong>{item.id}</strong>{item.resolution.model.status !== "ok" && item.resolution.model.status !== "none" && <Icon name="warning" />}<span className="push"><SourcePill pill={rolePill(item)} /></span></div>
    <div className="option-row"><ModelChip model={item.resolution.model} /><span className="push"><Meter thinking={item.resolution.thinking} /></span></div>
  </div> }));
  const addRole = (): void => {
    const id = custom.trim();
    if (!NAME_PATTERN.test(id)) { setRoleError(NAME_HINT); return; }
    setDraftRole(placeholderRole(id, snapshot.models.filter(model => model.available && model.kind === "chat").map(modelKey)));
    setSelected(id); setCustom(""); setRoleError("");
    assign(id);
  };
  return <>
    <div className="master-detail">
      <section className="card list-card"><h2>Model roles <span className="muted small">{assigned} of {snapshot.roles.length} assigned</span></h2>
        <ListBox label="Model roles" options={options} selected={role?.id} onSelect={setSelected} onActivate={id => { setSelected(id); assign(id); }} />
        <p className="small muted">Enter or double-click a role to choose its model.</p>
        <form className="add-row" onSubmit={event => { event.preventDefault(); addRole(); }}>
          <input aria-label="New custom role name" placeholder="New custom role" value={custom} onChange={event => setCustom(event.target.value)} aria-invalid={Boolean(roleError)} />
          <button className="secondary" type="submit" disabled={!custom.trim()}><Icon name="add" />Add and choose model…</button>
        </form>
        {roleError && <div className="small error">{roleError}</div>}
      </section>
      {role && <RoleDetail key={`${role.id}:${scope}`} snapshot={snapshot} role={role} scope={scope} projectAllowed={projectAllowed} setScope={setScope} send={send} assign={step => assign(role.id, step)} />}
    </div>
    <CurrentSession init={props.init} session={props.session} send={send} />
    <Cycle key={`cycle:${revision}`} {...props} />
    <Fallback {...props} />
  </>;
}
const LAYER_WORDS: Record<string, string> = { env: "an environment variable", overlay: "a config overlay", project: "the project config", global: "the global config", builtin: "OMP's built-in priority list" };
/** The sentence under "Effective now": where the model comes from, or, for a role with nothing assigned, what OMP does instead. */
function EffectiveNote({ role }: { role: SettingsRole }) {
  const { source, follows, model, thinking, envName } = role.resolution;
  if (source === "none") return <>{roleNote(role.id).summary.replace(/^not assigned · /, "Not assigned: ")}.</>;
  const from = source === "inherited" ? `the role it follows (${follows.map(id => `@${id}`).join(" → ")})` : source === "env" && envName ? `the environment variable ${envName}` : LAYER_WORDS[source] ?? source;
  return <>{model.model || model.wanted ? <>Resolved from {from}.</> : <>Resolved from {from}, which names no model that exists.</>}{thinking.level && <> Thinking level <strong>{thinking.level}</strong> {thinkingFrom(thinking.source)}.</>}</>;
}
const thinkingFrom = (source: RoleResolution["thinking"]["source"]): string => source === "selector" ? "from the :level on the selected model" : source === "role" ? "from the role it follows" : source === "model" ? "is the model's own default" : source === "setting" ? "from the default thinking level setting" : "";
function RoleDetail({ snapshot, role, scope, projectAllowed, setScope, send, assign }: { snapshot: SettingsSnapshot; role: SettingsRole; scope: SettingsScope; projectAllowed: boolean; setScope(scope: SettingsScope): void; send: Send; assign(step: "model" | "thinking"): void }) {
  const { resolution } = role;
  const persisted = at(snapshot[scope], ["modelRoles", role.id]);
  const persistedText = typeof persisted === "string" ? persisted : "";
  const selector = persistedText || role.selector;
  const model = snapshot.models.find(item => modelKey(item) === (selector ? selectorBase(selector) : role.resolved)) ?? snapshot.models.find(item => modelKey(item) === role.resolved);
  const clear = (): void => { send({ action: "save", scope, edits: [{ path: ["modelRoles", role.id], ...(scope === "project" ? { value: null } : {}) }] }, "role"); };
  const note = roleNote(role.id);
  const cycle = patternList(snapshot.effective.cycleOrder);
  const chain = at(snapshot.effective, ["retry", "fallbackChains", role.id]);
  const chainModels = patternList(chain);
  const problem = problems({ roles: [role], agents: [] })[0];
  const providerEntry = problem?.provider ? snapshot.providers.find(item => item.id === problem.provider) : undefined;
  const { following, overridden } = resolution.agents;
  // A role that tools resolve as a chain lists what OMP would try next; the others list the priority list OMP chooses from.
  const candidates = resolution.candidates ?? role.defaults;
  return <section className="card detail">
    <div className="card-head"><h2>{role.name}{role.name !== role.id && <Badge>{role.id}</Badge>}<SourcePill pill={rolePill(role)} /></h2>
      <button type="button" onClick={() => assign("model")}><Icon name="symbol-variable" />Change model…</button></div>
    <div className="effective">
      <div className="eyebrow">Effective now</div>
      <div className="effective-line"><span className="big"><ModelChip model={resolution.model} full /></span><Meter thinking={resolution.thinking} /></div>
      <div className="small muted"><EffectiveNote role={role} /></div>
      {problem && <div className="banner inner"><Icon name="warning" /><div className="grow"><strong>{problem.wanted}</strong> {problem.status === "login" ? "needs login" : problem.status === "missing" ? "is not a model OMP knows" : "is not available"}; this role has no usable model.</div>{problem.status === "login" && providerEntry && !providerEntry.available && <SignIn provider={providerEntry.id} send={send} label="Sign in" />}</div>}
    </div>
    <h3>How it was decided</h3>
    {resolution.trace.length ? <Trace steps={resolution.trace} label={`How ${role.id} was decided`} /> : <p className="small muted">Nothing is set for this role in any layer.</p>}
    {resolution.source === "none" && <details className="small" open><summary>What OMP does without it</summary><p>{note.details}</p></details>}
    {projectAllowed
      ? <label className="inline-label">Save to<select aria-label="Role write scope" value={scope} onChange={event => setScope(event.target.value as SettingsScope)}><option value="project">Project config · this folder</option><option value="global">Global config · active profile</option></select></label>
      : <p className="small muted">Saved to the global config{snapshot.effective.modelRoleStorage === "project" ? ". To save project roles, choose a project folder in the scope control" : ", as OMP role storage is global"}.</p>}
    <dl className="small">
      {persisted !== undefined && persisted !== role.selector && <><dt>Saved in {scope} config</dt><dd>{persisted === null ? `Cleared in the ${scope} config: the global value applies` : persistedText ? <code>{persistedText}</code> : "Not set"}</dd></>}
      {persisted === undefined && <><dt>Saved in {scope} config</dt><dd>Not set</dd></>}
    </dl>
    <div className="toolbar">
      <button type="button" className="secondary" disabled={!selector || !model?.reasoning} title={model && !model.reasoning ? "This model has no thinking levels" : undefined} onClick={() => assign("thinking")}><Icon name="lightbulb" />Thinking…</button>
      <button type="button" className="secondary" disabled={persisted === null || persisted === undefined && scope === "global"} onClick={clear}><Icon name="discard" />Clear {scope} value</button>
    </div>
    <InlineStatus origin="role" />
    <h3>Who depends on it</h3>
    <dl className="small depends">
      <dt>Agents</dt><dd>{following.length ? following.map(name => <span key={name} className="tag">{name}</span>) : <span className="muted">none follow it right now</span>}{overridden.length > 0 && <div className="xs muted">Name it in their definition but have their own model: {overridden.map(name => <s key={name} className="tag">{name}</s>)}</div>}</dd>
      <dt>Roles</dt><dd>{resolution.followers.length ? <>{resolution.followers.map(id => <span key={id} className="tag">{id}</span>)} <span className="xs muted">follow it while unset</span></> : <span className="muted">no role follows it</span>}</dd>
      <dt>Cycle order</dt><dd>{cycle.includes(role.id) ? `position ${cycle.indexOf(role.id) + 1} of ${cycle.length}` : <span className="muted">not in the cycle</span>}</dd>
      <dt>Fallback</dt><dd>{chainModels.length ? <>{count(chainModels.length, "model")}, first <code>{chainModels[0]}</code></> : <span className="muted">no chain for this role</span>}</dd>
    </dl>
    <p className="small muted">Picking a model saves the role at once, as OMP's <code>/models</code> does; reasoning models then offer a thinking level, where Escape keeps the role's current level.{role.id === "default" ? " Auto thinking on the default role sets the global default thinking level." : ""}</p>
    {candidates.length > 0 && <details><summary className="small">{resolution.candidates ? "Then OMP tries, in order" : "OMP's candidates when it chooses"}</summary><ol className="small plain-list">{candidates.map(item => <li key={item}><code>{item}</code></li>)}</ol></details>}
  </section>;
}
export function CurrentSession({ init, session, send }: { init?: Init; session?: SessionApply | null; send: Send }) {
  if (!init?.canApply) return <p className="small muted hint"><Icon name="info" /> Saved roles apply to new sessions. To switch a running Chat, open Models with <code>/models</code> from that Chat.</p>;
  const block = sessionBlock(session);
  if (!block) return null;
  return <section className="card"><h3>Current session</h3>
    <p><strong>{block.heading}</strong></p>
    <p className="small muted">{block.line}</p>
    {block.note && <p className="small">{block.note}</p>}
    {block.unavailable && <p className="small warning-text"><Icon name="warning" />{block.unavailable}</p>}
    {block.button && <div className="toolbar"><button type="button" disabled={block.blocked !== undefined} title={block.blocked} onClick={() => send({ action: "apply-default" }, "session")}>{block.button}</button>{block.blocked && <span className="small muted">{block.blocked}</span>}</div>}
    <InlineStatus origin="session" />
  </section>;
}
export function Cycle({ snapshot, send }: SurfaceProps) {
  const effective = patternList(snapshot.effective.cycleOrder);
  const [order, setOrder] = useState(effective);
  const addable = snapshot.roles.map(role => role.id).filter(id => !order.includes(id));
  const [chosen, setAdd] = useState("");
  const add = addable.includes(chosen) ? chosen : addable[0] ?? "";
  return <section className="card"><h2>Model cycle order <Badge>Global</Badge>{!sameList(order, effective) && <Badge tone="warning">Unsaved</Badge>}</h2>
    <p className="small muted">OMP's model cycling steps through these roles in this order. Effective order from {sourceLabel(snapshot.provenance.cycleOrder)}.</p>
    <OrderedList label="Model cycle order" entries={order} onChange={setOrder} empty="No roles in the cycle." describe={id => { const found = snapshot.roles.find(item => item.id === id); return found ? <ModelChip model={found.resolution.model} /> : "unknown role"; }} />
    <div className="toolbar">
      <select aria-label="Role to add to cycle" value={add} disabled={!addable.length} onChange={event => setAdd(event.target.value)}>{addable.map(id => <option key={id}>{id}</option>)}</select>
      <button type="button" className="secondary" disabled={!add} onClick={() => setOrder(withEntry(order, add))}><Icon name="add" />Add</button>
      <span className="grow" />
      <button type="button" disabled={sameList(order, effective)} onClick={() => send({ action: "save", scope: "global", edits: [{ path: ["cycleOrder"], value: order }] }, "cycle")}>Save order</button>
      <button type="button" className="secondary" disabled={snapshot.global.cycleOrder === undefined} onClick={() => send({ action: "save", scope: "global", edits: [{ path: ["cycleOrder"] }] }, "cycle")}>Reset global order</button>
    </div>
    <InlineStatus origin="cycle" />
  </section>;
}
export function Fallback({ snapshot, send, pick, revision }: SurfaceProps) {
  const effective = at(snapshot.effective, ["retry", "fallbackChains"]);
  const configured = isRecord(effective) ? Object.keys(effective) : [];
  const [selected, setSelected] = useState(configured[0] ?? "");
  // A chain created here opens its first model picker once, as OMP's "+ New fallback…" continues straight to the entry.
  const [created, setCreated] = useState<string>();
  const keys = selected && !configured.includes(selected) ? [...configured, selected] : configured;
  const newChain = async (): Promise<void> => {
    const key = await pick({ action: "pick-chain-key" }, "fallback");
    if (!key) return;
    setSelected(key); setCreated(key);
  };
  return <section className="card"><h2>Retry fallback chains <Badge>Global</Badge></h2>
    <p className="small muted">When a request fails, OMP retries with the chain's models from top to bottom. A chain belongs to a role, an exact model or a whole provider (<code>provider/*</code>). Effective chains from {sourceLabel(snapshot.provenance["retry.fallbackChains"])}.</p>
    <div className="grid">
      <div>
        {keys.length ? <ListBox label="Fallback chains" selected={selected} onSelect={setSelected} options={keys.map(key => ({ id: key, content: <div className="option-row">
          <span className="mono ellipsis">{key}</span><span className="small muted">{configured.includes(key) ? count(patternList(at(snapshot.effective, ["retry", "fallbackChains", key])).length, "model") : "new"}</span>
        </div> }))} /> : <p className="small muted">No fallback chains are configured.</p>}
        <div className="toolbar"><button type="button" className="secondary" onClick={() => void newChain()}><Icon name="add" />New chain…</button></div>
      </div>
      {selected ? <FallbackChain key={`${selected}:${revision}`} snapshot={snapshot} send={send} pick={pick} chainKey={selected} startAdding={created === selected} onStarted={() => setCreated(undefined)} />
        : <p className="small muted">Choose a chain, or create one for a role, model or provider.</p>}
    </div>
  </section>;
}
export function FallbackChain({ snapshot, send, pick, chainKey, startAdding, onStarted }: { snapshot: SettingsSnapshot; send: Send; pick: Pick; chainKey: string; startAdding: boolean; onStarted(): void }) {
  const persisted = at(snapshot.global, ["retry", "fallbackChains", chainKey]);
  const effective = patternList(at(snapshot.effective, ["retry", "fallbackChains", chainKey]));
  const [chain, setChain] = useState(effective);
  const add = async (): Promise<void> => {
    const value = await pick({ action: "pick-model", purpose: "fallback-entry", exclude: chain }, "fallback");
    if (value) setChain(current => withEntry(current, value));
  };
  useEffect(() => { if (startAdding) { onStarted(); void add(); } }, [startAdding]);
  const save = (clear: boolean): void => { send({ action: "save", scope: "global", edits: [{ path: ["retry", "fallbackChains", chainKey], ...(!clear && chain.length ? { value: chain } : {}) }] }, "fallback"); };
  return <div>
    <h3><code>{chainKey}</code>{!sameList(chain, effective) && <Badge tone="warning">Unsaved</Badge>}</h3>
    <p className="small muted">{persisted === undefined ? "Not set in the global config." : sameList(patternList(persisted), effective) ? "Saved in the global config." : "The global config has a different chain; a higher-priority config wins."}</p>
    <OrderedList label={`Fallback chain for ${chainKey}, tried in order`} entries={chain} onChange={setChain} empty="No models yet. Add the first one." describe={entry => <EntryStatusText entry={entry} snapshot={snapshot} />} />
    <div className="toolbar">
      <button type="button" className="secondary" onClick={() => void add()}><Icon name="add" />Add model…</button>
      <span className="grow" />
      <button type="button" disabled={sameList(chain, patternList(persisted))} onClick={() => save(false)}>Save chain</button>
      {!sameList(chain, effective) && <button type="button" className="secondary" onClick={() => setChain(effective)}>Discard changes</button>}
      <button type="button" className="secondary" disabled={persisted === undefined} onClick={() => save(true)}>Clear global chain</button>
    </div>
    <InlineStatus origin="fallback" />
  </div>;
}
