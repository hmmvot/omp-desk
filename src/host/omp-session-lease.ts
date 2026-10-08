/**
 * Detects a session that a plain OMP process outside this extension is writing.
 *
 * Installed OMP takes an ownership lease on a session when it first writes it and keeps it
 * until the process exits ([ADR-0046](../../docs/decisions/0046-probe-omp-session-lease-for-external-writers.md)).
 * On Windows that lease is a *named kernel mutex*: its mere existence says a live process
 * holds the session, and the kernel removes it when the holder dies. This module
 * derives the exact mutex name from a session id and asks whether such an object exists. It
 * never creates, waits on or holds the mutex: opening it with `SYNCHRONIZE` access and
 * closing the handle at once changes nothing for the owner or for a process that wants it.
 *
 * Everything here rests on one undocumented OMP detail, so it is built to be wrong in a safe
 * direction only. A name that no longer matches OMP's yields "absent", which is the behavior
 * before this module existed; OMP itself still moves a second writer to a sibling file.
 * A false "held" only shows a row state and a confirmation the user can answer "Open Anyway".
 *
 * Derivation, verified against OMP 18.6.3 (`pi-coding-agent` `src/session/session-storage.ts`
 * `tryAcquireSessionLease`, `pi-utils` `src/file-lock.ts` and the native `FileLock`):
 *
 * 1. `name` is the session id when it matches `^[A-Za-z0-9_-]{1,128}$`. Any other id is
 *    hashed by OMP with a hash this module does not reproduce, so it is reported as unknown.
 * 2. `lockPath = path.resolve(path.join(<owners dir>, name)) + ".lock"`, where the owners
 *    directory is `<home>/<PI_CONFIG_DIR or ".omp">/run/session-owners`.
 * 3. The native lock names the mutex `Global\omp-file-lock-` followed by 32 lower-case hex
 *    digits: two 64-bit xxHash64 values (seed 0, 64-bit seeds below) of the UTF-8 bytes of
 *    `lockPath`, each as 16 hex digits, in that order. There is no case folding, separator
 *    normalization or canonicalization.
 *
 * Holding a lease is "the named object exists": the native lock creates the mutex without
 * taking initial ownership and treats `ERROR_ALREADY_EXISTS` as "held by someone else".
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { verifyStagedRuntimeAsset, type StagedRuntimeAsset } from "../runtime-assets.ts";
import { windowsPowerShellEnvironment, windowsPowerShellExecutable } from "./windows-powershell.ts";

/** First 64-bit seed OMP's native lock mixes into the path hash. The bytes spell `OMP-LOCK`. */
const SEED_FIRST = 0x4f4d502d4c4f434bn;
/** Second 64-bit seed OMP's native lock mixes into the path hash. The bytes spell `PI-FILEL`. */
const SEED_SECOND = 0x50492d46494c454cn;

/** Prefix of every named mutex the native lock creates on Windows. */
export const LEASE_MUTEX_PREFIX = "Global\\omp-file-lock-";

/** What a mutex name must look like before it is handed to the helper. */
const LEASE_MUTEX_NAME = /^Global\\omp-file-lock-[0-9a-f]{32}$/;

/** A session id OMP uses verbatim as the lease's file name. */
const PLAIN_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const MASK = 0xffffffffffffffffn;
const PRIME1 = 0x9e3779b185ebca87n;
const PRIME2 = 0xc2b2ae3d27d4eb4fn;
const PRIME3 = 0x165667b19e3779f9n;
const PRIME4 = 0x85ebca77c2b2ae63n;
const PRIME5 = 0x27d4eb2f165667c5n;

function rotl(value: bigint, bits: bigint): bigint {
	return ((value << bits) | (value >> (64n - bits))) & MASK;
}

function round(accumulator: bigint, input: bigint): bigint {
	return (rotl((accumulator + input * PRIME2) & MASK, 31n) * PRIME1) & MASK;
}

function mergeRound(accumulator: bigint, value: bigint): bigint {
	return ((accumulator ^ round(0n, value)) * PRIME1 + PRIME4) & MASK;
}

/** xxHash64 of `input` with a 64-bit `seed`, as the reference algorithm defines it. */
export function xxh64(input: Uint8Array, seed: bigint): bigint {
	const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
	const length = input.byteLength;
	let offset = 0;
	let hash: bigint;
	if (length >= 32) {
		let v1 = (seed + PRIME1 + PRIME2) & MASK;
		let v2 = (seed + PRIME2) & MASK;
		let v3 = seed & MASK;
		let v4 = (seed - PRIME1) & MASK;
		for (; offset + 32 <= length; offset += 32) {
			v1 = round(v1, view.getBigUint64(offset, true));
			v2 = round(v2, view.getBigUint64(offset + 8, true));
			v3 = round(v3, view.getBigUint64(offset + 16, true));
			v4 = round(v4, view.getBigUint64(offset + 24, true));
		}
		hash = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;
		hash = mergeRound(hash, v1);
		hash = mergeRound(hash, v2);
		hash = mergeRound(hash, v3);
		hash = mergeRound(hash, v4);
	} else {
		hash = (seed + PRIME5) & MASK;
	}
	hash = (hash + BigInt(length)) & MASK;
	for (; offset + 8 <= length; offset += 8) {
		hash ^= round(0n, view.getBigUint64(offset, true));
		hash = (rotl(hash, 27n) * PRIME1 + PRIME4) & MASK;
	}
	if (offset + 4 <= length) {
		hash ^= (BigInt(view.getUint32(offset, true)) * PRIME1) & MASK;
		hash = (rotl(hash, 23n) * PRIME2 + PRIME3) & MASK;
		offset += 4;
	}
	for (; offset < length; offset += 1) {
		hash ^= (BigInt(input[offset]!) * PRIME5) & MASK;
		hash = (rotl(hash, 11n) * PRIME1) & MASK;
	}
	hash ^= hash >> 33n;
	hash = (hash * PRIME2) & MASK;
	hash ^= hash >> 29n;
	hash = (hash * PRIME3) & MASK;
	hash ^= hash >> 32n;
	return hash;
}

function hex64(value: bigint): string {
	return value.toString(16).padStart(16, "0");
}

/** The 32 hex digits OMP's native lock appends to its mutex prefix for one lock path. */
export function nativeLockDigest(lockPath: string): string {
	const bytes = Buffer.from(lockPath, "utf8");
	return hex64(xxh64(bytes, SEED_FIRST)) + hex64(xxh64(bytes, SEED_SECOND));
}

/**
 * The directory OMP keeps session ownership leases under: `<home>/<PI_CONFIG_DIR or .omp>/run/session-owners`.
 *
 * Built with Windows path rules (this extension is Windows-only). A `PI_CONFIG_DIR` that only
 * OMP's own `.env` files define is invisible here; that case reads as "absent".
 */
export function ompSessionOwnersDir(options: { readonly homeDir: string; readonly configDirName?: string | undefined }): string {
	const configDir = options.configDirName !== undefined && options.configDirName !== "" ? options.configDirName : ".omp";
	return path.win32.join(options.homeDir, configDir, "run", "session-owners");
}

/**
 * The named mutex a live OMP holds for `sessionId`, or `null` when OMP would name the lease
 * with a hash of an id that is not a plain token (OMP ids are UUIDs, so this does not
 * occur for sessions it writes).
 */
export function sessionLeaseMutexName(sessionId: string, ownersDir: string): string | null {
	if (!PLAIN_SESSION_ID.test(sessionId)) return null;
	const lockPath = `${path.win32.resolve(path.win32.join(ownersDir, sessionId))}.lock`;
	return LEASE_MUTEX_PREFIX + nativeLockDigest(lockPath);
}

/** What one probe saw for one mutex name. */
export type LeaseState = "held" | "absent";

/**
 * Ask which of these mutex names exist. Resolves to `null` for the whole batch when the probe
 * could not run or answered something other than exactly one verdict per name; a name that
 * could not be opened for another reason is simply missing from the map.
 */
export type LeaseProbe = (mutexNames: readonly string[]) => Promise<ReadonlyMap<string, LeaseState> | null>;

/** Bound for one helper run: PowerShell's own start plus a handful of `OpenMutex` calls. An open waits for it at most. */
export const LEASE_PROBE_TIMEOUT_MS = 5_000;

const HELPER_LINE = /^!LEASE (held|absent|error) (Global\\omp-file-lock-[0-9a-f]{32})$/;

/**
 * Read a helper's stdout. `!LEASE <verdict> <name>` per requested name, then `!DONE <count>`.
 * Anything else, a repeated or unrequested name, or a count that does not match is a failed
 * probe: no partial answer is trusted.
 */
export function parseLeaseReport(output: string, requested: readonly string[]): ReadonlyMap<string, LeaseState> | null {
	const wanted = new Set(requested);
	const seen = new Map<string, LeaseState | "error">();
	let done = false;
	for (const raw of output.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "") continue;
		if (done) return null;
		const verdict = HELPER_LINE.exec(line);
		if (verdict !== null) {
			const name = verdict[2]!;
			if (!wanted.has(name) || seen.has(name)) return null;
			seen.set(name, verdict[1] as LeaseState | "error");
			continue;
		}
		const finished = /^!DONE (\d+)$/.exec(line);
		if (finished === null || Number(finished[1]) !== wanted.size) return null;
		done = true;
	}
	if (!done || seen.size !== wanted.size) return null;
	const states = new Map<string, LeaseState>();
	for (const [name, verdict] of seen) if (verdict !== "error") states.set(name, verdict);
	return states;
}

/** How the helper process is created. Production leaves this out. */
export interface LeaseProbeLaunchOptions {
	readonly helper: () => Promise<StagedRuntimeAsset | null>;
	readonly timeoutMs?: number;
	/** Replaces the PowerShell start; a test supplies a child that speaks the same line protocol. */
	readonly launch?: (helper: StagedRuntimeAsset) => ChildProcess;
	readonly log?: (message: string) => void;
}

/**
 * The production probe: the staged PowerShell helper opens each name with `SYNCHRONIZE` only.
 * Any failure resolves to `null` and one log line; nothing is retried.
 */
export function powershellLeaseProbe(options: LeaseProbeLaunchOptions): LeaseProbe {
	const log = options.log ?? (() => {});
	return async mutexNames => {
		if (mutexNames.length === 0) return new Map();
		if (!mutexNames.every(name => LEASE_MUTEX_NAME.test(name))) return null;
		let helper: StagedRuntimeAsset | null;
		try {
			helper = await options.helper();
		} catch (error) {
			log(`session lease probe skipped: the helper is unavailable (${error instanceof Error ? error.message : String(error)})`);
			return null;
		}
		// A path that was correct when it was staged says nothing about the bytes there now.
		if (helper === null || !(await verifyStagedRuntimeAsset(helper))) {
			log("session lease probe skipped: the staged helper is missing or changed");
			return null;
		}
		const requested = [...new Set(mutexNames)];
		return await new Promise<ReadonlyMap<string, LeaseState> | null>(resolve => {
			let child: ChildProcess;
			try {
				child =
					options.launch?.(helper!) ??
					spawn(windowsPowerShellExecutable(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper!.path], {
						windowsHide: true,
						stdio: ["pipe", "pipe", "pipe"],
						env: windowsPowerShellEnvironment(),
					});
			} catch (error) {
				log(`session lease probe could not start: ${error instanceof Error ? error.message : String(error)}`);
				resolve(null);
				return;
			}
			let stdout = "";
			let settled = false;
			const finish = (value: ReadonlyMap<string, LeaseState> | null, note?: string): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (note !== undefined) log(`session lease probe failed: ${note}`);
				if (value === null) child.kill();
				resolve(value);
			};
			const timer = setTimeout(() => finish(null, "timed out"), options.timeoutMs ?? LEASE_PROBE_TIMEOUT_MS);
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
				if (stdout.length > 64 * 1024) finish(null, "unexpectedly long output");
			});
			child.stderr?.resume();
			child.on("error", error => finish(null, error.message));
			child.on("close", code => {
				if (settled) return;
				const report = parseLeaseReport(stdout, requested);
				finish(report, report === null ? `exit code ${code ?? "none"} with an unreadable report` : undefined);
			});
			child.stdin?.on("error", () => {});
			child.stdin?.end(`${requested.join("\n")}\n`);
		});
	};
}

/** Default freshness of a cached verdict: long enough to serve a burst of row observations. */
export const LEASE_VERDICT_TTL_MS = 2_000;

/** Most session ids probed in one helper run, so one pass stays a single short PowerShell call. */
const MAX_BATCH = 200;

export interface ExternalLeaseObserverOptions {
	readonly probe: LeaseProbe;
	/** The directory OMP names leases under right now, or `null` when it cannot be known. */
	readonly ownersDir: () => string | null;
	/** The session id in a file's header, or `null` when there is none. */
	readonly readSessionId: (file: string) => Promise<string | null>;
	/** Every session file the view shows: one pass probes them together. */
	readonly knownFiles: () => readonly string[];
	readonly now?: () => number;
	readonly ttlMs?: number;
	readonly log?: (message: string) => void;
}

interface Verdict {
	readonly state: LeaseState | null;
	/** When the probe that produced this was started. */
	readonly at: number;
	/** Ordinal of the pass that produced this, so a fresh request can demand a later one. */
	readonly pass: number;
}

/**
 * Answers "does a live OMP hold this session file's lease?" for many rows at a time.
 *
 * A burst of row observations is served by one helper run: the first request that finds no
 * fresh verdict probes every file the view shows, and the others reuse that answer for a
 * short time. `fresh` asks for a verdict probed after the call, which a click or an open uses
 * before it decides anything.
 *
 * The answer is a fact about leases, not about who holds one: the caller decides whether the
 * holder is a process this extension owns.
 */
export class ExternalLeaseObserver {
	readonly #options: ExternalLeaseObserverOptions;
	readonly #now: () => number;
	readonly #ttlMs: number;
	readonly #verdicts = new Map<string, Verdict>();
	readonly #wanted = new Set<string>();
	#round: Promise<void> | null = null;
	#passesStarted = 0;
	#unavailableLogged = false;

	constructor(options: ExternalLeaseObserverOptions) {
		this.#options = options;
		this.#now = options.now ?? (() => Date.now());
		this.#ttlMs = options.ttlMs ?? LEASE_VERDICT_TTL_MS;
	}

	/** `true` when a live OMP holds this file's session, `false` when none does, `null` when unknown. */
	async holds(file: string, options: { readonly fresh?: boolean } = {}): Promise<boolean | null> {
		const ownersDir = this.#options.ownersDir();
		if (ownersDir === null) return null;
		const sessionId = await this.#options.readSessionId(file);
		if (sessionId === null) return null;
		const name = sessionLeaseMutexName(sessionId, ownersDir);
		if (name === null) return null;
		const since = this.#now() - this.#ttlMs;
		// A fresh request is answered only by a pass that starts after this call.
		const passFloor = this.#passesStarted;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const known = this.#verdicts.get(name);
			if (known !== undefined && (options.fresh === true ? known.pass > passFloor : known.at >= since)) return known.state === null ? null : known.state === "held";
			this.#wanted.add(name);
			this.#round ??= this.#run(ownersDir).finally(() => {
				this.#round = null;
			});
			await this.#round;
		}
		const last = this.#verdicts.get(name);
		return last === undefined || last.state === null ? null : last.state === "held";
	}

	/** Forget every verdict; the next request probes again. */
	invalidate(): void {
		this.#verdicts.clear();
	}

	async #run(ownersDir: string): Promise<void> {
		// Let callers of the same turn register their name, then widen the pass to every shown row.
		await Promise.resolve();
		const names = new Set(this.#wanted);
		this.#wanted.clear();
		const files = this.#options.knownFiles().slice(0, MAX_BATCH);
		await Promise.all(
			files.map(async file => {
				try {
					const id = await this.#options.readSessionId(file);
					const name = id === null ? null : sessionLeaseMutexName(id, ownersDir);
					if (name !== null && names.size < MAX_BATCH) names.add(name);
				} catch {
					// A row whose header cannot be read is probed when it asks for itself.
				}
			}),
		);
		const pass = ++this.#passesStarted;
		const startedAt = this.#now();
		const requested = [...names];
		let answer: ReadonlyMap<string, LeaseState> | null = null;
		try {
			answer = await this.#options.probe(requested);
		} catch (error) {
			this.#options.log?.(`session lease probe threw: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (answer === null && !this.#unavailableLogged) {
			this.#unavailableLogged = true;
			this.#options.log?.("session lease probe unavailable: rows keep their ordinary ownership state");
		}
		if (answer !== null) this.#unavailableLogged = false;
		for (const name of requested) {
			this.#verdicts.set(name, { state: answer?.get(name) ?? null, at: startedAt, pass });
		}
		// Bound the cache to the names of the latest passes.
		if (this.#verdicts.size > MAX_BATCH * 4) {
			for (const key of this.#verdicts.keys()) {
				if (this.#verdicts.size <= MAX_BATCH * 2) break;
				if (!names.has(key)) this.#verdicts.delete(key);
			}
		}
	}
}
