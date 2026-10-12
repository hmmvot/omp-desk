/**
 * Whether a session claim's holder is a live window, for what Sessions shows and where a click goes: answered from the
 * window registry's records, with no process spawned, so a machine on which PowerShell takes seconds still shows a
 * row another window runs as such (the start-time reading is only the fallback for a holder the registry does not know).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { holderSeemsAlive } from "./holder-liveness.ts";
import { setProcessProbeObserver } from "./session-claim.ts";
import type { ObservedClaim, ProcessProbe } from "./session-claim.ts";
import { WINDOW_REGISTRY_DIRECTORY, WindowRegistry } from "./window-registry.ts";

const LEASE = 60_000;
const BASE = Date.parse("2026-10-11T10:00:00.000Z");

function claim(holderId: string | null, pid: number | null, overrides: Partial<ObservedClaim> = {}): ObservedClaim {
	return {
		claimPath: "C:/claims/a.claim", normalizedIdentity: "a", verifiable: true, ownerGeneration: "gen", holderId, identity: "a",
		pid, createdAt: "2026-10-11T09:00:00.000Z", processCreationTime: null, ...overrides,
	};
}

describe("holder liveness from the window registry", () => {
	let storage: string;
	let clock = BASE;
	const alive = new Set<number>();
	const registries: WindowRegistry[] = [];
	const probes: ProcessProbe[] = [];

	before(() => {
		storage = fs.mkdtempSync(path.join(os.tmpdir(), "omp-holder-liveness-"));
		setProcessProbeObserver(probe => probes.push(probe));
	});
	afterEach(() => {
		for (const registry of registries.splice(0)) registry.dispose();
		fs.rmSync(path.join(storage, WINDOW_REGISTRY_DIRECTORY), { recursive: true, force: true });
		clock = BASE;
		alive.clear();
		probes.length = 0;
	});
	after(() => {
		setProcessProbeObserver(null);
		fs.rmSync(storage, { recursive: true, force: true });
	});

	async function windows(): Promise<{ readonly reader: WindowRegistry }> {
		const open = (holderId: string, pid: number): WindowRegistry => {
			alive.add(pid);
			const registry = new WindowRegistry({
				storageDir: storage, holderId, pid, startedAt: "2026-10-11T09:00:00.000Z", now: () => clock, leaseMs: LEASE,
				pidAlive: candidate => alive.has(candidate), writeDebounceMs: 5, heartbeatMs: 1_000_000, watchDebounceMs: 20,
			});
			registries.push(registry);
			registry.setSnapshot({ windowUri: null, label: holderId, folders: [], liveCwds: [], rows: {}, focusedAt: null, stale: false });
			return registry;
		};
		const owner = open("owner", 4101);
		const reader = open("reader", 4102);
		for (const registry of [owner, reader]) await registry.flush();
		for (const registry of [owner, reader]) await registry.refresh();
		return { reader };
	}

	it("calls a holder a live window when its record says so, without starting any process", async () => {
		const { reader } = await windows();
		let fellBack = 0;
		const verdict = await holderSeemsAlive(claim("owner", 4101), reader, async () => { fellBack += 1; return false; });
		assert.equal(verdict, true);
		assert.equal(fellBack, 0, "no start-time reading was asked for");
		assert.deepEqual(probes, []);
	});

	it("answers while the start-time reading has not finished and would time out, so a click does not wait for it", async () => {
		const { reader } = await windows();
		// A reading that never completes: the registry's answer must not depend on it.
		const neverFinishes = (): Promise<boolean> => Promise.withResolvers<boolean>().promise;
		assert.equal(await holderSeemsAlive(claim("owner", 4101), reader, neverFinishes), true);
	});

	it("asks the start-time reading about a holder the registry does not know, or whose process is not the one the claim names", async () => {
		const { reader } = await windows();
		const asked: string[] = [];
		const fallback = async (observed: ObservedClaim): Promise<boolean> => { asked.push(observed.holderId ?? "none"); return true; };
		assert.equal(await holderSeemsAlive(claim("unknown", 4999), reader, fallback), true);
		assert.equal(await holderSeemsAlive(claim("owner", 7777), reader, fallback), true, "another process filed under the holder id of a live window");
		assert.equal(await holderSeemsAlive(claim("owner", 4101), undefined, fallback), true, "no registry yet");
		assert.deepEqual(asked, ["unknown", "owner", "owner"]);
	});

	it("does not call a holder alive once its window is gone or its lease has lapsed", async () => {
		const { reader } = await windows();
		const none = async (): Promise<boolean> => false;
		alive.delete(4101);
		assert.equal(await holderSeemsAlive(claim("owner", 4101), reader, none), false);
		alive.add(4101);
		clock += LEASE + 1;
		assert.equal(await holderSeemsAlive(claim("owner", 4101), reader, none), false);
	});

	it("never calls an unverifiable claim or one without a holder or a process a live window", async () => {
		const { reader } = await windows();
		const never = async (): Promise<boolean> => { assert.fail("not asked"); };
		assert.equal(await holderSeemsAlive(claim("owner", 4101, { verifiable: false }), reader, never), false);
		assert.equal(await holderSeemsAlive(claim(null, 4101), reader, never), false);
		assert.equal(await holderSeemsAlive(claim("owner", null), reader, never), false);
	});
});
