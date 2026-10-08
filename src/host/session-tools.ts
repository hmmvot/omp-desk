import type { ChatSlashCommand } from "../chat/model.ts";
import type { ControlToolList } from "./control-protocol.ts";
import type { RpcToolDescriptor } from "./rpc/protocol.ts";

export interface SessionSkill { readonly name: string; readonly description: string }
export interface SessionTool extends RpcToolDescriptor { readonly active: boolean | null }
export interface SessionToolsSnapshot {
	readonly message: string | null;
	readonly skills: readonly SessionSkill[];
	readonly tools: readonly SessionTool[];
	readonly skillsMessage: string | null;
	readonly toolsMessage: string | null;
}
export interface SessionToolsTarget {
	readonly key: object;
	readonly generation: string;
	readonly mode: "chat" | "terminal";
	readonly running: boolean;
	readonly commands: readonly ChatSlashCommand[];
	readonly readDescriptors: (() => Promise<readonly RpcToolDescriptor[] | null>) | null;
	readonly readTools: (() => Promise<ControlToolList | null>) | null;
}
export function emptyTools(message: string): SessionToolsSnapshot {
	return { message, skills: [], tools: [], skillsMessage: null, toolsMessage: null };
}
export function projectSessionTools(target: SessionToolsTarget, descriptors: readonly RpcToolDescriptor[] | null, list: ControlToolList | null): SessionToolsSnapshot {
	const observed = list?.available === true ? list : null;
	const active = observed === null ? null : new Set(observed.active);
	const rows = new Map<string, SessionTool>();
	for (const tool of descriptors ?? []) rows.set(tool.name, { ...tool, active: observed === null ||
		(!observed.all.includes(tool.name) && !observed.active.includes(tool.name)) ? null : active!.has(tool.name) });
	for (const name of observed === null ? [] : [...observed.all, ...observed.active]) {
		if (!rows.has(name)) rows.set(name, { name, description: "Description unavailable from host control.", active: active!.has(name) });
	}
	const skills = target.commands.filter(command => command.source === "skill").map(command => ({
		name: command.name,
		description: command.description ?? "No description provided.",
	}));
	return {
		message: null,
		skills,
		tools: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)),
		skillsMessage: target.mode === "terminal" ? "Skills unavailable in Terminal mode (no RPC catalogue)." : skills.length === 0 ? "No skill commands reported." : null,
		toolsMessage: descriptors === null && observed === null ? "Tools unavailable for this session." : rows.size === 0 ? "No tools loaded." : null,
	};
}

/** Selection/lifecycle changes invalidate pending reads; ordinary token updates never request inventory. */
export class SessionToolsController {
	#version = 0;
	#disposed = false;
	#visible = false;
	#selected: SessionToolsTarget | null = null;
	#pending = false;
	#again = false;
	readonly target: () => SessionToolsTarget | null;
	readonly publish: (snapshot: SessionToolsSnapshot) => void;
	constructor(target: () => SessionToolsTarget | null, publish: (snapshot: SessionToolsSnapshot) => void) {
		this.target = target;
		this.publish = publish;
	}
	setVisible(visible: boolean): void {
		this.#visible = visible;
		if (visible) this.refresh();
		else { this.#version += 1; this.#again = false; }
	}
	sync(): void {
		const next = this.target();
		if (next?.key === this.#selected?.key && next?.generation === this.#selected?.generation && next?.running === this.#selected?.running) return;
		this.#selected = next;
		this.refresh();
	}
	refresh(): void {
		if (this.#disposed || !this.#visible) return;
		this.#version += 1;
		this.#selected = this.target();
		const selected = this.#selected;
		if (selected === null || !selected.running) {
			this.publish(emptyTools(selected === null ? "Focus an OMP session to see its skills and tools." : "This session is not running."));
			return;
		}
		this.publish(emptyTools("Reading this session's skills and tools…"));
		if (this.#pending) { this.#again = true; return; }
		void this.#read();
	}
	async #read(): Promise<void> {
		this.#pending = true;
		const version = this.#version;
		const selected = this.#selected!;
		try {
			const [descriptors, tools] = await Promise.all([
				selected.readDescriptors?.().catch(() => null) ?? null,
				selected.readTools?.().catch(() => null) ?? null,
			]);
			const current = this.target();
			if (!this.#disposed && this.#visible && version === this.#version && current?.key === selected.key && current.generation === selected.generation && current.running) {
				this.publish(projectSessionTools(current, descriptors, tools));
			}
		} finally {
			this.#pending = false;
			if (this.#again && !this.#disposed) { this.#again = false; this.refresh(); }
		}
	}
	dispose(): void { this.#disposed = true; this.#version += 1; }
}
