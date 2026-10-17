import assert from "node:assert/strict";
import { test } from "node:test";
import type { SymbolChoice, SymbolSearchHost } from "./symbol-search.ts";
import { searchSymbol } from "./symbol-search.ts";
import type { SymbolEntry, SymbolFind } from "./symbol-links.ts";

const CWD = "D:\\Work\\omp-vscode";
const scope = { cwd: CWD, roots: [CWD] };
const entry = (name: string, file: string, line: number, container: string, column = 5): SymbolEntry =>
	({ name, kind: 6, container, path: `${CWD}\\${file}`, line, column });

/** A host answering `found` for every qualified lookup, recording what it was asked and what it did. */
function world(found: SymbolFind, choose: (choices: readonly SymbolChoice[]) => SymbolEntry | undefined = () => undefined) {
	const events: string[] = [];
	const host: SymbolSearchHost = {
		find: async (symbol, from) => { events.push(`find ${symbol.name} in ${from.cwd}`); return found; },
		open: async location => { events.push(`open ${location.path.slice(CWD.length + 1)}:${location.line}:${location.column}`); },
		pick: async choices => { events.push(`pick ${choices.map(choice => `${choice.label} | ${choice.description} | ${choice.detail}`).join("; ")}`); return choose(choices); },
		quickOpen: async value => { events.push(`quickOpen ${value}`); },
	};
	return { events, host };
}

test("an unqualified name, a call without a qualifier and text that is no symbol go to the Quick Open as typed, and nothing is looked up", async () => {
	const w = world({ state: "matches", entries: [entry("Load", "A.cs", 1, "SessionData")], via: "container" });
	await searchSymbol("  SessionData  ", scope, w.host);
	await searchSymbol("Load()\nmore", scope, w.host);
	await searchSymbol("two words here", scope, w.host);
	assert.deepEqual(w.events, ["quickOpen #SessionData", "quickOpen #Load()", "quickOpen #two words here"]);
});

test("one definition of a qualified name opens at its position", async () => {
	const w = world({ state: "matches", entries: [entry("Load", "src\\SessionData.cs", 42, "SessionData", 9)], via: "container" });
	await searchSymbol("SessionData.Load", scope, w.host);
	assert.deepEqual(w.events, [`find SessionData.Load in ${CWD}`, "open src\\SessionData.cs:42:9"]);
});

test("several definitions are chosen from, with name, container and file, and the chosen one opens; dismissing opens nothing", async () => {
	const first = entry("Load", "A.cs", 4, "Other.SessionData");
	const second = entry("Load", "B.cs", 20, "Core.SessionData");
	const found: SymbolFind = { state: "matches", entries: [first, second], via: "container" };
	const chosen = world(found, choices => choices[1]?.entry);
	await searchSymbol("SessionData.Load", scope, chosen.host);
	assert.deepEqual(chosen.events, [
		`find SessionData.Load in ${CWD}`,
		"pick Load | Other.SessionData | A.cs:4:5; Load | Core.SessionData | B.cs:20:5",
		"open B.cs:20:5",
	]);
	const dismissed = world(found);
	await searchSymbol("SessionData.Load", scope, dismissed.host);
	assert.equal(dismissed.events.some(event => event.startsWith("open") || event.startsWith("quickOpen")), false);
});

test("a qualified name nothing matches, or the lookup cannot answer, falls back to the Quick Open with the last segment", async () => {
	for (const state of ["none", "unavailable", "pending"] as const) {
		const w = world({ state });
		await searchSymbol("OmpDesk.SessionData.Load(x, 3)", scope, w.host);
		assert.deepEqual(w.events, [`find OmpDesk.SessionData.Load in ${CWD}`, "quickOpen #Load"], state);
	}
});

test("a definition without a position opens at the top of its file", async () => {
	const w = world({ state: "matches", entries: [entry("Load", "A.cs", 0, "SessionData", 0)], via: "container" });
	await searchSymbol("SessionData.Load", scope, w.host);
	assert.deepEqual(w.events.slice(1), ["open A.cs:1:1"]);
});
