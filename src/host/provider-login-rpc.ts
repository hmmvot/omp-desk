/**
 * The client of one short-lived `omp --mode rpc` process that serves provider login and logout (ADR-0070).
 *
 * The process is started for the login alone, in the profile and directory the caller names, and ends with it:
 * `login` runs on OMP's serial command queue (a Chat's own process would answer nothing else for minutes), and
 * OMP gives a login no abort, so the only real Cancel is ending the process. Nothing here touches `vscode`.
 *
 * Disclosure rules (ADR-0017): a frame OMP sends is never logged or kept, stderr is drained and discarded, an
 * error string OMP reports is classified here and never forwarded, and the text a user answers a prompt with
 * (a pasted authorization code or redirect URL, which can complete a login) goes to the process's stdin and
 * nowhere else.
 */
import { spawn } from "node:child_process";
import { isRecord } from "../shared/guards.ts";
import { encodeUiResponse, isResponseFrame } from "../protocol/rpc.ts";
import type { OmpCommand } from "./native-terminal.ts";
import { runTaskkillTree } from "./session-kill.ts";

/** One provider `get_login_providers` lists. */
export interface LoginProvider {
	readonly id: string;
	readonly name: string;
	readonly available: boolean;
	readonly authenticated: boolean;
}

/** One stored credential `get_logout_accounts` lists. `label` and `detail` can name the user's account. */
export interface LogoutAccount {
	readonly credentialId: number;
	readonly label: string;
	readonly detail: string;
	readonly type: "api_key" | "oauth";
	readonly active: boolean;
}

/** What `login` came to; the text OMP reports with a failure is deliberately not part of it. */
export type LoginResult =
	| { readonly kind: "signed-in" }
	/** The provider needs input this transport cannot carry (a secret, or a prompt before the sign-in address). */
	| { readonly kind: "refused" }
	| { readonly kind: "unknown-provider" }
	| { readonly kind: "failed" }
	/** The process ended, or this session was disposed, before OMP answered. */
	| { readonly kind: "closed" };

/** The address OMP asks the user to open, as `open_url` carries it. */
export interface LoginOpenUrl {
	readonly url: string;
	readonly launchUrl?: string;
	readonly instructions?: string;
}

/** An `input` OMP asked while a login runs: the pasted code or redirect URL, and a bounded title. */
export interface LoginPrompt {
	readonly title: string;
	readonly placeholder?: string;
}

/** What a caller supplies to follow one login. Every callback may throw: a throw ends that frame's handling only. */
export interface LoginHooks {
	openUrl(request: LoginOpenUrl): void;
	/** The user's answer, or `undefined` when they dismissed the prompt. `signal` aborts when the login settles. */
	prompt(prompt: LoginPrompt, signal: AbortSignal): Promise<string | undefined>;
	/** A progress notice OMP printed (`notify`), bounded and stripped of control characters. */
	progress(message: string): void;
	/** The user dismissed a prompt: the login cannot continue and the process is ended. */
	cancelled(): void;
}

/** The part of a child process this module uses (a `node:child_process` child satisfies it). */
export interface LoginChild {
	/** The process id the tree kill starts from; a child without one is only killed. */
	readonly pid?: number | undefined;
	readonly stdin: { write(data: string): unknown; end(): unknown; on(event: "error", listener: () => void): unknown };
	readonly stdout: { setEncoding(encoding: "utf8"): unknown; on(event: "data", listener: (chunk: string) => void): unknown };
	readonly stderr: { resume(): unknown; on(event: "data", listener: () => void): unknown } | null;
	on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	kill(): unknown;
}

/** Ends a process and every descendant it still has (Windows `taskkill /T /F`). Never rejects in practice; a rejection is ignored. */
export type TreeKill = (pid: number) => Promise<unknown>;

export type LoginSpawner = (command: string, args: readonly string[], options: { cwd: string; env: Record<string, string | undefined> }) => LoginChild;

const defaultSpawner: LoginSpawner = (command, args, options) =>
	spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

/** Where and how the login process runs: the session's executable, profile environment and directory. */
export interface LoginProcessScope {
	readonly executable: OmpCommand;
	/** Merged over this process's environment, e.g. `{ OMP_PROFILE: "default" }`. */
	readonly env: Readonly<Record<string, string>>;
	readonly cwd: string;
}

/** Why no login process became ready. */
export class LoginStartError extends Error {
	readonly reason: "spawn" | "exited" | "ready-timeout";
	constructor(reason: LoginStartError["reason"]) {
		super(reason === "spawn" ? "OMP could not be started." : reason === "exited" ? "OMP exited before it was ready." : "OMP did not become ready.");
		this.name = "LoginStartError";
		this.reason = reason;
	}
}

/**
 * OMP 18.10.3 ends an RPC process that has no model ("No default model selected"), which is exactly a new user's
 * state, and accepts an explicit `--model` selector without credentials. The login needs no model, so a selector
 * that resolves in the installed catalog is passed; the next one is tried only when the process ended before it was ready.
 */
export const LOGIN_STARTUP_MODEL_SELECTORS: readonly string[] = ["gpt", "claude", "gemini"];

/**
 * Flags that keep the process to the credential store: no session file, tool list, skills, rules, LSP, title or UI.
 * Extensions and MCP servers are not switched off (OMP 18.10.3 has no switch for MCP; extensions register OAuth providers),
 * so the process starts the ones the profile and the folder configure.
 */
const LOGIN_PROCESS_FLAGS = ["--mode", "rpc", "--no-session", "--no-ui", "--no-skills", "--no-rules", "--no-lsp", "--no-tools", "--no-title"];

export const READY_TIMEOUT_MS = 45_000;
export const REQUEST_TIMEOUT_MS = 30_000;
/** OMP bounds a sign-in at 300 s (callback) and a prompt at 600 s; this only guards a process that never answers. */
export const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** How long a process told to end by closing its stdin may take to exit (OMP disposes its session and MCP connections first) before it is killed. */
export const CLOSE_GRACE_MS = 5_000;
const MAX_LINE_CHARS = 2 * 1024 * 1024;
const MAX_PROVIDERS = 200;
const MAX_ACCOUNTS = 100;
const MAX_TEXT = 300;

export interface LoginTimers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}
const realTimers: LoginTimers = { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout) };

/** Text OMP sent that is shown to the user: bounded, with control characters replaced, never rendered as markup. */
export function boundedText(value: unknown, max = MAX_TEXT): string {
	if (typeof value !== "string") return "";
	// eslint-disable-next-line no-control-regex
	const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** The parts of `get_login_providers` the picker needs; a malformed entry is dropped, not repaired. */
export function parseLoginProviders(data: unknown): LoginProvider[] | null {
	if (!isRecord(data) || !Array.isArray(data.providers)) return null;
	const providers: LoginProvider[] = [];
	for (const entry of data.providers.slice(0, MAX_PROVIDERS)) {
		if (!isRecord(entry) || typeof entry.id !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(entry.id)) continue;
		const name = boundedText(entry.name, 120);
		providers.push({ id: entry.id, name: name.length > 0 ? name : entry.id, available: entry.available === true, authenticated: entry.authenticated === true });
	}
	return providers;
}

/** The parts of `get_logout_accounts` the picker needs. */
export function parseLogoutAccounts(data: unknown): LogoutAccount[] | null {
	if (!isRecord(data) || !Array.isArray(data.accounts)) return null;
	const accounts: LogoutAccount[] = [];
	for (const entry of data.accounts.slice(0, MAX_ACCOUNTS)) {
		if (!isRecord(entry) || !Number.isSafeInteger(entry.credentialId) || (entry.type !== "api_key" && entry.type !== "oauth")) continue;
		accounts.push({
			credentialId: entry.credentialId as number,
			label: boundedText(entry.label, 160),
			detail: boundedText(entry.detail, 200),
			type: entry.type,
			active: entry.active === true,
		});
	}
	return accounts;
}

/** A refusal OMP reports for a provider whose flow needs a prompt this transport cannot carry (rpc-mode.ts `login`). */
const RPC_REFUSAL = /not supported in RPC mode/i;

interface Pending {
	resolve(frame: Record<string, unknown>): void;
	reject(error: Error): void;
	timer: unknown;
}

/** One ready login process. Created by {@link startLoginSession}. */
export class LoginSession {
	readonly #child: LoginChild;
	readonly #timers: LoginTimers;
	readonly #pending = new Map<string, Pending>();
	readonly #exited = Promise.withResolvers<void>();
	#uiListener: ((frame: Record<string, unknown>) => void) | null = null;
	#buffer = "";
	#next = 0;
	#closed = false;
	#hasExited = false;
	#terminating = false;
	readonly #treeKill: TreeKill;

	/** @internal Use {@link startLoginSession}. */
	constructor(child: LoginChild, timers: LoginTimers, treeKill: TreeKill = pid => runTaskkillTree(pid)) {
		this.#child = child;
		this.#timers = timers;
		this.#treeKill = treeKill;
	}

	/** @internal Feeds one decoded stdout chunk; returns the frames complete in it. */
	feed(chunk: string): Record<string, unknown>[] {
		this.#buffer += chunk;
		const frames: Record<string, unknown>[] = [];
		let at: number;
		while ((at = this.#buffer.indexOf("\n")) >= 0) {
			const line = this.#buffer.slice(0, at).replace(/\r$/, "");
			this.#buffer = this.#buffer.slice(at + 1);
			if (line.length === 0) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isRecord(parsed)) frames.push(parsed);
			} catch {
				// A line that is not JSON is not a frame; its text is never logged.
			}
		}
		if (this.#buffer.length > MAX_LINE_CHARS) {
			this.#buffer = "";
			this.dispose();
		}
		return frames;
	}

	/** @internal */
	dispatch(frame: Record<string, unknown>): void {
		if (frame.type === "response") {
			if (!isResponseFrame(frame) || typeof frame.id !== "string") return;
			const pending = this.#pending.get(frame.id);
			if (pending === undefined) return;
			this.#pending.delete(frame.id);
			this.#timers.clearTimeout(pending.timer);
			pending.resolve(frame);
			return;
		}
		if (frame.type === "extension_ui_request") this.#uiListener?.(frame);
	}

	/** @internal */
	exited(): void {
		this.#closed = true;
		this.#hasExited = true;
		this.#exited.resolve();
		for (const [id, pending] of this.#pending) {
			this.#timers.clearTimeout(pending.timer);
			pending.reject(new LoginClosedError());
			this.#pending.delete(id);
		}
	}

	/** Whether the process has ended or was ended by {@link dispose}. */
	get closed(): boolean {
		return this.#closed;
	}

	/** Resolves when the process has ended. */
	get whenExited(): Promise<void> {
		return this.#exited.promise;
	}

	/**
	 * End the process now: closes its stdin and kills it, skipping OMP's own teardown. For a login that is still waiting on
	 * the user or the browser (OMP has no abort for it and does not exit on EOF while one runs) and for a process that has
	 * not become ready. Safe to call again, and after {@link close}.
	 */
	dispose(): void {
		this.#closed = true;
		// stdin is not closed first: an OMP that exits on end of input would be gone before its tree could be found.
		if (!this.#hasExited) this.#terminate();
		this.#rejectPending();
	}

	/**
	 * Kill the process with everything it started. OMP starts the MCP servers the profile and the folder configure, and a
	 * plain kill of one process leaves a descendant that detached from it running. The tree goes first: once the root is
	 * dead its children can no longer be found from it. The plain kill follows (and is the only one without a process id).
	 */
	#terminate(): void {
		if (this.#terminating) return;
		this.#terminating = true;
		const plainKill = (): void => {
			if (this.#hasExited) return;
			try { this.#child.kill(); } catch { /* the process is already gone */ }
		};
		const pid = this.#child.pid;
		if (pid === undefined) {
			plainKill();
			return;
		}
		void this.#treeKill(pid).catch(() => undefined).finally(plainKill);
	}

	/**
	 * End an idle process the way OMP expects: closes its stdin, lets OMP dispose its session and MCP connections, and
	 * resolves once it has exited. A process that is still running after `graceMs` is killed. Requests after this fail as closed.
	 */
	async close(graceMs = CLOSE_GRACE_MS): Promise<void> {
		if (!this.#closed) {
			this.#closed = true;
			try { this.#child.stdin.end(); } catch { /* the pipe is already gone */ }
			this.#rejectPending();
		}
		if (this.#hasExited) return;
		await this.#exitWithin(graceMs);
		if (this.#hasExited) return;
		this.#terminate();
		await this.#exitWithin(graceMs);
	}

	async #exitWithin(ms: number): Promise<void> {
		let timer: unknown;
		await Promise.race([this.#exited.promise, new Promise<void>(resolve => { timer = this.#timers.setTimeout(resolve, ms); })]);
		this.#timers.clearTimeout(timer);
	}

	#rejectPending(): void {
		for (const [id, pending] of this.#pending) {
			this.#timers.clearTimeout(pending.timer);
			pending.reject(new LoginClosedError());
			this.#pending.delete(id);
		}
	}

	#send(frame: string): void {
		if (this.#closed) throw new LoginClosedError();
		this.#child.stdin.write(`${frame}\n`);
	}

	#request(command: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
		if (this.#closed) return Promise.reject(new LoginClosedError());
		const id = `login:${++this.#next}`;
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		const timer = this.#timers.setTimeout(() => {
			if (this.#pending.delete(id)) reject(new Error("OMP did not answer in time."));
		}, timeoutMs);
		this.#pending.set(id, { resolve, reject, timer });
		try {
			this.#send(JSON.stringify({ id, ...command }));
		} catch (error) {
			this.#pending.delete(id);
			this.#timers.clearTimeout(timer);
			reject(error instanceof Error ? error : new Error("OMP could not be written to."));
		}
		return promise;
	}

	/** The providers OMP can log in to, with whether each already has a credential. */
	async providers(): Promise<LoginProvider[]> {
		const frame = await this.#request({ type: "get_login_providers" }, REQUEST_TIMEOUT_MS);
		const providers = frame.success === true ? parseLoginProviders(frame.data) : null;
		if (providers === null) throw new Error("OMP did not list its login providers.");
		return providers;
	}

	/** Run one login. Resolves with its outcome; it never rejects. The caller ends the session to cancel. */
	async login(providerId: string, hooks: LoginHooks): Promise<LoginResult> {
		const settled = new AbortController();
		let promptSignal: AbortController | null = null;
		const answer = async (frame: Record<string, unknown>): Promise<void> => {
			const id = frame.id;
			if (typeof id !== "string") return;
			promptSignal?.abort();
			const mine = new AbortController();
			promptSignal = mine;
			const signal = AbortSignal.any([mine.signal, settled.signal]);
			const title = boundedText(frame.title);
			const placeholder = boundedText(frame.placeholder);
			let value: string | undefined;
			try {
				value = await hooks.prompt({ title, ...(placeholder.length > 0 ? { placeholder } : {}) }, signal);
			} catch {
				value = undefined;
			}
			// A prompt that was superseded or outlived the login is not the user dismissing it.
			if (signal.aborted || this.#closed) return;
			if (value === undefined) {
				hooks.cancelled();
				return;
			}
			try { this.#send(encodeUiResponse(id, { value })); } catch { /* the process ended; the login resolves as closed */ }
		};
		this.#uiListener = frame => {
			try {
				switch (frame.method) {
					case "open_url":
						if (typeof frame.url === "string") {
							const instructions = boundedText(frame.instructions, 600);
							hooks.openUrl({
								url: frame.url,
								...(typeof frame.launchUrl === "string" ? { launchUrl: frame.launchUrl } : {}),
								...(instructions.length > 0 ? { instructions } : {}),
							});
						}
						return;
					case "input":
						void answer(frame);
						return;
					case "notify": {
						const message = boundedText(frame.message, 400);
						// OMP says this once the browser callback (or a pasted code) won: a masked box still open is for nothing.
						if (/^exchanging authori[sz]ation code/i.test(message)) promptSignal?.abort();
						if (message.length > 0) hooks.progress(message);
						return;
					}
					case "select":
					case "confirm":
					case "editor":
					case "ask":
						// A dialog this flow has no place for: never leave OMP waiting on it.
						if (typeof frame.id === "string") this.#send(encodeUiResponse(frame.id, { cancelled: true }));
						return;
					default:
						return;
				}
			} catch {
				// One frame's handling failing is not the login failing.
			}
		};
		try {
			const frame = await this.#request({ type: "login", providerId }, LOGIN_TIMEOUT_MS);
			if (frame.success === true) return { kind: "signed-in" };
			const error = typeof frame.error === "string" ? frame.error : "";
			if (RPC_REFUSAL.test(error)) return { kind: "refused" };
			if (/^Unknown OAuth provider/i.test(error)) return { kind: "unknown-provider" };
			return { kind: "failed" };
		} catch (error) {
			return error instanceof LoginClosedError ? { kind: "closed" } : { kind: "failed" };
		} finally {
			this.#uiListener = null;
			settled.abort();
		}
	}

	/** The stored credentials of one provider, the active one first. */
	async logoutAccounts(providerId: string): Promise<LogoutAccount[]> {
		const frame = await this.#request({ type: "get_logout_accounts", providerId }, REQUEST_TIMEOUT_MS);
		const accounts = frame.success === true ? parseLogoutAccounts(frame.data) : null;
		if (accounts === null) throw new Error("OMP did not list the stored accounts.");
		return accounts;
	}

	/** Remove one stored credential. `remainingSource` names what still authenticates the provider, bounded. */
	async logout(providerId: string, credentialId: number): Promise<{ readonly remainingSource?: string }> {
		const frame = await this.#request({ type: "logout", providerId, credentialId }, REQUEST_TIMEOUT_MS);
		if (frame.success !== true) throw new Error("OMP did not remove the credential.");
		const source = isRecord(frame.data) ? boundedText(frame.data.remainingSource, 120) : "";
		return source.length > 0 ? { remainingSource: source } : {};
	}
}

/** A request on a session that has ended. */
export class LoginClosedError extends Error {
	constructor() {
		super("The OMP login process has ended.");
		this.name = "LoginClosedError";
	}
}

export interface StartLoginOptions {
	readonly scope: LoginProcessScope;
	/** Overrides for tests: the process factory, the timers and the model selectors to try. */
	readonly spawner?: LoginSpawner;
	readonly timers?: LoginTimers;
	readonly modelSelectors?: readonly string[];
	/** Reports a fixed diagnostic sentence (never a frame, stderr or an error string OMP produced). */
	readonly log?: (message: string) => void;
	/** Aborts the start: the process is ended and the start rejects with a {@link LoginStartError}. */
	readonly signal?: AbortSignal;
	/** Overrides for tests: the tree kill (default: Windows `taskkill /T /F`). */
	readonly treeKill?: TreeKill;
}

/**
 * Start the login process, trying each model selector until one process reaches `ready`.
 * Rejects with a {@link LoginStartError} (nothing is left running).
 */
export async function startLoginSession(options: StartLoginOptions): Promise<LoginSession> {
	const selectors = options.modelSelectors ?? LOGIN_STARTUP_MODEL_SELECTORS;
	let failure = new LoginStartError("exited");
	for (const selector of selectors) {
		if (options.signal?.aborted) throw failure;
		try {
			return await startOnce(options, selector);
		} catch (error) {
			if (!(error instanceof LoginStartError)) throw error;
			failure = error;
			// Only an exit before ready can be a selector the catalog did not resolve.
			if (error.reason !== "exited") break;
		}
	}
	throw failure;
}

function startOnce(options: StartLoginOptions, selector: string): Promise<LoginSession> {
	const timers = options.timers ?? realTimers;
	const spawner = options.spawner ?? defaultSpawner;
	const { scope } = options;
	const args = [...scope.executable.prefixArgs, ...LOGIN_PROCESS_FLAGS, "--model", selector];
	const result = Promise.withResolvers<LoginSession>();
	let child: LoginChild;
	try {
		child = spawner(scope.executable.command, args, { cwd: scope.cwd, env: { ...process.env, ...scope.env } });
	} catch {
		options.log?.("provider login: the OMP process could not be started");
		return Promise.reject(new LoginStartError("spawn"));
	}
	const session = new LoginSession(child, timers, options.treeKill);
	let ready = false;
	let settled = false;
	const finish = (action: () => void): void => {
		if (settled) return;
		settled = true;
		timers.clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		action();
	};
	const onAbort = (): void => {
		finish(() => result.reject(new LoginStartError("exited")));
		session.dispose();
	};
	const timer = timers.setTimeout(() => {
		finish(() => result.reject(new LoginStartError("ready-timeout")));
		session.dispose();
	}, READY_TIMEOUT_MS);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	child.stdin.on("error", () => { /* a closed pipe surfaces as the exit */ });
	child.stderr?.on("data", () => { /* discarded: stderr text is never read or logged */ });
	child.stderr?.resume();
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", chunk => {
		for (const frame of session.feed(chunk)) {
			if (!ready && frame.type === "ready") {
				ready = true;
				finish(() => result.resolve(session));
				continue;
			}
			session.dispatch(frame);
		}
	});
	child.on("error", () => {
		session.exited();
		finish(() => result.reject(new LoginStartError("spawn")));
	});
	child.on("exit", () => {
		session.exited();
		finish(() => result.reject(new LoginStartError("exited")));
	});
	return result.promise;
}
