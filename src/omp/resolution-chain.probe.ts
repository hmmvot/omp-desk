// Bun-only probe run by resolution.live.test.ts: checks `roleChain` against the installed OMP's own
// `resolveConfiguredModelPatterns` for every combination of configured roles. Prints one JSON line.
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { roleChain } from "./resolution.ts";
import type { NativeModules, NativeSettings } from "./settings-contracts.ts";

const root = process.argv[2];
if (!root) throw new Error("package root missing");
const resolver = await import(pathToFileURL(path.join(root, "src", "config", "model-resolver.ts")).href) as NativeModules["config/model-resolver.ts"];
const roleIds = ["default", "smol", "slow", "tiny", "memory", "advisor", "commit", "plan", "vision", "task", "judge", "image", "web", "speech", "dictation", "custom"];
const varied = ["default", "smol", "slow", "tiny", "memory", "custom"];
const problems: string[] = [];
let checked = 0;
for (let mask = 0; mask < 1 << varied.length; mask++) {
  const configured = new Map(varied.filter((_, index) => mask >> index & 1).map(id => [id, `provider/model-${id}`] as const));
  const settings = { getModelRole: (id: string) => configured.get(id) } as unknown as NativeSettings;
  for (const role of roleIds) {
    if (configured.has(role)) continue;
    const input = { resolver, settings, available: [], all: [], loginProviders: new Set<string>(), roleIds, defaultThinkingLevel: undefined, envRoles: {}, pool: () => [], agents: [] };
    const chain = roleChain(input, role);
    // Ground truth: what OMP's alias resolution returns for `@role` with these roles set.
    const patterns = resolver.resolveConfiguredModelPatterns(`@${role}`, settings);
    const truth = [...configured].find(([, value]) => patterns[0] === value)?.[0];
    checked++;
    if (truth !== undefined && chain.used !== truth) problems.push(`${[...configured.keys()].join("+") || "∅"}: @${role} uses ${truth}, chain says ${chain.used}`);
    if (truth === undefined && (chain.used !== "builtin" && chain.used !== "none")) problems.push(`${[...configured.keys()].join("+") || "∅"}: @${role} uses no set role, chain says ${chain.used}`);
    // The order explains every outcome: the role used is the first consulted role that is set.
    const firstSet = chain.consulted.find(id => configured.has(id));
    if ((firstSet ?? (truth === undefined ? chain.used : "")) !== (truth ?? chain.used)) problems.push(`${[...configured.keys()].join("+") || "∅"}: @${role} order ${chain.consulted.join(">")} does not explain ${truth ?? chain.used}`);
  }
}
const lists = Object.fromEntries(roleIds.map(id => [id, resolver.rolePriorityDefaults(id).length > 0]));
console.log(`CHAIN_PROBE ${JSON.stringify({ checked, problems, lists, advisor: roleChain({ resolver, settings: { getModelRole: () => undefined } as unknown as NativeSettings, available: [], all: [], loginProviders: new Set(), roleIds, defaultThinkingLevel: undefined, envRoles: {}, pool: () => [], agents: [] }, "advisor"), memory: roleChain({ resolver, settings: { getModelRole: () => undefined } as unknown as NativeSettings, available: [], all: [], loginProviders: new Set(), roleIds, defaultThinkingLevel: undefined, envRoles: {}, pool: () => [], agents: [] }, "memory") })}`);
