import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	ExternalLeaseObserver,
	LEASE_MUTEX_PREFIX,
	nativeLockDigest,
	ompSessionOwnersDir,
	parseLeaseReport,
	powershellLeaseProbe,
	sessionLeaseMutexName,
	xxh64,
	type LeaseProbe,
	type LeaseState,
} from "./omp-session-lease.ts";
import { windowsPowerShellEnvironment, windowsPowerShellExecutable } from "./windows-powershell.ts";

const HELPER = fileURLToPath(new URL("./session-lease-probe.ps1", import.meta.url));

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

describe("lease helper report", () => {
	const a = `${LEASE_MUTEX_PREFIX}${"a".repeat(32)}`;
	const b = `${LEASE_MUTEX_PREFIX}${"b".repeat(32)}`;

	it("accepts exactly one verdict per requested name followed by the count", () => {
		const report = parseLeaseReport(`!LEASE held ${a}\r\n!LEASE absent ${b}\r\n!DONE 2\r\n`, [a, b]);
		assert.deepEqual([...(report ?? [])], [[a, "held"], [b, "absent"]]);
	});

	it("leaves a name the helper could not open out of the answer", () => {
		const report = parseLeaseReport(`!LEASE error ${a}\n!LEASE held ${b}\n!DONE 2\n`, [a, b]);
		assert.deepEqual([...(report ?? [])], [[b, "held"]]);
	});

	it("trusts nothing from a malformed or partial report", () => {
		assert.equal(parseLeaseReport(`!LEASE held ${a}\n`, [a]), null, "no terminator");
		assert.equal(parseLeaseReport(`!LEASE held ${a}\n!DONE 2\n`, [a]), null, "wrong count");
		assert.equal(parseLeaseReport(`!DONE 1\n`, [a]), null, "no verdict");
		assert.equal(parseLeaseReport(`!LEASE held ${a}\n!LEASE held ${a}\n!DONE 2\n`, [a, b]), null, "repeated name");
		assert.equal(parseLeaseReport(`!LEASE held ${b}\n!DONE 1\n`, [a]), null, "unrequested name");
		assert.equal(parseLeaseReport(`!LEASE maybe ${a}\n!DONE 1\n`, [a]), null, "unknown verdict");
		assert.equal(parseLeaseReport(`!LEASE held ${a}\n!DONE 1\n!LEASE held ${a}\n`, [a]), null, "output after the end");
		assert.equal(parseLeaseReport(`!ERROR bad-name\n`, [a]), null);
	});
});

describe("powershellLeaseProbe with a stand-in helper", () => {
	const names = [`${LEASE_MUTEX_PREFIX}${"1".repeat(32)}`, `${LEASE_MUTEX_PREFIX}${"2".repeat(32)}`];
	async function stagedHelper() {
		const bytes = await readFile(HELPER);
		return { path: HELPER, sha256: createHash("sha256").update(bytes).digest("hex") };
	}

	const standIn = (script: string): ((helper: unknown) => ChildProcess) => () =>
		spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

	it("sends the names on stdin and reads the verdicts", async () => {
		const script = `let input = ""; process.stdin.on("data", c => input += c).on("end", () => {
			const names = input.split("\\n").filter(Boolean);
			names.forEach((name, at) => console.log("!LEASE " + (at === 0 ? "held" : "absent") + " " + name));
			console.log("!DONE " + names.length);
		});`;
		const probe = powershellLeaseProbe({ helper: stagedHelper, launch: standIn(script) });
		const answer = await probe(names);
		assert.deepEqual([...(answer ?? [])], [[names[0], "held"], [names[1], "absent"]]);
	});

	it("never starts the helper for a name that is not a lease mutex name", async () => {
		let launched = false;
		const probe = powershellLeaseProbe({ helper: stagedHelper, launch: () => { launched = true; throw new Error("must not start"); } });
		assert.equal(await probe(["Global\\something-else"]), null);
		assert.equal(launched, false);
	});

	it("fails the probe, with a log line, when the staged helper changed", async () => {
		const logs: string[] = [];
		const probe = powershellLeaseProbe({
			helper: async () => ({ path: HELPER, sha256: "0".repeat(64) }),
			launch: () => { throw new Error("must not start"); },
			log: line => logs.push(line),
		});
		assert.equal(await probe(names), null);
		assert.equal(logs.length, 1);
		assert.match(logs[0]!, /missing or changed/);
	});

	it("fails the probe when the helper exits with a malformed report, crashes or times out", async () => {
		const logs: string[] = [];
		const run = (script: string, timeoutMs?: number) =>
			powershellLeaseProbe({ helper: stagedHelper, launch: standIn(script), log: line => logs.push(line), ...(timeoutMs === undefined ? {} : { timeoutMs }) })(names);
		assert.equal(await run(`console.log("!ERROR bad-name"); process.exit(2);`), null);
		assert.equal(await run(`process.exit(1);`), null);
		// A helper that never answers: the probe bounds it with its own timeout (a real, short one by design).
		assert.equal(await run(`require("node:net").createServer().listen(0);`, 100), null);
		assert.equal(logs.length, 3);
		assert.match(logs[2]!, /timed out/);
	});
});

describe("ExternalLeaseObserver", () => {
	const OWNERS = "C:\\Users\\alice\\.omp\\run\\session-owners";
	const files = new Map([["one.jsonl", "id-one"], ["two.jsonl", "id-two"], ["three.jsonl", "id-three"]]);
	const nameOf = (id: string) => sessionLeaseMutexName(id, OWNERS)!;

	function observer(held: ReadonlySet<string>, overrides: { probe?: LeaseProbe; now?: () => number; ownersDir?: () => string | null; logs?: string[] } = {}) {
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
			log: line => overrides.logs?.push(line),
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
		const logs: string[] = [];
		const { instance, advance } = observer(new Set(), { probe: async () => null, logs });
		assert.equal(await instance.holds("one.jsonl"), null);
		advance(5_000);
		assert.equal(await instance.holds("two.jsonl"), null);
		assert.equal(logs.length, 1);
		assert.match(logs[0]!, /unavailable/);
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
		const logs: string[] = [];
		const { instance } = observer(new Set(), { probe: async () => { throw new Error("boom"); }, logs });
		assert.equal(await instance.holds("one.jsonl"), null);
		assert.match(logs.join("\n"), /boom/);
	});
});

/**
 * The real thing, without OMP: a child process holds a real Windows named mutex under the name
 * this module derives for a throwaway session id, the production helper sees it, and sees it gone
 * once that process exits. The id is random and the owners directory synthetic, so no session of
 * a real OMP can share the name.
 */
describe("session lease probe against a real named mutex", { skip: process.platform !== "win32" }, () => {
	async function holder(mutexName: string): Promise<ChildProcess> {
		const child = spawn(
			windowsPowerShellExecutable(),
			[
				"-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
				`$m = New-Object System.Threading.Mutex($false, '${mutexName}'); [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [void][Console]::In.ReadLine()`,
			],
			{ windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: windowsPowerShellEnvironment() },
		);
		await new Promise<void>((resolve, reject) => {
			child.stdout!.setEncoding("utf8");
			child.stdout!.on("data", chunk => { if (String(chunk).includes("ready")) resolve(); });
			child.once("error", reject);
			child.once("exit", () => reject(new Error("the mutex holder exited early")));
		});
		return child;
	}

	it("sees the mutex while its holder lives and its absence afterwards, without ever taking it", async () => {
		const owners = "C:\\omp-desk-lease-test\\run\\session-owners";
		const name = sessionLeaseMutexName(randomUUID(), owners)!;
		const other = sessionLeaseMutexName(randomUUID(), owners)!;
		const bytes = await readFile(HELPER);
		const staged = { path: HELPER, sha256: createHash("sha256").update(bytes).digest("hex") };
		const probe = powershellLeaseProbe({ helper: async () => staged });
		assert.deepEqual([...((await probe([name, other])) ?? [])], [[name, "absent"], [other, "absent"]]);
		const child = await holder(name);
		try {
			assert.deepEqual([...((await probe([name, other])) ?? [])], [[name, "held"], [other, "absent"]]);
			// Probing again changes nothing: a probe never becomes the owner or releases the holder's claim.
			assert.deepEqual([...((await probe([name])) ?? [])], [[name, "held"]]);
		} finally {
			const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
			child.stdin!.end("\n");
			await exited;
		}
		assert.deepEqual([...((await probe([name])) ?? [])], [[name, "absent"]]);
	});
});
