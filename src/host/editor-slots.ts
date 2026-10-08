/**
 * The slot-keyed authority for editor identity, role and controller resolution
 * (ADR-0025).
 *
 * VS Code owns whether an editor exists; the SessionIndex owns which conversation a
 * slot *controls*; this registry is the window's own answer to "which slot is the
 * controller of this conversation, and what authority does every other slot showing
 * it have". It exists because one conversation can be shown by more than one editor
 * at a time (a stopped editor the user left with unsent text, and the editor a
 * native switch moved onto that conversation), and because a slot's identity must
 * never be confused with the conversation it currently serves.
 *
 * Two rules it exists to keep:
 *
 * - **A conversation has one controlling slot.** Anything that *acts* — commands,
 *   link delivery, native sends — resolves the controller through
 *   {@link EditorSlotRegistry.controllerOf}, never by taking whichever slot happens
 *   to show that conversation.
 * - **Nothing is keyed by a conversation.** A non-controlling slot keeps its own
 *   entry under its own immutable id, so two passive editors of one conversation
 *   cannot collide, and demoting one never overwrites another. Only the *derived*
 *   conversation→slot pointer moves when a switch settles.
 *
 * What this module owns is identity and authority: which slot controls which
 * conversation, what role every other slot showing it has, and a generation that
 * advances whenever either changes. It deliberately holds no resources and no
 * secrets — the live `WebviewPanel`, document incarnation, bridge endpoint and
 * terminal pipeline are keyed by the same immutable slot id in the extension's own
 * resource map (`tabs` in `src/extension.ts`), whose only way to reach a slot by
 * conversation is the {@link EditorSlotRegistry.controllerOf} answer this registry
 * gives. `src/host/session-index.ts` holds the same binding durably, so a restore
 * resolves a slot's conversation and role from what was committed rather than from
 * the order VS Code happened to revive its editors in.
 *
 * This module is pure: it starts nothing and knows no paths, so the rules above are
 * testable without an extension host.
 */

/** What one editor slot may do with the conversation it shows. */
export type EditorSlotRole = "controlling" | "passive";

/**
 * One immutable editor slot's identity and authority, as this window knows it.
 *
 * Identity and authority only; the slot's resources are named in the module comment
 * above. `slotId` is the immutable editor id (`E`): a conversation may change under
 * it, and it does not change with it.
 */
export interface EditorSlotEntry {
	/** Immutable editor identity: the VS Code editor this slot is, for its lifetime. */
	readonly slotId: string;
	/** The conversation this slot currently shows. */
	readonly tabId: string;
	readonly role: EditorSlotRole;
	/**
	 * Increases on every change of {@link tabId} *or* {@link role}.
	 *
	 * A stale callback, a queued native send and an authenticated page all pin this
	 * value, so a slot that moved on can be told apart from one that merely
	 * re-rendered.
	 */
	readonly generation: number;
	/** Why this slot is not controlling, when it is not. */
	readonly passiveReason: string | null;
}

export interface RegisterSlotInput {
	readonly slotId: string;
	readonly tabId: string;
	readonly role: EditorSlotRole;
	readonly passiveReason?: string | null;
}

export interface EditorSlotRegistry {
	/** Every slot, in insertion order. */
	entries(): readonly EditorSlotEntry[];
	/** One slot, or `null`. */
	get(slotId: string): EditorSlotEntry | null;
	/** The controlling slot of one conversation, or `null`. */
	controllerOf(tabId: string): EditorSlotEntry | null;
	/** Every slot showing one conversation, controlling first. */
	slotsFor(tabId: string): readonly EditorSlotEntry[];
	/**
	 * Insert or update one slot.
	 *
	 * A slot that becomes the controller demotes every other controlling slot of the
	 * same conversation to passive (they keep their entries, their panels and their
	 * drafts) and bumps their generation, because their authority changed.
	 */
	register(input: RegisterSlotInput): EditorSlotEntry;
	/** Drop one slot, returning whether it was known. */
	remove(slotId: string): boolean;
	/**
	 * Move the conversation pointer when a settled switch retires the source slot's
	 * conversation.
	 *
	 * The source slot keeps its own entry (it is still an editor) but is demoted and
	 * re-pointed by the caller through {@link register}; this only reports whether the
	 * conversation now has exactly one controller.
	 */
	isCoherent(tabId: string): boolean;
}

/** `true` when the value is usable as an immutable editor slot id. */
export function isEditorSlotId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

/**
 * Build an empty registry.
 *
 * The registry is derived state: it is rebuilt from the live panels on activation
 * and never persisted, because what must survive a restart is the *durable* role
 * (which SessionIndex records per slot) and the exact editor identity VS Code
 * restores, not this window's transient map.
 */
export function createEditorSlotRegistry(): EditorSlotRegistry {
	const slots = new Map<string, EditorSlotEntry>();

	const demoteRivals = (entry: EditorSlotEntry): void => {
		if (entry.role !== "controlling") return;
		for (const [slotId, existing] of slots) {
			if (slotId === entry.slotId) continue;
			if (existing.tabId !== entry.tabId || existing.role !== "controlling") continue;
			// A rival controlling slot is demoted but never dropped: its editor may hold
			// unsent input, and ADR-0025 requires that it stay readable and copyable while
			// it can no longer issue a native operation.
			slots.set(slotId, {
				...existing,
				role: "passive",
				generation: existing.generation + 1,
				passiveReason: "Another editor in this window became the controller of this session.",
			});
		}
	};

	return {
		entries(): readonly EditorSlotEntry[] {
			return [...slots.values()];
		},
		get(slotId: string): EditorSlotEntry | null {
			return slots.get(slotId) ?? null;
		},
		controllerOf(tabId: string): EditorSlotEntry | null {
			for (const entry of slots.values()) {
				if (entry.tabId === tabId && entry.role === "controlling") return entry;
			}
			return null;
		},
		slotsFor(tabId: string): readonly EditorSlotEntry[] {
			const matching = [...slots.values()].filter(entry => entry.tabId === tabId);
			return matching.sort((left, right) => (left.role === right.role ? 0 : left.role === "controlling" ? -1 : 1));
		},
		register(input: RegisterSlotInput): EditorSlotEntry {
			const existing = slots.get(input.slotId) ?? null;
			const moved = existing === null || existing.tabId !== input.tabId || existing.role !== input.role;
			const entry: EditorSlotEntry = {
				slotId: input.slotId,
				tabId: input.tabId,
				role: input.role,
				// The generation advances on a *change*: a re-report of the same binding
				// must not invalidate the credentials of a page that is still correct.
				generation: existing === null ? 1 : existing.generation + (moved ? 1 : 0),
				passiveReason:
					input.role === "controlling"
						? null
						: input.passiveReason ?? existing?.passiveReason ?? "This editor is not controlling its session.",
			};
			slots.set(input.slotId, entry);
			demoteRivals(entry);
			return slots.get(input.slotId) ?? entry;
		},
		remove(slotId: string): boolean {
			return slots.delete(slotId);
		},
		isCoherent(tabId: string): boolean {
			let controllers = 0;
			for (const entry of slots.values()) {
				if (entry.tabId !== tabId) continue;
				if (entry.role === "controlling") controllers += 1;
			}
			return controllers === 1;
		},
	};
}
