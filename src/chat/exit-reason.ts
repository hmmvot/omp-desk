/** Managed Chat child diagnostics are plain text, never markup or terminal output. */
export const CHAT_EXIT_STDERR_BYTES = 4 * 1024;

export interface ChatExitReason {
	exitCode: number | null;
	stderr: string;
}

/** Validate the bounded diagnostic crossing the host/page boundary. */
export function parseChatExitReason(value: unknown): ChatExitReason | null {
	if (typeof value !== "object" || value === null) return null;
	const reason = value as Record<string, unknown>;
	if (reason.exitCode !== null && !Number.isSafeInteger(reason.exitCode)) return null;
	if (typeof reason.stderr !== "string" || new TextEncoder().encode(reason.stderr).length > CHAT_EXIT_STDERR_BYTES) return null;
	// oxlint-disable-next-line no-control-regex
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(reason.stderr)) return null;
	return { exitCode: reason.exitCode as number | null, stderr: reason.stderr };
}

/** OMP 18.8.5's observed no-model startup refusal; other failures have no login remedy. */
export function exitNeedsProviderLogin(reason: ChatExitReason): boolean {
	return reason.stderr.includes("No default model selected");
}

export function chatExitText(reason: ChatExitReason): string {
	const heading = reason.exitCode === null ? "OMP exited." : `OMP exited with code ${reason.exitCode}.`;
	// The installed Bun CLI prints a minified source excerpt before an uncaught startup error.
	// Keep the meaningful final diagnostic, not that excerpt, in the banner and output channel.
	const errorStart = reason.stderr.search(/(?:^|\n\n)error: /);
	const text = (errorStart < 0 ? reason.stderr : reason.stderr.slice(errorStart)).trim();
	return text ? `${heading}\n${text}` : heading;
}
