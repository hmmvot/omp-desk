import * as vscode from "vscode";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { StagedRuntimeAsset } from "./runtime-assets";
import type { OmpRuntimeServices } from "./omp-runtime-services";
import { checkSettingsRuntime } from "./settings-runtime";
import type { OmpCommand } from "./native-terminal";
import { runSettingsWorker } from "./omp-settings-worker";
import { createSettingsHtml } from "./guest-webview";
import { OmpConfigController } from "./omp-config-controller";
import { chooseSetting } from "./settings-pickers";
import { onDiskFolder, scopePickerFolders } from "./folder-display.ts";
import { normalizeWorkspaceDirectory } from "./session-files.ts";
import { SettingsRefusal } from "./omp-settings-core";
import { isRecord as record } from "../shared/guards";
import type { ConfigMessage } from "../protocol/omp-config-model";
import type { ConfigRecord } from "../protocol/settings-model";
import type { PickEntry } from "../protocol/settings-pick-items";
import { OMP_CONFIG_EDITOR_VIEW_TYPE } from "./settings-editor-ids";

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
const VIEW_TYPE = OMP_CONFIG_EDITOR_VIEW_TYPE;
const STORED_CONTEXTS = "ompDesk.ompSettings.contexts";
/** The key compares a folder by its identity (case-folded on Windows); `binding.folder` is the display spelling. */
const editorKey = (binding: OmpConfigBinding): string =>
  createHash("sha256").update(JSON.stringify([binding.folder === null ? null : normalizeWorkspaceDirectory(binding.folder), binding.profile])).digest("hex");

/**
 * The full OMP settings editor (ADR-0071): one editor per OMP profile and scope (global, or one project folder),
 * opened by `/settings` in Chat, `ompDesk.openOmpSettings` and the Sessions title menu. It shares the staged-Bun
 * runtime and the locked config transaction of the Models and Agents editors; the panel only hosts the page.
 */
export class OmpConfigEditors implements vscode.Disposable {
  readonly #editors = new Map<string, Editor>();
  constructor(readonly context: vscode.ExtensionContext, readonly host: OmpConfigEditorHost, readonly services: OmpRuntimeServices) {}
  /** `ompDesk.openOmpSettings`: a refusal to open (no Bun, no source) is shown as the error it is, with its reason. */
  async openFromCommand(): Promise<void> {
    try { await this.open({ folder: await this.host.defaultFolder(), profile: this.host.defaultProfile() }); }
    catch (error) {
      if (!(error instanceof SettingsRefusal)) throw error;
      void vscode.window.showErrorMessage(error.message);
    }
  }
  /** Revive a panel VS Code restored after a reload from what `raw` names; a panel with no stored context is closed. */
  deserialize(panel: vscode.WebviewPanel, raw: unknown): void {
    const stored = record(raw) && typeof raw.key === "string" ? this.#stored().find(item => item.key === raw.key) : undefined;
    if (!stored) { panel.dispose(); return; }
    this.#attach(panel, stored.key, { folder: stored.cwd, profile: stored.profile });
  }
  async open(requested: OmpConfigBinding): Promise<void> {
    const binding: OmpConfigBinding = requested.folder === null ? requested : { ...requested, folder: await onDiskFolder(requested.folder) };
    const key = editorKey(binding);
    const existing = this.#editors.get(key);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); existing.controller.init(); return; }
    // A new editor opens only on an OMP it can read. Otherwise the reason is the answer, not an empty panel that fails on its first read.
    await this.#environment(binding);
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
  /** Bun and the selected OMP's package source, or a refusal that says which of them is missing and why. */
  async #environment(binding: OmpConfigBinding): Promise<{ bun: string; root: string }> {
    // A configured path that cannot be used is a reason to tell, like a missing Bun, not an error to throw out of a command.
    const executable = binding.executable ?? await this.services.resolveOmpBinary().catch((error: unknown) => { throw this.services.isOmpUnavailable(error) ? new SettingsRefusal(error.message) : error; });
    const [bun, root] = await Promise.all([this.services.resolveBunRuntime(), this.services.resolveOmpPackageRoot(executable)]);
    const found = checkSettingsRuntime({ surface: "The OMP Settings editor", instead: "Run /settings in this session's Terminal view instead.", executable, bun, root });
    if (!found.ok) throw new SettingsRefusal(found.message);
    return { bun: found.bun, root: found.root.root };
  }
  async #runtime(editor: Editor): Promise<NonNullable<Editor["runtime"]>> {
    if (editor.runtime) return editor.runtime;
    const { bun, root } = await this.#environment(editor.binding);
    const [asset] = await this.services.stageRuntimeAssets({ storageDir: this.context.globalStorageUri.fsPath, sourcePaths: [vscode.Uri.joinPath(this.context.extensionUri, "out", "config-settings-worker.mjs").fsPath] });
    if (!asset) throw new SettingsRefusal("The settings worker is missing from this extension build.");
    const runtime = { bun, packageRoot: root, asset };
    editor.runtime = runtime;
    return runtime;
  }
  async #worker(editor: Editor, request: ConfigRecord): Promise<unknown> {
    const runtime = await this.#runtime(editor);
    if (!await this.services.verifyStagedRuntimeAsset(runtime.asset)) throw new SettingsRefusal("The settings worker's staged bytes changed. Reopen the editor.");
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
    const folders = await scopePickerFolders(this.host.folders(), current);
    const entries: PickEntry[] = [
      { label: `${current === null ? "$(check) " : ""}$(globe) Global`, description: "Global config only; no project layer", value: "global", current: current === null, available: true },
      ...(folders.length ? [{ separator: "Project folder" }] : []),
      ...folders.map(folder => { const here = current !== null && normalizeWorkspaceDirectory(folder) === normalizeWorkspaceDirectory(current); return { label: `${here ? "$(check) " : ""}$(folder) ${path.basename(folder) || folder}`, description: folder, value: `folder:${folder}`, current: here, available: true }; }),
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
    const folder = picked === null ? null : await onDiskFolder(picked);
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
  dispose(): void { for (const editor of this.#editors.values()) editor.panel.dispose(); }
}
