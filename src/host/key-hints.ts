/**
 * The key a Desk command effectively has, and the other commands that may take it
 * (docs/designs/2026-10-18-chat-keys-and-empty-state.md, section 6).
 *
 * Pure: the manifests, the user's `keybindings.json` and the other extensions' contributions arrive as plain data, so this module
 * imports neither `vscode` nor `node:fs`. `src/wiring/key-hints-wiring.ts` reads them.
 *
 * What an extension cannot see, and this module therefore does not pretend to know: VS Code's own core keybindings, the order in
 * which VS Code resolves a user binding, several extensions and the core, and the value of a context key that depends on state.
 * A conflict is reported as "may be taken", and a `when` clause that cannot be read, or that mentions a key whose value is not
 * known here, is taken as possibly true: a conflict is shown, never hidden.
 */
import { EMPTY_STATE_KEY_COMMANDS, MAX_KEY_CONFLICTS, MAX_KEY_SOURCE_LENGTH } from "../shared/key-hints.ts";
import type { ChatKeyConflict, ChatKeyHint, EmptyStateKeyCommand } from "../shared/key-hints.ts";
import { isRecord } from "../shared/guards.ts";

/** Who a conflict names when the other binding is in the user's own `keybindings.json`. */
export const USER_KEYBINDINGS_SOURCE = "your keybindings.json";

/** One binding of this extension's manifest: `win` or else `key`. */
export interface DefaultBinding {
	readonly command: string;
	readonly key: string;
	readonly when: string | undefined;
}

/** One entry of the user's `keybindings.json`. `removal` is a `-command` entry; a removal may have no key. */
export interface UserBinding {
	readonly command: string;
	readonly key: string | undefined;
	readonly when: string | undefined;
	readonly removal: boolean;
}

/** One binding another extension contributes. `by` is its display name, or its id when it has none. */
export interface ForeignBinding {
	readonly by: string;
	readonly command: string;
	/** `undefined` only for a removal that names no key (VS Code then removes the command's bindings of every key). */
	readonly key: string | undefined;
	readonly when: string | undefined;
	/** A `-command` entry: it takes the matching defaults away instead of binding anything. */
	readonly removal: boolean;
}

export interface KeyHintInput {
	readonly defaults: readonly DefaultBinding[];
	readonly user: readonly UserBinding[];
	readonly foreign: readonly ForeignBinding[];
}

/** Entries read from one manifest or one file; a larger one is cut, never rejected whole. */
const MAX_ENTRIES = 5_000;

// --- Keys ----------------------------------------------------------------------------------------------------

const MODIFIER_ALIASES: Readonly<Record<string, string>> = {
	ctrl: "ctrl", control: "ctrl", shift: "shift", alt: "alt", option: "alt", meta: "meta", cmd: "meta", command: "meta", win: "meta", windows: "meta", super: "meta",
};
const MODIFIER_ORDER: readonly string[] = ["ctrl", "shift", "alt", "meta"];
const KEY_ALIASES: Readonly<Record<string, string>> = {
	esc: "escape", return: "enter", del: "delete", pgup: "pageup", pgdn: "pagedown", arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right",
	slash: "/", period: ".", comma: ",", backslash: "\\", minus: "-", equal: "=", backquote: "`", quote: "'", semicolon: ";", bracketleft: "[", bracketright: "]",
};
const MODIFIER_LABELS: Readonly<Record<string, string>> = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", meta: "Win" };
const KEY_LABELS: Readonly<Record<string, string>> = {
	up: "↑", down: "↓", left: "←", right: "→", escape: "Esc", enter: "Enter", space: "Space", pageup: "PageUp", pagedown: "PageDown",
	backspace: "Backspace", delete: "Delete", tab: "Tab", home: "Home", end: "End", insert: "Insert",
};

/** One chord with its modifiers in a fixed order and its key spelled one way, or `null` when it is not a chord. */
function normalizeChord(raw: string): string | null {
	const lower = raw.trim().toLowerCase();
	if (lower.length === 0) return null;
	let key: string;
	let modifiers: string[];
	if (lower === "+" || lower.endsWith("++")) {
		key = "+";
		modifiers = lower.slice(0, -2).split("+").filter(part => part.length > 0);
	} else {
		const parts = lower.split("+");
		key = parts.pop() ?? "";
		modifiers = parts;
	}
	// The scan-code spelling of a user binding: `[Slash]`, `[KeyA]`, `[Digit7]`.
	const scan = /^\[(?:key|digit)?([a-z0-9]+)\]$/.exec(key);
	if (scan !== null) key = scan[1]!;
	key = KEY_ALIASES[key] ?? key;
	if (key.length === 0) return null;
	const present = new Set<string>();
	for (const modifier of modifiers) {
		const canonical = MODIFIER_ALIASES[modifier];
		if (canonical === undefined) return null;
		present.add(canonical);
	}
	return [...MODIFIER_ORDER.filter(modifier => present.has(modifier)), key].join("+");
}

/**
 * A key as VS Code writes it (`ctrl+alt+q`, `Ctrl+K Ctrl+T`, `alt+up`, `ctrl+[Slash]`) in one spelling that two spellings of the same
 * key share, or `null` when it is empty or has a part this module does not know (so it matches nothing).
 */
export function normalizeKey(raw: string): string | null {
	const chords: string[] = [];
	for (const part of raw.trim().split(/\s+/)) {
		const chord = normalizeChord(part);
		if (chord === null) return null;
		chords.push(chord);
	}
	return chords.length === 0 ? null : chords.join(" ");
}

/** A normalized key as the empty state shows it: `ctrl+alt+q` is `Ctrl+Alt+Q`, `alt+up` is `Alt+↑`, `escape` is `Esc`. */
export function displayKey(normalized: string): string {
	return normalized.split(" ").map(chord => {
		const parts = chord === "+" ? ["+"] : chord.endsWith("++") ? [...chord.slice(0, -2).split("+"), "+"] : chord.split("+");
		const key = parts.pop() ?? "";
		const label = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : /^f\d+$/.test(key) ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
		return [...parts.map(part => MODIFIER_LABELS[part] ?? part), label].join("+");
	}).join(" ");
}

// --- `when` --------------------------------------------------------------------------------------------------

/** Where the key is pressed: a Chat webview with the focus, or a text editor (the editor's `Alt+Q`). */
export type KeyContext = "chat" | "editor";

/** The context a command's own default `when` puts its key in. */
export function contextOf(when: string | undefined): KeyContext {
	return when !== undefined && /\beditorTextFocus\b/.test(when) && !/\bactiveWebviewPanelId\b/.test(when) ? "editor" : "chat";
}

/**
 * The context keys that cannot hold while the key is pressed, so that a binding whose `when` needs one is not a conflict. The table is
 * deliberately a finite list of *focus, selection and widget* keys: a key that states a capability or an installed state of the window
 * (`terminalIsOpen`, `terminalHasBeenCreated`, `notebookKernelCount`, `editorIsOpen`) can hold with a Chat focused and is **not** here.
 */
export const NEVER_IN_ANY_CONTEXT: ReadonlySet<string> = new Set([
	"inQuickOpen",
	"terminalFocus", "terminalFocusInAny", "terminalEditorFocus", "terminalTextSelected", "terminalTextSelectedInFocused",
	"terminalFindFocused", "terminalFindInputFocused", "terminalAltBufferActive",
	"notebookEditorFocused", "notebookCellListFocused", "notebookOutputFocused", "notebookCellEditorFocused", "notebookCellFocused",
	"notebookFindWidgetFocused",
]);

/** What a text editor's focus makes true and a Chat's does not: in a Chat these keys are false or unset. */
export const NOT_WITH_A_CHAT_FOCUSED: ReadonlySet<string> = new Set([
	"editorTextFocus", "editorFocus", "textInputFocus", "editorColumnSelection", "editorReadonly", "editorHasSelection",
	"editorHasMultipleSelections", "editorLangId", "editorHoverFocused", "findWidgetVisible", "findInputFocussed", "replaceInputFocussed",
	"editorHasCodeActionsProvider", "editorHasCodeLensProvider", "editorHasCompletionItemProvider", "editorHasDefinitionProvider",
	"editorHasDeclarationProvider", "editorHasImplementationProvider", "editorHasTypeDefinitionProvider", "editorHasHoverProvider",
	"editorHasDocumentHighlightProvider", "editorHasDocumentSymbolProvider", "editorHasReferenceProvider", "editorHasRenameProvider",
	"editorHasSignatureHelpProvider", "editorHasInlayHintsProvider", "editorHasDocumentFormattingProvider",
	"editorHasDocumentSelectionFormattingProvider", "editorHasMultipleDocumentFormattingProvider",
	"editorHasMultipleDocumentSelectionFormattingProvider", "editorHasInlineCompletionProvider",
	// A Chat is a webview panel: no custom editor is active in it.
	"activeCustomEditorId", "customEditorFocus", "markdownEditorFocus",
]);

/** The platform keys of the `when` grammar: known on this host, so `isMac && …` is false on Windows rather than possibly true. */
function platformKeys(platform: NodeJS.Platform): Readonly<Record<string, boolean>> {
	return { isMac: platform === "darwin", isWindows: platform === "win32", isLinux: platform === "linux", isWeb: false };
}

/** Keys that hold in both contexts: the Chat is itself an open editor, so `editorIsOpen` is true there and `!editorIsOpen` cannot be. */
const ALWAYS_TRUE: ReadonlySet<string> = new Set(["editorIsOpen"]);

/** Whether `key` is a context key that cannot hold while the key is pressed in `context` (false or unset there). */
function isFalseKey(key: string, context: KeyContext): boolean {
	return NEVER_IN_ANY_CONTEXT.has(key) || (context === "chat" && NOT_WITH_A_CHAT_FOCUSED.has(key));
}

type WhenNode =
	| { readonly kind: "atom"; readonly key: string; readonly operator: string | null }
	| { readonly kind: "not"; readonly operand: WhenNode }
	| { readonly kind: "and" | "or"; readonly operands: readonly WhenNode[] };

/** Operators whose result is true for an unset key (`undefined != 'x'`). */
const TRUE_FOR_UNSET = new Set(["!=", "!==", "not in"]);

/** A recursive-descent reader of VS Code's `when` grammar; `null` when the clause does not read. */
function parseWhen(text: string): WhenNode | null {
	let pos = 0;
	const skip = (): void => { while (pos < text.length && /\s/.test(text[pos]!)) pos++; };
	const starts = (token: string): boolean => text.startsWith(token, pos);

	const readValue = (): boolean => {
		skip();
		const first = text[pos];
		if (first === undefined) return false;
		if (first === "/") {
			let i = pos + 1;
			while (i < text.length && text[i] !== "/") i += text[i] === "\\" ? 2 : 1;
			if (i >= text.length) return false;
			pos = i + 1;
			while (pos < text.length && /[a-z]/i.test(text[pos]!)) pos++;
			return true;
		}
		if (first === "'" || first === '"') {
			const end = text.indexOf(first, pos + 1);
			if (end === -1) return false;
			pos = end + 1;
			return true;
		}
		const start = pos;
		while (pos < text.length && !/[\s()]/.test(text[pos]!) && !starts("&&") && !starts("||")) pos++;
		return pos > start;
	};

	const readAtom = (): WhenNode | null => {
		skip();
		const start = pos;
		while (pos < text.length && !/[\s()!=<>&|]/.test(text[pos]!)) pos++;
		const key = text.slice(start, pos);
		if (key.length === 0) return null;
		skip();
		let operator: string | null = null;
		for (const candidate of ["===", "!==", "==", "!=", "=~", ">=", "<=", ">", "<"]) {
			if (starts(candidate)) { operator = candidate; pos += candidate.length; break; }
		}
		if (operator === null) {
			const word = /^(not\s+in|in)(?=\s)/.exec(text.slice(pos));
			if (word !== null) { operator = word[1]!.replace(/\s+/g, " "); pos += word[1]!.length; }
		}
		if (operator !== null && !readValue()) return null;
		return { kind: "atom", key, operator };
	};

	const readUnary = (): WhenNode | null => {
		skip();
		if (text[pos] === "!") {
			pos++;
			const operand = readUnary();
			return operand === null ? null : { kind: "not", operand };
		}
		if (text[pos] === "(") {
			pos++;
			const inner = readOr();
			skip();
			if (inner === null || text[pos] !== ")") return null;
			pos++;
			return inner;
		}
		return readAtom();
	};

	const readList = (separator: "&&" | "||", next: () => WhenNode | null): WhenNode | null => {
		const operands: WhenNode[] = [];
		for (;;) {
			const operand = next();
			if (operand === null) return null;
			operands.push(operand);
			skip();
			if (!starts(separator)) break;
			pos += 2;
		}
		const [only] = operands;
		return operands.length === 1 && only !== undefined ? only : { kind: separator === "&&" ? "and" : "or", operands };
	};

	const readAnd = (): WhenNode | null => readList("&&", readUnary);
	const readOr = (): WhenNode | null => readList("||", readAnd);

	const tree = readOr();
	skip();
	return tree !== null && pos === text.length ? tree : null;
}

/** Whether `node` can hold in `context` (`negated`: whether it can fail to hold). A key whose value is not known here can do either. */
function canHold(node: WhenNode, negated: boolean, context: KeyContext, platform: Readonly<Record<string, boolean>>): boolean {
	switch (node.kind) {
		case "not":
			return canHold(node.operand, !negated, context, platform);
		case "and":
		case "or": {
			// De Morgan: a negated conjunction is a disjunction of negations, and the other way round.
			const all = (node.kind === "and") !== negated;
			return all ? node.operands.every(operand => canHold(operand, negated, context, platform)) : node.operands.some(operand => canHold(operand, negated, context, platform));
		}
		case "atom": {
			if (ALWAYS_TRUE.has(node.key) && node.operator === null) return !negated;
			const known = platform[node.key];
			if (known !== undefined && node.operator === null) return negated ? !known : known;
			if (!isFalseKey(node.key, context)) return true;
			const holds = node.operator !== null && TRUE_FOR_UNSET.has(node.operator);
			return negated ? !holds : holds;
		}
	}
}

/**
 * Whether a binding with this `when` is **not obviously false** where the key is pressed. No `when`, a clause that does not read and a
 * clause with a key whose value is not known here are all possibly true. Only keys that cannot hold in `context` (an editor's focus, a
 * terminal's, a notebook's, the quick-open box; for a Chat the editor ones also) make a clause false.
 */
export function canApply(when: string | undefined, context: KeyContext, platform: NodeJS.Platform = process.platform): boolean {
	if (when === undefined || when.trim().length === 0) return true;
	const tree = parseWhen(when);
	return tree === null ? true : canHold(tree, false, context, platformKeys(platform));
}

// --- Reading the sources -------------------------------------------------------------------------------------

function textOf(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** The keybindings an extension manifest contributes, `win` before `key`, as `{ command, key, when }`. An array, or the one object VS Code also accepts. */
function manifestBindings(packageJSON: unknown): { command: string; key: string | undefined; when: string | undefined }[] {
	const contributes = isRecord(packageJSON) ? packageJSON.contributes : undefined;
	const raw = isRecord(contributes) ? contributes.keybindings : undefined;
	const entries = Array.isArray(raw) ? raw.slice(0, MAX_ENTRIES) : isRecord(raw) ? [raw] : [];
	const found: { command: string; key: string | undefined; when: string | undefined }[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		const command = textOf(entry.command);
		const key = textOf(entry.win) ?? textOf(entry.key);
		if (command !== undefined && (key !== undefined || command.startsWith("-"))) found.push({ command, key, when: textOf(entry.when) });
	}
	return found;
}

/** This extension's own bindings of `commands`, from its manifest. */
export function defaultBindingsOf(packageJSON: unknown, commands: readonly string[]): DefaultBinding[] {
	const found: DefaultBinding[] = [];
	for (const binding of manifestBindings(packageJSON)) {
		if (binding.key !== undefined && commands.includes(binding.command)) found.push({ command: binding.command, key: binding.key, when: binding.when });
	}
	return found;
}

/** What the installed extensions contribute that is not this extension's own: bindings and removals (`-command`). */
export interface ExtensionManifest {
	readonly id: string;
	readonly packageJSON: unknown;
}

/** An extension's own name for a list: its `displayName` unless that is missing or an unresolved `%placeholder%`, else its id. */
export function extensionLabel(extension: ExtensionManifest): string {
	const name = isRecord(extension.packageJSON) ? textOf(extension.packageJSON.displayName) : undefined;
	return name === undefined || /^%.*%$/.test(name.trim()) ? extension.id : name.trim();
}

export function foreignBindingsOf(extensions: readonly ExtensionManifest[], ownId: string): ForeignBinding[] {
	const own = ownId.toLowerCase();
	const found: ForeignBinding[] = [];
	for (const extension of extensions) {
		if (extension.id.toLowerCase() === own) continue;
		const by = extensionLabel(extension);
		for (const binding of manifestBindings(extension.packageJSON)) {
			const removal = binding.command.startsWith("-");
			found.push({ by, command: removal ? binding.command.slice(1) : binding.command, key: binding.key, when: binding.when, removal });
		}
	}
	return found;
}

/** The entries of a parsed `keybindings.json`; anything that is not an array of objects with a command is no entry. */
export function userBindingsOf(parsed: unknown): UserBinding[] {
	if (!Array.isArray(parsed)) return [];
	const found: UserBinding[] = [];
	for (const entry of parsed.slice(0, MAX_ENTRIES)) {
		if (!isRecord(entry)) continue;
		const command = textOf(entry.command);
		if (command === undefined) continue;
		const removal = command.startsWith("-");
		found.push({ command: removal ? command.slice(1) : command, key: textOf(entry.key), when: textOf(entry.when), removal });
	}
	return found;
}

// --- The answer ----------------------------------------------------------------------------------------------

/** A text a Chat page may show: control characters become spaces, the ends are trimmed and the length is the page's bound; `null` when nothing is left. */
function displayText(value: string): string | null {
	const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
	return text.length === 0 ? null : text.slice(0, MAX_KEY_SOURCE_LENGTH);
}

/** A `-command` entry of the user's file or of an extension's manifest: the command it names, and the key and `when` it narrows to. */
interface Removal {
	readonly command: string;
	readonly key: string | undefined;
	readonly when: string | undefined;
}

function whenTerms(when: string): string[] {
	return when.split("&&").map(term => term.replace(/\s+/g, " ").trim()).filter(term => term.length > 0);
}

/** `a` implies `b` as a conjunction of terms: every term of `b` is a term of `a`. A clause with `||` is compared as text. */
function whenImplies(a: string, b: string): boolean {
	if (a.includes("||") || b.includes("||")) return whenTerms(a).join(" && ") === whenTerms(b).join(" && ");
	const have = new Set(whenTerms(a));
	return whenTerms(b).every(term => have.has(term));
}

/**
 * VS Code's rule for a `-command` entry (`keybindingResolver.ts`, `_isTargetedForRemoval`): the same command; the same key when the
 * removal names one; and, when it names a `when`, a binding that has one and implies it (a removal with a `when` takes nothing from a
 * binding with none, a removal without a `when` takes every `when`). It applies to **defaults** (this extension's and the other
 * extensions') only, never to a positive entry of the user's own file.
 */
function removes(removal: Removal, binding: { command: string; key: string; when: string | undefined }): boolean {
	if (removal.command !== binding.command) return false;
	if (removal.key !== undefined && normalizeKey(removal.key) !== normalizeKey(binding.key)) return false;
	if (removal.when === undefined) return true;
	return binding.when !== undefined && whenImplies(binding.when, removal.when);
}

/** The contexts a command's key is pressed in: a Chat-only command in a Chat, the editor's in an editor, one with no `when` anywhere. */
function contextsOf(defaults: readonly DefaultBinding[]): KeyContext[] {
	const when = defaults[0]?.when;
	return when === undefined ? ["chat", "editor"] : [contextOf(when)];
}

function appliesIn(when: string | undefined, contexts: readonly KeyContext[]): boolean {
	return contexts.some(context => canApply(when, context));
}

/** The conflicts of `key` for `command`, the user's own bindings first, each (who, command) once, in file and extension order. */
function conflictsOf(command: string, key: string, contexts: readonly KeyContext[], input: KeyHintInput, removals: readonly Removal[]): ChatKeyConflict[] {
	const found: ChatKeyConflict[] = [];
	const add = (by: string, other: string): void => {
		const who = displayText(by);
		const what = displayText(other);
		if (who === null || what === null) return;
		if (!found.some(conflict => conflict.by === who && conflict.command === what)) found.push({ by: who, command: what });
	};
	for (const binding of input.user) {
		if (binding.removal || binding.key === undefined || binding.command === command) continue;
		if (normalizeKey(binding.key) === key && appliesIn(binding.when, contexts)) add(USER_KEYBINDINGS_SOURCE, binding.command);
	}
	for (const binding of input.foreign) {
		if (binding.removal || binding.key === undefined || normalizeKey(binding.key) !== key || !appliesIn(binding.when, contexts)) continue;
		if (removals.some(removal => removes(removal, { command: binding.command, key: binding.key as string, when: binding.when }))) continue;
		add(binding.by, binding.command);
	}
	return found;
}

/** One command's hint for the page, and the query that opens Keyboard Shortcuts on its key (`null` when it has no key). */
export interface KeyHintResult {
	readonly hint: ChatKeyHint;
	readonly query: string | null;
}

/**
 * The effective key of every command of the empty state, and what may take it.
 *
 * Removals (`-command`: the user's and the other extensions') take away the defaults they match (see {@link removes}). The user's own
 * positive entries of the command whose `when` can hold where the key is pressed replace the default, the **last** such entry (VS Code
 * resolves the user's rules from the end of the list); otherwise the first default that survives is shown, and a command with none has
 * the key `null`. The query is the editor's own `@keybinding:"…"` search, or `@command:<id>` for a key that holds a quote mark.
 */
export function computeKeyHints(input: KeyHintInput, commands: readonly EmptyStateKeyCommand[] = EMPTY_STATE_KEY_COMMANDS): KeyHintResult[] {
	const removals: Removal[] = [
		...input.user.filter(entry => entry.removal),
		...input.foreign.filter(entry => entry.removal),
	].map(entry => ({ command: entry.command, key: entry.key, when: entry.when }));
	return commands.map((command): KeyHintResult => {
		const defaults = input.defaults.filter(binding => binding.command === command);
		const contexts = contextsOf(defaults);
		const rebound = input.user.findLast(entry => !entry.removal && entry.command === command && entry.key !== undefined && normalizeKey(entry.key) !== null && appliesIn(entry.when, contexts));
		const surviving = defaults.find(binding => !removals.some(removal => removes(removal, binding)));
		const raw = rebound?.key ?? surviving?.key;
		const key = raw === undefined ? null : normalizeKey(raw);
		if (key === null) return { hint: { command, key: null, conflicts: [], more: 0 }, query: null };
		const conflicts = conflictsOf(command, key, contexts, input, removals);
		return {
			hint: { command, key: displayKey(key), conflicts: conflicts.slice(0, MAX_KEY_CONFLICTS), more: Math.max(0, conflicts.length - MAX_KEY_CONFLICTS) },
			query: key.includes('"') ? `@command:${command}` : `@keybinding:"${key}"`,
		};
	});
}
