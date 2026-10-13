import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isRecord } from "../../shared/guards";
import { groupedEntries } from "../../protocol/omp-config-model";
import type { ConfigAction, ConfigLayer, ConfigMessage, ConfigSnapshot, ConfigValue } from "../../protocol/omp-config-model";
import { shownEntries, tabCounts } from "./model";
import { Footer, Header, SearchBox, TabBar } from "./components/Chrome";
import { SettingRow } from "./components/SettingRow";
import { OMP_SETTINGS_CSS } from "./styles";

declare function acquireVsCodeApi(): { postMessage(message: ConfigAction): void; setState(state: { key: string }): void };
const vscode = acquireVsCodeApi();
type Request = ConfigAction extends infer A ? A extends ConfigAction ? Omit<A, "requestId"> : never : never;
interface Status { readonly ok: boolean; readonly pending: boolean; readonly message: string }

/** State and the host bridge. The presentation is in `components/`; the logic that needs no React is in `model.ts`. */
function useHost() {
  const [folder, setFolder] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ConfigSnapshot>();
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState<Status>({ ok: true, pending: true, message: "Reading the installed OMP settings…" });
  const busyRef = useRef(true);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (!isRecord(event.data) || typeof event.data.type !== "string") return;
      const message = event.data as unknown as ConfigMessage;
      switch (message.type) {
        case "ompConfig:init": setFolder(message.folder); vscode.setState({ key: message.key }); break;
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
  return { folder, snapshot, busy, status, send };
}

function App() {
  const { folder, snapshot, busy, status, send } = useHost();
  const [layer, setLayer] = useState<ConfigLayer>("global");
  const [tabId, setTabId] = useState("");
  const [query, setQuery] = useState("");
  // The global scope has no project layer: fall back to global whenever the scope loses its folder.
  const activeLayer: ConfigLayer = folder === null ? "global" : layer;
  const tabs = snapshot?.tabs ?? [];
  const selectedTab = tabs.find(tab => tab.id === tabId) ?? tabs[0];
  const searching = query.trim() !== "";
  const entries = snapshot?.entries ?? [];
  const counts = useMemo(() => tabCounts(tabs, entries, query), [tabs, entries, query]);
  const shown = useMemo(() => shownEntries(entries, query), [entries, query]);
  // One filtered list across every tab while searching; the selected tab's groups otherwise.
  const sections = (searching ? tabs : selectedTab ? [selectedTab] : []).flatMap(tab => groupedEntries(tab, shown).map(section => ({ ...section, key: `${tab.id}/${section.group ?? ""}` })));
  const row = (entry: ConfigSnapshot["entries"][number]) => <SettingRow key={entry.id} entry={entry} layer={activeLayer} busy={busy}
    layerFileExists={snapshot?.files[activeLayer].exists ?? false} layerUnavailable={activeLayer === "project" && folder === null}
    showTab={searching ? tabs.find(tab => tab.id === entry.tab)?.label ?? entry.tab : null}
    onSet={(value: ConfigValue) => send({ action: "set", id: entry.id, layer: activeLayer, value }, `Saving ${entry.label}…`)}
    onReset={() => send({ action: "reset", id: entry.id, layer: activeLayer }, `Resetting ${entry.label}…`)}
    onOpen={() => send({ action: "open-config", layer: activeLayer, id: entry.id }, "Opening the file…")} />;
  return <main>
    <Header snapshot={snapshot} folder={folder} layer={activeLayer} busy={busy} onLayer={setLayer}
      onScope={() => send({ action: "pick-scope" }, "Choose the scope in the picker…")} onReload={() => send({ action: "reload" }, "Reloading…")}
      onOpenFile={target => send({ action: "open-config", layer: target }, "Opening the file…")} />
    <div role="status" className={`status${status.ok ? "" : " error"}`}>{status.message}</div>
    {snapshot && snapshot.notices.length > 0 && <ul className="notices small">{snapshot.notices.map(notice => <li key={notice}>{notice}</li>)}</ul>}
    <SearchBox query={query} onQuery={setQuery} />
    {snapshot && <TabBar tabs={tabs} selected={selectedTab?.id ?? ""} counts={counts} onSelect={setTabId} />}
    <div id="panel" role="tabpanel" aria-labelledby={selectedTab ? `tab-${selectedTab.id}` : undefined}>
      {selectedTab && !searching && selectedTab.lead && <p className="lead muted">{selectedTab.lead}</p>}
      {sections.map(section => <section key={section.key}>
        {section.group !== null && <h2>{section.group}</h2>}
        <ul className="rows">{section.entries.map(row)}</ul>
      </section>)}
      {snapshot && sections.length === 0 && <p className="empty muted">{searching ? "No setting matches the filter." : "OMP lists no settings on this tab."}</p>}
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
