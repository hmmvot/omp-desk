import { embeddedSkillInvokedAt } from "../../chat/prompt-routing.ts";
import type { ChatSlashCommand } from "../../chat/model.ts";
import { classifySlashInput } from "../../protocol/rpc.ts";

/**
 * Commands Chat runs itself before anything is sent. `/rewind` and `/branch` are Chat's in-place Rewind, as they are
 * OMP's TUI rewind selector (`branch`, alias `rewind`); they never reach OMP or its fork-into-a-new-file RPC `branch`.
 * `/clear`, `/new` and `/delete` are the session-clearing commands of OMP's TUI as Desk runs them (ADR-0059): they
 * replace the catalogue entries of the same names, which OMP itself only runs in its terminal UI. `/fork` is OMP's, run as Desk's
 * Fork: a new Chat tab, never OMP's in-place switch. `/btw` is OMP's side question, answered by Desk in a panel over the composer: OMP's
 * RPC mode does not run it as text, so it would reach the model as an ordinary prompt.
 */
const DESK_COMMANDS: readonly ChatSlashCommand[] = [
 { name: "models", aliases: ["model"], source: "OMP Desk", description: "Open native Models settings (selector arguments retain OMP RPC semantics)" },
 { name: "agents", source: "OMP Desk", description: "Open native Agents settings" },
 { name: "settings", source: "OMP Desk", description: "Open OMP Desk's editor for OMP settings (global and project layers)" },
 { name: "rewind", aliases: ["branch"], source: "OMP Desk", description: "Rewind the conversation to an earlier message (Esc Esc)" },
 { name: "clear", source: "OMP Desk", description: "Clear the conversation context in place; the session, its file and its title stay" },
 { name: "fresh", source: "OMP Desk", description: "Rotate provider state without clearing local conversation history" },
 { name: "new", source: "OMP Desk", description: "Start a new session in this folder in place of this tab; this one stays in Sessions" },
 { name: "delete", source: "OMP Desk", description: "Delete this session after confirming, then start a new one in this tab" },
 { name: "fork", source: "OMP Desk", description: "Open a copy of this session in a new Chat tab beside it; this one keeps running" },
 { name: "btw", source: "OMP Desk", description: "Ask a side question that stays out of the conversation, or browse earlier ones", inputHint: "[question]" },
];

/** What `slashQueryAt` found: the token `[start, end)` under the caret, the text typed in it up to the caret (lower case, without the `/`), and whether only skills are offered (a token in the middle of the text). */
export interface SlashQuery {
	readonly query: string;
	readonly start: number;
	readonly end: number;
	readonly skillsOnly: boolean;
}

/** The name part of a mid-text token (after its `/`): an optional `skill:`, then a name of `[\w-]` with at most one `/` (a skill namespace, `agents/jira-cli`). A `.`, a `:` elsewhere, `//` or a second `/` is a path or a URL. */
const EMBEDDED_TOKEN_BODY = /^(?:skill:)?(?:[\w-]+(?:\/[\w-]*)?)?$/i;

/**
 * The `/` token the caret is in, if completion owns it. The leading command token lists every command and skill. A token in the middle of
 * the draft lists skills only, because OMP invokes nothing else there (docs/designs/2026-10-18-composer-command-skill-chips.md,
 * amendment 2026-10-20): it must start right after whitespace or a line break, have the shape of a skill name (`EMBEDDED_TOKEN_BODY`: no path,
 * no URL), have something typed after the `/`, match at least one skill of `commands` as the leading list matches (name or alias contains the
 * query, so `/ask-` finds `skill:ask-matt`), and be where OMP would invoke it (`embeddedSkillInvokedAt`, the gate of the chip scan: not after
 * a leading command or a local-execution sigil, not after an earlier skill token). When no skill matches, nothing opens.
 */
export function slashQueryAt(text: string, caret: number, commands: readonly ChatSlashCommand[]): SlashQuery | null {
 if (!Number.isSafeInteger(caret) || caret < 1 || caret > text.length) return null;
 const leading = /^\/([\w:-]*)(?=\s|$)/.exec(text);
 if (leading) {
  if (caret > leading[0].length || leading[0].length > 257) return null;
  return { query: text.slice(1, caret).toLowerCase(), start: 0, end: leading[0].length, skillsOnly: false };
 }
 let start = caret;
 while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
 if (start === caret || text[start] !== "/") return null;
 let end = caret;
 while (end < text.length && !/\s/.test(text[end]!)) end++;
 if (end - start > 257 || !EMBEDDED_TOKEN_BODY.test(text.slice(start + 1, end))) return null;
 const query = text.slice(start + 1, caret).toLowerCase();
 if (query.length === 0 || !embeddedSkillInvokedAt(text, start) || slashSuggestions(commands, query, true).length === 0) return null;
 return { query, start, end, skillsOnly: true };
}

/** Every command Chat can act on, before any query: Desk's own commands, then what the session advertises (denied owners and their aliases never appear). */
export function slashCatalogue(commands: readonly ChatSlashCommand[]): readonly ChatSlashCommand[] {
 const catalogue = [...DESK_COMMANDS, ...commands.filter(command => !DESK_COMMANDS.some(local => local.name === command.name || local.aliases?.includes(command.name))).map(deskListed)];
 return catalogue.filter(command => DESK_COMMANDS.includes(command) || !classifySlashInput(`/${command.name}`, commands).denied);
}

/**
 * Denied owners and every advertised alias disappear together; selection dispatches the owner. The list is ranked: the entry whose
 * name or alias is exactly the query comes first (so a typed full name is the selected row), then every command (OMP's builtins, file,
 * extension and custom commands, Desk's own) before any skill (`source: "skill"`), each group in catalogue order.
 */
export function slashSuggestions(commands: readonly ChatSlashCommand[], query: string, skillsOnly = false): readonly ChatSlashCommand[] {
 const rank = (command: ChatSlashCommand): number => (query.length > 0 && (command.name.toLowerCase() === query || command.aliases?.some(alias => alias.toLowerCase() === query)) ? 0 : command.source === "skill" ? 2 : 1);
 return slashCatalogue(commands)
  .filter(command => (!skillsOnly || command.source === "skill") && (command.name.toLowerCase().includes(query) || command.aliases?.some(alias => alias.toLowerCase().includes(query))))
  .map((command, index) => ({ command, index, rank: rank(command) }))
  .sort((a, b) => a.rank - b.rank || a.index - b.index)
  .slice(0, 50)
  .map(entry => entry.command);
}

/** Whether a draft is Chat's own `/rewind` or `/branch` (case-insensitive, nothing after it): the page opens Rewind instead of sending. */
export function isRewindCommand(text: string): boolean {
 return /^\/(?:rewind|branch)\s*$/i.test(text.trim());
}

export function spliceSlash(text: string, token: { start: number; end: number }, name: string): { text: string; caret: number } {
 const prefix = `/${name} `;
 return { text: text.slice(0, token.start) + prefix + text.slice(token.end).replace(/^ /, ""), caret: token.start + prefix.length };
}

export function parseArgumentHint(hint?: string): { text: string; requirement: "optional" | "required" | "unknown" } {
 const text = hint?.trim() ?? "";
 return { text, requirement: /^\[[\s\S]+\]$/.test(text) ? "optional" : /^<[^>]+>(?:\s|$)/.test(text) ? "required" : "unknown" };
}

/**
 * OMP's bundled `/review` is a custom command whose catalogue entry says only "Launch interactive code review" with the hint
 * "arguments"; it asks its questions as dialogs of the Chat. The Desk text names what it offers. Only the bundled entry is
 * rewritten (a same-named command of the user's own keeps its own text, and so does a later OMP text).
 */
const BUNDLED_REVIEW_TEXT = "Launch interactive code review";
const DESK_REVIEW: Pick<ChatSlashCommand, "description" | "inputHint"> = {
 description: "Review code: pick uncommitted changes, a branch diff, a commit or a pull request (needs the GitHub CLI), or write your own request",
 inputHint: "[PR link] [what to focus on]",
};

/** The command as Desk lists it: OMP's entry with the Desk text where one is defined. */
function deskListed(command: ChatSlashCommand): ChatSlashCommand {
 return command.name === "review" && command.source === "custom" && command.description === BUNDLED_REVIEW_TEXT ? { ...command, ...DESK_REVIEW } : command;
}

function resolveCommand(commands: readonly ChatSlashCommand[], name: string): ChatSlashCommand | undefined {
 const command = commands.find(command => command.name.toLowerCase() === name.toLowerCase() || command.aliases?.some(alias => alias.toLowerCase() === name.toLowerCase()));
 return command && !classifySlashInput(`/${command.name}`, commands).denied ? deskListed(command) : undefined;
}

/** Only the first argument token is variant-owned; later arguments remain ordinary text. */
export function slashArgumentAt(commands: readonly ChatSlashCommand[], text: string, caret: number) {
 if (!Number.isSafeInteger(caret) || caret < 1 || caret > text.length) return null;
 const match = /^\/([\w:-]+)[ \t]+([^\s]*)/.exec(text);
 if (!match || caret < match[0].length - match[2]!.length || caret > match[0].length) return null;
 const command = resolveCommand(commands, match[1]!);
 if (!command || (!command.inputHint && !command.subcommands?.length)) return null;
 const start = match[0].length - match[2]!.length;
 return { command, start, end: match[0].length, query: text.slice(start, caret).toLowerCase(), hint: parseArgumentHint(command.inputHint) };
}

export function argumentSuggestions(command: ChatSlashCommand, query: string) {
 return (command.subcommands ?? []).filter(row => row.name.toLowerCase().includes(query)).slice(0, 50).map(row => ({
  ...row, isDefault: /\(default\)/i.test(row.description ?? ""),
 }));
}

export function spliceArgument(text: string, start: number, end: number, name: string): { text: string; caret: number } {
 const prefix = text.slice(0, start) + name + " ";
 return { text: prefix + text.slice(end).replace(/^ /, ""), caret: prefix.length };
}

/** A shared submit guard also covers Send, host keybindings and a dismissed popup. */
export function missingRequiredArgument(commands: readonly ChatSlashCommand[], text: string): boolean {
 const match = /^\/([\w:-]+)\s*$/.exec(text);
 return !!match && parseArgumentHint(resolveCommand(commands, match[1]!)?.inputHint).requirement === "required";
}
