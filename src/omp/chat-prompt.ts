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
 *
 * The system-prompt rules alone are followed unevenly deep into a long conversation, so a second, per-message
 * reminder ({@link LINK_REMINDER}: file paths in inline code and code symbols as links) follows every user prompt of
 * a request. The `context` event, which runs on every provider request with a copy of the messages, inserts it as a
 * separate synthetic user message right after each prompt; the session file and Chat never see it. The prompt itself is
 * not changed, and every insertion is the same fixed text, so the provider's prompt cache prefix stays identical from
 * one request to the next and a cache breakpoint can still sit on the real prompt (OMP never anchors a breakpoint on
 * or before a message it finds rewritten for the request, which is why the reminder is its own message).
 */
import { HTML_PAGES_ENV, LINK_REMINDER_ENV, TOOL_INTENT_ENV } from "../host/control-protocol.ts";

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

export const MAX_TOOL_INTENT_INJECTION_CHARS = 800;
/**
 * Added only when `ompDesk.toolIntentDescriptions` is on. It replaces OMP's built-in `i` rule (system-prompt.md, only while
 * `tools.intentTracing` is on): Chat shows the `i` text beside the tool name and arguments, so it has to say why, not what.
 * Longer than an ordinary injection because the two examples are what makes the model leave bare verbs behind.
 */
export const TOOL_INTENT_INJECTION: ChatPromptInjection = {
	id: "tool-intent",
	text: "This replaces the built-in rule for `i` (2–6-word present-participle intent). For every tool whose schema has an `i` field, set `i` to what you are doing and why, in terms of the current task: the question the call answers or the change it makes, naming its subject (feature, bug, file, agent). At most 10 words. It is shown beside the tool name and its arguments, so do not repeat them, and do not use a bare verb such as check, read, search, run, fix or wait. Examples: not \"Find menu\" but \"Find where the tool card menu is drawn\"; not \"Tree state\" but \"Check that agents left no uncommitted changes\". Do not add `i` to tools whose schema lacks this field.",
};

export const MAX_HTML_PAGE_INJECTION_CHARS = 1000;
/**
 * Added only when `ompDesk.chatHtmlPages` is on: a closed top-level ```html fence of a reply is shown as a live page in a sandboxed frame
 * (docs/designs/2026-10-19-chat-html-pages.md). The model has to know what that page can and cannot do, or it writes a page that
 * fetches a CDN script or reads `100vh`, neither of which works there.
 */
export const HTML_PAGE_INJECTION: ChatPromptInjection = {
	id: "html-page",
	text: "A closed ```html fence in your reply is shown to the user as a live page. Use it only when a page shows what Markdown cannot (an interactive explainer, a chart, a mockup). One self-contained document in a sandboxed frame: inline `<script>`/`<style>` run; nothing loads from the network (no CDN, fonts, fetch; `data:` images only); no forms, popups, links out or navigation. Colour only with theme variables: `var(--bg)`, `--fg`, `--muted`, `--border`, `--surface`, `--accent`, `--success`, `--warning`, `--error`, `--c1`…`--c6`, `--font`, `--font-mono`. The page is at most about 800px wide and often much narrower (down to 320px): use a fluid layout that wraps, and never scale a wider drawing down to fit, since its text becomes unreadable or clipped; keep text 12px or larger. Keep the document height fixed when tabs, steps or states switch (reserve the tallest one in a fixed-height container), or the reply jumps; a page over 480px gets a Show full page button, so no `100vh`.",
};

/** The Chat prompt for a launch: the standing injections, the HTML page rule when `env` sets {@link HTML_PAGES_ENV} to `1`, and the tool-intent rule when it sets {@link TOOL_INTENT_ENV} to `1`. */
export function chatPromptFor(env: Readonly<Record<string, string | undefined>>): string {
	const injections = [...CHAT_PROMPT_INJECTIONS];
	if (env[HTML_PAGES_ENV] === "1") injections.push(HTML_PAGE_INJECTION);
	if (env[TOOL_INTENT_ENV] === "1") injections.push(TOOL_INTENT_INJECTION);
	return injections.length === CHAT_PROMPT_INJECTIONS.length ? CHAT_PROMPT : renderChatPrompt(injections);
}

export const MAX_LINK_REMINDER_CHARS = 350;
/** The text inserted after each user prompt of a request. */
export const LINK_REMINDER =
	"[OMP Desk reminder] In your reply, write each file or folder you mention as a path in inline code (`src/app.ts:42`, `docs/`) and each code symbol (class, method, property, field, type) as a link: [`Name`](path:line) with the definition line you saw, else [`Name`](path). Plain `code` only for a symbol you have not located; never guess a line.";

/** The binding context fields this module reads (`ExtensionContext`, pi-coding-agent `extensibility/extensions/types.ts`). */
export interface ChatPromptContext {
	readonly mode?: unknown;
	readonly agent?: { readonly kind?: unknown } | null;
}

/** The `pi` members the registration uses. */
export interface ChatPromptApi {
	on(event: string, handler: (event: unknown, ctx: ChatPromptContext) => unknown): void;
}

/** Whether `message` is a user's own prompt: not synthetic (auto-continue and the like) and not a history rewrite. */
function isPrompt(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	const candidate = message as { role?: unknown; synthetic?: unknown; historyRewriteAt?: unknown };
	return candidate.role === "user" && candidate.synthetic !== true && candidate.historyRewriteAt === undefined;
}

function isReminder(message: unknown): boolean {
	const candidate = message as { role?: unknown; synthetic?: unknown; content?: unknown } | null;
	return typeof candidate === "object" && candidate !== null && candidate.role === "user" && candidate.synthetic === true && candidate.content === LINK_REMINDER;
}

/**
 * `messages` with a {@link LINK_REMINDER} synthetic user message after every user prompt that does not already have one,
 * or `undefined` when nothing was added. Nothing existing is changed or removed, so the runner leaves the original
 * messages unmarked and only the reminders are rebuilt for the request. The reminder takes its prompt's timestamp: the
 * request bytes never depend on the clock.
 */
function withReminders(messages: readonly unknown[]): unknown[] | undefined {
	const out: unknown[] = [];
	let added = false;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		out.push(message);
		if (!isPrompt(message) || isReminder(messages[index + 1])) continue;
		const timestamp = (message as { timestamp?: unknown }).timestamp;
		out.push({ role: "user", content: LINK_REMINDER, synthetic: true, attribution: "agent", timestamp: typeof timestamp === "number" ? timestamp : 0 });
		added = true;
	}
	return added ? out : undefined;
}

/**
 * Append {@link CHAT_PROMPT} to the system prompt of every request an RPC main session prepares
 * (`before_agent_start` returns the replacement `systemPrompt`). A prompt that already carries it is left as it is.
 *
 * Only when `env` sets {@link LINK_REMINDER_ENV} to `1` (the `ompDesk.linkReminder` setting, off by default, read when Desk
 * launches the session), the `context` event also inserts {@link LINK_REMINDER} after every user prompt of each provider request.
 */
export function registerChatPrompt(pi: ChatPromptApi, env: Readonly<Record<string, string | undefined>> = process.env): void {
	const chatPrompt = chatPromptFor(env);
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx?.mode !== "rpc" || ctx.agent?.kind !== "main") return undefined;
		if (typeof event !== "object" || event === null || !("systemPrompt" in event)) return undefined;
		const prompt = event.systemPrompt;
		if (!Array.isArray(prompt) || !prompt.every(part => typeof part === "string")) return undefined;
		if (prompt.includes(chatPrompt)) return undefined;
		return { systemPrompt: [...prompt, chatPrompt] };
	});
	if (env[LINK_REMINDER_ENV] !== "1") return;
	pi.on("context", (event, ctx) => {
		if (ctx?.mode !== "rpc" || ctx.agent?.kind !== "main") return undefined;
		if (typeof event !== "object" || event === null || !("messages" in event) || !Array.isArray(event.messages)) return undefined;
		const messages = withReminders(event.messages);
		return messages === undefined ? undefined : { messages };
	});
}
