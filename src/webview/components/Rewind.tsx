/**
 * Rewind's page surfaces (design `docs/designs/2026-10-09-chat-rewind.md`): the bar above the composer while a
 * prompt is being picked or a navigation runs, the one-line Undo offer, and the branch-point marker the transcript
 * places after the card where other branches leave the active path. State lives in `ChatView`
 * (`lib/rewind-mode.ts`); these components only render it and report the user's choices.
 */
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { useState } from "react";
import type { ChatEntry } from "../../chat/messages";
import { rewindPreview, type BranchPoint, type RewindTarget, type UndoOffer } from "../../chat/rewind";
import type { RewindMode } from "../lib/rewind-mode";
import { FileLink } from "./FileLinks";

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const PENDING_LABEL: Record<string, string> = { rewind: "Rewinding…", undo: "Undoing the rewind…", switch: "Switching branch…" };

export function RewindBar({ mode, targets, entries, cwd, blocked, undo, notice, barRef, onMove, onSubmit, onCancel, onUndo, onDismissNotice }: {
	mode: RewindMode;
	targets: readonly RewindTarget[];
	/** Durable rows of the loaded branch; the preview counts what leaves it. */
	entries: readonly ChatEntry[];
	cwd: string | undefined;
	/** Why Rewind cannot run now, or null. */
	blocked: string | null;
	undo: UndoOffer | null;
	/** The last navigation's refusal or caveat, until dismissed or replaced. */
	notice: string | null;
	barRef: RefObject<HTMLDivElement | null>;
	onMove(to: "previous" | "next" | "first" | "last"): void;
	onSubmit(summarize: boolean): void;
	onCancel(): void;
	onUndo(): void;
	onDismissNotice(): void;
}): ReactNode {
	if (mode.kind === "pending") {
		return <div className="omp-rewind-bar" role="status"><span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />{PENDING_LABEL[mode.action]}{mode.summarize ? " Summarizing the abandoned branch can take a while." : ""}</div>;
	}
	if (mode.kind === "picking") {
		const target = targets.find(candidate => candidate.id === mode.targetId);
		const preview = target === undefined ? null : rewindPreview(entries, target.id, cwd);
		const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
			const key = event.key;
			if (key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End") onMove(key === "ArrowUp" ? "previous" : key === "ArrowDown" ? "next" : key === "Home" ? "first" : "last");
			else if (key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey) {
				if (event.target instanceof HTMLButtonElement) return;
				if (blocked === null) onSubmit(event.shiftKey);
			} else if (key === "Escape") onCancel();
			else return;
			event.preventDefault();
			event.stopPropagation();
		};
		return (
			<div ref={barRef} className="omp-rewind-bar omp-rewind-bar--picking" role="group" aria-label="Rewind the conversation" tabIndex={-1} onKeyDown={onKeyDown}>
				<div className="omp-rewind-title" aria-live="polite">
					<span className="codicon codicon-discard" aria-hidden="true" />
					<span>Rewind to: <q className="omp-rewind-target">{target?.preview ?? ""}</q>{preview !== null && ` · ${plural(preview.messages, "message")} leave${preview.messages === 1 ? "s" : ""} this branch`}</span>
				</div>
				{preview !== null && (preview.files.length > 0 || preview.commands > 0) && (
					<div className="omp-rewind-files">
						<span className="codicon codicon-warning" aria-hidden="true" />
						<span>
							{preview.files.length > 0 ? "Files changed after this point stay as they are: " : "Nothing on disk is undone: "}
							{preview.files.map((file, index) => <span key={file}>{index > 0 && ", "}<FileLink target={file}>{file}</FileLink></span>)}
							{preview.commands > 0 && `${preview.files.length > 0 ? " · " : ""}${plural(preview.commands, "command")} ran after it`}
						</span>
					</div>
				)}
				{/* Unavailable: the bar says why instead of offering the actions (design § UX). */}
				{blocked !== null && <div className="omp-rewind-blocked" role="status">{blocked}</div>}
				<div className="omp-rewind-actions">
					{blocked === null && <button type="button" className="omp-btn omp-btn--primary" disabled={target === undefined} onClick={() => onSubmit(false)}>Rewind</button>}
					{blocked === null && <button type="button" className="omp-btn" disabled={target === undefined} title="Rewind and keep a model-written summary of the abandoned messages" onClick={() => onSubmit(true)}>Rewind &amp; summarize</button>}
					<button type="button" className="omp-btn" onClick={onCancel}>Cancel</button>
					<span className="omp-rewind-legend">{blocked === null ? "↑↓ choose · Enter rewind · Shift+Enter summarize · Esc cancel" : "Esc cancel"}</span>
				</div>
			</div>
		);
	}
	if (notice !== null) {
		return (
			<div className="omp-rewind-bar omp-rewind-bar--notice" role="status">
				<span>{notice}</span>
				<button type="button" className="omp-btn" aria-label="Dismiss rewind notice" onClick={onDismissNotice}>Dismiss</button>
			</div>
		);
	}
	if (undo === null) return null;
	return (
		<div className="omp-rewind-bar omp-rewind-bar--undo" role="status">
			<span className="codicon codicon-discard" aria-hidden="true" />
			<span>{undo.kind === "switch" ? "Switched branch" : "Rewound"}{undo.summarized ? " with a summary" : ""}</span>
			<button type="button" className="omp-btn" disabled={blocked !== null} title={blocked ?? "Return to where the conversation was"} onClick={onUndo}>Undo</button>
		</div>
	);
}

/** "⎇ N other branches · M messages" after the card where they leave the path; opens a list to switch to one. */
export function BranchPointMarker({ point, onSwitch }: { point: BranchPoint; onSwitch?: (tipId: string) => void }): ReactNode {
	const [open, setOpen] = useState(false);
	const messages = point.branches.reduce((total, branch) => total + branch.messages, 0);
	return (
		<div className="omp-branch-point">
			<button type="button" className="omp-branch-point-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
				<span className="codicon codicon-git-branch" aria-hidden="true" />
				{point.branches.length} other branch{point.branches.length === 1 ? "" : "es"} · {plural(messages, "message")}
			</button>
			{open && (
				<ul className="omp-branch-list">
					{point.branches.map(branch => (
						<li key={branch.tipId}>
							<button type="button" className="omp-branch-switch" disabled={onSwitch === undefined} title={onSwitch === undefined ? "Switching is unavailable right now" : "Switch to this branch"} onClick={() => onSwitch?.(branch.tipId)}>
								<span className="omp-branch-name">{branch.firstPrompt ?? "Branch"}</span>
								<span className="omp-branch-size">{plural(branch.messages, "message")}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
