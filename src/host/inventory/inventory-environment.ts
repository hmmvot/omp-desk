import { isTransientOmpFailure } from "../../shared/omp-unavailable.ts";
import type { Logger } from "../../shared/logger.ts";

/**
 * Where Bun and the selected OMP's package source are (ADR-0061). Finding them runs the same launcher
 * resolution a session start does, including an `omp --version` probe, which on a busy machine can take
 * tens of seconds. The answer is therefore resolved once, shared by concurrent reads and reused for a minute.
 *
 * A failed resolution is classified (ADR-0011, 2026-10-12 amendment). A *transient* one — the probe ran
 * past its limit, the process could not be created, it was killed — says nothing about the installed OMP,
 * and resolution never falls through to another `omp` after one (a compiled install has no package source,
 * and an older one is not the OMP sessions run), so the earlier answer is kept and tried again after the
 * next minute. A *definitive* one — no launcher, no Bun, no package source for the OMP Desk resolved —
 * describes the install as it is now, so the earlier answer is dropped and the failure is reported:
 * inventory never describes an OMP other than the one Desk resolves. Where there is no earlier answer,
 * the failure says what was actually found.
 */
export interface ResolvedRuntime { readonly bun: string; readonly packageRoot: string }
export type RuntimeResolution =
	| { readonly ok: true; readonly bun: string; readonly packageRoot: string; readonly launcher: string; readonly release: string | null }
	| { readonly ok: false; readonly unavailable: string };
export interface RuntimeResolverDeps {
	/** One full resolution. A thrown error is a failed resolution, not a crash. */
	resolve(): Promise<RuntimeResolution>;
	/**
	 * What the resolution depends on that the user can change (the explicit OMP path). An answer found under
	 * another key describes another OMP: it is neither served nor kept across a failure.
	 */
	key?(): string;
	readonly log: Logger;
	now?(): number;
}
export const RESOLVE_TTL_MS = 60_000;

/** The sentence for a launcher whose package source cannot be read. Names the launcher, because a compiled install is the usual reason. */
export function noPackageSource(launcher: string, release: string | null): string {
	return `OMP's inventory reads the installed OMP's package source, and the OMP that Desk resolved (${launcher}${release === null ? "" : `, release ${release}`}) has none that matches it; a compiled-only OMP install cannot supply it.`;
}
export const NO_BUN = "OMP's inventory needs Bun to read OMP's package source, and no Bun runtime was found (BUN_INSTALL, ~/.bun/bin or PATH).";

export function createRuntimeResolver(deps: RuntimeResolverDeps): () => Promise<ResolvedRuntime | { readonly unavailable: string }> {
	const now = deps.now ?? Date.now;
	let good: (ResolvedRuntime & { readonly at: number }) | null = null;
	let goodKey = "";
	let running: { readonly key: string; readonly promise: Promise<ResolvedRuntime | { readonly unavailable: string }> } | null = null;
	// Attempts are numbered as they start. A key alone cannot say which attempt owns the cache: a setting changed
	// away and back (A, B, A) leaves two attempts for the same key, and only the latest may keep or drop an answer.
	let latest = 0;
	const currentKey = (): string => deps.key?.() ?? "";
	const resolveOnce = async (key: string): Promise<ResolvedRuntime | { readonly unavailable: string }> => {
		const attempt = ++latest;
		// Whether this attempt still describes the setting as it is now, and no newer attempt has started.
		const current = (): boolean => attempt === latest && currentKey() === key;
		const started = now();
		let failure: string;
		let transient = false;
		try {
			const result = await deps.resolve();
			if (result.ok) {
				deps.log.debug(`inventory: resolved Bun (${result.bun}) and the OMP package (${result.packageRoot}, launcher ${result.launcher}${result.release === null ? "" : ` release ${result.release}`}) in ${now() - started} ms`);
				// The answer belongs to the read that asked; it is cached only while the setting still is what it was asked under.
				if (!current()) {
					deps.log.debug("inventory: the OMP setting changed or was resolved again while resolving; this answer is not kept");
					return { bun: result.bun, packageRoot: result.packageRoot };
				}
				good = { at: now(), bun: result.bun, packageRoot: result.packageRoot };
				goodKey = key;
				return good;
			}
			failure = result.unavailable;
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			transient = isTransientOmpFailure(error);
			failure = `The installed OMP could not be resolved: ${text.split(/\r?\n/)[0]!.slice(0, 300)}`;
		}
		deps.log.warn(`inventory: resolving Bun and the OMP package failed after ${now() - started} ms (${transient ? "transient" : "definitive"}): ${failure}`);
		// Only an answer found under this very setting by the attempt that is still the current one describes the OMP that failed.
		if (current() && good !== null && goodKey === key) {
			if (transient) {
				// Nothing was learned about the install, and resolution does not substitute another one; a worker that cannot start reports it itself.
				good = { ...good, at: now() };
				deps.log.warn("inventory: keeping the Bun and OMP package found earlier");
				return good;
			}
			good = null;
			deps.log.warn("inventory: dropping the Bun and OMP package found earlier; Desk no longer resolves them");
		}
		return { unavailable: failure };
	};
	return async () => {
		const key = currentKey();
		if (good !== null && goodKey !== key) {
			good = null;
			deps.log.debug("inventory: the OMP setting changed; the Bun and OMP package found earlier are not reused");
		}
		if (good !== null && now() - good.at <= RESOLVE_TTL_MS) return good;
		if (running === null || running.key !== key) {
			const promise = resolveOnce(key).finally(() => { if (running?.promise === promise) running = null; });
			running = { key, promise };
		}
		return running.promise;
	};
}
