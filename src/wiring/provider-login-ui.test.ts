import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLoginUi } from "./provider-login-ui.ts";
import type { LoginUiApi } from "./provider-login-ui.ts";

type Listener = () => void;

/** The part of the editor API the adapter calls, recording what it was asked and answering from the test. */
function fakeApi() {
	const calls = {
		quickPicks: [] as { items: readonly { label: string; description?: string; detail?: string; value: unknown }[]; options: Record<string, unknown> }[],
		inputBoxes: [] as Record<string, unknown>[],
		progress: [] as { options: Record<string, unknown>; messages: string[] }[],
		warnings: [] as unknown[][],
		infos: [] as unknown[][],
		errors: [] as unknown[][],
		opened: [] as { target: string; strict: unknown }[],
		clipboard: [] as string[],
	};
	const cancellations: { cancel(): void; disposed: boolean; token: { isCancellationRequested: boolean } }[] = [];
	const answers = { quickPick: (items: readonly unknown[]): unknown => items[0], inputBox: (): string | undefined => "typed", warning: (..._args: unknown[]): unknown => undefined, opens: true };
	let cancelProgress: Listener | null = null;
	const api = {
		window: {
			async withProgress(options: Record<string, unknown>, task: (progress: { report(value: { message?: string }): void }, token: { isCancellationRequested: boolean; onCancellationRequested(listener: Listener): { dispose(): void } }) => Promise<unknown>) {
				const record = { options, messages: [] as string[] };
				calls.progress.push(record);
				const listeners = new Set<Listener>();
				const token = { isCancellationRequested: false, onCancellationRequested: (listener: Listener) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; } };
				cancelProgress = () => { token.isCancellationRequested = true; for (const listener of [...listeners]) listener(); };
				return await task({ report: value => { if (value.message !== undefined) record.messages.push(value.message); } }, token);
			},
			async showQuickPick(items: readonly { label: string; description?: string; detail?: string; value: unknown }[], options: Record<string, unknown>) {
				calls.quickPicks.push({ items, options });
				return answers.quickPick(items);
			},
			async showInputBox(options: Record<string, unknown>) {
				calls.inputBoxes.push(options);
				return answers.inputBox();
			},
			async showWarningMessage(...args: unknown[]) { calls.warnings.push(args); return answers.warning(...args); },
			async showInformationMessage(...args: unknown[]) { calls.infos.push(args); return undefined; },
			async showErrorMessage(...args: unknown[]) { calls.errors.push(args); return undefined; },
		},
		env: {
			async openExternal() { return answers.opens; },
			clipboard: { async writeText(text: string) { calls.clipboard.push(text); } },
		},
		Uri: { parse: (value: string, strict?: boolean) => { calls.opened.push({ target: value, strict }); return { toString: () => value }; } },
		ProgressLocation: { Notification: 15 },
		CancellationTokenSource: class {
			readonly #listeners = new Set<Listener>();
			readonly token = { isCancellationRequested: false, onCancellationRequested: (listener: Listener) => { this.#listeners.add(listener); return { dispose: () => { this.#listeners.delete(listener); } }; } };
			constructor() { cancellations.push(this); }
			disposed = false;
			cancel() { this.token.isCancellationRequested = true; for (const listener of [...this.#listeners]) listener(); }
			dispose() { this.disposed = true; }
		},
	};
	return { api: api as unknown as LoginUiApi, calls, answers, cancellations, cancelProgress: () => cancelProgress?.() };
}

describe("the login UI adapter", () => {
	it("shows a notification progress with Cancel and passes Cancel on as an abort", async () => {
		const fake = fakeApi();
		const ui = createLoginUi(fake.api);
		let aborted = false;
		const done = ui.withProgress("Signing in to X", async (report, signal) => {
			report("Waiting for the browser");
			signal.addEventListener("abort", () => { aborted = true; });
			fake.cancelProgress();
			return "result";
		});
		assert.equal(await done, "result");
		assert.equal(aborted, true);
		assert.deepEqual(fake.calls.progress[0]!.options, { location: 15, title: "Signing in to X", cancellable: true });
		assert.deepEqual(fake.calls.progress[0]!.messages, ["Waiting for the browser"]);
	});

	it("draws a check or terminal mark before a label and returns the value of the chosen item, dismissing when the signal aborts", async () => {
		const fake = fakeApi();
		const ui = createLoginUi(fake.api);
		fake.answers.quickPick = items => items[1];
		const abort = new AbortController();
		const picked = await ui.pick([
			{ label: "Anthropic", description: "signed in", icon: "check", value: "a" },
			{ label: "Other providers", description: "API keys", icon: "terminal", value: "t" },
			{ label: "Plain", value: "p" },
		], { title: "Log In to Provider", placeholder: "hint" }, abort.signal);
		assert.equal(picked, "t");
		const [shown] = fake.calls.quickPicks;
		assert.deepEqual(shown!.items.map(item => item.label), ["$(check) Anthropic", "$(terminal) Other providers", "Plain"]);
		assert.deepEqual(shown!.options, { title: "Log In to Provider", placeHolder: "hint", ignoreFocusOut: true, matchOnDescription: true });
		assert.equal(fake.cancellations[0]!.disposed, true, "the token source is released with the dialog");
		fake.answers.quickPick = () => undefined;
		assert.equal(await ui.pick([{ label: "x", value: 1 }], { title: "t", placeholder: "p" }, abort.signal), undefined);
		abort.abort();
		await ui.pick([{ label: "x", value: 1 }], { title: "t", placeholder: "p" }, abort.signal);
		assert.equal(fake.cancellations.at(-1)!.token.isCancellationRequested, true, "an already aborted signal cancels the dialog at once");
	});

	it("asks a pasted secret through a masked input box that survives losing focus", async () => {
		const fake = fakeApi();
		const ui = createLoginUi(fake.api);
		const secret = await ui.askSecret({ title: "Log In to X", prompt: "Paste the code", placeholder: "code" }, new AbortController().signal);
		assert.equal(secret, "typed");
		assert.deepEqual(fake.calls.inputBoxes, [{ title: "Log In to X", prompt: "Paste the code", placeHolder: "code", password: true, ignoreFocusOut: true }]);
		await ui.askSecret({ title: "t", prompt: "p" }, new AbortController().signal);
		assert.equal("placeHolder" in fake.calls.inputBoxes[1]!, false);
		assert.equal(fake.calls.inputBoxes[1]!.password, true);
	});

	it("confirms through a modal that carries the detail, true only for the named action", async () => {
		const fake = fakeApi();
		const ui = createLoginUi(fake.api);
		fake.answers.warning = (_message, _options, action) => action;
		assert.equal(await ui.confirm("Log out?", "detail", "Log Out"), true);
		assert.deepEqual(fake.calls.warnings[0], ["Log out?", { modal: true, detail: "detail" }, "Log Out"]);
		fake.answers.warning = () => undefined;
		assert.equal(await ui.confirm("Log out?", "detail", "Log Out"), false);
	});

	it("opens the address with a strict URI in the system browser and reports a browser that could not open", async () => {
		const fake = fakeApi();
		const ui = createLoginUi(fake.api);
		assert.equal(await ui.openExternal("https://claude.ai/oauth?x=1"), true);
		assert.deepEqual(fake.calls.opened[0], { target: "https://claude.ai/oauth?x=1", strict: true });
		fake.answers.opens = false;
		assert.equal(await ui.openExternal("https://claude.ai/oauth?x=1"), false);
		await ui.copy("text");
		assert.deepEqual(fake.calls.clipboard, ["text"]);
	});

	it("routes notices by level and returns the chosen action", async () => {
		const fake = fakeApi();
		const ui = createLoginUi(fake.api);
		fake.answers.warning = (_message, action) => action;
		assert.equal(await ui.notify("warning", "careful", ["Open Terminal Login"]), "Open Terminal Login");
		await ui.notify("info", "ok", []);
		await ui.notify("error", "bad", ["Retry"]);
		assert.deepEqual(fake.calls.warnings, [["careful", "Open Terminal Login"]]);
		assert.deepEqual(fake.calls.infos, [["ok"]]);
		assert.deepEqual(fake.calls.errors, [["bad", "Retry"]]);
	});
});
