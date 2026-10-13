import assert from "node:assert/strict";
import { test } from "node:test";
import { locateYamlKey } from "./yaml-key-line.ts";

const text = `# comment
tui:
  vimMode: true
  nested:
    deep: 1
lsp:
  diagnosticsOnWrite: false
  vimMode: nope
"quoted.key": 3
flat.key: 4
compaction:
  methodOrder:
    - handoff
`;

test("finds a nested key under its own parent, not a same-named key elsewhere", () => {
  assert.equal(locateYamlKey(text, ["tui", "vimMode"]), 2);
  assert.equal(locateYamlKey(text, ["lsp", "vimMode"]), 7);
  assert.equal(locateYamlKey(text, ["lsp", "diagnosticsOnWrite"]), 6);
  assert.equal(locateYamlKey(text, ["tui", "nested", "deep"]), 4);
  assert.equal(locateYamlKey(text, ["compaction", "methodOrder"]), 11);
  assert.equal(locateYamlKey(text, ["lsp"]), 5);
});
test("a key outside its parent's block, or absent, is not found; a flat dotted key is", () => {
  assert.equal(locateYamlKey(text, ["tui", "diagnosticsOnWrite"]), null);
  assert.equal(locateYamlKey(text, ["nope"]), null);
  assert.equal(locateYamlKey(text, ["flat", "key"]), 9, "a hand-written flat key");
  assert.equal(locateYamlKey("", ["a"]), null);
  assert.equal(locateYamlKey("a: 1\r\nb:\r\n  c: 2\r\n", ["b", "c"]), 2, "CRLF files");
});
