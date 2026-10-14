import * as vscode from "vscode";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { stageRuntimeAssets, verifyStagedRuntimeAsset } from "./runtime-assets";
import type { StagedRuntimeAsset } from "./runtime-assets";
import { resolveBunRuntime, resolveOmpBinary, resolveOmpPackageRoot } from "./native-terminal";
import type { OmpCommand } from "./native-terminal";
import { runSettingsWorker } from "./omp-settings-worker";
import { createSettingsHtml } from "./guest-webview";
import { OmpConfigController } from "./omp-config-controller";
import { chooseSetting } from "./settings-pickers";
import { SettingsRefusal } from "./omp-settings-core";
import { isRecord as record } from "../shared/guards";
import type { ConfigMessage } from "../protocol/omp-config-model";
import type { ConfigRecord } from "../protocol/settings-model";
import type { PickEntry } from "../protocol/settings-pick-items";

/** The profile and folder an editor shows; `folder` is null for the global scope (no project layer). */
export interface OmpConfigBinding { readonly folder: string | null; readonly profile: string; readonly executable?: OmpCommand }
export interface OmpConfigEditorHost {
  /** The OMP profile a command-opened editor uses. */
  defaultProfile(): string;
  /** The folder a command-opened editor shows: the active session's own folder, else the folder sessions run in for the first workspace folder, else null. */
  defaultFolder(): Promise<string | null>;
  /** Folders offered by the scope control: the folders Sessions shows. */
  folders(): readonly string[];
}
interface StoredContext { key: string; cwd: string | null; profile: string }
interface Editor {
  readonly panel: vscode.WebviewPanel; key: string; binding: OmpConfigBinding; controller: OmpConfigController;
  runtime?: { bun: string; packageRoot: string; asset: StagedRuntimeAsset };
  readonly abort: AbortController; disposed: boolean; readonly pending: Set<Promise<void>>;
}
const VIEW_TYPE = "ompDesk.ompSettings";
const STORED_CONTEXTS = "ompDesk.ompSettings.contexts";
const editorKey = (binding: OmpConfigBinding): string =>
  createHash("sha256").update(JSON.stringify([binding.folder === null ? null : path.resolve(binding.folder), binding.profile])).digest("hex");

/**
 * The full OMP settings editor (ADR-0071): one editor per OMP profile and scope (global, or one project folder),
 * opened by `/settings` in Chat, `ompDesk.openOmpSettings` and the Sessions title menu. It shares the staged-Bun
 * runtime and the locked config transaction of the Models and Agents editors; the panel only hosts the page.
 */
export class OmpConfigEditors implements vscode.Disposable {
  readonly #editors = new Map<string, Editor>();
  readonly #disposables: vscode.Disposable[] = [];
  constructor(readonly context: vscode.ExtensionContext, readonly host: OmpConfigEditorHost) {
    this.#disposables.push(
      vscode.commands.registerCommand("ompDesk.openOmpSettings", async () => this.open({ folder: await host.defaultFolder(), profile: host.defaultProfile() })),
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, raw: unknown) => {
          const stored = record(raw) && typeof raw.key === "string" ? this.#stored().find(item => item.key === raw.key) : undefined;
          if (!stored) { panel.dispose(); return; }
          this.#attach(panel, stored.key, { folder: stored.cwd, profile: stored.profile });
        },
      }),
    );
  }
  async open(requested: OmpConfigBinding): Promise<void> {
    const binding = requested;
    const key = editorKey(binding);
    const existing = this.#editors.get(key);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); existing.controller.init(); return; }
    await this.#remember(key, binding);
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "OMP Settings", vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    });
    this.#attach(panel, key, binding);
  }
  async #remember(key: string, binding: OmpConfigBinding): Promise<void> {
    const contexts = this.#stored().filter(item => item.key !== key);
    contexts.push({ key, cwd: binding.folder, profile: binding.profile });
    await this.context.workspaceState.update(STORED_CONTEXTS, contexts.slice(-32));
  }
  #stored(): StoredContext[] {
    const stored: unknown = this.context.workspaceState.get(STORED_CONTEXTS);
    return Array.isArray(stored) ? stored.filter((item): item is StoredContext => record(item)
      && typeof item.key === "string" && /^[a-f0-9]{64}$/.test(item.key)
      && (item.cwd === null || typeof item.cwd === "string" && path.isAbsolute(item.cwd)) && typeof item.profile === "string") : [];
  }
  #attach(panel: vscode.WebviewPanel, key: string, binding: OmpConfigBinding): void {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] };
    panel.iconPath = new vscode.ThemeIcon("settings-gear");
    const editor: Editor = {
      panel, key, binding, abort: new AbortController(), disposed: false, pending: new Set(),
      controller: new OmpConfigController(binding.folder, binding.profile, {
        worker: request => this.#worker(editor, request),
        post: (message: ConfigMessage) => { if (!editor.disposed) void panel.webview.postMessage(message); },
        key: () => editor.key,
        openFile: (file, line) => this.#openFile(file, line),
        pickScope: current => this.#pickScope(editor, current),
        rebind: folder => this.#rebind(editor, folder),
      }),
    };
    this.#editors.set(key, editor);
    this.#title(editor);
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const operation = editor.controller.handle(raw);
      editor.pending.add(operation);
      void operation.finally(() => editor.pending.delete(operation));
    });
    panel.onDidDispose(() => { editor.disposed = true; editor.abort.abort(); this.#editors.delete(editor.key); });
    panel.webview.html = createSettingsHtml(panel.webview, this.context.extensionUri, "omp-settings.js", "OMP Settings");
  }
  #title(editor: Editor): void {
    const folder = editor.binding.folder;
    editor.panel.title = `OMP Settings · ${folder === null ? "Global" : path.basename(folder) || folder}`;
  }
  /** The global scope runs OMP from a drive root: no project config there, and no user-profile ancestors are walked. */
  #cwd(binding: OmpConfigBinding): string { return binding.folder ?? path.parse(this.context.globalStorageUri.fsPath).root; }
  async #runtime(editor: Editor): Promise<NonNullable<Editor["runtime"]>> {
    if (editor.runtime) return editor.runtime;
    const executable = editor.binding.executable ?? await resolveOmpBinary();
    const [bun, root] = await Promise.all([resolveBunRuntime(), resolveOmpPackageRoot(executable)]);
    if (!bun || !root) throw new SettingsRefusal("The settings editor requires Bun and the selected OMP installation's importable sources. Compiled-only OMP installations are not supported; use OMP's /settings in a terminal.");
    const [asset] = await stageRuntimeAssets({ storageDir: this.context.globalStorageUri.fsPath, sourcePaths: [vscode.Uri.joinPath(this.context.extensionUri, "out", "config-settings-worker.mjs").fsPath] });
    if (!asset) throw new SettingsRefusal("The settings worker is missing from this extension build.");
    const runtime = { bun, packageRoot: root.root, asset };
    editor.runtime = runtime;
    return runtime;
  }
  async #worker(editor: Editor, request: ConfigRecord): Promise<unknown> {
    const runtime = await this.#runtime(editor);
    if (!await verifyStagedRuntimeAsset(runtime.asset)) throw new SettingsRefusal("The settings worker's staged bytes changed. Reopen the editor.");
    return runSettingsWorker({
      bunPath: runtime.bun, helperPath: runtime.asset.path, packageRoot: runtime.packageRoot,
      cwd: this.#cwd(editor.binding), profile: editor.binding.profile, signal: editor.abort.signal, request,
    });
  }
  async #openFile(file: string, line: number | null): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const position = new vscode.Position(line ?? 0, 0);
    await vscode.window.showTextDocument(document, { preview: false, selection: new vscode.Range(position, position) });
  }
  async #pickScope(editor: Editor, current: string | null): Promise<string | null | undefined> {
    const folders = [...new Set([...this.host.folders(), ...(current === null ? [] : [current])])];
    const entries: PickEntry[] = [
      { label: `${current === null ? "$(check) " : ""}$(globe) Global`, description: "Global config only; no project layer", value: "global", current: current === null, available: true },
      ...(folders.length ? [{ separator: "Project folder" }] : []),
      ...folders.map(folder => ({ label: `${folder === current ? "$(check) " : ""}$(folder) ${path.basename(folder) || folder}`, description: folder, value: `folder:${folder}`, current: folder === current, available: true })),
      { separator: "" },
      { label: "$(folder-opened) Choose another folder…", value: "browse", current: false, available: true },
    ];
    const value = await chooseSetting(() => entries, { title: "OMP settings scope", placeholder: "Global, or the project folder whose .omp/config.yml to include", signal: editor.abort.signal });
    if (value === undefined) return undefined;
    if (value === "global") return null;
    if (value.startsWith("folder:")) return value.slice("folder:".length);
    const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Use folder" });
    return chosen?.[0]?.fsPath;
  }
  /** Moves an open editor to another scope of the same profile; a scope already open in another tab is revealed instead. */
  async #rebind(editor: Editor, picked: string | null): Promise<{ folder: string | null } | { refusal: string }> {
    const folder = picked;
    const binding: OmpConfigBinding = { folder, profile: editor.binding.profile, ...(editor.binding.executable ? { executable: editor.binding.executable } : {}) };
    const key = editorKey(binding);
    const other = this.#editors.get(key);
    if (other && other !== editor) { other.panel.reveal(vscode.ViewColumn.Active); return { refusal: "That scope is already open in another tab." }; }
    this.#editors.delete(editor.key);
    editor.key = key; editor.binding = binding;
    this.#editors.set(key, editor);
    await this.#remember(key, binding);
    this.#title(editor);
    return { folder };
  }
  dispose(): void { for (const editor of this.#editors.values()) editor.panel.dispose(); for (const item of this.#disposables) item.dispose(); }
}
