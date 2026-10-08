/**
 * Tests for the broker-only stop of the Processes view, against fakes.
 *
 * The stop attaches to the recorded broker, proves it is the broker that was shown, stops
 * the child if it runs, and asks the empty broker to shut down. These tests defend that
 * order, that nothing is sent to a broker that is not the captured one, and that every
 * handle is released. The real broker is exercised in
 * `broker-process-stop.integration.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BROKER_PROCESS_EXIT_TIMEOUT_MS,
	BROKER_PROCESS_STOP_TIMEOUT_MS,
	brokerStopAttachFor,
	stopBrokerThroughBroker,
} from "./broker-process-stop.ts";
import type { BrokerStopAttach, BrokerStopPorts, BrokerStopTarget } from "./broker-process-stop.ts";
import type { PtyBrokerClient } from "./pty-client.ts";
import {
	PTY_PROTOCOL_VERSION,
	PTY_RECORD_VERSION,
	PTY_RUNTIME_VERSION,
	PTY_SERVICE,
	createPtyToken,
} from "./pty-protocol.ts";
import type { PtyBrokerRecord, PtyKind, PtyStopResult } from "./pty-protocol.ts";
import type { PtyRecordLookup } from "./pty-registry.ts";
import type { ProbeHandle } from "./rpc-reconcile.ts";

const BROKER_ID = "pty-11111111-2222-3333-4444-555555555555";
const GENERATION = "gen-11111111-2222-3333-4444-555555555555";
const CREATION = "134349421014308869";

function record(overrides: Partial<PtyBrokerRecord> = {}): PtyBrokerRecord {
	return {
		version: PTY_RECORD_VERSION,
		service: PTY_SERVICE,
		protocolVersion: PTY_PROTOCOL_VERSION,
		runtimeVersion: PTY_RUNTIME_VERSION,
		treeDigest: "a".repeat(64),
		brokerId: BROKER_ID,
		generation: GENERATION,
		slot: "tab:one",
		kind: "managed-omp",
		port: 51234,
		token: createPtyToken(),
		brokerPid: 4242,
		brokerCreationTime: CREATION,
		startedAt: new Date(0).toISOString(),
		cols: 100,
		rows: 30,
		title: null,
		...overrides,
	};
}

function targetOf(source: PtyBrokerRecord): BrokerStopTarget {
	return {
		slot: source.slot,
		kind: source.kind,
		brokerId: source.brokerId,
		generation: source.generation,
		brokerPid: source.brokerPid,
		brokerCreationTime: source.brokerCreationTime ?? "",
	};
}

function stopResult(overrides: Partial<PtyStopResult> = {}): PtyStopResult {
	return {
		verified: false,
		mode: "graceful",
		nativePid: 5151,
		pidGone: true,
		tree: "unknown",
		treeEvidence: "parent-links-only",
		remainingPids: [],
		checkedPids: [],
		exitCode: 0,
		detail: "the child exited",
		...overrides,
	};
}

interface FakeHandleOptions {
	readonly record?: PtyBrokerRecord;
	readonly slot?: string;
	readonly kind?: PtyKind;
	readonly brokerPid?: number;
	readonly state?: "running" | "exited" | null;
	readonly stop?: (mode: string | undefined) => Promise<PtyStopResult>;
	readonly shutdown?: () => Promise<{ readonly stopped: boolean }>;
}

/** A handle that logs every call in order, so a test can assert the sequence. */
function fakeHandle(options: FakeHandleOptions = {}) {
	const log: string[] = [];
	const stopOptions: Array<{ mode?: string; timeoutMs?: number }> = [];
	const shutdownOptions: Array<{ requireStopped?: boolean } | undefined> = [];
	const source = options.record ?? record();
	const handle: ProbeHandle = {
		slot: options.slot ?? source.slot,
		kind: options.kind ?? source.kind,
		brokerPid: options.brokerPid ?? source.brokerPid,
		record: source,
		nativePid: 5151,
		nativeCreationTime: CREATION,
		state: options.state === undefined ? "running" : options.state,
		disconnect: () => {
			log.push("disconnect");
		},
		stop: async stopArgs => {
			log.push(`stop:${stopArgs.mode ?? "graceful"}`);
			stopOptions.push({ mode: stopArgs.mode, timeoutMs: stopArgs.timeoutMs });
			return await (options.stop ?? (async () => stopResult()))(stopArgs.mode);
		},
		shutdown: async shutdownArgs => {
			log.push("shutdown");
			shutdownOptions.push(shutdownArgs);
			return await (options.shutdown ?? (async () => ({ stopped: true })))();
		},
	};
	return { handle, log, stopOptions, shutdownOptions };
}

function portsFor(
	attached: BrokerStopAttach,
	overrides: Partial<BrokerStopPorts> = {},
): { ports: BrokerStopPorts; waits: Array<{ target: BrokerStopTarget; timeoutMs: number }>; attaches: BrokerStopTarget[]; diagnostics: string[] } {
	const waits: Array<{ target: BrokerStopTarget; timeoutMs: number }> = [];
	const attaches: BrokerStopTarget[] = [];
	const diagnostics: string[] = [];
	const ports: BrokerStopPorts = {
		log: message => diagnostics.push(message),
		attach: async target => {
			attaches.push(target);
			return attached;
		},
		waitBrokerGone: async (target, timeoutMs) => {
			waits.push({ target, timeoutMs });
			return { gone: true, detail: "the broker is gone" };
		},
		...overrides,
	};
	return { ports, waits, attaches, diagnostics };
}

describe("stopBrokerThroughBroker", () => {
	it("stops a running child, then shuts the empty broker down, then lets go", async () => {
		const fake = fakeHandle();
		const { ports, waits, attaches } = portsFor({ ok: true, handle: fake.handle });
		const target = targetOf(fake.handle.record);
		const outcome = await stopBrokerThroughBroker(target, "graceful", ports);
		assert.equal(outcome.kind, "stopped");
		assert.equal(outcome.kind === "stopped" ? outcome.childWasRunning : null, true);
		assert.equal(outcome.kind === "stopped" ? outcome.brokerGone : null, true);
		assert.deepEqual(fake.log, ["stop:graceful", "shutdown", "disconnect"]);
		assert.deepEqual(fake.shutdownOptions, [{ requireStopped: true }]);
		assert.deepEqual(attaches, [target]);
		// The wait is for this very broker.
		assert.deepEqual(waits, [{ target, timeoutMs: BROKER_PROCESS_EXIT_TIMEOUT_MS }]);
		assert.equal(fake.stopOptions[0]?.timeoutMs, BROKER_PROCESS_STOP_TIMEOUT_MS);
	});

	it("honours the timeouts the ports give", async () => {
		const fake = fakeHandle();
		const { ports, waits } = portsFor({ ok: true, handle: fake.handle }, { stopTimeoutMs: 111, exitTimeoutMs: 222 });
		await stopBrokerThroughBroker(targetOf(fake.handle.record), "graceful", ports);
		assert.equal(fake.stopOptions[0]?.timeoutMs, 111);
		assert.equal(waits[0]?.timeoutMs, 222);
	});

	it("asks only the shutdown of a child that already exited", async () => {
		const fake = fakeHandle({ state: "exited" });
		const { ports } = portsFor({ ok: true, handle: fake.handle });
		const outcome = await stopBrokerThroughBroker(targetOf(fake.handle.record), "graceful", ports);
		assert.equal(outcome.kind, "stopped");
		assert.equal(outcome.kind === "stopped" ? outcome.childWasRunning : null, false);
		assert.deepEqual(fake.log, ["shutdown", "disconnect"]);
		assert.deepEqual(fake.shutdownOptions, [{ requireStopped: true }]);
	});

	it("treats a child whose state is not known as not running, and sends no stop", async () => {
		const fake = fakeHandle({ state: null });
		const { ports } = portsFor({ ok: true, handle: fake.handle });
		await stopBrokerThroughBroker(targetOf(fake.handle.record), "graceful", ports);
		assert.deepEqual(fake.log, ["shutdown", "disconnect"]);
	});

	it("sends the force mode only when asked for it", async () => {
		const fake = fakeHandle({ stop: async mode => stopResult({ mode: mode === "force" ? "force" : "graceful" }) });
		const { ports } = portsFor({ ok: true, handle: fake.handle });
		const outcome = await stopBrokerThroughBroker(targetOf(fake.handle.record), "force", ports);
		assert.equal(outcome.kind, "stopped");
		assert.deepEqual(fake.log, ["stop:force", "shutdown", "disconnect"]);
	});

	describe("refuses, sends nothing, and still lets go, when the handshake names another broker", () => {
		const mismatches: ReadonlyArray<readonly [string, FakeHandleOptions]> = [
			["handle slot", { slot: "tab:other" }],
			["record slot", { record: record({ slot: "tab:other" }) }],
			["broker id", { record: record({ brokerId: "pty-99999999-2222-3333-4444-555555555555" }) }],
			["generation", { record: record({ generation: "gen-99999999-2222-3333-4444-555555555555" }) }],
			["broker pid", { brokerPid: 9999 }],
		];
		for (const [name, options] of mismatches) {
			it(`a different ${name}`, async () => {
				const target = targetOf(record());
				const fake = fakeHandle(options);
				const { ports, waits } = portsFor({ ok: true, handle: fake.handle });
				const outcome = await stopBrokerThroughBroker(target, "graceful", ports);
				assert.equal(outcome.kind, "refused");
				assert.deepEqual(fake.log, ["disconnect"]);
				assert.deepEqual(waits, []);
			});
		}

		it("a different kind", async () => {
			const target = { ...targetOf(record()), kind: "folder-shell" as const };
			const fake = fakeHandle({ state: "running" });
			const { ports } = portsFor({ ok: true, handle: fake.handle });
			const outcome = await stopBrokerThroughBroker(target, "graceful", ports);
			assert.equal(outcome.kind, "refused");
			assert.deepEqual(fake.log, ["disconnect"]);
		});
	});

	it("is refused, with the attach's reason, when the attach is refused", async () => {
		const { ports, waits } = portsFor({ ok: false, reason: "the broker could not be authenticated" });
		const outcome = await stopBrokerThroughBroker(targetOf(record()), "graceful", ports);
		assert.deepEqual(outcome, { kind: "refused", reason: "the broker could not be authenticated" });
		assert.deepEqual(waits, []);
	});

	it("is unconfirmed, and may be forced, when a graceful stop does not prove the child gone", async () => {
		const fake = fakeHandle({ stop: async () => stopResult({ pidGone: false, detail: "it still answers" }) });
		const { ports, waits, diagnostics } = portsFor({ ok: true, handle: fake.handle });
		const outcome = await stopBrokerThroughBroker(targetOf(fake.handle.record), "graceful", ports);
		assert.equal(outcome.kind, "unconfirmed");
		assert.equal(outcome.kind === "unconfirmed" ? outcome.canForce : null, true);
		assert.ok(diagnostics.some(message => message.includes("it still answers")));
		// A broker whose child may still run is never asked to shut down.
		assert.deepEqual(fake.log, ["stop:graceful", "disconnect"]);
		assert.deepEqual(waits, []);
	});

	it("cannot be forced again after a failed force stop", async () => {
		const fake = fakeHandle({ stop: async () => stopResult({ pidGone: false, mode: "force" }) });
		const { ports } = portsFor({ ok: true, handle: fake.handle });
		const outcome = await stopBrokerThroughBroker(targetOf(fake.handle.record), "force", ports);
		assert.equal(outcome.kind, "unconfirmed");
		assert.equal(outcome.kind === "unconfirmed" ? outcome.canForce : null, false);
		assert.deepEqual(fake.log, ["stop:force", "disconnect"]);
	});

	it("is unconfirmed when the stop request throws, and does not shut down", async () => {
		const fake = fakeHandle({
			stop: async () => {
				throw new Error("the connection dropped");
			},
		});
		const { ports } = portsFor({ ok: true, handle: fake.handle });
		const outcome = await stopBrokerThroughBroker(targetOf(fake.handle.record), "graceful", ports);
		assert.equal(outcome.kind, "unconfirmed");
		assert.deepEqual(fake.log, ["stop:graceful", "disconnect"]);
	});

	it("is unconfirmed, and cannot be forced, when the broker declines to shut down", async () => {
		const fake = fakeHandle({ shutdown: async () => ({ stopped: false }) });
		const { ports, waits } = portsFor({ ok: true, handle: fake.handle });
		const outcome = await stopBrokerThroughBroker(targetOf(fake.handle.record), "graceful", ports);
		assert.equal(outcome.kind, "unconfirmed");
		assert.equal(outcome.kind === "unconfirmed" ? outcome.canForce : null, false, "no force is offered once the child is gone");
		assert.deepEqual(fake.log, ["stop:graceful", "shutdown", "disconnect"]);
		assert.deepEqual(waits, []);
	});

	it("is unconfirmed, and cannot be forced, when the shutdown request throws", async () => {
		const fake = fakeHandle({
			state: "exited",
			shutdown: async () => {
				throw new Error("child-alive");
			},
		});
		const { ports, diagnostics } = portsFor({ ok: true, handle: fake.handle });
		const outcome = await stopBrokerThroughBroker(targetOf(fake.handle.record), "graceful", ports);
		assert.equal(outcome.kind, "unconfirmed");
		assert.equal(outcome.kind === "unconfirmed" ? outcome.canForce : null, false);
		assert.ok(diagnostics.some(message => message.includes("child-alive")));
		assert.deepEqual(fake.log, ["shutdown", "disconnect"]);
	});

	it("reports a stop with the broker not yet gone when its PID outlives the wait", async () => {
		const fake = fakeHandle();
		const { ports, diagnostics } = portsFor(
			{ ok: true, handle: fake.handle },
			{ waitBrokerGone: async () => ({ gone: false, detail: "it was still listed after 10s" }) },
		);
		const outcome = await stopBrokerThroughBroker(targetOf(fake.handle.record), "graceful", ports);
		assert.equal(outcome.kind, "stopped");
		assert.equal(outcome.kind === "stopped" ? outcome.brokerGone : null, false);
		assert.ok(diagnostics.some(message => message.includes("it was still listed after 10s")));
		assert.deepEqual(fake.log, ["stop:graceful", "shutdown", "disconnect"]);
	});
});

describe("brokerStopAttachFor", () => {
	interface FakeClient {
		readonly client: PtyBrokerClient;
		readonly calls: Array<{ method: string; record: PtyBrokerRecord; options: unknown }>;
		readonly reads: string[];
	}

	/** A client that answers one lookup and records every attach it is asked for. */
	function fakeClient(lookup: PtyRecordLookup | Error, attached: ProbeHandle | null): FakeClient {
		const calls: FakeClient["calls"] = [];
		const reads: string[] = [];
		const attach = (method: string) => async (source: PtyBrokerRecord, options?: unknown) => {
			calls.push({ method, record: source, options });
			return attached === null
				? { state: "unavailable", reason: "refused", handle: null }
				: { state: "attached", reason: null, handle: attached };
		};
		const client = {
			readRecord: async (slot: string) => {
				reads.push(slot);
				if (lookup instanceof Error) throw lookup;
				return lookup;
			},
			attachRpcRecord: attach("attachRpcRecord"),
			attachRecord: attach("attachRecord"),
		} as unknown as PtyBrokerClient;
		return { client, calls, reads };
	}

	it("attaches a managed-rpc record through attachRpcRecord, adopted and with no owner", async () => {
		const stored = record({ kind: "managed-rpc" });
		const handle = fakeHandle({ record: stored }).handle;
		const fake = fakeClient({ kind: "ok", record: stored }, handle);
		const outcome = await brokerStopAttachFor(fake.client, () => {})(targetOf(stored));
		assert.deepEqual(outcome, { ok: true, handle });
		assert.deepEqual(fake.reads, [stored.slot]);
		assert.equal(fake.calls.length, 1);
		assert.equal(fake.calls[0]?.method, "attachRpcRecord");
		assert.deepEqual(fake.calls[0]?.options, { adopted: true });
		assert.equal("owner" in (fake.calls[0]?.options as object), false);
	});

	for (const kind of ["managed-omp", "folder-shell"] as const) {
		it(`attaches a ${kind} record through attachRecord, adopted and with no owner`, async () => {
			const stored = record({ kind });
			const handle = fakeHandle({ record: stored }).handle;
			const fake = fakeClient({ kind: "ok", record: stored }, handle);
			const outcome = await brokerStopAttachFor(fake.client, () => {})(targetOf(stored));
			assert.equal(outcome.ok, true);
			assert.equal(fake.calls.length, 1);
			assert.equal(fake.calls[0]?.method, "attachRecord");
			assert.deepEqual(fake.calls[0]?.options, { adopted: true });
			assert.equal("owner" in (fake.calls[0]?.options as object), false);
		});
	}

	it("refuses a slot with no record, without attaching", async () => {
		const fake = fakeClient({ kind: "none" }, null);
		const outcome = await brokerStopAttachFor(fake.client, () => {})(targetOf(record()));
		assert.equal(outcome.ok, false);
		assert.deepEqual(fake.calls, []);
	});

	it("refuses a record that cannot be read, without attaching", async () => {
		for (const lookup of [{ kind: "invalid", detail: "bad json" } as const, new Error("EBUSY")]) {
			const fake = fakeClient(lookup, null);
			const outcome = await brokerStopAttachFor(fake.client, () => {})(targetOf(record()));
			assert.equal(outcome.ok, false);
			assert.deepEqual(fake.calls, []);
		}
	});

	describe("refuses, without attaching, when the record no longer names the captured broker", () => {
		const changes: ReadonlyArray<readonly [string, Partial<PtyBrokerRecord>]> = [
			["broker id", { brokerId: "pty-99999999-2222-3333-4444-555555555555" }],
			["generation", { generation: "gen-99999999-2222-3333-4444-555555555555" }],
			["broker pid", { brokerPid: 9999 }],
			["broker creation time", { brokerCreationTime: "134349421019999999" }],
			["missing broker creation time", { brokerCreationTime: null }],
			["slot", { slot: "tab:other" }],
		];
		for (const [name, change] of changes) {
			it(`a changed ${name}`, async () => {
				const captured = record();
				const fake = fakeClient({ kind: "ok", record: { ...captured, ...change } }, fakeHandle().handle);
				const outcome = await brokerStopAttachFor(fake.client, () => {})(targetOf(captured));
				assert.equal(outcome.ok, false);
				assert.deepEqual(fake.calls, []);
			});
		}
	});

	it("refuses when the attach yields no handle", async () => {
		const stored = record();
		const fake = fakeClient({ kind: "ok", record: stored }, null);
		const outcome = await brokerStopAttachFor(fake.client, () => {})(targetOf(stored));
		assert.equal(outcome.ok, false);
		assert.equal(fake.calls.length, 1);
	});

	it("refuses, with the reason, when the attach throws", async () => {
		const stored = record();
		const client = {
			readRecord: async () => ({ kind: "ok", record: stored }),
			attachRecord: async () => {
				throw new Error("handshake refused");
			},
			attachRpcRecord: async () => {
				throw new Error("handshake refused");
			},
		} as unknown as PtyBrokerClient;
		const diagnostics: string[] = [];
		const outcome = await brokerStopAttachFor(client, message => diagnostics.push(message))(targetOf(stored));
		assert.equal(outcome.ok, false);
		assert.ok(diagnostics.some(message => message.includes("handshake refused")));
	});
});
