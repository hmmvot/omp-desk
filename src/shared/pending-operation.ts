/**
 * The vocabulary of "an action you asked for is being processed": which action, which step it is in, and the words the Sessions
 * view, the status bar and the Chat page show for them.
 *
 * Presentation only. Nothing here, and nothing that reads it, decides ownership, admission, a lease, run intent or a refusal;
 * a pending operation is never persisted and never published to another window. The host sends the page step **ids** from the
 * closed unions below and the page maps them to words itself, so no free text crosses the boundary (ADR-0017).
 *
 * Nothing here imports `vscode`.
 */

/** What the user asked for. `open`, `resume`, `new-session` and `restart` are the launch family: one attempt per tab. */
export const PENDING_KINDS = [
	"open",
	"resume",
	"new-session",
	"restart",
	"view-switch",
	"close",
	"kill",
	"delete",
	"forget",
	"rename",
	"export",
	"reload-windows",
	"inventory-toggle",
] as const;
export type PendingKind = (typeof PENDING_KINDS)[number];

/** Where in the flow the action is; the order of this list is not a sequence. */
export const PENDING_STEPS = [
	"routing",
	"reserving",
	"waiting",
	"ownership",
	"confirm",
	"admission",
	"prepare",
	"runtime",
	"spawn",
	"connect",
	"checking",
	"working",
	"saving",
] as const;
export type PendingStep = (typeof PENDING_STEPS)[number];

/** Who the user clicked: a row or button of the view that shows the state, the Chat composer, or a command with no surface of its own. */
export type PendingOrigin = "row" | "composer" | "command";

/** How the operation ended. `handed-off` means another window took the work. */
export type PendingEnd = "running" | "refused" | "failed" | "cancelled" | "handed-off";
export const PENDING_ENDS: readonly PendingEnd[] = ["running", "refused", "failed", "cancelled", "handed-off"];

/** Seconds are shown once the action has taken this long. */
export const PENDING_SECONDS_AFTER_MS = 5_000;
/** An operation this old is described as "still …" (and logged once); it is never cleared by age. */
export const PENDING_STILL_AFTER_MS = 60_000;

/** Validate an untrusted kind, step or end from the host-to-page boundary. */
export function isPendingKind(value: unknown): value is PendingKind {
	return typeof value === "string" && PENDING_KINDS.some(kind => kind === value);
}

export function isPendingStep(value: unknown): value is PendingStep {
	return typeof value === "string" && PENDING_STEPS.some(step => step === value);
}

export function isPendingEnd(value: unknown): value is PendingEnd {
	return typeof value === "string" && PENDING_ENDS.some(end => end === value);
}

const LAUNCH_FAMILY: Partial<Record<PendingKind, true>> = { open: true, resume: true, "new-session": true, restart: true };

/** Whether the kind belongs to the launch family (the actions that end in one `openTab` attempt). */
export function isLaunchFamily(kind: PendingKind): boolean {
	return LAUNCH_FAMILY[kind] === true;
}

/** Whether two kinds are one attempt on one key (they join), or separate operations. */
export function sameFamily(a: PendingKind, b: PendingKind): boolean {
	return isLaunchFamily(a) ? isLaunchFamily(b) : a === b;
}

/** The steps past the point where an `open` is only showing history. */
const LAUNCHING_STEPS: Partial<Record<PendingStep, true>> = { admission: true, prepare: true, runtime: true, spawn: true, connect: true };

const VERB: Record<PendingKind, string> = {
	open: "Opening",
	resume: "Starting",
	"new-session": "Starting",
	restart: "Starting",
	"view-switch": "Switching view",
	close: "Closing",
	kill: "Killing",
	delete: "Deleting",
	forget: "Forgetting",
	rename: "Renaming",
	export: "Exporting",
	"reload-windows": "Reloading windows",
	"inventory-toggle": "Saving",
};

const PHRASE: Record<PendingStep, string> = {
	routing: "looking for the window that has it",
	reserving: "reserving the session",
	waiting: "waiting for startup to finish",
	ownership: "checking for another OMP process",
	confirm: "waiting for your answer",
	admission: "claiming the session",
	prepare: "preparing OMP",
	runtime: "checking the runtime",
	spawn: "starting OMP",
	connect: "connecting",
	checking: "checking",
	working: "working",
	saving: "saving",
};

/** The verb of the kind at the step: a history open that has reached the launch reads "Starting", and a Close reads "Stopping" once it is stopping (not while it only checks or asks). */
export function pendingVerb(kind: PendingKind, step: PendingStep): string {
	if (kind === "open" && LAUNCHING_STEPS[step] === true) return "Starting";
	if (kind === "close" && step === "working") return "Stopping";
	return VERB[kind];
}

/** The lower-case phrase of a step. */
export function pendingPhrase(step: PendingStep): string {
	return PHRASE[step];
}

/** Whole seconds as ` · 7 s`, or the empty string while the wait is short or the step is the user's own answer. */
export function elapsedSuffix(step: PendingStep, elapsedMs: number): string {
	if (step === "confirm" || elapsedMs < PENDING_SECONDS_AFTER_MS) return "";
	return ` · ${Math.floor(elapsedMs / 1000)} s`;
}

/**
 * The words of one pending operation: `Starting · checking for another OMP process · 7 s`. `still` prefixes the phrase for an
 * operation past {@link PENDING_STILL_AFTER_MS}.
 */
export function pendingText(kind: PendingKind, step: PendingStep, elapsedMs: number, still = false): string {
	return `${pendingVerb(kind, step)} · ${still && step !== "confirm" ? "still " : ""}${PHRASE[step]}${elapsedSuffix(step, elapsedMs)}`;
}

/** The Chat banner's sentence for the action: `Starting the session`. */
export function pendingSubject(kind: PendingKind, step: PendingStep): string {
	switch (kind) {
		case "open": return LAUNCHING_STEPS[step] === true ? "Starting the session" : "Opening the session";
		case "resume":
		case "new-session":
		case "restart": return "Starting the session";
		case "view-switch": return "Switching the view";
		case "close": return "Closing the session";
		case "kill": return "Killing the session";
		case "delete": return "Deleting the session";
		case "forget": return "Forgetting the session";
		case "rename": return "Renaming the session";
		case "export": return "Exporting the session";
		case "reload-windows": return "Reloading windows";
		case "inventory-toggle": return "Saving";
	}
}

/** `Starting the session · checking for another OMP process · 7 s`, as the Chat banner shows it. */
export function pendingBannerText(kind: PendingKind, step: PendingStep, elapsedMs: number, still = false): string {
	return `${pendingSubject(kind, step)} · ${still && step !== "confirm" ? "still " : ""}${PHRASE[step]}${elapsedSuffix(step, elapsedMs)}`;
}
