import type { ReactNode } from "react";
import { useId } from "react";
import type { ChatModel } from "../../chat/model";
import { runningAgentDescriptions, TODO_STATUS_WORD, todoNoteMarker, todoSummary, todoWindowWithin } from "../../chat/hud-summary";
import { HudHeader, useDetailOpener } from "./HudRows";

export interface TodoHudProps {
	model: ChatModel;
	expanded: boolean;
	onToggle: () => void;
	/** Rows (content plus `+N more`) the bottom block's height cap leaves this row when expanded. */
	lines: number;
}

/**
 * The TODO row of the bottom block. Collapsed it is one line (the current task and one counter);
 * expanded it is the TUI's compact list, bounded, with the rest in the TODO tab. Display hints
 * never write native todo status or reproduce interactive auto-clear. Expansion is owned by the
 * dock so both rows share one height cap.
 */
export function TodoHud({ model, expanded, onToggle, lines }: TodoHudProps): ReactNode {
	const listId = useId();
	const detail = useDetailOpener();
	const phases = model.todo?.phases ?? [];
	const summary = todoSummary(phases);
	if (summary === null) return null;
	const window = expanded ? todoWindowWithin(phases, runningAgentDescriptions(model.agents.values()), lines) : null;

	return (
		<section className="omp-hud omp-hud--todo" aria-label="TODO">
			<HudHeader
				name="TODO"
				icon="checklist"
				summary={summary.current}
				counter={{ text: summary.counter, title: summary.title }}
				expanded={expanded}
				controls={listId}
				onToggle={onToggle}
				openLabel="Open TODO in editor tab"
				onOpen={() => detail.open({ kind: "todo" })}
				openAvailable={detail.available}
			/>
			{window !== null && (
				<ul id={listId} className="omp-hud-rows">
					{window.rows.map(row => row.kind === "phase" ? (
						<li key={row.key} className={`omp-hud-line omp-hud-phase${row.current ? " omp-hud-phase--current" : ""}`}>
							<span className="omp-hud-text">{row.label}</span>
						</li>
					) : (
						<li key={row.key} className={`omp-hud-line omp-hud-task omp-hud-tone--${row.glyph.tone}`} title={row.task.blocker === undefined ? row.task.content : `${row.task.content}\nBlocker: ${row.task.blocker}`}>
							<span className={`codicon codicon-${row.glyph.icon}`} aria-hidden="true" />
							<span className="omp-hud-text">{row.glyph.struck ? <s>{row.task.content}</s> : row.task.content}</span>
							{row.task.status === "blocked" && <span className="omp-hud-dim" aria-hidden="true">(blocked)</span>}
							{row.noteCount > 0 && <span className="omp-hud-dim" aria-hidden="true" title={`${row.noteCount} ${row.noteCount === 1 ? "note" : "notes"}`}>{todoNoteMarker(row.noteCount)}</span>}
							<span className="omp-sr-only">{TODO_STATUS_WORD[row.task.status]}{row.noteCount > 0 ? `, ${row.noteCount} ${row.noteCount === 1 ? "note" : "notes"}` : ""}</span>
						</li>
					))}
					{window.hidden > 0 && (
						<li className="omp-hud-line">
							<button type="button" className="omp-hud-more" disabled={!detail.available} onClick={() => detail.open({ kind: "todo" })}>+{window.hidden} more</button>
						</li>
					)}
				</ul>
			)}
		</section>
	);
}
