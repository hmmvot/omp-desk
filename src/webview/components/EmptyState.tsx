import type { ReactNode } from "react";
import { folderName, shortAge } from "../lib/empty-state";
import { useRecentSessions } from "../lib/recent-sessions";

/** The key hints of a conversation that has not started; static, no data. */
const HINTS: readonly { keys: string; text: string }[] = [
	{ keys: "/", text: "commands and skills" },
	{ keys: "@", text: "attach a file" },
	{ keys: "Alt+Enter", text: "queue a follow-up while the agent works" },
	{ keys: "Esc Esc", text: "rewind to an earlier prompt" },
];

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
				<h3>Start</h3>
				<dl className="omp-empty-keys">
					{HINTS.map(hint => <div key={hint.keys} className="omp-empty-key"><dt><kbd>{hint.keys}</kbd></dt><dd>{hint.text}</dd></div>)}
				</dl>
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
