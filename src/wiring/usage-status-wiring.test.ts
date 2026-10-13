/**
 * The status bar item's wiring: visibility, the severity background, the one-minute timer that runs only
 * while the item is visible, and the click command. `vscode` is the stand-in of `vscode-test-stub.ts`, so this
 * file must run under `node --test`. The text rules themselves are `src/host/usage-status.test.ts`.
 */
import assert from "node:assert/strict";
import module from "node:module";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { UsageStatusSource } from "../host/usage-status.ts";

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
const { registerUsageStatus, USAGE_STATUS_REFRESH_COMMAND } = await import("./usage-status-wiring.ts");

const T0 = 1_800_000_000_000;
const MIN = 60_000;

describe("registerUsageStatus", () => {
	let source: UsageStatusSource | null;
	let refreshed: number;
	let subscriptions: { dispose(): void }[];
	const start = () => registerUsageStatus({ subscriptions } as never, { source: () => source, refresh: () => { refreshed++; } });

	beforeEach(() => {
		mock.timers.enable({ apis: ["setInterval", "Date"], now: T0 });
		stub.window.statusBarItems.length = 0;
		stub.commands.registered.clear();
		source = null;
		refreshed = 0;
		subscriptions = [];
	});
	afterEach(() => {
		mock.timers.reset();
	});

	it("creates one left item that is hidden until there is a reading, and registers the click command", () => {
		const handle = start();
		const item = stub.window.statusBarItems[0]!;
		assert.equal(stub.window.statusBarItems.length, 1);
		assert.equal(item.alignment, stub.StatusBarAlignment.Left);
		assert.equal(item.command, USAGE_STATUS_REFRESH_COMMAND);
		assert.equal(item.visible, false);
		stub.commands.registered.get(USAGE_STATUS_REFRESH_COMMAND)?.();
		assert.equal(refreshed, 1, "a click asks for a forced refresh");
		handle.dispose();
	});

	it("shows the text with the pulse icon, the tooltip and the severity background", () => {
		const handle = start();
		const item = stub.window.statusBarItems[0]!;
		source = { provider: "anthropic", windows: [{ label: "5h", usedPercent: 42, resetsAt: T0 + 133 * MIN }, { label: "7d", usedPercent: 18, resetsAt: T0 + (3 * 1440 + 4 * 60) * MIN }], accountSelection: null, readAt: T0 };
		handle.update();
		assert.equal(item.visible, true);
		assert.equal(item.text, "$(pulse) 5h 42% · 2h13m  \u2502  7d 18% · 3d4h");
		assert.match(item.tooltip ?? "", /^OMP Desk provider usage: anthropic\n5h: 42% used/);
		const background = (): string | undefined => item.backgroundColor?.id;
		assert.equal(background(), undefined);
		source = { ...source, windows: [{ label: "5h", usedPercent: 80, resetsAt: null }] };
		handle.update();
		assert.equal(background(), "statusBarItem.warningBackground");
		source = { ...source, windows: [{ label: "5h", usedPercent: 95, resetsAt: null }] };
		handle.update();
		assert.equal(background(), "statusBarItem.errorBackground");
		source = { ...source, windows: [{ label: "5h", usedPercent: 10, resetsAt: null }] };
		handle.update();
		assert.equal(background(), undefined);
		handle.dispose();
	});

	it("ticks once a minute while visible so the countdown moves, and stops when hidden or disposed", () => {
		const handle = start();
		const item = stub.window.statusBarItems[0]!;
		source = { provider: "p", windows: [{ label: "5h", usedPercent: 1, resetsAt: T0 + 5 * MIN }], accountSelection: null, readAt: T0 };
		handle.update();
		assert.equal(item.text, "$(pulse) 5h 1% · 5m");
		mock.timers.tick(MIN);
		assert.equal(item.text, "$(pulse) 5h 1% · 4m");
		mock.timers.tick(5 * MIN);
		assert.equal(item.text, "$(pulse) 5h 1%", "a reset that passed shows no time until the next refresh");
		source = null;
		mock.timers.tick(MIN);
		assert.equal(item.visible, false, "the tick hides the item once the reading is gone");
		source = { provider: "p", windows: [{ label: "5h", usedPercent: 1, resetsAt: null }], accountSelection: null, readAt: T0 };
		mock.timers.tick(10 * MIN);
		assert.equal(item.visible, false, "no timer ran while hidden");
		handle.update();
		assert.equal(item.visible, true);
		assert.equal(item.text, "$(pulse) 5h 1%");
		handle.dispose();
		source = { provider: "p", windows: [{ label: "5h", usedPercent: 2, resetsAt: null }], accountSelection: null, readAt: T0 };
		mock.timers.tick(MIN);
		assert.equal(item.text, "$(pulse) 5h 1%", "no timer survives dispose");
		assert.equal(item.disposed, true);
		assert.equal(stub.commands.registered.has(USAGE_STATUS_REFRESH_COMMAND), false);
	});

	it("clears the timer when the extension context is disposed", () => {
		source = { provider: "p", windows: [{ label: "5h", usedPercent: 1, resetsAt: null }], accountSelection: null, readAt: T0 };
		start();
		const item = stub.window.statusBarItems[0]!;
		assert.equal(item.text, "$(pulse) 5h 1%");
		for (const subscription of subscriptions) subscription.dispose();
		source = { provider: "p", windows: [{ label: "5h", usedPercent: 2, resetsAt: null }], accountSelection: null, readAt: T0 };
		mock.timers.tick(MIN);
		assert.equal(item.text, "$(pulse) 5h 1%");
		assert.equal(item.disposed, true);
	});
});
