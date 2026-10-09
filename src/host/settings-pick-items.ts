import type { ConfigEdit, SettingsModel, SettingsRole, SettingsScope, SettingsSnapshot } from "./omp-settings-core.ts";

/** What a model choice is for; each purpose offers the values its OMP setting accepts. */
export type PickPurpose = "role" | "fallback-entry" | "agent-override" | "prewalk" | "advisor";
export const LIST_PICK_PURPOSES: readonly Exclude<PickPurpose, "role">[] = ["fallback-entry", "agent-override", "prewalk", "advisor"];
/** One QuickPick row, or a provider/group separator. Labels may carry `$(icon)` codicons. */
export type PickEntry =
  | { readonly separator: string }
  | { readonly label: string; readonly description?: string; readonly detail?: string; readonly value: string; readonly current: boolean; readonly available: boolean };
export type PickSnapshot = Pick<SettingsSnapshot, "models" | "roles" | "providers" | "effective">;
export interface ModelPickInput {
  readonly purpose: PickPurpose;
  readonly snapshot: PickSnapshot;
  /** The role being assigned (purpose `role`). */
  readonly role?: string;
  /** The value in force, marked with a check and focused. */
  readonly current?: string;
  /** Values already in the list being edited; they are not offered again. */
  readonly exclude?: readonly string[];
  /** Offer an Automatic item that clears the role's assignment in the write scope. */
  readonly clearable?: boolean;
  readonly showUnavailable: boolean;
}

const THINKING_SUFFIX = /:(?:inherit|auto|off|minimal|low|medium|high|xhigh|max)$/;
export function selectorBase(value: string): string { return value.replace(THINKING_SUFFIX, ""); }
export function selectorThinking(value: string): string | undefined { return THINKING_SUFFIX.exec(value)?.[0].slice(1); }
export function modelKey(model: Pick<SettingsModel, "provider" | "id">): string { return `${model.provider}/${model.id}`; }

/** The saved role change: OMP stores thinking as a selector suffix, except auto on the default role, which is the global default thinking level. */
export function roleChange(role: string, model: string, thinking: string | undefined, scope: SettingsScope): { edits: ConfigEdit[]; thinking?: string } {
  const base = selectorBase(model.trim());
  if (!base) return { edits: [{ path: ["modelRoles", role], ...(scope === "project" ? { value: null } : {}) }] };
  if (role === "default" && thinking === "auto") return { edits: [{ path: ["modelRoles", role], value: base }], thinking: "auto" };
  return { edits: [{ path: ["modelRoles", role], value: !thinking || thinking === "inherit" ? base : `${base}:${thinking}` }] };
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
function compact(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  return value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(1))}M` : value >= 1_000 ? `${Math.round(value / 1_000)}K` : String(value);
}
const PROVIDER_STATUS: Readonly<Record<string, string>> = { locked: "needs login", unavailable: "unreachable" };
function providerNote(snapshot: PickSnapshot, provider: string): string {
  const status = snapshot.providers.find(item => item.id === provider)?.status ?? "locked";
  return PROVIDER_STATUS[status] ?? "not available";
}
/** Roles whose effective selection is each model, in OMP's role order. */
export function rolesByModel(roles: readonly SettingsRole[]): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const role of roles) if (role.resolved) used.set(role.resolved, [...used.get(role.resolved) ?? [], role.id]);
  return used;
}
/** Providers in `modelProviderOrder` first, then alphabetically; usable providers always lead locked ones. */
export function providerOrder(snapshot: PickSnapshot, providers: Iterable<string>): string[] {
  const preferred = Array.isArray(snapshot.effective.modelProviderOrder) ? snapshot.effective.modelProviderOrder.filter((item): item is string => typeof item === "string") : [];
  const rank = (provider: string): number => { const index = preferred.indexOf(provider); return index < 0 ? preferred.length : index; };
  const available = new Set(snapshot.models.filter(model => model.available).map(model => model.provider));
  return [...new Set(providers)].sort((a, b) => Number(available.has(b)) - Number(available.has(a)) || rank(a) - rank(b) || collator.compare(a, b));
}
/** Recently used first (most recent leading), then newest-looking ids first, as OMP's browser orders versions. */
function modelOrder(a: SettingsModel, b: SettingsModel): number {
  const recentA = a.recent < 0 ? Number.MAX_SAFE_INTEGER : a.recent; const recentB = b.recent < 0 ? Number.MAX_SAFE_INTEGER : b.recent;
  return recentA - recentB || collator.compare(b.id, a.id);
}

function modelEntry(model: SettingsModel, usedBy: ReadonlyMap<string, readonly string[]>, current: string | undefined, unavailableNote = "needs login"): PickEntry {
  const key = modelKey(model);
  const selected = key === current;
  const roles = usedBy.get(key) ?? [];
  const context = compact(model.contextWindow);
  const cost = model.cost;
  const free = typeof cost?.input === "number" && typeof cost.output === "number" && cost.input === 0 && cost.output === 0;
  const details = [
    roles.length ? `$(account) ${roles.join(", ")}` : "",
    model.reasoning && model.efforts.length ? `$(lightbulb) ${model.efforts.join(", ")}` : "",
    model.available ? "" : `$(lock) ${model.provider} ${unavailableNote}`,
  ].filter(Boolean);
  return {
    label: `${selected ? "$(check) " : ""}${key}`,
    description: [model.name !== model.id ? model.name : "", context ? `${context} context` : "", free ? "free" : "", selected ? "current" : ""].filter(Boolean).join(" · "),
    ...(details.length ? { detail: details.join("   ") } : {}),
    value: key, current: selected, available: model.available,
  };
}

/** Model QuickPick rows: purpose-specific choices, roles' models, then one group per provider with usable providers first. */
export function modelPickEntries(input: ModelPickInput): PickEntry[] {
  const { snapshot, purpose } = input;
  const excluded = new Set(input.exclude ?? []);
  const current = input.current === undefined ? undefined : purpose === "role" ? selectorBase(input.current) : input.current;
  const usedBy = rolesByModel(snapshot.roles);
  const entries: PickEntry[] = [];
  const push = (entry: PickEntry): void => { if ("separator" in entry || !excluded.has(entry.value)) entries.push(entry); };
  if (purpose === "role" && input.clearable) push({ label: "$(circle-slash) Automatic", description: "Clear this role's assignment; OMP chooses the model", value: "", current: false, available: true });
  if (purpose === "prewalk" || purpose === "advisor") {
    const fallback = purpose === "prewalk" ? "@smol" : "@advisor";
    push({ label: `${current === "on" ? "$(check) " : ""}Agent default`, description: `The agent's own model, else ${fallback}`, value: "on", current: current === "on", available: true });
  }
  if (purpose !== "role" && purpose !== "fallback-entry") {
    entries.push({ separator: "Roles" });
    for (const role of snapshot.roles) {
      const value = `@${role.id}`;
      push({ label: `${value === current ? "$(check) " : ""}${value}`, description: role.resolved ? `→ ${role.resolved}${role.thinking ? ` · ${role.thinking}` : ""}` : role.selector ? "no available model" : "automatic",
        value, current: value === current, available: Boolean(role.resolved) || !role.selector });
    }
  }
  const role = purpose === "role" ? snapshot.roles.find(item => item.id === input.role) : undefined;
  const accepted = role ? new Set(role.accepts) : undefined;
  const candidates = snapshot.models.filter(model => model.available ? !accepted || accepted.has(modelKey(model)) : input.showUnavailable);
  const inUse = candidates.filter(model => model.available && usedBy.has(modelKey(model)));
  if (inUse.length) {
    entries.push({ separator: "Used by roles" });
    for (const model of inUse.sort((a, b) => (usedBy.get(modelKey(b))?.length ?? 0) - (usedBy.get(modelKey(a))?.length ?? 0) || modelOrder(a, b))) push(modelEntry(model, usedBy, current));
  }
  const shown = new Set(inUse.map(modelKey));
  const byProvider = new Map<string, SettingsModel[]>();
  for (const model of candidates) if (!shown.has(modelKey(model))) byProvider.set(model.provider, [...byProvider.get(model.provider) ?? [], model]);
  for (const provider of providerOrder(snapshot, byProvider.keys())) {
    const models = byProvider.get(provider)!;
    const note = providerNote(snapshot, provider);
    entries.push({ separator: models.some(model => model.available) ? provider : `${provider} — ${note}` });
    for (const model of models.sort(modelOrder)) push(modelEntry(model, usedBy, current, note));
  }
  if (purpose === "fallback-entry") {
    const providers = providerOrder(snapshot, snapshot.providers.filter(provider => provider.available || input.showUnavailable).map(provider => provider.id));
    if (providers.length) entries.push({ separator: "Same model on another provider" });
    for (const provider of providers) {
      const available = snapshot.providers.some(item => item.id === provider && item.available);
      push({ label: `${provider}/*`, description: "Keeps the failing model's id on this provider", ...(available ? {} : { detail: `$(lock) ${providerNote(snapshot, provider)}` }), value: `${provider}/*`, current: false, available });
    }
  }
  return dropEmptyGroups(entries);
}

/** Separators followed by no row (everything excluded) are removed. */
function dropEmptyGroups(entries: readonly PickEntry[]): PickEntry[] {
  return entries.filter((entry, index) => !("separator" in entry) || (entries[index + 1] !== undefined && !("separator" in entries[index + 1]!)));
}

const THINKING_DESCRIPTIONS: Readonly<Record<string, string>> = {
  inherit: "No suffix: use the session's thinking level", off: "No reasoning", auto: "Let OMP choose per request",
  minimal: "Fastest reasoning", low: "Light reasoning", medium: "Balanced reasoning", high: "Thorough reasoning", xhigh: "Extra thorough reasoning", max: "Maximum reasoning",
};
/** The TUI's thinking strip: inherit, off, auto, then the model's supported efforts. */
export function thinkingPickEntries(efforts: readonly string[], current: string): PickEntry[] {
  return [...new Set(["inherit", "off", "auto", ...efforts])].map(level => ({
    label: `${level === current ? "$(check) " : ""}${level}`, description: THINKING_DESCRIPTIONS[level], value: level, current: level === current, available: true,
  }));
}

/** Keys OMP accepts for `retry.fallbackChains`: a role, an exact model or a provider wildcard. Configured keys are left out. */
export function chainKeyEntries(snapshot: PickSnapshot, configured: readonly string[]): PickEntry[] {
  const taken = new Set(configured);
  const entries: PickEntry[] = [{ separator: "Roles" }];
  for (const role of snapshot.roles) if (!taken.has(role.id)) entries.push({ label: role.id, description: role.resolved ? `role · now ${role.resolved}` : "role", value: role.id, current: false, available: true });
  entries.push({ separator: "Whole provider" });
  for (const provider of providerOrder(snapshot, snapshot.providers.map(item => item.id))) {
    const key = `${provider}/*`;
    const available = snapshot.providers.some(item => item.id === provider && item.available);
    if (!taken.has(key)) entries.push({ label: key, description: available ? "any model on this provider" : `any model on this provider · ${providerNote(snapshot, provider)}`, value: key, current: false, available });
  }
  entries.push({ separator: "Exact model" });
  const usedBy = rolesByModel(snapshot.roles);
  for (const model of snapshot.models.filter(model => model.available).sort((a, b) => collator.compare(a.provider, b.provider) || modelOrder(a, b))) {
    if (!taken.has(modelKey(model))) entries.push(modelEntry(model, usedBy, undefined));
  }
  return dropEmptyGroups(entries);
}
