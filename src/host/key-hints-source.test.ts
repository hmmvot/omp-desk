/**
 * The reader behind the empty state's keys: this extension's manifest, the other extensions' and the active profile's
 * `keybindings.json`, in a scratch folder and with a real file watcher.
 *
 * Runner: `node --test src/host/key-hints-source.test.ts`
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Logger } from "../shared/logger.ts";
import type { ChatKeyHint } from "../shared/key-hints.ts";
import { MAX_KEYBINDINGS_BYTES, createKeyHintsSource, profileFolderOf } from "./key-hints-source.ts";
import type { KeyHintsSource, KeyHintsSourceDeps } from "./key-hints-source.ts";

const CHAT = "activeWebviewPanelId =~ /^omp[.]session/ && ompDesk.sessionMode == chat";
const OWN = { contributes: { keybindings: [
	{ command: "ompDesk.toggleThinking", key: "alt+t", when: CHAT },
	{ command: "ompDesk.searchPromptHistory", key: "alt+h", when: CHAT },
] } };
const KEYMAP = { id: "vendor.keymap", packageJSON: { displayName: "IntelliJ IDEA Keymap", contributes: { keybindings: [{ command: "git.sync", key: "ctrl+t" }, { command: "git.pull", key: "alt+t" }] } } };

let profile = "";
let sources: KeyHintsSource[] = [];
const messages: string[] = [];
const log: Logger = { error: (m: string) => messages.push(`error ${m}`), warn: (m: string) => messages.push(`warn ${m}`), info: (m: string) => messages.push(`info ${m}`), debug() {}, trace() {} } as unknown as Logger;

beforeEach(async () => {
	profile = await mkdtemp(path.join(tmpdir(), "omp-key-hints-"));
	await mkdir(path.join(profile, "globalStorage", "me.omp-desk"), { recursive: true });
	sources = [];
	messages.length = 0;
});

afterEach(async () => {
	for (const source of sources) source.dispose();
	await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function open(over: Partial<KeyHintsSourceDeps> = {}): { source: KeyHintsSource; changes: ChatKeyHint[][] } {
	const changes: ChatKeyHint[][] = [];
	const holder: { source?: KeyHintsSource } = {};
	const source = createKeyHintsSource({
		ownId: "me.omp-desk",
		ownManifest: OWN,
		extensions: () => [],
		keybindingsPath: path.join(profile, "keybindings.json"),
		changed: () => changes.push([...(holder.source?.current() ?? [])]),
		log,
		extensionsDebounceMs: 5,
		fileDebounceMs: 5,
		...over,
	});
	holder.source = source;
	sources.push(source);
	return { source, changes };
}

const hint = (source: KeyHintsSource, command: string): ChatKeyHint | undefined => source.current().find(entry => entry.command === command);
const waitFor = async (condition: () => boolean): Promise<void> => {
	for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 25));
	assert.ok(condition(), "the condition did not become true in time");
};

describe("profileFolderOf", () => {
	it("is two levels above the extension's global storage folder, in the default and in another profile", () => {
		assert.equal(profileFolderOf(path.join("U", "User", "globalStorage", "me.omp-desk")), path.join("U", "User"));
		assert.equal(profileFolderOf(path.join("U", "User", "profiles", "6f1a2b3c", "globalStorage", "me.omp-desk")), path.join("U", "User", "profiles", "6f1a2b3c"));
	});
});

describe("createKeyHintsSource", () => {
	it("answers in the background without a file: the manifest's keys, and the conflicts the other extensions give", async () => {
		const { source, changes } = open({ extensions: () => [{ id: "me.omp-desk", packageJSON: OWN }, KEYMAP] });
		assert.deepEqual(source.current(), [], "nothing is known before the first computation has run");
		await source.idle();
		assert.equal(hint(source, "ompDesk.toggleThinking")?.key, "Alt+T");
		assert.deepEqual(hint(source, "ompDesk.toggleThinking")?.conflicts, [{ by: "IntelliJ IDEA Keymap", command: "git.pull" }]);
		assert.equal(source.queryOf("ompDesk.toggleThinking"), '@keybinding:"alt+t"');
		assert.equal(source.queryOf("ompDesk.findInChat"), null);
		assert.equal(changes.length, 1, "told once");
	});

	it("reads a user's keybindings.json with comments: a rebinding, a removal and another command on the key", async () => {
		await writeFile(path.join(profile, "keybindings.json"), `// keys\n[\n\t{ "key": "ctrl+alt+h", "command": "ompDesk.searchPromptHistory" }, // rebound\n\t{ "key": "alt+t", "command": "-ompDesk.toggleThinking" },\n\t{ "key": "alt+h", "command": "terminal.focus" },\n]`);
		const { source } = open();
		await source.idle();
		assert.equal(hint(source, "ompDesk.searchPromptHistory")?.key, "Ctrl+Alt+H");
		assert.deepEqual(hint(source, "ompDesk.searchPromptHistory")?.conflicts, [], "alt+h is no longer its key");
		assert.equal(hint(source, "ompDesk.toggleThinking")?.key, null);
	});

	it("sees the file change, a new file, a deleted file and tells the caller each time and only when the answer differs", async () => {
		const file = path.join(profile, "keybindings.json");
		const { source, changes } = open();
		await source.idle();
		assert.equal(changes.length, 1);
		await writeFile(file, `[{ "key": "alt+t", "command": "workbench.action.terminal.toggleTerminal" }]`);
		await waitFor(() => (hint(source, "ompDesk.toggleThinking")?.conflicts.length ?? 0) === 1);
		assert.deepEqual(hint(source, "ompDesk.toggleThinking")?.conflicts, [{ by: "your keybindings.json", command: "workbench.action.terminal.toggleTerminal" }]);
		const afterFirst = changes.length;
		await writeFile(file, `[{ "key": "alt+t", "command": "workbench.action.terminal.toggleTerminal" } ]`);
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.equal(changes.length, afterFirst, "the same answer is not told again");
		await rm(file);
		await waitFor(() => hint(source, "ompDesk.toggleThinking")?.conflicts.length === 0);
	});

	it("keeps the bindings it read when the file is half-written, too large or unreadable, and says so once", async () => {
		const file = path.join(profile, "keybindings.json");
		await writeFile(file, `[{ "key": "alt+t", "command": "-ompDesk.toggleThinking" }]`);
		const { source } = open();
		await source.idle();
		assert.equal(hint(source, "ompDesk.toggleThinking")?.key, null);
		await writeFile(file, `[{ "key": "alt+t", "command": "-ompD`);
		await waitFor(() => messages.some(line => line.startsWith("warn key hints: keybindings.json was not read")));
		assert.equal(hint(source, "ompDesk.toggleThinking")?.key, null, "the previous bindings stay");
		await writeFile(file, `[]`);
		await waitFor(() => hint(source, "ompDesk.toggleThinking")?.key === "Alt+T");
	});

	it("does not read a file past the size limit, and recomputes when the extensions change", async () => {
		let extensions: { id: string; packageJSON: unknown }[] = [];
		const read = async (): Promise<string | null> => { throw new Error(`larger than ${MAX_KEYBINDINGS_BYTES} bytes`); };
		const { source } = open({ readFile: read, extensions: () => extensions });
		await source.idle();
		assert.ok(messages.some(line => line.includes(`larger than ${MAX_KEYBINDINGS_BYTES} bytes`)));
		assert.equal(hint(source, "ompDesk.toggleThinking"), undefined, "nothing was computed from a file that could not be read");
		const second = open({ extensions: () => extensions });
		await second.source.idle();
		assert.deepEqual(hint(second.source, "ompDesk.toggleThinking")?.conflicts, []);
		extensions = [KEYMAP];
		second.source.extensionsChanged();
		await waitFor(() => (hint(second.source, "ompDesk.toggleThinking")?.conflicts.length ?? 0) === 1);
		extensions = [];
		second.source.extensionsChanged();
		await waitFor(() => hint(second.source, "ompDesk.toggleThinking")?.conflicts.length === 0);
	});

	it("does nothing after dispose: no change, no timer", async () => {
		const { source, changes } = open({ extensions: () => [KEYMAP] });
		await source.idle();
		const told = changes.length;
		source.dispose();
		await writeFile(path.join(profile, "keybindings.json"), `[{ "key": "alt+t", "command": "x.y" }]`);
		source.extensionsChanged();
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.equal(changes.length, told);
	});
});
