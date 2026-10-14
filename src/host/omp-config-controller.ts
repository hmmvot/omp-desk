import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SettingsRefusal } from "./omp-settings-core.ts";
import { locateYamlKey } from "./yaml-key-line.ts";
import { isRecord as record } from "../shared/guards.ts";
import { describeOutcome } from "../protocol/omp-config-model.ts";
import type { ConfigAction, ConfigChange, ConfigEntry, ConfigLayer, ConfigMessage, ConfigReceipt, ConfigValue } from "../protocol/omp-config-model.ts";
import type { ConfigRecord } from "../protocol/settings-model.ts";

/**
 * What the OMP Settings editor does with the page's actions (ADR-0071), with no VS Code in it: the host
 * panel supplies the ports. One operation runs at a time; a request id answers once; every write is
 * followed by a fresh read so the page never shows a value the files do not hold.
 */
export interface OmpConfigPorts {
  /** Runs the staged Bun worker for this editor's profile and folder; rejects with a `SettingsRefusal`. */
  worker(request: ConfigRecord): Promise<unknown>;
  post(message: ConfigMessage): void;
  key(): string;
  openFile(file: string, line: number | null): Promise<void>;
  /** Asks which scope to show: a folder, null for global, undefined when dismissed. */
  pickScope(current: string | null): Promise<string | null | undefined>;
  /** Moves the editor to another folder; answers the folder it now shows (the folder sessions run in for the one picked), or a sentence when it cannot (that scope is already open). */
  rebind(folder: string | null): Promise<{ readonly folder: string | null } | { readonly refusal: string }>;
}

/** OMP never treats the home directory as a project (`getConfigDirs` in `discovery/builtin.ts`): it has no project layer. */
function isHomeFolder(folder: string): boolean {
  const fold = (value: string): string => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return fold(folder) === fold(os.homedir());
}

const MAX_TEXT = 4096;
const MAX_LIST = 256;
const GENERIC = "The settings operation could not complete. Reload before retrying.";

/** The page's action, or null for anything that is not one of the contract's shapes. */
export function parseConfigAction(raw: unknown): ConfigAction | null {
  if (!record(raw) || typeof raw.requestId !== "string" || !/^[\w-]{1,80}$/.test(raw.requestId) || typeof raw.action !== "string") return null;
  const requestId = raw.requestId;
  const layer = raw.layer === "global" || raw.layer === "project" ? raw.layer : null;
  const id = typeof raw.id === "string" && raw.id.length > 0 && raw.id.length <= 256 ? raw.id : null;
  switch (raw.action) {
    case "ready": case "reload": case "pick-scope": return { action: raw.action, requestId };
    case "set": {
      const value = raw.value;
      const ok = typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= MAX_TEXT
        || Array.isArray(value) && value.length <= MAX_LIST && value.every(item => typeof item === "string" && item.length <= MAX_TEXT);
      return layer && id && ok ? { action: "set", requestId, id, layer, value: value as ConfigValue } : null;
    }
    case "reset": return layer && id ? { action: "reset", requestId, id, layer } : null;
    case "open-config": return layer && (raw.id === undefined || id) ? { action: "open-config", requestId, layer, ...(id ? { id } : {}) } : null;
    default: return null;
  }
}

export class OmpConfigController {
  #folder: string | null;
  #receipt: ConfigReceipt | undefined;
  #busy = false;
  readonly #answered = new Set<string>();
  readonly profile: string;
  readonly #ports: OmpConfigPorts;
  constructor(folder: string | null, profile: string, ports: OmpConfigPorts) { this.#folder = folder; this.profile = profile; this.#ports = ports; }

  get folder(): string | null { return this.#folder; }
  /** The global scope and the home folder have no project layer to read or write. */
  get projectAvailable(): boolean { return this.#folder !== null && !isHomeFolder(this.#folder); }

  /** Sends the editor's identity and scope; the page answers with `ready`. */
  init(): void { this.#ports.post({ type: "ompConfig:init", key: this.#ports.key(), folder: this.#folder, profile: this.profile, projectAvailable: this.projectAvailable }); }

  /** Handles one raw page message; never rejects. Resolves when the operation has been answered. */
  async handle(raw: unknown): Promise<void> {
    const action = parseConfigAction(raw);
    if (action === null) return;
    if (this.#answered.has(action.requestId)) return;
    this.#answered.add(action.requestId);
    if (this.#answered.size > 128) this.#answered.delete(this.#answered.values().next().value!);
    if (this.#busy) { this.#result(action.requestId, false, "A settings operation is still running."); return; }
    this.#busy = true;
    try { this.#result(action.requestId, true, await this.#run(action)); }
    catch (error) { this.#result(action.requestId, false, error instanceof SettingsRefusal ? error.message : GENERIC); }
    finally { this.#busy = false; }
  }

  #result(requestId: string, ok: boolean, message: string): void { this.#ports.post({ type: "ompConfig:result", requestId, ok, message }); }

  async #read(): Promise<ConfigReceipt> {
    const result = await this.#ports.worker({ action: "read", project: this.projectAvailable });
    if (!record(result) || !record(result.snapshot) || !record(result.baselines) || !Array.isArray(result.snapshot.entries) || !Array.isArray(result.snapshot.tabs)) throw new SettingsRefusal("OMP returned an invalid settings snapshot.");
    const receipt = result as unknown as ConfigReceipt;
    this.#receipt = receipt;
    this.#ports.post({ type: "ompConfig:snapshot", snapshot: receipt.snapshot });
    return receipt;
  }

  /** The layer a write targets; the global scope has no project folder to write. */
  #layer(layer: ConfigLayer): ConfigLayer {
    if (layer === "project" && !this.projectAvailable) throw new SettingsRefusal(this.#folder === null ? "Choose a project folder in the scope control first. Nothing was changed." : "OMP does not treat the home folder as a project, so it has no project layer. Nothing was changed.");
    return layer;
  }

  async #run(action: ConfigAction): Promise<string> {
    switch (action.action) {
      case "ready": this.init(); await this.#read(); return "";
      case "reload": await this.#read(); return "Reloaded the files and the values OMP uses.";
      // OMP's own panel removes the key when a text field is saved empty, instead of pinning "".
      case "set": return this.#save(action.value === "" && this.#entry(action.id)?.control?.kind === "text"
        ? { op: "reset", id: action.id, layer: action.layer } : { op: "set", id: action.id, layer: action.layer, value: action.value });
      case "reset": return this.#save({ op: "reset", id: action.id, layer: action.layer });
      case "open-config": return this.#open(action.layer, action.id);
      case "pick-scope": {
        const chosen = await this.#ports.pickScope(this.#folder);
        if (chosen === undefined || chosen === this.#folder) return "";
        const moved = await this.#ports.rebind(chosen);
        if ("refusal" in moved) return moved.refusal;
        const shown = moved.folder;
        this.#folder = shown;
        this.#receipt = undefined;
        this.init();
        await this.#read();
        return shown === null ? "Showing the global scope." : `Showing the project scope of ${shown}.`;
      }
    }
  }

  #entry(id: string): ConfigEntry | undefined { return this.#receipt?.snapshot.entries.find(candidate => candidate.id === id); }

  async #save(change: ConfigChange): Promise<string> {
    const receipt = this.#receipt;
    if (!receipt) throw new SettingsRefusal("Reload before saving.");
    const layer = this.#layer(change.layer);
    const result = await this.#ports.worker({ action: "write", project: this.projectAvailable, scope: layer, changes: [change], baseline: receipt.baselines[layer] });
    const changed = !record(result) || result.changed !== false;
    let fresh: ConfigReceipt;
    try { fresh = await this.#read(); }
    catch { throw new SettingsRefusal("The change was saved, but reading the files back failed. Reload to inspect the result before making another change."); }
    const entry = fresh.snapshot.entries.find(candidate => candidate.id === change.id);
    return entry ? describeOutcome(entry, change, changed) : changed ? "Saved." : "Nothing to save. The file was not rewritten.";
  }

  async #open(layer: ConfigLayer, id: string | undefined): Promise<string> {
    const receipt = this.#receipt;
    if (!receipt) throw new SettingsRefusal("Reload before opening a config file.");
    this.#layer(layer);
    const facts = receipt.snapshot.files[layer];
    if (!facts.exists) throw new SettingsRefusal(layer === "global" ? "The global OMP config does not exist yet. Saving a global setting here creates it." : "This folder has no .omp/config.yml yet. Saving a project setting here creates it.");
    let line: number | null = null;
    if (id !== undefined) {
      const entry = receipt.snapshot.entries.find(candidate => candidate.id === id);
      if (!entry) throw new SettingsRefusal(`OMP has no setting ${id}.`);
      if (entry.readOnly?.reason === "secret") throw new SettingsRefusal("This is a credential. OMP Desk never reads or opens it at a key.");
      try { line = locateYamlKey(await fs.readFile(facts.path, "utf8"), id.split(".")); } catch { line = null; }
    }
    await this.#ports.openFile(facts.path, line);
    return id !== undefined && line === null ? "This layer does not set that key; the file is open at the top." : "";
  }
}
