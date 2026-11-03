/**
 * Folder commands of a window: the Add Folder flow (a pick among open folders, or the native dialog), Pin and Unpin, the folder choice a command
 * without a row asks for, and Resume Session over the history of one folder (the scan, the picker with its Delete action and the open of the
 * chosen session in this window or the window that suits its folder).
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { relativeAge } from "../shared/relative-age";
import { SessionIndex } from "../host/session-index";
import { normalizeSessionIdentityKey } from "../host/session-files";
import { type Logger } from "../shared/logger";
import { type LaunchKind } from "../host/launch-timeline";
import { type PendingHandle } from "../host/pending-operations";
import type { PendingKind, PendingOrigin, PendingStep } from "../shared/pending-operation";
import { canonicalFolderKey, folderHistoryDeletionSubject, inspectSessionFile, scanFolderHistory } from "../host/folder-history";
import type { FolderHistoryCandidate, FolderHistoryIndexedEntry, FolderHistoryScan } from "../host/folder-history";
import { folderHeadline, sizeText } from "../views/session-tree";
import { folderArgument } from "../views/workspace-folders";
import { LauncherFolders } from "../views/launcher-folders";
import { displayFolderPath } from "../host/folder-display";
import type { LauncherFolder } from "../views/launcher-folders";
import type { WorkspaceFolder } from "../views/workspace-folders";
import type { SessionHostRuntime } from "../host/native-session";
import type { TabState, WindowState } from "./window-state";

/** The "choose another folder" entry of the Add picker. */
const BROWSE_FOR_FOLDER_LABEL = "Browse…";

/** The one per-row action a Resume row carries: delete this session. */
const HISTORY_ROW_TRASH: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("trash"),
  tooltip: "Delete this session and its transcript…",
};

/** One row of the folder Resume picker. */
interface FolderHistoryPickItem extends vscode.QuickPickItem {
  readonly candidate: FolderHistoryCandidate;
}
/** What the folder commands reads of its window and calls into. */
export interface FolderCommandsDeps {
  readonly windowState: () => WindowState;
  readonly showError: (message: string) => void;
  readonly refreshLauncher: (options?: { readonly ownership?: boolean; }) => void;
  readonly showWarning: (message: string) => void;
  readonly showInfo: (message: string) => void;
  readonly log: Logger;
  readonly hostOf: (state: { readonly tabId: string | null; } | null | undefined) => SessionHostRuntime | null;
  readonly messageOf: (error: unknown) => string;
  readonly stateOf: (key: string | null) => TabState | undefined;
  readonly pendingEntry: <T>(key: string, kind: PendingKind, options: { readonly origin?: PendingOrigin; readonly requestId?: string | null; readonly step?: PendingStep; }, run: (handle: PendingHandle) => Promise<T>) => Promise<T>;
  readonly timedLaunch: <T>(tabId: string, kind: LaunchKind, commandAt: number, run: () => Promise<T>) => Promise<T>;
  readonly requestSessionRowExpand: (tabId: string) => void;
  readonly setActiveTab: (index: SessionIndex, tabId: string) => Promise<void>;
  readonly revealActiveSession: (index: SessionIndex) => Promise<void>;
}

/** The window's folder commands: Add, Pin and Unpin, the folder choice and the Resume Session flow over a folder's history. */
export function createFolderCommands(deps: FolderCommandsDeps) {
  const { windowState, showError, refreshLauncher, showWarning, showInfo, log, hostOf, messageOf, stateOf, pendingEntry, timedLaunch, requestSessionRowExpand, setActiveTab, revealActiveSession } = deps;

  /**
   * Ask which folder to pin, then pin it.
   *
   * The folders VS Code has open that are not pinned yet are offered first: they are what
   * the user is already looking at (and already shown in Sessions), and a short list beats
   * a filesystem dialog. Nothing is pinned without an explicit choice — "Browse…" opens
   * the native folder dialog for any other absolute local directory. When there is nothing
   * to suggest, the dialog is used directly.
   */
  async function addWorkspaceFolder(index: SessionIndex): Promise<LauncherFolder | null> {
    const s = windowState();
    const folders = s.launcherFolders;
    if (folders === undefined) return null;
    const chosenPath = await pickFolderToAdd(folders);
    if (chosenPath === null) return null;
    const added = await folders.add(chosenPath);
    if (!added.ok) {
      showError(`The folder was not added: ${added.reason}`);
      return null;
    }
    refreshLauncher();
    s.sessionActions.reportFolderSaveFailure(folders);
    return added.folder;
  }

  /**
   * One folder path the user picked to pin, or `null` when they dismissed the
   * question. The open VS Code folders that are not pinned are suggestions; the dialog is
   * the way to reach anything else, and only a local (`file`) location is ever returned.
   */
  async function pickFolderToAdd(folders: LauncherFolders): Promise<string | null> {
    const suggestions = folders.list().filter(folder => folder.open && !folder.pinned);
    if (suggestions.length === 0) return await browseForFolder();
    const picked = await vscode.window.showQuickPick(
      [
        ...suggestions.map(folder => ({
          label: folderHeadline(folder.path),
          description: displayFolderPath(folder.path),
          detail: "Open in this window",
          addPath: folder.path as string | null,
        })),
        {
          label: BROWSE_FOR_FOLDER_LABEL,
          description: "Choose another local folder",
          detail: "Opens the folder dialog",
          addPath: null,
        },
      ],
      {
        title: "Pin a folder to the Sessions view",
        placeHolder: "Pick the folder to pin, or browse for another one",
      },
    );
    if (picked === undefined) return null;
    return picked.addPath ?? (await browseForFolder());
  }

  /** The native folder dialog, which is how a directory outside the workspace is added. */
  async function browseForFolder(): Promise<string | null> {
    const chosen = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Add Folder",
      title: "Add a folder to the Sessions view",
    });
    const uri = chosen?.[0];
    if (uri === undefined) return null;
    if (uri.scheme !== "file") {
      showError(`Only local folders can be added to Sessions, and "${uri.toString()}" is not local.`);
      return null;
    }
    return uri.fsPath;
  }

  /**
   * Pin one folder the launcher shows, so it stays after VS Code closes it and appears in
   * every window.
   *
   * This is metadata only. The folder's id is the one it will keep once pinned, and it is
   * resolved again here, so a stale row cannot pin a different folder.
   */
  async function pinWorkspaceFolder(index: SessionIndex, argument: unknown): Promise<void> {
    const s = windowState();
    const folders = s.launcherFolders;
    if (folders === undefined) return;
    const folder = await chooseFolder(index, folders, argument, {
      title: "Pin a folder to the Sessions view",
      addWhenEmpty: false,
      only: "unpinned",
      nothing: "Every folder shown in Sessions is already pinned.",
    });
    if (folder === null) return;
    const result = await folders.pin(folder.id);
    if (!result.ok) {
      showWarning(result.reason);
      refreshLauncher();
      return;
    }
    refreshLauncher();
    s.sessionActions.reportFolderSaveFailure(folders);
  }

  /**
   * Unpin one folder: it leaves the pinned list of every window.
   *
   * This is the only way a folder is dropped from the launcher, and it is metadata only: no
   * editor is closed, no native host is stopped, no session is forgotten and no session file
   * is deleted. A folder VS Code has open here, or runs a session in, stays visible in this
   * window (unpinned); a running session never refuses it. The folder's id is resolved again here, so a
   * stale row cannot unpin a different folder.
   */
  async function unpinWorkspaceFolder(index: SessionIndex, argument: unknown): Promise<void> {
    const s = windowState();
    const folders = s.launcherFolders;
    if (folders === undefined) return;
    const folder = await chooseFolder(index, folders, argument, {
      title: "Unpin a folder from Sessions",
      addWhenEmpty: false,
      only: "pinned",
      nothing: "No folder is pinned in Sessions.",
    });
    if (folder === null) return;
    const result = await folders.unpin(folder.id);
    if (!result.unpinned) {
      showWarning(result.reason);
      refreshLauncher();
      return;
    }
    refreshLauncher();
    s.sessionActions.reportFolderSaveFailure(folders);
  }

  /**
   * The folder a folder-scoped command acts on.
   *
   * A folder row supplies its stable id, which is resolved again here against the folders
   * the launcher shows now: an id that went stale — the folder was unpinned and closed, or
   * the row belongs to another window — reports and stops instead of falling back to a
   * different folder. An absent argument asks the user (among the pinned or unpinned folders
   * when `only` says so; this window's folders first, in workspace order, when `openHereFirst` says so,
   * so that Enter picks the current project); with no folder shown at all there is nothing to choose from, so a
   * command that can create its subject (New Session, Resume) offers the Add flow and one
   * that cannot says so.
   */
  async function chooseFolder(
    index: SessionIndex,
    folders: LauncherFolders,
    argument: unknown,
    options: {
      readonly title: string;
      readonly addWhenEmpty: boolean;
      readonly only?: "pinned" | "unpinned";
      /** List the folders open in this window first, in workspace order, so the first (pre-selected) row is the current project. */
      readonly openHereFirst?: boolean;
      /** What to say when `only` leaves nothing to choose from. */
      readonly nothing?: string;
    },
  ): Promise<LauncherFolder | null> {
    const shown = folders.list();
    const supplied = folderArgument(argument, shown);
    if (supplied.kind === "stale") {
      showError("That folder is no longer in Sessions. Refresh Sessions and try again.");
      return null;
    }
    if (supplied.kind === "folder") return supplied.folder;
    const candidates = (options.openHereFirst === true ? folders.listForPicker() : shown).filter(folder => options.only === undefined || folder.pinned === (options.only === "pinned"));
    if (candidates.length === 0) {
      if (options.only !== undefined) {
        showInfo(options.nothing ?? "No folder matches.");
        return null;
      }
      if (!options.addWhenEmpty) {
        showInfo("No folder is shown in Sessions yet. Open a folder or add one first.");
        return null;
      }
      return await addWorkspaceFolder(index);
    }
    if (candidates.length === 1) return candidates[0];
    const picked = await vscode.window.showQuickPick(
      candidates.map(folder => {
        // Why the folder is listed: pinned, open in this window or another one, or only kept for a running session.
        const where = folder.openHere ? "open in this window" : folder.openElsewhere ? "open in another window" : null;
        const source = folder.pinned
          ? (where === null ? "pinned" : `pinned, ${where}`)
          : (where ?? "kept because a session runs in it");
        return {
          label: folderHeadline(folder.path),
          description: displayFolderPath(folder.path),
          detail: `${source}, ${folder.collapsed ? "collapsed" : "expanded"} in Sessions`,
          folder,
        };
      }),
      { title: options.title },
    );
    return picked?.folder ?? null;
  }

  /**
   * Every materialized index row, narrowed to what the folder query needs.
   *
   * All of them are passed, not only the ones that look like they match: the query
   * owns the folder comparison, needs the index's own session directories because a
   * custom `--session-dir` can sit outside every profile root, and is the one place
   * that decides whether a row appears as an indexed candidate or a discovered one.
   */
  function indexedRowsForHistory(index: SessionIndex): FolderHistoryIndexedEntry[] {
    return index.list().map(entry => ({
      tabId: entry.tabId,
      sessionFile: entry.sessionFile,
      cwd: entry.cwd,
      sessionId: entry.sessionId,
      profile: entry.scope.profile,
      sessionDirs: [entry.sessionDir, entry.scope.sessionDir].filter((dir): dir is string => dir !== null),
    }));
  }

  /**
   * Record one folder-scoped discovery pass in the output channel.
   *
   * Every issue's own text goes here and nowhere else: the pass's exception detail
   * and uncontrolled file paths are local evidence for the user reading the OMP
   * channel, while what a notification says stays a bounded statement about how
   * complete the pass was. A root or file that is simply absent is logged too — it
   * is a fact about the pass, not a hidden session.
   */
  function logFolderScan(folder: WorkspaceFolder, scan: FolderHistoryScan): void {
    log.debug(
      `folder history: ${scan.candidates.length} candidate(s) for ${folder.path} over ${scan.roots.length} root(s), ` +
        `${scan.issues.length} issue(s), ${scan.skippedFiles} skipped, incomplete=${scan.incomplete}, cancelled=${scan.cancelled}`,
    );
    for (const issue of scan.issues) {
      log.warn(`folder history (${issue.kind})${issue.path === null ? "" : ` ${issue.path}`}: ${issue.detail}`);
    }
  }

  /** What a discovered session file is called: its own title, or its file name. */
  function candidateLabel(candidate: FolderHistoryCandidate): string {
    const title = candidate.title?.trim() ?? "";
    if (title.length > 0) return title;
    const name = path.basename(candidate.file, ".jsonl");
    return name.length > 0 ? name : candidate.file;
  }

  /** What the picker row says about one candidate: this window's state, profile, age, size. */
  function candidateDescription(
    candidate: FolderHistoryCandidate,
    state: { readonly open: boolean; readonly running: boolean },
  ): string {
    // Where the row was found is deliberately absent: an indexed row and a discovered
    // one are one row per canonical file with the same actions (ADR-0027). What the
    // user is told is this window's own state for it, which is the thing that changes.
    const parts: string[] = [];
    if (state.open) parts.push("Open");
    else if (state.running) parts.push("Running in this window");
    if (!candidate.available) parts.push("Unavailable");
    parts.push(candidate.profile === null ? "default profile" : `profile ${candidate.profile}`);
    if (candidate.modifiedAt !== null) parts.push(relativeAge(candidate.modifiedAt, Date.now()));
    if (candidate.sizeBytes !== null) parts.push(sizeText(candidate.sizeBytes));
    return parts.join(" · ");
  }

  /**
   * Offer one folder's sessions, newest first, one row per exact file.
   *
   * The list merges the index's own rows with what the scan discovered and the query
   * has already collapsed both onto one row per canonical exact file, so a session that
   * is open is offered once and says so. Choosing an open session focuses its editor;
   * choosing any other indexed row uses the row the index already owns; only a
   * discovered file needs importing. A file whose indexed row has vanished from disk
   * stays visible as unavailable instead of disappearing between passes, and nothing is
   * resumed until one row is chosen.
   *
   * Every row carries its own trash button, and deleting one goes through exactly the
   * same confirmed transaction as a stopped row's Delete — the file, its artifacts, its
   * rewrite backups and its retained raw recordings. A row that was deleted disappears
   * from the list the user is still looking at, in place; a refusal is reported by name
   * and leaves the row exactly where it is.
   *
   * The picker never claims to be exhaustive when the scan could not read everything:
   * its own wording follows the pass's `incomplete` flag, and the reasons stay in the OMP
   * output channel rather than in this prompt.
   */
  async function pickFolderHistoryCandidate(
    index: SessionIndex,
    folder: WorkspaceFolder,
    scan: FolderHistoryScan,
  ): Promise<FolderHistoryCandidate | null> {
    const s = windowState();
    const open = new Set<string>();
    const running = new Set<string>();
    for (const state of s.tabs.values()) {
      if (state.tabId === null) continue;
      if (state.panel !== null) open.add(state.tabId);
      if (hostOf(state) !== null) running.add(state.tabId);
    }
    let remaining = [...scan.candidates];
    const rows = (): FolderHistoryPickItem[] =>
      remaining.map(candidate => ({
        label: candidateLabel(candidate),
        description: candidateDescription(candidate, {
          open: candidate.tabId !== null && open.has(candidate.tabId),
          running: candidate.tabId !== null && running.has(candidate.tabId),
        }),
        // An unavailable row names its file too, and says that choosing it cannot open
        // anything: the file is re-read at selection time, so a file that came back or
        // changed in the meantime is decided there rather than here.
        detail: candidate.available
          ? candidate.file
          : `${candidate.file}\nThis session file is not readable on disk, so it cannot be resumed.`,
        buttons: [HISTORY_ROW_TRASH],
        candidate,
      }));
    const picker = vscode.window.createQuickPick<FolderHistoryPickItem>();
    picker.title = scan.incomplete
      ? `Resume an OMP session in ${folderHeadline(folder.path)} (this list may be incomplete)`
      : `Resume an OMP session in ${folderHeadline(folder.path)}`;
    picker.placeholder = scan.incomplete
      ? "Some session locations could not be read, so sessions may be missing from this list"
      : "Every readable OMP session whose own header records this folder";
    picker.canSelectMany = false;
    picker.items = rows();
    picker.onDidTriggerItemButton(event => {
      const candidate = event.item.candidate;
      void (async () => {
        const deleted = await s.sessionActions.confirmAndDelete(index, folderHistoryDeletionSubject(candidate));
        if (!deleted) return;
        // In place: the row the user just deleted leaves the list they are looking at,
        // and every other row keeps its position.
        remaining = remaining.filter(other => other.file !== candidate.file);
        picker.items = rows();
      })();
    });
    return await new Promise<FolderHistoryCandidate | null>(resolve => {
      picker.onDidAccept(() => {
        resolve(picker.selectedItems[0]?.candidate ?? null);
        picker.hide();
      });
      picker.onDidHide(() => {
        resolve(null);
        picker.dispose();
      });
      picker.show();
    });
  }

  /**
   * Resume one of a folder's sessions, discovered on demand.
   *
   * The folder comes from a folder row or from a choice among the registered
   * folders. The scan is read-only, shows progress and can be cancelled, and it is
   * the only thing that ever enumerates OMP's session files: the launcher itself
   * never scans. The folder is resolved again after the scan and again after the
   * picker, so a folder removed while a dialog was open is never resumed from.
   */
  async function resumeWorkspaceFolder(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    argument: unknown,
  ): Promise<void> {
    const s = windowState();
    const folders = s.launcherFolders;
    if (folders === undefined) return;
    const folder = await chooseFolder(index, folders, argument, {
      title: "Choose the folder to resume a session from",
      addWhenEmpty: true,
      openHereFirst: true,
    });
    if (folder === null) return;
    if (await s.routing.routeLaunch(index, folder, { kind: "resume-folder", folderId: folder.id })) return;
    await resumeFromFolderHistory(context, index, folders, folder);
  }

  /** The scan, the picker and the launch of Resume Session for one folder, in this window. */
  async function resumeFromFolderHistory(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    folders: LauncherFolders,
    folder: LauncherFolder,
    keepLiveView = false,
  ): Promise<void> {
    const scan = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Looking for OMP sessions in ${folderHeadline(folder.path)}…`,
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        const registration = token.onCancellationRequested(() => controller.abort());
        try {
          return await scanFolderHistory({
            cwd: folder.path,
            indexed: indexedRowsForHistory(index),
            signal: controller.signal,
            isCancelled: () => token.isCancellationRequested,
          });
        } finally {
          registration.dispose();
        }
      },
    );
    logFolderScan(folder, scan);
    if (scan.cancelled) {
      // Cancelling means "stop waiting", so no picker is forced on the user
      // afterwards — but the partial result is reported rather than dropped: what
      // was already found is named here and every issue stays in the output channel.
      showInfo(
        scan.candidates.length === 0
          ? "Looking for OMP sessions was cancelled before any session was read, so nothing was resumed."
          : `Looking for OMP sessions was cancelled after ${scan.candidates.length} session(s) had been read, so nothing was resumed. ` +
              `Run Resume Session again to see the list.`,
      );
      return;
    }
    if (folders.get(folder.id) === null) {
      showWarning("That folder was removed from Sessions while its sessions were being read, so nothing was resumed.");
      refreshLauncher();
      return;
    }
    if (scan.candidates.length === 0) {
      // An empty answer is never presented as a complete one: a pass that could not
      // read everything says so instead, and the exact paths and errors are in the
      // OMP output channel rather than in this notification.
      if (scan.incomplete) {
        showWarning(
          `No OMP session could be read for "${folderHeadline(folder.path)}", and some session locations could not be read either, ` +
            `so this is not a complete answer. The OMP Desk output channel names every path and error.`,
        );
      } else {
        showInfo(`No readable OMP session records "${folderHeadline(folder.path)}" as its working directory.`);
      }
      return;
    }
    if (scan.incomplete) {
      showWarning(
        `Some OMP session locations of "${folderHeadline(folder.path)}" could not be read, so this list may be incomplete. ` +
          `The OMP Desk output channel names every path and error.`,
      );
    }
    const picked = await pickFolderHistoryCandidate(index, folder, scan);
    if (picked === null) return;
    const current = folders.get(folder.id);
    if (current === null) {
      showWarning("That folder was removed from Sessions, so nothing was resumed.");
      refreshLauncher();
      return;
    }
    await openFolderHistoryCandidate(context, index, current, picked, keepLiveView);
  }

  /**
   * Open one chosen folder-scoped session, after re-checking what it is.
   *
   * Everything is re-read at selection time, because between the scan and the click
   * a folder can be removed, a session file can change or disappear, another window
   * can import the same file, and a file's own header — the only authority on which
   * folder it belongs to — can record a different working directory than the row was
   * offered under. Any of those refuses or refreshes instead of launching an
   * unrelated session, and this is a selection-time check, not a filesystem snapshot:
   * a foreign OMP writer can still change the file a moment later.
   */
  async function openFolderHistoryCandidate(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    folder: WorkspaceFolder,
    candidate: FolderHistoryCandidate,
    keepLiveView = false,
  ): Promise<void> {
    const commandAt = Date.now();
    const inspection = await inspectSessionFile(candidate.file);
    if (inspection.kind === "missing") {
      showError(`That OMP session file is no longer there: ${inspection.detail}`);
      refreshLauncher();
      return;
    }
    if (inspection.kind === "unreadable") {
      showError(`That OMP session file could not be read: ${inspection.detail}`);
      refreshLauncher();
      return;
    }
    if (inspection.kind === "invalid") {
      showError(`That file is no longer a readable OMP session: ${inspection.detail}`);
      refreshLauncher();
      return;
    }
    const folderKey = canonicalFolderKey(folder.path);
    const headerKey = canonicalFolderKey(inspection.header.cwd);
    if (folderKey === null || headerKey === null || folderKey !== headerKey) {
      showWarning(
        `That OMP session no longer records "${displayFolderPath(folder.path)}" as its working directory, so it was not resumed here. ` +
          `Refresh Sessions, or resume it from the folder it now records.`,
      );
      refreshLauncher();
      return;
    }

    const existing = candidate.tabId === null ? null : index.get(candidate.tabId);
    if (candidate.tabId !== null && existing === null) {
      showWarning("That session is no longer in Sessions. Refresh Sessions and try again.");
      refreshLauncher();
      return;
    }
    // A row the index already holds is never re-registered: it is opened with its own
    // recorded scope, so a session launched with an explicit `--session-dir` keeps
    // writing where it always did. Registration below is therefore always for a file
    // the scan discovered, and there `candidate.sessionDir` is the root OMP was
    // pointed at — a profile root or a custom directory — which is exactly the
    // `--session-dir` that resumes it in place. (An indexed candidate carries `null`
    // for the same field, and `trackSession` re-uses an existing row for a file it
    // already owns without reading this input at all.)
    let entry = existing;
    // A file that has no row but whose conversation does (the row went on in a newer file, or this is the newer file of an
    // older row) opens that row: one conversation is one row.
    if (entry === null) entry = await index.rowOfChain(candidate.file);
    if (entry === null) {
      try {
        entry = await index.trackSession({
          sessionFile: candidate.file,
          cwd: folder.path,
          scope: { profile: candidate.profile, sessionDir: candidate.sessionDir },
        });
      } catch (error) {
        showError(`The OMP session could not be registered: ${messageOf(error)}`);
        refreshLauncher();
        return;
      }
    }

    // One file, one row: whatever row is about to be opened must still stand for the
    // exact file the user chose. A competing import can have registered that file
    // while the picker was open, and `trackSession` returns the row it found — so the
    // check is made on the row itself rather than on the click that produced it.
    //
    // The folder question was answered by the file's own header above and is not
    // asked of the row: an indexed row's recorded working directory can be stale,
    // and the header is the authority on which folder a session belongs to. The
    // index repairs that recorded value from the same header evidence when the row
    // opens, so the launch that follows runs in the folder the user selected rather
    // than in whatever the row remembered.
    if (entry.sessionFile === null || (normalizeSessionIdentityKey(entry.sessionFile) !== normalizeSessionIdentityKey(candidate.file) && (await index.rowOfChain(candidate.file))?.tabId !== entry.tabId)) {
      showWarning(
        "That session file now belongs to a different row in Sessions, so it was not resumed. Refresh Sessions and try again.",
      );
      refreshLauncher();
      return;
    }

    // An already-open session is focused, never re-opened: a second restore of one
    // row is what the index refuses as a duplicate, and a second panel would be a
    // second guest for one seat.
    const openPanel = stateOf(entry.tabId)?.panel ?? null;
    if (openPanel !== null && hostOf(stateOf(entry.tabId)) != null) {
      showInfo(`"${candidateLabel(candidate)}" is already open in this window.`);
      await revealExistingTab(index, entry.tabId, openPanel);
      return;
    }
    log.info(`tab ${entry.tabId}: resumed folder session ${candidate.file} (${candidate.source}) from ${folder.path}`);
    await pendingEntry(entry.tabId, "resume", { origin: "command" }, () => timedLaunch(entry.tabId, "resume", commandAt, () => windowState().sessionFlows.openTab(context, index, entry.tabId, "resumed", "explicit", undefined, false, keepLiveView)));
  }

  /**
   * Bring this window's panel for a tab to the front and record it as active.
   *
   * The user asked for a tab this window already has an editor for, so nothing is
   * created, restored or claimed here: the panel is revealed, the tab is recorded
   * as the active one and the launcher is refreshed.
   */
  async function revealExistingTab(index: SessionIndex, tabId: string, panel: vscode.WebviewPanel): Promise<void> {
    panel.reveal();
    requestSessionRowExpand(tabId);
    await setActiveTab(index, tabId);
    refreshLauncher();
    void revealActiveSession(index);
  }
  return { addWorkspaceFolder, pinWorkspaceFolder, unpinWorkspaceFolder, resumeWorkspaceFolder, revealExistingTab, resumeFromFolderHistory, chooseFolder };
}
