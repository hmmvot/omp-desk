// Fails when webview code reads a shortcut's letter, digit or punctuation key from `event.key`.
//
//   node scripts/check-keys.mjs [root]
//
// A shortcut is a place on the keyboard, not a character: `event.key` follows the layout (a Russian layout reports
// "с" for the physical C key) and `event.code` does not. Page code matches such keys with `isPhysicalKey`
// (`src/webview/lib/physical-keys.ts`); named keys (Enter, Escape, Tab, Insert, Arrow*, F*, and Space as " ") are compared
// with `event.key` as before. This check finds, in every non-test file under `src/webview/` except that module:
//
//   - `.key` compared (`===`, `!==`, `==`, `!=`) with a one-character string other than " ";
//   - `.key.toLowerCase()` and the other case conversions of `.key`;
//   - `.test(...key)` on a regular expression, and `[...].includes(...key)` over one-character strings;
//   - a `switch` on `.key` with a one-character `case`.
//
// Only the `.key` member is read, so a local variable that holds `event.key` is not followed; the unit tests of the
// webview press the shortcuts on a Cyrillic layout for that. `root` is the directory that holds `src/` (default: the
// repository). Exit code 1 on any finding.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MATCHER = "src/webview/lib/physical-keys.ts";
const KEY = String.raw`[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\??\.key\b`;
/** A one-character string literal that is not whitespace (Space, " ", is a named key); `n` is the number of its quote's capture group. */
const char = (n) => String.raw`(["'\`])(?!\s)[^"'\`\\]` + "\\" + n;
const COMPARE = String.raw`(?:===|!==|==|!=)`;

/** Each rule: what is wrong, and the pattern that finds it in comment-free source. */
const RULES = [
  { what: "`.key` compared with a character", pattern: String.raw`${KEY}\s*${COMPARE}\s*${char(1)}|${char(2)}\s*${COMPARE}\s*${KEY}` },
  { what: "case conversion of `.key`", pattern: String.raw`\.key\s*\.\s*to(?:Locale)?(?:Lower|Upper)Case\b` },
  { what: "regular expression test of `.key`", pattern: String.raw`\.test\(\s*[\w$.?]*\.key\s*\)` },
  { what: "`.key` looked up among characters", pattern: String.raw`\[[^\]\n]*${char(1)}[^\]\n]*\]\s*\.includes\(\s*[\w$.?]*\.key\s*\)` },
];

/** `source` with comments blanked (newlines kept, so line numbers stay true). */
export function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (line, lead) => lead + " ".repeat(line.length - lead.length));
}

function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** The text of the `{ ... }` block that opens at `open` (a `{`), by brace depth; strings are not special-cased. */
function blockAt(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

/** Findings of one file's source: `{ line, what }` each. */
export function findKeyViolations(source) {
  const code = withoutComments(source);
  const found = [];
  for (const { what, pattern } of RULES) {
    for (const match of code.matchAll(new RegExp(pattern, "g"))) {
      found.push({ line: lineOf(code, match.index), what });
    }
  }
  for (const match of code.matchAll(new RegExp(String.raw`switch\s*\(\s*${KEY}\s*\)\s*\{`, "g"))) {
    const open = match.index + match[0].length - 1;
    const body = blockAt(code, open);
    for (const single of body.matchAll(new RegExp(String.raw`case\s+${char(1)}\s*:`, "g"))) {
      found.push({ line: lineOf(code, open + single.index), what: "`switch` on `.key` with a character `case`" });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const problems = [];
  for (const file of walk(path.join(root, "src", "webview"), [])) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel === MATCHER) continue;
    for (const { line, what } of findKeyViolations(readFileSync(file, "utf8"))) problems.push(`${rel}:${line}: ${what}; match the physical key with isPhysicalKey (src/webview/lib/physical-keys.ts)`);
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("check-keys: no webview shortcut reads a character from event.key");
}
