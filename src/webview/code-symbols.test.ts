import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCodeSymbol, parseSymbolLinksRequest, parseSymbolLinksResolution, parseSymbolLinksRetry } from "./code-symbols.ts";

const shape = (content: string) => {
	const symbol = parseCodeSymbol(content);
	return symbol === null ? null : { name: symbol.name, last: symbol.last, attribute: symbol.attribute, call: symbol.call };
};

test("a bare capitalized name, a dotted name, a call and an attribute are symbols, and spelling variants normalize to one name", () => {
	assert.deepEqual(shape("Ability"), { name: "Ability", last: "Ability", attribute: false, call: false });
	assert.deepEqual(shape("AbilityData.Cast"), { name: "AbilityData.Cast", last: "Cast", attribute: false, call: false });
	assert.deepEqual(shape("AbilityData.Cast()"), { name: "AbilityData.Cast", last: "Cast", attribute: false, call: true });
	assert.deepEqual(shape("AbilityData.Cast(unit, 3)"), { name: "AbilityData.Cast", last: "Cast", attribute: false, call: true });
	assert.deepEqual(shape("UnitUseAbilityAbstract<T>"), { name: "UnitUseAbilityAbstract", last: "UnitUseAbilityAbstract", attribute: false, call: false });
	assert.deepEqual(shape("Dictionary<string, List<int>>"), { name: "Dictionary", last: "Dictionary", attribute: false, call: false });
	assert.deepEqual(shape("Game.Abilities.AbilityData<T>.Cast<TArg>(x)"), { name: "Game.Abilities.AbilityData.Cast", last: "Cast", attribute: false, call: true });
	assert.deepEqual(shape("[AllowedOn]"), { name: "AllowedOn", last: "AllowedOn", attribute: true, call: false });
	assert.deepEqual(shape("[AllowedOn(typeof(Unit))]"), { name: "AllowedOn", last: "AllowedOn", attribute: true, call: true });
	assert.deepEqual(shape("IAbilityCasterRestriction"), { name: "IAbilityCasterRestriction", last: "IAbilityCasterRestriction", attribute: false, call: false });
	assert.deepEqual(shape("ProcessRoutine"), { name: "ProcessRoutine", last: "ProcessRoutine", attribute: false, call: false });
	assert.deepEqual(shape("Items[]"), { name: "Items", last: "Items", attribute: false, call: false });
	assert.deepEqual(shape("Unit?"), { name: "Unit", last: "Unit", attribute: false, call: false });
	assert.deepEqual(shape("  Ability  "), { name: "Ability", last: "Ability", attribute: false, call: false });
	assert.deepEqual(shape("snake_case_name"), { name: "snake_case_name", last: "snake_case_name", attribute: false, call: false });
	assert.deepEqual(shape("$store"), { name: "$store", last: "$store", attribute: false, call: false });
	assert.deepEqual(shape("this_one"), { name: "this_one", last: "this_one", attribute: false, call: false });
});

test("camelCase and mixed-case names are symbols; a bare all-lowercase word is prose unless it is called", () => {
	assert.ok(parseCodeSymbol("processRoutine"));
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
	const request = { type: "omp:terminal-link-symbols", requestId: 4, tokens: ["Ability", "A.Bcd"] };
	assert.deepEqual(parseSymbolLinksRequest(request), request);
	for (const bad of [
		{ ...request, tokens: [] }, { ...request, tokens: "Ability" }, { ...request, tokens: [1] }, { ...request, tokens: [""] },
		{ ...request, tokens: ["a\nb"] }, { ...request, tokens: ["x".repeat(121)] }, { ...request, tokens: Array.from({ length: 17 }, () => "Abc") },
		{ ...request, requestId: -1 }, { ...request, requestId: 1.5 }, { ...request, cwd: "C:/x" }, { ...request, type: "omp:terminal-link-validate" },
	]) assert.equal(parseSymbolLinksRequest(bad as Record<string, unknown>), null, JSON.stringify(bad));
	const resolution = { type: "omp:terminal-link-symbol-resolution", requestId: 4, results: [{ token: "Ability", status: "found", target: "src/a.ts:3:1" }, { token: "Nope", status: "none" }, { token: "Late", status: "unavailable" }] };
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
	const message = { type: "omp:terminal-link-symbol-resolution", requestId: 1, results: [{ token: "Ability", status: "pending" }] };
	assert.deepEqual(parseSymbolLinksResolution(message), message);
});

test("an ambiguous result carries its number of definitions and nothing else does", () => {
	const message = { type: "omp:terminal-link-symbol-resolution", requestId: 1, results: [{ token: "Twin", status: "ambiguous", definitions: 2 }] };
	assert.deepEqual(parseSymbolLinksResolution(message), message);
	for (const bad of [{ token: "Twin", status: "ambiguous" }, { token: "Twin", status: "ambiguous", definitions: 1 }, { token: "Twin", status: "ambiguous", definitions: 2.5 }, { token: "Twin", status: "ambiguous", definitions: "2" }, { token: "Twin", status: "ambiguous", definitions: 2, target: "a.ts" }, { token: "Twin", status: "none", definitions: 2 }]) {
		assert.equal(parseSymbolLinksResolution({ ...message, results: [bad] }), null, JSON.stringify(bad));
	}
});
