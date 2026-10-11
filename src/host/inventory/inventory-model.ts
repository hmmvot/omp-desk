import type { ChatSlashCommand } from "../../chat/model.ts";

/**
 * The OMP inventory as the staged worker reports it (ADR-0061) and its projection into the four
 * views. Everything here is pure: the worker, the controller and the VS Code trees meet only
 * through these types.
 */
export type ViewKind = "skills" | "tools" | "mcp" | "extensions";
export const VIEW_KINDS: readonly ViewKind[] = ["skills", "tools", "mcp", "extensions"];
export type InventoryScope = "session" | "global";

export type RowKind = "skill" | "custom-tool" | "builtin-tool" | "mcp" | "extension-module" | "plugin";
export type OriginClass = "global" | "project" | "managed" | "other";
export type RowState = "active" | "disabled" | "shadowed";

/** How OMP stores the switch of a row; `null` means Desk offers none (a refusal reason explains why). */
export type ToggleMechanism = "disabledExtensions" | "setting" | "mcp" | "plugin";
export interface RowToggle { readonly mechanism: ToggleMechanism | null; readonly refusal: string | null }

export interface InventoryRow {
	readonly kind: RowKind;
	readonly name: string;
	readonly description: string | null;
	/** File to open on click: SKILL.md, tool/extension module, MCP config, plugin package.json. */
	readonly path: string | null;
	readonly provider: string;
	readonly providerName: string;
	readonly level: "user" | "project" | "native" | "builtin";
	readonly state: RowState;
	/** A lower-priority copy of a same-named item; OMP never switches such a row (it can also be `disabled`). */
	readonly shadowed: boolean;
	readonly disabledReason: string | null;
	/** What an MCP server's transport is, a built-in's setting value or a plugin's version: short plain text. */
	readonly detail: string | null;
	/** `mcp__<server>_` prefix OMP gives the tools of a server. */
	readonly toolPrefix: string | null;
	/** Skills: the name OMP registers the skill under in a session started here (collisions rename), `null` when OMP does not load it. */
	readonly runtimeName: string | null;
	readonly toggle: RowToggle;
}

export interface InventorySnapshot {
	readonly rows: readonly InventoryRow[];
	readonly cwd: string;
	readonly profile: string;
	/** The project's own `.omp/config.yml` sets `disabledExtensions`, which replaces the global list. */
	readonly projectOverridesDisabledExtensions: boolean;
	/** Views whose OMP discovery reported a failed source or a mismatch: their lists may be incomplete and nothing in them can be switched. */
	readonly incomplete: readonly ViewKind[];
	/** Provider ids disabled in OMP's settings: OMP loads nothing from them, so none of their items can appear. */
	readonly disabledProviders: readonly string[];
}

export interface InventoryUnavailable { readonly unavailable: string }
export type InventoryResult = InventorySnapshot | InventoryUnavailable;
export function isUnavailable(result: InventoryResult): result is InventoryUnavailable { return "unavailable" in result }

/** What the running session itself reported; any field is `null` when its source gave nothing. */
export interface SessionEvidence {
	readonly title: string;
	readonly running: boolean;
	/** Chat catalogue entries; `null` for Terminal mode or when no catalogue exists. */
	readonly commands: readonly ChatSlashCommand[] | null;
	/** Tools the session reports, with the authenticated activation mark when known. */
	readonly tools: readonly SessionToolEntry[] | null;
}
export interface SessionToolEntry { readonly name: string; readonly description: string; readonly active: boolean | null }

// --- origin ----------------------------------------------------------------------------------

/** One display class per `{provider, level}` (design: Origin classes). */
export function originClass(row: Pick<InventoryRow, "provider" | "level">): OriginClass {
	if (row.provider === "omp-managed") return "managed";
	if (row.level === "project") return "project";
	if (row.level === "user" && row.provider === "native") return "global";
	return "other";
}
export const ORIGIN_LABELS: Readonly<Record<OriginClass, string>> = {
	global: "Global", project: "Project", managed: "Managed", other: "Other ecosystems",
};
const ORIGIN_ORDER: readonly OriginClass[] = ["global", "project", "managed", "other"];

// --- view model ------------------------------------------------------------------------------

export type IconName = "book" | "tools" | "plug" | "extensions" | "package" | "circle-slash" | "warning" | "server" | "symbol-misc";
export interface ViewItem {
	readonly key: string;
	readonly label: string;
	readonly description: string;
	/** Plain text only: never rendered as Markdown. */
	readonly tooltip: string;
	readonly icon: IconName;
	/** `null` = no checkbox; otherwise the checkbox state, the row's enabled state in OMP's own computation. */
	readonly checked: boolean | null;
	readonly openPath: string | null;
	/** The row a toggle acts on; `null` for rows Desk only displays. */
	readonly row: InventoryRow | null;
}
export interface ViewGroup { readonly id: string; readonly label: string; readonly items: readonly ViewItem[] }
export interface ViewModel {
	/** Replaces the tree with one explanatory row. */
	readonly message: string | null;
	/** Banner above a non-empty tree. */
	readonly notice: string | null;
	readonly groups: readonly ViewGroup[];
	readonly scope: InventoryScope;
	/** Shown beside the view title. */
	readonly description: string;
}
export function emptyView(message: string, scope: InventoryScope = "global", description = "Global"): ViewModel {
	return { message, notice: null, groups: [], scope, description };
}

function plain(...parts: readonly (string | null | undefined)[]): string {
	return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
}
function reasonText(row: InventoryRow): string | null {
	if (row.shadowed || row.state === "shadowed") return "shadowed by a higher-priority item of the same name";
	if (row.state !== "disabled") return null;
	switch (row.disabledReason) {
		case "provider-disabled": return "its provider is disabled in OMP";
		case "user-opt-in": return "its user-level source is not enabled in OMP";
		default: return "disabled";
	}
}
const kindIcon: Readonly<Record<RowKind, IconName>> = {
	skill: "book", "custom-tool": "tools", "builtin-tool": "tools", mcp: "server", "extension-module": "extensions", plugin: "package",
};

function itemOf(row: InventoryRow, note: string | null, extraTooltip: string | null = null): ViewItem {
	const reason = reasonText(row);
	const toggleable = row.toggle.mechanism !== null && !row.shadowed && row.state !== "shadowed";
	const checked = toggleable ? row.state !== "disabled" : null;
	const bits = [row.state === "disabled" ? "disabled" : null, row.shadowed || row.state === "shadowed" ? "shadowed" : null, note, row.detail];
	return {
		key: `${row.kind}:${row.name}:${row.path ?? ""}`,
		label: row.name,
		description: bits.filter((bit): bit is string => bit !== null && bit.length > 0).join(" · "),
		tooltip: plain(row.description, row.detail === null ? null : `Detail: ${row.detail}`, `Origin: ${row.providerName} (${row.level})`,
			row.path === null ? null : `Source: ${row.path}`, reason === null ? null : `State: ${reason}`, note, extraTooltip,
			row.toggle.mechanism === null && row.toggle.refusal !== null ? `Cannot be switched here: ${row.toggle.refusal}` : null,
			toggleable ? "The checkbox changes the global OMP configuration, which applies to every session of this profile." : null),
		icon: row.state === "disabled" ? "circle-slash" : kindIcon[row.kind],
		checked,
		openPath: row.path,
		row: toggleable ? row : null,
	};
}

function byName(a: ViewItem, b: ViewItem): number { return a.label.localeCompare(b.label) }

function groupByOrigin(rows: readonly InventoryRow[], note: (row: InventoryRow) => string | null): ViewGroup[] {
	const groups: ViewGroup[] = [];
	for (const origin of ORIGIN_ORDER) {
		const items = rows.filter(row => originClass(row) === origin).map(row => itemOf(row, note(row)));
		if (items.length > 0) groups.push({ id: origin, label: `${ORIGIN_LABELS[origin]} (${items.length})`, items: items.sort(byName) });
	}
	return groups;
}

// --- skills ----------------------------------------------------------------------------------

function skillCommandNames(commands: readonly ChatSlashCommand[] | null): ReadonlySet<string> | null {
	if (commands === null) return null;
	const names = commands.filter(command => command.source === "skill").map(command => command.name);
	return names.length === 0 ? null : new Set(names);
}

export function projectSkills(rows: readonly InventoryRow[], evidence: SessionEvidence | null, effectiveKnown = true): { groups: ViewGroup[]; notice: string | null } {
	const skills = rows.filter(row => row.kind === "skill");
	const loaded = evidence === null || !evidence.running ? null : skillCommandNames(evidence.commands);
	const commandOf = (row: InventoryRow): string => `skill:${row.runtimeName ?? row.name}`;
	const groups = groupByOrigin(skills, row => {
		if (row.state !== "active") return null;
		if (effectiveKnown && row.runtimeName === null) return "excluded by OMP's skill settings";
		return loaded === null || loaded.has(commandOf(row)) ? null : "not reported by this session";
	});
	const known = new Set(skills.map(commandOf));
	const extra = loaded === null ? [] : [...loaded].filter(name => !known.has(name));
	if (extra.length > 0 && evidence !== null) {
		const items = extra.map(name => ({
			key: `session-skill:${name}`, label: name.replace(/^skill:/, ""), description: "reported by the session", icon: "book" as const,
			tooltip: plain(evidence.commands?.find(command => command.name === name)?.description, "Reported by the session's command catalogue; OMP's inventory has no file for it."),
			checked: null, openPath: null, row: null,
		}));
		groups.push({ id: "session-other", label: `Reported by the session (${items.length})`, items: items.sort(byName) });
	}
	let notice: string | null = null;
	if (evidence !== null && evidence.running && loaded === null) notice = "This session reported no skill commands (skill commands may be off or the catalogue is capped), so what it loaded is unknown.";
	else if (evidence !== null && !evidence.running) notice = "This session is not running; showing the configuration for its folder.";
	return { groups, notice };
}

// --- tools -----------------------------------------------------------------------------------

/**
 * The one server whose `mcp__<server>_` prefix starts a tool name, or `null` when none or several could
 * (OMP mints names lossily: servers `foo` and `foo_bar` both prefix `mcp__foo_bar_x`), so a match is evidence of a name, not proof of ownership.
 */
export function mcpServerOfTool(toolName: string, servers: readonly InventoryRow[]): InventoryRow | null {
	const owners = servers.filter(server => server.toolPrefix !== null && toolName.startsWith(server.toolPrefix) && toolName.length > server.toolPrefix.length);
	return owners.length === 1 ? owners[0]! : null;
}

export function projectTools(rows: readonly InventoryRow[], evidence: SessionEvidence | null): { groups: ViewGroup[]; notice: string | null } {
	const builtins = rows.filter(row => row.kind === "builtin-tool");
	const custom = rows.filter(row => row.kind === "custom-tool");
	const servers = rows.filter(row => row.kind === "mcp");
	const session = evidence !== null && evidence.running ? evidence.tools : null;
	const sessionByName = new Map((session ?? []).map(tool => [tool.name, tool]));
	const sessionNote = (row: InventoryRow): string | null => {
		if (session === null) return null;
		const tool = sessionByName.get(row.name);
		// Absence is a claim only when the authenticated registry was observed; descriptors alone are a partial list.
		if (tool === undefined) return row.state === "disabled" ? null : session.some(entry => entry.active !== null) ? "not in this session" : "not reported by this session";
		return tool.active === false ? "inactive in this session" : null;
	};
	const groups: ViewGroup[] = [];
	const builtinItems = builtins.map(row => itemOf(row, sessionNote(row), sessionByName.get(row.name)?.description ?? null));
	if (builtinItems.length > 0) groups.push({ id: "builtin", label: `Built-in (${builtinItems.length})`, items: builtinItems.sort(byName) });
	for (const group of groupByOrigin(custom, sessionNote)) groups.push({ ...group, id: `custom-${group.id}`, label: `Custom · ${group.label}` });
	if (session !== null) {
		const known = new Set([...builtins, ...custom].map(row => row.name));
		const mcpItems: ViewItem[] = [];
		const otherItems: ViewItem[] = [];
		for (const tool of session) {
			if (known.has(tool.name)) continue;
			const server = mcpServerOfTool(tool.name, servers);
			const item: ViewItem = {
				key: `session-tool:${tool.name}`, label: tool.name, icon: tool.active === false ? "circle-slash" : "tools",
				description: [server === null ? null : `server ${server.name}`, tool.active === false ? "inactive" : tool.active === null ? "activation unknown" : null].filter(Boolean).join(" · "),
				tooltip: plain(tool.description, server === null ? "Reported by the session; no inventory row explains its origin." : `Its name matches the MCP server ${server.name}.`),
				checked: null, openPath: null, row: null,
			};
			(server === null ? otherItems : mcpItems).push(item);
		}
		if (mcpItems.length > 0) groups.push({ id: "mcp", label: `MCP tools (${mcpItems.length})`, items: mcpItems.sort(byName) });
		if (otherItems.length > 0) groups.push({ id: "other", label: `Other session tools (${otherItems.length})`, items: otherItems.sort(byName) });
	}
	let notice: string | null = null;
	if (evidence !== null && !evidence.running) notice = "This session is not running; showing the configuration for its folder.";
	else if (evidence !== null && session === null) notice = "This session's own tool list could not be read, so session membership is not shown.";
	return { groups, notice };
}

// --- MCP -------------------------------------------------------------------------------------

export function projectMcp(rows: readonly InventoryRow[], evidence: SessionEvidence | null): { groups: ViewGroup[]; notice: string | null } {
	const servers = rows.filter(row => row.kind === "mcp");
	const session = evidence !== null && evidence.running ? evidence.tools : null;
	const counts = new Map<InventoryRow, number>();
	for (const tool of session ?? []) {
		const server = mcpServerOfTool(tool.name, servers);
		if (server !== null) counts.set(server, (counts.get(server) ?? 0) + 1);
	}
	const groups = groupByOrigin(servers, row => {
		if (session === null || row.state !== "active") return null;
		const count = counts.get(row) ?? 0;
		return count > 0 ? `${count} name-matched tool${count === 1 ? "" : "s"} in this session` : "no matching tools in this session";
	});
	let notice = "OMP exports no MCP connection status; rows show configuration and the session tools whose names match each server.";
	if (evidence !== null && !evidence.running) notice = "This session is not running; showing the configuration for its folder.";
	return { groups, notice };
}

// --- extensions ------------------------------------------------------------------------------

export function projectExtensions(rows: readonly InventoryRow[], evidence: SessionEvidence | null): { groups: ViewGroup[]; notice: string | null } {
	const modules = rows.filter(row => row.kind === "extension-module");
	const plugins = rows.filter(row => row.kind === "plugin");
	const groups = groupByOrigin(modules, () => null).map(group => ({ ...group, id: `module-${group.id}`, label: `Modules · ${group.label}` }));
	const pluginItems = plugins.map(row => itemOf(row, null));
	if (pluginItems.length > 0) groups.push({ id: "plugins", label: `Plugins (${pluginItems.length})`, items: pluginItems.sort(byName) });
	const notice = evidence !== null && !evidence.running
		? "This session is not running; showing the configuration for its folder."
		: "OMP reports no per-session extension state; rows show configuration.";
	return { groups, notice };
}

// --- whole view ------------------------------------------------------------------------------

export interface ProjectionInput {
	readonly view: ViewKind;
	readonly scope: InventoryScope;
	readonly inventory: InventoryResult;
	readonly evidence: SessionEvidence | null;
	readonly profile: string;
}
const EMPTY_TEXT: Readonly<Record<ViewKind, string>> = {
	skills: "No skills found.", tools: "No tools found.", mcp: "No MCP servers configured.", extensions: "No extensions or plugins found.",
};

/** Fallback when OMP's inventory cannot be read: only what the session itself reports, with no toggles. */
function fallback(view: ViewKind, reason: string, evidence: SessionEvidence | null, scope: InventoryScope, description: string): ViewModel {
	if (scope !== "session" || evidence === null || !evidence.running) return emptyView(reason, scope, description);
	const items: ViewItem[] = [];
	if (view === "skills") {
		for (const command of evidence.commands?.filter(entry => entry.source === "skill") ?? []) {
			items.push({ key: `session-skill:${command.name}`, label: command.name.replace(/^skill:/, ""), description: "reported by the session", icon: "book",
				tooltip: plain(command.description), checked: null, openPath: null, row: null });
		}
	} else if (view === "tools") {
		for (const tool of evidence.tools ?? []) {
			items.push({ key: `session-tool:${tool.name}`, label: tool.name, description: tool.active === false ? "inactive" : tool.active === null ? "activation unknown" : "",
				icon: tool.active === false ? "circle-slash" : "tools", tooltip: tool.description, checked: null, openPath: null, row: null });
		}
	}
	if (items.length === 0) return emptyView(reason, scope, description);
	return { message: null, notice: `${reason} Showing only what the session reports; nothing can be switched.`, scope, description,
		groups: [{ id: "session", label: `Reported by the session (${items.length})`, items: items.sort(byName) }] };
}

const VIEW_OF_ROW: Readonly<Record<RowKind, ViewKind>> = {
	skill: "skills", "custom-tool": "tools", "builtin-tool": "tools", mcp: "mcp", "extension-module": "extensions", plugin: "extensions",
};

export function projectView(input: ProjectionInput): ViewModel {
	const { view, scope, inventory, evidence, profile } = input;
	const suffix = profile === "default" ? "" : ` (profile ${profile})`;
	const description = scope === "session" && evidence !== null ? `Session: ${evidence.title}${suffix}` : `Global${suffix}`;
	if (isUnavailable(inventory)) return fallback(view, inventory.unavailable, evidence, scope, description);
	// A category OMP could not fully load is shown as found but cannot be switched.
	const incomplete = inventory.incomplete.includes(view);
	// Global is user-only by construction (the worker refuses a project layer), so a project-scoped marketplace entry there comes from a user registry.
	const scoped = scope === "global" ? inventory.rows.map(row => row.provider === "claude-plugins" && row.level === "project" ? { ...row, level: "user" as const } : row) : inventory.rows;
	const rows = incomplete ? scoped.map(row => VIEW_OF_ROW[row.kind] === view && row.toggle.mechanism !== null
		? { ...row, toggle: { mechanism: null, refusal: "OMP reported a failure loading some sources of this kind" } } : row) : scoped;
	const effectiveEvidence = scope === "session" ? evidence : null;
	const projected = view === "skills" ? projectSkills(rows, effectiveEvidence, !inventory.incomplete.includes("skills"))
		: view === "tools" ? projectTools(rows, effectiveEvidence)
			: view === "mcp" ? projectMcp(rows, effectiveEvidence) : projectExtensions(rows, effectiveEvidence);
	const overridden = scope === "session" && inventory.projectOverridesDisabledExtensions && view !== "mcp" && view !== "extensions";
	const notices = [
		projected.notice,
		incomplete ? "OMP reported a failure loading some sources, so this list may be incomplete and nothing here can be switched." : null,
		overridden ? "This project's .omp/config.yml sets its own disabledExtensions, which replaces the global list: global switches cannot change sessions here. Use Global to edit the global list." : null,
		inventory.disabledProviders.length > 0 ? `Items from providers disabled in OMP's settings (${inventory.disabledProviders.slice(0, 5).join(", ")}) are not loaded by OMP and are not listed.` : null,
		view === "extensions" && scope === "session" ? "Disabled plugins installed in this project are not listed: OMP offers no listing of them." : null,
	].filter((text): text is string => text !== null);
	if (projected.groups.length === 0) {
		const reasons = notices.filter(text => text !== projected.notice);
		return emptyView(reasons.length > 0 ? `${EMPTY_TEXT[view]} ${reasons.join(" ")}` : EMPTY_TEXT[view], scope, description);
	}
	return { message: null, notice: notices.length === 0 ? null : notices.join(" "), groups: projected.groups, scope, description };
}

// --- applying a toggle -----------------------------------------------------------------------

export type Applies = "live" | "next-session";
/** Fixed per-kind table (design: Toggles). OMP, not Desk, applies the change. */
export function appliesTo(row: Pick<InventoryRow, "kind">): Applies {
	switch (row.kind) {
		case "skill": case "extension-module": case "builtin-tool": return "live";
		default: return "next-session";
	}
}
export function toggleMessage(row: Pick<InventoryRow, "kind" | "name">, enabled: boolean, changed: boolean, sessionRunning: boolean): string {
	const verb = enabled ? "Enabled" : "Disabled";
	const what = row.kind === "builtin-tool" ? "tool" : row.kind === "extension-module" ? "extension" : row.kind === "custom-tool" ? "tool" : row.kind === "mcp" ? "MCP server" : row.kind;
	if (!changed) return `${row.name} is already ${enabled ? "enabled" : "disabled"} in the global OMP configuration.`;
	const base = `${verb} ${what} ${row.name} in the global OMP configuration (all sessions of this profile).`;
	if (!sessionRunning) return `${base} It applies to new sessions.`;
	if (appliesTo(row) === "live") {
		return row.kind === "extension-module"
			? `${base} Running sessions may apply it live; an extension a session never loaded needs a restart.`
			: `${base} Running sessions may apply it live; the view shows what the session reports.`;
	}
	return `${base} Restart a running session to apply it; new sessions pick it up.`;
}

/** Desk's own `-e` module is never discoverable, but a hand-built request for it is refused too. */
export const PROTECTED_EXTENSION_NAMES: Readonly<Record<string, true>> = { "omp-host-control": true };
