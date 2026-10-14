/**
 * The data behind the composer's Commands button: the slash completion's own catalogue (Desk's commands, then what the
 * session advertises, denied identity commands already removed), grouped and ordered for a list that can be browsed.
 *
 * "GUI support" means Desk handles the command with a native VS Code surface (an editor, a picker, a dialog or a page
 * action) instead of passing text to OMP or refusing it as terminal-only. Those commands come first and carry a marker
 * that names the surface; every other command is one OMP runs from chat text. Terminal-only commands without a Desk
 * equivalent, and the identity-changing commands Chat refuses, are not listed: Chat cannot run them, and the typed `/`
 * completion hides them for the same reason.
 *
 * Nothing here touches the DOM, the transport or the draft: {@link pickPlan} says what a pick does and the composer
 * does it.
 */
import { CLEAR_REFUSAL_SENTENCES } from "../../chat/clear.ts";
import { NEW_BUSY_SENTENCE } from "../../chat/desk-commands.ts";
import type { ChatSlashCommand } from "../../chat/model.ts";
import type { GuestChatCommand } from "../../protocol/messages.ts";
import { slashCatalogue, spliceSlash } from "./slash-completion.ts";

/** How a GUI-supported command runs when it is picked from the list. */
export type GuiRoute =
	/** The command text goes through the composer's send path and Desk's host answers it (native settings, session commands). */
	| { kind: "text" }
	/** Chat's own in-place Rewind. */
	| { kind: "rewind" }
	/** A named host action over `omp:chat-command`; `needs` says what the host requires of the conversation. */
	| { kind: "action"; command: GuestChatCommand; needs: "none" | "live" | "maintenance" };

/** What marks a command as GUI-supported, and what it does when picked. */
export interface GuiSupport {
	/** The surface the command opens, as the marker's tooltip says it. */
	readonly ui: string;
	readonly route: GuiRoute;
	/** Why the command cannot run while a turn is running; absent when it can. */
	readonly whileRunning?: string;
}

export type CommandGroup = "gui" | "command";

/** One row of the Commands list. */
export interface CommandRow {
	/** Canonical name, without the slash. */
	readonly name: string;
	readonly aliases: readonly string[];
	readonly description: string | undefined;
	/** The chip text: OMP, Skill, Prompt, Extension or Desk. */
	readonly source: string;
	readonly inputHint: string | undefined;
	/** The command accepts arguments (a hint or subcommands), so picking it completes the draft instead of running it. */
	readonly takesArguments: boolean;
	readonly gui: GuiSupport | null;
	readonly group: CommandGroup;
}

const RUNNING_PLAIN = "OMP runs this command only between turns. Wait for the turn or stop it, then pick it again.";
const FRESH_BUSY = "A response is running. Stop it first, then use /fresh.";

/** Desk's own commands (`slash-completion.ts`): every one is answered by Desk before anything reaches OMP. */
const DESK_GUI: Readonly<Record<string, GuiSupport>> = {
	models: { ui: "Opens the native Models settings editor", route: { kind: "text" } },
	agents: { ui: "Opens the native Agents settings editor", route: { kind: "text" } },
	settings: { ui: "Opens the OMP Settings editor", route: { kind: "text" } },
	rewind: { ui: "Opens the Rewind picker over the transcript", route: { kind: "rewind" } },
	clear: { ui: "Clears the conversation context in place and marks the transcript", route: { kind: "text" }, whileRunning: CLEAR_REFUSAL_SENTENCES.busy },
	fresh: { ui: "Rotates provider state in place and reports the result in the composer", route: { kind: "text" }, whileRunning: FRESH_BUSY },
	new: { ui: "Starts a new session in place of this tab", route: { kind: "text" }, whileRunning: NEW_BUSY_SENTENCE },
	delete: { ui: "Opens a confirmation dialog, then replaces this tab with a new session", route: { kind: "text" } },
};

/** OMP builtins the session advertises and Desk has a native surface for; the extension, skill and prompt commands of the same names are not these. */
const BUILTIN_GUI: Readonly<Record<string, GuiSupport>> = {
	compact: { ui: "Opens a mode picker, then compacts the conversation", route: { kind: "action", command: "compact", needs: "maintenance" } },
	shake: { ui: "Opens a mode picker, then shakes heavy content out of the context", route: { kind: "action", command: "shake", needs: "maintenance" } },
	export: { ui: "Opens a Save dialog and exports the conversation as HTML", route: { kind: "action", command: "export-html", needs: "live" } },
	share: { ui: "Opens a confirmation dialog, then shares the transcript", route: { kind: "action", command: "share", needs: "live" } },
};

/**
 * Terminal-only OMP builtins Desk stands in for. OMP's RPC mode does not advertise them, so the session's catalogue never
 * lists them; Desk answers them typed (the host's terminal-only guidance) and the list runs the same action directly, so a
 * pick never depends on the installed registry being known.
 */
const VIEW_COMMANDS: readonly (ChatSlashCommand & { gui: GuiSupport })[] = [
	{ name: "hotkeys", source: "builtin", description: "Show the OMP Desk keyboard shortcuts", gui: { ui: "Opens VS Code's Keyboard Shortcuts editor filtered to OMP Desk", route: { kind: "action", command: "keyboard-shortcuts", needs: "none" } } },
	{ name: "git", source: "builtin", description: "Open Source Control", gui: { ui: "Opens the Source Control view", route: { kind: "action", command: "source-control", needs: "none" } } },
	{ name: "skills", source: "builtin", description: "Browse the skills and tools of the session", gui: { ui: "Opens the Skills and Tools view of the OMP Desk side bar", route: { kind: "action", command: "tools-view", needs: "none" } } },
	{ name: "extensions", aliases: ["status"], source: "builtin", description: "Browse extensions, skills and tools", gui: { ui: "Opens the Skills and Tools view of the OMP Desk side bar", route: { kind: "action", command: "tools-view", needs: "none" } } },
	{ name: "setup", aliases: ["providers"], source: "builtin", description: "Set up a model provider", gui: { ui: "Opens the Log In to Provider picker, then signs in through your browser", route: { kind: "action", command: "provider-login", needs: "none" } } },
	{ name: "login", source: "builtin", description: "Log in to a model provider", gui: { ui: "Opens the Log In to Provider picker, then signs in through your browser", route: { kind: "action", command: "provider-login", needs: "none" } } },
];

/** The chip for a catalogue source: where the command comes from, in the words the list uses. */
export function commandSourceLabel(source: string | undefined): string {
	switch (source) {
		case "OMP Desk": return "Desk";
		case undefined:
		case "builtin": return "OMP";
		case "skill": return "Skill";
		case "extension": return "Extension";
		case "file":
		case "custom":
		case "mcp_prompt": return "Prompt";
		default: return source;
	}
}

function takesArguments(command: ChatSlashCommand): boolean {
	return (command.inputHint?.trim().length ?? 0) > 0 || (command.subcommands?.length ?? 0) > 0;
}

function guiFor(command: ChatSlashCommand): GuiSupport | null {
	if (command.source === "OMP Desk") return DESK_GUI[command.name] ?? null;
	return command.source === "builtin" ? BUILTIN_GUI[command.name] ?? null : null;
}

function advertises(commands: readonly ChatSlashCommand[], wanted: ChatSlashCommand): boolean {
	const names = [wanted.name, ...(wanted.aliases ?? [])].map(name => name.toLowerCase());
	return commands.some(command => names.includes(command.name.toLowerCase()) || command.aliases?.some(alias => names.includes(alias.toLowerCase())));
}

function rowOf(command: ChatSlashCommand, gui: GuiSupport | null): CommandRow {
	return {
		name: command.name,
		aliases: command.aliases ?? [],
		description: command.description,
		source: commandSourceLabel(command.source),
		inputHint: command.inputHint,
		takesArguments: takesArguments(command),
		gui,
		group: gui === null ? "command" : "gui",
	};
}

/** Every listed command, GUI-supported first, each group alphabetical. */
export function commandRows(commands: readonly ChatSlashCommand[]): readonly CommandRow[] {
	const rows = slashCatalogue(commands).map(command => rowOf(command, guiFor(command)));
	for (const { gui, ...command } of VIEW_COMMANDS) if (!advertises(commands, command)) rows.push(rowOf(command, gui));
	return rows.sort((a, b) => (a.group === b.group ? 0 : a.group === "gui" ? -1 : 1) || a.name.localeCompare(b.name, "en"));
}

/** How well `row` answers `query` (lower is better), or `null` when it does not. Names and aliases first, then the description. */
function relevance(row: CommandRow, query: string): number | null {
	const name = row.name.toLowerCase();
	if (name === query) return 0;
	if (name.startsWith(query)) return 1;
	if (row.aliases.some(alias => alias.toLowerCase().startsWith(query))) return 2;
	if (name.includes(query)) return 3;
	if (row.aliases.some(alias => alias.toLowerCase().includes(query))) return 4;
	return row.description?.toLowerCase().includes(query) ? 5 : null;
}

/** The rows that match a search: GUI-supported ones first, then by relevance, then alphabetically. An empty search keeps every row. */
export function filterCommandRows(rows: readonly CommandRow[], search: string): readonly CommandRow[] {
	const query = search.trim().replace(/^\/+/, "").toLowerCase();
	if (query.length === 0) return rows;
	return rows.flatMap(row => {
		const score = relevance(row, query);
		return score === null ? [] : [{ row, score }];
	}).sort((a, b) => (a.row.group === b.row.group ? 0 : a.row.group === "gui" ? -1 : 1) || a.score - b.score || a.row.name.localeCompare(b.row.name, "en")).map(entry => entry.row);
}

/** What the composer's state allows; the composer builds it from the snapshot so this module stays pure. */
export interface CommandContext {
	/** Why the composer cannot take a command text now (not live, read-only, a dialog open, held for replacement), or `null`. */
	readonly promptBlocked: string | null;
	/** Why the conversation cannot run a host action (not live, read-only), or `null`. */
	readonly sessionBlocked: string | null;
	/** A message of the draft is still waiting for OMP's confirmation. */
	readonly sendInFlight: boolean;
	/** A turn, a compaction or a maintenance pass is running. */
	readonly turnRunning: boolean;
	readonly maintenanceRunning: boolean;
	/** Why Rewind cannot open now, or `null`. */
	readonly rewindBlocked: string | null;
}

/**
 * Why a row cannot be picked now, or `null`. Commands that only complete the draft need a composer that takes text;
 * commands that run need the same plus a turn that is not running, because while one runs the composer steers and
 * OMP's builtins, skills and extension commands are not run from a steered message. A GUI command follows what its
 * own host action requires.
 */
export function commandAvailability(row: CommandRow, context: CommandContext): string | null {
	const route = row.gui?.route;
	if (route?.kind === "rewind") return context.rewindBlocked;
	if (route?.kind === "action") {
		if (route.needs === "none") return null;
		return context.sessionBlocked ?? (route.needs === "maintenance" && context.maintenanceRunning ? "Context maintenance is already running." : null);
	}
	if (context.promptBlocked !== null) return context.promptBlocked;
	if (route?.kind === "text") return context.sendInFlight ? "Waiting for OMP to confirm the previous message." : context.turnRunning ? row.gui?.whileRunning ?? null : null;
	if (row.takesArguments) return null;
	return context.sendInFlight ? "Waiting for OMP to confirm the previous message." : context.turnRunning ? RUNNING_PLAIN : null;
}

/** What picking a row does. */
export type PickPlan =
	| { kind: "rewind" }
	| { kind: "action"; command: GuestChatCommand }
	/** Send `text` as if it were the whole draft, without touching the draft. */
	| { kind: "send"; text: string }
	/** Put `/name ` in the draft with the caret after it. */
	| { kind: "insert"; name: string };

export function pickPlan(row: CommandRow): PickPlan {
	const route = row.gui?.route;
	if (route?.kind === "rewind") return { kind: "rewind" };
	if (route?.kind === "action") return { kind: "action", command: route.command };
	if (route?.kind === "text" || !row.takesArguments) return { kind: "send", text: `/${row.name}` };
	return { kind: "insert", name: row.name };
}

/**
 * The draft after `/name ` is put in it. A draft that already starts with a command token has that token replaced (the
 * typed completion's own rule); any other draft keeps all its text after the command, so nothing the user wrote is lost.
 */
export function insertCommandIntoDraft(text: string, name: string): { text: string; caret: number } {
	const token = /^\/[\w:-]*(?=\s|$)/.exec(text);
	if (token !== null) return spliceSlash(text, token[0].length, name);
	const prefix = `/${name} `;
	return { text: prefix + text.trimStart(), caret: prefix.length };
}
