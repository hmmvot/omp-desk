import { setTimeout as delay } from "node:timers/promises";

const TRANSIENT_WINDOWS_ERRORS: Record<string, true> = { EPERM: true, EBUSY: true, EACCES: true };

/**
 * Retry only Windows sharing/access failures (`EPERM`, `EBUSY`, `EACCES`), keeping the caller's
 * staging file and lock. Never unlinks the target: each attempt is the same atomic replacement
 * or pre-launch claim admission.
 */
export async function retryWindowsFileOperation<T>(
	operation: () => Promise<T>,
	options: { readonly platform?: NodeJS.Platform; readonly attempts?: number; readonly wait?: (ms: number) => Promise<unknown> } = {},
): Promise<T> {
	const attempts = options.attempts ?? 7;
	const wait = options.wait ?? delay;
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
			if ((options.platform ?? process.platform) !== "win32" || typeof code !== "string" ||
				TRANSIENT_WINDOWS_ERRORS[code] !== true || attempt + 1 >= attempts) throw error;
			await wait(Math.min(25 * 2 ** attempt, 250));
		}
	}
}
