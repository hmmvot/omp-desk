import { isRecord as record } from "../../guards.ts";
import { SettingsRefusal } from "../omp-settings-core.ts";
import { SOURCE_ROLES } from "./inventory-model.ts";
import type { InventoryResult, InventoryRow, InventoryScope, InventorySnapshot, RowKind, RowSource, RowToggle, SourceRole, ToggleMechanism, ViewKind } from "./inventory-model.ts";

/**
 * The extension-host half of the inventory worker (ADR-0061): it asks for a read or a switch and
 * validates the receipt. The receipt crosses a process boundary, so nothing is trusted beyond
 * what is checked here, and any failure is a fixed, credential-free sentence.
 */
export interface WorkerEnvironment { readonly bun: string; readonly packageRoot: string; readonly helperPath: string }
export interface InventoryRuntimeDeps {
	/** Resolve Bun, the selected OMP package root and the verified staged worker, or say why not. */
	environment(): Promise<WorkerEnvironment | { readonly unavailable: string }>;
	run(input: { environment: WorkerEnvironment; cwd: string; profile: string; request: Record<string, unknown> }): Promise<unknown>;
}
export interface InventoryReadRequest { readonly cwd: string; readonly profile: string; readonly scope: InventoryScope }
export interface ToggleRequest { readonly cwd: string; readonly profile: string; readonly scope: InventoryScope; readonly kind: RowKind; readonly name: string; readonly enabled: boolean }
/** What a switch changed, as the worker reported it: the file (`null` where OMP's plugin store owns the location) and a short description. */
export interface ToggleWrite { readonly file: string | null; readonly what: string }
export type ToggleResult = { readonly ok: true; readonly changed: boolean; readonly writes: readonly ToggleWrite[] } | { readonly ok: false; readonly message: string };
export interface InventoryRuntime {
	read(request: InventoryReadRequest): Promise<InventoryResult>;
	toggle(request: ToggleRequest): Promise<ToggleResult>;
}

const ROW_KINDS: readonly string[] = ["skill", "custom-tool", "builtin-tool", "mcp", "extension-module", "plugin"];
const MECHANISMS: readonly string[] = ["disabledExtensions", "setting", "mcp", "plugin"];
const LEVELS: readonly string[] = ["user", "project", "native", "builtin"];
const STATES: readonly string[] = ["active", "disabled", "shadowed"];
const VIEWS: readonly string[] = ["skills", "tools", "mcp", "extensions"];
const MAX_ROWS = 5000;
const MAX_TEXT = 2048;

function text(value: unknown, required = false): string | null | undefined {
	if (value === null || value === undefined) return required ? undefined : null;
	return typeof value === "string" && value.length <= MAX_TEXT ? value : undefined;
}

function parseToggle(value: unknown): RowToggle | null {
	if (!record(value)) return null;
	const mechanism = value.mechanism;
	const refusal = text(value.refusal);
	if (refusal === undefined || (mechanism !== null && !(typeof mechanism === "string" && MECHANISMS.includes(mechanism)))) return null;
	return { mechanism: mechanism as ToggleMechanism | null, refusal };
}

const MAX_SOURCES = 32;
function parseSources(value: unknown): readonly RowSource[] | null {
	if (!Array.isArray(value) || value.length > MAX_SOURCES) return null;
	const sources: RowSource[] = [];
	for (const entry of value) {
		if (!record(entry)) return null;
		const path = text(entry.path);
		const providerName = text(entry.providerName, true);
		if (path === undefined || typeof providerName !== "string" || typeof entry.level !== "string" || !LEVELS.includes(entry.level) || typeof entry.role !== "string" || !SOURCE_ROLES.includes(entry.role)) return null;
		sources.push({ path, providerName, level: entry.level as RowSource["level"], role: entry.role as SourceRole });
	}
	return sources;
}

export function parseRow(value: unknown): InventoryRow | null {
	if (!record(value)) return null;
	const { kind, level, state } = value;
	const name = text(value.name, true);
	const provider = text(value.provider, true);
	const providerName = text(value.providerName, true);
	const description = text(value.description);
	const path = text(value.path);
	const disabledReason = text(value.disabledReason);
	const runtimeName = text(value.runtimeName);
	const detail = text(value.detail);
	const toolPrefix = text(value.toolPrefix);
	const toggle = parseToggle(value.toggle);
	const sources = parseSources(value.sources);
	if (sources === null) return null;
	if (typeof kind !== "string" || !ROW_KINDS.includes(kind) || typeof level !== "string" || !LEVELS.includes(level) || typeof state !== "string" || !STATES.includes(state) ||
		typeof name !== "string" || name.length === 0 || typeof provider !== "string" || typeof providerName !== "string" ||
		description === undefined || path === undefined || disabledReason === undefined || detail === undefined || toolPrefix === undefined || runtimeName === undefined || typeof value.shadowed !== "boolean" || toggle === null) return null;
	return { kind: kind as InventoryRow["kind"], name, description, path, provider, providerName, level: level as InventoryRow["level"], state: state as InventoryRow["state"], shadowed: value.shadowed, disabledReason, detail, toolPrefix, runtimeName, toggle, sources };
}

export function parseSnapshot(value: unknown): InventorySnapshot | null {
	if (!record(value) || !Array.isArray(value.rows) || value.rows.length > MAX_ROWS || typeof value.cwd !== "string" || typeof value.profile !== "string" ||
		typeof value.projectOverridesDisabledExtensions !== "boolean" || !Array.isArray(value.incomplete) || !Array.isArray(value.disabledProviders) || value.disabledProviders.length > 100 ||
		!value.disabledProviders.every((id): id is string => typeof id === "string" && id.length <= 200) ||
		!value.incomplete.every((view): view is ViewKind => typeof view === "string" && VIEWS.includes(view))) return null;
	const rows: InventoryRow[] = [];
	for (const raw of value.rows) {
		const row = parseRow(raw);
		if (row === null) return null;
		rows.push(row);
	}
	return { rows, cwd: value.cwd, profile: value.profile, projectOverridesDisabledExtensions: value.projectOverridesDisabledExtensions, incomplete: value.incomplete, disabledProviders: value.disabledProviders };
}

const MAX_WRITES = 8;
function parseWrites(value: unknown): ToggleWrite[] | null {
	if (!Array.isArray(value) || value.length > MAX_WRITES) return null;
	const writes: ToggleWrite[] = [];
	for (const entry of value) {
		if (!record(entry)) return null;
		const file = text(entry.file);
		const what = text(entry.what, true);
		if (file === undefined || what === undefined || what === null) return null;
		writes.push({ file, what });
	}
	return writes;
}

const UNAVAILABLE_READ = "OMP's inventory could not be read with the installed OMP.";

export function createInventoryRuntime(deps: InventoryRuntimeDeps): InventoryRuntime {
	return {
		async read(request) {
			const environment = await deps.environment();
			if ("unavailable" in environment) return { unavailable: environment.unavailable };
			try {
				const receipt = await deps.run({ environment, cwd: request.cwd, profile: request.profile, request: { action: "read", scope: request.scope } });
				return parseSnapshot(receipt) ?? { unavailable: `${UNAVAILABLE_READ} (unrecognised result)` };
			} catch (error) {
				return { unavailable: error instanceof SettingsRefusal ? error.message : UNAVAILABLE_READ };
			}
		},
		async toggle(request) {
			const environment = await deps.environment();
			if ("unavailable" in environment) return { ok: false, message: environment.unavailable };
			try {
				const receipt = await deps.run({ environment, cwd: request.cwd, profile: request.profile,
					request: { action: "toggle", scope: request.scope, kind: request.kind, name: request.name, enabled: request.enabled } });
				if (!record(receipt) || typeof receipt.changed !== "boolean") return { ok: false, message: "OMP returned an unrecognised result; refresh to see the current state." };
				const writes = parseWrites(receipt.writes);
				if (writes === null || (!receipt.changed && writes.length > 0)) return { ok: false, message: "OMP returned an unrecognised result; refresh to see the current state." };
				return { ok: true, changed: receipt.changed, writes };
			} catch (error) {
				return { ok: false, message: error instanceof SettingsRefusal ? error.message : "The switch could not be written. Refresh to see the current state." };
			}
		},
	};
}
