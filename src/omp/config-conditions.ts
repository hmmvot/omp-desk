/**
 * OMP's `ui.condition` names and what each means (ADR-0071). OMP evaluates them in `config/settings-ui.ts`
 * against its initialized global `Settings` singleton; that table is module-private, so the rules are repeated here
 * over a read-only reader. (An in-memory `Settings.init` could evaluate OMP's own table at run time; it was not used
 * because the singleton is process-wide state seeded from a different source than the files the editor shows, and
 * the repeated rules stay checkable without it.)
 *
 * The table is pinned two ways: `config-schema.live.test.ts` checks every condition name the installed OMP
 * uses is known and gives OMP's own answers for a sweep of settings (`config-conditions-probe.ts`, which does use
 * an in-memory init), and an unknown name at run time makes that one setting read-only (`condition-unknown`) instead
 * of guessing its visibility. Residual risk: a rule whose meaning changes under an unchanged name is only caught by the
 * live test, and the sweep does not exercise the project branch of `contextFilesExtraNotProject` or environment inputs.
 */
export interface ConditionReader {
  /** The value OMP reads for `id` (environment included), as `Setting.get` returns it. */
  value(id: string): unknown;
  /** The layer supplying `id` (`Setting.provenance`). */
  provenance(id: string): string;
  readonly platform: NodeJS.Platform;
}
/** `terminal`: OMP decides from the terminal it runs in, which a Desk page cannot know; the entry stays visible. */
export type ConditionOutcome = { readonly known: true; readonly visible: boolean; readonly terminal: boolean; readonly note: string } | { readonly known: false };

interface Rule { readonly test: (read: ConditionReader) => boolean | "terminal"; readonly note: string }

/** `Record` of static rules: the names are OMP's, one per `CONDITIONS` entry of `config/settings-ui.ts`. */
const RULES: Record<string, Rule> = {
  macOS: { test: read => read.platform === "darwin", note: "OMP shows this only on macOS." },
  hasImageProtocol: { test: () => "terminal", note: "OMP's terminal UI shows this only in a terminal that supports inline images." },
  nativeRendering: { test: () => "terminal", note: "OMP's terminal UI shows this only while its native renderer is active." },
  advisorEnabled: { test: read => read.value("advisor.enabled") === true, note: "Shown while Advisor is enabled." },
  vimModeEnabled: { test: read => read.value("tui.vimMode") === true, note: "Shown while Vim mode is enabled." },
  hindsightActive: { test: read => read.value("memory.backend") === "hindsight", note: "Shown while the memory backend is Hindsight." },
  mnemopiActive: { test: read => read.value("memory.backend") === "mnemopi", note: "Shown while the memory backend is Mnemopi." },
  autolearnActive: { test: read => read.value("autolearn.enabled") === true, note: "Shown while Auto-Learn is enabled." },
  autoThinkingActive: { test: read => read.value("defaultThinkingLevel") === "auto", note: "Shown while the default thinking level is auto." },
  usageAwareFallbackEnabled: { test: read => read.value("retry.usageAwareFallback") === true, note: "Shown while usage-aware fallback is enabled." },
  planModeEnabled: { test: read => read.value("plan.enabled") === true, note: "Shown while plan mode is enabled." },
  planAutosaveEnabled: { test: read => read.value("plan.enabled") === true && read.value("plan.autosave") === true, note: "Shown while plan mode and plan autosave are enabled." },
  contextFilesExtraNotProject: { test: read => read.provenance("contextFiles.extra") !== "project", note: "Hidden while a project layer supplies the list, so it is never promoted to the global layer." },
};

/** The settings ids the rules read: each must exist in the installed OMP (checked by the live test). */
export const CONDITION_INPUTS: readonly string[] = [
  "advisor.enabled", "tui.vimMode", "memory.backend", "autolearn.enabled", "defaultThinkingLevel",
  "retry.usageAwareFallback", "plan.enabled", "plan.autosave", "contextFiles.extra",
];
export const KNOWN_CONDITIONS: readonly string[] = Object.keys(RULES);

export function evaluateCondition(name: string, read: ConditionReader): ConditionOutcome {
  if (!Object.hasOwn(RULES, name)) return { known: false };
  const rule = RULES[name]!;
  const result = rule.test(read);
  return result === "terminal"
    ? { known: true, visible: true, terminal: true, note: rule.note }
    : { known: true, visible: result, terminal: false, note: rule.note };
}
