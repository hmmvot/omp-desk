import type { InventoryRow, RowSource, RowToggle } from "../host/inventory/inventory-model.ts";

/**
 * One MCP server name, one row (ADR-0061, amendment). OMP's capability loader keys servers by name and the
 * highest-priority entry owns the name; it never merges fields from a lower entry (capability/index.ts dedupe,
 * mcp/config.ts `suppress`). Priority is the provider's (OMP's `.omp/` and `~/.omp/agent` files 100, omp-plugins 90,
 * Claude 80 ... the standalone `.mcp.json`/`mcp.json` provider 5), then the order of files inside the provider
 * (project before user), so a user-level file of a higher-priority provider beats a project `.mcp.json`. Neither
 * provider walks up to a repository or worktree root: project files are read at the session's own folder only.
 * An entry that only sets `enabled: false` is therefore not a server but a by-name switch that keeps the whole name
 * off, which is how a project turns off a server another file defines. This fold turns the entries of a name into
 * the one row the user means and lists the contributing files on it.
 */
export interface McpEntry {
  readonly name: string;
  readonly path: string | null;
  readonly provider: string;
  readonly providerName: string;
  readonly level: "user" | "project" | "native";
  readonly state: "active" | "disabled" | "shadowed";
  readonly disabledReason: string | null;
  /** OMP's own `_shadowed` mark (an earlier item owns the name or an equivalent connection). */
  readonly shadowed: boolean;
  /** `enabled` as the entry's file sets it; `undefined` when absent. */
  readonly enabled: boolean | undefined;
  /** The entry names a command or a url, so it can be a server. */
  readonly defines: boolean;
  readonly raw: Readonly<Record<string, unknown>>;
}
export interface McpFoldHooks {
  /** `transport · endpoint` of a definition; credential-free. */
  detail(raw: Readonly<Record<string, unknown>>): string;
  toolPrefix(name: string): string | null;
  /** The ordinary global switch for a name whose owner is a definition. */
  switchOf(owner: McpEntry): RowToggle;
  /** The project's own configuration disables this name by id, which a global switch cannot override. */
  excludedByProject: boolean;
  /** The name of the other server whose identical connection makes OMP drop the owner, when the owner carries OMP's `_shadowed` mark; `null` when none can be named. */
  shadowedBy(owner: McpEntry): string | null;
}
export interface FoldedServer { readonly row: InventoryRow; /** The owner is a definition that carries `enabled: false`: enabling must also force-enable it by name. */ readonly ownerDisabledByFlag: boolean }

function fileName(entry: McpEntry): string {
  return entry.path?.split(/[\\/]/).at(-1) ?? entry.providerName;
}

/** `entries` are one name's entries in OMP's precedence order (first wins). */
export function foldMcpServer(entries: readonly McpEntry[], hooks: McpFoldHooks): FoldedServer {
  const owner = entries[0];
  if (owner === undefined) throw new Error("A server needs at least one entry.");
  const definition = entries.find(entry => entry.defines) ?? null;
  const ownerDefines = owner.defines;
  const sources: RowSource[] = entries.map(entry => {
    const role = entry === definition ? "defines" : entry === owner && !ownerDefines ? (entry.enabled === false ? "disables" : "incomplete") : "ignored";
    return { path: entry.path, providerName: entry.providerName, level: entry.level, role };
  });
  const shown = definition ?? owner;
  const base = {
    kind: "mcp" as const, name: owner.name, description: null, path: shown.path, provider: shown.provider, providerName: shown.providerName, level: shown.level,
    toolPrefix: hooks.toolPrefix(owner.name), runtimeName: null, sources,
    detail: definition === null ? "no command or url" : hooks.detail(definition.raw),
  };
  if (!ownerDefines) {
    const disables = owner.enabled === false;
    return { ownerDisabledByFlag: false, row: { ...base, state: "disabled", shadowed: false, shadowedBy: null, disabledReason: disables ? "entry" : "invalid-entry",
      toggle: { mechanism: null, refusal: disables
        ? `${fileName(owner)} sets enabled: false for it without defining it, so OMP loads nothing for the name whatever the global switch says; remove that entry to enable it`
        : `its entry in ${fileName(owner)} has no command or url, so OMP loads nothing for it` } } };
  }
  const shadowed = owner.shadowed || owner.state === "shadowed";
  const shadowedBy = shadowed ? hooks.shadowedBy(owner) : null;
  const toggle: RowToggle = shadowedBy !== null
    ? { mechanism: null, refusal: `OMP keeps the server ${shadowedBy}, which has the same command or url, so there is nothing to switch for this one` }
    : hooks.excludedByProject
      ? { mechanism: null, refusal: "this project's config disables it by name, which a global switch cannot override" }
      : hooks.switchOf(owner);
  return { ownerDisabledByFlag: owner.enabled === false,
    row: { ...base, state: owner.state, shadowed, shadowedBy, disabledReason: owner.disabledReason, toggle } };
}

/** Warnings OMP raises for entries that are by-name switches rather than failed sources: `Invalid item at <file>: Must have command or url`. */
export function excusedEntryWarnings(warnings: readonly string[], entries: readonly McpEntry[], samePath: (a: string, b: string) => boolean): readonly string[] {
  const missing = /^\[[^\]]*\] Invalid item at (.+): Must have command or url$/;
  const perFile = new Map<string, { warnings: string[]; switches: number }>();
  for (const warning of warnings) {
    const file = missing.exec(warning)?.[1];
    if (file === undefined) continue;
    const key = [...perFile.keys()].find(known => samePath(known, file)) ?? file;
    const slot = perFile.get(key) ?? { warnings: [], switches: 0 };
    slot.warnings.push(warning);
    perFile.set(key, slot);
  }
  for (const entry of entries) {
    // OMP validates only the entries it did not mark shadowed, so only those can have produced a warning.
    if (entry.defines || entry.enabled !== false || entry.shadowed || entry.path === null) continue;
    const key = [...perFile.keys()].find(known => samePath(known, entry.path!));
    if (key !== undefined) perFile.get(key)!.switches++;
  }
  const excused = new Set<string>();
  for (const slot of perFile.values()) if (slot.warnings.length <= slot.switches) for (const warning of slot.warnings) excused.add(warning);
  return warnings.filter(warning => !excused.has(warning));
}
