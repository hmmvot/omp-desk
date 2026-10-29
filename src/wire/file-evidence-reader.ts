/**
 * Read-only view of the native file-evidence store: where the store lives, and
 * the rules the extension host uses to *show* committed observations.
 *
 * This is the reader half of
 * [Observe Native OMP File Changes Before Offering Guarded Reversal](../../docs/designs/2026-09-24-native-file-observation-and-reversibility.md)
 * under
 * [ADR-0007](../../docs/decisions/0007-native-file-evidence-and-guarded-restore.md).
 * Four properties this file must not break:
 *
 * 1. **Nothing here writes.** No function creates, changes or deletes a
 *    directory, a record, a blob or a consent file; the producer half owns the
 *    store. `fileEvidenceStoreRoot` only names a path.
 * 2. **Evidence comes from the store, not from a filesystem read.** Text is
 *    taken from a validated journal read, so a record whose blob is missing,
 *    corrupt or bound to another workspace or session never becomes a diff side.
 * 3. **No restore.** There is no undo, redo or rollback here and none may be
 *    added before both ADR-0007 gates pass; these functions only label and
 *    compare immutable bytes.
 * 4. **No overclaiming.** An absent file differs from an empty file, an
 *    admission read is not a per-tool preimage, and a call with no witnessed
 *    result is reported `unknown` rather than assumed unchanged.
 *
 * Nothing in this module imports `vscode`: the extension host owns the editor
 * surfaces, and the decisions they depend on stay testable without one.
 */

import path from "node:path";

import type {
	NativeFileObservationCallView,
	NativeFileObservationRecord,
	NativeFileObservationResolution,
	NativeObservationStage,
} from "./native-file-observation.ts";
import type { NativeFileObservationReadResult } from "./native-file-observation-storage.ts";
import { summarizeNativeFileObservations } from "./native-file-observation.ts";

/**
 * Name of the evidence store inside the launch's host-control directory.
 *
 * ADR-0007 requires the store to be extension-owned and separate from the
 * workspace; ADR-0006 puts the launch's host-control directory in the extension's
 * own global storage. The producer writes here and the reader reads here, so the
 * child name is defined once and both halves call this function instead of
 * spelling the path out: a second copy of the literal would silently point one
 * half at a different store.
 */
export const FILE_EVIDENCE_DIRECTORY_NAME = "file-evidence";

/** The evidence store root for one launch's host-control directory. */
export function fileEvidenceStoreRoot(hostControlDirectory: string): string {
	return path.join(hostControlDirectory, FILE_EVIDENCE_DIRECTORY_NAME);
}

/** Editor scheme the extension host serves validated observation text under. */
export const OBSERVATION_DOCUMENT_SCHEME = "omp-file-observation";

/**
 * Path for one observation document: an opaque per-window token plus the read
 * interval. The token is what the content provider keys on, so a URI cannot name
 * a record, a journal root or a filesystem path, and the stage is visible in the
 * diff without exposing anything the record does not already say.
 */
export function observationDocumentPath(token: string, stage: NativeObservationStage): string {
	return `/${token}/${stage}.txt`;
}

const OBSERVATION_TOKEN_RE = /^\/[A-Za-z0-9-]{1,64}\//;

/** The token of an observation document path, or `null` when it is not one. */
export function observationTokenFromPath(uriPath: string): string | null {
	const match = OBSERVATION_TOKEN_RE.exec(uriPath);
	return match === null ? null : match[0].slice(1, -1);
}

/**
 * Fixed sentences shown next to observations. They are authored here rather than
 * derived from a record, so no stored or host-supplied message reaches a user
 * surface as if it were our own statement.
 */
export const OBSERVATION_PREIMAGE_NOTE =
	"An admission read is not that call's before-image: OMP checks every tool's admission hook in a batch before any tool runs, so unrelated writes can land in between.";
export const OBSERVATION_COVERAGE_NOTE =
	"Only a write or edit that named this path is observed. Bash, MCP calls, child processes, deferred ast_edit writes and other writers are not covered.";
export const OBSERVATION_NO_RESTORE_NOTE =
	"Observations are shown read-only: this extension offers no undo, redo, rollback or checkpoint restore from them.";

const STORED_REASON_MAX_CHARS = 240;

/**
 * A stored policy sentence, accepted only in the bounded printable form this extension's
 * producer writes. Anything else — a host error, a path-bearing
 * message, an oversized string — is dropped instead of being forwarded.
 */
export function storedObservationReason(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	if (value.length === 0 || value.length > STORED_REASON_MAX_CHARS) return null;
	return /^[\x20-\x7e]+$/.test(value) ? value : null;
}

/**
 * Whether one observation can be shown as text, and when it cannot, which
 * refusal applies. `absent` and `empty` are deliberately distinct: a missing
 * file is not a zero-byte file.
 */
export type ObservationReadability =
	| "text"
	| "empty"
	| "absent"
	| "unsupported"
	| "binary"
	| "oversize"
	| "unavailable";

export interface ObservationTextState {
	readonly readability: ObservationReadability;
	/** Validated immutable text; present exactly for `text` and `empty`. */
	readonly text: string | null;
	readonly byteLength: number | null;
	/** Fixed sentence explaining a state that is not shown as text. */
	readonly reason: string | null;
	/** The record's own stored reason, when it is in the bounded printable form. */
	readonly storedReason: string | null;
}

/** Decode bytes only when they are valid UTF-8, as required by the producer's text classification. */
export function decodeObservationText(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Decide how one observation is shown, from the record and the journal's
 * verdict on its bytes. The read result is the authority: a record whose blob is
 * missing, corrupt, oversized or bound elsewhere is never rendered.
 */
export function observationTextState(
	record: NativeFileObservationRecord,
	read: NativeFileObservationReadResult,
): ObservationTextState {
	const storedReason = storedObservationReason(
		record.observation.unavailableReason ?? record.target.unavailableReason,
	);
	const refuse = (readability: ObservationReadability, reason: string): ObservationTextState => ({
		readability,
		text: null,
		byteLength: null,
		reason,
		storedReason,
	});
	if (!read.available) {
		switch (read.reason) {
			case "record-too-large":
				return refuse("oversize", "this record is above the size the reader accepts");
			case "missing-blob":
			case "corrupt-blob":
			case "corrupt-record":
				return refuse(
					"unavailable",
					"the stored bytes do not match what the record declares, so this observation is not shown",
				);
			default:
				return refuse("unavailable", "this observation can no longer be read from the store");
		}
	}
	if (read.record.recordId !== record.recordId) {
		return refuse("unavailable", "the stored record does not match the requested observation");
	}
	const facts = record.observation;
	if (facts.presence === "absent") {
		return refuse("absent", "the file was absent when this observation was taken");
	}
	if (facts.presence !== "file") {
		return refuse("unsupported", "the target was not a plain file, so no text was stored");
	}
	if (facts.consistency !== "stable") {
		return refuse("unavailable", "the observation did not capture a stable file");
	}
	if (facts.contentKind === "binary") {
		return refuse("binary", "the observation stored binary content, which is not shown as text");
	}
	if (facts.contentKind === "empty") {
		if (read.bytes === null || read.bytes.length !== 0) {
			return refuse("unavailable", "the stored bytes do not match an empty file");
		}
		return { readability: "empty", text: "", byteLength: 0, reason: null, storedReason };
	}
	if (facts.contentKind !== "text") {
		return refuse("unsupported", "the content type of this observation is not known, so it is not shown as text");
	}
	if (read.bytes === null) {
		return refuse("unavailable", "the record references no stored bytes");
	}
	try {
		return {
			readability: "text",
			text: decodeObservationText(read.bytes),
			byteLength: read.bytes.length,
			reason: null,
			storedReason,
		};
	} catch {
		return refuse("unavailable", "the stored text is not valid UTF-8");
	}
}

/** True when this observation has validated text a diff or preview may show. */
export function observationTextAvailable(state: ObservationTextState): boolean {
	return state.text !== null;
}

/**
 * Exact producer binding of one record: owner, launch slot, process instance,
 * producer epoch and session binding. Two records may be compared only inside
 * one such binding, so evidence from another host process or another session is
 * never presented as one comparison.
 */
export function observationBindingKey(record: NativeFileObservationRecord): string {
	const origin = record.origin;
	return [
		origin.ownerId,
		origin.slotId,
		origin.processInstanceId,
		origin.producerEpoch,
		record.session.workspaceDigest,
		record.session.sessionId,
	].join("\u0000");
}

/** One observed target inside a binding. Path identity is the digest when known. */
export function observationTargetKey(record: NativeFileObservationRecord): string {
	const target = record.target;
	const identity = target.pathDigest === null ? target.raw : target.pathDigest;
	return `${target.kind}\u0000${identity}`;
}

/** Two consecutive observations of one target inside one exact binding. */
export interface ObservationPair {
	readonly previous: NativeFileObservationRecord;
	readonly current: NativeFileObservationRecord;
}

/**
 * Every consecutive pair of observations that share one binding and one target,
 * newest first. Pairs are never formed across producer instances, epochs,
 * sessions or paths, so a diff can only ever compare two observations of the
 * same file made by the same host process in the same session.
 */
export function observationPairs(records: readonly NativeFileObservationRecord[]): readonly ObservationPair[] {
	const groups = new Map<string, NativeFileObservationRecord[]>();
	for (const record of records) {
		const key = `${observationBindingKey(record)}\u0000${observationTargetKey(record)}`;
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [record]);
		else group.push(record);
	}
	const pairs: ObservationPair[] = [];
	for (const group of groups.values()) {
		group.sort((left, right) =>
			left.sequence === right.sequence ? left.observedAtMs - right.observedAtMs : left.sequence - right.sequence,
		);
		for (let index = 1; index < group.length; index += 1) {
			pairs.push({ previous: group[index - 1]!, current: group[index]! });
		}
	}
	return pairs.sort(
		(left, right) =>
			right.current.sequence - left.current.sequence || right.current.observedAtMs - left.current.observedAtMs,
	);
}

/** The grouping key `summarizeNativeFileObservations` uses, so a view can be found. */
export function observationCallKey(record: NativeFileObservationRecord): string {
	return [record.origin.producerEpoch, record.toolCall.toolCallId, String(record.toolCall.occurrence)].join("\u0000");
}

/** What the journal can say about one call's coverage, in one fixed sentence. */
export function observationResolutionText(resolution: NativeFileObservationResolution): string {
	switch (resolution) {
		case "observed":
			return "a result was observed for this call as well";
		case "unknown":
			return "no result was observed for this call, so what happened to it afterwards is unknown";
		case "result-without-admission":
			return "only a result was observed; no admission read exists for this call";
	}
}

/** Which read interval a record describes, spelled out. */
export function observationStageText(stage: NativeObservationStage): string {
	return stage === "admission-observed"
		? "admission-observed — read before the tool ran, possibly before unrelated writes in the same batch"
		: "observed-post-result — read after the tool reported, after any deferred write it performs";
}

/** Short stage word for labels and titles. */
export function observationShortStage(stage: NativeObservationStage): string {
	return stage === "admission-observed" ? "admission" : "post-result";
}

/** The path this record names, as the producer displayed it (workspace-relative). */
export function observationPathLabel(record: NativeFileObservationRecord): string {
	return record.target.displayPath ?? record.target.raw;
}

/** Local wall-clock time of an observation; a duration is not what a user reads. */
export function observationClock(observedAtMs: number): string {
	const date = new Date(observedAtMs);
	const parts = [date.getHours(), date.getMinutes(), date.getSeconds()];
	return parts.map(value => String(value).padStart(2, "0")).join(":");
}

/** One line of the facts a picker item shows without opening anything. */
export function observationSummaryLine(record: NativeFileObservationRecord): string {
	const facts = record.observation;
	const bytes = facts.byteLength === null ? "no bytes stored" : `${facts.byteLength} B`;
	return (
		`${observationClock(record.observedAtMs)} · ${observationShortStage(record.stage)} · ${record.toolCall.toolName} · ` +
		`${facts.presence}/${facts.consistency}/${facts.contentKind} · ${bytes}`
	);
}

/**
 * Everything a user should be able to read about one observation before acting
 * on it: stage, provenance, what was compared, what the journal knows about the
 * call, and the three limits of the evidence.
 */
export function observationDetailLines(
	record: NativeFileObservationRecord,
	resolution: NativeFileObservationResolution | null,
	text: ObservationTextState,
): readonly string[] {
	const facts = record.observation;
	const origin = record.origin;
	const lines = [
		`stage: ${observationStageText(record.stage)}`,
		`observed: ${new Date(record.observedAtMs).toISOString()} (sequence ${record.sequence})`,
		`tool: ${record.toolCall.toolName}, call ${record.toolCall.toolCallId}, occurrence ${record.toolCall.occurrence}, reported outcome ${record.toolOutcome}`,
		`coverage for this call: ${resolution === null ? "no call view could be derived" : observationResolutionText(resolution)}`,
		`target: ${record.target.kind} ${observationPathLabel(record)}${record.target.pathDigest === null ? " (no path identity)" : ""}`,
		`state: presence ${facts.presence}, consistency ${facts.consistency}, content ${facts.contentKind}`,
		`bytes: ${facts.byteLength === null ? "none stored" : `${facts.byteLength} (digest ${facts.blobId ?? "unknown"})`}`,
		`compared around the read: ${facts.comparedFields.length === 0 ? "nothing reported" : facts.comparedFields.join(", ")}`,
		`shown as: ${text.text === null ? `not shown — ${text.reason}` : `${text.readability} text`}`,
		`producer: slot ${origin.slotId}, instance ${origin.processInstanceId}, epoch ${origin.producerEpoch}`,
	];
	if (text.storedReason !== null) lines.push(`stored reason: ${text.storedReason}`);
	if (record.notes.length > 0) lines.push(`record notes: ${record.notes.join(", ")}`);
	lines.push(OBSERVATION_PREIMAGE_NOTE, OBSERVATION_COVERAGE_NOTE, OBSERVATION_NO_RESTORE_NOTE);
	return lines;
}

/** Title of a VS Code diff between two observations of one path. */
export function observationComparisonTitle(pair: ObservationPair): string {
	return (
		`${observationPathLabel(pair.current)} — ${observationShortStage(pair.previous.stage)} ` +
		`${observationClock(pair.previous.observedAtMs)} → ${observationShortStage(pair.current.stage)} ` +
		`${observationClock(pair.current.observedAtMs)}`
	);
}

function describeSide(label: string, state: ObservationTextState): string {
	switch (state.readability) {
		case "absent":
			return `${label}: the file was absent, which is not the same as zero bytes`;
		case "empty":
			return `${label}: the file was present and empty (0 bytes)`;
		case "binary":
			return `${label}: binary content was stored and is not shown as text`;
		case "unsupported":
			return `${label}: ${state.reason ?? "the target is not a plain text file"}`;
		case "oversize":
			return `${label}: ${state.reason ?? "the record is above the size the reader accepts"}`;
		case "unavailable":
			return `${label}: ${state.reason ?? "the stored bytes could not be validated"}`;
		default:
			return `${label}: text was stored`;
	}
}

/**
 * The sentence shown instead of a diff when at least one side has no stored
 * text. `null` means both sides are renderable and a diff is honest.
 */
export function observationComparisonNotice(
	previous: ObservationTextState,
	current: ObservationTextState,
): string | null {
	if (observationTextAvailable(previous) && observationTextAvailable(current)) return null;
	return (
		`${describeSide("Earlier observation", previous)}. ${describeSide("Later observation", current)}. ` +
		"No text diff is shown while either side has no validated stored text."
	);
}

/** Per-call coverage view by the key {@link observationCallKey} produces. */
export function observationCallViews(
	records: readonly NativeFileObservationRecord[],
): Map<string, NativeFileObservationCallView> {
	const views = new Map<string, NativeFileObservationCallView>();
	for (const view of summarizeNativeFileObservations(records)) {
		const sample = view.admission[0] ?? view.result[0];
		if (sample !== undefined) views.set(observationCallKey(sample), view);
	}
	return views;
}
