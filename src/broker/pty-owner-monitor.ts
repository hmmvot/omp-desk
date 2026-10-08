/**
 * The folder-shell owner watch: the admitted set of owning VS Code main-process
 * generations and the one automatic stop that set may authorize
 * ([ADR-0030](../../docs/decisions/0030-watch-the-verified-owning-vscode-process-for-shell-grace.md)).
 *
 * The rules this file enforces, stated where they are implemented:
 *
 * - **Only a folder shell.** A managed OMP host has no owner watch at all: it is
 *   never stopped because a window closed, and it never even starts the helper.
 * - **Hints are not authority.** `process.pid`, `process.ppid` and a candidate
 *   `VSCODE_PID` arrive as hints; every one of them is re-read from the kernel by the
 *   staged helper, and a candidate that cannot be positively attested *disarms* this
 *   shell instead of being trusted or silently dropped.
 * - **A set, not a latest socket.** Admitted generations accumulate. An automatic stop
 *   is permitted only after **every** admitted generation's retained handle has
 *   signaled, so a second live window (or a restarted extension host of the same
 *   instance) can never be mistaken for the death of the first.
 * - **Adoption invalidates the epoch.** A positively attested adoption of a
 *   *different* main process adds its generation, cancels any pending grace and
 *   discards the events queued behind the old epoch — even if the earlier main is
 *   still alive or already gone. A same-main reattach deduplicates and changes nothing.
 * - **A generation, not a number.** An admitted generation is named by its process id
 *   *and* its creation time. An id that now names another process is a different
 *   generation with its own retained handle and its own lifetime, so one generation's
 *   exit can never be read as another's — and a signal naming the old creation time
 *   never satisfies the new generation.
 * - **An unattestable attachment disarms.** An authenticated attachment that says it
 *   cannot attest an owning main cancels whatever grace was queued and disarms: a live
 *   owner may exist that this shell cannot see, so a grace armed before that attachment
 *   arrived must never overtake it.
 * - **Loss of the watch is unknown, never an exit.** If the helper fails, dies or
 *   prints something unusable — including a wait that failed rather than reported a
 *   process ending — the owner set is no longer observable, so automatic stopping is
 *   disarmed; a helper crash is never read as a process having exited.
 * - **One finite grace, one attempt.** When the last admitted handle signals, this
 *   broker waits the finite grace, re-checks under its own gate that nothing changed,
 *   and then makes the one stop attempt the design authorizes. The attempt is the
 *   broker's ordinary identity-safe shell stop, so its unproven tree is reported as
 *   unknown and the slot keeps its recovery record (ADR-0029) rather than being
 *   presented as a proven whole-tree termination.
 */

import {
	PTY_MAX_OWNER_GENERATIONS,
	isPtyCreationTime,
	type PtyKind,
	type PtyOwnerHint,
	type PtyOwnerMainRecord,
	type PtyOwnerStopState,
	type PtyOwnerStopStatus,
	type PtyStopResult,
} from "../host/pty-protocol.ts";
import {
	startPtyOwnerWatcher,
	type PtyOwnerWatchEvents,
	type PtyOwnerWatcher,
	type PtyOwnerWatcherLaunch,
	type PtyOwnerWatchHelper,
} from "../host/pty-owner-watch.ts";

/** Default reason an automatic stop is attributed to, in logs and in its result. */
export const PTY_OWNER_EXIT_REASON = "the owning VS Code instance exited";

/**
 * Why a shell is disarmed when an authenticated attachment cannot attest an owner.
 *
 * Stated once because it is a *policy* fact a caller shows a user, not a diagnostic
 * string: nothing automatic will happen for this shell afterwards.
 */
export const PTY_OWNER_UNATTESTED_REASON =
	"an authenticated attachment could not attest an owning VS Code main process for this shell";

export interface PtyOwnerMonitorOptions {
	readonly kind: PtyKind;
	/** This broker's own pid, which the helper refuses to attest as a main process. */
	readonly brokerPid: number;
	/** The staged helper, or `null` when this build has none (auto-stop stays off). */
	readonly helper: PtyOwnerWatchHelper | null;
	readonly graceMs: number;
	/** Called after every change, so attached clients learn the new state. */
	readonly onStatusChanged: (status: PtyOwnerStopStatus) => void;
	/** The one stop attempt the design authorizes; the broker's ordinary stop. */
	readonly onAutoStop: (reason: string) => Promise<PtyStopResult>;
	readonly log: (line: string) => Promise<void> | void;
	/** Test seam: start the helper another way. Production leaves this out. */
	readonly launchWatcher?: (events: PtyOwnerWatchEvents) => Promise<PtyOwnerWatcherLaunch>;
}

interface AdmittedOwner {
	readonly pid: number;
	readonly creationTime: string;
	signaled: boolean;
	readonly admittedAtMs: number;
}

/**
 * How one admitted generation is named inside the set.
 *
 * The process id alone is not an identity: an id that now names another process is
 * another generation with its own lifetime, and conflating the two would let one
 * generation's exit be read as another's.
 */
function generationKey(pid: number, creationTime: string): string {
	return `${String(pid)}/${creationTime}`;
}

interface RunningGrace {
	readonly epoch: number;
	readonly deadline: number;
	readonly timer: NodeJS.Timeout;
}

export class PtyOwnerMonitor {
	private readonly options: PtyOwnerMonitorOptions;
	/** Admitted generations, keyed by generation rather than by id (see {@link generationKey}). */
	private readonly owners = new Map<string, AdmittedOwner>();
	private watcher: PtyOwnerWatcher | null = null;
	private startingWatcher: Promise<PtyOwnerWatcher | null> | null = null;
	private grace: RunningGrace | null = null;
	private epoch = 0;
	private disarmed: string | null = null;
	private stopAttempted = false;
	private stopping = false;
	private childExited = false;
	private detail: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: PtyOwnerMonitorOptions) {
		this.options = options;
		this.detail =
			options.kind === "folder-shell"
				? "no owning VS Code main process has been attested for this shell yet"
				: "a managed OMP host is never stopped by an owner watch";
	}

	/** What this broker will do about the exit of its owning VS Code instance. */
	status(): PtyOwnerStopStatus {
		const owners: PtyOwnerMainRecord[] = [...this.owners.values()].map(owner => ({
			pid: owner.pid,
			creationTime: owner.creationTime,
			signaled: owner.signaled,
			admittedAtMs: owner.admittedAtMs,
		}));
		return {
			state: this.state(),
			detail: this.detail,
			owners,
			graceRemainingMs: this.grace === null ? null : Math.max(0, this.grace.deadline - Date.now()),
		};
	}

	/**
	 * Admit the hint a launch was started with, if one was given.
	 *
	 * The launch argument line can only ever carry a *candidate*: there is no CLI form for
	 * "this frontend cannot attest an owner", because that statement is made by the
	 * authenticated attachment itself (the `admit-owner` request), which is also what
	 * answers a shell that was already running.
	 */
	async start(hint: PtyOwnerHint | null): Promise<void> {
		if (hint !== null) await this.admit(hint);
	}

	/**
	 * Admit one authenticated hint.
	 *
	 * Everything happens under this monitor's gate, so an adoption can never interleave
	 * with the grace decision it is meant to invalidate.
	 */
	async admit(hint: PtyOwnerHint): Promise<PtyOwnerStopStatus> {
		return await this.gate(async () => {
			if (this.options.kind !== "folder-shell") return this.status();
			if (this.disarmed !== null || this.childExited) return this.status();
			const watcher = await this.ensureWatcher();
			if (watcher === null) return this.status();
			const reading = await watcher.admit(hint);
			if (reading.kind !== "admitted" || !isPtyCreationTime(reading.creationTime)) {
				this.disarm(reading.kind === "unsupported" ? reading.detail : "the owner-watch helper gave no usable admission");
				return this.status();
			}
			const key = generationKey(reading.pid, reading.creationTime);
			const existing = this.owners.get(key);
			if (existing !== undefined) {
				this.detail = `main process ${String(reading.pid)} is already the generation this shell watches (a restarted extension host of the same instance)`;
				return this.status();
			}
			// An id that now names another process is a *different* generation with its own
			// lifetime (ADR-0030): it joins the set with its own handle, and the fact that it
			// reuses an earlier generation's id means nothing about that earlier generation.
			// The earlier entry stays exactly as it was observed — a signaled one never
			// blocks the stop, and an unsignaled one still has to signal.
			if (this.owners.size >= PTY_MAX_OWNER_GENERATIONS && !this.dropOldestSignaled()) {
				this.disarm(`this shell already watches ${String(PTY_MAX_OWNER_GENERATIONS)} live owning main processes`);
				return this.status();
			}
			this.owners.set(key, {
				pid: reading.pid,
				creationTime: reading.creationTime,
				signaled: false,
				admittedAtMs: Date.now(),
			});
			// A new generation is a new lifetime: whatever the previous epoch queued up
			// (including a grace that was about to fire) belongs to the old one.
			this.epoch += 1;
			this.cancelGrace("a new owning main process was adopted");
			this.stopAttempted = false;
			this.detail = `watching owning VS Code main process ${String(reading.pid)} (${String(this.owners.size)} admitted)`;
			await this.options.log(`owner admitted pid=${String(reading.pid)} creation=${reading.creationTime}`);
			this.armGrace();
			this.changed();
			return this.status();
		});
	}

	/**
	 * An authenticated attachment reported that it cannot attest an owning main.
	 *
	 * This is the ADR-0030 fail-closed rule, and it exists for a concrete race: the
	 * shell may have an armed owner set whose admitted mains have already signaled while
	 * a *second* live window — one that cannot attest itself — is the very reason not to
	 * stop. A live owner that this shell cannot see must therefore never be overtaken by
	 * a grace that was armed before that attachment arrived, so this disarms permanently
	 * and cancels whatever the previous epoch had queued (ADR-0030: an authenticated
	 * attachment whose main cannot be attested disables automatic stopping for this
	 * shell). A managed OMP host is unaffected: it has no watch at all.
	 */
	async admitUnattestable(): Promise<PtyOwnerStopStatus> {
		return await this.gate(async () => {
			if (this.options.kind !== "folder-shell") return this.status();
			this.disarm(PTY_OWNER_UNATTESTED_REASON);
			return this.status();
		});
	}

	/** The child exited on its own: nothing automatic is left to do. */
	childHasExited(): void {
		this.childExited = true;
		this.epoch += 1;
		this.cancelGrace("the child exited on its own");
		if (this.state() === "grace") this.detail = "the child exited before its owning instance; the grace was cancelled";
	}

	/** Close the helper. The broker calls this only while it is shutting down. */
	async close(): Promise<void> {
		this.epoch += 1;
		this.cancelGrace("the broker is shutting down");
		const watcher = this.watcher ?? (await this.startingWatcher?.catch(() => null)) ?? null;
		this.watcher = null;
		await watcher?.stop().catch(() => undefined);
	}

	private state(): PtyOwnerStopState {
		if (this.options.kind !== "folder-shell") return "not-applicable";
		if (this.disarmed !== null) return "disarmed";
		if (this.stopping) return "stopping";
		if (this.grace !== null) return "grace";
		if (this.owners.size === 0) return "disarmed";
		if (this.allSignaled()) return this.stopAttempted ? "stopped" : "armed";
		return "armed";
	}

	private allSignaled(): boolean {
		for (const owner of this.owners.values()) {
			if (!owner.signaled) return false;
		}
		return true;
	}

	/**
	 * Make room for a newly adopted generation by forgetting the oldest *signaled* one.
	 *
	 * A signaled generation can never change state again, so forgetting it cannot change
	 * any decision — while a live (unsignaled) one must never be forgotten, because the
	 * whole point of the set is that every admitted owner has to signal before a stop.
	 * Returns `false` when every admitted generation is still live, which the caller
	 * reports as a refusal (fail closed) rather than dropping one.
	 */
	private dropOldestSignaled(): boolean {
		for (const [key, owner] of this.owners) {
			if (!owner.signaled) continue;
			this.owners.delete(key);
			return true;
		}
		return false;
	}

	private changed(): void {
		this.options.onStatusChanged(this.status());
	}

	private disarm(reason: string): void {
		if (this.disarmed !== null) return;
		this.disarmed = reason;
		this.epoch += 1;
		this.cancelGrace("automatic stopping was disarmed");
		this.detail = `automatic stopping is disarmed: ${reason}. This shell is left running for an explicit Close.`;
		void this.options.log(`owner watch disarmed: ${reason}`);
		this.changed();
	}

	private cancelGrace(reason: string): void {
		const grace = this.grace;
		if (grace === null) return;
		this.grace = null;
		clearTimeout(grace.timer);
		void this.options.log(`owner grace cancelled: ${reason}`);
	}

	/**
	 * Arm the finite grace when — and only when — every admitted generation is gone.
	 *
	 * Called from inside the gate, so what it reads is a consistent snapshot of the
	 * admitted set that nothing else can change while the timer is being armed.
	 */
	private armGrace(): void {
		if (this.options.kind !== "folder-shell") return;
		if (this.disarmed !== null || this.childExited || this.stopping || this.stopAttempted || this.grace !== null) return;
		if (this.owners.size === 0 || !this.allSignaled()) return;
		const epoch = this.epoch;
		const deadline = Date.now() + this.options.graceMs;
		const timer = setTimeout(() => {
			void this.fireGrace(epoch);
		}, this.options.graceMs);
		timer.unref();
		this.grace = { epoch, deadline, timer };
		this.detail = `every admitted owning VS Code main process has exited; a ${String(Math.round(this.options.graceMs / 1000))}s grace precedes one shell stop attempt`;
		void this.options.log(`owner grace armed for ${String(this.options.graceMs)}ms after ${String(this.owners.size)} admitted main process(es) signaled`);
		this.changed();
	}

	/**
	 * The grace elapsed: re-check under the gate, then make the one stop attempt.
	 *
	 * The epoch is what makes this safe: an admission, a loss of the watch or an
	 * explicit change since the timer was armed moves it, and the timer then does
	 * nothing at all.
	 */
	private async fireGrace(epoch: number): Promise<void> {
		await this.gate(async () => {
			const grace = this.grace;
			if (grace === null || grace.epoch !== epoch || this.epoch !== epoch) return;
			this.grace = null;
			if (this.disarmed !== null || this.childExited || this.stopping) return;
			if (this.owners.size === 0 || !this.allSignaled()) return;
			this.stopping = true;
			this.stopAttempted = true;
			this.epoch += 1;
			this.detail = `the owning VS Code instance exited; attempting the folder-shell stop (${String(this.owners.size)} admitted main process(es) signaled)`;
			this.changed();
			await this.options.log("owner grace elapsed: attempting the folder-shell stop");
			let result: PtyStopResult | null = null;
			try {
				result = await this.options.onAutoStop(PTY_OWNER_EXIT_REASON);
			} catch (error) {
				this.stopping = false;
				this.detail = `the stop attempt after the owning VS Code instance exited failed: ${messageOf(error)}`;
				this.changed();
				return;
			}
			this.stopping = false;
			// What the attempt proved is what the broker's stop answer proved and nothing
			// more: this design has no kernel-enforced group, so the tree is not claimed.
			this.detail =
				`the owning VS Code instance exited and the shell stop was attempted: ` +
				`process ${result.pidGone ? "gone" : "still present"}, descendant tree ${result.tree} (${result.treeEvidence})`;
			await this.options.log(`owner stop attempt: pidGone=${String(result.pidGone)} tree=${result.tree} verified=${String(result.verified)}`);
			this.changed();
		});
	}

	private async ensureWatcher(): Promise<PtyOwnerWatcher | null> {
		if (this.watcher !== null) return this.watcher;
		if (this.startingWatcher !== null) return await this.startingWatcher;
		const helper = this.options.helper;
		if (helper === null) {
			this.disarm("this build staged no owner-watch helper");
			return null;
		}
		const events: PtyOwnerWatchEvents = {
			onSignaledMain: (pid, creationTime) => this.mainSignaled(pid, creationTime),
			onWatchLost: detail => this.watchLost(detail),
		};
		const starting = (async (): Promise<PtyOwnerWatcher | null> => {
			const launch = await (this.options.launchWatcher?.(events) ??
				startPtyOwnerWatcher(events, { helper, brokerPid: this.options.brokerPid }));
			if (launch.watcher === null) {
				this.disarm(launch.detail ?? "the owner-watch helper could not be started");
				return null;
			}
			this.watcher = launch.watcher;
			return launch.watcher;
		})();
		this.startingWatcher = starting;
		try {
			return await starting;
		} finally {
			this.startingWatcher = null;
		}
	}

	/** One admitted generation's retained handle signaled: a kernel fact, not an id read. */
	private mainSignaled(pid: number, creationTime: string): void {
		void this.gate(async () => {
			// The signal names the generation, not just the id: a signal for an id that now
			// names another process must not satisfy that other generation.
			const owner = this.owners.get(generationKey(pid, creationTime));
			if (owner === undefined || owner.signaled) return;
			owner.signaled = true;
			await this.options.log(`owning main process ${String(pid)} signaled`);
			const pending = this.owners.size > 0 && this.allSignaled();
			this.detail = pending
				? `every admitted owning main process has exited (${String(this.owners.size)} admitted)`
				: `owning main process ${String(pid)} exited; ${String([...this.owners.values()].filter(entry => !entry.signaled).length)} admitted main process(es) are still live`;
			this.armGrace();
			this.changed();
		});
	}

	/** The helper is gone: unknown, which is not an exit of anything it watched. */
	private watchLost(detail: string): void {
		void this.gate(async () => {
			this.disarm(
				`the owner watch was lost (${detail}), so the admitted owner set can no longer be observed`,
			);
		});
	}

	/** One serialization point for admissions, signals, grace decisions and the stop. */
	private async gate<T>(work: () => Promise<T>): Promise<T> {
		const previous = this.queue;
		const running = previous.then(work, work);
		this.queue = running.then(
			() => undefined,
			() => undefined,
		);
		return await running;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
