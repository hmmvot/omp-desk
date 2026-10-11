import { readSessionEvidence } from "../session-tools.ts";
import { emptyView, projectView, toggleMessage, VIEW_KINDS, appliesTo } from "./inventory-model.ts";
import type { InventoryResult, InventoryRow, InventoryScope, ViewKind, ViewModel } from "./inventory-model.ts";
import type { InventoryRuntime } from "./inventory-runtime.ts";
import type { SessionToolsTarget } from "../session-tools.ts";

export interface InventoryControllerDeps {
	target(): SessionToolsTarget | null;
	runtime: InventoryRuntime;
	/** Where the global inventory is read: a folder without a project layer. */
	neutralCwd: string;
	publish(view: ViewKind, model: ViewModel): void;
	/** Mirrors a view's effective scope to its title-bar button. */
	scopeChanged(view: ViewKind, scope: InventoryScope): void;
	notify(message: string, level: "info" | "warning"): void;
	/** One line per switch request and its outcome: the only trace of who changed OMP's `config.yml` from a view. */
	log(message: string): void;
	/** After a live switch, OMP's config watcher needs a moment before a running session shows it. */
	delay(ms: number): Promise<void>;
}

interface ViewState { visible: boolean; chosen: InventoryScope | null; shown: string | null }
/** One inventory worker run per distinct folder/profile per refresh, shared by every visible view. */
interface Plan { view: ViewKind; scope: InventoryScope; key: string; cwd: string; profile: string; forcedGlobal: boolean }
interface PublishedContext { plan: Plan; running: boolean }

export const LIVE_SETTLE_MS = 1500;

/**
 * Owns the four views' Session | Global scope, visibility and reads. A view reads only while
 * visible; a selection or lifecycle change invalidates pending reads (the target's key and
 * generation fence every result); at most one read cycle runs, with one queued refresh.
 */
export class InventoryController {
	#version = 0;
	#disposed = false;
	#pending = false;
	#again = false;
	#selected: SessionToolsTarget | null = null;
	/** What each view last showed: the context of its rows, immune to later selection changes. */
	/** Every switchable row ever published, with the context of the list it appeared in: a row clicked after a newer list replaced it keeps its own context. */
	readonly #contexts = new WeakMap<InventoryRow, PublishedContext>();
	#switching: Promise<void> = Promise.resolve();
	readonly #deps: InventoryControllerDeps;
	readonly #views: Record<ViewKind, ViewState> = {
		skills: { visible: false, chosen: null, shown: null }, tools: { visible: false, chosen: null, shown: null },
		mcp: { visible: false, chosen: null, shown: null }, extensions: { visible: false, chosen: null, shown: null },
	};

	constructor(deps: InventoryControllerDeps) { this.#deps = deps; }

	setVisible(view: ViewKind, visible: boolean): void {
		this.#views[view].visible = visible;
		if (visible) this.refresh();
		else this.#version += 1;
	}

	/** The user's explicit choice; it holds until they choose again. */
	setScope(view: ViewKind, scope: InventoryScope): void {
		this.#views[view].chosen = scope;
		this.#views[view].shown = null;
		this.refresh();
	}

	/** Selection, lifecycle or running-state change of the target. */
	sync(): void {
		const next = this.#deps.target();
		const now = this.#selected;
		if (next?.key === now?.key && next?.generation === now?.generation && next?.running === now?.running) return;
		this.refresh();
	}

	refresh(): void {
		if (this.#disposed || !VIEW_KINDS.some(view => this.#views[view].visible)) return;
		this.#version += 1;
		this.#selected = this.#deps.target();
		if (this.#pending) { this.#again = true; return; }
		void this.#cycle();
	}

	#plan(view: ViewKind, target: SessionToolsTarget | null): Plan {
		const chosen = this.#views[view].chosen;
		const profile = target?.profile ?? "default";
		const wantsSession = (chosen ?? "session") === "session";
		if (wantsSession && target !== null && target.cwd !== null) {
			return { view, scope: "session", key: `session\0${target.cwd}\0${profile}`, cwd: target.cwd, profile, forcedGlobal: false };
		}
		return { view, scope: "global", key: `global\0${profile}`, cwd: this.#deps.neutralCwd, profile, forcedGlobal: chosen === "session" };
	}

	async #cycle(): Promise<void> {
		this.#pending = true;
		try {
			const version = this.#version;
			const target = this.#selected;
			const plans = VIEW_KINDS.filter(view => this.#views[view].visible).map(view => this.#plan(view, target));
			for (const plan of plans) {
				this.#deps.scopeChanged(plan.view, plan.scope);
				if (this.#views[plan.view].shown !== plan.key) {
					this.#views[plan.view].shown = plan.key;
					this.#deps.publish(plan.view, emptyView("Reading OMP's inventory…", plan.scope, plan.scope === "session" ? `Session: ${target?.title ?? ""}` : "Global"));
				}
			}
			const keys = new Map(plans.map(plan => [plan.key, plan]));
			const needsEvidence = target !== null && plans.some(plan => plan.scope === "session");
			const [entries, evidence] = await Promise.all([
				Promise.all([...keys.values()].map(async plan => [plan.key, await this.#deps.runtime.read({ cwd: plan.cwd, profile: plan.profile, scope: plan.scope })] as const)),
				needsEvidence ? readSessionEvidence(target) : Promise.resolve(null),
			]);
			const current = this.#deps.target();
			const fenced = !this.#disposed && version === this.#version &&
				(target === null || (current?.key === target.key && current.generation === target.generation));
			if (!fenced) return;
			const results = new Map<string, InventoryResult>(entries);
			for (const plan of plans) {
				const inventory = results.get(plan.key)!;
				const model = projectView({ view: plan.view, scope: plan.scope, inventory, evidence: plan.scope === "session" ? evidence : null, profile: plan.profile });
				const context: PublishedContext = { plan, running: target?.running === true };
				for (const group of model.groups) for (const item of group.items) if (item.row !== null) this.#contexts.set(item.row, context);
				this.#deps.publish(plan.view, plan.forcedGlobal ? { ...model, description: "Global (no active session)" } : model);
			}
		} finally {
			this.#pending = false;
			if (this.#again && !this.#disposed) { this.#again = false; void this.#cycle(); }
		}
	}

	/** Serialized: two switches never interleave their writes. The folder, profile and scope are those of the list the row was published in, captured now. */
	toggle(view: ViewKind, row: InventoryRow, enabled: boolean): Promise<void> {
		const context = this.#contexts.get(row);
		const run = this.#switching.then(() => this.#toggle(context, row, enabled));
		this.#switching = run.catch(() => {});
		return run;
	}

	async #toggle(context: PublishedContext | undefined, row: InventoryRow, enabled: boolean): Promise<void> {
		if (this.#disposed) return;
		if (context === undefined) { this.#deps.notify("Refresh the view before switching.", "warning"); return; }
		const { plan, running } = context;
		this.#deps.log(`inventory: switch ${row.kind}:${row.name} ${enabled ? "on" : "off"} requested in the ${plan.scope} list (profile ${plan.profile})`);
		const result = await this.#deps.runtime.toggle({ cwd: plan.cwd, profile: plan.profile, scope: plan.scope, kind: row.kind, name: row.name, enabled });
		this.#deps.log(`inventory: switch ${row.kind}:${row.name} ${enabled ? "on" : "off"} ${result.ok ? (result.changed ? "written" : "already as requested; nothing written") : `refused: ${result.message}`}`);
		if (!result.ok) {
			this.#deps.notify(result.message, "warning");
			this.refresh();
			return;
		}
		this.#deps.notify(toggleMessage(row, enabled, result.changed, running), "info");
		this.refresh();
		if (result.changed && running && appliesTo(row) === "live") {
			await this.#deps.delay(LIVE_SETTLE_MS);
			this.refresh();
		}
	}

	dispose(): void { this.#disposed = true; this.#version += 1; }
}
