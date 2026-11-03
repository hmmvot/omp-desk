/**
 * Text from an editor into a session of this window: `OMP Desk: Add File to Session` (`@path` references) and the quotes of an editor
 * selection, a diff hunk, a caret's line or a Markdown preview's selection. A session is chosen from the window's candidates (or a new one
 * is started beside the file), opened when it must be, and the text is handed to its composer or, for a terminal, pasted. Nothing is
 * ever submitted.
 */
import * as vscode from "vscode";
import { delay } from "../host/native-terminal";
import { SessionIndex } from "../host/session-index";
import type { SessionIndexEntry, SessionViewMode } from "../host/session-model";
import { type Logger } from "../shared/logger";
import type { PendingOrigin } from "../shared/pending-operation";
import { candidateDescription as sendCandidateDescription, composeEditorQuotes, composeHunkQuote, composeInsertion, composeLineReference, folderName as sessionFolderName, insertAvailability, newSessionFolder, pickerEntries, visibleQuoteTarget } from "./editor-context";
import type { EditorQuoteSource, HunkQuoteSource, LineReferenceSource, ReferenceSource, SendCandidate } from "./editor-context";
import { quoteHunkOf } from "./quote-hunk";
import { quoteSourceOf } from "./quote-source";
import { composePreviewQuote } from "./preview-quote";
import type { PreviewDocument } from "./preview-quote";
import type { ActivePreview } from "./preview-selection";
import { activePreview, copyPreviewSelection, previewDocumentOf } from "./preview-selection";
import { sessionItemState, sessionStateLabel, sessionHeadline } from "../views/session-tree";
import type { SessionLauncherFacts } from "../views/session-tree";
import type { SessionHostRuntime } from "../host/native-session";
import type { GuestInsertQuoteMessage, GuestInsertTextMessage } from "../protocol/messages";
import type { TabState, WindowState } from "./window-state";

// "OMP Desk: Add File to Session" and "OMP Desk: Quote Selection to Session"
// What Add File adds is a reference (`@src/a.ts`), composed by `wiring/editor-context` for the chosen session's cwd. Quote
// Selection to Session sends the selected text with its location as a quote the page places like a Chat quote, or, with nothing
// selected, the location of the caret's line as inline code. The target of Add File is always the user's choice from a picker, most
// recently focused editor first; a quote or a line reference skips the picker when a Chat of this window is visible and goes into that
// composer. Nothing is ever submitted, and the destination is revealed and focused.

/** How long a session being opened may take to be able to receive the text. */
export const INSERT_TARGET_TIMEOUT_MS = 30_000;

export const INSERT_POLL_MS = 100;

type SendTarget =
  | { readonly kind: "session"; readonly candidate: SendCandidate }
  | { readonly kind: "new"; readonly folder: string };

/** What goes to the chosen session: `@path` references (Add File to Session), a quote of editor text, the hunk of a diff under the caret, or the reference to a caret's line (the last three are Alt+Q). */
type InsertionRequest =
  | { readonly kind: "references"; readonly sources: readonly ReferenceSource[] }
  | { readonly kind: "quote"; readonly source: EditorQuoteSource }
  | { readonly kind: "hunk"; readonly source: HunkQuoteSource }
  | { readonly kind: "line"; readonly source: LineReferenceSource }
  | { readonly kind: "preview"; readonly document: PreviewDocument; readonly text: string };

/** How the status bar and the warnings word what went where. */
const SEND_WORDS = {
  references: { past: "added", Past: "Added", to: "to" },
  quote: { past: "quoted", Past: "Quoted", to: "into" },
  hunk: { past: "quoted", Past: "Quoted", to: "into" },
  preview: { past: "quoted", Past: "Quoted", to: "into" },
  line: { past: "referenced", Past: "Referenced", to: "in" },
} as const;
/** What the session insertions reads of its window and calls into. */
export interface SessionInsertionsDeps {
  readonly showWarning: (message: string) => void;
  readonly windowState: () => WindowState;
  readonly launcherFacts: (tabId: string) => SessionLauncherFacts;
  readonly stateOf: (key: string | null) => TabState | undefined;
  readonly passiveReasonForSlot: (slot: string) => string | null;
  readonly hostOf: (state: { readonly tabId: string | null; } | null | undefined) => SessionHostRuntime | null;
  readonly defaultSessionMode: (context: vscode.ExtensionContext) => SessionViewMode;
  readonly log: Logger;
  readonly showInfo: (message: string) => void;
  readonly showError: (message: string) => void;
  readonly refreshLauncher: (options?: { readonly ownership?: boolean; }) => void;
  readonly messageOf: (error: unknown) => string;
  readonly openSession: (context: vscode.ExtensionContext, index: SessionIndex, argument: unknown, verb: "opened" | "resumed", noRouting?: boolean, keepLiveView?: boolean, origin?: PendingOrigin) => Promise<boolean>;
  readonly fencedOf: (state: { readonly tabId: string | null; } | null | undefined) => boolean;
  readonly activateNativeEditor: (state: TabState) => void;
}

/** The window's insertions into a session's composer: Add File to Session, the editor and preview quotes, the target pick and the delivery. */
export function createSessionInsertions(deps: SessionInsertionsDeps) {
  const { showWarning, windowState, launcherFacts, stateOf, passiveReasonForSlot, hostOf, defaultSessionMode, log, showInfo, showError, refreshLauncher, messageOf, openSession, fencedOf, activateNativeEditor } = deps;

  /** An Explorer click (with its multi-selection), an editor or tab menu, or — from the palette — the active editor's file. */
  async function addFilesToSession(context: vscode.ExtensionContext, index: SessionIndex, clicked: unknown, selected: unknown): Promise<void> {
    const chosen = Array.isArray(selected) ? selected.filter((value): value is vscode.Uri => value instanceof vscode.Uri) : [];
    const uris = chosen.length > 0 ? chosen : clicked instanceof vscode.Uri ? [clicked] : vscode.window.activeTextEditor === undefined ? [] : [vscode.window.activeTextEditor.document.uri];
    const files = uris.filter(uri => uri.scheme === "file");
    if (files.length === 0) {
      showWarning("Select a file or folder on disk to add.");
      return;
    }
    const dirty = new Set(vscode.workspace.textDocuments.filter(document => document.isDirty).map(document => document.uri.toString()));
    await addToSession(context, index, files.map(uri => ({ fsPath: uri.fsPath })), files.some(uri => dirty.has(uri.toString())));
  }

  /** This window's sessions that can take text now, or by being opened first. */
  function sendCandidates(context: vscode.ExtensionContext, index: SessionIndex): SendCandidate[] {
    const s = windowState();
    const found: SendCandidate[] = [];
    for (const entry of index.list()) {
      const facts = launcherFacts(entry.tabId);
      // A row another window holds is never an Add-to-Session target: window-local facts cannot see
      // that claim, so the Sessions row's own observation decides.
      const state = s.launcherProvider?.displayedState(entry.tabId) === "otherWindow" ? "otherWindow" : sessionItemState(entry, facts);
      const availability = insertAvailability(state, { running: facts.running, open: facts.open });
      if (availability === null) continue;
      const tab = stateOf(entry.tabId);
      const editorOpen = tab?.panel != null;
      // An editor that does not control its session shows one another writer holds.
      if (tab !== undefined && editorOpen && passiveReasonForSlot(tab.slotId) !== null) continue;
      // A page that outlived a host restart has no panel handle to reveal or write to.
      if (facts.open && !editorOpen) continue;
      found.push({
        tabId: entry.tabId,
        slotId: tab !== undefined && editorOpen ? tab.slotId : null,
        title: tab?.panel?.title ?? sessionHeadline(entry, null),
        cwd: hostOf(tab)?.cwd ?? entry.cwd,
        mode: hostOf(tab)?.kind ?? tab?.mode ?? defaultSessionMode(context),
        stateLabel: sessionStateLabel(state),
        availability,
        visible: editorOpen && tab?.panel?.visible === true,
      });
    }
    return found;
  }

  /** The QuickPick: eligible sessions, most recently focused first and preselected, then a new session next to the file. */
  async function pickSendTarget(context: vscode.ExtensionContext, index: SessionIndex, firstFsPath: string | null, unsaved: boolean, chatOnly: boolean): Promise<SendTarget | null> {
    const s = windowState();
    // A document with no path (untitled, or another scheme) starts a new session in the first workspace folder, if there is one.
    const workspace = firstFsPath === null ? vscode.workspace.workspaceFolders?.[0] : vscode.workspace.getWorkspaceFolder(vscode.Uri.file(firstFsPath));
    const requestedFolder = firstFsPath === null ? workspace?.uri.fsPath ?? null : newSessionFolder(firstFsPath, workspace?.uri.fsPath ?? null);
    // A workspace folder shown as the checkout root its sessions run at starts the session there.
    const listed = requestedFolder === null ? null : s.launcherFolders?.folderForCwd(requestedFolder) ?? null;
    const folder = listed?.path ?? requestedFolder;
    const folderListed = listed !== null;
    // A quote is Markdown for the Chat composer: a terminal session is not offered, and a new session is started as a Chat.
    const candidates = chatOnly ? sendCandidates(context, index).filter(candidate => candidate.mode === "chat") : sendCandidates(context, index);
    const entries = pickerEntries(candidates, s.editorRecency.order(), folder ?? "", chatOnly ? "chat" : defaultSessionMode(context), folderListed).filter(entry => folder !== null || entry.kind !== "new");
    if (entries.length === 0) {
      showWarning(chatOnly ? "No Chat session is open in this window, and there is no folder to start one in. Open a Chat session first." : "No OMP session is open in this window, and there is no folder to start one in. Open a session first.");
      return null;
    }
    const items: (vscode.QuickPickItem & { target?: SendTarget })[] = [];
    for (const entry of entries) {
      if (entry.kind === "new") {
        if (items.length > 0) items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: `$(add) ${entry.label}`, description: entry.description, target: { kind: "new", folder: entry.folder } });
        continue;
      }
      const { candidate } = entry;
      items.push({
        label: `$(${candidate.mode === "chat" ? "comment-discussion" : "terminal"}) ${candidate.title}`,
        description: sendCandidateDescription(candidate),
        detail: candidate.availability === "resume" ? `${candidate.cwd} — stopped: choosing it starts the session first` : candidate.cwd,
        target: { kind: "session", candidate },
      });
    }
    const picker = vscode.window.createQuickPick<(typeof items)[number]>();
    picker.title = chatOnly ? "Quote into OMP session" : "Add to OMP session";
    const verb = chatOnly ? "quote it into" : "add it to";
    picker.placeholder = unsaved ? `Choose the session to ${verb} — ${chatOnly ? "the quote holds the unsaved text, the location is the saved file's" : "unsaved changes are not included"}` : `Choose the session to ${verb}`;
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.items = items;
    const first = items[0];
    if (first !== undefined) picker.activeItems = [first];
    const { promise, resolve } = Promise.withResolvers<SendTarget | null>();
    picker.onDidAccept(() => {
      resolve(picker.selectedItems[0]?.target ?? null);
      picker.hide();
    });
    picker.onDidHide(() => {
      resolve(null);
      picker.dispose();
    });
    picker.show();
    return await promise;
  }

  /** The request written for one session's working directory: the page message, and the text a terminal would be pasted (`null`: it takes none). */
  function composeRequest(request: InsertionRequest, cwd: string):
    | { readonly ok: true; readonly summary: string; readonly chat: GuestInsertTextMessage | GuestInsertQuoteMessage; readonly pasteText: string | null }
    | { readonly ok: false; readonly reason: string } {
    if (request.kind === "references") {
      const composed = composeInsertion(request.sources, cwd);
      return composed.ok ? { ok: true, summary: composed.summary, chat: { type: "omp:insert-text", text: composed.text }, pasteText: composed.text } : composed;
    }
    if (request.kind === "line") {
      const composed = composeLineReference(request.source, cwd);
      return composed.ok ? { ok: true, summary: composed.summary, chat: { type: "omp:insert-text", text: composed.text }, pasteText: null } : composed;
    }
    if (request.kind === "hunk") {
      const composed = composeHunkQuote(request.source, cwd);
      return composed.ok ? { ok: true, summary: composed.summary, chat: { type: "omp:insert-quote", quotes: composed.quotes }, pasteText: null } : composed;
    }
    if (request.kind === "preview") {
      const composed = composePreviewQuote(request.document, request.text, cwd);
      return composed.ok ? { ok: true, summary: composed.summary, chat: { type: "omp:insert-quote", quotes: composed.quotes }, pasteText: null } : composed;
    }
    const composed = composeEditorQuotes(request.source, cwd);
    return composed.ok ? { ok: true, summary: composed.summary, chat: { type: "omp:insert-quote", quotes: composed.quotes }, pasteText: null } : composed;
  }

  async function addToSession(context: vscode.ExtensionContext, index: SessionIndex, sources: readonly ReferenceSource[], unsaved: boolean): Promise<void> {
    const first = sources[0];
    if (first === undefined) return;
    await sendToSession(context, index, { kind: "references", sources }, first.fsPath, unsaved);
  }

  /**
   * "OMP Desk: Quote Selection to Session" (`Alt+Q` in a text editor): every non-empty selection of the active editor becomes a quote
   * in the chosen Chat session's draft; the page places the quote the way it places a Chat quote
   * (docs/designs/2026-10-15-quote-chat-selection.md, decision 9). With nothing selected the primary caret's line is referenced instead
   * (docs/designs/2026-10-18-chat-keys-and-empty-state.md, decision 3): `path:N` as inline code, inserted at the caret of the draft, by
   * the quote's own location rule and target rule. The active editor of a diff is the side that has the focus; a side that is a Git
   * revision names the version it is (decision 10 of the quote design, `src/wiring/quote-source.ts`).
   * In a diff editor, with nothing selected and the caret on a changed line, the whole hunk is quoted instead (decision 11, `wiring/quote-hunk.ts`).
   */
  async function quoteEditorSelectionToSession(context: vscode.ExtensionContext, index: SessionIndex): Promise<void> {
    const preview = activePreview();
    if (preview !== null) {
      await quotePreviewSelectionToSession(context, index, preview);
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      showWarning("Open a text editor to quote from or to point at a line.");
      return;
    }
    const { document } = editor;
    const selections = editor.selections.filter(selection => !selection.isEmpty);
    if (selections.length === 0) {
      // In a diff editor with the caret on a changed line, the whole hunk is the quote (decision 11); anywhere else the caret's line is referenced.
      const hunk = await quoteHunkOf(editor);
      if (hunk !== null) {
        log.debug(`diff hunk: ${hunk.modified.version ?? "file on disk"} against ${hunk.original.version ?? "file on disk"}`);
        const early = composeHunkQuote(hunk, "");
        if (!early.ok) {
          showWarning(`${early.reason} Nothing was quoted.`);
          return;
        }
        await sendToSession(context, index, { kind: "hunk", source: hunk }, hunk.modified.fsPath ?? hunk.original.fsPath, document.isDirty);
        return;
      }
      const where = await quoteSourceOf(document, [editor.selection]);
      const source: LineReferenceSource = { fsPath: where.fsPath, version: where.version, line: editor.selection.active.line + 1 };
      log.debug(`line reference: ${document.uri.scheme} document, ${source.fsPath === null ? "no path" : source.version === null ? "file on disk" : `version ${source.version}`}`);
      // A document with no location, or a path that cannot be written, is refused before a session is chosen or started.
      const early = composeLineReference(source, "");
      if (!early.ok) {
        showWarning(early.reason);
        return;
      }
      await sendToSession(context, index, { kind: "line", source }, source.fsPath, document.isDirty);
      return;
    }
    const source = await quoteSourceOf(document, selections);
    log.debug(`quote source: ${document.uri.scheme} document, ${source.fsPath === null ? "no path" : source.version === null ? "file on disk" : `version ${source.version}`}, ${selections.length} selection(s)`);
    // What cannot be quoted at all (too long, a control character, too many selections) is refused before a session is chosen or started.
    const early = composeEditorQuotes(source, "");
    if (!early.ok) {
      showWarning(`${early.reason} Nothing was quoted.`);
      return;
    }
    await sendToSession(context, index, { kind: "quote", source }, source.fsPath, document.isDirty);
  }

  /**
   * `Alt+Q` while VS Code's Markdown preview has the focus: the selected rendered text goes into the Chat draft under the path of the
   * document the preview shows (docs/designs/2026-10-15-quote-chat-selection.md, decision 12). Nothing selected is a notice and
   * nothing is quoted; the session is chosen as for any quote.
   */
  async function quotePreviewSelectionToSession(context: vscode.ExtensionContext, index: SessionIndex, preview: ActivePreview): Promise<void> {
    log.debug(`preview quote: ${preview.fsPath === null ? "preview panel" : "preview editor"}`);
    const text = await copyPreviewSelection();
    if (text.trim().length === 0) {
      showInfo("Select some text in the preview first.");
      return;
    }
    const document = await previewDocumentOf(preview);
    log.debug(`preview quote: ${document.fsPath === null ? "document not identified" : "document identified"}`);
    const early = composePreviewQuote(document, text, "");
    if (!early.ok) {
      showWarning(`${early.reason} Nothing was quoted.`);
      return;
    }
    await sendToSession(context, index, { kind: "preview", document, text }, document.fsPath, false);
  }

  async function sendToSession(context: vscode.ExtensionContext, index: SessionIndex, request: InsertionRequest, firstFsPath: string | null, unsaved: boolean): Promise<void> {
    const s = windowState();
    const chatOnly = request.kind !== "references";
    const words = SEND_WORDS[request.kind];
    // A quote or a line reference goes straight into the Chat the user can see in this window; the picker only asks when none is shown.
    const visibleChat = chatOnly ? visibleQuoteTarget(sendCandidates(context, index), s.editorRecency.order()) : null;
    const target = visibleChat !== null ? { kind: "session" as const, candidate: visibleChat } : await pickSendTarget(context, index, firstFsPath, unsaved, chatOnly);
    if (target === null) return;
    let tabId: string;
    let cwd: string;
    let folderAdded = false;
    if (target.kind === "new") {
      const folders = s.launcherFolders;
      if (folders === undefined) return;
      // Refuse what cannot be written before anything is added or started.
      const probe = composeRequest(request, target.folder);
      if (!probe.ok) { showWarning(`${probe.reason} Nothing was ${words.past}.`); return; }
      // Choosing "New session in <folder>" for a folder the launcher already shows (open in this
      // window or pinned) just starts there; for any other folder it is the explicit act of pinning
      // it (a session is never started in a folder the launcher does not show); the picker row says so.
      const shown = folders.folderForCwd(target.folder);
      folderAdded = shown === null;
      const added = shown === null ? await folders.add(target.folder) : { ok: true as const, folder: shown, created: false };
      if (!added.ok) {
        showError(`The folder for a new session was not pinned: ${added.reason}`);
        return;
      }
      cwd = added.folder.path;
      refreshLauncher();
      let entry: SessionIndexEntry;
      try {
        entry = await index.createDraft({ cwd });
      } catch (error) {
        showError(`A new OMP session could not be reserved: ${messageOf(error)}`);
        return;
      }
      tabId = entry.tabId;
      refreshLauncher();
      await windowState().sessionFlows.openTab(context, index, tabId, "started", "explicit", chatOnly ? "chat" : undefined);
    } else {
      tabId = target.candidate.tabId;
      cwd = target.candidate.cwd;
      const probe = composeRequest(request, cwd);
      if (!probe.ok) { showWarning(`${probe.reason} Nothing was ${words.past}.`); return; }
      // Reveals a running session's editor, reopens a closed one and starts a stopped one, all through the
      // path the Sessions view's Open uses (ownership is rechecked there).
      // The references are inserted into an editor of this window, so a stopped session is launched here, not in
      // the window its folder is open in (ADR-0057 leaves this one entry point local).
      if (!(await openSession(context, index, tabId, "resumed", true))) return;
    }
    const delivered = await deliverInsertion(tabId, request, cwd);
    if (!delivered.ok) {
      log.warn(`tab ${tabId}: editor ${request.kind} was not ${words.past} (${delivered.reason})`);
      void vscode.window.showWarningMessage(`OMP Desk: ${delivered.reason} Nothing was ${words.past}.`, ...(request.kind === "references" ? ["Copy reference"] : [])).then(choice => {
        if (choice === "Copy reference" && request.kind === "references") {
          const composed = composeInsertion(request.sources, cwd);
          if (composed.ok) void vscode.env.clipboard.writeText(composed.text);
        }
      });
      return;
    }
    log.debug(`tab ${tabId}: ${stateOf(tabId)?.mode ?? "chat"} received ${request.kind === "references" ? `${request.sources.length} editor reference(s)` : request.kind === "quote" ? `${request.source.selections.length} editor quote(s)` : request.kind === "hunk" ? "a diff hunk" : request.kind === "preview" ? "a preview quote" : "a line reference"}`);
    const notes: string[] = [];
    if (unsaved) notes.push(chatOnly ? "the file has unsaved changes: the location is the saved file's" : "unsaved changes are not included");
    if (folderAdded) notes.push(`${sessionFolderName(cwd)} was pinned to the Sessions view`);
    // OMP expands @mentions only in a prompt sent while it is idle, not in a steering or queued follow-up message. A quote and a line reference hold no mention.
    if (request.kind === "references" && s.turnActivities.get(tabId)?.streaming === true) notes.push("the session is busy: send it once the turn ends so the files are read");
    vscode.window.setStatusBarMessage(`${words.Past} ${delivered.summary} ${words.to} «${delivered.title}»${notes.length > 0 ? ` — ${notes.join("; ")}` : ""}`, notes.length > 0 ? 10_000 : 6_000);
  }

  /**
   * Hand the references to the session's input once that input exists: the composer of a chat page that
   * has announced itself, or the native TUI once it has enabled bracketed paste. The target is revealed
   * and focused once; a session still starting is waited for, bounded. The text is composed against the
   * session's working directory as it is when written, which a starting session may still be settling.
   */
  async function deliverInsertion(
    tabId: string,
    request: InsertionRequest,
    entryCwd: string,
  ): Promise<{ readonly ok: true; readonly title: string; readonly summary: string } | { readonly ok: false; readonly reason: string }> {
    const s = windowState();
    const deadline = Date.now() + INSERT_TARGET_TIMEOUT_MS;
    let waiting = "the session did not become ready";
    let revealed = false;
    for (;;) {
      const state = stateOf(tabId);
      const panel = state?.panel ?? null;
      if (state !== undefined && panel !== null && state.document?.kind === "guest" && !fencedOf(state)
        && passiveReasonForSlot(state.slotId) === null && launcherFacts(tabId).running) {
        if (s.turnActivities.get(tabId)?.pendingRequest != null) return { ok: false, reason: "The session is waiting for your answer, which covers its input." };
        if (!revealed) {
          revealed = true;
          if (!panel.active) panel.reveal(undefined, false);
        }
        const composed = composeRequest(request, hostOf(state)?.cwd ?? entryCwd);
        if (!composed.ok) return { ok: false, reason: composed.reason };
        const { summary } = composed;
        if (state.mode === "chat") {
          if (s.readyDocuments.get(state) === state.document) {
            const posted = await panel.webview.postMessage(composed.chat);
            return posted ? { ok: true, title: panel.title, summary } : { ok: false, reason: "The chat page did not accept the text." };
          }
          waiting = "the chat page did not become ready";
        } else if (composed.pasteText === null) {
          return { ok: false, reason: "A quote or a line reference goes into a Chat session; this one shows its terminal." };
        } else if (state.pipeline !== null && state.shellSlot === null) {
          const outcome = await state.pipeline.pasteText(composed.pasteText);
          if (outcome === "pasted") {
            const settleBy = Date.now() + 2_000;
            while (state.panel?.active !== true && Date.now() < settleBy) await delay(50);
            activateNativeEditor(state);
            return { ok: true, title: panel.title, summary };
          }
          if (outcome === "refused" || outcome === "unavailable") return { ok: false, reason: "The terminal could not take the text." };
          waiting = outcome === "not-owner" ? "the terminal did not take input ownership" : "OMP's prompt is not reading input yet";
        }
      }
      if (Date.now() >= deadline) return { ok: false, reason: `Timed out: ${waiting}.` };
      await delay(INSERT_POLL_MS);
    }
  }
  return { quoteEditorSelectionToSession, addFilesToSession };
}
