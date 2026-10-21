import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
	MAX_BTW_QUESTION_CHARS,
	btwCopyText,
	btwLatestTurn,
	btwRunning,
	btwShownStatus,
	btwTurnCount,
	type BtwRecordView,
	type BtwStatus,
} from "../../chat/btw";
import type { ChatModel } from "../../chat/model";
import { chatWritable } from "../lib/chat-client";
import type { BtwClient, BtwView } from "../lib/btw-client";
import { reportComposerPopupOpen } from "../lib/composer-overlay";
import { requestPanelAction } from "../lib/panel-actions";
import { useSendWith } from "../lib/send-with";
import { isSendChord, SEND_KEY_LABELS } from "../../chat/send-with";
import { CopyButton } from "./CopyButton";
import { Markdown } from "./Markdown";
import { PacedMarkdown } from "./PacedMarkdown";

const NOT_WRITABLE = "This conversation is not accepting input right now.";
const STATUS_LABEL: Readonly<Record<BtwStatus, string>> = {
	running: "Answering…",
	complete: "Done",
	cancelled: "Cancelled",
	error: "Failed",
	interrupted: "Interrupted",
};

/** Whether the conversation can still be answering a question: a stopped, failed, read-only or legacy one cannot. */
function canAnswer(model: ChatModel): boolean {
	return model.phase === "live" || model.phase === "starting" || model.phase === "attaching" || model.phase === "resyncing";
}

function firstLine(text: string): string {
	const line = text.trim().split("\n", 1)[0] ?? "";
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * The side-question panel of the bottom block (docs/designs/2026-10-19-chat-btw-side-questions.md): the topic that is answering or was
 * picked, one turn after another, with Cancel, Copy, a follow-up row and the list of the session's earlier topics. It sits in the dock
 * directly above the composer and in the column's flow, so the transcript's bottom anchor absorbs its height like the composer's. The
 * answer is OMP's side turn: it is never a transcript row, and nothing here reaches the conversation's turn state.
 *
 * Escape belongs to the panel while the focus is inside it: it cancels a running question, else closes the panel, and the host's stop
 * key stays disarmed for that press, so one Escape never also stops the main turn.
 */
export function BtwPanel({ btw, model }: { btw: BtwClient; model: ChatModel }): ReactNode {
	const view = useSyncExternalStore(btw.subscribe, btw.getSnapshot);
	const sectionRef = useRef<HTMLElement | null>(null);
	const [focused, setFocused] = useState(false);
	useEffect(() => {
		reportComposerPopupOpen("btw", focused);
		return () => reportComposerPopupOpen("btw", false);
	}, [focused]);

	const panel = view.panel;
	const shown = panel?.kind === "record" ? view.records.find(record => record.id === panel.id) : undefined;
	const answering = canAnswer(model);
	const writable = chatWritable(model);

	const close = useCallback((): void => {
		const holdsFocus = sectionRef.current?.contains(document.activeElement) === true;
		btw.close();
		if (holdsFocus) requestPanelAction("focus-composer");
	}, [btw]);
	const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>): void => {
		if (event.key !== "Escape" || event.nativeEvent.isComposing || event.keyCode === 229) return;
		event.preventDefault();
		event.stopPropagation();
		if (shown !== undefined && answering && btwRunning(shown) && writable) void btw.cancel(shown.id);
		else close();
	}, [answering, btw, close, shown, writable]);

	if (panel === null || (panel.kind === "record" && shown === undefined)) return null;
	return (
		<section ref={sectionRef} className="omp-btw" role="region" aria-label="Side question" aria-keyshortcuts="Escape" onKeyDown={onKeyDown}
			onFocus={() => setFocused(true)}
			onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
			{panel.kind === "history"
				? <HistoryView btw={btw} view={view} answering={answering} onClose={close} />
				: <RecordView btw={btw} view={view} record={shown!} answering={answering} writable={writable} onClose={close} />}
			{view.notice !== null && (
				<div className="omp-btw-notice" role="status">
					<span className="codicon codicon-warning" aria-hidden="true" />
					<span className="omp-btw-notice-text">{view.notice}</span>
					<button type="button" className="omp-btw-action" aria-label="Dismiss" title="Dismiss" onClick={() => btw.dismissNotice()}>
						<span className="codicon codicon-close" aria-hidden="true" />
					</button>
				</div>
			)}
		</section>
	);
}

function CloseButton({ onClose }: { onClose: () => void }): ReactNode {
	return (
		<button type="button" className="omp-btw-action omp-btw-close" aria-label="Close side question" aria-keyshortcuts="Escape" title="Close (Escape)" onClick={onClose}>
			<span className="codicon codicon-close" aria-hidden="true" />
		</button>
	);
}

function RecordView({ btw, view, record, answering, writable, onClose }: { btw: BtwClient; view: BtwView; record: BtwRecordView; answering: boolean; writable: boolean; onClose: () => void }): ReactNode {
	const latest = btwLatestTurn(record);
	const status = btwShownStatus(latest, answering);
	const running = status === "running";
	const copyText = btwCopyText(record);
	const why = writable ? undefined : NOT_WRITABLE;
	const anyRunning = view.records.some(item => btwRunning(item)) && answering;
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const follow = useRef(true);
	// The body follows the answer's tail while it streams, unless the reader scrolled up.
	useLayoutEffect(() => {
		const body = bodyRef.current;
		if (body !== null && follow.current) body.scrollTop = body.scrollHeight;
	}, [latest.answer.length, record.turns.length]);
	return (
		<>
			<div className="omp-btw-head">
				<span className="omp-btw-title">
					<span className="codicon codicon-comment-discussion" aria-hidden="true" />
					<span className="omp-hud-label">Side question</span>
					<span className="omp-btw-summary" title={record.turns[0]!.question}>{firstLine(record.turns[0]!.question)}</span>
				</span>
				<span className={`omp-btw-status omp-btw-status--${status}`} role="status">{STATUS_LABEL[status]}</span>
				{view.records.length > 1 && (
					<button type="button" className="omp-btw-action omp-btw-history" aria-label="Show earlier side questions" title="Earlier side questions" onClick={() => btw.showHistory()}>
						<span className="codicon codicon-history" aria-hidden="true" />
					</button>
				)}
				{copyText !== undefined && <CopyButton text={copyText} label="Copy answer" className="omp-btw-copy" />}
				{running && (
					<button type="button" className="omp-btw-action omp-btw-cancel" disabled={!writable} aria-label="Cancel the side question" aria-keyshortcuts="Escape" title={why ?? "Cancel the side question (Escape)"} onClick={() => void btw.cancel(record.id)}>
						<span className="codicon codicon-debug-stop" aria-hidden="true" />
					</button>
				)}
				<CloseButton onClose={onClose} />
			</div>
			<div ref={bodyRef} className="omp-btw-body" tabIndex={0} aria-label="Side question and answer"
				onScroll={event => { const body = event.currentTarget; follow.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24; }}>
				{(record.omitted ?? 0) > 0 && <div className="omp-btw-note">{record.omitted} earlier {record.omitted === 1 ? "turn is" : "turns are"} not shown.</div>}
				{record.turns.map((turn, index) => {
					const last = index === record.turns.length - 1;
					const turnRunning = last && running;
					return (
						<div key={`${record.omitted ?? 0}:${index}`} className="omp-btw-turn">
							<div className="omp-btw-question">{turn.question}</div>
							{turn.answer.length > 0
								? <div className="omp-btw-answer">{turnRunning ? <PacedMarkdown text={turn.answer} streaming /> : <Markdown text={turn.answer} />}</div>
								: turnRunning && <div className="omp-btw-wait"><span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" /> Answering…</div>}
							{turn.clipped === true && <div className="omp-btw-note">The answer was shortened.</div>}
							{turn.error !== undefined && <div className="omp-btw-error">{turn.error}</div>}
						</div>
					);
				})}
			</div>
			{!running && <FollowUp btw={btw} recordId={record.id} disabled={!writable || view.pending || anyRunning} why={why} />}
		</>
	);
}

function FollowUp({ btw, recordId, disabled, why }: { btw: BtwClient; recordId: string; disabled: boolean; why: string | undefined }): ReactNode {
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const mounted = useRef(true);
	const sendWith = useSendWith();
	useEffect(() => () => { mounted.current = false; }, []);
	const submit = async (): Promise<void> => {
		const question = text.trim();
		if (question.length === 0 || disabled || sending) return;
		setSending(true);
		const result = await btw.ask(question, recordId);
		if (!mounted.current) return;
		setSending(false);
		if (result.ok) setText("");
	};
	return (
		<div className="omp-btw-follow">
			<textarea className="omp-btw-input" rows={1} value={text} disabled={disabled} maxLength={MAX_BTW_QUESTION_CHARS} aria-label="Ask a follow-up in this side conversation" title={why}
				placeholder="Ask a follow-up…" spellCheck={false}
				onChange={event => setText(event.target.value)}
				onKeyDown={event => {
					if (!isSendChord(event, sendWith) || event.nativeEvent.isComposing || event.keyCode === 229) return;
					event.preventDefault();
					void submit();
				}} />
			<button type="button" className="omp-btw-send" disabled={disabled || sending || text.trim().length === 0} aria-label="Send the follow-up" title={why ?? `Send the follow-up (${SEND_KEY_LABELS[sendWith].send})`} onClick={() => void submit()}>
				<span className="codicon codicon-send" aria-hidden="true" />
			</button>
		</div>
	);
}

function when(time: number): string {
	return new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function HistoryView({ btw, view, answering, onClose }: { btw: BtwClient; view: BtwView; answering: boolean; onClose: () => void }): ReactNode {
	return (
		<>
			<div className="omp-btw-head">
				<span className="omp-btw-title">
					<span className="codicon codicon-history" aria-hidden="true" />
					<span className="omp-hud-label">Side questions</span>
					<span className="omp-btw-summary">{view.records.length === 0 ? "none yet" : `${view.records.length + view.omitted}`}</span>
				</span>
				<CloseButton onClose={onClose} />
			</div>
			{view.records.length === 0
				? <div className="omp-btw-note omp-btw-empty">No side questions in this session yet. Type /btw followed by a question.</div>
				: (
					<ul className="omp-btw-list" aria-label="Side questions of this session">
						{view.records.map(record => {
							const status = btwShownStatus(btwLatestTurn(record), answering);
							return (
								<li key={record.id}>
									<button type="button" className="omp-btw-item" onClick={() => btw.show(record.id)} title={record.turns[0]!.question}>
										<span className="omp-btw-item-text">{firstLine(record.turns[0]!.question)}</span>
										<span className={`omp-btw-status omp-btw-status--${status}`}>{STATUS_LABEL[status]}</span>
										<span className="omp-btw-item-meta">{btwTurnCount(record) > 1 ? `${btwTurnCount(record)} turns · ` : ""}{when(record.turns[0]!.createdAt)}</span>
									</button>
								</li>
							);
						})}
						{view.omitted > 0 && <li className="omp-btw-note">{view.omitted} older {view.omitted === 1 ? "side question is" : "side questions are"} not listed.</li>}
					</ul>
				)}
		</>
	);
}
