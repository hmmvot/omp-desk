/**
 * File observation evidence of a window (`OMP Desk: Enable/Disable/Show/Delete File Evidence`): the evidence namespaces a session's launches
 * recorded, the read-only observation documents and native diffs shown from them, and the consent, disable and delete flows that change what is
 * stored. Verified facts only: a record is shown when its namespace, launch and session identity agree (ADR-0054 and its amendments).
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { SessionIndex } from "../host/session-index";
import { controlDirectoryOf, controlProcessRecordKey, controlReleaseRecordKey } from "../runtime/local-control";
import type { RecordedControlProcess, RecordedControlRelease } from "../runtime/local-control";
import type { ConversationRecord } from "../runtime/runtime-record";
import { type Logger } from "../shared/logger";
import { createControlRequestId, controlPathEquals, readControlRendezvous } from "../wire/control-protocol";
import { queryControlProcessGeneration } from "../host/control-client";
import { fileEvidenceStoreRoot, observationCallKey, observationCallViews, observationComparisonNotice, observationComparisonTitle, observationDetailLines, observationDocumentPath, observationPathLabel, observationPairs, observationShortStage, observationSummaryLine, observationTextState, observationTokenFromPath, OBSERVATION_DOCUMENT_SCHEME } from "../wire/file-evidence-reader";
import type { ObservationPair, ObservationTextState } from "../wire/file-evidence-reader";
import { NATIVE_FILE_OBSERVATION_DISCLOSURE, NATIVE_FILE_OBSERVATION_DISCLOSURE_ID, deleteNativeFileObservationHistory, disableNativeFileObservationCapture, grantNativeFileObservationConsent, openNativeFileObservationJournal, readNativeFileObservationConsent, readNativeFileObservationDisable, resolveNativeFileObservationStorePaths, restrictNativeFileObservationStorage, revokeNativeFileObservationConsent } from "../wire/native-file-observation-storage";
import type { NativeFileObservationJournal, NativeFileObservationStorePaths } from "../wire/native-file-observation-storage";
import type { NativeFileObservationCallView, NativeFileObservationRecord } from "../wire/native-file-observation";
import type { ControlChannel, ObservationDocumentBinding, TabState, WindowState } from "./window-state";

// Native file observation — read-only evidence
//
// The native producer (`src/omp/file-evidence.ts`, wired into the OMP `-e`
// extension by `src/omp/host-control.ts`) writes content-addressed bytes and a
// bounded journal under this extension's own host-control directory, and only
// after the user records an explicit consent for one workspace and session.
//
// Everything in this section is read-only: it lists committed records, renders
// bounded stored text, and offers a native diff between two observations of one
// path inside exactly one producer binding. It never writes a file inside the
// workspace, never restores anything and never sends stored bytes to a Webview
// (ADR-0007; docs/designs/2026-09-24-native-file-observation-and-reversibility.md).

/** Observations one picker lists; the journal enforces its own tighter bound. */
const OBSERVATION_LIST_LIMIT = 200;

/** How many read-only observation document bindings stay resolvable per window. */
const OBSERVATION_DOCUMENT_LIMIT = 32;

/** Button that grants capture; dismissing the dialog any other way leaves it off. */
const ENABLE_EVIDENCE_LABEL = "Enable observation";

/** Button that deletes one session's stored history. */
const DELETE_SESSION_LABEL = "Delete this session's history";

/** Button that deletes every session namespace this launch recorded. */
const DELETE_LAUNCH_LABEL = "Delete every session of this launch";

const SHOW_OBSERVATION_LABEL = "Show this observation (read-only)";

const COMPARE_OBSERVATION_LABEL = "Compare with the previous observation of this path";

/**
 * Shown when a document no longer has a binding, or its observation is gone.
 *
 * It says what it is not — an empty observation — because a document that simply
 * rendered nothing would be indistinguishable from a file that was empty when it
 * was observed, which the store reports separately.
 */
const OBSERVATION_DOCUMENT_UNAVAILABLE =
  "This observation document cannot be shown: it is no longer resolvable or the stored observation is gone. It is not an empty observation — reopen the list from the OMP Desk file-observation command.";

/** Verified facts of one tab's live control channel; null when it has none yet. */
interface EvidenceLiveChannel {
  readonly slotId: string;
  /** The host-control subsystem's own instance id; not the broker child's identity. */
  readonly instanceId: string;
  /** PID the authenticated channel's binding names. */
  readonly pid: number;
  readonly cwd: string;
  /**
   * PID the OS proved for the server end of the pipe this channel carries, and that
   * process's kernel creation time. Both come from `ControlPeerProof`, which refuses
   * after the channel closes — so this accessor's proof is a *live* one.
   */
  readonly serverPid: number;
  readonly serverCreationTime: string;
}

/** One launch's evidence namespace for one workspace and session. */
interface EvidenceNamespace {
  readonly slotId: string;
  readonly paths: NativeFileObservationStorePaths;
  /** Host-control directory this launch published into. */
  readonly directory: string;
  /** Kernel instance of the launch; null when no verified channel names this slot. */
  readonly processInstanceId: string | null;
  readonly pid: number | null;
  /** Kernel creation time recorded for that pid at launch, when one was recorded. */
  readonly processCreation: string | null;
  /**
   * Set only when *this exact slot* was released by this claim after a confirmed
   * stop. A claim's release speaks for the launch it released and for no other,
   * so it is looked up per slot rather than threaded in from the current tab.
   */
  readonly releaseProof: string | null;
}

interface EvidenceSession {
  readonly tabId: string;
  readonly directory: string;
  readonly sessionId: string;
  /** The launch this window owns first, then older namespaces of the same session. */
  readonly namespaces: readonly EvidenceNamespace[];
}

type EvidenceSessionResult =
  | { readonly ok: true; readonly session: EvidenceSession }
  | { readonly ok: false; readonly reason: string };

/** Positive evidence that one namespace's producer stopped, or why it cannot be shown. */
type ProducerStopProof =
  | { readonly stopped: true; readonly detail: string }
  | { readonly stopped: false; readonly detail: string };

/** The exact launch and session identity one consent grant is bound to. */
interface ConsentBinding {
  readonly namespace: EvidenceNamespace;
  /** Everything that must still agree when the grant is written, and again after. */
  readonly key: string;
}

type ConsentBindingResult =
  | { readonly ok: true; readonly binding: ConsentBinding }
  | { readonly ok: false; readonly reason: string };
/** What the file-evidence commands read of their window and call into. */
export interface FileEvidenceDeps {
  readonly controlOf: (state: { readonly tabId: string | null; } | null | undefined) => ConversationRecord["control"];
  readonly stateOf: (key: string | null) => TabState | undefined;
  readonly messageOf: (error: unknown) => string;
  readonly showInfo: (message: string) => void;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly windowState: () => WindowState;
  readonly log: Logger;
  readonly activeControl: (index: SessionIndex, tabId?: string | null) => ControlChannel | null;
  readonly showWarning: (message: string) => void;
  readonly showError: (message: string) => void;
}

/** The window's file-evidence commands: the namespaces of a session's launches, the read-only observation documents and the consent, disable, show and delete flows. */
export function createFileEvidence(deps: FileEvidenceDeps) {
  const { controlOf, stateOf, messageOf, showInfo, isProcessAlive, windowState, log, activeControl, showWarning, showError } = deps;

  /**
   * The verified facts of one tab's control channel, or `null`.
   *
   * A channel that has not finished its handshake proves no process identity: its
   * accessor throws, and a thrown proof is no proof.
   */
  function liveControlFacts(state: TabState | undefined): EvidenceLiveChannel | null {
    try {
      const client = controlOf(state)?.client ?? null;
      if (client === null) return null;
      const live = client.binding;
      // `peerProof` is read on the same channel: it refuses once the channel has
      // closed, so a retained binding alone can never authorize a fact that claims to
      // be proved by this window.
      const proof = client.peerProof;
      return {
        slotId: live.slotId,
        instanceId: live.instanceId,
        pid: live.pid,
        cwd: live.cwd,
        serverPid: proof.serverPid,
        serverCreationTime: proof.serverCreationTime,
      };
    } catch {
      return null;
    }
  }

  /** Names of the sub-directories of one directory; empty when it cannot be read. */
  async function subdirectories(directory: string): Promise<string[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(directory));
    } catch {
      return [];
    }
    return entries.filter(([, type]) => type === vscode.FileType.Directory).map(([name]) => name);
  }

  /**
   * Every evidence namespace one indexed session can have.
   *
   * The store path is
   * `<control dir>/file-evidence/<owner>/<slot>/<workspace digest>/<session digest>`,
   * so the workspace and session identity constrain the namespace and the launch
   * slot names the producer. The launch this window owns comes first; a namespace
   * written by an earlier launch of the same session, or by a launch this window
   * never recorded (another window, an extension-host reload, a confirmed stop that
   * released its control material), is found by re-deriving each candidate path
   * from exactly the same workspace and session identity and accepting it only when
   * that derivation reproduces the directory that exists. Nothing here reads or
   * writes an observation.
   */
  async function evidenceSession(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    tabId: string,
  ): Promise<EvidenceSessionResult> {
    const entry = index.get(tabId);
    if (entry === null) return { ok: false, reason: "that session is no longer indexed" };
    const ownership = entry.ownership;
    if (ownership === null) return { ok: false, reason: "that session has no claim this window owns" };
    const sessionId = entry.sessionId;
    if (sessionId === null || sessionId.length === 0) {
      return {
        ok: false,
        reason: "the OMP session id for this tab is not known yet, and evidence is bound to that exact id",
      };
    }
    const directory = controlDirectoryOf(context.globalStorageUri.fsPath);
    const live = liveControlFacts(stateOf(tabId));
    // The producer hashed the native process directory into its namespace; the
    // indexed cwd is the directory this window launched that process in.
    const workspaceRoot = live?.cwd ?? entry.cwd;
    const record = context.globalState.get<RecordedControlProcess>(
      controlProcessRecordKey(ownership.ownerGeneration),
    );
    const releases = context.globalState.get<readonly RecordedControlRelease[]>(
      controlReleaseRecordKey(ownership.ownerGeneration),
    ) ?? [];
    const slotIds: string[] = [];
    if (live !== null) slotIds.push(live.slotId);
    if (record !== undefined && !slotIds.includes(record.slotId)) slotIds.push(record.slotId);
    for (const slotId of await discoverEvidenceSlots(directory, workspaceRoot, sessionId)) {
      if (!slotIds.includes(slotId)) slotIds.push(slotId);
    }
    const namespaces: EvidenceNamespace[] = [];
    for (const slotId of slotIds) {
      let paths: NativeFileObservationStorePaths;
      try {
        paths = resolveNativeFileObservationStorePaths({
          storageRoot: fileEvidenceStoreRoot(directory),
          ownerId: slotId,
          slotId,
          workspaceRoot,
          sessionId,
        });
      } catch (error) {
        return { ok: false, reason: `the evidence namespace could not be derived (${messageOf(error)})` };
      }
      const own = live !== null && live.slotId === slotId;
      const recorded = record?.slotId === slotId ? record : null;
      namespaces.push({
        slotId,
        paths,
        directory,
        processInstanceId: own ? live.instanceId : null,
        pid: own ? live.pid : (recorded?.pid ?? null),
        processCreation: own ? live.serverCreationTime : (recorded?.processCreation ?? null),
        releaseProof: releases.find(entry => entry.slotId === slotId)?.releasedAt ?? null,
      });
    }
    if (namespaces.length === 0) {
      return {
        ok: false,
        reason: "no evidence store exists for this workspace and session, so there is nothing to read or delete",
      };
    }
    return { ok: true, session: { tabId, directory, sessionId, namespaces } };
  }

  /**
   * Launch slots with a store directory for exactly this workspace and session.
   *
   * Only names that re-derive to a real namespace are returned, so an unrelated
   * directory in the evidence root can never be read as this session's store.
   */
  async function discoverEvidenceSlots(
    directory: string,
    workspaceRoot: string,
    sessionId: string,
  ): Promise<string[]> {
    const storageRoot = fileEvidenceStoreRoot(directory);
    const slots: string[] = [];
    for (const ownerId of await subdirectories(storageRoot)) {
      for (const slotId of await subdirectories(path.join(storageRoot, ownerId))) {
        let candidate: NativeFileObservationStorePaths;
        try {
          candidate = resolveNativeFileObservationStorePaths({
            storageRoot,
            ownerId,
            slotId,
            workspaceRoot,
            sessionId,
          });
        } catch {
          continue;
        }
        let found: vscode.FileStat | null = null;
        try {
          found = await vscode.workspace.fs.stat(vscode.Uri.file(candidate.sessionDirectory));
        } catch {
          found = null;
        }
        if (found !== null && found.type === vscode.FileType.Directory) slots.push(slotId);
      }
    }
    return slots;
  }

  /** The tab these commands act on: the active one, never another tab's store. */
  function evidenceTabId(index: SessionIndex): string | null {
    const tabId = index.activeTabId;
    if (tabId === null) {
      showInfo("No OMP session is active in this window. Focus the session you mean and run this command again.");
      return null;
    }
    return tabId;
  }

  /**
   * Whether one stored record belongs to this exact namespace.
   *
   * The journal already refuses a record whose workspace/session digests do not
   * match the namespace it was opened with; this adds the producer identity, so a
   * record written by another launch, another window or another session is never
   * presented as this session's evidence.
   */
  function recordMatchesNamespace(record: NativeFileObservationRecord, namespace: EvidenceNamespace): boolean {
    if (record.origin.ownerId !== namespace.paths.ownerId || record.origin.slotId !== namespace.paths.slotId) {
      return false;
    }
    if (namespace.processInstanceId !== null && record.origin.processInstanceId !== namespace.processInstanceId) {
      return false;
    }
    return (
      record.session.sessionId === namespace.paths.sessionId &&
      record.session.workspaceDigest === namespace.paths.workspaceDigest
    );
  }

  /**
   * Whether one namespace's producer is provably gone.
   *
   * Absence of a control record is *not* proof that a producer stopped: control
   * material can be released by a confirmed stop, dropped on an extension-host
   * reload or lost with a crash, while the native process keeps its open journal
   * and can still commit an observation. Only positive evidence is accepted here:
   *
   * - a live verified channel, or a rendezvous record whose process exists, proves
   *   it is running and refuses;
   * - a rendezvous whose process no longer exists, or a recorded process whose pid
   *   no longer exists, or a recorded pid now held by a *different* kernel process
   *   (creation time differs, so the pid was reused), proves the stop;
   * - when no process identity survives at all, only the release this launcher
   *   recorded for *this exact slot* after a confirmed stop proves it — a release
   *   belongs to the launch it released, so another launch's or another window's
   *   namespace is never deleted on this claim's word.
   *
   * Everything else refuses with the exact missing fact, and the bytes stay.
   */
  async function producerStopProof(namespace: EvidenceNamespace): Promise<ProducerStopProof> {
    if (namespace.processInstanceId !== null) {
      return {
        stopped: false,
        detail: `this window still holds a verified control channel to launch slot ${namespace.slotId}`,
      };
    }
    const rendezvous = await readControlRendezvous(namespace.directory, namespace.slotId);
    if (rendezvous !== null) {
      return isProcessAlive(rendezvous.pid)
        ? {
            stopped: false,
            detail: `launch slot ${namespace.slotId} still publishes a live control record for pid ${rendezvous.pid}`,
          }
        : {
            stopped: true,
            detail: `the process that published launch slot ${namespace.slotId} (pid ${rendezvous.pid}) no longer exists`,
          };
    }
    const pid = namespace.pid;
    if (pid === null) {
      return namespace.releaseProof === null
        ? {
            stopped: false,
            detail: `launch slot ${namespace.slotId} has no process identity, no live control record and no release this window recorded, so its producer cannot be proven stopped`,
          }
        : {
            stopped: true,
            detail: `this window released launch slot ${namespace.slotId} after a confirmed stop (${namespace.releaseProof})`,
          };
    }
    if (!isProcessAlive(pid)) {
      return { stopped: true, detail: `the recorded process of launch slot ${namespace.slotId} (pid ${pid}) no longer exists` };
    }
    if (namespace.processCreation === null) {
      return {
        stopped: false,
        detail: `pid ${pid} of launch slot ${namespace.slotId} still exists and no recorded process generation can tell it from a reused pid`,
      };
    }
    let current: string;
    try {
      current = await queryControlProcessGeneration(pid);
    } catch {
      return {
        stopped: false,
        detail: `the process generation of pid ${pid} for launch slot ${namespace.slotId} could not be read, so a reused pid cannot be ruled out`,
      };
    }
    return current === namespace.processCreation
      ? {
          stopped: false,
          detail: `the recorded process of launch slot ${namespace.slotId} (pid ${pid}, generation ${current}) is still running`,
        }
      : {
          stopped: true,
          detail: `pid ${pid} of launch slot ${namespace.slotId} now hosts another process (generation ${current}), so the recorded producer is gone`,
        };
  }

  /**
   * Why deleting this session's stored observations would be unsafe right now, or
   * `null` when every namespace is proven stopped.
   *
   * The proof is re-taken from the current launch and store on every call, so a
   * dialog that stayed open across a launch or a release cannot make a stale answer
   * stand. It shows no UI and deletes nothing; the delete command calls it before
   * the confirmation dialog and again afterwards.
   */
  async function fileEvidenceDeletionRefusal(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    tabId: string,
  ): Promise<string | null> {
    const resolved = await evidenceSession(context, index, tabId);
    if (!resolved.ok) return resolved.reason;
    // The proof of a still-running producer reads its kernel generation with the
    // staged PowerShell helper: stage it first, so a delete right after activation
    // answers from a real probe instead of refusing because no helper is configured
    // yet. A staging failure is left to that refusal, which reports it.
    await windowState().staging.entries().catch(() => {});
    for (const namespace of resolved.session.namespaces) {
      const proof = await producerStopProof(namespace);
      if (!proof.stopped) {
        log.warn(`file observation delete refused: ${proof.detail}`);
        return "A session may still be recording file changes. Stop it before deleting its observations.";
      }
    }
    return null;
  }

  /** Whether capture is on for this session, as the store itself reports it. */
  async function observationCaptureState(session: EvidenceSession): Promise<string> {
    const first = session.namespaces[0];
    if (first === undefined) return "no evidence store exists for this workspace and session";
    const disabled = await readNativeFileObservationDisable({ paths: first.paths });
    if (disabled.disabled) {
      return `capture is disabled for this workspace (${disabled.reason ?? "no reason recorded"})`;
    }
    const consent = await readNativeFileObservationConsent({ paths: first.paths });
    return consent.state === "granted" ? "capture is enabled for this session" : `capture is off (${consent.reason})`;
  }

  /** Register one opaque document binding and return the editor URI for it. */
  function observationDocumentUri(
    stage: NativeFileObservationRecord["stage"],
    binding: ObservationDocumentBinding,
  ): vscode.Uri {
    const s = windowState();
    const token = createControlRequestId();
    const uri = vscode.Uri.from({
      scheme: OBSERVATION_DOCUMENT_SCHEME,
      path: observationDocumentPath(token, stage),
    });
    s.observationDocuments.set(token, { uri, binding });
    while (s.observationDocuments.size > OBSERVATION_DOCUMENT_LIMIT) {
      const oldest = s.observationDocuments.keys().next();
      if (oldest.done) break;
      s.observationDocuments.delete(oldest.value);
    }
    return uri;
  }

  /** Ask every open observation document to re-read the store. */
  function refreshObservationDocuments(): void {
    const s = windowState();
    for (const entry of s.observationDocuments.values()) s.observationDocumentChanges.fire(entry.uri);
  }

  function tabShowsObservationDocument(tab: vscode.Tab): boolean {
    const input = tab.input;
    if (input instanceof vscode.TabInputText) return input.uri.scheme === OBSERVATION_DOCUMENT_SCHEME;
    if (input instanceof vscode.TabInputTextDiff) {
      return (
        input.original.scheme === OBSERVATION_DOCUMENT_SCHEME ||
        input.modified.scheme === OBSERVATION_DOCUMENT_SCHEME
      );
    }
    return false;
  }

  /**
   * Close the observation documents this window opened.
   *
   * An editor tab holds its own copy of whatever the provider last returned, so a
   * deletion that left tabs open would leave readable copies of deleted bytes on
   * screen. They are read-only, so closing one never discards user work.
   */
  async function closeObservationDocuments(): Promise<void> {
    const ours: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) if (tabShowsObservationDocument(tab)) ours.push(tab);
    }
    if (ours.length > 0) await vscode.window.tabGroups.close(ours, true);
  }

  /** The read-only body of one observation document, resolved from the store. */
  async function renderObservationDocument(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    binding: ObservationDocumentBinding,
  ): Promise<string> {
    const resolved = await evidenceSession(context, index, binding.tabId);
    if (!resolved.ok) return OBSERVATION_DOCUMENT_UNAVAILABLE;
    for (const namespace of resolved.session.namespaces) {
      const reader = await openNativeFileObservationJournal({ paths: namespace.paths, mode: "reader" });
      try {
        const read = await reader.read(binding.recordId);
        if (!read.available || !recordMatchesNamespace(read.record, namespace)) continue;
        const text = observationTextState(read.record, read);
        if (binding.kind === "side") {
          // A diff side is the stored text only: an observation with no validated
          // text is never rendered as an empty file.
          return text.text ?? OBSERVATION_DOCUMENT_UNAVAILABLE;
        }
        const listed = await reader.list({ limit: OBSERVATION_LIST_LIMIT });
        const view = observationCallViews(listed.records).get(observationCallKey(read.record)) ?? null;
        return renderObservationDetail(read.record, view, text);
      } finally {
        await reader.close().catch(() => {});
      }
    }
    return OBSERVATION_DOCUMENT_UNAVAILABLE;
  }

  /**
   * Body of one observation document, re-validated on every request.
   *
   * The token is only a binding: the namespace is re-derived from the current
   * launch, the store is re-opened read-only, and the record and its bytes are
   * re-read and re-validated. A document whose observation was deleted, replaced or
   * corrupted therefore reports that, instead of serving the copy a cache kept.
   */
  async function observationDocumentContent(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    uriPath: string,
  ): Promise<string> {
    const s = windowState();
    const token = observationTokenFromPath(uriPath);
    const entry = token === null ? undefined : s.observationDocuments.get(token);
    if (entry === undefined) return OBSERVATION_DOCUMENT_UNAVAILABLE;
    try {
      return await renderObservationDocument(context, index, entry.binding);
    } catch {
      // A store that cannot be read is reported as unavailable, never as empty.
      return OBSERVATION_DOCUMENT_UNAVAILABLE;
    }
  }

  /**
   * What a reader sees before any byte: provenance, the journal's verdict on the
   * call and the fixed limits of the evidence, then the stored text unchanged.
   */
  function renderObservationDetail(
    record: NativeFileObservationRecord,
    view: NativeFileObservationCallView | null,
    text: ObservationTextState,
  ): string {
    return [
      `File observation — ${observationPathLabel(record)}`,
      ...observationDetailLines(record, view === null ? null : view.resolution, text),
      "",
      text.text === null ? "(no stored text is shown for this observation)" : text.text,
    ].join("\n");
  }

  async function openObservationDocument(
    stage: NativeFileObservationRecord["stage"],
    binding: ObservationDocumentBinding,
  ): Promise<void> {
    const document = await vscode.workspace.openTextDocument(observationDocumentUri(stage, binding));
    await vscode.window.showTextDocument(document, { preview: true });
  }

  /** A native diff of two validated observations of one path inside one binding. */
  async function compareObservationPair(
    tabId: string,
    journal: NativeFileObservationJournal,
    pair: ObservationPair,
  ): Promise<void> {
    const [previousRead, currentRead] = await Promise.all([
      journal.read(pair.previous.recordId),
      journal.read(pair.current.recordId),
    ]);
    const previous = observationTextState(pair.previous, previousRead);
    const current = observationTextState(pair.current, currentRead);
    const notice = observationComparisonNotice(previous, current);
    if (notice !== null || previous.text === null || current.text === null) {
      // An absent, binary, oversize or unreadable side is never diffed as if it
      // were empty: the notice says which side has no validated stored text.
      showInfo(notice ?? OBSERVATION_DOCUMENT_UNAVAILABLE);
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.diff",
      observationDocumentUri(pair.previous.stage, { tabId, recordId: pair.previous.recordId, kind: "side" }),
      observationDocumentUri(pair.current.stage, { tabId, recordId: pair.current.recordId, kind: "side" }),
      observationComparisonTitle(pair),
    );
  }

  /**
   * The live binding a consent record may be written for, re-derived on demand.
   *
   * A consent record is per workspace and session, and capture is owned by the
   * native process hosting that session, so the grant must name exactly the tab,
   * claim, verified control channel and store that exist *now*: the active tab, its
   * claim generation, the indexed session id and cwd, and the authenticated
   * binding's slot, instance, pid and session file. Nothing about this can be made
   * atomic against a native session switch — the observer binds capture to the
   * session id it sees per stage — so the caller re-derives this identity before
   * the disclosure and again before the grant, and refuses on any difference.
   */
  async function consentBinding(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    tabId: string,
  ): Promise<ConsentBindingResult> {
    if (index.activeTabId !== tabId) {
      return { ok: false, reason: "the active session changed while this command was running" };
    }
    const channel = activeControl(index);
    if (channel === null || channel.tabId !== tabId) {
      return { ok: false, reason: "the verified host-control channel for this session is no longer available" };
    }
    const entry = index.get(tabId);
    const ownership = entry?.ownership ?? null;
    if (entry === null || ownership === null) {
      return { ok: false, reason: "that session no longer holds the claim this window would record consent under" };
    }
    const resolved = await evidenceSession(context, index, tabId);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const namespace = resolved.session.namespaces.find(candidate => candidate.processInstanceId !== null);
    if (namespace === undefined) {
      return { ok: false, reason: "no verified native host is identified for this session right now" };
    }
    let live: EvidenceLiveChannel;
    let sessionFile: string | null;
    try {
      const binding = channel.client.binding;
      // `peerProof` refuses once the channel is closed, so this branch proves a live
      // channel rather than a retained one.
      const proof = channel.client.peerProof;
      live = {
        slotId: binding.slotId,
        instanceId: binding.instanceId,
        pid: binding.pid,
        cwd: binding.cwd,
        serverPid: proof.serverPid,
        serverCreationTime: proof.serverCreationTime,
      };
      sessionFile = binding.sessionFile;
    } catch {
      return { ok: false, reason: "the host-control channel has not completed its handshake" };
    }
    if (namespace.slotId !== live.slotId) {
      return { ok: false, reason: "the store does not belong to the native process this window authenticated" };
    }
    return {
      ok: true,
      binding: {
        namespace,
        key: [
          tabId,
          ownership.ownerGeneration,
          entry.sessionId ?? "",
          namespace.paths.sessionDirectory,
          live.slotId,
          live.instanceId,
          String(live.pid),
          sessionFile ?? "",
        ].join("\u0000"),
      },
    };
  }

  /**
   * Record explicit consent for this workspace and this session.
   *
   * The restricted store access rules are established and independently verified
   * before the consent record exists (ADR-0007), the full disclosure — including
   * that a snapshot taken before a tool runs can preserve bytes of an operation
   * the user later denies — is shown before any approval, and only the explicit
   * button grants capture. The tab, claim and authenticated host are re-checked
   * after the access rewrite and again after the dialog, so a session the user
   * switched to in the meantime never receives a consent record.
   */
  async function enableFileEvidence(context: vscode.ExtensionContext, index: SessionIndex): Promise<void> {
    const tabId = evidenceTabId(index);
    if (tabId === null) return;
    const start = await consentBinding(context, index, tabId);
    if (!start.ok) {
      showWarning(`File observation cannot be enabled: ${start.reason}.`);
      return;
    }
    const restricted = await restrictNativeFileObservationStorage({ paths: start.binding.namespace.paths });
    const readiness = restricted.readiness;
    if (!restricted.restricted || readiness === null || !readiness.ready) {
      showError(
        `File observation stayed off: ${
          restricted.reason ?? readiness?.reason ?? "the observation store could not be verified"
        }.`,
      );
      return;
    }
    // The access rewrite read and rewrote the store's own directories; the session may have moved on since.
    const before = await consentBinding(context, index, tabId);
    if (!before.ok) {
      showWarning(`File observation stayed off: ${before.reason}.`);
      return;
    }
    if (before.binding.key !== start.binding.key) {
      showWarning(
        "File observation stayed off: the session or its native host changed while the store was being prepared, so no consent was recorded. Run the command again.",
      );
      return;
    }
    const namespace = before.binding.namespace;
    const disabled = await readNativeFileObservationDisable({ paths: namespace.paths });
    log.info(`file observation consent: session ${namespace.paths.sessionId}, pid ${namespace.pid ?? "unknown"}, access ${readiness.evidence.join("; ")}`);
    const detail = [
      ...NATIVE_FILE_OBSERVATION_DISCLOSURE,
      "",
      `Workspace: ${namespace.paths.workspaceRoot}`,
      `Store: ${namespace.paths.storageRoot}`,
      ...(disabled.disabled
        ? [
            "",
            `Capture was disabled for this workspace${
              disabled.atMs === null ? "" : ` on ${new Date(disabled.atMs).toISOString()}`
            }${disabled.reason === null ? "" : ` (${disabled.reason})`}. Enabling here lifts that disable marker.`,
          ]
        : []),
    ].join("\n");
    const picked = await vscode.window.showWarningMessage(
      "OMP Desk: Store file observations for this workspace and session?",
      { modal: true, detail },
      ENABLE_EVIDENCE_LABEL,
    );
    if (picked !== ENABLE_EVIDENCE_LABEL) {
      showInfo("File observation stays off; no consent was recorded and no byte was stored.");
      return;
    }
    // The dialog can stay open across a session switch or a relaunch in the native
    // TUI, so the grant is written only for the identity that still holds.
    const grantedFor = await consentBinding(context, index, tabId);
    if (!grantedFor.ok) {
      showWarning(`File observation stayed off: ${grantedFor.reason}.`);
      return;
    }
    if (grantedFor.binding.key !== start.binding.key) {
      showWarning(
        "File observation stayed off: the session or its native host changed while the confirmation was open, so no consent was recorded for it. Run the command again on the session you mean.",
      );
      return;
    }
    const granted = await grantNativeFileObservationConsent({
      paths: grantedFor.binding.namespace.paths,
      disclosureId: NATIVE_FILE_OBSERVATION_DISCLOSURE_ID,
      preApprovalCaptureAcknowledged: true,
      ...(disabled.disabled ? { allowReEnable: true } : {}),
    });
    if (!granted.granted) {
      showError(`File observation stayed off: ${granted.reason ?? "the consent record was not stored"}.`);
      return;
    }
    log.info(`file observation enabled for session namespace ${grantedFor.binding.namespace.paths.sessionDigest}`);
    showInfo(
      "File observation is enabled for this session. Recorded observations are read-only evidence: no undo, redo, rollback or checkpoint restore is offered from them.",
    );
  }

  /**
   * Stop capture for this workspace, durably.
   *
   * The disable marker sits above the session namespace of each launch, so new
   * stages on a running native host refuse capture and the stop survives an
   * extension-host reload. A publication already underway may still finish:
   * deletion therefore requires a confirmed stopped producer. The launcher's own
   * consent records are removed too, so later enablement is deliberate.
   * Stored history is untouched until separately deleted.
   */
  async function disableFileEvidence(context: vscode.ExtensionContext, index: SessionIndex): Promise<void> {
    const tabId = evidenceTabId(index);
    if (tabId === null) return;
    const resolved = await evidenceSession(context, index, tabId);
    if (!resolved.ok) {
      showWarning(`File observation cannot be disabled: ${resolved.reason}.`);
      return;
    }
    const session = resolved.session;
    let failed: string | null = null;
    for (const namespace of session.namespaces) {
      const disabled = await disableNativeFileObservationCapture({
        paths: namespace.paths,
        reason: "disabled from the Sessions view",
      });
      if (!disabled.disabled) failed = disabled.detail ?? "the disable marker was not written";
    }
    if (failed !== null) {
      showError(`File observation could not be disabled: ${failed}.`);
      return;
    }
    let revoked = 0;
    for (const entry of index.list()) {
      if (entry.sessionId === null || !controlPathEquals(entry.cwd, session.namespaces[0]?.paths.workspaceRoot ?? "")) {
        continue;
      }
      const other = await evidenceSession(context, index, entry.tabId);
      if (!other.ok) continue;
      for (const namespace of other.session.namespaces) {
        const result = await revokeNativeFileObservationConsent({ paths: namespace.paths });
        if (result.revoked) revoked += 1;
      }
    }
    log.info(
      `file observation disabled for ${session.namespaces.length} namespace(s); ${revoked} consent record(s) revoked`,
    );
    // Open documents re-read the store: disabling keeps retained history, so they
    // must show the retained evidence rather than a stale rendering.
    refreshObservationDocuments();
    showInfo(
      `File observation is disabled for new capture stages, and a future launch of this session starts with no consent (${revoked} consent record(s) removed). An already-started publication may still finish; stop the native host before deleting retained history. Open observation documents were refreshed.`,
    );
  }

  /** Show the session's stored observations as read-only text and native diffs. */
  async function showFileEvidence(context: vscode.ExtensionContext, index: SessionIndex): Promise<void> {
    const tabId = evidenceTabId(index);
    if (tabId === null) return;
    const resolved = await evidenceSession(context, index, tabId);
    if (!resolved.ok) {
      showWarning(`File observations are unavailable: ${resolved.reason}.`);
      return;
    }
    const session = resolved.session;
    const readers = new Map<string, NativeFileObservationJournal>();
    try {
      const records: NativeFileObservationRecord[] = [];
      let rejected = 0;
      let truncated = false;
      for (const namespace of session.namespaces) {
        const reader = await openNativeFileObservationJournal({ paths: namespace.paths, mode: "reader" });
        readers.set(namespace.slotId, reader);
        const listed = await reader.list({ limit: OBSERVATION_LIST_LIMIT });
        rejected += listed.rejected;
        truncated = truncated || listed.truncated;
        for (const record of listed.records) {
          if (recordMatchesNamespace(record, namespace)) records.push(record);
        }
      }
      if (records.length === 0) {
        const unvalidated = rejected === 0 ? "" : ` ${rejected} stored record(s) did not validate and are not shown.`;
        showInfo(
          `No file observation is recorded for this session: ${await observationCaptureState(session)}.${unvalidated}`,
        );
        return;
      }
      records.sort((left, right) => right.sequence - left.sequence || right.observedAtMs - left.observedAtMs);
      const pairByCurrent = new Map<string, ObservationPair>();
      for (const pair of observationPairs(records)) pairByCurrent.set(pair.current.recordId, pair);
      const picked = await vscode.window.showQuickPick(
        records.map(record => ({
          label: `${observationPathLabel(record)} — ${observationShortStage(record.stage)}`,
          description: observationSummaryLine(record),
          detail: `tool ${record.toolCall.toolName}, call ${record.toolCall.toolCallId}, reported outcome ${record.toolOutcome}`,
          record,
        })),
        {
          title: `File observations recorded for this session (${records.length})`,
          placeHolder: `Read-only evidence${
            truncated ? `, newest ${OBSERVATION_LIST_LIMIT} shown` : ""
          }; no restore is offered`,
        },
      );
      if (picked === undefined) return;
      const record = picked.record;
      const reader = readers.get(record.origin.slotId);
      if (reader === undefined) return;
      const pair = pairByCurrent.get(record.recordId) ?? null;
      const actions = pair === null ? [SHOW_OBSERVATION_LABEL] : [SHOW_OBSERVATION_LABEL, COMPARE_OBSERVATION_LABEL];
      const action = await vscode.window.showQuickPick(actions, { title: observationPathLabel(record) });
      if (action === undefined) return;
      if (action === COMPARE_OBSERVATION_LABEL && pair !== null) {
        await compareObservationPair(session.tabId, reader, pair);
        return;
      }
      await openObservationDocument(record.stage, {
        tabId: session.tabId,
        recordId: record.recordId,
        kind: "detail",
      });
    } catch (error) {
      showWarning(`File observations could not be read: ${messageOf(error)}.`);
    } finally {
      for (const reader of readers.values()) await reader.close().catch(() => {});
    }
  }

  /**
   * Delete retained history for this session, or for every session of the launches
   * that recorded it.
   *
   * Every namespace must be proven stopped before anything is removed: the store
   * cannot be locked against its own producer and a stage already past its gate can
   * still commit one observation, so promising erasure while a process might still
   * publish would be a false statement. The proofs are re-taken after the
   * confirmation dialog, because the answer can change while it is open; a
   * namespace whose producer cannot be proven stopped keeps its bytes and is named
   * in the refusal.
   */
  async function deleteFileEvidence(context: vscode.ExtensionContext, index: SessionIndex): Promise<void> {
    const tabId = evidenceTabId(index);
    if (tabId === null) return;
    const refused = await fileEvidenceDeletionRefusal(context, index, tabId);
    if (refused !== null) {
      showWarning(
        `Refusing to delete stored observations: ${refused}. One more observation could still be stored, so nothing was removed. Stop that native host (close its terminal, or end that exact process) and run this again.`,
      );
      return;
    }
    const resolved = await evidenceSession(context, index, tabId);
    if (!resolved.ok) {
      showWarning(`File observations cannot be deleted: ${resolved.reason}.`);
      return;
    }
    const session = resolved.session;
    const detail = [
      `Session store(s): ${session.namespaces.map(namespace => namespace.paths.sessionDirectory).join(", ")}`,
      `All observations for these folders: ${session.namespaces
        .map(namespace => namespace.paths.workspaceDirectory)
        .join(", ")}`,
      "The sessions that recorded these observations have stopped.",
      "Their recording permissions are removed with the stored content, so recording does not resume automatically.",
      "Open observation documents are closed with the deletion, because an editor tab holds its own copy of what it displayed.",
      "Removal is an ordinary file-system delete, not a secure erase of the underlying storage.",
    ].join("\n");
    const picked = await vscode.window.showWarningMessage(
      "OMP Desk: Delete stored file observations?",
      { modal: true, detail },
      DELETE_SESSION_LABEL,
      DELETE_LAUNCH_LABEL,
    );
    if (picked !== DELETE_SESSION_LABEL && picked !== DELETE_LAUNCH_LABEL) {
      showInfo("Nothing was deleted.");
      return;
    }
    // The dialog can stay open while a host is launched, a claim is released or the
    // window's active session changes, so the target and the proofs are re-taken
    // rather than trusted from before it.
    if (index.activeTabId !== tabId) {
      showWarning(
        "Refusing to delete stored observations: the active session changed while the confirmation was open. Nothing was removed.",
      );
      return;
    }
    const changed = await fileEvidenceDeletionRefusal(context, index, tabId);
    if (changed !== null) {
      showWarning(`Refusing to delete stored observations: ${changed}. Nothing was removed.`);
      return;
    }
    const confirmed = await evidenceSession(context, index, tabId);
    if (!confirmed.ok) {
      showWarning(`Refusing to delete stored observations: ${confirmed.reason}.`);
      return;
    }
    const scope = picked === DELETE_LAUNCH_LABEL ? "workspace" : "session";
    let records = 0;
    let blobs = 0;
    let namespaces = 0;
    let revoked = false;
    let failure: string | null = null;
    for (const namespace of confirmed.session.namespaces) {
      const result = await deleteNativeFileObservationHistory({
        paths: namespace.paths,
        scope,
        revokeConsent: true,
        keepDisableMarker: true,
      });
      records += result.removedRecords;
      blobs += result.removedBlobs;
      namespaces += result.removedNamespaces;
      revoked = revoked || result.revokedConsent;
      if (result.detail !== null) failure = result.detail;
    }
    // An open editor holds its own copy of what the provider last returned, so the
    // documents this window opened are closed and refreshed instead of left showing
    // bytes that no longer exist.
    await closeObservationDocuments();
    refreshObservationDocuments();
    const removed = `removed ${records} record(s) and ${blobs} stored blob(s) across ${namespaces} namespace(s)`;
    if (failure !== null) {
      showWarning(`File observations were ${removed}, but the store reported: ${failure}.`);
      return;
    }
    log.info(`file observations deleted (${scope}): ${removed}`);
    showInfo(
      `File observations deleted: ${removed}.${
        revoked ? " Their consent records were removed as well." : ""
      } Open observation documents were closed.`,
    );
  }
  return { enableFileEvidence, disableFileEvidence, showFileEvidence, deleteFileEvidence, observationDocumentContent };
}
