/**
 * The `/skill:<name>` invocation OMP acts on in a `prompt` (installed OMP 18.11.1: `coding-agent`
 * `extensibility/skills.ts` `parseSkillInvocation`, with `pi-tui` `prompt/skill-tokens`), shared by the composer's chip scan
 * (`webview/lib/command-chips.ts`) and the host's choice of how to deliver a message while a turn runs
 * (`host/rpc/session.ts`): one rule, so a chip is drawn exactly where OMP would run the skill.
 *
 * - a text that starts with `/skill:` (after the whitespace OMP trims) invokes the skill named by that first token, the rest being
 *   its arguments;
 * - otherwise the first `/skill:<name>` token anywhere in the text (delimited by whitespace or an edge, a bare name or
 *   `<namespace>/<name>`) invokes it, unless the text starts with another slash command or with a local-execution sigil
 *   (`!`, `$ `, `$$ `), whose body OMP takes verbatim;
 * - only the first token counts, and whether the skill exists is the caller's question.
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

/** The bare name (without `skill:`) of the skill `text` invokes, or `null` when it carries no skill token. */
export function invokedSkillName(text: string): string | null {
	const trimmed = text.trimStart();
	if (trimmed.startsWith(SKILL_PREFIX)) {
		const space = trimmed.search(/\s/);
		const name = space === -1 ? trimmed.slice(SKILL_PREFIX.length) : trimmed.slice(SKILL_PREFIX.length, space);
		return name === "" ? null : name;
	}
	if (trimmed.startsWith("/") || startsWithLocalExecution(trimmed) || !text.includes(SKILL_PREFIX)) return null;
	return SKILL_TOKEN.exec(text)?.[2] ?? null;
}

/** Whether `text` invokes a skill the session lists (a catalogue entry `skill:<name>` of source `skill`). */
export function invokesListedSkill(text: string, commands: readonly Pick<ChatSlashCommand, "name" | "source">[]): boolean {
	const name = invokedSkillName(text);
	if (name === null) return false;
	const listed = `skill:${name}`;
	return commands.some(command => command.source === "skill" && command.name === listed);
}
