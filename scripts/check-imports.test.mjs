import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-imports.mjs");

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "check-imports-"));
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}

function run(root) {
  const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  return { status: result.status, lines: result.stdout.split("\n").filter(Boolean) };
}

test("reports a layer violation, a root file, a re-export cycle and a runtime cycle", () => {
  const root = fixture({
    "src/extension.ts": 'import { a } from "./host/a.ts";\nexport const e = a;\n',
    "src/stray.ts": "export const stray = 1;\n",
    "src/host/a.ts": '\n\nimport { view } from "../webview/y.ts";\nexport const a = view;\n',
    "src/webview/y.ts": "export const view = 1;\n",
    // closed only through `import type` and `export ... from`
    "src/shared/types-a.ts": 'import type { B } from "./types-b.ts";\nexport type A = B;\n',
    "src/shared/types-b.ts": 'export type { A } from "./types-a.ts";\nexport type B = number;\n',
    // runtime cycle
    "src/chat/one.ts": 'import { two } from "./two";\nexport const one = () => two;\n',
    "src/chat/two.ts": 'import {\n  one,\n} from "./one.ts";\nexport const two = () => one;\n',
    // allowed: protocol -> chat, views -> host, the test file may reach any layer
    "src/protocol/p.ts": 'import { one } from "../chat/one.ts";\nexport const p = one;\n',
    "src/views/v.ts": 'import { a } from "../host/a.ts";\nexport const v = a;\n',
    "src/host/a.test.ts": 'import { view } from "../webview/y.ts";\nexport const t = view;\n',
  });
  try {
    const { status, lines } = run(root);
    assert.equal(status, 1);
    assert.deepEqual(lines, [
      "src/host/a.ts:3 imports src/webview/y.ts: host may not import webview",
      "src/stray.ts:1 is directly under src/: only extension.ts may be; move it to a layer",
      "import cycle: src/chat/one.ts -> src/chat/two.ts -> src/chat/one.ts",
      "import cycle: src/shared/types-a.ts -> src/shared/types-b.ts -> src/shared/types-a.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exits 0 on a tree that follows the rule", () => {
  const root = fixture({
    "src/extension.ts": 'import { a } from "./host/a.ts";\nexport const e = a;\n',
    "src/shared/s.ts": "export const s = 1;\n",
    "src/host/a.ts": 'import { s } from "../shared/s.ts";\nexport const a = s;\n',
  });
  try {
    assert.equal(run(root).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository tree passes", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
