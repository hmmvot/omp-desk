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
 * - the rule is shared with the host (`chat/prompt-routing.ts`), which sends a message that starts with a listed command or invokes a
 *   listed skill as a `prompt` with `streamingBehavior` while a turn runs, as OMP's terminal UI does (a `steer` would queue it as
 *   text), so a chip is drawn the same whether or not a turn is running.
 * A chip is drawn for the token OMP would act on, and only once the name is complete: whitespace must follow it, except for a token
 * that ends the draft (leading or mid-text), which is a (bare) chip the moment its name is exactly a command or a skill.
 */
import type { ChatSlashCommand } from "../../../chat/model.ts";
import { embeddedSkillAllowed, SKILL_PREFIX, SKILL_TOKEN } from "../../../chat/prompt-routing.ts";
import { findReferences, type IsKnownReference, type ReferenceSpan } from "./image-references.ts";
import { slashCatalogue } from "../slash-completion.ts";

/** A skill is drawn with a book, any other command with a terminal prompt; the chip is the same otherwise. */
export type CommandKind = "command" | "skill";

/**
 * One command chip: `[start, end)` is the token, plus the single space after it when the token is followed by one. `number` is always 0.
 * `bare` is a leading token that ends the draft with nothing after it: the name is exactly a listed command or skill, so it is drawn
 * as a chip at once, but it is still being typed, so it is edited as text (see `isBareChip`).
 */
export interface CommandSpan {
	readonly start: number;
	readonly end: number;
	readonly kind: CommandKind;
	readonly number: 0;
	readonly bare: boolean;
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
 * except Desk's own commands, which Chat's interceptors match in any case.
 */
export function commandResolver(commands: readonly ChatSlashCommand[]): ResolveCommand {
	const kinds = new Map<string, CommandKind>();
	const own = new Map<string, CommandKind>();
	for (const command of slashCatalogue(commands)) {
		const desk = command.source === DESK_SOURCE;
		const kind: CommandKind = command.source === "skill" ? "skill" : "command";
		for (const name of [command.name, ...(command.aliases ?? [])]) {
			if (!kinds.has(name)) kinds.set(name, kind);
			if (desk) own.set(name.toLowerCase(), kind);
		}
	}
	return name => kinds.get(name) ?? own.get(name.toLowerCase()) ?? null;
}

const WHITESPACE = /\s/;

function tokenEnd(text: string, from: number): number {
	let end = from;
	while (end < text.length && !WHITESPACE.test(text[end]!)) end++;
	return end;
}

/** Whether the chip is a bare command chip: drawn as a block, but a character typed after it or deleted from it turns it back into text. */
export function isBareChip(span: ChipSpan): boolean {
	return "bare" in span && span.bare;
}

/**
 * The command chip of `text`: at most one, the token OMP acts on. A token is a chip as soon as its name is complete: when
 * whitespace follows it, or when it ends the draft (a `bare` chip, so `/report` is a block the moment it is exactly a command's
 * name and text again once a character is added or removed). The same holds for a skill in the middle of the text, whose completion
 * list (`slashQueryAt`, skills only) opens under the same gates (`embeddedSkillInvokedAt`), so the list and the chip agree.
 */
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
	} else if (embeddedSkillAllowed(trimmed) && text.includes(SKILL_PREFIX)) {
		const match = SKILL_TOKEN.exec(text);
		if (match === null) return [];
		start = match.index + match[1]!.length;
		end = match.index + match[0].length;
		skillOnly = true;
	}
	const bare = end >= text.length;
	if (start < 0 || (!bare && !WHITESPACE.test(text[end]!))) return [];
	const kind = resolve(text.slice(start + 1, end));
	if (kind === null || (skillOnly && kind !== "skill")) return [];
	return [{ start, end: !bare && text[end] === " " ? end + 1 : end, kind, number: 0, bare }];
}

/** Every chip of the draft in text order: attachment markers first claim their text, then the command chip takes what they leave. */
export function findChips(text: string, isKnown: IsKnownReference, resolve: ResolveCommand): ChipSpan[] {
	const references = findReferences(text, isKnown);
	const commands = findCommandChips(text, resolve).filter(chip => !references.some(marker => marker.start < chip.end && chip.start < marker.end));
	return commands.length === 0 ? references : [...references, ...commands].sort((a, b) => a.start - b.start);
}
