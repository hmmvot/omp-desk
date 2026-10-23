/**
 * The native `ask` tool's dialog: every question of one call at once.
 *
 * It mirrors the OMP TUI's `AskDialogComponent` (pi-tui `overlays/ask-dialog.ts`): a tab per question plus a
 * trailing Submit (review) tab whenever there is more than one question or any question is multi-select
 * (`#hasSubmitTab`); a single-select answer commits and moves to the next tab (`#advanceAfterQuestion`), a
 * multi-select toggles and is confirmed with Next; Left/Right (and Shift+Tab/Tab in the terminal) cycle the tabs
 * with wrap-around (`handleTabSwitchKey`, `#switchTab`); the review tab lists every answer, flags the
 * unanswered ones and still submits them; the one submit answers every question in request order. A lone
 * single-select question has no tabs and submits on its answer.
 *
 * Tab/Shift+Tab stay the browser's focus traversal here: capturing them would trap keyboard focus inside the
 * card, so the tabs are reached with Left/Right (wrapping) and clicks.
 *
 * Answers live in this component only; typing Other updates the answer immediately, and nothing is sent until Submit.
 */
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChatAskAnswer, ChatAskQuestion, ChatUiRequest } from "../../chat/model";
import { useSendWith } from "../lib/send-with";
import { useSecondTick } from "../lib/live-clock";
import { isSendChord } from "../../chat/send-with";
import { Markdown } from "./Markdown";

type AskRequest = Extract<ChatUiRequest, { method: "ask" }>;

const OTHER_LABEL = "Other (type your own)";
const RECOMMENDED_SUFFIX = " (Recommended)";
const MAX_TAB_CHARS = 24;

/** What the user has answered for one question. A single-select holds either one option or a custom answer, never both. */
interface QuestionState {
	selected: readonly string[];
	custom: string | undefined;
}

/** The tab text: the question's `header` chip when it has one, else its first words (the TUI falls back to the id). */
export function askTabLabel(question: ChatAskQuestion, index: number): string {
	const header = question.header?.trim();
	const words = question.question.trim().replace(/\s+/g, " ");
	const text = header !== undefined && header.length > 0 ? header : words;
	if (text.length === 0) return `Q${index + 1}`;
	if (text.length <= MAX_TAB_CHARS) return text;
	if (header === undefined || header.length === 0) {
		// First whole words that fit, so a tab never ends mid-word.
		let out = "";
		for (const word of text.split(" ")) {
			const next = out.length === 0 ? word : `${out} ${word}`;
			if (next.length > MAX_TAB_CHARS) break;
			out = next;
		}
		if (out.length > 0) return `${out}…`;
	}
	return `${text.slice(0, MAX_TAB_CHARS - 1)}…`;
}

function displayLabel(question: ChatAskQuestion, index: number): string {
	const label = question.options[index]?.label ?? "";
	return question.recommended === index && !label.endsWith(RECOMMENDED_SUFFIX) ? `${label}${RECOMMENDED_SUFFIX}` : label;
}

function isAnswered(state: QuestionState): boolean {
	return state.selected.length > 0 || state.custom !== undefined;
}

function summarize(question: ChatAskQuestion, state: QuestionState): string | null {
	const parts = question.options.flatMap((option, index) => (state.selected.includes(option.label) ? [displayLabel(question, index)] : []));
	if (state.custom !== undefined) parts.push(question.multi ? `Other: “${state.custom}”` : `“${state.custom}”`);
	return parts.length === 0 ? null : parts.join(", ");
}

export interface AskOptionRowProps {
	/** `radio`/`checkbox` rows report their checked state; a plain row is an action. */
	role?: "radio" | "checkbox";
	checked?: boolean;
	marker: string;
	label: string;
	description?: string;
	/** The option has a preview, shown below the list while the row is highlighted. */
	hasPreview?: boolean;
	disabled?: boolean;
	/** The pointer entered or the keyboard focused the row. */
	onHighlight?(): void;
	onClick(): void;
}

/**
 * One answer row. The label takes the whole row width and wraps inside it; the description sits below it, muted,
 * at the label's indent.
 */
export function AskOptionRow({ role, checked, marker, label, description, hasPreview, disabled, onHighlight, onClick }: AskOptionRowProps): ReactNode {
	return (
		<button
			type="button"
			className={`omp-ask-option${checked === true ? " omp-ask-option--checked" : ""}`}
			role={role}
			aria-checked={role === undefined ? undefined : checked === true}
			data-has-preview={hasPreview === true ? "true" : undefined}
			disabled={disabled}
			onFocus={onHighlight}
			onMouseEnter={onHighlight}
			onClick={onClick}
		>
			<span className={`omp-ask-option-marker codicon codicon-${marker}`} aria-hidden="true" />
			<span className="omp-ask-option-text">
				<span className="omp-ask-option-label">{label}</span>
				{description !== undefined && description.length > 0 && <span className="omp-ask-option-desc">{description}</span>}
			</span>
		</button>
	);
}

/** Whole seconds left before OMP answers an `ask` for the user; never more than the timeout itself, so a skewed clock cannot overstate it. */
export function askSecondsLeft(timeoutMs: number, expiresAt: number | undefined, now: number): number {
	const left = expiresAt === undefined ? timeoutMs : Math.min(timeoutMs, expiresAt - now);
	return Math.max(0, Math.ceil(left / 1000));
}

function formatCountdown(seconds: number): string {
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes} min ${String(seconds % 60).padStart(2, "0")} s` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** The countdown to OMP's own timeout: it answers the recommended option of every question and closes the dialog. */
function AskCountdown({ timeoutMs, expiresAt }: { timeoutMs: number; expiresAt: number | undefined }): ReactNode {
	const [mountedAt] = useState(() => Date.now());
	useSecondTick(true);
	const seconds = askSecondsLeft(timeoutMs, expiresAt ?? mountedAt + timeoutMs, Date.now());
	return (
		<div className="omp-ask-timer" role="timer" title="When the time runs out, OMP answers the recommended option of every question">
			<span className="codicon codicon-clock" aria-hidden="true" /> Answers itself in {formatCountdown(seconds)}
		</div>
	);
}

interface CustomEditorProps {
	draft: string;
	onChange(draft: string): void;
	onCommit(draft: string): void;
}

/** The "Other" text entry: typing updates the answer; the send key of `ompDesk.chatSendWith` (Enter by default) / Use answer advances, the other Enter chord inserts a newline. */
function CustomEditor({ draft, onChange, onCommit }: CustomEditorProps): ReactNode {
	const ref = useRef<HTMLTextAreaElement | null>(null);
	const sendWith = useSendWith();
	useEffect(() => {
		ref.current?.focus();
	}, []);
	return (
		<div className="omp-ask-custom">
			<textarea
				ref={ref}
				className="omp-textarea"
				rows={2}
				value={draft}
				placeholder="Type your own answer"
				spellCheck={false}
				onChange={event => onChange(event.target.value)}
				onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
					if (isSendChord(event, sendWith) && !event.nativeEvent.isComposing && event.keyCode !== 229) {
						event.preventDefault();
						onCommit(draft);
					}
				}}
			/>
			<div className="omp-composer-actions">
				<button type="button" className="omp-btn omp-btn--primary" onClick={() => onCommit(draft)}>
					Use answer
				</button>
			</div>
		</div>
	);
}

export function AskDialog({ request, onRespond }: { request: AskRequest; onRespond(answers: readonly ChatAskAnswer[]): void }): ReactNode {
	const { questions } = request;
	const hasTabs = questions.length > 1 || questions.some(question => question.multi);
	const reviewIndex = questions.length;
	const tabCount = hasTabs ? questions.length + 1 : 1;
	const [states, setStates] = useState<readonly QuestionState[]>(() => questions.map(() => ({ selected: [], custom: undefined })));
	/** Open "Other" editors by question; the text survives a tab switch. */
	const [drafts, setDrafts] = useState<readonly (string | null)[]>(() => questions.map(() => null));
	const [active, setActive] = useState(0);
	/** The highlighted option of each question, for its preview; `undefined` until the pointer or the keyboard picks one. */
	const [cursors, setCursors] = useState<readonly (number | undefined)[]>(() => questions.map(() => undefined));
	const baseId = useId();
	const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const focusTabNext = useRef(false);
	const submitRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (!focusTabNext.current) return;
		focusTabNext.current = false;
		tabRefs.current[active]?.focus();
	}, [active]);

	// Arriving on review by answering (a picked option or a committed "Other" unmounts what had the focus) puts the focus on
	// Submit answers, so Enter submits; arriving by keyboard keeps it on the tab, where Enter submits too (see onKeyDown).
	const onReview = hasTabs && active === reviewIndex;
	useEffect(() => {
		if (!onReview) return;
		const focused = document.activeElement;
		if (focused instanceof HTMLElement && focused.closest(".omp-ask-tabs") !== null) return;
		submitRef.current?.focus();
	}, [onReview]);

	const submit = useCallback(
		(final: readonly QuestionState[]): void => {
			onRespond(
				questions.map((question, index): ChatAskAnswer => {
					const state = final[index] ?? { selected: [], custom: undefined };
					const selectedOptions = question.options.map(option => option.label).filter(label => state.selected.includes(label));
					return state.custom === undefined ? { id: question.id, selectedOptions } : { id: question.id, selectedOptions, customInput: state.custom };
				}),
			);
		},
		[onRespond, questions],
	);

	/** Move past question `from`, or submit when it was the only one. */
	const advance = useCallback(
		(from: number, final: readonly QuestionState[]): void => {
			if (!hasTabs) {
				submit(final);
				return;
			}
			setActive(from + 1 < questions.length ? from + 1 : reviewIndex);
		},
		[hasTabs, questions.length, reviewIndex, submit],
	);

	const update = (index: number, state: QuestionState): readonly QuestionState[] => {
		const next = states.map((existing, at) => (at === index ? state : existing));
		setStates(next);
		return next;
	};

	const pick = (index: number, label: string): void => {
		const question = questions[index]!;
		const state = states[index]!;
		if (question.multi) {
			const selected = state.selected.includes(label) ? state.selected.filter(existing => existing !== label) : [...state.selected, label];
			update(index, { ...state, selected });
			return;
		}
		setDrafts(drafts.map((draft, at) => (at === index ? null : draft)));
		advance(index, update(index, { selected: [label], custom: undefined }));
	};

	const editCustom = (index: number, draft: string): void => {
		const question = questions[index]!;
		const text = draft.trim();
		setDrafts(drafts.map((existing, at) => (at === index ? draft : existing)));
		update(index, { selected: question.multi ? states[index]!.selected : [], custom: text.length > 0 ? text : undefined });
	};

	const commitCustom = (index: number, draft: string): void => {
		const question = questions[index]!;
		const state = states[index]!;
		const text = draft.trim();
		setDrafts(drafts.map((existing, at) => (at === index ? null : existing)));
		if (text.length === 0) {
			// An empty entry withdraws the custom answer and stays on the question.
			update(index, { ...state, custom: undefined });
			return;
		}
		advance(index, update(index, { selected: question.multi ? state.selected : [], custom: text }));
	};

	const toggleOther = (index: number): void => {
		const question = questions[index]!;
		const state = states[index]!;
		const clear = question.multi && (drafts[index] !== null || state.custom !== undefined);
		setDrafts(drafts.map((draft, at) => (at === index ? (clear ? null : state.custom ?? "") : draft)));
		update(index, { selected: question.multi ? state.selected : [], custom: clear ? undefined : state.custom });
	};

	const highlight = (at: number, option: number): void => {
		setCursors(existing => (existing[at] === option ? existing : existing.map((cursor, position) => (position === at ? option : cursor))));
	};

	const go = (index: number, fromKeyboard: boolean): void => {
		if (index < 0 || index >= tabCount) return;
		focusTabNext.current = fromKeyboard;
		setActive(index);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const target = event.target;
		if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
		// On review, Enter submits from anywhere but a review row, which opens its question.
		if (event.key === "Enter" && onReview && !(target instanceof HTMLElement && target.closest(".omp-ask-review-row") !== null) && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit(states);
			return;
		}
		if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
			if (!hasTabs) return;
			event.preventDefault();
			go((active + (event.key === "ArrowRight" ? 1 : -1) + tabCount) % tabCount, true);
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			const rows = [...(panelRef.current?.querySelectorAll<HTMLElement>(".omp-ask-option, .omp-ask-review-row") ?? [])];
			if (rows.length === 0) return;
			event.preventDefault();
			const at = rows.findIndex(row => row === document.activeElement);
			const next = event.key === "ArrowDown" ? (at + 1) % rows.length : (at <= 0 ? rows.length : at) - 1;
			rows[next]?.focus();
		}
	};

	const index = Math.min(active, questions.length - 1);
	const question = questions[index]!;
	const state = states[index]!;
	const draft = drafts[index];
	// The option the pointer or the keyboard is on (the recommended one, else the first, until one is): its preview is the one shown, as in the terminal UI.
	const previewAt = Math.min(cursors[index] ?? question.recommended ?? 0, Math.max(0, question.options.length - 1));
	const preview = onReview ? undefined : question.options[previewAt]?.preview;
	const unanswered = states.filter(existing => !isAnswered(existing)).length;
	const tabId = (at: number): string => `${baseId}-tab-${at}`;
	const panelId = `${baseId}-panel`;

	return (
		<div className="omp-ask-dialog" onKeyDown={onKeyDown}>
			{request.timeoutMs !== undefined && <AskCountdown timeoutMs={request.timeoutMs} expiresAt={request.expiresAt} />}
			{hasTabs && (
				<div className="omp-ask-tabs" role="tablist" aria-label="Questions">
					{questions.map((tabQuestion, at) => {
						const answered = isAnswered(states[at]!);
						const label = askTabLabel(tabQuestion, at);
						return (
							<button
								key={tabQuestion.id}
								ref={element => {
									tabRefs.current[at] = element;
								}}
								id={tabId(at)}
								type="button"
								role="tab"
								aria-selected={active === at}
								aria-controls={panelId}
								aria-label={`Question ${at + 1}: ${label} (${answered ? "answered" : "unanswered"})`}
								tabIndex={active === at ? 0 : -1}
								title={tabQuestion.header?.trim() || tabQuestion.question}
								className={`omp-ask-tab${active === at ? " omp-ask-tab--active" : ""}${answered ? " omp-ask-tab--answered" : ""}`}
								onClick={() => go(at, false)}
							>
								<span className={`omp-ask-tab-mark codicon codicon-${answered ? "check" : "circle-large-outline"}`} aria-hidden="true" />
								<span className="omp-ask-tab-label">{label}</span>
							</button>
						);
					})}
					<button
						ref={element => {
							tabRefs.current[reviewIndex] = element;
						}}
						id={tabId(reviewIndex)}
						type="button"
						role="tab"
						aria-selected={onReview}
						aria-controls={panelId}
						aria-label={unanswered === 0 ? "Submit (all answered)" : `Submit (${unanswered} unanswered)`}
						tabIndex={onReview ? 0 : -1}
						className={`omp-ask-tab omp-ask-tab--submit${onReview ? " omp-ask-tab--active" : ""}`}
						onClick={() => go(reviewIndex, false)}
					>
						<span className="omp-ask-tab-label">Submit</span>
					</button>
				</div>
			)}
			<div
				ref={panelRef}
				id={panelId}
				className="omp-ask-panel"
				role={hasTabs ? "tabpanel" : undefined}
				aria-labelledby={hasTabs ? tabId(active) : undefined}
			>
				{onReview ? (
					<>
						<div className="omp-ask-review-title">Review answers</div>
						{unanswered > 0 && (
							<div className="omp-ask-warning">
								{unanswered} unanswered question{unanswered === 1 ? "" : "s"}; Submit still sends them.
							</div>
						)}
						<div className="omp-ask-review">
							{questions.map((reviewQuestion, at) => {
								const answer = summarize(reviewQuestion, states[at]!);
								return (
									<button key={reviewQuestion.id} type="button" className="omp-ask-review-row" onClick={() => go(at, false)}>
										<span className="omp-ask-review-q">
											{at + 1}. {reviewQuestion.header?.trim() || reviewQuestion.question.trim() || `Q${at + 1}`}
										</span>
										<span className={answer === null ? "omp-ask-review-a omp-ask-review-a--none" : "omp-ask-review-a"}>{answer ?? "unanswered"}</span>
									</button>
								);
							})}
						</div>
						<div className="omp-composer-actions">
							<button ref={submitRef} type="button" className="omp-btn omp-btn--primary" onClick={() => submit(states)}>
								Submit answers
							</button>
						</div>
					</>
				) : (
					<>
						<div className="omp-ask-question">
							<Markdown text={question.question} />
						</div>
						<div className="omp-ask-options" role={question.multi ? "group" : "radiogroup"} aria-label={question.multi ? "Select any number" : "Select one"}>
							{question.options.map((option, at) => (
								<AskOptionRow
									key={`${question.id}-${at}-${option.label}`}
									role={question.multi ? "checkbox" : "radio"}
									checked={state.selected.includes(option.label)}
									marker={question.multi ? (state.selected.includes(option.label) ? "check" : "blank") : state.selected.includes(option.label) ? "circle-large-filled" : "circle-large-outline"}
									label={displayLabel(question, at)}
									description={option.description}
									hasPreview={option.preview !== undefined}
									onHighlight={() => highlight(index, at)}
									onClick={() => pick(index, option.label)}
								/>
							))}
							<AskOptionRow
								role={question.multi ? "checkbox" : "radio"}
								checked={state.custom !== undefined || draft !== null}
								marker={question.multi ? (state.custom !== undefined || draft !== null ? "check" : "blank") : state.custom !== undefined || draft !== null ? "circle-large-filled" : "circle-large-outline"}
								label={OTHER_LABEL}
								description={state.custom !== undefined && draft === null ? `“${state.custom}”` : undefined}
								onClick={() => toggleOther(index)}
							/>
							{draft !== null && draft !== undefined && (
								<CustomEditor
									key={question.id}
									draft={draft}
									onChange={text => editCustom(index, text)}
									onCommit={text => commitCustom(index, text)}
								/>
							)}
						</div>
						{preview !== undefined && (
							<div className="omp-ask-preview" role="group" aria-label={`Preview of ${question.options[previewAt]?.label ?? "the option"}`}>
								<Markdown text={preview} />
							</div>
						)}
						{hasTabs && (
							<div className="omp-composer-actions">
								<button type="button" className="omp-btn omp-btn--primary" onClick={() => go(index + 1, false)}>
									{index + 1 < questions.length ? "Next" : "Review"}
								</button>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
