import assert from "node:assert/strict";
import { test } from "node:test";
import { stopShellAndBroker, watchShellExit, type ShellExitSource, type ShellStopSource } from "./shell-exit.ts";
import type { PtyHandleEvent } from "./pty-client.ts";
import type { PtyStatusPayload, PtyStopResult } from "./pty-protocol.ts";
import { TabLifecycle } from "./tab-lifecycle.ts";

function fixture(initial: ShellExitSource["state"] = "running", kind: ShellExitSource["kind"] = "folder-shell") {
	let state = initial;
	const listeners = new Set<(event: PtyHandleEvent) => void>();
	const calls: string[] = [];
	const logs: string[] = [];
	const source: ShellExitSource = {
		kind, get state() { return state; },
		subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		async shutdown(options) { assert.equal(options?.requireStopped, true); calls.push("shutdown"); return { stopped: true }; },
	};
	const status = (next: "running" | "exited"): PtyStatusPayload => ({
		state: next, exitCode: next === "exited" ? 0 : null, signal: null,
		cols: 80, rows: 24, alt: false, title: null, nativePid: 11, nativeCreationTime: null,
		brokerPid: 12, brokerCreationTime: null, clients: 1, inputOwner: null,
		uptimeMs: 100, noClientForMs: null, childExitedAtMs: next === "exited" ? 100 : null,
		outputPosition: 0, oldestPosition: 0, notices: [],
		ownerStop: { state: "disarmed", detail: "", owners: [], graceRemainingMs: null },
	});
	return {
		source, calls, logs,
		ports: {
			async retireSlot() { calls.push("remove-shell-slot", "forget-broker-mapping"); },
			log(message: string) { logs.push(message); },
			runRetirement: (operation: () => Promise<void>) => operation(),
		},
		push(next: "running" | "exited") { state = next; for (const listener of listeners) listener({ type: "state", status: status(next) }); },
		close() { for (const listener of listeners) listener({ type: "closed", reason: "disconnected" }); },
	};
}

const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test("natural exit retires shell metadata and shuts down its authenticated broker once, with a frontend still attached", async () => {
	const f = fixture();
	const unsubscribe = watchShellExit(f.source, f.ports);
	f.push("running"); f.close();
	assert.deepEqual(f.calls, [], "socket closure or running state is not proof of child exit");
	f.push("exited"); f.push("exited");
	await settled();
	assert.deepEqual(f.calls, ["remove-shell-slot", "forget-broker-mapping", "shutdown"]);
	assert.deepEqual(f.logs, []);
	unsubscribe();
});

test("reattaching an already exited shell also retires it", async () => {
	const f = fixture("exited");
	watchShellExit(f.source, f.ports)();
	await settled();
	assert.deepEqual(f.calls, ["remove-shell-slot", "forget-broker-mapping", "shutdown"]);
});

test("unknown child state and managed OMP children are never automatically retired", async () => {
	for (const kind of ["folder-shell", "managed-omp", "managed-rpc"] as const) {
		const f = fixture(null, kind);
		const stop = watchShellExit(f.source, f.ports);
		f.close();
		if (kind !== "folder-shell") f.push("exited");
		await settled();
		assert.deepEqual(f.calls, []);
		stop();
	}
});

test("unsubscribing a live shell prevents obsolete editor callbacks", async () => {
	const f = fixture();
	watchShellExit(f.source, f.ports)();
	f.push("exited");
	await settled();
	assert.deepEqual(f.calls, []);
});

test("an unconfirmed shutdown is logged without a force or child stop", async () => {
	const f = fixture();
	f.source.shutdown = async () => { f.calls.push("shutdown"); throw new Error("connection closed"); };
	watchShellExit(f.source, f.ports);
	f.push("exited");
	await settled();
	assert.deepEqual(f.calls, ["remove-shell-slot", "forget-broker-mapping", "shutdown"]);
	assert.equal(f.logs.length, 1);
});

test("natural retirement waits for the whole explicit stop and shutdown, then yields to its authenticated outcome", async () => {
	const f = fixture();
	const lifecycle = new TabLifecycle();
	const slot = "shell:serialized";
	f.ports.runRetirement = operation => lifecycle.run(slot, operation);
	const stopWatch = watchShellExit(f.source, f.ports);
	const entered = Promise.withResolvers<void>();
	const verdict = Promise.withResolvers<void>();
	const explicit = lifecycle.run(slot, async () => {
		entered.resolve();
		await verdict.promise;
		f.calls.push("stop-reply");
		const ack = await f.source.shutdown({ requireStopped: true });
		assert.equal(ack.stopped, true);
		stopWatch({ cancelQueuedRetirement: true });
	});
	await entered.promise;
	f.push("exited");
	await settled();
	assert.deepEqual(f.calls, [], "an exit event cannot preempt the explicit transaction's shutdown");
	verdict.resolve();
	await explicit;
	await lifecycle.run(slot, async () => undefined);
	// The explicit controller owns metadata retirement after its confirmed outcome.
	await f.ports.retireSlot();
	assert.deepEqual(f.calls, ["stop-reply", "shutdown", "remove-shell-slot", "forget-broker-mapping"]);
	assert.deepEqual(f.logs, []);
});

test("a failed explicit transaction releases the slot for the queued natural retirement", async () => {
	const f = fixture();
	const lifecycle = new TabLifecycle();
	const slot = "shell:failed-explicit";
	f.ports.runRetirement = operation => lifecycle.run(slot, operation);
	const stopWatch = watchShellExit(f.source, f.ports);
	const entered = Promise.withResolvers<void>();
	const failure = Promise.withResolvers<void>();
	const explicit = lifecycle.run(slot, async () => {
		entered.resolve();
		await failure.promise;
		throw new Error("explicit stop failed");
	});
	const rejected = assert.rejects(explicit);
	await entered.promise;
	f.push("exited");
	await settled();
	assert.deepEqual(f.calls, []);
	failure.resolve();
	await rejected;
	await lifecycle.run(slot, async () => undefined);
	assert.deepEqual(f.calls, ["remove-shell-slot", "forget-broker-mapping", "shutdown"]);
	assert.deepEqual(f.logs, []);
	stopWatch();
});

test("ordinary editor teardown preserves a natural exit already queued on the shell lifecycle", async () => {
	const f = fixture();
	const lifecycle = new TabLifecycle();
	const slot = "shell:closed-editor";
	f.ports.runRetirement = operation => lifecycle.run(slot, operation);
	const held = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const prior = lifecycle.run(slot, async () => { entered.resolve(); await held.promise; });
	await entered.promise;
	const stopWatch = watchShellExit(f.source, f.ports);
	f.push("exited");
	stopWatch();
	held.resolve();
	await prior;
	await lifecycle.run(slot, async () => undefined);
	assert.deepEqual(f.calls, ["remove-shell-slot", "forget-broker-mapping", "shutdown"]);
});

function stopFixture(state: ShellStopSource["state"] = "running") {
	const calls: string[] = [];
	const logs: string[] = [];
	let result: PtyStopResult = {
		mode: "graceful", verified: false, pidGone: true, nativePid: 11,
		tree: "unknown", treeEvidence: "parent-links-only",
		remainingPids: [], checkedPids: [], exitCode: 0, detail: "the exact child generation is gone",
	};
	const source: ShellStopSource = {
		kind: "folder-shell", state,
		async stop(options) {
			assert.equal(options?.mode, "graceful");
			calls.push("stop");
			return result;
		},
		async shutdown(options) {
			assert.equal(options?.requireStopped, true);
			calls.push("shutdown");
			return { stopped: true };
		},
		disconnect() { calls.push("disconnect"); },
	};
	return {
		source, calls, logs,
		ports: {
			async retireSlot() { calls.push("remove-shell-slot", "forget-broker-mapping"); },
			log(message: string) { logs.push(message); },
		},
		setResult(next: Partial<PtyStopResult>) { result = { ...result, ...next }; },
	};
}

test("confirmed Terminate retires a stopped shell and broker even when descendant completeness is unknown", async () => {
	const f = stopFixture();
	assert.deepEqual(await stopShellAndBroker(f.source, f.ports), { kind: "stopped" });
	assert.deepEqual(f.calls, ["stop", "shutdown", "remove-shell-slot", "forget-broker-mapping", "disconnect"]);
	assert.ok(f.logs.some(log => log.includes("tree=unknown") && log.includes("verified=false")));
	assert.ok(f.logs.some(log => log.includes("no tree-stop claim")));
});

test("observed descendants remain diagnostic evidence, not a false whole-tree success or a live-shell failure", async () => {
	const f = stopFixture();
	f.setResult({ tree: "remaining", remainingPids: [22], checkedPids: [22] });
	assert.deepEqual(await stopShellAndBroker(f.source, f.ports), { kind: "stopped" });
	assert.ok(f.calls.includes("shutdown"));
	assert.ok(f.calls.includes("remove-shell-slot"));
	assert.ok(f.logs.some(log => log.includes("tree=remaining") && log.includes("verified=false")));
});

test("a child still alive keeps recovery metadata and never requests broker shutdown", async () => {
	const f = stopFixture();
	f.setResult({ pidGone: false });
	assert.deepEqual(await stopShellAndBroker(f.source, f.ports), { kind: "unconfirmed", stage: "stop" });
	assert.deepEqual(f.calls, ["stop", "disconnect"]);
});

test("a failed authenticated stop keeps recovery metadata and disconnects without shutdown or force", async () => {
	const f = stopFixture();
	f.source.stop = async () => { f.calls.push("stop"); throw new Error("stop failed"); };
	assert.deepEqual(await stopShellAndBroker(f.source, f.ports), { kind: "unconfirmed", stage: "stop" });
	assert.deepEqual(f.calls, ["stop", "disconnect"]);
});

test("shutdown refusal after root absence keeps the slot and reports the shutdown stage", async () => {
	for (const rejection of ["throw", "not-stopped"]) {
		const f = stopFixture();
		f.source.shutdown = async () => {
			f.calls.push("shutdown");
			if (rejection === "throw") throw new Error("child-alive");
			return { stopped: false };
		};
		assert.deepEqual(await stopShellAndBroker(f.source, f.ports), { kind: "unconfirmed", stage: "shutdown" });
		assert.deepEqual(f.calls, ["stop", "shutdown", "disconnect"]);
	}
});

test("a shell already exited during its close decision only needs authenticated broker shutdown", async () => {
	const f = stopFixture("exited");
	assert.deepEqual(await stopShellAndBroker(f.source, f.ports), { kind: "stopped" });
	assert.deepEqual(f.calls, ["shutdown", "remove-shell-slot", "forget-broker-mapping", "disconnect"]);
});

test("missing child-state proof and other broker kinds cannot enter the shell stop path", async () => {
	const unknown = stopFixture(null);
	assert.deepEqual(await stopShellAndBroker(unknown.source, unknown.ports), { kind: "unconfirmed", stage: "stop" });
	assert.deepEqual(unknown.calls, ["disconnect"]);
	const managed = stopFixture();
	assert.deepEqual(await stopShellAndBroker({ ...managed.source, kind: "managed-omp" }, managed.ports), { kind: "unconfirmed", stage: "stop" });
	assert.deepEqual(managed.calls, ["disconnect"]);
});

test("a failed recovery-record write is distinguished from child or broker stop failure", async () => {
	const f = stopFixture();
	f.ports.retireSlot = async () => { f.calls.push("remove-shell-slot"); throw new Error("catalog write failed"); };
	assert.deepEqual(await stopShellAndBroker(f.source, f.ports), { kind: "unconfirmed", stage: "retirement" });
	assert.deepEqual(f.calls, ["stop", "shutdown", "remove-shell-slot", "disconnect"]);
});
