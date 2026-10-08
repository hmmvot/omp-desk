/**
 * Startup and performance diagnostics for this extension host.
 *
 * `OMP: Show Diagnostics` renders one extension-owned, read-only report from
 * values this window actually observed. Five properties this file must not
 * break:
 *
 * 1. **Nothing is estimated.** A stage is either measured between two real
 *    observation points or reported as `not observed` with the reason. There is
 *    no default, no zero and no "expected" value: an unmeasured stage must never
 *    look like a fast one.
 * 2. **Every measurement names its provenance.** {@link DIAGNOSTIC_STAGES} fixes
 *    the two observation points of each stage, so a number in the report is
 *    always attributable to a code path and a clock.
 * 3. **No secrets.** A host-control key or any other credential is never recorded here, and
 *    {@link redactCapabilities} removes capability-shaped text from anything a
 *    caller does pass in.
 * 4. **Bounded.** Subjects, facts and notes are capped, and every recorded value
 *    is truncated, so one long host message cannot flood the report.
 * 5. **Read-only.** Nothing here starts, stops, probes or configures anything; it
 *    only records observations its caller already made and formats them.
 *
 * Nothing in this module imports `vscode`: the extension host owns the editor
 * surface, and the report contents stay testable without one.
 */

/** One measured startup phase, or one phase this window never observed. */
export type DiagnosticStageId =
	| "resolution"
	| "broker-launch"
	| "first-paint"
	| "chat-live"
	| "host-control-verified";

export interface DiagnosticStageDefinition {
	readonly id: DiagnosticStageId;
	readonly label: string;
	/**
	 * Which subject owns this measurement: the window or one session. A stage is only
	 * ever listed as `not observed` under the subject that owns it, so a session is
	 * never shown as missing a window-level measurement.
	 */
	readonly scope: DiagnosticSubjectKind;
	/**
	 * The two observation points a measurement of this stage spans. Authored
	 * here, never derived from recorded data, so the report cannot claim a
	 * provenance it did not have.
	 */
	readonly provenance: string;
}

/**
 * Canonical stage order and provenance. A stage that is absent from a record is
 * rendered as `not observed` rather than omitted, so a missing measurement is
 * visible instead of silently narrowing the report.
 */
export const DIAGNOSTIC_STAGES: readonly DiagnosticStageDefinition[] = [
	{
		id: "resolution",
		label: "OMP launcher resolution",
		scope: "session",
		provenance:
			"launcher: resolveOmpBinary() inside this launch, timed with the extension host clock (src/host/native-terminal.ts) — this is the whole call, so it spans the PATH walk, every refused candidate and, on the first resolution of an extension-host session, the memoized program-marker read of the selected binary; it is not that launcher's own startup cost",
	},
	{
		id: "broker-launch",
		label: "Broker launch to child identity",
		scope: "session",
		provenance:
			"extension host: await launchRpcHost() / attachRpcHost() — the extension-owned PTY broker, the pipe child and its observed pid and kernel creation time are all inside this call",
	},
	{
		id: "first-paint",
		label: "First history paint",
		scope: "session",
		provenance:
			"extension host: the first snapshot the session published (the JSONL tail window read from disk, before the process is ready), timed against this session's launch mark",
	},
	{
		id: "chat-live",
		label: "Chat live",
		scope: "session",
		provenance:
			"extension host: the session's `live` phase — `ready` read, `get_state` bound to the exact session file and the delta since the disk cursor folded — timed against this session's launch mark",
	},
	{
		id: "host-control-verified",
		label: "Host control verified",
		scope: "session",
		provenance:
			"extension host: HostControlClient.connectVerified() completing — matching pid, matching process generation and the authenticated handshake",
	},
];

export type DiagnosticStageState = "running" | "ok" | "failed" | "not-observed";

export interface DiagnosticStage {
	readonly id: DiagnosticStageId;
	readonly label: string;
	readonly provenance: string;
	readonly state: DiagnosticStageState;
	/** Measured milliseconds, or `null` when this stage carries no measurement. */
	readonly durationMs: number | null;
	/** Epoch ms of the closing observation, or `null` when there was none. */
	readonly at: number | null;
	/** Non-secret, capability-free detail (for example launcher, endpoint, pid). */
	readonly detail: string | null;
	/** Why the stage is unmeasured or failed; always present for those states. */
	readonly note: string | null;
}

/** Subjects one recorder keeps (the window plus this window's tabs). */
export const MAX_DIAGNOSTIC_SUBJECTS = 32;
/** Facts and notes kept per subject. */
export const MAX_DIAGNOSTIC_FACTS = 32;
export const MAX_DIAGNOSTIC_NOTES = 48;
/** Longest recorded string; longer values are truncated with an ellipsis. */
export const MAX_DIAGNOSTIC_VALUE_CHARS = 512;
/** Subjects listed in one rendered report. */
const MAX_RENDERED_SUBJECTS = 12;

export const REDACTED_CAPABILITY = "[capability removed]";

/** A relay room path (`/r/<roomId>` plus its `.`/`#` key suffix), which is what a link carries beyond the origin. */
const ROOM_PATH_RE = /\/r\/[A-Za-z0-9_-]{8,64}(?:[.#][A-Za-z0-9_-]+)?/g;
/** Explicit capability query parameters. */
const CAPABILITY_QUERY_RE = /[?&](?:token|key|writeToken|write_token)=[^\s&#]*/gi;
/** A bare `<roomId>.<key>` / `<roomId>#<key>` capability, the form an earlier Collab build wrote links in. */
const BARE_LINK_RE = /[A-Za-z0-9_-]{10,64}[#.][A-Za-z0-9_-]{16,}/g;

/**
 * Remove capability-shaped text from a value before it is recorded.
 *
 * This is defense in depth rather than the primary rule: the recorder's callers
 * pass only fields the extension already treats as non-secret, and no caller
 * ever hands a room link here. A loopback *origin* (`ws://127.0.0.1:<port>`) is not
 * a capability and survives; a room path or key inside it does not. The shapes
 * of an earlier Collab build's links stay recognised.
 */
export function redactCapabilities(text: string): string {
	return text
		.replace(CAPABILITY_QUERY_RE, REDACTED_CAPABILITY)
		.replace(ROOM_PATH_RE, REDACTED_CAPABILITY)
		.replace(BARE_LINK_RE, REDACTED_CAPABILITY);
}

export type DiagnosticSubjectKind = "window" | "session";

/** The recorder's subject key for the window-level record. */
export const WINDOW_DIAGNOSTIC_SUBJECT = "window";

export interface DiagnosticSubjectInit {
	readonly label: string;
	readonly kind: DiagnosticSubjectKind;
	readonly cwd?: string | null;
	readonly sessionFile?: string | null;
	/** Epoch ms this subject's timeline starts at (a launch or an attach). */
	readonly startedAt?: number;
}

export interface DiagnosticFact {
	readonly key: string;
	readonly value: string;
}

export interface DiagnosticNote {
	readonly at: number;
	readonly text: string;
}

export interface DiagnosticSubjectSnapshot {
	readonly key: string;
	readonly label: string;
	readonly kind: DiagnosticSubjectKind;
	readonly cwd: string | null;
	readonly sessionFile: string | null;
	readonly startedAt: number | null;
	readonly stages: readonly DiagnosticStage[];
	readonly facts: readonly DiagnosticFact[];
	readonly notes: readonly DiagnosticNote[];
}

/** Live subject state; only this module mutates it. */
interface SubjectState {
	key: string;
	label: string;
	kind: DiagnosticSubjectKind;
	cwd: string | null;
	sessionFile: string | null;
	startedAt: number | null;
	readonly starts: Map<DiagnosticStageId, number>;
	readonly stages: Map<DiagnosticStageId, DiagnosticStage>;
	readonly facts: DiagnosticFact[];
	readonly notes: DiagnosticNote[];
}

export interface DiagnosticEnvironment {
	readonly extensionVersion: string;
	readonly vscodeVersion: string;
	/** `${process.platform} ${process.arch}` of the extension host. */
	readonly platform: string;
	readonly hostPid: number;
	/** Extension storage directory. */
	readonly storagePath: string;
	readonly generatedAt?: number;
}

export interface ObserveStageInput {
	/** A duration measured by the caller's own two observation points. */
	readonly durationMs: number | null;
	readonly detail?: string | null;
	readonly note?: string | null;
	/** Overrides the canonical provenance when the caller measured differently. */
	readonly provenance?: string;
	readonly at?: number;
}

function clamp(text: string): string {
	const redacted = redactCapabilities(text);
	return redacted.length > MAX_DIAGNOSTIC_VALUE_CHARS
		? `${redacted.slice(0, MAX_DIAGNOSTIC_VALUE_CHARS)}…`
		: redacted;
}

/**
 * Records what this extension host observed, per subject, and renders it.
 *
 * A subject is the window or one session tab. Time comes from an injected
 * `now()` so a test can assert exact durations; production always passes
 * `Date.now`.
 */
export class DiagnosticsRecorder {
	readonly #subjects = new Map<string, SubjectState>();
	readonly #now: () => number;

	constructor(options?: { now?: () => number }) {
		this.#now = options?.now ?? Date.now;
	}

	/**
	 * Start (or update) one subject. The first `startedAt` wins: a later call for
	 * an existing subject refreshes its label and paths without moving its
	 * timeline, so a session that materializes a file mid-launch keeps the mark
	 * its measurements were taken against.
	 */
	beginSubject(key: string, init: DiagnosticSubjectInit): void {
		const existing = this.#subjects.get(key);
		if (existing) {
			existing.label = clamp(init.label);
			existing.cwd = init.cwd === undefined ? existing.cwd : init.cwd === null ? null : clamp(init.cwd);
			existing.sessionFile =
				init.sessionFile === undefined ? existing.sessionFile : init.sessionFile === null ? null : clamp(init.sessionFile);
			return;
		}
		if (this.#subjects.size >= MAX_DIAGNOSTIC_SUBJECTS) {
			// Bounded memory: the oldest *session* record is dropped so the newest
			// launch is always recorded. The window record is never the victim.
			const oldest = [...this.#subjects.values()].find(subject => subject.kind === "session");
			if (oldest === undefined) return;
			this.#subjects.delete(oldest.key);
		}
		this.#subjects.set(key, {
			key,
			label: clamp(init.label),
			kind: init.kind,
			cwd: init.cwd === undefined || init.cwd === null ? null : clamp(init.cwd),
			sessionFile: init.sessionFile === undefined || init.sessionFile === null ? null : clamp(init.sessionFile),
			startedAt: init.startedAt ?? this.#now(),
			starts: new Map(),
			stages: new Map(),
			facts: [],
			notes: [],
		});
	}

	/** Mark the start of a stage, so a later `succeed`/`fail` spans real work. */
	begin(key: string, stageId: DiagnosticStageId, options?: { provenance?: string }): void {
		const subject = this.#subjects.get(key);
		if (!subject) return;
		const at = this.#now();
		const definition = stageDefinition(stageId);
		subject.starts.set(stageId, at);
		subject.stages.set(stageId, {
			...definition,
			provenance: options?.provenance === undefined ? definition.provenance : clamp(options.provenance),
			state: "running",
			durationMs: null,
			at,
			detail: null,
			note: null,
		});
	}

	/** Close a stage that was started with {@link begin} and succeeded. */
	succeed(key: string, stageId: DiagnosticStageId, input?: { detail?: string | null; note?: string | null }): void {
		this.#close(key, stageId, "ok", input?.detail ?? null, input?.note ?? null);
	}

	/** Close a stage that was started with {@link begin} and failed. */
	fail(key: string, stageId: DiagnosticStageId, note: string, input?: { detail?: string | null }): void {
		this.#close(key, stageId, "failed", input?.detail ?? null, note);
	}

	/** Record a measurement the caller took with its own two observation points. */
	observe(key: string, stageId: DiagnosticStageId, input: ObserveStageInput): void {
		const subject = this.#subjects.get(key);
		if (!subject) return;
		const definition = stageDefinition(stageId);
		subject.stages.set(stageId, {
			id: definition.id,
			label: definition.label,
			provenance: input.provenance === undefined ? definition.provenance : clamp(input.provenance),
			state: "ok",
			durationMs: input.durationMs === null ? null : Math.max(0, Math.round(input.durationMs)),
			at: input.at ?? this.#now(),
			detail: input.detail === undefined || input.detail === null ? null : clamp(input.detail),
			note: input.note === undefined || input.note === null ? null : clamp(input.note),
		});
	}

	/** Record that this window did not observe a stage, with the reason. */
	notObserved(key: string, stageId: DiagnosticStageId, note: string, options?: { provenance?: string }): void {
		const subject = this.#subjects.get(key);
		if (!subject) return;
		const definition = stageDefinition(stageId);
		subject.stages.set(stageId, {
			id: definition.id,
			label: definition.label,
			provenance: options?.provenance === undefined ? definition.provenance : clamp(options.provenance),
			state: "not-observed",
			durationMs: null,
			at: null,
			detail: null,
			note: clamp(note),
		});
	}

	/** Record one non-secret fact, replacing an earlier value of the same key. */
	fact(key: string, name: string, value: string): void {
		const subject = this.#subjects.get(key);
		if (!subject) return;
		const entry: DiagnosticFact = { key: clamp(name), value: clamp(value) };
		const index = subject.facts.findIndex(current => current.key === entry.key);
		if (index >= 0) {
			subject.facts[index] = entry;
			return;
		}
		if (subject.facts.length >= MAX_DIAGNOSTIC_FACTS) return;
		subject.facts.push(entry);
	}

	/** Append one provenance note; the oldest notes are dropped at the cap. */
	note(key: string, text: string): void {
		const subject = this.#subjects.get(key);
		if (!subject) return;
		subject.notes.push({ at: this.#now(), text: clamp(text) });
		if (subject.notes.length > MAX_DIAGNOSTIC_NOTES) subject.notes.splice(0, subject.notes.length - MAX_DIAGNOSTIC_NOTES);
	}

	/** Drop one subject (a forgotten tab), so its record is not shown again. */
	forget(key: string): void {
		this.#subjects.delete(key);
	}

	snapshot(key: string): DiagnosticSubjectSnapshot | null {
		const subject = this.#subjects.get(key);
		return subject === undefined ? null : freeze(subject);
	}

	/** Window subject first, then sessions in creation order. */
	subjects(): readonly DiagnosticSubjectSnapshot[] {
		const window = this.#subjects.get(WINDOW_DIAGNOSTIC_SUBJECT);
		const rest = [...this.#subjects.values()].filter(subject => subject !== window);
		return [...(window === undefined ? [] : [freeze(window)]), ...rest.map(freeze)];
	}

	/** The full read-only report body for the diagnostics document. */
	render(environment: DiagnosticEnvironment): string {
		return renderDiagnosticsReport(this.subjects(), environment);
	}

	#close(
		key: string,
		stageId: DiagnosticStageId,
		state: "ok" | "failed",
		detail: string | null,
		note: string | null,
	): void {
		const subject = this.#subjects.get(key);
		if (!subject) return;
		const start = subject.starts.get(stageId);
		const at = this.#now();
		const definition = stageDefinition(stageId);
		const running = subject.stages.get(stageId);
		subject.stages.set(stageId, {
			id: definition.id,
			label: definition.label,
			// A stage marked with a caller-supplied provenance keeps it: the two
			// observation points did not change when it closed.
			provenance: running?.provenance ?? definition.provenance,
			state,
			durationMs: start === undefined ? null : Math.max(0, at - start),
			at,
			detail: detail === null ? null : clamp(detail),
			note:
				note !== null
					? clamp(note)
					: start === undefined
						? "no start mark was recorded for this stage, so no duration is reported"
						: null,
		});
	}
}

function stageDefinition(stageId: DiagnosticStageId): DiagnosticStageDefinition {
	const definition = DIAGNOSTIC_STAGES.find(stage => stage.id === stageId);
	// Unreachable for a typed caller; an untyped one (a cast, a JSON boundary) can still pass an unknown id.
	return definition ?? { id: stageId, label: stageId, scope: "session", provenance: "unrecognized stage" };
}

function freeze(subject: SubjectState): DiagnosticSubjectSnapshot {
	return {
		key: subject.key,
		label: subject.label,
		kind: subject.kind,
		cwd: subject.cwd,
		sessionFile: subject.sessionFile,
		startedAt: subject.startedAt,
		// Every canonical stage is listed for a session, so a measurement this
		// window never took is visible instead of silently absent. The window
		// record only carries window-level stages, so it lists only those.
		stages: DIAGNOSTIC_STAGES.flatMap((definition): DiagnosticStage[] => {
			const recorded = subject.stages.get(definition.id);
			if (recorded !== undefined) return [recorded];
			if (definition.scope !== subject.kind) return [];
			return [
				{
					id: definition.id,
					label: definition.label,
					provenance: definition.provenance,
					state: "not-observed" as const,
					durationMs: null,
					at: null,
					detail: null,
					note: "this window did not observe this stage",
				},
			];
		}),
		facts: [...subject.facts],
		notes: [...subject.notes],
	};
}

/** Path of the single diagnostics document; the provider ignores any other. */
export const DIAGNOSTICS_DOCUMENT_PATH = "/diagnostics.md";

export function formatMeasured(durationMs: number | null): string {
	if (durationMs === null) return "not observed";
	if (durationMs < 1000) return `${durationMs} ms`;
	const seconds = durationMs / 1000;
	if (seconds < 60) return `${seconds.toFixed(2)} s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes} m ${(seconds - minutes * 60).toFixed(1)} s`;
}

function stateLabel(stage: DiagnosticStage): string {
	switch (stage.state) {
		case "ok":
			return stage.durationMs === null ? "observed (no duration)" : "measured";
		case "failed":
			return "failed";
		case "running":
			return "in progress";
		case "not-observed":
			return "not observed";
	}
}

function timestampCell(at: number | null): string {
	return at === null ? "—" : new Date(at).toISOString();
}

/** `+1.24 s since this session's launch`, derived from two measured marks. */
function sinceStart(subject: DiagnosticSubjectSnapshot, stage: DiagnosticStage): string {
	if (stage.at === null || subject.startedAt === null) return "—";
	return `+${formatMeasured(Math.max(0, stage.at - subject.startedAt))}`;
}

function tableCell(text: string | null): string {
	if (text === null || text.length === 0) return "—";
	// Keep a table row one line: a recorded value may contain newlines.
	return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/**
 * The whole report. Authored text is fixed here; everything else comes from the
 * recorded subjects, so the document cannot state a fact no stage observed.
 */
export function renderDiagnosticsReport(
	subjects: readonly DiagnosticSubjectSnapshot[],
	environment: DiagnosticEnvironment,
): string {
	const generatedAt = new Date(environment.generatedAt ?? Date.now()).toISOString();
	const lines: string[] = [
		"# OMP Desk — diagnostics",
		"",
		"Extension-owned, read-only report. It contains measured startup timings, resolved paths and versions.",
		"It never contains a secret or a bearer capability: no host-control key is recorded by it.",
		"",
		`Generated ${generatedAt} · extension ${tableCell(environment.extensionVersion)} · VS Code ${tableCell(environment.vscodeVersion)} · ${tableCell(environment.platform)} · extension host pid ${environment.hostPid}`,
		`Extension storage: ${tableCell(environment.storagePath)}`,
		"",
		"Prewarm: this extension starts nothing ahead of time — no OMP process and no session is prewarmed.",
		"These measurements are the evidence a prewarm decision would need; the extension performs none without it.",
		"",
	];

	const shown = subjects.slice(0, MAX_RENDERED_SUBJECTS);
	if (shown.length === 0) {
		lines.push("This window has recorded nothing yet: no session was launched or attached in it.", "");
	}
	for (const subject of shown) {
		const heading = subject.kind === "window" ? "## Window" : `## Session — ${tableCell(subject.label)}`;
		lines.push(heading, "");
		if (subject.kind === "session") {
			lines.push(
				`Launched or attached at ${timestampCell(subject.startedAt)} · cwd ${tableCell(subject.cwd)} · session file ${tableCell(subject.sessionFile)}`,
				"",
			);
		}
		if (subject.facts.length > 0) {
			lines.push("Facts (observed, not measured):", "");
			for (const fact of subject.facts) lines.push(`- ${tableCell(fact.key)}: ${tableCell(fact.value)}`);
			lines.push("");
		}
		lines.push("Measurements:", "");
		lines.push("| stage | state | measured | last observation | since start | detail | how it was measured |");
		lines.push("|---|---|---|---|---|---|---|");
		for (const stage of subject.stages) {
			const measured = stage.state === "running" ? "—" : formatMeasured(stage.durationMs);
			lines.push(
				`| ${tableCell(stage.label)} | ${stateLabel(stage)} | ${measured} | ${timestampCell(stage.at)} | ${sinceStart(subject, stage)} | ${tableCell(stage.detail)} | ${tableCell(stage.provenance)} |`,
			);
		}
		lines.push("");
		const notes = subject.stages.filter(stage => stage.note !== null);
		if (notes.length > 0) {
			lines.push("Stage notes:", "");
			for (const stage of notes) lines.push(`- ${tableCell(stage.label)}: ${tableCell(stage.note)}`);
			lines.push("");
		}
		if (subject.notes.length > 0) {
			lines.push("Observed log:", "");
			for (const note of subject.notes) lines.push(`- ${new Date(note.at).toISOString()} ${tableCell(note.text)}`);
			lines.push("");
		}
	}
	if (subjects.length > shown.length) {
		lines.push(`… ${subjects.length - shown.length} further subject(s) are recorded but not listed in this report.`, "");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}
