import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isRecord } from "../../shared/guards";
import type { ConfigAction, ConfigLayer, ConfigMessage, ConfigSnapshot, ConfigValue } from "../../protocol/omp-config-model";
import { fileLayerFor, layout, modifiedCount, parseQuery, shownEntries } from "./model";
import type { Filter, View } from "./model";
import { Footer, Header, LayerBar, SearchBar, Toc } from "./components/Chrome";
import { Icon } from "./components/Icon";
import { SettingRow } from "./components/SettingRow";
import { OMP_SETTINGS_CSS } from "./styles";

declare function acquireVsCodeApi(): { postMessage(message: ConfigAction): void; setState(state: { key: string }): void };
const vscode = acquireVsCodeApi();
type Request = ConfigAction extends infer A ? A extends ConfigAction ? Omit<A, "requestId"> : never : never;
interface Status { readonly ok: boolean; readonly pending: boolean; readonly message: string }

/** State and the host bridge. The presentation is in `components/`; the logic that needs no React is in `model.ts`. */
function useHost() {
  const [scope, setScope] = useState<{ folder: string | null; projectAvailable: boolean }>({ folder: null, projectAvailable: false });
  const [snapshot, setSnapshot] = useState<ConfigSnapshot>();
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState<Status>({ ok: true, pending: true, message: "Reading the installed OMP settings…" });
  const busyRef = useRef(true);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (!isRecord(event.data) || typeof event.data.type !== "string") return;
      const message = event.data as unknown as ConfigMessage;
      switch (message.type) {
        case "ompConfig:init": setScope({ folder: message.folder, projectAvailable: message.projectAvailable }); vscode.setState({ key: message.key }); break;
        case "ompConfig:snapshot": setSnapshot(message.snapshot); break;
        case "ompConfig:result": busyRef.current = false; setBusy(false); setStatus({ ok: message.ok, pending: false, message: message.message }); break;
      }
    };
    window.addEventListener("message", receive);
    vscode.postMessage({ action: "ready", requestId: crypto.randomUUID() });
    return () => window.removeEventListener("message", receive);
  }, []);
  const send = (request: Request, pending: string): void => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setStatus({ ok: true, pending: true, message: pending });
    vscode.postMessage({ ...request, requestId: crypto.randomUUID() } as ConfigAction);
  };
  return { ...scope, snapshot, busy, status, send };
}

function App() {
  const { folder, projectAvailable, snapshot, busy, status, send } = useHost();
  const [chosen, setView] = useState<View>("global");
  const [query, setQuery] = useState("");
  const [chips, setChips] = useState<ReadonlySet<string>>(new Set());
  const [current, setCurrent] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  // A scope without a project layer (global, the home folder) falls back to the global view.
  const view: View = chosen === "project" && !projectAvailable ? "global" : chosen;
  const tabs = snapshot?.tabs ?? [];
  const entries = snapshot?.entries ?? [];
  const parsed = useMemo(() => parseQuery(query, chips), [query, chips]);
  const shown = useMemo(() => shownEntries(entries, query, chips, tabs), [entries, query, chips, tabs]);
  const { sections, toc } = useMemo(() => layout(tabs, shown, view), [tabs, shown, view]);
  const tabLabels = useMemo(() => new Map(tabs.map(tab => [tab.id, tab.label])), [tabs]);
  const counts = useMemo(() => ({ global: modifiedCount(entries, "global"), project: modifiedCount(entries, "project") }), [entries]);
  const searching = parsed.terms.length > 0 || parsed.filters.size > 0;
  const visibleTotal = useMemo(() => entries.filter(entry => entry.visible).length, [entries]);

  // The table of contents follows the list: the last heading at or above the top edge is current.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    let frame = 0;
    const update = (): void => {
      frame = 0;
      let found = "";
      for (const heading of list.querySelectorAll<HTMLElement>("[data-anchor]")) { if (heading.offsetTop - list.offsetTop <= list.scrollTop + 8) found = heading.dataset.anchor ?? found; else break; }
      setCurrent(found);
    };
    const onScroll = (): void => { if (frame === 0) frame = requestAnimationFrame(update); };
    list.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => { list.removeEventListener("scroll", onScroll); if (frame !== 0) cancelAnimationFrame(frame); };
  }, [sections]);

  const jump = (anchor: string): void => {
    const list = listRef.current;
    const target = list?.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`);
    if (list && target) list.scrollTop = target.offsetTop - list.offsetTop - 2;
  };
  const toggleChip = (filter: Filter): void => setChips(previous => { const next = new Set(previous); if (!next.delete(filter)) next.add(filter); return next; });
  const openFile = (layer: ConfigLayer, id?: string): void => send({ action: "open-config", layer, ...(id === undefined ? {} : { id }) }, "Opening the file…");

  return <main>
    <Header snapshot={snapshot} folder={folder} projectAvailable={projectAvailable} busy={busy}
      onScope={() => send({ action: "pick-scope" }, "Choose the scope in the picker…")} onReload={() => send({ action: "reload" }, "Reloading…")} onOpenFile={layer => openFile(layer)} />
    {snapshot && snapshot.notices.length > 0 && <ul className="notices small">{snapshot.notices.map(notice => <li key={notice}>{notice}</li>)}</ul>}
    <SearchBar query={query} chips={chips} onQuery={setQuery} onChip={toggleChip} />
    <LayerBar view={view} folder={folder} projectAvailable={projectAvailable} counts={counts} shown={shown.length} total={visibleTotal} searching={searching} onView={setView} />
    <div role="status" className={`status${status.ok ? "" : " error"}`}>{status.message ? <><Icon name={status.pending ? "loading" : status.ok ? "check" : "error"} spin={status.pending} />{status.message}</> : null}</div>
    <div className="s1grid">
      <Toc toc={toc} current={current} onJump={jump} />
      <div className="list" ref={listRef} tabIndex={-1}>
        {sections.map(section => <section key={section.tab.id}>
          <h2 className="s1gh" data-anchor={section.anchor}>{section.tab.label}{section.tab.lead && <span className="lead"> {section.tab.lead}</span>}</h2>
          {section.groups.map(group => <div key={group.anchor}>
            {group.group !== null && <h3 className="s1gh2" data-anchor={group.anchor}>{group.group}</h3>}
            <ul className="rows">{group.entries.map(entry => <SettingRow key={entry.id} entry={entry} tabLabel={tabLabels.get(entry.tab) ?? entry.tab} view={view} busy={busy}
              layerFileExists={snapshot?.files[fileLayerFor(entry, view)].exists ?? false}
              terms={parsed.terms}
              onSet={(value: ConfigValue) => send({ action: "set", id: entry.id, layer: view === "effective" ? "global" : view, value }, `Saving ${entry.label}…`)}
              onReset={() => send({ action: "reset", id: entry.id, layer: view === "effective" ? "global" : view }, `Resetting ${entry.label}…`)}
              onOpen={layer => openFile(layer, entry.id)} />)}</ul>
          </div>)}
        </section>)}
        {snapshot && sections.length === 0 && <p className="empty muted">{searching ? "No setting matches." : "OMP lists no settings."}</p>}
      </div>
    </div>
    <Footer />
  </main>;
}

const style = document.createElement("style");
style.nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? "";
style.textContent = OMP_SETTINGS_CSS;
document.head.appendChild(style);
const root = document.getElementById("root");
if (!root) throw new Error("The settings page container is missing.");
createRoot(root).render(<App />);
