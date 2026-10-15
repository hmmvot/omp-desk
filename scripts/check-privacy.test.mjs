import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-privacy.mjs");
const SECRET = "zz-private-project";
const OTHER = "yy-account-name";

let root = "";
let repo = "";
let denylist = "";

const git = (...args) => {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const put = (file, text) => {
  const target = path.join(repo, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
};
const commit = (message, ...files) => {
  git("add", "-A", "--", ...files);
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};
const run = (...args) => {
  const result = spawnSync(process.execPath, [script, "--repo", repo, "--denylist", denylist, ...args], { encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr, lines: result.stdout.split("\n").filter(Boolean) };
};

/** A minimal ZIP writer: deflated entries, enough for the reader under test. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "check-privacy-"));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  denylist = path.join(root, "denylist.txt");
  writeFileSync(denylist, `# a comment\n${SECRET}\n\n\\b${OTHER}\\b\n`);
  git("init", "-q", "-b", "main");
});

after(() => rmSync(root, { recursive: true, force: true }));

test("a missing, empty or invalid denylist is an error, never a pass", () => {
  const missing = spawnSync(process.execPath, [script, "--repo", repo, "--denylist", path.join(root, "absent.txt")], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /does not exist/);
  writeFileSync(path.join(root, "empty.txt"), "# nothing\n");
  assert.equal(spawnSync(process.execPath, [script, "--repo", repo, "--denylist", path.join(root, "empty.txt")], { encoding: "utf8" }).status, 2);
  writeFileSync(path.join(root, "broken.txt"), "(\n");
  assert.equal(spawnSync(process.execPath, [script, "--repo", repo, "--denylist", path.join(root, "broken.txt")], { encoding: "utf8" }).status, 2);
  assert.equal(run("--bogus").status, 2);
});

test("a clean tree passes", () => {
  put("src/a.ts", "export const a = 1;\n");
  commit("Add a", "src");
  const result = run("--tree", "HEAD");
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(result.lines, []);
});

test("a hit in a tracked file is reported as file:line and rule number, without the matched text", () => {
  put("docs/notes.md", `first line\nsee ${SECRET.toUpperCase()} here\n`);
  commit("Add notes", "docs");
  const result = run();
  assert.equal(result.status, 1);
  assert.deepEqual(result.lines, ["HEAD:docs/notes.md:2 rule 1"]);
  assert.ok(!result.out.toLowerCase().includes(SECRET) && !result.err.toLowerCase().includes(SECRET), "the matched text is never printed");
});

test("a hit in a path is reported without a line", () => {
  put(`src/${OTHER}.ts`, "ok\n");
  commit("Add a file", "src");
  assert.ok(run("--tree", "HEAD").lines.includes(`HEAD:src/${OTHER}.ts rule 2`));
});

test("history is checked even when the tree is clean: added lines, paths and messages", () => {
  git("rm", "-q", "-r", "docs", `src/${OTHER}.ts`);
  git("commit", "-q", "-m", `Remove them, ${OTHER} said so`);
  assert.equal(run("--tree", "HEAD").status, 0, "the tree is clean again");
  const result = run("--range", "all");
  assert.equal(result.status, 1);
  const rules = result.lines.filter((line) => line.includes(" rule "));
  assert.ok(rules.some((line) => /^[0-9a-f]{7}:docs\/notes\.md:2 rule 1$/.test(line)), result.out);
  assert.ok(rules.some((line) => new RegExp(`^[0-9a-f]{7}:src/${OTHER}\\.ts rule 2$`).test(line)), "the path of a commit");
  assert.ok(rules.some((line) => /^[0-9a-f]{7}:message:1 rule 2$/.test(line)), "the message of a commit");
  assert.ok(!result.out.toLowerCase().includes(SECRET));
});

test("a range limits the commits that are checked, and lists the images it adds or changes", () => {
  const before = git("rev-parse", "HEAD");
  put("media/shot.png", "not really a png");
  put("src/b.ts", "export const b = 2;\n");
  const head = commit("Add a screenshot", "media", "src");
  const result = run("--range", `${before}..${head}`);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(result.lines, [`image ${head.slice(0, 7)} A media/shot.png`]);
});

test("a VSIX is checked by entry name and by the text of every entry", () => {
  const clean = path.join(root, "clean.vsix");
  writeFileSync(clean, zip({ "extension/package.json": "{}\n", "extension/media/icon.png": "x" }));
  const cleanResult = run("--vsix", clean);
  assert.equal(cleanResult.status, 0, cleanResult.out);
  assert.deepEqual(cleanResult.lines, ["image clean.vsix:extension/media/icon.png"]);
  const dirty = path.join(root, "dirty.vsix");
  writeFileSync(dirty, zip({ "extension/README.md": `one\ntwo ${SECRET}\n`, [`extension/${OTHER}.txt`]: "fine\n" }));
  const result = run("--vsix", dirty);
  assert.equal(result.status, 1);
  assert.deepEqual(result.lines.sort(), [`dirty.vsix:extension/${OTHER}.txt rule 2`, "dirty.vsix:extension/README.md:2 rule 1"].sort());
});
