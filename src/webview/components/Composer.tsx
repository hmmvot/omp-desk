/**
 * Composer: prompt entry, image attachments, turn interrupt, and the dialog the
 * session is waiting on.
 *
 * Dialog rules (ADR-0002 approval invariant):
 * - only an explicit answer to the dialog currently shown may be sent;
 * - a dialog is answered at most once — {@link ChatClient.answerUi} enforces it, so
 *   a double click or a re-rendered card cannot produce a second answer and a card
 *   for a withdrawn dialog settles nothing;
 * - every control is disabled unless the conversation is live and unlocked, and
 *   cancelling sends an explicit `cancelled` answer rather than a fabricated
 *   approval.
 *
 * Attachment rules:
 * - images are validated at selection time against the host's formats and byte
 *   budget ({@link ../lib/attachments}); a rejected file changes nothing and is
 *   reported inline, so an oversized or mislabeled pick never reaches the host;
 * - the draft is read and cleared through refs, so a second Enter/click in the
 *   same frame cannot send the same draft twice, and an unfinished file read
 *   cannot be sent half-attached;
 * - a pending dialog owns the composer outright: no attachment can be added,
 *   and a held draft is announced instead of being merged into a dialog answer;
 * - every attached image (paste, Attach, drop) is a numbered `[Image #N, WxH]` marker in the
 *   prompt text at the caret, the OMP TUI's own convention ({@link ../lib/image-references});
 *   the text is the single source of truth: an image is attached exactly while its marker is
 *   present, so deleting the marker (or the thumbnail's ×) removes the attachment, and Undo
 *   brings both back. Numbers are stable while editing and compacted to 1..K only on send;
 * - nothing is queued locally — the queue row above the composer (`QueuedMessages`) lists
 *   OMP's own queue readback, and an Edit hands a dequeued message back here
 *   ({@link ../lib/queue-restore}), appended to the draft with its images re-attached.
 *
 * Delivery rules:
 * - an idle session takes Enter as `prompt`; a running one takes Enter as `steer`
 *   (injected into the running turn) and Alt+Enter as `follow_up` (queued for after
 *   it), the same two deliveries the native TUI offers;
 * - a refused send (session not live, a denied slash builtin) keeps the draft and
 *   says why.
 */
import type { ImageContent } from "@oh-my-pi/pi-wire";
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { chatTurnInProgress } from "../../chat/model";
import { nativeSettingsCommand } from "../../chat/settings-command";
import { guestTransport } from "../bridge";
import {
	IMAGE_ACCEPT_ATTRIBUTE,
	MAX_DRAFT_BYTES,
	formatBytes,
	imageFilesFrom,
	rawTotal,
	readImageAttachment,
	sizeRejection,
	type PendingImage,
} from "../lib/attachments";
import { AskDialog, AskOptionRow } from "./AskDialog";
import type { ChatUiRequest, ChatUiResponse } from "../../chat/model";
import type { ChatClient, ChatSnapshot } from "../lib/chat-client";
import { chatWritable } from "../lib/chat-client";
import { reportComposerPopupOpen } from "../lib/composer-overlay";
import { providePanelActions } from "../lib/panel-actions";
import { provideDraftHandoff, subscribeRestoredDraft, takeRestoredDraft } from "../lib/draft-handoff";
import type { DraftCapture } from "../lib/draft-handoff";
import { followedByBlank, spaceInsertion, subscribeInsertedText } from "../lib/insert-text";
import { mergeRestoredQueued, offerQueuedForEditing, subscribeQueuedForEditing } from "../lib/queue-restore";
import { queueNotice, queueRows, restoredEntries } from "../lib/queue-view";
import { historyStep, sessionPrompts, type HistoryCursor } from "../lib/prompt-history";
import { mentionQueryAt, spliceMention } from "../messages";
import {
	activeImages,
	compactForSend,
	deletionRange,
	draftSegments,
	findImageReferences,
	imageReferenceLabel,
	pruneInactive,
	referencedNumbers,
	repairDamagedReferences,
	snapSelection,
	type ImageReferenceSpan,
} from "../lib/image-references";
import { useDismissibleLayer } from "../lib/dismissible-layer";
import { ExtensionNoticeLine, ExtensionWidgets } from "./ExtensionSurfaces";
import { argumentSuggestions, isRewindCommand, missingRequiredArgument, slashArgumentAt, slashQueryAt, slashSuggestions, spliceArgument, spliceSlash } from "../lib/slash-completion";
import { ChatFooter } from "./ChatFooter";

/** Textarea line height, kept in sync with `.omp-textarea`; vertical padding and border are read from the element. */
const LINE_PX = 20;
/** The prompt textarea never shows fewer lines than this, so a two-line placeholder or draft is fully visible. */
const MIN_ROWS = 2;
const MAX_ROWS = 8;

/** Wait after the last keystroke before asking the extension host for paths. */
const SUGGESTION_DEBOUNCE_MS = 150;
/** Two `Esc` presses this close together in an empty, idle composer open Rewind, as in the TUI. */
const DOUBLE_ESCAPE_MS = 500;

/** Stable empty list, so "no suggestions" does not re-render every consumer. */
const NO_SUGGESTIONS: readonly string[] = [];

function autosize(element: HTMLTextAreaElement | null, minRows: number): void {
	if (element === null) return;
	const style = getComputedStyle(element);
	const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
	const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
	// Collapsing the textarea to measure it would transiently shrink the dock, and the browser clamps
	// the transcript's scroll position at that forced layout. Holding the parent's height keeps the
	// dock's size unchanged for the whole synchronous measure, so no intermediate height is laid out.
	const holder = element.parentElement;
	if (holder !== null) holder.style.height = `${holder.offsetHeight}px`;
	element.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + padding;
	element.style.height = `${Math.max(minRows * LINE_PX + padding, Math.min(element.scrollHeight, max)) + border}px`;
	element.style.overflowY = element.scrollHeight > max ? "auto" : "hidden";
	if (holder !== null) holder.style.height = "";
}

/** An image of the current draft: the attachment plus its stable reference number. */
type DraftImage = PendingImage & { number: number };

/** Horizontal padding of `.omp-textarea`; the highlight layer mirrors it plus the scrollbar gutter. */
const TEXTAREA_PADDING_X = 12;

/**
 * Keeps the marker highlight layer aligned with the textarea: the same scroll offset, and the
 * same wrapping width when the textarea shows a scrollbar the layer does not have.
 */
function syncMirror(textarea: HTMLTextAreaElement | null, mirror: HTMLDivElement | null): void {
	if (textarea === null || mirror === null) return;
	mirror.style.paddingRight = `${TEXTAREA_PADDING_X + textarea.offsetWidth - textarea.clientWidth}px`;
	const content = mirror.firstElementChild;
	if (content instanceof HTMLElement) content.style.transform = `translateY(${-textarea.scrollTop}px)`;
}

/**
 * Replaces `[start, end)` through the editing command stack, so the browser's own Undo/Redo
 * covers the change (and, because the draft's attachments follow its markers, covers them too).
 * Falls back to a plain value write when the command is unavailable.
 */
function replaceRange(textarea: HTMLTextAreaElement, start: number, end: number, replacement: string): void {
	textarea.focus();
	textarea.setSelectionRange(start, end);
	if (replacement.length === 0 ? document.execCommand("delete") : document.execCommand("insertText", false, replacement)) return;
	textarea.setRangeText(replacement, start, end, "end");
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Whether Enter should commit. `false` while an IME composition is active, so
 * the keystroke confirms the composition instead. `nativeEvent.isComposing`
 * covers most browsers; the tracked flag bridges WebKit, which fires the
 * confirming Enter keydown after `compositionend`.
 */
function shouldSubmitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (event.key !== "Enter" || event.shiftKey) return false;
	return !(event.nativeEvent.isComposing || composing);
}

/** Tracks IME composition in a ref the keydown handler reads synchronously. */
function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

/** One line for the alert region: the first failures plus a count of the rest. */
function rejectionSummary(rejected: readonly string[]): string | null {
	if (rejected.length === 0) return null;
	const shown = rejected.slice(0, 2).join(" ");
	return rejected.length <= 2 ? shown : `${shown} (+${rejected.length - 2} more)`;
}

interface AskEditorProps {
	prefill: string | undefined;
	placeholder: string | undefined;
	disabled: boolean;
	onSubmit(value: string): void;
}

/**
 * Editor and input dialog entry. Mounted with `key={id}` so a new dialog seeds a
 * fresh draft from `prefill` while a re-render never clobbers a half-typed one.
 * Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ prefill, placeholder, disabled, onSubmit }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	useLayoutEffect(() => {
		autosize(textareaRef.current, 1);
	}, [draft]);

	return (
		<>
			<textarea
				ref={textareaRef}
				className="omp-textarea"
				value={draft}
				onChange={event => setDraft(event.target.value)}
				onKeyDown={event => {
					if (shouldSubmitOnEnter(event, composingRef.current)) {
						event.preventDefault();
						onSubmit(draft);
					}
				}}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
				placeholder={placeholder ?? "Type your response"}
				rows={1}
				spellCheck={false}
				disabled={disabled}
			/>
			<div className="omp-composer-actions" style={{ marginTop: 6 }}>
				<button type="button" className="omp-btn omp-btn--primary" disabled={disabled} onClick={() => onSubmit(draft)}>
					Submit
				</button>
			</div>
		</>
	);
}

/** The controls of one dialog; each answer names the dialog it settles. */
function DialogBody({
	request,
	onRespond,
}: {
	request: ChatUiRequest;
	onRespond(response: ChatUiResponse): void;
}): ReactNode {
	switch (request.method) {
		case "select":
			return (
				<div className="omp-ask-options">
					{request.options.map((option, index) => (
						<AskOptionRow
							key={`${request.id}-${index}-${option.label}`}
							marker="circle-large-outline"
							label={option.label}
							description={option.description}
							onClick={() => onRespond({ id: request.id, value: option.label })}
						/>
					))}
				</div>
			);
		case "ask":
			return <AskDialog key={request.id} request={request} onRespond={answers => onRespond({ id: request.id, answers })} />;
		case "confirm":
			return (
				<>
					{request.message.length > 0 && <div className="omp-ask-help">{request.message}</div>}
					<div className="omp-composer-actions" style={{ marginTop: 6 }}>
						<button
							type="button"
							className="omp-btn omp-btn--primary"
							onClick={() => onRespond({ id: request.id, confirmed: true })}
						>
							Confirm
						</button>
						<button type="button" className="omp-btn" onClick={() => onRespond({ id: request.id, confirmed: false })}>
							Deny
						</button>
					</div>
				</>
			);
		case "input":
			return (
				<AskEditor
					key={request.id}
					prefill={undefined}
					placeholder={request.placeholder}
					disabled={false}
					onSubmit={value => onRespond({ id: request.id, value })}
				/>
			);
		case "editor":
			return (
				<AskEditor
					key={request.id}
					prefill={request.prefill}
					placeholder={undefined}
					disabled={false}
					onSubmit={value => onRespond({ id: request.id, value })}
				/>
			);
	}
}

interface RecoverableMessage {
	id: number;
	text: string;
	images: readonly ImageContent[];
	reason: string;
	unconfirmed: boolean;
	lostAttachments?: number;
}

export function Composer({ client, snapshot, progressAvailable = true, onRewind }: {
	client: ChatClient;
	snapshot: ChatSnapshot;
	progressAvailable?: boolean;
	/** Open Rewind (`Esc` `Esc` in an empty idle composer, or `/rewind`); absent where Rewind is not offered. */
	onRewind?: () => void;
}): ReactNode {
	const [text, setText] = useState("");
	/** Every image attached to this draft, including ones whose marker was deleted and could still come back through Undo. */
	const [images, setImages] = useState<readonly DraftImage[]>([]);
	const [attachError, setAttachError] = useState<string | null>(null);
	/** Why the last send or answer was refused; cleared by the next accepted one. */
	const [sendError, setSendError] = useState<string | null>(null);
	const [submitted, setSubmitted] = useState(false);
	const [sending, setSending] = useState(false);
	const sendingRef = useRef(false);
	const draftRevisionRef = useRef(0);
	const recoverySeqRef = useRef(0);
	const [recoverable, setRecoverable] = useState<readonly RecoverableMessage[]>([]);
	const recoverableRef = useRef<readonly RecoverableMessage[]>([]);
	const pendingOriginalRef = useRef<{ text: string; images: readonly ImageContent[] } | null>(null);
	const captureRef = useRef<{ requestId: number; released: Promise<void>; release(): void } | null>(null);
	const readCapture = useCallback(() => captureRef.current, []);
	const [captureLocked, setCaptureLocked] = useState(false);
	const [lostAttachments, setLostAttachments] = useState(0);
	const lostAttachmentsRef = useRef(0);
	const publishRecoverable = useCallback((next: readonly RecoverableMessage[]): void => {
		recoverableRef.current = next;
		setRecoverable(next);
	}, []);
	/** Files still being read; a prompt must not overtake them. */
	const [reading, setReading] = useState(0);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();
	/**
	 * Synchronous draft mirror. State lands a render later, so submit, attach,
	 * and remove touch these refs first: a repeat Enter/click in the same frame
	 * must not re-send a draft the first submit cleared, and a file read that
	 * finishes later must budget against what the draft holds at that moment.
	 */
	const textRef = useRef("");
	const imagesRef = useRef<readonly DraftImage[]>([]);
	const imageSeqRef = useRef(0);
	/** Next stable reference number; never reused within a draft, reset once a prompt is sent. */
	const nextNumberRef = useRef(1);
	/** Marker insertions waiting for an IME composition to finish. */
	const deferredRef = useRef<(() => void)[]>([]);
	const wrapperRef = useRef<HTMLDivElement | null>(null);
	const mirrorRef = useRef<HTMLDivElement | null>(null);
	/**
	 * In-flight reads, counted synchronously: `send` must not overtake a read
	 * that has been started but not yet published, which is exactly what the
	 * `reading` state cannot answer inside the frame that started it.
	 */
	const readingRef = useRef(0);
	/**
	 * Raw bytes held by in-flight reads. A selection reserves its bytes before
	 * reading them, so two overlapping selections budget against one running
	 * total (`imagesRef` + `reservedRef`) instead of each sizing against the
	 * same published draft and together overshooting the per-prompt limit. The
	 * reservation is handed to the published draft in the same synchronous step
	 * that publishes it, so the invariant "published + reserved ≤ budget" never
	 * has a gap.
	 */
	const reservedRef = useRef(0);
	const mountedRef = useRef(true);
	/** Caret offset mirror; {@link mentionQueryAt} needs it synchronously. */
	const caretRef = useRef(0);
	/** Caret to restore after an accepted suggestion swaps the draft text. */
	const pendingCaretRef = useRef<number | null>(null);
	/** The ↑/↓ prompt-history walk in progress, or `null`. */
	const historyRef = useRef<HistoryCursor | null>(null);
	/** Last completion request sent, or `null` once it is answered or invalidated. */
	const pendingQueryRef = useRef<{ requestId: number; query: string } | null>(null);
	const requestSeqRef = useRef(0);
	const [caret, setCaret] = useState(0);
	const [suggestions, setSuggestions] = useState<readonly string[]>(NO_SUGGESTIONS);
	const [activeSuggestion, setActiveSuggestion] = useState(0);
	const [argumentSelectionKey, setArgumentSelectionKey] = useState<string | null>(null);
	const suggestionListId = useId();
	const [dismissedCompletion, setDismissedCompletion] = useState<string | null>(null);

	const live = snapshot.phase === "live";
	// Writing needs a live, unlocked session; the same rule refuses inside the client, so
	// a stale button can never reach the host.
	const canPrompt = chatWritable(snapshot);
	const resumable = snapshot.phase === "view-only" || snapshot.phase === "stopped";
	const busy = snapshot.working;
	const request = snapshot.uiRequest;
	useEffect(() => { setSubmitted(false); }, [snapshot.working, snapshot.phase, snapshot.commandFeedback, snapshot.lastPromptResult, progressAvailable]);
	// `reading` is the rendered mirror of `readingRef`: it drives what this frame
	// shows, while `send` enforces the synchronous ref.
	/** Images whose marker is in the text — what the strip shows and a send carries. */
	const attached = useMemo(() => activeImages(text, images), [text, images]);
	const referenceSpans = useMemo(() => findImageReferences(text, number => images.some(image => image.number === number)), [text, images]);
	const canSubmit = canPrompt && !captureLocked && request === null && !sending && reading === 0 && (text.trim().length > 0 || attached.length > 0);

	useLayoutEffect(() => {
		autosize(textareaRef.current, MIN_ROWS);
		syncMirror(textareaRef.current, mirrorRef.current);
	}, [text, request?.id, referenceSpans]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			// Draft base64 and previews live only in this component's state and
			// refs; dropping them with the component is what releases them.
			mountedRef.current = false;
		};
	}, []);

	/**
	 * `@` completion exists only where prompting does: a read-only or
	 * disconnected panel asks nothing, and a pending host request owns the
	 * composer outright, so no search runs beside it.
	 */
	const completionsEnabled = canPrompt && !captureLocked && request === null;
	const completionKey = `${text}\0${caret}`;
	const slash = useMemo(() => completionsEnabled && dismissedCompletion !== completionKey ? slashQueryAt(text, caret) : null, [completionsEnabled, dismissedCompletion, completionKey, text, caret]);
	const argument = useMemo(() => completionsEnabled && dismissedCompletion !== completionKey ? slashArgumentAt(snapshot.commands, text, caret) : null, [completionsEnabled, dismissedCompletion, completionKey, snapshot.commands, text, caret]);
	const mention = useMemo(
		() => completionsEnabled && slash === null && argument === null && dismissedCompletion !== completionKey ? mentionQueryAt(text, caret) : null,
		[caret, completionsEnabled, text, slash, argument, dismissedCompletion, completionKey],
	);
	// Narrow the last answer against whatever has been typed since it arrived, so
	// the popup stays useful between keystrokes instead of blanking until the next
	// debounce, and a stale answer can never offer an irrelevant path.
	const visible = useMemo(() => {
		if (slash !== null) return slashSuggestions(snapshot.commands, slash.query).map(command => ({ kind: "slash" as const, name: command.name, label: `/${command.name}`, description: command.description, source: command.source === "skill" ? "Skill" : command.source, inputHint: command.inputHint, usage: undefined, isDefault: false }));
		if (argument !== null) return argumentSuggestions(argument.command, argument.query).map(row => ({ kind: "argument" as const, name: row.name, label: row.name, description: row.description, source: undefined, inputHint: undefined, usage: row.usage, isDefault: row.isDefault }));
		if (mention === null) return [];
		const needle = mention.query.toLowerCase().replaceAll("\\", "/");
		return suggestions.filter(path => !needle || path.toLowerCase().replaceAll("\\", "/").includes(needle)).map(path => ({ kind: "file" as const, name: path, label: path, description: undefined, source: undefined, inputHint: undefined, usage: undefined, isDefault: false }));
	}, [mention, suggestions, slash, argument, snapshot.commands]);
	const activeIndex = argument !== null && argumentSelectionKey !== completionKey
		? (argument.query.length === 0 ? -1 : 0)
		: visible.length === 0 ? -1 : Math.min(activeSuggestion, visible.length - 1);
	const argumentHint = argument !== null && argument.query.length === 0 ? argument.hint.text : "";
	const suggestionsOpen = visible.length > 0 || argumentHint.length > 0;
	// A pointer selects only an option it can already see; scrolling under the pointer would move the list away from it.
	const pointerSelectionRef = useRef(false);
	const selectSuggestion = useCallback((index: number, pointer = false): void => {
		pointerSelectionRef.current = pointer;
		setActiveSuggestion(index);
		setArgumentSelectionKey(completionKey);
	}, [completionKey]);
	// Keep the active option inside the list's scrollport, so keyboard navigation never selects an option the user cannot see.
	useLayoutEffect(() => {
		if (pointerSelectionRef.current) { pointerSelectionRef.current = false; return; }
		if (activeIndex < 0) return;
		const option = document.getElementById(`${suggestionListId}-${activeIndex}`);
		const list = option?.parentElement;
		if (!option || !list) return;
		// The first option scrolls to the very top, so the list's padding and any argument hint above it show too.
		if (activeIndex === 0 || option.offsetTop < list.scrollTop) list.scrollTop = activeIndex === 0 ? 0 : option.offsetTop;
		else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
	}, [activeIndex, visible, suggestionListId]);
	// Outside press, Escape and window blur dismiss the completion list by the same shared rule as every other chat layer.
	const dismissCompletion = useCallback((): void => {
		setDismissedCompletion(`${textRef.current}\0${caretRef.current}`);
		setSuggestions(NO_SUGGESTIONS);
		pendingQueryRef.current = null;
		requestSeqRef.current++;
	}, []);
	useDismissibleLayer({ open: suggestionsOpen, inside: [wrapperRef], onDismiss: dismissCompletion });

	// One bounded request per settled query; the debounce also collapses a fast
	// typist's keystrokes into a single host round trip.
	useEffect(() => {
		// Any reply still in flight answers a query the caret has already left.
		pendingQueryRef.current = null;
		if (mention === null) {
			setSuggestions(NO_SUGGESTIONS);
			return;
		}
		setActiveSuggestion(0);
		const requestId = ++requestSeqRef.current;
		const timer = setTimeout(() => {
			pendingQueryRef.current = { requestId, query: mention.query };
			guestTransport.post({ type: "omp:complete-files", requestId, query: mention.query });
		}, SUGGESTION_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [mention]);

	// A reply counts only for the request still pending; a panel that can no longer
	// prompt has already dropped its pending request, so late answers are ignored.
	useEffect(() => {
		return guestTransport.subscribe(message => {
			if (message.type !== "omp:file-completions") return;
			const pending = pendingQueryRef.current;
			if (pending === null || pending.requestId !== message.requestId) return;
			pendingQueryRef.current = null;
			setSuggestions(message.paths);
			setActiveSuggestion(0);
		});
	}, []);
	useEffect(() => guestTransport.onRouteChange(() => {
		pendingQueryRef.current = null; requestSeqRef.current++;
		setSuggestions(NO_SUGGESTIONS);
		setDismissedCompletion(`${textRef.current}\0${caretRef.current}`);
	}), []);

	// After an accepted suggestion the draft is new text; put the caret after the
	// inserted mention once React has committed it.
	useLayoutEffect(() => {
		const target = pendingCaretRef.current;
		if (target === null) return;
		pendingCaretRef.current = null;
		const element = textareaRef.current;
		if (element === null) return;
		element.focus();
		element.setSelectionRange(target, target);
		caretRef.current = target;
		setCaret(target);
	}, [text]);

	const syncCaret = useCallback((element: HTMLTextAreaElement): void => {
		const position = element.selectionStart ?? element.value.length;
		if (position === caretRef.current) return;
		caretRef.current = position;
		setCaret(position);
	}, []);

	/**
	 * Replace the `@` token under the caret with the chosen path, leaving every
	 * other character — and the attachment draft — untouched. Quoting is the
	 * mention grammar's, not the user's concern: `spliceMention` emits the bare
	 * `@path` form when it parses back to the same path and a quoted form
	 * otherwise.
	 */
	const acceptSuggestion = useCallback(
		(selected: { kind: "file" | "slash" | "argument"; name: string }): void => {
			if (captureRef.current !== null || !completionsEnabled || composingRef.current || selected.name.length === 0) return;
			const slashToken = selected.kind === "slash" ? slashQueryAt(textRef.current, caretRef.current) : null;
			const argumentToken = selected.kind === "argument" ? slashArgumentAt(snapshot.commands, textRef.current, caretRef.current) : null;
			const token = selected.kind === "file" ? mentionQueryAt(textRef.current, caretRef.current) : null;
			if (slashToken === null && argumentToken === null && token === null) return;
			const spliced = slashToken ? spliceSlash(textRef.current, slashToken.end, selected.name) : argumentToken ? spliceArgument(textRef.current, argumentToken.start, argumentToken.end, selected.name) : spliceMention(textRef.current, caretRef.current, token!.start, selected.name);
			draftRevisionRef.current++;
			textRef.current = spliced.text;
			// The answer has been consumed; anything still in flight is stale.
			pendingQueryRef.current = null;
			requestSeqRef.current++;
			pendingCaretRef.current = spliced.caret;
			setSuggestions(NO_SUGGESTIONS);
			setText(spliced.text);
		},
		[completionsEnabled, composingRef, snapshot.commands],
	);

	const publishImages = useCallback((next: readonly DraftImage[]): void => {
		if (captureRef.current !== null) return;
		draftRevisionRef.current++;
		imagesRef.current = next;
		setImages(next);
	}, []);

	/** Whether `number` belongs to an image of this draft — read synchronously, so edits are judged against the draft as it is now. */
	const isKnownNumber = useCallback((number: number): boolean => imagesRef.current.some(image => image.number === number), []);

	/**
	 * Insert the markers for `added` at the caret (or over the selection), one space apart and
	 * with a space on each side unless whitespace is already there, so typing can continue
	 * straight after the last marker. Goes through the editing command stack, so Undo removes
	 * the marker and its attachment together. An IME composition is never interrupted: the
	 * insertion waits for it to end.
	 */
	const insertReferences = useCallback((added: readonly DraftImage[]): void => {
		const place = (): void => {
			if (captureRef.current !== null) return;
			const element = textareaRef.current;
			const current = textRef.current;
			const start = element?.selectionStart ?? current.length;
			const end = element?.selectionEnd ?? current.length;
			const markers = added.map(image => imageReferenceLabel(image.number, image.width !== undefined && image.height !== undefined ? { width: image.width, height: image.height } : undefined));
			const lead = start > 0 && !/\s/.test(current[start - 1]!) ? " " : "";
			const trail = end < current.length && /\s/.test(current[end]!) ? "" : " ";
			const inserted = `${lead}${markers.join(" ")}${trail}`;
			if (element === null) {
				draftRevisionRef.current++;
				textRef.current = current + inserted;
				setText(textRef.current);
				return;
			}
			replaceRange(element, start, end, inserted);
		};
		if (composingRef.current) deferredRef.current.push(place);
		else place();
	}, [composingRef]);

	const endComposition = useCallback((): void => {
		onCompositionEnd();
		// Queued after the guard's own reset, so the insertion sees a finished composition.
		setTimeout(() => {
			const waiting = deferredRef.current.splice(0);
			for (const place of waiting) place();
		}, 0);
	}, [onCompositionEnd]);

	/** Validate, read, and add `files`. Every rejection is reported, never dropped. */
	const addFiles = useCallback(
		async (files: readonly File[]): Promise<void> => {
			if (captureRef.current !== null || !canPrompt || files.length === 0) return;
			readingRef.current += files.length;
			setReading(readingRef.current);
			const accepted: PendingImage[] = [];
			const rejected: string[] = [];
			// This call's share of `reservedRef`, so the release in `finally` stays
			// balanced even if a read throws instead of reporting failure. A leaked
			// reservation would shrink the draft budget with nothing to show for it.
			let held = 0;
			try {
				for (const file of files) {
					// Reserve before reading: the check and the reservation happen in one
					// synchronous step, so a concurrent selection sees these bytes. Only
					// images still referenced by the text count: a removed one is released first.
					const oversize = sizeRejection(file, rawTotal(activeImages(textRef.current, imagesRef.current)) + reservedRef.current);
					if (oversize !== null) {
						rejected.push(oversize);
						continue;
					}
					reservedRef.current += file.size;
					held += file.size;
					const read = await readImageAttachment(file, ++imageSeqRef.current).catch(() => null);
					if (read !== null && read.ok) {
						accepted.push(read.image);
					} else {
						// A failed read releases exactly what it reserved.
						reservedRef.current -= file.size;
						held -= file.size;
						rejected.push(read === null ? `${file.name}: could not be read.` : read.reason);
					}
				}
			} finally {
				// The bytes of `accepted` stop being reserved here and are published
				// below with no await in between, so the invariant
				// "published + reserved ≤ budget" never has a gap.
				readingRef.current = Math.max(0, readingRef.current - files.length);
				reservedRef.current = Math.max(0, reservedRef.current - held);
			}
			if (!mountedRef.current) return;
			setReading(readingRef.current);
			if (accepted.length > 0) {
				const added: DraftImage[] = accepted.map(image => ({ ...image, number: nextNumberRef.current++ }));
				const merged = [...imagesRef.current, ...added];
				const present = referencedNumbers(textRef.current, number => merged.some(image => image.number === number));
				// Deleted images stay only for Undo and never push the draft past the prompt budget.
				publishImages(pruneInactive(merged, number => present.has(number), new Set(added.map(image => image.number)), MAX_DRAFT_BYTES));
				insertReferences(added);
			}
			if (accepted.length > 0 || rejected.length > 0) setAttachError(rejectionSummary(rejected));
		},
		[canPrompt, insertReferences, publishImages],
	);

	/** The × on a thumbnail deletes that image's marker(s) from the text; the attachment follows its marker. */
	const removeImage = useCallback(
		(number: number): void => {
			if (captureRef.current !== null) return;
			const element = textareaRef.current;
			if (element === null) return;
			const spans = findImageReferences(textRef.current, isKnownNumber).filter(span => span.number === number);
			for (const span of spans.reverse()) replaceRange(element, span.start, span.end, "");
			setAttachError(null);
		},
		[isKnownNumber],
	);

	const onFilesPicked = useCallback(
		(event: ChangeEvent<HTMLInputElement>): void => {
			const picked = event.target.files;
			if (picked !== null && picked.length > 0) void addFiles(Array.from(picked));
			// Reset so picking the same file again still fires `change`.
			event.target.value = "";
		},
		[addFiles],
	);

	const onPaste = useCallback(
		(event: ClipboardEvent<HTMLTextAreaElement>): void => {
			const files = imageFilesFrom(event.clipboardData);
			if (files.length === 0) return;
			// The marker carries the image; letting the paste through would also
			// drop an unreadable data URL into the prompt text.
			event.preventDefault();
			void addFiles(files);
		},
		[addFiles],
	);

	const onDragOver = useCallback((event: DragEvent<HTMLTextAreaElement>): void => {
		if (canPrompt && Array.from(event.dataTransfer.items).some(item => item.kind === "file")) event.preventDefault();
	}, [canPrompt]);

	const onDrop = useCallback(
		(event: DragEvent<HTMLTextAreaElement>): void => {
			const files = imageFilesFrom(event.dataTransfer);
			if (files.length === 0) return;
			event.preventDefault();
			void addFiles(files);
		},
		[addFiles],
	);

	/**
	 * Typing rewrites the draft; if an edit the `beforeinput` interception did not cover (a
	 * word-wise delete, a drop) cut into a marker, the whole marker goes, never a fragment.
	 */
	const onTextChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>): void => {
		const element = event.target;
		if (captureRef.current !== null) { element.value = textRef.current; return; }
		let value = element.value;
		const before = textRef.current;
		if (!(event.nativeEvent as InputEvent).isComposing) {
			const repaired = repairDamagedReferences(before, value, findImageReferences(before, isKnownNumber));
			if (repaired !== null) {
				value = repaired.text;
				pendingCaretRef.current = repaired.caret;
			}
		}
		draftRevisionRef.current++;
		textRef.current = value;
		if (pendingCaretRef.current === null) syncCaret(element);
		setText(value);
	}, [isKnownNumber, syncCaret]);

	const send = useCallback(
		async (followUp: boolean): Promise<void> => {
			// The wire pairs the Nth marker with the Nth image, so the draft's stable numbers are
			// compacted to 1..K here and images whose marker was deleted are not sent.
			const compacted = compactForSend(textRef.current, imagesRef.current);
			const draft = compacted.text.trim();
			const attached = compacted.images;
			// A pending dialog, a locked or not-live panel, and a read that has started
			// but not published yet must never produce a message. `readingRef` (not the
			// `reading` state) is what makes this true inside the same frame that
			// started the read.
			if (captureRef.current !== null || !canPrompt || request !== null || readingRef.current > 0 || sendingRef.current) return;
			if (draft.length === 0 && attached.length === 0) return;
			// Chat's own `/rewind` and `/branch` never reach OMP; both open the in-place Rewind.
			if (onRewind !== undefined && attached.length === 0 && isRewindCommand(draft)) {
				draftRevisionRef.current++;
				textRef.current = "";
				setText("");
				setSendError(null);
				onRewind();
				return;
			}
			if (missingRequiredArgument(snapshot.commands, draft)) {
				setDismissedCompletion(null);
				setSendError("This command requires an argument.");
				return;
			}
			// Restored queued messages can bring the draft past what one message may carry; say so instead of
			// sending a message the host would refuse without a word.
			if (rawTotal(attached) > MAX_DRAFT_BYTES) {
				setSendError(`the attached images are ${formatBytes(rawTotal(attached))}, over the ${formatBytes(MAX_DRAFT_BYTES)} one message may carry; remove an image to send`);
				return;
			}
			const wire: ImageContent[] = attached.map(image => ({
				type: "image",
				mimeType: image.mimeType,
				data: image.data,
			}));
			const payload = wire.length > 0 ? wire : undefined;
			// The model's own `working`, read now: the delivery follows the turn the
			// session is in at this instant, not the one this render saw.
			const running = client.getSnapshot().working;
			const revision = draftRevisionRef.current;
			pendingOriginalRef.current = { text: compacted.text, images: wire };
			sendingRef.current = true;
			setSending(true);
			const result = await (!running
				? client.sendPrompt(draft, payload)
				: followUp
					? client.sendFollowUp(draft, payload)
					: client.sendSteer(draft, payload));
			for (let held = readCapture(); held !== null; held = readCapture()) await held.released;
			pendingOriginalRef.current = null;
			sendingRef.current = false;
			if (!mountedRef.current) return;
			setSending(false);
			if (!result.ok) {
				if (result.unconfirmed || draftRevisionRef.current !== revision) {
					const entry: RecoverableMessage = { id: ++recoverySeqRef.current, text: compacted.text, images: wire, reason: result.reason, unconfirmed: result.unconfirmed === true };
					publishRecoverable([...recoverableRef.current, entry]);
					setSendError(null);
				} else {
					setSendError(result.reason);
				}
				return;
			}
			setSendError(null);
			if (!running && result.explained !== true && nativeSettingsCommand(draft) === null) setSubmitted(true);
			// Admission may finish after typing, attaching, or restoring another draft. Never erase that work.
			if (draftRevisionRef.current !== revision) return;
			draftRevisionRef.current++;
			historyRef.current = null;
			textRef.current = "";
			nextNumberRef.current = 1;
			publishImages([]);
			setAttachError(null);
			setText("");
		},
		[canPrompt, client, onRewind, publishImages, publishRecoverable, readCapture, request, snapshot.commands],
	);

	// A complete capture stays immutable through the host's confirmation and replacement.
	useEffect(() => provideDraftHandoff({
		read(requestId) {
			if (readingRef.current > 0 || composingRef.current || deferredRef.current.length > 0 || client.draftHandoffPending) return null;
			if (captureRef.current !== null) return null;
			const recoverable = recoverableRef.current.map(entry => ({ text: entry.text, attachments: entry.images.length + (entry.lostAttachments ?? 0), unconfirmed: entry.unconfirmed }));
			const pending = pendingOriginalRef.current;
			if (pending !== null) recoverable.push({ text: pending.text, attachments: pending.images.length, unconfirmed: true });
			const content: DraftCapture = { text: textRef.current, attachments: activeImages(textRef.current, imagesRef.current).length + lostAttachmentsRef.current, recoverable };
			const { promise, resolve } = Promise.withResolvers<void>();
			captureRef.current = { requestId, released: promise, release: resolve };
			client.setDraftHandoffLocked(true);
			setCaptureLocked(true);
			return content;
		},
		release(requestId) {
			const held = captureRef.current;
			if (held === null || held.requestId !== requestId) return;
			captureRef.current = null;
			client.setDraftHandoffLocked(false);
			if (mountedRef.current) setCaptureLocked(false);
			if (mountedRef.current) {
				const waiting = deferredRef.current.splice(0);
				for (const place of waiting) place();
			}
			held.release();
		},
	}), [client, composingRef]);

	// A draft handed back to a document that has just been created lands here, and the
	// pending value is consumed so a later mount cannot replay it into a new draft.
	useEffect(() => {
		const apply = (restored: DraftCapture): void => {
			draftRevisionRef.current++;
			textRef.current = restored.text;
			setText(restored.text);
			lostAttachmentsRef.current = restored.attachments;
			setLostAttachments(restored.attachments);
			for (const span of findImageReferences(restored.text, () => true)) nextNumberRef.current = Math.max(nextNumberRef.current, span.number + 1);
			for (const original of restored.recoverable) {
				for (const span of findImageReferences(original.text, () => true)) nextNumberRef.current = Math.max(nextNumberRef.current, span.number + 1);
			}
			publishRecoverable(restored.recoverable.map(entry => ({
				id: ++recoverySeqRef.current, text: entry.text, images: [], unconfirmed: entry.unconfirmed, lostAttachments: entry.attachments,
				reason: entry.unconfirmed ? "OMP did not confirm this message before this editor was replaced. It may already have been accepted. Review the conversation before sending it again." : "This original message was not sent. Add it to the draft only when you want to send it.",
			})));
			textareaRef.current?.focus();
		};
		const pending = takeRestoredDraft();
		if (pending !== null) apply(pending);
		return subscribeRestoredDraft(apply);
	}, [publishRecoverable]);

	// "OMP: Add Selection/File to Session": the `@path` references the extension host composed in
	// an editor are inserted at the caret (over a selection), through the editing command stack so
	// Undo removes them, and at the end of the draft while no textarea is mounted. They are never
	// submitted, and an IME composition is not interrupted. One that arrived before this composer
	// mounted is delivered first (`lib/insert-text`).
	useEffect(() => subscribeInsertedText(reference => {
		const place = (): void => {
			if (captureRef.current !== null) { deferredRef.current.push(place); return; }
			const element = textareaRef.current;
			const current = textRef.current;
			const start = element?.selectionStart ?? current.length;
			const end = element?.selectionEnd ?? current.length;
			const inserted = spaceInsertion(current, start, end, reference);
			if (element === null) {
				draftRevisionRef.current++;
				textRef.current = current + inserted;
				setText(textRef.current);
				return;
			}
			replaceRange(element, start, end, inserted);
			// A space already follows: the caret steps over it, so it never rests right after a bare `@path`.
			if (followedByBlank(current, end)) {
				const caret = start + inserted.length + 1;
				element.setSelectionRange(caret, caret);
			}
		};
		if (composingRef.current) deferredRef.current.push(place);
		else place();
	}), [composingRef]);

	// `set_editor_text` from the session (an extension prefilling the prompt): the request
	// replaces the draft, once per `seq`. The seq present at mount was already applied by an
	// earlier mount of this composer and is not replayed.
	const editorSeqRef = useRef(snapshot.pendingEditorText?.seq ?? null);
	const editorText = snapshot.pendingEditorText;
	useEffect(() => {
		if (editorText === null || editorText.seq === editorSeqRef.current) return;
		if (captureRef.current !== null) return;
		editorSeqRef.current = editorText.seq;
		draftRevisionRef.current++;
		textRef.current = editorText.text;
		setText(editorText.text);
		textareaRef.current?.focus();
	}, [editorText, captureLocked]);

	// "Edit" / "Edit all" on queued messages (the queue row above the composer): what OMP handed back is
	// appended to the draft after whatever is already typed, with its images re-attached under fresh
	// reference numbers (`lib/queue-restore`). Nothing is sent, and nothing the draft held is replaced.
	useEffect(() => subscribeQueuedForEditing(entries => {
		const place = (): void => {
			if (captureRef.current !== null) { deferredRef.current.push(place); return; }
			const held = imagesRef.current.length;
			const merged = mergeRestoredQueued({ text: textRef.current, images: imagesRef.current, nextNumber: nextNumberRef.current, nextId: imageSeqRef.current + 1 }, entries);
			nextNumberRef.current = merged.nextNumber;
			imageSeqRef.current = merged.nextId - 1;
			const present = referencedNumbers(merged.text, number => merged.images.some(image => image.number === number));
			publishImages(pruneInactive(merged.images, number => present.has(number), new Set(merged.images.slice(held).map(image => image.number)), MAX_DRAFT_BYTES));
			draftRevisionRef.current++;
			textRef.current = merged.text;
			pendingCaretRef.current = merged.text.length;
			setText(merged.text);
			setAttachError(merged.imagesLost > 0 ? `${merged.imagesLost} image${merged.imagesLost === 1 ? "" : "s"} of the edited message could not be attached (unsupported format).` : null);
		};
		// Like inserted text: an IME composition in flight finishes first, so the restore never splits it.
		if (composingRef.current) deferredRef.current.push(place);
		else place();
	}), [composingRef, publishImages]);

	// Rewind's edit and resubmit (ADR-0051): a rewound prompt replaces the draft, and a draft typed before it moves to
	// a recovery card first, never overwritten. Undo takes the prompt back out while it is still unedited
	// (`rewoundRef` holds the draft revision right after it was placed). Any page's navigation counts, so a command-
	// palette Rewind lands here too.
	const rewoundRef = useRef<number | null>(null);
	useEffect(() => client.subscribeNavigations(answer => {
		if (answer.status !== "done") return;
		const place = (): void => {
			if (captureRef.current !== null) { deferredRef.current.push(place); return; }
			const unedited = rewoundRef.current !== null && rewoundRef.current === draftRevisionRef.current;
			rewoundRef.current = null;
			if (answer.kind === "undo") {
				if (!unedited) return;
				draftRevisionRef.current++;
				textRef.current = "";
				nextNumberRef.current = 1;
				publishImages([]);
				setAttachError(null);
				setText("");
				return;
			}
			const draft = answer.draft;
			if (answer.kind !== "rewind" || draft === undefined) return;
			const held = compactForSend(textRef.current, imagesRef.current);
			if (held.text.trim().length > 0 || held.images.length > 0) {
				const images: ImageContent[] = held.images.map(image => ({ type: "image", mimeType: image.mimeType, data: image.data }));
				publishRecoverable([...recoverableRef.current, { id: ++recoverySeqRef.current, text: held.text, images, reason: "Your draft from before the rewind. Add it to the draft only when you want it back.", unconfirmed: false }]);
			}
			const merged = mergeRestoredQueued({ text: "", images: [], nextNumber: 1, nextId: imageSeqRef.current + 1 }, [{ text: draft.text, images: draft.images }]);
			nextNumberRef.current = merged.nextNumber;
			imageSeqRef.current = merged.nextId - 1;
			publishImages(pruneInactive(merged.images, () => true, new Set(merged.images.map(image => image.number)), MAX_DRAFT_BYTES));
			historyRef.current = null;
			draftRevisionRef.current++;
			textRef.current = merged.text;
			pendingCaretRef.current = merged.text.length;
			setText(merged.text);
			const lost = merged.imagesLost + draft.unavailableImages;
			setAttachError(lost > 0 ? `${lost} image${lost === 1 ? "" : "s"} of the rewound message could not be restored.` : null);
			setSendError(null);
			rewoundRef.current = draftRevisionRef.current;
			textareaRef.current?.focus();
		};
		if (composingRef.current) deferredRef.current.push(place);
		else place();
	}), [client, composingRef, publishImages, publishRecoverable]);
	const lastEscapeRef = useRef(Number.NEGATIVE_INFINITY);

	// VS Code commands and keybindings reach the composer through this registry
	// (`src/webview/lib/panel-actions.ts`): `omp.sendPrompt`, `omp.stopTurn` and
	// `omp.focusComposer` run these same handlers, so a keybinding can never send
	// what the Send button refuses or stop a turn the Stop button would not.

	/**
	 * Stop the running turn; a refusal (session not live, host unreachable) is shown, never dropped. Like the TUI's
	 * Escape, the messages still queued come back into the draft (after what it holds) instead of running later.
	 */
	const stop = useCallback((): void => {
		const result = client.sendAbort(answer => {
			offerQueuedForEditing(answer.entries.map(entry => ({ text: entry.text, images: entry.images ?? [] })));
			if (!mountedRef.current) return;
			if (answer.truncated === true) setSendError("Stopped. OMP could not hand back every queued message, so some were discarded.");
			else if (answer.imagesDropped === true) setSendError("Stopped. Some images of the queued messages could not be restored to the composer.");
		});
		setSendError(result.ok ? null : result.reason);
	}, [client]);

	/** `Alt+↑`, the TUI's dequeue: the newest queued message comes back into the draft. */
	const dequeueLast = useCallback(async (): Promise<boolean> => {
		const last = queueRows(client.getSnapshot().state?.queuedMessages).at(-1);
		if (last === undefined) return false;
		const outcome = await client.removeQueued("edit", [{ queue: last.queue, text: last.text }]);
		if (outcome.ok) offerQueuedForEditing(restoredEntries(outcome.results));
		if (mountedRef.current) setSendError(queueNotice("edit", outcome)?.text ?? null);
		return true;
	}, [client]);

	/** Re-run a failed or aborted last turn through OMP's own `/retry` (it says "Nothing to retry." otherwise). */
	const retry = useCallback(async (): Promise<void> => {
		const current = client.getSnapshot();
		if (current.working || !chatWritable(current) || captureRef.current !== null) return;
		const result = await client.sendPrompt("/retry");
		if (mountedRef.current) setSendError(result.ok ? null : result.reason);
	}, [client]);

	useEffect(
		() =>
			providePanelActions({
				"send-prompt": () => send(false),
				"stop-turn": stop,
				"focus-composer": () => textareaRef.current?.focus(),
				"retry-turn": () => void retry(),
			}),
		[retry, send, stop],
	);

	// A prompt picked in the host's history search (`Ctrl+R`) joins the draft like an edited queued message.
	useEffect(() => guestTransport.subscribe(message => {
		if (message.type === "omp:recall-prompt") offerQueuedForEditing([{ text: message.text, images: [] }]);
	}), []);

	// The extension host needs one more fact about Escape: whether this popup is
	// open. It is reported on every change and cleared when the composer unmounts,
	// so the host's stop keybinding can require a closed popup — one Escape press
	// then means exactly one thing instead of dismissing the popup and aborting
	// the running turn at the same time.
	useEffect(() => {
		reportComposerPopupOpen("completion", suggestionsOpen);
		return () => {
			if (suggestionsOpen) reportComposerPopupOpen("completion", false);
		};
	}, [suggestionsOpen]);

	// Markers are atomic. The caret and selection edges never rest inside one, and a Backspace/Delete that
	// touches one removes it whole through the editing command stack (so Undo restores it, and with it the
	// attachment). Native listeners, because React's `onBeforeInput` does not carry deletion input types.
	const textareaMounted = !(request !== null && canPrompt);
	useEffect(() => {
		const element = textareaRef.current;
		if (element === null) return;
		const spans = (): ImageReferenceSpan[] => findImageReferences(element.value, isKnownNumber);
		let dragging = false;
		let last = { start: element.selectionStart, end: element.selectionEnd };
		const snap = (pointer: boolean): void => {
			if (dragging || composingRef.current) return;
			const start = element.selectionStart;
			const end = element.selectionEnd;
			const forward = pointer || start !== end || start === last.start ? null : start > last.start;
			const next = snapSelection(spans(), start, end, forward);
			if (next.start !== start || next.end !== end) element.setSelectionRange(next.start, next.end, element.selectionDirection);
			last = { start: next.start, end: next.end };
		};
		const onSelectionChange = (): void => {
			if (document.activeElement === element) snap(false);
		};
		const onPointerDown = (): void => {
			dragging = true;
		};
		const onPointerUp = (): void => {
			if (!dragging) return;
			dragging = false;
			snap(true);
		};
		const onBeforeInput = (event: InputEvent): void => {
			if (captureRef.current !== null) { event.preventDefault(); return; }
			if (event.isComposing || !event.inputType.startsWith("delete")) return;
			const direction = event.inputType.endsWith("Backward") ? "backward" : event.inputType.endsWith("Forward") ? "forward" : "range";
			const range = deletionRange(spans(), element.selectionStart, element.selectionEnd, direction);
			if (range === null) return;
			event.preventDefault();
			replaceRange(element, range.start, range.end, "");
		};
		element.addEventListener("selectionchange", onSelectionChange);
		document.addEventListener("selectionchange", onSelectionChange);
		element.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("pointerup", onPointerUp, true);
		element.addEventListener("beforeinput", onBeforeInput);
		return () => {
			element.removeEventListener("selectionchange", onSelectionChange);
			document.removeEventListener("selectionchange", onSelectionChange);
			element.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("pointerup", onPointerUp, true);
			element.removeEventListener("beforeinput", onBeforeInput);
		};
	}, [composingRef, isKnownNumber, textareaMounted]);

	/**
	 * Keys the open popup claims: arrows move the highlight, Enter/Tab accept
	 * (Enter only without Shift), Escape closes. Everything else falls through to
	 * the composer's own rules, so a closed or empty popup still sends on Enter.
	 * While an IME composition is active no key is claimed at
	 * all — arrows and Enter belong to the candidate window, and consuming them
	 * would break text entry for those users.
	 */
	const onPromptKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>): void => {
			const composing = event.nativeEvent.isComposing || composingRef.current;
			// `Esc` `Esc` in an empty composer while nothing runs opens Rewind, as in the TUI. While a turn runs, Escape
			// belongs to Stop (`omp.stopTurn`), and an open popup takes it first.
			if (event.key === "Escape" && onRewind !== undefined && !composing && !suggestionsOpen) {
				const idle = !client.getSnapshot().working && event.currentTarget.value.length === 0 && imagesRef.current.length === 0;
				if (idle && event.timeStamp - lastEscapeRef.current <= DOUBLE_ESCAPE_MS) {
					lastEscapeRef.current = Number.NEGATIVE_INFINITY;
					event.preventDefault();
					onRewind();
					return;
				}
				lastEscapeRef.current = idle ? event.timeStamp : Number.NEGATIVE_INFINITY;
			}
			if (suggestionsOpen && !composing) {
				if (visible.length > 0 && (event.key === "Home" || event.key === "End")) {
					event.preventDefault(); event.stopPropagation();
					selectSuggestion(event.key === "Home" ? 0 : visible.length - 1); return;
				}
				if (visible.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
					event.preventDefault();
					selectSuggestion(activeIndex < 0 ? (event.key === "ArrowDown" ? 0 : visible.length - 1) : (activeIndex + (event.key === "ArrowDown" ? 1 : visible.length - 1)) % visible.length);
					return;
				}
				if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
					const selected = visible[activeIndex];
					const tabSelection = event.key === "Tab" && activeIndex < 0 ? visible[0] : undefined;
					if (selected !== undefined || tabSelection !== undefined) {
						event.preventDefault();
						acceptSuggestion((selected ?? tabSelection)!);
						return;
					}
				}
			}
			if (!composing && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
				if (event.altKey) {
					if (event.key === "ArrowUp" && client.writable) { event.preventDefault(); void dequeueLast(); }
					return;
				}
				const element = event.currentTarget;
				const value = element.value;
				const at = element.selectionStart;
				const edge = at === element.selectionEnd && (event.key === "ArrowUp" ? !value.slice(0, at).includes("\n") : !value.slice(at).includes("\n"));
				if (edge && imagesRef.current.length === 0) {
					const step = historyStep(sessionPrompts(client.getSnapshot().entries), historyRef.current, event.key === "ArrowUp" ? "older" : "newer", value);
					if (step !== null) {
						event.preventDefault();
						historyRef.current = step.cursor;
						draftRevisionRef.current++;
						textRef.current = step.text;
						pendingCaretRef.current = step.text.length;
						setText(step.text);
						return;
					}
				}
			}
			if (shouldSubmitOnEnter(event, composingRef.current)) {
				event.preventDefault();
				send(event.altKey);
			}
		},
		[acceptSuggestion, activeIndex, client, composingRef, dequeueLast, onRewind, send, suggestionsOpen, visible, selectSuggestion],
	);

	/** Answer the shown dialog; the client answers each dialog once and refuses a stale card. */
	const respond = useCallback(
		(response: ChatUiResponse): void => {
			if (captureRef.current !== null) return;
			const result = client.answerUi(response);
			setSendError(result.ok ? null : result.reason);
		},
		[client],
	);

	const dialog = request !== null && canPrompt ? (
			<>
				<div className="omp-ask">
					{request.method !== "ask" && (
						<div className="omp-ask-title">
							{request.title.length > 0 ? request.title : "the session is waiting for a response"} ·{" "}
							<code>{request.method}</code>
						</div>
					)}
					<fieldset disabled={captureLocked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
						<DialogBody request={request} onRespond={respond} />
					</fieldset>
				</div>
				{sendError !== null && (
					<div className="omp-attach-error" role="alert">
						{sendError}
					</div>
				)}
				<div className="omp-composer-row">
					<div className="omp-composer-hint" style={{ flex: "1 1 auto" }}>
						{busy ? "The session is paused on this request." : "Answering resumes the session."}
						{attached.length > 0 &&
							` · ${
								attached.length === 1 ? "1 attached image is" : `${attached.length} attached images are`
							} held for your next prompt`}
					</div>
					<div className="omp-composer-actions">
						<button type="button" className="omp-btn" onClick={() => respond({ id: request.id, cancelled: true })}>
							Cancel
						</button>
						{busy && (
							<button type="button" className="omp-btn omp-btn--stop" onClick={stop}>
								<span aria-hidden="true" className="codicon codicon-debug-stop omp-btn-icon" /> Stop
							</button>
						)}
					</div>
				</div>
			</>
		) : null;

	const placeholder = resumable
		? "This session is not running. Resume it to send a message."
		: !canPrompt
		? (snapshot.readOnlyReason ?? "waiting for the session…")
		: busy
			? "Steer the running turn"
			: "Message OMP";

	const attachmentAction = (
		<>
			<button
				type="button"
				className="omp-btn omp-composer-attach"
				disabled={!canPrompt || captureLocked || reading > 0}
				aria-label={reading > 0 ? "Reading attached images" : "Attach images"}
				title={reading > 0 ? "Reading attached images…" : "Attach images (PNG, JPEG, GIF, WebP)"}
				onClick={() => fileInputRef.current?.click()}
			>
				<span aria-hidden="true" className={`codicon codicon-${reading > 0 ? "loading" : "attach"}`} />
			</button>
			<input
				ref={fileInputRef}
				className="omp-file-input"
				type="file"
				accept={IMAGE_ACCEPT_ATTRIBUTE}
				multiple
				onChange={onFilesPicked}
			/>
		</>
	);
	// Attach sits with the send actions. Narrow panels show Stop, Follow up and Send/Steer as icons (CSS hides `.omp-btn-label`), so the single toolbar row has the same height idle and busy.
	const promptActions = (
		<>
			{attachmentAction}
			{busy && canPrompt && (
				<button type="button" className="omp-btn omp-btn--stop omp-btn--icon-mid" aria-label="Stop the running turn" title="Stop the running turn" onClick={stop}>
					<span aria-hidden="true" className="codicon codicon-debug-stop omp-btn-icon" />
					<span className="omp-btn-label">Stop</span>
				</button>
			)}
			{resumable && (
				<button
					type="button"
					className="omp-btn omp-btn--primary"
					title="Start the session again from its saved file"
					onClick={() => client.resume()}
				>
					Resume
				</button>
			)}
			{busy && (
				<button
					type="button"
					className="omp-btn omp-btn--icon-mid"
					disabled={!canSubmit}
					title="Queue follow-up (Alt+Enter; Shift+Enter for a newline)"
					aria-label="Queue follow-up"
					aria-keyshortcuts="Alt+Enter"
					onClick={() => send(true)}
				>
					<span aria-hidden="true" className="codicon codicon-list-ordered omp-btn-icon" />
					<span className="omp-btn-label">Queue follow-up</span>
				</button>
			)}
			<button
				type="button"
				className="omp-btn omp-btn--primary omp-btn--icon-narrow"
				disabled={!canSubmit}
				title={busy ? "Steer the running turn (Enter; Shift+Enter for a newline)" : "Send message (Enter; Shift+Enter for a newline)"}
				aria-label={busy ? "Steer the running turn" : "Send message"}
				aria-keyshortcuts="Enter"
				onClick={() => send(false)}
			>
				<span aria-hidden="true" className="codicon codicon-send omp-btn-icon" />
				<span className="omp-btn-label">{busy ? "Steer" : "Send"}</span>
			</button>
		</>
	);

	return (
		<div className="omp-composer">
			{progressAvailable && (submitted || chatTurnInProgress(snapshot)) && <div className="omp-turn-progress" aria-hidden="true" />}
			{captureLocked && <div className="omp-composer-hint" role="status">Your input is held unchanged while this editor is being replaced.</div>}
			{lostAttachments > 0 && <div className="omp-attach-error" role="alert">
				{lostAttachments} image{lostAttachments === 1 ? "" : "s"} could not be carried to this document. Reattach them before sending.
				<button type="button" className="omp-btn" disabled={captureLocked} aria-label="Dismiss attachment warning" onClick={() => {
					if (captureRef.current !== null) return;
					lostAttachmentsRef.current = 0;
					setLostAttachments(0);
				}}>Dismiss</button>
			</div>}
			{dialog ?? <>
			{snapshot.statusLine !== null && <div className="omp-composer-hint">{snapshot.statusLine}</div>}
			<ExtensionNoticeLine snapshot={snapshot} />
			<ExtensionWidgets snapshot={snapshot} placement="aboveEditor" />
			{request !== null && !canPrompt && (
				<div className="omp-ask-help">
					{live
						? "the session is waiting for a response, but this panel cannot answer it"
						: "the session is waiting for a response, but it is not running here"}
				</div>
			)}
			{sending && !captureLocked && <div className="omp-composer-hint" role="status">Waiting for OMP to confirm this message. Your draft remains editable.</div>}
			{recoverable.map(entry => (
				<div key={entry.id} className="omp-attach-error" role="alert">
					<div>{entry.reason}</div>
					{(entry.lostAttachments ?? 0) > 0 && <div>{entry.lostAttachments} image{entry.lostAttachments === 1 ? "" : "s"} must be reattached before sending this original.</div>}
					<details>
						<summary>{entry.unconfirmed ? "Unconfirmed message" : "Unsent message"}</summary>
						<pre style={{ whiteSpace: "pre-wrap", maxHeight: 120, overflowY: "auto" }}>{entry.text}</pre>
					</details>
					<button type="button" className="omp-btn" disabled={captureLocked} onClick={() => {
						if (captureRef.current !== null) return;
						const held = compactForSend(textRef.current, imagesRef.current);
						if (held.text !== entry.text || held.images.length !== entry.images.length || held.images.some((image, index) => image.mimeType !== entry.images[index]?.mimeType || image.data !== entry.images[index]?.data)) {
							offerQueuedForEditing([{ text: entry.text, images: entry.images }]);
							lostAttachmentsRef.current += entry.lostAttachments ?? 0;
							setLostAttachments(lostAttachmentsRef.current);
						}
						else if ((entry.lostAttachments ?? 0) > lostAttachmentsRef.current) {
							lostAttachmentsRef.current = entry.lostAttachments ?? 0;
							setLostAttachments(lostAttachmentsRef.current);
						}
						textareaRef.current?.focus();
					}}>Add to draft</button>
					<button type="button" className="omp-btn" disabled={captureLocked} aria-label="Dismiss recoverable message" onClick={() => {
						if (captureRef.current === null) publishRecoverable(recoverableRef.current.filter(item => item.id !== entry.id));
					}}>Dismiss</button>
				</div>
			))}
			{sendError !== null && (
				<div className="omp-attach-error" role="alert">
					{sendError}
				</div>
			)}
			{attached.length > 0 && (
				<ul className="omp-attachments" aria-label="attached images">
					{attached.map(image => (
						<li key={image.id} className="omp-attachment" data-image-number={image.number}>
							<span className="omp-attachment-figure">
								<img className="omp-attachment-thumb" alt={`Image #${image.number}`} src={`data:${image.mimeType};base64,${image.data}`} />
								<span className="omp-attachment-number" aria-hidden="true">#{image.number}</span>
							</span>
							<span className="omp-attachment-meta">
								<span className="omp-attachment-name" title={image.name}>
									{image.name}
								</span>
								<span className="omp-attachment-size">{formatBytes(image.bytes)}</span>
							</span>
							<button
								type="button"
								className="omp-attachment-remove"
								disabled={!canPrompt || captureLocked}
								aria-label={`Remove Image #${image.number} (${image.name})`}
								title={`Remove ${image.name}`}
								onClick={() => removeImage(image.number)}
							>
								×
							</button>
						</li>
					))}
				</ul>
			)}
			{attachError !== null && (
				<div className="omp-attach-error" role="alert">
					{attachError}
				</div>
			)}
			<div className="omp-composer-row omp-composer-row--input">
				<div className="omp-suggest-wrapper" ref={wrapperRef}>
					{referenceSpans.length > 0 && (
						<div className="omp-textarea-mirror" ref={mirrorRef} aria-hidden="true">
							<div className="omp-textarea-mirror-text">
								{draftSegments(text, referenceSpans).map((segment, index) => segment.marker
									? <mark key={index} className="omp-image-ref-mark" data-image-number={segment.number}>{segment.text}</mark>
									: segment.text)}
								{"\u200b"}
							</div>
						</div>
					)}
					<textarea
						ref={textareaRef}
						className="omp-textarea"
						value={text}
						onChange={onTextChange}
						onScroll={event => syncMirror(event.currentTarget, mirrorRef.current)}
						onDragOver={onDragOver}
						onDrop={onDrop}
						onKeyDown={onPromptKeyDown}
						onKeyUp={event => syncCaret(event.currentTarget)}
						onClick={event => syncCaret(event.currentTarget)}
						onSelect={event => syncCaret(event.currentTarget)}
						onPaste={onPaste}
						onCompositionStart={onCompositionStart}
						onCompositionEnd={endComposition}
						placeholder={placeholder}
						rows={MIN_ROWS}
						spellCheck={false}
						readOnly={captureLocked}
						disabled={!canPrompt}
						role="combobox"
						aria-autocomplete="list"
						aria-expanded={suggestionsOpen}
						aria-controls={suggestionsOpen ? suggestionListId : undefined}
						aria-activedescendant={suggestionsOpen && activeIndex >= 0 ? `${suggestionListId}-${activeIndex}` : undefined}
					/>
					{suggestionsOpen && (
						<ul id={suggestionListId} role="listbox" aria-label={argument !== null ? "Command arguments" : slash !== null ? "Slash commands" : "Workspace files"} className="omp-suggest-list">
							{argumentHint && <li role="presentation" className="omp-suggest-option omp-native-muted omp-slash-hint">{argumentHint}{argument?.hint.requirement === "optional" ? " · optional" : argument?.hint.requirement === "required" ? " · required" : ""}</li>}
							{visible.map((option, index) => (
								<li
									key={`${option.kind}:${option.name}`}
									id={`${suggestionListId}-${index}`}
									role="option"
									aria-selected={index === activeIndex}
									className={`omp-suggest-option${index === activeIndex ? " omp-suggest-option--active" : ""}`}
									onMouseEnter={() => selectSuggestion(index, true)}
									// Accepting must not blur the textarea first: the click would
									// otherwise land after the caret and draft context were lost.
									onMouseDown={event => event.preventDefault()}
									onClick={() => acceptSuggestion(option)}
								>
									<span className="omp-slash-label"><strong>{option.label}</strong>{option.source && <span className="omp-native-badge">{option.source}</span>}{option.isDefault && <span className="omp-native-badge">default</span>}{option.kind === "argument" && argument?.hint.requirement === "optional" && <span className="omp-native-badge">optional</span>}</span>
									{option.description && <span className="omp-slash-description">{option.description}</span>}
									{option.inputHint && <span className="omp-native-muted omp-slash-hint">{option.inputHint}</span>}
									{option.usage && <span className="omp-native-muted omp-slash-hint">{option.usage}</span>}
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
			<ExtensionWidgets snapshot={snapshot} placement="belowEditor" />
			</>}
			<ChatFooter client={client} snapshot={snapshot}
				trailingActions={dialog === null ? promptActions : undefined} />
		</div>
	);
}
