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

function check(files, expected) {
  const root = fixture(files);
  try {
    const { status, lines } = run(root);
    assert.deepEqual(lines, expected);
    assert.equal(status, expected.length === 0 ? 0 : 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A tree that follows every rule: exit 0 and the one summary line.
function checkClean(files) {
  const root = fixture(files);
  try {
    const { status, lines } = run(root);
    assert.equal(status, 0, lines.join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("extension.ts may import every layer except webview", () => {
  check(
    {
      "src/extension.ts":
        'import { a } from "./host/a.ts";\nimport { w } from "./wiring/w.ts";\nimport { s } from "./shared/s.ts";\nimport { v } from "./webview/y.ts";\nimport { o } from "../test/o.ts";\nexport const e = [a, w, s, v, o];\n',
      "src/host/a.ts": "export const a = 1;\n",
      "src/wiring/w.ts": "export const w = 1;\n",
      "src/shared/s.ts": "export const s = 1;\n",
      "src/webview/y.ts": "export const v = 1;\n",
      "test/o.ts": "export const o = 1;\n",
    },
    ["src/extension.ts:4 imports src/webview/y.ts: extension may not import webview"],
  );
});

test("reports a non-test file in a directory that is not a layer", () => {
  check(
    {
      "src/other/o.ts": "export const o = 1;\n",
      "src/other/o.test.ts": "export const t = 1;\n",
    },
    [
      "src/other/o.ts:1 is in a directory that is not a layer (shared, chat, protocol, host, broker, omp, views, webview, runtime, wiring)",
    ],
  );
});

test("reports a layer file importing extension.ts", () => {
  check(
    {
      "src/extension.ts": "export const e = 1;\n",
      "src/wiring/w.ts": '\nimport { e } from "../extension";\nexport const w = e;\n',
    },
    ["src/wiring/w.ts:2 imports src/extension.ts: wiring may not import extension.ts"],
  );
});

test("the test entry src/extension-harness.ts may import extension.ts and every layer, no non-test file may import it", () => {
  checkClean({
    "src/extension.ts": "export const e = 1;\n",
    "src/extension-harness.ts": 'import { e } from "./extension";\nimport { v } from "./webview/y.ts";\nexport const harness = [e, v];\n',
    "src/webview/y.ts": "export const v = 1;\n",
  });
  check(
    {
      "src/extension.ts": "export const e = 1;\n",
      "src/extension-harness.ts": 'import { e } from "./extension";\nexport const harness = e;\n',
      "src/wiring/w.ts": '\nimport { harness } from "../extension-harness";\nexport const w = harness;\n',
      "src/stray-harness.ts": "export const stray = 1;\n",
    },
    [
      "src/stray-harness.ts:1 is directly under src/: only extension.ts may be; move it to a layer",
      "src/wiring/w.ts:2 imports src/extension-harness.ts: the test entry is bundled by its test only",
    ],
  );
});

test("resolves .tsx files and index.tsx directories", () => {
  check(
    {
      "src/host/h.ts": 'import { c } from "../webview/comp";\nimport { d } from "../webview/d";\nexport const h = [c, d];\n',
      "src/webview/comp/index.tsx": "export const c = 1;\n",
      "src/webview/d.tsx": "export const d = 1;\n",
    },
    [
      "src/host/h.ts:1 imports src/webview/comp/index.tsx: host may not import webview",
      "src/host/h.ts:2 imports src/webview/d.tsx: host may not import webview",
    ],
  );
});

test("reports a cycle that passes through a test file", () => {
  check(
    {
      "src/chat/a.ts": 'import { t } from "./a.test.ts";\nexport const a = t;\n',
      "src/chat/a.test.ts": 'import { a } from "./a.ts";\nexport const t = a;\n',
    },
    ["import cycle: src/chat/a.test.ts -> src/chat/a.ts -> src/chat/a.test.ts"],
  );
});

test("exempts test stubs by name segment only", () => {
  check(
    {
      "src/webview/y.ts": "export const y = 1;\n",
      "src/views/vscode-test-stub.ts": 'import { y } from "../webview/y.ts";\nexport const a = y;\n',
      "src/wiring/vscode-test-stub.ts": 'import { y } from "../webview/y.ts";\nexport const b = y;\n',
      "src/host/test-stub.ts": 'import { y } from "../webview/y.ts";\nexport const c = y;\n',
      "src/host/latest-stub.ts": 'import { y } from "../webview/y.ts";\nexport const d = y;\n',
    },
    ["src/host/latest-stub.ts:1 imports src/webview/y.ts: host may not import webview"],
  );
});

test("the runtime layer imports the process layers, wiring and extension.ts import it, no other layer does", () => {
  check(
    {
      "src/extension.ts": 'import { r } from "./runtime/r.ts";\nexport const e = r;\n',
      "src/runtime/r.ts": 'import { h } from "../host/h.ts";\nimport { b } from "../broker/b.ts";\nimport { o } from "../omp/o.ts";\nimport { p } from "../protocol/p.ts";\nexport const r = [h, b, o, p];\n',
      "src/wiring/w.ts": 'import { r } from "../runtime/r.ts";\nexport const w = r;\n',
      "src/host/h.ts": "export const h = 1;\n",
      "src/broker/b.ts": "export const b = 1;\n",
      "src/omp/o.ts": "export const o = 1;\n",
      "src/protocol/p.ts": "export const p = 1;\n",
      "src/views/v.ts": 'import { r } from "../runtime/r.ts";\nexport const v = r;\n',
      "src/webview/y.ts": 'import { r } from "../runtime/r.ts";\nexport const y = r;\n',
      "src/host/h2.ts": 'import { r } from "../runtime/r.ts";\nexport const h2 = r;\n',
      "src/runtime/w.ts": 'import { w } from "../wiring/w.ts";\nimport { v } from "../views/v.ts";\nexport const x = [w, v];\n',
    },
    [
      "src/host/h2.ts:1 imports src/runtime/r.ts: host may not import runtime",
      "src/runtime/w.ts:1 imports src/wiring/w.ts: runtime may not import wiring",
      "src/runtime/w.ts:2 imports src/views/v.ts: runtime may not import views",
      "src/views/v.ts:1 imports src/runtime/r.ts: views may not import runtime",
      "src/webview/y.ts:1 imports src/runtime/r.ts: webview may not import runtime",
    ],
  );
});

test("a runtime file may not name vscode in any form", () => {
  check(
    {
      "src/runtime/static.ts": 'import * as vscode from "vscode";\nexport const a = vscode;\n',
      "src/runtime/typeonly.ts": 'import type { Uri } from "vscode";\nexport type A = Uri;\n',
      "src/runtime/side.ts": '\nimport "vscode";\nexport const b = 1;\n',
      "src/runtime/reexport.ts": 'export { window } from "vscode";\n',
      "src/runtime/dynamic.ts": 'export const c = () => import("vscode");\n',
      "src/runtime/require.ts": 'import vscode = require("vscode");\nexport const d = vscode;\n',
      "src/runtime/call.ts": 'export const e = require("vscode");\n',
      "src/runtime/position.ts": 'export type F = import("vscode").Uri;\n',
      "src/runtime/clean.ts": 'import { node } from "node:path";\nimport type { Uri } from "other-vscode-lib";\nexport const g = node;\n',
    },
    [
      "src/runtime/call.ts:1 imports vscode: runtime may not reach vscode",
      "src/runtime/dynamic.ts:1 imports vscode: runtime may not reach vscode",
      "src/runtime/position.ts:1 imports vscode: runtime may not reach vscode",
      "src/runtime/reexport.ts:1 imports vscode: runtime may not reach vscode",
      "src/runtime/require.ts:1 imports vscode: runtime may not reach vscode",
      "src/runtime/side.ts:2 imports vscode: runtime may not reach vscode",
      "src/runtime/static.ts:1 imports vscode: runtime may not reach vscode",
      "src/runtime/typeonly.ts:1 imports vscode: runtime may not reach vscode",
    ],
  );
});

test("a runtime file may not reach vscode through a chain of non-test imports", () => {
  check(
    {
      "src/runtime/x.ts": 'import { y } from "../host/y.ts";\nimport { clean } from "../host/clean.ts";\nexport const x = [y, clean];\n',
      "src/host/y.ts": 'import { z } from "./z.ts";\nexport const y = z;\n',
      "src/host/z.ts": '\n\nconst vscode = await import("vscode");\nexport const z = vscode;\n',
      "src/host/clean.ts": "export const clean = 1;\n",
      // a test file that names vscode is not part of the chain
      "src/host/clean.test.ts": 'import * as vscode from "vscode";\nexport const t = vscode;\n',
      "src/host/only-test.ts": 'import { t } from "./clean.test.ts";\nexport const o = t;\n',
      "src/runtime/ok.ts": 'import { o } from "../host/clean.ts";\nexport const ok = o;\n',
    },
    ["src/runtime/x.ts -> src/host/y.ts -> src/host/z.ts:3 imports vscode: runtime may not reach vscode"],
  );
});

test("a file outside the runtime layer may import vscode", () => {
  checkClean({
    "src/host/h.ts": 'import * as vscode from "vscode";\nexport const h = vscode;\n',
    "src/wiring/w.ts": 'import { h } from "../host/h.ts";\nexport const w = h;\n',
  });
});

test("the port module uses only statement-level type imports from the allow-list", () => {
  checkClean({
    "src/runtime/session-runtime.ts": [
      'import type { Row } from "../shared/row.ts";',
      'import type { RestoreOutcome, RestoreReport as Report } from "../host/session-index.ts";',
      'import type { NativeStopVerdict } from "../host/rpc-reconcile.ts";',
      'import type { ChatFrame } from "../protocol/frame.ts";',
      "export type Port = [Row, RestoreOutcome, Report, NativeStopVerdict, ChatFrame];",
      'export type { ChatFrame } from "../protocol/frame.ts";',
      "",
    ].join("\n"),
    "src/shared/row.ts": "export type Row = number;\n",
    "src/protocol/frame.ts": "export type ChatFrame = string;\n",
    "src/host/session-index.ts": "export type RestoreOutcome = string;\nexport type RestoreReport = string;\nexport class SessionIndex {}\n",
    "src/host/rpc-reconcile.ts": "export type NativeStopVerdict = string;\n",
  });
});

test("the port module refuses value imports, inline type modifiers, star re-exports and live types", () => {
  check(
    {
      "src/runtime/session-runtime.ts": [
        'import { index } from "../host/session-index.ts";',
        'import { type RestoreOutcome } from "../host/session-index.ts";',
        'import type { SessionIndex } from "../host/session-index.ts";',
        'import type { PtyHandle } from "../host/pty-client.ts";',
        'import type { Path } from "node:path";',
        'import "../host/session-index.ts";',
        'export * from "../shared/row.ts";',
        'export { Row } from "../shared/row.ts";',
        'export type Dynamic = import("../host/pty-client.ts").PtyHandle;',
        "",
      ].join("\n"),
      "src/shared/row.ts": "export type Row = number;\n",
      "src/host/session-index.ts": "export const index = 1;\nexport type RestoreOutcome = string;\nexport class SessionIndex {}\n",
      "src/host/pty-client.ts": "export type PtyHandle = string;\n",
    },
    [
      'src/runtime/session-runtime.ts:1 has `import { index } from "../host/session-index.ts"`: only `import type { ... } from` is allowed in the port module',
      "src/runtime/session-runtime.ts:2 has an inline `type` modifier in the import of ../host/session-index.ts: use a statement-level `import type`",
      "src/runtime/session-runtime.ts:3 imports SessionIndex from src/host/session-index.ts: not an allow-listed data type for the port module",
      "src/runtime/session-runtime.ts:4 imports src/host/pty-client.ts, which is not an allow-listed source for the port module",
      "src/runtime/session-runtime.ts:5 imports node:path, which is not an allow-listed relative module",
      "src/runtime/session-runtime.ts:6 has a side-effect import of ../host/session-index.ts: the port module uses `import type` only",
      'src/runtime/session-runtime.ts:7 has `export * from "../shared/row.ts"`: only `export type { ... } from` is allowed in the port module',
      'src/runtime/session-runtime.ts:8 has `export { Row } from "../shared/row.ts"`: only `export type { ... } from` is allowed in the port module',
      "src/runtime/session-runtime.ts:9 has a dynamic import or require: the port module uses statement-level `import type` only",
    ],
  );
});

test("outside the Draft module only its entry may be imported (R-draft-1); the module's own tests and files inside it are exempt", () => {
  const root = fixture({
    "src/webview/lib/draft/draft.ts": 'import { inner } from "./inner.ts";\nexport const d = inner;\n',
    "src/webview/lib/draft/inner.ts": "export const inner = 1;\n",
    "src/webview/lib/draft/inner.test.ts": 'import { inner } from "./inner.ts";\nexport const t = inner;\n',
    "src/webview/lib/surface.ts": 'import { d } from "./draft/draft.ts";\nimport { inner } from "./draft/inner.ts";\nexport const s = [d, inner];\n',
    "src/webview/lib/surface.test.ts": 'import { inner } from "./draft/inner.ts";\nexport const st = inner;\n',
    "src/webview/components/View.tsx": 'import { inner } from "../lib/draft/inner";\nexport const v = inner;\n',
  });
  try {
    const { status, lines } = run(root);
    assert.equal(status, 1);
    assert.deepEqual(lines, [
      "src/webview/components/View.tsx:1 imports src/webview/lib/draft/inner.ts: outside src/webview/lib/draft/ only draft.ts may be imported from it (R-draft-1)",
      "src/webview/lib/surface.ts:2 imports src/webview/lib/draft/inner.ts: outside src/webview/lib/draft/ only draft.ts may be imported from it (R-draft-1)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Draft module reaches only its directory, shared, protocol, chat, two grammar modules and type-only pi-wire (R-draft-2)", () => {
  const root = fixture({
    "src/webview/lib/draft/draft.ts": [
      'import { ok } from "../../../shared/ok.ts";',
      'import { slash } from "../slash-completion.ts";',
      'import { fence } from "../code-fence.ts";',
      'import type { ImageContent } from "@oh-my-pi/pi-wire";',
      'import { surface } from "../draft-surface.ts";',
      'import { View } from "../../components/View.tsx";',
      'import { useState } from "react";',
      'import { image } from "@oh-my-pi/pi-wire";',
      'import "react-dom";',
      "export const d = [ok, slash, fence, surface, View, useState, image];",
      "export type I = ImageContent;",
      "",
    ].join("\n"),
    "src/webview/lib/draft/draft.test.ts": 'import { useState } from "react";\nexport const t = useState;\n',
    "src/shared/ok.ts": "export const ok = 1;\n",
    "src/webview/lib/slash-completion.ts": "export const slash = 1;\n",
    "src/webview/lib/code-fence.ts": "export const fence = 1;\n",
    "src/webview/lib/draft-surface.ts": "export const surface = 1;\n",
    "src/webview/components/View.tsx": "export const View = 1;\n",
  });
  try {
    const { status, lines } = run(root);
    assert.equal(status, 1);
    assert.deepEqual(lines, [
      "src/webview/lib/draft/draft.ts:5 imports src/webview/lib/draft-surface.ts: the Draft module may import only its own directory, shared, protocol, chat, slash-completion.ts and code-fence.ts (R-draft-2)",
      "src/webview/lib/draft/draft.ts:6 imports src/webview/components/View.tsx: the Draft module may import only its own directory, shared, protocol, chat, slash-completion.ts and code-fence.ts (R-draft-2)",
      "src/webview/lib/draft/draft.ts:7 imports react: the Draft module may import only type-only @oh-my-pi/pi-wire besides relative files (R-draft-2)",
      "src/webview/lib/draft/draft.ts:8 imports @oh-my-pi/pi-wire: the Draft module may import only type-only @oh-my-pi/pi-wire besides relative files (R-draft-2)",
      "src/webview/lib/draft/draft.ts:9 imports react-dom: the Draft module may import only type-only @oh-my-pi/pi-wire besides relative files (R-draft-2)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository tree passes", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
