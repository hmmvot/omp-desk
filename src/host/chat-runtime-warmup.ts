/**
 * The start of the Bun plan's pipe-only check at activation
 * ([ADR-0074](../../docs/decisions/0074-run-chat-brokers-on-the-sessions-own-bun-runtime-with-code-exe-as-fallback.md), amendment
 * 2026-10-28), so the first Chat of a window finds the proof instead of waiting for it.
 *
 * What this module fixes is only the manner of the start: it returns at once, does its work on a later turn of the event loop, and
 * ends every way (an OMP that cannot be resolved, a check that cannot run) in one log line, never in a rejection and never in
 * anything a caller waits for. Activation, the first paint of the views and the restore do not wait for it. What is checked, and
 * how it is shared with the other windows, is {@link PtyBrokerClient.warmChatRuntime}'s.
 */
import type { Logger } from "../shared/logger.ts";
import type { OmpLaunchFacts } from "./chat-broker-runtime.ts";
import type { ChatRuntimeWarmup } from "./pty-client.ts";

export interface ChatRuntimeWarmupStart {
	/** The OMP launch a Chat started now would run (the window's own resolution, shared with its other users). */
	readonly resolve: () => Promise<OmpLaunchFacts>;
	readonly warm: (binary: OmpLaunchFacts) => Promise<ChatRuntimeWarmup>;
	readonly log: Logger;
	/** Test seam: hands `run` to a later turn; an unreferenced zero-delay timer. */
	readonly defer?: (run: () => void) => void;
}

/** Begin the warm-up in the background. Returns before anything is read, resolved or checked. */
export function startChatRuntimeWarmup(start: ChatRuntimeWarmupStart): void {
	const defer =
		start.defer ??
		((run: () => void): void => {
			setTimeout(run, 0).unref();
		});
	defer(() => {
		void (async () => {
			let binary: OmpLaunchFacts;
			try {
				binary = await start.resolve();
			} catch (error) {
				start.log.info(`Bun runtime pre-check ahead of the first Chat: not run, the OMP launch could not be resolved (${error instanceof Error ? error.message : String(error)})`);
				return;
			}
			try {
				const result = await start.warm(binary);
				if (result.outcome === "skipped") start.log.debug(`Bun runtime pre-check ahead of the first Chat: not needed (${result.detail})`);
			} catch (error) {
				start.log.warn(`Bun runtime pre-check ahead of the first Chat: failed (${error instanceof Error ? error.message : String(error)})`);
			}
		})();
	});
}
