/**
 * The three places the OMP process code touches the VS Code API: the explicit OMP path setting,
 * the visible provider-login terminal, and the lookup of a recorded process's terminal.
 *
 * They live apart from `native-terminal.ts` so the process code (and the `src/runtime/` layer
 * that wraps it) imports no `vscode` module at all (ADR-0066). `native-terminal.ts` reads the
 * setting through a reader registered at activation (`setOmpPathReader`).
 */
import * as vscode from "vscode";
import type { OmpCommand } from "./native-terminal";
import { OMP_PATH_SETTING } from "../shared/omp-unavailable";
import { CHAT_BROKER_RUNTIME_SETTING, type ChatBrokerRuntimeSetting } from "./chat-broker-runtime";

/** One visible provider-login terminal: the command, where it runs, and its scope. */
export interface ProviderLoginTerminalRequest {
  /** Argument list after the executable's own prefix, e.g. `["login","anthropic"]`. */
  readonly args: readonly string[];
  /** The exact target this session runs, so the login lands in the same install. */
  readonly executable: OmpCommand;
  /** Working directory of the session the login was requested from. */
  readonly cwd: string;
  /** Environment for the command, including the session's config overlay. */
  readonly env: Readonly<Record<string, string>>;
  /** Visible terminal title, e.g. `omp login`. */
  readonly name: string;
}

/**
 * The explicit OMP path the user set (`ompDesk.executablePath`, machine scope, so a workspace can never
 * name a program to run), or the empty string when PATH decides.
 */
export function configuredOmpPath(): string {
  const value = vscode.workspace.getConfiguration("ompDesk").get<unknown>(OMP_PATH_SETTING.slice("ompDesk.".length));
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The runtime Chat brokers start on (`ompDesk.chatBrokerRuntime`, machine scope, so a workspace cannot choose).
 * Anything but the one non-default value reads as the default, `auto`.
 */
export function configuredChatBrokerRuntime(): ChatBrokerRuntimeSetting {
  const value = vscode.workspace.getConfiguration("ompDesk").get<unknown>(CHAT_BROKER_RUNTIME_SETTING.slice("ompDesk.".length));
  return value === "vscode" ? "vscode" : "auto";
}

/**
 * Open the native interactive provider login in a *visible* terminal.
 *
 * `omp login [provider]` is interactive only (readline prompts plus a browser
 * OAuth flow), so the GUI starts it and gets out of the way: this function
 * creates the terminal, shows it, and returns the handle. Nothing the flow
 * prints is read, captured, parsed or logged — the extension never learns the
 * provider URL, the pasted code or the stored credential, and OMP writes the
 * credential into its own store.
 *
 * `isTransient` matches the host terminal for the same reason: the extension
 * owns session restoration, so a reload must not resurrect a login command. The
 * environment carries the session's own `PI_CONFIG_FILES` overlay (when it has
 * one), so the credential is resolved and stored exactly as the session that
 * asked for it would resolve it.
 */
export function openProviderLoginTerminal(request: ProviderLoginTerminalRequest): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: request.name,
    shellPath: request.executable.command,
    shellArgs: [...request.executable.prefixArgs, ...request.args],
    cwd: vscode.Uri.file(request.cwd),
    env: { ...request.env },
    isTransient: true,
    iconPath: new vscode.ThemeIcon("account"),
  });
  terminal.show(false);
  return terminal;
}

/**
 * The pty process of a terminal, or undefined while VS Code has not reported it.
 *
 * The resolved command runs OMP in the PTY process itself (including the
 * installed Bun entry), not via the `omp.exe` shim's child. That makes the
 * process-identity comparison against the recorded broker child exact.
 */
async function terminalProcessId(terminal: vscode.Terminal): Promise<number | undefined> {
  const { promise, resolve } = Promise.withResolvers<number | undefined>();
  terminal.processId.then(
    pid => resolve(pid),
    () => resolve(undefined),
  );
  return await promise;
}

/**
 * The identical VS Code terminal of a recorded process, when this window still
 * has it. Matching is by exact `processId`; a miss never invents a terminal and
 * never starts a second OMP process.
 */
export async function findTerminalForPid(pid: number): Promise<vscode.Terminal | null> {
  for (const terminal of vscode.window.terminals) {
    if (terminal.exitStatus !== undefined) continue;
    if ((await terminalProcessId(terminal)) === pid) return terminal;
  }
  return null;
}
