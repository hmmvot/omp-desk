import type { ReactNode } from "react";
import { guestTransport } from "../bridge";
import { folderName, shortAge } from "../lib/empty-state";
import { useKeyHint } from "../lib/key-hints-store";
import { useRecentSessions } from "../lib/recent-sessions";
import type { EmptyStateKeyCommand } from "../../shared/key-hints";

/** One Desk command's key as the user effectively has it: a `<kbd>`, `none` when removed, and a warning button when another binding may take it. */
function CommandKey({ command }: { command: EmptyStateKeyCommand }): ReactNode {
	const { key, conflicts, more } = useKeyHint(command);
	if (key === null) return <kbd className="omp-empty-key--none">none</kbd>;
	const lines = conflicts.map(conflict => `${key} may be taken by ${conflict.by}: ${conflict.command}`);
	if (more > 0) lines.push(`and ${more} more`);
	const tooltip = lines.join("\n");
	return <>
		<kbd>{key}</kbd>
		{lines.length > 0 && <button type="button" className="omp-empty-key-conflict" aria-label={tooltip} title={tooltip}
			onClick={() => guestTransport.post({ type: "omp:open-key-conflict", command })}>
			<span className="codicon codicon-warning" aria-hidden="true" />
		</button>}
	</>;
}

function Hint({ keys, children }: { keys: ReactNode; children: ReactNode }): ReactNode {
	return <div className="omp-empty-key"><dt>{keys}</dt><dd>{children}</dd></div>;
}

function Group({ title, children }: { title: string; children: ReactNode }): ReactNode {
	return <section className="omp-empty-group"><h3>{title}</h3><dl className="omp-empty-keys">{children}</dl></section>;
}

/** The link under the groups: Keyboard Shortcuts filtered to this extension's keys. The key in its text is the effective one. */
function ShortcutsLink(): ReactNode {
	const { key } = useKeyHint("ompDesk.showChatKeyboardShortcuts");
	return <button type="button" className="omp-empty-shortcuts" onClick={() => guestTransport.post({ type: "omp:chat-command", command: "keyboard-shortcuts" })}>
		{key === null ? "All keyboard shortcuts" : `All keyboard shortcuts (${key})`}
	</button>;
}

/**
 * What an empty conversation shows instead of one italic line: the folder, the model and thinking level
 * already on the page, the key hints, and up to three recent sessions of the same folder (a click opens one
 * as a click on its row in Sessions does). Recents are the only part that needs the host; without them the
 * hints stand alone.
 */
export function EmptyState({ cwd, model, thinkingLevel }: {
	cwd?: string;
	model?: { id: string; name?: string } | null;
	thinkingLevel?: string | null;
}): ReactNode {
	const recents = useRecentSessions(cwd);
	const modelName = model === null || model === undefined ? null : model.name ?? model.id;
	const setting = [modelName, thinkingLevel].filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
	const now = Date.now();
	return (
		<div className="omp-empty-state">
			<div className="omp-empty-state-body">
				<div className="omp-empty-head">
					<span className="codicon codicon-sparkle" aria-hidden="true" />
					{cwd !== undefined && <b>{folderName(cwd)}</b>}
					{setting.length > 0 && <small>{setting}</small>}
				</div>
				<div className="omp-empty-groups">
					<Group title="Start">
						<Hint keys={<kbd>/</kbd>}>commands and skills</Hint>
						<Hint keys={<kbd>@</kbd>}>attach a file</Hint>
						<Hint keys={<><kbd>Ctrl+V</kbd> or <kbd>Shift</kbd>+drag</>}>an attachment</Hint>
						<Hint keys={<kbd>↑</kbd>}>an earlier prompt</Hint>
						<Hint keys={<CommandKey command="ompDesk.searchPromptHistory" />}>search prompts</Hint>
					</Group>
					<Group title="While the agent works">
						<Hint keys={<kbd>Enter</kbd>}>steer</Hint>
						<Hint keys={<kbd>Alt+Enter</kbd>}>queue</Hint>
						<Hint keys={<kbd>Alt+↑</kbd>}>take a queued message back</Hint>
						<Hint keys={<CommandKey command="ompDesk.stopTurn" />}>stop</Hint>
					</Group>
					<Group title="In the conversation">
						<Hint keys={<CommandKey command="ompDesk.findInChat" />}>find</Hint>
						<Hint keys={<CommandKey command="ompDesk.quoteChatSelection" />}>quote</Hint>
						<Hint keys={<kbd>Esc Esc</kbd>}>rewind</Hint>
						<Hint keys={<><CommandKey command="ompDesk.toggleThinking" /> / <CommandKey command="ompDesk.toggleToolOutput" /></>}>thinking / tool calls</Hint>
					</Group>
					<Group title="From the editor and anywhere">
						<Hint keys={<CommandKey command="ompDesk.quoteEditorSelection" />}>quote or line reference</Hint>
						<Hint keys={<CommandKey command="ompDesk.focusComposer" />}>composer</Hint>
						<Hint keys={<CommandKey command="ompDesk.goToSession" />}>go to session</Hint>
						<Hint keys={<CommandKey command="ompDesk.newSession" />}>new session</Hint>
					</Group>
				</div>
				<ShortcutsLink />
				{recents.items.length > 0 && <>
					<h3>Recent in this folder</h3>
					<ul className="omp-empty-recent">
						{recents.items.map((item, index) => <li key={index}>
							<button type="button" title={item.title} onClick={() => recents.open(index)}>
								<span className="codicon codicon-history" aria-hidden="true" />
								<span className="omp-empty-recent-title">{item.title}</span>
								<span className="omp-empty-recent-age">{shortAge(item.updatedAt, now)}</span>
							</button>
						</li>)}
					</ul>
				</>}
			</div>
		</div>
	);
}
