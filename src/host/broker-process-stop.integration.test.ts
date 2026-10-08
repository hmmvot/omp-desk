/**
 * The broker-only stop of the Processes view against the real, packaged broker.
 *
 * `broker-process-stop.test.ts` defends the order and the refusals with fakes; this file
 * proves the same path against a broker that really runs: the record's identity is read
 * back, the broker authenticates, the child stops, the empty broker shuts itself down and
 * its PID disappears, while its record stays as recovery metadata. No process id is
 * signalled by any of it.
 *
 * Skipped outside Windows (the identity readings are Windows-only) and when the packaged
 * broker tree has not been built (`node esbuild.mjs --pty`).
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { brokerStopAttachFor, stopBrokerThroughBroker } from "./broker-process-stop.ts";
import type { BrokerStopPorts, BrokerStopTarget } from "./broker-process-stop.ts";
import { PtyBrokerClient } from "./pty-client.ts";
import type { PtyHandle } from "./pty-client.ts";
import { isPtyProcessAlive, waitForPtyProcessGone } from "./pty-identity.ts";
import type { PtyProbeHelper } from "./pty-identity.ts";
import { readPtyRecord } from "./pty-registry.ts";

const EXTENSION_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** A child that stays alive until it is stopped. */
const LIVE_SCRIPT = "process.stdout.write('READY\\r\\n'); setInterval(() => {}, 1000);";
/** A child that exits by itself at once. */
const EXITING_SCRIPT = "process.stdout.write('DONE'); process.exit(0);";

const WINDOWS_ONLY = process.platform !== "win32" ? "the process identity readings are implemented for Windows only" : false;
const BUILT = existsSync(path.join(EXTENSION_ROOT, "out", "pty", "pty-broker.js"));
const SKIP = WINDOWS_ONLY || (BUILT ? false : "the packaged broker tree is absent: run `node esbuild.mjs --pty` first");

let storage = "";
let client: PtyBrokerClient;
let helper: PtyProbeHelper;
const opened: PtyHandle[] = [];
let counter = 0;

before(async () => {
	if (SKIP !== false) return;
	// The record directory must satisfy the real access convention, so the storage tree
	// lives in this account's profile rather than in the shared temporary directory.
	storage = await mkdtemp(path.join(homedir(), ".omp-broker-stop-e2e-"));
	client = new PtyBrokerClient({ storageDir: storage, extensionRoot: EXTENSION_ROOT });
});

after(async () => {
	if (SKIP !== false) return;
	for (const handle of opened) {
		try {
			await handle.stop({ mode: "force", timeoutMs: 10_000 });
			await handle.shutdown({ requireStopped: false });
		} catch {
			handle.disconnect();
		}
	}
	// A broker runs with the staged tree as its working directory, so a Windows removal
	// can still see it busy for a moment after the process exits.
	await rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function launch(script: string): Promise<{ handle: PtyHandle; target: BrokerStopTarget }> {
	counter += 1;
	const outcome = await client.launch({
		slot: `tab:stop-e2e-${counter}`,
		kind: "managed-omp",
		file: process.execPath,
		args: ["-e", script],
		cwd: tmpdir(),
		cols: 100,
		rows: 30,
		title: `stop e2e ${counter}`,
	});
	assert.equal(outcome.state, "running", outcome.reason);
	assert.ok(outcome.handle);
	opened.push(outcome.handle);
	const record = outcome.handle.record;
	assert.ok(record.brokerCreationTime, "the broker did not record its creation time");
	return {
		handle: outcome.handle,
		target: {
			slot: record.slot,
			kind: record.kind,
			brokerId: record.brokerId,
			generation: record.generation,
			brokerPid: record.brokerPid,
			brokerCreationTime: record.brokerCreationTime,
		},
	};
}

/** Resolve once the child is exited: from the status now, or from the state frame still coming. */
async function whenExited(handle: PtyHandle): Promise<void> {
	const exited = new Promise<void>(resolve => {
		const unsubscribe = handle.subscribe(event => {
			if (event.type === "state" && event.status.state === "exited") {
				unsubscribe();
				resolve();
			}
		});
	});
	await handle.attach({ since: 0 });
	if ((await handle.refreshStatus()).state !== "exited") await exited;
}

function realPorts(): BrokerStopPorts {
	return {
		log: message => console.log(message),
		attach: brokerStopAttachFor(client, message => console.log(message)),
		waitBrokerGone: async (target, timeoutMs) => {
			const reading = await waitForPtyProcessGone(helper, target.brokerPid, target.brokerCreationTime, timeoutMs);
			return { gone: reading.gone, detail: reading.detail };
		},
	};
}

describe("stopBrokerThroughBroker against the real broker", { skip: SKIP }, () => {
	before(async () => {
		const readiness = await client.ready();
		assert.equal(readiness.ready, true, readiness.reason ?? "not ready");
		assert.ok(readiness.runtime);
		helper = readiness.runtime.helper;
	});

	it("stops a running child gracefully, shuts the broker down, and keeps its record", async () => {
		const { handle, target } = await launch(LIVE_SCRIPT);
		assert.equal((await handle.refreshStatus()).state, "running");
		const outcome = await stopBrokerThroughBroker(target, "graceful", realPorts());
		assert.equal(outcome.kind, "stopped", JSON.stringify(outcome));
		assert.equal(outcome.kind === "stopped" ? outcome.childWasRunning : null, true);
		assert.equal(outcome.kind === "stopped" ? outcome.brokerGone : null, true);
		assert.equal(isPtyProcessAlive(target.brokerPid), false);
		// The broker never retires its record on an unproven tree (ADR-0029).
		assert.equal((await readPtyRecord(storage, target.slot)).kind, "ok");
	});

	it("shuts down a broker whose child already exited, without a stop request", async () => {
		const { handle, target } = await launch(EXITING_SCRIPT);
		await whenExited(handle);
		const outcome = await stopBrokerThroughBroker(target, "graceful", realPorts());
		assert.equal(outcome.kind, "stopped", JSON.stringify(outcome));
		assert.equal(outcome.kind === "stopped" ? outcome.childWasRunning : null, false);
		assert.equal(outcome.kind === "stopped" ? outcome.brokerGone : null, true);
		assert.equal(isPtyProcessAlive(target.brokerPid), false);
	});

	it("refuses a target that is not the recorded broker, and leaves the broker and its child running", async () => {
		const { handle, target } = await launch(LIVE_SCRIPT);
		const changes: ReadonlyArray<Partial<BrokerStopTarget>> = [
			{ generation: "gen-99999999-2222-3333-4444-555555555555" },
			{ brokerId: "pty-99999999-2222-3333-4444-555555555555" },
			{ brokerCreationTime: "134349421019999999" },
			{ brokerPid: target.brokerPid + 1 },
		];
		for (const change of changes) {
			const outcome = await stopBrokerThroughBroker({ ...target, ...change }, "graceful", realPorts());
			assert.equal(outcome.kind, "refused", JSON.stringify(change));
		}
		assert.equal(isPtyProcessAlive(target.brokerPid), true);
		assert.equal((await handle.refreshStatus()).state, "running");
	});

	it("refuses a slot that has no record", async () => {
		const { target } = await launch(LIVE_SCRIPT);
		const outcome = await stopBrokerThroughBroker({ ...target, slot: "tab:stop-e2e-never-launched" }, "graceful", realPorts());
		assert.equal(outcome.kind, "refused");
		assert.equal(isPtyProcessAlive(target.brokerPid), true);
	});
});
