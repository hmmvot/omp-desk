/**
 * A folder shell's editor: one general-purpose terminal, in its own tab.
 *
 * This is deliberately not a session. `Open Terminal` on a folder creates a *new*
 * shell whose working directory is that folder, and the user may run anything in it,
 * including a manual `omp`. Nothing here adopts that process as a managed session, and
 * nothing here stops it: an `omp` started by hand has no authenticated control
 * bootstrap and no claim this extension may act on.
 *
 * The path this shell runs in arrives with the host's own report of the terminal
 * (`sessionLabel`), so this view renders what the host said rather than guessing from
 * a slot id.
 */
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { guestTransport } from "../bridge";
import { TerminalPane } from "./TerminalPane";

export function ShellView(): ReactNode {
	const [label, setLabel] = useState<string | undefined>(undefined);

	// The host names the folder when it describes the terminal, and may do so again after
	// a reconnect; the newest name wins and nothing else is read out of the frames.
	useEffect(() => {
		return guestTransport.subscribe(message => {
			if (message.type === "omp:terminal-state" && message.sessionLabel !== undefined) setLabel(message.sessionLabel);
		});
	}, []);

	// `active` is always true: this document has exactly one surface. The focus signal is
	// raised once because opening a shell editor *is* the user asking for a terminal —
	// the caret belongs in it, ready to type.
	return (
		<div className="omp-app">
			<TerminalPane active title={label} focusSignal={1} passive={false} />
		</div>
	);
}
