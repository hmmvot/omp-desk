import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	UNMANAGED_MIN_AGE_MS,
	createUnmanagedBrokerScanner,
	parseBrokerCommandLine,
	processKey,
	sameStorageDirectory,
	splitWindowsCommandLine,
	verifyUnmanagedBroker,
} from "./unmanaged-brokers.ts";
import type { UnmanagedScanPorts } from "./unmanaged-brokers.ts";
import { buildBrokerArguments } from "./pty-client.ts";
import { createBrokerProcessReader, deriveUnmanagedRow, planKillAll, selectOrphanedAndIdle } from "./broker-processes.ts";
import type { BrokerProcessReadPorts } from "./broker-processes.ts";
import { processState, processFolder, processTitle } from "../views/session-processes.ts";

const STORAGE = "C:\\Users\\someone\\AppData\\Roaming\\Code\\User\\globalStorage\\publisher.extension";
const FILETIME_UNIX_EPOCH = 116444736000000000n;
const NOW = Date.parse("2026-10-21T16:00:00.000Z");

/** The FILETIME of an instant `ageMs` before `NOW`. */
function creationAt(ageMs: number): string {
	return String(FILETIME_UNIX_EPOCH + BigInt(NOW - ageMs) * 10_000n);
}

/** One argument as `CreateProcess` callers must quote it for the C runtime's parser. */
function quote(argument: string): string {
	if (argument !== "" && !/[\s"]/.test(argument)) return argument;
	return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

function line(...argv: string[]): string {
	return argv.map(quote).join(" ");
}

describe("splitWindowsCommandLine", () => {
	it("splits on whitespace, honours quotes and keeps backslashes literal outside a quote", () => {
		assert.deepEqual(splitWindowsCommandLine('a  b\tc'), ["a", "b", "c"]);
		assert.deepEqual(splitWindowsCommandLine('"C:\\Program Files\\x.exe" --a "b c"'), ["C:\\Program Files\\x.exe", "--a", "b c"]);
		assert.deepEqual(splitWindowsCommandLine("C:\\dir\\file.js"), ["C:\\dir\\file.js"]);
		assert.deepEqual(splitWindowsCommandLine('""'), [""]);
	});

	it("reads backslashes before a quote as the C runtime does", () => {
		assert.deepEqual(splitWindowsCommandLine('a\\"b'), ['a"b']);
		assert.deepEqual(splitWindowsCommandLine('"a\\\\" b'), ["a\\", "b"]);
		assert.deepEqual(splitWindowsCommandLine('"a\\\\\\"b"'), ['a\\"b']);
	});

	it("round-trips what the quoting rule produces", () => {
		const samples = ["plain", "with space", 'quote"inside', "trailing\\", "C:\\a b\\c d\\", "", "--env=NAME=VALUE x", "ünï cødé"];
		for (const sample of samples) assert.deepEqual(splitWindowsCommandLine(line("x", sample, "y")), ["x", sample, "y"], JSON.stringify(sample));
	});
});

/** The command line a real launch produces, composed by the client's own argument builder. */
function brokerLine(overrides: { slot?: string; storageDir?: string; title?: string | null; args?: string[]; cwd?: string; kind?: "managed-rpc" | "folder-shell" } = {}): string {
	const spec = {
		slot: overrides.slot ?? "tab:5f0a3c1e-0000-4000-8000-000000000001",
		kind: overrides.kind ?? "managed-rpc",
		file: "C:\\Users\\someone\\bin\\omp.exe",
		args: overrides.args ?? ["--mode", "rpc-ui", "--session", "C:\\Users\\someone\\.omp\\agent\\sessions\\work dir\\2026-10-20_abc.jsonl"],
		cwd: overrides.cwd ?? "D:\\work space\\project",
		title: overrides.title === undefined ? "My session" : overrides.title,
		env: { OMP_FLAG: "1 2" },
	};
	const runtime = {
		tree: { digest: "a".repeat(64) },
		native: { path: "C:\\store\\native\\koffi.node", sha256: "b".repeat(64) },
		ownerHelper: { path: "C:\\store\\pty-owner-watch.ps1", sha256: "c".repeat(64) },
	};
	const argv = buildBrokerArguments(spec as never, runtime as never, overrides.storageDir ?? STORAGE, "C:\\logs\\broker.log");
	return line("C:\\Users\\someone\\.bun\\bin\\bun.exe", "C:\\store\\runtime\\pty-tree\\hash\\pty-broker.js", ...argv);
}

describe("parseBrokerCommandLine", () => {
	it("reads the facts out of the line the client's own argument builder composes", () => {
		const facts = parseBrokerCommandLine(brokerLine());
		assert.deepEqual(facts, {
			slot: "tab:5f0a3c1e-0000-4000-8000-000000000001",
			kind: "managed-rpc",
			storageDir: STORAGE,
			cwd: "D:\\work space\\project",
			title: "My session",
			sessionFile: "C:\\Users\\someone\\.omp\\agent\\sessions\\work dir\\2026-10-20_abc.jsonl",
			treeDigest: "a".repeat(64),
		});
	});

	it("reads a folder shell that carries no session", () => {
		const facts = parseBrokerCommandLine(brokerLine({ slot: "shell:folder", kind: "folder-shell", args: [], title: null }));
		assert.equal(facts?.kind, "folder-shell");
		assert.equal(facts?.sessionFile, null);
		assert.equal(facts?.title, null);
	});

	it("refuses anything that is not a broker's line", () => {
		assert.equal(parseBrokerCommandLine('"C:\\Program Files\\Code\\Code.exe" --type=renderer'), null);
		assert.equal(parseBrokerCommandLine("node server.js --slot tab:x --kind managed-rpc --storage-dir C:\\s --cwd C:\\w"), null, "no entry script");
		assert.equal(parseBrokerCommandLine(line("bun.exe", "C:\\x\\pty-broker.js", "--slot", "tab:x")), null, "no kind, storage or folder");
		assert.equal(parseBrokerCommandLine(line("bun.exe", "C:\\x\\pty-broker.js", "--slot", "bad slot!", "--kind", "managed-rpc", "--storage-dir", "C:\\s", "--cwd", "C:\\w")), null, "a slot the broker itself would refuse");
		assert.equal(parseBrokerCommandLine(line("bun.exe", "C:\\x\\pty-broker.js", "--slot", "tab:x", "--kind", "managed-rpc", "--storage-dir", "relative", "--cwd", "C:\\w")), null);
		assert.equal(parseBrokerCommandLine(line("bun.exe", "C:\\x\\pty-broker.js", "stray", "--slot", "tab:x")), null);
		assert.equal(parseBrokerCommandLine(line("bun.exe", "C:\\x\\pty-broker.js", "--slot")), null, "a flag with no value");
	});

	it("compares storage directories without case or a trailing separator", () => {
		assert.equal(sameStorageDirectory("C:\\A\\b\\", "c:\\a\\B"), true);
		assert.equal(sameStorageDirectory("C:\\a\\b", "C:\\a\\c"), false);
	});
});

interface FakeProcess {
	readonly pid: number;
	readonly exe: string;
	readonly commandLine: string | null;
	readonly creation: string;
}

function ports(processes: FakeProcess[], calls: { commandLines: number[] } = { commandLines: [] }): UnmanagedScanPorts & { calls: typeof calls; processes: FakeProcess[] } {
	return {
		calls,
		processes,
		processTable: () => ({ kind: "found", entries: processes.map(process => ({ pid: process.pid, parentPid: 1, exe: process.exe })) }),
		processCommandLine: pid => {
			calls.commandLines.push(pid);
			const found = processes.find(process => process.pid === pid);
			if (found === undefined) return { kind: "gone" };
			return found.commandLine === null ? { kind: "unknown", detail: "denied" } : { kind: "found", commandLine: found.commandLine };
		},
		creationTime: pid => {
			const found = processes.find(process => process.pid === pid);
			return found === undefined ? { kind: "gone" } : { kind: "found", creationTime: found.creation };
		},
		now: () => NOW,
	};
}

describe("the unmanaged broker scanner", () => {
	const broker = (pid: number, overrides: Partial<FakeProcess> = {}): FakeProcess => ({ pid, exe: "bun.exe", commandLine: brokerLine({ slot: `tab:t${pid}` }), creation: creationAt(10 * 60_000), ...overrides });

	it("lists the brokers of this storage that no record names, and only those", () => {
		const recorded = broker(100);
		const unrecorded = broker(200);
		const foreign = broker(300, { commandLine: brokerLine({ slot: "tab:other", storageDir: "C:\\Users\\someone\\AppData\\Roaming\\Code - Insiders\\User\\globalStorage\\publisher.extension" }) });
		const stranger = broker(400, { exe: "Code.exe", commandLine: '"C:\\Program Files\\Code\\Code.exe" --type=renderer' });
		const denied = broker(500, { commandLine: null });
		const scanner = createUnmanagedBrokerScanner(ports([recorded, unrecorded, foreign, stranger, denied]));
		const found = scanner.scan(STORAGE, new Set([processKey(recorded.pid, recorded.creation)]));
		assert.deepEqual(found?.map(entry => entry.pid), [200]);
		assert.equal(found?.[0]?.facts.slot, "tab:t200");
		assert.equal(found?.[0]?.startedAt, new Date(NOW - 10 * 60_000).toISOString());
	});

	it("does not list a broker that may still be publishing its record", () => {
		const young = broker(100, { creation: creationAt(UNMANAGED_MIN_AGE_MS - 1_000) });
		const settled = broker(200, { creation: creationAt(UNMANAGED_MIN_AGE_MS + 1_000) });
		const found = createUnmanagedBrokerScanner(ports([young, settled])).scan(STORAGE, new Set());
		assert.deepEqual(found?.map(entry => entry.pid), [200]);
	});

	it("tells a recycled id from the recorded process by its creation time", () => {
		const old = broker(100);
		const recycled = { ...broker(100), creation: creationAt(60_000) };
		const found = createUnmanagedBrokerScanner(ports([recycled])).scan(STORAGE, new Set([processKey(old.pid, old.creation)]));
		assert.deepEqual(found?.map(entry => entry.pid), [100], "the record names another process lifetime of that id");
	});

	it("reads each process's command line once, and again for a process that took over the id", () => {
		const calls = { commandLines: [] as number[] };
		const fake = ports([broker(100), broker(200, { commandLine: "notepad.exe" })], calls);
		const scanner = createUnmanagedBrokerScanner(fake);
		scanner.scan(STORAGE, new Set());
		scanner.scan(STORAGE, new Set());
		assert.deepEqual(calls.commandLines.sort(), [100, 200], "a second scan reads nothing again");
		fake.processes[0] = broker(100, { creation: creationAt(11 * 60_000), commandLine: brokerLine({ slot: "tab:next" }) });
		const found = scanner.scan(STORAGE, new Set());
		assert.equal(found?.[0]?.facts.slot, "tab:next");
		assert.equal(calls.commandLines.filter(pid => pid === 100).length, 2);
	});
	it("does not remember a command line the kernel refused to give, and lists the broker once it can be read", () => {
		const calls = { commandLines: [] as number[] };
		const fake = ports([broker(100, { commandLine: null })], calls);
		const scanner = createUnmanagedBrokerScanner(fake);
		assert.deepEqual(scanner.scan(STORAGE, new Set()), [], "unreadable: not listed");
		fake.processes[0] = broker(100);
		assert.deepEqual(scanner.scan(STORAGE, new Set())?.map(entry => entry.pid), [100], "read again, not cached as 'not a broker'");
		assert.equal(calls.commandLines.length, 2);
	});

	it("answers null, never an empty list, when the process table cannot be read", () => {
		const fake = ports([]);
		const scanner = createUnmanagedBrokerScanner({ ...fake, processTable: () => ({ kind: "unknown", detail: "snapshot failed" }) });
		assert.equal(scanner.scan(STORAGE, new Set()), null);
	});
});

describe("verifyUnmanagedBroker", () => {
	const facts = parseBrokerCommandLine(brokerLine())!;
	const process: FakeProcess = { pid: 100, exe: "bun.exe", commandLine: brokerLine(), creation: creationAt(60_000) };
	const expected = { pid: 100, creationTime: process.creation, facts };

	it("accepts the same process lifetime with the same command line", () => {
		assert.equal(verifyUnmanagedBroker(ports([process]), expected), true);
	});

	it("refuses a gone process, a later occupant of the id and a changed command line", () => {
		assert.equal(verifyUnmanagedBroker(ports([]), expected), false);
		assert.equal(verifyUnmanagedBroker(ports([{ ...process, creation: creationAt(1_000) }]), expected), false);
		assert.equal(verifyUnmanagedBroker(ports([{ ...process, commandLine: brokerLine({ slot: "tab:another" }) }]), expected), false);
		assert.equal(verifyUnmanagedBroker(ports([{ ...process, commandLine: "notepad.exe" }]), expected), false);
		assert.equal(verifyUnmanagedBroker(ports([{ ...process, commandLine: null }]), expected), false);
	});
});

describe("unmanaged rows", () => {
	const unmanaged = {
		pid: 4242,
		creationTime: creationAt(10 * 60_000),
		startedAt: new Date(NOW - 10 * 60_000).toISOString(),
		facts: parseBrokerCommandLine(brokerLine())!,
	};

	it("derive a row that names the process, cannot be stopped through a broker and is its own state", () => {
		const row = deriveUnmanagedRow(unmanaged, NOW);
		assert.equal(row.source, "unmanaged");
		assert.equal(row.status, "unmanaged");
		assert.equal(row.kind, "session");
		assert.equal(row.brokerPid, 4242);
		assert.equal(row.brokerCreationTime, unmanaged.creationTime);
		assert.equal(row.uptimeMs, 10 * 60_000);
		assert.equal(row.stop.available, false);
		assert.equal(row.unmanaged?.slot, "tab:5f0a3c1e-0000-4000-8000-000000000001");
		assert.equal(processState(row), "unmanaged");
		assert.equal(processTitle(row), "My session");
		assert.equal(processFolder(row), "D:\\work space\\project");
		assert.equal(JSON.stringify(row).includes("token"), false, "a view model never carries a capability");
	});

	it("falls back to the session file's name for a title, and to nothing for a terminal", () => {
		const untitled = { ...unmanaged, facts: parseBrokerCommandLine(brokerLine({ title: null }))! };
		assert.equal(processTitle(deriveUnmanagedRow(untitled, NOW)), "2026-10-20_abc.jsonl");
		const shell = { ...unmanaged, facts: parseBrokerCommandLine(brokerLine({ slot: "shell:x", kind: "folder-shell", args: [], title: null }))! };
		const row = deriveUnmanagedRow(shell, NOW);
		assert.equal(row.kind, "terminal");
		assert.equal(processTitle(row), "Terminal process");
	});

	it("never join Kill All or Stop Orphaned and Idle, and are not reported as another version's", () => {
		const row = deriveUnmanagedRow(unmanaged, NOW);
		const plan = planKillAll([row]);
		assert.deepEqual([plan.here, plan.otherWindows, plan.notRun, plan.blocked], [[], [], [], []]);
		assert.deepEqual(selectOrphanedAndIdle([row]), []);
	});
});

describe("the reader with an unmanaged scan", () => {
	const record = {
		version: 1,
		service: "omp-desk-pty",
		protocolVersion: 0,
		runtimeVersion: 0,
		treeDigest: "b".repeat(64),
		brokerId: "pty-00000000-0000-4000-8000-000000000001",
		generation: "gen-00000000-0000-4000-8000-000000000001",
		slot: "tab:recorded",
		kind: "managed-rpc" as const,
		port: 50000,
		brokerPid: 100,
		brokerCreationTime: creationAt(60 * 60_000),
		startedAt: new Date(NOW - 60 * 60_000).toISOString(),
		cols: 80,
		rows: 24,
		title: null,
	};

	function readerWith(listUnmanaged: BrokerProcessReadPorts["listUnmanaged"]) {
		let askedWith: ReadonlySet<string> | null = null;
		const reader = createBrokerProcessReader({
			listRecords: async () => ({ records: [{ source: "current", record: record as never }], unreadable: 0 }),
			catalog: async () => ({ ready: false, complete: false, session: () => null, terminal: () => null }) as never,
			isAlive: () => true,
			readCreationTime: async () => ({ kind: "found", creationTime: record.brokerCreationTime }),
			readChild: async () => "running",
			buildDigest: async () => null,
			now: () => NOW,
			...(listUnmanaged === undefined ? {} : { listUnmanaged: async known => { askedWith = known; return listUnmanaged(known); } }),
		});
		return { reader, asked: () => askedWith };
	}

	it("lists an unmanaged broker beside the recorded one, first, and names the recorded process to the scan", async () => {
		const unmanaged = { pid: 4242, creationTime: creationAt(10 * 60_000), startedAt: new Date(NOW - 10 * 60_000).toISOString(), facts: parseBrokerCommandLine(brokerLine())! };
		const { reader, asked } = readerWith(async () => [unmanaged]);
		const snapshot = await reader.read();
		assert.deepEqual(snapshot.rows.map(row => row.source), ["unmanaged", "current"]);
		assert.deepEqual([...(asked() ?? [])], [processKey(record.brokerPid, record.brokerCreationTime)]);
	});

	it("lists records only when the scan is absent or could not read the process table", async () => {
		assert.deepEqual((await readerWith(undefined).reader.read()).rows.map(row => row.source), ["current"]);
		assert.deepEqual((await readerWith(async () => null).reader.read()).rows.map(row => row.source), ["current"]);
	});
});
