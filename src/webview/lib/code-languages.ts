/**
 * The languages fenced code is highlighted in, and what their words are called in TextMate.
 *
 * The tokenizer (highlight.js, `code-tokens.ts`) knows a keyword is a keyword; the editor theme tells
 * `if` (`keyword.control`) from `const` (`storage.type`) from `public` (`storage.modifier`), so each
 * language names its word families here, with the scope names the language's grammar in VS Code uses.
 * A keyword that is in no family is a plain `keyword.other`.
 */

/** How the words highlight.js leaves unmarked (variables, member names, calls, types) are told apart. */
export type WordStrategy = "script" | "csharp" | "go" | "cpp" | "rust" | "python" | "shell" | "powershell" | "css" | "clike" | "assign" | "none";

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
	/** A language added after the first set: titles, types and built-ins are named by the generic rules of `code-tokens.ts`. */
	readonly modern?: true;
	/** Words no token claims and no table names stay plain (the grammar scopes no variables). */
	readonly plainVariables?: true;
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
const JAVA_KEYWORDS = table({
	"keyword.control": "if else switch case default for while do break continue return throw try catch finally yield assert",
	"keyword.other.import": "import",
	"keyword.other.package": "package",
	"storage.modifier": "public private protected static final abstract native synchronized transient volatile strictfp sealed permits extends implements throws",
	"storage.type": "class interface enum record",
	"keyword.control.new": "new",
	"keyword.operator.instanceof": "instanceof",
	"storage.type.var": "var",
});
const JAVA_BUILTINS = table({
	"storage.type.primitive": "int long short byte char float double boolean void",
	"variable.language": "this super",
});

const KOTLIN_KEYWORDS = table({
	"keyword.control": "if else when for while do break continue return throw try catch finally",
	"keyword.other.import": "import package",
	"storage.type": "class interface object fun val var typealias constructor init",
	"storage.modifier": "public private protected internal open final abstract override sealed data enum inner companion lateinit const suspend inline noinline crossinline reified vararg operator infix tailrec external annotation value out",
	"keyword.operator.expression": "is as in by",
});
const KOTLIN_BUILTINS = table({ "variable.language": "this super" });

const SWIFT_KEYWORDS = table({
	"keyword.control": "if else switch case default for while repeat break continue return throw try catch guard defer fallthrough do where in",
	"keyword.control.import": "import",
	"storage.type": "class struct enum protocol extension func var let typealias init deinit subscript associatedtype actor",
	"storage.modifier": "public private fileprivate internal open static final mutating nonmutating override lazy weak unowned convenience required indirect async await throws rethrows inout some any",
	"keyword.operator.expression": "as is",
});
const SWIFT_BUILTINS = table({ "variable.language": "self super Self" });

const PHP_KEYWORDS = table({
	"keyword.control": "if else elseif switch case default for foreach while do break continue return throw try catch finally match yield goto declare endif endfor endforeach endwhile endswitch",
	"keyword.other.namespace": "namespace",
	"keyword.other.use": "use as",
	"storage.type": "class interface trait enum function fn const var",
	"storage.modifier": "public private protected static final abstract readonly extends implements global",
	"keyword.operator.new": "new clone",
	"keyword.operator.logical": "and or xor instanceof",
	"support.function.construct": "echo print include require include_once require_once unset isset empty list array die exit",
});

const RUBY_KEYWORDS = table({
	"keyword.control": "if elsif else unless case when while until for break next redo retry return yield begin rescue ensure then do end def class module undef alias in",
	"keyword.operator.logical": "and or not",
	"variable.language": "self super",
	"keyword.other.special-method": "require require_relative include extend attr_reader attr_writer attr_accessor private protected public puts print p raise loop lambda proc",
});

const SQL_KEYWORDS = table({
	"keyword.other.DML": "select insert update delete from where join left right inner outer full cross on group order by having limit offset union all distinct as into values set",
	"keyword.other.DDL": "create alter drop table index view database schema truncate",
	"keyword.other.data-integrity": "primary key foreign references unique check default not null constraint",
});

const DOCKERFILE_KEYWORDS = table({
	"keyword.other.special-method": "from run cmd label maintainer expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell as",
});

const MAKEFILE_KEYWORDS = table({
	"keyword.control": "include ifeq ifneq ifdef ifndef else endif define endef export override vpath .PHONY",
});

const SCALA_KEYWORDS = table({
	"keyword.control": "if else match for while do return throw try catch finally yield",
	"keyword.other.import": "import package",
	"storage.type": "class object trait def val var type enum given",
	"storage.modifier": "public private protected abstract final sealed implicit lazy override case extends with",
	"keyword.control.new": "new",
});
const SCALA_BUILTINS = table({ "variable.language": "this super" });

const DART_KEYWORDS = table({
	"keyword.control": "if else switch case default for while do break continue return throw try catch finally rethrow assert yield await",
	"keyword.other.import": "import export part library as show hide",
	"storage.type": "class enum mixin extension typedef var final const void",
	"storage.modifier": "abstract static late required external factory covariant async extends implements with on sync",
	"keyword.operator.new": "new",
	"keyword.operator.expression": "is in",
});
const DART_BUILTINS = table({ "variable.language": "this super", "storage.type.primitive": "int double num bool String dynamic" });

const R_KEYWORDS = table({
	"keyword.control": "if else for while repeat break next return in function",
});

const PERL_KEYWORDS = table({
	"keyword.control": "if elsif else unless for foreach while until do last next redo return die",
	"storage.type": "my our local sub package",
	"keyword.other": "use require print say",
});

const GRAPHQL_KEYWORDS = table({
	"keyword.operation": "query mutation subscription fragment",
	"storage.type": "type interface enum union input scalar schema extend directive implements on",
});

const PROTOBUF_KEYWORDS = table({
	"keyword.other": "syntax package import option returns reserved",
	"storage.type": "message enum service rpc extend oneof map",
	"storage.modifier": "repeated optional required stream",
});

const HASKELL_KEYWORDS = table({
	"keyword.control": "if then else case of let in where do",
	"keyword.other": "module import qualified as hiding",
	"storage.type": "data type newtype class instance deriving",
});

const ELIXIR_KEYWORDS = table({
	"keyword.control": "if else unless case cond with for do end fn when receive try catch rescue after raise throw def defp defmodule defmacro defstruct defprotocol defimpl import require use alias quote unquote",
});

const OBJC_KEYWORDS = table({
	"keyword.control": "if else switch case default for while do break continue return goto",
	"storage.type": "@interface @implementation @protocol @end @class @property @synthesize struct enum typedef",
	"storage.modifier": "static const extern inline nonatomic strong weak assign copy readonly readwrite atomic",
});
const OBJC_BUILTINS = table({ "storage.type.primitive": "int long short char float double BOOL void id", "variable.language": "self super" });

const GROOVY_KEYWORDS = table({
	"keyword.control": "if else switch case default for while do break continue return throw try catch finally",
	"keyword.other.import": "import package",
	"storage.type": "class interface enum trait def var",
	"storage.modifier": "public private protected static final abstract synchronized extends implements",
	"keyword.control.new": "new",
});

const LUA_KEYWORDS = table({
	"keyword.control": "if then else elseif end for while do repeat until return break goto in function",
	"keyword.local": "local",
	"keyword.operator.logical": "and or not",
});

const BAT_KEYWORDS = table({
	"keyword.control.conditional": "if else not exist defined errorlevel equ neq lss leq gtr geq",
	"keyword.control.repeat": "for in do",
	"keyword.control.statement": "goto call exit",
});

function language(suffix: string, root: string, engine: string, keywords: Readonly<Record<string, string>>, builtins: Readonly<Record<string, string>>, words: WordStrategy, caseInsensitive = false): CodeLanguage {
	return { suffix, root, engine, keywords, builtins, words, ...(caseInsensitive ? { caseInsensitive: true as const } : {}) };
}

/** A language of the second set: generic word rules, optionally case-insensitive keywords and plain unscoped variables. */
function more(suffix: string, root: string, engine: string, keywords: Readonly<Record<string, string>>, builtins: Readonly<Record<string, string>> = NONE, options: { caseInsensitive?: true; plainVariables?: true; words?: WordStrategy } = {}): CodeLanguage {
	return { suffix, root, engine, keywords, builtins, words: options.words ?? "clike", modern: true, ...(options.caseInsensitive ? { caseInsensitive: true as const } : {}), ...(options.plainVariables ? { plainVariables: true as const } : {}) };
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
	java: more("java", "source.java", "java", JAVA_KEYWORDS, JAVA_BUILTINS),
	kotlin: more("kotlin", "source.kotlin", "kotlin", KOTLIN_KEYWORDS, KOTLIN_BUILTINS, { plainVariables: true }),
	swift: more("swift", "source.swift", "swift", SWIFT_KEYWORDS, SWIFT_BUILTINS, { plainVariables: true }),
	php: more("php", "source.php", "php", PHP_KEYWORDS, NONE, { caseInsensitive: true }),
	ruby: more("ruby", "source.ruby", "ruby", RUBY_KEYWORDS, NONE, { plainVariables: true }),
	sql: more("sql", "source.sql", "sql", SQL_KEYWORDS, NONE, { caseInsensitive: true, plainVariables: true }),
	dockerfile: more("dockerfile", "source.dockerfile", "dockerfile", DOCKERFILE_KEYWORDS, NONE, { caseInsensitive: true, plainVariables: true }),
	toml: more("toml", "source.toml", "ini", NONE, NONE, { words: "none" }),
	ini: more("ini", "source.ini", "ini", NONE, NONE, { words: "none" }),
	properties: more("properties", "source.properties", "properties", NONE, NONE, { words: "none" }),
	makefile: more("makefile", "source.makefile", "makefile", MAKEFILE_KEYWORDS, NONE, { words: "assign" }),
	scala: more("scala", "source.scala", "scala", SCALA_KEYWORDS, SCALA_BUILTINS, { plainVariables: true }),
	dart: more("dart", "source.dart", "dart", DART_KEYWORDS, DART_BUILTINS),
	r: more("r", "source.r", "r", R_KEYWORDS),
	perl: more("perl", "source.perl", "perl", PERL_KEYWORDS),
	graphql: more("graphql", "source.graphql", "graphql", GRAPHQL_KEYWORDS),
	protobuf: more("proto", "source.proto", "protobuf", PROTOBUF_KEYWORDS, NONE, { plainVariables: true }),
	haskell: more("haskell", "source.haskell", "haskell", HASKELL_KEYWORDS, NONE, { plainVariables: true }),
	elixir: more("elixir", "source.elixir", "elixir", ELIXIR_KEYWORDS),
	objectivec: more("objc", "source.objc", "objectivec", OBJC_KEYWORDS, OBJC_BUILTINS),
	groovy: more("groovy", "source.groovy", "groovy", GROOVY_KEYWORDS, NONE, { plainVariables: true }),
	hcl: more("hcl", "source.hcl", "hcl", NONE, NONE, { words: "none" }),
	nginx: more("nginx", "source.nginx", "nginx", NONE, NONE, { words: "none" }),
	lua: more("lua", "source.lua", "lua", LUA_KEYWORDS),
	bat: more("batchfile", "source.batchfile", "dos", BAT_KEYWORDS, NONE, { caseInsensitive: true, words: "none" }),
	gitignore: more("ignore", "source.ignore", "gitignore", NONE, NONE, { words: "none" }),
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
	java: "java", jsp: "java",
	kotlin: "kotlin", kt: "kotlin", kts: "kotlin",
	swift: "swift",
	php: "php", php3: "php", php4: "php", php5: "php", phtml: "php",
	ruby: "ruby", rb: "ruby", gemspec: "ruby", rake: "ruby", rbw: "ruby",
	sql: "sql", mysql: "sql", postgres: "sql", postgresql: "sql", pgsql: "sql", plsql: "sql", tsql: "sql", sqlite: "sql",
	dockerfile: "dockerfile", docker: "dockerfile", containerfile: "dockerfile",
	toml: "toml",
	ini: "ini", cfg: "ini", editorconfig: "ini",
	properties: "properties", props: "properties",
	makefile: "makefile", make: "makefile", mk: "makefile", mak: "makefile", gnumakefile: "makefile",
	scala: "scala", sc: "scala",
	dart: "dart",
	r: "r", rscript: "r",
	perl: "perl", pl: "perl", pm: "perl",
	graphql: "graphql", gql: "graphql", graphqls: "graphql",
	protobuf: "protobuf", proto: "protobuf", proto3: "protobuf",
	haskell: "haskell", hs: "haskell",
	elixir: "elixir", ex: "elixir", exs: "elixir",
	objectivec: "objectivec", objc: "objectivec", "objective-c": "objectivec", "obj-c": "objectivec", mm: "objectivec",
	groovy: "groovy", gradle: "groovy",
	hcl: "hcl", tf: "hcl", terraform: "hcl", tfvars: "hcl",
	nginx: "nginx", nginxconf: "nginx",
	lua: "lua",
	bat: "bat", cmd: "bat", batch: "bat", batchfile: "bat",
	gitignore: "gitignore", ignore: "gitignore", dockerignore: "gitignore", npmignore: "gitignore", gitattributes: "gitignore",
};

/** The canonical language id of a fence's info string (`ts`, `TypeScript`, `c#`, `{.python}`), or `null` when it is not one of ours. */
export function languageId(info: string): string | null {
	const word = info.trim().toLowerCase().replace(/^\{?\.?/, "").split(/[\s,{}:]/, 1)[0] ?? "";
	return Object.hasOwn(ALIASES, word) ? (ALIASES[word] as string) : null;
}
