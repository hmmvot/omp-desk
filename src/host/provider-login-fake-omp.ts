/**
 * A scripted stand-in for the `omp --mode rpc` process of the provider login, for tests (`LoginChild` over in-memory
 * streams). It records every frame the client wrote, the arguments it was started with and whether it was killed;
 * a test scripts the answers. Product code never imports it.
 */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { LoginChild, LoginSpawner } from "./provider-login-rpc.ts";

export type FakeFrame = Record<string, unknown>;

export class FakeOmp {
	/** Every frame the client wrote to stdin, parsed. */
	readonly written: FakeFrame[] = [];
	/** The exact stdin text, to assert on what was (not) sent. */
	stdinText = "";
	command = "";
	args: readonly string[] = [];
	cwd = "";
	env: Record<string, string | undefined> = {};
	killed = false;
	stdinEnded = false;
	/** Like OMP at end of input with nothing running: exit by itself. A test sets this false for a process that does not. */
	exitOnEof = true;
	exited = false;
	/** Called for every command frame the client sends. */
	onFrame: (frame: FakeFrame, peer: FakeOmp) => void = () => undefined;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly child: LoginChild;
	readonly #events = new EventEmitter();
	#carry = "";

	constructor(options: { readonly ready?: boolean; readonly pid?: number } = {}) {
		const stdin = new Writable({
			write: (chunk: Buffer | string, _encoding, callback) => {
				const text = chunk.toString();
				this.stdinText += text;
				this.#carry += text;
				let at: number;
				while ((at = this.#carry.indexOf("\n")) >= 0) {
					const line = this.#carry.slice(0, at);
					this.#carry = this.#carry.slice(at + 1);
					const frame = JSON.parse(line) as FakeFrame;
					this.written.push(frame);
					this.onFrame(frame, this);
				}
				callback();
			},
			final: callback => {
				this.stdinEnded = true;
				callback();
				if (this.exitOnEof) setImmediate(() => this.exit(0));
			},
		});
		this.child = {
			pid: options.pid,
			stdin,
			stdout: this.stdout,
			stderr: this.stderr,
			on: ((event: string, listener: Parameters<EventEmitter["on"]>[1]) => this.#events.on(event, listener)) as LoginChild["on"],
			kill: () => {
				this.killed = true;
				this.exit(null);
				return true;
			},
		};
		if (options.ready !== false) setImmediate(() => this.emit({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] }));
	}

	/** Write one frame to the client's stdout. */
	emit(frame: FakeFrame): void {
		if (!this.exited) this.stdout.write(`${JSON.stringify(frame)}\n`);
	}

	/** Write raw text to stdout (partial lines, noise). */
	emitRaw(text: string): void {
		this.stdout.write(text);
	}

	/** A `response` frame answering `frame`. */
	reply(frame: FakeFrame, success: boolean, extra: { data?: unknown; error?: string } = {}): void {
		this.emit({ type: "response", id: frame.id, command: frame.type, success, ...extra });
	}

	/** An `extension_ui_request` frame. */
	ui(method: string, fields: FakeFrame = {}): void {
		this.emit({ type: "extension_ui_request", id: `ui-${this.written.length}-${method}`, method, ...fields });
	}

	exit(code: number | null): void {
		if (this.exited) return;
		this.exited = true;
		this.#events.emit("exit", code, code === null ? "SIGTERM" : null);
	}

	/** The answers to `extension_ui_response` frames written so far. */
	uiResponses(): FakeFrame[] {
		return this.written.filter(frame => frame.type === "extension_ui_response");
	}
}

/** A spawner handing out the peers `make` builds, in order; `spawned` lists them. */
export function fakeSpawner(make: (attempt: number) => FakeOmp): { readonly spawner: LoginSpawner; readonly spawned: FakeOmp[] } {
	const spawned: FakeOmp[] = [];
	const spawner: LoginSpawner = (command, args, options) => {
		const peer = make(spawned.length);
		peer.command = command;
		peer.args = args;
		peer.cwd = options.cwd;
		peer.env = options.env;
		spawned.push(peer);
		return peer.child;
	};
	return { spawner, spawned };
}

/** The frames of the usual provider list. */
export const FAKE_PROVIDERS = [
	{ id: "anthropic", name: "Anthropic (Claude Pro/Max)", available: true, authenticated: true },
	{ id: "openai-codex", name: "ChatGPT Plus/Pro (Codex Subscription)", available: true, authenticated: false },
	{ id: "hidden", name: "Not available here", available: false, authenticated: false },
	{ id: "openrouter", name: "OpenRouter", available: true, authenticated: false },
];

/** A peer that answers `get_login_providers` with {@link FAKE_PROVIDERS} and lets `rest` handle the other commands. */
export function providerPeer(rest: (frame: FakeFrame, peer: FakeOmp) => void = () => undefined): FakeOmp {
	const peer = new FakeOmp();
	peer.onFrame = (frame, self) => {
		if (frame.type === "get_login_providers") self.reply(frame, true, { data: { providers: FAKE_PROVIDERS } });
		else rest(frame, self);
	};
	return peer;
}
