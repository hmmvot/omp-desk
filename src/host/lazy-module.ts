/**
 * Code that most windows never run, loaded the first time something asks for it.
 *
 * The extension bundle is evaluated at every window start, and its cost follows its size (measured: about 0.15 ms per
 * kilobyte of bundle in a plain Node process, far more in a busy extension host). The code reached only by a command or a
 * restored editor lives in a second file, `out/rare-subsystems.js` (`./rare-subsystems-loader.ts`), and `lazy` makes the first
 * caller read it and every later caller share the result. A `lazy(() => import("…"))` of a module that esbuild keeps in the
 * same bundle would not do this: the bytes are still read and parsed at start-up.
 */

/**
 * A loader that runs `load` once and shares its result among every caller, concurrent or later. A failed load is not
 * remembered, so a later caller tries again (the reason of the failure is the one of the call that sees it).
 */
export function lazy<T>(load: () => Promise<T>): () => Promise<T> {
	let loading: Promise<T> | null = null;
	return () => {
		const attempt = (loading ??= load());
		attempt.catch(() => {
			if (loading === attempt) loading = null;
		});
		return attempt;
	};
}
