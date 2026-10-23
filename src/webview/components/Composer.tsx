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
 *   budget (the Draft module's `attach`, `lib/draft/`); a rejected file changes nothing and is
 *   reported inline, so an oversized or mislabeled pick never reaches the host;
 * - the draft is read and cleared through the Draft cell (`lib/draft/`), so a second Enter/click in the
 *   same frame cannot send the same draft twice, and an unfinished file read
 *   cannot be sent half-attached;
 * - a pending dialog owns the composer outright: no attachment can be added,
 *   and a held draft is announced instead of being merged into a dialog answer;
 * - every attached image (paste, Attach, drop) is a numbered `[Image #N, WxH]` marker in the
 *   prompt text at the caret, the OMP TUI's own convention (`lib/draft/image-references.ts`);
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
 *
 * Code blocks (docs/designs/2026-10-15-composer-code-blocks.md, {@link ../lib/code-fence}):
 * - inside a fenced block of the draft Enter is a newline, Tab and Shift+Tab indent and outdent like an
 *   editor, and Ctrl+Enter is the chord that sends; Shift+Tab with nothing to outdent leaves the box;
 * - no completion opens there, and the editing surface ({@link ./DraftEditor}, {@link ../lib/draft-surface}) draws the
 *   lines of a block in the editor font on a band while the prose around them keeps the UI font;
 * - the text that is sent is the draft as typed.
 */
import type { ImageContent } from "@oh-my-pi/pi-wire";
import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { chatTurnInProgress } from "../../chat/model";
import { nativeSettingsCommand } from "../../chat/settings-command";
import { guestTransport } from "../bridge";
import { formatBytes, groupedCount } from "../../shared/file-size";
import { MAX_MESSAGE_CHARS } from "../../shared/attach-limits";
import { composeFileBlocks } from "../../shared/file-blocks";
import {
	MAX_DRAFT_BYTES,
	acceptCompletion,
	activeDocuments,
	addRecoverable,
	attach as attachToDraft,
	clearText,
	cleared,
	commandResolver,
	compactForSend,
	completionAt,
	dismissLost,
	dismissRecoverable,
	documentChars,
	fieldRules,
	insertCommand,
	insertText,
	keyEdit,
	knowsReference,
	rawTotal,
	readingBy,
	recall,
	removeAttachment,
	removeQuote,
	restoreHandoff,
	restoreQueued,
	rewind,
	setEditorText,
	viewOf,
	withState,
	type AttachEntry,
	type DraftDocument,
	type Recoverable,
	type ReferenceKind,
} from "../lib/draft/draft";
import { dragCarries, droppedFileUris, fileFromAttached, filesFrom } from "../lib/attach-dom";
import { attachReader } from "../lib/attach-reader";
import { useDraft } from "../lib/use-draft";
import { readLinkedFiles } from "../lib/read-linked";
import { AskDialog, AskOptionRow } from "./AskDialog";
import { AttachmentStrip } from "./AttachmentStrip";
import { DraftEditor } from "./DraftEditor";
import type { ChatModel, ChatUiRequest, ChatUiResponse } from "../../chat/model";
import type { ChatClient, ChatSnapshot } from "../lib/chat-client";
import { useSendWith } from "../lib/send-with";
import { isSendChord, SEND_KEY_LABELS, type ChatSendWith } from "../../chat/send-with";
import { provideQuoteSink } from "../lib/quote-sink";
import { quoteSelectionIntoDraft } from "../lib/quote-selection";
import { useQuoteDraft } from "../lib/use-quote-draft";
import { QuoteRemoveButtons } from "./QuoteRemoveButtons";
import { chatWritable } from "../lib/chat-client";
import { startsSession } from "../lib/chat-operation";
import { reportComposerPopupOpen } from "../lib/composer-overlay";
import { useHeldFocus } from "../lib/use-held-focus";
import { providePanelActions } from "../lib/panel-actions";
import { focusWhenPossible } from "../lib/focus-retry";
import { createDoubleEscape } from "../lib/double-escape";
import { isEditableTarget } from "../lib/type-to-focus";
import { provideDraftHandoff, subscribeRestoredDraft, takeRestoredDraft } from "../lib/draft-handoff";
import type { DraftCapture } from "../lib/draft-handoff";
import { subscribeInsertedText } from "../lib/insert-text";
import { offerQueuedForEditing, subscribeQueuedForEditing } from "../lib/queue-handover";
import { queueNotice, queueRows, restoredEntries } from "../lib/queue-view";
import { sessionPrompts } from "../../chat/prompt-history";
import { MAX_DROP_URIS } from "../../protocol/messages";
import { useDismissibleLayer } from "../lib/dismissible-layer";
import { ExtensionNoticeLine, ExtensionWidgets } from "./ExtensionSurfaces";
import { argumentSuggestions, isRewindCommand, missingRequiredArgument, slashSuggestions } from "../lib/slash-completion";
import { ChatFooter } from "./ChatFooter";
import { CommandsMenu } from "./CommandsMenu";
import { KeyboardShortcutsButton } from "./KeyboardShortcutsButton";
import { pickPlan, type CommandContext, type CommandRow } from "../lib/command-list";
import { rewindBlockedReason } from "../../chat/rewind-mode";

/** Textarea line height, kept in sync with `.omp-textarea`; vertical padding and border are read from the element. */
const LINE_PX = 20;
const MAX_ROWS = 8;
/** The words under the field while the caret is in a fenced code block (docs/designs/2026-10-15-composer-code-blocks.md). */
const CODE_HINT = "Code block · Ctrl+Enter: send · Enter: new line · Tab: indent · Shift+Tab: outdent, or leave when there is nothing to outdent";
/** The words under the field while the caret is in a quote line (docs/designs/2026-10-15-quote-chat-selection.md). */
const QUOTE_HINTS: Record<ChatSendWith, string> = {
	enter: "Quote · Ctrl+Enter: send · Enter: new line · Shift+Tab: leave the quote",
	shiftEnter: "Quote · Shift+Enter or Ctrl+Enter: send · Enter: new line · Shift+Tab: leave the quote",
};
/** How long a quote's notice stays above the conversation. */
const QUOTE_NOTICE_MS = 5000;
/** How long the notice that a Stop took a message back (or could not) stays above the conversation. */
const STOP_NOTICE_MS = 8000;

/** Wait after the last keystroke before asking the extension host for paths. */
const SUGGESTION_DEBOUNCE_MS = 150;
/** Quiet time before the screen-reader status states how many suggestions the list holds, so typing does not announce each narrowing. */
const SUGGESTION_ANNOUNCE_MS = 400;
/** How long a dropped file waits for the host to read it before the composer says so. */
const URI_REQUEST_TIMEOUT_MS = 20_000;

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

/** Why a file cannot be attached or read where the extension host's own connection is missing (the fallback route, decision 23). */
const NEEDS_HOST = "Attaching files needs the editor's connection to the extension host; reload the window.";

/**
 * Whether the session has already answered the send that `before` was taken for: a turn began or ended, the command said what it
 * did, or its `prompt_result` arrived. These are the facts that reset the composer's progress latch, so a latch set only after
 * them would never be reset. A command that asks first (`/review` opens a picker inside its `prompt`, which OMP acknowledges only
 * when the command returns) has its result in before its acknowledgement reaches the page.
 */
function outcomeSince(now: ChatModel, before: ChatModel): boolean {
	return now.working !== before.working || now.phase !== before.phase || now.commandFeedback !== before.commandFeedback || now.lastPromptResult !== before.lastPromptResult;
}

/** Whether `text` starts with the `/skill:<name>` of an installed skill: a skill invocation, which may carry files. */
function startsInstalledSkill(commands: readonly { readonly name: string; readonly source?: string }[], text: string): boolean {
	const token = /^\/(\S+)/.exec(text)?.[1];
	return token !== undefined && commands.some(command => command.source === "skill" && command.name === token);
}

/** The refusal for a message over the limit, with its real figures and, when it carries files, the largest one. */
function tooLongSentence(total: number, documents: readonly DraftDocument[]): string {
	const largest = documents.reduce<DraftDocument | null>((best, document) => (best === null || documentChars(document) > documentChars(best) ? document : best), null);
	const tail = largest === null ? "" : ` The largest file is ${largest.name} (${groupedCount(documentChars(largest))} characters).`;
	return `The message would be ${groupedCount(total)} characters; one message carries ${groupedCount(MAX_MESSAGE_CHARS)}.${tail}`;
}

/**
 * Whether Enter should commit. `false` while an IME composition is active, so
 * the keystroke confirms the composition instead. `nativeEvent.isComposing`
 * covers most browsers; the tracked flag bridges WebKit, which fires the
 * confirming Enter keydown after `compositionend`.
 */
function isComposerSendKey(event: Pick<globalThis.KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "isComposing">, composing: boolean, mode: ChatSendWith): boolean {
	return isSendChord(event, mode) && !(event.isComposing || composing);
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
	const sendWith = useSendWith();

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
					if (isComposerSendKey(event.nativeEvent, composingRef.current, sendWith)) {
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

export function Composer({ client, snapshot, progressAvailable = true, onRewind, onSubmitted }: {
	client: ChatClient;
	snapshot: ChatSnapshot;
	progressAvailable?: boolean;
	/** Open Rewind (`Esc` `Esc` in an empty idle composer, or `/rewind`); absent where Rewind is not offered. */
	onRewind?: () => void;
	/** The user submitted a message (a prompt, a steer or a follow-up, or a Commands row that sends one); the transcript goes back to the tail. */
	onSubmitted?: () => void;
}): ReactNode {
	const { cell, port, surfaceRef, state } = useDraft();
	const { draft, caret, held: captureLocked } = state;
	const { text, reading, recoverable } = draft;
	const lostAttachments = draft.lostImages;
	/** What the last send says besides its result (a file with unsaved changes in the editor); cleared by the next send. */
	const [sendNotice, setSendNotice] = useState<string | null>(null);
	/** The route the host selected: the fallback connection cannot attach files, only the extension host's own can. */
	const [routeKind, setRouteKind] = useState(() => guestTransport.routeKind());
	const [attachError, setAttachError] = useState<string | null>(null);
	/** A drag the composer can attach is over it. */
	const [dropActive, setDropActive] = useState(false);
	/** Why the last send or answer was refused; cleared by the next accepted one. */
	const [sendError, setSendError] = useState<string | null>(null);
	const [submitted, setSubmitted] = useState(false);
	const [sending, setSending] = useState(false);
	const sendingRef = useRef(false);
	const getField = useCallback((): HTMLElement | null => surfaceRef.current?.element ?? null, [surfaceRef]);
	/** The surface's composition window, read live: false while no field is mounted. */
	const composingRef = useMemo(() => ({ get current(): boolean { return port.composing(); } }), [port]);
	const wrapperRef = useRef<HTMLDivElement | null>(null);
	const mountedRef = useRef(true);
	/** The one drop whose files the host is reading, and the timer that gives up on it. */
	const pendingUrisRef = useRef<{ readonly requestId: number; readonly timer: number | null } | null>(null);
	const uriRequestSeqRef = useRef(0);
	/** Last completion request sent, or `null` once it is answered or invalidated. */
	const pendingQueryRef = useRef<{ requestId: number; query: string } | null>(null);
	const requestSeqRef = useRef(0);
	const [suggestions, setSuggestions] = useState<readonly string[]>(NO_SUGGESTIONS);
	const [activeSuggestion, setActiveSuggestion] = useState(0);
	const [argumentSelectionKey, setArgumentSelectionKey] = useState<string | null>(null);
	const suggestionListId = useId();
	const [dismissedCompletion, setDismissedCompletion] = useState<string | null>(null);

	const live = snapshot.phase === "live";
	// Writing needs a live, unlocked session; the same rule refuses inside the client, so
	// a stale button can never reach the host.
	const canPrompt = chatWritable(snapshot);
	// A session that is re-attached while the user types disables the field; it takes the focus back when it is writable again.
	useHeldFocus(getField, canPrompt, canPrompt ? "" : `phase=${snapshot.phase}${snapshot.readOnlyReason === null ? "" : " read-only"}`);
	const resumable = snapshot.phase === "view-only" || snapshot.phase === "stopped";
	// The click is acknowledged in this page before the host answers (`ChatClient.getOperationState`): Resume says `Starting…` and Stop says `Stopping…`.
	const { operation, notice: operationNotice } = useSyncExternalStore(client.subscribeOperations, client.getOperationState);
	const starting = startsSession(operation);
	const stopping = operation?.kind === "stop";
	const busy = snapshot.working;
	const sendWith = useSendWith();
	const request = snapshot.uiRequest;
	useEffect(() => { setSubmitted(false); }, [snapshot.working, snapshot.phase, snapshot.commandFeedback, snapshot.lastPromptResult, progressAvailable]);
	const keyLabels = SEND_KEY_LABELS[sendWith];
	/** What the draft draws and gates on: the attachments whose marker is in the text, the fenced blocks and quote lines, and where the caret is among them. */
	const view = useMemo(() => viewOf(draft, caret), [draft, caret]);
	const { images: attached, documents: attachedDocuments, blocks, caretBlock, caretInQuote } = view;
	const quoteLayout = view.quote;
	const codeHintId = useId();
	const canSubmit = canPrompt && !captureLocked && request === null && !sending && reading === 0 && view.hasContent;

	// A command or a skill is a chip while the session's catalogue lists it: the host sends it as a `prompt` whether or not a turn runs
	// (`chat/prompt-routing.ts`), so the catalogue is what the surface draws from besides the attachments.
	const resolver = useMemo(() => commandResolver(snapshot.commands), [snapshot.commands]);
	const resolverRef = useRef(resolver);
	// The surface asks these rules for its chips and where a caret rests; their lookups read the cell and the catalogue now, never a render's copy.
	const rules = useMemo(() => fieldRules((kind, number, name) => knowsReference(cell.read(), kind, number, name), name => resolverRef.current(name)), [cell]);
	// A marker is a chip while its attachment is attached and plain text otherwise, so the surface draws again when the set of attachments or the catalogue changes.
	useLayoutEffect(() => {
		resolverRef.current = resolver;
		surfaceRef.current?.refresh();
	}, [draft.images, draft.documents, resolver, surfaceRef]);
	const fieldMounted = !(request !== null && canPrompt);
	// A field that mounts while a hand-off holds the draft (a dialog closing meanwhile) starts frozen.
	useLayoutEffect(() => {
		if (fieldMounted) port.adopt();
	}, [fieldMounted, port]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			clearTimeout(pendingUrisRef.current?.timer ?? undefined);
			// Draft base64 and previews live only in this component's state and
			// refs; dropping them with the component is what releases them.
			mountedRef.current = false;
		};
	}, []);

	/**
	 * `@` completion exists only where prompting does: a read-only or
	 * disconnected panel asks nothing, and a pending host request owns the
	 * composer outright, so no search runs beside it. Inside a fenced code block
	 * nothing completes: `/` and `@` there are code, and Enter and Tab are the editor's.
	 */
	const completionsEnabled = canPrompt && !captureLocked && request === null && caretBlock === null && !caretInQuote;
	const completionKey = `${text}\0${caret}`;
	// Keyed by the text alone: a read starting or a card appearing changes the draft but never the token, and a new token object would send the host another request.
	const tokens = useMemo(() => completionAt(draft, caret, snapshot.commands, completionsEnabled && dismissedCompletion !== completionKey), [draft.text, caret, snapshot.commands, completionsEnabled, dismissedCompletion, completionKey]); // eslint-disable-line react-hooks/exhaustive-deps
	const { slash, argument, mention } = tokens;
	// Narrow the last answer against whatever has been typed since it arrived, so
	// the popup stays useful between keystrokes instead of blanking until the next
	// debounce, and a stale answer can never offer an irrelevant path.
	const visible = useMemo(() => {
		if (slash !== null) return slashSuggestions(snapshot.commands, slash.query, slash.skillsOnly).map(command => ({ kind: "slash" as const, name: command.name, label: `/${command.name}`, description: command.description, source: command.source === "skill" ? "Skill" : command.source, inputHint: command.inputHint, usage: undefined, isDefault: false }));
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
		const now = cell.getState();
		setDismissedCompletion(`${now.draft.text}\0${now.caret}`);
		setSuggestions(NO_SUGGESTIONS);
		pendingQueryRef.current = null;
		requestSeqRef.current++;
	}, [cell]);
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
		const now = cell.getState();
		setDismissedCompletion(`${now.draft.text}\0${now.caret}`);
	}), [cell]);

	/**
	 * Replace the `@` token under the caret with the chosen path, leaving every
	 * other character — and the attachment draft — untouched. Quoting is the
	 * mention grammar's, not the user's concern: `spliceMention` emits the bare
	 * `@path` form when it parses back to the same path and a quoted form
	 * otherwise. An accepted completion is skipped while an IME composition is open or the hand-off holds the draft.
	 */
	const acceptSuggestion = useCallback(
		(selected: { kind: "file" | "slash" | "argument"; name: string }): void => {
			if (!completionsEnabled) return;
			cell.perform(acceptCompletion(cell.getState().caret, selected, snapshot.commands), { composing: "skip", held: "drop" }, outcome => {
				if (outcome.kind !== "applied") return;
				// The answer has been consumed; anything still in flight is stale.
				pendingQueryRef.current = null;
				requestSeqRef.current++;
				setSuggestions(NO_SUGGESTIONS);
			});
		},
		[cell, completionsEnabled, snapshot.commands],
	);

	/**
	 * Add `entries` to the draft (the Draft module's `attach`): a paste, a drop, the host's answer to a drop or a pick. The draft must not
	 * be held and the session must be writable; what the attach says about the files is the alert row's.
	 */
	const attach = useCallback(
		async (entries: readonly AttachEntry[], earlier: readonly string[] = []): Promise<void> => {
			if (cell.getState().held || !canPrompt) return;
			const result = await attachToDraft(cell, entries, attachReader, earlier, { started: () => setSendNotice(null) });
			if (result.alert !== undefined && mountedRef.current) setAttachError(result.alert);
		},
		[canPrompt, cell],
	);

	/** The × on a thumbnail or a tile deletes that attachment's marker(s) from the text, as one undo step; the attachment follows its marker. */
	const removeAttachmentOf = useCallback(
		(kind: ReferenceKind, number: number): void => {
			cell.perform(removeAttachment(kind, number), { composing: "wait", held: "drop" }, outcome => {
				if (outcome.kind !== "dropped") setAttachError(null);
			});
		},
		[cell],
	);

	/** A paste of files attaches them (an image as an image, a text as a document); the surface cancels the paste, so nothing unreadable lands in the text. Any other paste is its plain text. */
	const handlePaste = useCallback(
		(event: ClipboardEvent): boolean => {
			const files = filesFrom(event.clipboardData);
			if (files.length === 0) return false;
			void attach(files.map(file => ({ kind: "file" as const, file })));
			return true;
		},
		[attach],
	);

	/** Settle the one drop or pick that is waiting for the host: its share of `reading` is released here and nowhere else. */
	const finishUriRequest = useCallback((): void => {
		const waiting = pendingUrisRef.current;
		if (waiting === null) return;
		pendingUrisRef.current = null;
		clearTimeout(waiting.timer ?? undefined);
		cell.commit(readingBy(cell.read(), -1));
	}, [cell]);

	/** Ask the host to read the files a drag from VS Code's Explorer or an editor tab named; its answer attaches them. */
	const requestUris = useCallback((uris: readonly string[]): void => {
		finishUriRequest();
		const requestId = ++uriRequestSeqRef.current;
		cell.commit(readingBy(cell.read(), 1));
		const timer = window.setTimeout(() => {
			if (pendingUrisRef.current?.requestId !== requestId) return;
			finishUriRequest();
			setAttachError("The extension host did not answer, so nothing was attached from VS Code. Try again.");
		}, URI_REQUEST_TIMEOUT_MS);
		pendingUrisRef.current = { requestId, timer };
		if (guestTransport.post({ type: "omp:attach-uris", requestId, uris: [...uris] }) === false) {
			finishUriRequest();
			setAttachError(NEEDS_HOST);
		}
	}, [cell, finishUriRequest]);

	/** Open the host's file dialog; what it returns attaches like a drop. A native dialog may stay open as long as the user likes, so a pick has no timeout. */
	const requestPick = useCallback((): void => {
		if (cell.getState().held || !canPrompt) return;
		finishUriRequest();
		const requestId = ++uriRequestSeqRef.current;
		cell.commit(readingBy(cell.read(), 1));
		pendingUrisRef.current = { requestId, timer: null };
		if (guestTransport.post({ type: "omp:pick-files", requestId }) === false) {
			finishUriRequest();
			setAttachError(NEEDS_HOST);
		}
	}, [canPrompt, cell, finishUriRequest]);

	// A route change settles a pending pick (its answer may have gone to the route that was left) and tells the button whether the host's connection is there.
	useEffect(() => guestTransport.onRouteChange(kind => {
		setRouteKind(kind);
		finishUriRequest();
	}), [finishUriRequest]);

	/**
	 * Drags are taken at the document, not on the composer card: a drop anywhere on the Chat page attaches, and a drag that
	 * enters over the transcript is not lost on its way to the card. An accepted drag is also hidden from the VS Code shell
	 * script, which listens on the window and, told of a file drag, has the workbench block this page's pointer events so
	 * its own drop overlay takes the drop and opens the image in an editor tab. That works only for a drag that first
	 * enters over this page; one that enters over another part of the window (the usual case) is blocked before the page
	 * sees it, and holding Shift is what lets it through.
	 */
	useEffect(() => {
		const accepts = (event: globalThis.DragEvent): boolean =>
			event.dataTransfer !== null && canPrompt && !cell.getState().held && dragCarries(event.dataTransfer) !== null;
		const over = (event: globalThis.DragEvent): void => {
			if (!accepts(event) || event.dataTransfer === null) return;
			event.preventDefault();
			event.stopPropagation();
			event.dataTransfer.dropEffect = "copy";
			setDropActive(true);
		};
		const leave = (event: globalThis.DragEvent): void => {
			// A leave into another element of the page is not a leave; one to nothing is the drag going away.
			if (!(event.relatedTarget instanceof Node)) setDropActive(false);
		};
		const drop = (event: globalThis.DragEvent): void => {
			setDropActive(false);
			if (!accepts(event) || event.dataTransfer === null) return;
			const files = filesFrom(event.dataTransfer);
			const named = files.length > 0 ? { uris: [] as string[], refusal: null } : droppedFileUris(event.dataTransfer, MAX_DROP_URIS);
			if (files.length === 0 && named.uris.length === 0 && named.refusal === null) return;
			event.preventDefault();
			event.stopPropagation();
			if (named.refusal !== null) setAttachError(named.refusal);
			else if (files.length > 0) void attach(files.map(file => ({ kind: "file" as const, file })));
			else requestUris(named.uris);
		};
		document.addEventListener("dragenter", over);
		document.addEventListener("dragover", over);
		document.addEventListener("dragleave", leave);
		document.addEventListener("drop", drop);
		return () => {
			document.removeEventListener("dragenter", over);
			document.removeEventListener("dragover", over);
			document.removeEventListener("dragleave", leave);
			document.removeEventListener("drop", drop);
			setDropActive(false);
		};
	}, [attach, canPrompt, cell, requestUris]);

	/** A message kept as a card beside the draft: a refused or uncertain send. */
	const keepRecoverable = useCallback((entry: Omit<Recoverable, "id">): void => {
		cell.commit(addRecoverable(cell.read(), entry));
	}, [cell]);

	const send = useCallback(
		async (followUp: boolean): Promise<void> => {
			// The wire pairs the Nth marker with the Nth image, so the draft's stable numbers are
			// compacted to 1..K here and images whose marker was deleted are not sent. A document's marker is the
			// reference of its block and is left as it is.
			const typed = cell.read();
			const compacted = compactForSend(typed.text, typed.images);
			const files = activeDocuments(typed.text, typed.documents);
			const draft = compacted.text.trim();
			const attached = compacted.images;
			// A pending dialog, a locked or not-live panel, and a read that has started
			// but not published yet must never produce a message. The cell's `reading`, not the one
			// a render saw, is what makes this true inside the same frame that started the read.
			if (cell.getState().held || !canPrompt || request !== null || typed.reading > 0 || sendingRef.current) return;
			if (draft.length === 0 && attached.length === 0 && files.length === 0) return;
			// Chat's own `/rewind` and `/branch` never reach OMP; both open the in-place Rewind.
			if (onRewind !== undefined && attached.length === 0 && files.length === 0 && isRewindCommand(draft)) {
				cell.commit(clearText(typed));
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
			// A text that starts with `/` is a command to OMP, which does not take files; a skill invocation is the one that does.
			if (files.length > 0 && draft.startsWith("/") && !startsInstalledSkill(snapshot.commands, draft)) {
				setSendError("A message that starts with / is a command and cannot carry files.");
				return;
			}
			const known = files.reduce((sum, file) => sum + documentChars(file), draft.length);
			if (known > MAX_MESSAGE_CHARS) {
				setSendError(tooLongSentence(known, files));
				return;
			}
			const wire: ImageContent[] = attached.map(image => ({
				type: "image",
				mimeType: image.mimeType,
				data: image.data,
			}));
			const payload = wire.length > 0 ? wire : undefined;
			// The draft revision is the one at Enter: edits made while the files are read are kept by the guard below.
			const revision = cell.read().revision;
			// Set before any await, so a second Enter and a command that sends are blocked while the files are read. The read is
			// not counted in `reading`: a hand-off during it would be refused and a view switch would lose the draft.
			sendingRef.current = true;
			setSending(true);
			setSendNotice(null);
			const giveUp = (reason: string | null): void => {
				sendingRef.current = false;
				if (!mountedRef.current) return;
				setSending(false);
				if (reason !== null) setSendError(reason);
			};
			const linked = files.filter(file => file.source.kind === "linked");
			const texts = new Map<number, { label: string; content: string; dirty: boolean }>();
			if (linked.length > 0) {
				const heldChars = files.reduce((sum, file) => sum + (file.source.kind === "held" ? file.source.content.length : 0), draft.length);
				const read = await readLinkedFiles(
					guestTransport,
					++uriRequestSeqRef.current,
					linked.flatMap(file => (file.source.kind === "linked" ? [{ number: file.number, ref: file.source.ref }] : [])),
					Math.max(0, MAX_MESSAGE_CHARS - heldChars),
					new Map(linked.map(file => [file.number, file.name])),
				);
				if (!read.ok) {
					giveUp(read.reason);
					return;
				}
				for (const [number, file] of read.files) texts.set(number, file);
			}
			// The values the send closed over are from before the read: judge the page as it is now. A hand-off that began during
			// the read already carries the draft intact; otherwise the draft is untouched and Enter sends it again.
			const current = client.getSnapshot();
			if (cell.getState().held || !chatWritable(current) || current.uiRequest !== null || !mountedRef.current) {
				giveUp(null);
				return;
			}
			const blocks: { number: number; name: string; label: string | null; content: string }[] = [];
			for (const file of files) {
				if (file.source.kind === "held") {
					blocks.push({ number: file.number, name: file.name, label: file.source.label, content: file.source.content });
					continue;
				}
				const read = texts.get(file.number);
				if (read === undefined) {
					giveUp(`${file.name} could not be read.`);
					return;
				}
				blocks.push({ number: file.number, name: file.name, label: read.label, content: read.content });
			}
			const text = composeFileBlocks(draft, blocks);
			// Escaping the files' text can add characters, and a text-only message was never checked at all.
			if (text.length > MAX_MESSAGE_CHARS) {
				giveUp(tooLongSentence(text.length, files));
				return;
			}
			// The model's own `working`, read now: the delivery follows the turn the
			// session is in at this instant, not the one this render saw.
			const running = client.getSnapshot().working;
			const before = client.getSnapshot();
			cell.commit({ draft: withState(cell.read(), { inFlight: { text, images: wire } }), writes: [] });
			onSubmitted?.();
			const result = await (!running
				? client.sendPrompt(text, payload)
				: followUp
					? client.sendFollowUp(text, payload)
					: client.sendSteer(text, payload));
			for (let held = cell.held(); held !== null; held = cell.held()) await held;
			cell.commit({ draft: withState(cell.read(), { inFlight: null }), writes: [] });
			sendingRef.current = false;
			if (!mountedRef.current) return;
			setSending(false);
			if (!result.ok) {
				if (result.unconfirmed || cell.read().revision !== revision) {
					keepRecoverable({ text, images: wire, reason: result.reason, unconfirmed: result.unconfirmed === true });
					setSendError(null);
				} else {
					setSendError(result.reason);
				}
				return;
			}
			setSendError(null);
			const unsaved = linked.filter(file => texts.get(file.number)?.dirty === true).map(file => `${file.name} has unsaved changes in the editor; the saved version was sent.`);
			setSendNotice(unsaved.length > 0 ? unsaved.join(" ") : null);
			if (!running && result.explained !== true && nativeSettingsCommand(draft) === null && !outcomeSince(client.getSnapshot(), before)) setSubmitted(true);
			// Admission may finish after typing, attaching, or restoring another draft. Never erase that work.
			if (cell.read().revision !== revision) return;
			cell.commit(cleared(cell.read()));
			setAttachError(null);
		},
		[keepRecoverable, canPrompt, cell, client, onRewind, onSubmitted, request, snapshot.commands],
	);

	/** Why the Commands list cannot offer a command now; each row adds its own rule (`lib/command-list.ts`). */
	const commandContext = useMemo<CommandContext>(() => ({
		promptBlocked: !canPrompt ? snapshot.readOnlyReason ?? "This session is not running." : captureLocked ? "Your input is held while this editor is being replaced." : request !== null ? "Answer the open question first." : null,
		sessionBlocked: snapshot.phase !== "live" ? "This session is not running." : snapshot.readOnlyReason,
		sendInFlight: sending,
		turnRunning: chatTurnInProgress(snapshot),
		maintenanceRunning: snapshot.maintenance?.status === "working" || snapshot.state?.isCompacting === true,
		rewindBlocked: onRewind === undefined ? "Rewind is not available in this editor." : rewindBlockedReason(snapshot),
	}), [canPrompt, captureLocked, onRewind, request, sending, snapshot]);

	/**
	 * One row picked in the Commands list. A GUI command runs its own action; a command that takes arguments is put in the
	 * draft as `/name ` with the caret after it (the typed completion's rule, so the rest of the draft stays); every other
	 * command is sent the way the Send button sends a draft, but as its own message: the draft itself is never touched.
	 */
	const runCommand = useCallback((row: CommandRow): void => {
		const plan = pickPlan(row);
		if (plan.kind === "rewind") { onRewind?.(); return; }
		if (plan.kind === "action") {
			if (!guestTransport.post({ type: "omp:chat-command", command: plan.command })) setSendError("OMP Desk could not reach the editor host. Try the command again in a moment.");
			surfaceRef.current?.focus();
			return;
		}
		if (cell.getState().held || !canPrompt || request !== null) return;
		if (plan.kind === "insert") {
			pendingQueryRef.current = null;
			requestSeqRef.current++;
			setSuggestions(NO_SUGGESTIONS);
			setDismissedCompletion(null);
			cell.commit(insertCommand(cell.read(), plan.name));
			return;
		}
		if (sendingRef.current) return;
		surfaceRef.current?.focus();
		setSendError(null);
		void (async () => {
			onSubmitted?.();
			const running = client.getSnapshot().working;
			const before = client.getSnapshot();
			const result = await (running ? client.sendSteer(plan.text) : client.sendPrompt(plan.text));
			if (!mountedRef.current) return;
			if (!result.ok) { setSendError(result.reason); return; }
			if (!running && result.explained !== true && nativeSettingsCommand(plan.text) === null && !outcomeSince(client.getSnapshot(), before)) setSubmitted(true);
		})();
	}, [canPrompt, cell, client, onRewind, onSubmitted, request]);

	// A complete capture stays immutable through the host's confirmation and replacement: the cell holds the draft until the host releases it.
	useEffect(() => provideDraftHandoff({
		read(requestId) {
			if (client.draftHandoffPending) return null;
			const content = cell.capture(requestId);
			if (content === null) return null;
			client.setDraftHandoffLocked(true);
			return content;
		},
		release(requestId) {
			if (cell.release(requestId)) client.setDraftHandoffLocked(false);
		},
	}), [cell, client]);

	// A draft handed back to a document that has just been created lands here, and the
	// pending value is consumed so a later mount cannot replay it into a new draft.
	useEffect(() => {
		const apply = (restored: DraftCapture): void => {
			cell.commit(restoreHandoff(cell.read(), restored));
		};
		const pending = takeRestoredDraft();
		if (pending !== null) apply(pending);
		return subscribeRestoredDraft(apply);
	}, [cell]);

	// "OMP Desk: Add File to Session" (the `@path` references) and "OMP Desk: Quote Selection to Session" with nothing selected (the
	// `path:N` line reference): the text the extension host composed in an editor is inserted at the caret (over a selection) as one
	// undo step, and at the end of the draft while no field is mounted. It is never submitted; an IME composition is not
	// interrupted and a held draft waits for its release. One that arrived before this composer mounted is delivered first (`lib/insert-text`).
	useEffect(() => subscribeInsertedText(reference => cell.perform(insertText(reference), { composing: "wait", held: "wait" })), [cell]);

	// `set_editor_text` from the session (an extension prefilling the prompt): the request
	// replaces the draft, once per `seq`. The seq present at mount was already applied by an
	// earlier mount of this composer and is not replayed.
	const editorSeqRef = useRef(snapshot.pendingEditorText?.seq ?? null);
	const editorText = snapshot.pendingEditorText;
	useEffect(() => {
		if (editorText === null || editorText.seq === editorSeqRef.current) return;
		if (cell.getState().held) return;
		editorSeqRef.current = editorText.seq;
		cell.commit(setEditorText(cell.read(), editorText.text));
	}, [editorText, captureLocked, cell]);

	// "Edit" / "Edit all" on queued messages (the queue row above the composer): what OMP handed back is
	// appended to the draft after whatever is already typed, with its images re-attached under fresh
	// reference numbers (`lib/queue-restore`). Nothing is sent, and nothing the draft held is replaced.
	// An IME composition in flight finishes first and a held draft waits for its release, so the restore never splits either.
	useEffect(() => subscribeQueuedForEditing(entries => {
		cell.perform(restoreQueued(entries), { composing: "wait", held: "wait" }, outcome => {
			if (outcome.kind === "applied" && outcome.result.attach !== undefined) setAttachError(outcome.result.attach);
		});
	}), [cell]);

	// Rewind's edit and resubmit (ADR-0051): a rewound prompt replaces the draft, and a draft typed before it moves to
	// a recovery card first, never overwritten. Undo takes the prompt back out while it is still unedited
	// (the draft's `unedited` holds the revision right after it was placed). Any page's navigation counts, so a command-
	// palette Rewind lands here too.
	useEffect(() => client.subscribeNavigations(answer => {
		if (answer.status !== "done") return;
		cell.perform(rewind(answer), { composing: "wait", held: "wait" }, outcome => {
			if (outcome.kind !== "applied") return;
			if (outcome.result.attach !== undefined) setAttachError(outcome.result.attach);
			if (outcome.result.send !== undefined) setSendError(outcome.result.send);
		});
	}), [cell, client]);
	const doubleEscapeRef = useRef(createDoubleEscape());
	// `Esc` `Esc` with the focus on the page around the composer (the transcript, a tool row, a link, the body) opens Rewind
	// under the same conditions. The composer's own field counts through `onPromptKeyDown`, any other editable field not
	// at all; an Escape a popup, menu or dialog took was prevented in the capture phase and never reaches this listener.
	useEffect(() => {
		if (onRewind === undefined) return;
		const onKeyDown = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || composingRef.current || client.getSnapshot().uiRequest !== null) return;
			const target = event.target instanceof Element ? event.target : document.activeElement;
			if (target !== null && isEditableTarget(target)) return;
			const idle = !client.getSnapshot().working && viewOf(cell.read(), 0).untouched;
			if (!doubleEscapeRef.current.press(event.timeStamp, idle)) return;
			event.preventDefault();
			onRewind();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [cell, client, composingRef, onRewind]);

	// VS Code commands and keybindings reach the composer through this registry
	// (`src/webview/lib/panel-actions.ts`): `ompDesk.sendPrompt`, `ompDesk.stopTurn` and
	// `ompDesk.focusComposer` run these same handlers, so a keybinding can never send
	// what the Send button refuses or stop a turn the Stop button would not.

	/**
	 * Stop the running turn; a refusal (session not live, host unreachable) is shown, never dropped. Like the TUI's
	 * Escape, the messages still queued come back into the draft (after what it holds) instead of running later. A Stop
	 * right after a send may also take that message back out of the conversation (ADR-0082): it comes first among
	 * what the hand-over places, so a refill of an empty composer is that message, and a composer that already holds
	 * a draft keeps it, with the message after it.
	 */
	const stop = useCallback((): void => {
		const result = client.sendAbort(answer => {
			const taken = answer.withdrawn;
			const lost = taken?.unavailableImages ?? 0;
			offerQueuedForEditing([
				...(taken === undefined ? [] : [{ text: taken.text, images: taken.images ?? [], withdrawn: true as const, ...(lost > 0 ? { notes: [`${lost} image${lost === 1 ? "" : "s"} of the message could not be restored.`] } : {}) }]),
				...answer.entries.map(entry => ({ text: entry.text, images: entry.images ?? [] })),
			]);
			if (taken !== undefined) {
				client.notices.post({ key: "stop-withdraw", level: "info", ttlMs: STOP_NOTICE_MS, text: taken.unconfirmed === true
					? "Stopped. Your message is back in the composer. OMP did not confirm taking it out of the conversation, so it may still be there."
					: "Stopped. Your message is back in the composer." });
			} else if (answer.kept === true) {
				client.notices.post({ key: "stop-withdraw", level: "warn", ttlMs: STOP_NOTICE_MS, text: "Stopped. OMP could not take the message back out of the conversation, so it stays there." });
			}
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
		if (current.working || !chatWritable(current) || cell.getState().held) return;
		const result = await client.sendPrompt("/retry");
		if (mountedRef.current) setSendError(result.ok ? null : result.reason);
	}, [cell, client]);

	useEffect(
		() =>
			providePanelActions({
				"send-prompt": () => send(false),
				"stop-turn": stop,
				"focus-composer": () => {
					focusWhenPossible({
						element: () => surfaceRef.current,
						active: () => document.activeElement,
						idle: active => active === null || active === document.body,
						schedule: (callback, delayMs) => { window.setTimeout(callback, delayMs); },
					});
				},
				"retry-turn": () => void retry(),
				"quote-selection": () => { quoteSelectionIntoDraft(); },
				"open-rewind": () => { if (onRewind === undefined) setSendError("Rewind is not available in this editor."); else onRewind(); },
			}),
		[onRewind, retry, send, stop],
	);

	// Quoting (docs/designs/2026-10-15-quote-chat-selection.md): every trigger asks this composer through the sink, so the refusals, the edit and the notice are the same whoever asked.
	const quoteSettling = snapshot.phase === "starting" || snapshot.phase === "attaching" || snapshot.phase === "resyncing";
	const { quote } = useQuoteDraft({
		cell,
		writable: () => canPrompt,
		settling: () => quoteSettling,
		notify: (text, level) => client.notices.post({ key: "quote", text, level, ttlMs: QUOTE_NOTICE_MS }),
	}, quoteSettling);
	useEffect(() => provideQuoteSink(quote), [quote]);

	/** Remove quote: the run that starts at `start` and its line break, one undo step; an open composition finishes first. The surface applies it and echoes it to the cell like any edit. */
	const removeQuoteAt = useCallback((start: number): void => {
		cell.perform(removeQuote(start), { composing: "wait", held: "drop" });
	}, [cell]);

	// A prompt picked in the host's history search (`Ctrl+Alt+Y`) joins the draft like an edited queued message.
	useEffect(() => guestTransport.subscribe(message => {
		if (message.type === "omp:recall-prompt") offerQueuedForEditing([{ text: message.text, images: [], documents: message.documents, notes: message.notes }]);
		if (message.type === "omp:attached-files") {
			const waiting = pendingUrisRef.current;
			if (waiting === null || waiting.requestId !== message.requestId) return;
			finishUriRequest();
			// The host's order is the drop's order, so image and file markers land in it.
			void attach(message.items.map((item): AttachEntry => (item.kind === "image" ? { kind: "file", file: fileFromAttached(item) } : { kind: "linked", item })), message.refusals);
		}
	}), [attach, finishUriRequest]);

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

	// A textbox cannot carry `aria-expanded`, so the open list is stated for screen readers by a polite status that says how many
	// suggestions it holds, after a quiet moment so typing does not announce each narrowing.
	const [suggestionStatus, setSuggestionStatus] = useState("");
	useEffect(() => {
		if (!suggestionsOpen) { setSuggestionStatus(""); return; }
		const timer = setTimeout(() => setSuggestionStatus(visible.length > 0 ? `${visible.length} suggestion${visible.length === 1 ? "" : "s"}` : argumentHint), SUGGESTION_ANNOUNCE_MS);
		return () => clearTimeout(timer);
	}, [suggestionsOpen, visible.length, argumentHint]);

	/**
	 * Keys the open popup claims: arrows move the highlight, Enter/Tab accept
	 * (Enter only without Shift), Escape closes. Everything else falls through to
	 * the composer's own rules, so a closed or empty popup still sends on Enter.
	 * While an IME composition is active no key is claimed at
	 * all — arrows and Enter belong to the candidate window, and consuming them
	 * would break text entry for those users.
	 *
	 * Inside a fenced code block (`lib/code-fence`) the editor's keys come first: Enter is a newline that
	 * keeps the line's indentation, Tab and Shift+Tab indent and outdent, and Shift+Tab with nothing to
	 * outdent leaves the box backwards. Ctrl+Enter is not claimed there and sends by the rules below.
	 */
	const onPromptKeyDown = useCallback(
		(event: globalThis.KeyboardEvent): void => {
			const surface = surfaceRef.current;
			if (surface === null) return;
			const composing = event.isComposing || composingRef.current;
			const start = surface.selectionStart;
			const end = surface.selectionEnd;
			const claim = keyEdit(cell.read(), { anchor: start, focus: end }, event, { composing, held: cell.getState().held, sendWith });
			if (claim.claimed) {
				event.preventDefault();
				if (claim.change !== null) cell.commit(claim.change);
				return;
			}
			const inBlock = claim.inBlock;
			// `Esc` `Esc` in an empty composer while nothing runs opens Rewind, as in the TUI. While a turn runs, Escape
			// belongs to Stop (`ompDesk.stopTurn`), and an open popup takes it first.
			if (event.key === "Escape" && onRewind !== undefined && !composing && !suggestionsOpen) {
				const idle = !client.getSnapshot().working && viewOf(cell.read(), 0).untouched;
				if (doubleEscapeRef.current.press(event.timeStamp, idle)) {
					event.preventDefault();
					onRewind();
					return;
				}
			}
			if (suggestionsOpen && !composing && !inBlock) {
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
				// History takes the arrow only when the browser would have no row left to move the caret to: soft-wrapped rows count, not just newlines.
				const edges = start === end ? surface.rowEdges(start) : null;
				const edge = edges !== null && (event.key === "ArrowUp" ? edges.first : edges.last);
				if (edge) {
					const change = recall(cell.read(), sessionPrompts(client.getSnapshot().entries), event.key === "ArrowUp" ? "older" : "newer", cell.getState().held);
					if (change !== null) {
						event.preventDefault();
						cell.commit(change);
						return;
					}
				}
			}
			if (isComposerSendKey(event, composingRef.current, sendWith)) {
				event.preventDefault();
				send(event.altKey);
			}
		},
		[acceptSuggestion, activeIndex, cell, client, composingRef, dequeueLast, onRewind, send, sendWith, suggestionsOpen, visible, selectSuggestion],
	);

	/** Answer the shown dialog; the client answers each dialog once and refuses a stale card. */
	const respond = useCallback(
		(response: ChatUiResponse): void => {
			if (cell.getState().held) return;
			const result = client.answerUi(response);
			setSendError(result.ok ? null : result.reason);
		},
		[client],
	);

	// An open dialog owns Escape: it cancels the dialog (the same answer as its Cancel button) and never stops the turn. The host's
	// stop key is disarmed through the popup owner; the listener is on the bubbling phase, so an inner layer that takes Escape itself
	// (the transcript find bar, a menu) has already prevented it, and a composition or an `isComposing` key is left alone. Like VS Code's
	// quick pick and input box, one Escape closes the whole dialog, also from the "Other" field of a question.
	const dialogOpen = request !== null && canPrompt;
	const dialogId = request?.id ?? null;
	useEffect(() => {
		if (!dialogOpen || dialogId === null) return;
		reportComposerPopupOpen("dialog", true);
		const onKeyDown = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
			event.preventDefault();
			event.stopPropagation();
			respond({ id: dialogId, cancelled: true });
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			reportComposerPopupOpen("dialog", false);
		};
	}, [dialogOpen, dialogId, respond]);

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
				{(sendError ?? operationNotice) !== null && (
					<div className="omp-attach-error" role="alert">
						{sendError ?? operationNotice}
					</div>
				)}
				<div className="omp-composer-row">
					<div className="omp-composer-hint" style={{ flex: "1 1 auto" }}>
						{busy ? "The session is paused on this request." : "Answering resumes the session."}
						{attached.length + attachedDocuments.length > 0 &&
							` · ${
								attachedDocuments.length > 0
									? `${attached.length + attachedDocuments.length} attachments are`
									: attached.length === 1 ? "1 attached image is" : `${attached.length} attached images are`
							} held for your next prompt`}
					</div>
					<div className="omp-composer-actions omp-ask-actions">
						<button type="button" className="omp-btn" onClick={() => respond({ id: request.id, cancelled: true })}>
							Cancel
						</button>
						{busy && (
							<button type="button" className="omp-btn omp-btn--stop" disabled={stopping} onClick={stop}>
								<span aria-hidden="true" className={`codicon codicon-${stopping ? "loading codicon-modifier-spin" : "debug-stop"} omp-btn-icon`} /> {stopping ? "Stopping…" : "Stop"}
							</button>
						)}
					</div>
				</div>
			</>
		) : null;

	const placeholder = resumable
		? (starting ? "Starting the session…" : "This session is not running. Resume it to send a message.")
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
				disabled={!canPrompt || captureLocked || reading > 0 || routeKind === "bridge"}
				aria-label={reading > 0 ? "Reading attached files" : "Attach files"}
				title={reading > 0 ? "Reading attached files…" : routeKind === "bridge" ? NEEDS_HOST : "Attach a file or an image. You can also paste one, or hold Shift and drag it onto the chat (from the file manager or VS Code's Explorer): without Shift VS Code may open the file instead."}
				onClick={requestPick}
			>
				<span aria-hidden="true" className={`codicon codicon-${reading > 0 ? "loading" : "attach"}`} />
			</button>
		</>
	);
	// Attach sits with the send actions. Narrow panels show Stop, Follow up and Send/Steer as icons (CSS hides `.omp-btn-label`), so the single toolbar row has the same height idle and busy.
	const promptActions = (
		<>
			{attachmentAction}
			{busy && canPrompt && (
				<button type="button" className="omp-btn omp-btn--stop omp-btn--icon-mid" aria-label={stopping ? "Stopping the turn" : "Stop the running turn"} title={stopping ? "Stopping the turn…" : "Stop the running turn"} disabled={stopping} onClick={stop}>
					<span aria-hidden="true" className={`codicon codicon-${stopping ? "loading codicon-modifier-spin" : "debug-stop"} omp-btn-icon`} />
					<span className="omp-btn-label">{stopping ? "Stopping…" : "Stop"}</span>
				</button>
			)}
			{resumable && (
				<button
					type="button"
					className="omp-btn omp-btn--primary"
					title={starting ? "Starting the session…" : "Start the session again from its saved file"}
					disabled={starting}
					aria-busy={starting}
					onClick={() => client.resume()}
				>
					{starting && <span aria-hidden="true" className="codicon codicon-loading codicon-modifier-spin omp-btn-icon" />}
					{starting ? " Starting…" : "Resume"}
				</button>
			)}
			{busy && (
				<button
					type="button"
					className="omp-btn omp-btn--icon-mid"
					disabled={!canSubmit}
					title={`Queue follow-up (${keyLabels.queue}; ${keyLabels.newline} for a newline)`}
					aria-label="Queue follow-up"
					aria-keyshortcuts={keyLabels.queue}
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
				title={`${busy ? "Steer the running turn" : "Send message"} (${keyLabels.send}; ${keyLabels.newline} for a newline)`}
				aria-label={busy ? "Steer the running turn" : "Send message"}
				aria-keyshortcuts={keyLabels.send}
				onClick={() => send(false)}
			>
				<span aria-hidden="true" className="codicon codicon-send omp-btn-icon" />
				<span className="omp-btn-label">{busy ? "Steer" : "Send"}</span>
			</button>
		</>
	);

	return (
		<div className={dropActive ? "omp-composer omp-composer--dropping" : "omp-composer"}>
			{progressAvailable && (submitted || chatTurnInProgress(snapshot)) && <div className="omp-turn-progress" aria-hidden="true" />}
			{captureLocked && <div className="omp-composer-hint" role="status">Your input is held unchanged while this editor is being replaced.</div>}
			{lostAttachments > 0 && <div className="omp-attach-error" role="alert">
				{lostAttachments} image{lostAttachments === 1 ? "" : "s"} could not be carried to this document. Reattach them before sending.
				<button type="button" className="omp-btn" disabled={captureLocked} aria-label="Dismiss attachment warning" onClick={() => {
					if (cell.getState().held) return;
					cell.commit(dismissLost(cell.read()));
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
			{sending && !captureLocked && request === null && <div className="omp-composer-hint" role="status">Waiting for OMP to confirm this message. Your draft remains editable.</div>}
			{recoverable.map(entry => (
				<div key={entry.id} className="omp-attach-error" role="alert">
					<div>{entry.reason}</div>
					{(entry.lostAttachments ?? 0) > 0 && <div>{entry.lostAttachments} image{entry.lostAttachments === 1 ? "" : "s"} must be reattached before sending this original.</div>}
					{(entry.lostFiles ?? 0) > 0 && <div>{entry.lostFiles} attached file{entry.lostFiles === 1 ? "" : "s"} must be attached again: the file's text is read from disk when sent and is not kept here.</div>}
					<details>
						<summary>{entry.unconfirmed ? "Unconfirmed message" : "Unsent message"}</summary>
						<pre style={{ whiteSpace: "pre-wrap", maxHeight: 120, overflowY: "auto" }}>{entry.text}</pre>
					</details>
					<button type="button" className="omp-btn" disabled={captureLocked} onClick={() => {
						if (cell.getState().held) return;
						const now = cell.read();
						const held = compactForSend(now.text, now.images);
						const files = activeDocuments(now.text, now.documents);
						// The draft already is this original when it composes to the same text. A linked file's text is not here to compare, so it never matches.
						const sameText = files.every(file => file.source.kind === "held") && composeFileBlocks(held.text.trim(), files.flatMap(file => (file.source.kind === "held" ? [{ number: file.number, name: file.name, label: file.source.label, content: file.source.content }] : []))) === entry.text;
						if (!sameText || held.images.length !== entry.images.length || held.images.some((image, index) => image.mimeType !== entry.images[index]?.mimeType || image.data !== entry.images[index]?.data)) {
							offerQueuedForEditing([{ text: entry.text, images: entry.images }]);
							const after = cell.read();
							cell.commit({ draft: withState(after, { lostImages: after.lostImages + (entry.lostAttachments ?? 0) }), writes: [] });
						}
						else if ((entry.lostAttachments ?? 0) > now.lostImages) {
							cell.commit({ draft: withState(now, { lostImages: entry.lostAttachments ?? 0 }), writes: [] });
						}
						surfaceRef.current?.focus();
					}}>Add to draft</button>
					<button type="button" className="omp-btn" disabled={captureLocked} aria-label="Dismiss recoverable message" onClick={() => {
						if (cell.getState().held) return;
						cell.commit(dismissRecoverable(cell.read(), entry.id));
					}}>Dismiss</button>
				</div>
			))}
			{(sendError ?? operationNotice) !== null && (
				<div className="omp-attach-error" role="alert">
					{sendError ?? operationNotice}
				</div>
			)}
			{sendNotice !== null && <div className="omp-composer-hint" role="status">{sendNotice}</div>}
			<AttachmentStrip images={attached} documents={attachedDocuments} removeDisabled={!canPrompt || captureLocked} onRemove={removeAttachmentOf} />
			{attachError !== null && (
				<div className="omp-attach-error" role="alert">
					{attachError}
				</div>
			)}
			<div className="omp-composer-row omp-composer-row--input">
				<div className="omp-suggest-wrapper" ref={wrapperRef}>
					<DraftEditor
						surfaceRef={surfaceRef}
						text={text}
						config={{
							editable: canPrompt,
							placeholder,
							describedBy: caretBlock !== null || caretInQuote ? codeHintId : null,
							controls: suggestionsOpen ? suggestionListId : null,
							activeDescendant: suggestionsOpen && activeIndex >= 0 ? `${suggestionListId}-${activeIndex}` : null,
						}}
						options={{ rules, onEdit: cell.edited, onSelection: cell.moved, onKeyDown: onPromptKeyDown, onWindowOpen: cell.windowOpened, onSettled: cell.settled, handlePaste, isAttachmentDrag: transfer => dragCarries(transfer) !== null }}
					/>
					{quoteLayout.runs.length > 0 && <QuoteRemoveButtons surfaceRef={surfaceRef} text={text} runs={quoteLayout.runs} disabled={captureLocked} onRemove={removeQuoteAt} />}
					{suggestionsOpen && (
						<ul id={suggestionListId} role="listbox" aria-label={argument !== null ? "Command arguments" : slash !== null ? (slash.skillsOnly ? "Skills" : "Slash commands") : "Workspace files"} className="omp-suggest-list">
							{argumentHint && <li role="presentation" className="omp-suggest-option omp-native-muted omp-slash-hint">{argumentHint}{argument?.hint.requirement === "optional" ? " · optional" : argument?.hint.requirement === "required" ? " · required" : ""}</li>}
							{visible.map((option, index) => (
								<li
									key={`${option.kind}:${option.name}`}
									id={`${suggestionListId}-${index}`}
									role="option"
									aria-selected={index === activeIndex}
									className={`omp-suggest-option${index === activeIndex ? " omp-suggest-option--active" : ""}`}
									onMouseEnter={() => selectSuggestion(index, true)}
									// Accepting must not blur the field first: the click would
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
					<span className="omp-sr-only" role="status">{suggestionStatus}</span>
				</div>
			</div>
			{(blocks.length > 0 || quoteLayout.runs.length > 0) && (
				// The row stays while the draft holds a block or a quote and only its words come and go with the caret, so a click into one never moves the text under the pointer.
				<div className="omp-composer-hint omp-composer-hint--code" id={codeHintId} role="status" title={caretBlock !== null ? CODE_HINT : caretInQuote ? QUOTE_HINTS[sendWith] : undefined}>
					{caretBlock !== null ? CODE_HINT : caretInQuote ? QUOTE_HINTS[sendWith] : ""}
				</div>
			)}
			<ExtensionWidgets snapshot={snapshot} placement="belowEditor" />
			</>}
			<ChatFooter client={client} snapshot={snapshot}
				commandsAction={<><KeyboardShortcutsButton /><CommandsMenu commands={snapshot.commands} context={commandContext} disabled={captureLocked} onPick={runCommand} /></>}
				trailingActions={dialog === null ? promptActions : undefined} />
		</div>
	);
}
