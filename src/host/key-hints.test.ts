/**
 * The effective key of a Desk command and what may take it (docs/designs/2026-10-18-chat-keys-and-empty-state.md, section 6).
 *
 * Runner: `node --test src/host/key-hints.test.ts`
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseJsonc } from "../shared/jsonc.ts";
import { EMPTY_STATE_KEY_COMMANDS } from "../shared/key-hints.ts";
import type { ChatKeyHint } from "../shared/key-hints.ts";
import {
	USER_KEYBINDINGS_SOURCE, canApply, computeKeyHints, contextOf, defaultBindingsOf, displayKey, extensionLabel, foreignBindingsOf, normalizeKey, userBindingsOf,
} from "./key-hints.ts";
import type { DefaultBinding, ForeignBinding, UserBinding } from "./key-hints.ts";

const CHAT = "activeWebviewPanelId =~ /^omp[.]session/ && ompDesk.sessionMode == chat";
const DEFAULTS: DefaultBinding[] = [
	{ command: "ompDesk.toggleThinking", key: "alt+t", when: CHAT },
	{ command: "ompDesk.searchPromptHistory", key: "alt+h", when: CHAT },
	{ command: "ompDesk.quoteChatSelection", key: "alt+q", when: CHAT },
	{ command: "ompDesk.quoteEditorSelection", key: "alt+q", when: "editorTextFocus" },
	{ command: "ompDesk.goToSession", key: "ctrl+alt+q", when: undefined },
	{ command: "ompDesk.stopTurn", key: "escape", when: CHAT },
];

function hintsOf(user: UserBinding[] = [], foreign: ForeignBinding[] = []): Map<string, ChatKeyHint> {
	return new Map(computeKeyHints({ defaults: DEFAULTS, user, foreign }).map(({ hint }) => [hint.command, hint]));
}
const user = (entry: Partial<UserBinding> & { command: string }): UserBinding => ({ key: undefined, when: undefined, removal: false, ...entry });
const foreign = (entry: Partial<ForeignBinding> & { command: string }): ForeignBinding => ({ by: "IntelliJ IDEA Keymap", key: undefined, when: undefined, removal: false, ...entry });

describe("normalizeKey and displayKey", () => {
	it("gives two spellings of one key one form", () => {
		assert.equal(normalizeKey("Ctrl+Alt+Q"), "ctrl+alt+q");
		assert.equal(normalizeKey("alt+ctrl+q"), "ctrl+alt+q");
		assert.equal(normalizeKey("cmd+shift+L"), "shift+meta+l");
		assert.equal(normalizeKey("shift+win+l"), normalizeKey("meta+shift+l"));
		assert.equal(normalizeKey("ctrl+K  Ctrl+T"), "ctrl+k ctrl+t");
		assert.equal(normalizeKey("esc"), "escape");
		assert.equal(normalizeKey("alt+arrowup"), "alt+up");
		assert.equal(normalizeKey("ctrl+[Slash]"), "ctrl+/");
		assert.equal(normalizeKey("ctrl+[KeyA]"), "ctrl+a");
		assert.equal(normalizeKey("ctrl++"), "ctrl++");
	});

	it("refuses what is not a key, so it matches nothing", () => {
		for (const bad of ["", "   ", "hyper+x", "ctrl+"]) assert.equal(normalizeKey(bad), null, JSON.stringify(bad));
	});

	it("shows keys the way the empty state writes them", () => {
		assert.equal(displayKey("ctrl+alt+q"), "Ctrl+Alt+Q");
		assert.equal(displayKey("ctrl+shift+l"), "Ctrl+Shift+L");
		assert.equal(displayKey("alt+up"), "Alt+↑");
		assert.equal(displayKey("escape"), "Esc");
		assert.equal(displayKey("ctrl+/"), "Ctrl+/");
		assert.equal(displayKey("ctrl+k ctrl+t"), "Ctrl+K Ctrl+T");
		assert.equal(displayKey("f5"), "F5");
		assert.equal(displayKey("ctrl++"), "Ctrl++");
		assert.equal(displayKey("meta+l"), "Win+L");
	});
});

describe("canApply: whether a when clause is not obviously false where the key is pressed", () => {
	it("holds with no clause and with a clause that is true in a Chat", () => {
		assert.equal(canApply(undefined, "chat"), true);
		assert.equal(canApply("", "chat"), true);
		assert.equal(canApply("editorIsOpen", "chat"), true, "a Chat is an editor tab");
		assert.equal(canApply("editorFocus || editorIsOpen", "chat"), true);
		assert.equal(canApply("config.git.enabled && !terminalFocus", "chat"), true);
		assert.equal(canApply("someExtension.state == 'ready'", "chat"), true, "an unknown key is possibly true");
	});

	it("does not hold when a clause needs a key that is false in a Chat", () => {
		for (const when of [
			"editorTextFocus", "editorFocus", "editorTextFocus && !editorReadonly", "editorHasSelection", "editorLangId == typescript", "editorLangId =~ /^ts/",
			"terminalFocus", "terminalTextSelected && terminalFocus", "notebookEditorFocused", "notebookCellEditorFocused && foo", "inQuickOpen",
			"editorTextFocus && foo || terminalFocus", "(editorTextFocus || inQuickOpen) && foo", "editorHasCompletionItemProvider",
		]) assert.equal(canApply(when, "chat"), false, when);
	});

	it("holds when only one side of an or is false, and for a negated or unequal use of a false key", () => {
		assert.equal(canApply("editorTextFocus || foo", "chat"), true);
		assert.equal(canApply("!editorTextFocus", "chat"), true);
		assert.equal(canApply("!terminalFocus && !inQuickOpen", "chat"), true);
		assert.equal(canApply("editorLangId != markdown", "chat"), true, "an unset key is not equal to anything");
		assert.equal(canApply("editorLangId not in 'a b'", "chat"), true);
		assert.equal(canApply("!(editorTextFocus && foo)", "chat"), true);
		assert.equal(canApply("!(editorTextFocus || foo)", "chat"), true, "not (a false key or an unknown): possible when the unknown fails");
		assert.equal(canApply("!(foo || !editorTextFocus)", "chat"), false, "the inner or is certainly true, so its negation is certainly false");
	});

	it("knows the platform keys of the host and that a Chat is no custom editor", () => {
		const markdown = "activeCustomEditorId == 'vscode.markdown.editor' && markdownEditorFocus && isMac";
		assert.equal(canApply(markdown, "chat", "win32"), false, "a Chat is not a custom editor");
		assert.equal(canApply("isMac", "chat", "win32"), false);
		assert.equal(canApply("isMac", "chat", "darwin"), true);
		assert.equal(canApply("!isMac", "chat", "win32"), true);
		assert.equal(canApply("isWindows && foo", "chat", "win32"), true);
		assert.equal(canApply("isLinux || isMac", "editor", "win32"), false);
	});

	it("takes a clause that does not read as possibly true", () => {
		for (const when of ["editorTextFocus &&", "(editorTextFocus", "editorTextFocus )", "== x", "foo == ", "a && || b"]) assert.equal(canApply(when, "chat"), true, when);
	});

	it("for the editor's own key, an editor's focus holds and terminal and notebook focus do not", () => {
		assert.equal(canApply("editorTextFocus", "editor"), true);
		assert.equal(canApply("editorHasSelection && editorLangId == ts", "editor"), true);
		assert.equal(canApply("terminalFocus", "editor"), false);
		assert.equal(canApply("notebookCellEditorFocused", "editor"), false);
		assert.equal(canApply("inQuickOpen", "editor"), false);
	});

	it("puts a command in the editor context only for its own editor focus", () => {
		assert.equal(contextOf("editorTextFocus"), "editor");
		assert.equal(contextOf("editorTextFocus && editorHasSelection"), "editor");
		assert.equal(contextOf(CHAT), "chat");
		assert.equal(contextOf(undefined), "chat");
	});
});

describe("computeKeyHints", () => {
	it("shows the manifest's keys and no conflicts when nothing else binds them", () => {
		const hints = hintsOf();
		assert.deepEqual(hints.get("ompDesk.toggleThinking"), { command: "ompDesk.toggleThinking", key: "Alt+T", conflicts: [], more: 0 });
		assert.equal(hints.get("ompDesk.goToSession")?.key, "Ctrl+Alt+Q");
		assert.equal(hints.get("ompDesk.stopTurn")?.key, "Esc");
		assert.deepEqual([...hints.keys()], [...EMPTY_STATE_KEY_COMMANDS].filter(command => hints.has(command)));
		assert.equal(hints.get("ompDesk.findInChat")?.key, null, "a command the manifest does not bind has no key");
	});

	it("shows the user's own key for a command and keeps the default conflicts out of it", () => {
		const hints = hintsOf([user({ command: "ompDesk.toggleThinking", key: "ctrl+alt+t" })], [foreign({ key: "alt+t", command: "x.y" })]);
		assert.deepEqual(hints.get("ompDesk.toggleThinking"), { command: "ompDesk.toggleThinking", key: "Ctrl+Alt+T", conflicts: [], more: 0 }, "alt+t is no longer the key");
	});

	it("honours a removal of a key, with and without the key named", () => {
		assert.equal(hintsOf([user({ command: "ompDesk.toggleThinking", removal: true, key: "alt+t" })]).get("ompDesk.toggleThinking")?.key, null);
		assert.equal(hintsOf([user({ command: "ompDesk.toggleThinking", removal: true })]).get("ompDesk.toggleThinking")?.key, null);
		assert.equal(hintsOf([user({ command: "ompDesk.toggleThinking", removal: true, key: "alt+x" })]).get("ompDesk.toggleThinking")?.key, "Alt+T", "a removal of another key takes nothing");
		assert.equal(hintsOf([user({ command: "ompDesk.toggleThinking", removal: true, key: "Alt+T", when: "other" })]).get("ompDesk.toggleThinking")?.key, "Alt+T", "a removal with another when takes nothing");
		assert.equal(hintsOf([user({ command: "ompDesk.toggleThinking", removal: true, key: "Alt+T", when: ` ${CHAT} ` })]).get("ompDesk.toggleThinking")?.key, null);
		assert.equal(hintsOf([user({ command: "ompDesk.toggleThinking", removal: true }), user({ command: "ompDesk.toggleThinking", key: "ctrl+k ctrl+t" })]).get("ompDesk.toggleThinking")?.key, "Ctrl+K Ctrl+T", "removed, then bound again");
	});

	it("flags an extension binding the same key with no when, or one that holds in a Chat", () => {
		const hints = hintsOf([], [
			foreign({ key: "alt+t", command: "git.sync" }),
			foreign({ key: "Alt+H", command: "editor.action.startFindReplaceAction", when: "editorFocus || editorIsOpen", by: "Another Keymap" }),
		]);
		assert.deepEqual(hints.get("ompDesk.toggleThinking")?.conflicts, [{ by: "IntelliJ IDEA Keymap", command: "git.sync" }]);
		assert.deepEqual(hints.get("ompDesk.searchPromptHistory")?.conflicts, [{ by: "Another Keymap", command: "editor.action.startFindReplaceAction" }]);
	});

	it("does not flag a binding whose when cannot hold in a Chat", () => {
		const blocked = ["editorTextFocus", "terminalFocus", "notebookEditorFocused", "inQuickOpen", "editorLangId == markdown"].map(when => foreign({ key: "alt+t", command: "x.y", when }));
		assert.deepEqual(hintsOf([], blocked).get("ompDesk.toggleThinking")?.conflicts, []);
	});

	it("judges the editor's Alt+Q in the editor context and the Chat's in a Chat", () => {
		const editorOnly = foreign({ key: "alt+q", command: "x.wrap", when: "editorTextFocus && editorLangId == markdown", by: "Wrapper" });
		const hints = hintsOf([], [editorOnly]);
		assert.deepEqual(hints.get("ompDesk.quoteEditorSelection")?.conflicts, [{ by: "Wrapper", command: "x.wrap" }]);
		assert.deepEqual(hints.get("ompDesk.quoteChatSelection")?.conflicts, []);
	});

	it("flags a user binding of another command to the key, under the user's own name", () => {
		const hints = hintsOf([
			user({ command: "workbench.action.terminal.toggleTerminal", key: "alt+t" }),
			user({ command: "ompDesk.toggleThinking", key: "alt+t" }),
			user({ command: "other.terminalOnly", key: "alt+t", when: "terminalFocus" }),
			user({ command: "no.key" }),
		]);
		assert.deepEqual(hints.get("ompDesk.toggleThinking")?.conflicts, [{ by: USER_KEYBINDINGS_SOURCE, command: "workbench.action.terminal.toggleTerminal" }]);
	});

	it("does not count a foreign binding the user removed", () => {
		const hints = hintsOf([user({ command: "git.sync", removal: true, key: "alt+t" })], [foreign({ key: "alt+t", command: "git.sync" }), foreign({ key: "alt+t", command: "git.pull" })]);
		assert.deepEqual(hints.get("ompDesk.toggleThinking")?.conflicts, [{ by: "IntelliJ IDEA Keymap", command: "git.pull" }]);
		const all = hintsOf([user({ command: "git.sync", removal: true })], [foreign({ key: "alt+t", command: "git.sync" })]);
		assert.deepEqual(all.get("ompDesk.toggleThinking")?.conflicts, [], "a removal with no key takes every key");
	});

	it("names three conflicts at most, counts the rest and lists each once", () => {
		const many = ["a", "b", "c", "d", "e"].map(name => foreign({ key: "alt+t", command: `x.${name}`, by: `Extension ${name}` }));
		const hint = hintsOf([], [...many, ...many]).get("ompDesk.toggleThinking")!;
		assert.deepEqual(hint.conflicts.map(conflict => conflict.command), ["x.a", "x.b", "x.c"]);
		assert.equal(hint.more, 2);
	});

	it("gives the query that opens Keyboard Shortcuts on the effective key, and none for a command without a key", () => {
		const results = computeKeyHints({ defaults: DEFAULTS, user: [user({ command: "ompDesk.searchPromptHistory", key: "Ctrl+K Ctrl+H" })], foreign: [] });
		assert.equal(results.find(result => result.hint.command === "ompDesk.searchPromptHistory")?.query, '@keybinding:"ctrl+k ctrl+h"');
		assert.equal(results.find(result => result.hint.command === "ompDesk.toggleThinking")?.query, '@keybinding:"alt+t"');
		assert.equal(results.find(result => result.hint.command === "ompDesk.findInChat")?.query, null);
	});
});

describe("removals and the user's own entries, as VS Code resolves them", () => {
	const THINKING = "ompDesk.toggleThinking";

	it("takes a default away with a removal whose when it implies, and not with a narrower one or one the default does not have", () => {
		const withWhen = (when: string | undefined) => hintsOf([user({ command: THINKING, removal: true, key: "alt+t", when })]).get(THINKING)?.key;
		assert.equal(withWhen("ompDesk.sessionMode == chat"), null, "a broader when (one term of the default's) removes it");
		assert.equal(withWhen("ompDesk.sessionMode == chat && ompDesk.streaming"), "Alt+T", "a narrower when removes nothing");
		assert.equal(withWhen(undefined), null, "a removal with no when removes every when");
		const bare = computeKeyHints({ defaults: [{ command: THINKING, key: "alt+t", when: undefined }], user: [user({ command: THINKING, removal: true, key: "alt+t", when: "foo" })], foreign: [] });
		assert.equal(bare.find(result => result.hint.command === THINKING)?.hint.key, "Alt+T", "a removal with a when takes nothing from a default with none");
	});

	it("applies another extension's removal to this extension's default, and to a third extension's binding", () => {
		const keymap = (entry: Partial<ForeignBinding> & { key: string; command: string }) => foreign({ by: "Keymap", ...entry });
		assert.equal(hintsOf([], [keymap({ command: THINKING, key: "alt+t", removal: true })]).get(THINKING)?.key, null, "the keymap removed our key");
		const hints = hintsOf([], [foreign({ command: "git.sync", key: "alt+t" }), keymap({ command: "git.sync", key: "alt+t", removal: true })]);
		assert.deepEqual(hints.get(THINKING)?.conflicts, [], "the removed binding takes nothing");
	});

	it("applies another extension's removal that names no key", () => {
		assert.equal(hintsOf([], [foreign({ by: "Keymap", command: THINKING, removal: true })]).get(THINKING)?.key, null);
		const parsed = foreignBindingsOf([{ id: "vendor.keymap", packageJSON: { contributes: { keybindings: [{ command: "-ompDesk.toggleThinking" }, { command: "x.noKey" }] } } }], "me.omp-desk");
		assert.deepEqual(parsed, [{ by: "vendor.keymap", command: "ompDesk.toggleThinking", key: undefined, when: undefined, removal: true }]);
	});

	it("never removes a positive entry of the user's own file, and shows the last of the user's entries that can hold in the Chat", () => {
		const hints = hintsOf([
			user({ command: "other.cmd", key: "alt+t" }),
			user({ command: "other.cmd", removal: true, key: "alt+t" }),
			user({ command: THINKING, key: "ctrl+alt+1" }),
			user({ command: THINKING, key: "ctrl+alt+2", when: "editorTextFocus" }),
			user({ command: THINKING, key: "ctrl+alt+3" }),
		]);
		assert.equal(hints.get(THINKING)?.key, "Ctrl+Alt+3", "the last entry wins, as in VS Code");
		assert.equal(hintsOf([user({ command: THINKING, key: "ctrl+alt+2", when: "editorTextFocus" })]).get(THINKING)?.key, "Alt+T", "a key bound only under the editor's focus does not fire in a Chat, so the default stays");
		const kept = hintsOf([user({ command: "other.cmd", key: "alt+t" }), user({ command: "other.cmd", removal: true, key: "alt+t" })]);
		assert.deepEqual(kept.get(THINKING)?.conflicts, [{ by: USER_KEYBINDINGS_SOURCE, command: "other.cmd" }], "the user's own binding survives a removal in the same file");
	});

	it("flags a binding that needs a capability key, never one that needs a focus, and reads editorIsOpen as true in a Chat", () => {
		const conflicts = (when: string) => hintsOf([], [foreign({ key: "alt+t", command: "x.y", when })]).get(THINKING)?.conflicts.length;
		assert.equal(conflicts("terminalIsOpen"), 1, "a terminal is open somewhere in the window");
		assert.equal(conflicts("terminalHasBeenCreated && notebookKernelCount > 0"), 1);
		assert.equal(conflicts("terminalFocus"), 0);
		assert.equal(conflicts("editorIsOpen"), 1);
		assert.equal(conflicts("!editorIsOpen"), 0, "the Chat is an open editor");
		assert.equal(canApply("terminalIsOpen", "chat"), true);
		assert.equal(canApply("!editorIsOpen", "chat"), false);
		assert.equal(canApply("!editorIsOpen", "editor"), false);
	});

	it("judges a command with no when of its own in a Chat and in an editor", () => {
		const goTo = (when: string) => hintsOf([], [foreign({ key: "ctrl+alt+q", command: "x.y", when })]).get("ompDesk.goToSession")?.conflicts.length;
		assert.equal(goTo("editorTextFocus"), 1, "it is pressed in an editor too");
		assert.equal(goTo("terminalFocus"), 0);
		assert.equal(hintsOf([], [foreign({ key: "alt+t", command: "x.y", when: "editorTextFocus" })]).get(THINKING)?.conflicts.length, 0, "a Chat-only command is judged in a Chat");
	});

	it("shows a foreign name the page can carry: control characters are replaced and the length is the page's bound", () => {
		const long = "N".repeat(300);
		const hint = hintsOf([], [foreign({ key: "alt+t", command: `x.${long}`, by: "Ext\u001b[0m\nname" })]).get(THINKING)!;
		assert.deepEqual(hint.conflicts.map(conflict => conflict.by), ["Ext [0m name"]);
		assert.equal(hint.conflicts[0]?.command.length, 128);
		assert.deepEqual(hintsOf([], [foreign({ key: "alt+t", command: "   ", by: "  " })]).get(THINKING)?.conflicts, [], "a name with nothing in it names nothing");
	});

	it("opens the command's own search for a key with a quote mark in it", () => {
		const results = computeKeyHints({ defaults: DEFAULTS, user: [user({ command: THINKING, key: 'ctrl+alt+"' })], foreign: [] });
		assert.equal(results.find(result => result.hint.command === THINKING)?.query, `@command:${THINKING}`);
	});
});

describe("reading the sources", () => {
	it("reads a keybindings.json with comments, a BOM, a trailing comma and a key in a string that looks like a comment", () => {
		const text = `\uFEFF// my keys
[
	// rebind
	{ "key": "ctrl+alt+t", "command": "ompDesk.toggleThinking", /* inline */ "when": "editorTextFocus" },
	{ "key": "alt+h", "command": "-ompDesk.searchPromptHistory" },
	{ "command": "-git.sync" },
	{ "key": "ctrl+/", "command": "x.url", "args": "http://example.test//x", },
	"not an entry", { "key": "a" }, 7,
]`;
		assert.deepEqual(userBindingsOf(parseJsonc(text)), [
			{ command: "ompDesk.toggleThinking", key: "ctrl+alt+t", when: "editorTextFocus", removal: false },
			{ command: "ompDesk.searchPromptHistory", key: "alt+h", when: undefined, removal: true },
			{ command: "git.sync", key: undefined, when: undefined, removal: true },
			{ command: "x.url", key: "ctrl+/", when: undefined, removal: false },
		]);
		assert.deepEqual(userBindingsOf({ not: "an array" }), []);
	});

	it("takes win before key and ignores mac and linux only entries, and the one-object form of a manifest", () => {
		const manifest = { contributes: { keybindings: [
			{ command: "a.one", key: "ctrl+1", win: "alt+1", when: "x" },
			{ command: "a.two", mac: "cmd+2" },
			{ command: "-a.three", key: "ctrl+3" },
			{ key: "ctrl+4" },
			"junk",
		] } };
		assert.deepEqual(defaultBindingsOf(manifest, ["a.one", "a.two", "a.three"]), [{ command: "a.one", key: "alt+1", when: "x" }]);
		assert.deepEqual(defaultBindingsOf({ contributes: { keybindings: { command: "a.one", key: "ctrl+1" } } }, ["a.one"]), [{ command: "a.one", key: "ctrl+1", when: undefined }]);
		assert.deepEqual(defaultBindingsOf({}, ["a.one"]), []);
	});

	it("collects other extensions' bindings and removals under their display names, skipping this extension", () => {
		const extensions = [
			{ id: "me.omp-desk", packageJSON: { displayName: "OMP Desk", contributes: { keybindings: [{ command: "ompDesk.toggleThinking", key: "alt+t" }] } } },
			{ id: "vendor.keymap", packageJSON: { displayName: "IntelliJ IDEA Keymap", contributes: { keybindings: [{ command: "git.sync", key: "ctrl+t" }, { command: "-git.sync", key: "ctrl+t", when: "x" }] } } },
			{ id: "vendor.nls", packageJSON: { displayName: "%displayName%", contributes: { keybindings: [{ command: "z.run", key: "ctrl+z" }] } } },
			{ id: "vendor.plain", packageJSON: { name: "plain" } },
		];
		assert.deepEqual(foreignBindingsOf(extensions, "Me.Omp-Desk"), [
			{ by: "IntelliJ IDEA Keymap", command: "git.sync", key: "ctrl+t", when: undefined, removal: false },
			{ by: "IntelliJ IDEA Keymap", command: "git.sync", key: "ctrl+t", when: "x", removal: true },
			{ by: "vendor.nls", command: "z.run", key: "ctrl+z", when: undefined, removal: false },
		]);
		assert.equal(extensionLabel({ id: "x.y", packageJSON: { displayName: "  Pretty  " } }), "Pretty");
		assert.equal(extensionLabel({ id: "x.y", packageJSON: {} }), "x.y");
	});
});
