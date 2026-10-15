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
import type { StagedRuntimeAsset } from "./runtime-assets.ts";

/** What opening a named mutex for `SYNCHRONIZE` showed. */
export type MutexState = "held" | "absent" | "error";

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
}

const SYNCHRONIZE = 0x00100000;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_NAME = 123;

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
	load(library: string): { func(prototype: string): (...args: unknown[]) => unknown };
}

function bindMutex(koffi: Koffi): Win32Native {
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

/**
 * Load the staged addon and bind the calls.
 *
 * Throws, naming the cause, when the copy no longer holds the bytes its digest names, is not an
 * image for this process's architecture, or does not load. `dlopen` is the one load of this file
 * in this process: the bytes just hashed are the bytes a directly following load maps (the gap
 * between them follows a verification that passed, ADR-0076 decision 4).
 */
export async function loadWin32Native(asset: StagedRuntimeAsset, arch: string = process.arch): Promise<Win32Native> {
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
	return bindMutex(holder.exports as Koffi);
}

let shared: Promise<Win32Native | null> | null = null;

/**
 * Start the one load of this process. Called first thing in activation, before any reader asks:
 * every reader awaits {@link win32Native}, and `null` is only ever the settled "unavailable".
 */
export function startWin32Native(source: () => Promise<StagedRuntimeAsset | null>, log: Logger = silentLogger): Promise<Win32Native | null> {
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
