import { readSessionEvidence } from "../session-tools.ts";
import { emptyView, isUnavailable, projectView, toggleMessage, VIEW_KINDS, appliesTo } from "./inventory-model.ts";
import type { InventoryResult, InventoryRow, InventoryScope, SessionEvidence, ViewKind, ViewModel } from "./inventory-model.ts";
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
	/** `undo`, when given, is offered as an Undo button on the notice. */
	notify(message: string, level: "info" | "warning", undo?: () => void): void;
	/** One line per switch request and its outcome: the only trace of who changed OMP's `config.yml` from a view. */
	log(message: string): void;
	/** After a live switch, OMP's config watcher needs a moment before a running session shows it. */
	delay(ms: number): Promise<void>;
	/** Clock, injectable for tests. */
	now?(): number;
}

interface ViewState { visible: boolean; chosen: InventoryScope | null; shown: string | null }
/** One inventory worker run per distinct folder/profile per refresh, shared by every visible view. */
interface Plan { view: ViewKind; scope: InventoryScope; key: string; cwd: string; profile: string; forcedGlobal: boolean }
interface PublishedContext { plan: Plan; running: boolean }

export const LIVE_SETTLE_MS = 1500;
/** A read this young is shown as current without asking OMP again (three views opening in a row share one read). */
export const FRESH_MS = 5_000;

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
	#forced = false;
	#epoch = 0;
	readonly #cache = new Map<string, { readonly result: InventoryResult; readonly at: number }>();
	readonly #inflight = new Map<string, Promise<InventoryResult>>();
	/** The last session evidence per target, so a re-opened view can paint before the session answers again. */
	readonly #evidence = new WeakMap<object, { readonly generation: string; readonly evidence: SessionEvidence }>();
	readonly #deps: InventoryControllerDeps;
	readonly #views: Record<ViewKind, ViewState> = {
		skills: { visible: false, chosen: null, shown: null }, tools: { visible: false, chosen: null, shown: null },
		mcp: { visible: false, chosen: null, shown: null }, extensions: { visible: false, chosen: null, shown: null },
	};

	constructor(deps: InventoryControllerDeps) { this.#deps = deps; }
	#now(): number { return this.#deps.now?.() ?? Date.now(); }

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

	/** `force` drops every cached read first (the user's Refresh); otherwise a read younger than FRESH_MS is used as is and an older one is shown, marked, while a fresh read runs. */
	refresh(options: { readonly force?: boolean } = {}): void {
		if (this.#disposed || !VIEW_KINDS.some(view => this.#views[view].visible)) return;
		this.#version += 1;
		if (options.force === true) this.#forced = true;
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

	/** A written switch (or an explicit Refresh) makes every cached read untrustworthy; reads still running began before it. */
	#invalidate(): void {
		this.#epoch += 1;
		this.#cache.clear();
		this.#inflight.clear();
	}

	/** One worker run per distinct folder/profile at a time, whatever cycle or view asks, and never cancelled by a newer cycle: its result is cached for them all. */
	#read(plan: Plan): Promise<InventoryResult> {
		const running = this.#inflight.get(plan.key);
		if (running !== undefined) return running;
		const epoch = this.#epoch;
		const started = this.#now();
		const run = this.#deps.runtime.read({ cwd: plan.cwd, profile: plan.profile, scope: plan.scope }).then(result => {
			const took = this.#now() - started;
			if (isUnavailable(result)) this.#deps.log(`inventory: read failed after ${took} ms (${plan.scope} list, profile ${plan.profile}, folder ${plan.cwd}): ${result.unavailable}`);
			else this.#deps.log(`inventory: read ${plan.scope} list in ${took} ms (${result.rows.length} rows, profile ${plan.profile})`);
			if (this.#epoch === epoch) {
				if (!isUnavailable(result)) this.#cache.set(plan.key, { result, at: this.#now() });
				this.#inflight.delete(plan.key);
			}
			return result;
		});
		this.#inflight.set(plan.key, run);
		return run;
	}

	async #cycle(): Promise<void> {
		this.#pending = true;
		try {
			const version = this.#version;
			const target = this.#selected;
			const force = this.#forced;
			this.#forced = false;
			if (force) this.#invalidate();
			const began = this.#now();
			const plans = VIEW_KINDS.filter(view => this.#views[view].visible).map(view => this.#plan(view, target));
			const fenced = (): boolean => {
				const current = this.#deps.target();
				return !this.#disposed && version === this.#version && (target === null || (current?.key === target.key && current.generation === target.generation));
			};
			const known = target === null ? undefined : this.#evidence.get(target.key);
			const lastEvidence = known !== undefined && known.generation === target?.generation ? known.evidence : null;
			const project = (plan: Plan, inventory: InventoryResult, evidence: SessionEvidence | null, note: string | null): void => {
				const model = projectView({ view: plan.view, scope: plan.scope, inventory, evidence: plan.scope === "session" ? evidence : null, profile: plan.profile });
				const context: PublishedContext = { plan, running: target?.running === true };
				for (const group of model.groups) for (const item of group.items) if (item.row !== null) this.#contexts.set(item.row, context);
				const description = plan.forcedGlobal ? "Global (no active session)" : model.description;
				this.#deps.publish(plan.view, { ...model, description: note === null ? description : `${description} · ${note}` });
			};
			// First paint: what is cached, marked while a fresh read runs, so a view never waits for the worker twice.
			for (const plan of plans) {
				this.#deps.scopeChanged(plan.view, plan.scope);
				const hit = this.#cache.get(plan.key);
				const fresh = hit !== undefined && this.#now() - hit.at < FRESH_MS;
				if (hit !== undefined && (plan.scope === "global" || lastEvidence !== null) && fenced()) {
					this.#views[plan.view].shown = plan.key;
					project(plan, hit.result, lastEvidence, fresh ? null : "refreshing…");
				} else if (this.#views[plan.view].shown !== plan.key) {
					this.#views[plan.view].shown = plan.key;
					this.#deps.publish(plan.view, emptyView("Reading OMP's inventory…", plan.scope, plan.scope === "session" ? `Session: ${target?.title ?? ""}` : "Global"));
				}
			}
			const keys = new Map(plans.map(plan => [plan.key, plan]));
			const needsEvidence = target !== null && plans.some(plan => plan.scope === "session");
			const wanted = [...keys.values()].filter(plan => {
				const hit = this.#cache.get(plan.key);
				return hit === undefined || this.#now() - hit.at >= FRESH_MS;
			});
			if (wanted.length === 0 && !needsEvidence) return;
			const evidenceStarted = this.#now();
			const [entries, evidence] = await Promise.all([
				Promise.all(wanted.map(async plan => [plan.key, await this.#read(plan)] as const)),
				needsEvidence ? readSessionEvidence(target).then(read => { this.#deps.log(`inventory: session evidence read in ${this.#now() - evidenceStarted} ms`); return read; }) : Promise.resolve(null),
			]);
			if (target !== null && evidence !== null) this.#evidence.set(target.key, { generation: target.generation, evidence });
			if (!fenced()) return;
			const results = new Map<string, InventoryResult>(entries);
			for (const plan of plans) {
				const answered = results.get(plan.key);
				const hit = this.#cache.get(plan.key);
				if (answered !== undefined && !isUnavailable(answered)) project(plan, answered, evidence, null);
				else if (answered !== undefined && hit !== undefined) project(plan, hit.result, evidence, "could not refresh; showing an earlier read");
				else if (answered !== undefined) project(plan, answered, evidence, null);
				else project(plan, hit?.result ?? { unavailable: "OMP's inventory is not available." }, evidence, null);
			}
			this.#deps.log(`inventory: ${plans.length} view(s) published in ${this.#now() - began} ms (${wanted.length} worker run(s) awaited)`);
		} finally {
			this.#pending = false;
			if (this.#again && !this.#disposed) { this.#again = false; void this.#cycle(); }
		}
	}

	/** Serialized: two switches never interleave their writes. The folder, profile and scope are those of the list the row was published in, captured now. */
	toggle(view: ViewKind, row: InventoryRow, enabled: boolean): Promise<void> {
		const context = this.#contexts.get(row);
		const run = this.#switching.then(() => this.#toggle(view, context, row, enabled));
		this.#switching = run.catch(() => {});
		return run;
	}

	async #toggle(view: ViewKind, context: PublishedContext | undefined, row: InventoryRow, enabled: boolean): Promise<void> {
		if (this.#disposed) return;
		if (context === undefined) { this.#deps.notify("Refresh the view before switching.", "warning"); return; }
		const { plan, running } = context;
		const subject = `${row.kind}:${row.name} ${enabled ? "disabled→enabled" : "enabled→disabled"}`;
		this.#deps.log(`inventory: switch requested in the ${view} view: ${subject} (global configuration of profile ${plan.profile}; list shown: ${plan.scope}, folder ${plan.cwd})`);
		const result = await this.#deps.runtime.toggle({ cwd: plan.cwd, profile: plan.profile, scope: plan.scope, kind: row.kind, name: row.name, enabled });
		this.#deps.log(`inventory: switch ${subject}: ${result.ok ? (result.changed ? `written: ${result.writes.map(write => `${write.what} (${write.file ?? "OMP's own store"})`).join("; ")}` : "already as requested; nothing written") : `refused: ${result.message}`}`);
		this.#invalidate();
		if (!result.ok) {
			this.#deps.notify(result.message, "warning");
			this.refresh({ force: true });
			return;
		}
		// Disabling is the switch an accidental keystroke or click hurts: the notice offers to put it back.
		this.#deps.notify(toggleMessage(row, enabled, result.changed, running), "info", result.changed && !enabled ? () => { void this.toggle(view, row, true); } : undefined);
		this.refresh({ force: true });
		if (result.changed && running && appliesTo(row) === "live") {
			await this.#deps.delay(LIVE_SETTLE_MS);
			this.#invalidate();
			this.refresh({ force: true });
		}
	}

	dispose(): void { this.#disposed = true; this.#version += 1; }
}
