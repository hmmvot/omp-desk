// Checks the import direction between the source layers (ADR-0065), the `vscode`-free `runtime` layer (ADR-0066) and import cycles.
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
  runtime: ["host", "broker", "omp", "protocol", "chat", "shared"],
  wiring: ["host", "views", "runtime", "protocol", "chat", "shared"],
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
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out; // removed while the tree was being read
  }
  for (const name of names) {
    const full = path.join(dir, name);
    // An entry another process removed between the directory read and here is not part of the tree.
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
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

// Every way a file can name the `vscode` module: a static, type-only, side-effect or re-export
// specifier, a dynamic `import()` (which also covers the type-position `import("vscode")`), a
// `require()` and `import x = require()`. Other bare specifiers are not part of this check.
const VSCODE_STATIC = /^[ \t]*(?:import|export)\b[^'";]*?\bfrom\s*(['"])vscode\1|^[ \t]*import\s*(['"])vscode\2/gm;
const VSCODE_CALL = /\b(?:import|require)\s*\(\s*(['"`])vscode\1\s*\)/g;

function vscodeLineOf(text) {
  let first = Infinity;
  for (const pattern of [VSCODE_STATIC, VSCODE_CALL]) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match !== null) first = Math.min(first, match.index);
  }
  return first === Infinity ? null : lineOf(text, first);
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
const texts = new Map(); // rel -> source text
const vscodeImporters = new Map(); // rel -> line of the first reference to `vscode`
while (queue.length > 0) {
  const file = queue.pop();
  const rel = toRel(file);
  const edges = [];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // removed while the tree was being read
  }
  texts.set(rel, text);
  const vscodeLine = vscodeLineOf(text);
  if (vscodeLine !== null) vscodeImporters.set(rel, vscodeLine);
  for (const { specifier, line } of specifiersOf(text)) {
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

// R-runtime-1: nothing in `src/runtime/` refers to `vscode`, directly or through a chain of relative
// imports between non-test files (ADR-0066). The shortest chain to each offending file is printed.
for (const start of nodes) {
  if (layerOf(start) !== "runtime" || isTestFile(start)) continue;
  const parent = new Map([[start, null]]);
  const frontier = [start];
  for (let head = 0; head < frontier.length; head++) {
    const rel = frontier[head];
    if (vscodeImporters.has(rel)) {
      const chain = [];
      for (let at = rel; at !== null; at = parent.get(at)) chain.unshift(at);
      const last = `${chain.pop()}:${vscodeImporters.get(rel)}`;
      findings.push(`${[...chain, last].join(" -> ")} imports vscode: runtime may not reach vscode`);
    }
    for (const { to } of graph.get(rel) ?? []) {
      if (parent.has(to) || isTestFile(to) || !graph.has(to)) continue;
      parent.set(to, rel);
      frontier.push(to);
    }
  }
}

// R-runtime-2: the port module declares data only. It uses statement-level `import type` and
// `export type ... from`, every source and name is on this list, so a live object (an index, a
// handle, a client, the chat runtime) cannot become part of the port's contract by a type import.
const PORT_FILE = "src/runtime/session-runtime.ts";
const PORT_ANY_NAME_DIRECTORIES = ["src/shared/", "src/protocol/", "src/chat/"];
const PORT_ALLOWED_NAMES = {
  "src/host/session-index.ts": ["OmpHostLaunchRequest", "OmpHostLaunchResult", "OmpHostAttachRequest", "OmpHostAttachResult", "RestoreOutcome", "RestoreReport"],
  "src/host/session-model.ts": [
    "SessionAvailability", "RunIntent", "OmpLaunchScope", "RecordedRpcIdentity", "RecordedHost", "SessionViewMode",
    "NativeHostTransferOutcome", "RecordedOwnership", "SessionOrigin", "SessionIndexEntry", "SessionImportConflict",
    "EditorSlotRole", "EditorSlotBinding",
  ],
  "src/host/rpc-reconcile.ts": ["NativeStopVerdict"],
  "src/host/session-restore-trace.ts": ["OmpHostStepTimings"],
  "src/host/chat-runtime.ts": ["ChatPage", "ChatCommandOutcome", "ConversationActivity", "RewindRead"],
  "src/host/rpc/session.ts": ["NavigateRequest", "NavigateOutcome"],
};
const PORT_STATEMENT = /^[ \t]*(import|export)\b([^'";]*?)\bfrom\s*(['"])([^'"\n]+)\3|^[ \t]*import\s*(['"])([^'"\n]+)\5/gm;
const PORT_DYNAMIC = /\b(?:import|require)\s*\(/g;
if (graph.has(PORT_FILE)) {
  const text = texts.get(PORT_FILE);
  const portDir = path.dirname(path.join(root, PORT_FILE));
  const report = (index, message) => findings.push(`${PORT_FILE}:${lineOf(text, index)} ${message}`);
  for (const match of text.matchAll(PORT_STATEMENT)) {
    if (match[6] !== undefined) {
      report(match.index, `has a side-effect import of ${match[6]}: the port module uses \`import type\` only`);
      continue;
    }
    const [, keyword, clause, , specifier] = match;
    const typed = /^\s*type\s*\{([^{}]*)\}\s*$/.exec(clause);
    const braced = typed ?? /^\s*\{([^{}]*)\}\s*$/.exec(clause);
    const names = braced === null ? [] : braced[1].split(",").map((part) => part.trim()).filter(Boolean);
    if (names.some((name) => /^type\s/.test(name))) {
      report(match.index, `has an inline \`type\` modifier in the import of ${specifier}: use a statement-level \`${keyword} type\``);
      continue;
    }
    if (typed === null) {
      report(match.index, `has \`${keyword}${clause.replace(/\s+/g, " ").trimEnd()} from "${specifier}"\`: only \`${keyword} type { ... } from\` is allowed in the port module`);
      continue;
    }
    const target = specifier.startsWith(".") ? resolveSpecifier(path.join(portDir, "x"), specifier) : undefined;
    const targetRel = target === undefined ? null : toRel(target);
    if (targetRel === null) {
      report(match.index, `imports ${specifier}, which is not an allow-listed relative module`);
    } else if (!PORT_ANY_NAME_DIRECTORIES.some((directory) => targetRel.startsWith(directory))) {
      const allowedNames = PORT_ALLOWED_NAMES[targetRel];
      if (allowedNames === undefined) {
        report(match.index, `imports ${targetRel}, which is not an allow-listed source for the port module`);
      } else {
        for (const name of names) {
          const original = name.split(/\s+as\s+/)[0].trim();
          if (!allowedNames.includes(original)) report(match.index, `imports ${original} from ${targetRel}: not an allow-listed data type for the port module`);
        }
      }
    }
  }
  for (const match of text.matchAll(PORT_DYNAMIC)) {
    report(match.index, "has a dynamic import or require: the port module uses statement-level `import type` only");
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
