import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { before } from "node:test";
import { build } from "esbuild";
import type { SettingRowProps } from "./components/SettingRow";
import type { ConfigEntry, ConfigValue } from "../../protocol/omp-config-model.ts";

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
  entry, tabLabel: "Files", view: "global", layerFileExists: true, busy: false, terms: [], onSet() {}, onReset() {}, onOpen() {}, ...props,
});
const setIn = (layer: "global" | "project", value: ConfigValue) => ({ global: { state: "unset" }, project: { state: "unset" }, [layer]: { state: "set", value } }) as ConfigEntry["layers"];

test("a boolean row: the VS Code title, id, description, a switch, a modified bar and a Reset only when the layer sets it", () => {
  const html = render(base);
  assert.match(html, /<span class="cat">Files › LSP: <\/span>Format on Write/);
  assert.match(html, /<div class="sid">lsp\.formatOnWrite<\/div>/);
  assert.match(html, /<span class="sw"><input type="checkbox" aria-label="Format on Write" checked=""\/>/);
  assert.doesNotMatch(html, /srow mod|Reset Format on Write/);
  assert.match(html, /Not set in the global config; OMP(?:\\x27|&#x27;|.)s default applies\./);
  const set = render({ ...base, layers: setIn("global", false) });
  assert.match(set, /class="srow mod"/);
  assert.match(set, /aria-label="Reset Format on Write"/);
  assert.match(set, /aria-label="Open Format on Write in the global config file"/);
  assert.doesNotMatch(set, /Not set in the global config/);
});

test("the Effective view is read-only and shows what OMP uses; the project view shows the global value it falls back to", () => {
  const entry: ConfigEntry = { ...base, layers: setIn("global", true), effective: { value: true, source: "global", layeredSource: "global" } };
  const effective = render(entry, { view: "effective" });
  assert.match(effective, /<input type="checkbox"[^>]*checked=""/);
  assert.match(effective, /<input type="checkbox"[^>]*disabled=""/);
  assert.doesNotMatch(effective, /Reset Format on Write/);
  assert.match(effective, /Comes from the global config\./);
  const project = render(entry, { view: "project" });
  assert.match(project, /<input type="checkbox"[^>]*checked=""/);
  assert.match(project, /Also set in the global config: on\./);
  assert.match(project, /<span class="small muted">On<\/span>/, "an inherited value is dimmed");
});

test("a credential row has no value, no control and no way to open its key; it says where to set it", () => {
  const html = render({ ...base, id: "mnemopi.llmApiKey", label: "Key", type: "string", control: null, effective: { source: "default", layeredSource: "default" },
    readOnly: { reason: "secret", note: "This is a credential. Set it in a terminal: omp config set mnemopi.llmApiKey <value>." }, layers: setIn("global", "" as never) as never, writable: { global: false, project: false } });
  assert.doesNotMatch(html, /<input|<select|<button/);
  assert.match(html, /omp config set mnemopi\.llmApiKey/);
  assert.match(html, /<span class="tag">set<\/span>/);
});

test("a complex row offers its YAML key to open and says why it has no control", () => {
  const complex = render({ ...base, control: null, readOnly: { reason: "complex", note: "Open the YAML file at this key to edit it." } }, { view: "project", layerFileExists: false });
  assert.match(complex, /Complex value/);
  assert.match(complex, /aria-label="Open Format on Write in the project config file"[^>]*>|disabled=""[^>]*aria-label="Open Format on Write in the project config file"/);
  assert.match(render({ ...base, control: null, readOnly: { reason: "complex", note: "x" } }), /title="Open the config file at this key"/);
  const env = render({ ...base, env: { name: "PI_EDIT_FUZZY", present: true, active: true, fallback: false }, effective: { value: true, source: "env", layeredSource: "default" } });
  assert.match(env, /Overridden by \$PI_EDIT_FUZZY/);
});

test("a busy editor, a layer the entry cannot write and a read-only layer disable every control; search words are marked", () => {
  assert.match(render(base, { busy: true }), /<input type="checkbox"[^>]*disabled=""/);
  assert.match(render({ ...base, writable: { global: false, project: false } }), /<input type="checkbox"[^>]*disabled=""/);
  assert.match(render(base, { terms: ["format"] }), /<mark>Format<\/mark> on Write/);
});

test("an enum row lists OMP's choices, and a stored value outside them is shown, not replaced", () => {
  const enumEntry: ConfigEntry = { ...base, type: "enum", control: { kind: "enum", options: [{ value: "text", label: "Text" }, { value: "icon", label: "Icon", description: "Single glyph" }] }, layers: setIn("global", "icon"), effective: { value: "icon", source: "global", layeredSource: "global" } };
  assert.match(render(enumEntry), /<option value="icon" title="Single glyph" selected="">Icon<\/option>/);
  assert.match(render({ ...enumEntry, layers: setIn("global", "legacy") }), /legacy \(not a listed choice\)/);
});

test("a number OMP lists no choices for gets a typed input that explains a bad entry instead of sending it", () => {
  const html = render({ ...base, id: "retry.maxDelayMs", label: "Max Delay", type: "number", control: { kind: "numeric", integer: true }, default: 300000, layers: setIn("global", 1000) });
  assert.match(html, /<input type="text" inputMode="decimal" aria-label="Max Delay" aria-invalid="false" class="" value="1000"/);
  assert.match(html, /<button type="button" disabled="">Save<\/button>/);
});
