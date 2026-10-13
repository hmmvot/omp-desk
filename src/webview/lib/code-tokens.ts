/**
 * Source text to tokens with TextMate scopes.
 *
 * highlight.js finds the tokens; this module names them the way VS Code's TextMate grammar for the same
 * language does (`keyword.control.ts`, `entity.name.function.ts`, `support.type.property-name.json`), so the
 * editor theme's rules (`code-theme-style.ts`) apply to them. The words highlight.js leaves unmarked
 * (variables, member names, called functions, types, shell commands) are told apart by the characters
 * around them. This is an approximation of the grammar, not a second grammar: a theme rule for a scope
 * this module does not report does not apply, and a word it classifies differently is coloured as such.
 *
 * The spans always cover the whole source: concatenated, their text is the source.
 */
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { LANGUAGES, languageId, type CodeLanguage, type WordStrategy } from "./code-languages.ts";

/** A run of source text and the scopes it has, outermost first (the language's root scope is the first). */
export interface CodeSpan {
	readonly text: string;
	readonly scopes: readonly string[];
}

const ENGINES: Readonly<Record<string, LanguageFn>> = { bash, cpp, csharp, css, diff, go, javascript, json, markdown, powershell, python, rust, typescript, xml, yaml };
const registered = new Set<string>();

/** Register one engine language (and the languages an HTML document embeds); false when it is not one we ship. */
function engineFor(name: string): boolean {
	if (registered.has(name)) return true;
	const definition = Object.hasOwn(ENGINES, name) ? ENGINES[name] : undefined;
	if (definition === undefined) return false;
	hljs.registerLanguage(name, definition);
	registered.add(name);
	if (name === "xml") {
		engineFor("css");
		engineFor("javascript");
	}
	return true;
}

interface RawSpan {
	readonly text: string;
	/** The `class` attribute of each enclosing highlight.js span, outermost first. */
	readonly classes: readonly string[];
}

const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };
const HTML_PART = /<span class="([^"]*)">|<\/span>|([^<]+)/g;

/** The spans of highlight.js's escaped HTML output (`<span class="…">` and text only). */
function rawSpans(html: string): RawSpan[] {
	const spans: RawSpan[] = [];
	const open: string[] = [];
	for (const part of html.matchAll(HTML_PART)) {
		if (part[1] !== undefined) open.push(part[1]);
		else if (part[2] === undefined) open.pop();
		else spans.push({ text: part[2].replace(/&(?:amp|lt|gt|quot|#x27);/g, entity => ENTITIES[entity] as string), classes: [...open] });
	}
	return spans;
}

interface Level {
	readonly base: string;
	readonly modifiers: readonly string[];
}

function levelOf(attribute: string): Level {
	const [first = "", ...modifiers] = attribute.split(" ");
	return { base: first.replace(/^hljs-/, ""), modifiers };
}

/** The characters around a token, on its own line. */
interface Around {
	readonly source: string;
	readonly start: number;
	readonly end: number;
	/** The nearest non-blank character before the token on its line, `""` at the start of the line. */
	readonly before: string;
	/** The nearest non-blank character after the token on its line. */
	readonly after: string;
	/** The word before the token when only blanks separate them. */
	readonly previousWord: string;
	/** The text of the token's line before the token. */
	readonly lineBefore: string;
}

function around(source: string, start: number, end: number): Around {
	const lineStart = source.lastIndexOf("\n", start - 1) + 1;
	const lineBefore = source.slice(lineStart, start);
	const trimmed = lineBefore.trimEnd();
	const lineEnd = source.indexOf("\n", end);
	const lineAfter = source.slice(end, lineEnd < 0 ? source.length : lineEnd).trimStart();
	return {
		source, start, end, lineBefore,
		before: trimmed.at(-1) ?? "",
		after: lineAfter[0] ?? "",
		previousWord: trimmed.length < lineBefore.length ? (/([A-Za-z_$][\w$]*)$/.exec(trimmed)?.[1] ?? "") : "",
	};
}

const PASCAL = /^[A-Z]/;
const ALL_CAPS = /^[A-Z][A-Z0-9_]+$/;
/** `<…>` that closes before a `(` : a generic call or declaration. */
const GENERIC_CALL = /^<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>\s*\(/;

const SCRIPT_LANGUAGE_VARIABLES: Readonly<Record<string, true>> = { this: true, super: true, self: true, cls: true };

/** A word highlight.js left unmarked, by the language's strategy; `null` when the grammar leaves it unscoped. */
function wordScope(strategy: WordStrategy, word: string, near: Around, inParameters: boolean): string | null {
	const { before, after, previousWord } = near;
	switch (strategy) {
		case "script": {
			if (previousWord === "function" && before !== ".") return "entity.name.function";
			if (previousWord === "const") return "variable.other.constant";
			if (after === "(") return "entity.name.function";
			if (before === ".") return "variable.other.property";
			if (ALL_CAPS.test(word)) return after === "." ? "variable.other.constant.object" : "variable.other.constant";
			if (PASCAL.test(word)) return after === "." ? "variable.other.object" : "entity.name.type";
			return inParameters ? "variable.parameter" : "variable.other.readwrite";
		}
		case "csharp": {
			if (PASCAL.test(word) && /^\s*(?:using|namespace)\b/.test(near.lineBefore)) return "entity.name.type.namespace";
			if (after === "(" || (after === "<" && PASCAL.test(word) && GENERIC_CALL.test(near.source.slice(near.end).trimStart()))) return "entity.name.function";
			if (before === ".") return "variable.other.property";
			if (PASCAL.test(word)) {
				if (after === ".") return /^\s*(?:using|namespace)\b/.test(near.lineBefore) ? "entity.name.type.namespace" : "variable.other.object";
				return "entity.name.type";
			}
			return "variable.other.readwrite";
		}
		case "go": {
			if (previousWord === "package") return "entity.name.type.package";
			if (previousWord === "const") return "variable.other.constant";
			if (after === "(") return "entity.name.function";
			if (before === ".") return "variable.other.property";
			return PASCAL.test(word) ? "entity.name.type" : "variable.other.readwrite";
		}
		case "cpp": {
			if (after === "(") return "entity.name.function";
			if (after === ":" && near.source[near.end] === ":") return "entity.name.scope-resolution";
			if (before === ":" && near.source[near.start - 2] === ":") {
				if (after === "<" && GENERIC_CALL.test(near.source.slice(near.end).trimStart())) return "entity.name.function";
				return after === "<" ? "entity.name.type" : "variable.other.readwrite";
			}
			if (before === "." || (before === ">" && near.source[near.start - 2] === "-")) return "variable.other.property";
			return PASCAL.test(word) ? "entity.name.type" : "variable.other.readwrite";
		}
		case "rust": {
			if (after === "!") return "entity.name.function.macro";
			if (after === "(") return PASCAL.test(word) ? "entity.name.type" : "entity.name.function";
			if (after === ":" && near.source[near.end] === ":") return "entity.name.namespace";
			if (PASCAL.test(word)) return "entity.name.type";
			return null;
		}
		case "python": {
			if (/(?:Error|Exception|Warning)$/.test(word)) return "support.type.exception";
			if (inParameters) return "variable.parameter.function.language";
			if ((before === "(" || before === ",") && after === "=" && near.source.slice(near.end).trimStart()[1] !== "=") return "variable.parameter.function-call";
			return null;
		}
		default:
			return null;
	}
}

const SHELL_COMMAND_STARTS = "\0;|&({`)";
const SHELL_COMMAND_WORDS: Readonly<Record<string, true>> = { then: true, do: true, else: true, elif: true, if: true, while: true, until: true };

/** Shell words highlight.js left unmarked: options, commands, assignments and arguments. */
function shellScope(word: string, near: Around): string | null {
	if (/^\d+$/.test(word)) return "constant.numeric.integer";
	if (word.startsWith("-")) return "constant.other.option.dash";
	const commandPosition = near.before === "" || SHELL_COMMAND_STARTS.includes(near.before) || Object.hasOwn(SHELL_COMMAND_WORDS, near.previousWord);
	if (near.source[near.end] === "=" && commandPosition) return "variable.other.assignment";
	if (/\[\[?\s[^\]]*$/.test(near.lineBefore)) return word.startsWith("-") || /^(?:true|false)$/.test(word) ? null : "string.unquoted.argument";
	return commandPosition ? "entity.name.function" : "string.unquoted.argument";
}

/** Whether the position is inside a CSS declaration's value (after `:` inside braces). */
function inCssValue(near: Around): boolean {
	const head = near.source.slice(0, near.start);
	const open = head.lastIndexOf("{");
	const close = head.lastIndexOf("}");
	if (open < 0 || open < close) return false;
	const declaration = head.slice(open + 1);
	const colon = declaration.lastIndexOf(":");
	return colon >= 0 && colon > declaration.lastIndexOf(";");
}

function cssScope(word: string, near: Around): string | null {
	if (/^-?(?:\d*\.\d+|\d+)/.test(word)) return "constant.numeric";
	if (word.startsWith("--")) return "variable.argument";
	if (near.after === "(" && near.source[near.end] === "(") return "support.function.misc";
	return inCssValue(near) ? "support.constant.property-value" : null;
}

/** `string.quoted.double`, `string.quoted.single`, `string.template` or a YAML plain scalar: the names themes write rules for. */
function stringScope(suffix: string, text: string, near: Around, inDirective: boolean): string {
	if (inDirective) return "string";
	const quote = /^[A-Za-z]{0,2}("""|'''|["'`])/.exec(text)?.[1];
	if (quote === undefined) return suffix === "yaml" ? (/\[[^\]]*$/.test(near.lineBefore) ? "string.unquoted.plain.in" : "string.unquoted.plain.out") : "string.quoted";
	if (quote === "`") return "string.template";
	return quote.startsWith('"') ? "string.quoted.double" : "string.quoted.single";
}

/** The scopes of an `omp` unmarked-text word by strategy; separate from `wordScope` because these strategies tokenize differently. */
const UNMARKED: Readonly<Record<WordStrategy, RegExp | null>> = {
	script: /(=>)|([A-Za-z_$][\w$]*)/g,
	csharp: /[A-Za-z_][\w]*/g,
	go: /[A-Za-z_][\w]*/g,
	cpp: /[A-Za-z_][\w]*/g,
	rust: /[A-Za-z_][\w]*/g,
	python: /[A-Za-z_][\w]*/g,
	shell: /--?[A-Za-z][\w-]*|\d+|[A-Za-z_][\w./-]*/g,
	powershell: null,
	css: /-?(?:\d*\.\d+|\d+)[a-z%]*|--[\w-]+|[A-Za-z][\w-]*(?=\()|[A-Za-z][\w-]*/g,
	none: null,
};

function builtinScope(language: CodeLanguage, text: string, near: Around): string | null {
	if (Object.hasOwn(language.builtins, text)) return language.builtins[text] as string;
	if (Object.hasOwn(language.keywords, text)) return language.keywords[text] as string;
	switch (language.suffix) {
		case "python":
			if (/(?:Error|Exception|Warning)$/.test(text)) return "support.type.exception";
			return PASCAL.test(text) ? null : "support.function.builtin";
		case "powershell":
			return "support.function";
		case "shell":
			return "support.function.builtin";
		case "go":
			return PASCAL.test(text) ? "entity.name.type" : "support.function";
		case "html":
		case "markdown":
			return null;
		default:
			if (PASCAL.test(text)) return near.after === "." ? (ALL_CAPS.test(text) ? "variable.other.constant.object" : "variable.other.object") : "support.class";
			return "support.function";
	}
}

/** TextMate scope (without the language suffix) of one highlight.js level, or `null` when it names nothing a theme colours. */
function scopeOf(language: CodeLanguage, level: Level, text: string, enclosing: readonly Level[], near: Around): string | null {
	const { base, modifiers } = level;
	const suffix = language.suffix;
	switch (base) {
		case "comment":
			if (suffix === "diff") return /^(?:diff|---|\+\+\+)/.test(text) ? "meta.diff.header" : null;
			return "comment";
		case "doctag":
			return suffix === "ts" || suffix === "tsx" || suffix === "js" ? "storage.type.class.jsdoc" : "keyword.other";
		case "keyword": {
			if (suffix === "html") return "entity.other.attribute-name";
			if (suffix === "css") return "keyword.control.at-rule";
			if (enclosing.some(parent => parent.base === "meta")) return "keyword.control.directive";
			if (suffix === "python" && text === "in" && /\bfor\b[^:]*$/.test(near.lineBefore)) return "keyword.control.flow";
			const key = language.caseInsensitive === true ? text.toLowerCase() : text;
			return Object.hasOwn(language.keywords, key) ? (language.keywords[key] as string) : "keyword.other";
		}
		case "literal":
			if (suffix === "powershell" && text.startsWith("-")) return "keyword.operator";
			if (suffix === "shell") return "support.function.builtin";
			if (suffix === "rust" && text === "None") return "entity.name.type";
			return "constant.language";
		case "number":
			return suffix === "css" && text.startsWith("#") ? "constant.other.color.rgb-value.hex" : "constant.numeric";
		case "string":
			return stringScope(suffix, text, near, enclosing.some(parent => parent.base === "meta"));
		case "char":
			return modifiers.includes("escape_") ? "constant.character.escape" : "constant.character";
		case "regexp":
			return "string.regexp";
		case "subst":
			return "meta.template.expression";
		case "built_in":
		case "type":
			if (suffix === "powershell" && near.before === "[" && near.after === "]") return "storage.type";
			return builtinScope(language, text, near);
		case "title": {
			if (modifiers.includes("inherited__")) return "entity.other.inherited-class";
			const function_ = modifiers.includes("function_") || modifiers.includes("invoke__");
			if (suffix === "rust" && PASCAL.test(text)) return "entity.name.type";
			if (suffix === "powershell") return "entity.name.function";
			if (function_) return "entity.name.function";
			// highlight.js calls every capitalised name a class; it is a call, a qualifier or a type by what follows.
			if (near.after === "(") return "entity.name.function";
			if (suffix === "cs" || suffix === "cpp" || suffix === "c" || suffix === "go") {
				if (!modifiers.includes("class_")) return wordScope(language.words, text, near, false) ?? "entity.name.type";
			}
			if (suffix === "ts" || suffix === "tsx" || suffix === "js") {
				if (near.after === ".") return ALL_CAPS.test(text) ? "variable.other.constant.object" : "variable.other.object";
				if (modifiers.includes("class_") && !/^(?:class|interface|enum|extends|implements|type|new)$/.test(near.previousWord) && near.before !== ":" && near.before !== "<" && near.before !== "|" && near.before !== "&" && near.before !== "," && near.before !== "(") return wordScope(language.words, text, near, false) ?? "entity.name.type.class";
			}
			return modifiers.includes("class_") ? "entity.name.type.class" : "entity.name.type";
		}
		case "attr":
			switch (suffix) {
				case "json": return "support.type.property-name";
				case "yaml": return "entity.name.tag";
				case "html":
				case "css": return "entity.other.attribute-name";
				default: return "variable.other.property";
			}
		case "attribute":
			return suffix === "css" ? "support.type.property-name" : "entity.other.attribute-name";
		case "variable":
			if (suffix === "shell") return "variable.other.normal";
			if (suffix === "powershell" && /^\$(?:null|true|false)$/i.test(text)) return "constant.language";
			if (modifiers.includes("language_")) return Object.hasOwn(SCRIPT_LANGUAGE_VARIABLES, text) ? "variable.language" : "variable.other.object";
			if (modifiers.includes("constant_")) return "variable.other.constant";
			return "variable.other.readwrite";
		case "template-variable":
			return "variable.other.readwrite";
		case "property":
			return "variable.other.property";
		case "meta":
			switch (suffix) {
				case "python": return "entity.name.function.decorator";
				case "rust": return "entity.other.attribute";
				case "diff": return "meta.diff.range";
				case "yaml": return "entity.name.type.anchor";
				case "html": return "punctuation.definition.tag";
				case "shell": return "comment.line.shebang";
				case "cs": return text.startsWith("[") ? "entity.name.type" : "meta.preprocessor";
				default: return "meta.preprocessor";
			}
		case "name":
		case "selector-tag":
			return "entity.name.tag";
		case "selector-id":
			return "entity.other.attribute-name.id";
		case "selector-class":
			return "entity.other.attribute-name.class";
		case "selector-attr":
			return "entity.other.attribute-name";
		case "selector-pseudo":
			return "entity.other.attribute-name.pseudo-class";
		case "section":
			return "markup.heading";
		case "bullet":
			return suffix === "markdown" ? "punctuation.definition.list.begin" : "punctuation.definition.sequence.item";
		case "strong":
			return "markup.bold";
		case "emphasis":
			return "markup.italic";
		case "code":
			return "markup.inline.raw";
		case "quote":
			return "markup.quote";
		case "link":
			return "markup.underline.link";
		case "addition":
			return "markup.inserted";
		case "deletion":
			return "markup.deleted";
		case "symbol":
			if (suffix === "html") return "constant.character.entity";
			return suffix === "rust" ? "storage.modifier.lifetime" : "constant.other.symbol";
		default:
			return null;
	}
}

/** highlight.js spans that only group other tokens: the text directly in them is classified by this module. */
const CONTAINERS = ["params", "function", "class", "subst", "tag"];
const TAG_PUNCTUATION = /[<>/]+/g;
const TEMPLATE_EDGES = /\$\{|\}|\{|\}/g;

/** Tokenize `source` as the language `info` names (`ts`, `py`, `c#` …); `null` when it is none we highlight. */
export function tokenize(source: string, info: string): CodeSpan[] | null {
	const id = languageId(info);
	const language = id === null ? undefined : LANGUAGES[id];
	if (language === undefined || !engineFor(language.engine)) return null;
	let html: string;
	try {
		html = hljs.highlight(source, { language: language.engine, ignoreIllegals: true }).value;
	} catch {
		return [{ text: source, scopes: [language.root] }];
	}

	const spans: CodeSpan[] = [];
	const push = (text: string, scopes: readonly string[]): void => {
		if (text === "") return;
		const last = spans.at(-1);
		if (last !== undefined && last.scopes.length === scopes.length && last.scopes.every((scope, index) => scope === scopes[index])) {
			spans[spans.length - 1] = { text: last.text + text, scopes: last.scopes };
		} else {
			spans.push({ text, scopes });
		}
	};

	let offset = 0;
	for (const raw of rawSpans(html)) {
		const near = around(source, offset, offset + raw.text.length);
		const levels = raw.classes.map(levelOf);
		const scopes: string[] = [language.root];
		let active = language;
		let inTag = false;
		let inSubstitution = false;
		for (const [index, level] of levels.entries()) {
			if (level.base.startsWith("language-")) {
				// A sub-language the document embeds (CSS and JavaScript in HTML): its own root and words.
				const embedded = LANGUAGES[level.base === "language-javascript" ? "js" : level.base.slice("language-".length)];
				if (embedded !== undefined) { active = embedded; scopes.push(embedded.root); }
				continue;
			}
			if (level.base === "tag") inTag = true;
			if (level.base === "subst") inSubstitution = true;
			const scope = scopeOf(active, level, raw.text, levels.slice(0, index), near);
			if (scope !== null) scopes.push(`${scope}.${active.suffix}`);
		}

		const strategy = active.words;
		// Text no highlight.js token claims sits directly in a container (or in no span): its words are classified here.
		const innermost = levels.at(-1)?.base;
		const unmarked = innermost === undefined || CONTAINERS.includes(innermost) || innermost.startsWith("language-");
		if (!unmarked) {
			if (active.suffix === "yaml" && innermost === "attr" && raw.text.endsWith(":")) {
				// A YAML key's colon is punctuation, not part of the key.
				push(raw.text.slice(0, -1), scopes);
				push(":", scopes.slice(0, -1));
			} else {
				push(raw.text, scopes);
			}
		} else if (inTag) {
			let at = 0;
			for (const run of raw.text.matchAll(TAG_PUNCTUATION)) {
				push(raw.text.slice(at, run.index), scopes);
				push(run[0], [...scopes, `punctuation.definition.tag.${active.suffix}`]);
				at = run.index + run[0].length;
			}
			push(raw.text.slice(at), scopes);
		} else {
			const pattern = UNMARKED[strategy];
			const inParameters = levels.some(level => level.base === "params");
			let at = 0;
			if (inSubstitution && (active.suffix === "ts" || active.suffix === "tsx" || active.suffix === "js")) {
				// `${expr}` of a template literal: the delimiters are punctuation, the expression is code.
				for (const edge of raw.text.matchAll(TEMPLATE_EDGES)) {
					at = pushWords(raw.text, at, edge.index, scopes, pattern, strategy, source, offset, inParameters, active, push);
					push(edge[0], [...scopes, `punctuation.definition.template-expression.${edge[0] === "${" ? "begin" : "end"}.${active.suffix}`]);
					at = edge.index + edge[0].length;
				}
			} else if (inSubstitution && active.suffix === "python") {
				for (const edge of raw.text.matchAll(TEMPLATE_EDGES)) {
					push(raw.text.slice(at, edge.index), scopes);
					push(edge[0], [...scopes, `constant.character.format.placeholder.other.${active.suffix}`]);
					at = edge.index + edge[0].length;
				}
				push(raw.text.slice(at), scopes);
				offset += raw.text.length;
				continue;
			}
			pushWords(raw.text, at, raw.text.length, scopes, pattern, strategy, source, offset, inParameters, active, push);
		}
		offset += raw.text.length;
	}
	return spans;
}

/** Classify the unmarked words of `text[from..to)`; returns `to`. */
function pushWords(
	text: string, from: number, to: number, scopes: readonly string[], pattern: RegExp | null, strategy: WordStrategy,
	source: string, offset: number, inParameters: boolean, language: CodeLanguage, push: (text: string, scopes: readonly string[]) => void,
): number {
	const part = text.slice(from, to);
	if (pattern === null) {
		push(part, scopes);
		return to;
	}
	let at = 0;
	for (const match of part.matchAll(new RegExp(pattern.source, "g"))) {
		const word = match[0];
		const start = offset + from + match.index;
		push(part.slice(at, match.index), scopes);
		const near = around(source, start, start + word.length);
		let scope: string | null;
		if (strategy === "script" && match[1] !== undefined) scope = "storage.type.function.arrow";
		else if (strategy === "shell") scope = shellScope(word, near);
		else if (strategy === "css") scope = cssScope(word, near);
		else if (strategy !== "none" && Object.hasOwn(language.builtins, word) && !(language.suffix === "python" && near.after === "[")) scope = language.builtins[word] as string;
		else scope = wordScope(strategy, word, near, inParameters);
		push(word, scope === null ? scopes : [...scopes, `${scope}.${language.suffix}`]);
		at = match.index + word.length;
	}
	push(part.slice(at), scopes);
	return to;
}
