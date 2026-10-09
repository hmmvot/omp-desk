/**
 * Which typed `/name` commands are OMP terminal-UI builtins that Chat must not send.
 *
 * In `--mode rpc-ui` a builtin without a text-mode `handle` is not run: OMP forwards the text to the model
 * as an ordinary prompt (`slash-commands/acp-builtins.ts`, `executeAcpBuiltinSlashCommand` returns `false`).
 * `get_available_commands` advertises only the builtins that have a `handle`, so the commands at risk are
 * exactly *the installed builtin registry minus what the session advertises*. The registry is read from the
 * selected OMP install by a bounded Bun helper (`media/slash-registry.mjs`), never from a list kept here, so
 * a new OMP release changes the set without a Desk release. A name the session advertises (a handled
 * builtin, or a skill/extension/custom/file command that reuses a TUI-only name) is never refused.
 *
 * Nothing here imports `vscode`.
 */
import { spawn } from "node:child_process";
import type { ChatSlashCommand } from "../chat/model.ts";
import { isRecord } from "../guards.ts";

/** One builtin of the installed registry: its names and whether rpc mode can run it. */
export interface BuiltinSlashEntry {
	readonly name: string;
	readonly aliases: readonly string[];
	/** The builtin has a text-mode `handle`, so rpc mode runs it instead of prompting the model. */
	readonly handled: boolean;
}

/** The installed registry, tagged with the install it was read from. */
export interface SlashRegistry {
	/** `<package root>@<version>`: a different install or version is read again. */
	readonly key: string;
	readonly commands: readonly BuiltinSlashEntry[];
}

const NAME = /^[a-z][a-z0-9_:-]{0,63}$/i;
const MAX_ENTRIES = 500;

/** The helper's JSON answer, validated; `null` for anything else. */
export function parseSlashRegistry(value: unknown): BuiltinSlashEntry[] | null {
	if (!isRecord(value) || value.ok !== true || !Array.isArray(value.commands)) return null;
	const entries: BuiltinSlashEntry[] = [];
	for (const row of value.commands.slice(0, MAX_ENTRIES)) {
		if (!isRecord(row) || typeof row.name !== "string" || !NAME.test(row.name) || typeof row.handled !== "boolean") continue;
		const aliases = Array.isArray(row.aliases) ? row.aliases.filter((alias): alias is string => typeof alias === "string" && NAME.test(alias)).slice(0, 20) : [];
		entries.push({ name: row.name, aliases, handled: row.handled });
	}
	return entries.length > 0 ? entries : null;
}

/** How long the helper may take: it imports the registry module graph of the installed OMP once. */
const HELPER_TIMEOUT_MS = 30_000;
const MAX_HELPER_OUTPUT = 512 * 1024;

/** Run the staged helper against one OMP package root; `null` when it cannot be read. */
export function readSlashRegistry(input: { readonly bunPath: string; readonly helperPath: string; readonly packageRoot: string; readonly cwd: string }): Promise<BuiltinSlashEntry[] | null> {
	const { promise, resolve } = Promise.withResolvers<BuiltinSlashEntry[] | null>();
	let output = "";
	let settled = false;
	const finish = (value: BuiltinSlashEntry[] | null): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(value);
	};
	const child = spawn(input.bunPath, [input.helperPath, "--package-root", input.packageRoot], {
		cwd: input.cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"],
	});
	const timer = setTimeout(() => { child.kill(); finish(null); }, HELPER_TIMEOUT_MS);
	timer.unref?.();
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		output += chunk;
		if (output.length > MAX_HELPER_OUTPUT) { child.kill(); finish(null); }
	});
	child.on("error", () => finish(null));
	child.on("close", () => {
		const line = output.trim().split(/\r?\n/).findLast(part => part.startsWith("{")) ?? "";
		try { finish(parseSlashRegistry(JSON.parse(line))); }
		catch { finish(null); }
	});
	return promise;
}

/** A Desk action that stands in for a terminal-UI command. */
export type DeskSlashAction = "keyboard-shortcuts" | "source-control" | "tools-view" | "provider-login" | "models-settings";

/** What Chat does with a terminal-UI command instead of sending it. */
export interface TuiCommandGuidance {
	/** The canonical builtin name (an alias resolves to it). */
	readonly command: string;
	/** The one line the page is told. */
	readonly line: string;
	/** The Desk equivalent the host runs, when one exists. */
	readonly action?: DeskSlashAction;
}

/**
 * The canonical TUI-only builtin a draft starts with, or `null`. Only a leading `/name` token counts (the
 * same token rule as the identity-command refusal); a name or alias the session advertises passes.
 */
export function tuiOnlyCommand(text: string, registry: readonly BuiltinSlashEntry[] | null, advertised: readonly ChatSlashCommand[]): string | null {
	if (registry === null) return null;
	const match = /^\s*\/([A-Za-z][A-Za-z0-9_-]*)(?=\s|$)/.exec(text);
	if (match === null) return null;
	const name = match[1]!.toLowerCase();
	for (const command of advertised) {
		if (command.name.toLowerCase() === name || command.aliases?.some(alias => alias.toLowerCase() === name)) return null;
	}
	const builtin = registry.find(entry => entry.name.toLowerCase() === name || entry.aliases.some(alias => alias.toLowerCase() === name));
	return builtin === undefined || builtin.handled ? null : builtin.name;
}

/**
 * The line (and Desk action) for one TUI-only builtin. Names with a Desk equivalent are mapped; every other
 * one — including builtins a later OMP adds — points at the same session in Terminal mode, where the native
 * UI runs it.
 */
export function tuiCommandGuidance(command: string): TuiCommandGuidance {
	const slash = `/${command}`;
	switch (command) {
		case "hotkeys":
			return { command, action: "keyboard-shortcuts", line: `${slash} is a terminal command; opened the OMP keyboard shortcuts instead.` };
		case "git":
			return { command, action: "source-control", line: `${slash} is a terminal command; opened Source Control instead.` };
		case "skills":
		case "extensions":
			return { command, action: "tools-view", line: `${slash} is a terminal command; opened the Skills and Tools view instead.` };
		case "setup":
		case "login":
			return { command, action: "provider-login", line: `${slash} is a terminal command; opened provider login instead.` };
		case "settings":
			return { command, action: "models-settings", line: `${slash} is a terminal command; opened the native Models settings instead.` };
		case "copy":
			return { command, line: `${slash} was not sent: use the Copy buttons on replies, code blocks and your messages.` };
		case "queue":
			return { command, line: `${slash} was not sent: queued messages are listed above the composer, with Edit, Remove and Send now.` };
		case "branch":
			return { command, line: `${slash} was not sent. Rewind takes no arguments: send /rewind or /branch alone, press Esc twice in an empty composer, or use the message's Rewind action.` };
		case "clear":
		case "new":
		case "restart":
		case "logout":
			return { command, line: `${slash} was not sent: it is a terminal command. Use the Sessions view to start, stop or resume sessions.` };
		default:
			return { command, line: `${slash} was not sent: it works only in OMP's terminal UI. Switch this editor to Terminal to use it.` };
	}
}
