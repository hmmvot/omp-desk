import type { ReactNode } from "react";
import { guestTransport } from "../bridge";
import { useKeyHint } from "../lib/key-hints-store";

/**
 * The composer's keyboard icon: opens Keyboard Shortcuts filtered to this extension's keys, as `/hotkeys` does. It touches no draft, so
 * a held draft capture does not disable it. The title names the key the user effectively has for the command.
 */
export function KeyboardShortcutsButton(): ReactNode {
	const { key } = useKeyHint("ompDesk.showChatKeyboardShortcuts");
	return (
		<button
			type="button"
			className="omp-btn omp-composer-keyboard"
			aria-label="Keyboard shortcuts"
			title={key === null ? "Keyboard shortcuts" : `Keyboard shortcuts (${key})`}
			onClick={() => guestTransport.post({ type: "omp:chat-command", command: "keyboard-shortcuts" })}
		>
			<span aria-hidden="true" className="codicon codicon-keyboard" />
		</button>
	);
}
