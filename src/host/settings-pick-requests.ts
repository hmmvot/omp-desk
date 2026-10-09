import { SettingsRefusal } from "./omp-settings-core.ts";
import type { SettingsRole, SettingsScope } from "./omp-settings-core.ts";
import { LIST_PICK_PURPOSES } from "./settings-pick-items.ts";
import type { PickPurpose } from "./settings-pick-items.ts";

const shortText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
/** Validates a page's `pick-model` request; values are offered and returned, never executed. */
export function parseModelPickRequest(raw: Readonly<Record<string, unknown>>): { purpose: Exclude<PickPurpose, "role">; current?: string; exclude: string[] } {
  const purpose = LIST_PICK_PURPOSES.find(item => item === raw.purpose);
  if (!purpose) throw new SettingsRefusal("Choose what the model is for.");
  if (raw.current !== undefined && !shortText(raw.current)) throw new SettingsRefusal("The current value is invalid.");
  if (raw.exclude !== undefined && !(Array.isArray(raw.exclude) && raw.exclude.length <= 100 && raw.exclude.every(shortText))) throw new SettingsRefusal("The list being edited is invalid.");
  return { purpose, ...(raw.current === undefined ? {} : { current: raw.current }), exclude: raw.exclude === undefined ? [] : [...raw.exclude] };
}
/** Validates a page's `assign-role` request; changing only the thinking level needs a role OMP reported. */
export function parseRoleAssignment(raw: Readonly<Record<string, unknown>>, roles: readonly Pick<SettingsRole, "id">[]): { role: string; scope: SettingsScope; step: "model" | "thinking" } {
  if (typeof raw.role !== "string" || !/^[a-zA-Z][\w-]*$/.test(raw.role)) throw new SettingsRefusal("Use a letter, then letters, digits, - or _ for a role.");
  if (raw.scope !== "global" && raw.scope !== "project") throw new SettingsRefusal("Choose global or project scope.");
  if (raw.step !== "model" && raw.step !== "thinking") throw new SettingsRefusal("Choose a model or a thinking level.");
  if (raw.step === "thinking" && !roles.some(role => role.id === raw.role)) throw new SettingsRefusal("That role is no longer known. Reload before changing it.");
  return { role: raw.role, scope: raw.scope, step: raw.step };
}
