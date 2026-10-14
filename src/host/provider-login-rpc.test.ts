import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { recordingLogger, type LoggedLine } from "../shared/logger.ts";
import { FakeOmp, fakeSpawner, providerPeer } from "./provider-login-fake-omp.ts";
import type { FakeFrame } from "./provider-login-fake-omp.ts";
import { boundedText, LoginStartError, parseLoginProviders, parseLogoutAccounts, startLoginSession } from "./provider-login-rpc.ts";
import type { LoginHooks, LoginProcessScope, LoginTimers } from "./provider-login-rpc.ts";

const SCOPE: LoginProcessScope = { executable: { command: "omp-bin", prefixArgs: ["prefix.js"] }, env: { OMP_PROFILE: "work" }, cwd: "D:\\project" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function hooks(overrides: Partial<LoginHooks> = {}): LoginHooks & { opened: unknown[]; shown: string[]; prompts: unknown[]; cancels: number } {
	const record = { opened: [] as unknown[], shown: [] as string[], prompts: [] as unknown[], cancels: 0 };
	return Object.assign(record, {
		openUrl: (request: unknown) => { record.opened.push(request); },
		prompt: async (prompt: unknown) => { record.prompts.push(prompt); return "answer"; },
		progress: (message: string) => { record.shown.push(message); },
		cancelled: () => { record.cancels++; },
		...overrides,
	}) as never;
}

describe("startLoginSession", () => {
	it("starts the session's own OMP in its directory with its profile and the login-only flags, behind --model", async () => {
		const { spawner, spawned } = fakeSpawner(() => providerPeer());
		const session = await startLoginSession({ scope: SCOPE, spawner });
		const peer = spawned[0]!;
		assert.equal(peer.command, "omp-bin");
		assert.deepEqual(peer.args, ["prefix.js", "--mode", "rpc", "--no-session", "--no-ui", "--no-skills", "--no-rules", "--no-lsp", "--no-tools", "--no-title", "--model", "gpt"]);
		assert.equal(peer.cwd, "D:\\project");
		assert.equal(peer.env.OMP_PROFILE, "work");
		assert.ok(Object.keys(process.env).length === 0 || Object.keys(peer.env).length > 1, "the environment is merged over this process's, not replaced");
		session.dispose();
	});

	it("tries the next selector only after an exit before ready, and reports the exit when none works", async () => {
		const attempts: FakeOmp[] = [];
		const { spawner, spawned } = fakeSpawner(attempt => {
			const peer = new FakeOmp({ ready: attempt === 2 });
			attempts.push(peer);
			if (attempt < 2) setImmediate(() => peer.exit(1));
			return peer;
		});
		const session = await startLoginSession({ scope: SCOPE, spawner });
		assert.deepEqual(spawned.map(peer => peer.args.at(-1)), ["gpt", "claude", "gemini"]);
		session.dispose();

		const failing = fakeSpawner(() => { const peer = new FakeOmp({ ready: false }); setImmediate(() => peer.exit(1)); return peer; });
		await assert.rejects(startLoginSession({ scope: SCOPE, spawner: failing.spawner }), (error: unknown) => error instanceof LoginStartError && error.reason === "exited");
		assert.equal(failing.spawned.length, 3);
	});

	it("does not retry a process that could not be spawned, and rejects with a fixed sentence", async () => {
		let spawns = 0;
		const spawner = () => { spawns++; throw new Error("ENOENT C:\\secret\\path"); };
		await assert.rejects(startLoginSession({ scope: SCOPE, spawner }), (error: unknown) => error instanceof LoginStartError && error.reason === "spawn" && !error.message.includes("secret"));
		assert.equal(spawns, 1);
	});

	it("ends a process that is never ready after the ready timeout, and one whose start is aborted", async () => {
		let fire: (() => void) | null = null;
		const timers: LoginTimers = { setTimeout: callback => { fire = callback; return 1; }, clearTimeout: () => { fire = null; } };
		const silent = fakeSpawner(() => new FakeOmp({ ready: false }));
		const waiting = startLoginSession({ scope: SCOPE, spawner: silent.spawner, timers });
		await tick();
		fire!();
		await assert.rejects(waiting, (error: unknown) => error instanceof LoginStartError && error.reason === "ready-timeout");
		assert.equal(silent.spawned[0]!.killed, true);

		const abort = new AbortController();
		const aborted = fakeSpawner(() => new FakeOmp({ ready: false }));
		const start = startLoginSession({ scope: SCOPE, spawner: aborted.spawner, timers: { setTimeout: () => 1, clearTimeout: () => undefined }, signal: abort.signal });
		await tick();
		abort.abort();
		await assert.rejects(start, LoginStartError);
		assert.equal(aborted.spawned[0]!.killed, true);
		assert.equal(aborted.spawned.length, 1, "an aborted start does not try another selector");
	});
});

describe("providers", () => {
	it("asks get_login_providers and keeps well-formed entries only", async () => {
		const peer = providerPeer();
		const { spawner } = fakeSpawner(() => peer);
		const session = await startLoginSession({ scope: SCOPE, spawner });
		const providers = await session.providers();
		assert.deepEqual(peer.written.map(frame => frame.type), ["get_login_providers"]);
		assert.deepEqual(providers.map(provider => [provider.id, provider.available, provider.authenticated]), [["anthropic", true, true], ["openai-codex", true, false], ["hidden", false, false], ["openrouter", true, false]]);
		assert.deepEqual(parseLoginProviders({ providers: [{ id: "bad id", name: "x" }, { name: "no id" }, 3, { id: "ok", name: "\u001b[31mOK\u0007" }] }), [{ id: "ok", name: "[31mOK", available: false, authenticated: false }]);
		assert.equal(parseLoginProviders({}), null);
		session.dispose();
	});

	it("rejects when OMP answers with a failure, and decodes lines split across chunks, CRLF and noise", async () => {
		const peer = new FakeOmp();
		peer.onFrame = frame => {
			peer.emitRaw("not json at all\r\n");
			const line = JSON.stringify({ type: "response", id: frame.id, command: "get_login_providers", success: true, data: { providers: [{ id: "a", name: "A", available: true, authenticated: false }] } });
			peer.emitRaw(line.slice(0, 20));
			peer.emitRaw(`${line.slice(20)}\r\n`);
		};
		const { spawner } = fakeSpawner(() => peer);
		const session = await startLoginSession({ scope: SCOPE, spawner });
		assert.deepEqual((await session.providers()).map(provider => provider.id), ["a"]);
		session.dispose();

		const failing = new FakeOmp();
		failing.onFrame = frame => failing.reply(frame, false, { error: "TOKEN=hunter2 leaked" });
		const second = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => failing).spawner });
		await assert.rejects(second.providers(), (error: unknown) => error instanceof Error && !error.message.includes("hunter2"));
		second.dispose();
	});
});

describe("login", () => {
	it("follows open_url, notify and a pasted answer to the success response", async () => {
		const peer = providerPeer((frame, self) => {
			if (frame.type !== "login") return;
			self.ui("notify", { message: "Waiting for the browser", notifyType: "info" });
			self.ui("open_url", { url: "https://claude.ai/oauth?state=abc", launchUrl: "http://127.0.0.1:5555/launch", instructions: "Complete login in your browser." });
			self.ui("input", { title: "Paste the authorization code (or full redirect URL):", placeholder: "code" });
		});
		const { spawner } = fakeSpawner(() => peer);
		const session = await startLoginSession({ scope: SCOPE, spawner });
		const follower = hooks();
		const result = session.login("openai-codex", follower);
		await tick(); await tick(); await tick();
		assert.deepEqual(peer.written.at(-1) && peer.written.find(frame => frame.type === "login"), { id: peer.written.find(frame => frame.type === "login")!.id, type: "login", providerId: "openai-codex" });
		assert.deepEqual(follower.shown, ["Waiting for the browser"]);
		assert.deepEqual(follower.opened, [{ url: "https://claude.ai/oauth?state=abc", launchUrl: "http://127.0.0.1:5555/launch", instructions: "Complete login in your browser." }]);
		assert.deepEqual(follower.prompts, [{ title: "Paste the authorization code (or full redirect URL):", placeholder: "code" }]);
		const answered = peer.uiResponses();
		assert.equal(answered.length, 1);
		assert.deepEqual({ ...answered[0]!, id: "x" }, { type: "extension_ui_response", id: "x", value: "answer" });
		peer.reply(peer.written.find(frame => frame.type === "login")!, true, { data: { providerId: "openai-codex" } });
		assert.deepEqual(await result, { kind: "signed-in" });
		session.dispose();
	});

	it("classifies a refusal, an unknown provider and any other failure by kind, and never returns OMP's error text", async () => {
		for (const [error, kind] of [
			["Provider 'x' requires secret input, which is not supported in RPC mode. Use the terminal UI to log in.", "refused"],
			["Provider 'x' requires interactive prompts which are not supported in RPC mode. Use the terminal UI to log in.", "refused"],
			["Unknown OAuth provider: nope", "unknown-provider"],
			["token exchange failed: access_token=SECRET", "failed"],
		] as const) {
			const peer = providerPeer((frame, self) => { if (frame.type === "login") self.reply(frame, false, { error }); });
			const session = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => peer).spawner });
			const result = await session.login("x", hooks());
			assert.deepEqual(result, { kind });
			session.dispose();
		}
	});

	it("answers a dialog it has no place for with cancelled, so OMP never waits on it", async () => {
		const peer = providerPeer((frame, self) => { if (frame.type === "login") { self.ui("confirm", { title: "t", message: "m" }); self.ui("select", { title: "t", options: ["a"] }); self.ui("setWidget", { widgetKey: "k" }); } });
		const session = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => peer).spawner });
		void session.login("x", hooks());
		await tick(); await tick();
		assert.deepEqual(peer.uiResponses().map(frame => frame.cancelled), [true, true]);
		session.dispose();
	});

	it("ends the process when the user dismisses the prompt, and does not answer it", async () => {
		const peer = providerPeer((frame, self) => { if (frame.type === "login") self.ui("input", { title: "Paste the code" }); });
		const session = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => peer).spawner });
		const follower = hooks({ prompt: async () => undefined, cancelled: () => { follower.cancels++; session.dispose(); } });
		const result = await session.login("x", follower);
		assert.equal(follower.cancels, 1);
		assert.deepEqual(peer.uiResponses(), []);
		assert.equal(peer.killed, true);
		assert.deepEqual(result, { kind: "closed" });
	});

	it("resolves closed and kills the process when the session is disposed mid-login, and when the process exits", async () => {
		const peer = providerPeer();
		const session = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => peer).spawner });
		const result = session.login("x", hooks());
		await tick();
		session.dispose();
		assert.deepEqual(await result, { kind: "closed" });
		assert.equal(peer.killed, true);
		assert.equal(peer.stdinEnded, false, "stdin stays open so an OMP that exits on end of input cannot leave before its tree is killed");
		assert.equal(session.closed, true);

		const dying = providerPeer();
		const second = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => dying).spawner });
		const pending = second.login("x", hooks());
		await tick();
		dying.exit(1);
		assert.deepEqual(await pending, { kind: "closed" });
		await assert.rejects(second.providers());
	});

	it("drops a prompt that outlived the login instead of treating it as a dismissal", async () => {
		const peer = providerPeer((frame, self) => { if (frame.type === "login") self.ui("input", { title: "Paste the code" }); });
		const session = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => peer).spawner });
		let release: (value: string | undefined) => void = () => undefined;
		let seen: AbortSignal | null = null;
		const follower = hooks({ prompt: (_prompt, signal) => { seen = signal; return new Promise<string | undefined>(resolve => { release = resolve; }); } });
		const result = session.login("x", follower);
		await tick(); await tick();
		peer.reply(peer.written.find(frame => frame.type === "login")!, true, { data: { providerId: "x" } });
		assert.deepEqual(await result, { kind: "signed-in" });
		assert.equal((seen as AbortSignal | null)?.aborted, true, "the open prompt is told the login settled");
		release(undefined);
		await tick();
		assert.equal(follower.cancels, 0);
		assert.deepEqual(peer.uiResponses(), []);
		session.dispose();
	});

	it("closes the masked prompt when OMP reports it is exchanging the code, without treating that as a dismissal", async () => {
		const peer = providerPeer((frame, self) => { if (frame.type === "login") self.ui("input", { title: "Paste the authorization code" }); });
		const session = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => peer).spawner });
		let seen: AbortSignal | null = null;
		const follower = hooks({ prompt: (_prompt, signal) => { seen = signal; return new Promise<string | undefined>(() => undefined); } });
		const result = session.login("x", follower);
		await tick(); await tick();
		assert.equal((seen as AbortSignal | null)?.aborted, false);
		peer.ui("notify", { message: "Exchanging authorization code for tokens..." });
		await tick();
		assert.equal((seen as AbortSignal | null)?.aborted, true, "the callback won: the box has nothing left to ask");
		assert.equal(follower.cancels, 0);
		peer.reply(peer.written.find(frame => frame.type === "login")!, true, { data: { providerId: "x" } });
		assert.deepEqual(await result, { kind: "signed-in" });
		session.dispose();
	});
});

describe("ending the process", () => {
	it("close() ends stdin, waits for OMP to exit by itself and never kills a process that did", async () => {
		const peer = providerPeer();
		const session = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => peer).spawner });
		await session.close();
		assert.deepEqual([peer.stdinEnded, peer.exited, peer.killed, session.closed], [true, true, false, true]);
		await session.close();
		session.dispose();
		assert.equal(peer.killed, false, "a process that has exited is not killed");
	});

	it("close() kills a process that is still running after the grace period, and fails requests while it waits", async () => {
		const peer = providerPeer();
		peer.exitOnEof = false;
		let fire: (() => void) | null = null;
		const timers: LoginTimers = { setTimeout: callback => { fire = callback; return 1; }, clearTimeout: () => { fire = null; } };
		const session = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => peer).spawner, timers });
		const closing = session.close();
		await tick();
		assert.equal(peer.killed, false, "OMP gets its teardown time first");
		await assert.rejects(session.providers());
		fire!();
		await closing;
		assert.equal(peer.killed, true);
		assert.equal(peer.exited, true);
	});

	it("kills the whole process tree before the process itself, so a descendant OMP started cannot outlive a Cancel", async () => {
		const peer = new FakeOmp({ pid: 4242 });
		peer.exitOnEof = false;
		peer.onFrame = (frame, self) => { if (frame.type === "get_login_providers") self.reply(frame, true, { data: { providers: [] } }); };
		const order: string[] = [];
		let finishTree: () => void = () => undefined;
		const treeKill = (pid: number): Promise<void> => { order.push(`tree ${pid}`); return new Promise(resolve => { finishTree = resolve; }); };
		const session = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => peer).spawner, treeKill });
		session.dispose();
		session.dispose();
		await tick();
		assert.deepEqual(order, ["tree 4242"], "one tree kill, however often dispose is called");
		assert.equal(peer.killed, false, "the root is not killed before its tree: its children could no longer be found");
		finishTree();
		await tick(); await tick(); await tick();
		assert.equal(peer.killed, true, "the plain kill follows");
	});

	it("still kills the process when the tree kill fails, and reaches the tree on the way out of a close() that timed out", async () => {
		const failing = new FakeOmp({ pid: 7 });
		const session = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => failing).spawner, treeKill: () => Promise.reject(new Error("taskkill missing")) });
		session.dispose();
		await tick(); await tick();
		assert.equal(failing.killed, true);

		const stubborn = new FakeOmp({ pid: 8 });
		stubborn.exitOnEof = false;
		const trees: number[] = [];
		let fire: (() => void) | null = null as (() => void) | null;
		const timers: LoginTimers = { setTimeout: callback => { fire = callback; return 1; }, clearTimeout: () => { fire = null; } };
		const second = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => stubborn).spawner, timers, treeKill: async pid => { trees.push(pid); } });
		const closing = second.close();
		await tick();
		fire!();
		await tick(); await tick();
		(fire as (() => void) | null)?.();
		await closing;
		assert.deepEqual(trees, [8]);
		assert.equal(stubborn.killed, true);
	});

	it("dispose() during close() ends the process at once", async () => {
		const peer = providerPeer();
		peer.exitOnEof = false;
		const session = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => peer).spawner });
		const closing = session.close();
		await tick();
		session.dispose();
		await closing;
		assert.equal(peer.killed, true);
	});
});

describe("logout", () => {
	it("lists the stored accounts of a provider and removes one by credential id", async () => {
		const peer = providerPeer((frame, self) => {
			if (frame.type === "get_logout_accounts") self.reply(frame, true, { data: { accounts: [{ credentialId: 7, provider: "anthropic", label: "me@example.test", detail: "Pro", type: "oauth", active: true }, { credentialId: "x" }] } });
			if (frame.type === "logout") self.reply(frame, true, { data: { remainingSource: "env ANTHROPIC_API_KEY\u0007" } });
		});
		const session = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => peer).spawner });
		assert.deepEqual(await session.logoutAccounts("anthropic"), [{ credentialId: 7, label: "me@example.test", detail: "Pro", type: "oauth", active: true }]);
		assert.deepEqual(await session.logout("anthropic", 7), { remainingSource: "env ANTHROPIC_API_KEY" });
		const sent = peer.written.filter((frame: FakeFrame) => frame.type === "get_logout_accounts" || frame.type === "logout");
		assert.deepEqual(sent.map(frame => ({ type: frame.type, providerId: frame.providerId, credentialId: frame.credentialId })), [
			{ type: "get_logout_accounts", providerId: "anthropic", credentialId: undefined },
			{ type: "logout", providerId: "anthropic", credentialId: 7 },
		]);
		session.dispose();
	});

	it("rejects a logout OMP refused", async () => {
		const peer = providerPeer((frame, self) => { if (frame.type === "logout") self.reply(frame, false, { error: "Credential 7 is not stored for anthropic" }); });
		const session = await startLoginSession({ scope: SCOPE, spawner: fakeSpawner(() => peer).spawner });
		await assert.rejects(session.logout("anthropic", 7));
		assert.equal(parseLogoutAccounts({ accounts: "no" }), null);
		assert.equal(boundedText(`${"x".repeat(400)}`, 10), "xxxxxxxxx…");
		session.dispose();
	});
});

describe("a real child process", () => {
	it("speaks the frames over real pipes, ends on dispose, and carries nothing of stderr", async () => {
		const script = `
			const readline = require("node:readline");
			process.stderr.write("TOKEN=from-stderr\\n");
			console.log(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }));
			readline.createInterface({ input: process.stdin }).on("line", line => {
				const frame = JSON.parse(line);
				console.log(JSON.stringify({ type: "response", id: frame.id, command: frame.type, success: true, data: { providers: [{ id: "anthropic", name: "Anthropic", available: true, authenticated: false }] } }));
			}).on("close", () => process.exit(0));
		`;
		const logs: LoggedLine[] = [];
		const session = await startLoginSession({
			scope: { executable: { command: process.execPath, prefixArgs: ["-e", script, "--"] }, env: {}, cwd: process.cwd() },
			spawner: (command, args, options) => spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }),
			log: recordingLogger(logs),
		});
		assert.deepEqual((await session.providers()).map(provider => provider.id), ["anthropic"]);
		session.dispose();
		await session.whenExited;
		assert.deepEqual(logs, []);
	});
});
