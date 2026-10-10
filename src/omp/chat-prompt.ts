/**
 * The OMP Desk Chat prompt: one short section appended to the system prompt of every RPC main session Desk
 * launches, telling the model how to format replies so Chat renders them well. It is a fixed preamble and a list
 * of injections, one per Chat feature that depends on a reply format.
 *
 * Adding an injection: append one entry to {@link CHAT_PROMPT_INJECTIONS}. Every entry costs tokens on every
 * request of every Chat session, so:
 * - One rule per entry, in one or two imperative sentences, at most {@link MAX_INJECTION_CHARS} characters.
 * - Say only what Chat needs that a plain Markdown reply would not do anyway. Do not restate OMP's own prompt.
 * - Show the format with an inline example instead of describing it; give a reason in a clause at most.
 * - Keep the text constant: no session, time or setting values, so the provider's prompt cache prefix stays stable.
 * - Add an entry together with the feature that needs it, and remove it with that feature.
 * `chat-prompt.test.ts` enforces the size limits.
 *
 * Only an RPC main session gets the section: the native TUI renders replies itself, and a subagent's reply goes
 * to its parent rather than the user. The `-e` host-control module registers it (`registerChatPrompt`).
 */

export interface ChatPromptInjection {
	/** A short stable name for the feature the rule serves. */
	readonly id: string;
	readonly text: string;
}

export const MAX_INJECTION_CHARS = 280;
export const MAX_CHAT_PROMPT_CHARS = 1500;

const PREAMBLE = "# OMP Desk Chat\nThe user reads your replies in OMP Desk, a chat panel in VS Code. Format replies for it:";

export const CHAT_PROMPT_INJECTIONS: readonly ChatPromptInjection[] = [
	{
		// Chat links a path the host proves to exist (src/webview/lib/chat-file-links.ts); a whole inline code span
		// is one candidate, and a folder needs a separator to look like a path.
		id: "file-links",
		text: "Write each file or folder you mention as a path in inline code, relative to the working directory or absolute, so it becomes a link: `src/app.ts`, `src/app.ts:42` for a line, `src/webview/` for a folder.",
	},
	{
		// A Markdown link to a path renders its label (inline code kept) as a file link once the host proves the file; the
		// line suffix is the definition the click opens (src/webview/components/Markdown.tsx). A symbol the model leaves
		// plain is linked by the host when VS Code's workspace symbol providers find one definition
		// (src/host/symbol-links.ts, docs/designs/2026-10-10-code-symbol-links.md): this rule only has to help.
		id: "code-links",
		text: "Link every code symbol at each mention, tables and lists included: [`App.start`](src/app.ts:12) with a definition line you saw, else the file alone: [`Parser`](src/parse.ts). Plain code only for a symbol you have not located; never guess a line or search just for one.",
	},
];

export function renderChatPrompt(injections: readonly ChatPromptInjection[]): string {
	return [PREAMBLE, ...injections.map(injection => `- ${injection.text}`)].join("\n");
}

export const CHAT_PROMPT = renderChatPrompt(CHAT_PROMPT_INJECTIONS);

/** The binding context fields this module reads (`ExtensionContext`, pi-coding-agent `extensibility/extensions/types.ts`). */
export interface ChatPromptContext {
	readonly mode?: unknown;
	readonly agent?: { readonly kind?: unknown } | null;
}

/** The `pi` member the registration uses. */
export interface ChatPromptApi {
	on(event: string, handler: (event: unknown, ctx: ChatPromptContext) => unknown): void;
}

/**
 * Append {@link CHAT_PROMPT} to the system prompt of every request an RPC main session prepares
 * (`before_agent_start` returns the replacement `systemPrompt`). A prompt that already carries it is left as it is.
 */
export function registerChatPrompt(pi: ChatPromptApi): void {
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx?.mode !== "rpc" || ctx.agent?.kind !== "main") return undefined;
		if (typeof event !== "object" || event === null || !("systemPrompt" in event)) return undefined;
		const prompt = event.systemPrompt;
		if (!Array.isArray(prompt) || !prompt.every(part => typeof part === "string")) return undefined;
		if (prompt.includes(CHAT_PROMPT)) return undefined;
		return { systemPrompt: [...prompt, CHAT_PROMPT] };
	});
}
