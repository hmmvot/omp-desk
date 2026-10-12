/**
 * Where Bun and the selected OMP's package source are (ADR-0061). Finding them runs the same launcher
 * resolution a session start does, including an `omp --version` probe, which on a busy machine can take
 * tens of seconds and can fall through to another installed `omp` (a compiled one, without package
 * source). The answer is therefore resolved once, shared by concurrent reads, reused for a minute, and a
 * later failed resolution keeps the last good answer instead of replacing a working inventory with an
 * error. Where there is no earlier answer, the failure says what was actually found.
 */
export interface ResolvedRuntime { readonly bun: string; readonly packageRoot: string }
export type RuntimeResolution =
	| { readonly ok: true; readonly bun: string; readonly packageRoot: string; readonly launcher: string; readonly release: string | null }
	| { readonly ok: false; readonly unavailable: string };
export interface RuntimeResolverDeps {
	/** One full resolution. A thrown error is a failed resolution, not a crash. */
	resolve(): Promise<RuntimeResolution>;
	log(message: string): void;
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
	let running: Promise<ResolvedRuntime | { readonly unavailable: string }> | null = null;
	const resolveOnce = async (): Promise<ResolvedRuntime | { readonly unavailable: string }> => {
		const started = now();
		let failure: string;
		try {
			const result = await deps.resolve();
			if (result.ok) {
				good = { at: now(), bun: result.bun, packageRoot: result.packageRoot };
				deps.log(`inventory: resolved Bun (${result.bun}) and the OMP package (${result.packageRoot}, launcher ${result.launcher}${result.release === null ? "" : ` release ${result.release}`}) in ${now() - started} ms`);
				return good;
			}
			failure = result.unavailable;
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			failure = `The installed OMP could not be resolved: ${text.split(/\r?\n/)[0]!.slice(0, 300)}`;
		}
		deps.log(`inventory: resolving Bun and the OMP package failed after ${now() - started} ms: ${failure}`);
		if (good !== null) {
			// Install locations do not move between reads; a worker that cannot start reports it itself.
			good = { ...good, at: now() };
			deps.log("inventory: keeping the Bun and OMP package found earlier");
			return good;
		}
		return { unavailable: failure };
	};
	return async () => {
		if (good !== null && now() - good.at <= RESOLVE_TTL_MS) return good;
		running ??= resolveOnce().finally(() => { running = null; });
		return running;
	};
}
