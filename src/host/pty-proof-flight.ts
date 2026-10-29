/**
 * One self-check of the PTY runtime for all windows at once
 * ([ADR-0032](../../docs/decisions/0032-prove-the-pty-runtime-with-a-console-child.md), amendment 2026-10-28).
 *
 * After an extension update every window that reloads stages the same tree and then runs the same self-check: five windows
 * measured five checks at once on one machine, each slower for the others, each past its own 15 s limit. The check's answer
 * depends only on what the stored proof's key names (`pty-runtime-proof-store.ts`), so one window can run it and the others
 * take its result:
 *
 * - the **result** is the stored proof itself (a proven check is written under the key, atomically, before the lock is
 *   released); this module adds no second place for a success to live;
 * - the **lock** is `<storage>/runtime/pty-flight/<key name>.lock`, created whole in one step (a temporary file linked to the
 *   name, so no reader sees half of it) and named by the hash of the *whole* key, so a window with another tree, another
 *   executable file or another operating system build never waits for it. It records its holder's process id and the time its
 *   attempt can last at most;
 * - a lock whose holder process is gone, or whose time is up although the process id is alive (reused, or hung), is **stale**
 *   and taken over; a lock whose holder lives is waited for, polling the stored proof, for a bounded time;
 * - when the holder's attempt ends **without a proof** (inconclusive: the machine was too slow; or broken: a fault was
 *   observed), it leaves a short **outcome** beside the lock before it lets go. A window that waited for exactly that holder
 *   and asked for no more time than the holder was given takes the outcome as its own answer instead of repeating a check that
 *   just ended the same way on the same machine. An outcome is never a success and is never read by a window that did not wait
 *   for that attempt: a window that arrives later runs its own check;
 * - past the wait, or when the directory cannot be used at all, the window runs its **own check without the lock**, as every
 *   window did before. The lock is an optimisation: a race between two windows that both find a stale lock can run two
 *   checks at once and costs nothing else.
 */
import { randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readBoundedFile, replaceFileAtomic } from "../wire/atomic-file.ts";
import { isPtyProcessAlive } from "../wire/pty-identity.ts";
import { RUNTIME_ASSET_DIRECTORY } from "../wire/runtime-assets.ts";
import { isRecord } from "../shared/guards.ts";

/** Directory below `runtime/` holding the locks and outcomes of running checks. Apart from the proofs, which it must never mix with. */
export const PTY_FLIGHT_DIRECTORY = "pty-flight";

/** How often a waiting window looks at the stored proof and the lock. */
export const PTY_FLIGHT_POLL_MS = 250;

const FORMAT = 1;
const MAX_FILE_BYTES = 8 * 1024;
/** How many stale locks one pass removes before it gives the turn back to the wait loop. */
const MAX_TAKEOVERS = 5;
/** How often a file that exists but cannot be read for a moment is read again, and the pause between the reads. */
const READ_ATTEMPTS = 4;
const READ_RETRY_MS = 5;

/** What one attempt reports to the flight. A `SelfCheckResult` has the first two fields. */
export interface PtyFlightAttempt {
	/** `proven` is the only success; the attempt has recorded its proof by the time it returns. */
	readonly kind: "proven" | "broken" | "inconclusive";
	readonly detail: string;
}

export interface PtyFlightOptions {
	/** How long to wait for another window's attempt before running one's own; `2 * deadlineMs + 5 s`. */
	readonly waitMs?: number;
	/** Test seam: the poll interval; {@link PTY_FLIGHT_POLL_MS}. */
	readonly pollMs?: number;
	/** Test seam: whether a lock holder's process is alive; a process-id probe. */
	readonly isHolderAlive?: (pid: number) => boolean;
	/** Test seam: this attempt's identity; a random one. */
	readonly holderId?: string;
	/** Test seam: the clock; `Date.now`. */
	readonly now?: () => number;
	/** Test seam: the pause between two looks at the stored proof and the lock; a timer. */
	readonly sleep?: (ms: number) => Promise<void>;
}

export interface PtyFlightInput<Stored, Attempt extends PtyFlightAttempt> {
	readonly storageDir: string;
	/** The proof key's name ({@link ptyProofKeyName}): what makes two windows' checks the same check. */
	readonly name: string;
	/** The deadline this window's check runs under (a window with a longer one never takes a shorter one's outcome). */
	readonly deadlineMs: number;
	/** The longest one attempt can last, so a lock older than that is stale whatever its holder's process id says. */
	readonly maxRunMs: number;
	/** The stored proof for the key, or `null`. */
	readonly readStored: () => Promise<Stored | null>;
	/** One check; it stores its own proof when it proves. Called at most once. */
	readonly attempt: () => Promise<Attempt>;
	readonly options?: PtyFlightOptions;
}

/** How the answer came about. */
export type PtyFlightResult<Stored, Attempt extends PtyFlightAttempt> =
	/** Another check's proof appeared (or was there when the lock was taken); another window's unless `foreign` is false (this process's own warm-up). */
	| { readonly via: "stored"; readonly stored: Stored; readonly waitedMs: number; readonly foreign: boolean }
	/** This window ran the check, holding the lock, after `waitedMs` of waiting. */
	| { readonly via: "owner"; readonly attempt: Attempt; readonly waitedMs: number; readonly foreign: boolean }
	/** Another check ended without a proof while this one waited for it (another window's unless `foreign` is false); this one takes its outcome. */
	| { readonly via: "shared"; readonly outcome: PtyFlightOutcome; readonly waitedMs: number; readonly foreign: boolean }
	/** The wait ran out, or the lock directory could not be used: this window ran its own check without the lock. */
	| { readonly via: "local"; readonly attempt: Attempt; readonly waitedMs: number; readonly foreign: boolean; readonly why: string };

/** What an attempt that did not prove left behind. */
export interface PtyFlightOutcome {
	readonly kind: "broken" | "inconclusive";
	readonly detail: string;
}

interface LockRecord {
	readonly holderId: string;
	readonly pid: number;
	readonly expiresAt: number;
}

interface OutcomeRecord extends PtyFlightOutcome {
	readonly holderId: string;
	readonly deadlineMs: number;
}

/** Where the locks and outcomes of one storage live. */
export function ptyFlightDirectory(storageDir: string): string {
	return join(storageDir, RUNTIME_ASSET_DIRECTORY, PTY_FLIGHT_DIRECTORY);
}

type FileRead = { readonly kind: "missing" } | { readonly kind: "invalid" } | { readonly kind: "busy" } | { readonly kind: "value"; readonly value: unknown };

/**
 * One small file of the flight. `busy` is a file that exists and cannot be read right now (on Windows another process's rename or
 * removal can fail a read for a moment; it is retried a few times first); `invalid` is one that was read and is not what a window
 * writes.
 */
async function readJson(file: string): Promise<FileRead> {
	for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
		try {
			const read = await readBoundedFile(file, MAX_FILE_BYTES);
			if (read.kind === "missing") return { kind: "missing" };
			if (read.kind === "invalid") return { kind: "invalid" };
			try {
				return { kind: "value", value: JSON.parse(read.text) as unknown };
			} catch {
				return { kind: "invalid" };
			}
		} catch {
			const pause = Promise.withResolvers<void>();
			setTimeout(pause.resolve, READ_RETRY_MS);
			await pause.promise;
		}
	}
	return { kind: "busy" };
}

async function readLock(file: string): Promise<LockRecord | "absent" | "invalid" | "busy"> {
	const read = await readJson(file);
	if (read.kind === "missing") return "absent";
	if (read.kind !== "value") return read.kind;
	const { value } = read;
	if (!isRecord(value) || value.format !== FORMAT) return "invalid";
	const { holderId, pid, expiresAt } = value;
	if (typeof holderId !== "string" || typeof pid !== "number" || !Number.isSafeInteger(pid) || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return "invalid";
	return { holderId, pid, expiresAt };
}

async function readOutcome(file: string): Promise<OutcomeRecord | null> {
	const read = await readJson(file);
	if (read.kind !== "value" || !isRecord(read.value) || read.value.format !== FORMAT) return null;
	const { holderId, kind, detail, deadlineMs } = read.value;
	if (typeof holderId !== "string" || (kind !== "broken" && kind !== "inconclusive") || typeof detail !== "string" || typeof deadlineMs !== "number") return null;
	return { holderId, kind, detail, deadlineMs };
}

type Acquisition =
	| { readonly kind: "owner" }
	| { readonly kind: "held"; readonly holderId: string; readonly pid: number | null }
	| { readonly kind: "unusable"; readonly why: string };

/**
 * Run one check for every window that asks for the same key at the same time, or take the answer of the window that does.
 * Never throws for a reason of its own: whatever goes wrong with the files, the window runs its own check.
 */
export async function singleFlight<Stored, Attempt extends PtyFlightAttempt>(
	input: PtyFlightInput<Stored, Attempt>,
): Promise<PtyFlightResult<Stored, Attempt>> {
	const options = input.options ?? {};
	const now = options.now ?? Date.now;
	const pollMs = options.pollMs ?? PTY_FLIGHT_POLL_MS;
	const waitMs = options.waitMs ?? 2 * input.deadlineMs + 5_000;
	const alive = options.isHolderAlive ?? isPtyProcessAlive;
	const sleep =
		options.sleep ??
		(async (ms: number): Promise<void> => {
			const pause = Promise.withResolvers<void>();
			setTimeout(pause.resolve, ms);
			await pause.promise;
		});
	const holderId = options.holderId ?? `flight-${randomUUID()}`;
	const directory = ptyFlightDirectory(input.storageDir);
	const lockFile = join(directory, `${input.name}.lock`);
	const outcomeFile = join(directory, `${input.name}.outcome.json`);
	const startedAt = now();
	const waited = (): number => Math.max(0, now() - startedAt);
	/** Every holder this window saw hold the lock: the only attempts whose outcome it may take. */
	const waitedFor = new Set<string>();

	/** Whether any holder this window waited for was another process: a launch waiting for its own window's warm-up is not "another window". */
	let foreign = false;
	const wait = (): { readonly waitedMs: number; readonly foreign: boolean } => ({ waitedMs: waited(), foreign });
	const local = async (why: string): Promise<PtyFlightResult<Stored, Attempt>> => ({ via: "local", attempt: await input.attempt(), why, ...wait() });

	// A proof that is already stored needs no directory and no lock.
	const present = await input.readStored();
	if (present !== null) return { via: "stored", stored: present, waitedMs: 0, foreign: false };
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
	} catch (error) {
		return await local(`the flight directory could not be created (${errorCode(error)})`);
	}

	const tryAcquire = async (): Promise<Acquisition> => {
		for (let takeovers = 0; takeovers <= MAX_TAKEOVERS; takeovers += 1) {
			const record: LockRecord = { holderId, pid: process.pid, expiresAt: now() + input.maxRunMs };
			const staged = `${lockFile}.${process.pid}.${randomUUID()}.tmp`;
			try {
				await writeFile(staged, `${JSON.stringify({ format: FORMAT, ...record })}\n`, { flag: "wx", mode: 0o600 });
				try {
					await link(staged, lockFile);
					return { kind: "owner" };
				} catch (error) {
					if (errorCode(error) !== "EEXIST") return { kind: "unusable", why: `the lock could not be created (${errorCode(error)})` };
				} finally {
					await rm(staged, { force: true }).catch(() => undefined);
				}
			} catch (error) {
				await rm(staged, { force: true }).catch(() => undefined);
				return { kind: "unusable", why: `the lock could not be created (${errorCode(error)})` };
			}
			const held = await readLock(lockFile);
			if (held === "absent") continue; // released between the create and the read
			// A lock that cannot be read right now (another process is replacing or removing it) is a live holder's: it is waited for, never removed.
			if (held === "busy") return { kind: "held", holderId: "unreadable", pid: null };
			if (held !== "invalid" && now() < held.expiresAt && alive(held.pid)) return { kind: "held", holderId: held.holderId, pid: held.pid };
			// Corrupt, past its time, or its process is gone: stale. Look once more right before removing, so a lock
			// another window just took over is not removed under it.
			const again = await readLock(lockFile);
			if (again === "absent") continue;
			if (held === "invalid" ? again !== "invalid" : typeof again === "string" || again.holderId !== held.holderId) continue;
			await rm(lockFile, { force: true }).catch(() => undefined);
		}
		return { kind: "unusable", why: "the lock kept changing under this window" };
	};

	const release = async (): Promise<void> => {
		const held = await readLock(lockFile);
		if (typeof held !== "string" && held.holderId === holderId) await rm(lockFile, { force: true }).catch(() => undefined);
	};

	for (;;) {
		// The proof was read before the loop and after each pause, so nothing is read twice in a row.

		if (waitedFor.size > 0) {
			const outcome = await readOutcome(outcomeFile);
			if (outcome !== null && waitedFor.has(outcome.holderId) && outcome.deadlineMs >= input.deadlineMs) {
				return { via: "shared", outcome: { kind: outcome.kind, detail: outcome.detail }, ...wait() };
			}
		}

		const acquired = await tryAcquire();
		if (acquired.kind === "unusable") return await local(acquired.why);
		if (acquired.kind === "owner") {
			try {
				// The previous holder may have stored its proof, or left its outcome, between this window's reads and its acquisition.
				const late = await input.readStored();
				if (late !== null) return { via: "stored", stored: late, ...wait() };
				const left = waitedFor.size > 0 ? await readOutcome(outcomeFile) : null;
				if (left !== null && waitedFor.has(left.holderId) && left.deadlineMs >= input.deadlineMs) {
					return { via: "shared", outcome: { kind: left.kind, detail: left.detail }, ...wait() };
				}
				await rm(outcomeFile, { force: true }).catch(() => undefined);
				const attempt = await input.attempt();
				if (attempt.kind !== "proven") {
					const outcome: OutcomeRecord & { readonly format: number } = { format: FORMAT, holderId, kind: attempt.kind, detail: attempt.detail.slice(0, 1000), deadlineMs: input.deadlineMs };
					// A window that cannot leave the outcome runs its own check later; this one's answer is unaffected.
					await replaceFileAtomic(outcomeFile, `${JSON.stringify(outcome)}\n`, { mode: 0o600, createDirectory: false }).catch(() => undefined);
				}
				return { via: "owner", attempt, ...wait() };
			} finally {
				await release();
			}
		}

		waitedFor.add(acquired.holderId);
		if (acquired.pid !== process.pid) foreign = true;
		if (waited() >= waitMs) {
			return await local(`the check of another window did not finish within ${waitMs} ms`);
		}
		await sleep(pollMs);
		const arrived = await input.readStored();
		if (arrived !== null) return { via: "stored", stored: arrived, ...wait() };
	}
}

function errorCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
}

