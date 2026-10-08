import type { AgentSpec, ConfigEdit, SettingsScope, SettingsSnapshot } from "../../host/omp-settings-core";
import type { SettingsKind } from "../../chat/settings-command";

export type SettingsAction =
  | { action: "ready" | "reload" | "apply-default"; requestId: string }
  | { action: "save"; requestId: string; scope: SettingsScope; edits: readonly ConfigEdit[]; thinking?: string }
  | { action: "refresh" | "login"; requestId: string; provider?: string }
  | { action: "open-config"; requestId: string; scope: SettingsScope }
  | { action: "preset"; requestId: string; name: string; operation: "save" | "switch" | "delete" }
  | { action: "open-agent"; requestId: string; agent: string }
  | { action: "generate"; requestId: string; description: string }
  | { action: "create"; requestId: string; scope: SettingsScope };
export type SettingsMessage =
  | { type: "settings:init"; key: string; kind: SettingsKind; canApply: boolean; sessionLabel?: string }
  | { type: "settings:snapshot"; snapshot: SettingsSnapshot }
  | { type: "settings:preview"; spec: AgentSpec | null }
  | { type: "settings:result"; requestId: string; ok: boolean; message: string };
