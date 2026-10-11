/**
 * Built-in tool → OMP's own on/off setting. Explicit, not inferred from spelling: every id is checked
 * against the installed registry at run time (and by the contract test). `find.enabled` is a
 * multi-state setting and is shown without a switch; `rewind` shares `checkpoint.enabled`.
 */
export const BUILTIN_SWITCHES: Readonly<Record<string, string>> = {
  bash: "bash.enabled", todo: "todo.enabled", glob: "glob.enabled", grep: "grep.enabled", ast_grep: "astGrep.enabled", ast_edit: "astEdit.enabled",
  debug: "debug.enabled", ida: "ida.enabled", github: "github.enabled", lsp: "lsp.enabled", ask: "ask.enabled", checkpoint: "checkpoint.enabled",
  web_search: "web_search.enabled", security_scan: "security.enabled", find: "find.enabled",
};
export const SHARED_SWITCH_NOTES: Readonly<Record<string, string>> = { rewind: "follows the checkpoint switch", checkpoint: "also controls rewind" };

