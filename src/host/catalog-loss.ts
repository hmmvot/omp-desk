/**
 * What a user is told when the profile catalog was missing or reset
 * ([ADR-0081](../../docs/decisions/0081-keep-a-private-backup-of-the-catalog-and-broker-records-outside-vs-codes-storage-and-restore-it-over-a-missing-catalog.md)).
 *
 * Three situations, none of them silent: a restore from the backup (one notice with the copy's age), a loss with nothing to
 * restore from but evidence that data existed (collected over a few seconds, because the evidence arrives from several places at
 * different times), and a catalog that regressed to fewer sessions than the previous generation's newest copy. This module has no
 * `vscode` import; the window shows what `show` is handed.
 */

import type { BackupInspection } from "./catalog-backup.ts";

/** How long the first piece of evidence waits for more before the notice is decided. */
export const LOSS_GATHER_MS = 3_000;
/** The one extension of that wait when more evidence arrives inside it. */
export const LOSS_GATHER_EXTENSION_MS = 5_000;

export type LossNoticeKind = "restored" | "no-backup" | "backup-unusable" | "regressed";

/** Buttons a notice offers besides its text. */
export type LossNoticeAction = "show-log" | "show-sessions" | "show-backup-folder";

export interface LossNotice {
	readonly kind: LossNoticeKind;
	readonly message: string;
	readonly actions: readonly LossNoticeAction[];
}

/** Facts that survive in VS Code's own state and name sessions the catalog no longer has. */
export interface LossEvidence {
	/** Tab ids this window's local observations name that the catalog lacks. */
	readonly observations: number;
	/** Desk editors VS Code restored that name a tab the catalog lacks. */
	readonly restoredEditors: number;
	/** Broker processes of this storage that no record names. */
	readonly unmanagedBrokers: number;
	/** Record files in `pty/` while the catalog was missing. */
	readonly recordFiles: number;
}

export const NO_EVIDENCE: LossEvidence = { observations: 0, restoredEditors: 0, unmanagedBrokers: 0, recordFiles: 0 };

export const hasEvidence = (evidence: LossEvidence): boolean =>
	evidence.observations + evidence.restoredEditors + evidence.unmanagedBrokers + evidence.recordFiles > 0;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** "5 minutes", "3 hours", "2 days": the coarse age of a copy. */
export function formatAge(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes < 1) return "less than a minute";
	if (minutes < 60) return plural(minutes, "minute", "minutes");
	const hours = Math.round(minutes / 60);
	if (hours < 48) return plural(hours, "hour", "hours");
	return plural(Math.round(hours / 24), "day", "days");
}

export interface RestoredFacts {
	readonly rows: number;
	readonly folders: number;
	readonly ageMs: number;
	readonly brokersRestored: number;
	/** Broker processes still running that no restored record names. */
	readonly unmanagedBrokers: number;
}

export function restoredNotice(facts: RestoredFacts): LossNotice {
	const parts = [
		`OMP Desk found its saved sessions missing and restored ${plural(facts.rows, "session", "sessions")} and ${plural(facts.folders, "folder", "folders")} from the backup made ${formatAge(facts.ageMs)} ago.`,
		facts.brokersRestored > 0 ? `${plural(facts.brokersRestored, "running session", "running sessions")} can be reconnected by opening ${facts.brokersRestored === 1 ? "it" : "them"}.` : "",
		facts.unmanagedBrokers > 0
			? `${plural(facts.unmanagedBrokers, "OMP process", "OMP processes")} still ${facts.unmanagedBrokers === 1 ? "runs" : "run"} without a record; ${facts.unmanagedBrokers === 1 ? "it is" : "they are"} listed in the Sessions view and can be ended there.`
			: "",
	];
	return { kind: "restored", message: parts.filter(part => part.length > 0).join(" "), actions: facts.unmanagedBrokers > 0 ? ["show-log", "show-sessions"] : ["show-log"] };
}

function evidenceSentence(evidence: LossEvidence): string {
	const parts: string[] = [];
	if (evidence.observations > 0) parts.push(`this window remembers ${plural(evidence.observations, "session", "sessions")}`);
	if (evidence.restoredEditors > 0) parts.push(`${plural(evidence.restoredEditors, "open editor", "open editors")} belong${evidence.restoredEditors === 1 ? "s" : ""} to sessions that are gone`);
	if (evidence.unmanagedBrokers > 0) parts.push(`${plural(evidence.unmanagedBrokers, "OMP process", "OMP processes")} still run${evidence.unmanagedBrokers === 1 ? "s" : ""} without a record`);
	if (evidence.recordFiles > 0) parts.push(`${plural(evidence.recordFiles, "broker record", "broker records")} remain`);
	return parts.join("; ");
}

export function lossNotice(kind: "no-backup" | "backup-unusable", evidence: LossEvidence, reason: string | null): LossNotice {
	const lead = kind === "no-backup"
		? "OMP Desk's saved sessions were not found and no backup exists."
		: `OMP Desk's saved sessions were not found and a backup exists but could not be used${reason === null ? "" : ` (${reason})`}.`;
	const body = evidenceSentence(evidence);
	return {
		kind,
		message: body.length > 0 ? `${lead} ${body.charAt(0).toUpperCase()}${body.slice(1)}.` : lead,
		actions: evidence.unmanagedBrokers > 0 ? ["show-log", "show-sessions"] : ["show-log"],
	};
}

export function regressedNotice(before: { readonly rows: number; readonly folders: number }, now: { readonly rows: number; readonly folders: number }): LossNotice {
	return {
		kind: "regressed",
		message: `OMP Desk's saved sessions look reset: ${plural(now.rows, "session", "sessions")} and ${plural(now.folders, "folder", "folders")} now, ${before.rows} and ${before.folders} before. The previous catalog is kept in the backup folder.`,
		actions: ["show-log", "show-backup-folder"],
	};
}

export interface CatalogLossDeps {
	/** The backup's state at the time the notice is decided. */
	readonly inspectBackup: () => Promise<BackupInspection>;
	/** `true` for the first window to claim a notice kind within its window (the cross-window marker). */
	readonly claimNotice: (kind: LossNoticeKind) => Promise<boolean>;
	readonly show: (notice: LossNotice) => void;
	readonly log: (level: "info" | "warn", message: string) => void;
	/** Run `callback` once after `ms`; returns the cancel. The default is an unref'd `setTimeout`. */
	readonly setTimer?: (callback: () => void, ms: number) => () => void;
}

const defaultTimer = (callback: () => void, ms: number): (() => void) => {
	const timer = setTimeout(callback, ms);
	timer.unref?.();
	return () => clearTimeout(timer);
};

/**
 * Collects the evidence of a catalog that was missing and could not be restored, and decides one notice.
 *
 * The first piece of evidence starts a {@link LOSS_GATHER_MS} wait, extended once by {@link LOSS_GATHER_EXTENSION_MS} when more
 * arrives inside it; what arrives later is logged and shown in no second notice.
 */
export class CatalogLossReporter {
	readonly #deps: CatalogLossDeps;
	readonly #setTimer: (callback: () => void, ms: number) => () => void;
	#armed = false;
	#evidence: LossEvidence = NO_EVIDENCE;
	#cancel: (() => void) | null = null;
	#extended = false;
	#decided = false;

	constructor(deps: CatalogLossDeps) {
		this.#deps = deps;
		this.#setTimer = deps.setTimer ?? defaultTimer;
	}

	/** The catalog was missing at open and nothing was restored: evidence now counts. */
	arm(): void {
		this.#armed = true;
	}

	/** Add evidence; the notice is decided {@link LOSS_GATHER_MS} after the first piece. */
	add(more: Partial<LossEvidence>): void {
		const next: LossEvidence = {
			observations: Math.max(this.#evidence.observations, more.observations ?? 0),
			restoredEditors: this.#evidence.restoredEditors + (more.restoredEditors ?? 0),
			unmanagedBrokers: Math.max(this.#evidence.unmanagedBrokers, more.unmanagedBrokers ?? 0),
			recordFiles: Math.max(this.#evidence.recordFiles, more.recordFiles ?? 0),
		};
		const grew = hasEvidence(next) && JSON.stringify(next) !== JSON.stringify(this.#evidence);
		this.#evidence = next;
		if (!this.#armed || !grew) return;
		if (this.#decided) {
			this.#deps.log("warn", `catalog: more evidence of lost sessions arrived after the notice: ${evidenceSentence(next)}`);
			return;
		}
		if (this.#cancel === null) {
			this.#cancel = this.#setTimer(() => void this.#decide(), LOSS_GATHER_MS);
		} else if (!this.#extended) {
			this.#extended = true;
			this.#cancel();
			this.#cancel = this.#setTimer(() => void this.#decide(), LOSS_GATHER_EXTENSION_MS);
		}
	}

	/** The evidence gathered so far. */
	evidence(): LossEvidence {
		return this.#evidence;
	}

	dispose(): void {
		this.#cancel?.();
		this.#cancel = null;
	}

	async #decide(): Promise<void> {
		this.#decided = true;
		this.#cancel = null;
		const backup = await this.#deps.inspectBackup().catch((): BackupInspection => ({ state: "unusable", reason: "the backup could not be inspected" }));
		if (backup.state === "available") {
			// A copy exists and can be read, yet nothing was restored (a document appeared meanwhile, or another window restored): nothing is lost.
			this.#deps.log("info", "catalog: evidence of lost sessions was found, but a usable backup exists and the catalog was repaired by another path");
			return;
		}
		const notice = backup.state === "none" ? lossNotice("no-backup", this.#evidence, null) : lossNotice("backup-unusable", this.#evidence, backup.reason);
		this.#deps.log("warn", `catalog: the saved sessions are missing and could not be restored (${backup.state === "none" ? "no backup" : `backup unusable: ${backup.reason}`}); ${evidenceSentence(this.#evidence)}`);
		if (await this.#deps.claimNotice(notice.kind).catch(() => true)) this.#deps.show(notice);
	}
}
