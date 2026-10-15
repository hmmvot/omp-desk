/**
 * Win32 facts, answered in process (ADR-0076).
 *
 * Desk used to start `powershell.exe` for every question a single kernel call answers: does this
 * named mutex exist, when did this process start, who may write this folder. A PowerShell start
 * costs 0.7 s and more on a busy machine; the calls below cost microseconds to a millisecond.
 * They run through koffi's prebuilt, raw Node-API addon (`koffi.node`, loaded with
 * `process.dlopen`; koffi's JavaScript wrapper is not shipped). This is the only module that
 * touches the FFI (`scripts/check-imports.mjs` enforces that), and every prototype it binds is
 * written out here, once, at load.
 *
 * The addon is a staged copy (ADR-0012): `loadWin32Native` re-reads and re-hashes it, checks that
 * it is built for this process's architecture, and only then loads it. A module that cannot be
 * loaded is one log line with the cause; every reader then gets `null` and answers "unknown".
 * There is deliberately no PowerShell fallback.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Logger } from "../shared/logger.ts";
import { silentLogger } from "../shared/logger.ts";
import { CallLane } from "./call-lane.ts";
import {
	decodeAclEntries,
	formatSid,
	MAX_SID_SUBAUTHORITIES,
	nullDaclEntries,
	SID_HEADER_BYTES,
	sidBytesOf,
	type SecurityEntry,
} from "./win32-security.ts";

/** A native module file and the digest its bytes must hold; a staged runtime asset has exactly this shape. */
export interface NativeModuleAsset {
	readonly path: string;
	readonly sha256: string;
}

/** What opening a named mutex for `SYNCHRONIZE` showed. */
export type MutexState = "held" | "absent" | "error";

/** What a creation-time reading found. */
export type ProcessCreationReading =
	| { readonly kind: "found"; readonly filetime: string }
	| { readonly kind: "gone" }
	| { readonly kind: "unknown"; readonly detail: string };

/** What a descendant reading found. */
export type ProcessTreeReading =
	| { readonly kind: "found"; readonly pids: readonly number[] }
	| { readonly kind: "unknown"; readonly detail: string };

/** The Win32 facts Desk reads. Each method mirrors the contract of the script it replaced. */
export interface Win32Native {
	/**
	 * `OpenMutexW(SYNCHRONIZE)` and nothing else: the mutex is never taken, waited on or kept.
	 *
	 * Mapped as `Mutex.TryOpenExisting` mapped it: `ERROR_FILE_NOT_FOUND`, `ERROR_PATH_NOT_FOUND`,
	 * `ERROR_INVALID_NAME` and `ERROR_INVALID_HANDLE` (another kind of object holds the name) are
	 * "absent"; `ERROR_ACCESS_DENIED` is "held" (it exists; an elevated OMP made it); anything else
	 * is "error".
	 */
	mutexState(name: string): MutexState;
	/**
	 * Kernel creation time of one process: `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` and `GetProcessTimes`.
	 *
	 * `found` carries the creation FILETIME as a decimal string, the string the PowerShell helper printed
	 * (`StartTime.ToFileTime()`). `gone` is `ERROR_INVALID_PARAMETER` (no such process) and a process that
	 * has exited but is still referenced by an open handle; any other failure is `unknown`.
	 */
	processCreation(pid: number): ProcessCreationReading;
	/**
	 * Every live descendant of a process, from one `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` walked in memory.
	 * A process without children, or one that is gone, has none (`found` with no pids); a failed snapshot is `unknown`.
	 */
	processDescendants(pid: number): ProcessTreeReading;
	/**
	 * The account SID of this process's token and, for every path, its owner and every grant and denial of its
	 * DACL (`GetNamedSecurityInfoW`; ADR-0054). Runs on the one worker-thread lane under a deadline; a read that
	 * misses it reports every path as unreadable. A path that cannot be read has `entries: null`, one whose owner
	 * cannot be read `owner: null`, each failing alone. A NULL DACL reads as one entry granting Everyone everything.
	 */
	readSecurity(paths: readonly string[], deadlineMs: number): Promise<Win32SecurityRead>;
	/**
	 * `DOMAIN\name` for each SID that resolves (`LookupAccountSidW`), in the same lane under the same deadline.
	 * Names are diagnostic only: ask for the SIDs a refusal names, never on the admission path.
	 */
	lookupAccountNames(sids: readonly string[], deadlineMs: number): Promise<ReadonlyMap<string, string>>;
}

/** What one batched security read reported. Paths are keyed by their lower-case spelling. */
export interface Win32SecurityRead {
	readonly sid: string | null;
	/** Why the whole read failed (a missed deadline, an error); `null` otherwise. */
	readonly failure: string | null;
	readonly reports: ReadonlyMap<string, { readonly entries: SecurityEntry[] | null; readonly owner: string | null }>;
}

const SYNCHRONIZE = 0x00100000;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_NAME = 123;
const ERROR_INVALID_PARAMETER = 87;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const STILL_ACTIVE = 259;
const TH32CS_SNAPPROCESS = 0x2;
/** A snapshot of the process table can fail transiently (`ERROR_BAD_LENGTH`); one more try, then it is unknown. */
const SNAPSHOT_ATTEMPTS = 3;
const SE_FILE_OBJECT = 1;
/** `OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION`. */
const OWNER_AND_DACL = 0x1 | 0x4;
const TOKEN_QUERY = 0x8;
const TOKEN_USER_CLASS = 1;
const ACL_HEADER_BYTES = 8;

/** PE `Machine` of an image this process can load, by `process.arch`. */
const PE_MACHINES: Readonly<Record<string, number>> = { x64: 0x8664, arm64: 0xaa64 };

/** The PE `Machine` field of a Windows image, or `null` when the bytes are not one. */
export function peMachineOf(bytes: Uint8Array): number | null {
	if (bytes.length < 0x40) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint16(0, true) !== 0x5a4d) return null;
	const header = view.getUint32(0x3c, true);
	if (header + 6 > bytes.length || view.getUint32(header, true) !== 0x00004550) return null;
	return view.getUint16(header + 4, true);
}

/** The slice of koffi's raw module this file uses. */
interface Koffi {
	load(library: string): { func(prototype: string): NativeCall };
	struct(name: string, members: Record<string, unknown>): unknown;
	array(type: string, length: number, hint?: string): unknown;
	sizeof(type: unknown): number;
}

function bindMutex(koffi: Koffi): Pick<Win32Native, "mutexState"> {
	const kernel32 = koffi.load("kernel32.dll");
	const openMutex = kernel32.func("void* __stdcall OpenMutexW(uint32 access, bool inherit, str16 name)") as (
		access: number,
		inherit: boolean,
		name: string,
	) => unknown;
	const closeHandle = kernel32.func("bool __stdcall CloseHandle(void* handle)") as (handle: unknown) => boolean;
	const lastError = kernel32.func("uint32 __stdcall GetLastError()") as () => number;
	return {
		mutexState(name) {
			const handle = openMutex(SYNCHRONIZE, false, name);
			if (handle !== null && handle !== undefined) {
				closeHandle(handle);
				return "held";
			}
			const code = lastError();
			if (code === ERROR_FILE_NOT_FOUND || code === ERROR_PATH_NOT_FOUND || code === ERROR_INVALID_NAME || code === ERROR_INVALID_HANDLE) return "absent";
			return code === ERROR_ACCESS_DENIED ? "held" : "error";
		},
	};
}

/** The row of a process snapshot Desk reads. */
interface ProcessRow {
	th32ProcessID: number;
	th32ParentProcessID: number;
}

function bindProcess(koffi: Koffi): Pick<Win32Native, "processCreation" | "processDescendants"> {
	const kernel32 = koffi.load("kernel32.dll");
	const openProcess = kernel32.func("void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)") as (
		access: number,
		inherit: boolean,
		pid: number,
	) => unknown;
	const getProcessTimes = kernel32.func(
		"bool __stdcall GetProcessTimes(void* process, _Out_ uint64* created, _Out_ uint64* exited, _Out_ uint64* kernel, _Out_ uint64* user)",
	) as (process: unknown, created: bigint[], exited: bigint[], kernel: bigint[], user: bigint[]) => boolean;
	const getExitCode = kernel32.func("bool __stdcall GetExitCodeProcess(void* process, _Out_ uint32* code)") as (process: unknown, code: number[]) => boolean;
	const closeHandle = kernel32.func("bool __stdcall CloseHandle(void* handle)") as (handle: unknown) => boolean;
	const lastError = kernel32.func("uint32 __stdcall GetLastError()") as () => number;
	const entry = koffi.struct("PROCESSENTRY32W", {
		dwSize: "uint32",
		cntUsage: "uint32",
		th32ProcessID: "uint32",
		th32DefaultHeapID: "uintptr_t",
		th32ModuleID: "uint32",
		cntThreads: "uint32",
		th32ParentProcessID: "uint32",
		pcPriClassBase: "int32",
		dwFlags: "uint32",
		szExeFile: koffi.array("char16_t", 260, "String"),
	});
	const entrySize = koffi.sizeof(entry);
	const createSnapshot = kernel32.func("void* __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)") as (flags: number, pid: number) => unknown;
	const firstRow = kernel32.func("bool __stdcall Process32FirstW(void* snapshot, _Inout_ PROCESSENTRY32W* row)") as (snapshot: unknown, row: unknown) => boolean;
	const nextRow = kernel32.func("bool __stdcall Process32NextW(void* snapshot, _Inout_ PROCESSENTRY32W* row)") as (snapshot: unknown, row: unknown) => boolean;

	/** The process table as one snapshot, or the Win32 error that stopped it. */
	function snapshotRows(): { readonly rows: ProcessRow[] } | { readonly error: number } {
		let error = 0;
		for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt++) {
			const snapshot = createSnapshot(TH32CS_SNAPPROCESS, 0);
			try {
				const row: ProcessRow & { dwSize: number } = { dwSize: entrySize, th32ProcessID: 0, th32ParentProcessID: 0 };
				if (snapshot === null || snapshot === undefined || !firstRow(snapshot, row)) {
					error = lastError();
					continue;
				}
				const rows: ProcessRow[] = [];
				do rows.push({ th32ProcessID: row.th32ProcessID, th32ParentProcessID: row.th32ParentProcessID });
				while (nextRow(snapshot, row));
				return { rows };
			} finally {
				if (snapshot !== null && snapshot !== undefined) closeHandle(snapshot);
			}
		}
		return { error };
	}

	return {
		processCreation(pid) {
			if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) return { kind: "unknown", detail: "no process id to read" };
			const handle = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
			if (handle === null || handle === undefined) {
				const code = lastError();
				return code === ERROR_INVALID_PARAMETER ? { kind: "gone" } : { kind: "unknown", detail: `OpenProcess failed with Win32 error ${code}` };
			}
			try {
				// A process that has exited but is still referenced by an open handle still has its times; it is gone all the same.
				const exitCode = [0];
				if (!getExitCode(handle, exitCode)) return { kind: "unknown", detail: `GetExitCodeProcess failed with Win32 error ${lastError()}` };
				if (exitCode[0] !== STILL_ACTIVE) return { kind: "gone" };
				const created = [0n];
				if (!getProcessTimes(handle, created, [0n], [0n], [0n])) {
					return { kind: "unknown", detail: `GetProcessTimes failed with Win32 error ${lastError()}` };
				}
				return { kind: "found", filetime: created[0]!.toString() };
			} finally {
				closeHandle(handle);
			}
		},
		processDescendants(pid) {
			if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unknown", detail: "no process id to read" };
			const table = snapshotRows();
			if ("error" in table) return { kind: "unknown", detail: `the process snapshot failed with Win32 error ${table.error}` };
			const children = new Map<number, number[]>();
			for (const row of table.rows) {
				const siblings = children.get(row.th32ParentProcessID);
				if (siblings === undefined) children.set(row.th32ParentProcessID, [row.th32ProcessID]);
				else siblings.push(row.th32ProcessID);
			}
			// Breadth first, inside this one snapshot, with a visited set: a reused parent id can make the table cyclic.
			const visited = new Set<number>([pid]);
			const found: number[] = [];
			for (let head = [pid], next: number[] = []; head.length > 0; head = next, next = []) {
				for (const parent of head) {
					for (const child of children.get(parent) ?? []) {
						if (visited.has(child)) continue;
						visited.add(child);
						found.push(child);
						next.push(child);
					}
				}
			}
			return { kind: "found", pids: found };
		},
	};
}

/** A koffi function, called synchronously or on its worker threads. */
type NativeCall = ((...args: unknown[]) => unknown) & { async(...args: unknown[]): void };

/** One asynchronous call as a promise; the arguments are kept alive until it settles. */
function callAsync<T>(call: NativeCall, ...args: unknown[]): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	call.async(...args, (error: Error | null, value: T) => (error === null ? resolve(value) : reject(error)));
	return promise;
}

/** Characters of one account name or domain a lookup may return; a longer name stays a bare SID. */
const ACCOUNT_NAME_CHARS = 256;

function bindSecurity(koffi: Koffi, lane: CallLane): Pick<Win32Native, "readSecurity" | "lookupAccountNames"> {
	const advapi32 = koffi.load("advapi32.dll");
	const kernel32 = koffi.load("kernel32.dll");
	const getNamedSecurityInfo = advapi32.func(
		"uint32 __stdcall GetNamedSecurityInfoW(str16 path, int objectType, uint32 information, _Out_ void** owner, _Out_ void** group, _Out_ void** dacl, _Out_ void** sacl, _Out_ void** descriptor)",
	) as NativeCall;
	const lookupAccountSid = advapi32.func(
		"bool __stdcall LookupAccountSidW(void* system, void* sid, void* name, _Inout_ uint32* nameChars, void* domain, _Inout_ uint32* domainChars, _Out_ int32* use)",
	) as NativeCall;
	const openProcessToken = advapi32.func("bool __stdcall OpenProcessToken(void* process, uint32 access, _Out_ void** token)") as NativeCall;
	const getTokenInformation = advapi32.func(
		"bool __stdcall GetTokenInformation(void* token, int tokenClass, void* information, uint32 length, _Out_ uint32* returned)",
	) as NativeCall;
	const getCurrentProcess = kernel32.func("void* __stdcall GetCurrentProcess()") as NativeCall;
	const closeHandle = kernel32.func("bool __stdcall CloseHandle(void* handle)") as NativeCall;
	const localFree = kernel32.func("void* __stdcall LocalFree(void* memory)") as NativeCall;

	const moveMemory = kernel32.func("void __stdcall RtlMoveMemory(_Out_ uint8_t* destination, void* source, size_t length)") as NativeCall;
	/**
	 * Bytes at a native address koffi returned, copied out before the memory is freed. `RtlMoveMemory` into a Buffer, never
	 * `koffi.view`: the extension host is Electron, whose V8 sandbox refuses an ArrayBuffer over external memory and aborts the process.
	 */
	const copyNative = (address: unknown, length: number): Buffer => {
		const bytes = Buffer.alloc(length);
		moveMemory(bytes, address, length);
		return bytes;
	};

	/** The SID of this process's token (`TokenUser`), or `null`. */
	function tokenSid(): string | null {
		const token = [null as unknown];
		if (!(openProcessToken(getCurrentProcess(), TOKEN_QUERY, token) as boolean)) return null;
		try {
			const information = Buffer.alloc(256);
			if (!(getTokenInformation(token[0], TOKEN_USER_CLASS, information, information.length, [0]) as boolean)) return null;
			// TOKEN_USER is one SID_AND_ATTRIBUTES: a pointer to the SID, which sits inside this same buffer.
			return formatSid(copyNative(information.readBigUInt64LE(0), SID_HEADER_BYTES + 4 * MAX_SID_SUBAUTHORITIES));
		} finally {
			closeHandle(token[0]);
		}
	}

	/** One path's owner and access entries, from one descriptor read; each part fails on its own. */
	async function readPath(target: string): Promise<{ entries: SecurityEntry[] | null; owner: string | null }> {
		const owner = [null as unknown];
		const dacl = [null as unknown];
		const descriptor = [null as unknown];
		const status = await callAsync<number>(getNamedSecurityInfo, target, SE_FILE_OBJECT, OWNER_AND_DACL, owner, [null], dacl, [null], descriptor);
		if (status !== 0) return { entries: null, owner: null };
		try {
			let ownerSid: string | null = null;
			if (owner[0] !== null && owner[0] !== 0n) {
				// The first 8 bytes carry the sub-authority count; only then is the SID's full length known.
				const subAuthorities = copyNative(owner[0], SID_HEADER_BYTES)[1]!;
				ownerSid = subAuthorities > MAX_SID_SUBAUTHORITIES ? null : formatSid(copyNative(owner[0], SID_HEADER_BYTES + 4 * subAuthorities));
			}
			let entries: SecurityEntry[] | null;
			if (dacl[0] === null || dacl[0] === 0n) {
				entries = nullDaclEntries();
			} else {
				const size = copyNative(dacl[0], ACL_HEADER_BYTES).readUInt16LE(2);
				entries = size < ACL_HEADER_BYTES ? null : decodeAclEntries(copyNative(dacl[0], size));
			}
			return { entries, owner: ownerSid };
		} finally {
			localFree(descriptor[0]);
		}
	}

	return {
		readSecurity(paths, deadlineMs) {
			const failed = (failure: string): Win32SecurityRead => ({
				sid: null,
				failure,
				reports: new Map(paths.map(target => [target.toLowerCase(), { entries: null, owner: null }])),
			});
			return lane
				.run(
					async isExpired => {
						const sid = tokenSid();
						const reports = new Map<string, { entries: SecurityEntry[] | null; owner: string | null }>();
						for (const target of paths) {
							if (isExpired()) break;
							reports.set(target.toLowerCase(), await readPath(target));
						}
						return { sid, failure: null, reports } satisfies Win32SecurityRead;
					},
					deadlineMs,
					() => failed(`the security read did not finish in ${deadlineMs} ms`),
				)
				.catch((error: unknown) => failed(`the security read failed (${error instanceof Error ? error.message : String(error)})`));
		},
		async lookupAccountNames(sids, deadlineMs) {
			const names = new Map<string, string>();
			await lane
				.run(
					async isExpired => {
						for (const text of sids) {
							if (isExpired()) break;
							const sid = sidBytesOf(text);
							if (sid === null) continue;
							const name = Buffer.alloc(ACCOUNT_NAME_CHARS * 2);
							const domain = Buffer.alloc(ACCOUNT_NAME_CHARS * 2);
							const nameChars = [ACCOUNT_NAME_CHARS];
							const domainChars = [ACCOUNT_NAME_CHARS];
							const found = await callAsync<boolean>(lookupAccountSid, null, sid, name, nameChars, domain, domainChars, [0]);
							if (!found) continue;
							const account = name.toString("utf16le", 0, nameChars[0]! * 2);
							const owner = domain.toString("utf16le", 0, domainChars[0]! * 2);
							names.set(text, owner.length === 0 ? account : `${owner}\\${account}`);
						}
					},
					deadlineMs,
					() => undefined,
				)
				.catch(() => undefined);
			return names;
		},
	};
}

/**
 * Load the staged addon and bind the calls.
 *
 * Throws, naming the cause, when the copy no longer holds the bytes its digest names, is not an
 * image for this process's architecture, or does not load. `dlopen` is the one load of this file
 * in this process: the bytes just hashed are the bytes a directly following load maps (the gap
 * between them follows a verification that passed, ADR-0076 decision 4).
 */
export async function loadWin32Native(asset: NativeModuleAsset, arch: string = process.arch): Promise<Win32Native> {
	const expected = PE_MACHINES[arch];
	if (expected === undefined) throw new Error(`no native module is shipped for ${arch}`);
	let bytes: Buffer;
	try {
		bytes = await readFile(asset.path);
	} catch (error) {
		throw new Error(`the staged native module cannot be read (${error instanceof Error ? error.message : String(error)})`);
	}
	if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("the staged native module does not match its digest");
	const machine = peMachineOf(bytes);
	if (machine !== expected) {
		throw new Error(`the staged native module is not a ${arch} image (PE machine ${machine === null ? "none" : `0x${machine.toString(16)}`})`);
	}
	const holder: { exports: unknown } = { exports: {} };
	try {
		process.dlopen(holder, asset.path);
	} catch (error) {
		throw new Error(`the native module did not load (${error instanceof Error ? error.message : String(error)})`);
	}
	const koffi = holder.exports as Koffi;
	return { ...bindMutex(koffi), ...bindProcess(koffi), ...bindSecurity(koffi, new CallLane()) };
}

let shared: Promise<Win32Native | null> | null = null;

/**
 * Start the one load of this process. Called first thing in activation, before any reader asks:
 * every reader awaits {@link win32Native}, and `null` is only ever the settled "unavailable".
 */
export function startWin32Native(source: () => Promise<NativeModuleAsset | null>, log: Logger = silentLogger): Promise<Win32Native | null> {
	shared ??= (async () => {
		try {
			const asset = await source();
			if (asset === null) {
				log.warn("the native module is unavailable: it could not be staged; Windows checks read as unknown");
				return null;
			}
			return await loadWin32Native(asset);
		} catch (error) {
			log.warn(`the native module is unavailable: ${error instanceof Error ? error.message : String(error)}; Windows checks read as unknown`);
			return null;
		}
	})();
	return shared;
}

/** The process's native module once its load has settled; `null` when it could not load (or none was started). */
export function win32Native(): Promise<Win32Native | null> {
	return shared ?? Promise.resolve(null);
}

/** Replace the process's native module. Tests only. */
export function setWin32NativeForTest(native: Win32Native | null | undefined): void {
	shared = native === undefined ? null : Promise.resolve(native);
}
