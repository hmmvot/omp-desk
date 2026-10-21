/**
 * Brokers of this storage that no record names, found by their command line
 * ([ADR-0081](../../docs/decisions/0081-keep-a-private-backup-of-the-catalog-and-broker-records-outside-vs-codes-storage-and-restore-it-over-a-missing-catalog.md)).
 *
 * A broker's record in `pty/` holds the token that authenticates to it and is written once. When the record is lost (a wiped
 * storage folder, a file removed by hand) the broker keeps running, and the Processes list, which is built from records, cannot
 * show it. What the process table still holds is its command line, which `buildBrokerArguments` composes with nothing secret on
 * it: the slot, the kind, the storage directory it belongs to, the working folder and the arguments of the OMP child.
 *
 * This module only recognises and describes. It authenticates to nothing and kills nothing: an unmanaged row offers Kill, which
 * proves the creation time again before it ends the tree (`session-kill.ts`), and this module's {@link verifyUnmanagedBroker} proves
 * the command line again too.
 *
 * No `vscode` import and no I/O of its own: the process table, the command lines and the creation times arrive through ports.
 */

import path from "node:path";
import { filetimeToEpochMs, isPtyKind, isPtySlot } from "./pty-protocol.ts";
import type { PtyKind } from "./pty-protocol.ts";
import type { ProcessCommandLineReading, ProcessTableReading, Win32Native } from "./win32-native.ts";
import type { PtyIdentityReading } from "./pty-identity.ts";

/** What a broker's command line says about it. */
export interface UnmanagedBrokerFacts {
	readonly slot: string;
	readonly kind: PtyKind;
	readonly storageDir: string;
	readonly cwd: string;
	readonly title: string | null;
	/** The OMP session file the child serves (`--session <file>` among the child's arguments), or `null`. */
	readonly sessionFile: string | null;
	/** The digest of the staged runtime tree the broker runs from, or `null` when the line carries none. */
	readonly treeDigest: string | null;
}

/** One broker process no record names. */
export interface UnmanagedBroker {
	readonly pid: number;
	/** FILETIME decimal string, read from the kernel. */
	readonly creationTime: string;
	readonly startedAt: string;
	readonly facts: UnmanagedBrokerFacts;
}

/**
 * Split a Windows command line into arguments by the rules of `CommandLineToArgvW` (and the C runtime): whitespace separates
 * arguments outside quotes, `"` toggles quoting, a run of backslashes is literal unless a `"` follows it, in which case each pair
 * is one backslash and an odd one makes the quote literal.
 */
export function splitWindowsCommandLine(line: string): string[] {
	const args: string[] = [];
	let index = 0;
	const length = line.length;
	for (;;) {
		while (index < length && (line[index] === " " || line[index] === "\t")) index += 1;
		if (index >= length) break;
		let argument = "";
		let quoted = false;
		while (index < length) {
			const char = line[index];
			if (char === "\\") {
				let slashes = 0;
				while (index < length && line[index] === "\\") {
					slashes += 1;
					index += 1;
				}
				if (line[index] === '"') {
					argument += "\\".repeat(Math.floor(slashes / 2));
					if (slashes % 2 === 1) {
						argument += '"';
						index += 1;
					}
				} else {
					argument += "\\".repeat(slashes);
				}
				continue;
			}
			if (char === '"') {
				if (quoted && line[index + 1] === '"') {
					argument += '"';
					index += 2;
					continue;
				}
				quoted = !quoted;
				index += 1;
				continue;
			}
			if (!quoted && (char === " " || char === "\t")) break;
			argument += char;
			index += 1;
		}
		args.push(argument);
	}
	return args;
}

/** The file name of the broker's entry script, which is what makes a command line a broker's. */
const BROKER_ENTRY = "pty-broker.js";

/**
 * What a command line says about the broker it belongs to, or `null` when it is not a broker's: no argument whose file name is the
 * entry script, or one of the flags every broker is started with missing or unusable. Pure.
 */
export function parseBrokerCommandLine(commandLine: string): UnmanagedBrokerFacts | null {
	if (!commandLine.toLowerCase().includes(BROKER_ENTRY)) return null;
	const argv = splitWindowsCommandLine(commandLine);
	const entry = argv.findIndex(argument => path.win32.basename(argument).toLowerCase() === BROKER_ENTRY);
	if (entry < 0) return null;
	const values = new Map<string, string>();
	const childArguments: string[] = [];
	for (let index = entry + 1; index < argv.length; index += 1) {
		const token = argv[index]!;
		if (!token.startsWith("--")) return null;
		const value = argv[index + 1];
		if (value === undefined) return null;
		index += 1;
		if (token === "--arg") childArguments.push(value);
		else if (token !== "--env") values.set(token.slice(2), value);
	}
	const slot = values.get("slot");
	const kind = values.get("kind");
	const storageDir = values.get("storage-dir");
	const cwd = values.get("cwd");
	if (!isPtySlot(slot) || !isPtyKind(kind) || storageDir === undefined || !path.win32.isAbsolute(storageDir) || cwd === undefined) return null;
	const sessionAt = childArguments.indexOf("--session");
	return {
		slot,
		kind,
		storageDir,
		cwd,
		title: values.get("title") ?? null,
		sessionFile: sessionAt >= 0 ? childArguments[sessionAt + 1] ?? null : null,
		treeDigest: values.get("tree-digest") ?? null,
	};
}

/** Two spellings of one storage directory: Windows paths compare without case and without a trailing separator. */
export function sameStorageDirectory(left: string, right: string): boolean {
	const normal = (value: string): string => path.win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
	return normal(left) === normal(right);
}

/** The key a record or a process is known by: the process id and the kernel's creation time of that process. */
export function processKey(pid: number, creationTime: string): string {
	return `${pid}|${creationTime}`;
}

/** A broker younger than this may still be publishing its record; it is not listed as unmanaged yet. */
export const UNMANAGED_MIN_AGE_MS = 15_000;

export interface UnmanagedScanPorts {
	processTable(): ProcessTableReading;
	processCommandLine(pid: number): ProcessCommandLineReading;
	/** The kernel's creation time of one process. */
	creationTime(pid: number): PtyIdentityReading;
	now(): number;
}

export interface UnmanagedBrokerScanner {
	/**
	 * Every broker of `storageDir` that is running and that `known` (the process keys of the live records) does not name.
	 * `null` when the process table could not be read: that is "unknown", never "there are none".
	 */
	scan(storageDir: string, known: ReadonlySet<string>): UnmanagedBroker[] | null;
}

interface CachedProcess {
	readonly creationTime: string;
	/** `null`: the process is not a broker (or its command line could not be read). */
	readonly facts: UnmanagedBrokerFacts | null;
}

/** The scanner. A command line never changes while a process lives, so one reading is kept per (pid, creation time). */
export function createUnmanagedBrokerScanner(ports: UnmanagedScanPorts): UnmanagedBrokerScanner {
	const cache = new Map<number, CachedProcess>();
	return {
		scan(storageDir, known) {
			const table = ports.processTable();
			if (table.kind !== "found") return null;
			const live = new Set<number>();
			const found: UnmanagedBroker[] = [];
			const now = ports.now();
			for (const entry of table.entries) {
				if (entry.pid <= 4) continue;
				live.add(entry.pid);
				const created = ports.creationTime(entry.pid);
				if (created.kind !== "found") continue;
				let held = cache.get(entry.pid);
				if (held === undefined || held.creationTime !== created.creationTime) {
					const reading = ports.processCommandLine(entry.pid);
					// An unreadable line (denied, a transient failure) is not a verdict: it is asked again at the next scan.
					if (reading.kind === "unknown") continue;
					held = { creationTime: created.creationTime, facts: reading.kind === "found" ? parseBrokerCommandLine(reading.commandLine) : null };
					cache.set(entry.pid, held);
				}
				if (held.facts === null || !sameStorageDirectory(held.facts.storageDir, storageDir)) continue;
				if (known.has(processKey(entry.pid, created.creationTime))) continue;
				const startedMs = filetimeToEpochMs(created.creationTime);
				if (startedMs === null || now - startedMs < UNMANAGED_MIN_AGE_MS) continue;
				found.push({ pid: entry.pid, creationTime: created.creationTime, startedAt: new Date(startedMs).toISOString(), facts: held.facts });
			}
			for (const pid of [...cache.keys()]) if (!live.has(pid)) cache.delete(pid);
			return found;
		},
	};
}

/** The scan ports over the process's native module. */
export function nativeScanPorts(native: Win32Native, now: () => number = Date.now): UnmanagedScanPorts {
	return {
		processTable: () => native.processTable(),
		processCommandLine: pid => native.processCommandLine(pid),
		creationTime: pid => {
			const reading = native.processCreation(pid);
			return reading.kind === "found" ? { kind: "found", creationTime: reading.filetime } : reading;
		},
		now,
	};
}

/**
 * Whether `pid` still is the broker a row described: the creation time is the one the row names and the command line still says the
 * same slot, kind and storage directory. Read again immediately before a kill, so a recycled id is never ended on a stale row.
 */
export function verifyUnmanagedBroker(
	ports: Pick<UnmanagedScanPorts, "processCommandLine" | "creationTime">,
	expected: { readonly pid: number; readonly creationTime: string; readonly facts: UnmanagedBrokerFacts },
): boolean {
	const created = ports.creationTime(expected.pid);
	if (created.kind !== "found" || created.creationTime !== expected.creationTime) return false;
	const reading = ports.processCommandLine(expected.pid);
	if (reading.kind !== "found") return false;
	const facts = parseBrokerCommandLine(reading.commandLine);
	return facts !== null && facts.slot === expected.facts.slot && facts.kind === expected.facts.kind && sameStorageDirectory(facts.storageDir, expected.facts.storageDir);
}
