// Checks the import direction between the source layers (ADR-0065) and fails on import cycles.
//
//   node scripts/check-imports.mjs [root]
//
// `root` is the directory that holds `src/` (default: the repository). Every static
// `import` / `export ... from` specifier counts, including `import type`; relative
// specifiers are resolved to files, the layer of a file is the first path segment under
// `src/`. Test files, test stubs and anything outside `src/` are exempt from the layer
// rule and stay in the cycle check. Exit code 1 on any finding.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// layer -> layers it may import besides itself.
const ALLOWED = {
  shared: [],
  chat: ["shared"],
  protocol: ["chat", "shared"],
  host: ["broker", "omp", "protocol", "chat", "shared"],
  broker: ["host", "omp", "protocol", "chat", "shared"],
  omp: ["host", "broker", "protocol", "chat", "shared"],
  views: ["host", "protocol", "chat", "shared"],
  webview: ["protocol", "chat", "shared"],
  wiring: ["host", "views", "protocol", "chat", "shared"],
};
// The bundle entry may import every layer except `webview` (page code runs in the webview, never in the host).
const EXTENSION_ALLOWED = Object.keys(ALLOWED).filter((layer) => layer !== "webview");
const ROOT_FILE = "extension.ts";
const EXTENSIONS = [".ts", ".tsx"];

const IMPORT_FROM = /^[ \t]*(?:import|export)\b[^'";]*?\bfrom\s*(['"])([^'"\n]+)\1/gm;
const IMPORT_BARE = /^[ \t]*import\s*(['"])([^'"\n]+)\1/gm;

const rootArg = process.argv[2];
const root = path.resolve(rootArg ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const srcDir = path.join(root, "src");

const toRel = (file) => path.relative(root, file).split(path.sep).join("/");

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (EXTENSIONS.includes(path.extname(name))) out.push(full);
  }
  return out;
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function resolveSpecifier(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = [
    base,
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ];
  return candidates.find((c) => EXTENSIONS.includes(path.extname(c)) && isFile(c));
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function specifiersOf(text) {
  const found = [];
  for (const pattern of [IMPORT_FROM, IMPORT_BARE]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const specifier = match[2];
      if (specifier.startsWith(".")) {
        found.push({ specifier, line: lineOf(text, match.index + match[0].lastIndexOf(specifier)) });
      }
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

// `test-stub` must start a name segment: `vscode-test-stub.ts` and `test-stub.ts` are stubs, `latest-stub.ts` is not.
const isTestFile = (rel) => /\.test\.tsx?$/.test(rel) || /(?:^|[/-])test-stub[^/]*\.tsx?$/.test(rel);

// layer of a file: a ALLOWED key, "extension" for src/extension.ts, "root" for another file
// directly under src/, "outside" for a file outside src/ (test/**), "unknown" otherwise.
function layerOf(rel) {
  if (!rel.startsWith("src/")) return "outside";
  const segments = rel.slice(4).split("/");
  if (segments.length === 1) return segments[0] === ROOT_FILE ? "extension" : "root";
  return Object.hasOwn(ALLOWED, segments[0]) ? segments[0] : "unknown";
}

// Graph: every file under src/ plus whatever they reach outside it.
const graph = new Map(); // rel -> [{ to, line }]
const queue = existsSync(srcDir) ? walk(srcDir, []) : [];
const seen = new Set(queue);
while (queue.length > 0) {
  const file = queue.pop();
  const rel = toRel(file);
  const edges = [];
  for (const { specifier, line } of specifiersOf(readFileSync(file, "utf8"))) {
    const target = resolveSpecifier(file, specifier);
    if (target === undefined) continue;
    edges.push({ to: toRel(target), line });
    if (!seen.has(target)) {
      seen.add(target);
      queue.push(target);
    }
  }
  graph.set(rel, edges);
}

const findings = [];
const nodes = [...graph.keys()].sort();

// Layer rule.
for (const rel of nodes) {
  const layer = layerOf(rel);
  if (layer === "root" && !isTestFile(rel)) {
    findings.push(`${rel}:1 is directly under src/: only ${ROOT_FILE} may be; move it to a layer`);
    continue;
  }
  if (layer === "unknown" && !isTestFile(rel)) {
    findings.push(`${rel}:1 is in a directory that is not a layer (${Object.keys(ALLOWED).join(", ")})`);
    continue;
  }
  if (isTestFile(rel) || layer === "root" || layer === "unknown" || layer === "outside") {
    continue;
  }
  const allowed = layer === "extension" ? EXTENSION_ALLOWED : ALLOWED[layer];
  for (const { to, line } of graph.get(rel)) {
    const target = layerOf(to);
    if (target === layer || target === "outside" || target === "root" || target === "unknown") continue;
    if (target === "extension") {
      findings.push(`${rel}:${line} imports ${to}: ${layer} may not import ${ROOT_FILE}`);
    } else if (!allowed.includes(target)) {
      findings.push(`${rel}:${line} imports ${to}: ${layer} may not import ${target}`);
    }
  }
}

// Cycle rule: depth-first search, each cycle reported once, rotated to start at its smallest member.
const state = new Map(); // rel -> 1 on the stack, 2 done
const stack = [];
const cycles = new Set();
function visit(rel) {
  state.set(rel, 1);
  stack.push(rel);
  const targets = [...new Set((graph.get(rel) ?? []).map((edge) => edge.to))].sort();
  for (const to of targets) {
    if (!graph.has(to)) continue;
    const status = state.get(to);
    if (status === 1) {
      const cycle = stack.slice(stack.indexOf(to));
      const start = cycle.indexOf([...cycle].sort()[0]);
      const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
      cycles.add([...rotated, rotated[0]].join(" -> "));
    } else if (status === undefined) {
      visit(to);
    }
  }
  stack.pop();
  state.set(rel, 2);
}
for (const rel of nodes) if (!state.has(rel)) visit(rel);
for (const cycle of [...cycles].sort()) findings.push(`import cycle: ${cycle}`);

if (findings.length > 0) {
  console.log(findings.join("\n"));
  console.error(`check-imports: ${findings.length} finding(s)`);
  process.exit(1);
}
const edgeCount = [...graph.values()].reduce((sum, edges) => sum + edges.length, 0);
console.log(`check-imports: ${graph.size} files, ${edgeCount} imports, no layer violation, no cycle`);
