/**
 * The diagnostics report of a window (`OMP Desk: Show Diagnostics`): a read-only document that re-probes on every request, the environment
 * facts of this extension host and the refresh of the report's session subjects.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { SessionIndex } from "../host/session-index";
import type { ConversationRecord } from "../runtime/runtime-record";
import { type Logger } from "../shared/logger";
import { DIAGNOSTICS_DOCUMENT_PATH, WINDOW_DIAGNOSTIC_SUBJECT, redactCapabilities } from "../host/diagnostics";
import type { DiagnosticEnvironment, DiagnosticStageId } from "../host/diagnostics";
import type { SessionHostRuntime } from "../host/native-session";
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
