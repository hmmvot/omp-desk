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
import { readFileSync } from "node:fs";
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

/** One row of the process table. */
export interface ProcessTableEntry {
	readonly pid: number;
	readonly parentPid: number;
	/** The image's file name as the snapshot spells it (`bun.exe`). */
	readonly exe: string;
}

/** What a process-table reading found. */
export type ProcessTableReading =
	| { readonly kind: "found"; readonly entries: readonly ProcessTableEntry[] }
	| { readonly kind: "unknown"; readonly detail: string };

/** What a command-line reading found. */
export type ProcessCommandLineReading =
	| { readonly kind: "found"; readonly commandLine: string }
	| { readonly kind: "gone" }
	| { readonly kind: "unknown"; readonly detail: string };

/** What opening a named pipe as a client found. */
export type PipeClientOpening =
	| { readonly kind: "opened"; readonly fd: number; readonly serverPid: number }
	| { readonly kind: "busy" }
	| { readonly kind: "unreachable" }
	| { readonly kind: "unknown"; readonly detail: string };

/** What `volumeOf` found. */
export interface VolumeKind {
	/** `GetDriveTypeW`: 3 is `DRIVE_FIXED`, 4 `DRIVE_REMOTE`. */
	readonly driveType: number;
	/** The file system name (`NTFS`), or `null` when the volume could not be read. */
	readonly fileSystem: string | null;
}

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
	/** Every live process, from one `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` read in memory; a failed snapshot is `unknown`. */
	processTable(): ProcessTableReading;
	/**
	 * The command line the operating system holds for one process: `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` and
	 * `NtQueryInformationProcess(ProcessCommandLineInformation)`, which returns the text in one call without reading another
	 * process's memory. `gone` is `ERROR_INVALID_PARAMETER`; a process this account may not open, and any other failure, is `unknown`.
	 */
	processCommandLine(pid: number): ProcessCommandLineReading;
	/**
	 * Open a named pipe as a client and read the server's process id from that same handle
	 * (`CreateFileW`, `GetNamedPipeServerProcessId`; ADR-0006 peer proof, ADR-0076 decision 8). `opened` hands over a
	 * C-runtime descriptor of the libuv this process runs on (`uv_open_osfhandle`) that owns the handle: the caller
	 * compares the pid, then either adopts it with `new net.Socket({ fd })` or closes it with `fs.closeSync(fd)`.
	 * Nothing is read or written here, so the server has said nothing yet. `busy` is every instance in use, `unreachable`
	 * no such pipe, anything else `unknown`.
	 */
	openPipeClient(name: string): PipeClientOpening;
	/**
	 * The kind of drive and, for a fixed disk only, the file system of the volume a root path (`C:\`) is on: `GetDriveTypeW` (3 is a
	 * fixed disk, 4 a network drive), then `GetVolumeInformationW` (never on another drive type, where it can wait on a server or a
	 * device). Synchronous; a volume that cannot be read has no file system name.
	 */
	volumeOf(root: string): VolumeKind;
	/**
	 * The account SID of this process's token and, for every path, its owner and every grant and denial of its
	 * DACL (`GetNamedSecurityInfoW`; ADR-0054). Runs on the one worker-thread lane under a deadline; a read that
	 * misses it reports every path as unreadable. A path that cannot be read has `entries: null`, one whose owner
	 * cannot be read `owner: null`, each failing alone. A NULL DACL reads as one entry granting Everyone everything.
	 */
	readSecurity(paths: readonly string[], deadlineMs: number): Promise<Win32SecurityRead>;
	/**
	 * The same read on the calling thread, in one synchronous step: no lane, no thread-pool job, no turn of the event loop. Only
	 * for paths on a local fixed NTFS volume (`volumeOf`), where the call cannot wait on a network or a domain controller; a path
	 * that cannot be read still fails alone. On a host whose pool and loop other extensions keep busy, ten paths cost milliseconds
	 * this way and seconds as sequential lane jobs.
	 */
	readSecuritySync(paths: readonly string[]): Win32SecurityRead;
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
	szExeFile: string;
}

/** `ProcessCommandLineInformation`, available from Windows 8.1. */
const PROCESS_COMMAND_LINE_INFORMATION = 60;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
const STATUS_BUFFER_OVERFLOW = 0x80000005;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023;
/** Where the text starts in the answer: the `UNICODE_STRING` header (length, maximum length, padding, pointer) is two machine words on a 64-bit image. */
const UNICODE_STRING_HEADER_BYTES = 16;
const COMMAND_LINE_FIRST_BYTES = 4096;
/** A command line is bounded by `CreateProcess` at 32767 characters; the answer is that and its header. */
const COMMAND_LINE_MAX_BYTES = 32768 * 2 + 64;

function bindProcess(koffi: Koffi): Pick<Win32Native, "processCreation" | "processDescendants" | "processTable" | "processCommandLine"> {
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
	const queryInformation = koffi.load("ntdll.dll").func(
		"int32 __stdcall NtQueryInformationProcess(void* process, uint32 informationClass, _Out_ uint8_t* information, uint32 length, _Out_ uint32* returned)",
	) as (process: unknown, informationClass: number, information: Buffer, length: number, returned: number[]) => number;

	/** The process table as one snapshot, or the Win32 error that stopped it. */
	function snapshotRows(): { readonly rows: ProcessRow[] } | { readonly error: number } {
		let error = 0;
		for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt++) {
			const snapshot = createSnapshot(TH32CS_SNAPPROCESS, 0);
			try {
				const row: ProcessRow & { dwSize: number } = { dwSize: entrySize, th32ProcessID: 0, th32ParentProcessID: 0, szExeFile: "" };
				if (snapshot === null || snapshot === undefined || !firstRow(snapshot, row)) {
					error = lastError();
					continue;
				}
				const rows: ProcessRow[] = [];
				do rows.push({ th32ProcessID: row.th32ProcessID, th32ParentProcessID: row.th32ParentProcessID, szExeFile: row.szExeFile });
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
		processTable() {
			const table = snapshotRows();
			if ("error" in table) return { kind: "unknown", detail: `the process snapshot failed with Win32 error ${table.error}` };
			return { kind: "found", entries: table.rows.map(row => ({ pid: row.th32ProcessID, parentPid: row.th32ParentProcessID, exe: row.szExeFile })) };
		},
		processCommandLine(pid) {
			if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) return { kind: "unknown", detail: "no process id to read" };
			const handle = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
			if (handle === null || handle === undefined) {
				const code = lastError();
				return code === ERROR_INVALID_PARAMETER ? { kind: "gone" } : { kind: "unknown", detail: `OpenProcess failed with Win32 error ${code}` };
			}
			try {
				let size = COMMAND_LINE_FIRST_BYTES;
				for (let attempt = 0; attempt < 3; attempt++) {
					const buffer = Buffer.alloc(size);
					const returned = [0];
					const status = queryInformation(handle, PROCESS_COMMAND_LINE_INFORMATION, buffer, size, returned) >>> 0;
					if (status === STATUS_INFO_LENGTH_MISMATCH || status === STATUS_BUFFER_OVERFLOW || status === STATUS_BUFFER_TOO_SMALL) {
						const needed = returned[0] ?? 0;
						if (needed <= size || needed > COMMAND_LINE_MAX_BYTES) return { kind: "unknown", detail: `the command line needs ${needed} bytes, which is not a plausible size` };
						size = needed;
						continue;
					}
					if (status !== 0) return { kind: "unknown", detail: `NtQueryInformationProcess failed with status 0x${status.toString(16)}` };
					// The answer is a UNICODE_STRING whose text follows its header in the same buffer; the pointer inside it is an address in
					// the buffer koffi marshalled, which is not this one, so it is never followed.
					const length = buffer.readUInt16LE(0);
					if (length === 0 || (length & 1) !== 0 || UNICODE_STRING_HEADER_BYTES + length > buffer.length) {
						return { kind: "unknown", detail: "the process has no readable command line" };
					}
					return { kind: "found", commandLine: buffer.toString("utf16le", UNICODE_STRING_HEADER_BYTES, UNICODE_STRING_HEADER_BYTES + length) };
				}
				return { kind: "unknown", detail: "the command line changed size while it was read" };
			} finally {
				closeHandle(handle);
			}
		},
	};
}

const VOLUME_NAME_CHARS = 64;
/** `GetDriveTypeW`'s `DRIVE_FIXED`. */
const DRIVE_FIXED_TYPE = 3;

function bindVolume(koffi: Koffi): Pick<Win32Native, "volumeOf"> {
	const kernel32 = koffi.load("kernel32.dll");
	const getDriveType = kernel32.func("uint32 __stdcall GetDriveTypeW(str16 root)") as (root: string) => number;
	const getVolumeInformation = kernel32.func(
		"bool __stdcall GetVolumeInformationW(str16 root, void* label, uint32 labelChars, void* serial, void* maxComponent, void* flags, void* fileSystem, uint32 fileSystemChars)",
	) as (root: string, label: null, labelChars: number, serial: null, maxComponent: null, flags: null, fileSystem: Buffer, fileSystemChars: number) => boolean;
	return {
		volumeOf(root) {
			const driveType = getDriveType(root);
			// `GetVolumeInformationW` on a network or removable root can wait for a server or a device on the calling thread, so it is
			// asked of a fixed disk only (ADR-0076, decision 15); every other drive type has no file system name.
			if (driveType !== DRIVE_FIXED_TYPE) return { driveType, fileSystem: null };
			const name = Buffer.alloc(VOLUME_NAME_CHARS * 2);
			if (!getVolumeInformation(root, null, 0, null, null, null, name, VOLUME_NAME_CHARS)) return { driveType, fileSystem: null };
			let end = 0;
			while (end + 1 < name.length && (name[end] !== 0 || name[end + 1] !== 0)) end += 2;
			return { driveType, fileSystem: name.toString("utf16le", 0, end) };
		},
	};
}

const ERROR_PIPE_BUSY = 231;
const PIPE_NAMESPACE = "\\\\.\\pipe\\";
const HOST_PATH_CHARS = 1024;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const FILE_FLAG_OVERLAPPED = 0x40000000;
/** `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`: the server may learn who connects, never act as the client. */
const PIPE_CLIENT_QOS = 0x00100000 | 0x00010000;

function bindPipe(koffi: Koffi): Pick<Win32Native, "openPipeClient"> {
	const kernel32 = koffi.load("kernel32.dll");
	const createFile = kernel32.func(
		"intptr_t __stdcall CreateFileW(str16 name, uint32 access, uint32 share, void* security, uint32 disposition, uint32 flags, void* template)",
	) as (name: string, access: number, share: number, security: null, disposition: number, flags: number, template: null) => number | bigint;
	const serverPid = kernel32.func("bool __stdcall GetNamedPipeServerProcessId(intptr_t pipe, _Out_ uint32* pid)") as (pipe: number | bigint, pid: number[]) => boolean;
	const closeHandle = kernel32.func("bool __stdcall CloseHandle(intptr_t handle)") as (handle: number | bigint) => boolean;
	const lastError = kernel32.func("uint32 __stdcall GetLastError()") as () => number;
	const getModuleFileName = kernel32.func("uint32 __stdcall GetModuleFileNameW(void* module, _Out_ uint8_t* buffer, uint32 size)") as (module: null, buffer: Buffer, size: number) => number;
	/**
	 * `uv_open_osfhandle` of the libuv this process runs on, found in the executable the kernel says this process was started
	 * from (`GetModuleFileNameW(NULL)`, never the overwritable `process.execPath`): the C runtime that numbers the descriptor is
	 * the one libuv reads, so a second copy of the executable must never be loaded here.
	 */
	let adopt: ((handle: number | bigint) => number) | null | undefined;
	const uvOpenOsHandle = (): ((handle: number | bigint) => number) | null => {
		if (adopt !== undefined) return adopt;
		try {
			const buffer = Buffer.alloc(HOST_PATH_CHARS * 2);
			const chars = getModuleFileName(null, buffer, HOST_PATH_CHARS);
			if (chars <= 0 || chars >= HOST_PATH_CHARS) throw new Error("the host executable's path is not readable");
			adopt = koffi.load(buffer.toString("utf16le", 0, chars * 2)).func("int uv_open_osfhandle(intptr_t handle)") as (handle: number | bigint) => number;
		} catch {
			adopt = null;
		}
		return adopt;
	};
	return {
		openPipeClient(name) {
			if (!name.startsWith(PIPE_NAMESPACE)) return { kind: "unknown", detail: "only a name in the local pipe namespace is opened" };
			const adoptHandle = uvOpenOsHandle();
			if (adoptHandle === null) return { kind: "unknown", detail: "this process's libuv does not export uv_open_osfhandle" };
			const handle = createFile(name, GENERIC_READ | GENERIC_WRITE, 0, null, OPEN_EXISTING, FILE_FLAG_OVERLAPPED | PIPE_CLIENT_QOS, null);
			if (Number(handle) === -1) {
				const error = lastError();
				if (error === ERROR_PIPE_BUSY) return { kind: "busy" };
				if (error === ERROR_FILE_NOT_FOUND || error === ERROR_PATH_NOT_FOUND) return { kind: "unreachable" };
				return { kind: "unknown", detail: `CreateFileW failed with Win32 error ${error}` };
			}
			let adopted = false;
			try {
				const pid = [0];
				if (!serverPid(handle, pid)) return { kind: "unknown", detail: `GetNamedPipeServerProcessId failed with Win32 error ${lastError()}` };
				const fd = adoptHandle(handle);
				if (fd < 0) return { kind: "unknown", detail: "uv_open_osfhandle refused the pipe handle" };
				adopted = true;
				return { kind: "opened", fd, serverPid: pid[0] as number };
			} finally {
				if (!adopted) closeHandle(handle);
			}
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

function bindSecurity(koffi: Koffi, lane: CallLane): Pick<Win32Native, "readSecurity" | "readSecuritySync" | "lookupAccountNames"> {
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
		return decodeDescriptor(status, owner, dacl, descriptor);
	}

	/** {@link readPath} on the calling thread. */
	function readPathSync(target: string): { entries: SecurityEntry[] | null; owner: string | null } {
		const owner = [null as unknown];
		const dacl = [null as unknown];
		const descriptor = [null as unknown];
		const status = getNamedSecurityInfo(target, SE_FILE_OBJECT, OWNER_AND_DACL, owner, [null], dacl, [null], descriptor) as number;
		return decodeDescriptor(status, owner, dacl, descriptor);
	}

	/** What one `GetNamedSecurityInfoW` answered, decoded; the descriptor is freed. */
	function decodeDescriptor(status: number, owner: unknown[], dacl: unknown[], descriptor: unknown[]): { entries: SecurityEntry[] | null; owner: string | null } {
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
		readSecuritySync(paths) {
			try {
				const sid = tokenSid();
				const reports = new Map<string, { entries: SecurityEntry[] | null; owner: string | null }>();
				for (const target of paths) reports.set(target.toLowerCase(), readPathSync(target));
				return { sid, failure: null, reports };
			} catch (error) {
				return {
					sid: null,
					failure: `the security read failed (${error instanceof Error ? error.message : String(error)})`,
					reports: new Map(paths.map(target => [target.toLowerCase(), { entries: null, owner: null }])),
				};
			}
		},
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

/** One timed step of loading the addon: wall time, and the host process's CPU time (user + system) over the same span. */
export interface NativeLoadStep {
	readonly name: "read" | "hash" | "dlopen" | "bind" | "verify";
	readonly wallMs: number;
	readonly cpuMs: number;
}

/** `process.cpuUsage()` in milliseconds. */
function processCpuMs(): number {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
}

/** Times consecutive steps of one load; the steps land in `into`. */
function stepClock(into: NativeLoadStep[] | undefined): (name: NativeLoadStep["name"]) => void {
	let wall = performance.now();
	let cpu = processCpuMs();
	return name => {
		const nextWall = performance.now();
		const nextCpu = processCpuMs();
		into?.push({ name, wallMs: nextWall - wall, cpuMs: nextCpu - cpu });
		wall = nextWall;
		cpu = nextCpu;
	};
}

/** Everything after the bytes are in memory: digest, image type, the one `dlopen`, the bindings. Synchronous. */
function loadFromBytes(asset: NativeModuleAsset, bytes: Buffer, arch: string, expected: number, step: (name: NativeLoadStep["name"]) => void): Win32Native {
	if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("the staged native module does not match its digest");
	const machine = peMachineOf(bytes);
	if (machine !== expected) {
		throw new Error(`the staged native module is not a ${arch} image (PE machine ${machine === null ? "none" : `0x${machine.toString(16)}`})`);
	}
	step("hash");
	const holder: { exports: unknown } = { exports: {} };
	try {
		process.dlopen(holder, asset.path);
	} catch (error) {
		throw new Error(`the native module did not load (${error instanceof Error ? error.message : String(error)})`);
	}
	step("dlopen");
	const koffi = holder.exports as Koffi;
	const native: Win32Native = { ...bindMutex(koffi), ...bindProcess(koffi), ...bindPipe(koffi), ...bindVolume(koffi), ...bindSecurity(koffi, new CallLane()) };
	step("bind");
	return native;
}

function expectedMachine(arch: string): number {
	const expected = PE_MACHINES[arch];
	if (expected === undefined) throw new Error(`no native module is shipped for ${arch}`);
	return expected;
}

function unreadable(error: unknown): Error {
	return new Error(`the staged native module cannot be read (${error instanceof Error ? error.message : String(error)})`);
}

/**
 * Load the staged addon and bind the calls.
 *
 * Throws, naming the cause, when the copy no longer holds the bytes its digest names, is not an
 * image for this process's architecture, or does not load. `dlopen` is the one load of this file
 * in this process: the bytes just hashed are the bytes a directly following load maps (the gap
 * between them follows a verification that passed, ADR-0076 decision 4). `steps` receives the
 * timing of the load's parts.
 */
export async function loadWin32Native(asset: NativeModuleAsset, arch: string = process.arch, steps?: NativeLoadStep[]): Promise<Win32Native> {
	const expected = expectedMachine(arch);
	const step = stepClock(steps);
	let bytes: Buffer;
	try {
		bytes = await readFile(asset.path);
	} catch (error) {
		throw unreadable(error);
	}
	step("read");
	return loadFromBytes(asset, bytes, arch, expected, step);
}

/**
 * The same load in one synchronous step, for a caller that must not spend a turn of the host's event loop on any await
 * (the warm start, ADR-0076 decision 11).
 */
export function loadWin32NativeSync(asset: NativeModuleAsset, arch: string = process.arch, steps?: NativeLoadStep[]): Win32Native {
	const expected = expectedMachine(arch);
	const step = stepClock(steps);
	let bytes: Buffer;
	try {
		bytes = readFileSync(asset.path);
	} catch (error) {
		throw unreadable(error);
	}
	step("read");
	return loadFromBytes(asset, bytes, arch, expected, step);
}

let shared: Promise<Win32Native | null> | null = null;
/** The message of the failure that made the load settle as unavailable; `null` while loading, after a load and when none was started. */
let failure: string | null = null;
/** The timing of the parts of the load that produced the shared module; empty before one. */
let loadSteps: readonly NativeLoadStep[] = [];
/** The steps of the load as one phrase: `read 3 (cpu 2) · hash 4 (cpu 4) · dlopen 20 (cpu 18) · bind 12 (cpu 12)`. */
export function describeLoadSteps(steps: readonly NativeLoadStep[]): string {
	return steps.map(step => `${step.name} ${Math.round(step.wallMs)} (cpu ${Math.round(step.cpuMs)})`).join(" · ");
}

/** Whether the shared module came from the synchronous warm start. */
let startedWarm = false;

/** The parts of the load that produced the shared module, timed; empty before one. */
export function win32NativeLoadSteps(): readonly NativeLoadStep[] {
	return loadSteps;
}

/** Whether the shared module came from the synchronous warm start (ADR-0076 decision 11) rather than from a staging child. */
export function win32NativeStartedWarm(): boolean {
	return startedWarm;
}

/** A staged module a warm start names, and the synchronous check of its path chain that must pass before it is shared. */
export interface WarmStart {
	readonly asset: NativeModuleAsset;
	/** The refusal of the module's path chain, or `null`; runs after the module loaded, before it is shared. A throw is a refusal. */
	readonly verify?: (native: Win32Native) => string | null;
}

/**
 * Start the one load of this process. Called first thing in activation, before any reader asks:
 * every reader awaits {@link win32Native}, and `null` is only ever the settled "unavailable".
 * `source` throws, naming the cause, when it has no module to give: the message is kept for {@link win32NativeFailure}.
 *
 * `warm`, when given, runs first and synchronously: a module it names that loads is loaded before this call returns, with no turn
 * of the event loop in between (ADR-0076 decision 11). It is shared, in that same step, once its `verify` (the owner and access list
 * of the module's path chain, read natively and synchronously) has found nothing wrong; a refusal settles the load as unavailable with that cause, as a staging child's
 * refusal does. A warm start that has nothing, or fails to load, falls through to `source`, which reports the cause.
 */
export function startWin32Native(
	source: () => Promise<NativeModuleAsset | null>,
	log: Logger = silentLogger,
	warm?: () => WarmStart | null,
): Promise<Win32Native | null> {
	if (shared === null && warm !== undefined) {
		try {
			const start = warm();
			if (start !== null) {
				const steps: NativeLoadStep[] = [];
				const native = loadWin32NativeSync(start.asset, process.arch, steps);
				failure = null;
				loadSteps = steps;
				startedWarm = true;
				const refuse = (cause: string): null => {
					failure = cause;
					log.warn(`the native module is unavailable: ${cause}; Windows checks read as unknown`);
					return null;
				};
				// Synchronous, like everything above it: the module is shared (or refused) before this call returns.
				let problem: string | null = null;
				if (start.verify !== undefined) {
					const wall = performance.now();
					const cpu = processCpuMs();
					try {
						problem = start.verify(native);
					} catch (error) {
						problem = `the layout of the native module could not be verified (${error instanceof Error ? error.message : String(error)})`;
					}
					steps.push({ name: "verify", wallMs: performance.now() - wall, cpuMs: processCpuMs() - cpu });
				}
				shared = Promise.resolve(problem === null ? native : refuse(problem));
				return shared;
			}
		} catch (error) {
			log.debug(`the warm start of the native module did not load: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	shared ??= (async () => {
		failure = null;
		try {
			const asset = await source();
			if (asset === null) {
				failure = "it could not be staged";
				log.warn(`the native module is unavailable: ${failure}; Windows checks read as unknown`);
				return null;
			}
			const steps: NativeLoadStep[] = [];
			const native = await loadWin32Native(asset, process.arch, steps);
			loadSteps = steps;
			return native;
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
			log.warn(`the native module is unavailable: ${failure}; Windows checks read as unknown`);
			return null;
		}
	})();
	return shared;
}

/** Why the process's load settled as unavailable, as the raw message of the last failure; `null` when it did not fail. */
export function win32NativeFailure(): string | null {
	return failure;
}

/** The process's native module once its load has settled; `null` when it could not load (or none was started). */
export function win32Native(): Promise<Win32Native | null> {
	return shared ?? Promise.resolve(null);
}

/** Replace the process's native module. Tests only. */
export function setWin32NativeForTest(native: Win32Native | null | undefined): void {
	failure = null;
	loadSteps = [];
	startedWarm = false;
	shared = native === undefined ? null : Promise.resolve(native);
}
