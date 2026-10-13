import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeThemeRule } from "../../chat/code-theme.ts";
import { styledRuns, spansOf } from "./code-highlight.ts";
import { languageForPath, languageId, LANGUAGES } from "./code-languages.ts";
import { tokenize } from "./code-tokens.ts";
import { createCodeThemeStyler } from "./code-theme-style.ts";

test("fence ids and aliases resolve to one language each, whatever the case", () => {
	const expected: Record<string, string> = {
		ps1: "powershell", PowerShell: "powershell", pwsh: "powershell",
		cmd: "bat", bat: "bat", BAT: "bat", batch: "bat",
		dockerfile: "dockerfile", Dockerfile: "dockerfile", docker: "dockerfile",
		tf: "hcl", hcl: "hcl", Terraform: "hcl", tfvars: "hcl",
		kt: "kotlin", kts: "kotlin", Kotlin: "kotlin",
		rb: "ruby", Ruby: "ruby", yml: "yaml", YAML: "yaml",
		gitignore: "gitignore", dockerignore: "gitignore", ignore: "gitignore",
		editorconfig: "ini", INI: "ini", toml: "toml", properties: "properties",
		makefile: "makefile", Make: "makefile", mk: "makefile",
		gql: "graphql", proto: "protobuf", hs: "haskell", ex: "elixir", exs: "elixir",
		objc: "objectivec", "Objective-C": "objectivec", gradle: "groovy", groovy: "groovy",
		pl: "perl", r: "r", sc: "scala", dart: "dart", lua: "lua", swift: "swift", php: "php", java: "java",
		postgres: "sql", SQL: "sql", nginx: "nginx", "c#": "cs", "{.python}": "python", "ts title=a.ts": "ts",
	};
	for (const [info, id] of Object.entries(expected)) assert.equal(languageId(info), id, info);
});

test("plain text, an unknown language and mermaid are not highlighted", () => {
	for (const info of ["text", "plaintext", "txt", "Text", "mermaid", "Mermaid", "", "nosuchlang"]) {
		assert.equal(languageId(info), null, info);
		assert.equal(tokenize("a b", info), null, info);
	}
});

test("every language names a root scope, a suffix and an engine, and the ids it is registered under are its own", () => {
	assert.ok(Object.keys(LANGUAGES).length >= 42);
	for (const [id, language] of Object.entries(LANGUAGES)) {
		assert.ok(language.root.length > 0 && language.suffix.length > 0 && language.engine.length > 0, id);
		assert.equal(languageId(id), id, `${id} is its own alias`);
	}
});

const SAMPLES: Record<string, string> = {
	gitignore: "# deps\nnode_modules/\n!keep/*.log\n**/dist/?.js\n",
	bat: "@echo off\nREM note\nset A=1\nif exist x.txt goto :end\nfor %%i in (*.c) do echo %%i\n:end\n",
	lua: "-- c\nlocal x = 1\nlocal function f(a) return a .. \"s\" end\nif x == nil then print(x) end\n--[[ block ]]\n",
	java: "package a.b;\nimport java.util.List;\n@Override\npublic class A<T> extends B { private static final int X = 0x1F; /** d */ String f(int a) { return \"s\" + null; } }\n",
	kotlin: "package a\nfun <T> f(a: Int): String? { val x = \"s ${a}\"; return when (a) { 1 -> x else -> null } }\n",
	swift: "import Foundation\nstruct A: B { let x: Int = 1\n func f(_ a: Int) -> Bool { guard let z = y else { return false }; return true } }\n",
	php: "<?php\nnamespace A;\nfinal class A { public function f(int $a): void { echo \"x $a\"; $this->c = [1, 'a' => true]; } }\n// c\n",
	ruby: "require 'json'\nclass A < B\n  def f(a, b = 1)\n    puts \"x #{a}\" if a && !b\n    @y = :sym\n  end\nend\n",
	sql: "-- c\nSELECT a.id, COUNT(*) AS n FROM users a LEFT JOIN b ON a.id = b.id WHERE a.x >= 10 AND name LIKE 'x%';\nCREATE TABLE t (id INT PRIMARY KEY, n VARCHAR(10) NOT NULL);\n",
	dockerfile: "# c\nFROM node:20 AS build\nENV A=1\nRUN npm ci && npm run build\nCMD [\"node\", \"x.js\"]\n",
	toml: "# c\n[package]\nname = \"x\"\nn = 12\nb = true\n[[bin]]\nname = 'y'\n",
	ini: "; c\n[section]\nkey = value\nn = 12\ns = \"str\"\n",
	properties: "# c\nkey=value\nother.key = 12\n",
	makefile: "# c\nCC := gcc\n.PHONY: all\nall: main.o\n\t$(CC) -o app $^\nifeq ($(A),1)\nendif\n",
	scala: "package a\nobject A extends App { val x: Int = 1; def f[T](a: T): Option[T] = a match { case Some(v) => v; case _ => None } }\n",
	dart: "import 'package:a/a.dart';\nclass A extends B { final int x; A(this.x); Future<void> f() async { var s = 'a ${x}'; await g(); } }\n",
	r: "# c\nx <- c(1, 2.5, NA)\nf <- function(a, b = 2) { if (a > b) TRUE else FALSE }\nlibrary(dplyr)\n",
	perl: "use strict;\nmy $x = \"s $y\";\nmy @a = (1, 2);\nsub f { my ($a) = @_; return $a =~ /re/ ? 1 : 0; }\n# c\n",
	graphql: "# c\nquery Q($id: ID!) { user(id: $id) { name ...F } }\ntype A implements B { id: ID! n: [String] @deprecated }\n",
	protobuf: "syntax = \"proto3\";\npackage a.b;\n// c\nmessage M { string a = 1; repeated int32 b = 2; map<string, N> c = 3; }\nservice S { rpc F(M) returns (N); }\n",
	haskell: "module A where\nimport Data.List (sort)\n-- c\ndata T = A | B Int deriving (Show)\nf :: Int -> String\nf x = case x of { 1 -> \"a\"; _ -> show x }\n",
	elixir: "defmodule A do\n  # c\n  def f(a, b \\\\ 1) when is_integer(a) do\n    IO.puts(\"x #{a}\")\n    :ok\n  end\nend\n",
	objectivec: "#import <Foundation/Foundation.h>\n@interface A : NSObject\n@property (nonatomic, strong) NSString *x;\n@end\n@implementation A\n- (void)f:(int)a { NSLog(@\"x %d\", a); }\n@end\n",
	groovy: "plugins { id 'java' }\ndef x = \"s ${a}\"\nclass A { String n; def f(a) { println a } }\n// c\n",
	hcl: "resource \"aws_s3_bucket\" \"b\" {\n  bucket = \"x\" # c\n  count  = 2\n  on     = true\n  tags   = merge(var.a, { n = \"b\" })\n}\n/* block */\n",
	nginx: "# c\nserver {\n  listen 80;\n  location ~ ^/a/(.*)$ { proxy_pass http://b; return 301 $scheme://x; }\n}\n",
};

test("the spans of every new language spell the source exactly, root scope first", () => {
	for (const [info, source] of Object.entries(SAMPLES)) {
		const spans = spansOf(info, source);
		assert.ok(spans !== null, `${info} is tokenized`);
		assert.equal(spans.map(span => span.text).join(""), source, `${info}: the spans spell the source`);
		assert.ok(spans.every(span => span.scopes[0] === LANGUAGES[info]?.root), `${info}: the root scope leads`);
		assert.ok(spans.some(span => span.scopes.length > 1), `${info}: something is coloured`);
	}
});

/** Dark Modern's colours for the scope families these samples use. */
const DARK: CodeThemeRule[] = [
	{ scopes: ["comment"], foreground: "#6A9955" },
	{ scopes: ["string"], foreground: "#CE9178" },
	{ scopes: ["constant.numeric"], foreground: "#B5CEA8" },
	{ scopes: ["keyword.control"], foreground: "#C586C0" },
	{ scopes: ["storage.type", "storage.modifier", "constant.language", "keyword.local", "keyword.command"], foreground: "#569CD6" },
	{ scopes: ["entity.name.function"], foreground: "#DCDCAA" },
	{ scopes: ["entity.name.type"], foreground: "#4EC9B0" },
	{ scopes: ["variable.parameter"], foreground: "#9CDCFE" },
	{ scopes: ["keyword.operator"], foreground: "#D4D4D4" },
	{ scopes: ["support.function"], foreground: "#DCDCAA" },
];
const styler = createCodeThemeStyler(DARK);

/** `[text, colour]` of every coloured run. */
function painted(info: string, source: string): Array<[string, string]> {
	const spans = spansOf(info, source);
	assert.ok(spans !== null);
	return styledRuns(spans, styler).flatMap(run => (run.style?.color === undefined || run.style.color === null ? [] : [[run.text, run.style.color] as [string, string]]));
}

test("gitignore: comments, negation and globs are told apart", () => {
	const spans = spansOf("gitignore", SAMPLES.gitignore as string) ?? [];
	const scopes = (text: string): string | undefined => spans.find(span => span.text === text)?.scopes.slice(1).join(" ");
	assert.equal(scopes("# deps"), "comment.line.number-sign.ignore");
	assert.equal(scopes("!"), "keyword.operator.negation.ignore");
	assert.equal(scopes("**"), "keyword.operator.glob.ignore");
	assert.equal(scopes("?"), "keyword.operator.glob.ignore");
	assert.equal(spans.find(span => span.text.includes("node_modules"))?.scopes.length, 1, "a plain pattern is plain");
	assert.deepEqual(painted("gitignore", SAMPLES.gitignore as string).map(([, colour]) => colour), ["#6A9955", "#D4D4D4", "#D4D4D4", "#D4D4D4", "#D4D4D4"]);
	// A line starting with `\#` is a pattern, not a comment; an escaped `\*` is not a glob.
	assert.deepEqual(painted("gitignore", "\\#file\na\\*b\n"), []);
});

test("bat: commands, control words, variables and comments get the batch grammar's scopes", () => {
	const runs = painted("bat", SAMPLES.bat as string);
	assert.deepEqual(runs.filter(([text]) => ["echo", "set", "if", "goto", "for", "REM note", "1"].includes(text)), [
		["echo", "#569CD6"], ["REM note", "#6A9955"], ["set", "#569CD6"], ["1", "#B5CEA8"], ["if", "#C586C0"], ["goto", "#C586C0"], ["for", "#C586C0"], ["echo", "#569CD6"],
	]);
	assert.equal(languageId("CMD"), "bat");
});

test("lua: keywords, local, functions, strings, nil and built-ins are coloured", () => {
	const runs = painted("lua", SAMPLES.lua as string);
	assert.deepEqual(runs.filter(([text]) => ["-- c", "local", "f", "\"s\"", "nil", "print", "--[[ block ]]", "function"].includes(text)), [
		["-- c", "#6A9955"], ["local", "#569CD6"], ["local", "#569CD6"], ["function", "#C586C0"], ["f", "#DCDCAA"], ["\"s\"", "#CE9178"], ["nil", "#569CD6"], ["print", "#DCDCAA"], ["--[[ block ]]", "#6A9955"],
	]);
});

test("dockerfile, hcl and java take their grammars' scopes", () => {
	const docker = spansOf("dockerfile", SAMPLES.dockerfile as string) ?? [];
	assert.deepEqual(docker.filter(span => span.scopes.includes("keyword.other.special-method.dockerfile")).map(span => span.text), ["FROM", "AS", "ENV", "RUN", "CMD"]);
	const hcl = spansOf("tf", SAMPLES.hcl as string) ?? [];
	const hclScope = (text: string): string | undefined => hcl.find(span => span.text === text)?.scopes.at(-1);
	assert.equal(hclScope("resource"), "entity.name.type.hcl");
	assert.equal(hclScope("\"aws_s3_bucket\""), "variable.other.constant.hcl");
	assert.equal(hclScope("bucket"), "variable.other.property.hcl");
	assert.equal(hclScope("merge"), "entity.name.function.hcl");
	assert.equal(hclScope("true"), "constant.language.hcl");
	assert.equal(hclScope("/* block */"), "comment.hcl");
	assert.deepEqual(painted("java", SAMPLES.java as string).filter(([text]) => ["public", "class", "int", "String", "null"].includes(text)).map(([text]) => text), ["public", "class", "int", "String", "int", "null"]);
});

test("a file path picks its language from the name, then the extension, read selectors ignored", () => {
	const expected: Record<string, string | null> = {
		".workspace/notes/compile_tree.py": "python", "src\\win\\Main.KT": "kotlin", "a/b/index.tsx": "tsx", "x.test.ts": "ts", "lib.rs": "rust",
		"ci/Dockerfile": "dockerfile", "Dockerfile.dev": "dockerfile", "build.dockerfile": "dockerfile", "Makefile": "makefile", "GNUmakefile": "makefile", "rules.mk": "makefile",
		".gitignore": "gitignore", "pkg/.dockerignore": "gitignore", ".editorconfig": "ini", "Jenkinsfile": "groovy", "Gemfile": "ruby", ".bashrc": "shell", "run.sh": "shell", "setup.ps1": "powershell",
		"src/a.ts:12": "ts", "src/a.ts:10-40": "ts", "src/a.ts:L5-L9": "ts", "src/a.ts:raw": "ts", "src/a.ts:12:raw": "ts", "C:\\repo\\a.py": "python", "main.tf": "hcl", "x.yml": "yaml",
		"notes.txt": null, "data.bin": null, "README": null, "noext.": null, ".hidden": null, "": null, "a.zzz": null, "dir.d/file": null, "archive.zip:src/m.go": "go",
	};
	for (const [path, id] of Object.entries(expected)) assert.equal(languageForPath(path), id, path);
});
