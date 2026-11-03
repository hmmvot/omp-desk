/**
 * The diagnostics report of a window (`OMP Desk: Show Diagnostics`): a read-only document that re-probes on every request, the environment
 * facts of this extension host and the refresh of the report's session subjects.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { ActivationTimer } from "../host/activation-timing";
import { createHtmlPageServer } from "../host/html-page-server";
import { installedNerdFonts } from "../host/terminal-fonts";
import { terminalFontFamily } from "../shared/terminal-theme";
import type { LoginFlowDeps } from "../host/provider-login-flow";
import { createHelperSlots } from "../host/helper-slots";
import { observeSessionBranch } from "../host/session-branch";
import type { FooterMetadataMessage } from "../shared/footer-metadata";
import { relativeAge } from "../shared/relative-age";
import type { SessionsGrouping } from "../views/session-order";
import { useSynchronousLocalFs } from "../wire/local-fs";
import { synchronousLocalPaths } from "../wire/private-storage";
import { startFsTurnaroundProbe } from "../host/fs-turnaround";
import { startChatRuntimeWarmup } from "../host/chat-runtime-warmup";
import { SessionIndex } from "../host/session-index";
import { isManagedHost } from "../host/session-model";
import type { LauncherWindow } from "../runtime/local-launcher";
import { LocalExitOperations } from "../runtime/local-exit";
import type { ExitWindow } from "../runtime/local-exit";
import { LocalIdentity } from "../runtime/local-identity";
import type { IdentityWindow } from "../runtime/local-identity";
import { LocalNativeWatch } from "../runtime/local-native-watch";
import { LocalKill } from "../runtime/local-kill";
import type { KillWindow } from "../runtime/local-kill";
import type { NativeWatchWindow } from "../runtime/local-native-watch";
import type { RuntimeRecord } from "../runtime/runtime-record";
import { createRuntimeStaging } from "../runtime/runtime-entries";
import { timedStep } from "../host/session-restore-trace";
import type { RestorePassPhases } from "../host/session-restore-trace";
import { runNativeStage } from "../runtime/native-stage-client";
import { LocalSessionRuntime } from "../runtime/local-runtime";
import type { LocalSessionRuntimeDeps } from "../runtime/local-runtime";
import { LocalWriterVerifier } from "../runtime/local-writer";
import { LocalTransitions } from "../runtime/local-transition";
import { RuntimeRecords } from "../runtime/runtime-record";
import type { ConversationRecord } from "../runtime/runtime-record";
import type { TransitionWindow } from "../runtime/local-transition";
import { type Logger } from "../shared/logger";
import { PendingDisplay } from "../host/pending-display";
import { observeLaunchSteps } from "../host/pending-steps";
import type { LaunchReadiness } from "../host/pending-operations";
import { pendingDisplayShell } from "./pending-shell";
import { PersistFailureReporter } from "../host/persist-report";
import { holderSeemsAlive } from "../host/holder-liveness";
import { PageHealthMonitor } from "../host/page-health";
import { WindowRegistry } from "../host/window-registry";
import { warmNativeAsset } from "../host/native-proof";
import { nativeTroubleshootingAnchor } from "../wire/native-module-failure";
import { quoteHunkOf } from "./quote-hunk";
import { quoteSourceOf } from "./quote-source";
import { composePreviewQuote } from "./preview-quote";
import type { PreviewDocument } from "./preview-quote";
import type { ActivePreview } from "./preview-selection";
import { sendDesktopNotification } from "../host/desktop-notifications";
import { notificationLine } from "../shared/notification-text";
import { NativeActivityLedger } from "../wire/native-activity";
import { PackageDrift } from "../host/package-drift";
import { DIAGNOSTICS_DOCUMENT_PATH, WINDOW_DIAGNOSTIC_SUBJECT, redactCapabilities } from "../host/diagnostics";
import type { DiagnosticEnvironment, DiagnosticStageId } from "../host/diagnostics";
import { ProcessTreeItem } from "../views/process-rows";
import { registerInventoryViews } from "./inventory-wiring";
import { registerContextView } from "./context-wiring";
import { registerUsageStatus } from "./usage-status-wiring";
import { registerCodeTheme } from "./code-theme-wiring";
import { registerKeyHints } from "./key-hints-wiring";
import { createFileWindow } from "./file-window";
import { registerSessionActions } from "./session-actions";
import { adoptSessionTitle } from "./session-title";
import type { SessionActionsDeps } from "./session-actions";
import { registerRecentSessions } from "./recent-sessions";
import { registerArtifactDocuments } from "./artifact-documents";
import { registerSessionFileDocuments } from "./session-file-documents";
import { registerBridgeHost } from "./bridge-host";
import type { BridgeHostDeps } from "./bridge-host";
import { registerDeskSettingsView } from "./desk-settings-view";
import type { SessionToolsTarget } from "../host/session-tools";
import { LauncherFolders } from "../views/launcher-folders";
import { SessionFolderResolver } from "../wire/session-folder";
import { displayFolderPath } from "../host/folder-display";
import type { LauncherFolder } from "../views/launcher-folders";
import { ChatRuntime } from "../host/chat-runtime";
import { activateAgentDebugger } from "../host/debug/index";
import { PendingForks } from "../host/pending-forks";
import { FORK_REFUSAL_SENTENCES } from "../chat/fork";
import type { SessionHostRuntime } from "../host/native-session";
import { NAVIGATE_REFUSAL_SENTENCES } from "../chat/rewind";
import type { TurnActivityReport } from "../protocol/activity";
import { STATE_UNCONFIRMED_REASON } from "../protocol/rpc";
import { BridgeAdmissionError } from "../host/bridge-route";
import { EditorCoordinator } from "../host/editor-coordinator";
import { tabInputIdentity } from "../host/bridge-identity";
import { EDITOR_GROUP_FOCUS_COMMANDS } from "../host/chat-layout";
import { selectEditorTab as selectEditorTabThrough } from "../host/editor-tab-selection";
import type { TabSelectionApi } from "../host/editor-tab-selection";
import { PtyBrokerClient } from "../host/pty-client";
import { ptyStateDirectory } from "../wire/pty-registry";
import { ptyRecordedTreeDigestFile } from "../host/pty-runtime";
import { createPtyReadinessGate } from "../host/pty-readiness";
import { createEditorSlotRegistry } from "../host/editor-slots";
import type { EditorSlotRole } from "../host/editor-slots";
import type { BrokerSlotProvenance } from "../host/broker-slots";
import type { PtyHandle } from "../host/pty-client";
import { TerminalPipeline } from "../host/terminal-pipeline";
import type { TerminalHostMessage } from "../host/terminal-pipeline";
import { searchSymbol } from "../host/symbol-search";
import { FileEventGate } from "../host/link-watch";
import { handleInternalLink } from "../host/internal-links";
import { handleCommitLink } from "../host/commit-links";
import { createCommitLinkResolver } from "./commit-links";
import { parseCommitLinkTarget } from "../shared/commit-links";
import { handleLinkRuleOpen } from "../host/link-rules";
import type { LinkRuleSource } from "../host/link-rules";
import { createWindowLinkRules } from "./link-rules";
import { showDeskCommands } from "./palette-commands";
import { parseInternalLink } from "../shared/internal-links";
import { watchBrokerLoss } from "../host/broker-loss";
import { setTimeout as delayMs } from "node:timers/promises";
import { openProfileCatalog } from "./catalog-recovery";
import type { OpenedCatalog } from "./catalog-recovery";
import { importPredecessorFolders } from "./predecessor-import";
import { registerCatalogAdoption } from "./catalog-adoption";
import { registerSessionFlows } from "./session-flows";
import { migrateLegacySettings } from "./legacy-settings";
import { migrateSessionFolderSettings } from "./session-folder-settings";
import { editorProjectFolder } from "../host/session-folder-setting";
import { fileClaim } from "./legacy-settings-claim";
import type { LegacySettingsPort } from "./legacy-settings";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { registerSettingsEditors } from "./settings-editors";
import type { SettingsEditorContext } from "../host/omp-settings-editor";
import { SETTINGS_APPLY_NOT_LIVE } from "../host/omp-settings-apply";
import { folderShellOwnerHint } from "../host/shell-owner";
import type { PtyOwnerHint } from "../wire/pty-protocol";
import type { ControlModelRef } from "../protocol/control";
import type { ControlHostSnapshot } from "../wire/control-protocol";
import type { WindowState } from "./window-state";

// Startup and performance diagnostics
//
// `OMP Desk: Show Diagnostics` renders one extension-owned, read-only document from
// measurements this window already took while launching and attaching sessions.
// Nothing in this section starts a process, probes OMP, changes a setting or
// warms anything to produce a number: it records what happened, marks every
// stage it did not observe as such, and never carries a secret or a bearer
// capability — no host-control key and no bridge secret.
// `src/host/diagnostics.ts` owns the recording rules and the redaction; this
// section only supplies the observations and the environment.

/** Diagnostics document scheme; the provider answers only the fixed report path. */
export const DIAGNOSTICS_DOCUMENT_SCHEME = "omp-diagnostics";
/** What the diagnostics report reads of its window and calls into. */
export interface SessionDiagnosticsDeps {
  readonly windowState: () => WindowState;
  readonly hostOf: (state: { readonly tabId: string | null; } | null | undefined) => SessionHostRuntime | null;
  readonly controlOf: (state: { readonly tabId: string | null; } | null | undefined) => ConversationRecord["control"];
  readonly recordOf: (state: { readonly tabId: string | null; } | null | undefined) => ConversationRecord | undefined;
  readonly log: Logger;
  readonly showError: (message: string) => void;
  readonly messageOf: (error: unknown) => string;
}

/** The window's read-only diagnostics report: its document, its environment facts and the refresh of its subjects. */
export function createSessionDiagnostics(deps: SessionDiagnosticsDeps) {
  const { windowState, hostOf, controlOf, recordOf, log, showError, messageOf } = deps;

  function diagnosticsUri(): vscode.Uri {
    return vscode.Uri.from({ scheme: DIAGNOSTICS_DOCUMENT_SCHEME, path: DIAGNOSTICS_DOCUMENT_PATH });
  }

  /** The one-line description of a session tab this report uses. */
  function diagnosticsLabel(cwd: string): string {
    return `OMP: ${path.basename(cwd)}`;
  }

  /**
   * Whether one stage already holds a measurement — a duration this window
   * actually observed. A stage that is still running, or that was recorded as
   * unobserved, is not measured yet.
   */
  function diagnosticsStageMeasured(tabId: string, stageId: DiagnosticStageId): boolean {
    const s = windowState();
    const stage = s.diagnostics.snapshot(tabId)?.stages.find(current => current.id === stageId);
    return stage !== undefined && stage.durationMs !== null;
  }

  /** The verifiable environment facts of this extension host. */
  function diagnosticsEnvironment(context: vscode.ExtensionContext): DiagnosticEnvironment {
    const pkg: unknown = context.extension.packageJSON;
    const version = typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, "version") : undefined;
    return {
      extensionVersion: typeof version === "string" && version.length > 0 ? version : "unknown",
      vscodeVersion: vscode.version,
      platform: `${process.platform} ${process.arch}`,
      hostPid: process.pid,
      storagePath: context.globalStorageUri.fsPath,
    };
  }

  /**
   * Refresh the facts that change while a host lives: the exact command it was
   * launched from, the conversation's phase and whether host control is verified.
   * Every value is a non-secret identity.
   */
  function refreshSessionDiagnostics(index: SessionIndex): void {
    const s = windowState();
    const recorded = new Set(s.diagnostics.subjects().map(subject => subject.key));
    let resolvedTarget = false;
    for (const [tabId, state] of s.tabs) {
      if (!recorded.has(tabId)) continue;
      const runtime = hostOf(state);
      if (runtime === null) continue;
      const target = runtime.binary;
      if (target !== null) {
        resolvedTarget = true;
        s.diagnostics.fact(tabId, "omp target", `${target.command} ${target.prefixArgs.join(" ")}`.trim());
        s.diagnostics.fact(tabId, "omp target origin", target.origin);
        if (typeof target.version === "string") s.diagnostics.fact(tabId, "omp reported version", target.version);
      }
      s.diagnostics.fact(tabId, "host pid", String(runtime.pid));
      s.diagnostics.fact(
        tabId,
        "broker",
        `slot ${runtime.identity.slot} · generation ${runtime.identity.brokerGeneration} · pid ${runtime.identity.brokerPid}`,
      );
      s.diagnostics.fact(tabId, "chat phase", s.sessionRuntime.conversations.stateOf(tabId)?.phase ?? "no conversation");
      s.diagnostics.fact(
        tabId,
        "host control",
        controlOf(state) !== null
          ? "verified"
          : `unavailable${(recordOf(state)?.controlFailure ?? null) === null ? "" : ` — ${(recordOf(state)?.controlFailure ?? null)}`}`,
      );
      const entry = index.get(tabId);
      if (entry !== null) {
        const released = entry.ownership !== null && entry.ownership.releasedAt !== null;
        s.diagnostics.fact(tabId, "session state", `${entry.availability}${released ? " · claim released" : ""}`);
      }
    }
    if (!resolvedTarget) {
      // The resolved launcher is captured at a host's own launch; a window that
      // never launched one has nothing to report here, and this report does not
      // resolve (or run) a launcher of its own to fill the gap.
      s.diagnostics.fact(
        WINDOW_DIAGNOSTIC_SUBJECT,
        "OMP target",
        "not resolved in this window — no OMP host was launched here",
      );
    }
  }

  /** The report body; the provider calls this on every request, so it re-probes. */
  async function diagnosticsDocumentContent(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    uriPath: string,
  ): Promise<string> {
    const s = windowState();
    if (uriPath !== DIAGNOSTICS_DOCUMENT_PATH) {
      return `${redactCapabilities(uriPath)}\n\nThis diagnostics document has no report bound to this path. Run "OMP Desk: Show Diagnostics" to open the window's report.\n`;
    }
    refreshSessionDiagnostics(index);
    return s.diagnostics.render(diagnosticsEnvironment(context));
  }

  /** Show this window's read-only diagnostics report. */
  async function showDiagnostics(context: vscode.ExtensionContext, index: SessionIndex): Promise<void> {
    const s = windowState();
    try {
      const document = await vscode.workspace.openTextDocument(diagnosticsUri());
      await vscode.window.showTextDocument(document, { preview: false });
      // An already-open report holds the previous content; ask it to re-read.
      s.diagnosticsDocumentChanges.fire(diagnosticsUri());
      log.debug("diagnostics report shown");
    } catch (error) {
      showError(`The diagnostics report could not be shown: ${messageOf(error)}`);
    }
  }
  return { diagnosticsEnvironment, showDiagnostics, diagnosticsDocumentContent, diagnosticsLabel, diagnosticsStageMeasured };
}
