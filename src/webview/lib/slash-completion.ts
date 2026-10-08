import type { ChatSlashCommand } from "../../chat/model.ts";
import { classifySlashInput } from "../../host/rpc/protocol.ts";

const SETTINGS_COMMANDS: readonly ChatSlashCommand[] = [
 { name: "models", aliases: ["model"], source: "OMP Desk", description: "Open native Models settings (selector arguments retain OMP RPC semantics)" },
 { name: "agents", source: "OMP Desk", description: "Open native Agents settings" },
];

/** Only the leading command token is completion-owned; embedded skill tokens are prose. */
export function slashQueryAt(text: string, caret: number): { query: string; end: number } | null {
 if (!Number.isSafeInteger(caret) || caret < 1 || caret > text.length) return null;
 const match = /^\/([\w:-]*)(?=\s|$)/.exec(text);
 if (!match || caret > match[0].length || match[0].length > 257) return null;
 return { query: text.slice(1, caret).toLowerCase(), end: match[0].length };
}

/** Denied owners and every advertised alias disappear together; selection dispatches the owner. */
export function slashSuggestions(commands: readonly ChatSlashCommand[], query: string): readonly ChatSlashCommand[] {
 const catalogue = [...SETTINGS_COMMANDS, ...commands.filter(command => !SETTINGS_COMMANDS.some(setting => setting.name === command.name || setting.aliases?.includes(command.name)))];
 return catalogue.filter(command => !classifySlashInput(`/${command.name}`, commands).denied &&
  (command.name.toLowerCase().includes(query) || command.aliases?.some(alias => alias.toLowerCase().includes(query)))).slice(0, 50);
}

export function spliceSlash(text: string, end: number, name: string): { text: string; caret: number } {
 const prefix = `/${name} `;
 return { text: prefix + text.slice(end).replace(/^ /, ""), caret: prefix.length };
}

export function parseArgumentHint(hint?: string): { text: string; requirement: "optional" | "required" | "unknown" } {
 const text = hint?.trim() ?? "";
 return { text, requirement: /^\[[\s\S]+\]$/.test(text) ? "optional" : /^<[^>]+>(?:\s|$)/.test(text) ? "required" : "unknown" };
}

function resolveCommand(commands: readonly ChatSlashCommand[], name: string): ChatSlashCommand | undefined {
 const command = commands.find(command => command.name.toLowerCase() === name.toLowerCase() || command.aliases?.some(alias => alias.toLowerCase() === name.toLowerCase()));
 return command && !classifySlashInput(`/${command.name}`, commands).denied ? command : undefined;
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
