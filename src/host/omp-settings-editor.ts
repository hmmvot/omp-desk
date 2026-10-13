import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { stageRuntimeAssets, verifyStagedRuntimeAsset } from "./runtime-assets";
import type { StagedRuntimeAsset } from "./runtime-assets";
import { openProviderLoginTerminal } from "./omp-vscode";
import { resolveBunRuntime, resolveOmpBinary, resolveOmpPackageRoot } from "./native-terminal";
import type { OmpCommand } from "./native-terminal";
import { runSettingsWorker } from "./omp-settings-worker";
import { createSettingsHtml } from "./guest-webview";
import { parseAgentSpec, SettingsRefusal, valueAt } from "./omp-settings-core";
import { isRecord as record } from "../shared/guards";
import type { AgentSpec, ConfigEdit, ConfigRecord, SettingsScope, SettingsSnapshot } from "../protocol/settings-model";
import type { SettingsKind } from "../chat/settings-command";
import type { SettingsMessage } from "../protocol/settings-messages";
import { chooseSetting, pickFallbackChainKey, pickSettingsModel, pickSettingsThinking } from "./settings-pickers";
import { modelKey, roleChange, selectorBase, selectorThinking } from "../protocol/settings-pick-items";
import { ancestorProjectFolder, projectFolderFor } from "../omp/config-ancestor";
import { NEAREST_OMP_SETTING } from "../protocol/omp-config-model";
import { parseModelPickRequest, parseRoleAssignment } from "./settings-pick-requests";
import type { PickEntry } from "../protocol/settings-pick-items";

export interface SettingsEditorContext {
  /** The project folder whose layer and agents are shown, or null for the global scope. */
  readonly folder: string | null;
  readonly profile: string; readonly executable?: OmpCommand;
  readonly sessionLabel?: string;
  readonly applyDefault?: (model: { provider: string; id: string; thinking?: string }) => Promise<string>;
}
export interface SettingsEditorHost {
  /** The OMP profile a command-opened editor uses. */
  defaultProfile(): string;
  /** Folders offered by the in-editor scope control: the folders Sessions shows. */
  folders(): readonly string[];
  /** Signs in to a provider in exactly this profile and directory (the same flow as `ompDesk.loginProvider`); resolves with its outcome word. */
  signIn(request: { providerId: string; profile: string; cwd: string }): Promise<string>;
}
interface FileBaseline { logical: string; physical: string; exists: boolean; digest: string; settings: ConfigRecord }
interface ReadReceipt { snapshot: SettingsSnapshot; files: Record<SettingsScope, FileBaseline> }
/** `cwd` is the bound folder, or null for the global scope. */
interface StoredContext { key: string; kind: SettingsKind; cwd: string | null; profile: string }
interface Editor {
  readonly panel: vscode.WebviewPanel; key: string; readonly kind: SettingsKind;
  binding: SettingsEditorContext; receipt?: ReadReceipt; preview?: AgentSpec;
  runtime?: { bun: string; packageRoot: string; asset: StagedRuntimeAsset; cacheDirectory: string; executable: OmpCommand };
  readonly abort: AbortController; busy: boolean; disposed: boolean;
  readonly requests: Map<string, Promise<void>>;
  readonly pending: Set<Promise<void>>;
}
const VIEW_TYPE = "omp.settings";
const STORED_CONTEXTS = "omp.settings.contexts";
const PICK_TITLES = { "fallback-entry": "Add to the fallback chain", "agent-override": "Add to the agent's model override", prewalk: "Prewalk model", advisor: "Advisor model" } as const;
const editorKey = (kind: SettingsKind, binding: SettingsEditorContext): string =>
  createHash("sha256").update(JSON.stringify([kind, binding.folder === null ? null : path.resolve(binding.folder), binding.profile])).digest("hex");

/**
 * One editor per native profile and scope (global, or one project folder), independent of conversation
 * slots and claims. Commands open the global scope directly; the editor's own scope control reaches a folder.
 */
export class SettingsEditors implements vscode.Disposable {
  readonly #editors = new Map<string, Editor>();
  readonly #disposables: vscode.Disposable[] = [];
  constructor(readonly context: vscode.ExtensionContext, readonly host: SettingsEditorHost) {
    this.#disposables.push(
      vscode.commands.registerCommand("ompDesk.openModels", () => this.open("models", { folder: null, profile: host.defaultProfile() })),
      vscode.commands.registerCommand("ompDesk.openAgents", () => this.open("agents", { folder: null, profile: host.defaultProfile() })),
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, raw: unknown) => {
          const stored = record(raw) && typeof raw.key === "string" ? this.#stored().find(item => item.key === raw.key) : undefined;
          if (!stored) { panel.dispose(); return; }
          this.#attach(panel, stored.key, stored.kind, { folder: stored.cwd, profile: stored.profile });
        },
      }),
    );
  }
  /**
   * The folder an editor treats as the project, the same as the OMP settings editor's: with `ompDesk.ompSettings.useNearestAncestorOmpFolder` on, the nearest
   * ancestor whose `.omp` is non-empty (a Unity project's repository root), else the folder itself. The setting is read for that folder.
   */
  async #projectFolder(folder: string | null): Promise<string | null> {
    if (folder === null) return null;
    const enabled = vscode.workspace.getConfiguration("ompDesk", vscode.Uri.file(folder)).get<boolean>("ompSettings.useNearestAncestorOmpFolder", false);
    return projectFolderFor(folder, enabled);
  }
  async open(kind: SettingsKind, requested: SettingsEditorContext): Promise<void> {
    const binding: SettingsEditorContext = { ...requested, folder: await this.#projectFolder(requested.folder) };
    const key = editorKey(kind, binding);
    const existing = this.#editors.get(key);
    if (existing) {
      existing.binding = binding;
      this.#init(existing);
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    await this.#remember(key, kind, binding);
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, kind === "models" ? "OMP Models" : "OMP Agents", vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    });
    this.#attach(panel, key, kind, binding);
  }
  async #remember(key: string, kind: SettingsKind, binding: SettingsEditorContext): Promise<void> {
    const contexts = this.#stored().filter(item => item.key !== key);
    contexts.push({ key, kind, cwd: binding.folder, profile: binding.profile });
    await this.context.workspaceState.update(STORED_CONTEXTS, contexts.slice(-32));
  }
  #stored(): StoredContext[] {
    const stored: unknown = this.context.workspaceState.get(STORED_CONTEXTS);
    return Array.isArray(stored) ? stored.filter((item): item is StoredContext => record(item)
      && typeof item.key === "string" && /^[a-f0-9]{64}$/.test(item.key)
      && (item.kind === "models" || item.kind === "agents")
      && (item.cwd === null || typeof item.cwd === "string" && path.isAbsolute(item.cwd)) && typeof item.profile === "string") : [];
  }
  #attach(panel: vscode.WebviewPanel, key: string, kind: SettingsKind, binding: SettingsEditorContext): void {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] };
    panel.iconPath = new vscode.ThemeIcon(kind === "models" ? "symbol-variable" : "organization");
    const editor: Editor = { panel, key, kind, binding, abort: new AbortController(), busy: false, disposed: false, requests: new Map(), pending: new Set() };
    this.#editors.set(key, editor);
    this.#title(editor);
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (!record(raw) || typeof raw.requestId !== "string" || !/^[\w-]{1,80}$/.test(raw.requestId) || typeof raw.action !== "string") return;
      if (editor.requests.has(raw.requestId)) return;
      const operation = this.#action(editor, raw, raw.requestId);
      editor.requests.set(raw.requestId, operation);
      editor.pending.add(operation);
      void operation.finally(() => editor.pending.delete(operation));
      if (editor.requests.size > 128) editor.requests.delete(editor.requests.keys().next().value!);
    });
    panel.onDidDispose(() => {
      editor.disposed = true; editor.abort.abort(); this.#editors.delete(editor.key);
      void Promise.allSettled(editor.pending).then(() => this.#cleanup(editor));
    });
    panel.webview.html = createSettingsHtml(panel.webview, this.context.extensionUri);
  }
  #title(editor: Editor): void {
    const folder = editor.binding.folder;
    editor.panel.title = `OMP ${editor.kind === "models" ? "Models" : "Agents"} · ${folder === null ? "Global" : path.basename(folder) || folder}`;
  }
  #post(editor: Editor, message: SettingsMessage): void { if (!editor.disposed) void editor.panel.webview.postMessage(message); }
  #init(editor: Editor): void {
    this.#post(editor, { type: "settings:init", key: editor.key, kind: editor.kind, folder: editor.binding.folder, canApply: Boolean(editor.binding.applyDefault), sessionLabel: editor.binding.sessionLabel });
  }
  /** Moves an open editor to another scope of the same profile; an editor already showing that scope is revealed instead. */
  async #rebind(editor: Editor, chosen: string | null): Promise<string> {
    const folder = await this.#projectFolder(chosen);
    const binding: SettingsEditorContext = { folder, profile: editor.binding.profile, ...(editor.binding.executable ? { executable: editor.binding.executable } : {}) };
    const key = editorKey(editor.kind, binding);
    if (key === editor.key) return "";
    const other = this.#editors.get(key);
    if (other) { other.panel.reveal(vscode.ViewColumn.Active); return "That scope is already open in another tab."; }
    this.#editors.delete(editor.key);
    editor.key = key; editor.binding = binding; editor.receipt = undefined; editor.preview = undefined;
    this.#editors.set(key, editor);
    await this.#remember(key, editor.kind, binding);
    this.#title(editor);
    this.#post(editor, { type: "settings:preview", spec: null });
    this.#init(editor);
    await this.#read(editor);
    return folder === null ? "Showing the global scope." : `Showing the project scope of ${folder}.`;
  }
  async #pickScope(editor: Editor): Promise<string | null | undefined> {
    const current = editor.binding.folder;
    const folders = [...new Set([...this.host.folders(), ...(current === null ? [] : [current])])];
    const entries: PickEntry[] = [
      { label: `${current === null ? "$(check) " : ""}$(globe) Global`, description: editor.kind === "agents" ? "Global config, user and bundled agents; no project layer" : "Global config; no project layer", value: "global", current: current === null, available: true },
      ...(folders.length ? [{ separator: "Project folder" }] : []),
      ...folders.map(folder => ({ label: `${folder === current ? "$(check) " : ""}$(folder) ${path.basename(folder) || folder}`, description: folder, value: `folder:${folder}`, current: folder === current, available: true })),
      { separator: "" },
      { label: "$(folder-opened) Choose another folder…", value: "browse", current: false, available: true },
    ];
    const value = await chooseSetting(() => entries, { title: `${editor.kind === "models" ? "Models" : "Agents"} settings scope`, placeholder: "Global, or the project folder whose layer and agents to include", signal: editor.abort.signal });
    if (value === undefined) return undefined;
    if (value === "global") return null;
    if (value.startsWith("folder:")) return value.slice("folder:".length);
    const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Use folder" });
    return chosen?.[0]?.fsPath;
  }
  /** The global scope runs OMP from a drive root: no project config there, and agent discovery walks no user-profile ancestors. */
  #cwd(editor: Editor): string { return editor.binding.folder ?? path.parse(this.context.globalStorageUri.fsPath).root; }
  /** Validates a write scope; the global scope has no project to write. */
  #scope(editor: Editor, raw: unknown): SettingsScope {
    if (raw !== "global" && raw !== "project") throw new SettingsRefusal("Choose global or project scope.");
    if (raw === "project" && editor.binding.folder === null) throw new SettingsRefusal("Choose a project folder in the scope control first. Nothing was changed.");
    return raw;
  }
  async #runtime(editor: Editor): Promise<NonNullable<Editor["runtime"]>> {
    if (editor.runtime) return editor.runtime;
    const executable = editor.binding.executable ?? await resolveOmpBinary();
    const [bun, root] = await Promise.all([resolveBunRuntime(), resolveOmpPackageRoot(executable)]);
    if (!bun || !root) throw new SettingsRefusal("These editors require Bun and the selected OMP installation's importable sources. Compiled-only OMP installations are not supported.");
    const assets = await stageRuntimeAssets({ storageDir: this.context.globalStorageUri.fsPath, sourcePaths: [vscode.Uri.joinPath(this.context.extensionUri, "out", "settings-worker.mjs").fsPath] });
    const asset = assets[0];
    if (!asset) throw new SettingsRefusal("The native settings worker is missing from this extension build.");
    // The verified runtime directory is private; temporary catalogue copies inherit its restrictions.
    const cacheDirectory = await fs.mkdtemp(path.join(path.dirname(asset.path), "settings-editor-"));
    const runtime = { bun, packageRoot: root.root, asset, cacheDirectory, executable };
    editor.runtime = runtime;
    if (editor.disposed) { await this.#cleanup(editor); throw new SettingsRefusal("The settings editor was closed."); }
    return runtime;
  }
  async #worker(editor: Editor, request: ConfigRecord): Promise<unknown> {
    const runtime = await this.#runtime(editor);
    if (!await verifyStagedRuntimeAsset(runtime.asset)) throw new SettingsRefusal("The settings worker's staged bytes changed. Reopen the editor.");
    return runSettingsWorker({ bunPath: runtime.bun, helperPath: runtime.asset.path, packageRoot: runtime.packageRoot,
      cwd: this.#cwd(editor), profile: editor.binding.profile, signal: editor.abort.signal,
      request: { ...request, catalogueCache: path.join(runtime.cacheDirectory, "models.db") } });
  }
  async #read(editor: Editor, action = "read", provider?: string): Promise<void> {
    const result = await this.#worker(editor, { action, provider });
    if (!record(result) || !record(result.snapshot) || !record(result.files)) throw new SettingsRefusal("OMP returned an invalid settings snapshot.");
    editor.receipt = result as unknown as ReadReceipt;
    const folder = editor.binding.folder;
    const ancestorProject = folder === null ? null : await ancestorProjectFolder(folder);
    this.#post(editor, { type: "settings:snapshot", snapshot: editor.receipt.snapshot, configExists: { global: editor.receipt.files.global.exists, project: editor.receipt.files.project.exists }, ancestorProject });
  }
  async #save(editor: Editor, scope: SettingsScope, edits: ConfigEdit[], thinking?: string, preset?: string): Promise<string> {
    const receipt = editor.receipt;
    if (!receipt) throw new SettingsRefusal("Reload before saving.");
    this.#scope(editor, scope);
    let saved = false;
    let changed = false;
    const write = async (target: SettingsScope, targetEdits: ConfigEdit[], targetPreset?: string): Promise<void> => {
      const result = await this.#worker(editor, { action: "write", scope: target, edits: targetEdits, preset: targetPreset, baseline: receipt.files[target] });
      saved = true;
      if (!record(result) || result.changed !== false) changed = true;
    };
    try {
      if (scope === "global" && thinking !== undefined) edits.push({ path: ["defaultThinkingLevel"], value: thinking });
      if (edits.length) await write(scope, edits, preset);
      if (scope === "project" && thinking !== undefined) await write("global", [{ path: ["defaultThinkingLevel"], value: thinking }]);
    } catch (error) {
      if (saved) throw new SettingsRefusal("Project roles were saved, but global thinking was not. Reload to inspect the partial result before retrying.");
      throw error;
    }
    try { await this.#read(editor); }
    catch { throw new SettingsRefusal("The settings were saved, but readback failed. Reload to inspect the result before making another change."); }
    if (!changed) return "Nothing to save: OMP config already has these values. The file was not rewritten.";
    return "Saved to OMP config. Check effective values and sources for inherited shadows. Future resolution reloads; the current model and existing children are unchanged.";
  }
  async #action(editor: Editor, raw: ConfigRecord, requestId: string): Promise<void> {
    if (editor.disposed) return;
    if (editor.busy) { this.#post(editor, { type: "settings:result", requestId, ok: false, message: "A settings operation is still running." }); return; }
    editor.busy = true;
    let message = "";
    try {
      switch (raw.action) {
        case "ready": this.#init(editor); await this.#read(editor); break;
        case "reload": await this.#read(editor); message = "Reloaded persisted and effective values."; break;
        case "save": {
          const scope = this.#scope(editor, raw.scope);
          if (!Array.isArray(raw.edits) || raw.edits.length > 100 || !raw.edits.every(edit => record(edit) && Array.isArray(edit.path) && edit.path.every(key => typeof key === "string"))) throw new SettingsRefusal("The settings edits are invalid.");
          if (raw.thinking !== undefined && typeof raw.thinking !== "string") throw new SettingsRefusal("Choose a thinking effort.");
          const edits = raw.edits.map(edit => ({ path: [...edit.path], value: edit.value }));
          message = await this.#save(editor, scope, edits, raw.thinking as string | undefined);
          break;
        }
        case "preset": {
          if (typeof raw.name !== "string" || !["save", "switch", "delete"].includes(String(raw.operation))) throw new SettingsRefusal("Choose a preset operation.");
          const plan = await this.#worker(editor, { action: "preset-plan", preset: raw.name, operation: raw.operation });
          if (!record(plan) || (plan.scope !== "global" && plan.scope !== "project") || !Array.isArray(plan.edits)) throw new SettingsRefusal("OMP returned no preset transaction.");
          message = await this.#save(editor, plan.scope, plan.edits as ConfigEdit[], typeof plan.thinking === "string" ? plan.thinking : undefined, typeof plan.preset === "string" ? plan.preset : undefined);
          break;
        }
        case "assign-role": message = await this.#assignRole(editor, raw); break;
        case "pick-model": {
          const snapshot = editor.receipt?.snapshot;
          if (!snapshot) throw new SettingsRefusal("Reload before choosing a model.");
          const request = parseModelPickRequest(raw);
          const value = await pickSettingsModel({ ...request, snapshot }, PICK_TITLES[request.purpose], editor.abort.signal);
          this.#post(editor, { type: "settings:picked", requestId, value: value ?? null });
          break;
        }
        case "pick-chain-key": {
          const snapshot = editor.receipt?.snapshot;
          if (!snapshot) throw new SettingsRefusal("Reload before adding a chain.");
          const configured = [snapshot.effective, snapshot.global].flatMap(layer => { const chains = valueAt(layer, ["retry", "fallbackChains"]); return record(chains) ? Object.keys(chains) : []; });
          const value = await pickFallbackChainKey(snapshot, configured, editor.abort.signal);
          this.#post(editor, { type: "settings:picked", requestId, value: value ?? null });
          break;
        }
        case "pick-scope": {
          const folder = await this.#pickScope(editor);
          if (folder !== undefined) message = await this.#rebind(editor, folder);
          break;
        }
        case "refresh": case "login": {
          if (raw.provider !== undefined && (typeof raw.provider !== "string" || !editor.receipt?.snapshot.providers.some(provider => provider.id === raw.provider))) throw new SettingsRefusal("Choose a discovered provider.");
          if (raw.action === "refresh") {
            await this.#read(editor, "refresh", raw.provider as string | undefined);
            message = "Provider catalogue refreshed. OMP may have persisted refreshed credentials; catalogue changes remain in this editor's private cache.";
          } else message = await this.#loginTerminal(editor, typeof raw.provider === "string" ? raw.provider : undefined);
          break;
        }
        case "sign-in": {
          const provider = typeof raw.provider === "string" ? raw.provider : "";
          if (!editor.receipt?.snapshot.providers.some(item => item.id === provider)) throw new SettingsRefusal("Choose a provider this editor lists.");
          this.#signIn(editor, provider);
          message = `Signing in to ${provider}: follow the login prompts. This page updates when it finishes.`;
          break;
        }
        case "open-nearest-setting": await vscode.commands.executeCommand("workbench.action.openSettings", NEAREST_OMP_SETTING); break;
        case "open-config": {
          const scope = this.#scope(editor, raw.scope);
          const file = editor.receipt?.snapshot[scope === "global" ? "globalFile" : "projectFile"];
          if (!file) throw new SettingsRefusal("Reload before opening config.");
          if (!editor.receipt?.files[scope].exists) throw new SettingsRefusal(scope === "global" ? "The global OMP config does not exist yet. Saving a global setting here creates it." : "This folder has no project OMP config yet. Saving a project role creates it.");
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: false });
          break;
        }
        case "open-agent": {
          if (typeof raw.agent !== "string" || !editor.receipt?.snapshot.agents.some(agent => agent.name === raw.agent && agent.hasFile)) throw new SettingsRefusal("Choose a discovered definition file.");
          const result = await this.#worker(editor, { action: "agent-file", agent: raw.agent });
          if (!record(result) || typeof result.file !== "string") throw new SettingsRefusal("The agent file is unavailable.");
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(result.file)), { preview: false });
          break;
        }
        case "generate": {
          if (typeof raw.description !== "string" || !raw.description.trim() || raw.description.length > 32_000) throw new SettingsRefusal("Describe the agent in at most 32,000 characters.");
          editor.preview = undefined;
          this.#post(editor, { type: "settings:preview", spec: null });
          const generated = await this.#worker(editor, { action: "generate", description: raw.description });
          if (!record(generated)) throw new SettingsRefusal("OMP returned no generated specification.");
          editor.preview = parseAgentSpec(generated.spec);
          this.#post(editor, { type: "settings:preview", spec: editor.preview });
          message = "Review this read-only specification, then choose its destination. No history session was created.";
          break;
        }
        case "create": {
          const scope = this.#scope(editor, raw.scope);
          if (!editor.preview) throw new SettingsRefusal("Generate and review a specification first.");
          await this.#worker(editor, { action: "create", scope, spec: editor.preview });
          editor.preview = undefined;
          this.#post(editor, { type: "settings:preview", spec: null });
          try { await this.#read(editor); } catch { throw new SettingsRefusal("The agent file was created, but readback failed. Reload before creating it again."); }
          message = "Agent definition created without overwriting any existing file. Existing children are unchanged.";
          break;
        }
        case "apply-default": {
          const apply = editor.binding.applyDefault;
          if (!apply) throw new SettingsRefusal("Open Models from a running Chat to apply the effective default to that exact session.");
          const result = await this.#worker(editor, { action: "resolve-default" });
          if (editor.binding.applyDefault !== apply) throw new SettingsRefusal("The launching Chat changed while resolving the default. Nothing was applied.");
          if (!record(result) || typeof result.provider !== "string" || typeof result.id !== "string" || (result.thinking !== undefined && typeof result.thinking !== "string")) throw new SettingsRefusal("OMP did not resolve a default model.");
          message = await apply({ provider: result.provider, id: result.id, thinking: result.thinking as string | undefined });
          break;
        }
        default: throw new SettingsRefusal("This settings action is unavailable.");
      }
      this.#post(editor, { type: "settings:result", requestId, ok: true, message });
    } catch (error) {
      this.#post(editor, { type: "settings:result", requestId, ok: false, message: error instanceof SettingsRefusal ? error.message : "The native settings operation could not complete. Reload before retrying." });
    } finally { editor.busy = false; }
  }
  /** OMP's own login in a visible terminal, in this editor's profile. */
  async #loginTerminal(editor: Editor, provider: string | undefined): Promise<string> {
    const runtime = await this.#runtime(editor);
    openProviderLoginTerminal({ executable: runtime.executable, args: ["--profile", editor.binding.profile, "login", ...(provider === undefined ? [] : [provider])],
      cwd: this.#cwd(editor), env: { OMP_PROFILE: editor.binding.profile }, name: "OMP settings login" });
    return "Complete OMP login in the visible terminal, then Reload this editor. Credentials are managed only by OMP.";
  }
  /**
   * Starts the provider sign-in of ADR-0070 through the host's in-process port and returns at once: the flow can run for minutes
   * and must not hold this editor's one operation slot. Its outcome arrives as a notice, followed by a fresh snapshot
   * when no other operation is running, so the page shows the provider's models as usable.
   */
  #signIn(editor: Editor, provider: string): void {
    const words: Readonly<Record<string, { ok: boolean; text: string }>> = {
      "signed-in": { ok: true, text: `Signed in to ${provider}.` },
      cancelled: { ok: true, text: `Sign-in to ${provider} was cancelled.` },
      terminal: { ok: true, text: `${provider} needs an API key, so a login terminal was opened. Reload this page when you are done.` },
      declined: { ok: true, text: `${provider} uses an API key, which OMP Desk never takes. Use the login terminal it offered, then reload this page.` },
      busy: { ok: false, text: "Another sign-in is already running in this window." },
    };
    const outcome = Promise.resolve(this.host.signIn({ providerId: provider, profile: editor.binding.profile, cwd: this.#cwd(editor) }));
    void outcome.catch(() => "failed").then(async result => {
      if (editor.disposed) return;
      const word = words[String(result)] ?? { ok: false, text: `Sign-in to ${provider} failed.` };
      this.#post(editor, { type: "settings:notice", ok: word.ok, message: word.text });
      if (editor.busy) return;
      try { await this.#read(editor); } catch { this.#post(editor, { type: "settings:notice", ok: false, message: `${word.text} Reload to read the models again.` }); }
    });
  }
  /**
   * OMP's hub flow: pick a model, then a thinking level for reasoning models, and save at once.
   * Dismissing the thinking step keeps the level the role had when the new model supports it.
   */
  async #assignRole(editor: Editor, raw: ConfigRecord): Promise<string> {
    const snapshot = editor.receipt?.snapshot;
    if (!snapshot) throw new SettingsRefusal("Reload before assigning a role.");
    const { role, scope: rawScope, step } = parseRoleAssignment(raw, snapshot.roles);
    const scope = this.#scope(editor, rawScope);
    const info = snapshot.roles.find(item => item.id === role);
    const persisted = valueAt(snapshot[scope], ["modelRoles", role]);
    const selector = typeof persisted === "string" ? persisted : info?.selector;
    const scopeLabel = editor.binding.folder !== null && snapshot.effective.modelRoleStorage === "project" ? ` (${scope})` : "";
    const previous = selector && selectorThinking(selector) || (role === "default" && snapshot.effective.defaultThinkingLevel === "auto" ? "auto" : "inherit");
    if (step === "thinking") {
      const model = snapshot.models.find(item => modelKey(item) === (selector ? selectorBase(selector) : info?.resolved)) ?? snapshot.models.find(item => modelKey(item) === info?.resolved);
      if (!selector || !model?.reasoning) throw new SettingsRefusal("This role's model has no thinking levels.");
      const thinking = await pickSettingsThinking(model.efforts, previous, `Thinking for ${role}${scopeLabel} · ${selectorBase(selector)}`, editor.abort.signal);
      if (thinking === undefined) return "";
      const change = roleChange(role, selector, thinking, scope);
      return this.#save(editor, scope, change.edits, change.thinking);
    }
    const picked = await pickSettingsModel({ purpose: "role", snapshot, role, current: info?.resolved ?? selector, clearable: typeof persisted === "string" }, `Model for ${role}${scopeLabel}`, editor.abort.signal);
    if (picked === undefined) return "";
    if (picked === "") return this.#save(editor, scope, roleChange(role, "", undefined, scope).edits);
    const model = snapshot.models.find(item => modelKey(item) === picked);
    let thinking: string | undefined;
    if (model?.reasoning) {
      const kept = ["inherit", "off", "auto", ...model.efforts].includes(previous) ? previous : "inherit";
      thinking = await pickSettingsThinking(model.efforts, kept, `Thinking for ${role}${scopeLabel} · ${picked}`, editor.abort.signal) ?? kept;
    }
    const change = roleChange(role, picked, thinking, scope);
    return this.#save(editor, scope, change.edits, change.thinking);
  }
  async #cleanup(editor: Editor): Promise<void> {
    if (editor.runtime) await fs.rm(editor.runtime.cacheDirectory, { force: true, recursive: true }).catch(() => {});
  }
  dispose(): void { for (const editor of this.#editors.values()) editor.panel.dispose(); for (const item of this.#disposables) item.dispose(); }
}
