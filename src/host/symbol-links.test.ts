import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCodeSymbol } from "../webview/code-symbols.ts";
import type { SymbolLinksResolution } from "../webview/code-symbols.ts";
import { SymbolKind, SymbolLinkResolver, handleSymbolLinks, isInside, isNameCandidate, matchSymbol, symbolEntry, symbolRoots, symbolTarget } from "./symbol-links.ts";
import type { SymbolEntry, SymbolSource } from "./symbol-links.ts";

const CWD = "D:\\Work\\Game";
const entry = (name: string, kind: number, file: string, line = 10, container = "", column = 5): SymbolEntry =>
	({ name, kind, container, path: `${CWD}\\${file}`, line, column });
const symbol = (content: string) => {
	const parsed = parseCodeSymbol(content);
	assert.ok(parsed !== null, content);
	return parsed;
};
const unique = (content: string, entries: SymbolEntry[]) => {
	const match = matchSymbol(symbol(content), entries);
	return match.state === "unique" ? match.entry.path.slice(CWD.length + 1) + ":" + match.entry.line : match.state;
};
/** One turn of the event loop, so promise continuations that were already due have run. */
function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

test("a bare name matches its exact name case-sensitively, and parameter and generic lists on the provider's name are ignored", () => {
	const entries = [entry("Ability", SymbolKind.Class, "A.cs", 3), entry("AbilityData", SymbolKind.Class, "B.cs"), entry("ability", SymbolKind.Class, "C.cs")];
	assert.equal(unique("Ability", entries), "A.cs:3");
	assert.equal(unique("Abilit", entries), "none");
	assert.equal(unique("Ability", [entry("Ability<T>", SymbolKind.Class, "G.cs", 7)]), "G.cs:7");
	assert.equal(unique("Cast()", [entry("Cast(Unit unit, int n)", SymbolKind.Method, "M.cs", 9, "AbilityData")]), "M.cs:9");
	assert.equal(unique("Cast", [entry("cast", SymbolKind.Method, "M.cs")]), "none", "case matters");
});

test("a dotted name needs its preceding segments to end the entry's container; a container-less entry never matches", () => {
	const cast = (container: string, file = "M.cs") => entry("Cast", SymbolKind.Method, file, 20, container);
	assert.equal(unique("AbilityData.Cast", [cast("AbilityData")]), "M.cs:20");
	assert.equal(unique("AbilityData.Cast", [cast("Game.Abilities.AbilityData")]), "M.cs:20", "a qualified container ends with the segment");
	assert.equal(unique("AbilityData.Cast", [cast("Game.Abilities.AbilityData<T>")]), "M.cs:20", "generic arguments of the container are ignored");
	assert.equal(unique("Abilities.AbilityData.Cast", [cast("Game.Abilities.AbilityData")]), "M.cs:20");
	assert.equal(unique("Other.AbilityData.Cast", [cast("Game.Abilities.AbilityData")]), "none");
	assert.equal(unique("AbilityData.Cast", [cast("OtherData")]), "none");
	assert.equal(unique("AbilityData.Cast", [cast("")]), "none");
	assert.equal(unique("Data.Cast", [cast("AbilityData")]), "none", "a segment is compared whole, not as a suffix of text");
	assert.equal(unique("AbilityData.Cast", [cast("AbilityData", "A.cs"), cast("Other.AbilityData", "B.cs")]), "ambiguous", "two classes of one name each hold the member");
	assert.equal(unique("Game.AbilityData", [entry("AbilityData", SymbolKind.Class, "A.cs", 4, "Game")]), "A.cs:4", "a qualified type matches through its namespace");
	assert.equal(unique("Color.Red", [entry("Red", SymbolKind.EnumMember, "C.cs", 2, "Color")]), "C.cs:2");
});

test("a bare capitalized name prefers a type over members of that name; members are accepted when no type matches", () => {
	const type = entry("Ability", SymbolKind.Class, "T.cs", 1);
	const member = entry("Ability", SymbolKind.Property, "P.cs", 2, "Unit");
	assert.equal(unique("Ability", [type, member]), "T.cs:1");
	assert.equal(unique("Ability", [member]), "P.cs:2");
	assert.equal(unique("Ability", [member, entry("Ability", SymbolKind.Field, "F.cs", 3, "Other")]), "ambiguous");
	assert.equal(unique("Ability", [type, entry("Ability", SymbolKind.Class, "U.cs", 1, "Other")]), "ambiguous", "two types of one name in different containers");
	assert.equal(unique("Ability", [type, entry("Ability", SymbolKind.Constructor, "T.cs", 4, "Ability")]), "T.cs:1", "a constructor is not a rival of its class");
	assert.equal(unique("start()", [entry("start", SymbolKind.Function, "S.ts", 8)]), "S.ts:8", "a lowercase call is a function, found without a type");
	assert.equal(unique("start()", [entry("start", SymbolKind.Function, "S.ts", 8), entry("start", SymbolKind.Method, "T.ts", 2, "Loop")]), "ambiguous");
});

test("overloads, partial classes and a duplicate report of one declaration: distinct locations are counted, one location is one definition", () => {
	assert.equal(unique("Cast", [entry("Cast(int)", SymbolKind.Method, "M.cs", 30, "AbilityData"), entry("Cast(string)", SymbolKind.Method, "M.cs", 20, "AbilityData")]), "M.cs:20", "overloads of one member in one container are one symbol: the first by position");
	assert.equal(unique("Cast", [entry("Cast", SymbolKind.Method, "M.cs", 20, "AbilityData"), entry("Cast", SymbolKind.Method, "M.cs", 30, "OtherData")]), "ambiguous", "same name in two containers");
	assert.equal(unique("Cast", [entry("Cast", SymbolKind.Method, "M.cs", 20, "AbilityData"), entry("Cast", SymbolKind.Property, "M.cs", 30, "AbilityData")]), "ambiguous", "a method and a property are two symbols");
	assert.equal(unique("Unit", [entry("Unit", SymbolKind.Class, "Unit.Combat.cs", 5), entry("Unit", SymbolKind.Class, "Unit.cs", 9), entry("Unit", SymbolKind.Class, "Unit.Items.cs", 2)]), "Unit.cs:9", "partial parts: the type's own file");
	assert.equal(unique("Unit", [entry("Unit", SymbolKind.Class, "B.cs", 5, "Game"), entry("Unit", SymbolKind.Class, "A.cs", 9, "Game")]), "A.cs:9", "partial parts without an own file: the first by path");
	assert.equal(unique("Unit", [entry("Unit<T>", SymbolKind.Class, "U1.cs", 5), entry("Unit", SymbolKind.Class, "U2.cs", 9)]), "ambiguous", "a generic and a non-generic type are two types");
	assert.equal(unique("Unit", [entry("Unit", SymbolKind.Class, "U1.ts", 5), entry("Unit", SymbolKind.Class, "U2.ts", 9)]), "ambiguous", "outside C# a container-less type is never merged");
	assert.equal(unique("Unit", [entry("Unit", SymbolKind.Class, "A.cs", 5, "One"), entry("Unit", SymbolKind.Class, "B.cs", 9, "Two")]), "ambiguous", "two namespaces");
	const twins = [entry("Unit", SymbolKind.Class, "A.cs", 5, "One"), entry("Unit", SymbolKind.Class, "sub\\B.cs", 9, "Two")];
	const near = matchSymbol(symbol("Unit"), twins, `${CWD}\\sub`);
	assert.ok(near.state === "unique" && near.via === "cwd" && near.entry.path.endsWith("B.cs"), "exactly one same-named type lies inside the session folder");
	assert.equal(matchSymbol(symbol("Unit"), twins, CWD).state, "ambiguous", "both lie inside it");
	assert.equal(unique("Unit", [entry("Unit", SymbolKind.Class, "Unit.cs", 5), entry("Unit", SymbolKind.Class, "unit.CS", 5)]), "Unit.cs:5", "the same declaration reported twice (any path case)");
});

test("attributes match the type of the name or of the name with the Attribute suffix, and nothing else", () => {
	assert.equal(unique("[AllowedOn]", [entry("AllowedOnAttribute", SymbolKind.Class, "A.cs", 3)]), "A.cs:3");
	assert.equal(unique("[AllowedOn]", [entry("AllowedOn", SymbolKind.Class, "A.cs", 3)]), "A.cs:3");
	assert.equal(unique("[AllowedOn]", [entry("AllowedOnAttribute", SymbolKind.Class, "A.cs", 3), entry("AllowedOn", SymbolKind.Class, "B.cs", 3)]), "ambiguous");
	assert.equal(unique("[AllowedOn]", [entry("AllowedOn", SymbolKind.Method, "A.cs", 3)]), "none", "an attribute is a type");
	assert.equal(unique("AllowedOn", [entry("AllowedOnAttribute", SymbolKind.Class, "A.cs", 3)]), "none", "without brackets the suffix is not implied");
});

test("kinds that are not a symbol of the code never match", () => {
	for (const kind of [SymbolKind.File, SymbolKind.Package, SymbolKind.String, SymbolKind.Number, SymbolKind.Boolean, SymbolKind.Array, SymbolKind.Null, SymbolKind.Operator, SymbolKind.TypeParameter, SymbolKind.Key, SymbolKind.Object]) {
		assert.equal(unique("Thing", [entry("Thing", kind, "X.ts")]), "none", `kind ${kind}`);
	}
	for (const kind of [SymbolKind.Class, SymbolKind.Interface, SymbolKind.Struct, SymbolKind.Enum, SymbolKind.Function, SymbolKind.Variable, SymbolKind.Constant, SymbolKind.Namespace, SymbolKind.Event]) {
		assert.equal(unique("Thing", [entry("Thing", kind, "X.ts", 3)]), "X.ts:3", `kind ${kind}`);
	}
});

test("only a file inside the session folder or an open workspace folder that contains it counts", () => {
	assert.equal(isInside("D:\\Work\\Game", "D:\\Work\\Game\\src\\a.ts"), true);
	assert.equal(isInside("D:\\Work\\Game", "d:/work/game/src/a.ts"), true, "case and separators");
	assert.equal(isInside("D:\\Work\\Game", "D:\\Work\\Game"), true);
	assert.equal(isInside("D:\\Work\\Game", "D:\\Work\\Game2\\a.ts"), false, "a sibling that shares a prefix");
	assert.equal(isInside("D:\\Work\\Game", "D:\\Work\\a.ts"), false);
	assert.equal(isInside("D:\\Work\\Game", "E:\\Work\\Game\\a.ts"), false, "another drive");
	assert.equal(isInside("D:\\Work\\Game", ""), false, "a non-file location has no path");
	assert.equal(isInside("", "D:\\x"), false);
	assert.deepEqual(symbolRoots("D:\\Work\\Game", ["D:\\Work\\Game", "D:\\Work", "D:\\Work\\Game\\Sub", "D:\\Other"]), ["D:\\Work\\Game", "D:\\Work"], "the cwd and a workspace folder that contains it");
	assert.deepEqual(symbolRoots("", ["D:\\Work"]), []);
});

test("a target is relative to the session folder inside it and absolute outside, with the line and column the provider gave", () => {
	assert.equal(symbolTarget({ ...entry("A", SymbolKind.Class, "src\\a b.cs", 12, "", 4), path: `${CWD}\\src\\a b.cs` }, CWD), "src/a b.cs:12:4");
	assert.equal(symbolTarget({ name: "A", kind: SymbolKind.Class, container: "", path: "D:\\Work\\Lib\\a.cs", line: 3, column: 0 }, CWD), "D:\\Work\\Lib\\a.cs:3:1");
	assert.equal(symbolTarget({ name: "A", kind: SymbolKind.Class, container: "", path: `${CWD}\\a.cs`, line: 0, column: 0 }, CWD), "a.cs", "no position: the file only");
});

test("a provider symbol becomes an entry only for a file location, and a missing or placeholder range is no position", () => {
	const at = (line: number, character: number) => ({ start: { line, character }, end: { line, character: character + 3 } });
	const file = { scheme: "file", fsPath: `${CWD}\\a.ts` };
	assert.deepEqual(symbolEntry({ name: "A", kind: 4, containerName: "N", location: { uri: file, range: at(11, 3) } }), { name: "A", kind: 4, container: "N", path: file.fsPath, line: 12, column: 4 });
	assert.equal(symbolEntry({ name: "A", kind: 4, location: { uri: { scheme: "csharp", fsPath: "x" }, range: at(1, 1) } }).path, "", "metadata is outside every folder");
	assert.equal(symbolEntry({ name: "A", kind: 4, location: { uri: file } }).line, 0);
	assert.equal(symbolEntry({ name: "A", kind: 4, location: { uri: file, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } } }).line, 0, "an unresolved placeholder at the origin");
	assert.equal(symbolEntry({ name: "A", kind: 4, location: { uri: file, range: at(0, 0) } }).line, 1, "a real declaration on the first line");
	const oversize = symbolEntry({ name: "A", kind: 4, containerName: "x".repeat(2000), location: { uri: file, range: at(1, 1) } });
	assert.deepEqual([oversize.name, oversize.kind, oversize.container], ["", -1, ""], "metadata too long to match faithfully is never cut into another identity");
});

/** A provider answering from a table of query text to entries, with a record of what it was asked. */
function provider(answers: Record<string, SymbolEntry[] | "throw" | "hang">) {
	const asked: string[] = [];
	let hung = 0;
	const source: SymbolSource = {
		query(text) {
			asked.push(text);
			const answer = answers[text] ?? [];
			if (answer === "throw") return Promise.reject(new Error("provider failed"));
			if (answer === "hang") { hung++; return new Promise(() => {}); }
			return Promise.resolve(answer);
		},
	};
	return { source, asked, hung: () => hung };
}
const scope = { cwd: CWD, roots: [CWD] };

test("a unique definition inside the folder is found; ambiguous, outside and unknown symbols are none", async () => {
	const { source } = provider({
		Ability: [entry("Ability", SymbolKind.Class, "A.cs", 3), entry("AbilityData", SymbolKind.Class, "D.cs")],
		Twin: [entry("Twin", SymbolKind.Class, "A.ts"), entry("Twin", SymbolKind.Class, "B.ts")],
		Lib: [{ name: "Lib", kind: SymbolKind.Class, container: "", path: "C:\\Other\\Lib.cs", line: 1, column: 1 }, { name: "Lib", kind: SymbolKind.Class, container: "", path: "", line: 0, column: 0 }],
		Unknown: [entry("UnknownThing", SymbolKind.Class, "U.cs")],
	});
	const resolver = new SymbolLinkResolver(source);
	assert.deepEqual(await resolver.resolve(symbol("Ability"), scope), { status: "found", target: "A.cs:3:5" });
	assert.deepEqual(await resolver.resolve(symbol("Twin"), scope), { status: "ambiguous", definitions: 2 }, "several definitions: a link to the symbol search, never to one of them");
	assert.deepEqual(await resolver.resolve(symbol("Lib"), scope), { status: "none" });
	assert.deepEqual(await resolver.resolve(symbol("Unknown"), scope), { status: "none" });
});

test("a dotted name asks for its last segment, and only when that finds nothing for the full dotted text", async () => {
	const cast = entry("Cast", SymbolKind.Method, "M.cs", 20, "AbilityData");
	const byLast = provider({ Cast: [cast, entry("Cast", SymbolKind.Method, "N.cs", 4, "Other")] });
	assert.deepEqual(await new SymbolLinkResolver(byLast.source).resolve(symbol("AbilityData.Cast()"), scope), { status: "found", target: "M.cs:20:5" });
	assert.deepEqual(byLast.asked, ["Cast"]);
	const qualified = provider({ Cast: [entry("Cast", SymbolKind.Method, "N.cs", 4, "Other")], "AbilityData.Cast": [cast] });
	assert.deepEqual(await new SymbolLinkResolver(qualified.source).resolve(symbol("AbilityData.Cast"), scope), { status: "found", target: "M.cs:20:5" });
	assert.deepEqual(qualified.asked, ["Cast", "AbilityData.Cast"], "a second, qualified question only after the plain one found nothing");
	const ambiguous = provider({ Cast: [cast, entry("Cast", SymbolKind.Method, "N.cs", 4, "Other.AbilityData")] });
	assert.deepEqual(await new SymbolLinkResolver(ambiguous.source).resolve(symbol("AbilityData.Cast"), scope), { status: "ambiguous", definitions: 2 });
	assert.deepEqual(ambiguous.asked, ["Cast"], "an ambiguous answer is final");
});

test("an empty answer, an error and a timeout are unavailable, never cached; a real answer is cached with its own lifetime", async () => {
	let now = 1_000;
	const empty = provider({});
	const resolver = new SymbolLinkResolver(empty.source, { now: () => now, foundTtlMs: 100, noneTtlMs: 40 });
	assert.deepEqual(await resolver.resolve(symbol("Ability"), scope), { status: "pending" }, "an empty answer before the provider ever answered is not a verdict");
	assert.deepEqual(await resolver.resolve(symbol("Ability"), scope), { status: "pending" });
	assert.deepEqual(empty.asked, ["Ability", "Ability"], "a pending token is asked again, never cached");
	const thrown = provider({ Ability: "throw" });
	assert.deepEqual(await new SymbolLinkResolver(thrown.source).resolve(symbol("Ability"), scope), { status: "unavailable" });
	const hung = provider({ Ability: "hang" });
	assert.deepEqual(await new SymbolLinkResolver(hung.source, { queryTimeoutMs: 10 }).resolve(symbol("Ability"), scope), { status: "pending" });

	const answers = provider({ Ability: [entry("Ability", SymbolKind.Class, "A.cs", 3)], Nope: [entry("Other", SymbolKind.Class, "O.cs")] });
	const cached = new SymbolLinkResolver(answers.source, { now: () => now, foundTtlMs: 100, noneTtlMs: 40 });
	await cached.resolve(symbol("Ability"), scope); await cached.resolve(symbol("Nope"), scope);
	await cached.resolve(symbol("Ability"), scope); await cached.resolve(symbol("Nope"), scope);
	assert.deepEqual(answers.asked, ["Ability", "Nope"], "within the lifetime, answers come from the cache");
	now += 50;
	await cached.resolve(symbol("Ability"), scope); await cached.resolve(symbol("Nope"), scope);
	assert.deepEqual(answers.asked, ["Ability", "Nope", "Nope"], "a none expires first");
	now += 100;
	await cached.resolve(symbol("Ability"), scope);
	assert.deepEqual(answers.asked.at(-1), "Ability");
	assert.equal(answers.asked.length, 4);
});

test("the cache is per session folder and per spelling that changes matching, and one question in flight is shared", async () => {
	const answers = provider({ AllowedOn: [entry("AllowedOnAttribute", SymbolKind.Class, "A.cs", 3)] });
	const resolver = new SymbolLinkResolver(answers.source);
	assert.deepEqual(await resolver.resolve(symbol("AllowedOn"), scope), { status: "none" });
	assert.deepEqual(await resolver.resolve(symbol("[AllowedOn]"), scope), { status: "found", target: "A.cs:3:5" }, "an attribute is not served the plain name's answer");
	const other = { cwd: "D:\\Work\\Other", roots: ["D:\\Work\\Other"] };
	assert.deepEqual(await resolver.resolve(symbol("[AllowedOn]"), other), { status: "none" }, "another session folder has its own answer");
	const both = await Promise.all([resolver.resolve(symbol("AllowedOn()"), scope), resolver.resolve(symbol("AllowedOn<T>"), scope)]);
	assert.deepEqual(both, [{ status: "none" }, { status: "none" }]);
});

test("invalidation drops cached answers and fences lookups that were running: they return unavailable and cache nothing", async () => {
	const release: (() => void)[] = [];
	let version = 1;
	const asked: string[] = [];
	const source: SymbolSource = {
		query: text => new Promise(resolve => { asked.push(text); release.push(() => resolve([entry("Ability", SymbolKind.Class, version === 1 ? "Old.cs" : "New.cs", 3)])); }),
	};
	const resolver = new SymbolLinkResolver(source);
	const stale = resolver.resolve(symbol("Ability"), scope);
	await tick();
	version = 2;
	resolver.invalidate();
	const fresh = resolver.resolve(symbol("Ability"), scope);
	await tick();
	assert.equal(asked.length, 2, "a new generation never joins the old lookup");
	release[0]!(); release[1]!();
	assert.deepEqual(await stale, { status: "unavailable" }, "the old answer is not delivered");
	assert.deepEqual(await fresh, { status: "found", target: "New.cs:3:5" });
	await resolver.resolve(symbol("Ability"), scope);
	assert.equal(asked.length, 2, "the fresh answer was cached, the stale one did not replace it");
	resolver.invalidate();
	const again = resolver.resolve(symbol("Ability"), scope);
	await tick();
	release[2]!();
	await again;
	assert.equal(asked.length, 3, "after an invalidation the cache is empty");
});

test("at most the configured provider calls run at once; a slot is released only when the provider settles, and a full line refuses instead of queueing", async () => {
	let running = 0;
	let peak = 0;
	const releases: (() => void)[] = [];
	const source: SymbolSource = {
		query: () => new Promise(resolve => { running++; peak = Math.max(peak, running); releases.push(() => { running--; resolve([]); }); }),
	};
	const resolver = new SymbolLinkResolver(source, { maxConcurrent: 2, queryTimeoutMs: 20 });
	const names = ["Aaa", "Bbb", "Ccc", "Ddd"];
	const results = names.map(name => resolver.resolve(symbol(name), scope));
	assert.deepEqual(await Promise.all(results.slice(0, 2)), [{ status: "pending" }, { status: "pending" }], "the first two time out and wait");
	assert.equal(peak, 2, "four lookups, two provider calls at a time");
	assert.equal(releases.length, 2, "the timeout of the first two did not free their slots for the others");
	assert.deepEqual(await Promise.all(results.slice(2)), [{ status: "pending" }, { status: "pending" }], "a lookup waiting for a slot gives up after the same deadline and waits for the queue to drain");
	releases.splice(0).forEach(release => release());
	await tick();
	assert.equal(releases.length, 0, "an expired waiter is not dispatched when a slot frees up");
	assert.equal(peak, 2);

	const handedOn: (() => void)[] = [];
	const patient = new SymbolLinkResolver({ query: () => new Promise(resolve => { handedOn.push(() => resolve([])); }) }, { maxConcurrent: 1, queryTimeoutMs: 1000 });
	const first = patient.resolve(symbol("Eee"), scope);
	const second = patient.resolve(symbol("Fff"), scope);
	await tick();
	assert.equal(handedOn.length, 1, "the second lookup waits for the only slot");
	handedOn.splice(0).forEach(release => release());
	await tick();
	assert.equal(handedOn.length, 1, "settlement hands the slot to the next waiter");
	handedOn.splice(0).forEach(release => release());
	await Promise.all([first, second]);

	const refused: Promise<unknown>[] = [];
	const crowded = new SymbolLinkResolver({ query: () => new Promise(() => {}) }, { maxConcurrent: 1, queryTimeoutMs: 5 });
	for (let index = 0; index < 80; index++) refused.push(crowded.resolve(symbol(`Name${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}x`), scope));
	const settled = await Promise.all(refused.slice(65));
	assert.deepEqual(settled, Array.from({ length: 15 }, () => ({ status: "pending" })), "beyond the waiting line, lookups are refused at once and wait for the queue to drain");
});

function host(overrides: Partial<{ enabled: () => boolean; roots: () => string[]; isCurrent: () => boolean; cwd: string }> = {}) {
	const replies: SymbolLinksResolution[] = [];
	return {
		replies,
		host: { cwd: CWD, roots: () => [CWD], enabled: () => true, isCurrent: () => true, reply: (message: SymbolLinksResolution) => { replies.push(message); }, ...overrides },
	};
}

test("a batch answers every token it was asked, normalizes each on the host and treats a non-symbol as none", async () => {
	const { source } = provider({ Ability: [entry("Ability", SymbolKind.Class, "A.cs", 3)] });
	const { host: h, replies } = host();
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 7, tokens: ["Ability", "two words", "Ability()", "Missing"] }, h, new SymbolLinkResolver(source));
	assert.deepEqual(replies, [{
		type: "omp:terminal-link-symbol-resolution", requestId: 7,
		results: [
			{ token: "Ability", status: "found", target: "A.cs:3:5" },
			{ token: "two words", status: "none" },
			{ token: "Ability()", status: "found", target: "A.cs:3:5" },
			{ token: "Missing", status: "none" },
		],
	}]);
});

test("with the setting off the host answers none and disabled, and nothing is asked of any provider", async () => {
	const { source, asked } = provider({ Ability: [entry("Ability", SymbolKind.Class, "A.cs")] });
	const { host: h, replies } = host({ enabled: () => false });
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 1, tokens: ["Ability"] }, h, new SymbolLinkResolver(source));
	assert.deepEqual(replies, [{ type: "omp:terminal-link-symbol-resolution", requestId: 1, disabled: true, results: [{ token: "Ability", status: "none" }] }]);
	assert.deepEqual(asked, []);
});

test("a setting turned off, a folder set that changed, or a replaced document while the provider worked revokes the answer", async () => {
	const answers = { Ability: [entry("Ability", SymbolKind.Class, "A.cs", 3)] };
	const request = { type: "omp:terminal-link-symbols" as const, requestId: 2, tokens: ["Ability"] };
	let enabled = true;
	const disabledMidway = host({ enabled: () => enabled });
	const midway: SymbolSource = { query: async () => { enabled = false; return answers.Ability; } };
	await handleSymbolLinks(request, disabledMidway.host, new SymbolLinkResolver(midway));
	assert.deepEqual(disabledMidway.replies, [{ type: "omp:terminal-link-symbol-resolution", requestId: 2, disabled: true, results: [{ token: "Ability", status: "none" }] }]);

	let roots = [CWD];
	const moved = host({ roots: () => roots });
	await handleSymbolLinks(request, moved.host, new SymbolLinkResolver({ query: async () => { roots = []; return answers.Ability; } }));
	assert.deepEqual(moved.replies, [{ type: "omp:terminal-link-symbol-resolution", requestId: 2, results: [{ token: "Ability", status: "unavailable" }] }]);

	let current = true;
	const replaced = host({ isCurrent: () => current });
	await handleSymbolLinks(request, replaced.host, new SymbolLinkResolver({ query: async () => { current = false; return answers.Ability; } }));
	assert.deepEqual(replaced.replies, [], "a replaced document is answered with nothing");
});

test("a batch is answered at its deadline with what has settled, and the rest stays unavailable", async () => {
	const answers: Record<string, SymbolEntry[] | "hang"> = { Ability: [entry("Ability", SymbolKind.Class, "A.cs", 3)], Slow: "hang" };
	const { source } = provider(answers);
	const { host: h, replies } = host();
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 3, tokens: ["Slow", "Ability"] }, h, new SymbolLinkResolver(source, { queryTimeoutMs: 1000 }), 20);
	assert.deepEqual(replies[0]!.results, [{ token: "Slow", status: "unavailable" }, { token: "Ability", status: "found", target: "A.cs:3:5" }]);
});

test("a locally truncated answer never makes a unique match; a failed qualified query is unavailable, not a miss", async () => {
	const filler = (count: number) => Array.from({ length: count }, (_, index) => entry(`Other${index}`, SymbolKind.Class, `F${index}.cs`));
	const cut = provider({ Ability: [entry("Ability", SymbolKind.Class, "A.cs", 3), ...filler(1000), entry("Ability", SymbolKind.Class, "B.cs", 4)] });
	assert.deepEqual(await new SymbolLinkResolver(cut.source).resolve(symbol("Ability"), scope), { status: "unavailable" }, "the second declaration lies beyond what Desk looks at");
	const cutAmbiguous = provider({ Twin: [entry("Twin", SymbolKind.Class, "A.ts"), entry("Twin", SymbolKind.Class, "B.ts"), ...filler(1000)] });
	assert.deepEqual(await new SymbolLinkResolver(cutAmbiguous.source).resolve(symbol("Twin"), scope), { status: "ambiguous", definitions: 2 }, "an ambiguity inside the examined prefix still holds");
	const exact = provider({ Ability: [entry("Ability", SymbolKind.Class, "A.cs", 3), ...filler(999)] });
	assert.deepEqual(await new SymbolLinkResolver(exact.source).resolve(symbol("Ability"), scope), { status: "found", target: "A.cs:3:5" }, "exactly the bound is not a cut");

	const unrelated = [entry("Cast", SymbolKind.Method, "N.cs", 4, "Other")];
	for (const failure of ["throw", "hang"] as const) {
		const failing = provider({ Cast: unrelated, "AbilityData.Cast": failure });
		assert.deepEqual(await new SymbolLinkResolver(failing.source, { queryTimeoutMs: 10 }).resolve(symbol("AbilityData.Cast"), scope), { status: failure === "hang" ? "pending" : "unavailable" }, failure);
	}
	const completed = provider({ Cast: unrelated, "AbilityData.Cast": [] });
	assert.deepEqual(await new SymbolLinkResolver(completed.source).resolve(symbol("AbilityData.Cast"), scope), { status: "none" }, "a qualified query that completed and found nothing is a miss");
});

test("declarations without a position are one symbol when they are overloads in one container, and the positioned one is opened", () => {
	const bare = (name: string, file: string, container = "AbilityData") => entry(name, SymbolKind.Method, file, 0, container, 0);
	assert.equal(unique("Cast", [bare("Cast(int)", "M.cs"), bare("Cast(string)", "M.cs")]), "M.cs:0", "two unresolved overloads in one file open the file");
	assert.equal(unique("Cast", [bare("Cast(int)", "M.cs"), entry("Cast(string)", SymbolKind.Method, "M.cs", 30, "AbilityData")]), "M.cs:30", "unresolved beside resolved: the resolved one");
	assert.equal(unique("Cast", [bare("Cast(int)", "M.cs"), bare("Cast(int)", "M.cs", "OtherData")]), "ambiguous", "unresolved in two containers");
	assert.equal(unique("Cast", [bare("Cast", "M.cs")]), "M.cs:0", "one unresolved declaration opens its file");
});

test("a path component that merely starts with dots is inside the folder; a real parent traversal is not", () => {
	assert.equal(isInside("D:\\Work\\Game", "D:\\Work\\Game\\..helpers\\a.ts"), true);
	assert.equal(isInside("D:\\Work\\Game", "D:\\Work\\Game\\..\\a.ts"), false);
});

test("a lookup that waits for a slot is dropped by an invalidation instead of reaching the provider, and a batch drops answers a file change made stale", async () => {
	const asked: string[] = [];
	const releases: (() => void)[] = [];
	const source: SymbolSource = { query: text => { asked.push(text); return new Promise(resolve => { releases.push(() => resolve([entry(text, SymbolKind.Class, `${text}.cs`, 2)])); }); } };
	const resolver = new SymbolLinkResolver(source, { maxConcurrent: 1, queryTimeoutMs: 1000 });
	const running = resolver.resolve(symbol("Aaa"), scope);
	const waiting = resolver.resolve(symbol("Bbb"), scope);
	await tick();
	resolver.invalidate();
	releases.splice(0).forEach(release => release());
	assert.deepEqual(await Promise.all([running, waiting]), [{ status: "unavailable" }, { status: "unavailable" }]);
	assert.deepEqual(asked, ["Aaa"], "the waiting lookup never reached the provider");

	const fast = entry("Ability", SymbolKind.Class, "A.cs", 3);
	let slow: (() => void) | undefined;
	const batchResolver = new SymbolLinkResolver({ query: text => text === "Ability" ? Promise.resolve([fast]) : new Promise(resolve => { slow = () => resolve([]); }) });
	const { host: h, replies } = host();
	const batch = handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 9, tokens: ["Ability", "Slowpoke"] }, h, batchResolver);
	await tick();
	batchResolver.invalidate();
	slow?.();
	await batch;
	assert.deepEqual(replies[0]!.results, [{ token: "Ability", status: "unavailable" }, { token: "Slowpoke", status: "unavailable" }]);
});

test("an entry too long to match makes the lookup uncertain: it can hide the only rival of a unique match", async () => {
	const long = symbolEntry({ name: `Cast(${"int, ".repeat(100)})`, kind: SymbolKind.Method, containerName: "AbilityData", location: { uri: { scheme: "file", fsPath: `${CWD}\\M.cs` }, range: { start: { line: 29, character: 0 }, end: { line: 29, character: 4 } } } });
	assert.equal(long.kind, -1);
	const one = provider({ Cast: [entry("Cast(int)", SymbolKind.Method, "M.cs", 20, "AbilityData"), long] });
	assert.deepEqual(await new SymbolLinkResolver(one.source).resolve(symbol("Cast"), scope), { status: "unavailable" });
	const rivals = provider({ Cast: [entry("Cast(int)", SymbolKind.Method, "M.cs", 20, "AbilityData"), entry("Cast(string)", SymbolKind.Method, "M.cs", 30, "OtherData"), long] });
	assert.deepEqual(await new SymbolLinkResolver(rivals.source).resolve(symbol("Cast"), scope), { status: "ambiguous", definitions: 2 }, "an ambiguity already seen stays one");
});

test("the host works on a bounded number of batches at once and refuses the rest at once", async () => {
	const resolver = new SymbolLinkResolver({ query: () => new Promise(() => {}) }, { queryTimeoutMs: 1000 });
	const running = Array.from({ length: 8 }, (_, index) => handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: index, tokens: [`Name${"abcdefgh"[index]}x`] }, host().host, resolver, 30));
	const extra = host();
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 99, tokens: ["Ability"] }, extra.host, resolver, 30);
	assert.deepEqual(extra.replies[0]!.results, [{ token: "Ability", status: "unavailable" }], "the ninth batch is refused without waiting for a deadline");
	await Promise.all(running);
	const after = host();
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 100, tokens: ["Ability"] }, after.host, resolver, 30);
	assert.equal(after.replies.length, 1, "capacity returns once batches end");
});

test("a name candidate is an exact name, its attribute form or an entry too long to tell; fuzzy neighbours are not", () => {
	assert.equal(isNameCandidate("Game", "Game"), true);
	assert.equal(isNameCandidate("Game<T>", "Game"), true);
	assert.equal(isNameCandidate("Cast(int, string)", "Cast"), true);
	assert.equal(isNameCandidate("GameAttribute", "Game"), true);
	assert.equal(isNameCandidate("GameManager", "Game"), false);
	assert.equal(isNameCandidate("game", "Game"), false);
	assert.equal(isNameCandidate(`Cast(${"x".repeat(300)})`, "Cast"), true, "oversize cannot be judged here");
});

test("a lookup writes one compact line with the counts and the verdict; a provider answer of only fuzzy entries is a miss, an empty one is unavailable", async () => {
	const lines: string[] = [];
	const answers = provider({
		Game: Object.assign([entry("Game", SymbolKind.Class, "Game.cs", 3, "WH2"), entry("Game", SymbolKind.Class, "Game.GameModes.cs", 7, "WH2")], { total: 40 }),
		Fuzzy: Object.assign([], { total: 25 }),
		Silent: [],
		Slow: "hang",
	});
	const resolver = new SymbolLinkResolver(answers.source, { log: line => lines.push(line), queryTimeoutMs: 10 });
	assert.deepEqual(await resolver.resolve(symbol("Game"), scope), { status: "found", target: "Game.cs:3:5" });
	assert.deepEqual(await resolver.resolve(symbol("Fuzzy"), scope), { status: "none" });
	assert.deepEqual(await resolver.resolve(symbol("Silent"), scope), { status: "none" }, "once the provider has answered a symbol, an empty answer is a real miss");
	assert.deepEqual(await resolver.resolve(symbol("Slow"), scope), { status: "pending" });
	assert.equal(lines.length, 4);
	assert.match(lines[0]!, /^code symbol "Game": 1 query, 40 provider entries, 2 in scope, 2 matching locations -> found \(partial\) in \d+ ms$/);
	assert.match(lines[1]!, /-> none in/);
	assert.match(lines[2]!, /0 provider entries.* -> none in/);
	assert.match(lines[3]!, /-> parked \(timeout\) in/);
});

test("a call with arguments names the method: the argument list is stripped", () => {
	assert.equal(symbol("HandleTurnBasedModeSwitched(false)").name, "HandleTurnBasedModeSwitched");
	assert.equal(symbol("Game.Spawn(unit, 3, new Vector3(1, 2, 3))").name, "Game.Spawn");
	assert.equal(symbol("Run<T>(x)").name, "Run");
});

test("until the provider has answered a symbol an empty answer parks the token; a canary probe finds the provider ready and signals a retry once", async () => {
	let loaded = false;
	const asked: string[] = [];
	const lines: string[] = [];
	let retries = 0;
	const source: SymbolSource = {
		query: text => { asked.push(text); return Promise.resolve(Object.assign(loaded ? [entry("Ability", SymbolKind.Class, "A.cs", 3)] : [], { total: loaded ? 5 : 0 })); },
	};
	const resolver = new SymbolLinkResolver(source, { probeDelaysMs: [5, 5], log: line => lines.push(line), onRetry: () => { retries++; } });
	const results = await Promise.all(["Ability", "Alpha", "Bravo"].map(name => resolver.resolve(symbol(name), scope)));
	assert.deepEqual(results, [{ status: "pending" }, { status: "pending" }, { status: "pending" }], "a loading server is not a verdict");
	assert.match(lines[0]!, /-> parked \(not ready\) in/);
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.equal(retries, 0, "still loading: the probes keep failing quietly");
	assert.ok(asked.length > 3, "canary queries were sent");
	loaded = true;
	await new Promise(resolve => setTimeout(resolve, 60));
	assert.equal(retries, 1, "ready: one signal");
	assert.match(lines.at(-1)!, /^code symbols: provider ready after \d+ s, re-running 3 parked$/);
	assert.deepEqual(await resolver.resolve(symbol("Ability"), scope), { status: "found", target: "A.cs:3:5" });
	loaded = false;
	assert.deepEqual(await resolver.resolve(symbol("Unknown"), scope), { status: "none" }, "after readiness an empty answer is a real miss");
	resolver.resetReadiness();
	assert.deepEqual(await resolver.resolve(symbol("Another"), scope), { status: "pending" }, "a changed workspace folder set loads the servers again");
});

test("a lookup that was refused or timed out because of a full queue signals a retry once the queue has drained, not before", async () => {
	const releases: (() => void)[] = [];
	let retries = 0;
	const source: SymbolSource = { query: () => new Promise(resolve => { releases.push(() => resolve(Object.assign([], { total: 3 }))); }) };
	const resolver = new SymbolLinkResolver(source, { maxConcurrent: 1, queryTimeoutMs: 15, onRetry: () => { retries++; } });
	const first = resolver.resolve(symbol("Aaa"), scope);
	const second = resolver.resolve(symbol("Bbb"), scope);
	assert.deepEqual(await Promise.all([first, second]), [{ status: "pending" }, { status: "pending" }]);
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(retries, 0, "the slow provider call still holds the slot");
	releases.splice(0).forEach(release => release());
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(retries, 1, "the queue drained");
});

test("a pending token is answered pending on the wire and is not cached", async () => {
	const { source } = provider({});
	const { host: h, replies } = host();
	const resolver = new SymbolLinkResolver(source, { probeDelaysMs: [100000] });
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 1, tokens: ["Ability"] }, h, resolver);
	assert.deepEqual(replies[0]!.results, [{ token: "Ability", status: "pending" }]);
});

test("an ambiguous symbol is answered with its number of different definitions, partial parts and overloads counted once, and is cached like a found one", async () => {
	let now = 0;
	const answers = provider({ Unit: [entry("Unit", SymbolKind.Class, "Unit.cs", 5, "One"), entry("Unit", SymbolKind.Class, "Unit.Combat.cs", 9, "One"), entry("Unit", SymbolKind.Class, "B.cs", 2, "Two"), entry("Unit", SymbolKind.Class, "C.cs", 2, "Three")] });
	const resolver = new SymbolLinkResolver(answers.source, { now: () => now, foundTtlMs: 100, noneTtlMs: 10 });
	assert.deepEqual(await resolver.resolve(symbol("Unit"), scope), { status: "ambiguous", definitions: 3 });
	now += 50;
	await resolver.resolve(symbol("Unit"), scope);
	assert.equal(answers.asked.length, 1, "kept as long as a found answer");
	const { host: h, replies } = host();
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 3, tokens: ["Unit"] }, h, resolver);
	assert.deepEqual(replies[0]!.results, [{ token: "Unit", status: "ambiguous", definitions: 3 }]);
});
