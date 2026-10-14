import type { ConfigSnapshot } from "../../../protocol/omp-config-model";
import { FILTERS, VIEW_NAME } from "../model";
import type { Filter, TocTab, View } from "../model";
import { Icon } from "./Icon";

/** The editor's frame: header, search and filters, the Global / Project / Effective switch, the table of contents and the footer. Presentation only. */
export interface HeaderProps {
  readonly snapshot: ConfigSnapshot | undefined;
  readonly folder: string | null;
  readonly projectAvailable: boolean;
  readonly busy: boolean;
  onScope(): void;
  onReload(): void;
  onOpenFile(layer: "global" | "project"): void;
}

export function Header({ snapshot, folder, projectAvailable, busy, onScope, onReload, onOpenFile }: HeaderProps) {
  const files = snapshot?.files;
  const name = folder === null ? "Global" : folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
  const sub = snapshot === undefined ? "Reading the installed OMP…" : `OMP ${snapshot.omp.version}${snapshot.omp.verified ? "" : " (not verified with this release)"} · profile ${snapshot.profile} · ${projectAvailable ? `project folder ${name}` : folder === null ? "global config, no project layer" : "the home folder has no project layer"}`;
  return <header className="page-head">
    <div>
      <h1>OMP settings</h1>
      <p className="sub">{sub}</p>
    </div>
    <div className="toolbar">
      <button type="button" className="btn sec" disabled={busy} onClick={onScope} title={folder ?? "Choose a project folder"}><Icon name={folder === null ? "globe" : "folder"} />{name}<Icon name="chevron-down" /></button>
      <button type="button" className="btn sec" disabled={busy} onClick={onReload}><Icon name="refresh" />Reload</button>
      <button type="button" className="btn sec" disabled={!files?.global.exists} onClick={() => onOpenFile("global")} title={files?.global.exists ? files.global.path : "The global config does not exist yet; saving a setting creates it."}><Icon name="go-to-file" />Global config</button>
      {projectAvailable && <button type="button" className="btn sec" disabled={!files?.project.exists} onClick={() => onOpenFile("project")} title={files?.project.exists ? files.project.path : "This folder has no .omp/config.yml yet; saving a project setting creates it."}><Icon name="go-to-file" />Project config</button>}
    </div>
  </header>;
}

const CHIPS: Readonly<Record<Filter, { readonly label: string; readonly icon: string }>> = {
  modified: { label: "Modified", icon: "circle-filled" }, project: { label: "In project", icon: "folder" }, env: { label: "Env-controlled", icon: "symbol-variable" },
  warning: { label: "Warnings", icon: "warning" }, readonly: { label: "Read-only", icon: "lock" },
};

export interface SearchProps { readonly query: string; readonly chips: ReadonlySet<string>; onQuery(query: string): void; onChip(filter: Filter): void }
export function SearchBar({ query, chips, onQuery, onChip }: SearchProps) {
  return <div className="searchbar">
    <span className="searchbox"><Icon name="search" /><input type="search" aria-label="Search settings" placeholder="Search settings (@modified, @env, @warning, @tab:model …)" value={query} onChange={event => onQuery(event.target.value)} /></span>
    <div className="chips" role="group" aria-label="Filters"><span className="xs muted">Filter:</span>
      {FILTERS.map(filter => <button key={filter} type="button" className={`btn chip${chips.has(filter) ? "" : " sec"}`} aria-pressed={chips.has(filter)} onClick={() => onChip(filter)}><Icon name={CHIPS[filter].icon} />{CHIPS[filter].label}</button>)}
    </div>
  </div>;
}

export interface LayerBarProps {
  readonly view: View; readonly folder: string | null; readonly projectAvailable: boolean;
  readonly counts: Readonly<Record<"global" | "project", number>>; readonly shown: number; readonly total: number; readonly searching: boolean;
  onView(view: View): void;
}
export function LayerBar({ view, folder, projectAvailable, counts, shown, total, searching, onView }: LayerBarProps) {
  const tab = (id: View, icon: string, count?: number, disabled = false, title = "") =>
    <button type="button" role="tab" className="lt" aria-selected={view === id} disabled={disabled} title={title} onClick={() => onView(id)}>
      <Icon name={icon} />{id === "project" && projectAvailable && folder !== null ? `Project · ${folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder}` : VIEW_NAME[id]}{count !== undefined && <span className="pill">{count}</span>}
    </button>;
  return <div className="layerbar">
    <div role="tablist" aria-label="Settings layer">
      {tab("global", "globe", counts.global, false, "Edits the global config.yml of the OMP profile")}
      {tab("project", "folder", projectAvailable ? counts.project : undefined, !projectAvailable, projectAvailable ? "Edits <folder>/.omp/config.yml" : "Choose a project folder in the scope control to edit the project layer")}
      {tab("effective", "eye", undefined, false, "What OMP uses: read-only, with the source of every value")}
    </div>
    <span className="small muted count-note">{shown} of {total} settings{searching ? " match" : ""}</span>
  </div>;
}

export interface TocProps { readonly toc: readonly TocTab[]; readonly current: string; onJump(anchor: string): void }
export function Toc({ toc, current, onJump }: TocProps) {
  return <nav className="toc" aria-label="Settings tabs and groups">
    {toc.map(item => <div key={item.tab.id}>
      <button type="button" className="t" aria-current={current === item.anchor || item.groups.some(group => group.anchor === current)} onClick={() => onJump(item.anchor)}>
        {item.tab.label}{item.modified && <span className="mdot" title="Has modified settings" />}<span className="cnt">{item.count}</span></button>
      {item.groups.map(group => <button key={group.anchor} type="button" className="g" aria-current={current === group.anchor} onClick={() => onJump(group.anchor)}>{group.group}<span className="cnt">{group.count}</span></button>)}
    </div>)}
  </nav>;
}

export function Footer() {
  return <footer className="footnote small muted">
    <Icon name="info" /><span>Saved settings apply to new sessions; running sessions pick them up when OMP reloads its config. Saving rewrites the config file without YAML comments. Credentials are never shown here: set them in a terminal with <code>omp config set</code>.</span>
  </footer>;
}
