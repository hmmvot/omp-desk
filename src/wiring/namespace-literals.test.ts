/**
 * The source's own use of the `omp.` namespace (ADR-0068): after the move to `ompDesk.` only the names listed here may still
 * be string literals starting with `omp.`. The manifest test (`contributions.test.ts`) cannot see a missed rename in code, and a
 * missed command id would keep working through its legacy alias, with a misleading warning, until the alias is removed.
 * Each entry is also required to still occur, so a persisted key cannot be renamed by accident. Runner:
 * `node --test src/wiring/namespace-literals.test.ts`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/** Every literal in the host and page sources that may start with `omp.`, each with why it stays. */
const KEPT = new Map<string, string>([
	// Webview view types: VS Code persists an editor with its view type and revives it through the serializer of that exact type.
	["omp.session", "webview view type of a session editor (legacy generic type and namespace of the per-editor bridge types)"],
	["omp.session.b", "namespace of the per-editor bridge view types (omp.session.b2.<tab>.<editor>)"],
	["omp.shellTerminal", "webview view type of a folder shell editor"],
	["omp.settings", "webview view type of the Models/Agents settings editors"],
	["omp.detail", "the detail tabs' view type before ADR-0068, swept at activation"],
	// Persisted keys: Mementos, catalog records and SecretStorage keys of this extension.
	["omp.sessionIndex.v1", "catalog record and Memento key of the session index"],
	["omp.sessionIndex.local.v1", "per-window Memento key of the session index"],
	["omp.brokerSlots.v1", "broker slot record"],
	["omp.shellSlots.v1", "shell slot record"],
	["omp.workspaceFolders.v1", "pinned folder record"],
	["omp.windowFolderCollapsed.v1", "collapsed state of window folders"],
	["omp.unityProjectChoice.v1", "remembered Unity project choice"],
	["omp.chat.promptHistory", "prompt history Memento"],
	["omp.chat.thinkingExpanded", "thinking default Memento"],
	["omp.chat.toolsExpanded", "tool default Memento"],
	["omp.session.defaultMode", "default session view Memento"],
	["omp.agentDebugger.breakpointOwners", "breakpoint owner Memento"],
	["omp.settings.contexts", "stored settings editor contexts"],
	["omp.bridge.v1", "SecretStorage key namespace of the host bridge"],
	["omp.hostControl.key", "SecretStorage key namespace"],
	["omp.hostControl.recipient", "SecretStorage key namespace"],
	["omp.hostControl.process", "host control process record"],
	["omp.hostControl.releasedSlots", "host control release record"],
	// Ids VS Code keys only inside this extension.
	["omp.terminalsGroup", "tree element id"],
	["omp.terminalsSpacer", "tree element id"],
	["omp.newSessionRow", "tree element id"],
	["omp.resumeSessionRow", "tree element id"],
	["omp.providerLogin", "tree element id"],
	["omp.usageStatus", "status bar item id (VS Code keeps its hidden state by it)"],
	// Names of programs, not of this extension.
	["omp.exe", "OMP's Windows program"],
	["omp.cmd", "OMP's Windows program"],
	["omp.bat", "OMP's Windows program"],
]);

/** Files whose business is the old names. */
const LEGACY_FILES = new Set(["src/wiring/legacy-aliases.ts", "src/wiring/legacy-settings.ts"]);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function sources(dir: string, found: string[] = []): string[] {
	for (const name of readdirSync(dir).sort()) {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) sources(full, found);
		else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/-test-stub\.ts$|vscode-recording-stub\.ts$/.test(name)) found.push(full);
	}
	return found;
}

const LITERAL_START = /["'`](omp\.[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)/g;

describe("the omp. string literals in the sources", () => {
	const files = sources(path.join(ROOT, "src")).map(file => ({ file: path.relative(ROOT, file).split(path.sep).join("/"), text: readFileSync(file, "utf8") }));

	it("are only the names that deliberately stay, so a command, setting or context key cannot be missed by the rename", () => {
		const unexpected: string[] = [];
		for (const { file, text } of files) {
			if (LEGACY_FILES.has(file)) continue;
			for (const line of text.split("\n")) {
				if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
				for (const match of line.matchAll(LITERAL_START)) {
					const token = match[1] ?? "";
					if (!KEPT.has(token)) unexpected.push(`${file}: ${token}`);
				}
			}
		}
		assert.deepEqual(unexpected, [], "a string literal in the omp. namespace that ADR-0068 did not keep: rename it to ompDesk., or add it to KEPT with the reason it stays");
	});

	it("still contain every name that stays, so a persisted key or view type cannot be renamed by accident", () => {
		const all = files.map(({ text }) => text).join("\n");
		const gone = [...KEPT.keys()].filter(token => !new RegExp(`["'\`]${token.replace(/\./g, "\\.")}(?![A-Za-z0-9])`).test(all));
		assert.deepEqual(gone, [], "a kept name no longer occurs: it was renamed (data loss for stored state) or is dead and can leave the list");
	});

	it("read their own settings from the ompDesk section", () => {
		const bare = files.filter(({ file, text }) => !LEGACY_FILES.has(file) && /getConfiguration\(\s*["'`]omp["'`]/.test(text)).map(({ file }) => file);
		assert.deepEqual(bare, [], "getConfiguration(\"omp\") reads another extension's namespace");
		const viewCommand = files.filter(({ file, text }) => !LEGACY_FILES.has(file) && /workbench\.view\.extension\.omp\b(?!Desk)/.test(text)).map(({ file }) => file);
		assert.deepEqual(viewCommand, [], "the container id is ompDesk");
	});
});
