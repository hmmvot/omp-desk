import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeOmp, fakeSpawner, providerPeer } from "./provider-login-fake-omp.ts";
import type { FakeFrame } from "./provider-login-fake-omp.ts";
import { API_KEY_HINT, runProviderLogin, runProviderLogout } from "./provider-login-flow.ts";
import type { LoginFlowDeps, LoginUi, UiPickItem } from "./provider-login-flow.ts";
import { startLoginSession } from "./provider-login-rpc.ts";
import type { LoginSession } from "./provider-login-rpc.ts";

const SECRET = "S3CRET-AUTH-CODE-4711";
const OAUTH_URL = "https://claude.ai/oauth/authorize?state=STATE-TOKEN&code_challenge=CHALLENGE";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const until = async (condition: () => boolean): Promise<void> => {
	for (let turns = 0; turns < 50 && !condition(); turns++) await tick();
	assert.ok(condition(), "the condition did not become true");
};

/** A scripted editor: it records what was shown and answers from the queues a test fills. */
class FakeUi implements LoginUi {
	readonly shown: string[] = [];
	readonly progressTitles: string[] = [];
	readonly progressReports: string[] = [];
	readonly picks: { items: readonly UiPickItem<unknown>[]; title: string; placeholder: string }[] = [];
	readonly notices: { level: string; message: string; actions: readonly string[] }[] = [];
	readonly opened: string[] = [];
	readonly copied: string[] = [];
	readonly secretPrompts: { title: string; prompt: string; placeholder?: string }[] = [];
	readonly confirms: { message: string; detail: string; action: string }[] = [];
	/** What a pick resolves with: an item index, or a function of the items. */
	pickAnswers: (number | undefined | ((items: readonly UiPickItem<unknown>[]) => unknown))[] = [];
	secretAnswer: string | undefined | "never" = SECRET;
	confirmAnswer = true;
	browserOpens = true;
	noticeAnswer: string | undefined;
	/** A notice nobody ever answers (a toast that hid itself). */
	noticesStayOpen = false;
	/** Cancel of the progress notification currently showing. */
	cancelProgress: (() => void) | null = null;
	secretSignal: AbortSignal | null = null;

	async withProgress<T>(title: string, run: (report: (message: string) => void, signal: AbortSignal) => Promise<T>): Promise<T> {
		this.progressTitles.push(title);
		const abort = new AbortController();
		this.cancelProgress = () => abort.abort();
		try {
			return await run(message => { this.progressReports.push(message); this.shown.push(message); }, abort.signal);
		} finally {
			this.cancelProgress = null;
		}
	}
	async pick<T>(items: readonly UiPickItem<T>[], options: { title: string; placeholder: string }): Promise<T | undefined> {
		this.picks.push({ items, ...options });
		const answer = this.pickAnswers.shift();
		const chosen = typeof answer === "function" ? answer(items) : answer;
		return typeof chosen === "number" ? items[chosen]?.value : undefined;
	}
	async askSecret(options: { title: string; prompt: string; placeholder?: string }, signal: AbortSignal): Promise<string | undefined> {
		this.secretPrompts.push(options);
		this.secretSignal = signal;
		if (this.secretAnswer === "never") return await new Promise<string | undefined>(resolve => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
		return this.secretAnswer;
	}
	async confirm(message: string, detail: string, action: string): Promise<boolean> {
		this.confirms.push({ message, detail, action });
		return this.confirmAnswer;
	}
	async openExternal(url: string): Promise<boolean> {
		this.opened.push(url);
		return this.browserOpens;
	}
	async copy(text: string): Promise<void> {
		this.copied.push(text);
	}
	async notify(level: "info" | "warning" | "error", message: string, actions: readonly string[]): Promise<string | undefined> {
		this.notices.push({ level, message, actions });
		this.shown.push(message);
		if (this.noticesStayOpen) return new Promise<string | undefined>(() => undefined);
		return this.noticeAnswer !== undefined && actions.includes(this.noticeAnswer) ? this.noticeAnswer : undefined;
	}
}

interface Harness {
	readonly ui: FakeUi;
	/** The browser settle timer: `fire()` runs it now. */
	readonly settle: { fire(): void; readonly pending: () => boolean };
	readonly logs: string[];
	readonly terminals: (string | undefined)[];
	readonly changed: { count: number };
	readonly window: AbortController;
	readonly deps: LoginFlowDeps;
	readonly spawned: FakeOmp[];
}

function harness(make: () => FakeOmp, ui = new FakeUi()): Harness {
	const logs: string[] = [];
	const terminals: (string | undefined)[] = [];
	const changed = { count: 0 };
	const window = new AbortController();
	const { spawner, spawned } = fakeSpawner(make);
	let timer: (() => void) | null = null;
	const settle = { fire() { const callback = timer; timer = null; callback?.(); }, pending: () => timer !== null };
	const deps: LoginFlowDeps = {
		ui,
		start: signal => startLoginSession({ scope: { executable: { command: "omp", prefixArgs: [] }, env: {}, cwd: "D:\\work" }, spawner, signal, modelSelectors: ["gpt"] }),
		openTerminal: providerId => { terminals.push(providerId); },
		credentialsChanged: () => { changed.count++; },
		log: message => logs.push(message),
		signal: window.signal,
		timers: { setTimeout: callback => { timer = callback; return 1; }, clearTimeout: () => { timer = null; } },
	};
	return { ui, settle, logs, terminals, changed, window, deps, spawned };
}

/** The peer a successful paste-code login talks to. */
function loginPeer(finish: "success" | ((frame: FakeFrame, peer: FakeOmp) => void) = "success", prompt = true): FakeOmp {
	return providerPeer((frame, peer) => {
		if (frame.type !== "login") return;
		peer.ui("notify", { message: "Opening the sign-in page" });
		peer.ui("open_url", { url: OAUTH_URL, launchUrl: "http://127.0.0.1:41999/launch/abc", instructions: "Complete login in your browser." });
		if (prompt) peer.ui("input", { title: "Paste the authorization code (or full redirect URL):" });
		if (typeof finish === "function") finish(frame, peer);
	});
}

const providerIdOf = (value: unknown): string | null =>
	typeof value === "object" && value !== null && "provider" in value && typeof value.provider === "object" && value.provider !== null && "id" in value.provider && typeof value.provider.id === "string" ? value.provider.id : null;
/** An idle process ends the way OMP expects: its stdin closed, it exits by itself, nothing is killed. */
function assertClosedGracefully(peer: FakeOmp, message?: string): void {
	assert.deepEqual([peer.stdinEnded, peer.exited, peer.killed], [true, true, false], message);
}

const choose = (id: string) => (items: readonly UiPickItem<unknown>[]) => items.findIndex(item => providerIdOf(item.value) === id);

describe("the provider picker", () => {
	it("lists the OAuth providers OMP marks available, a check on the signed-in ones, and ends with the API-key line", async () => {
		const run = harness(() => providerPeer());
		run.ui.pickAnswers = [undefined];
		assert.equal(await runProviderLogin(run.deps), "cancelled");
		const [picker] = run.ui.picks;
		assert.deepEqual(picker!.items.map(item => [item.label, item.icon ?? null]), [
			["Anthropic (Claude Pro/Max)", "check"],
			["ChatGPT Plus/Pro (Codex Subscription)", null],
			["OpenRouter", null],
			["Other providers", "terminal"],
		]);
		assert.equal(picker!.items.at(-1)!.description, API_KEY_HINT);
		assert.match(API_KEY_HINT, /omp.*terminal.*\/login/);
		assert.ok(picker!.placeholder.includes(API_KEY_HINT));
		assertClosedGracefully(run.spawned[0]!, "dismissing the picker ends the OMP process through its stdin");
		assert.deepEqual(run.terminals, []);
	});

	it("opens the visible terminal login from the last item", async () => {
		const run = harness(() => providerPeer());
		run.ui.pickAnswers = [items => items.length - 1];
		assert.equal(await runProviderLogin(run.deps), "terminal");
		assert.deepEqual(run.terminals, [undefined]);
		assertClosedGracefully(run.spawned[0]!);
	});

	it("offers the terminal login when OMP could not be started, and starts nothing else", async () => {
		const run = harness(() => { const peer = new FakeOmp({ ready: false }); setImmediate(() => peer.exit(1)); return peer; });
		run.ui.noticeAnswer = "Open Terminal Login";
		assert.equal(await runProviderLogin(run.deps), "failed");
		assert.deepEqual(run.terminals, [undefined]);
		assert.equal(run.ui.picks.length, 0);
	});
});

describe("a sign-in", () => {
	it("opens the sign-in address in the browser, reads the pasted code through a masked prompt, and refreshes models on success", async () => {
		const run = harness(() => loginPeer());
		run.ui.pickAnswers = [choose("openai-codex")];
		const flow = runProviderLogin(run.deps);
		await until(() => run.ui.secretPrompts.length === 1);
		const peer = run.spawned.at(-1)!;
		assert.deepEqual(run.ui.opened, [OAUTH_URL], "the full address is opened, not the loopback launch address");
		assert.deepEqual(run.ui.secretPrompts, [{ title: "Log In to ChatGPT Plus/Pro (Codex Subscription)", prompt: "Paste the authorization code (or full redirect URL):" }]);
		assert.ok(run.ui.progressReports.some(message => message.includes("claude.ai") && message.includes("Complete login in your browser.")));
		await until(() => peer.uiResponses().length === 1);
		assert.equal(peer.uiResponses()[0]!.value, SECRET);
		peer.reply(peer.written.find(frame => frame.type === "login")!, true, { data: { providerId: "openai-codex" } });
		assert.equal(await flow, "signed-in");
		assert.equal(run.changed.count, 1);
		assert.deepEqual(run.ui.notices.map(notice => [notice.level, notice.message]), [["info", "Signed in to ChatGPT Plus/Pro (Codex Subscription)."]]);
		assert.deepEqual(run.ui.progressTitles, ["Log In to Provider", "Signing in to ChatGPT Plus/Pro (Codex Subscription)"]);
		assertClosedGracefully(peer, "the process ends with the login");
	});

	it("holds the sign-in address through the settle window, then opens it for a sign-in that needs no pasted answer", async () => {
		const run = harness(() => loginPeer("success", false));
		run.ui.pickAnswers = [choose("anthropic")];
		const flow = runProviderLogin(run.deps);
		await until(() => run.settle.pending());
		assert.deepEqual(run.ui.opened, [], "nothing opens before the settle window has passed");
		run.settle.fire();
		await until(() => run.ui.opened.length === 1);
		assert.deepEqual(run.ui.opened, [OAUTH_URL]);
		const peer = run.spawned[0]!;
		peer.reply(peer.written.find(frame => frame.type === "login")!, true, { data: { providerId: "anthropic" } });
		assert.equal(await flow, "signed-in");
		assert.deepEqual(run.ui.secretPrompts, []);
		assert.equal(run.changed.count, 1);
	});

	it("signs in to a provider named by the caller without showing the picker, and falls back to the picker for an unlisted id", async () => {
		const named = harness(() => loginPeer("success", false));
		const first = runProviderLogin(named.deps, { providerId: "anthropic" });
		await until(() => named.settle.pending());
		named.settle.fire();
		const peer = named.spawned[0]!;
		peer.reply(peer.written.find(frame => frame.type === "login")!, true, { data: { providerId: "anthropic" } });
		assert.equal(await first, "signed-in");
		assert.equal(named.ui.picks.length, 0, "no provider pick");
		const unlisted = harness(() => loginPeer());
		unlisted.ui.pickAnswers = [() => -1];
		assert.equal(await runProviderLogin(unlisted.deps, { providerId: "not-a-provider" }), "cancelled");
		assert.equal(unlisted.ui.picks.length, 1, "the picker is the answer to an id OMP does not list");
	});

	it("opens nothing for a login that ends inside the settle window", async () => {
		const run = harness(() => loginPeer(frame => undefined, false));
		run.ui.pickAnswers = [choose("anthropic")];
		const flow = runProviderLogin(run.deps);
		await until(() => run.settle.pending());
		const peer = run.spawned[0]!;
		peer.reply(peer.written.find(frame => frame.type === "login")!, false, { error: "denied" });
		await flow;
		assert.equal(run.settle.pending(), false, "the timer is cleared with the login");
		assert.deepEqual(run.ui.opened, []);
	});

	it("declines a provider that asks for an API key before the browser opens, and offers the terminal login", async () => {
		const run = harness(() => providerPeer((frame, peer) => {
			if (frame.type !== "login") return;
			peer.ui("open_url", { url: "https://platform.deepseek.com/api_keys", instructions: "Create or copy your API key from the DeepSeek dashboard" });
			peer.ui("input", { title: "Paste your DeepSeek API key" });
		}));
		run.ui.pickAnswers = [items => items.findIndex(item => item.label === "OpenRouter")];
		run.ui.noticeAnswer = "Open Terminal Login";
		assert.equal(await runProviderLogin(run.deps), "declined");
		await until(() => run.terminals.length === 1);
		assert.deepEqual(run.ui.opened, [], "the provider's dashboard page is not opened for nothing");
		assert.deepEqual(run.ui.secretPrompts, [], "no API key is asked for in VS Code");
		assert.deepEqual(run.spawned[0]!.uiResponses(), []);
		assert.equal(run.spawned[0]!.killed, true);
		assert.match(run.ui.notices[0]!.message, /cannot sign in from VS Code: it asks for something other than a browser sign-in\./);
		assert.ok(run.ui.notices[0]!.message.endsWith(`${API_KEY_HINT}.`));
		assert.deepEqual(run.terminals, ["openrouter"]);
		assert.equal(run.changed.count, 0);
		assert.ok(![...run.logs, ...run.ui.shown].some(line => line.includes("DeepSeek") || line.includes("deepseek")), "nothing OMP's prompt said is logged or shown");
	});

	it("never lets the pasted code, the sign-in address or OMP's text into the log, a notice or a progress line", async () => {
		const run = harness(() => loginPeer((frame, peer) => peer.reply(frame, false, { error: `exchange failed for code=${SECRET} at ${OAUTH_URL}` })));
		run.ui.pickAnswers = [choose("openai-codex")];
		run.ui.noticeAnswer = undefined;
		assert.equal(await runProviderLogin(run.deps), "failed");
		const peer = run.spawned[0]!;
		assert.ok(peer.stdinText.includes(SECRET), "the code went to OMP, which is its only destination");
		const everything = [...run.logs, ...run.ui.notices.map(notice => notice.message), ...run.ui.progressReports, ...run.ui.progressTitles].join("\n");
		for (const forbidden of [SECRET, "STATE-TOKEN", "CHALLENGE", "oauth/authorize", "41999", "exchange failed"]) assert.ok(!everything.includes(forbidden), `${forbidden} reached a diagnostic or notice`);
		assert.ok(run.logs.some(line => line.includes("https://claude.ai")), "the origin alone is logged");
		assert.ok(run.logs.every(line => !line.includes("?") || !line.includes("http")));
	});

	it("keeps the secret out of the log on success as well", async () => {
		const run = harness(() => loginPeer());
		run.ui.pickAnswers = [choose("anthropic")];
		const flow = runProviderLogin(run.deps);
		await until(() => run.spawned.at(-1)?.uiResponses().length === 1);
		const peer = run.spawned[0]!;
		peer.reply(peer.written.find(frame => frame.type === "login")!, true, { data: { providerId: "anthropic" } });
		await flow;
		assert.ok(![...run.logs, ...run.ui.shown].some(line => line.includes(SECRET)));
	});

	it("cancels mid-flow: Cancel on the progress ends the process, resolves cancelled and reports no failure", async () => {
		const run = harness(() => loginPeer());
		run.ui.secretAnswer = "never";
		run.ui.pickAnswers = [choose("openai-codex")];
		const flow = runProviderLogin(run.deps);
		await until(() => run.ui.secretPrompts.length === 1 && run.ui.opened.length === 1);
		run.ui.cancelProgress!();
		assert.equal(await flow, "cancelled");
		const peer = run.spawned[0]!;
		assert.equal(peer.killed, true);
		assert.equal(run.ui.secretSignal!.aborted, true, "the open input box is dismissed");
		assert.deepEqual(peer.uiResponses(), [], "the pending prompt is not answered");
		assert.equal(run.changed.count, 1, "OMP stores a credential before it refreshes online: the models are re-read");
		assert.deepEqual(run.ui.notices, []);
		assert.ok(run.logs.some(line => line.endsWith("was cancelled")));
	});

	it("cancels when the user dismisses the masked prompt", async () => {
		const run = harness(() => loginPeer());
		run.ui.secretAnswer = undefined;
		run.ui.pickAnswers = [choose("openai-codex")];
		assert.equal(await runProviderLogin(run.deps), "cancelled");
		assert.equal(run.spawned[0]!.killed, true);
		assert.deepEqual(run.ui.notices, []);
		assert.equal(run.changed.count, 1);
	});

	it("ends the process when the window closes during the sign-in", async () => {
		const run = harness(() => loginPeer());
		run.ui.secretAnswer = "never";
		run.ui.pickAnswers = [choose("openai-codex")];
		const flow = runProviderLogin(run.deps);
		await until(() => run.ui.secretPrompts.length === 1);
		run.window.abort();
		assert.equal(await flow, "cancelled");
		assert.equal(run.spawned[0]!.killed, true);
	});

	it("explains a refusal in fixed words and falls back to the terminal login for that provider when asked", async () => {
		const withoutAnswer = harness(() => providerPeer((frame, peer) => { if (frame.type === "login") peer.reply(frame, false, { error: "Provider 'openrouter' requires secret input, which is not supported in RPC mode." }); }));
		withoutAnswer.ui.pickAnswers = [choose("openrouter")];
		assert.equal(await runProviderLogin(withoutAnswer.deps), "declined");
		assert.match(withoutAnswer.ui.notices[0]!.message, /^OpenRouter cannot sign in from VS Code/);
		assert.ok(withoutAnswer.ui.notices[0]!.message.endsWith(`${API_KEY_HINT}.`));
		assert.deepEqual(withoutAnswer.terminals, []);
		assert.ok(!withoutAnswer.ui.notices[0]!.message.includes("secret input"), "OMP's own sentence is not forwarded");

		const run = harness(() => providerPeer((frame, peer) => { if (frame.type === "login") peer.reply(frame, false, { error: "x which is not supported in RPC mode" }); }));
		run.ui.pickAnswers = [choose("openrouter")];
		run.ui.noticeAnswer = "Open Terminal Login";
		assert.equal(await runProviderLogin(run.deps), "declined");
		await until(() => run.terminals.length === 1);
		assert.deepEqual(run.terminals, ["openrouter"]);
		assert.equal(run.changed.count, 0);
	});

	it("offers a terminal retry after an ordinary failure, without OMP's text", async () => {
		const run = harness(() => providerPeer((frame, peer) => { if (frame.type === "login") peer.reply(frame, false, { error: "invalid_grant for me@example.test" }); }));
		run.ui.pickAnswers = [choose("anthropic")];
		run.ui.noticeAnswer = "Try in Terminal";
		assert.equal(await runProviderLogin(run.deps), "failed");
		await until(() => run.terminals.length === 1);
		assert.deepEqual(run.terminals, ["anthropic"]);
		assert.equal(run.ui.notices[0]!.message, "Signing in to Anthropic (Claude Pro/Max) did not complete.");
	});

	it("does not wait for an outcome notice nobody answers: the flow ends and the process has exited", async () => {
		const refused = harness(() => providerPeer((frame, peer) => { if (frame.type === "login") peer.reply(frame, false, { error: "x which is not supported in RPC mode" }); }));
		refused.ui.noticesStayOpen = true;
		refused.ui.pickAnswers = [choose("openrouter")];
		assert.equal(await runProviderLogin(refused.deps), "declined");
		assertClosedGracefully(refused.spawned[0]!);
		const failed = harness(() => providerPeer((frame, peer) => { if (frame.type === "login") peer.reply(frame, false, { error: "nope" }); }));
		failed.ui.noticesStayOpen = true;
		failed.ui.pickAnswers = [choose("anthropic")];
		assert.equal(await runProviderLogin(failed.deps), "failed");
		assertClosedGracefully(failed.spawned[0]!);
	});

	it("refuses an address that is not a web link and ends the login without opening anything", async () => {
		const run = harness(() => providerPeer((frame, peer) => { if (frame.type === "login") peer.ui("open_url", { url: "file:///C:/Windows/System32/cmd.exe" }); }));
		run.ui.pickAnswers = [choose("anthropic")];
		assert.equal(await runProviderLogin(run.deps), "failed");
		assert.deepEqual(run.ui.opened, []);
		assert.match(run.ui.notices[0]!.message, /not a web link/);
		assert.equal(run.spawned[0]!.killed, true);
	});

	it("offers the link to copy when the browser cannot be opened", async () => {
		const run = harness(() => loginPeer());
		run.ui.browserOpens = false;
		run.ui.noticeAnswer = "Copy Link";
		run.ui.pickAnswers = [choose("anthropic")];
		const flow = runProviderLogin(run.deps);
		await until(() => run.ui.copied.length === 1);
		assert.deepEqual(run.ui.copied, [OAUTH_URL]);
		assert.match(run.ui.notices[0]!.message, /browser could not be opened/);
		const peer = run.spawned[0]!;
		peer.reply(peer.written.find(frame => frame.type === "login")!, true, { data: { providerId: "anthropic" } });
		await flow;
	});
});

describe("logout", () => {
	function logoutPeer(accounts: unknown[], remainingSource?: string): FakeOmp {
		return providerPeer((frame, peer) => {
			if (frame.type === "get_logout_accounts") peer.reply(frame, true, { data: { accounts } });
			if (frame.type === "logout") peer.reply(frame, true, { data: remainingSource === undefined ? {} : { remainingSource } });
		});
	}
	const account = { credentialId: 7, provider: "anthropic", label: "me@example.test", detail: "Pro plan", type: "oauth", active: true };

	it("picks a signed-in provider, then an account, confirms, removes it and refreshes models", async () => {
		const peer = logoutPeer([account, { ...account, credentialId: 9, label: "work@example.test", active: false }], "env ANTHROPIC_API_KEY");
		const run = harness(() => peer);
		run.ui.pickAnswers = [0, 1];
		assert.equal(await runProviderLogout(run.deps), "logged-out");
		assert.deepEqual(run.ui.picks[0]!.items.map(item => item.label), ["Anthropic (Claude Pro/Max)"], "only providers with a credential are offered");
		assert.deepEqual(run.ui.picks[1]!.items.map(item => [item.label, item.description]), [["me@example.test", "OAuth · active"], ["work@example.test", "OAuth"]]);
		assert.equal(run.ui.confirms.length, 1);
		assert.equal(run.ui.confirms[0]!.action, "Log Out");
		assert.match(run.ui.confirms[0]!.detail, /work@example\.test/);
		const logout = peer.written.find(frame => frame.type === "logout")!;
		assert.deepEqual({ providerId: logout.providerId, credentialId: logout.credentialId }, { providerId: "anthropic", credentialId: 9 });
		assert.equal(run.changed.count, 1);
		assert.match(run.ui.notices.at(-1)!.message, /Logged out of Anthropic .* still signs in through env ANTHROPIC_API_KEY/);
		assert.ok(![...run.logs].some(line => line.includes("example.test")), "an account label is never logged");
		assertClosedGracefully(peer);
	});

	it("removes nothing when the confirmation is declined or any pick is dismissed", async () => {
		const declined = harness(() => logoutPeer([account]));
		declined.ui.pickAnswers = [0, 0];
		declined.ui.confirmAnswer = false;
		assert.equal(await runProviderLogout(declined.deps), "cancelled");
		assert.equal(declined.spawned[0]!.written.some(frame => frame.type === "logout"), false);
		assert.equal(declined.changed.count, 0);

		const dismissed = harness(() => logoutPeer([account]));
		dismissed.ui.pickAnswers = [undefined];
		assert.equal(await runProviderLogout(dismissed.deps), "cancelled");
		const second = harness(() => logoutPeer([account]));
		second.ui.pickAnswers = [0, undefined];
		assert.equal(await runProviderLogout(second.deps), "cancelled");
		assert.equal(second.ui.confirms.length, 0);
	});

	it("explains a provider that signs in through the environment, which has no stored credential to remove", async () => {
		const run = harness(() => logoutPeer([]));
		run.ui.pickAnswers = [0];
		assert.equal(await runProviderLogout(run.deps), "nothing");
		assert.match(run.ui.notices[0]!.message, /no stored credential/);
		assert.equal(run.ui.confirms.length, 0);
	});

	it("reports a removal OMP refused without OMP's text", async () => {
		const peer = providerPeer((frame, self) => {
			if (frame.type === "get_logout_accounts") self.reply(frame, true, { data: { accounts: [account] } });
			if (frame.type === "logout") self.reply(frame, false, { error: "Credential 7 is not stored for anthropic" });
		});
		const run = harness(() => peer);
		run.ui.pickAnswers = [0, 0];
		assert.equal(await runProviderLogout(run.deps), "failed");
		assert.equal(run.ui.notices.at(-1)!.message, "The credential of Anthropic (Claude Pro/Max) could not be removed.");
		assert.equal(run.changed.count, 1, "a removal that timed out may still have happened: the models are re-read");
	});

	it("says so when no provider is signed in", async () => {
		const run = harness(() => { const peer = new FakeOmp(); peer.onFrame = (frame, self) => self.reply(frame, true, { data: { providers: [{ id: "a", name: "A", available: true, authenticated: false }] } }); return peer; });
		assert.equal(await runProviderLogout(run.deps), "nothing");
		assert.match(run.ui.notices[0]!.message, /No provider is signed in/);
	});
});

describe("the process ends with every flow", () => {
	it("leaves no running session whichever way a flow ends", async () => {
		const sessions: LoginSession[] = [];
		const run = harness(() => loginPeer());
		const start = run.deps.start;
		const tracked: LoginFlowDeps = { ...run.deps, start: async signal => { const session = await start(signal); sessions.push(session); return session; } };
		run.ui.pickAnswers = [undefined];
		await runProviderLogin(tracked);
		run.ui.pickAnswers = [choose("openai-codex")];
		run.ui.secretAnswer = undefined;
		await runProviderLogin(tracked);
		assert.equal(sessions.length, 2);
		assert.ok(sessions.every(session => session.closed));
	});
});
