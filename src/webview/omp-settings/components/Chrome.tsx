import { useRef } from "react";
import type { KeyboardEvent } from "react";
import type { ConfigLayer, ConfigSnapshot, ConfigTab } from "../../../protocol/omp-config-model";

/** The editor's frame: header, layer switch, search, tabs and the static footer. Presentation only. */
export interface HeaderProps {
  readonly snapshot: ConfigSnapshot | undefined;
  readonly folder: string | null;
  readonly layer: ConfigLayer;
  readonly busy: boolean;
  onLayer(layer: ConfigLayer): void;
  onScope(): void;
  onReload(): void;
  onOpenFile(layer: ConfigLayer): void;
}

export function Header({ snapshot, folder, layer, busy, onLayer, onScope, onReload, onOpenFile }: HeaderProps) {
  const files = snapshot?.files;
  return <header className="header">
    <div>
      <h1>OMP Settings</h1>
      <p className="muted small">{snapshot ? `OMP ${snapshot.omp.version} · profile ${snapshot.profile}` : "Reading the installed OMP…"}</p>
    </div>
    <div className="toolbar">
      <div role="group" aria-label="Layer to edit" className="segmented">
        <button type="button" aria-pressed={layer === "global"} onClick={() => onLayer("global")}>Global</button>
        <button type="button" aria-pressed={layer === "project"} disabled={folder === null} title={folder === null ? "Choose a project folder first" : `Project layer of ${folder}`} onClick={() => onLayer("project")}>Project</button>
      </div>
      <button type="button" className="secondary" disabled={busy} onClick={onScope} title="Choose the project folder whose layer to edit">{folder === null ? "No project folder" : folder}</button>
      <button type="button" className="secondary" disabled={busy} onClick={onReload}>Reload</button>
      <button type="button" className="secondary" disabled={!files?.[layer].exists} onClick={() => onOpenFile(layer)} title={files?.[layer].path}>Open {layer} config</button>
    </div>
  </header>;
}

export function SearchBox({ query, onQuery }: { query: string; onQuery(query: string): void }) {
  return <input type="search" className="search" aria-label="Filter settings" placeholder="Filter by name, id or description" value={query} onChange={event => onQuery(event.target.value)} />;
}

export function TabBar({ tabs, selected, counts, onSelect }: { tabs: readonly ConfigTab[]; selected: string; counts: Readonly<Record<string, number>>; onSelect(id: string): void }) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const keyDown = (event: KeyboardEvent, index: number): void => {
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const id = tabs[(next + tabs.length) % tabs.length]!.id;
    onSelect(id);
    buttons.current.get(id)?.focus();
  };
  return <div role="tablist" aria-label="Setting tabs" className="tabs">
    {tabs.map((tab, index) => <button key={tab.id} role="tab" type="button" id={`tab-${tab.id}`} aria-selected={tab.id === selected} aria-controls="panel" tabIndex={tab.id === selected ? 0 : -1}
      ref={element => { if (element) buttons.current.set(tab.id, element); }} onKeyDown={event => keyDown(event, index)} onClick={() => onSelect(tab.id)}>{tab.label}<span className="count">{counts[tab.id] ?? 0}</span></button>)}
  </div>;
}

export function Footer() {
  return <footer className="footer small muted">
    <p>Each change is saved to the chosen layer's file at once, under OMP's file lock. OMP's running terminal and Chat sessions reload their config files when they change; a setting OMP reads only at session start applies to new sessions. OMP does not say which is which.</p>
    <p>Credentials are never shown here. Set them in a terminal with <code>omp config set</code>.</p>
  </footer>;
}
