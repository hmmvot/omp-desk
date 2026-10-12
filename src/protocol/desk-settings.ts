/**
 * The Settings view's pure core: the contributed configuration schema projected into rows and
 * controls, the effective value and its source layer, input validation, the layer a change is
 * written to and the layers a reset clears. It imports nothing from VS Code, so the host controller,
 * the Webview bundle and the tests share exactly one copy of every rule.
 */
import { OMP_PATH_SETTING } from "../shared/omp-unavailable.ts";

/** Settings whose row carries a **Test** button: the page asks the host to try the typed value without saving it. */
const TESTABLE_KEYS: Readonly<Record<string, true>> = { [OMP_PATH_SETTING]: true };

export function isTestable(key: string): boolean {
	return TESTABLE_KEYS[key] === true;
}
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** The configuration layers the view reads and writes. Folder layers are never written (see the design). */
export type Target = "user" | "workspace";
/** Where the value in effect comes from. */
export type Source = "default" | "user" | "workspace";

export interface EnumOption {
	readonly value: JsonPrimitive;
	readonly label: string;
	readonly description?: string;
}

export type Control =
	| { readonly kind: "boolean" }
	| { readonly kind: "enum"; readonly options: readonly EnumOption[] }
	| {
		readonly kind: "number";
		readonly integer: boolean;
		readonly minimum?: number;
		readonly maximum?: number;
		readonly exclusiveMinimum?: number;
		readonly exclusiveMaximum?: number;
		readonly multipleOf?: number;
	}
	| {
		readonly kind: "string";
		readonly multiline: boolean;
		readonly minLength?: number;
		readonly maxLength?: number;
		readonly pattern?: string;
		readonly patternErrorMessage?: string;
	}
	/** Arrays, objects and every shape without a faithful single-value control: read-only here, edited in settings.json. */
	| { readonly kind: "json" };

export interface SettingDescriptor {
	readonly key: string;
	/** "Tool Call Detail", or "Agent Debugger: Enabled" for a key with a sub-category. */
	readonly label: string;
	readonly groupId: string;
	readonly groupTitle: string;
	/** Plain text with optional `code` spans and **bold**; links are reduced to their text. */
	readonly description: string;
	readonly deprecation?: string;
	/** The schema's own scope; an omitted scope is `window`, as in VS Code. */
	readonly scope: string;
	/** Whether VS Code reads a workspace value of this setting (application and machine settings are user-only). */
	readonly workspaceWritable: boolean;
	readonly control: Control;
}

export interface ConfigLayers {
	readonly defaultValue?: JsonValue;
	readonly globalValue?: JsonValue;
	readonly workspaceValue?: JsonValue;
}

export interface WorkspaceFacts {
	readonly available: boolean;
	readonly name: string | null;
}

/** One row as the page renders it. */
export interface SettingView {
	readonly key: string;
	readonly label: string;
	readonly description: string;
	readonly deprecation?: string;
	readonly control: Control;
	/** The effective value; absent when no layer and no default defines one. */
	readonly value?: JsonValue;
	readonly defaultValue?: JsonValue;
	readonly source: Source;
	/** A user or workspace layer holds a value, so Reset has something to clear. */
	readonly modified: boolean;
	/** The layers Reset clears, topmost first: stated before the action, because it can include the user-wide value. */
	readonly resetLayers: readonly Target[];
	/** Folders of the open workspace that hold a value Desk never reads (it reads settings without a folder). */
	readonly folders: readonly string[];
	/** Layers a change may be written to, and the one used unless the user chooses another. */
	readonly targets: readonly Target[];
	readonly defaultTarget: Target;
	/** A line on where this setting lives, for settings whose scope limits the layers. */
	readonly scopeNote?: string;
	/** The row offers a Test button for the value typed into it. */
	readonly test?: true;
}

export interface SettingGroupView {
	readonly id: string;
	readonly title: string;
	readonly settings: readonly SettingView[];
}

const MAX_SETTINGS = 500;
/** Scopes whose workspace layer VS Code ignores. */
const USER_ONLY_SCOPES: Record<string, true> = { application: true, machine: true };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() !== "" ? value : undefined;
const primitive = (value: unknown): value is JsonPrimitive =>
	value === null || typeof value === "string" || typeof value === "boolean" || finite(value);

/** "toolCallDetail" -> "Tool Call Detail"; "MCPServers" -> "MCP Servers". */
export function humanize(identifier: string): string {
	return identifier
		.replace(/[-_]+/g, " ")
		.replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ")
		.replace(/(?<=[A-Z])(?=[A-Z][a-z])/g, " ")
		.split(" ")
		.filter(word => word !== "")
		.map(word => word[0]!.toUpperCase() + word.slice(1))
		.join(" ");
}

/** Reduce the Markdown a schema may carry to the inline subset the page renders: `code`, **bold**, paragraphs. */
export function plainDescription(source: string): string {
	return source
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\r\n?/g, "\n")
		.trim();
}

/** `undefined` when the schema has no `enum`; `null` when it has one the page cannot offer faithfully. */
function enumOptions(property: Record<string, unknown>): EnumOption[] | null | undefined {
	const values = property.enum;
	if (values === undefined) return undefined;
	if (!Array.isArray(values) || values.length === 0 || !values.every(primitive)) return null;
	const labels = Array.isArray(property.enumItemLabels) ? property.enumItemLabels : [];
	const described = Array.isArray(property.markdownEnumDescriptions) ? property.markdownEnumDescriptions
		: Array.isArray(property.enumDescriptions) ? property.enumDescriptions : [];
	return values.map((value, index): EnumOption => {
		const description = text(described[index]);
		return {
			value,
			label: text(labels[index]) ?? String(value),
			...(description === undefined ? {} : { description: plainDescription(description) }),
		};
	});
}

/** Validation keywords this projection cannot enforce: a schema that uses one is edited in settings.json, never through a control that would accept what VS Code rejects. */
const UNENFORCED_KEYWORDS = ["format", "allOf", "not", "const", "if", "then", "else", "dependencies", "dependentSchemas", "contentMediaType", "contentEncoding"];

/** The single-value control for the schema's type and its bounds; `json` when the type is not one the page can edit. */
function valueControl(type: string, property: Record<string, unknown>): Control {
	switch (type) {
		case "boolean":
			return { kind: "boolean" };
		case "number":
		case "integer":
			return {
				kind: "number",
				integer: type === "integer",
				...(finite(property.minimum) ? { minimum: property.minimum } : {}),
				...(finite(property.maximum) ? { maximum: property.maximum } : {}),
				...(finite(property.exclusiveMinimum) ? { exclusiveMinimum: property.exclusiveMinimum } : {}),
				...(finite(property.exclusiveMaximum) ? { exclusiveMaximum: property.exclusiveMaximum } : {}),
				...(finite(property.multipleOf) && property.multipleOf > 0 ? { multipleOf: property.multipleOf } : {}),
			};
		case "string": {
			const message = text(property.patternErrorMessage) ?? text(property.errorMessage);
			return {
				kind: "string",
				multiline: property.editPresentation === "multilineText",
				...(finite(property.minLength) ? { minLength: property.minLength } : {}),
				...(finite(property.maxLength) ? { maxLength: property.maxLength } : {}),
				...(typeof property.pattern === "string" && property.pattern !== "" ? { pattern: property.pattern } : {}),
				...(message === undefined ? {} : { patternErrorMessage: message }),
			};
		}
		default:
			return { kind: "json" };
	}
}

function controlOf(property: Record<string, unknown>): Control {
	const declared = property.type;
	const type = typeof declared === "string" ? declared
		: Array.isArray(declared) && declared.length === 1 && typeof declared[0] === "string" ? declared[0] : undefined;
	// Anything that is not one simple type (a union, a $ref, anyOf, no type) or that carries a rule the page cannot check has no faithful control.
	if (type === undefined || property.anyOf !== undefined || property.oneOf !== undefined || property.$ref !== undefined) return { kind: "json" };
	if (UNENFORCED_KEYWORDS.some(keyword => property[keyword] !== undefined)) return { kind: "json" };
	const base = valueControl(type, property);
	if (base.kind === "string" && base.pattern !== undefined) {
		try { new RegExp(base.pattern, "u"); } catch { return { kind: "json" }; }
	}
	const options = enumOptions(property);
	if (options === undefined) return base;
	// An enumeration that is present but unusable (empty, or with a non-primitive entry) must not lose its restriction.
	if (options === null) return { kind: "json" };
	// An enumeration still has the type's own bounds: an option those bounds reject is not offered.
	if (base.kind === "json") return base;
	const allowed = options.filter(option => checkValue(base, option.value).ok);
	return allowed.length === 0 ? { kind: "json" } : { kind: "enum", options: allowed };
}

interface Section { readonly title: string | undefined; readonly order: number | undefined; readonly properties: Record<string, unknown> }

function sectionsOf(configuration: unknown): Section[] {
	const raw = Array.isArray(configuration) ? configuration : configuration === undefined ? [] : [configuration];
	const sections: Section[] = [];
	for (const entry of raw) {
		if (!isObject(entry) || !isObject(entry.properties)) continue;
		sections.push({ title: text(entry.title), order: finite(entry.order) ? entry.order : undefined, properties: entry.properties });
	}
	// Sections are ordered by `order`, then declaration order (Desk keeps the author's order); a section without `order` comes last.
	return sections
		.map((section, index) => ({ section, index }))
		.sort((a, b) => (a.section.order ?? Number.MAX_SAFE_INTEGER) - (b.section.order ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
		.map(item => item.section);
}

/**
 * Project `contributes.configuration` (one section or an array) into the setting descriptors, in
 * Desk's own order (by `order`, then declaration order). The projection is the only list of settings:
 * a property added to package.json appears here without any other change.
 */
export function projectConfiguration(configuration: unknown): SettingDescriptor[] {
	const sections = sectionsOf(configuration);
	const seen = new Set<string>();
	const descriptors: SettingDescriptor[] = [];
	sections.forEach((section, sectionIndex) => {
		const entries = Object.entries(section.properties)
			.map(([key, property], index) => ({ key, property, index }))
			.filter((entry): entry is { key: string; property: Record<string, unknown>; index: number } => isObject(entry.property) && entry.property.included !== false)
			.sort((a, b) => {
				const left = finite(a.property.order) ? a.property.order : Number.MAX_SAFE_INTEGER;
				const right = finite(b.property.order) ? b.property.order : Number.MAX_SAFE_INTEGER;
				return left - right || a.index - b.index;
			});
		for (const { key, property } of entries) {
			if (seen.has(key) || descriptors.length >= MAX_SETTINGS) continue;
			seen.add(key);
			const segments = key.split(".");
			const name = humanize(segments[segments.length - 1]!);
			const subgroup = segments.length > 2 ? segments.slice(1, -1).map(humanize).join(" ") : undefined;
			const scope = text(property.scope) ?? "window";
			const description = text(property.markdownDescription) ?? text(property.description) ?? "";
			const deprecation = text(property.markdownDeprecationMessage) ?? text(property.deprecationMessage);
			const sectionTitle = section.title;
			const groupTitle = subgroup === undefined
				? (sections.length > 1 && sectionTitle !== undefined ? sectionTitle : "General")
				: (sections.length > 1 && sectionTitle !== undefined ? `${sectionTitle} · ${subgroup}` : subgroup);
			descriptors.push({
				key,
				label: subgroup === undefined ? name : `${subgroup}: ${name}`,
				groupId: `${sectionIndex}:${subgroup ?? ""}`,
				groupTitle,
				description: plainDescription(description),
				...(deprecation === undefined ? {} : { deprecation: plainDescription(deprecation) }),
				scope,
				workspaceWritable: USER_ONLY_SCOPES[scope] !== true,
				control: controlOf(property),
			});
		}
	});
	return descriptors;
}

export function sameValue(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
	}
	if (typeof a === "object" && typeof b === "object") {
		const left = Object.keys(a);
		const right = Object.keys(b);
		return left.length === right.length && left.every(key => key in b && sameValue(a[key], b[key]));
	}
	return false;
}

// ---- validation -------------------------------------------------------------------------------

export type Parsed = { readonly ok: true; readonly value: JsonValue } | { readonly ok: false; readonly message: string };

const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const reject = (message: string): Parsed => ({ ok: false, message });
const accept = (value: JsonValue): Parsed => ({ ok: true, value });

/** The bound violated by a number, in VS Code's own wording, or null. */
function numberBound(control: Extract<Control, { kind: "number" }>, value: number): string | null {
	if (control.integer && !Number.isInteger(value)) return "The value must be a whole number.";
	if (control.minimum !== undefined && value < control.minimum) return `The value must be at least ${control.minimum}.`;
	if (control.maximum !== undefined && value > control.maximum) return `The value must be at most ${control.maximum}.`;
	if (control.exclusiveMinimum !== undefined && value <= control.exclusiveMinimum) return `The value must be greater than ${control.exclusiveMinimum}.`;
	if (control.exclusiveMaximum !== undefined && value >= control.exclusiveMaximum) return `The value must be less than ${control.exclusiveMaximum}.`;
	if (control.multipleOf !== undefined) {
		const quotient = value / control.multipleOf;
		if (Math.abs(quotient - Math.round(quotient)) > 1e-9) return `The value must be a multiple of ${control.multipleOf}.`;
	}
	return null;
}

function stringBound(control: Extract<Control, { kind: "string" }>, value: string): string | null {
	if (control.minLength !== undefined && value.length < control.minLength) return `Enter at least ${control.minLength} character${control.minLength === 1 ? "" : "s"}.`;
	if (control.maxLength !== undefined && value.length > control.maxLength) return `Enter at most ${control.maxLength} character${control.maxLength === 1 ? "" : "s"}.`;
	if (control.pattern !== undefined) {
		let expression: RegExp | null = null;
		try { expression = new RegExp(control.pattern, "u"); } catch { /* an unusable schema pattern cannot reject input */ }
		if (expression !== null && !expression.test(value)) return control.patternErrorMessage ?? `The value must match ${control.pattern}.`;
	}
	return null;
}

/** Check a typed value (what the host receives and what is written) against the control. */
export function checkValue(control: Control, value: unknown): Parsed {
	switch (control.kind) {
		case "boolean":
			return typeof value === "boolean" ? accept(value) : reject("The value must be true or false.");
		case "enum": {
			const match = control.options.find(option => option.value === value);
			return match === undefined ? reject("Choose one of the listed values.") : accept(match.value);
		}
		case "number": {
			if (!finite(value)) return reject("Enter a number.");
			const bound = numberBound(control, value);
			return bound === null ? accept(value) : reject(bound);
		}
		case "string": {
			if (typeof value !== "string") return reject("The value must be text.");
			const bound = stringBound(control, value);
			return bound === null ? accept(value) : reject(bound);
		}
		case "json":
			return reject("Edit this setting in settings.json.");
	}
}

/** Turn what the user typed into a typed value, or the reason it cannot be one; `checkValue` has the final say. */
export function parseInput(control: Control, input: string): Parsed {
	if (control.kind === "number") {
		const trimmed = input.trim();
		if (trimmed === "") return reject("Enter a number.");
		if (!NUMBER_TEXT.test(trimmed)) return reject("Enter a number.");
		return checkValue(control, Number(trimmed));
	}
	return checkValue(control, input);
}

/** The text an input shows for a value. */
export function inputText(value: JsonValue | undefined): string {
	return value === undefined || value === null ? "" : typeof value === "string" ? value : String(value);
}

// ---- state, targets, reset ---------------------------------------------------------------------

/** The layer's value as VS Code reads it: a workspace value of a user-only setting does not exist. */
function layerValues(descriptor: SettingDescriptor, layers: ConfigLayers, workspace: WorkspaceFacts): { user: JsonValue | undefined; workspace: JsonValue | undefined } {
	return {
		user: layers.globalValue,
		workspace: descriptor.workspaceWritable && workspace.available ? layers.workspaceValue : undefined,
	};
}

export function sourceOf(descriptor: SettingDescriptor, layers: ConfigLayers, workspace: WorkspaceFacts): Source {
	const values = layerValues(descriptor, layers, workspace);
	return values.workspace !== undefined ? "workspace" : values.user !== undefined ? "user" : "default";
}

/** Layers a change to this setting may be written to: user always; workspace when its scope reads one and a workspace is open. */
export function writableTargets(descriptor: SettingDescriptor, workspace: WorkspaceFacts): readonly Target[] {
	return descriptor.workspaceWritable && workspace.available ? ["user", "workspace"] : ["user"];
}

/**
 * The layer a change is written to when the user did not choose one: the workspace when a workspace
 * value already overrides the user's (a write to the user layer would change nothing in effect),
 * otherwise the user layer.
 */
export function defaultTarget(descriptor: SettingDescriptor, layers: ConfigLayers, workspace: WorkspaceFacts): Target {
	return sourceOf(descriptor, layers, workspace) === "workspace" ? "workspace" : "user";
}

export type TargetChoice = { readonly ok: true; readonly target: Target } | { readonly ok: false; readonly message: string };

/** Resolve a requested layer (or none) to the one to write, refusing a layer the setting's scope or the window cannot hold. */
export function chooseTarget(descriptor: SettingDescriptor, layers: ConfigLayers, workspace: WorkspaceFacts, requested: unknown): TargetChoice {
	if (requested === undefined) return { ok: true, target: defaultTarget(descriptor, layers, workspace) };
	if (requested !== "user" && requested !== "workspace") return { ok: false, message: "Unknown settings layer." };
	if (!writableTargets(descriptor, workspace).includes(requested)) {
		return {
			ok: false,
			message: requested === "workspace" && !descriptor.workspaceWritable
				? `${descriptor.key} has ${descriptor.scope} scope and is saved in User settings only.`
				: "No workspace is open, so there are no workspace settings to write.",
		};
	}
	return { ok: true, target: requested };
}

/** The layers a reset clears so the default takes effect again: every writable layer that holds a value. */
export function resetTargets(descriptor: SettingDescriptor, layers: ConfigLayers, workspace: WorkspaceFacts): readonly Target[] {
	const values = layerValues(descriptor, layers, workspace);
	return [...(values.workspace !== undefined ? ["workspace" as const] : []), ...(values.user !== undefined ? ["user" as const] : [])];
}

function scopeNote(descriptor: SettingDescriptor): string | undefined {
	switch (descriptor.scope) {
		case "application": return "Application scope: saved in User settings and applies to every window.";
		case "machine": return "Machine scope: saved in User settings only.";
		default: return undefined;
	}
}

/** Assemble one row. `effective` is what VS Code reports (it merges object values across layers). */
export function buildView(
	descriptor: SettingDescriptor,
	layers: ConfigLayers,
	effective: JsonValue | undefined,
	workspace: WorkspaceFacts,
	folders: readonly string[],
): SettingView {
	const note = scopeNote(descriptor);
	return {
		key: descriptor.key,
		label: descriptor.label,
		description: descriptor.description,
		...(descriptor.deprecation === undefined ? {} : { deprecation: descriptor.deprecation }),
		control: descriptor.control,
		...(effective === undefined ? {} : { value: effective }),
		...(layers.defaultValue === undefined ? {} : { defaultValue: layers.defaultValue }),
		source: sourceOf(descriptor, layers, workspace),
		modified: resetTargets(descriptor, layers, workspace).length > 0,
		resetLayers: resetTargets(descriptor, layers, workspace),
		folders: hasFolderLayer(descriptor) ? folders : [],
		targets: writableTargets(descriptor, workspace),
		defaultTarget: defaultTarget(descriptor, layers, workspace),
		...(note === undefined ? {} : { scopeNote: note }),
		...(isTestable(descriptor.key) ? { test: true as const } : {}),
	};
}

/** Group rows for display, keeping the first-appearance order of groups and the order inside each. */
export function groupViews(entries: readonly { readonly descriptor: SettingDescriptor; readonly view: SettingView }[]): SettingGroupView[] {
	const groups = new Map<string, { id: string; title: string; settings: SettingView[] }>();
	for (const { descriptor, view } of entries) {
		let group = groups.get(descriptor.groupId);
		if (group === undefined) {
			group = { id: descriptor.groupId, title: descriptor.groupTitle, settings: [] };
			groups.set(descriptor.groupId, group);
		}
		group.settings.push(view);
	}
	return [...groups.values()];
}

// ---- search -------------------------------------------------------------------------------------

/** Whether a row matches a query: every whitespace-separated term occurs in its label, key, group, description or option text. */
export function matchesQuery(view: SettingView, groupTitle: string, query: string): boolean {
	const terms = query.toLowerCase().split(/\s+/).filter(term => term !== "");
	if (terms.length === 0) return true;
	const options = view.control.kind === "enum" ? view.control.options.map(option => `${option.label} ${option.description ?? ""}`) : [];
	const haystack = [view.label, view.key, groupTitle, view.description, ...options].join("\n").toLowerCase();
	return terms.every(term => haystack.includes(term));
}

/** Whether VS Code lets a folder layer hold a value of this setting (resource-level scopes). */
export function hasFolderLayer(descriptor: SettingDescriptor): boolean {
	return descriptor.scope === "resource" || descriptor.scope === "language-overridable" || descriptor.scope === "machine-overridable";
}

/** Page to host. Every action carries a request id the result echoes. */
export type DeskSettingsAction =
	| { readonly action: "ready"; readonly requestId: string }
	/** Write `value` for `key`; `target` is the layer the user chose, absent for the default layer. */
	| { readonly action: "set"; readonly requestId: string; readonly key: string; readonly value: JsonValue; readonly target?: Target }
	/** Clear the setting's user and workspace values so its default applies again. */
	| { readonly action: "reset"; readonly requestId: string; readonly key: string }
	/** Open the Settings editor filtered to the one setting. */
	| { readonly action: "open-editor"; readonly requestId: string; readonly key: string }
	/** Open the settings.json that holds the value (the workspace's when it overrides), revealing the key. */
	| { readonly action: "open-json"; readonly requestId: string; readonly key: string }
	/** Try `value` (what is typed in the row, saved or not) the way the setting is used, and report the outcome; writes nothing. */
	| { readonly action: "test"; readonly requestId: string; readonly key: string; readonly value: string };

/** Host to page. */
export type DeskSettingsMessage =
	| { readonly type: "settings:state"; readonly groups: readonly SettingGroupView[]; readonly workspace: WorkspaceFacts }
	| { readonly type: "settings:result"; readonly requestId: string; readonly key: string; readonly ok: boolean; readonly message: string }
	| { readonly type: "settings:test"; readonly requestId: string; readonly key: string; readonly ok: boolean; readonly message: string };
