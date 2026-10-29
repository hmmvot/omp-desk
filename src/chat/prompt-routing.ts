/**
 * What OMP acts on in a `prompt` that it does not act on in a `steer` or `follow_up` (installed OMP 18.13.3, unchanged since 18.11.1): a `/skill:<name>`
 * invocation (`coding-agent` `extensibility/skills.ts` `parseSkillInvocation` with `pi-tui` `prompt/skill-tokens`) and a
 * leading slash command (`rpc-mode.ts` `dispatchOrderedUserInput`: `executeAcpBuiltinSlashCommand` for a builtin, `session.prompt`
 * for an extension, custom or file command, which a `steer` would queue as text or refuse). While a turn runs the host therefore sends
 * such a message as a `prompt` with `streamingBehavior`, as OMP's own terminal UI does, and OMP decides what each one does
 * mid-turn. One rule shared by the composer's chip scan (`webview/lib/command-chips.ts`) and the host's choice of command
 * (`host/rpc/session.ts`), so a chip is drawn exactly where the host sends a prompt.
 *
 * - a text that starts with `/skill:` (after the whitespace OMP trims) invokes the skill named by that first token, the rest being
 *   its arguments;
 * - otherwise the first `/skill:<name>` token anywhere in the text (delimited by whitespace or an edge, a bare name or
 *   `<namespace>/<name>`) invokes it, unless the text starts with another slash command or with a local-execution sigil
 *   (`!`, `$ `, `$ `), whose body OMP takes verbatim;
 * - only the first token counts, and whether the skill exists is the caller's question;
 * - a text that starts with `/` names a command by its first whitespace-delimited token, matched exactly (case included) against a
 *   listed name or alias.
 */
import type { ChatSlashCommand } from "./model.ts";

/** OMP's `SKILL_TOKEN_RE` without the global flag: group 1 is the delimiter before the token, group 2 the name. */
export const SKILL_TOKEN = /(^|\s)\/skill:([^\s/]+(?:\/[^\s/]+)?)(?=\s|$)/;
export const SKILL_PREFIX = "/skill:";

/** Whether the left-trimmed text begins with a TUI local-execution sigil, whose body OMP takes verbatim (so no skill token in it is an invocation). */
export function startsWithLocalExecution(trimmed: string): boolean {
	if (trimmed.startsWith("!")) return true;
	if (trimmed.charCodeAt(0) !== 36 /* $ */ || trimmed.charCodeAt(1) === 123 /* { */) return false;
	const next = trimmed.charCodeAt(trimmed.charCodeAt(1) === 36 ? 2 : 1);
	return Number.isNaN(next) || next === 32 || next === 9 || next === 10 || next === 13;
}

/** Whether a `/skill:<name>` token in the middle of `trimmed` (the left-trimmed text) can be a skill invocation: the text starts with neither another slash command nor a local-execution sigil. */
export function embeddedSkillAllowed(trimmed: string): boolean {
	return !trimmed.startsWith("/") && !startsWithLocalExecution(trimmed);
}

/**
 * Whether a skill token that begins at `start` in `text` would be the one OMP invokes: the gate above holds and no earlier token of the
 * text has the `/skill:<name>` shape (the first such token counts, whether or not the session lists its skill, as `findCommandChips` reads it).
 */
export function embeddedSkillInvokedAt(text: string, start: number): boolean {
	return embeddedSkillAllowed(text.trimStart()) && !SKILL_TOKEN.test(text.slice(0, start));
}

/** The bare name (without `skill:`) of the skill `text` invokes, or `null` when it carries no skill token. */
export function invokedSkillName(text: string): string | null {
	const trimmed = text.trimStart();
	if (trimmed.startsWith(SKILL_PREFIX)) {
		const space = trimmed.search(/\s/);
		const name = space === -1 ? trimmed.slice(SKILL_PREFIX.length) : trimmed.slice(SKILL_PREFIX.length, space);
		return name === "" ? null : name;
	}
	if (!embeddedSkillAllowed(trimmed) || !text.includes(SKILL_PREFIX)) return null;
	return SKILL_TOKEN.exec(text)?.[2] ?? null;
}

/** Whether `text` invokes a skill the session lists (a catalogue entry `skill:<name>` of source `skill`). */
export function invokesListedSkill(text: string, commands: readonly Pick<ChatSlashCommand, "name" | "source">[]): boolean {
	const name = invokedSkillName(text);
	if (name === null) return false;
	const listed = `skill:${name}`;
	return commands.some(command => command.source === "skill" && command.name === listed);
}

/** The first token of a text that starts with `/`, without the slash (`compact`, `skill:review`), or `null`. OMP reads it from the text as sent, with no trim. */
export function leadingCommandToken(text: string): string | null {
	if (!text.startsWith("/")) return null;
	const end = text.search(/\s/);
	const token = end === -1 ? text.slice(1) : text.slice(1, end);
	return token === "" ? null : token;
}

/** Whether the session lists a command or an alias named `token`. */
function listsCommand(token: string, commands: readonly Pick<ChatSlashCommand, "name" | "aliases">[]): boolean {
	return commands.some(command => command.name === token || command.aliases?.includes(token) === true);
}

/** Whether `text` invokes a skill the session lists or starts with a command it lists: what the host sends as a `prompt` while a turn runs. */
export function routesAsPrompt(text: string, commands: readonly Pick<ChatSlashCommand, "name" | "aliases" | "source">[]): boolean {
	if (invokesListedSkill(text, commands)) return true;
	const token = leadingCommandToken(text);
	return token !== null && listsCommand(token, commands);
}
