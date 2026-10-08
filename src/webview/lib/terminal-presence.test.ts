/**
 * Tests for the terminal pane's presence store.
 *
 * The host learns focus and visibility from the pane's reports and decides which of
 * several editors showing one terminal owns input; the store must therefore notify
 * once per real change and must merge partial reports without inventing a state
 * nobody observed.
 *
 * Runner: `node --test src/webview/lib/terminal-presence.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reportTerminalPresence, subscribeTerminalPresence, terminalPresence } from "./terminal-presence.ts";

const GENERATION = "0123456789abcdef0123456789abcdef";

function hiddenTerminal(): void {
	reportTerminalPresence({ visible: false, focused: false, generation: null });
}

describe("terminal presence", () => {
	it("reports the merged state to subscribers, once per change", () => {
		hiddenTerminal();
		const seen: string[] = [];
		const stop = subscribeTerminalPresence(value => seen.push(`${value.visible}/${value.focused}/${value.generation ?? "none"}`));

		reportTerminalPresence({ visible: true });
		// The generation of the pane that just became visible is part of the same
		// change: reporting it separately would notify a state nobody observed.
		reportTerminalPresence({ generation: GENERATION, focused: true });
		// A repeat of the current state is a no-op.
		reportTerminalPresence({ visible: true });
		reportTerminalPresence({});
		stop();
		reportTerminalPresence({ visible: false, focused: false, generation: null });

		assert.deepEqual(seen, ["true/false/none", `true/true/${GENERATION}`]);
		assert.deepEqual(terminalPresence(), { visible: false, focused: false, generation: null });
	});
});
