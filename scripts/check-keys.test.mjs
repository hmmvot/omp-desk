import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { findKeyViolations } from "./check-keys.mjs";

const lines = (source) => findKeyViolations(source).map((finding) => finding.line);

describe("a shortcut letter read from event.key", () => {
  it("is found in every shape a chord has been written", () => {
    assert.deepEqual(lines(`if (event.ctrlKey && event.key === "c") copy();`), [1]);
    assert.deepEqual(lines(`if (event.ctrlKey && "v" === event.key) paste();`), [1]);
    assert.deepEqual(lines(`if (e.nativeEvent.key !== 'z') return;`), [1]);
    assert.deepEqual(lines("if (event.key == `y`) redo();"), [1]);
    assert.deepEqual(lines(`const paste = event.key.toLowerCase() === "v";`), [1]);
    assert.deepEqual(lines(`return /^[a-z]$/i.test(event.key);`), [1]);
    assert.deepEqual(lines(`if (["c", "x"].includes(event.key)) return;`), [1]);
    assert.deepEqual(lines(`if (event.key === "/" || event.key === "[") return;`), [1, 1]);
    assert.deepEqual(lines(`\n\nswitch (event.key) {\n  case "Enter": break;\n  case "f": find(); break;\n}`), [5]);
  });

  it("leaves named keys, Space and comments alone", () => {
    assert.deepEqual(lines(`if (event.key === "Enter" || event.key === "Escape" || event.key === "Insert" || event.key === "F3") run();`), []);
    assert.deepEqual(lines(`if (event.key === " ") activate();`), []);
    assert.deepEqual(lines(`switch (event.key) { case "ArrowUp": up(); break; case " ": space(); break; }`), []);
    assert.deepEqual(lines(`// event.key === "c" is what this used to say\nconst x = 1; /* event.key.toLowerCase() */`), []);
    assert.deepEqual(lines(`const key = "c"; if (key === "c") x();`), [], "only the .key member of an event is read; a local named key is not an event");
  });
});

describe("the check over the tree", () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-keys.mjs");
  const run = (root) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [script, root], { encoding: "utf8", stdio: "pipe" }) };
    } catch (error) {
      return { code: error.status, out: String(error.stderr) };
    }
  };

  it("fails for a page file, names it, and skips the matcher module and test files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "omp-check-keys-"));
    try {
      const lib = path.join(root, "src", "webview", "lib");
      mkdirSync(lib, { recursive: true });
      writeFileSync(path.join(lib, "physical-keys.ts"), `export const ok = (event) => /^[a-z]$/i.test(event.key);\n`);
      writeFileSync(path.join(lib, "physical-keys.test.ts"), `const t = (event) => event.key === "c";\n`);
      assert.equal(run(root).code, 0);
      writeFileSync(path.join(lib, "chord.ts"), `export const copy = (event) => event.ctrlKey && event.key === "c";\n`);
      const failed = run(root);
      assert.equal(failed.code, 1);
      assert.match(failed.out, /src\/webview\/lib\/chord\.ts:1: `\.key` compared with a character; match the physical key with isPhysicalKey/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes on this repository", () => {
    assert.equal(run(path.join(path.dirname(script), "..")).code, 0);
  });
});
