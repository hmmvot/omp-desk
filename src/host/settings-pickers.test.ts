import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

test("settings QuickPicks search details, toggle unavailable models, refuse locked role models and close with their editor", async () => {
  const temp = await mkdtemp(join(tmpdir(), "omp-settings-pickers-"));
  try {
    const result = await build({ stdin: { contents: 'export * from "./settings-pickers.ts"; export { created } from "vscode";', resolveDir: join(process.cwd(), "src/host"), loader: "ts" }, bundle: true, write: false,
      format: "esm", platform: "node", plugins: [{ name: "settings-picker-fixture", setup(plugin) {
        plugin.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" }));
        plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
         export const created=[];
         export const QuickPickItemKind={Separator:-1};
         export class ThemeIcon{constructor(id){this.id=id;}}
         export const window={createQuickPick(){
          let accept,hide,button; const picker={items:[],selectedItems:[],activeItems:[],buttons:[],title:"",
           onDidAccept(fn){accept=fn;return {dispose(){accept=undefined;}}},
           onDidHide(fn){hide=fn;return {dispose(){hide=undefined;}}},
           onDidTriggerButton(fn){button=fn;return {dispose(){button=undefined;}}},
           show(){this.shown=true;},dispose(){this.disposed=true;},
           accept(value){this.selectedItems=[this.items.find(item=>item.value===value)];accept?.();},
           press(){button?.(this.buttons[0]);},cancel(){hide?.();}};
          created.push(picker);return picker;
         }};` }));
      } }] });
    const file = join(temp, "pickers.mjs");
    await writeFile(file, result.outputFiles[0]!.text);
    const api = await import(pathToFileURL(file).href);
    const snapshot = {
      models: [
        { provider: "open", id: "m", name: "M", kind: "chat", available: true, reasoning: false, efforts: [], recent: -1 },
        { provider: "shut", id: "x", name: "X", kind: "chat", available: false, reasoning: false, efforts: [], recent: -1 },
      ],
      roles: [{ id: "smol", name: "Smol", section: "chat", source: "global", selector: "open/m", resolved: "open/m", accepts: ["open/m"], defaults: [] }],
      providers: [{ id: "open", status: "available", available: true }, { id: "shut", status: "locked", available: false }],
      effective: {},
    };
    const pending = api.pickSettingsModel({ purpose: "role", snapshot, role: "smol", current: "open/m" }, "Model for smol");
    const picker = api.created.at(-1);
    assert.equal(picker.matchOnDescription, true);
    assert.equal(picker.matchOnDetail, true);
    assert.equal(picker.shown, true);
    assert.equal(picker.activeItems[0].value, "open/m", "the current model is focused");
    assert.equal(picker.items[0].kind, -1, "groups are QuickPick separators");
    assert.ok(!picker.items.some((item: { value?: string }) => item.value === "shut/x"), "unavailable models start hidden");
    assert.equal(picker.buttons[0].tooltip, "Show unavailable models");
    picker.press();
    assert.ok(picker.items.some((item: { value?: string }) => item.value === "shut/x"));
    assert.equal(picker.buttons[0].tooltip, "Hide unavailable models");
    picker.accept("shut/x");
    assert.match(picker.title, /log in to its provider/, "a role cannot take a locked model; the picker stays open and says why");
    assert.notEqual(picker.disposed, true);
    picker.accept("open/m");
    assert.equal(await pending, "open/m");
    assert.equal(picker.disposed, true);

    const fallback = api.pickSettingsModel({ purpose: "fallback-entry", snapshot }, "Add");
    const list = api.created.at(-1);
    list.press(); list.accept("shut/x");
    assert.equal(await fallback, "shut/x", "a fallback may name a provider to log in to later");

    const controller = new AbortController();
    const closed = api.pickSettingsThinking(["low"], "inherit", "Thinking", controller.signal);
    assert.deepEqual(api.created.at(-1).items.map((item: { value: string }) => item.value), ["inherit", "off", "auto", "low"]);
    controller.abort();
    assert.equal(await closed, undefined, "closing the editor dismisses its picker");
    assert.equal(api.created.at(-1).disposed, true);

    const key = api.pickFallbackChainKey(snapshot, ["smol"]);
    const keys = api.created.at(-1);
    assert.ok(!keys.items.some((item: { value?: string }) => item.value === "smol"));
    keys.cancel();
    assert.equal(await key, undefined);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
