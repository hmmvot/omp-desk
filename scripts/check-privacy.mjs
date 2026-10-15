// The privacy gate: fails when personal information reaches the repository, its history or a release package.
//
//   node scripts/check-privacy.mjs [--denylist FILE] [--repo DIR]
//                                  [--tree REF]... [--range REVS]... [--vsix FILE]...
//
// "Personal information" is whatever the maintainer lists in the denylist: names of unrelated private
// projects, local paths, account names. The script contains no such names itself. The denylist is a text
// file of case-insensitive JavaScript regular expressions, one per line; blank lines and lines that start
// with `#` are ignored. It is kept outside Git (default `.omp/workspace/privacy-denylist.txt`); a missing,
// unreadable or empty denylist is an error, never a pass.
//
// Checks, any number of each (without any, `--tree HEAD` runs):
//   --tree REF    every tracked path and every text file of the tree at REF.
//   --range REVS  every commit that `git log REVS` lists (for example `origin/main..HEAD`, or `all` for
//                 every ref): the message, the path of every changed file and every added line. Every
//                 image added or changed in the range is listed, so a person or an agent can look at it.
//   --vsix FILE   every entry name and every text entry of an extracted VSIX (a ZIP file).
//   --repo DIR    the repository to inspect (default: the current directory).
//
// Output: one line per hit, `<where>:<line> rule <N>` or `<where> rule <N>` for a path, N being the
// 1-based position of the matching rule among the rules of the denylist. The matched text is never
// printed. Exit code 0: no hit; 1: at least one hit; 2: bad usage or an unreadable denylist.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const DEFAULT_DENYLIST = ".omp/workspace/privacy-denylist.txt";
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif|tiff?)$/i;
const MAX_REPORTED = 200;

function fail(message) {
  console.error(`check-privacy: ${message}`);
  process.exit(2);
}

function parseArguments(argv) {
  const options = { denylist: DEFAULT_DENYLIST, repo: process.cwd(), trees: [], ranges: [], vsix: [] };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    const need = () => {
      if (value === undefined) fail(`${flag} needs a value`);
      index++;
      return value;
    };
    if (flag === "--denylist") options.denylist = need();
    else if (flag === "--repo") options.repo = path.resolve(need());
    else if (flag === "--tree") options.trees.push(need());
    else if (flag === "--range") options.ranges.push(need());
    else if (flag === "--vsix") options.vsix.push(need());
    else fail(`unknown argument ${flag}`);
  }
  if (options.trees.length + options.ranges.length + options.vsix.length === 0) options.trees.push("HEAD");
  return options;
}

function loadRules(file) {
  if (!existsSync(file)) fail(`the denylist ${file} does not exist (pass --denylist FILE)`);
  const rules = [];
  for (const [index, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    try {
      rules.push(new RegExp(line, "i"));
    } catch {
      fail(`${file}:${index + 1} is not a valid regular expression`);
    }
  }
  if (rules.length === 0) fail(`the denylist ${file} holds no rules`);
  return rules;
}

const hits = { count: 0 };
function report(where, line, rule) {
  hits.count++;
  if (hits.count <= MAX_REPORTED) console.log(line === null ? `${where} rule ${rule}` : `${where}:${line} rule ${rule}`);
  else if (hits.count === MAX_REPORTED + 1) console.log(`(further hits are counted, not listed)`);
}

/** Reports each rule that matches `text` once for this place; `line` is null for a path. */
function scan(rules, where, line, text) {
  rules.forEach((rule, index) => {
    if (rule.test(text)) report(where, line, index + 1);
  });
}

function scanText(rules, where, text) {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) scan(rules, where, index + 1, lines[index]);
}

const isBinary = (buffer) => buffer.subarray(0, 8192).includes(0);

function git(options, args, input) {
  const result = spawnSync("git", args, { cwd: options.repo, input, maxBuffer: 1 << 30 });
  if (result.status !== 0) fail(`git ${args[0]} failed: ${result.stderr.toString().trim().split("\n")[0]}`);
  return result.stdout;
}

function checkTree(options, rules, ref) {
  const listing = git(options, ["ls-tree", "-r", "-z", ref]).toString("utf8").split("\0").filter(Boolean);
  const blobs = [];
  for (const entry of listing) {
    const tab = entry.indexOf("\t");
    const [, type, oid] = entry.slice(0, tab).split(" ");
    const file = entry.slice(tab + 1);
    scan(rules, `${ref}:${file}`, null, file);
    if (IMAGE.test(file)) console.log(`image ${ref}:${file}`);
    if (type === "blob") blobs.push({ oid, file });
  }
  const unique = [...new Set(blobs.map((blob) => blob.oid))];
  const out = git(options, ["cat-file", "--batch"], `${unique.join("\n")}\n`);
  const content = new Map();
  for (let offset = 0; offset < out.length; ) {
    const end = out.indexOf(10, offset);
    const [oid, , size] = out.subarray(offset, end).toString("ascii").split(" ");
    content.set(oid, out.subarray(end + 1, end + 1 + Number(size)));
    offset = end + 1 + Number(size) + 1;
  }
  for (const { oid, file } of blobs) {
    const buffer = content.get(oid);
    if (buffer !== undefined && !isBinary(buffer)) scanText(rules, `${ref}:${file}`, buffer.toString("utf8"));
  }
}

/** Streams `git log` and calls `onLine(line)` for each output line. */
function streamLog(options, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["log", "--no-color", "--no-ext-diff", "--no-renames", ...args], { cwd: options.repo, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", onLine);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git log failed: ${stderr.trim().split("\n")[0]}`))));
  });
}

async function checkRange(options, rules, range) {
  const revs = range === "all" ? ["--all"] : range.split(/\s+/).filter(Boolean);
  let sha = "";
  let inMessage = false;
  let messageLine = 0;
  let where = "";
  let inHunk = false;
  let line = 0;
  await streamLog(options, ["-p", "-U0", "--format=%x01%H%n%B%x02", ...revs], (text) => {
    if (text.startsWith("\x01")) {
      sha = text.slice(1, 8);
      inMessage = true;
      messageLine = 0;
      return;
    }
    if (inMessage) {
      if (text.startsWith("\x02")) inMessage = false;
      else scan(rules, `${sha}:message`, ++messageLine, text);
      return;
    }
    if (text.startsWith("diff --git ")) {
      inHunk = false;
      where = text.slice(text.lastIndexOf(" b/") + 3);
      scan(rules, `${sha}:${where}`, null, where);
    } else if (text.startsWith("@@ ")) {
      inHunk = true;
      line = Number(/\+(\d+)/.exec(text)?.[1] ?? 1);
    } else if (inHunk && text.startsWith("+")) {
      scan(rules, `${sha}:${where}`, line++, text.slice(1));
    }
  });
  const status = [];
  let current = "";
  await streamLog(options, ["--name-status", "--diff-filter=AM", "--format=%x01%H", ...revs], (text) => {
    if (text.startsWith("\x01")) current = text.slice(1, 8);
    else if (text.length > 0) {
      const [kind, file] = text.split("\t");
      if (IMAGE.test(file)) status.push(`image ${current} ${kind} ${file}`);
    }
  });
  for (const entry of status) console.log(entry);
}

function readZip(file) {
  const buffer = readFileSync(file);
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) fail(`${file} is not a ZIP file`);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) fail(`${file} has a damaged central directory`);
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    if (method !== 0 && method !== 8) fail(`${file}: ${name} uses an unsupported compression method`);
    entries.push({ name, read: () => (method === 0 ? data : inflateRawSync(data)) });
  }
  return entries;
}

function checkVsix(rules, file) {
  const label = path.basename(file);
  for (const entry of readZip(file)) {
    scan(rules, `${label}:${entry.name}`, null, entry.name);
    if (IMAGE.test(entry.name)) console.log(`image ${label}:${entry.name}`);
    const data = entry.read();
    if (!isBinary(data)) scanText(rules, `${label}:${entry.name}`, data.toString("utf8"));
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const rules = loadRules(path.resolve(options.denylist));
  for (const ref of options.trees) checkTree(options, rules, ref);
  for (const range of options.ranges) await checkRange(options, rules, range);
  for (const file of options.vsix) checkVsix(rules, path.resolve(file));
  if (hits.count > 0) {
    console.error(`check-privacy: ${hits.count} hit(s). Do not push or release.`);
    process.exit(1);
  }
  console.error(`check-privacy: no hits against ${rules.length} rules.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
