import type { AgentSpec, ConfigEdit, SettingsScope, SettingsSnapshot } from "../../host/omp-settings-core";
import type { SettingsKind } from "../../chat/settings-command";
import type { PickPurpose } from "../../host/settings-pick-items";

export type ListPickPurpose = Exclude<PickPurpose, "role">;
export type SettingsAction =
  | { action: "ready" | "reload" | "apply-default" | "pick-scope"; requestId: string }
  /** Opens the QuickPick of keys for a new fallback chain; the host answers with `settings:picked`. */
  | { action: "pick-chain-key"; requestId: string }
  | { action: "save"; requestId: string; scope: SettingsScope; edits: readonly ConfigEdit[]; thinking?: string }
  /** Opens the model QuickPick (`model`) or the thinking QuickPick (`thinking`) and saves the role at once, as OMP's hub does. */
  | { action: "assign-role"; requestId: string; role: string; scope: SettingsScope; step: "model" | "thinking" }
  /** Opens the model QuickPick for a list or switch value; the host answers with `settings:picked`. */
  | { action: "pick-model"; requestId: string; purpose: ListPickPurpose; current?: string; exclude?: readonly string[] }
  | { action: "refresh" | "login"; requestId: string; provider?: string }
  | { action: "open-config"; requestId: string; scope: SettingsScope }
  | { action: "preset"; requestId: string; name: string; operation: "save" | "switch" | "delete" }
  | { action: "open-agent"; requestId: string; agent: string }
  | { action: "generate"; requestId: string; description: string }
  | { action: "create"; requestId: string; scope: SettingsScope };
export type SettingsMessage =
  /** `folder` is null for the global scope: no project layer, no project agents and global writes only. */
  | { type: "settings:init"; key: string; kind: SettingsKind; folder: string | null; canApply: boolean; sessionLabel?: string }
  | { type: "settings:snapshot"; snapshot: SettingsSnapshot; configExists: Readonly<Record<SettingsScope, boolean>> }
  | { type: "settings:preview"; spec: AgentSpec | null }
  /** The value chosen in a `pick-model` or `pick-chain-key` QuickPick, null when dismissed; always followed by the request's `settings:result`. */
  | { type: "settings:picked"; requestId: string; value: string | null }
  | { type: "settings:result"; requestId: string; ok: boolean; message: string };
