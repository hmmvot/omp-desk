/**
 * The row and host vocabulary of the session index: the types every side names and
 * the predicates that only inspect them.
 *
 * This is a leaf: it holds no I/O and imports nothing from `src/host/`. The catalog
 * (`session-index.ts`), the ownership policy (`session-availability.ts`) and the
 * launch, reconcile and deletion modules all name these shapes, so they live
 * below all of them.
 */

/** What this extension currently knows about a session's ownership. */
export type SessionAvailability = "draft" | "live" | "saved" | "failed";

/**
 * Durable run intent: what the user last asked this extension to keep running.
 *
 * It is deliberately separate from {@link SessionAvailability} and from whether
 * an editor is open, because both of those are observations that can be gone
 * while the intent stays: a closed editor must not turn a running session into a
 * stopped one, and a crashed extension host must not turn an explicitly closed
 * session into a startable one. A row is `running` only while the user has asked
 * for it to run and no explicit close, confirmed native exit or verified
 * retirement has since set it to `stopped`. Activation may reattach a
 * previously running verified survivor; it never starts a row whose intent is
 * `stopped`.
 */
export type RunIntent = "running" | "stopped";

/** Launch scope an entry must be reopened with. */
export interface OmpLaunchScope {
	/**
	 * OMP profile (`--profile`), or `null` for the default profile.
	 *
	 * `null` is "the default profile", not "whatever profile the launched process
	 * happens to inherit": a launcher MUST select the default profile explicitly
	 * (OMP's own `--profile default` sentinel) so an `OMP_PROFILE`/`PI_PROFILE`
	 * inherited from the extension host cannot hand a session that recorded no
	 * named profile to a named one.
	 */
	readonly profile: string | null;
	/** Explicit OMP session directory (`--session-dir`), or `null` to let OMP derive it. */
	readonly sessionDir: string | null;
}

/**
 * The last launch attempt this extension recorded for an entry.
 *
 * Usually the host that was launched: its broker slot and child process, plus the
 * session id it reported. It is also written *before* a launch is attempted, with
 * every identity field `null` — a window that dies between starting a native
 * process and reading its outcome leaves exactly that behind, and it is the state
 * nothing can prove absent. A completed pass overwrites it with the real identity,
 * restores the record the row carried when the launcher reported that nothing
 * started, or (an unconfirmed outcome) leaves the identity-less record standing.
 */
export interface RecordedRpcIdentity {
	/** Durable broker slot the conversation's `managed-rpc` child runs under. */
	readonly slot: string;
	readonly brokerId: string;
	/** Per-broker-start generation. */
	readonly brokerGeneration: string;
	readonly brokerPid: number;
	readonly brokerCreationTime: string | null;
	/** The OMP process itself; `null` until the launch outcome read it. */
	readonly childPid: number | null;
	readonly childCreationTime: string | null;
}

export interface RecordedHost {
	/** The OMP child's pid (mirrors {@link RecordedRpcIdentity.childPid}); `null` until its outcome is read. */
	readonly pid: number | null;
	/** Parse-only: a Collab-era record's host identity. Nothing writes it any more. */
	readonly instanceId: string | null;
	/** Parse-only: a Collab-era record's room generation. Nothing writes it any more. */
	readonly generation: number | null;
	readonly sessionId: string | null;
	readonly startedAt: string;
	/** Explicit managed transport; absent denotes a historical Collab-era host. */
	readonly transport?: "rpc" | "native";
	/** Shared exact broker/root identity; the persisted field name predates native mode. */
	readonly rpc?: RecordedRpcIdentity | null;
}

/** Whether a recorded host is a launch of this build's rpc transport. */
export function isRpcHost(host: RecordedHost | null): host is RecordedHost & { readonly transport: "rpc" } {
	return host !== null && host.transport === "rpc";
}

export type SessionViewMode = "chat" | "terminal";
export type NativeHostTransferOutcome =
	| { readonly status: "bound"; readonly binding: EditorSlotBinding }
	| { readonly status: "refused"; readonly kind: "changed" | "conflict" | "unavailable"; readonly detail: string };

export function isManagedHost(host: RecordedHost | null): host is RecordedHost & { readonly transport: "rpc" | "native" } {
	return host !== null && (host.transport === "rpc" || host.transport === "native");
}

/** Structural check for a persisted {@link RecordedRpcIdentity}. */
export function isRecordedRpcIdentity(value: unknown): value is RecordedRpcIdentity {
	if (typeof value !== "object" || value === null) return false;
	const rpc = value as Partial<Record<keyof RecordedRpcIdentity, unknown>>;
	return (
		typeof rpc.slot === "string" &&
		typeof rpc.brokerId === "string" &&
		typeof rpc.brokerGeneration === "string" &&
		typeof rpc.brokerPid === "number" &&
		(rpc.brokerCreationTime === null || typeof rpc.brokerCreationTime === "string") &&
		(rpc.childPid === null || typeof rpc.childPid === "number") &&
		(rpc.childCreationTime === null || typeof rpc.childCreationTime === "string")
	);
}

/**
 * The claim this extension took (or reserved) for an entry.
 *
 * `ownerGeneration` is the generation used for the atomic claim, `draftIdentity`
 * is the reserved identity the session had before a file existed, and
 * `releasedAt` is set only after a confirmed stop released the claim.
 */
export interface RecordedOwnership {
	readonly ownerGeneration: string;
	readonly draftIdentity: string | null;
	readonly releasedAt: string | null;
}

/**
 * Where an entry's session file came from. This is provenance for the
 * destructive paths, not a permission to resume: an `imported` row is claimed,
 * reconciled, launched and shown exactly like an `extension` one.
 *
 * - `extension` — this extension reserved the tab as a draft and created the
 *   session file its index records.
 * - `imported` — the tab was registered from a session file this extension found
 *   in OMP's own history. The exact file, its profile and its session directory
 *   are kept as discovered, and the file itself is never deleted by this
 *   extension.
 */
export type SessionOrigin = "extension" | "imported";

/**
 * What an imported row is, in one sentence the launcher row, its tooltip and the
 * index share. It states the provenance and the boundary of the guarantee — an
 * external OMP process is not excluded — without claiming that anything is
 * refused because of it.
 */
export const IMPORTED_SESSION_DETAIL =
	"Saved in OMP history. Resume to continue this conversation. Close it in any other app before making changes.";

/**
 * The origin of a row, including one written before the field existed
 * (`undefined`, or any value a hand-edit left behind).
 *
 * The derivation is fail-closed about *provenance*: `createDraft` always reserves
 * a draft identity and nothing clears it, so a row that holds one is provably
 * this extension's own, while a row without one may have been imported and is
 * never reported as created by this extension. It is applied whenever a row is
 * cloned, so a row from an older version is resolved at load and persisted in its
 * resolved form from then on. `unmanaged` is the value an earlier version wrote
 * for the same thing; it is read as `imported`.
 */
export function resolveSessionOrigin(
	origin: unknown,
	ownership: RecordedOwnership | null | undefined,
): SessionOrigin {
	if (origin === "extension") return "extension";
	if (origin === "imported" || origin === "unmanaged") return "imported";
	return ownership?.draftIdentity != null ? "extension" : "imported";
}

/** One stable UI tab: a draft or a materialized session. */
export interface SessionIndexEntry {
	/** Stable editor-tab identity; survives draft promotion and window restart. */
	readonly tabId: string;
	/** `draft` until a session file exists, `session` afterwards. */
	readonly kind: "draft" | "session";
	/**
	 * Whether this extension created the tab or registered a file it found in
	 * OMP's own history. Provenance for the destructive paths only; both origins
	 * resume (see {@link SessionOrigin}).
	 */
	readonly origin: SessionOrigin;
	/** Exact materialized session file, or `null` while the entry is a draft. */
	readonly sessionFile: string | null;
	/** OMP session id when known (session header read, or a host report). */
	readonly sessionId: string | null;
	/** Normalized working directory the session belongs to. */
	readonly cwd: string;
	/** Scope the host must be relaunched with. */
	readonly scope: OmpLaunchScope;
	/** Effective OMP session directory, when observed. */
	readonly sessionDir: string | null;
	/** Claim owner generation and reserved draft identity, when one was taken. */
	readonly ownership: RecordedOwnership | null;
	/** Last host this extension launched, when one was launched. */
	readonly host: RecordedHost | null;
	readonly createdAt: string;
	/**
	 * When this extension's bookkeeping last touched the row: created, restored,
	 * reattached, promoted, focused, or marked failed or conflicting.
	 *
	 * It only recovers which tab to focus ({@link SessionIndex.activeTabId}) and is
	 * **not** conversation activity: the Sessions view's "Last activity" is read
	 * from the session file ({@link readSessionFileActivity}). The name stays
	 * because the shared catalog persists it and every build validates it there.
	 */
	readonly lastActiveAt: string;
	/** Monotonic tab order; {@link SessionIndex.restoreAll} restores in this order. */
	readonly ordinal: number;
	/** Last observed availability (see {@link classifySessionAvailability} for the policy). */
	readonly availability: SessionAvailability;
	/** Human-readable reason for the last observed availability. */
	readonly detail: string | null;
	/** Durable run intent, recorded separately from {@link availability}. */
	readonly runIntent: RunIntent;
	/**
	 * Last native title this extension observed for the conversation, or `null`.
	 *
	 * It is a cache of what OMP stored, never a VS Code-only alias: the row's
	 * label prefers the exact file's own title slot ({@link readSessionFileHeader})
	 * and falls back to this, then to the stable per-conversation ordinal label.
	 */
	readonly title: string | null;
	/**
	 * Stable identity of the last completed assistant reply, or `null`.
	 *
	 * "Answer ready" is a comparison of two identities, not a boolean: the row is
	 * unread while `lastCompletedReplyId` names a reply the user has not seen, and
	 * a later completion replaces the identity instead of clearing a flag.
	 */
	readonly lastCompletedReplyId: string | null;
	/** Stable identity of the last reply that was actually displayed, or `null`. */
	readonly lastSeenReplyId: string | null;
	/**
	 * Set when importing older per-workspace state found a row with this tab
	 * identity that disagreed with the row already held, or when the row's own
	 * source was internally inconsistent.
	 *
	 * It is a *shared* fact and deliberately sticky: while it is set, nothing may
	 * launch, attach, transfer or release this row, because two records claim to be
	 * it and no timestamp decides which one is the user's. Removing the row and
	 * resuming its exact file again registers one clean row, which is the resolution.
	 *
	 * Absent (or `null`) on every row no legacy source disagreed about, which is
	 * every row this version writes itself.
	 */
	readonly importConflict?: SessionImportConflict | null;
}

/** One legacy source's disagreement about a row, retained so it stays visible. */
export interface SessionImportConflict {
	/** Source that carried the rejected record, e.g. `workspaceState:1790429061985`. */
	readonly source: string;
	readonly reason: string;
	readonly at: string;
}

// Editor slots

/**
 * Which role a bound editor slot plays for its conversation.
 *
 * `controlling` is the one editor whose commands, composer and Reload target the
 * conversation; `passive` is a second editor of the same conversation, kept so
 * an unsent draft is neither lost nor able to start a second writer. A passive
 * slot never issues a native operation.
 */
export type EditorSlotRole = "controlling" | "passive";

/**
 * Durable binding of one immutable editor slot to the conversation it currently
 * controls.
 *
 * The slot is VS Code's editor identity and never changes; the conversation it
 * controls changes only by binding the slot again. `generation` increases with
 * every change of conversation or role, so a stale Webview credential or queued
 * callback can be told apart from the current binding without comparing
 * conversation identities.
 */
export interface EditorSlotBinding {
	readonly slotId: string;
	readonly tabId: string;
	readonly generation: number;
	readonly role: EditorSlotRole;
	readonly mode?: SessionViewMode;
	readonly committedAt: string;
	/**
	 * Why this editor is not controlling, when its editor asked to be.
	 *
	 * Controller election is claim-bound (ADR-0034, narrowed by ADR-0039 for rows
	 * no one owns): a window restoring a row whose writer a verified rival holds
	 * publishes a *passive* binding with this reason instead of demoting the
	 * incumbent. It is `null` for a binding that got the role it asked for.
	 */
	readonly roleRefusal?: string | null;
}

/**
 * Descriptor of a launched native host, owned by the caller's integration.
 *
 * It carries only what the index records for later reconciliation: the process
 * id, the broker and child identity, and the OMP session id the host reported.
 * Stopping the host stays the integration's own concern — the
 * index never calls into it — and the confirmation comes back as
 * {@link CloseSessionOptions.confirmedStopped}.
 */
export interface OmpHostHandle {
	readonly pid: number | null;
	/** Session id the host reported; the only source for a draft, which has no header yet. */
	readonly sessionId: string | null;
	/** The broker/child identity the launch or attach observed. */
	readonly rpc: RecordedRpcIdentity | null;
	readonly transport?: "rpc" | "native";
}
