import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { describe, it } from "node:test";
import { MAX_CODE_THEMES, MAX_CODE_THEME_JSON_BYTES, MAX_CODE_THEME_RULES, MAX_CODE_THEME_SCOPES_PER_RULE, parseCodeThemes } from "../chat/code-theme.ts";
import type { CodeTheme } from "../chat/code-theme.ts";
import { resolveCodeThemes } from "./code-theme.ts";
import type { CodeThemeContribution, CodeThemeInput, CodeThemeKind, CodeThemeSettings } from "./code-theme.ts";

const EXT = "/ext/demo";

const DARK: CodeThemeContribution = { extensionPath: EXT, id: "Demo Dark", uiTheme: "vs-dark", path: "./themes/dark.json" };

/** An in-memory file system: an object is stored as its JSON, a string as is. `reads` records what was read. */
function memory(files: Record<string, unknown>, reads: string[] = []): Pick<CodeThemeInput, "readFile" | "fileSize"> {
	const text = (path: string): string | null => {
		if (!Object.hasOwn(files, path)) return null;
		const content = files[path];
		return typeof content === "string" ? content : JSON.stringify(content);
	};
	return {
		readFile: async path => {
			reads.push(path);
			return text(path);
		},
		fileSize: async path => {
			const content = text(path);
			return content === null ? null : Buffer.byteLength(content, "utf8");
		},
	};
}

function settings(overrides: Partial<CodeThemeSettings> = {}): CodeThemeSettings {
	return { colorTheme: "Demo Dark", ...overrides };
}

function resolveAll(files: Record<string, unknown>, overrides: Partial<Omit<CodeThemeInput, "readFile" | "fileSize">> = {}, reads: string[] = []): Promise<CodeTheme[]> {
	return resolveCodeThemes({
		kind: "dark",
		settings: settings(),
		customizations: undefined,
		themes: [DARK],
		...memory(files, reads),
		...overrides,
	});
}

/** The single theme of the default setup, or `null`. */
async function resolve(files: Record<string, unknown>, overrides: Partial<Omit<CodeThemeInput, "readFile" | "fileSize">> = {}): Promise<CodeTheme | null> {
	const themes = await resolveAll(files, overrides);
	assert.ok(themes.length <= 1, "one candidate expected");
	return themes[0] ?? null;
}

const file = (name: string): string => `${EXT}/themes/${name}`;

const scopesOf = (theme: CodeTheme | null): string[] => (theme?.rules ?? []).flatMap(rule => [...rule.scopes]);

describe("resolveCodeThemes: theme files", () => {
	it("reads the rules of a theme in file order, dropping rules that set no scope", async () => {
		const theme = await resolve({
			[file("dark.json")]: {
				tokenColors: [
					{ settings: { foreground: "#111111" } },
					{ scope: "comment", settings: { foreground: "#6A9955", fontStyle: "italic" } },
					{ scope: ["string", "constant.other"], settings: { foreground: "#ce9178" } },
				],
			},
		});
		assert.deepEqual(theme, {
			id: "Demo Dark",
			rules: [
				{ scopes: ["comment"], foreground: "#6A9955", fontStyle: "italic" },
				{ scopes: ["string", "constant.other"], foreground: "#ce9178" },
			],
		});
	});

	it("loads an include before the file's own rules, so later rules come last", async () => {
		const theme = await resolve({
			[file("dark.json")]: { include: "./base.json", tokenColors: [{ scope: "string", settings: { foreground: "#222222" } }] },
			[file("base.json")]: { tokenColors: [{ scope: "string", settings: { foreground: "#111111" } }, { scope: "comment", settings: { foreground: "#333333" } }] },
		});
		assert.deepEqual(theme?.rules.map(rule => rule.foreground), ["#111111", "#333333", "#222222"]);
	});

	it("follows a three-level include chain, each include relative to the file that names it", async () => {
		const theme = await resolve({
			[file("dark.json")]: { include: "./sub/mid.json", tokenColors: [{ scope: "c", settings: { foreground: "#333333" } }] },
			[file("sub/mid.json")]: { include: "../root.json", tokenColors: [{ scope: "b", settings: { foreground: "#222222" } }] },
			[file("root.json")]: { tokenColors: [{ scope: "a", settings: { foreground: "#111111" } }] },
		});
		assert.deepEqual(scopesOf(theme), ["a", "b", "c"]);
	});

	it("accepts a backslash include", async () => {
		const theme = await resolve({
			[file("dark.json")]: { include: ".\\sub\\base.json" },
			[file("sub/base.json")]: { tokenColors: [{ scope: "a", settings: { foreground: "#111111" } }] },
		});
		assert.deepEqual(scopesOf(theme), ["a"]);
	});

	it("omits the theme for an include cycle, and for a chain deeper than eight includes", async () => {
		assert.equal(
			await resolve({
				[file("dark.json")]: { include: "./a.json" },
				[file("a.json")]: { include: "./dark.json", tokenColors: [] },
			}),
			null,
		);
		const chain: Record<string, unknown> = { [file("dark.json")]: { include: "./i1.json" } };
		for (let level = 1; level <= 9; level++) {
			chain[file(`i${level}.json`)] = level === 9 ? { tokenColors: [] } : { include: `./i${level + 1}.json` };
		}
		assert.equal(await resolve(chain), null);
		delete chain[file("i9.json")];
		chain[file("i8.json")] = { tokenColors: [{ scope: "ok", settings: { foreground: "#111111" } }] };
		assert.deepEqual(scopesOf(await resolve(chain)), ["ok"]);
	});

	it("omits a theme whose tokenColors is a string (VS Code reads it as a plist), also when an include has it", async () => {
		const tokens = [{ scope: "keyword", settings: { foreground: "#C586C0" } }];
		assert.equal(await resolve({ [file("dark.json")]: { tokenColors: "./tokens.json" }, [file("tokens.json")]: tokens }), null);
		assert.equal(await resolve({ [file("dark.json")]: { tokenColors: "./legacy.tmTheme" } }), null);
		assert.equal(
			await resolve({
				[file("dark.json")]: { include: "./base.json", tokenColors: tokens },
				[file("base.json")]: { tokenColors: "./legacy.tmTheme" },
			}),
			null,
		);
	});

	it("accepts the legacy `settings` array, skipping its scope-less default rule, and then ignores that file's own tokenColors", async () => {
		const theme = await resolve({
			[file("dark.json")]: {
				include: "./base.json",
				settings: [
					{ settings: { background: "#000000", foreground: "#FFFFFF" } },
					{ scope: "comment", settings: { foreground: "#888888" } },
				],
				tokenColors: [{ scope: "string", settings: { foreground: "#999999" } }],
			},
			[file("base.json")]: { tokenColors: [{ scope: "included", settings: { foreground: "#111111" } }] },
		});
		assert.deepEqual(theme?.rules, [
			{ scopes: ["included"], foreground: "#111111" },
			{ scopes: ["comment"], foreground: "#888888" },
		]);
	});

	it("reads JSONC: a BOM, line and block comments, trailing commas, and comment-like text in strings", async () => {
		const text = `\uFEFF// theme
{
	/* block */
	"name": "x // not a comment",
	"tokenColors": [
		{ "scope": "string.quoted /* kept */", "settings": { "foreground": "#ce9178", }, }, // trailing
		{ "scope": ["a", "b",], "settings": { "foreground": "#111111" } },
	],
}`;
		const theme = await resolve({ [file("dark.json")]: text });
		assert.deepEqual(theme?.rules, [
			{ scopes: ["string.quoted /* kept */"], foreground: "#ce9178" },
			{ scopes: ["a", "b"], foreground: "#111111" },
		]);
	});

	it("omits the theme for a missing file, a JSON error, a non-object, a missing include and a failing read", async () => {
		assert.equal(await resolve({}), null);
		assert.equal(await resolve({ [file("dark.json")]: "{ tokenColors: [" }), null);
		assert.equal(await resolve({ [file("dark.json")]: "[]" }), null);
		assert.equal(await resolve({ [file("dark.json")]: { include: "./missing.json" } }), null);
		assert.equal(await resolve({ [file("dark.json")]: { include: 5 } }), null);
		assert.equal(await resolve({ [file("dark.json")]: { tokenColors: 5 } }), null);
		assert.deepEqual(
			await resolveCodeThemes({
				kind: "dark",
				settings: settings(),
				customizations: undefined,
				themes: [DARK],
				readFile: async () => {
					throw new Error("EACCES");
				},
				fileSize: async () => 10,
			}),
			[],
		);
	});

	it("checks the size before reading: a file over 1 MiB is not read, and a file that is not a regular file is omitted", async () => {
		const reads: string[] = [];
		const big = `{"tokenColors":[]}${" ".repeat(1024 * 1024)}`;
		assert.deepEqual(await resolveAll({ [file("dark.json")]: big }, {}, reads), []);
		assert.deepEqual(reads, [], "nothing was read");
		const exact = `{"tokenColors":[]}${" ".repeat(1024 * 1024 - 18)}`;
		assert.equal(Buffer.byteLength(exact), 1024 * 1024);
		assert.equal((await resolveAll({ [file("dark.json")]: exact })).length, 1);
		assert.deepEqual(
			await resolveCodeThemes({
				kind: "dark",
				settings: settings(),
				customizations: undefined,
				themes: [DARK],
				readFile: async () => '{"tokenColors":[]}',
				fileSize: async () => null,
			}),
			[],
		);
	});
});

describe("resolveCodeThemes: the candidates", () => {
	const light: CodeThemeContribution = { extensionPath: EXT, id: "Demo Light", uiTheme: "vs", path: "./themes/light.json" };
	const hcDark: CodeThemeContribution = { extensionPath: EXT, id: "Demo HC", uiTheme: "hc-black", path: "./themes/hc.json" };
	const hcLight: CodeThemeContribution = { extensionPath: EXT, id: "Demo HC Light", uiTheme: "hc-light", path: "./themes/hcl.json" };
	const two: CodeThemeContribution = { extensionPath: EXT, id: "Demo Two", uiTheme: "vs-dark", path: "./themes/two.json" };
	const three: CodeThemeContribution = { extensionPath: EXT, id: "Demo Three", uiTheme: "vs-dark", path: "./themes/three.json" };
	const four: CodeThemeContribution = { extensionPath: EXT, id: "Demo Four", uiTheme: "vs-dark", path: "./themes/four.json" };
	const themes = [DARK, light, hcDark, hcLight, two, three, four];
	const files: Record<string, unknown> = {};
	for (const name of ["dark", "light", "hc", "hcl", "two", "three", "four"]) {
		files[file(`${name}.json`)] = { tokenColors: [{ scope: name, settings: { foreground: "#111111" } }] };
	}
	const idsOf = async (kind: CodeThemeKind, overrides: Partial<CodeThemeSettings>): Promise<string[]> =>
		(await resolveAll(files, { kind, themes, settings: overrides })).map(theme => theme.id);

	it("sends workbench.colorTheme first, then the distinct preferred themes of the active kind", async () => {
		assert.deepEqual(await idsOf("dark", { colorTheme: "Demo Dark", preferredDark: "Demo Two", preferredLight: "Demo Light" }), ["Demo Dark", "Demo Two"]);
		assert.deepEqual(await idsOf("dark", { colorTheme: "Demo Two", preferredDark: "Demo Dark" }), ["Demo Two", "Demo Dark"]);
		assert.deepEqual(await idsOf("light", { colorTheme: "Demo Dark", preferredDark: "Demo Two", preferredLight: "Demo Light" }), ["Demo Light"]);
	});

	it("covers the high-contrast preferred settings of their kind", async () => {
		const all = { colorTheme: "Demo Dark", preferredDark: "Demo Two", preferredLight: "Demo Light", preferredHighContrast: "Demo HC", preferredHighContrastLight: "Demo HC Light" };
		assert.deepEqual(await idsOf("hc-dark", all), ["Demo HC"]);
		assert.deepEqual(await idsOf("hc-light", all), ["Demo HC Light"]);
	});

	it("names a theme once however many settings name it, and sends at most three", async () => {
		assert.deepEqual(await idsOf("dark", { colorTheme: "Demo Dark", preferredDark: "Demo Dark", preferredLight: "Demo Dark" }), ["Demo Dark"]);
		const many = { colorTheme: "Demo Dark", preferredDark: "Demo Two", preferredLight: "Demo Three", preferredHighContrast: "Demo Four" };
		assert.deepEqual(await idsOf("dark", many), ["Demo Dark", "Demo Two", "Demo Three"]);
		assert.equal(MAX_CODE_THEMES, 3);
	});

	it("omits a theme of another kind than the active one, an unknown or missing uiTheme and a theme that is not installed", async () => {
		const odd: CodeThemeContribution = { extensionPath: EXT, id: "Odd", uiTheme: "vs-sepia", path: "./themes/dark.json" };
		const bare: CodeThemeContribution = { extensionPath: EXT, id: "Bare", path: "./themes/dark.json" };
		assert.deepEqual(await idsOf("light", { colorTheme: "Demo Dark" }), []);
		assert.deepEqual(await resolveAll(files, { themes: [odd, bare], settings: { colorTheme: "Odd", preferredDark: "Bare" } }), []);
		assert.deepEqual(await idsOf("dark", { colorTheme: "Gone" }), []);
		assert.deepEqual(await idsOf("dark", {}), []);
		assert.deepEqual(await idsOf("dark", { colorTheme: "", preferredDark: "Demo Two" }), ["Demo Two"]);
	});

	it("leaves out one theme that fails and keeps the others", async () => {
		const broken = { ...files, [file("two.json")]: "{ nope" };
		const result = await resolveAll(broken, { themes, settings: { colorTheme: "Demo Dark", preferredDark: "Demo Two", preferredLight: "Demo Three" } });
		assert.deepEqual(result.map(theme => theme.id), ["Demo Dark", "Demo Three"]);
	});

	it("maps the legacy and renamed setting values to the theme ids", async () => {
		const modern: CodeThemeContribution[] = [
			{ extensionPath: EXT, id: "Dark Modern", uiTheme: "vs-dark", path: "./themes/dark.json" },
			{ extensionPath: EXT, id: "Light Modern", uiTheme: "vs", path: "./themes/light.json" },
			{ extensionPath: EXT, id: "Dark+", uiTheme: "vs-dark", path: "./themes/two.json" },
			{ extensionPath: EXT, id: "Light+", uiTheme: "vs", path: "./themes/three.json" },
			{ extensionPath: EXT, id: "Dark 2026", uiTheme: "vs-dark", path: "./themes/four.json" },
			{ extensionPath: EXT, id: "Light 2026", uiTheme: "vs", path: "./themes/hc.json" },
		];
		const named = async (kind: CodeThemeKind, colorTheme: string): Promise<string[]> =>
			(await resolveAll(files, { kind, themes: modern, settings: { colorTheme } })).map(theme => theme.id);
		assert.deepEqual(await named("dark", "Default Dark Modern"), ["Dark Modern"]);
		assert.deepEqual(await named("light", "Default Light Modern"), ["Light Modern"]);
		assert.deepEqual(await named("dark", "Default Dark+"), ["Dark+"]);
		assert.deepEqual(await named("light", "Default Light+"), ["Light+"]);
		assert.deepEqual(await named("dark", "Experimental Dark"), ["Dark 2026"]);
		assert.deepEqual(await named("dark", "VS Code Dark"), ["Dark 2026"]);
		assert.deepEqual(await named("light", "Experimental Light"), ["Light 2026"]);
		assert.deepEqual(await named("light", "VS Code Light"), ["Light 2026"]);
		assert.deepEqual(await named("dark", "Dark Modern"), ["Dark Modern"]);
	});

	it("identifies a theme by id, then label, then its file name with the extension, and takes the first contribution of an id", async () => {
		const byLabel: CodeThemeContribution = { extensionPath: EXT, label: "Label Name", uiTheme: "vs-dark", path: "./themes/dark.json" };
		const byFile: CodeThemeContribution = { extensionPath: EXT, uiTheme: "vs-dark", path: "./themes/two.json" };
		const both: CodeThemeContribution = { extensionPath: EXT, id: "the-id", label: "The Label", uiTheme: "vs-dark", path: "./themes/three.json" };
		const emptyId: CodeThemeContribution = { extensionPath: EXT, id: "", label: "Empty Id", uiTheme: "vs-dark", path: "./themes/four.json" };
		const pick = (name: string, ...contributions: CodeThemeContribution[]): Promise<CodeTheme[]> =>
			resolveAll(files, { themes: contributions, settings: { colorTheme: name } });
		assert.deepEqual((await pick("Label Name", byLabel)).map(theme => theme.id), ["Label Name"]);
		assert.deepEqual((await pick("two.json", byFile)).map(theme => theme.id), ["two.json"]);
		assert.deepEqual(await pick("two", byFile), []);
		assert.deepEqual((await pick("the-id", both)).map(theme => theme.id), ["the-id"]);
		assert.deepEqual(await pick("The Label", both), []);
		assert.deepEqual((await pick("Empty Id", emptyId)).map(theme => theme.id), ["Empty Id"]);
		const first = await pick("Demo Dark", DARK, { ...DARK, path: "./themes/two.json" });
		assert.deepEqual(scopesOf(first[0] ?? null), ["dark"]);
	});

	it("keeps a `%key%` label as written (VS Code has translated manifests already)", async () => {
		const localized: CodeThemeContribution = { extensionPath: EXT, label: "%theme.dark%", uiTheme: "vs-dark", path: "./themes/dark.json" };
		const withNls = { ...files, [`${EXT}/package.nls.json`]: { "theme.dark": "Localized Dark" } };
		assert.deepEqual((await resolveAll(withNls, { themes: [localized], settings: { colorTheme: "%theme.dark%" } })).map(theme => theme.id), ["%theme.dark%"]);
		assert.deepEqual(await resolveAll(withNls, { themes: [localized], settings: { colorTheme: "Localized Dark" } }), []);
	});

	it("produces output that parseCodeThemes accepts unchanged", async () => {
		const result = await resolveAll(files, { themes, settings: { colorTheme: "Demo Dark", preferredDark: "Demo Two" } });
		assert.deepEqual(parseCodeThemes(result), result);
	});
});

describe("resolveCodeThemes: tokenColorCustomizations", () => {
	const base = {
		[file("dark.json")]: { tokenColors: [{ scope: "theme", settings: { foreground: "#111111" } }] },
	};
	const customized = async (customizations: unknown, id = "Demo Dark"): Promise<CodeTheme | null> =>
		resolve(base, { customizations, themes: [{ ...DARK, id }], settings: settings({ colorTheme: id }) });

	it("expands every group shorthand in VS Code's order, a string as a colour and an object as settings", async () => {
		// Written in a different order than the workbench's, to prove the order is the fixed one.
		const theme = await customized({
			variables: "#070707",
			functions: { foreground: "#060606", fontStyle: "bold" },
			types: "#050505",
			numbers: "#040404",
			keywords: "#030303",
			strings: "#020202",
			comments: "#010101",
		});
		assert.deepEqual(theme?.rules.slice(1), [
			{ scopes: ["comment", "punctuation.definition.comment"], foreground: "#010101" },
			{ scopes: ["string", "meta.embedded.assembly"], foreground: "#020202" },
			{ scopes: ["keyword - keyword.operator", "keyword.control", "storage", "storage.type"], foreground: "#030303" },
			{ scopes: ["constant.numeric"], foreground: "#040404" },
			{ scopes: ["entity.name.type", "entity.name.class", "support.type", "support.class"], foreground: "#050505" },
			{ scopes: ["entity.name.function", "support.function"], foreground: "#060606", fontStyle: "bold" },
			{ scopes: ["variable", "entity.name.variable"], foreground: "#070707" },
		]);
		assert.equal(theme?.rules[0]?.foreground, "#111111", "the theme's own rules stay first");
	});

	it("appends textMateRules after the shorthands, splitting a string scope at commas but not an array's elements", async () => {
		const theme = await customized({
			textMateRules: [
				{ scope: "markup.bold, markup.italic", settings: { fontStyle: "bold italic" } },
				{ scope: ["a", "b", "c,d"], settings: { foreground: "#AABBCC" } },
				{ settings: { foreground: "#123456" } },
				{ scope: "no.settings" },
			],
			comments: "#010101",
		});
		assert.deepEqual(theme?.rules.slice(1), [
			{ scopes: ["comment", "punctuation.definition.comment"], foreground: "#010101" },
			{ scopes: ["markup.bold", "markup.italic"], fontStyle: "italic bold" },
			{ scopes: ["a", "b"], foreground: "#AABBCC" },
		]);
	});

	it("merges the global values and every matching [Theme] block first, then applies shorthands and textMateRules", async () => {
		const customizations = {
			textMateRules: [{ scope: "global.rule", settings: { foreground: "#000001" } }],
			strings: "#999999",
			comments: "#999998",
			"[Demo Dark]": { strings: "#AA0000", textMateRules: [{ scope: "exact.rule", settings: { foreground: "#000002" } }] },
			"[Demo*]": { numbers: "#BB0000" },
			"[*Dark]": { comments: "#CC0000" },
			"[*emo D*]": { textMateRules: [{ scope: "contains.rule", settings: { foreground: "#000003" } }] },
			"[Other][Demo Dark]": { types: "#EE0000", strings: "#AA0001" },
			"[Other Theme]": { functions: "#FF0000" },
			"[Demo]": { variables: "#FF1111" },
			"[Light*]": { keywords: "#FF2222" },
			"[Demo Dark]x": { keywords: "#FF4444" },
			"[Demo Dark ]": { variables: "#FF3333" },
		};
		const theme = await customized(customizations);
		assert.deepEqual(theme?.rules.slice(1), [
			{ scopes: ["comment", "punctuation.definition.comment"], foreground: "#CC0000" },
			{ scopes: ["string", "meta.embedded.assembly"], foreground: "#AA0001" },
			{ scopes: ["constant.numeric"], foreground: "#BB0000" },
			{ scopes: ["entity.name.type", "entity.name.class", "support.type", "support.class"], foreground: "#EE0000" },
			{ scopes: ["global.rule"], foreground: "#000001" },
			{ scopes: ["exact.rule"], foreground: "#000002" },
			{ scopes: ["contains.rule"], foreground: "#000003" },
		]);
	});

	it("ignores a [Theme] block that is not an object, and font family, size and line height", async () => {
		const theme = await customized({
			"[Demo Dark]": { textMateRules: [{ scope: "x", settings: { foreground: "#111111" } }], comments: "#222222" },
			"[Demo*]": "#333333",
			"[*]": [{ comments: "#444444" }],
			fontFamily: "Fira Code",
			fontSize: 14,
			lineHeight: 20,
		});
		assert.deepEqual(theme?.rules.slice(1).map(rule => rule.foreground), ["#222222", "#111111"]);
	});

	it("ignores customizations that are not an object", async () => {
		for (const value of [null, "#FFFFFF", 5, ["comments"]]) assert.deepEqual(scopesOf(await customized(value)), ["theme"]);
	});

	it("keeps rules in output order so a later rule of the same selector comes last", async () => {
		const theme = await customized({ textMateRules: [{ scope: "theme", settings: { foreground: "#222222" } }] });
		assert.deepEqual(theme?.rules.map(rule => rule.foreground), ["#111111", "#222222"]);
	});

	it("applies the customizations to each candidate under its own id", async () => {
		const two: CodeThemeContribution = { ...DARK, id: "Demo Two" };
		const result = await resolveAll(base, {
			themes: [DARK, two],
			settings: { colorTheme: "Demo Dark", preferredDark: "Demo Two" },
			customizations: { "[Demo Two]": { comments: "#ABCDEF" } },
		});
		assert.deepEqual(result.map(theme => theme.rules.length), [1, 2]);
	});
});

describe("resolveCodeThemes: normalisation and bounds", () => {
	const only = (rules: unknown[]): Record<string, unknown> => ({ [file("dark.json")]: { tokenColors: rules } });

	it("keeps foreground only as a hex colour and reduces fontStyle to the four known words", async () => {
		const theme = await resolve(
			only([
				{ scope: "a", settings: { foreground: "#abc", fontStyle: "bold  italic" } },
				{ scope: "b", settings: { foreground: "red", fontStyle: "underline" } },
				{ scope: "c", settings: { foreground: "#12345", fontStyle: "bold wiggle" } },
				{ scope: "d", settings: { foreground: "#11223344", fontStyle: "" } },
				{ scope: "e", settings: { fontStyle: "strikethrough" } },
				{ scope: "f", settings: { foreground: 5, fontStyle: 3 } },
				{ scope: "g", settings: { foreground: "rgb(0,0,0)" } },
				{ scope: "h", settings: { fontStyle: "normal" } },
			]),
		);
		assert.deepEqual(theme?.rules, [
			{ scopes: ["a"], foreground: "#abc", fontStyle: "italic bold" },
			{ scopes: ["b"], fontStyle: "underline" },
			{ scopes: ["c"], fontStyle: "bold" },
			{ scopes: ["d"], foreground: "#11223344", fontStyle: "" },
			{ scopes: ["e"], fontStyle: "strikethrough" },
			{ scopes: ["h"], fontStyle: "" },
		]);
	});

	it("splits a string scope at commas, trims it, drops empty and invalid selectors, and keeps descendant and exclusion selectors", async () => {
		const theme = await resolve(
			only([
				{ scope: " a , b ,, c.d ", settings: { foreground: "#111111" } },
				{ scope: "keyword - keyword.operator", settings: { foreground: "#222222" } },
				{ scope: "source.css variable", settings: { foreground: "#333333" } },
				{ scope: ["ok", "bad\"quote", "x".repeat(201), 7], settings: { foreground: "#444444" } },
				{ scope: "<<'", settings: { foreground: "#555555" } },
				{ scope: "  ", settings: { foreground: "#666666" } },
			]),
		);
		assert.deepEqual(theme?.rules, [
			{ scopes: ["a", "b", "c.d"], foreground: "#111111" },
			{ scopes: ["keyword - keyword.operator"], foreground: "#222222" },
			{ scopes: ["source.css variable"], foreground: "#333333" },
			{ scopes: ["ok"], foreground: "#444444" },
		]);
	});

	it("splits a rule of more than 64 selectors into several rules in order", async () => {
		const scope = Array.from({ length: 130 }, (_, index) => `s${index}`);
		const theme = await resolve(only([{ scope, settings: { foreground: "#111111", fontStyle: "bold" } }]));
		assert.deepEqual(theme?.rules.map(rule => rule.scopes.length), [MAX_CODE_THEME_SCOPES_PER_RULE, MAX_CODE_THEME_SCOPES_PER_RULE, 2]);
		assert.deepEqual(scopesOf(theme), scope);
		assert.ok(theme?.rules.every(rule => rule.foreground === "#111111" && rule.fontStyle === "bold"));
	});

	it("omits a theme of more than 1500 rules and accepts exactly 1500", async () => {
		const rule = (index: number): unknown => ({ scope: `s${index}`, settings: { foreground: "#111111" } });
		const exact = Array.from({ length: MAX_CODE_THEME_RULES }, (_, index) => rule(index));
		assert.equal((await resolve(only(exact)))?.rules.length, MAX_CODE_THEME_RULES);
		assert.equal(await resolve(only([...exact, rule(MAX_CODE_THEME_RULES)])), null);
	});

	it("omits a theme whose serialised form exceeds 96 KiB", async () => {
		// 20 rules of 64 selectors of about 155 characters is about 200 KB: over the output bound, under the 1 MiB file bound and the rule bound.
		const long = (index: number): string => `${"x".repeat(150)}${index}`;
		const rules = Array.from({ length: 20 }, (_, rule) => ({
			scope: Array.from({ length: 64 }, (_, selector) => long(rule * 64 + selector)),
			settings: { foreground: "#111111" },
		}));
		assert.ok(JSON.stringify(rules).length > MAX_CODE_THEME_JSON_BYTES);
		assert.equal(await resolve(only(rules)), null);
	});

	it("omits a theme whose id is over the id bound", async () => {
		const id = "n".repeat(201);
		assert.deepEqual(await resolveAll(only([{ scope: "a", settings: { foreground: "#111111" } }]), { themes: [{ ...DARK, id }], settings: settings({ colorTheme: id }) }), []);
	});
});

describe("resolveCodeThemes: the real Dark Modern files", () => {
	const dir = process.env.OMP_VSCODE_THEMES_DIR;
	it("resolves Dark Modern through its include chain (set OMP_VSCODE_THEMES_DIR to the theme-defaults extension folder)", { skip: dir === undefined }, async () => {
		const manifest = JSON.parse(await readFile(`${dir}/package.json`, "utf8")) as { contributes: { themes: { id?: string; label: string; uiTheme: string; path: string }[] } };
		const themes = manifest.contributes.themes.map(theme => ({ ...theme, extensionPath: dir! }));
		const result = await resolveCodeThemes({
			kind: "dark",
			settings: { colorTheme: "Default Dark Modern", preferredDark: "Dark+", preferredLight: "Light Modern" },
			customizations: undefined,
			themes,
			readFile: async path => {
				try {
					return await readFile(path, "utf8");
				} catch {
					return null;
				}
			},
			fileSize: async path => {
				try {
					const info = await stat(path);
					return info.isFile() ? info.size : null;
				} catch {
					return null;
				}
			},
		});
		assert.deepEqual(result.map(theme => theme.id), ["Dark Modern", "Dark+"]);
		const modern = result[0]!;
		assert.ok(modern.rules.length > 20);
		assert.ok(modern.rules.some(rule => rule.scopes.includes("string") && rule.foreground !== undefined));
		assert.deepEqual(parseCodeThemes(result), result);
	});
});
