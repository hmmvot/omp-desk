import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCodeSymbol } from "../shared/code-symbols.ts";
import type { SymbolLinksResolution } from "../shared/code-symbols.ts";
import { recordingLogger, type LoggedLine } from "../shared/logger.ts";
import { SymbolKind, SymbolLinkResolver, handleSymbolLinks, hierarchyNode, inheritedLocations, isNameCandidate, matchSymbol, symbolEntry, symbolRoots, symbolTarget } from "./symbol-links.ts";
import { isInside } from "./link-scope.ts";
import { FileNameLinkResolver } from "./file-name-links.ts";
import type { HierarchyNode, HierarchyType, SymbolEntry, SymbolSource, TypeHierarchySource } from "./symbol-links.ts";

const CWD = "D:\\Work\\omp-vscode";
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
	const entries = [entry("Session", SymbolKind.Class, "A.cs", 3), entry("SessionData", SymbolKind.Class, "B.cs"), entry("session", SymbolKind.Class, "C.cs")];
	assert.equal(unique("Session", entries), "A.cs:3");
	assert.equal(unique("Sessio", entries), "none");
	assert.equal(unique("Session", [entry("Session<T>", SymbolKind.Class, "G.cs", 7)]), "G.cs:7");
	assert.equal(unique("Load()", [entry("Load(Store store, int n)", SymbolKind.Method, "M.cs", 9, "SessionData")]), "M.cs:9");
	assert.equal(unique("Load", [entry("cast", SymbolKind.Method, "M.cs")]), "none", "case matters");
});

test("a dotted name needs its preceding segments to end the entry's container; a container-less entry never matches", () => {
	const cast = (container: string, file = "M.cs") => entry("Load", SymbolKind.Method, file, 20, container);
	assert.equal(unique("SessionData.Load", [cast("SessionData")]), "M.cs:20");
	assert.equal(unique("SessionData.Load", [cast("OmpDesk.Sessions.SessionData")]), "M.cs:20", "a qualified container ends with the segment");
	assert.equal(unique("SessionData.Load", [cast("OmpDesk.Sessions.SessionData<T>")]), "M.cs:20", "generic arguments of the container are ignored");
	assert.equal(unique("Sessions.SessionData.Load", [cast("OmpDesk.Sessions.SessionData")]), "M.cs:20");
	assert.equal(unique("Other.SessionData.Load", [cast("OmpDesk.Sessions.SessionData")]), "none");
	assert.equal(unique("SessionData.Load", [cast("OtherData")]), "none");
	assert.equal(unique("SessionData.Load", [cast("")]), "none");
	assert.equal(unique("Data.Load", [cast("SessionData")]), "none", "a segment is compared whole, not as a suffix of text");
	assert.equal(unique("SessionData.Load", [cast("SessionData", "A.cs"), cast("Other.SessionData", "B.cs")]), "ambiguous", "two classes of one name each hold the member");
	assert.equal(unique("OmpDesk.SessionData", [entry("SessionData", SymbolKind.Class, "A.cs", 4, "OmpDesk")]), "A.cs:4", "a qualified type matches through its namespace");
	assert.equal(unique("Color.Red", [entry("Red", SymbolKind.EnumMember, "C.cs", 2, "Color")]), "C.cs:2");
});

/**
 * Entries shaped exactly like the C# language server's workspace/symbol answers (Microsoft.CodeAnalysis.LanguageServer
 * of ms-dotnettools.csharp 2.160.4; raw captures in .omp/workspace/tmp/symprobe/raw-en.txt and raw-ru.txt), kinds
 * as vscode.SymbolKind. The container is a localized display text, never a namespace: `in SessionIndex (project Probe (net8.0))`.
 */
const roslyn = (name: string, kind: number, file: string, line: number, container: string) => entry(name, kind, file, line, container);
const IN = (type: string, project = "Probe (net8.0)") => `in ${type} (project ${project})`;
const TOP = "project Probe (net8.0)";

test("a C# member links through the Roslyn container text `in Type (project P (tfm))`", () => {
	const overloads = [
		roslyn("Reload", SymbolKind.Method, "SessionIndex.cs", 8, IN("SessionIndex")),
		roslyn("Reload", SymbolKind.Method, "SessionIndex.cs", 9, IN("SessionIndex")),
	];
	assert.equal(unique("SessionIndex.Reload", overloads), "SessionIndex.cs:8", "overloads of one member in one type are one definition");
	assert.equal(unique("SessionIndex.Reload()", overloads), "SessionIndex.cs:8");
	assert.equal(unique("Reload", overloads), "SessionIndex.cs:8");
	assert.equal(unique("SessionIndex.Reload", [...overloads, roslyn("Reload", SymbolKind.Method, "Other.cs", 3, IN("Other"))]), "SessionIndex.cs:8", "a member of another type is no rival of the qualified name");
	assert.equal(unique("Reload", [...overloads, roslyn("Reload", SymbolKind.Method, "Other.cs", 3, IN("Other"))]), "ambiguous");
	assert.equal(unique("Other.Reload", overloads), "none", "the qualifier must be the member's own type");
	assert.equal(unique("SessionIndex.Reload", [roslyn("Reload", SymbolKind.Method, "Other.cs", 3, IN("SessionIndex", "Elsewhere (net8.0)")), ...overloads]), "ambiguous", "same-named types of two projects are two symbols");
});

test("a Roslyn container in another display language is read the same way", () => {
	const ru = (type: string) => `в ${type} (проект Probe (net8.0))`;
	const overloads = [
		roslyn("Reload", SymbolKind.Method, "SessionIndex.cs", 8, ru("SessionIndex")),
		roslyn("Reload", SymbolKind.Method, "SessionIndex.cs", 9, ru("SessionIndex")),
	];
	assert.equal(unique("SessionIndex.Reload", overloads), "SessionIndex.cs:8");
	assert.equal(unique("Other.Reload", overloads), "none");
	const ja = roslyn("Run", SymbolKind.Method, "G.cs", 2, "GlobalThing 内 (プロジェクト Probe (net8.0))");
	assert.equal(unique("GlobalThing.Run", [ja]), "G.cs:2", "the localized word may follow the type");
});

test("Class.Property, Class.Field, Enum.Member, nested and generic containers", () => {
	const counter = roslyn("Counter", SymbolKind.Property, "SessionIndex.cs", 7, IN("SessionIndex"));
	assert.equal(unique("SessionIndex.Counter", [counter]), "SessionIndex.cs:7");
	assert.equal(unique("SessionIndex.Counter", [counter, roslyn("Counter", SymbolKind.Property, "Other.cs", 2, IN("Other"))]), "SessionIndex.cs:7");
	assert.equal(unique("Mode.One", [roslyn("One", SymbolKind.EnumMember, "G.cs", 4, IN("Mode"))]), "G.cs:4");
	assert.equal(unique("GlobalThing.Value", [roslyn("Value", SymbolKind.Field, "G.cs", 1, IN("GlobalThing"))]), "G.cs:1");
	const member = roslyn("Member", SymbolKind.Method, "SessionIndex.cs", 16, IN("Outer.Inner"));
	assert.equal(unique("Outer.Inner.Member", [member]), "SessionIndex.cs:16");
	assert.equal(unique("Inner.Member", [member]), "SessionIndex.cs:16", "the nearest enclosing type is enough");
	assert.equal(unique("Outer.Member", [member]), "none", "Outer does not directly hold Member");
	assert.equal(unique("Inner.Prop", [roslyn("Prop", SymbolKind.Property, "SessionIndex.cs", 17, IN("Outer.Inner"))]), "SessionIndex.cs:17");
	const put = roslyn("Put", SymbolKind.Method, "SessionIndex.cs", 22, IN("Box<T>"));
	assert.equal(unique("Box.Put", [put]), "SessionIndex.cs:22", "the container's type parameters are ignored");
	assert.equal(unique("Box<T>.Put", [put]), "SessionIndex.cs:22");
	const fill = roslyn("Fill", SymbolKind.Method, "SessionIndex.cs", 23, IN("Box<T>.Slot<U>"));
	assert.equal(unique("Slot.Fill", [fill]), "SessionIndex.cs:23");
	assert.equal(unique("Box.Slot.Fill", [fill]), "SessionIndex.cs:23");
	assert.equal(unique("Box.Fill", [fill]), "none");
	assert.equal(unique("Dict.Add", [roslyn("Add", SymbolKind.Method, "D.cs", 5, IN("Dict<K, V>"))]), "D.cs:5", "a space inside the type arguments does not split the container");
	assert.equal(unique("Entry.Key", [roslyn("Key", SymbolKind.Property, "D.cs", 6, IN("Dict<K, V>.Entry"))]), "D.cs:6");
});

test("a Roslyn type, partial type and delegate still link; the project, file and `in` words are not qualifiers", () => {
	assert.equal(unique("SessionIndex", [roslyn("Uuid", SymbolKind.Struct, "SessionIndex.cs", 4, TOP), roslyn("SessionIndex", SymbolKind.Class, "SessionIndex.cs", 5, TOP)]), "SessionIndex.cs:5");
	assert.equal(unique("Probe.SessionIndex", [roslyn("SessionIndex", SymbolKind.Class, "SessionIndex.cs", 5, TOP)]), "none", "the project is not the type's container");
	assert.equal(unique("Parted", [roslyn("Parted", SymbolKind.Class, "Global.cs", 2, "Global.cs - Probe (net8.0)"), roslyn("Parted", SymbolKind.Class, "Global.cs", 3, "Global.cs - Probe (net8.0)")]), "Global.cs:2", "parts of one partial type in one file");
	assert.equal(unique("Split.Nest", [roslyn("Nest", SymbolKind.Class, "PartB.cs", 3, "in Split (PartB.cs - Probe (net8.0))")]), "PartB.cs:3", "a nested type of a partial type");
	assert.equal(unique("Deep", [roslyn("Deep", SymbolKind.Method, "PartA.cs", 3, IN("Split.Nest"))]), "PartA.cs:3");
	const handler = roslyn("Handler", SymbolKind.Function, "G.cs", 6, "in  (project Probe (net8.0))");
	assert.equal(unique("Handler", [handler]), "G.cs:6", "a delegate in the global scope has no type in its container");
	assert.equal(unique("OmpDesk.Handler", [handler]), "none");
	assert.equal(unique("Split.Two", [roslyn("Two", SymbolKind.Method, "PartB.cs", 3, IN("Split")), roslyn("Two", SymbolKind.Method, "PartA.cs", 9, IN("Split"))]), "PartA.cs:9", "one member name in two files of a partial type is one symbol");
});

test("a lookup of `SessionIndex.Reload` finds the member in the bare-name answer (the failing case of a real log)", async () => {
	const answer = [
		roslyn("Reload", SymbolKind.Method, "SessionIndex.cs", 73, IN("SessionIndex", "Assembly-CSharp (netstandard2.1)")),
		roslyn("Reload", SymbolKind.Method, "SessionIndex.cs", 80, IN("SessionIndex", "Assembly-CSharp (netstandard2.1)")),
	];
	const { source, asked } = provider({ Reload: answer });
	assert.deepEqual(await new SymbolLinkResolver(source).resolve(symbol("SessionIndex.Reload"), scope), { status: "found", target: "SessionIndex.cs:73:5" });
	assert.deepEqual(asked, ["Reload"]);
});

test("a bare capitalized name prefers a type over members of that name; members are accepted when no type matches", () => {
	const type = entry("Session", SymbolKind.Class, "T.cs", 1);
	const member = entry("Session", SymbolKind.Property, "P.cs", 2, "Store");
	assert.equal(unique("Session", [type, member]), "T.cs:1");
	assert.equal(unique("Session", [member]), "P.cs:2");
	assert.equal(unique("Session", [member, entry("Session", SymbolKind.Field, "F.cs", 3, "Other")]), "ambiguous");
	assert.equal(unique("Session", [type, entry("Session", SymbolKind.Class, "U.cs", 1, "Other")]), "ambiguous", "two types of one name in different containers");
	assert.equal(unique("Session", [type, entry("Session", SymbolKind.Constructor, "T.cs", 4, "Session")]), "T.cs:1", "a constructor is not a rival of its class");
	assert.equal(unique("start()", [entry("start", SymbolKind.Function, "S.ts", 8)]), "S.ts:8", "a lowercase call is a function, found without a type");
	assert.equal(unique("start()", [entry("start", SymbolKind.Function, "S.ts", 8), entry("start", SymbolKind.Method, "T.ts", 2, "Loop")]), "ambiguous");
});

test("overloads, partial classes and a duplicate report of one declaration: distinct locations are counted, one location is one definition", () => {
	assert.equal(unique("Load", [entry("Load(int)", SymbolKind.Method, "M.cs", 30, "SessionData"), entry("Load(string)", SymbolKind.Method, "M.cs", 20, "SessionData")]), "M.cs:20", "overloads of one member in one container are one symbol: the first by position");
	assert.equal(unique("Load", [entry("Load", SymbolKind.Method, "M.cs", 20, "SessionData"), entry("Load", SymbolKind.Method, "M.cs", 30, "OtherData")]), "ambiguous", "same name in two containers");
	assert.equal(unique("Load", [entry("Load", SymbolKind.Method, "M.cs", 20, "SessionData"), entry("Load", SymbolKind.Property, "M.cs", 30, "SessionData")]), "ambiguous", "a method and a property are two symbols");
	assert.equal(unique("Store", [entry("Store", SymbolKind.Class, "Store.Cache.cs", 5), entry("Store", SymbolKind.Class, "Store.cs", 9), entry("Store", SymbolKind.Class, "Store.Items.cs", 2)]), "Store.cs:9", "partial parts: the type's own file");
	assert.equal(unique("Store", [entry("Store", SymbolKind.Class, "B.cs", 5, "OmpDesk"), entry("Store", SymbolKind.Class, "A.cs", 9, "OmpDesk")]), "A.cs:9", "partial parts without an own file: the first by path");
	assert.equal(unique("Store", [entry("Store<T>", SymbolKind.Class, "U1.cs", 5), entry("Store", SymbolKind.Class, "U2.cs", 9)]), "ambiguous", "a generic and a non-generic type are two types");
	assert.equal(unique("Store", [entry("Store", SymbolKind.Class, "U1.ts", 5), entry("Store", SymbolKind.Class, "U2.ts", 9)]), "ambiguous", "outside C# a container-less type is never merged");
	assert.equal(unique("Store", [entry("Store", SymbolKind.Class, "A.cs", 5, "One"), entry("Store", SymbolKind.Class, "B.cs", 9, "Two")]), "ambiguous", "two namespaces");
	const twins = [entry("Store", SymbolKind.Class, "A.cs", 5, "One"), entry("Store", SymbolKind.Class, "sub\\B.cs", 9, "Two")];
	const near = matchSymbol(symbol("Store"), twins, `${CWD}\\sub`);
	assert.ok(near.state === "unique" && near.via === "cwd" && near.entry.path.endsWith("B.cs"), "exactly one same-named type lies inside the session folder");
	assert.equal(matchSymbol(symbol("Store"), twins, CWD).state, "ambiguous", "both lie inside it");
	assert.equal(unique("Store", [entry("Store", SymbolKind.Class, "Store.cs", 5), entry("Store", SymbolKind.Class, "store.CS", 5)]), "Store.cs:5", "the same declaration reported twice (any path case)");
});

test("attributes match the type of the name or of the name with the Attribute suffix, and nothing else", () => {
	assert.equal(unique("[Tracked]", [entry("TrackedAttribute", SymbolKind.Class, "A.cs", 3)]), "A.cs:3");
	assert.equal(unique("[Tracked]", [entry("Tracked", SymbolKind.Class, "A.cs", 3)]), "A.cs:3");
	assert.equal(unique("[Tracked]", [entry("TrackedAttribute", SymbolKind.Class, "A.cs", 3), entry("Tracked", SymbolKind.Class, "B.cs", 3)]), "ambiguous");
	assert.equal(unique("[Tracked]", [entry("Tracked", SymbolKind.Method, "A.cs", 3)]), "none", "an attribute is a type");
	assert.equal(unique("Tracked", [entry("TrackedAttribute", SymbolKind.Class, "A.cs", 3)]), "none", "without brackets the suffix is not implied");
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
	assert.equal(isInside("D:\\Work\\omp-vscode", "D:\\Work\\omp-vscode\\src\\a.ts"), true);
	assert.equal(isInside("D:\\Work\\omp-vscode", "d:/work/omp-vscode/src/a.ts"), true, "case and separators");
	assert.equal(isInside("D:\\Work\\omp-vscode", "D:\\Work\\omp-vscode"), true);
	assert.equal(isInside("D:\\Work\\omp-vscode", "D:\\Work\\omp-vscode2\\a.ts"), false, "a sibling that shares a prefix");
	assert.equal(isInside("D:\\Work\\omp-vscode", "D:\\Work\\a.ts"), false);
	assert.equal(isInside("D:\\Work\\omp-vscode", "E:\\Work\\omp-vscode\\a.ts"), false, "another drive");
	assert.equal(isInside("D:\\Work\\omp-vscode", ""), false, "a non-file location has no path");
	assert.equal(isInside("", "D:\\x"), false);
	assert.deepEqual(symbolRoots("D:\\Work\\omp-vscode", ["D:\\Work\\omp-vscode", "D:\\Work", "D:\\Work\\omp-vscode\\Sub", "D:\\Other", "d:\\work\\OMP-VSCODE\\", "D:\\Work\\omp-vscode-other"]), ["D:\\Work\\omp-vscode", "D:\\Work", "D:\\Work\\omp-vscode\\Sub"], "the cwd, a workspace folder that contains it and one inside it (searched with its own excludes); not the cwd again, a sibling or an unrelated folder");
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
	const oversize = symbolEntry({ name: "A", kind: 4, containerName: "x".repeat(3000), location: { uri: file, range: at(1, 1) } });
	assert.deepEqual([oversize.name, oversize.kind, oversize.container, oversize.opaque], ["A", 4, "", true], "a container too long to keep is never cut into another identity: the entry stays named and is opaque");
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
		Session: [entry("Session", SymbolKind.Class, "A.cs", 3), entry("SessionData", SymbolKind.Class, "D.cs")],
		Twin: [entry("Twin", SymbolKind.Class, "A.ts"), entry("Twin", SymbolKind.Class, "B.ts")],
		Lib: [{ name: "Lib", kind: SymbolKind.Class, container: "", path: "C:\\Other\\Lib.cs", line: 1, column: 1 }, { name: "Lib", kind: SymbolKind.Class, container: "", path: "", line: 0, column: 0 }],
		Unknown: [entry("UnknownThing", SymbolKind.Class, "U.cs")],
	});
	const resolver = new SymbolLinkResolver(source);
	assert.deepEqual(await resolver.resolve(symbol("Session"), scope), { status: "found", target: "A.cs:3:5" });
	assert.deepEqual(await resolver.resolve(symbol("Twin"), scope), { status: "ambiguous", definitions: 2 }, "several definitions: a link to the symbol search, never to one of them");
	assert.deepEqual(await resolver.resolve(symbol("Lib"), scope), { status: "none" });
	assert.deepEqual(await resolver.resolve(symbol("Unknown"), scope), { status: "none" });
});

test("a dotted name asks for its last segment, and only when that finds nothing for the full dotted text", async () => {
	const cast = entry("Load", SymbolKind.Method, "M.cs", 20, "SessionData");
	const byLast = provider({ Load: [cast, entry("Load", SymbolKind.Method, "N.cs", 4, "Other")] });
	assert.deepEqual(await new SymbolLinkResolver(byLast.source).resolve(symbol("SessionData.Load()"), scope), { status: "found", target: "M.cs:20:5" });
	assert.deepEqual(byLast.asked, ["Load"]);
	const qualified = provider({ Load: [entry("Load", SymbolKind.Method, "N.cs", 4, "Other")], "SessionData.Load": [cast] });
	assert.deepEqual(await new SymbolLinkResolver(qualified.source).resolve(symbol("SessionData.Load"), scope), { status: "found", target: "M.cs:20:5" });
	assert.deepEqual(qualified.asked, ["Load", "SessionData.Load"], "a second, qualified question only after the plain one found nothing");
	const ambiguous = provider({ Load: [cast, entry("Load", SymbolKind.Method, "N.cs", 4, "Other.SessionData")] });
	assert.deepEqual(await new SymbolLinkResolver(ambiguous.source).resolve(symbol("SessionData.Load"), scope), { status: "ambiguous", definitions: 2 });
	assert.deepEqual(ambiguous.asked, ["Load"], "an ambiguous answer is final");
});

test("an empty answer, an error and a timeout are unavailable, never cached; a real answer is cached with its own lifetime", async () => {
	let now = 1_000;
	const empty = provider({});
	const resolver = new SymbolLinkResolver(empty.source, { now: () => now, foundTtlMs: 100, noneTtlMs: 40 });
	assert.deepEqual(await resolver.resolve(symbol("Session"), scope), { status: "pending" }, "an empty answer before the provider ever answered is not a verdict");
	assert.deepEqual(await resolver.resolve(symbol("Session"), scope), { status: "pending" });
	assert.deepEqual(empty.asked, ["Session", "Session"], "a pending token is asked again, never cached");
	const thrown = provider({ Session: "throw" });
	assert.deepEqual(await new SymbolLinkResolver(thrown.source).resolve(symbol("Session"), scope), { status: "unavailable" });
	const hung = provider({ Session: "hang" });
	assert.deepEqual(await new SymbolLinkResolver(hung.source, { queryTimeoutMs: 10 }).resolve(symbol("Session"), scope), { status: "pending" });

	const answers = provider({ Session: [entry("Session", SymbolKind.Class, "A.cs", 3)], Nope: [entry("Other", SymbolKind.Class, "O.cs")] });
	const cached = new SymbolLinkResolver(answers.source, { now: () => now, foundTtlMs: 100, noneTtlMs: 40 });
	await cached.resolve(symbol("Session"), scope); await cached.resolve(symbol("Nope"), scope);
	await cached.resolve(symbol("Session"), scope); await cached.resolve(symbol("Nope"), scope);
	assert.deepEqual(answers.asked, ["Session", "Nope"], "within the lifetime, answers come from the cache");
	now += 50;
	await cached.resolve(symbol("Session"), scope); await cached.resolve(symbol("Nope"), scope);
	assert.deepEqual(answers.asked, ["Session", "Nope", "Nope"], "a none expires first");
	now += 100;
	await cached.resolve(symbol("Session"), scope);
	assert.deepEqual(answers.asked.at(-1), "Session");
	assert.equal(answers.asked.length, 4);
});

test("the cache is per session folder and per spelling that changes matching, and one question in flight is shared", async () => {
	const answers = provider({ Tracked: [entry("TrackedAttribute", SymbolKind.Class, "A.cs", 3)] });
	const resolver = new SymbolLinkResolver(answers.source);
	assert.deepEqual(await resolver.resolve(symbol("Tracked"), scope), { status: "none" });
	assert.deepEqual(await resolver.resolve(symbol("[Tracked]"), scope), { status: "found", target: "A.cs:3:5" }, "an attribute is not served the plain name's answer");
	const other = { cwd: "D:\\Work\\Other", roots: ["D:\\Work\\Other"] };
	assert.deepEqual(await resolver.resolve(symbol("[Tracked]"), other), { status: "none" }, "another session folder has its own answer");
	const both = await Promise.all([resolver.resolve(symbol("Tracked()"), scope), resolver.resolve(symbol("Tracked<T>"), scope)]);
	assert.deepEqual(both, [{ status: "none" }, { status: "none" }]);
});

test("invalidation drops cached answers and fences lookups that were running: they wait (pending) and cache nothing", async () => {
	const release: (() => void)[] = [];
	let version = 1;
	const asked: string[] = [];
	const source: SymbolSource = {
		query: text => new Promise(resolve => { asked.push(text); release.push(() => resolve([entry("Session", SymbolKind.Class, version === 1 ? "Old.cs" : "New.cs", 3)])); }),
	};
	const resolver = new SymbolLinkResolver(source);
	const stale = resolver.resolve(symbol("Session"), scope);
	await tick();
	version = 2;
	resolver.invalidate();
	const fresh = resolver.resolve(symbol("Session"), scope);
	await tick();
	assert.equal(asked.length, 2, "a new generation never joins the old lookup");
	release[0]!(); release[1]!();
	assert.deepEqual(await stale, { status: "pending" }, "the old answer is not delivered, and is no failure either");
	assert.deepEqual(await fresh, { status: "found", target: "New.cs:3:5" });
	await resolver.resolve(symbol("Session"), scope);
	assert.equal(asked.length, 2, "the fresh answer was cached, the stale one did not replace it");
	resolver.invalidate();
	const again = resolver.resolve(symbol("Session"), scope);
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
	const { source } = provider({ Session: [entry("Session", SymbolKind.Class, "A.cs", 3)] });
	const { host: h, replies } = host();
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 7, tokens: ["Session", "two words", "Session()", "Missing"] }, h, new SymbolLinkResolver(source));
	assert.deepEqual(replies, [{
		type: "omp:terminal-link-symbol-resolution", requestId: 7,
		results: [
			{ token: "Session", status: "found", target: "A.cs:3:5" },
			{ token: "two words", status: "none" },
			{ token: "Session()", status: "found", target: "A.cs:3:5" },
			{ token: "Missing", status: "none" },
		],
	}]);
});

test("a bare file name token is answered from the file lookup; a token that is also a symbol is a symbol only when no file has that name, and an uncertain file lookup stays unanswered", async () => {
	const find = async (name: string) => name === "Loader.cs" ? { paths: [`${CWD}\\Assets\\Loader.cs`], truncated: false }
		: name === "Dup.cs" ? { paths: [`${CWD}\\A\\Dup.cs`, `${CWD}\\B\\Dup.cs`], truncated: false }
		: name === "twin.run" ? { paths: [], truncated: false }
		: name === "Broken.cs" ? null : { paths: [], truncated: false };
	const { source, asked } = provider({ run: [entry("run", SymbolKind.Method, "T.ts", 4, "twin")], "Loader.cs": [entry("Loader", SymbolKind.Class, "X.cs", 1)] });
	const { host: h, replies } = host();
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 9, tokens: ["Loader.cs:849", "Dup.cs(12,3)", "twin.run", "Broken.cs", "Gone.cs"] }, h, new SymbolLinkResolver(source, { files: new FileNameLinkResolver({ find }, { isFile: async () => false }) }));
	assert.deepEqual(replies[0]!.results, [
		{ token: "Loader.cs:849", status: "found", target: "Assets/Loader.cs:849" },
		{ token: "Dup.cs(12,3)", status: "ambiguous", definitions: 2, files: true },
		{ token: "twin.run", status: "found", target: "T.ts:4:5" },
		{ token: "Broken.cs", status: "unavailable" },
		{ token: "Gone.cs", status: "none" },
	]);
	assert.deepEqual(asked, ["run"], "no symbol is asked for a file name that matched or could not be searched");
});

test("without a file search a bare file name is just a symbol candidate or nothing, and an invalidation reaches the file lookups and the batch's fence", async () => {
	const { host: h, replies } = host();
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 1, tokens: ["Loader.cs:849"] }, h, new SymbolLinkResolver(provider({}).source));
	assert.deepEqual(replies[0]!.results, [{ token: "Loader.cs:849", status: "none" }]);
	let version = 1;
	const files = new FileNameLinkResolver({ find: async () => ({ paths: version === 1 ? [`${CWD}\\Old\\Loader.cs`] : [`${CWD}\\New\\Loader.cs`], truncated: false }) }, { isFile: async () => false });
	const resolver = new SymbolLinkResolver(provider({}).source, { files });
	assert.deepEqual(await resolver.resolveFileName({ name: "Loader.cs" }, scope), { status: "found", target: "Old/Loader.cs" });
	version = 2;
	assert.deepEqual(await resolver.resolveFileName({ name: "Loader.cs" }, scope), { status: "found", target: "Old/Loader.cs" }, "cached");
	resolver.invalidate();
	assert.deepEqual(await resolver.resolveFileName({ name: "Loader.cs" }, scope), { status: "found", target: "New/Loader.cs" }, "invalidate() forgets the file answers too");
	const moved = host();
	const second = new SymbolLinkResolver(provider({}).source, { files: new FileNameLinkResolver({ find: async () => { second.invalidate(); return { paths: [`${CWD}\\Old\\Loader.cs`], truncated: false }; } }, { isFile: async () => false }) });
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 2, tokens: ["Loader.cs"] }, moved.host, second);
	assert.deepEqual(moved.replies[0]!.results, [{ token: "Loader.cs", status: "pending" }], "files changed while the search ran: nothing stale is delivered, and the token waits for the signal");
});

test("a path tail token (`host/session-index.ts:579`) is answered from the file lookup like a bare name, and several files are a choice", async () => {
	const find = async (name: string) => name === "host/session-index.ts" ? { paths: [`${CWD}\\omp-vscode\\src\\host\\session-index.ts`], truncated: false }
		: name === "Dup/Settings.cs" ? { paths: [`${CWD}\\A\\Dup\\Settings.cs`, `${CWD}\\B\\Dup\\Settings.cs`], truncated: false }
		: { paths: [], truncated: false };
	const { host: h, replies } = host();
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 3, tokens: ["host/session-index.ts:579", "Dup\\Settings.cs(4)", "Nope/Missing.cs:1", "./session-index.ts"] }, h, new SymbolLinkResolver(provider({}).source, { files: new FileNameLinkResolver({ find }, { isFile: async () => false }) }));
	assert.deepEqual(replies[0]!.results, [
		{ token: "host/session-index.ts:579", status: "found", target: "omp-vscode/src/host/session-index.ts:579" },
		{ token: "Dup\\Settings.cs(4)", status: "ambiguous", definitions: 2, files: true },
		{ token: "Nope/Missing.cs:1", status: "none" },
		{ token: "./session-index.ts", status: "none" },
	]);
});

test("a busy repository does not leave file names plain: a file lookup under way survives changes of contents and of the set of files, while symbol answers are still dropped", async () => {
	const existing = new Set([`${CWD}\\Assets\\Loader.cs`]);
	const search = Promise.withResolvers<{ paths: string[]; truncated: boolean }>();
	const files = new FileNameLinkResolver({ find: () => search.promise }, { isFile: async candidate => existing.has(candidate) });
	const resolver = new SymbolLinkResolver(provider({ Session: [entry("Session", SymbolKind.Class, "A.cs", 3)] }).source, { files });
	const { host: h, replies } = host();
	const batch = handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 5, tokens: ["Loader.cs:7", "Session"] }, h, resolver);
	await tick();
	resolver.invalidateContent();
	assert.equal(resolver.fileGeneration, 0, "a changed file's contents never move the file lookups' generation");
	resolver.invalidate();
	assert.equal(resolver.fileGeneration, 1, "a created, deleted or renamed file does");
	search.resolve({ paths: [`${CWD}\\Assets\\Loader.cs`], truncated: false });
	await batch;
	assert.deepEqual(replies[0]!.results, [
		{ token: "Loader.cs:7", status: "found", target: "Assets/Loader.cs:7" },
		{ token: "Session", status: "pending" },
	]);
	let searches = 0;
	const cached = new SymbolLinkResolver(provider({}).source, { files: new FileNameLinkResolver({ find: async () => { searches++; return { paths: [`${CWD}\\Assets\\Loader.cs`], truncated: false }; } }, { isFile: async () => false }) });
	assert.deepEqual(await cached.resolveFileName({ name: "Loader.cs" }, scope), { status: "found", target: "Assets/Loader.cs" });
	cached.invalidateContent();
	assert.deepEqual(await cached.resolveFileName({ name: "Loader.cs" }, scope), { status: "found", target: "Assets/Loader.cs" });
	assert.equal(searches, 1, "a change of contents keeps the file-name answers");
});

test("with the setting off the host answers none and disabled, and nothing is asked of any provider", async () => {
	const { source, asked } = provider({ Session: [entry("Session", SymbolKind.Class, "A.cs")] });
	const { host: h, replies } = host({ enabled: () => false });
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 1, tokens: ["Session"] }, h, new SymbolLinkResolver(source));
	assert.deepEqual(replies, [{ type: "omp:terminal-link-symbol-resolution", requestId: 1, disabled: true, results: [{ token: "Session", status: "none" }] }]);
	assert.deepEqual(asked, []);
});

test("a setting turned off, a folder set that changed, or a replaced document while the provider worked revokes the answer", async () => {
	const answers = { Session: [entry("Session", SymbolKind.Class, "A.cs", 3)] };
	const request = { type: "omp:terminal-link-symbols" as const, requestId: 2, tokens: ["Session"] };
	let enabled = true;
	const disabledMidway = host({ enabled: () => enabled });
	const midway: SymbolSource = { query: async () => { enabled = false; return answers.Session; } };
	await handleSymbolLinks(request, disabledMidway.host, new SymbolLinkResolver(midway));
	assert.deepEqual(disabledMidway.replies, [{ type: "omp:terminal-link-symbol-resolution", requestId: 2, disabled: true, results: [{ token: "Session", status: "none" }] }]);

	let roots = [CWD];
	const moved = host({ roots: () => roots });
	await handleSymbolLinks(request, moved.host, new SymbolLinkResolver({ query: async () => { roots = []; return answers.Session; } }));
	assert.deepEqual(moved.replies, [{ type: "omp:terminal-link-symbol-resolution", requestId: 2, results: [{ token: "Session", status: "pending" }] }]);

	let current = true;
	const replaced = host({ isCurrent: () => current });
	await handleSymbolLinks(request, replaced.host, new SymbolLinkResolver({ query: async () => { current = false; return answers.Session; } }));
	assert.deepEqual(replaced.replies, [], "a replaced document is answered with nothing");
});

test("a batch is answered at its deadline with what has settled, and the rest stays pending: it was not answered, so it is no try", async () => {
	const answers: Record<string, SymbolEntry[] | "hang"> = { Session: [entry("Session", SymbolKind.Class, "A.cs", 3)], Slow: "hang" };
	const { source } = provider(answers);
	const { host: h, replies } = host();
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 3, tokens: ["Slow", "Session"] }, h, new SymbolLinkResolver(source, { queryTimeoutMs: 1000 }), 20);
	assert.deepEqual(replies[0]!.results, [{ token: "Slow", status: "pending" }, { token: "Session", status: "found", target: "A.cs:3:5" }]);
});

test("a locally truncated answer never makes a unique match; a failed qualified query is unavailable, not a miss", async () => {
	const filler = (count: number) => Array.from({ length: count }, (_, index) => entry(`Other${index}`, SymbolKind.Class, `F${index}.cs`));
	const cut = provider({ Session: [entry("Session", SymbolKind.Class, "A.cs", 3), ...filler(1000), entry("Session", SymbolKind.Class, "B.cs", 4)] });
	assert.deepEqual(await new SymbolLinkResolver(cut.source).resolve(symbol("Session"), scope), { status: "unavailable" }, "the second declaration lies beyond what Desk looks at");
	const cutAmbiguous = provider({ Twin: [entry("Twin", SymbolKind.Class, "A.ts"), entry("Twin", SymbolKind.Class, "B.ts"), ...filler(1000)] });
	assert.deepEqual(await new SymbolLinkResolver(cutAmbiguous.source).resolve(symbol("Twin"), scope), { status: "ambiguous", definitions: 2 }, "an ambiguity inside the examined prefix still holds");
	const exact = provider({ Session: [entry("Session", SymbolKind.Class, "A.cs", 3), ...filler(999)] });
	assert.deepEqual(await new SymbolLinkResolver(exact.source).resolve(symbol("Session"), scope), { status: "found", target: "A.cs:3:5" }, "exactly the bound is not a cut");

	const unrelated = [entry("Load", SymbolKind.Method, "N.cs", 4, "Other")];
	for (const failure of ["throw", "hang"] as const) {
		const failing = provider({ Load: unrelated, "SessionData.Load": failure });
		assert.deepEqual(await new SymbolLinkResolver(failing.source, { queryTimeoutMs: 10 }).resolve(symbol("SessionData.Load"), scope), { status: failure === "hang" ? "pending" : "unavailable" }, failure);
	}
	const completed = provider({ Load: unrelated, "SessionData.Load": [] });
	assert.deepEqual(await new SymbolLinkResolver(completed.source).resolve(symbol("SessionData.Load"), scope), { status: "none" }, "a qualified query that completed and found nothing is a miss");
});

test("declarations without a position are one symbol when they are overloads in one container, and the positioned one is opened", () => {
	const bare = (name: string, file: string, container = "SessionData") => entry(name, SymbolKind.Method, file, 0, container, 0);
	assert.equal(unique("Load", [bare("Load(int)", "M.cs"), bare("Load(string)", "M.cs")]), "M.cs:0", "two unresolved overloads in one file open the file");
	assert.equal(unique("Load", [bare("Load(int)", "M.cs"), entry("Load(string)", SymbolKind.Method, "M.cs", 30, "SessionData")]), "M.cs:30", "unresolved beside resolved: the resolved one");
	assert.equal(unique("Load", [bare("Load(int)", "M.cs"), bare("Load(int)", "M.cs", "OtherData")]), "ambiguous", "unresolved in two containers");
	assert.equal(unique("Load", [bare("Load", "M.cs")]), "M.cs:0", "one unresolved declaration opens its file");
});

test("a path component that merely starts with dots is inside the folder; a real parent traversal is not", () => {
	assert.equal(isInside("D:\\Work\\omp-vscode", "D:\\Work\\omp-vscode\\..helpers\\a.ts"), true);
	assert.equal(isInside("D:\\Work\\omp-vscode", "D:\\Work\\omp-vscode\\..\\a.ts"), false);
});

test("a lookup that waits for a slot is dropped by an invalidation instead of reaching the provider, and a batch holds back answers a file change made stale", async () => {
	const asked: string[] = [];
	const releases: (() => void)[] = [];
	const source: SymbolSource = { query: text => { asked.push(text); return new Promise(resolve => { releases.push(() => resolve([entry(text, SymbolKind.Class, `${text}.cs`, 2)])); }); } };
	const resolver = new SymbolLinkResolver(source, { maxConcurrent: 1, queryTimeoutMs: 1000 });
	const running = resolver.resolve(symbol("Aaa"), scope);
	const waiting = resolver.resolve(symbol("Bbb"), scope);
	await tick();
	resolver.invalidate();
	releases.splice(0).forEach(release => release());
	assert.deepEqual(await Promise.all([running, waiting]), [{ status: "pending" }, { status: "pending" }]);
	assert.deepEqual(asked, ["Aaa"], "the waiting lookup never reached the provider");

	const fast = entry("Session", SymbolKind.Class, "A.cs", 3);
	let slow: (() => void) | undefined;
	const batchResolver = new SymbolLinkResolver({ query: text => text === "Session" ? Promise.resolve([fast]) : new Promise(resolve => { slow = () => resolve([]); }) });
	const { host: h, replies } = host();
	const batch = handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 9, tokens: ["Session", "Slowpoke"] }, h, batchResolver);
	await tick();
	batchResolver.invalidate();
	slow?.();
	await batch;
	assert.deepEqual(replies[0]!.results, [{ token: "Session", status: "pending" }, { token: "Slowpoke", status: "pending" }]);
});

/**
 * Entries as the C# language server answers `workspace/symbol` for a project with an incremental source generator (captured 2026-10-19
 * from ms-dotnettools.csharp 2.160.4's Microsoft.CodeAnalysis.LanguageServer over stdio, a scratch project with a generator that emits a
 * second part of a partial type and a formatter class with generic nested types; `kind` is the LSP number, one more than `vscode.SymbolKind`,
 * line and character are zero-based). What the capture showed, and the fixtures keep:
 * - a name is always the bare name (`SessionService` for `SessionService<T>` too; no parameter list, no type arguments);
 * - a partial type's container is the file of its part, `Session.cs - OmpDesk (net10.0)`; a non-partial top-level type's is `project OmpDesk (net10.0)`;
 * - a member's container is `in Type (project OmpDesk (net10.0))`, and the type's own text carries its type parameters, so a member of a
 *   nested generic type had a container of about 725 characters with one 40-parameter level and 1121 with two (the adapter once allowed 512);
 * - a declaration in a file on disk has a `file:` URI; one the compiler generates only in memory (no file on disk) has a
 *   `roslyn-source-generated://` URI, which has no path here and so is never in the session's folders.
 */
const lsp = (name: string, kind: number, container: string, file: string, line: number, character: number, uri = `file:///${CWD.replaceAll("\\", "/")}/${file}`) =>
	symbolEntry({ name, kind: kind - 1, containerName: container, location: { uri: { scheme: uri.slice(0, uri.indexOf(":")), fsPath: uri.startsWith("file:") ? `${CWD}\\${file}` : uri }, range: { start: { line, character }, end: { line, character: character + name.length } } } });
const PROJECT = "OmpDesk (net10.0)";
const typeParameters = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(", ");
const SLOT = `SessionServiceFormatter.Slot<${typeParameters("TBufferWriter", 40)}>`;
const INNER = `${SLOT}.Inner<${typeParameters("TInner", 40)}>`;
const PART = "SessionService.Generated.g.cs";
const FORMATTER = "SessionService.SessionServiceFormatter.g.cs";
const CAPTURED: Record<string, SymbolEntry[]> = {
	SessionService: [
		lsp("SessionService", 5, `${PART} - ${PROJECT}`, PART, 2, 14),
		lsp("SessionService", 5, `Session.cs - ${PROJECT}`, "Session.cs", 9, 21),
		lsp("SessionService", 5, `Session.cs - ${PROJECT}`, "Session.cs", 15, 21),
	],
	Dispose: [
		lsp("Dispose", 6, `in SessionService (project ${PROJECT})`, PART, 4, 16),
		lsp("Dispose", 6, `in Other (project ${PROJECT})`, "Session.cs", 22, 16),
		lsp("Dispose", 6, `in SessionServiceFormatter (project ${PROJECT})`, FORMATTER, 6, 16),
		lsp("Dispose", 6, `in ${SLOT} (project ${PROJECT})`, FORMATTER, 9, 20),
		lsp("Dispose", 6, `in ${INNER} (project ${PROJECT})`, FORMATTER, 10, 438),
		lsp("Dispose", 6, `in SessionServiceFormatter<${typeParameters("TBufferWriter", 40)}> (project ${PROJECT})`, FORMATTER, 13, 728),
		lsp("Dispose", 6, `in SessionService (project ${PROJECT})`, "ignored.g.cs", 5, 16, "roslyn-source-generated://5f0f6f1a-0000-4000-8000-000000000000/ignored.g.cs?hintName=ignored.g.cs&assemblyName=Gen"),
	],
	Deserialize: [lsp("Deserialize", 6, `in SessionServiceFormatter (project ${PROJECT})`, FORMATTER, 4, 23)],
	Slot: [lsp("Slot", 5, `in SessionServiceFormatter (project ${PROJECT})`, FORMATTER, 7, 24)],
	Inner: [lsp("Inner", 5, `in ${SLOT} (project ${PROJECT})`, FORMATTER, 10, 28)],
	Count: [
		lsp("Count", 7, `in SessionService (project ${PROJECT})`, "Session.cs", 11, 15),
		lsp("Count", 7, `in ${INNER} (project ${PROJECT})`, FORMATTER, 10, 463),
	],
};

test("the captured entries have the shapes the matching rules read: bare names, file-named partial containers, generic containers over 512 characters, no path for an in-memory generated file", () => {
	assert.ok(CAPTURED.Dispose![3]!.container.length > 512 && CAPTURED.Dispose![4]!.container.length > 1000, "the member containers of nested generic types are long");
	assert.equal(CAPTURED.Dispose![3]!.opaque, undefined, "a long container is kept: it is read as it is");
	assert.equal(CAPTURED.Dispose![6]!.path, "", "an in-memory generated document has no path");
	assert.deepEqual([CAPTURED.SessionService![0]!.kind, CAPTURED.Dispose![0]!.kind, CAPTURED.Count![0]!.kind], [SymbolKind.Class, SymbolKind.Method, SymbolKind.Property], "LSP kinds are converted to vscode kinds");
});

test("a type and its members in a project with generated code link as they should: a long generic container no longer poisons the lookup, and a generated part is one symbol with the others", async () => {
	const resolver = new SymbolLinkResolver(provider(CAPTURED).source);
	const found = (name: string) => resolver.resolve(symbol(name), scope);
	assert.deepEqual(await found("SessionService"), { status: "found", target: "Session.cs:10:22" }, "the parts in `Session.cs` and in the generated file are one partial type, opened at the first by path");
	assert.deepEqual(await found("SessionService.Dispose"), { status: "found", target: `${PART}:5:17` }, "the member the generated part declares; the long containers of the formatter's nested types are other types'");
	assert.deepEqual(await found("Other.Dispose"), { status: "found", target: "Session.cs:23:17" });
	assert.deepEqual(await found("Dispose"), { status: "ambiguous", definitions: 5 }, "the in-memory declaration has no path and is no rival");
	assert.deepEqual(await found("SessionServiceFormatter.Deserialize"), { status: "found", target: `${FORMATTER}:5:24` });
	assert.deepEqual(await found("Slot.Dispose"), { status: "found", target: `${FORMATTER}:10:21` }, "the member of a type with 40 type parameters");
	assert.deepEqual(await found("Inner.Count"), { status: "found", target: `${FORMATTER}:11:464` }, "the member of a type nested in it, 1122 characters of container");
});

test("a name or container beyond what the adapter keeps is cut down to what matching reads of it; a container that stays unreadable makes the entry opaque (defensive: not seen in the capture)", () => {
	const huge = `Deserialize(ref GeneratedReader reader, ${"global::System.Collections.Generic.Dictionary<string, int> map, ".repeat(6)}int tail)`;
	const signature = lsp(huge, 6, `in SessionServiceFormatter (project ${PROJECT})`, FORMATTER, 4, 23);
	assert.ok(huge.length > 256);
	assert.deepEqual([signature.name.length <= 256, signature.container, signature.opaque], [true, `in SessionServiceFormatter (project ${PROJECT})`, undefined]);
	assert.equal(unique("SessionServiceFormatter.Deserialize", [signature]), `${FORMATTER}:5`, "by its bare name it is the method `Deserialize`");
	const wide = lsp("Dispose", 6, `in SessionService<${typeParameters("TArgument", 400)}> (project ${PROJECT})`, "SessionService.cs", 8, 16);
	assert.equal(wide.container, `in SessionService (project ${PROJECT})`, "a container made over 2048 characters long by type arguments reads the same without them");
	const unreadable = lsp("Dispose", 6, `in SessionService (project ${"P".repeat(3000)} (net10.0))`, "SessionService.cs", 8, 16);
	assert.deepEqual([unreadable.name, unreadable.kind, unreadable.container, unreadable.opaque], ["Dispose", SymbolKind.Method, "", true], "a container that stays long is never cut into another container");
});

const provided = (name: string, kind: number, file: string, line: number, container: string) => symbolEntry({ name, kind, containerName: container, location: { uri: { scheme: "file", fsPath: `${CWD}\\${file}` }, range: { start: { line: line - 1, character: 4 }, end: { line: line - 1, character: 9 } } } });

test("an entry named like the symbol whose container cannot be read makes the name plain: an answer, never a wrong link and never a retry", async () => {
	const lines: LoggedLine[] = [];
	const hidden = provided("Dispose", SymbolKind.Method, "Generated\\Other.g.cs", 3, `in Formatter (project ${"P".repeat(3000)} (net8.0))`);
	assert.equal(hidden.opaque, true);
	const own = provided("Dispose", SymbolKind.Method, "SessionService.cs", 20, IN("SessionService"));
	const answers = provider({ Dispose: [own, hidden], "SessionService.Dispose": [own, hidden] });
	const resolver = new SymbolLinkResolver(answers.source, { log: recordingLogger(lines) });
	assert.deepEqual(await resolver.resolve(symbol("SessionService.Dispose"), scope), { status: "none" }, "it could be a second declaration of the member: not linked");
	assert.match(lines.find(line => line.message.includes("SessionService.Dispose"))!.message, /none \(unmatchable entry\)/);
	assert.deepEqual(await new SymbolLinkResolver(provider({ Dispose: [own, hidden] }).source).resolve(symbol("Dispose"), scope), { status: "none" });
	const rival = provided("Dispose", SymbolKind.Method, "Rival.cs", 5, IN("Rival"));
	assert.deepEqual(await new SymbolLinkResolver(provider({ Dispose: [own, rival, hidden] }).source).resolve(symbol("Dispose"), scope), { status: "ambiguous", definitions: 2 }, "an ambiguity already seen stays one");
	assert.deepEqual(await new SymbolLinkResolver(provider({ SessionService: [provided("SessionService", SymbolKind.Class, "SessionService.cs", 6, TOP), { ...hidden, name: "Other" }] }).source).resolve(symbol("SessionService"), scope), { status: "found", target: "SessionService.cs:6:5" }, "an opaque entry of another name is no rival");
	const outside = { ...hidden, path: "D:\\Elsewhere\\Other.g.cs" };
	assert.deepEqual(await new SymbolLinkResolver(provider({ Dispose: [own, outside] }).source).resolve(symbol("Dispose"), scope), { status: "found", target: "SessionService.cs:20:5" }, "an unreadable entry outside the session's folders is no rival");
});

test("the host works on a bounded number of batches at once and the rest wait for the retry signal", async () => {
	const resolver = new SymbolLinkResolver({ query: () => new Promise(() => {}) }, { queryTimeoutMs: 1000 });
	const running = Array.from({ length: 8 }, (_, index) => handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: index, tokens: [`Name${"abcdefgh"[index]}x`] }, host().host, resolver, 30));
	const extra = host();
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 99, tokens: ["Session"] }, extra.host, resolver, 30);
	assert.deepEqual(extra.replies[0]!.results, [{ token: "Session", status: "pending" }], "the ninth batch is refused without waiting for a deadline; it was not tried, so it is a wait");
	await Promise.all(running);
	const after = host();
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 100, tokens: ["Session"] }, after.host, resolver, 30);
	assert.equal(after.replies.length, 1, "capacity returns once batches end");
});

test("one batch takes only its share of the provider's slots, so batches of several pages take turns", async () => {
	const asked: string[] = [];
	const releases: (() => void)[] = [];
	const source: SymbolSource = { query: text => { asked.push(text); return new Promise(resolve => { releases.push(() => resolve(Object.assign([entry(text, SymbolKind.Class, `${text}.cs`, 2)], { total: 1 }))); }); } };
	const resolver = new SymbolLinkResolver(source, { maxConcurrent: 2, queryTimeoutMs: 1000 });
	const tokens = (prefix: string) => Array.from({ length: 6 }, (_, index) => `${prefix}Name${index}`);
	const first = handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 1, tokens: tokens("A") }, host().host, resolver);
	const second = handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 2, tokens: tokens("B") }, host().host, resolver);
	await tick();
	assert.deepEqual(asked, ["AName0", "AName1"], "the first batch asks two at a time, not all six");
	releases.splice(0).forEach(release => release());
	await tick();
	await tick();
	assert.ok(asked.slice(2, 4).some(text => text.startsWith("B")), `the second batch gets its turn before the first is done (${asked.join(", ")})`);
	for (let turn = 0; turn < 20; turn++) { releases.splice(0).forEach(release => release()); await tick(); }
	await Promise.all([first, second]);
});

test("a provider that is loading and has let a call time out is not asked more than its slots: the rest wait for the ready signal", async () => {
	const lines: LoggedLine[] = [];
	let retries = 0;
	let ready = false;
	const asked: string[] = [];
	const releases: (() => void)[] = [];
	const source: SymbolSource = { query: text => { asked.push(text); return ready ? Promise.resolve(Object.assign([entry(text, SymbolKind.Class, `${text}.cs`, 2)], { total: 1 })) : new Promise(resolve => { releases.push(() => resolve([])); }); } };
	const resolver = new SymbolLinkResolver(source, { maxConcurrent: 2, queryTimeoutMs: 10, log: recordingLogger(lines), probeDelaysMs: [5], minRetryMs: 1, onRetry: () => { retries++; } });
	assert.deepEqual(await Promise.all([resolver.resolve(symbol("Aaa"), scope), resolver.resolve(symbol("Bbb"), scope)]), [{ status: "pending" }, { status: "pending" }]);
	assert.deepEqual(await resolver.resolve(symbol("Ccc"), scope), { status: "pending" });
	assert.deepEqual(asked, ["Aaa", "Bbb"], "the third name never reached the provider or its line");
	assert.ok(lines.some(line => line.message.includes("\"Ccc\"") && line.message.includes("parked (not ready)")), "it waits as a not-ready name, which no page counts as a try");
	ready = true;
	releases.splice(0).forEach(release => release());
	for (let turn = 0; turn < 100 && retries === 0; turn++) await new Promise<void>(resolve => setTimeout(resolve, 5));
	assert.ok(retries > 0, "the provider answered: the pages are told to ask again");
});

test("the file search's drained line asks the waiting pages again, whatever the symbol provider is doing", async () => {
	let retries = 0;
	const resolver = new SymbolLinkResolver({ query: () => new Promise(() => {}) }, { minRetryMs: 1, onRetry: () => { retries++; } });
	void resolver.resolve(symbol("Hanging"), scope);
	await tick();
	resolver.filesDrained();
	for (let turn = 0; turn < 50 && retries === 0; turn++) await new Promise<void>(resolve => setTimeout(resolve, 5));
	assert.equal(retries, 1);
});

test("a name candidate is an exact name, its attribute form or the same by its bare name however long the signature; fuzzy neighbours are not", () => {
	assert.equal(isNameCandidate("Desk", "Desk"), true);
	assert.equal(isNameCandidate("Desk<T>", "Desk"), true);
	assert.equal(isNameCandidate("Load(int, string)", "Load"), true);
	assert.equal(isNameCandidate("DeskAttribute", "Desk"), true);
	assert.equal(isNameCandidate("DeskManager", "Desk"), false);
	assert.equal(isNameCandidate("desk", "Desk"), false);
	assert.equal(isNameCandidate(`Load(${"x".repeat(300)})`, "Load"), true, "a long signature is still the bare name");
	assert.equal(isNameCandidate(`Deserialize(ref GeneratedReader reader, scoped ref ${"Pair<int, string>, ".repeat(30)}value)`, "SessionService"), false, "a long signature of another name is a fuzzy neighbour that must not crowd the exact ones out");
});

test("a lookup writes one compact line with the counts and the verdict; a provider answer of only fuzzy entries is a miss, an empty one is unavailable", async () => {
	const logged: LoggedLine[] = [];
	const answers = provider({
		Desk: Object.assign([entry("Desk", SymbolKind.Class, "Desk.cs", 3, "omp-vscode"), entry("Desk", SymbolKind.Class, "Desk.DeskModes.cs", 7, "omp-vscode")], { total: 40 }),
		Fuzzy: Object.assign([], { total: 25 }),
		Silent: [],
		Slow: "hang",
	});
	const resolver = new SymbolLinkResolver(answers.source, { log: recordingLogger(logged), queryTimeoutMs: 10 });
	assert.deepEqual(await resolver.resolve(symbol("Desk"), scope), { status: "found", target: "Desk.cs:3:5" });
	assert.deepEqual(await resolver.resolve(symbol("Fuzzy"), scope), { status: "none" });
	assert.deepEqual(await resolver.resolve(symbol("Silent"), scope), { status: "none" }, "once the provider has answered a symbol, an empty answer is a real miss");
	assert.deepEqual(await resolver.resolve(symbol("Slow"), scope), { status: "pending" });
	const lines = logged.map(line => line.message);
	assert.equal(lines.length, 4);
	assert.ok(logged.every(line => line.level === "debug"), "a lookup line is a debug line");
	assert.match(lines[0]!, /^code symbol "Desk": 1 query, 40 provider entries, 2 in scope, 2 matching locations -> found \(partial\) in \d+ ms$/);
	assert.match(lines[1]!, /-> none in/);
	assert.match(lines[2]!, /0 provider entries.* -> none in/);
	assert.match(lines[3]!, /-> parked \(timeout\) in/);
});

test("a call with arguments names the method: the argument list is stripped", () => {
	assert.equal(symbol("HandleTurnBasedModeSwitched(false)").name, "HandleTurnBasedModeSwitched");
	assert.equal(symbol("Sessions.Spawn(session, 3, new Vector3(1, 2, 3))").name, "Sessions.Spawn");
	assert.equal(symbol("Run<T>(x)").name, "Run");
});

test("until the provider has answered a symbol an empty answer parks the token; a canary probe finds the provider ready and signals a retry once", async () => {
	let loaded = false;
	const asked: string[] = [];
	const logged: LoggedLine[] = [];
	let retries = 0;
	const source: SymbolSource = {
		query: text => { asked.push(text); return Promise.resolve(Object.assign(loaded ? [entry("Session", SymbolKind.Class, "A.cs", 3)] : [], { total: loaded ? 5 : 0 })); },
	};
	const resolver = new SymbolLinkResolver(source, { probeDelaysMs: [5, 5], log: recordingLogger(logged), onRetry: () => { retries++; } });
	const results = await Promise.all(["Session", "Alpha", "Bravo"].map(name => resolver.resolve(symbol(name), scope)));
	assert.deepEqual(results, [{ status: "pending" }, { status: "pending" }, { status: "pending" }], "a loading server is not a verdict");
	assert.match(logged[0]!.message, /-> parked \(not ready\) in/);
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.equal(retries, 0, "still loading: the probes keep failing quietly");
	assert.ok(asked.length > 3, "canary queries were sent");
	loaded = true;
	await new Promise(resolve => setTimeout(resolve, 60));
	assert.equal(retries, 1, "ready: one signal");
	assert.match(logged.at(-1)!.message, /^code symbols: provider ready after \d+ s, re-running 3 parked$/);
	assert.deepEqual(await resolver.resolve(symbol("Session"), scope), { status: "found", target: "A.cs:3:5" });
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
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 1, tokens: ["Session"] }, h, resolver);
	assert.deepEqual(replies[0]!.results, [{ token: "Session", status: "pending" }]);
});

test("an ambiguous symbol is answered with its number of different definitions, partial parts and overloads counted once, and is cached like a found one", async () => {
	let now = 0;
	const answers = provider({ Store: [entry("Store", SymbolKind.Class, "Store.cs", 5, "One"), entry("Store", SymbolKind.Class, "Store.Cache.cs", 9, "One"), entry("Store", SymbolKind.Class, "B.cs", 2, "Two"), entry("Store", SymbolKind.Class, "C.cs", 2, "Three")] });
	const resolver = new SymbolLinkResolver(answers.source, { now: () => now, foundTtlMs: 100, noneTtlMs: 10 });
	assert.deepEqual(await resolver.resolve(symbol("Store"), scope), { status: "ambiguous", definitions: 3 });
	now += 50;
	await resolver.resolve(symbol("Store"), scope);
	assert.equal(answers.asked.length, 1, "kept as long as a found answer");
	const { host: h, replies } = host();
	await handleSymbolLinks({ type: "omp:terminal-link-symbols", requestId: 3, tokens: ["Store"] }, h, resolver);
	assert.deepEqual(replies[0]!.results, [{ token: "Store", status: "ambiguous", definitions: 3 }]);
});

test("namespaces written before a type are dropped for a container that names only the type, never for one that carries its own namespaces, and a lower-case segment is no namespace", () => {
	assert.equal(unique("OmpDesk.Core.SessionIndex.Load", [roslyn("Load", SymbolKind.Method, "SessionIndex.cs", 20, IN("SessionIndex"))]), "SessionIndex.cs:20");
	assert.equal(unique("OmpDesk.Core.Catalog.Profile.Load", [roslyn("Load", SymbolKind.Method, "Catalog.cs", 4, IN("Catalog.Profile"))]), "Catalog.cs:4", "a nested type's container is `Outer.Inner`");
	assert.equal(unique("OmpDesk.Core.SessionIndex.Load", [entry("Load", SymbolKind.Method, "M.cs", 20, "Other.Sessions.SessionIndex")]), "none", "a provider that names namespaces contradicts a wrong one");
	assert.equal(unique("Other.SessionData.Load", [entry("Load", SymbolKind.Method, "M.cs", 20, "OmpDesk.Sessions.SessionData")]), "none");
	assert.equal(unique("core.SessionIndex.Load", [roslyn("Load", SymbolKind.Method, "SessionIndex.cs", 20, IN("SessionIndex"))]), "none", "a lower-case segment is not dropped");
	assert.equal(unique("SessionIndex.Load", [roslyn("Load", SymbolKind.Method, "SessionIndex.cs", 20, IN("SessionIndex"))]), "SessionIndex.cs:20", "the segment beside the member is always kept");
});

const at = (file: string) => `${CWD}\\${file}`;
const typeAt = (name: string, file: string, line: number, endLine: number): HierarchyType => ({ name, path: at(file), line, endLine });

test("an inherited member is the one the nearest supertype level declares, found by the container's own name and narrowed by the type's range", () => {
	const base = typeAt("RecordBase<string, Profile>", "Data.cs", 3, 8);
	const declared = roslyn("ApplyFrom(TValue)", SymbolKind.Method, "Data.cs", 5, IN("RecordBase<TValue, TSelf>"));
	const named = (...entries: SymbolEntry[]) => inheritedLocations(entries, [[typeAt("Mid", "Mid.cs", 2, 9)], [base]]).map(found => `${found.path.slice(CWD.length + 1)}:${found.line}`);
	assert.deepEqual(named(declared), ["Data.cs:5"], "two levels up");
	assert.deepEqual(named(declared, roslyn("ApplyFrom", SymbolKind.Method, "Mid.cs", 7, IN("Mid"))), ["Mid.cs:7"], "an override nearer the type shadows the base's declaration");
	assert.deepEqual(named(roslyn("ApplyFrom", SymbolKind.Method, "Other.cs", 5, IN("Unrelated"))), [], "a member of a type outside the chain is not inherited");
	assert.deepEqual(named(roslyn("ApplyFrom", SymbolKind.Method, "Data.cs", 6, IN("Inner")), declared), ["Data.cs:5"], "a nested type inside the base's range is not the base");
	const twins = [roslyn("Reset", SymbolKind.Method, "Data.cs", 6, IN("RecordBase<TValue, TSelf>")), roslyn("Reset", SymbolKind.Method, "Elsewhere.cs", 6, IN("RecordBase<TValue>"))];
	assert.deepEqual(inheritedLocations(twins, [[base]]).map(found => found.path.slice(CWD.length + 1)), ["Data.cs"], "of two types with the one name the one the hierarchy points at");
	assert.deepEqual(inheritedLocations(twins.slice(1), [[base]]).map(found => found.path.slice(CWD.length + 1)), ["Elsewhere.cs"], "a partial part in another file is still the type, by name");
	assert.deepEqual(inheritedLocations([declared], [[{ name: "RecordBase", path: "", line: 1, endLine: 9 }]]), [], "a type outside the files has nothing to compare");
});

/** A type hierarchy answering from tables of type name to supertypes, recording the calls it got. */
function hierarchy(prepared: Record<string, HierarchyNode[]>, supertypes: Record<string, HierarchyNode[] | "throw" | "hang">) {
	const calls: string[] = [];
	const source: TypeHierarchySource = {
		prepare(from) {
			calls.push(`prepare ${from.name}`);
			return Promise.resolve(prepared[from.name] ?? []);
		},
		supertypes(of) {
			calls.push(`supertypes ${of.name}`);
			const answer = supertypes[of.name] ?? [];
			if (answer === "throw") return Promise.reject(new Error("hierarchy failed"));
			if (answer === "hang") return new Promise(() => {});
			return Promise.resolve(answer);
		},
	};
	return { source, calls };
}
const nodeAt = (name: string, file: string, line: number, endLine: number): HierarchyNode => ({ ...typeAt(name, file, line, endLine), token: name });

/** The shape of a real capture of the C# language server on a three-type project: the member's container is the base class, the derived type is nested in `Catalog`. */
const baseType = roslyn("RecordBase<TValue, TSelf>", SymbolKind.Class, "Data.cs", 3, TOP);
const setMember = roslyn("ApplyFrom(TValue)", SymbolKind.Method, "Data.cs", 5, IN("RecordBase<TValue, TSelf>"));
const overrideType = roslyn("Profile", SymbolKind.Class, "Catalog.cs", 10, IN("Catalog"));
const baseNode = nodeAt("RecordBase<string, Profile>", "Data.cs", 3, 8);
const inheritedProvider = (extra: Record<string, SymbolEntry[]> = {}) => provider({ ApplyFrom: [setMember, roslyn("ApplyFrom(int)", SymbolKind.Method, "Other.cs", 2, IN("Unrelated"))], Profile: [overrideType], ...extra });

test("a member the qualifier's type inherits is found where its base class declares it, through the provider's type hierarchy", async () => {
	const answers = inheritedProvider();
	const types = hierarchy({ Profile: [nodeAt("Profile", "Catalog.cs", 10, 12)] }, { Profile: [baseNode] });
	const resolver = new SymbolLinkResolver({ ...answers.source, hierarchy: types.source });
	assert.deepEqual(await resolver.resolve(symbol("Profile.ApplyFrom"), scope), { status: "found", target: "Data.cs:5:5" });
	assert.deepEqual(answers.asked, ["ApplyFrom", "Profile.ApplyFrom", "Profile"], "the name, the qualified name, then the qualifier's type");
	assert.deepEqual(types.calls, ["prepare Profile", "supertypes Profile", "supertypes RecordBase<string, Profile>"]);
	await resolver.resolve(symbol("Profile.ApplyFrom"), scope);
	assert.equal(answers.asked.length, 3, "a found answer is cached like any other");
	assert.deepEqual(await new SymbolLinkResolver({ ...answers.source, hierarchy: types.source }).resolve(symbol("OmpDesk.Core.Catalog.Profile.ApplyFrom"), scope), { status: "found", target: "Data.cs:5:5" }, "namespaces and the outer type before the nested one");
});

test("without a type hierarchy, or when the type is not exactly one in the folders or the hierarchy says nothing, an inherited member stays unresolved: no name-only guess", async () => {
	const bare = inheritedProvider();
	assert.deepEqual(await new SymbolLinkResolver(bare.source).resolve(symbol("Profile.ApplyFrom"), scope), { status: "none" });
	assert.deepEqual(bare.asked, ["ApplyFrom", "Profile.ApplyFrom"], "no hierarchy, no third question");
	const silent = hierarchy({}, {});
	assert.deepEqual(await new SymbolLinkResolver({ ...inheritedProvider().source, hierarchy: silent.source }).resolve(symbol("Profile.ApplyFrom"), scope), { status: "none" }, "the provider has no hierarchy for the position");
	const twice = hierarchy({ Profile: [nodeAt("Profile", "Catalog.cs", 10, 12)] }, { Profile: [baseNode] });
	const twins = inheritedProvider({ Profile: [overrideType, roslyn("Profile", SymbolKind.Class, "Other.cs", 4, IN("Elsewhere"))] });
	assert.deepEqual(await new SymbolLinkResolver({ ...twins.source, hierarchy: twice.source }).resolve(symbol("Profile.ApplyFrom"), scope), { status: "none" }, "two types of that name: which one is meant is unknown");
	assert.deepEqual(twice.calls, []);
	const unplaced = inheritedProvider({ Profile: [{ ...overrideType, line: 0, column: 0 }] });
	assert.deepEqual(await new SymbolLinkResolver({ ...unplaced.source, hierarchy: twice.source }).resolve(symbol("Profile.ApplyFrom"), scope), { status: "none" }, "a type without a position cannot be asked");
	const outside = inheritedProvider({ Profile: [{ ...overrideType, path: "D:\\Other\\Catalog.cs" }] });
	assert.deepEqual(await new SymbolLinkResolver({ ...outside.source, hierarchy: twice.source }).resolve(symbol("Profile.ApplyFrom"), scope), { status: "none" }, "a type outside the session's folders");
	assert.deepEqual(await new SymbolLinkResolver({ ...inheritedProvider({ Profile: [{ ...overrideType, kind: SymbolKind.Enum }] }).source, hierarchy: twice.source }).resolve(symbol("Profile.ApplyFrom"), scope), { status: "none" }, "an enum has no base to inherit from");
});

test("an override nearer the type wins, two declarations at one level are ambiguous, and a direct member never needs the hierarchy", async () => {
	const mid = nodeAt("Mid", "Mid.cs", 2, 9);
	const middle = roslyn("ApplyFrom", SymbolKind.Method, "Mid.cs", 7, IN("Mid"));
	const types = hierarchy({ Profile: [nodeAt("Profile", "Catalog.cs", 10, 12)] }, { Profile: [mid], Mid: [baseNode] });
	assert.deepEqual(await new SymbolLinkResolver({ ...inheritedProvider({ ApplyFrom: [setMember, middle] }).source, hierarchy: types.source }).resolve(symbol("Profile.ApplyFrom"), scope), { status: "found", target: "Mid.cs:7:5" });
	const twoBases = hierarchy({ Profile: [nodeAt("Profile", "Catalog.cs", 10, 12)] }, { Profile: [nodeAt("IFirst", "First.cs", 1, 5), nodeAt("ISecond", "Second.cs", 1, 5)] });
	const declared = (type: string, file: string) => roslyn("ApplyFrom", SymbolKind.Method, file, 3, IN(type));
	assert.deepEqual(await new SymbolLinkResolver({ ...inheritedProvider({ ApplyFrom: [declared("IFirst", "First.cs"), declared("ISecond", "Second.cs")] }).source, hierarchy: twoBases.source }).resolve(symbol("Profile.ApplyFrom"), scope), { status: "ambiguous", definitions: 2 });
	const direct = hierarchy({}, {});
	const own = inheritedProvider({ ApplyFrom: [roslyn("ApplyFrom", SymbolKind.Method, "Catalog.cs", 11, IN("Profile"))] });
	assert.deepEqual(await new SymbolLinkResolver({ ...own.source, hierarchy: direct.source }).resolve(symbol("Profile.ApplyFrom"), scope), { status: "found", target: "Catalog.cs:11:5" });
	assert.deepEqual(direct.calls, [], "the container matched: nothing else was asked");
	assert.deepEqual(own.asked, ["ApplyFrom"]);
});

test("the type hierarchy is walked a bounded depth and number of calls; a hierarchy that is too large or fails is not a verdict, and nothing is cached", async () => {
	const tower: Record<string, HierarchyNode[]> = {};
	for (let level = 0; level < 20; level++) tower[level === 0 ? "Profile" : `Level${level}`] = [nodeAt(`Level${level + 1}`, `L${level + 1}.cs`, 1, 5)];
	const deep = hierarchy({ Profile: [nodeAt("Profile", "Catalog.cs", 10, 12)] }, tower);
	assert.deepEqual(await new SymbolLinkResolver({ ...inheritedProvider().source, hierarchy: deep.source }).resolve(symbol("Profile.ApplyFrom"), scope), { status: "none" });
	assert.equal(deep.calls.length, 9, "one prepare and eight levels");
	const wide: Record<string, HierarchyNode[]> = { Profile: [0, 1, 2].map(index => nodeAt(`Fan${index}`, `F${index}.cs`, 1, 5)) };
	for (let index = 0; index < 3; index++) wide[`Fan${index}`] = [0, 1, 2].map(child => nodeAt(`Fan${index}${child}`, `G${index}${child}.cs`, 1, 5));
	for (let index = 0; index < 3; index++) for (let child = 0; child < 3; child++) wide[`Fan${index}${child}`] = [0, 1, 2].map(leaf => nodeAt(`Fan${index}${child}${leaf}`, `H${index}${child}${leaf}.cs`, 1, 5));
	const broad = hierarchy({ Profile: [nodeAt("Profile", "Catalog.cs", 10, 12)] }, { ...wide, ...Object.fromEntries(Object.values(wide).flat().map(node => [node.name, [0, 1, 2].map(next => nodeAt(`${node.name}${next}`, `${node.name}${next}.cs`, 1, 5))])) });
	assert.deepEqual(await new SymbolLinkResolver({ ...inheritedProvider().source, hierarchy: broad.source }).resolve(symbol("Profile.ApplyFrom"), scope), { status: "unavailable" });
	assert.ok(broad.calls.length <= 25, `at most 24 supertype calls and the prepare: ${broad.calls.length}`);
	const hung = hierarchy({ Profile: [nodeAt("Profile", "Catalog.cs", 10, 12)] }, { Profile: "hang" });
	const slow = new SymbolLinkResolver({ ...inheritedProvider().source, hierarchy: hung.source }, { queryTimeoutMs: 10 });
	assert.deepEqual(await slow.resolve(symbol("Profile.ApplyFrom"), scope), { status: "pending" }, "a hierarchy that does not answer in time parks the token like a slow provider");
	assert.deepEqual(await slow.resolve(symbol("Profile.ApplyFrom"), scope), { status: "pending" });
	assert.equal(hung.calls.filter(call => call === "prepare Profile").length, 2, "nothing cached: the second question asked again");
	const broken = hierarchy({ Profile: [nodeAt("Profile", "Catalog.cs", 10, 12)] }, { Profile: "throw" });
	assert.deepEqual(await new SymbolLinkResolver({ ...inheritedProvider().source, hierarchy: broken.source }).resolve(symbol("Profile.ApplyFrom"), scope), { status: "unavailable" });
});

test("an invalidation while the hierarchy is asked leaves the lookup pending and caches nothing", async () => {
	const release = Promise.withResolvers<HierarchyNode[]>();
	const types: TypeHierarchySource = { prepare: async () => [nodeAt("Profile", "Catalog.cs", 10, 12)], supertypes: () => release.promise };
	const resolver = new SymbolLinkResolver({ ...inheritedProvider().source, hierarchy: types });
	const running = resolver.resolve(symbol("Profile.ApplyFrom"), scope);
	await tick();
	await tick();
	resolver.invalidate();
	release.resolve([baseNode]);
	assert.deepEqual(await running, { status: "pending" });
	const again = hierarchy({ Profile: [nodeAt("Profile", "Catalog.cs", 10, 12)] }, { Profile: [baseNode] });
	assert.deepEqual(await new SymbolLinkResolver({ ...inheritedProvider().source, hierarchy: again.source }).resolve(symbol("Profile.ApplyFrom"), scope), { status: "found", target: "Data.cs:5:5" });
});

test("a provider's hierarchy item becomes a node: only a file location has a path, and lines are one-based", () => {
	const item = { name: "RecordBase<string, Profile>", uri: { scheme: "file", fsPath: at("Data.cs") }, range: { start: { line: 2 }, end: { line: 5 } } };
	assert.deepEqual(hierarchyNode(item), { name: item.name, path: at("Data.cs"), line: 3, endLine: 6, token: item });
	assert.equal(hierarchyNode({ ...item, uri: { scheme: "roslyn-metadata", fsPath: "x" } }).path, "");
});

test("a qualified selection's every definition is returned for the symbol search, inherited ones included, without a cache; failures leave the fallback to the caller", async () => {
	const twins = provider({ Load: [entry("Load", SymbolKind.Method, "B.cs", 20, "SessionData"), entry("Load", SymbolKind.Method, "A.cs", 4, "Other.SessionData"), entry("Load", SymbolKind.Method, "C.cs", 9, "Unrelated")] });
	const resolver = new SymbolLinkResolver(twins.source);
	const direct = await resolver.find(symbol("SessionData.Load"), scope);
	assert.equal(direct.state, "matches");
	assert.deepEqual(direct.state === "matches" ? direct.entries.map(found => found.path.slice(CWD.length + 1)) : [], ["A.cs", "B.cs"], "both classes of that name, by position");
	await resolver.find(symbol("SessionData.Load"), scope);
	assert.equal(twins.asked.length, 2, "nothing is cached");
	const types = hierarchy({ Profile: [nodeAt("Profile", "Catalog.cs", 10, 12)] }, { Profile: [baseNode] });
	const inherited = await new SymbolLinkResolver({ ...inheritedProvider().source, hierarchy: types.source }).find(symbol("Profile.ApplyFrom"), scope);
	assert.deepEqual(inherited.state === "matches" ? [inherited.via, inherited.entries.map(found => found.line)] : inherited, ["inherited", [5]]);
	assert.deepEqual(await new SymbolLinkResolver(provider({ Load: [entry("Load", SymbolKind.Method, "C.cs", 9, "Unrelated")] }).source).find(symbol("SessionData.Load"), scope), { state: "none" });
	assert.deepEqual(await new SymbolLinkResolver(provider({}).source, { probeDelaysMs: [100000] }).find(symbol("SessionData.Load"), scope), { state: "pending" }, "a provider that has not answered yet");
	assert.deepEqual(await new SymbolLinkResolver(provider({ Load: "throw" }).source).find(symbol("SessionData.Load"), scope), { state: "unavailable" });
	assert.deepEqual(await new SymbolLinkResolver(twins.source).find(symbol("SessionData.Load"), { cwd: "", roots: [] }), { state: "none" });
});

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("lookups lost to a burst of file changes are signalled once after the burst settles; a change that loses nothing signals nothing", async () => {
	const releases: (() => void)[] = [];
	let retries = 0;
	const source: SymbolSource = { query: () => new Promise(resolve => { releases.push(() => resolve(Object.assign([entry("Session", SymbolKind.Class, "A.cs", 3)], { total: 1 }))); }) };
	const resolver = new SymbolLinkResolver(source, { settleMs: 40, minRetryMs: 10, onRetry: () => { retries++; } });
	resolver.invalidate("created Library\\a");
	await sleep(60);
	assert.equal(retries, 0, "no lookup was under way: nothing was lost, nothing is signalled");
	const first = resolver.resolve(symbol("Session"), scope);
	const second = resolver.resolve(symbol("Other"), scope);
	await tick();
	resolver.invalidate("created Library\\b");
	releases.splice(0).forEach(release => release());
	assert.deepEqual(await Promise.all([first, second]), [{ status: "pending" }, { status: "pending" }], "dropped by the change: waiting, not failed");
	for (let burst = 0; burst < 4; burst++) { await sleep(15); resolver.invalidateContent("saved a.cs"); }
	assert.equal(retries, 0, "the burst has not settled: the signal waits");
	await sleep(120);
	assert.equal(retries, 1, "one signal for the whole burst and both lookups");
	await sleep(120);
	assert.equal(retries, 1, "and not again");
});

test("an invalidation that never stops delays the signal only up to its cap, and a lost lookup in a quiet workspace is asked about again promptly", async () => {
	let retries = 0;
	const resolver = new SymbolLinkResolver({ query: async () => { resolver.invalidate("changed"); return []; } }, { settleMs: 20, minRetryMs: 5, onRetry: () => { retries++; } });
	await resolver.resolve(symbol("Session"), scope);
	for (let turn = 0; turn < 14 && retries === 0; turn++) { await sleep(15); resolver.invalidate("changed again"); }
	assert.equal(retries, 1, "ten settle windows after the first loss at the latest, however busy");
});

test("a provider that becomes ready tells the pages even when no lookup was parked as not ready; lookups lost to changes were pending", async () => {
	let loaded = false;
	let retries = 0;
	const source: SymbolSource = { query: async () => { if (!loaded) { resolver.invalidate("changed"); return []; } return Object.assign([entry("Session", SymbolKind.Class, "A.cs", 3)], { total: 1 }); } };
	const resolver = new SymbolLinkResolver(source, { settleMs: 1_000_000, onRetry: () => { retries++; } });
	assert.deepEqual(await resolver.resolve(symbol("Session"), scope), { status: "pending" });
	loaded = true;
	assert.deepEqual(await resolver.resolve(symbol("Session"), scope), { status: "found", target: "A.cs:3:5" });
	assert.equal(retries, 1, "the lost lookup left a page waiting; the provider answering is the signal it waits for");
	assert.deepEqual(await resolver.resolve(symbol("Other"), scope), { status: "none" });
	assert.equal(retries, 1);
});
