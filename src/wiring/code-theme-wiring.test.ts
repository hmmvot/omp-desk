/**
 * The code-theme wiring: what it reads from `vscode`, when it re-resolves (the watched settings, the active theme,
 * the installed extensions), that a superseded resolution is dropped, that an unchanged result is not announced
 * and that every applied resolution logs one line. `vscode` is the stand-in of `vscode-test-stub.ts`, so this file
 * must run under `node --test`. The resolution rules themselves are `src/host/code-theme.test.ts`.
 */
import assert from "node:assert/strict";
import module from "node:module";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

if (typeof module.registerHooks === "function") {
	const stubUrl = new URL("./vscode-test-stub.ts", import.meta.url).href;
	module.registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === "vscode") return { url: stubUrl, shortCircuit: true };
			return nextResolve(specifier, context);
		},
	});
}

const stub = await import("./vscode-test-stub.ts");
const { registerCodeTheme } = await import("./code-theme-wiring.ts");

const EXT = "/ext/demo";

const themeFile = (foreground: string): string => JSON.stringify({ tokenColors: [{ scope: "string", settings: { foreground } }] });

const FILES: Record<string, string> = {
	[`${EXT}/themes/dark.json`]: themeFile("#ce9178"),
	[`${EXT}/themes/two.json`]: themeFile("#00ff00"),
	[`${EXT}/themes/light.json`]: themeFile("#a31515"),
};

const settle = async (): Promise<void> => {
	for (let turn = 0; turn < 8; turn++) await new Promise<void>(resolve => setImmediate(resolve));
};

const ids = (themes: readonly { id: string }[]): string[] => themes.map(theme => theme.id);

describe("registerCodeTheme", () => {
	let reads: string[];
	let changed: number;
	let logs: string[];
	let subscriptions: { dispose(): void }[];
	let files: Record<string, string>;
	let gate: Promise<void> | null;
	const ports = {
		readFile: async (path: string): Promise<string | null> => {
			reads.push(path);
			await gate;
			return Object.hasOwn(files, path) ? files[path]! : null;
		},
		fileSize: async (path: string): Promise<number | null> => (Object.hasOwn(files, path) ? Buffer.byteLength(files[path]!) : null),
	};
	const start = () =>
		registerCodeTheme({ subscriptions } as never, {
			changed: () => { changed++; },
			log: message => { logs.push(message); },
			...ports,
		});
	const debounce = async (): Promise<void> => {
		mock.timers.tick(100);
		await settle();
	};

	beforeEach(() => {
		mock.timers.enable({ apis: ["setTimeout"] });
		reads = [];
		changed = 0;
		logs = [];
		subscriptions = [];
		files = FILES;
		gate = null;
		stub.workspace.settings = { "workbench.colorTheme": "Demo Dark" };
		stub.window.activeColorTheme = { kind: stub.ColorThemeKind.Dark };
		stub.extensions.all = [
			{
				extensionPath: EXT,
				packageJSON: {
					contributes: {
						themes: [
							{ id: "Demo Dark", uiTheme: "vs-dark", path: "./themes/dark.json" },
							{ id: "Demo Two", uiTheme: "vs-dark", path: "./themes/two.json" },
							{ id: "Demo Light", uiTheme: "vs", path: "./themes/light.json" },
							{ id: 5, path: 7 },
						],
					},
				},
			},
			{ extensionPath: "/ext/none", packageJSON: { contributes: { themes: "not a list" } } },
			{ extensionPath: "/ext/bare", packageJSON: undefined },
		];
	});
	afterEach(() => {
		for (const subscription of subscriptions) subscription.dispose();
		mock.timers.reset();
	});

	it("has no themes before the first resolution, resolves at registration and announces the themes once", async () => {
		const handle = start();
		assert.deepEqual(handle.current(), []);
		await settle();
		assert.deepEqual(handle.current(), [{ id: "Demo Dark", rules: [{ scopes: ["string"], foreground: "#ce9178" }] }]);
		assert.equal(changed, 1);
		assert.equal(subscriptions.includes(handle), true, "registered with the extension context");
	});

	it("resolves the preferred themes of the active kind as further candidates, workbench.colorTheme first", async () => {
		stub.workspace.settings = {
			"workbench.colorTheme": "Demo Two",
			"workbench.preferredDarkColorTheme": "Demo Dark",
			"workbench.preferredLightColorTheme": "Demo Light",
		};
		const handle = start();
		await settle();
		assert.deepEqual(ids(handle.current()), ["Demo Two", "Demo Dark"]);
	});

	it("logs one line for each applied resolution: the ids and rule counts, or why there are none", async () => {
		start();
		await settle();
		assert.equal(logs.length, 1);
		assert.match(logs[0]!, /^code theme: themes "Demo Dark" \(1 rules\)$/);
		stub.workspace.settings = { "workbench.colorTheme": "Not Installed" };
		stub.workspace.fireConfigurationChange("workbench.colorTheme");
		await debounce();
		assert.equal(logs.length, 2);
		assert.match(logs[1]!, /^code theme: no themes for dark .*"Not Installed"/);
	});

	it("announces nothing when the first resolution is empty, like the value current() already has", async () => {
		stub.workspace.settings = { "workbench.colorTheme": "Not Installed" };
		const handle = start();
		await settle();
		assert.deepEqual(handle.current(), []);
		assert.equal(changed, 0);
		assert.equal(logs.length, 1, "it still says why there is nothing");
	});

	it("re-resolves, debounced, when a watched setting changes", async () => {
		const handle = start();
		await settle();
		stub.workspace.settings = { "workbench.colorTheme": "Demo Two" };
		stub.workspace.fireConfigurationChange("workbench.colorTheme");
		stub.workspace.fireConfigurationChange("workbench.colorTheme");
		await settle();
		assert.deepEqual(ids(handle.current()), ["Demo Dark"], "nothing before the debounce elapses");
		const before = reads.length;
		await debounce();
		assert.deepEqual(handle.current(), [{ id: "Demo Two", rules: [{ scopes: ["string"], foreground: "#00ff00" }] }]);
		assert.equal(changed, 2);
		assert.equal(reads.length - before, 1, "two quick changes resolve once");
	});

	it("reacts to every watched setting, including the customizations", async () => {
		const handle = start();
		await settle();
		const keys = [
			"workbench.preferredDarkColorTheme",
			"workbench.preferredLightColorTheme",
			"workbench.preferredHighContrastColorTheme",
			"workbench.preferredHighContrastLightColorTheme",
			"editor.tokenColorCustomizations",
		];
		for (const key of keys) {
			const before = reads.length;
			stub.workspace.fireConfigurationChange(key);
			await debounce();
			assert.ok(reads.length > before, `${key} re-resolves`);
		}
		stub.workspace.settings = { ...stub.workspace.settings, "editor.tokenColorCustomizations": { strings: "#112233" } };
		stub.workspace.fireConfigurationChange("editor.tokenColorCustomizations");
		await debounce();
		assert.deepEqual(handle.current()[0]?.rules.at(-1), { scopes: ["string", "meta.embedded.assembly"], foreground: "#112233" });
	});

	it("does not re-resolve for an unrelated setting", async () => {
		start();
		await settle();
		const before = reads.length;
		stub.workspace.fireConfigurationChange("editor.fontSize");
		stub.workspace.fireConfigurationChange("workbench.colorCustomizations");
		await debounce();
		assert.equal(reads.length, before);
		assert.equal(changed, 1);
	});

	it("re-resolves when the active theme's kind changes, and sends only themes of the new kind", async () => {
		const handle = start();
		await settle();
		stub.window.setColorThemeKind(stub.ColorThemeKind.Light);
		await debounce();
		assert.deepEqual(handle.current(), [], "Demo Dark is not a light theme");
		assert.equal(changed, 2);
		stub.workspace.settings = { "workbench.colorTheme": "Demo Light" };
		stub.window.setColorThemeKind(stub.ColorThemeKind.Light);
		await debounce();
		assert.deepEqual(ids(handle.current()), ["Demo Light"]);
	});

	it("re-resolves when the installed extensions change", async () => {
		const handle = start();
		await settle();
		files = { ...FILES, [`${EXT}/themes/dark.json`]: themeFile("#123456") };
		stub.extensions.fireChange();
		await debounce();
		assert.deepEqual(handle.current()[0]?.rules, [{ scopes: ["string"], foreground: "#123456" }]);
		assert.equal(changed, 2);
	});

	it("does not announce a result identical to the last one", async () => {
		start();
		await settle();
		const before = reads.length;
		stub.extensions.fireChange();
		await debounce();
		assert.ok(reads.length > before, "it did resolve again");
		assert.equal(changed, 1);
		assert.equal(logs.length, 2, "but the resolution is logged");
	});

	it("drops a resolution that a newer change superseded", async () => {
		let release!: () => void;
		gate = new Promise<void>(resolve => { release = resolve; });
		const handle = start();
		await settle();
		// The first resolution is stuck reading Demo Dark; the setting moves on and the second one finishes first.
		stub.workspace.settings = { "workbench.colorTheme": "Demo Two" };
		stub.workspace.fireConfigurationChange("workbench.colorTheme");
		gate = null;
		await debounce();
		assert.deepEqual(ids(handle.current()), ["Demo Two"]);
		assert.equal(changed, 1);
		release();
		await settle();
		assert.deepEqual(ids(handle.current()), ["Demo Two"], "the slow, older result did not overwrite the newer one");
		assert.equal(changed, 1);
		assert.equal(logs.length, 1, "the dropped resolution is not logged");
	});

	it("logs and gives no themes when reading VS Code fails, and keeps going", async () => {
		const handle = start();
		await settle();
		assert.deepEqual(ids(handle.current()), ["Demo Dark"]);
		Object.defineProperty(stub.extensions, "all", { configurable: true, get() { throw new Error("host gone"); } });
		try {
			stub.extensions.fireChange();
			await debounce();
		} finally {
			Object.defineProperty(stub.extensions, "all", { configurable: true, writable: true, value: [] });
		}
		assert.deepEqual(handle.current(), []);
		assert.match(logs.join("\n"), /resolution failed: host gone/);
		assert.equal(changed, 2);
	});

	it("logs a failing change callback without throwing", async () => {
		registerCodeTheme({ subscriptions } as never, {
			changed() { throw new Error("pages gone"); },
			log: message => { logs.push(message); },
			...ports,
		});
		await settle();
		assert.match(logs.join("\n"), /change notification failed: pages gone/);
	});

	it("stops reacting once disposed, and drops a resolution still in flight", async () => {
		let release!: () => void;
		gate = new Promise<void>(resolve => { release = resolve; });
		const handle = start();
		await settle();
		handle.dispose();
		release();
		await settle();
		assert.deepEqual(handle.current(), []);
		assert.equal(changed, 0);
		const before = reads.length;
		stub.workspace.fireConfigurationChange("workbench.colorTheme");
		stub.extensions.fireChange();
		await debounce();
		assert.equal(reads.length, before);
	});
});
