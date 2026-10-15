/**
 * When the extension bundle began evaluating its modules. `extension.ts` imports this first, so this module's body runs before any
 * other module of the bundle evaluates; the gap to `activate()` is the cost of loading the code, which `activate()` cannot see.
 */
export const MODULE_EVALUATION_STARTED_AT = performance.now();

/** The host process's CPU time (user + system, ms) at the same moment. */
export const MODULE_EVALUATION_STARTED_CPU_MS = (() => {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
})();
