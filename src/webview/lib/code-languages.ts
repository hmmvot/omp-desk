/**
 * The languages fenced code is highlighted in, and what their words are called in TextMate.
 *
 * The tokenizer (highlight.js, `code-tokens.ts`) knows a keyword is a keyword; the editor theme tells
 * `if` (`keyword.control`) from `const` (`storage.type`) from `public` (`storage.modifier`), so each
 * language names its word families here, with the scope names the language's grammar in VS Code uses.
 * A keyword that is in no family is a plain `keyword.other`.
 */

/** How the words highlight.js leaves unmarked (variables, member names, calls, types) are told apart. */
export type WordStrategy = "script" | "csharp" | "go" | "cpp" | "rust" | "python" | "shell" | "powershell" | "css" | "none";

export interface CodeLanguage {
	/** TextMate language suffix of every scope (`keyword.control.ts`). */
	readonly suffix: string;
	/** The outermost scope of a token of this language. */
	readonly root: string;
	/** highlight.js language the source is tokenized with. */
	readonly engine: string;
	/** Text of a highlight.js `keyword` token to its scope (without suffix); keywords not listed are `keyword.other`. */
	readonly keywords: Readonly<Record<string, string>>;
	/** Text of a `built_in` or `type` token to its scope; other such text is told apart by the language's strategy. */
	readonly builtins: Readonly<Record<string, string>>;
	readonly words: WordStrategy;
	/** Keywords are matched without regard to case (PowerShell). */
	readonly caseInsensitive?: true;
}

/** `{ "keyword.control": "if else" }` as `{ if: "keyword.control", else: "keyword.control" }`. */
function table(families: Readonly<Record<string, string>>): Record<string, string> {
	const words: Record<string, string> = Object.create(null) as Record<string, string>;
	for (const [scope, list] of Object.entries(families)) for (const word of list.split(" ")) words[word] = scope;
	return words;
}

const NONE = table({});

const SCRIPT_KEYWORDS = table({
	"keyword.control.conditional": "if else",
	"keyword.control.switch": "switch case default",
	"keyword.control.loop": "for while do break continue",
	"keyword.control.flow": "return await yield",
	"keyword.control.trycatch": "throw try catch finally",
	"keyword.control.import": "import",
	"keyword.control.export": "export",
	"keyword.control.from": "from",
	"keyword.control.as": "as",
	"keyword.control.type": "type",
	"keyword.operator.expression": "typeof instanceof in of delete void is keyof infer satisfies asserts",
	"keyword.operator.new": "new",
	"storage.type": "const let var function class interface enum namespace module get set constructor",
	"storage.modifier": "abstract async declare extends implements override private protected public readonly static accessor",
	"keyword.other.debugger": "debugger",
	"keyword.control.with": "with",
});
const SCRIPT_BUILTINS = table({
	"support.type.primitive": "string number boolean any unknown never void object symbol bigint undefined",
});

const PYTHON_KEYWORDS = table({
	"keyword.control.flow": "if elif else for while break continue return try except finally raise with yield await assert pass",
	"keyword.control.import": "import from",
	"keyword.control.as": "as",
	"keyword.operator.logical": "and or not in is",
	"storage.type.function": "def lambda async",
	"storage.type.class": "class",
	"storage.modifier.declaration": "global nonlocal",
	"keyword.other": "del exec match case",
});
const PYTHON_BUILTINS = table({
	"support.type": "int float str bool list dict set tuple frozenset bytes bytearray object type complex",
	"variable.parameter.function.language.special.self": "self cls",
});

const CSHARP_KEYWORDS = table({
	"keyword.control.conditional": "if else switch case default",
	"keyword.control.loop": "for foreach while do break continue",
	"keyword.control.flow": "return throw yield goto",
	"keyword.control.trycatch": "try catch finally",
	"keyword.other.using": "using",
	"keyword.other.namespace": "namespace",
	"keyword.other.new": "new",
	"storage.type.class": "class",
	"storage.type.struct": "struct",
	"storage.type.interface": "interface",
	"storage.type.enum": "enum",
	"storage.type.delegate": "delegate",
	"storage.type.record": "record",
	"storage.type.event": "event",
	"storage.modifier": "public private protected internal static readonly abstract sealed virtual override async partial const volatile extern unsafe ref out in params this base operator implicit explicit required init",
	"keyword.type": "int uint long ulong short ushort byte sbyte char float double decimal bool string object void nint nuint",
	"storage.type.var": "var dynamic",
	"keyword.operator.expression": "is as typeof sizeof nameof await",
	"keyword.other.where": "where select from let group into orderby join on equals by ascending descending",
	"keyword.other.get": "get set add remove",
	"keyword.control.context": "lock",
	"keyword.other.fixed": "fixed checked unchecked stackalloc",
});
const CSHARP_BUILTINS = table({
	"keyword.type": "int uint long ulong short ushort byte sbyte char float double decimal bool string object void nint nuint",
});

const POWERSHELL_KEYWORDS = table({
	"keyword.control": "if elseif else switch for foreach while do until break continue return throw try catch finally trap exit begin process end in param",
	"storage.type": "function filter workflow class enum",
	"keyword.operator.word": "and or not xor is isnot as",
});

const SHELL_KEYWORDS = table({
	"keyword.control": "if then elif else fi for while until do done case esac in select function return break continue exit",
});

const RUST_KEYWORDS = table({
	"keyword.control": "if else match for while loop break continue return in await yield",
	"keyword.other": "use mod crate super self as where unsafe dyn move ref box extern",
	"storage.type": "fn let struct enum trait impl type const static mut union",
	"storage.modifier": "pub async",
});
const RUST_BUILTINS = table({
	"entity.name.type.primitive": "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str",
});

const GO_KEYWORDS = table({
	"keyword.control": "if else for range switch case default select return break continue goto go defer fallthrough",
	"keyword.package": "package",
	"keyword.control.import": "import",
	"storage.type": "func var const type struct interface map chan",
});
const GO_BUILTINS = table({
	"storage.type.numeric": "int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128",
	"storage.type.string": "string",
	"storage.type.boolean": "bool",
	"storage.type.byte": "byte",
	"storage.type.rune": "rune",
	"storage.type.error": "error",
	"support.function.builtin": "append cap close complex copy delete imag len make new panic print println real recover",
});

const CPP_KEYWORDS = table({
	"keyword.control": "if else for while do switch case default break continue return goto try catch throw co_return co_await co_yield",
	"storage.type": "class struct enum union typename template typedef using namespace auto decltype",
	"storage.modifier": "public private protected static const constexpr consteval constinit inline virtual override final explicit extern mutable volatile register noexcept friend export thread_local",
	"keyword.operator.new": "new delete",
	"keyword.operator.sizeof": "sizeof alignof typeid alignas",
	"keyword.operator.cast": "static_cast dynamic_cast const_cast reinterpret_cast",
});
const CPP_BUILTINS = table({
	"storage.type.primitive": "int long short char float double bool void signed unsigned size_t wchar_t",
});

function language(suffix: string, root: string, engine: string, keywords: Readonly<Record<string, string>>, builtins: Readonly<Record<string, string>>, words: WordStrategy, caseInsensitive = false): CodeLanguage {
	return { suffix, root, engine, keywords, builtins, words, ...(caseInsensitive ? { caseInsensitive: true as const } : {}) };
}

/** Canonical language by id. */
export const LANGUAGES: Readonly<Record<string, CodeLanguage>> = {
	ts: language("ts", "source.ts", "typescript", SCRIPT_KEYWORDS, SCRIPT_BUILTINS, "script"),
	tsx: language("tsx", "source.tsx", "typescript", SCRIPT_KEYWORDS, SCRIPT_BUILTINS, "script"),
	js: language("js", "source.js", "javascript", SCRIPT_KEYWORDS, SCRIPT_BUILTINS, "script"),
	json: language("json", "source.json", "json", NONE, NONE, "none"),
	python: language("python", "source.python", "python", PYTHON_KEYWORDS, PYTHON_BUILTINS, "python"),
	cs: language("cs", "source.cs", "csharp", CSHARP_KEYWORDS, CSHARP_BUILTINS, "csharp"),
	powershell: language("powershell", "source.powershell", "powershell", POWERSHELL_KEYWORDS, NONE, "powershell", true),
	shell: language("shell", "source.shell", "bash", SHELL_KEYWORDS, NONE, "shell"),
	html: language("html", "text.html.derivative", "xml", NONE, NONE, "none"),
	css: language("css", "source.css", "css", NONE, NONE, "css"),
	markdown: language("markdown", "text.html.markdown", "markdown", NONE, NONE, "none"),
	yaml: language("yaml", "source.yaml", "yaml", NONE, NONE, "none"),
	diff: language("diff", "source.diff", "diff", NONE, NONE, "none"),
	rust: language("rust", "source.rust", "rust", RUST_KEYWORDS, RUST_BUILTINS, "rust"),
	go: language("go", "source.go", "go", GO_KEYWORDS, GO_BUILTINS, "go"),
	cpp: language("cpp", "source.cpp", "cpp", CPP_KEYWORDS, CPP_BUILTINS, "cpp"),
	c: language("c", "source.c", "cpp", CPP_KEYWORDS, CPP_BUILTINS, "cpp"),
};

const ALIASES: Readonly<Record<string, string>> = {
	ts: "ts", typescript: "ts", mts: "ts", cts: "ts",
	tsx: "tsx",
	js: "js", javascript: "js", jsx: "js", mjs: "js", cjs: "js", node: "js",
	json: "json", jsonc: "json", json5: "json",
	py: "python", python: "python", python3: "python", py3: "python", pyi: "python",
	cs: "cs", csharp: "cs", "c#": "cs", dotnet: "cs",
	ps1: "powershell", powershell: "powershell", pwsh: "powershell", ps: "powershell", psm1: "powershell", psd1: "powershell",
	bash: "shell", sh: "shell", shell: "shell", zsh: "shell", shellscript: "shell",
	html: "html", htm: "html", xhtml: "html", xml: "html", svg: "html", xaml: "html", csproj: "html",
	css: "css",
	md: "markdown", markdown: "markdown",
	yaml: "yaml", yml: "yaml",
	diff: "diff", patch: "diff",
	rust: "rust", rs: "rust",
	go: "go", golang: "go",
	cpp: "cpp", "c++": "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp", h: "cpp",
	c: "c",
};

/** The canonical language id of a fence's info string (`ts`, `TypeScript`, `c#`, `{.python}`), or `null` when it is not one of ours. */
export function languageId(info: string): string | null {
	const word = info.trim().toLowerCase().replace(/^\{?\.?/, "").split(/[\s,{}:]/, 1)[0] ?? "";
	return Object.hasOwn(ALIASES, word) ? (ALIASES[word] as string) : null;
}
