import assert from "node:assert/strict";
import { test } from "node:test";
import { fileReference, parseBareFileName, parseCodeSymbol, parseSymbolLinksRequest, parseSymbolLinksResolution, parseSymbolLinksRetry } from "./code-symbols.ts";

const shape = (content: string) => {
	const symbol = parseCodeSymbol(content);
	return symbol === null ? null : { name: symbol.name, last: symbol.last, attribute: symbol.attribute, call: symbol.call };
};

test("a bare capitalized name, a dotted name, a call and an attribute are symbols, and spelling variants normalize to one name", () => {
	assert.deepEqual(shape("Session"), { name: "Session", last: "Session", attribute: false, call: false });
	assert.deepEqual(shape("SessionData.Load"), { name: "SessionData.Load", last: "Load", attribute: false, call: false });
	assert.deepEqual(shape("SessionData.Load()"), { name: "SessionData.Load", last: "Load", attribute: false, call: true });
	assert.deepEqual(shape("SessionData.Load(unit, 3)"), { name: "SessionData.Load", last: "Load", attribute: false, call: true });
	assert.deepEqual(shape("SessionStoreBase<T>"), { name: "SessionStoreBase", last: "SessionStoreBase", attribute: false, call: false });
	assert.deepEqual(shape("Dictionary<string, List<int>>"), { name: "Dictionary", last: "Dictionary", attribute: false, call: false });
	assert.deepEqual(shape("OmpDesk.Sessions.SessionData<T>.Load<TArg>(x)"), { name: "OmpDesk.Sessions.SessionData.Load", last: "Load", attribute: false, call: true });
	assert.deepEqual(shape("[Tracked]"), { name: "Tracked", last: "Tracked", attribute: true, call: false });
	assert.deepEqual(shape("[Tracked(typeof(Store))]"), { name: "Tracked", last: "Tracked", attribute: true, call: true });
	assert.deepEqual(shape("ISessionStoreRestriction"), { name: "ISessionStoreRestriction", last: "ISessionStoreRestriction", attribute: false, call: false });
	assert.deepEqual(shape("SessionRoutine"), { name: "SessionRoutine", last: "SessionRoutine", attribute: false, call: false });
	assert.deepEqual(shape("Items[]"), { name: "Items", last: "Items", attribute: false, call: false });
	assert.deepEqual(shape("Store?"), { name: "Store", last: "Store", attribute: false, call: false });
	assert.deepEqual(shape("  Session  "), { name: "Session", last: "Session", attribute: false, call: false });
	assert.deepEqual(shape("snake_case_name"), { name: "snake_case_name", last: "snake_case_name", attribute: false, call: false });
	assert.deepEqual(shape("$store"), { name: "$store", last: "$store", attribute: false, call: false });
	assert.deepEqual(shape("this_one"), { name: "this_one", last: "this_one", attribute: false, call: false });
});

test("camelCase and mixed-case names are symbols; a bare all-lowercase word is prose unless it is called", () => {
	assert.ok(parseCodeSymbol("sessionRoutine"));
	assert.ok(parseCodeSymbol("parse()"));
	assert.ok(parseCodeSymbol("obj.run"), "a dotted name needs no capital");
	for (const prose of ["main", "json", "sha256", "npm", "parse", "omp"]) assert.equal(parseCodeSymbol(prose), null, prose);
});

test("the grammar and the wire agree: generic arguments may hold `$`, and a control character anywhere, even in padding, is not a symbol", () => {
	assert.ok(parseCodeSymbol("Foo<$Type>"));
	assert.ok(parseCodeSymbol(" Foo "), "plain padding is trimmed");
	for (const padded of ["\tFoo\t", "Foo\n", "\u000bFoo"]) assert.equal(parseCodeSymbol(padded), null, JSON.stringify(padded));
});

test("spans with spaces, operators, literals, keywords, short names, paths and unbalanced punctuation are not symbols", () => {
	const refused = [
		"", "ab", "A", "A.B", "a.b", "x.y.zz",
		"two words", "a + b", "Foo()  bar", "x => x", "Foo::Bar", "Foo->Bar", "Foo, Bar", "a || b", "!Foo", "-Foo", "@Foo", "#Foo", "Foo;",
		"123", "1.5", "0xFF", "\"Foo\"", "'Foo'", "Foo\"", "src/Foo.ts", "..\\Foo", "C:\\Foo", "http://x.test", "Foo/Bar",
		"null", "true", "undefined", "class", "this", "this.Foo", "base.Run()", "string", "void", "Foo.class", "int.Parse",
		"Foo<", "Foo<T", "Foo>", "Foo<a+b>", "Foo(", "Foo)", "Foo(x", "(Foo)", "[Foo", "Foo]", "[]", "[Foo]]", "Foo<T>>",
		"Ünïcode", "Foo.Ünï", "A.B.C.D.E.Fff", "Foo..Bar", ".Foo", "Foo.", "Foo`bar", "Foo\nBar", "Foo\u0000",
		"x".repeat(121),
	];
	for (const content of refused) assert.equal(parseCodeSymbol(content), null, JSON.stringify(content));
});

test("keywords are case-sensitive: a type named like a keyword in another case is still a symbol", () => {
	assert.ok(parseCodeSymbol("String"));
	assert.ok(parseCodeSymbol("Object"));
	assert.equal(parseCodeSymbol("string"), null);
	assert.equal(parseCodeSymbol("constructor"), null, "an all-lowercase bare word");
	assert.ok(parseCodeSymbol("constructor()"), "an own-property name of Object is not mistaken for a keyword");
});

test("the request and resolution parsers accept exactly the exchange's shapes", () => {
	const request = { type: "omp:terminal-link-symbols", requestId: 4, tokens: ["Session", "A.Bcd"] };
	assert.deepEqual(parseSymbolLinksRequest(request), request);
	for (const bad of [
		{ ...request, tokens: [] }, { ...request, tokens: "Session" }, { ...request, tokens: [1] }, { ...request, tokens: [""] },
		{ ...request, tokens: ["a\nb"] }, { ...request, tokens: ["x".repeat(121)] }, { ...request, tokens: Array.from({ length: 17 }, () => "Abc") },
		{ ...request, requestId: -1 }, { ...request, requestId: 1.5 }, { ...request, cwd: "C:/x" }, { ...request, type: "omp:terminal-link-validate" },
	]) assert.equal(parseSymbolLinksRequest(bad as Record<string, unknown>), null, JSON.stringify(bad));
	const resolution = { type: "omp:terminal-link-symbol-resolution", requestId: 4, results: [{ token: "Session", status: "found", target: "src/a.ts:3:1" }, { token: "Nope", status: "none" }, { token: "Late", status: "unavailable" }] };
	assert.deepEqual(parseSymbolLinksResolution(resolution), resolution);
	assert.deepEqual(parseSymbolLinksResolution({ ...resolution, disabled: true }), { ...resolution, disabled: true });
	for (const bad of [
		{ ...resolution, disabled: false }, { ...resolution, results: "x" }, { ...resolution, requestId: "4" },
		{ ...resolution, results: [{ token: "A", status: "found" }] }, { ...resolution, results: [{ token: "A", status: "none", target: "x" }] },
		{ ...resolution, results: [{ token: "A", status: "maybe" }] }, { ...resolution, results: [{ token: "A", status: "found", target: "a\nb" }] },
		{ ...resolution, results: [{ token: "A", status: "none", extra: 1 }] }, { ...resolution, results: [null] },
		{ ...resolution, results: Array.from({ length: 17 }, () => ({ token: "A", status: "none" })) },
	]) assert.equal(parseSymbolLinksResolution(bad as Record<string, unknown>), null, JSON.stringify(bad));
});

test("the length limit applies to the raw token, as the wire does, so padding cannot smuggle an overlong span in", () => {
	assert.equal(parseCodeSymbol(`${" ".repeat(100)}Foo${" ".repeat(100)}`), null);
	assert.ok(parseCodeSymbol(`${" ".repeat(5)}Foo${" ".repeat(5)}`));
});

test("the retry signal and the pending status are exact", () => {
	assert.deepEqual(parseSymbolLinksRetry({ type: "omp:terminal-link-symbols-retry" }), { type: "omp:terminal-link-symbols-retry" });
	assert.equal(parseSymbolLinksRetry({ type: "omp:terminal-link-symbols-retry", extra: 1 }), null);
	assert.equal(parseSymbolLinksRetry({ type: "other" }), null);
	const message = { type: "omp:terminal-link-symbol-resolution", requestId: 1, results: [{ token: "Session", status: "pending" }] };
	assert.deepEqual(parseSymbolLinksResolution(message), message);
});

test("an ambiguous result carries its number of definitions and nothing else does", () => {
	const message = { type: "omp:terminal-link-symbol-resolution", requestId: 1, results: [{ token: "Twin", status: "ambiguous", definitions: 2 }] };
	assert.deepEqual(parseSymbolLinksResolution(message), message);
	for (const bad of [{ token: "Twin", status: "ambiguous" }, { token: "Twin", status: "ambiguous", definitions: 1 }, { token: "Twin", status: "ambiguous", definitions: 2.5 }, { token: "Twin", status: "ambiguous", definitions: "2" }, { token: "Twin", status: "ambiguous", definitions: 2, target: "a.ts" }, { token: "Twin", status: "none", definitions: 2 }]) {
		assert.equal(parseSymbolLinksResolution({ ...message, results: [bad] }), null, JSON.stringify(bad));
	}
});

test("an ambiguous result may say its several are files, and nothing else may", () => {
	const message = { type: "omp:terminal-link-symbol-resolution", requestId: 1, results: [{ token: "Settings.cs:4", status: "ambiguous", definitions: 3, files: true }] };
	assert.deepEqual(parseSymbolLinksResolution(message), message);
	for (const bad of [{ token: "A.cs", status: "ambiguous", definitions: 3, files: false }, { token: "A.cs", status: "found", target: "a.cs", files: true }, { token: "A.cs", status: "none", files: true }, { token: "A.cs", status: "ambiguous", definitions: 3, files: "yes" }]) {
		assert.equal(parseSymbolLinksResolution({ ...message, results: [bad] }), null, JSON.stringify(bad));
	}
});

const bare = (content: string) => parseBareFileName(content);

test("a bare file name has a stem and a one-case letter-led extension, with an optional line and column", () => {
	assert.deepEqual(bare("session-index.ts"), { name: "session-index.ts" });
	assert.deepEqual(bare("session-index.ts:849"), { name: "session-index.ts", line: 849 });
	assert.deepEqual(bare("session-index.ts:849:12"), { name: "session-index.ts", line: 849, column: 12 });
	assert.deepEqual(bare("session-index.ts:L849"), { name: "session-index.ts", line: 849 });
	assert.deepEqual(bare("session-index.ts:849-860"), { name: "session-index.ts", line: 849 }, "the start of a range");
	assert.deepEqual(bare("session-index.ts#L849"), { name: "session-index.ts", line: 849 });
	assert.deepEqual(bare("session-index.ts(849)"), { name: "session-index.ts", line: 849 });
	assert.deepEqual(bare("session-index.ts(849,3)"), { name: "session-index.ts", line: 849, column: 3 });
	assert.deepEqual(bare("  index.ts:7  "), { name: "index.ts", line: 7 }, "padding is trimmed");
	for (const name of ["foo.d.ts", ".eslintrc.json", "README.MD", "Makefile.am", "my-file_2.v2.tsx", "foo@2x.png", "Проект.cs", "a.b1"]) assert.ok(bare(name), name);
});

test("anchored paths, symbols, versions, prose and anything that could be a glob or a mention are not file references", () => {
	const refused = [
		"D:\\a.cs", "C:/a.cs", "./a.cs", ".\\a.cs", "../a.cs", "a/../b.cs", "a/./b.cs", "/a/b.cs", "\\a.cs", "~/a.cs", "a//b.cs", "a/b.cs/", "a/ b.cs", "my dir/a.cs", "@lib/a.cs", "-lib/a.cs", "a/*.cs", "a/b?.cs", "a/b/Makefile", "a/B.Cs", "a/b.cs:x", "a/b.cs:0",
		"a.cs:x", "a.cs:0", "a.cs:1:0", "a.cs(0)", "a.cs:12345678", "a.cs:12:3:4", "two words.cs", "a .cs",
		"Foo.Bar", "SessionData.Load", "Foo.bar2Baz", "obj.Run()", "1.2.3", "v1.0", "3.14", "e.", "a.", ".cs", "..cs", "a..cs", "foo.", "Makefile", "file.c++", "a.verylongextension",
		"*.cs", "a?.cs", "[a].cs", "{a,b}.cs", "a(b).cs", "!a.cs", "@scope.cs", "-a.cs", "+a.cs", "~a.cs", "$a.cs", "a.cs\n", "`a.cs`", "a\u0000.cs", "x".repeat(101) + ".cs", "",
	];
	for (const content of refused) assert.equal(bare(content), null, JSON.stringify(content));
	assert.equal(bare(`${" ".repeat(100)}a.cs${" ".repeat(100)}`), null, "the raw length is bounded like the wire's");
});

test("the trailing part of a path is a file reference: its directories, the name and the position are kept apart", () => {
	assert.deepEqual(bare("host/session-index.ts:579"), { name: "session-index.ts", directory: "host", line: 579 });
	assert.deepEqual(bare("shared/code-symbols.ts"), { name: "code-symbols.ts", directory: "shared" });
	assert.deepEqual(bare("src\\host\\session-index.ts(12,3)"), { name: "session-index.ts", directory: "src/host", line: 12, column: 3 }, "either separator, normalized to a slash");
	assert.deepEqual(bare(".workspace/notes/code-symbols.ts#L9"), { name: "code-symbols.ts", directory: ".workspace/notes", line: 9 });
	assert.equal(fileReference(bare("host/session-index.ts:579")!), "host/session-index.ts");
	assert.equal(fileReference(bare("session-index.ts:579")!), "session-index.ts");
	assert.equal(parseCodeSymbol("host/session-index.ts:579"), null, "a path is never a symbol");
});

test("a name that is both a bare file name and a symbol is both; a mixed-case extension is a symbol only", () => {
	assert.ok(bare("Twin.run") && parseCodeSymbol("Twin.run"));
	assert.ok(bare("Settings.json") && parseCodeSymbol("Settings.json"));
	assert.equal(bare("Twin.Run"), null);
	assert.ok(parseCodeSymbol("Twin.Run"));
	assert.equal(parseCodeSymbol("session-index.ts"), null, "two letters: never a symbol");
});
