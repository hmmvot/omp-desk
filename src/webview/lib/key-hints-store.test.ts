/**
 * Tests for the page's copy of the effective Chat keys: the manifest default until the host speaks, the host's key and conflicts after,
 * garbage and repeats changing nothing, and the transport path.
 *
 * Runner: `node --test src/webview/lib/key-hints-store.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { displayKey } from "../../host/key-hints.ts";
import type { GuestHostMessage } from "../../protocol/messages.ts";
import { EMPTY_STATE_KEY_COMMANDS, type EmptyStateKeyCommand } from "../../shared/key-hints.ts";
import { attachKeyHints, DEFAULT_KEYS, setKeyHints, useKeyHint, type KeyHintView } from "./key-hints-store.ts";

function shown(command: EmptyStateKeyCommand): KeyHintView {
	const seen: KeyHintView[] = [];
	renderToStaticMarkup(createElement(() => {
		seen.push(useKeyHint(command));
		return null;
	}));
	assert.equal(seen.length, 1);
	return seen[0]!;
}

const THINKING = "ompDesk.toggleThinking";

afterEach(() => setKeyHints([]));

describe("key hints store", () => {
	it("has a default for every command of the empty state", () => {
		assert.deepEqual(Object.keys(DEFAULT_KEYS).sort(), [...EMPTY_STATE_KEY_COMMANDS].sort());
	});

	it("shows the keys package.json binds, so the page and the manifest cannot drift apart", () => {
		const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { contributes: { keybindings: Array<{ command: string; key: string }> } };
		const fromManifest = Object.fromEntries(EMPTY_STATE_KEY_COMMANDS.map(command => [command, displayKey(manifest.contributes.keybindings.find(binding => binding.command === command)?.key ?? "")]));
		assert.deepEqual(DEFAULT_KEYS, fromManifest);
	});

	it("shows the default until the host speaks, then the host's key, conflicts and count", () => {
		assert.deepEqual(shown(THINKING), { key: "Ctrl+Alt+T", conflicts: [], more: 0 });
		setKeyHints([{ command: THINKING, key: "Alt+Shift+T", conflicts: [{ by: "IntelliJ IDEA Keymap", command: "git.sync" }], more: 2 }]);
		assert.deepEqual(shown(THINKING), { key: "Alt+Shift+T", conflicts: [{ by: "IntelliJ IDEA Keymap", command: "git.sync" }], more: 2 });
		assert.equal(shown("ompDesk.stopTurn").key, "Esc", "a command the host did not name keeps its default");
	});

	it("shows a removed key as null, and returns to the default when the host sends nothing for it", () => {
		setKeyHints([{ command: THINKING, key: null, conflicts: [], more: 0 }]);
		assert.equal(shown(THINKING).key, null);
		setKeyHints([]);
		assert.equal(shown(THINKING).key, "Ctrl+Alt+T");
	});

	it("keeps the previous state on garbage and ignores identical content", () => {
		const hint = { command: THINKING, key: "Alt+Shift+T", conflicts: [], more: 0 };
		setKeyHints([hint]);
		const before = shown(THINKING);
		const garbage: unknown[] = [null, "x", 3, {}, [{ command: "evil.command", key: "A", conflicts: [], more: 0 }], [{ command: THINKING, key: 4, conflicts: [], more: 0 }],
			[{ command: THINKING, key: "A", conflicts: [{ by: 1, command: "c" }], more: 0 }], [{ command: THINKING, key: "A", conflicts: [], more: -1 }], [hint, hint]];
		for (const value of garbage) {
			setKeyHints(value);
			assert.equal(shown(THINKING), before);
		}
		setKeyHints([{ ...hint }]);
		assert.equal(shown(THINKING), before, "the same content is the same object");
	});

	it("follows omp:chat-keys on the transport and stops following a replaced attachment", () => {
		const listeners = new Set<(message: GuestHostMessage) => void>();
		const transport = { subscribe: (listener: (message: GuestHostMessage) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
		attachKeyHints(transport);
		for (const listener of listeners) listener({ type: "omp:chat-keys", keys: [{ command: THINKING, key: "Ctrl+K Ctrl+T", conflicts: [], more: 0 }] });
		assert.equal(shown(THINKING).key, "Ctrl+K Ctrl+T");
		attachKeyHints({ subscribe: () => () => {} });
		assert.equal(listeners.size, 0);
	});
});
