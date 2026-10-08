/**
 * Native-side file-evidence observer: the entry point the OMP `-e` host
 * extension wires into its `tool_call` / `tool_result` hooks.
 *
 * Implements the producer half of
 * [Observe Native OMP File Changes Before Offering Guarded Reversal](../../docs/designs/2026-09-24-native-file-observation-and-reversibility.md)
 * under
 * [ADR-0007](../../docs/decisions/0007-native-file-evidence-and-guarded-restore.md).
 * Five properties this file must never break:
 *
 * 1. **Inert without explicit consent and verified storage.** A freshly created
 *    observer writes nothing until a granted consent record exists for this
 *    exact owner/slot/workspace/session binding *and* the store passed
 *    {@link verifyNativeFileObservationStorage}. Otherwise every stage call
 *    returns `unavailable` with the reason and the native tool runs untouched.
 * 2. **Bounded and never blocking for long.** Each stage is raced against
 *    `limits.maxObservationMs`; a stage that does not settle in time resolves
 *    `timed-out` and its leftover work is fenced. Nothing here ever returns a
 *    cancellation, so an expected failure cannot deny or delay an OMP tool
 *    beyond that budget.
 * 3. **Interval observations only.** Records carry `admission-observed` or
 *    `observed-post-result`; no API in this module labels a record an
 *    attributable per-operation preimage or postimage, and no API applies one.
 * 4. **Storage facts come from the store, not the caller.** The namespace is
 *    derived from the live session binding, the byte limits are the policy
 *    module's, and a commit that names another owner/session is refused.
 * 5. **No restore.** There is deliberately no undo, redo, rollback or write
 *    path here; automatic reversal stays unavailable until both the attributable
 *    evidence gate and a verified Windows exclusion mechanism exist.
 *
 * The OMP surface this is written against is cited in
 * `host/native-file-observation.ts`. OMP invokes `tool_call` handlers before
 * the tool executes, and a handler that hangs blocks the tool
 * (pi-coding-agent `src/extensibility/extensions/runner.ts`), which is why the
 * hook adapter here is bounded and never rejects.
 */

import path from "node:path";
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from "node:timers";

import * as fs from "node:fs/promises";

import {
	NATIVE_FILE_OBSERVATION_LIMITS,
	NATIVE_FILE_OBSERVATION_LIMIT_CEILINGS,
	NativeFileObservationConfigurationError,
	type NativeFileObservationLimits,
	type NativeFileObservationRecord,
	type NativeFileObservationResolution,
	type NativeObservationStage,
	type NativeObservationTarget,
	type NativeObservationTargetKind,
	classifyNativeObservationTarget,
	extractNativeObservationTargets,
	isNativeObservationDigest,
	nativeFileObservationRecordId,
	nativeObservationDigestText,
	nativeObservationPathDigest,
	observeNativeFileState,
	parseNativeFileObservationRecord,
	resolveNativeFileObservationLimits,
	summarizeNativeFileObservations,
} from "../host/native-file-observation.ts";
import {
	NATIVE_FILE_OBSERVATION_DISCLOSURE,
	NATIVE_FILE_OBSERVATION_DISCLOSURE_ID,
	NativeFileObservationStoreError,
	type NativeFileObservationConsent,
	type NativeFileObservationConsentGrant,
	type NativeFileObservationConsentState,
	type NativeFileObservationDeleteResult,
	type NativeFileObservationDeleteScope,
	type NativeFileObservationDisableState,
	type NativeFileObservationJournal,
	type NativeFileObservationJournalMode,
	type NativeFileObservationListResult,
	type NativeFileObservationReadResult,
	type NativeFileObservationStorageProbe,
	type NativeFileObservationStorageReadiness,
	type NativeFileObservationStorageRestriction,
	type NativeFileObservationStorePaths,
	deleteNativeFileObservationHistory,
	disableNativeFileObservationCapture,
	grantNativeFileObservationConsent,
	openNativeFileObservationJournal,
	readNativeFileObservationConsent,
	readNativeFileObservationDisable,
	resolveNativeFileObservationStorePaths,
	restrictNativeFileObservationStorage,
	revokeNativeFileObservationConsent,
	verifyNativeFileObservationStorage,
} from "../host/native-file-observation-storage.ts";

export {
	NATIVE_FILE_OBSERVATION_DISCLOSURE,
	NATIVE_FILE_OBSERVATION_DISCLOSURE_ID,
	NATIVE_FILE_OBSERVATION_LIMITS,
	NATIVE_FILE_OBSERVATION_LIMIT_CEILINGS,
	NativeFileObservationConfigurationError,
	NativeFileObservationStoreError,
	classifyNativeObservationTarget,
	deleteNativeFileObservationHistory,
	disableNativeFileObservationCapture,
	extractNativeObservationTargets,
	grantNativeFileObservationConsent,
	isNativeObservationDigest,
	nativeFileObservationRecordId,
	nativeObservationDigestText,
	nativeObservationPathDigest,
	observeNativeFileState,
	openNativeFileObservationJournal,
	parseNativeFileObservationRecord,
	readNativeFileObservationConsent,
	readNativeFileObservationDisable,
	resolveNativeFileObservationLimits,
	resolveNativeFileObservationStorePaths,
	restrictNativeFileObservationStorage,
	revokeNativeFileObservationConsent,
	summarizeNativeFileObservations,
	verifyNativeFileObservationStorage,
};
export type {
	NativeFileObservationConsent,
	NativeFileObservationConsentGrant,
	NativeFileObservationConsentState,
	NativeFileObservationDeleteResult,
	NativeFileObservationDeleteScope,
	NativeFileObservationDisableState,
	NativeFileObservationJournal,
	NativeFileObservationJournalMode,
	NativeFileObservationLimits,
	NativeFileObservationListResult,
	NativeFileObservationReadResult,
	NativeFileObservationRecord,
	NativeFileObservationResolution,
	NativeFileObservationStorageProbe,
	NativeFileObservationStorageReadiness,
	NativeFileObservationStorageRestriction,
	NativeFileObservationStorePaths,
	NativeObservationStage,
	NativeObservationTarget,
	NativeObservationTargetKind,
};

// Binding

/** Identities that select one evidence namespace; every field is caller-supplied. */
export interface FileEvidenceStoreRef {
	/** Absolute extension-owned directory outside the workspace. */
	readonly storageRoot: string;
	readonly ownerId: string;
	readonly slotId: string;
	readonly workspaceRoot: string;
	readonly sessionId: string;
}

export interface FileEvidenceNamespace {
	readonly ok: true;
	readonly paths: NativeFileObservationStorePaths;
}

export interface FileEvidenceNamespaceFailure {
	readonly ok: false;
	readonly reason: string;
}

/**
 * Resolve a binding to its namespace without throwing, so a caller can treat an
 * unusable binding as "capture off" instead of an exception inside a hook.
 */
export function resolveFileEvidenceNamespace(ref: FileEvidenceStoreRef): FileEvidenceNamespace | FileEvidenceNamespaceFailure {
	try {
		return { ok: true, paths: resolveNativeFileObservationStorePaths(ref) };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : "the evidence namespace could not be derived" };
	}
}

/** Live session the observer is currently bound to. */
export interface FileEvidenceSessionRef {
	readonly sessionId: string;
	readonly sessionFile: string | null;
	readonly cwd: string;
}

export interface FileEvidenceObserverOptions {
	readonly storageRoot: string;
	readonly ownerId: string;
	readonly slotId: string;
	readonly workspaceRoot: string;
	/** Kernel-level instance identity of this native host process. */
	readonly processInstanceId: string;
	/** Producer epoch; defaults to {@link processInstanceId}. A restart must pass a new one. */
	readonly producerEpoch?: string;
	/** Fallback session source; `noteContext` feeds the same slot from OMP's own context. */
	readonly session?: () => FileEvidenceSessionRef | null;
	readonly limits?: Partial<NativeFileObservationLimits>;
	readonly now?: () => number;
	readonly probe?: NativeFileObservationStorageProbe;
}

export interface FileEvidenceStatus {
	readonly captureEnabled: boolean;
	readonly reason: string | null;
	readonly storeDirectory: string | null;
	readonly readiness: NativeFileObservationStorageReadiness | null;
	/** Namespace key the observer last resolved, `null` before a live session existed. */
	readonly sessionKey: string | null;
}

export type FileEvidenceOutcomeReason =
	| "captured"
	| "disabled"
	| "no-consent"
	| "storage-unavailable"
	| "no-session"
	| "unaddressable"
	| "timed-out"
	| "internal-error"
	| "closed";

/** What one stage observed; `observations` is one entry per named target. */
export interface FileEvidenceObservationSummary {
	readonly raw: string;
	readonly kind: NativeObservationTargetKind;
	readonly displayPath: string | null;
	readonly recordId: string | null;
	readonly storedBytes: boolean;
	readonly unavailableReason: string | null;
}

export interface FileEvidenceOutcome {
	readonly outcome: FileEvidenceOutcomeReason;
	readonly stage: NativeObservationStage;
	readonly reason: string | null;
	readonly elapsedMs: number;
	readonly observations: readonly FileEvidenceObservationSummary[];
}

export interface FileEvidenceObserver {
	/** Cache of the last gate evaluation; never performs I/O. */
	status(): FileEvidenceStatus;
	/** Feed OMP's live extension context so the namespace follows the session. */
	noteContext(context: unknown): void;
	/** Observe the bytes present when the tool was admitted. */
	admitToolCall(call: FileEvidenceToolCall): Promise<FileEvidenceOutcome>;
	/** Observe the bytes present after the tool reported, including after an error. */
	observeToolResult(result: FileEvidenceToolResult): Promise<FileEvidenceOutcome>;
	/** Re-read consent, disablement and storage readiness; safe to call anytime. */
	reload(): Promise<FileEvidenceStatus>;
	close(): Promise<void>;
}

export interface FileEvidenceToolCall {
	readonly toolCallId: unknown;
	readonly toolName: unknown;
	readonly input: unknown;
}

export interface FileEvidenceToolResult extends FileEvidenceToolCall {
	readonly isError: unknown;
}

// Deadline handling

/**
 * Resolve promptly when `work` exceeds `ms`. Abandoned filesystem work can
 * still be in flight; callers must check the deadline before publishing, and
 * deletion must not run against a live producer.
 */
function settleWithin<T>(work: Promise<T>, alternative: (kind: "timeout" | "error") => T, ms: number): Promise<T> {
	const { promise, resolve } = Promise.withResolvers<T>();
	const timer = setNodeTimeout(() => {
		work.then(
			() => {},
			() => {},
		);
		resolve(alternative("timeout"));
	}, ms);
	work.then(
		value => {
			clearNodeTimeout(timer);
			resolve(value);
		},
		() => {
			clearNodeTimeout(timer);
			resolve(alternative("error"));
		},
	);
	return promise;
}

// Observer

const IDENTITY_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const LEDGER_CAPACITY = 4096;

interface GateDecision {
	readonly allowed: true;
	readonly session: FileEvidenceSessionRef;
	readonly paths: NativeFileObservationStorePaths;
	readonly journal: NativeFileObservationJournal;
	readonly physicalWorkspaceRoot: string;
}

interface GateRefusal {
	readonly allowed: false;
	readonly outcome: FileEvidenceOutcomeReason;
	readonly reason: string;
}

/**
 * Create the observer the native extension wires into its hooks.
 *
 * The observer starts inert: it holds no bytes and writes nothing until a stage
 * call finds a granted consent record and a verified store. Construction never
 * throws and never performs I/O beyond the first stage call.
 */
export function createFileEvidenceObserver(options: FileEvidenceObserverOptions): FileEvidenceObserver {
	const now = options.now ?? Date.now;
	let limits: NativeFileObservationLimits | null = null;
	let limitsReason: string | null = null;
	try {
		limits = resolveNativeFileObservationLimits(options.limits);
	} catch (error) {
		limitsReason = error instanceof Error ? error.message : "the observation limits are unusable";
	}
	const producerEpoch =
		typeof options.producerEpoch === "string" && IDENTITY_RE.test(options.producerEpoch)
			? options.producerEpoch
			: options.processInstanceId;
	const identityUsable = IDENTITY_RE.test(options.processInstanceId) && IDENTITY_RE.test(producerEpoch);

	let session: FileEvidenceSessionRef | null = options.session?.() ?? null;
	let journal: NativeFileObservationJournal | null = null;
	let journalKey: string | null = null;
	let readiness: NativeFileObservationStorageReadiness | null = null;
	let readinessKey: string | null = null;
	let physicalWorkspaceRoot: string | null = null;
	let status: FileEvidenceStatus = {
		captureEnabled: false,
		reason:
			limitsReason ??
			(identityUsable ? "no observation has been attempted yet" : "the producer identity is not usable"),
		storeDirectory: null,
		readiness: null,
		sessionKey: null,
	};
	let closed = false;
	const ledger = new Map<string, number>();

	function noteSession(next: FileEvidenceSessionRef | null): void {
		session = next;
	}

	function refusal(outcome: FileEvidenceOutcomeReason, reason: string, stage: NativeObservationStage, startedAt: number, observations: readonly FileEvidenceObservationSummary[] = []): FileEvidenceOutcome {
		return {
			outcome,
			stage,
			reason,
			elapsedMs: Math.max(0, now() - startedAt),
			observations,
		};
	}

	/** One gate pass: identity, live session, disable marker, consent, readiness. */
	async function evaluateGates(): Promise<GateDecision | GateRefusal> {
		if (closed) return { allowed: false, outcome: "closed", reason: "the observer is closed" };
		if (limits === null) {
			return { allowed: false, outcome: "storage-unavailable", reason: limitsReason ?? "the limits are unusable" };
		}
		if (!identityUsable) {
			return { allowed: false, outcome: "storage-unavailable", reason: "the producer identity is not usable" };
		}
		const live = session ?? options.session?.() ?? null;
		if (live === null) {
			status = { ...status, captureEnabled: false, reason: "no live OMP session context has been observed yet" };
			return { allowed: false, outcome: "no-session", reason: "no live OMP session context has been observed yet" };
		}
		session = live;
		const ref: FileEvidenceStoreRef = {
			storageRoot: options.storageRoot,
			ownerId: options.ownerId,
			slotId: options.slotId,
			workspaceRoot: options.workspaceRoot,
			sessionId: live.sessionId,
		};
		const namespace = resolveFileEvidenceNamespace(ref);
		if (!namespace.ok) {
			status = { ...status, captureEnabled: false, reason: namespace.reason, sessionKey: null };
			return { allowed: false, outcome: "storage-unavailable", reason: namespace.reason };
		}
		const paths = namespace.paths;
		// Disablement and consent are read before any directory is created, so an
		// observer that is not enabled leaves no trace at all.
		const disabled = await readNativeFileObservationDisable({ paths });
		if (disabled.disabled) {
			const reason = `capture is disabled for this workspace (${disabled.reason ?? "no reason recorded"})`;
			status = {
				captureEnabled: false,
				reason,
				storeDirectory: paths.storageRoot,
				readiness,
				sessionKey: paths.sessionDigest,
			};
			return { allowed: false, outcome: "disabled", reason };
		}
		const consent = await readNativeFileObservationConsent({ paths });
		if (consent.state !== "granted") {
			const reason = `byte capture needs explicit consent for this workspace and session (${consent.reason})`;
			status = {
				captureEnabled: false,
				reason,
				storeDirectory: paths.storageRoot,
				readiness,
				sessionKey: paths.sessionDigest,
			};
			return { allowed: false, outcome: "no-consent", reason };
		}
		if (readiness === null || physicalWorkspaceRoot === null || readinessKey !== paths.sessionDigest) {
			readiness = await verifyNativeFileObservationStorage({ paths, ...(options.probe ? { probe: options.probe } : {}) });
			readinessKey = paths.sessionDigest;
			physicalWorkspaceRoot = readiness.ready ? await fs.realpath(paths.workspaceRoot).catch(() => null) : null;
			if (!readiness.ready || physicalWorkspaceRoot === null) {
				const reason =
					readiness.reason ?? "the workspace root has no physical form to check targets against";
				status = {
					captureEnabled: false,
					reason,
					storeDirectory: paths.storageRoot,
					readiness,
					sessionKey: paths.sessionDigest,
				};
				return { allowed: false, outcome: "storage-unavailable", reason };
			}
		}
		if (journal === null || journalKey !== paths.sessionDigest) {
			await journal?.close();
			journal = await openNativeFileObservationJournal({ paths, mode: "producer", limits });
			journalKey = paths.sessionDigest;
		}
		status = {
			captureEnabled: true,
			reason: null,
			storeDirectory: paths.storageRoot,
			readiness,
			sessionKey: paths.sessionDigest,
		};
		return { allowed: true, session: live, paths, journal, physicalWorkspaceRoot };
	}

	/** Assign the occurrence counter for one admission, evicting the oldest entry. */
	function occurrenceFor(toolCallId: string): number {
		const current = ledger.get(toolCallId);
		if (current !== undefined) return current;
		for (const key of ledger.keys()) {
			if (ledger.size < LEDGER_CAPACITY) break;
			ledger.delete(key);
		}
		ledger.set(toolCallId, 0);
		return 0;
	}

	async function observe(
		stage: NativeObservationStage,
		call: FileEvidenceToolCall,
		toolOutcome: "unknown" | "success" | "error",
	): Promise<FileEvidenceOutcome> {
		const startedAt = now();
		if (limits === null) {
			return refusal("storage-unavailable", limitsReason ?? "the limits are unusable", stage, startedAt);
		}
		const active = limits;
		const deadlineMs = startedAt + active.maxObservationMs;
		return settleWithin(
			runObservation(stage, call, toolOutcome, deadlineMs, active, startedAt),
			kind =>
				refusal(
					kind === "timeout" ? "timed-out" : "internal-error",
					kind === "timeout"
						? `the observation did not finish within ${active.maxObservationMs}ms; the tool is unaffected`
						: "the observation failed unexpectedly; the tool is unaffected",
					stage,
					startedAt,
				),
			active.maxObservationMs,
		);
	}

	async function runObservation(
		stage: NativeObservationStage,
		call: FileEvidenceToolCall,
		toolOutcome: "unknown" | "success" | "error",
		deadlineMs: number,
		active: NativeFileObservationLimits,
		startedAt: number,
	): Promise<FileEvidenceOutcome> {
		const gate = await evaluateGates();
		if (!gate.allowed) return refusal(gate.outcome, gate.reason, stage, startedAt);

		const toolCallId = typeof call.toolCallId === "string" && call.toolCallId.length > 0 && call.toolCallId.length <= 200
			? call.toolCallId
			: null;
		const toolName = typeof call.toolName === "string" && call.toolName.length > 0 && call.toolName.length <= 64
			? call.toolName
			: null;
		if (toolCallId === null || toolName === null) {
			return refusal("unaddressable", "the tool event carried no usable call identity", stage, startedAt);
		}
		const extraction = extractNativeObservationTargets({ toolName, input: call.input, limits: active });
		if (extraction.rawPaths.length === 0) {
			return refusal(
				"unaddressable",
				extraction.unaddressableReason ?? "the tool named no local file to observe",
				stage,
				startedAt,
			);
		}
		const occurrence = stage === "admission-observed" ? occurrenceFor(toolCallId) : (ledger.get(toolCallId) ?? 0);
		const sessionFileDigest =
			gate.session.sessionFile === null ? null : nativeObservationPathDigest(gate.session.sessionFile);
		const observations: FileEvidenceObservationSummary[] = [];

		for (const rawPath of extraction.rawPaths.slice(0, active.maxPathsPerToolCall)) {
			if (now() > deadlineMs) {
				observations.push({
					raw: rawPath.slice(0, active.maxRawPathChars),
					kind: "unsupported-path-shape",
					displayPath: null,
					recordId: null,
					storedBytes: false,
					unavailableReason: "the observation deadline passed before this target was read",
				});
				continue;
			}
			const target = classifyNativeObservationTarget({
				rawPath,
				cwd: gate.session.cwd.length > 0 ? gate.session.cwd : options.workspaceRoot,
				workspaceRoot: options.workspaceRoot,
				limits: active,
			});
			const state = await observeNativeFileState({ target, physicalWorkspaceRoot: gate.physicalWorkspaceRoot, limits: active, now });
			// The hook can already have returned a timeout, or consent may have
			// been revoked while filesystem I/O was outstanding. Never start a
			// publication in either case. An already-started journal publication
			// remains in flight; history deletion therefore requires a stopped
			// native producer.
			const disabled = await readNativeFileObservationDisable({ paths: gate.paths });
			const consent = await readNativeFileObservationConsent({ paths: gate.paths });
			if (closed || now() >= deadlineMs || disabled.disabled || disabled.reason !== null ||
				consent.state !== "granted") {
				observations.push({
					raw: target.raw,
					kind: target.kind,
					displayPath: target.displayPath,
					recordId: null,
					storedBytes: false,
					unavailableReason: "the deadline passed or capture was disabled before publication",
				});
				continue;
			}
			const result = await gate.journal.publish(
				{
					stage,
					observedAtMs: startedAt,
					origin: {
						ownerId: options.ownerId,
						slotId: options.slotId,
						processInstanceId: options.processInstanceId,
						producerEpoch,
					},
					session: {
						sessionId: gate.session.sessionId,
						sessionFileDigest,
						workspaceDigest: gate.paths.workspaceDigest,
					},
					toolCall: { toolCallId, toolName, occurrence },
					target: {
						raw: target.raw,
						kind: target.kind,
						pathDigest: target.absolutePath === null ? null : nativeObservationPathDigest(target.absolutePath),
						displayPath: target.displayPath,
						unavailableReason: target.unavailableReason,
					},
					observation: {
						presence: state.presence,
						consistency: state.consistency,
						contentKind: state.contentKind,
						byteLength: state.byteLength,
						blobId: state.blobId,
						elapsedMs: state.elapsedMs,
						comparedFields: state.comparedFields,
						unavailableReason: state.unavailableReason,
					},
					toolOutcome,
					notes: now() > deadlineMs ? ["deadline-exceeded"] : [],
				},
				state.bytes,
			);
			observations.push({
				raw: target.raw,
				kind: target.kind,
				displayPath: target.displayPath,
				recordId: result.recordId,
				storedBytes: result.published && state.bytes !== null,
				unavailableReason:
					result.published && state.unavailableReason === null ? null : (state.unavailableReason ?? result.detail),
			});
		}

		const stored = observations.filter(observation => observation.recordId !== null).length;
		return {
			outcome: stored > 0 ? "captured" : "unaddressable",
			stage,
			reason:
				stored > 0
					? null
					: (observations[0]?.unavailableReason ?? "no observation could be committed"),
			elapsedMs: Math.max(0, now() - startedAt),
			observations,
		};
	}

	return {
		status(): FileEvidenceStatus {
			return status;
		},
		noteContext(context: unknown): void {
			const next = readSessionFromContext(context);
			if (next !== null) noteSession(next);
		},
		async admitToolCall(call: FileEvidenceToolCall): Promise<FileEvidenceOutcome> {
			return observe("admission-observed", call, "unknown");
		},
		async observeToolResult(result: FileEvidenceToolResult): Promise<FileEvidenceOutcome> {
			return observe("observed-post-result", result, result.isError === true ? "error" : "success");
		},
		async reload(): Promise<FileEvidenceStatus> {
			readiness = null;
			readinessKey = null;
			physicalWorkspaceRoot = null;
			const gate = await evaluateGates().catch(() => null);
			if (gate === null) {
				status = { ...status, captureEnabled: false, reason: "the observation gates could not be evaluated" };
			}
			return status;
		},
		async close(): Promise<void> {
			closed = true;
			await journal?.close().catch(() => {});
			journal = null;
			journalKey = null;
			status = { ...status, captureEnabled: false, reason: "the observer is closed" };
		},
	};
}

/** Read OMP's live session identity out of an extension handler context. */
function readSessionFromContext(context: unknown): FileEvidenceSessionRef | null {
	if (typeof context !== "object" || context === null) return null;
	const manager = (context as { sessionManager?: unknown }).sessionManager;
	if (typeof manager !== "object" || manager === null) return null;
	const read = (name: string): unknown => {
		const method = (manager as Record<string, unknown>)[name];
		if (typeof method !== "function") return undefined;
		try {
			return (method as () => unknown).call(manager);
		} catch {
			return undefined;
		}
	};
	const sessionId = read("getSessionId");
	if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 200) return null;
	const sessionFile = read("getSessionFile");
	const cwd = read("getCwd");
	return {
		sessionId,
		sessionFile: typeof sessionFile === "string" && sessionFile.length > 0 ? sessionFile : null,
		cwd: typeof cwd === "string" && cwd.length > 0 ? path.resolve(cwd) : "",
	};
}

// OMP hook adapter

/**
 * OMP hook signature this adapter produces. Its resolved value is always
 * `undefined`: OMP treats a returned `{ block: true }` as a tool denial, so the
 * adapter never produces one, and a caller that awaits it changes nothing about
 * the tool's outcome.
 */
export type FileEvidenceOmpHook = (event: unknown, context: unknown) => Promise<void>;

export interface FileEvidenceOmpHooks {
	readonly onToolCall: FileEvidenceOmpHook;
	readonly onToolResult: FileEvidenceOmpHook;
}

function readEventField(event: unknown, field: string): unknown {
	if (typeof event !== "object" || event === null) return undefined;
	return (event as Record<string, unknown>)[field];
}

/**
 * Wrap an observer as the two OMP handlers the native extension registers.
 *
 * The handlers await one bounded observation so the admission read happens
 * before the tool executes, refresh the session binding from OMP's own context,
 * swallow every failure, and never return a cancellation.
 */
export function createFileEvidenceHooks(observer: FileEvidenceObserver): FileEvidenceOmpHooks {
	return {
		async onToolCall(event, context) {
			observer.noteContext(context);
			await observer
				.admitToolCall({
					toolCallId: readEventField(event, "toolCallId"),
					toolName: readEventField(event, "toolName"),
					input: readEventField(event, "input"),
				})
				.catch(() => {});
		},
		async onToolResult(event, context) {
			observer.noteContext(context);
			await observer
				.observeToolResult({
					toolCallId: readEventField(event, "toolCallId"),
					toolName: readEventField(event, "toolName"),
					input: readEventField(event, "input"),
					isError: readEventField(event, "isError"),
				})
				.catch(() => {});
		},
	};
}
