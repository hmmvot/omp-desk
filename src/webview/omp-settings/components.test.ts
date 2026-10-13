import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { before } from "node:test";
import { build } from "esbuild";
import type { SettingRowProps } from "./components/SettingRow";
import type { ConfigEntry } from "../../protocol/omp-config-model.ts";

/** The thin presentation components, rendered to static markup from an esbuild bundle (the page's own bundler). */
let renderRow: (props: SettingRowProps) => string;
before(async () => {
	const bundled = await build({ stdin: { contents: `
		import { createElement } from "react";
		import { renderToStaticMarkup } from "react-dom/server";
		import { SettingRow } from "./components/SettingRow";
		export const row = props => renderToStaticMarkup(createElement(SettingRow, props));
	`, loader: "tsx", resolveDir: join(process.cwd(), "src/webview/omp-settings") }, bundle: true, write: false,
		format: "cjs", platform: "node", packages: "external", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
	const module = { exports: {} };
	new Function("require", "module", "exports", bundled.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
	renderRow = (module.exports as { row: typeof renderRow }).row;
});

const base: ConfigEntry = {
  id: "lsp.formatOnWrite", tab: "files", group: "LSP", label: "Format on Write", description: "Format files after writing", type: "boolean", control: { kind: "boolean" }, readOnly: null,
  layers: { global: { state: "unset" }, project: { state: "unset" } }, effective: { value: true, source: "default", layeredSource: "default" }, default: true,
  env: null, visible: true, condition: null, writable: { global: true, project: true }, projectOther: null,
};
const render = (entry: ConfigEntry, props: Partial<SettingRowProps> = {}): string => renderRow({
  entry, layer: "global", layerFileExists: true, layerUnavailable: false, busy: false, showTab: null, onSet() {}, onReset() {}, onOpen() {}, ...props,
});

test("a boolean row shows its control, the layer it edits, and a Reset only when that layer sets it", () => {
  const html = render(base);
  assert.match(html, /<input type="checkbox" aria-label="Format on Write" checked=""/);
  assert.match(html, /Not set in the global layer/);
  assert.match(html, /<button type="button" class="secondary" disabled="" title="Remove this setting from the global layer">Reset<\/button>/);
  const set = render({ ...base, layers: { global: { state: "set", value: false }, project: { state: "unset" } } });
  assert.doesNotMatch(set, /Not set in the global layer/);
  assert.doesNotMatch(set, /disabled="" title="Remove/);
  assert.match(set, /global: off/);
});

test("a credential row has no value, no control and no way to open its key; it says where to set it", () => {
  const html = render({ ...base, id: "mnemopi.llmApiKey", label: "Key", type: "string", control: null, effective: { source: "default", layeredSource: "default" },
    readOnly: { reason: "secret", note: "This is a credential. Set it in a terminal: omp config set mnemopi.llmApiKey <value>." }, layers: { global: { state: "set" }, project: { state: "unset" } }, writable: { global: false, project: false } });
  assert.doesNotMatch(html, /<input|<select|<button/);
  assert.match(html, /omp config set mnemopi\.llmApiKey/);
  assert.match(html, /global: set/);
});

test("a complex row offers the YAML of the layer being edited, and an environment override is badged", () => {
  const complex = render({ ...base, control: null, readOnly: { reason: "complex", note: "Open the YAML file at this key to edit it." } }, { layer: "project", layerFileExists: false });
  assert.match(complex, /disabled="">Open project YAML at this key/);
  assert.match(render({ ...base, control: null, readOnly: { reason: "complex", note: "x" } }), />Open global YAML at this key<\/button>/);
  const env = render({ ...base, env: { name: "PI_EDIT_FUZZY", present: true, active: true, fallback: false }, effective: { value: true, source: "env", layeredSource: "default" } });
  assert.match(env, /\$PI_EDIT_FUZZY overrides/);
  assert.match(env, /in effect: environment/);
});

test("a row hidden by OMP's condition reads as such, and a busy editor disables every control", () => {
  const hidden = render({ ...base, visible: false, condition: { name: "vimModeEnabled", note: "Shown while Vim mode is enabled." }, writable: { global: false, project: false } });
  assert.match(hidden, /hidden-by-condition/);
  assert.match(hidden, /Shown while Vim mode is enabled\./);
  assert.match(hidden, /<input type="checkbox"[^>]*disabled=""/);
  assert.match(render(base, { busy: true }), /<input type="checkbox"[^>]*disabled=""/);
  assert.match(render(base, { layer: "project", layerUnavailable: true }), /<input type="checkbox"[^>]*disabled=""/);
});

test("an enum row lists OMP's choices, and a stored value outside them is shown, not replaced", () => {
  const enumEntry: ConfigEntry = { ...base, type: "enum", control: { kind: "enum", options: [{ value: "text", label: "Text" }, { value: "icon", label: "Icon", description: "Single glyph" }] }, layers: { global: { state: "set", value: "icon" }, project: { state: "unset" } }, effective: { value: "icon", source: "global", layeredSource: "global" } };
  const html = render(enumEntry);
  assert.match(html, /<option value="icon" title="Single glyph" selected="">Icon<\/option>/);
  assert.match(render({ ...enumEntry, layers: { global: { state: "set", value: "legacy" }, project: { state: "unset" } }, effective: { value: "legacy", source: "global", layeredSource: "global" } }), /legacy \(not a listed choice\)/);
});

test("a number OMP lists no choices for gets a typed input that explains a bad entry instead of sending it", () => {
  const html = render({ ...base, id: "retry.maxDelayMs", label: "Max Delay", type: "number", control: { kind: "numeric", integer: true }, default: 300000, layers: { global: { state: "set", value: 1000 }, project: { state: "unset" } } });
  assert.match(html, /<input type="text" inputMode="decimal" aria-label="Max Delay" aria-invalid="false" class="" value="1000"/);
  assert.match(html, /<button type="button" disabled="">Save<\/button>/);
});
