/** Retire a folder shell after its authenticated broker proves the child exited. */
import type { PtyHandle } from "./pty-client.ts";

export type ShellExitSource = Pick<PtyHandle, "kind" | "state" | "subscribe" | "shutdown">;

/** Unsubscribe future exit events; a confirmed explicit stop may also cancel queued retirement. */
export type ShellExitWatchStop = (options?: { readonly cancelQueuedRetirement?: boolean }) => void;

/** Keep the editor alive; retire only its recovery metadata and exited broker. */
export function watchShellExit(
	source: ShellExitSource,
	ports: {
		retireSlot(): Promise<void>;
		log(message: string): void;
		runRetirement(operation: () => Promise<void>): Promise<void>;
	},
): ShellExitWatchStop {
	let retired = false;
	let cancelled = false;
	const retire = (): void => {
		if (retired || source.kind !== "folder-shell" || source.state !== "exited") return;
		retired = true;
		void ports.runRetirement(async () => {
			if (cancelled) return;
			// This proves only the shell child ended, not that escaped descendants ended.
			// Remove recovery metadata before shutdown so closing its editor stays silent.
			try {
				await ports.retireSlot();
			} catch (error) {
				ports.log(`shell slot retirement failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				const result = await source.shutdown({ requireStopped: true });
				if (!result.stopped) ports.log("the exited shell broker did not accept shutdown");
			} catch (error) {
				ports.log(`exited shell broker shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}).catch(error => ports.log(`exited shell lifecycle failed: ${error instanceof Error ? error.message : String(error)}`));
	};
	const unsubscribe = source.subscribe(event => {
		if (event.type === "state" && event.status.state === "exited") retire();
	});
	retire();
	// Ordinary teardown preserves an already observed exit. An explicit stop that
	// owns the slot's gate may cancel its queued retirement after its own shutdown ack.
	return options => {
		if (options?.cancelQueuedRetirement) cancelled = true;
		unsubscribe();
	};
}

export type ShellStopSource = Pick<PtyHandle, "kind" | "state" | "stop" | "shutdown" | "disconnect">;
export type ShellStopOutcome =
	| { readonly kind: "stopped" }
	| { readonly kind: "unconfirmed"; readonly stage: "stop" | "shutdown" | "retirement" };

/** An explicitly confirmed Terminate stops the shell and retires its broker, not an unproven tree. */
export async function stopShellAndBroker(
	source: ShellStopSource,
	ports: { retireSlot(): Promise<void>; log(message: string): void },
): Promise<ShellStopOutcome> {
	let stage: "stop" | "shutdown" | "retirement" = "stop";
	try {
		if (source.kind !== "folder-shell" || source.state === null) {
			ports.log("shell stop refused: no authenticated folder-shell child state");
			return { kind: "unconfirmed", stage };
		}
		if (source.state === "running") {
			const result = await source.stop({ mode: "graceful" });
			ports.log(`shell stop: pidGone=${result.pidGone}, tree=${result.tree}, verified=${result.verified}; ${result.detail}`);
			if (!result.pidGone) return { kind: "unconfirmed", stage };
			// The provider cannot prove escaped descendants ended. That does not undo
			// its exact-child absence proof or require keeping an empty broker alive.
		}
		stage = "shutdown";
		const shutdown = await source.shutdown({ requireStopped: true });
		if (!shutdown.stopped) {
			ports.log("shell broker shutdown did not confirm child exit");
			return { kind: "unconfirmed", stage };
		}
		ports.log("shell broker acknowledged shutdown after confirmed child exit; no tree-stop claim made");
		stage = "retirement";
		await ports.retireSlot();
		return { kind: "stopped" };
	} catch (error) {
		ports.log(`shell ${stage} failed: ${error instanceof Error ? error.message : String(error)}`);
		return { kind: "unconfirmed", stage };
	} finally {
		source.disconnect();
	}
}
