import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { stageRuntimeAssets, verifyStagedRuntimeAsset } from "../runtime-assets";
import type { StagedRuntimeAsset } from "../runtime-assets";
import { openProviderLoginTerminal, resolveBunRuntime, resolveOmpBinary, resolveOmpPackageRoot } from "./native-terminal";
import type { OmpCommand } from "./native-terminal";
import { runSettingsWorker } from "./omp-settings-worker";
import { createSettingsHtml } from "./guest-webview";
import { parseAgentSpec, SettingsRefusal } from "./omp-settings-core";
import { isRecord as record } from "../guards";
import type { AgentSpec, ConfigEdit, ConfigRecord, SettingsScope, SettingsSnapshot } from "./omp-settings-core";
import type { SettingsKind } from "../chat/settings-command";
import type { SettingsMessage } from "../webview/settings/messages";

export interface SettingsEditorContext {
  readonly cwd: string; readonly profile: string; readonly executable?: OmpCommand;
  readonly sessionLabel?: string;
  readonly applyDefault?: (model: { provider: string; id: string; thinking?: string }) => Promise<string>;
}
interface FileBaseline { logical: string; physical: string; exists: boolean; digest: string; settings: ConfigRecord }
interface ReadReceipt { snapshot: SettingsSnapshot; files: Record<SettingsScope, FileBaseline> }
interface StoredContext { key: string; kind: SettingsKind; cwd: string; profile: string }
interface Editor {
  readonly panel: vscode.WebviewPanel; readonly key: string; readonly kind: SettingsKind;
  binding: SettingsEditorContext; receipt?: ReadReceipt; preview?: AgentSpec;
  runtime?: { bun: string; packageRoot: string; asset: StagedRuntimeAsset; cacheDirectory: string; executable: OmpCommand };
  readonly abort: AbortController; busy: boolean; disposed: boolean;
  readonly requests: Map<string, Promise<void>>;
  readonly pending: Set<Promise<void>>;
}
const VIEW_TYPE = "omp.settings";
const STORED_CONTEXTS = "omp.settings.contexts";

/** One editor per native profile/folder/surface, independent of conversation slots and claims. */
export class SettingsEditors implements vscode.Disposable {
  readonly #editors = new Map<string, Editor>();
  readonly #disposables: vscode.Disposable[] = [];
  constructor(readonly context: vscode.ExtensionContext, readonly pickContext: (kind: SettingsKind, argument: unknown) => Promise<SettingsEditorContext | null>) {
    this.#disposables.push(
      vscode.commands.registerCommand("omp.openModels", (argument: unknown) => this.open("models", undefined, argument)),
      vscode.commands.registerCommand("omp.openAgents", (argument: unknown) => this.open("agents", undefined, argument)),
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, raw: unknown) => {
          const stored = record(raw) && typeof raw.key === "string" ? this.#stored().find(item => item.key === raw.key) : undefined;
          if (!stored) { panel.dispose(); return; }
          this.#attach(panel, stored.key, stored.kind, { cwd: stored.cwd, profile: stored.profile });
        },
      }),
    );
  }
  async open(kind: SettingsKind, binding?: SettingsEditorContext, argument?: unknown): Promise<void> {
    const chosen = binding ?? await this.pickContext(kind, argument);
    if (!chosen) return;
    const key = createHash("sha256").update(JSON.stringify([kind, path.resolve(chosen.cwd), chosen.profile])).digest("hex");
    const existing = this.#editors.get(key);
    if (existing) {
      existing.binding = chosen;
      this.#init(existing);
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const contexts = this.#stored().filter(item => item.key !== key);
    contexts.push({ key, kind, cwd: chosen.cwd, profile: chosen.profile });
    await this.context.workspaceState.update(STORED_CONTEXTS, contexts.slice(-32));
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, kind === "models" ? "OMP Models" : "OMP Agents", vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    });
    this.#attach(panel, key, kind, chosen);
  }
  #stored(): StoredContext[] {
    const stored: unknown = this.context.workspaceState.get(STORED_CONTEXTS);
    return Array.isArray(stored) ? stored.filter((item): item is StoredContext => record(item)
      && typeof item.key === "string" && /^[a-f0-9]{64}$/.test(item.key)
      && (item.kind === "models" || item.kind === "agents")
      && typeof item.cwd === "string" && path.isAbsolute(item.cwd) && typeof item.profile === "string") : [];
  }
  #attach(panel: vscode.WebviewPanel, key: string, kind: SettingsKind, binding: SettingsEditorContext): void {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] };
    panel.iconPath = new vscode.ThemeIcon(kind === "models" ? "symbol-variable" : "organization");
    const editor: Editor = { panel, key, kind, binding, abort: new AbortController(), busy: false, disposed: false, requests: new Map(), pending: new Set() };
    this.#editors.set(key, editor);
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
      editor.disposed = true; editor.abort.abort(); this.#editors.delete(key);
      void Promise.allSettled(editor.pending).then(() => this.#cleanup(editor));
    });
    panel.webview.html = createSettingsHtml(panel.webview, this.context.extensionUri);
  }
  #post(editor: Editor, message: SettingsMessage): void { if (!editor.disposed) void editor.panel.webview.postMessage(message); }
  #init(editor: Editor): void {
    this.#post(editor, { type: "settings:init", key: editor.key, kind: editor.kind, canApply: Boolean(editor.binding.applyDefault), sessionLabel: editor.binding.sessionLabel });
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
      cwd: editor.binding.cwd, profile: editor.binding.profile, signal: editor.abort.signal,
      request: { ...request, catalogueCache: path.join(runtime.cacheDirectory, "models.db") } });
  }
  async #read(editor: Editor, action = "read", provider?: string): Promise<void> {
    const result = await this.#worker(editor, { action, provider });
    if (!record(result) || !record(result.snapshot) || !record(result.files)) throw new SettingsRefusal("OMP returned an invalid settings snapshot.");
    editor.receipt = result as unknown as ReadReceipt;
    this.#post(editor, { type: "settings:snapshot", snapshot: editor.receipt.snapshot, configExists: { global: editor.receipt.files.global.exists, project: editor.receipt.files.project.exists } });
  }
  #scope(raw: ConfigRecord): SettingsScope {
    if (raw.scope !== "global" && raw.scope !== "project") throw new SettingsRefusal("Choose global or project scope.");
    return raw.scope;
  }
  async #save(editor: Editor, scope: SettingsScope, edits: ConfigEdit[], thinking?: string, preset?: string): Promise<string> {
    const receipt = editor.receipt;
    if (!receipt) throw new SettingsRefusal("Reload before saving.");
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
          const scope = this.#scope(raw);
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
        case "refresh": case "login": {
          if (raw.provider !== undefined && (typeof raw.provider !== "string" || !editor.receipt?.snapshot.providers.some(provider => provider.id === raw.provider))) throw new SettingsRefusal("Choose a discovered provider.");
          if (raw.action === "refresh") {
            await this.#read(editor, "refresh", raw.provider as string | undefined);
            message = "Provider catalogue refreshed. OMP may have persisted refreshed credentials; catalogue changes remain in this editor's private cache.";
          } else {
            const runtime = await this.#runtime(editor);
            openProviderLoginTerminal({ executable: runtime.executable, args: ["--profile", editor.binding.profile, "login", ...(typeof raw.provider === "string" ? [raw.provider] : [])],
              cwd: editor.binding.cwd, env: { OMP_PROFILE: editor.binding.profile }, name: "OMP settings login" });
            message = "Complete OMP login in the visible terminal, then Reload this editor. Credentials are managed only by OMP.";
          }
          break;
        }
        case "open-config": {
          const scope = this.#scope(raw);
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
          const scope = this.#scope(raw);
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
  async #cleanup(editor: Editor): Promise<void> {
    if (editor.runtime) await fs.rm(editor.runtime.cacheDirectory, { force: true, recursive: true }).catch(() => {});
  }
  dispose(): void { for (const editor of this.#editors.values()) editor.panel.dispose(); for (const item of this.#disposables) item.dispose(); }
}
