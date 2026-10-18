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
import { composeFileBlocks, fileMarker } from "../../shared/file-blocks";
import {
	MAX_DRAFT_BYTES,
	attachGuardRefusal,
	dragCarries,
	droppedFileUris,
	fileFromAttached,
	filesFrom,
	rawTotal,
	readImageAttachment,
	sizeRejection,
	type PendingImage,
} from "../lib/attachments";
import { classifyFile, draftRoomRefusal, readDocumentFile } from "../lib/attached-documents";
import { activeDocuments, documentChars, documentExtension, documentIcon, documentTooltip, draftFromSentText, isKnownDocument, pruneInactiveDocuments, type DraftDocument } from "../lib/draft-documents";
import { readLinkedFiles } from "../lib/read-linked";
import { AskDialog, AskOptionRow } from "./AskDialog";
import { DraftEditor } from "./DraftEditor";
import type { ChatUiRequest, ChatUiResponse } from "../../chat/model";
import type { ChatClient, ChatSnapshot } from "../lib/chat-client";
import { blockContaining, findFencedBlocks, indentEdit, newlineEdit, outdentEdit, type TextEdit } from "../lib/code-fence";
import { findQuoteRuns, isQuoteLineAt } from "../lib/quote-lines";
import { quoteKeyEdit } from "../lib/quote-edits";
import { removalRange } from "../lib/quote-draft";
import { provideQuoteSink } from "../lib/quote-sink";
import { quoteSelectionIntoDraft } from "../lib/quote-selection";
import { useQuoteDraft } from "../lib/use-quote-draft";
import { QuoteRemoveButtons } from "./QuoteRemoveButtons";
import type { DraftSurface, HistoryMode } from "../lib/draft-surface";
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
import { followedByBlank, spaceInsertion, subscribeInsertedText } from "../lib/insert-text";
import { mergeRestoredQueued, offerQueuedForEditing, subscribeQueuedForEditing } from "../lib/queue-restore";
import { queueNotice, queueRows, restoredEntries } from "../lib/queue-view";
import { historyStep, sessionPrompts, type HistoryCursor } from "../../chat/prompt-history";
import { MAX_DROP_URIS, mentionQueryAt, spliceMention, type GuestAttachedDocument } from "../../protocol/messages";
import {
	activeImages,
	compactForSend,
	findReferences,
	imageReferenceLabel,
	pruneInactive,
	referencedNumbers,
	type ReferenceKind,
} from "../lib/image-references";
import { commandResolver } from "../lib/command-chips";
import { useDismissibleLayer } from "../lib/dismissible-layer";
import { ExtensionNoticeLine, ExtensionWidgets } from "./ExtensionSurfaces";
import { argumentSuggestions, isRewindCommand, missingRequiredArgument, slashArgumentAt, slashQueryAt, slashSuggestions, spliceArgument, spliceSlash } from "../lib/slash-completion";
import { ChatFooter } from "./ChatFooter";
import { CommandsMenu } from "./CommandsMenu";
import { insertCommandIntoDraft, pickPlan, type CommandContext, type CommandRow } from "../lib/command-list";
import { rewindBlockedReason } from "../../chat/rewind-mode";

/** Textarea line height, kept in sync with `.omp-textarea`; vertical padding and border are read from the element. */
const LINE_PX = 20;
const MAX_ROWS = 8;
/** The words under the field while the caret is in a fenced code block (docs/designs/2026-10-15-composer-code-blocks.md). */
const CODE_HINT = "Code block · Ctrl+Enter: send · Enter: new line · Tab: indent · Shift+Tab: outdent, or leave when there is nothing to outdent";
/** The words under the field while the caret is in a quote line (docs/designs/2026-10-15-quote-chat-selection.md). */
const QUOTE_HINT = "Quote · Ctrl+Enter: send · Enter: new line · Shift+Tab: leave the quote";

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

/** An image of the current draft: the attachment plus its stable reference number. */
type DraftImage = PendingImage & { number: number };

/** One thing to attach: a `File` the page was handed (its text is read here), or a document the host attached by path. */
type AttachEntry =
	| { readonly kind: "file"; readonly file: File }
	| { readonly kind: "linked"; readonly item: GuestAttachedDocument };

/** What one attach call accepted, in order, so the markers go into the draft in that order. */
type Accepted =
	| { readonly kind: "image"; readonly image: PendingImage }
	| { readonly kind: "document"; readonly name: string; readonly source: DraftDocument["source"] };

/** Why a file cannot be attached or read where the extension host's own connection is missing (the fallback route, decision 23). */
const NEEDS_HOST = "Attaching files needs the editor's connection to the extension host; reload the window.";

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
 * Replaces `[from, to)` through the surface, so the draft's own Undo covers the change (and, because the draft's
 * attachments follow its markers, covers them too). The field takes the focus first, as a click on Attach or a
 * thumbnail's × always returned it to the draft.
 */
function replaceInSurface(surface: DraftSurface, from: number, to: number, replacement: string): void {
	surface.focus();
	surface.replaceRange(from, to, replacement);
}

/**
 * Whether Enter should commit. `false` while an IME composition is active, so
 * the keystroke confirms the composition instead. `nativeEvent.isComposing`
 * covers most browsers; the tracked flag bridges WebKit, which fires the
 * confirming Enter keydown after `compositionend`.
 */
function shouldSubmitOnEnter(event: Pick<globalThis.KeyboardEvent, "key" | "shiftKey" | "isComposing">, composing: boolean): boolean {
	if (event.key !== "Enter" || event.shiftKey) return false;
	return !(event.isComposing || composing);
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
					if (shouldSubmitOnEnter(event.nativeEvent, composingRef.current)) {
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
	/** Linked files of a draft that moved here: their text is not on the page, so the file must be attached again. */
	lostFiles?: number;
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
	const [text, setText] = useState("");
	/** Every image attached to this draft, including ones whose marker was deleted and could still come back through Undo. */
	const [images, setImages] = useState<readonly DraftImage[]>([]);
	/** Every document attached to this draft, including ones whose marker was deleted and could still come back through Undo. */
	const [documents, setDocuments] = useState<readonly DraftDocument[]>([]);
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
	const surfaceRef = useRef<DraftSurface | null>(null);
	const getField = useCallback((): HTMLElement | null => surfaceRef.current?.element ?? null, []);
	/** The surface's composition window, read live: false while no field is mounted. */
	const composingRef = useMemo(() => ({ get current(): boolean { return surfaceRef.current?.composing ?? false; } }), []);
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
	const documentsRef = useRef<readonly DraftDocument[]>([]);
	/** Next document number; its own counter, never reused within a draft, reset once a message is sent. */
	const nextDocumentNumberRef = useRef(1);
	/** Characters held by in-flight document reads, so overlapping attaches budget against one running total. */
	const reservedCharsRef = useRef(0);
	/** Marker insertions waiting for an IME composition to finish. */
	const deferredRef = useRef<(() => void)[]>([]);
	const wrapperRef = useRef<HTMLDivElement | null>(null);
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
	/** The one drop whose files the host is reading, and the timer that gives up on it. */
	const pendingUrisRef = useRef<{ readonly requestId: number; readonly timer: number | null } | null>(null);
	const uriRequestSeqRef = useRef(0);
	/** Caret offset mirror; {@link mentionQueryAt} needs it synchronously. */
	const caretRef = useRef(0);
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
	// A session that is re-attached while the user types disables the field; it takes the focus back when it is writable again.
	useHeldFocus(getField, canPrompt, canPrompt ? "" : `phase=${snapshot.phase}${snapshot.readOnlyReason === null ? "" : " read-only"}`);
	const resumable = snapshot.phase === "view-only" || snapshot.phase === "stopped";
	// The click is acknowledged in this page before the host answers (`ChatClient.getOperationState`): Resume says `Starting…` and Stop says `Stopping…`.
	const { operation, notice: operationNotice } = useSyncExternalStore(client.subscribeOperations, client.getOperationState);
	const starting = startsSession(operation);
	const stopping = operation?.kind === "stop";
	const busy = snapshot.working;
	const request = snapshot.uiRequest;
	useEffect(() => { setSubmitted(false); }, [snapshot.working, snapshot.phase, snapshot.commandFeedback, snapshot.lastPromptResult, progressAvailable]);
	// `reading` is the rendered mirror of `readingRef`: it drives what this frame
	// shows, while `send` enforces the synchronous ref.
	/** Images whose marker is in the text — what the strip shows and a send carries. */
	const attached = useMemo(() => activeImages(text, images), [text, images]);
	/** Documents whose marker is in the text, in number order: the ones a send would carry. */
	const attachedDocuments = useMemo(() => activeDocuments(text, documents), [text, documents]);
	/** Fenced code blocks of the draft, and the one the caret is in: its keys are an editor's, and no completion opens in it. */
	const blocks = useMemo(() => findFencedBlocks(text), [text]);
	const caretBlock = useMemo(() => blockContaining(blocks, caret), [blocks, caret]);
	/** Quote lines of the draft (bands outside the fenced blocks); a quote line holds text the agent wrote, so no completion opens in it. */
	const quoteLayout = useMemo(() => findQuoteRuns(text, blocks), [text, blocks]);
	const caretInQuote = isQuoteLineAt(quoteLayout, text, caret);
	const codeHintId = useId();
	const canSubmit = canPrompt && !captureLocked && request === null && !sending && reading === 0 && (text.trim().length > 0 || attached.length > 0 || attachedDocuments.length > 0);

	// A command or a skill is a chip while the session's catalogue lists it and the next send would reach OMP as a `prompt` (while a
	// turn runs the composer steers or follows up, which OMP does not scan), so those two are what the surface draws from besides the attachments.
	const resolver = useMemo(() => commandResolver(snapshot.commands, busy), [snapshot.commands, busy]);
	const resolverRef = useRef(resolver);
	const resolveCommand = useCallback((name: string) => resolverRef.current(name), []);
	// A marker is a chip while its attachment is attached and plain text otherwise, so the surface draws again when the set of attachments or the catalogue changes.
	useLayoutEffect(() => {
		resolverRef.current = resolver;
		surfaceRef.current?.refresh();
	}, [images, documents, resolver]);
	const fieldMounted = !(request !== null && canPrompt);
	// A field that mounts while a hand-off holds the draft (a dialog closing meanwhile) starts frozen.
	useLayoutEffect(() => {
		if (fieldMounted && captureRef.current !== null) surfaceRef.current?.freeze();
	}, [fieldMounted]);

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

	/**
	 * Every write from outside the surface (docs/designs/2026-10-15-composer-contenteditable-surface.md, section 2): the refs
	 * and the surface change now and the state follows with the next render. Each caller says what happens to the undo
	 * stack: `"reset"` for a draft that starts over (send, Rewind, hand-off), `"record"` for one more step the user can
	 * undo. A `caret` also takes the focus, as every placement did when the field was a textarea.
	 */
	const writeDraft = useCallback((value: string, options: { caret?: number; history: HistoryMode }): void => {
		const changed = value !== textRef.current;
		draftRevisionRef.current++;
		textRef.current = value;
		surfaceRef.current?.setText(value, options);
		const at = options.caret ?? (changed ? value.length : undefined);
		if (at !== undefined) {
			caretRef.current = at;
			setCaret(at);
		}
		if (options.caret !== undefined) surfaceRef.current?.focus();
		setText(value);
	}, []);

	const syncCaret = useCallback((): void => {
		const surface = surfaceRef.current;
		if (surface === null) return;
		const position = surface.selectionStart;
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
			// The answer has been consumed; anything still in flight is stale.
			pendingQueryRef.current = null;
			requestSeqRef.current++;
			setSuggestions(NO_SUGGESTIONS);
			writeDraft(spliced.text, { caret: spliced.caret, history: "record" });
		},
		[completionsEnabled, composingRef, snapshot.commands, writeDraft],
	);

	const publishImages = useCallback((next: readonly DraftImage[]): void => {
		if (captureRef.current !== null) return;
		draftRevisionRef.current++;
		imagesRef.current = next;
		setImages(next);
	}, []);

	const publishDocuments = useCallback((next: readonly DraftDocument[]): void => {
		if (captureRef.current !== null) return;
		draftRevisionRef.current++;
		documentsRef.current = next;
		setDocuments(next);
	}, []);

	/** Whether a marker belongs to an attachment of this draft — read synchronously, so edits are judged against the draft as it is now. */
	const isKnownReference = useCallback((kind: ReferenceKind, number: number, name: string): boolean =>
		kind === "image" ? imagesRef.current.some(image => image.number === number) : isKnownDocument(documentsRef.current, number, name), []);

	/**
	 * Insert `markers` at the caret (or over the selection), one space apart and
	 * with a space on each side unless whitespace is already there, so typing can continue
	 * straight after the last marker. An undoable edit of the draft, so Undo removes the markers and,
	 * with them, the attachments. An IME composition is never interrupted: the insertion waits for it to end.
	 */
	const insertMarkers = useCallback((markers: readonly string[]): void => {
		const place = (): void => {
			if (captureRef.current !== null) return;
			const surface = surfaceRef.current;
			const current = textRef.current;
			const start = surface?.selectionStart ?? current.length;
			const end = surface?.selectionEnd ?? current.length;
			const lead = start > 0 && !/\s/.test(current[start - 1]!) ? " " : "";
			const trail = end < current.length && /\s/.test(current[end]!) ? "" : " ";
			const inserted = `${lead}${markers.join(" ")}${trail}`;
			if (surface === null) writeDraft(current + inserted, { history: "record" });
			else replaceInSurface(surface, start, end, inserted);
		};
		if (composingRef.current) deferredRef.current.push(place);
		else place();
	}, [composingRef, writeDraft]);

	/**
	 * Validate, read, and add `entries`; `earlier` are refusals that came before them (the host's, for a drop or a pick). Every
	 * rejection is reported, never dropped. A `File` is classified by its first bytes before its size is judged; an image is
	 * budgeted and read as an image, a text becomes a held document, and a document the host linked is added by reference.
	 */
	const attach = useCallback(
		async (entries: readonly AttachEntry[], earlier: readonly string[] = []): Promise<void> => {
			if (captureRef.current !== null || !canPrompt || (entries.length === 0 && earlier.length === 0)) return;
			const overGuard = attachGuardRefusal(activeImages(textRef.current, imagesRef.current).length + activeDocuments(textRef.current, documentsRef.current).length, entries.length);
			if (overGuard !== null) {
				setAttachError(overGuard);
				return;
			}
			readingRef.current += entries.length;
			setReading(readingRef.current);
			setSendNotice(null);
			const accepted: Accepted[] = [];
			const rejected: string[] = [...earlier];
			// This call's share of the reservations, so the release in `finally` stays balanced even if a read throws instead of
			// reporting failure. A leaked reservation would shrink the draft budget with nothing to show for it.
			let heldBytes = 0;
			let heldChars = 0;
			/** The characters the draft would hold: its text, every document of it and the reads still in flight. */
			const knownChars = (): number => activeDocuments(textRef.current, documentsRef.current).reduce((sum, document) => sum + documentChars(document), textRef.current.length + reservedCharsRef.current);
			const addDocument = (name: string, chars: number, source: DraftDocument["source"]): void => {
				const room = draftRoomRefusal(name, chars, knownChars());
				if (room !== null) {
					rejected.push(room);
					return;
				}
				reservedCharsRef.current += chars;
				heldChars += chars;
				accepted.push({ kind: "document", name, source });
			};
			try {
				for (const entry of entries) {
					if (entry.kind === "linked") {
						const { item } = entry;
						const linkedTwice = (candidate: DraftDocument["source"]): boolean => candidate.kind === "linked" && candidate.ref === item.ref;
						if (activeDocuments(textRef.current, documentsRef.current).some(document => linkedTwice(document.source)) || accepted.some(done => done.kind === "document" && linkedTwice(done.source))) {
							rejected.push(`${item.name} is already attached.`);
							continue;
						}
						addDocument(item.name, item.chars, { kind: "linked", ref: item.ref, bytes: item.bytes, chars: item.chars });
						continue;
					}
					const { file } = entry;
					const sort = await classifyFile(file);
					if (sort.kind === "refused") {
						rejected.push(sort.reason);
						continue;
					}
					if (sort.kind === "image") {
						// Reserve before reading: the check and the reservation happen in one synchronous step, so a concurrent
						// selection sees these bytes. Only images still referenced by the text count: a removed one is released first.
						const oversize = sizeRejection(file, rawTotal(activeImages(textRef.current, imagesRef.current)) + reservedRef.current);
						if (oversize !== null) {
							rejected.push(oversize);
							continue;
						}
						reservedRef.current += file.size;
						heldBytes += file.size;
						const read = await readImageAttachment(file, ++imageSeqRef.current).catch(() => null);
						if (read !== null && read.ok) {
							accepted.push({ kind: "image", image: read.image });
						} else {
							// A failed read releases exactly what it reserved.
							reservedRef.current -= file.size;
							heldBytes -= file.size;
							rejected.push(read === null ? `${file.name}: could not be read.` : read.reason);
						}
						continue;
					}
					const text = await readDocumentFile(file).catch(() => null);
					if (text === null || !text.ok) {
						rejected.push(text === null ? `${file.name}: could not be read.` : text.reason);
						continue;
					}
					addDocument(file.name, text.content.length, { kind: "held", content: text.content, label: null, bytes: text.bytes });
				}
			} finally {
				// What `accepted` reserved stops being reserved here and is published below with no await in between, so the
				// invariant "published + reserved fits" never has a gap.
				readingRef.current = Math.max(0, readingRef.current - entries.length);
				reservedRef.current = Math.max(0, reservedRef.current - heldBytes);
				reservedCharsRef.current = Math.max(0, reservedCharsRef.current - heldChars);
			}
			if (!mountedRef.current) return;
			setReading(readingRef.current);
			const addedImages: DraftImage[] = [];
			const addedDocuments: DraftDocument[] = [];
			const markers: string[] = [];
			for (const done of accepted) {
				if (done.kind === "image") {
					const image: DraftImage = { ...done.image, number: nextNumberRef.current++ };
					addedImages.push(image);
					markers.push(imageReferenceLabel(image.number, image.width !== undefined && image.height !== undefined ? { width: image.width, height: image.height } : undefined));
				} else {
					const document: DraftDocument = { number: nextDocumentNumberRef.current++, name: done.name, source: done.source };
					addedDocuments.push(document);
					markers.push(fileMarker(document.number, document.name));
				}
			}
			if (addedImages.length > 0) {
				const merged = [...imagesRef.current, ...addedImages];
				const present = referencedNumbers(textRef.current, "image", (kind, number) => kind === "image" && merged.some(image => image.number === number));
				// Deleted images stay only for Undo and never push the draft past the prompt budget.
				publishImages(pruneInactive(merged, number => present.has(number), new Set(addedImages.map(image => image.number)), MAX_DRAFT_BYTES));
			}
			if (addedDocuments.length > 0) {
				const merged = [...documentsRef.current, ...addedDocuments];
				const present = referencedNumbers(textRef.current, "file", (kind, number, name) => kind === "file" && isKnownDocument(merged, number, name));
				// Deleted documents stay only for Undo, and what they hold is bounded like an image's bytes.
				publishDocuments(pruneInactiveDocuments(merged, number => present.has(number), new Set(addedDocuments.map(document => document.number))));
			}
			if (markers.length > 0) insertMarkers(markers);
			if (accepted.length > 0 || rejected.length > 0) setAttachError(rejectionSummary(rejected));
		},
		[canPrompt, insertMarkers, publishDocuments, publishImages],
	);

	/** The × on a thumbnail or a tile deletes that attachment's marker(s) from the text, as one undo step; the attachment follows its marker. */
	const removeAttachment = useCallback(
		(kind: ReferenceKind, number: number): void => {
			const remove = (): void => {
				const surface = surfaceRef.current;
				if (captureRef.current !== null || surface === null) return;
				const spans = findReferences(textRef.current, isKnownReference).filter(span => span.kind === kind && span.number === number);
				surface.focus();
				surface.removeRanges(spans.map(span => ({ from: span.start, to: span.end })));
				setAttachError(null);
			};
			if (composingRef.current) deferredRef.current.push(remove);
			else remove();
		},
		[composingRef, isKnownReference],
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
		readingRef.current = Math.max(0, readingRef.current - 1);
		if (mountedRef.current) setReading(readingRef.current);
	}, []);

	/** Ask the host to read the files a drag from VS Code's Explorer or an editor tab named; its answer attaches them. */
	const requestUris = useCallback((uris: readonly string[]): void => {
		finishUriRequest();
		const requestId = ++uriRequestSeqRef.current;
		readingRef.current += 1;
		setReading(readingRef.current);
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
	}, [finishUriRequest]);

	/** Open the host's file dialog; what it returns attaches like a drop. A native dialog may stay open as long as the user likes, so a pick has no timeout. */
	const requestPick = useCallback((): void => {
		if (captureRef.current !== null || !canPrompt) return;
		finishUriRequest();
		const requestId = ++uriRequestSeqRef.current;
		readingRef.current += 1;
		setReading(readingRef.current);
		pendingUrisRef.current = { requestId, timer: null };
		if (guestTransport.post({ type: "omp:pick-files", requestId }) === false) {
			finishUriRequest();
			setAttachError(NEEDS_HOST);
		}
	}, [canPrompt, finishUriRequest]);

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
			event.dataTransfer !== null && canPrompt && captureRef.current === null && dragCarries(event.dataTransfer) !== null;
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
	}, [attach, canPrompt, requestUris]);

	/**
	 * The user edited the draft, or a composition settled. The surface has applied the edit, put a marker the edit cut
	 * into back whole, and kept the selection; the composer takes the new text.
	 */
	const onEdit = useCallback((value: string): void => {
		draftRevisionRef.current++;
		textRef.current = value;
		syncCaret();
		setText(value);
	}, [syncCaret]);

	/** A composition is an edit: a send awaiting confirmation must not erase what is being composed. */
	const onWindowOpen = useCallback((): void => {
		draftRevisionRef.current++;
	}, []);

	/** The composition window closed: the draft is settled, so the work that waited for it runs. */
	const onSettled = useCallback((): void => {
		syncCaret();
		surfaceRef.current?.refresh();
		for (const place of deferredRef.current.splice(0)) place();
	}, [syncCaret]);

	const send = useCallback(
		async (followUp: boolean): Promise<void> => {
			// The wire pairs the Nth marker with the Nth image, so the draft's stable numbers are
			// compacted to 1..K here and images whose marker was deleted are not sent. A document's marker is the
			// reference of its block and is left as it is.
			const compacted = compactForSend(textRef.current, imagesRef.current);
			const files = activeDocuments(textRef.current, documentsRef.current);
			const draft = compacted.text.trim();
			const attached = compacted.images;
			// A pending dialog, a locked or not-live panel, and a read that has started
			// but not published yet must never produce a message. `readingRef` (not the
			// `reading` state) is what makes this true inside the same frame that
			// started the read.
			if (captureRef.current !== null || !canPrompt || request !== null || readingRef.current > 0 || sendingRef.current) return;
			if (draft.length === 0 && attached.length === 0 && files.length === 0) return;
			// Chat's own `/rewind` and `/branch` never reach OMP; both open the in-place Rewind.
			if (onRewind !== undefined && attached.length === 0 && files.length === 0 && isRewindCommand(draft)) {
				writeDraft("", { history: "reset" });
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
			const revision = draftRevisionRef.current;
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
			if (captureRef.current !== null || !chatWritable(current) || current.uiRequest !== null || !mountedRef.current) {
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
			pendingOriginalRef.current = { text, images: wire };
			onSubmitted?.();
			const result = await (!running
				? client.sendPrompt(text, payload)
				: followUp
					? client.sendFollowUp(text, payload)
					: client.sendSteer(text, payload));
			for (let held = readCapture(); held !== null; held = readCapture()) await held.released;
			pendingOriginalRef.current = null;
			sendingRef.current = false;
			if (!mountedRef.current) return;
			setSending(false);
			if (!result.ok) {
				if (result.unconfirmed || draftRevisionRef.current !== revision) {
					const entry: RecoverableMessage = { id: ++recoverySeqRef.current, text, images: wire, reason: result.reason, unconfirmed: result.unconfirmed === true };
					publishRecoverable([...recoverableRef.current, entry]);
					setSendError(null);
				} else {
					setSendError(result.reason);
				}
				return;
			}
			setSendError(null);
			const unsaved = linked.filter(file => texts.get(file.number)?.dirty === true).map(file => `${file.name} has unsaved changes in the editor; the saved version was sent.`);
			setSendNotice(unsaved.length > 0 ? unsaved.join(" ") : null);
			if (!running && result.explained !== true && nativeSettingsCommand(draft) === null) setSubmitted(true);
			// Admission may finish after typing, attaching, or restoring another draft. Never erase that work.
			if (draftRevisionRef.current !== revision) return;
			historyRef.current = null;
			nextNumberRef.current = 1;
			nextDocumentNumberRef.current = 1;
			publishImages([]);
			publishDocuments([]);
			setAttachError(null);
			writeDraft("", { history: "reset" });
		},
		[canPrompt, client, onRewind, onSubmitted, publishDocuments, publishImages, publishRecoverable, readCapture, request, snapshot.commands, writeDraft],
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
		if (captureRef.current !== null || !canPrompt || request !== null) return;
		if (plan.kind === "insert") {
			const spliced = insertCommandIntoDraft(textRef.current, plan.name);
			historyRef.current = null;
			pendingQueryRef.current = null;
			requestSeqRef.current++;
			setSuggestions(NO_SUGGESTIONS);
			setDismissedCompletion(null);
			if (spliced.text === textRef.current) {
				const surface = surfaceRef.current;
				surface?.focus();
				surface?.setSelectionRange(spliced.caret, spliced.caret);
				caretRef.current = spliced.caret;
				setCaret(spliced.caret);
				return;
			}
			writeDraft(spliced.text, { caret: spliced.caret, history: "record" });
			return;
		}
		if (sendingRef.current) return;
		surfaceRef.current?.focus();
		setSendError(null);
		void (async () => {
			onSubmitted?.();
			const running = client.getSnapshot().working;
			const result = await (running ? client.sendSteer(plan.text) : client.sendPrompt(plan.text));
			if (!mountedRef.current) return;
			if (!result.ok) { setSendError(result.reason); return; }
			if (!running && result.explained !== true && nativeSettingsCommand(plan.text) === null) setSubmitted(true);
		})();
	}, [canPrompt, client, onRewind, onSubmitted, request, writeDraft]);

	// A complete capture stays immutable through the host's confirmation and replacement.
	useEffect(() => provideDraftHandoff({
		read(requestId) {
			if (readingRef.current > 0 || composingRef.current || deferredRef.current.length > 0 || client.draftHandoffPending) return null;
			if (captureRef.current !== null) return null;
			const recoverable = recoverableRef.current.map(entry => ({ text: entry.text, attachments: entry.images.length + (entry.lostAttachments ?? 0), unconfirmed: entry.unconfirmed }));
			const pending = pendingOriginalRef.current;
			if (pending !== null) recoverable.push({ text: pending.text, attachments: pending.images.length, unconfirmed: true });
			const documents = activeDocuments(textRef.current, documentsRef.current).map(document => document.source.kind === "held"
				? { number: document.number, name: document.name, ref: null, label: document.source.label, content: document.source.content, bytes: document.source.bytes, chars: document.source.content.length }
				: { number: document.number, name: document.name, ref: document.source.ref, label: null, content: null, bytes: document.source.bytes, chars: document.source.chars });
			const content: DraftCapture = { text: textRef.current, attachments: activeImages(textRef.current, imagesRef.current).length + lostAttachmentsRef.current, recoverable, documents };
			const { promise, resolve } = Promise.withResolvers<void>();
			captureRef.current = { requestId, released: promise, release: resolve };
			surfaceRef.current?.freeze();
			client.setDraftHandoffLocked(true);
			setCaptureLocked(true);
			return content;
		},
		release(requestId) {
			const held = captureRef.current;
			if (held === null || held.requestId !== requestId) return;
			surfaceRef.current?.thaw();
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
			writeDraft(restored.text, { caret: restored.text.length, history: "reset" });
			lostAttachmentsRef.current = restored.attachments;
			setLostAttachments(restored.attachments);
			// Markers of the restored texts keep their numbers, so new attachments must not reuse one.
			const bump = (text: string): void => {
				for (const span of findReferences(text, () => true)) {
					if (span.kind === "image") nextNumberRef.current = Math.max(nextNumberRef.current, span.number + 1);
					else nextDocumentNumberRef.current = Math.max(nextDocumentNumberRef.current, span.number + 1);
				}
			};
			bump(restored.text);
			for (const original of restored.recoverable) bump(original.text);
			for (const document of restored.documents) nextDocumentNumberRef.current = Math.max(nextDocumentNumberRef.current, document.number + 1);
			publishDocuments(restored.documents.map((document): DraftDocument => ({
				number: document.number,
				name: document.name,
				source: document.ref !== null ? { kind: "linked", ref: document.ref, bytes: document.bytes, chars: document.chars } : { kind: "held", content: document.content ?? "", label: document.label, bytes: document.bytes },
			})));
			publishRecoverable(restored.recoverable.map(entry => ({
				id: ++recoverySeqRef.current, text: entry.text, images: [], unconfirmed: entry.unconfirmed, lostAttachments: entry.attachments,
				reason: entry.unconfirmed ? "OMP did not confirm this message before this editor was replaced. It may already have been accepted. Review the conversation before sending it again." : "This original message was not sent. Add it to the draft only when you want to send it.",
			})));
		};
		const pending = takeRestoredDraft();
		if (pending !== null) apply(pending);
		return subscribeRestoredDraft(apply);
	}, [publishDocuments, publishRecoverable, writeDraft]);

	// "OMP Desk: Add Selection/File to Session": the `@path` references the extension host composed in
	// an editor are inserted at the caret (over a selection) as one undo step, and at the end of the
	// draft while no field is mounted. They are never submitted, and an IME composition is not
	// interrupted. One that arrived before this composer mounted is delivered first (`lib/insert-text`).
	useEffect(() => subscribeInsertedText(reference => {
		const place = (): void => {
			if (captureRef.current !== null) { deferredRef.current.push(place); return; }
			const surface = surfaceRef.current;
			const current = textRef.current;
			const start = surface?.selectionStart ?? current.length;
			const end = surface?.selectionEnd ?? current.length;
			const inserted = spaceInsertion(current, start, end, reference);
			if (surface === null) {
				writeDraft(current + inserted, { history: "record" });
				return;
			}
			replaceInSurface(surface, start, end, inserted);
			// A space already follows: the caret steps over it, so it never rests right after a bare `@path`.
			if (followedByBlank(current, end)) {
				const caret = start + inserted.length + 1;
				surface.setSelectionRange(caret, caret);
			}
		};
		if (composingRef.current) deferredRef.current.push(place);
		else place();
	}), [composingRef, writeDraft]);

	// `set_editor_text` from the session (an extension prefilling the prompt): the request
	// replaces the draft, once per `seq`. The seq present at mount was already applied by an
	// earlier mount of this composer and is not replayed.
	const editorSeqRef = useRef(snapshot.pendingEditorText?.seq ?? null);
	const editorText = snapshot.pendingEditorText;
	useEffect(() => {
		if (editorText === null || editorText.seq === editorSeqRef.current) return;
		if (captureRef.current !== null) return;
		editorSeqRef.current = editorText.seq;
		writeDraft(editorText.text, { history: "record" });
		surfaceRef.current?.focus();
	}, [editorText, captureLocked, writeDraft]);

	// "Edit" / "Edit all" on queued messages (the queue row above the composer): what OMP handed back is
	// appended to the draft after whatever is already typed, with its images re-attached under fresh
	// reference numbers (`lib/queue-restore`). Nothing is sent, and nothing the draft held is replaced.
	useEffect(() => subscribeQueuedForEditing(entries => {
		const place = (): void => {
			if (captureRef.current !== null) { deferredRef.current.push(place); return; }
			const held = imagesRef.current.length;
			const heldDocuments = documentsRef.current.length;
			const merged = mergeRestoredQueued({ text: textRef.current, images: imagesRef.current, documents: documentsRef.current, nextNumber: nextNumberRef.current, nextDocumentNumber: nextDocumentNumberRef.current, nextId: imageSeqRef.current + 1 }, entries);
			nextNumberRef.current = merged.nextNumber;
			nextDocumentNumberRef.current = merged.nextDocumentNumber;
			imageSeqRef.current = merged.nextId - 1;
			const present = referencedNumbers(merged.text, "image", (kind, number) => kind === "image" && merged.images.some(image => image.number === number));
			publishImages(pruneInactive(merged.images, number => present.has(number), new Set(merged.images.slice(held).map(image => image.number)), MAX_DRAFT_BYTES));
			const presentFiles = referencedNumbers(merged.text, "file", (kind, number, name) => kind === "file" && isKnownDocument(merged.documents, number, name));
			publishDocuments(pruneInactiveDocuments(merged.documents, number => presentFiles.has(number), new Set(merged.documents.slice(heldDocuments).map(document => document.number))));
			writeDraft(merged.text, { caret: merged.text.length, history: "record" });
			const sentences = [...(merged.imagesLost > 0 ? [`${merged.imagesLost} image${merged.imagesLost === 1 ? "" : "s"} of the edited message could not be attached (unsupported format).`] : []), ...merged.notes];
			setAttachError(sentences.length > 0 ? sentences.join(" ") : null);
		};
		// Like inserted text: an IME composition in flight finishes first, so the restore never splits it.
		if (composingRef.current) deferredRef.current.push(place);
		else place();
	}), [composingRef, publishDocuments, publishImages, writeDraft]);

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
				nextNumberRef.current = 1;
				nextDocumentNumberRef.current = 1;
				publishImages([]);
				publishDocuments([]);
				setAttachError(null);
				writeDraft("", { history: "reset" });
				return;
			}
			const draft = answer.draft;
			if (answer.kind !== "rewind" || draft === undefined) return;
			const held = compactForSend(textRef.current, imagesRef.current);
			const heldFiles = activeDocuments(textRef.current, documentsRef.current);
			const heldText = composeFileBlocks(held.text.trim(), heldFiles.flatMap(file => (file.source.kind === "held" ? [{ number: file.number, name: file.name, label: file.source.label, content: file.source.content }] : [])));
			if (heldText.length > 0 || held.images.length > 0) {
				const images: ImageContent[] = held.images.map(image => ({ type: "image", mimeType: image.mimeType, data: image.data }));
				const linkedFiles = heldFiles.filter(file => file.source.kind === "linked").length;
				publishRecoverable([...recoverableRef.current, { id: ++recoverySeqRef.current, text: heldText, images, reason: "Your draft from before the rewind. Add it to the draft only when you want it back.", unconfirmed: false, ...(linkedFiles > 0 ? { lostFiles: linkedFiles } : {}) }]);
			}
			const merged = mergeRestoredQueued({ text: "", images: [], documents: [], nextNumber: 1, nextDocumentNumber: 1, nextId: imageSeqRef.current + 1 }, [{ text: draft.text, images: draft.images }]);
			nextNumberRef.current = merged.nextNumber;
			nextDocumentNumberRef.current = merged.nextDocumentNumber;
			imageSeqRef.current = merged.nextId - 1;
			publishImages(pruneInactive(merged.images, () => true, new Set(merged.images.map(image => image.number)), MAX_DRAFT_BYTES));
			publishDocuments(merged.documents);
			historyRef.current = null;
			writeDraft(merged.text, { caret: merged.text.length, history: "reset" });
			const lost = merged.imagesLost + draft.unavailableImages;
			setAttachError(lost > 0 ? `${lost} image${lost === 1 ? "" : "s"} of the rewound message could not be restored.` : null);
			setSendError(null);
			rewoundRef.current = draftRevisionRef.current;
		};
		if (composingRef.current) deferredRef.current.push(place);
		else place();
	}), [client, composingRef, publishDocuments, publishImages, publishRecoverable, writeDraft]);
	const doubleEscapeRef = useRef(createDoubleEscape());
	// `Esc` `Esc` with the focus on the page around the composer (the transcript, a tool row, a link, the body) opens Rewind
	// under the same conditions. The composer's own field counts through `onPromptKeyDown`, any other editable field not
	// at all; an Escape a popup, menu or dialog took was prevented in the capture phase and never reaches this listener.
	useEffect(() => {
		if (onRewind === undefined) return;
		const onKeyDown = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || composingRef.current) return;
			const target = event.target instanceof Element ? event.target : document.activeElement;
			if (target !== null && isEditableTarget(target)) return;
			const idle = !client.getSnapshot().working && textRef.current.length === 0 && imagesRef.current.length === 0 && documentsRef.current.length === 0;
			if (!doubleEscapeRef.current.press(event.timeStamp, idle)) return;
			event.preventDefault();
			onRewind();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [client, composingRef, onRewind]);

	// VS Code commands and keybindings reach the composer through this registry
	// (`src/webview/lib/panel-actions.ts`): `ompDesk.sendPrompt`, `ompDesk.stopTurn` and
	// `ompDesk.focusComposer` run these same handlers, so a keybinding can never send
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
	const { notice: quoteNotice, quote } = useQuoteDraft({
		surface: () => surfaceRef.current,
		captured: () => captureRef.current !== null,
		composing: () => composingRef.current,
		defer: work => { deferredRef.current.push(work); },
		writable: () => canPrompt,
	});
	useEffect(() => provideQuoteSink(quote), [quote]);

	/** Remove quote: the run that starts at `start` and its line break, one undo step; an open composition finishes first. */
	const removeQuote = useCallback((start: number): void => {
		const remove = (): void => {
			const surface = surfaceRef.current;
			if (surface === null || captureRef.current !== null) return;
			const current = surface.text;
			const run = findQuoteRuns(current, findFencedBlocks(current)).runs.find(candidate => candidate.start === start);
			if (run === undefined) return;
			const range = removalRange(current, run);
			surface.apply({ from: range.from, to: range.to, insert: "", selection: { anchor: range.from, focus: range.from } }, "replace");
			// The button that was pressed is gone (and a press on it never moved the focus into the field), so without this the
			// focus would sit on the page body and Ctrl+Z would reach nobody: the field takes the focus, the caret where the quote was.
			surface.focus();
		};
		if (composingRef.current) deferredRef.current.push(remove);
		else remove();
	}, [composingRef]);

	// A prompt picked in the host's history search (`Ctrl+R`) joins the draft like an edited queued message.
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
			const text = surface.text;
			const start = surface.selectionStart;
			const end = surface.selectionEnd;
			/** A block edit is one undo step, with the selection where the edit says. */
			const applyBlockEdit = (edit: TextEdit): void => {
				surface.apply({ from: edit.from, to: edit.to, insert: edit.insert, selection: { anchor: edit.selectionStart, focus: edit.selectionEnd } }, "block");
			};
			// Inside a fenced code block Enter and Tab are an editor's (docs/designs/2026-10-15-composer-code-blocks.md); the chord that
			// sends there is Ctrl+Enter, which falls through to the rules below. An IME composition and a held draft are left alone.
			const block = composing || event.keyCode === 229 || captureRef.current !== null
				? null
				: blockContaining(findFencedBlocks(text), start, end);
			if (block !== null) {
				if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
					const edit = event.shiftKey ? outdentEdit(text, block, start, end) : indentEdit(text, block, start, end);
					// Shift+Tab with nothing left to outdent is the way out of the block, backwards, and is the only Tab that moves the focus.
					if (edit === null && event.shiftKey) return;
					event.preventDefault();
					if (edit !== null) applyBlockEdit(edit);
					return;
				}
				if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
					event.preventDefault();
					applyBlockEdit(newlineEdit(text, block, start, end));
					return;
				}
			}
			// A quote line follows the code block's keys (docs/designs/2026-10-15-quote-chat-selection.md, Section 4): Enter is a new line that carries the prefix (an empty quote line lets go of it), Shift+Tab leaves the quote, Backspace and Delete take the prefix with them. Ctrl+Enter sends from here through the rules below.
			if (block === null && !composing && event.keyCode !== 229 && captureRef.current === null) {
				const blocksNow = findFencedBlocks(text);
				const quoteEdit = quoteKeyEdit(text, findQuoteRuns(text, blocksNow), event, start, end);
				if (quoteEdit !== null) {
					event.preventDefault();
					applyBlockEdit(quoteEdit);
					return;
				}
			}
			// `Esc` `Esc` in an empty composer while nothing runs opens Rewind, as in the TUI. While a turn runs, Escape
			// belongs to Stop (`ompDesk.stopTurn`), and an open popup takes it first.
			if (event.key === "Escape" && onRewind !== undefined && !composing && !suggestionsOpen) {
				const idle = !client.getSnapshot().working && text.length === 0 && imagesRef.current.length === 0 && documentsRef.current.length === 0;
				if (doubleEscapeRef.current.press(event.timeStamp, idle)) {
					event.preventDefault();
					onRewind();
					return;
				}
			}
			if (suggestionsOpen && !composing && block === null) {
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
				if (edge && imagesRef.current.length === 0) {
					// A prompt that carried files is walked by its prose; the history cursor owns the documents it placed and swaps them on
					// each step, so ↑ then ↓ returns the draft.
					const prompts = sessionPrompts(client.getSnapshot().entries);
					const step = historyStep(prompts.map(prompt => draftFromSentText(prompt).text), historyRef.current, event.key === "ArrowUp" ? "older" : "newer", text);
					if (step !== null) {
						event.preventDefault();
						historyRef.current = step.cursor;
						const recalled = step.cursor === null ? null : draftFromSentText(prompts[prompts.length - step.cursor.index]!);
						const placed = recalled?.documents ?? [];
						nextDocumentNumberRef.current = placed.reduce((next, document) => Math.max(next, document.number + 1), 1);
						publishDocuments(placed);
						writeDraft(step.text, { caret: step.text.length, history: "record" });
						return;
					}
				}
			}
			if (shouldSubmitOnEnter(event, composingRef.current)) {
				event.preventDefault();
				send(event.altKey);
			}
		},
		[acceptSuggestion, activeIndex, client, composingRef, dequeueLast, onRewind, publishDocuments, send, suggestionsOpen, visible, selectSuggestion, writeDraft],
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
		<div className={dropActive ? "omp-composer omp-composer--dropping" : "omp-composer"}>
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
						if (captureRef.current !== null) return;
						const held = compactForSend(textRef.current, imagesRef.current);
						const files = activeDocuments(textRef.current, documentsRef.current);
						// The draft already is this original when it composes to the same text. A linked file's text is not here to compare, so it never matches.
						const sameText = files.every(file => file.source.kind === "held") && composeFileBlocks(held.text.trim(), files.flatMap(file => (file.source.kind === "held" ? [{ number: file.number, name: file.name, label: file.source.label, content: file.source.content }] : []))) === entry.text;
						if (!sameText || held.images.length !== entry.images.length || held.images.some((image, index) => image.mimeType !== entry.images[index]?.mimeType || image.data !== entry.images[index]?.data)) {
							offerQueuedForEditing([{ text: entry.text, images: entry.images }]);
							lostAttachmentsRef.current += entry.lostAttachments ?? 0;
							setLostAttachments(lostAttachmentsRef.current);
						}
						else if ((entry.lostAttachments ?? 0) > lostAttachmentsRef.current) {
							lostAttachmentsRef.current = entry.lostAttachments ?? 0;
							setLostAttachments(lostAttachmentsRef.current);
						}
						surfaceRef.current?.focus();
					}}>Add to draft</button>
					<button type="button" className="omp-btn" disabled={captureLocked} aria-label="Dismiss recoverable message" onClick={() => {
						if (captureRef.current === null) publishRecoverable(recoverableRef.current.filter(item => item.id !== entry.id));
					}}>Dismiss</button>
				</div>
			))}
			{(sendError ?? operationNotice) !== null && (
				<div className="omp-attach-error" role="alert">
					{sendError ?? operationNotice}
				</div>
			)}
			{sendNotice !== null && <div className="omp-composer-hint" role="status">{sendNotice}</div>}
			{(attached.length > 0 || attachedDocuments.length > 0) && (
				<ul className="omp-attachments" aria-label="attachments">
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
								onClick={() => removeAttachment("image", image.number)}
							>
								×
							</button>
						</li>
					))}
					{attachedDocuments.map(document => (
						<li key={`file-${document.number}`} className="omp-attachment" data-file-number={document.number}>
							<span className="omp-attachment-figure omp-attachment-tile" title={documentTooltip(document)}>
								<span aria-hidden="true" className={`codicon codicon-${documentIcon(document.name)}`} />
								<span className="omp-attachment-ext" aria-hidden="true">{documentExtension(document.name).slice(0, 4).toUpperCase()}</span>
								<span className="omp-attachment-number" aria-hidden="true">#{document.number}</span>
							</span>
							<span className="omp-attachment-meta">
								<span className="omp-attachment-name" title={document.name}>
									{document.name}
								</span>
								<span className="omp-attachment-size">{formatBytes(document.source.bytes)}</span>
							</span>
							<button
								type="button"
								className="omp-attachment-remove"
								disabled={!canPrompt || captureLocked}
								aria-label={`Remove File #${document.number} (${document.name})`}
								title={`Remove ${document.name}`}
								onClick={() => removeAttachment("file", document.number)}
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
						options={{ isKnownReference, resolveCommand, onEdit, onSelection: syncCaret, onKeyDown: onPromptKeyDown, onWindowOpen, onSettled, handlePaste, isAttachmentDrag: transfer => dragCarries(transfer) !== null }}
					/>
					{quoteLayout.runs.length > 0 && <QuoteRemoveButtons surfaceRef={surfaceRef} text={text} runs={quoteLayout.runs} disabled={captureLocked} onRemove={removeQuote} />}
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
			{(blocks.length > 0 || quoteLayout.runs.length > 0 || quoteNotice !== null) && (
				// The row stays while the draft holds a block or a quote and only its words come and go with the caret, so a click into one never moves the text under the pointer. A quote's notice takes the row for a few seconds.
				<div className="omp-composer-hint omp-composer-hint--code" id={codeHintId} role="status" title={quoteNotice ?? (caretBlock !== null ? CODE_HINT : caretInQuote ? QUOTE_HINT : undefined)}>
					{quoteNotice ?? (caretBlock !== null ? CODE_HINT : caretInQuote ? QUOTE_HINT : "")}
				</div>
			)}
			<ExtensionWidgets snapshot={snapshot} placement="belowEditor" />
			</>}
			<ChatFooter client={client} snapshot={snapshot}
				commandsAction={<CommandsMenu commands={snapshot.commands} context={commandContext} disabled={captureLocked} onPick={runCommand} />}
				trailingActions={dialog === null ? promptActions : undefined} />
		</div>
	);
}
