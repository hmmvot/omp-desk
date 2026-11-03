/**
 * Provider models of a window: the default profile's model catalogue (`omp models --json`, cached on success only), each conversation's footer
 * metadata (model availability, usage and session cost, branch), and the provider login and logout flows (ADR-0070) with their window-wide
 * refresh triggers: activation, a finished flow and the close of the explicit `omp login` terminal.
 */
import * as os from "node:os";
import * as vscode from "vscode";
import { DEFAULT_OMP_PROFILE } from "../host/native-terminal";
import { openProviderLoginTerminal } from "../host/omp-vscode";
import type { LoginFlowDeps } from "../host/provider-login-flow";
import { rareSubsystems, type RareSubsystems } from "./rare-subsystems-loader";
import { runOmpCli } from "../host/native-terminal";
import { ProviderUsageCache, PROVIDER_USAGE_ARGS, PROVIDER_USAGE_TIMEOUT_MS } from "../host/provider-usage";
import { isHelperCancelled } from "../host/helper-scheduler";
import { observeSessionBranch } from "../host/session-branch";
import type { GitApi, BranchObservation } from "../host/session-branch";
import type { FooterMetadataMessage } from "../shared/footer-metadata";
import type { OmpCommand } from "../host/native-terminal";
import { SessionIndex } from "../host/session-index";
import type { LiveConversation } from "../runtime/session-runtime";
import { type Logger } from "../shared/logger";
import type { SessionHostRuntime } from "../host/native-session";
import type { TabState, WindowState } from "./window-state";

/**
 * Where one provider login or logout runs: the session's own OMP, directory and profile, so the credential lands
 * where that session will read it.
 */
interface ProviderAuthScope {
  readonly runtime: SessionHostRuntime | null;
  readonly profile: string | null;
  readonly cwd: string;
}

/** The modules of one provider login or logout flow, loaded together with the first flow. */
interface ProviderLoginModules {
  readonly flow: RareSubsystems["providerLoginFlow"];
  readonly rpc: RareSubsystems["providerLoginRpc"];
  readonly ui: RareSubsystems["providerLoginUi"];
}
/** What the provider models reads of its window and calls into. */
export interface ProviderModelsDeps {
  readonly windowState: () => WindowState;
  readonly log: Logger;
  readonly executableFor: (runtime: SessionHostRuntime | null) => Promise<OmpCommand>;
  readonly ompCliScopeEnvironment: (profile: string | null) => Record<string, string>;
  readonly liveAt: (tabId: string, incarnation: number) => LiveConversation | null;
  readonly hostOf: (state: { readonly tabId: string | null; } | null | undefined) => SessionHostRuntime | null;
  readonly stateOf: (key: string | null) => TabState | undefined;
  readonly noteUsageFailure: (binding: object, stage: string, error: unknown) => void;
  readonly showInfo: (message: string) => void;
  readonly showError: (message: string) => void;
  readonly messageOf: (error: unknown) => string;
}

/** The window's provider models: the default profile's catalogue, each conversation's footer metadata and the provider login and logout flows. */
export function createProviderModels(deps: ProviderModelsDeps) {
  const { windowState, log, executableFor, ompCliScopeEnvironment, liveAt, hostOf, stateOf, noteUsageFailure, showInfo, showError, messageOf } = deps;

  /** Cache only a successful default-profile catalogue; unresolved OMP adds no onboarding UI. */
  function refreshDefaultProviderModels(reason: "credentials" | "discovery" = "credentials"): Promise<void> {
    const s = windowState();
    // A credential change repeats a read that is already running (it may have started before the change); a discovery asked for
    // by a session's first look or by activation joins whatever read is queued or running and starts one only when there is none.
    if (reason === "credentials") s.defaultProviderModelsDirty = true;
    if (s.defaultProviderModelsRead !== null) return s.defaultProviderModelsRead;
    s.defaultProviderModelsRead = (async () => {
      do {
        s.defaultProviderModelsDirty = false;
        try {
          // Not needed for the first view: held back until the startup restore is over, bounded with the window's other helpers and spread across windows (ADR-0084).
          await s.helpers.run({ label: "models of the default profile", class: "background", key: "models:default", run: signal => readDefaultProviderModels(s, signal) });
        } catch (error) {
          if (isHelperCancelled(error)) return;
          log.warn("Default-profile models could not be read; retaining the last availability.");
        }
      } while (s.defaultProviderModelsDirty);
    })().finally(() => { s.defaultProviderModelsRead = null; });
    return s.defaultProviderModelsRead;
  }

  /** One read of the default profile's model catalogue: `omp models --json`. */
  async function readDefaultProviderModels(s: WindowState, signal: AbortSignal): Promise<void> {
    let executable: OmpCommand;
    try { executable = await executableFor(null); }
    catch {
      s.defaultProviderModelsAvailable = null;
      s.launcherProvider?.setProviderLoginRequired(false);
      return;
    }
    try {
      const result = await runOmpCli(executable, ["models", "--json"], 15_000, {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
        env: ompCliScopeEnvironment(DEFAULT_OMP_PROFILE),
        signal,
      });
      if (result.exitCode !== 0) return;
      const parsed: unknown = JSON.parse(result.stdout);
      if (typeof parsed !== "object" || parsed === null || !("models" in parsed) || !Array.isArray(parsed.models)) return;
      s.defaultProviderModelsAvailable = parsed.models.length > 0;
      s.launcherProvider?.setProviderLoginRequired(!s.defaultProviderModelsAvailable);
    } catch (error) {
      if (signal.aborted) throw error;
      log.warn("Default-profile models could not be read; retaining the last availability.");
    }
  }

  /**
   * A credential may have changed through this window's login, logout or login terminal: re-read model availability here
   * and ask every other window of the profile to re-read its own (ADR-0070). Requests that arrive from another window
   * call {@link refreshProviderModelsEverywhere} only, so a notice is never echoed.
   */
  function announceCredentialsChanged(index: SessionIndex): void {
    refreshProviderModelsEverywhere(index);
    void windowState().routing.announceCredentialsChanged();
  }

  /** Re-read model availability here: the default profile and every indexed session. */
  function refreshProviderModelsEverywhere(index: SessionIndex): void {
    void refreshDefaultProviderModels();
    for (const entry of index.list()) void refreshSessionModels(index, entry.tabId);
  }

  /**
   * Activation, a finished provider login or logout, and the close of the explicit `omp login` terminal are the
   * window-wide discovery triggers. Closing the window ends a login still running.
   */
  function subscribeProviderLoginRefresh(context: vscode.ExtensionContext, index: SessionIndex): void {
    const s = windowState();
    context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
      const ownedLoginClosed = terminal === s.providerLoginTerminal;
      if (ownedLoginClosed) s.providerLoginTerminal = null;
      if (!ownedLoginClosed && terminal.name !== "omp login") return;
      announceCredentialsChanged(index);
    }), { dispose: () => { s.providerAuthRun?.abort(); } });
    void refreshDefaultProviderModels("discovery");
  }

  function recordSessionModels(index: SessionIndex, tabId: string, available: boolean): void {
    const s = windowState();
    ensureFooterBinding(index, tabId);
    const binding = s.footerBindings.get(tabId);
    if (!binding || binding.message.hasAvailableModels === available) return;
    const firstLook = binding.message.hasAvailableModels === undefined;
    binding.message = { ...binding.message, hasAvailableModels: available };
    publishFooterMetadata(tabId);
    // A session's first look is no change: the read of the default profile this window queued at activation covers it, so it asks again
    // only when that catalogue was never read. A changed answer is a hint that credentials changed.
    if (!firstLook) void refreshDefaultProviderModels("credentials");
    else if (s.defaultProviderModelsAvailable === null) void refreshDefaultProviderModels("discovery");
  }

  /** Read this conversation's own profile through RPC, never a per-session CLI. */
  function refreshSessionModels(index: SessionIndex, tabId: string): Promise<void> {
    const s = windowState();
    const pending = s.sessionModelReads.get(tabId);
    if (pending) return pending;
    const conversations = s.sessionRuntime.conversations;
    const live = conversations.liveOf(tabId);
    if (live === null || live.phase !== "live") return Promise.resolve();
    // An automatic read is not worth delaying a Stop that OMP would queue behind it; a picker the user opens may read mid-turn.
    if (live.working) { s.sessionModelRefreshOwed.add(tabId); return Promise.resolve(); }
    const epoch = live.epoch;
    const read = conversations.readAvailableModels(tabId, live.incarnation).then(listed => {
      const now = liveAt(tabId, live.incarnation);
      if (listed.status === "stale" || now === null || now.phase !== "live" ||
        epoch.nonce !== now.epoch.nonce || epoch.counter !== now.epoch.counter) return;
      if (listed.status === "ok") {
        s.sessionModelRefreshOwed.delete(tabId);
        recordSessionModels(index, tabId, listed.models.length > 0);
      } else if (listed.status === "refused" && listed.reason === "busy") s.sessionModelRefreshOwed.add(tabId);
    }).finally(() => { if (s.sessionModelReads.get(tabId) === read) s.sessionModelReads.delete(tabId); });
    s.sessionModelReads.set(tabId, read);
    return read;
  }

  /** Host-owned optional footer facts, sent to every editor showing this exact conversation. */
  function publishFooterMetadata(tabId: string): void {
    const s = windowState();
    const binding = s.footerBindings.get(tabId);
    if (!binding) return;
    s.usageStatus?.update();
    for (const state of s.tabs.values()) {
      if (state.tabId !== tabId) continue;
      if (state.panel !== null) void state.panel.webview.postMessage(binding.message);
      else if (state.bridge?.documentId) state.bridge.endpoint.pushTerminal(state.bridge.documentId, binding.message);
    }
  }

  function ensureFooterBinding(index: SessionIndex, tabId: string): void {
    const s = windowState();
    const entry = index.get(tabId);
    if (!entry) return;
    const cwd = hostOf(stateOf(tabId))?.cwd ?? entry.cwd;
    const existing = s.footerBindings.get(tabId);
    if (existing?.cwd === cwd) return;
    existing?.observer?.dispose();
    const binding = { cwd, modelId: null as string | null,
      message: { type: "omp:footer-metadata" as const, provider: null, windows: [], accounts: [], accountSelection: null, branch: null } as FooterMetadataMessage,
      observer: null as BranchObservation | null };
    s.footerBindings.set(tabId, binding);
    const current = (): boolean => s.footerBindings.get(tabId) === binding && (hostOf(stateOf(tabId))?.cwd ?? index.get(tabId)?.cwd) === cwd;
    const publish = (branch: string | null): void => {
      if (!current()) return;
      binding.message = { ...binding.message, branch };
      publishFooterMetadata(tabId);
    };
    binding.observer = observeSessionBranch(cwd, undefined, publish);
    const extension = vscode.extensions?.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
    if (extension) void Promise.resolve(extension.isActive ? extension.exports : extension.activate()).then(exports => {
      if (!current()) return;
      const api = exports.getAPI(1); // Keep the CLI observer if Git is disabled/unavailable.
      binding.observer?.dispose();
      binding.observer = observeSessionBranch(cwd, api, publish);
    }).catch(() => log.warn("Git footer observation could not activate the built-in Git extension."));
  }

  /** Session cost has its own attach/end readback; it must not inherit the quota cache's five-minute throttle. */
  function refreshSessionCost(index: SessionIndex, tabId: string): void {
    const s = windowState();
    ensureFooterBinding(index, tabId);
    const binding = s.footerBindings.get(tabId);
    const live = s.sessionRuntime.conversations.liveOf(tabId);
    const runtime = hostOf(stateOf(tabId));
    if (!binding) return;
    binding.message = { ...binding.message, sessionCost: undefined };
    publishFooterMetadata(tabId);
    if (live === null || live.phase !== "live" || !runtime) return;
    const epoch = live.epoch;
    void s.sessionRuntime.conversations.readSessionCost(tabId, live.incarnation).then(cost => {
      const now = liveAt(tabId, live.incarnation);
      if (s.footerBindings.get(tabId) !== binding || now === null || hostOf(stateOf(tabId)) !== runtime ||
        epoch.nonce !== now.epoch.nonce || epoch.counter !== now.epoch.counter) return;
      binding.message = { ...binding.message, sessionCost: cost ?? undefined };
      publishFooterMetadata(tabId);
    });
  }

  function refreshFooterMetadata(index: SessionIndex, tabId: string, refreshUsage: boolean, forceUsage = false): void {
    const s = windowState();
    ensureFooterBinding(index, tabId);
    const binding = s.footerBindings.get(tabId);
    const live = s.sessionRuntime.conversations.liveOf(tabId);
    const entry = index.get(tabId);
    const runtime = hostOf(stateOf(tabId));
    if (!binding || !entry) return;
    const model = live?.state?.model ?? null;
    const changed = binding.message.provider !== model?.provider || binding.modelId !== model?.id;
    if (!refreshUsage && !changed) return;
    binding.modelId = model?.id ?? null;
    if (!model || !runtime) {
      binding.message = { ...binding.message, provider: null, windows: [], accounts: [], accountSelection: null };
      binding.usageReadAt = null;
      publishFooterMetadata(tabId);
      return;
    }
    const sameSession = (): boolean => s.sessionRuntime.conversations.incarnationOf(tabId) === (live?.incarnation ?? null);
    // Resolve the exact installation before selecting the scope cache; never join different cwd/profile installs.
    void executableFor(runtime).then(async executable => {
      if (s.footerBindings.get(tabId) !== binding || !sameSession() || hostOf(stateOf(tabId)) !== runtime) return;
      const scope = JSON.stringify([executable.command, executable.prefixArgs, entry.scope.profile ?? DEFAULT_OMP_PROFILE, runtime.cwd]);
      let cache = s.usageCaches.get(scope);
      if (!cache) { cache = new ProviderUsageCache(Date.now, log); s.usageCaches.set(scope, cache); }
      binding.message = { ...binding.message, provider: model.provider, ...cache.get(model.provider, model.id) };
      binding.usageReadAt = cache.readAt(model.provider);
      publishFooterMetadata(tabId);
      // A quota on screen (the active tab, or any Chat panel that is visible, as in a split) goes at once, bounded, and promotes a background read of the
      // same scope that is still queued; every other tab's read waits for the startup restore (ADR-0084).
      const usageKey = `usage\0${scope}\0${model.provider}`;
      const onScreen = forceUsage || index.activeTabId === tabId || [...s.tabs.values()].some(state => state.tabId === tabId && state.panel?.visible === true);
      if (onScreen) s.helpers.promote(usageKey);
      const usage = await cache.refresh(model.provider, model.id, () => s.helpers.run({
        label: "provider usage", class: onScreen ? "visible" : "background", key: usageKey,
        run: signal => runOmpCli(executable, [...PROVIDER_USAGE_ARGS, "--provider", model.provider], PROVIDER_USAGE_TIMEOUT_MS,
          { cwd: runtime.cwd, env: ompCliScopeEnvironment(entry.scope.profile), signal }),
      }), forceUsage);
      const chosen = s.sessionRuntime.conversations.liveOf(tabId)?.state?.model;
      if (s.footerBindings.get(tabId) !== binding || !sameSession() || hostOf(stateOf(tabId)) !== runtime ||
        chosen?.provider !== model.provider || chosen?.id !== model.id) return;
      binding.message = { ...binding.message, provider: model.provider, ...usage };
      binding.usageReadAt = cache.readAt(model.provider);
      publishFooterMetadata(tabId);
    }, error => noteUsageFailure(binding, "resolving the OMP executable", error)).catch(error => noteUsageFailure(binding, "publishing the usage", error));
  }

  /**
   * Provider login and logout start from a command or a picker row and nowhere else, so their modules are read from
   * `out/rare-subsystems.js` with the first flow and not at activation (ADR-0085).
   */
  async function providerLoginModules(): Promise<ProviderLoginModules> {
    const { providerLoginFlow, providerLoginRpc, providerLoginUi } = await rareSubsystems();
    return { flow: providerLoginFlow, rpc: providerLoginRpc, ui: providerLoginUi };
  }

  /**
   * Run one provider login or logout flow (ADR-0070) in a short-lived OMP process of the scope; this window runs one at a
   * time. The guard is reserved before the asynchronous preflight (the profile question, executable resolution), so a
   * repeated click opens nothing, and it is released only when the flow and its process have ended.
   */
  async function runProviderAuth<T extends string>(
    index: SessionIndex,
    resolveScope: () => Promise<ProviderAuthScope | null>,
    flow: (deps: LoginFlowDeps, modules: ProviderLoginModules) => Promise<T>,
  ): Promise<T | "busy" | "cancelled" | "failed"> {
    const s = windowState();
    if (s.providerLoginTerminal !== null) {
      // A login in a terminal and one in VS Code compete for the same fixed callback ports of some providers.
      s.providerLoginTerminal.show();
      showInfo("An omp login terminal is still open in this window. Finish or close it first.");
      return "busy";
    }
    if (s.providerAuthRun !== null) {
      showInfo("A provider login or logout is already running in this window.");
      return "busy";
    }
    const run = new AbortController();
    s.providerAuthRun = run;
    try {
      const modules = await providerLoginModules();
      const scope = await resolveScope();
      if (scope === null) return "cancelled";
      let executable: OmpCommand;
      try {
        executable = await executableFor(scope.runtime);
      } catch (error) {
        showError(`The installed OMP could not be resolved, so no provider login was started: ${messageOf(error)}`);
        return "failed";
      }
      const env = ompCliScopeEnvironment(scope.profile);
      return await flow({
        ui: modules.ui.createLoginUi(vscode),
        start: signal => modules.rpc.startLoginSession({ scope: { executable, env, cwd: scope.cwd }, signal, log }),
        openTerminal: providerId => openProviderLoginTerminalFor(executable, env, scope.cwd, providerId),
        credentialsChanged: () => announceCredentialsChanged(index),
        log,
        signal: run.signal,
      }, modules);
    } catch (error) {
      log.error(`provider login: the flow failed unexpectedly: ${messageOf(error)}`);
      showError("The provider login could not be completed.");
      return "failed";
    } finally {
      s.providerAuthRun = null;
    }
  }

  /**
   * The explicit fallback for what the RPC login refuses (a provider that takes a secret or a prompt before its
   * sign-in address) and for API keys: OMP's own `omp login [provider]` in a visible terminal. The extension reads
   * nothing from it; its close refreshes model availability.
   */
  function openProviderLoginTerminalFor(executable: OmpCommand, env: Record<string, string>, cwd: string, providerId: string | undefined): void {
    const s = windowState();
    if (s.providerLoginTerminal !== null) {
      s.providerLoginTerminal.show();
      return;
    }
    s.providerLoginTerminal = openProviderLoginTerminal({
      args: providerId === undefined ? ["login"] : ["login", providerId],
      executable,
      cwd,
      env,
      name: "omp login",
    });
  }

  /** A session-scoped entry (Chat's model picker, its footer): log in within that session's own profile and directory. */
  async function openProviderLogin(index: SessionIndex, runtime: SessionHostRuntime | null, profile: string | null, cwd: string): Promise<void> {
    await runProviderAuth(index, async () => ({ runtime, profile, cwd }), (deps, { flow }) => flow.runProviderLogin(deps));
  }

  /** A session-scoped entry (the Commands list's /logout): log out within that session's own profile and directory, as {@link openProviderLogin} does for login. */
  async function openProviderLogout(index: SessionIndex, runtime: SessionHostRuntime | null, profile: string | null, cwd: string): Promise<void> {
    await runProviderAuth(index, async () => ({ runtime, profile, cwd }), (deps, { flow }) => flow.runProviderLogout(deps));
  }

  /**
   * The scope a palette provider login or logout runs in; never another tab's host. From a session's tab it uses that
   * session's profile. Without one it still works: a new user must log in before any session can start, so it uses
   * the default profile, or asks when the indexed sessions use more than one profile.
   */
  async function paletteProviderAuthScope(index: SessionIndex, title: string, placeHolder: string): Promise<ProviderAuthScope | null> {
    const tabId = index.activeTabId;
    const runtime = tabId === null ? null : hostOf(stateOf(tabId)) ?? null;
    if (tabId !== null && runtime !== null) return { runtime, profile: index.get(tabId)?.scope.profile ?? null, cwd: runtime.cwd };
    const profiles = [...new Set(index.list().map(entry => entry.scope.profile ?? DEFAULT_OMP_PROFILE))].sort();
    let profile: string = DEFAULT_OMP_PROFILE;
    if (profiles.length > 1 || (profiles.length === 1 && profiles[0] !== DEFAULT_OMP_PROFILE)) {
      const choices = profiles.includes(DEFAULT_OMP_PROFILE) ? profiles : [DEFAULT_OMP_PROFILE, ...profiles];
      const picked = await vscode.window.showQuickPick(choices, { title, placeHolder });
      if (picked === undefined) return null;
      profile = picked;
    }
    return { runtime: null, profile, cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir() };
  }

  /**
   * `ompDesk.loginProvider`. Resolves with the outcome: `signed-in`, `cancelled`, `terminal` (the user chose the terminal
   * login), `declined` (the provider takes an API key; the terminal is offered), `failed`, or `busy` (another login or logout,
   * or a fallback terminal, is open in this window). A caller that knows its scope may pass `{ providerId?, profile? }`: a
   * `profile` the extension already knows (the default or one of its indexed sessions') skips the profile question, and a
   * `providerId` OMP lists as available skips the provider pick. The directory is never taken from the caller (the first
   * workspace folder, else the home directory); anything else in the argument is ignored.
   */
  async function loginProviderFromPalette(index: SessionIndex, argument?: unknown): Promise<string> {
    const given = typeof argument === "object" && argument !== null ? argument as Record<string, unknown> : {};
    const text = (key: string): string | undefined => typeof given[key] === "string" && (given[key] as string).length > 0 ? given[key] as string : undefined;
    const known = new Set<string>([DEFAULT_OMP_PROFILE, ...index.list().map(entry => entry.scope.profile ?? DEFAULT_OMP_PROFILE)]);
    const asked = text("profile");
    const profile = asked !== undefined && known.has(asked) ? asked : undefined;
    const providerId = text("providerId");
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const scope = profile === undefined
      ? () => paletteProviderAuthScope(index, "Log In to Provider", "OMP profile to log in with")
      : async (): Promise<ProviderAuthScope> => ({ runtime: null, profile, cwd });
    return await runProviderAuth(index, scope, (deps, { flow }) => flow.runProviderLogin(deps, providerId === undefined ? {} : { providerId }));
  }

  /**
   * The in-process sign-in the Models and Agents pages use (ADR-0070 amendment): the same flow, window guard and credential refresh as
   * `ompDesk.loginProvider`, but in the exact profile and directory of the editor that asks, which the public command's restricted argument cannot name.
   */
  async function signInProvider(index: SessionIndex, request: { readonly providerId: string; readonly profile: string; readonly cwd: string }): Promise<string> {
    return await runProviderAuth(index, async () => ({ runtime: null, profile: request.profile, cwd: request.cwd }), (deps, { flow }) => flow.runProviderLogin(deps, { providerId: request.providerId }));
  }

  /** `ompDesk.logoutProvider`. */
  async function logoutProviderFromPalette(index: SessionIndex): Promise<void> {
    await runProviderAuth(index, () => paletteProviderAuthScope(index, "Log Out of Provider", "OMP profile to log out of"), (deps, { flow }) => flow.runProviderLogout(deps));
  }
  return { signInProvider, subscribeProviderLoginRefresh, refreshFooterMetadata, loginProviderFromPalette, logoutProviderFromPalette, refreshProviderModelsEverywhere, publishFooterMetadata, openProviderLogin, openProviderLogout, refreshSessionModels, refreshSessionCost, ensureFooterBinding, recordSessionModels, refreshDefaultProviderModels };
}
