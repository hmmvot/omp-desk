/**
 * What OMP 18.10 does at run time when a built-in model role has no model assigned
 * (design 2026-10-13, "Item 6"; sources are `pi-coding-agent/src/…` of that version). Static text keyed by
 * built-in role id, because the behaviour lives in each consumer, not in a function that could report it.
 * `list` says whether OMP ships a built-in priority list for the role (`rolePriorityDefaults`); a live
 * test fails when OMP and this table disagree.
 */
export interface RoleNote {
  /** One line for a row or the "Effective now" box: what an unassigned role does. */
  readonly summary: string;
  /** The full behaviour, for the detail pane. */
  readonly details: string;
  readonly list: boolean;
  /** OMP's tool resolves this role with `resolveRoleChain`: the role, then the retry fallback chain or the built-in list, over the models the role accepts. */
  readonly chain?: true;
}

export const ROLE_NOTES: Readonly<Record<string, RoleNote>> = {
  default: { list: false, summary: "not assigned · a session uses its restored or first available model",
    details: "No fallback role. A session starts on its restored model, else the first available provider-default model; with no signed-in provider it starts without a model and asks you to log in." },
  smol: { list: true, summary: "not assigned · follows default, then OMP's fast list",
    details: "Roles that name @smol use the default role when it is set, else OMP's built-in fast-model list. Code that reads the role directly (edit auto-repair, sharpshooter) skips it." },
  slow: { list: true, summary: "not assigned · follows default, then OMP's thinking list",
    details: "Roles that name @slow (the reviewer agent, the slow tier of eval completion) use the default role when it is set, else OMP's built-in thinking-model list." },
  vision: { list: false, summary: "not assigned · tries default, then the active model, then any image-capable model",
    details: "Image questions try @vision, @default, the active model, an image-capable model of the active provider, then any image-capable model. With none, the read tool reports that a vision-capable model must be configured." },
  plan: { list: false, summary: "not assigned · plan mode keeps the active model",
    details: "No fallback. Plan mode does not switch models and runs on the model you are using." },
  commit: { list: false, summary: "not assigned · uses smol, then another configured chat role",
    details: "Commit message generation takes the first configured role of commit, smol, then the other chat roles. With none configured it fails with “No model available for commit generation”." },
  tiny: { list: true, summary: "not assigned · follows smol",
    details: "Follows smol even when smol is unset (then default, then OMP's fast list). Titles and classifiers use configured roles first and then the active model." },
  memory: { list: true, chain: true, summary: "not assigned · follows tiny, then smol",
    details: "Memory extraction follows tiny, then smol, then the default role if set, then OMP's fast list. With no model it runs without an LLM and logs a warning." },
  task: { list: false, summary: "not assigned · subagents use the spawning session's model",
    details: "An agent whose definition says @task runs on the model of the session that spawns it, else on the default role." },
  advisor: { list: true, summary: "not assigned · uses slow if set, else OMP's thinking list",
    details: "The advisor (off by default) uses the slow role when it is set, else OMP's built-in thinking-model list. It never inherits the default role or the main model. With no candidate it is skipped." },
  image: { list: true, chain: true, summary: "not assigned · OMP's image model list",
    details: "Image generation (off by default) tries OMP's built-in image models in order and skips ones without credentials; if none is usable it fails." },
  web: { list: true, chain: true, summary: "not assigned · OMP's web search providers",
    details: "Web search tries OMP's built-in providers in order, keyless ones last; with none available the tool reports that no web search model is configured." },
  speech: { list: true, chain: true, summary: "not assigned · OMP's speech model list",
    details: "Speech (off by default) tries OMP's built-in voices in order (a local model, then hosted ones); with none usable it reports an error." },
  dictation: { list: true, chain: true, summary: "not assigned · OMP's local speech-to-text model",
    details: "Dictation uses OMP's built-in local speech-to-text model." },
  judge: { list: true, chain: true, summary: "not assigned · OMP's judge list, then tiny, smol, default",
    details: "Judgments try OMP's built-in judge models, then @tiny, @smol and @default; the session's own model is appended when no candidate is native." },
};

const CUSTOM: RoleNote = { list: false, summary: "not assigned · no built-in behaviour",
  details: "A custom role has no built-in behaviour. It matters only where a setting, an agent or the cycle order names it." };
export function roleNote(id: string): RoleNote { return Object.hasOwn(ROLE_NOTES, id) ? ROLE_NOTES[id]! : CUSTOM; }
