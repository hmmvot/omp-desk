/**
 * Recognizes a double-click on a session row by timing.
 *
 * A VS Code TreeItem command fires once per click and carries no double-click
 * information. A single click on a stopped row shows its history; a second click on
 * the same row within `intervalMs` launches it. A click on a live row always just
 * reveals it and resets the pending click.
 */
export class SessionClickRecognizer {
	#previous: { identity: string; at: number } | null = null;
	readonly now: () => number;
	readonly intervalMs: number;
	constructor(now: () => number = Date.now, intervalMs = 400) {
		this.now = now;
		this.intervalMs = intervalMs;
	}
	click(identity: string, stopped: boolean): "history" | "launch" | "reveal" {
		if (!stopped) { this.#previous = null; return "reveal"; }
		const at = this.now();
		const previous = this.#previous;
		if (previous?.identity === identity && at >= previous.at && at - previous.at <= this.intervalMs) {
			this.#previous = null;
			return "launch";
		}
		this.#previous = { identity, at };
		return "history";
	}
}
