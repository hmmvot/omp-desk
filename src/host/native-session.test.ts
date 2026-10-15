/**
 * What `waitForManagedRootExit` may call a stopped writer when the broker that would say so is gone.
 *
 * A broker ended from outside (Kill in Sessions, Task Manager, a crash) cannot answer a status
 * request, so the exit handling that follows it proves the writer gone the way a recovered row's is:
 * the broker's and the OMP root's own recorded creation times must name processes that are no longer
 * there. Anything less (a live process with the recorded creation time, a creation time never
 * recorded, a probe that cannot decide) must not be reported as stopped.
 *
 * `native-session.ts` imports `vscode` through its siblings without file extensions, so it is compiled
 * here with the project's bundler and a `vscode` stand-in, and the readings go through this test's own native module to the
 * real kernel.
 *
 * Runner: `node --test src/host/native-session.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import { queryPtyProcessIdentity } from "./pty-identity.ts";
import { loadWin32Native, setWin32NativeForTest } from "./win32-native.ts";
import { installedAddonAsset } from "./win32-test-support.ts";
import type { brokerAndRootGone as brokerAndRootGoneType, recordedRootGone as recordedRootGoneType, waitForManagedRootExit as waitForManagedRootExitType } from "./native-session.ts";

const VSCODE_STUB = `
export const Uri = { file: (value) => ({ fsPath: value }) };
export class ThemeIcon { constructor(id) { this.id = id; } }
export const window = { createTerminal: options => ({ options }), terminals: [] };
`;

/** An id no process has. */
const ABSENT_PID = 2147483000;

let temp: string;
let wait: typeof waitForManagedRootExitType;
let bothGone: typeof brokerAndRootGoneType;
let rootGone: typeof recordedRootGoneType;
let ownCreation: string;

before(async () => {
	temp = await mkdtemp(path.join(tmpdir(), "omp-native-session-"));
	const outfile = path.join(temp, "native-session.mjs");
	await build({
		entryPoints: [fileURLToPath(new URL("./native-session.ts", import.meta.url))],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node20",
		plugins: [
			{
				name: "vscode-stub",
				setup(pluginBuild) {
					pluginBuild.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
					pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: VSCODE_STUB, loader: "js" }));
				},
			},
		],
	});
	const loaded = (await import(pathToFileURL(outfile).href)) as { waitForManagedRootExit: typeof waitForManagedRootExitType; brokerAndRootGone: typeof brokerAndRootGoneType; recordedRootGone: typeof recordedRootGoneType };
	wait = loaded.waitForManagedRootExit;
	bothGone = loaded.brokerAndRootGone;
	rootGone = loaded.recordedRootGone;
	setWin32NativeForTest(await loadWin32Native(await installedAddonAsset()));
	const own = await queryPtyProcessIdentity(process.pid);
	assert.equal(own.kind, "found");
	ownCreation = own.kind === "found" ? own.creationTime : "";
});

after(async () => {
	await rm(temp, { recursive: true, force: true });
});

const GONE_CREATION = "134349421010000001";

/** A runtime whose broker no longer answers (every status request fails), with the given process facts. */
function deadBrokerRuntime(facts: { brokerPid: number; brokerCreationTime: string | null; childPid: number; childCreationTime: string | null }) {
	return {
		kind: "terminal",
		pid: facts.childPid,
		identity: { slot: "tab:one", brokerId: "pty-one", brokerGeneration: "g1", brokerPid: facts.brokerPid, brokerCreationTime: facts.brokerCreationTime, childPid: facts.childPid, childCreationTime: facts.childCreationTime },
		handle: {
			brokerPid: facts.brokerPid,
			record: { brokerCreationTime: facts.brokerCreationTime },
			refreshStatus: async () => {
				throw new Error("the broker connection closed");
			},
		},
	} as unknown as Parameters<typeof waitForManagedRootExitType>[0];
}

/** A broker client that reads the kernel through this test's own native module, as the real one does. */
const client = () => ({ identityReading: queryPtyProcessIdentity }) as unknown as Parameters<typeof waitForManagedRootExitType>[1];

describe("the writer of a session whose broker no longer answers", { skip: process.platform !== "win32" ? "the identity probe is implemented for Windows only" : false }, () => {
	it("is stopped when the broker's and the OMP root's recorded processes are both gone", async () => {
		const verdict = await wait(deadBrokerRuntime({ brokerPid: ABSENT_PID, brokerCreationTime: GONE_CREATION, childPid: ABSENT_PID - 1, childCreationTime: GONE_CREATION }), client(), 1_000);
		assert.equal(verdict.writerGone, true, verdict.diagnosticDetail);
	});

	it("is stopped when both ids were reissued to processes created at other times", async () => {
		const verdict = await wait(deadBrokerRuntime({ brokerPid: process.pid, brokerCreationTime: GONE_CREATION, childPid: process.pid, childCreationTime: GONE_CREATION }), client(), 1_000);
		assert.equal(verdict.writerGone, true, verdict.diagnosticDetail);
	});

	it("is not stopped while the OMP root is still the recorded process, even though the broker is gone", async () => {
		const verdict = await wait(deadBrokerRuntime({ brokerPid: ABSENT_PID, brokerCreationTime: GONE_CREATION, childPid: process.pid, childCreationTime: ownCreation }), client(), 1_000);
		assert.equal(verdict.writerGone, false, "an OMP process that survived its broker is still the writer");
	});

	it("is not stopped while the broker is still the recorded process: a failed request to a live broker proves nothing", async () => {
		const verdict = await wait(deadBrokerRuntime({ brokerPid: process.pid, brokerCreationTime: ownCreation, childPid: ABSENT_PID, childCreationTime: GONE_CREATION }), client(), 1_000);
		assert.equal(verdict.writerGone, false);
	});

	it("is not stopped when the broker's creation time was never recorded: its absence cannot be proven", async () => {
		const verdict = await wait(deadBrokerRuntime({ brokerPid: ABSENT_PID, brokerCreationTime: null, childPid: ABSENT_PID - 1, childCreationTime: GONE_CREATION }), client(), 1_000);
		assert.equal(verdict.writerGone, false);
	});
});

describe("the proof that a broker and its root are both gone", { skip: process.platform !== "win32" ? "the identity probe is implemented for Windows only" : false }, () => {
	it("holds only when both recorded identities name gone processes", async () => {
		assert.equal(await bothGone(client(), { pid: ABSENT_PID, creationTime: GONE_CREATION }, { pid: ABSENT_PID - 1, creationTime: GONE_CREATION }), true);
		assert.equal(await bothGone(client(), { pid: process.pid, creationTime: GONE_CREATION }, { pid: process.pid, creationTime: GONE_CREATION }), true, "reissued ids");
	});

	it("does not hold while either process is still the recorded one, or when an identity was never recorded", async () => {
		assert.equal(await bothGone(client(), { pid: ABSENT_PID, creationTime: GONE_CREATION }, { pid: process.pid, creationTime: ownCreation }), false);
		assert.equal(await bothGone(client(), { pid: process.pid, creationTime: ownCreation }, { pid: ABSENT_PID, creationTime: GONE_CREATION }), false);
		assert.equal(await bothGone(client(), { pid: ABSENT_PID, creationTime: null }, { pid: ABSENT_PID - 1, creationTime: GONE_CREATION }), false);
		assert.equal(await bothGone(client(), { pid: ABSENT_PID, creationTime: GONE_CREATION }, { pid: ABSENT_PID - 1, creationTime: null }), false);
	});

	it("does not hold when the native module cannot answer", async () => {
		const noNative = { identityReading: async () => ({ kind: "unknown", detail: "the native module is not available" }) } as unknown as Parameters<typeof waitForManagedRootExitType>[1];
		assert.equal(await bothGone(noNative, { pid: ABSENT_PID, creationTime: GONE_CREATION }, { pid: ABSENT_PID - 1, creationTime: GONE_CREATION }), false);
	});
});

describe("the proof that a stopped session's OMP root already ended", { skip: process.platform !== "win32" ? "the identity probe is implemented for Windows only" : false }, () => {
	it("holds for an id no process uses, even with no broker to ask", async () => {
		assert.equal(await rootGone(null, { pid: ABSENT_PID, creationTime: GONE_CREATION }), true);
	});

	it("holds for an id reissued to a process created at another time", async () => {
		assert.equal(await rootGone(client(), { pid: process.pid, creationTime: GONE_CREATION }), true);
	});

	it("does not hold while the id is still the recorded process, or when that cannot be read", async () => {
		assert.equal(await rootGone(client(), { pid: process.pid, creationTime: ownCreation }), false);
		assert.equal(await rootGone(null, { pid: process.pid, creationTime: GONE_CREATION }), false, "no probe to tell a reissued id apart");
		assert.equal(await rootGone(client(), { pid: process.pid, creationTime: null }), false, "a creation time never recorded");
	});
});
