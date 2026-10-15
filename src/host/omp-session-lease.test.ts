import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
	LEASE_FAILURE_BACKOFF_MAX_MS,
	ExternalLeaseObserver,
	leaseFailureBackoffMs,
	LEASE_FAILURE_BACKOFF_MS,
	LEASE_MUTEX_PREFIX,
	nativeLeaseProbe,
	nativeLockDigest,
	ompSessionOwnersDir,
	sessionLeaseMutexName,
	xxh64,
	type LeaseProbe,
	type LeaseState,
} from "./omp-session-lease.ts";
import { recordingLogger, silentLogger, type LoggedLine } from "../shared/logger.ts";
import { loadWin32Native, type MutexState, type Win32Native } from "./win32-native.ts";
import { holdMutex, installedAddonAsset, releaseMutex } from "./win32-test-support.ts";

/**
 * Lock paths and the 32-digit names installed OMP 18.6.3's native `FileLock.tryAcquire` gave
 * them, read back from the Windows named-object directory while each lock was held. The paths
 * are synthetic; the lengths straddle xxHash64's 32-byte stripe and the last two carry
 * non-ASCII text and a drive other than the system one.
 */
const NATIVE_VECTORS: ReadonlyArray<readonly [string, string]> = [
	["", "dd4458733774f8b02ff557a2e70c6e06"],
	["a", "a053d1cfb2118107a3b15dd2e2b5ebdb"],
	["abc", "c0151025cd8a94a413c147b69cf27e28"],
	["abcd", "23712ca79ddfbb28a4cf0f03bee4cd51"],
	["abcdefgh", "bccd1decf9b76f7af832f166ccb298db"],
	["C:\\t.lock", "078ba2457b8b54c0dc9c55e5e2e72f5f"],
	["x".repeat(31), "9eddc9383420423d5882b91d99c235d8"],
	["x".repeat(32), "bbd9bd3ff3d067298a03938857db085e"],
	["x".repeat(33), "514e4cbd9f3dfaac4d244373446aab28"],
	["x".repeat(64), "4a839277ad4bb6d4d5159323aed3f915"],
	["x".repeat(65), "0ce28b576a43d65ca30322caf17f3e18"],
	["C:\\Users\\alice\\.omp\\run\\session-owners\\0198a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b.lock", "e09d80bd5eb51b492e3cefa628ecb4b2"],
	["C:\\Users\\alice\\.omp\\run\\session-owners\\Session_01-ab.lock", "d68484e84958cb7cd6d9f868914f6fb0"],
	["C:\\Users\\\u0418\u0432\u0430\u043d\\.omp\\run\\session-owners\\0198a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b.lock", "2fde72ecc19fbcd3f33fdba953ae5a02"],
	["D:\\cfg\\run\\session-owners\\0198a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b.lock", "27fe5e60be3c0a101c942c27da0de46c"],
];

const ID = "0198a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b";

describe("OMP session lease name", () => {
	it("hashes lock paths exactly as OMP's native lock did", () => {
		for (const [lockPath, digest] of NATIVE_VECTORS) assert.equal(nativeLockDigest(lockPath), digest, JSON.stringify(lockPath));
	});

	it("is xxHash64 of the reference algorithm", () => {
		// The published XXH64 test value for the empty input with seed 0.
		assert.equal(xxh64(new Uint8Array(), 0n), 0xef46db3751d8e999n);
	});

	it("derives the mutex from the session id and the owners directory", () => {
		const owners = ompSessionOwnersDir({ homeDir: "C:\\Users\\alice" });
		assert.equal(owners, "C:\\Users\\alice\\.omp\\run\\session-owners");
		assert.equal(sessionLeaseMutexName(ID, owners), `${LEASE_MUTEX_PREFIX}e09d80bd5eb51b492e3cefa628ecb4b2`);
		assert.equal(sessionLeaseMutexName("Session_01-ab", owners), `${LEASE_MUTEX_PREFIX}d68484e84958cb7cd6d9f868914f6fb0`);
		assert.equal(sessionLeaseMutexName(ID, "D:\\cfg\\run\\session-owners"), `${LEASE_MUTEX_PREFIX}27fe5e60be3c0a101c942c27da0de46c`);
		assert.equal(
			sessionLeaseMutexName(ID, ompSessionOwnersDir({ homeDir: "C:\\Users\\\u0418\u0432\u0430\u043d" })),
			`${LEASE_MUTEX_PREFIX}2fde72ecc19fbcd3f33fdba953ae5a02`,
		);
	});

	it("follows PI_CONFIG_DIR the way OMP joins it to the home directory", () => {
		assert.equal(ompSessionOwnersDir({ homeDir: "C:\\Users\\alice", configDirName: ".omp-work" }), "C:\\Users\\alice\\.omp-work\\run\\session-owners");
		assert.equal(ompSessionOwnersDir({ homeDir: "C:\\Users\\alice", configDirName: "" }), "C:\\Users\\alice\\.omp\\run\\session-owners");
	});

	it("is case-sensitive and does not fold separators, as OMP's is", () => {
		const owners = "C:\\Users\\alice\\.omp\\run\\session-owners";
		assert.notEqual(sessionLeaseMutexName("Abc", owners), sessionLeaseMutexName("abc", owners));
		assert.notEqual(sessionLeaseMutexName(ID, owners), sessionLeaseMutexName(ID, owners.toLowerCase()));
	});

	it("reports an id OMP would hash differently as unknown, never a guessed name", () => {
		const owners = "C:\\Users\\alice\\.omp\\run\\session-owners";
		for (const id of ["", "has space", "with.dot", "../escape", "x".repeat(129), "caf\u00e9"]) {
			assert.equal(sessionLeaseMutexName(id, owners), null, JSON.stringify(id));
		}
		assert.notEqual(sessionLeaseMutexName("x".repeat(128), owners), null);
	});
});

describe("nativeLeaseProbe", () => {
	const names = [`${LEASE_MUTEX_PREFIX}${"1".repeat(32)}`, `${LEASE_MUTEX_PREFIX}${"2".repeat(32)}`];
	const states: Readonly<Record<string, MutexState>> = { [names[0]!]: "held", [names[1]!]: "absent" };
	const stub = (answer: (name: string) => MutexState): Win32Native => ({ mutexState: answer });

	it("asks the native module once per distinct name and reads the verdicts", async () => {
		const asked: string[] = [];
		const probe = nativeLeaseProbe({ native: async () => stub(name => { asked.push(name); return states[name]!; }) });
		const answer = await probe([names[0]!, names[1]!, names[0]!]);
		assert.deepEqual([...(answer ?? [])], [[names[0], "held"], [names[1], "absent"]]);
		assert.deepEqual(asked, [names[0], names[1]]);
	});

	it("leaves a name that could not be opened out of the answer", async () => {
		const probe = nativeLeaseProbe({ native: async () => stub(name => (name === names[0] ? "error" : "held")) });
		assert.deepEqual([...((await probe(names)) ?? [])], [[names[1], "held"]]);
	});

	it("answers an empty batch without waiting for the native module", async () => {
		const probe = nativeLeaseProbe({ native: async () => { throw new Error("must not be asked"); } });
		assert.deepEqual([...((await probe([])) ?? [])], []);
	});

	it("never opens a name that is not a lease mutex name", async () => {
		let asked = false;
		const probe = nativeLeaseProbe({ native: async () => { asked = true; return stub(() => "held"); } });
		assert.equal(await probe(["Global\\something-else"]), null);
		assert.equal(asked, false);
	});

	it("fails the probe, with one log line, when the native module is unavailable", async () => {
		const logs: LoggedLine[] = [];
		const probe = nativeLeaseProbe({ native: async () => null, log: recordingLogger(logs) });
		assert.equal(await probe(names), null);
		assert.equal(logs.length, 1);
		assert.equal(logs[0]!.level, "warn");
		assert.match(logs[0]!.message, /native module is unavailable/);
	});

	it("fails the probe, with a log line, when a native call throws", async () => {
		const logs: LoggedLine[] = [];
		const probe = nativeLeaseProbe({ native: async () => stub(() => { throw new Error("boom"); }), log: recordingLogger(logs) });
		assert.equal(await probe(names), null);
		assert.match(logs.map(line => line.message).join("\n"), /boom/);
	});
});

describe("ExternalLeaseObserver", () => {
	const OWNERS = "C:\\Users\\alice\\.omp\\run\\session-owners";
	const files = new Map([["one.jsonl", "id-one"], ["two.jsonl", "id-two"], ["three.jsonl", "id-three"]]);
	const nameOf = (id: string) => sessionLeaseMutexName(id, OWNERS)!;

	function observer(held: ReadonlySet<string>, overrides: { probe?: LeaseProbe; now?: () => number; ownersDir?: () => string | null; logs?: LoggedLine[] } = {}) {
		const calls: string[][] = [];
		const probe: LeaseProbe = overrides.probe ?? (async requested => {
			calls.push([...requested]);
			return new Map<string, LeaseState>(requested.map(name => [name, held.has(name) ? "held" : "absent"]));
		});
		let clock = 1_000;
		const instance = new ExternalLeaseObserver({
			probe,
			ownersDir: overrides.ownersDir ?? (() => OWNERS),
			readSessionId: async file => files.get(file) ?? null,
			knownFiles: () => [...files.keys()],
			now: overrides.now ?? (() => clock),
			ttlMs: 2_000,
			log: overrides.logs === undefined ? silentLogger : recordingLogger(overrides.logs),
		});
		return { instance, calls, advance: (ms: number) => { clock += ms; } };
	}

	it("serves a burst of rows with one probe of every known session", async () => {
		const { instance, calls } = observer(new Set([nameOf("id-two")]));
		const answers = await Promise.all([instance.holds("one.jsonl"), instance.holds("two.jsonl"), instance.holds("three.jsonl")]);
		assert.deepEqual(answers, [false, true, false]);
		assert.equal(calls.length, 1);
		assert.deepEqual([...calls[0]!].sort(), ["id-one", "id-two", "id-three"].map(nameOf).sort());
	});

	it("reuses a fresh verdict, probes again when it is stale, and always probes for a fresh request", async () => {
		const { instance, calls, advance } = observer(new Set([nameOf("id-one")]));
		assert.equal(await instance.holds("one.jsonl"), true);
		assert.equal(await instance.holds("one.jsonl"), true);
		assert.equal(calls.length, 1);
		advance(2_500);
		assert.equal(await instance.holds("one.jsonl"), true);
		assert.equal(calls.length, 2);
		assert.equal(await instance.holds("one.jsonl", { fresh: true }), true);
		assert.equal(calls.length, 3);
	});

	it("answers unknown, never absent, when the probe fails, and logs it once", async () => {
		const logs: LoggedLine[] = [];
		const { instance, advance } = observer(new Set(), { probe: async () => null, logs });
		assert.equal(await instance.holds("one.jsonl"), null);
		advance(5_000);
		assert.equal(await instance.holds("two.jsonl"), null);
		assert.equal(logs.length, 1);
		assert.equal(logs[0]!.level, "warn");
		assert.match(logs[0]!.message, /unavailable/);
	});

	it("does not start another probe for each observation while the last one failed, and tries again after the backoff", async () => {
		let probes = 0;
		let clock = 1_000;
		const instance = new ExternalLeaseObserver({
			// A busy machine: the probe takes longer than a verdict stays fresh, then reports nothing.
			probe: async () => { probes += 1; clock += 5_000; return null; },
			ownersDir: () => OWNERS,
			readSessionId: async file => files.get(file) ?? null,
			knownFiles: () => [...files.keys()],
			now: () => clock,
			ttlMs: 2_000,
		});
		const burst = await Promise.all([instance.holds("one.jsonl"), instance.holds("two.jsonl"), instance.holds("three.jsonl")]);
		assert.deepEqual(burst, [null, null, null]);
		assert.equal(probes, 1, "one failed pass answers the whole burst; each row did not start its own three attempts");
		clock += 5_000;
		assert.equal(await instance.holds("one.jsonl"), null);
		assert.equal(probes, 1, "inside the backoff the failure is answered from memory");
		clock += LEASE_FAILURE_BACKOFF_MS;
		assert.equal(await instance.holds("one.jsonl"), null);
		assert.equal(probes, 2, "after the backoff the probe is tried again");
		assert.equal(await instance.holds("one.jsonl", { fresh: true }), null);
		assert.equal(probes, 3, "a click that must not act on an old verdict still probes");
	});

	it("doubles the hold with each failed probe in a row, up to the cap, and starts over after one that reports", async () => {
		assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(leaseFailureBackoffMs), [15_000, 30_000, 60_000, 120_000, 240_000, LEASE_FAILURE_BACKOFF_MAX_MS, LEASE_FAILURE_BACKOFF_MAX_MS]);
		let probes = 0;
		let clock = 1_000;
		let timesOut = true;
		const instance = new ExternalLeaseObserver({
			probe: async requested => {
				probes += 1;
				return timesOut ? null : new Map<string, LeaseState>(requested.map(name => [name, "absent"]));
			},
			ownersDir: () => OWNERS,
			readSessionId: async file => files.get(file) ?? null,
			knownFiles: () => [...files.keys()],
			now: () => clock,
			ttlMs: 2_000,
		});
		// Each attempt is made the moment the previous hold lapses; the next hold must be twice as long.
		let hold = LEASE_FAILURE_BACKOFF_MS;
		for (let failure = 1; failure <= 4; failure += 1) {
			assert.equal(await instance.holds("one.jsonl"), null);
			assert.equal(probes, failure);
			clock += hold - 1;
			assert.equal(await instance.holds("one.jsonl"), null);
			assert.equal(probes, failure, `inside the ${hold} ms hold after failure ${failure} nothing is probed`);
			clock += 1;
			hold *= 2;
		}
		timesOut = false;
		assert.equal(await instance.holds("one.jsonl"), false, "the probe that finally reports is believed");
		timesOut = true;
		clock += 2_500;
		assert.equal(await instance.holds("one.jsonl"), null);
		clock += LEASE_FAILURE_BACKOFF_MS - 1;
		const before = probes;
		assert.equal(await instance.holds("one.jsonl"), null);
		assert.equal(probes, before, "after a success the next failure holds the base backoff again");
		clock += 1;
		await instance.holds("one.jsonl");
		assert.equal(probes, before + 1);
	});

	it("answers unknown when it cannot name the lease: no owners directory, no header, an unplain id", async () => {
		const withoutDir = observer(new Set(), { ownersDir: () => null });
		assert.equal(await withoutDir.instance.holds("one.jsonl"), null);
		assert.equal(withoutDir.calls.length, 0);
		const { instance, calls } = observer(new Set());
		assert.equal(await instance.holds("missing.jsonl"), null);
		files.set("odd.jsonl", "has space");
		try {
			assert.equal(await instance.holds("odd.jsonl"), null);
		} finally {
			files.delete("odd.jsonl");
		}
		assert.equal(calls.length, 0);
	});

	it("treats a probe that throws as a failed probe", async () => {
		const logs: LoggedLine[] = [];
		const { instance } = observer(new Set(), { probe: async () => { throw new Error("boom"); }, logs });
		assert.equal(await instance.holds("one.jsonl"), null);
		assert.match(logs.map(line => line.message).join("\n"), /boom/);
	});
});

/**
 * The real thing, without OMP: a child process holds a real Windows named mutex under the name
 * this module derives for a throwaway session id, the production probe (the real native module)
 * sees it, and sees it gone once that process exits. The id is random and the owners directory
 * synthetic, so no session of a real OMP can share the name.
 */
describe("session lease probe against a real named mutex", { skip: process.platform !== "win32" }, () => {
	it("sees the mutex while its holder lives and its absence afterwards, without ever taking it", async () => {
		const owners = "C:\\omp-desk-lease-test\\run\\session-owners";
		const name = sessionLeaseMutexName(randomUUID(), owners)!;
		const other = sessionLeaseMutexName(randomUUID(), owners)!;
		const native = await loadWin32Native(await installedAddonAsset());
		const probe = nativeLeaseProbe({ native: async () => native });
		assert.deepEqual([...((await probe([name, other])) ?? [])], [[name, "absent"], [other, "absent"]]);
		const child = await holdMutex(name);
		try {
			assert.deepEqual([...((await probe([name, other])) ?? [])], [[name, "held"], [other, "absent"]]);
			// Probing again changes nothing: a probe never becomes the owner or releases the holder's claim.
			assert.deepEqual([...((await probe([name])) ?? [])], [[name, "held"]]);
		} finally {
			await releaseMutex(child);
		}
		assert.deepEqual([...((await probe([name])) ?? [])], [[name, "absent"]]);
	});
});
