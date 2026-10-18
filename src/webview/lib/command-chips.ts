/**
 * Slash-command and skill chips of the composer draft (docs/designs/2026-10-18-composer-command-skill-chips.md).
 *
 * A command or a skill that the draft names is drawn as the same atomic, non-editable chip as an image or a file marker, and
 * it is found the same way: a pure scan of the draft string, so undo, a recalled history entry, a restored draft and a paste
 * all show the chip without any state besides the text and the catalogue of the session. The chip's text is the literal
 * token (`/compact`, `/skill:review`), so what is stored, handed off and sent is unchanged.
 *
 * Which token OMP acts on, mirrored from the installed OMP (18.11.1, `pi-tui` `prompt/skill-tokens` and
 * `coding-agent` `extensibility/skills.ts`, which the rpc `prompt` command uses):
 * - a draft that starts with `/` (after the whitespace the send trims) runs the command named by its first token; only a
 *   `/skill:<name>` there is a skill, and anything else after the first token is the command's arguments;
 * - a `/skill:<name>` token **anywhere else in the draft** (delimited by whitespace or an edge, a bare name or
 *   `<namespace>/<name>`) is a skill invocation as well, the first such token only, unless the draft starts with another
 *   slash command or with a local-execution sigil (`!`, `$ `, `$$ `);
 * - the skill must be one the session lists; an unknown name is ordinary text;
 * - all of it is the `prompt` command: while a turn runs the composer sends `steer` or `follow_up`, which OMP does not scan, so
 *   only Desk's own commands (answered by the host on every send path) stay chips then.
 * A chip is drawn for the token OMP would act on, and only once the name is complete: whitespace must follow it.
 */
import type { ChatSlashCommand } from "../../chat/model.ts";
import { findReferences, type IsKnownReference, type ReferenceSpan } from "./image-references.ts";
import { slashCatalogue } from "./slash-completion.ts";

/** A skill is drawn with a book, any other command with a terminal prompt; the chip is the same otherwise. */
export type CommandKind = "command" | "skill";

/** One command chip: `[start, end)` is the token, plus the single space after it when the token is followed by one. `number` is always 0. */
export interface CommandSpan {
	readonly start: number;
	readonly end: number;
	readonly kind: CommandKind;
	readonly number: 0;
}

/** Everything the draft draws as an atomic chip. */
export type ChipSpan = ReferenceSpan | CommandSpan;

/** The kind of the command or skill a token names (the token without its `/`, such as `compact` or `skill:review`), or `null` for ordinary text. */
export type ResolveCommand = (name: string) => CommandKind | null;

/** The `source` of the commands Chat itself answers (`slash-completion.ts`, `DESK_COMMANDS`): the host intercepts them on every send path, whatever the turn is doing. */
const DESK_SOURCE = "OMP Desk";

/**
 * The resolver of one catalogue: Desk's own commands and what the session advertises (denied identity-changing builtins are not in it,
 * so they stay plain text and are refused at send as before). Names and aliases match exactly, case included, as OMP's own lookup does,
 * except Desk's own commands, which Chat's interceptors match in any case. While `working` the composer sends `steer` or `follow_up`,
 * which OMP does not scan for commands and skills, so only Desk's own commands are known then.
 */
export function commandResolver(commands: readonly ChatSlashCommand[], working: boolean = false): ResolveCommand {
	const kinds = new Map<string, CommandKind>();
	const own = new Map<string, CommandKind>();
	for (const command of slashCatalogue(commands)) {
		const desk = command.source === DESK_SOURCE;
		if (working && !desk) continue;
		const kind: CommandKind = command.source === "skill" ? "skill" : "command";
		for (const name of [command.name, ...(command.aliases ?? [])]) {
			if (!kinds.has(name)) kinds.set(name, kind);
			if (desk) own.set(name.toLowerCase(), kind);
		}
	}
	return name => kinds.get(name) ?? own.get(name.toLowerCase()) ?? null;
}

const SKILL_PREFIX = "/skill:";
/** OMP's `SKILL_TOKEN_RE` without the global flag: group 1 is the delimiter before the token, group 2 the name. */
const SKILL_TOKEN = /(^|\s)\/skill:([^\s/]+(?:\/[^\s/]+)?)(?=\s|$)/;
const WHITESPACE = /\s/;

/** Whether the left-trimmed draft begins with a TUI local-execution sigil, whose body OMP takes verbatim (so no skill token in it is an invocation). */
function startsWithLocalExecution(trimmed: string): boolean {
	if (trimmed.startsWith("!")) return true;
	if (trimmed.charCodeAt(0) !== 36 /* $ */ || trimmed.charCodeAt(1) === 123 /* { */) return false;
	const next = trimmed.charCodeAt(trimmed.charCodeAt(1) === 36 ? 2 : 1);
	return Number.isNaN(next) || next === 32 || next === 9 || next === 10 || next === 13;
}

function tokenEnd(text: string, from: number): number {
	let end = from;
	while (end < text.length && !WHITESPACE.test(text[end]!)) end++;
	return end;
}

/** The command chip of `text`: at most one, the token OMP acts on, once whitespace follows its name. */
export function findCommandChips(text: string, resolve: ResolveCommand): CommandSpan[] {
	const trimmed = text.trimStart();
	const lead = text.length - trimmed.length;
	let start = -1;
	let end = -1;
	let skillOnly = false;
	if (trimmed.startsWith("/")) {
		// A leading `/skill:<name>` and a leading command are one case: the first token, whatever follows being arguments.
		start = lead;
		end = tokenEnd(text, lead);
	} else if (!startsWithLocalExecution(trimmed) && text.includes(SKILL_PREFIX)) {
		const match = SKILL_TOKEN.exec(text);
		if (match === null) return [];
		start = match.index + match[1]!.length;
		end = match.index + match[0].length;
		skillOnly = true;
	}
	if (start < 0 || end >= text.length || !WHITESPACE.test(text[end]!)) return [];
	const kind = resolve(text.slice(start + 1, end));
	if (kind === null || (skillOnly && kind !== "skill")) return [];
	return [{ start, end: text[end] === " " ? end + 1 : end, kind, number: 0 }];
}

/** Every chip of the draft in text order: attachment markers first claim their text, then the command chip takes what they leave. */
export function findChips(text: string, isKnown: IsKnownReference, resolve: ResolveCommand): ChipSpan[] {
	const references = findReferences(text, isKnown);
	const commands = findCommandChips(text, resolve).filter(chip => !references.some(marker => marker.start < chip.end && chip.start < marker.end));
	return commands.length === 0 ? references : [...references, ...commands].sort((a, b) => a.start - b.start);
}
