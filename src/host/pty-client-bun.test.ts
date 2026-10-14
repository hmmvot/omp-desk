/**
 * Which runtime a Chat broker really starts on
 * ([ADR-0074](../../docs/decisions/0074-run-chat-brokers-on-the-sessions-own-bun-runtime-with-code-exe-as-fallback.md)),
 * through the client a window uses and the real detached broker.
 *
 * Runner: `node --test src/host/pty-client-bun.test.ts`
 *
 * No broker is mocked: the real staged tree, a real detached broker process, the real pipe-only self-check and the real
 * handshake. What is injected is only what the machine decides: the security read of the runtime executable (so the
 * verdict does not depend on this account's ACLs) and, in the Bun-less cases, the executable itself:
 *
 * - a copy of `node.exe` named `bun.exe`, which passes the launch inspection and is then refused by the check (Node
 *   rejects the Bun-only `--no-install` the Bun runtime is started with, so the pipe-only check cannot answer);
 * - the machine's own Bun (`BUN_INSTALL`, `~/.bun/bin`, `PATH`), when it is at least the minimum: the broker must start on it,
 *   record that, and run from that image. The cases that need it say why they are skipped when there is none.
 *
 * Skipped outside Windows and when the packaged broker tree has not been built (`node esbuild.mjs --pty`).
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { recordingLogger, type Logger, type LoggedLine } from "../shared/logger.ts";
import { MIN_BUN_VERSION, isSupportedBunVersion, type OmpLaunchFacts } from "./chat-broker-runtime.ts";
import type { PrivateStorageSecurityRead, PrivateStorageSecurityReport } from "./private-storage.ts";
import { PtyBrokerClient, type ChatBrokerRuntimePolicy, type PtyBrokerClientOptions, type RpcLaunchOutcome } from "./pty-client.ts";
import { ptyRecordPath } from "./pty-registry.ts";
import type { PtyBrokerRuntime, PtyLaunchSpec } from "./pty-protocol.ts";
import type { RpcHandle } from "./rpc-handle.ts";

const EXTENSION_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const WINDOWS_ONLY = process.platform !== "win32" ? "the process identity readings are implemented for Windows only" : false;
const BUILT = existsSync(path.join(EXTENSION_ROOT, "out", "pty", "pty-broker.js"));
const SKIP = WINDOWS_ONLY || (BUILT ? false : "the packaged broker tree is absent: run `node esbuild.mjs --pty` first");

/** The bound of one test, which launches its own detached broker (and, the first time, proves the runtime). */
const TEST_TIMEOUT_MS = 120_000;

const ME = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const STRANGER = "S-1-5-21-1111111111-2222222222-3333333333-1002";
const FULL_CONTROL = 0x1f01ff;
const READ_EXECUTE = 0x1200a9;
const CREATE_FILES_AND_WRITE_DATA = 0x2 | 0x4 | 0x100;
const WRITE_DATA = 0x2;

/** The stand-in for `omp --mode rpc-ui`: says `ready`, answers the negotiation, ends when its stdin closes. */
const RPC_CHILD_SCRIPT = String.raw`
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
out({ type: "ready", supportedProtocolVersions: [1, 2] });
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
	pending += chunk;
	for (;;) {
		const newline = pending.indexOf("\n");
		if (newline < 0) break;
		const command = JSON.parse(pending.slice(0, newline));
		pending = pending.slice(newline + 1);
		if (command.type === "negotiate_protocol") out({ id: command.id, type: "response", command: "negotiate_protocol", success: true });
	}
});
process.stdin.on("end", () => process.exit(0));
`;

let storage: string;
let scratch: string;
/** A copy of `node.exe` named `bun.exe`. */
let nodeAsBun: string;
let counter = 0;
const opened: RpcHandle[] = [];
const strays: number[] = [];

const nextSlot = (): string => {
	counter += 1;
	return `tab:bun-e2e-${counter}`;
};

function specFor(slot: string): PtyLaunchSpec {
	return { slot, kind: "managed-rpc", file: process.execPath, args: ["-e", RPC_CHILD_SCRIPT], cwd: tmpdir(), title: `rpc ${slot}` };
}

/**
 * Reports for the chain the verifier asks about, owned by this account, with nothing more than a user profile grants:
 * the file and the folder it sits in (the first two paths) are read-only for everyone else, the folders above allow
 * Users to create files. `grant` adds one more access entry to the file.
 */
function trustedSecurity(grant: { readonly file?: { readonly principal: string; readonly permissions: number } } = {}): (paths: readonly string[]) => Promise<PrivateStorageSecurityRead> {
	return async paths => {
		const reports = new Map<string, PrivateStorageSecurityReport>();
		paths.forEach((target, index) => {
			const entries: { principal: string; permissions: number; denied: boolean }[] = [
				{ principal: ME, permissions: FULL_CONTROL, denied: false },
				{ principal: "S-1-5-18", permissions: FULL_CONTROL, denied: false },
				{ principal: "S-1-5-32-544", permissions: FULL_CONTROL, denied: false },
				{ principal: "S-1-5-32-545", permissions: READ_EXECUTE, denied: false },
			];
			if (index > 1) entries.push({ principal: "S-1-5-32-545", permissions: CREATE_FILES_AND_WRITE_DATA, denied: false });
			if (index === 0 && grant.file !== undefined) entries.push({ ...grant.file, denied: false });
			reports.set(target.toLowerCase(), { acl: { ok: true, stdout: JSON.stringify(entries), detail: null }, owner: ME });
		});
		return { sid: ME, failure: null, reports };
	};
}

interface Window {
	readonly client: PtyBrokerClient;
	/** Every runtime event this window logged. */
	readonly events: string[];
	/** The same lines with the level each was logged at. */
	readonly levelled: LoggedLine[];
	/** Every set of paths the trust read was asked about. */
	readonly trustReads: (readonly string[])[];
}

/** One window, with a policy when `policy` is given and the setting `auto` unless it says otherwise. */
function windowWith(
	policy: Partial<ChatBrokerRuntimePolicy> | null,
	options: {
		readonly grant?: { readonly principal: string; readonly permissions: number };
		/** The client's own seams: the identity reading and the clock the holds are kept by. */
		readonly client?: Pick<PtyBrokerClientOptions, "queryIdentity" | "now">;
		/** Runs when the trust read is asked, which is while the Bun plan is made, before any broker is spawned. */
		readonly onTrustRead?: () => void;
	} = {},
): Window {
	const events: string[] = [];
	const levelled: LoggedLine[] = [];
	const recorder = recordingLogger(levelled);
	const note = (message: string): void => {
		events.push(message);
	};
	const log: Logger = {
		error: message => (recorder.error(message), note(message)),
		warn: message => (recorder.warn(message), note(message)),
		info: message => (recorder.info(message), note(message)),
		debug: message => (recorder.debug(message), note(message)),
		trace: message => (recorder.trace(message), note(message)),
	};
	const trustReads: (readonly string[])[] = [];
	const readSecurity = trustedSecurity(options.grant === undefined ? {} : { file: options.grant });
	const chatBrokerRuntime: ChatBrokerRuntimePolicy | undefined = policy === null
		? undefined
		: {
			setting: () => "auto",
			trust: {
				readSecurity: async paths => {
					trustReads.push(paths);
					options.onTrustRead?.();
					return await readSecurity(paths);
				},
			},
			...policy,
		};
	const client = new PtyBrokerClient({
		storageDir: storage,
		extensionRoot: EXTENSION_ROOT,
		log,
		...(options.client ?? {}),
		...(chatBrokerRuntime === undefined ? {} : { chatBrokerRuntime }),
	});
	return { client, events, levelled, trustReads };
}

async function launch(window: Window, ompBinary?: OmpLaunchFacts, slot = nextSlot(), spec: (slot: string) => PtyLaunchSpec = specFor): Promise<RpcLaunchOutcome> {
	const outcome = ompBinary === undefined ? await window.client.launchRpc(spec(slot)) : await window.client.launchRpc(spec(slot), { ompBinary });
	if (outcome.handle !== null) opened.push(outcome.handle);
	else if (outcome.brokerPid !== null) strays.push(outcome.brokerPid);
	return outcome;
}

function runningHandle(outcome: RpcLaunchOutcome): RpcHandle {
	assert.equal(outcome.state, "running", outcome.reason);
	assert.ok(outcome.handle);
	return outcome.handle;
}

function recordedRuntime(handle: RpcHandle): PtyBrokerRuntime {
	const runtime = handle.record.runtime;
	assert.ok(runtime, "the broker's record carries no runtime statement");
	return runtime;
}

/** The executable image a process runs from. */
function imagePathOf(pid: number): string {
	return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).Path`], { encoding: "utf8", windowsHide: true, timeout: 60_000 }).trim();
}

/** The chat-runtime lines a window logged. */
const runtimeLines = (window: Window): string[] => window.events.filter(message => message.startsWith("Chat broker runtime:"));

/** The level of the chat-runtime line that contains `text`, or undefined when there is none. */
const levelOfRuntimeLine = (window: Window, text: string): string | undefined =>
	window.levelled.find(line => line.message.startsWith("Chat broker runtime:") && line.message.includes(text))?.level;

function assertOnExtensionHost(handle: RpcHandle): void {
	assert.deepEqual(recordedRuntime(handle), { engine: "node", version: process.versions.node });
}

/** A runnable real Bun on this machine, whatever its version: `BUN_INSTALL`, the profile's `.bun`, then `PATH`. */
function findRealBun(): { readonly executable: string; readonly version: string } | null {
	const candidates = [
		...(process.env.BUN_INSTALL === undefined ? [] : [path.join(process.env.BUN_INSTALL, "bin", "bun.exe")]),
		path.join(homedir(), ".bun", "bin", "bun.exe"),
		...(process.env.PATH ?? "").split(path.delimiter).filter(entry => entry.length > 0).map(entry => path.join(entry, "bun.exe")),
	];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
		const version = probe.status === 0 ? probe.stdout.trim() : "";
		if (/^\d+\.\d+\.\d+/.test(version)) return { executable: candidate, version };
	}
	return null;
}
const REAL = SKIP ? null : findRealBun();
const REAL_SUPPORTED = REAL !== null && isSupportedBunVersion(REAL.version);
/** The `skip` option of a case that needs a Bun the broker may run on. */
const NEEDS_BUN: string | false = REAL === null ? "no Bun was found (BUN_INSTALL, ~/.bun/bin, PATH)" : REAL_SUPPORTED ? false : `the Bun found is ${REAL.version}, older than ${MIN_BUN_VERSION}`;

before(async () => {
	if (SKIP) return;
	// The record directory must satisfy the real access convention: it lives in this account's profile.
	storage = await mkdtemp(path.join(homedir(), ".omp-bun-e2e-"));
	scratch = await mkdtemp(path.join(tmpdir(), "omp-bun-e2e-"));
	nodeAsBun = path.join(scratch, "node-as-bun", "bun.exe");
	await mkdir(path.dirname(nodeAsBun), { recursive: true });
	await copyFile(process.execPath, nodeAsBun);
});

after(async () => {
	for (const handle of opened) {
		try {
			await handle.stop({ mode: "force", timeoutMs: 10_000 });
			await handle.shutdown({ requireStopped: false });
		} catch {
			handle.disconnect();
		}
	}
	for (const pid of strays) {
		try {
			process.kill(pid);
		} catch {
			// already gone
		}
	}
	if (storage !== undefined) await rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	if (scratch !== undefined) await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});


/** A spec whose child file is not absolute: every broker, on any runtime, refuses it before it publishes a record. */
const specWithRelativeFile = (slot: string): PtyLaunchSpec => ({ ...specFor(slot), file: "relative-child.exe" });

describe("a Chat broker on the session's Bun", { skip: SKIP }, () => {
	describe("starts on that Bun", () => {
		it("starts on the machine's own Bun, records it, runs from its image and says so in the log", { timeout: TEST_TIMEOUT_MS, skip: NEEDS_BUN }, async () => {
			assert.ok(REAL);
			const window = windowWith({});
			const outcome = await launch(window, { command: REAL.executable, launcher: "bun-shim" });
			const handle = runningHandle(outcome);
			assert.equal(outcome.adopted, false);
			assert.deepEqual(recordedRuntime(handle), { engine: "bun", version: REAL.version });
			assert.equal((await realpath(imagePathOf(handle.brokerPid))).toLowerCase(), (await realpath(REAL.executable)).toLowerCase(), "the broker process did not run from the session's bun.exe");
			const lines = runtimeLines(window);
			assert.equal(lines.length, 1, lines.join("\n"));
			assert.ok((lines[0] ?? "").startsWith(`Chat broker runtime: Bun ${REAL.version} (`), lines[0]);
			assert.ok((lines[0] ?? "").toLowerCase().includes((await realpath(REAL.executable)).toLowerCase()));
			assert.match(lines[0] ?? "", /a VS Code update does not end it/);
			assert.equal(levelOfRuntimeLine(window, "a VS Code update does not end it"), "info");
			// The trust read covered the executable and the directories above it, never the volume root.
			assert.equal(window.trustReads.length, 1);
			assert.equal((window.trustReads[0] ?? [])[0]?.toLowerCase(), (await realpath(REAL.executable)).toLowerCase());
			assert.ok(!(window.trustReads[0] ?? []).some(target => /^[A-Za-z]:\\?$/.test(target)));
			assert.equal(handle.record.kind, "managed-rpc");
		});

		it("passes a bun-shim launch's Bun flags to the OMP child exactly as written: --define and --preload ahead of the entry, nothing in BUN_OPTIONS", { timeout: TEST_TIMEOUT_MS, skip: NEEDS_BUN }, async () => {
			assert.ok(REAL);
			const dir = path.join(scratch, "flags-through-broker");
			mkdirSync(dir, { recursive: true });
			const marker = path.join(dir, "child-saw.json");
			const preload = path.join(dir, "preload.mjs");
			const entry = path.join(dir, "entry.mjs");
			writeFileSync(preload, "globalThis.__DESK_TEST_PRELOADED__ = true;\n");
			// The stand-in for OMP's entry: records what reached it, then behaves as the rpc child does.
			writeFileSync(entry, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ define: __DESK_TEST_RECIPIENT__, preloaded: globalThis.__DESK_TEST_PRELOADED__ === true, bunOptions: process.env.BUN_OPTIONS ?? null, argv: process.argv.slice(2) }));\n${RPC_CHILD_SCRIPT}`);
			const flags = ["--define", '__DESK_TEST_RECIPIENT__:"public-recipient"', "--preload", preload];
			const window = windowWith({});
			const spec = (slot: string): PtyLaunchSpec => ({ ...specFor(slot), file: REAL.executable, args: [...flags, entry, "--mode", "rpc-ui"] });
			const handle = runningHandle(await launch(window, { command: REAL.executable, launcher: "bun-shim" }, nextSlot(), spec));
			assert.deepEqual(recordedRuntime(handle), { engine: "bun", version: REAL.version }, "the broker is on Bun");
			const saw = JSON.parse(readFileSync(marker, "utf8")) as { define: string; preloaded: boolean; bunOptions: string | null; argv: string[] };
			assert.equal(saw.define, "public-recipient", "--define reached the entry");
			assert.equal(saw.preloaded, true, "--preload ran before the entry");
			assert.equal(saw.bunOptions, process.env.BUN_OPTIONS ?? null, "the broker added nothing to the child's BUN_OPTIONS");
			assert.deepEqual(saw.argv, ["--mode", "rpc-ui"], "the entry's own arguments follow the entry untouched");
		});

		it("decides afresh on every launch: the trust read runs again, the in-process proof is reused", { timeout: TEST_TIMEOUT_MS, skip: NEEDS_BUN }, async () => {
			assert.ok(REAL);
			const window = windowWith({});
			runningHandle(await launch(window, { command: REAL.executable, launcher: "bun-shim" }));
			const second = runningHandle(await launch(window, { command: REAL.executable, launcher: "bun-shim" }));
			assert.deepEqual(recordedRuntime(second), { engine: "bun", version: REAL.version });
			assert.equal(runtimeLines(window).length, 2);
			assert.ok(runtimeLines(window).every(line => line.startsWith("Chat broker runtime: Bun ")), runtimeLines(window).join("\n"));
			assert.equal(window.trustReads.length, 2, "no access verdict is kept between launches");
		});

		it("refuses the machine's own Bun when it is older than the minimum, after the real pipe-only check ran on it", { timeout: TEST_TIMEOUT_MS, skip: REAL === null ? NEEDS_BUN : REAL_SUPPORTED ? "the Bun found is new enough" : false }, async () => {
			assert.ok(REAL);
			const window = windowWith({});
			const handle = runningHandle(await launch(window, { command: REAL.executable, launcher: "bun-shim" }));
			assertOnExtensionHost(handle);
			const lines = runtimeLines(window);
			assert.equal(lines.length, 1);
			assert.match(lines[0] ?? "", /^Chat broker runtime: VS Code \(Code\.exe\), because /);
			assert.ok((lines[0] ?? "").includes(`reports Bun ${REAL.version}`), lines[0]);
			assert.ok((lines[0] ?? "").includes(`needs Bun ${MIN_BUN_VERSION} or newer`), lines[0]);
			assert.equal(levelOfRuntimeLine(window, "needs Bun"), "warn");
		});
	});

	describe("falls back to the extension host's executable", () => {
		it("when the setting says vscode, even with a launch that would qualify", { timeout: TEST_TIMEOUT_MS }, async () => {
			const window = windowWith({ setting: () => "vscode" });
			const handle = runningHandle(await launch(window, { command: REAL?.executable ?? nodeAsBun, launcher: "bun-shim" }));
			assertOnExtensionHost(handle);
			const lines = runtimeLines(window);
			assert.equal(lines.length, 1);
			assert.match(lines[0] ?? "", /^Chat broker runtime: VS Code \(Code\.exe\), because /);
			assert.ok((lines[0] ?? "").includes('ompDesk.chatBrokerRuntime is set to "vscode"'), lines[0]);
			assert.match(lines[0] ?? "", /a VS Code update ends it/);
			assert.equal(levelOfRuntimeLine(window, "is set to"), "info");
			assert.equal(window.trustReads.length, 0, "the setting is decided before anything is read");
		});

		it("when the launch carries no OMP binary at all: nothing about Bun is decided or logged", { timeout: TEST_TIMEOUT_MS }, async () => {
			const window = windowWith({});
			const handle = runningHandle(await launch(window));
			assertOnExtensionHost(handle);
			assert.deepEqual(runtimeLines(window), []);
			assert.equal(window.trustReads.length, 0);
		});

		it("when the OMP launch is a compiled program, not a bun shim", { timeout: TEST_TIMEOUT_MS }, async () => {
			const window = windowWith({});
			const handle = runningHandle(await launch(window, { command: REAL?.executable ?? nodeAsBun, launcher: "program" }));
			assertOnExtensionHost(handle);
			const lines = runtimeLines(window);
			assert.equal(lines.length, 1);
			assert.match(lines[0] ?? "", /^Chat broker runtime: VS Code \(Code\.exe\), because /);
			assert.match(lines[0] ?? "", /not launched through a bun shim/);
			assert.ok((lines[0] ?? "").includes("compiled program (a standalone install"), lines[0]);
			assert.equal(levelOfRuntimeLine(window, "standalone install"), "info", "a standalone omp.exe has no Bun of its own to share: expected, not degraded");
			assert.equal(window.trustReads.length, 0);
		});

		it("when the launch was built by hand and names no launcher", { timeout: TEST_TIMEOUT_MS }, async () => {
			const window = windowWith({});
			const handle = runningHandle(await launch(window, { command: REAL?.executable ?? nodeAsBun }));
			assertOnExtensionHost(handle);
			assert.match(runtimeLines(window)[0] ?? "", /not launched through a bun shim/);
			assert.equal(levelOfRuntimeLine(window, "not launched through a bun shim"), "info");
		});

		it("when the bun.exe is a copy of node.exe: the trust read and the pipe-only check both run, and the check refuses it", { timeout: TEST_TIMEOUT_MS }, async () => {
			const window = windowWith({});
			const handle = runningHandle(await launch(window, { command: nodeAsBun, launcher: "bun-shim" }));
			assertOnExtensionHost(handle);
			const lines = runtimeLines(window);
			assert.equal(lines.length, 1);
			assert.match(lines[0] ?? "", /^Chat broker runtime: VS Code \(Code\.exe\), because /);
			assert.ok((lines[0] ?? "").includes(`the pipe-only self-check on ${await realpath(nodeAsBun)} refused it`), lines[0]);
			assert.equal(levelOfRuntimeLine(window, "refused it"), "warn");
			assert.equal(window.trustReads.length, 1, "the trust read and the check run together");
		});

		it("when another principal could write to the executable: the trust verdict refuses it", { timeout: TEST_TIMEOUT_MS }, async () => {
			const window = windowWith({}, { grant: { principal: STRANGER, permissions: WRITE_DATA } });
			const handle = runningHandle(await launch(window, { command: nodeAsBun, launcher: "bun-shim" }));
			assertOnExtensionHost(handle);
			const lines = runtimeLines(window);
			assert.equal(lines.length, 1);
			assert.match(lines[0] ?? "", /^Chat broker runtime: VS Code \(Code\.exe\), because /);
			assert.match(lines[0] ?? "", /is not trusted to host a broker/);
			assert.equal(levelOfRuntimeLine(window, "is not trusted"), "warn", "a Bun that was eligible and lost it is degraded, not expected");
			assert.ok((lines[0] ?? "").includes(STRANGER), lines[0]);
			assert.ok((lines[0] ?? "").includes("the executable"), lines[0]);
		});

		it("when the host is not Windows x64 (the platform the Bun path is verified on)", { timeout: TEST_TIMEOUT_MS }, async () => {
			const window = windowWith({ bunLaunch: { platform: "linux" } });
			const handle = runningHandle(await launch(window, { command: REAL?.executable ?? nodeAsBun, launcher: "bun-shim" }));
			assertOnExtensionHost(handle);
			const lines = runtimeLines(window);
			assert.equal(lines.length, 1);
			assert.match(lines[0] ?? "", /Windows x64 only; this host is linux/);
			assert.equal(window.trustReads.length, 0);
		});

		it("when the command is not a bun.exe that exists", { timeout: TEST_TIMEOUT_MS }, async () => {
			const window = windowWith({});
			const missing = path.join(scratch, "missing", "bun.exe");
			const handle = runningHandle(await launch(window, { command: missing, launcher: "bun-shim" }));
			assertOnExtensionHost(handle);
			assert.match(runtimeLines(window)[0] ?? "", /could not be resolved/);
			assert.equal(window.trustReads.length, 0);
		});
	});

	describe("holds a Bun file off the Bun path after a failed start", () => {
		it("keeps the file on the extension host's executable until it changes", { timeout: 3 * TEST_TIMEOUT_MS, skip: NEEDS_BUN }, async () => {
			assert.ok(REAL);
			// A copy, so that changing its modification time never touches the machine's own Bun.
			const heldBun = path.join(scratch, "held-bun", "bun.exe");
			await mkdir(path.dirname(heldBun), { recursive: true });
			await copyFile(REAL.executable, heldBun);
			const command: OmpLaunchFacts = { command: heldBun, launcher: "bun-shim" };
			const window = windowWith({});

			// Every broker refuses the relative child file before it publishes a record, so the Bun start produces no broker.
			const first = await launch(window, command, undefined, specWithRelativeFile);
			assert.equal(first.state, "not-started", first.reason);
			const firstLines = runtimeLines(window);
			// One line per launch, written when the outcome is known: a refused Bun start logs only the fallback.
			assert.equal(firstLines.length, 1, firstLines.join("\n"));
			assert.match(firstLines[0] ?? "", /^Chat broker runtime: VS Code \(Code\.exe\), because the Bun broker exited with code \d+ before it published a record/);
			assert.equal(levelOfRuntimeLine(window, "exited with code"), "warn");
			const heldDetail = /because ([\s\S]*?); a VS Code update ends it/.exec(firstLines[0] ?? "")?.[1];
			assert.ok(heldDetail);

			// The same file again: held off Bun, the reason is the one that held it, and nothing is read or proven.
			window.events.length = 0;
			const second = await launch(window, command, undefined, specWithRelativeFile);
			assert.equal(second.state, "not-started", second.reason);
			const secondLines = runtimeLines(window);
			assert.equal(secondLines.length, 1, secondLines.join("\n"));
			assert.ok((secondLines[0] ?? "").startsWith("Chat broker runtime: VS Code (Code.exe), because "), secondLines[0]);
			assert.ok((secondLines[0] ?? "").includes(heldDetail), secondLines[0]);
			assert.equal(window.trustReads.length, 1, "a held file is decided before the trust read");

			// A file that changed is a different file: it is eligible again.
			const later = new Date(Date.now() + 60_000);
			await utimes(heldBun, later, later);
			window.events.length = 0;
			await launch(window, command, undefined, specWithRelativeFile);
			// The file was tried on Bun again (a second trust read), and the refused start logs only its fallback line.
			assert.match(runtimeLines(window)[0] ?? "", /^Chat broker runtime: VS Code \(Code\.exe\), because the Bun broker exited with code/);
			assert.equal(window.trustReads.length, 2);
		});
	});

	describe("holds a Bun file off the Bun path after a broker that came to nothing", () => {
		const TEN_MINUTES_MS = 10 * 60_000;

		/** A copy of the machine's own Bun, so that changing its modification time never touches the real one. */
		async function bunCopy(name: string): Promise<string> {
			assert.ok(REAL);
			const copy = path.join(scratch, name, "bun.exe");
			await mkdir(path.dirname(copy), { recursive: true });
			await copyFile(REAL.executable, copy);
			return copy;
		}

		it("holds a file whose broker published a record and then ended before it could be attached, until the file changes", { timeout: 4 * TEST_TIMEOUT_MS, skip: NEEDS_BUN }, async () => {
			assert.ok(REAL);
			const heldBun = await bunCopy("unattachable-bun");
			const command: OmpLaunchFacts = { command: heldBun, launcher: "bun-shim" };
			const clock = { offset: 0 };
			const window = windowWith({}, { client: { now: () => Date.now() + clock.offset } });
			const slot = nextSlot();

			// The broker is ended the moment its record appears (the file system tells us; nothing is polled): the record
			// stays, its process is gone, and every attach attempt finds that.
			const recordFile = ptyRecordPath(storage, slot);
			mkdirSync(path.dirname(recordFile), { recursive: true });
			const killed = Promise.withResolvers<number>();
			let ended = false;
			const watcher = watch(path.dirname(recordFile), () => {
				if (ended) return;
				try {
					const record: unknown = JSON.parse(readFileSync(recordFile, "utf8"));
					if (typeof record === "object" && record !== null && "brokerPid" in record && typeof record.brokerPid === "number") {
						ended = true;
						process.kill(record.brokerPid);
						killed.resolve(record.brokerPid);
					}
				} catch {
					// The record is not there yet, or not completely written: the next event is the one that counts.
				}
			});
			let first: RpcLaunchOutcome;
			try {
				first = await launch(window, command, slot);
			} finally {
				watcher.close();
			}
			assert.ok(Number.isSafeInteger(await killed.promise), "the broker's record appeared and its process was ended");
			assert.equal(first.state, "unconfirmed", first.reason);
			assert.match(first.reason, /a broker owns the slot but could not be attached/);
			assert.equal(runtimeLines(window).length, 1, runtimeLines(window).join("\n"));
			assert.ok((runtimeLines(window)[0] ?? "").startsWith(`Chat broker runtime: Bun ${REAL.version} (`), runtimeLines(window)[0]);
			assert.equal(window.trustReads.length, 1);

			// The next Chat on the same file does not start on Bun, says why, and reads and proves nothing.
			window.events.length = 0;
			assertOnExtensionHost(runningHandle(await launch(window, command)));
			const secondLines = runtimeLines(window);
			assert.equal(secondLines.length, 1, secondLines.join("\n"));
			assert.match(secondLines[0] ?? "", /^Chat broker runtime: VS Code \(Code\.exe\), because a Bun broker on this file could not be attached/);
			assert.equal(window.trustReads.length, 1, "a held file is decided before the trust read");

			// Held until the file changes: ten minutes on the clock do not lift it, a changed modification time does.
			clock.offset = TEN_MINUTES_MS + 60_000;
			window.events.length = 0;
			assertOnExtensionHost(runningHandle(await launch(window, command)));
			assert.match(runtimeLines(window)[0] ?? "", /could not be attached/);
			const later = new Date(Date.now() + 120_000);
			await utimes(heldBun, later, later);
			window.events.length = 0;
			const again = runningHandle(await launch(window, command));
			assert.deepEqual(recordedRuntime(again), { engine: "bun", version: REAL.version });
			assert.ok((runtimeLines(window)[0] ?? "").startsWith(`Chat broker runtime: Bun ${REAL.version} (`), runtimeLines(window).join("\n"));
			assert.equal(window.trustReads.length, 2);
		});

		it("holds a file whose broker left no usable record, on the reason of the branch the launch took, and lifts it as that branch says", { timeout: 4 * TEST_TIMEOUT_MS, skip: NEEDS_BUN }, async context => {
			assert.ok(REAL);
			const heldBun = await bunCopy("unreadable-bun");
			const command: OmpLaunchFacts = { command: heldBun, launcher: "bun-shim" };
			const clock = { offset: 0 };
			const slot = nextSlot();
			let planted = false;
			// An unreadable record is put into the slot as the Bun broker is about to start: it refuses to claim an occupied
			// slot and ends, leaving those bytes, so the client finds a record it cannot read and no broker that answers.
			const window = windowWith({}, {
				client: { now: () => Date.now() + clock.offset },
				// The trust read runs while the Bun plan is made, before the broker is spawned: plant the unreadable record then.
				onTrustRead: () => {
					if (planted) return;
					planted = true;
					const file = ptyRecordPath(storage, slot);
					mkdirSync(path.dirname(file), { recursive: true });
					writeFileSync(file, "this is not a broker record");
				},
			});

			const first = await launch(window, command, slot);
			assert.ok(planted, "the Bun start was reached");
			// The client reads the unreadable record while the process is still starting (it is alive and silent: a timed
			// hold), or after it ended (a record this build cannot read: held until the file changes). Which one depends
			// only on how fast the process refuses; each has its own reason and its own way out.
			const alive = first.state === "unconfirmed";
			context.diagnostic(alive ? "branch taken: the process was alive and silent (timed hold)" : "branch taken: the process had ended and left an unreadable record (hold until the file changes)");
			if (alive) assert.match(first.reason, /did not publish a record in time/);
			else assert.equal(first.state, "not-started", first.reason);
			const holdDetail = alive ? "had not published a record after the deadline" : "left a record this build could not read";

			window.events.length = 0;
			const second = runningHandle(await launch(window, command));
			assertOnExtensionHost(second);
			const secondLines = runtimeLines(window);
			assert.equal(secondLines.length, 1, secondLines.join("\n"));
			assert.match(secondLines[0] ?? "", /^Chat broker runtime: VS Code \(Code\.exe\), because /);
			assert.ok((secondLines[0] ?? "").includes(holdDetail), secondLines[0]);
			assert.equal(window.trustReads.length, 1, "a held file is decided before the trust read");

			if (alive) {
				clock.offset = TEN_MINUTES_MS + 60_000;
			} else {
				// Held until the file changes: the clock alone does not lift it.
				clock.offset = TEN_MINUTES_MS + 60_000;
				window.events.length = 0;
				assertOnExtensionHost(runningHandle(await launch(window, command)));
				assert.ok((runtimeLines(window)[0] ?? "").includes(holdDetail), runtimeLines(window).join("\n"));
				const later = new Date(Date.now() + 120_000);
				await utimes(heldBun, later, later);
			}
			window.events.length = 0;
			const lifted = runningHandle(await launch(window, command));
			assert.deepEqual(recordedRuntime(lifted), { engine: "bun", version: REAL.version });
			assert.ok((runtimeLines(window)[0] ?? "").startsWith(`Chat broker runtime: Bun ${REAL.version} (`), runtimeLines(window).join("\n"));
			assert.equal(window.trustReads.length, 2);
		});
	});

	describe("never replaces a recorded slot", () => {
		it("adopts a running broker on the extension host's executable and decides nothing about the runtime", { timeout: TEST_TIMEOUT_MS }, async () => {
			const slot = nextSlot();
			const first = windowWith(null);
			const started = runningHandle(await launch(first, undefined, slot));
			assertOnExtensionHost(started);

			const second = windowWith({});
			const outcome = await launch(second, { command: REAL?.executable ?? nodeAsBun, launcher: "bun-shim" }, slot);
			const adopted = runningHandle(outcome);
			assert.equal(outcome.adopted, true);
			assert.equal(outcome.brokerPid, started.brokerPid);
			assert.equal(adopted.brokerPid, started.brokerPid);
			assert.equal(adopted.record.brokerId, started.record.brokerId);
			assertOnExtensionHost(adopted);
			assert.deepEqual(runtimeLines(second), [], "the runtime is decided only when a broker has to be started");
			assert.equal(second.trustReads.length, 0);
		});
	});

	describe("without a policy", () => {
		it("starts every broker on the extension host's executable and logs nothing about Bun", { timeout: TEST_TIMEOUT_MS }, async () => {
			const window = windowWith(null);
			const handle = runningHandle(await launch(window, { command: REAL?.executable ?? nodeAsBun, launcher: "bun-shim" }));
			assertOnExtensionHost(handle);
			assert.equal(window.events.some(message => /Bun/.test(message)), false, window.events.join("\n"));
			assert.deepEqual(runtimeLines(window), []);
		});
	});
});
