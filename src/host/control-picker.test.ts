import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

test("native pickers disambiguate names, retain current focus and cancel stale or replaced choices", async () => {
	const temp = await mkdtemp(join(tmpdir(), "omp-control-picker-"));
	try {
		const result = await build({ stdin: { contents: 'export * from "./control-picker.ts"; export { created } from "vscode";', resolveDir: join(process.cwd(), "src/host"), loader: "ts" }, bundle: true, write: false,
			format: "esm", platform: "node", plugins: [{ name: "native-picker-fixture", setup(plugin) {
				plugin.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" }));
				plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
				 export const created=[];
				 export const QuickPickItemKind={Separator:-1};
				 export const window={createQuickPick(){
				  let accept,hide; const picker={selectedItems:[],
				   onDidAccept(fn){accept=fn;return {dispose(){accept=undefined;}}},
				   onDidHide(fn){hide=fn;return {dispose(){hide=undefined;}}},
				   show(){},dispose(){this.disposed=true;},accept(index){this.selectedItems=[this.items[index]];accept?.();},cancel(){hide?.();}};
				  created.push(picker);return picker;
				 }};` }));
			} }] });
		const file = join(temp, "picker.mjs");
		await writeFile(file, result.outputFiles[0]!.text);
		const api = await import(pathToFileURL(file).href);
		const current = { provider: "one", id: "original", name: "Same" }, next = { provider: "two", id: "next", name: "Same" };
		let live = true;
		const pending = api.pickControlModel([current, next], current, () => live, "first");
		const picker = api.created.at(-1);
		assert.deepEqual(picker.items.filter((item: { value?: unknown }) => item.value).map((item: { description?: string }) => item.description), ["current", "next"]);
		assert.equal(picker.items.filter((item: { kind?: number }) => item.kind === -1).length, 2);
		assert.equal(picker.activeItems[0], picker.items[1]);
		assert.equal(picker.items[1].detail, undefined);
		live = false; picker.accept(3);
		assert.equal(await pending, undefined);
		assert.equal(picker.disposed, true);
		const first = api.pickControlThinking(["low", "max"], "low", () => true, "first");
		const replaced = api.created.at(-1);
		const second = api.pickControlThinking(["low", "max"], "low", () => true, "second");
		assert.equal(await first, undefined);
		assert.equal(replaced.disposed, true);
		api.cancelControlPicker("first");
		assert.notEqual(api.created.at(-1).disposed, true);
		api.cancelControlPicker("second");
		assert.equal(await second, undefined);
	} finally { await rm(temp, { recursive: true, force: true }); }
});

test("models use provider groups and natural family/version order; thinking explains choices without detail lines", async () => {
	const temp = await mkdtemp(join(tmpdir(), "omp-control-picker-order-"));
	try {
		const result = await build({ stdin: { contents: 'export * from "./control-picker.ts"; export { created } from "vscode";', resolveDir: join(process.cwd(), "src/host"), loader: "ts" }, bundle: true, write: false,
			format: "esm", platform: "node", plugins: [{ name: "picker-order", setup(plugin) {
				plugin.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" }));
				plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
				 export const created=[]; export const QuickPickItemKind={Separator:-1};
				 export const window={createQuickPick(){const p={onDidAccept(){return {dispose(){}}},onDidHide(){return {dispose(){}}},show(){},dispose(){}};created.push(p);return p;}};` }));
			} }] });
		const file = join(temp, "picker.mjs");
		await writeFile(file, result.outputFiles[0]!.text);
		const api = await import(pathToFileURL(file).href);
		void api.pickControlModel([{provider:"z",id:"alpha-10"}, {provider:"a",id:"beta-2"}, {provider:"z",id:"alpha-2"}], null, () => true);
		assert.deepEqual(api.created.at(-1).items.map((item: { label: string }) => item.label), ["a", "beta-2", "z", "alpha-2", "alpha-10"]);
		api.cancelControlPicker();
		void api.pickControlThinking(["off", "low", "high"], "low", () => true);
		const picker = api.created.at(-1);
		assert.equal(picker.activeItems[0].value, "low");
		assert.ok(picker.items.every((item: { description?: string; detail?: string }) => item.description && item.detail === undefined));
		api.cancelControlPicker();
	} finally { await rm(temp, { recursive: true, force: true }); }
});
