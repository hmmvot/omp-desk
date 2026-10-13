import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { CONDITION_INPUTS, evaluateCondition, KNOWN_CONDITIONS } from "./config-conditions.ts";
import type { ConditionReader } from "./config-conditions.ts";

/**
 * Test support, run by Bun: compares `config-conditions.ts` with OMP's own visibility predicates. OMP's
 * `createSettingsHost()` evaluates them over its global settings singleton, which an in-memory `Settings.init`
 * provides without touching any file; runtime overrides then sweep the inputs the rules read. Prints one JSON line.
 */
const packageRoot = process.argv[2];
if (!packageRoot) throw new Error("Usage: bun config-conditions-probe.ts <pi-coding-agent root>");
const load = async (relative: string): Promise<Record<string, unknown>> => await import(pathToFileURL(path.join(packageRoot, "src", relative)).href) as Record<string, unknown>;
interface Handle { override(scope: unknown, value: unknown): void; clearOverride(scope: unknown): void; get(scope: unknown): unknown; provenance(scope: unknown): string; ui?: { condition?: string } }
const { Settings } = await load("config/settings.ts") as unknown as { Settings: { init(options: { inMemory: boolean }): Promise<unknown> } };
const { lookup, all } = await load("config/registry.ts") as unknown as { lookup(id: string): Handle | undefined; all(): readonly (Handle & { id: string })[] };
await load("config/all-settings.ts");
const { createSettingsHost } = await load("config/settings-ui.ts") as unknown as { createSettingsHost(): { entries: readonly { path: string; condition?: () => boolean }[] } };
const settings = await Settings.init({ inMemory: true });
const handle = (id: string): Handle => { const found = lookup(id); if (!found) throw new Error(`missing ${id}`); return found; };
const reader: ConditionReader = { platform: process.platform, value: id => handle(id).get(settings), provenance: id => handle(id).provenance(settings) };
const names = new Set(all().map(setting => setting.ui?.condition).filter((name): name is string => name !== undefined));
const sweeps: Record<string, unknown>[] = [
  {},
  { "advisor.enabled": true, "tui.vimMode": true, "memory.backend": "mnemopi", "plan.enabled": true, "plan.autosave": true, "autolearn.enabled": true, "retry.usageAwareFallback": true, "defaultThinkingLevel": "auto" },
  { "memory.backend": "hindsight", "plan.enabled": false, "plan.autosave": true },
  { "plan.enabled": true, "plan.autosave": false, "advisor.enabled": false, "tui.vimMode": false },
];
const mismatches: string[] = [];
let checked = 0;
for (const sweep of sweeps) {
  for (const id of CONDITION_INPUTS) handle(id).clearOverride(settings);
  for (const [id, value] of Object.entries(sweep)) handle(id).override(settings, value);
  for (const entry of createSettingsHost().entries) {
    const name = handle(entry.path).ui?.condition;
    if (name === undefined || entry.condition === undefined) continue;
    const mine = evaluateCondition(name, reader);
    if (!mine.known) { mismatches.push(`${entry.path}: unknown condition ${name}`); continue; }
    if (mine.terminal) continue;
    checked += 1;
    const theirs = entry.condition();
    if (theirs !== mine.visible) mismatches.push(`${entry.path} [${name}] under ${JSON.stringify(sweep)}: OMP ${theirs}, editor ${mine.visible}`);
  }
}
process.stdout.write(JSON.stringify({ unknown: [...names].filter(name => !KNOWN_CONDITIONS.includes(name)), unused: KNOWN_CONDITIONS.filter(name => !names.has(name)), missingInputs: CONDITION_INPUTS.filter(id => lookup(id) === undefined), mismatches, checked }));
