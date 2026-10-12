import type { ChatSlashCommand } from "../chat/model.ts";
import type { ControlToolList } from "./control-protocol.ts";
import type { RpcToolDescriptor } from "../protocol/rpc.ts";
import type { SessionEvidence, SessionToolEntry } from "./inventory/inventory-model.ts";

/**
 * The OMP editor the inventory views describe, and how to read what its session itself reports.
 * The extension builds it from editor recency (not Sessions row selection); the fencing fields
 * make every asynchronous read discardable when the editor or its session changed.
 */
export interface SessionToolsTarget {
	readonly key: object;
	readonly generation: string;
	/** The editor's session tab; the Context view runs Compact and Shake for it. */
	readonly tabId: string;
	readonly mode: "chat" | "terminal";
	readonly running: boolean;
	/** Session title, shown in the view description. */
	readonly title: string;
	/** The session's recorded working directory; the inventory is read there. */
	readonly cwd: string | null;
	/** `null` is the default profile. */
	readonly profile: string | null;
	readonly commands: readonly ChatSlashCommand[];
	readonly readDescriptors: (() => Promise<readonly RpcToolDescriptor[] | null>) | null;
	readonly readTools: (() => Promise<ControlToolList | null>) | null;
}

/**
 * Merge bounded RPC descriptors with the authenticated names-only list. Active/inactive comes only from
 * the list: a name in `all` but not `active` is inactive; a descriptor absent from both has unknown
 * activation; an unavailable list never invents an inactive mark. `null` when neither source answered.
 */
export function mergeSessionTools(descriptors: readonly RpcToolDescriptor[] | null, list: ControlToolList | null): SessionToolEntry[] | null {
	const observed = list?.available === true ? list : null;
	if (descriptors === null && observed === null) return null;
	const active = observed === null ? null : new Set(observed.active);
	const rows = new Map<string, SessionToolEntry>();
	for (const tool of descriptors ?? []) {
		const known = observed !== null && (observed.all.includes(tool.name) || observed.active.includes(tool.name));
		rows.set(tool.name, { ...tool, active: known ? active!.has(tool.name) : null });
	}
	for (const name of observed === null ? [] : [...observed.all, ...observed.active]) {
		if (!rows.has(name)) rows.set(name, { name, description: "Description unavailable from host control.", active: active!.has(name) });
	}
	return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** What the target's session reports right now; Terminal mode has no command catalogue. */
export async function readSessionEvidence(target: SessionToolsTarget): Promise<SessionEvidence> {
	if (!target.running) return { title: target.title, running: false, commands: null, tools: null };
	const [descriptors, list] = await Promise.all([
		target.readDescriptors?.().catch(() => null) ?? null,
		target.readTools?.().catch(() => null) ?? null,
	]);
	return { title: target.title, running: true, commands: target.mode === "chat" ? target.commands : null, tools: mergeSessionTools(descriptors, list) };
}
