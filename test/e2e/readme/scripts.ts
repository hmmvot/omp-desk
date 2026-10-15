/**
 * The conversations of the README screenshots, as scripts of the scripted model server. Every session works on this very
 * project (`omp-vscode`): the workspace is a copy of a few of its files (see scene.ts), so the file names, line numbers
 * and constants the replies cite are real and resolve to links in Chat.
 */
import type { ModelScript } from "./scripted-model-server.ts";

/** Line numbers of the constants the Chat reply cites, read from the workspace copy of the sources. */
export interface SourceFacts {
	readonly attachmentBytesLine: number;
	readonly draftBytesLine: number;
}

/** The names the screenshots give their sessions (the Sessions view's Rename). */
export const IMAGE_TITLE = "chat-image-limits";
export const TIMING_TITLE = "fix-reload-timing";
export const WORKING_TITLE = "native-win32-checks";
export const TERMINAL_TITLE = "attachments-exports";

export const IMAGE_QUESTION = "What is this limit?";
export const TIMING_REQUEST = "Reload Window is slow with many Chat tabs. Make a todo list, have one subagent measure where the time goes, and wait for its report before changing anything.";
export const QUEUED_FOLLOW_UP = "Then list the exported functions of src/webview/lib/attachments.ts.";
export const WORKING_REQUEST = "Run the native Win32 checks and tell me about every failure.";
export const TERMINAL_REQUEST = "Summarize what src/webview/lib/attachments.ts exports.";

const SUBAGENT_TASK = "Measure where Reload Window spends its time with the reload timing probe, and report the slowest step.";

/** Sessions that only need to exist, stopped, in the Sessions list: one short question each. */
export const STOPPED_SESSIONS: readonly { readonly prompt: string; readonly title: string; readonly reply: string }[] = [
	{ prompt: "Why does the session lease probe start PowerShell?", title: "session-lease-probe", reply: "It resolves the owner of OMP's lease mutex; the native call replaces it." },
	{ prompt: "How does the Sessions view order its flat list?", title: "sessions-view-ordering", reply: "Live sessions first, unread ones on top, then the most recently active; stopped sessions last." },
	{ prompt: "What does the Context view read from OMP?", title: "context-view-sources", reply: "The live state, the session statistics and the session file; the breakdown only when you ask for it." },
	{ prompt: "Which commands does the Models editor add?", title: "models-editor-commands", reply: "Open Models Settings, plus Refresh and Generate inside the editor." },
	{ prompt: "Where is the chat broker started?", title: "chat-broker-runtime", reply: "On the bun.exe that runs the session's OMP, with Code.exe as the fallback." },
];

export function readmeScripts(facts: SourceFacts): ModelScript[] {
	return [
		{
			prompt: IMAGE_QUESTION,
			steps: [
				{
					tools: [
						{ name: "read", args: { path: "src/webview/lib/attachments.ts" } },
						{ name: "grep", args: { pattern: "MAX_ATTACHMENT_BYTES", path: "src" } },
						{ name: "bash", args: { command: "git log --oneline -3 -- src/webview/lib/attachments.ts" } },
					],
					promptTokens: 38_000,
				},
				{
					text: [
						"That limit belongs to OMP Desk, not to OMP or the model. The Chat composer enforces two limits:",
						"",
						`- \`MAX_ATTACHMENT_BYTES = 512 KB\` for one image, in \`src/webview/lib/attachments.ts:${facts.attachmentBytesLine}\`;`,
						`- \`MAX_DRAFT_BYTES = 576 KB\` for all images of one message, in \`src/webview/lib/attachments.ts:${facts.draftBytesLine}\`.`,
						"",
						`The extension host checks the same numbers in the chat message grammar (\`MAX_CHAT_IMAGE_BASE64_CHARS\`), so an oversized image is refused before Send instead of failing later.`,
						"",
						"A PNG screenshot is usually larger than 512 KB, like the 770 KB one you attached. **Options:** shrink the image before attaching it, or raise both constants together with the transport limits.",
					].join("\n"),
					promptTokens: 52_000,
				},
			],
		},
		{
			prompt: TIMING_REQUEST,
			steps: [
				{
					tools: [{ name: "todo", args: { op: "init", list: [{ phase: "Reload timing", items: ["Measure reconcile time per tab", "Find the slowest step", "Write down the finding"] }] } }],
					promptTokens: 41_000,
				},
				{
					text: "The todo list is ready. A subagent measures the reload now.",
					tools: [{ name: "task", args: { name: "ReloadProfiler", task: SUBAGENT_TASK } }],
					promptTokens: 42_000,
				},
				{
					text: "Waiting for the subagent's report before I change anything.",
					tools: [{ name: "wait", args: {} }],
					promptTokens: 43_000,
				},
			],
		},
		{
			prompt: SUBAGENT_TASK,
			steps: [{ text: "Running the reload timing probe.", tools: [{ name: "bash", args: { command: "sleep 1800", timeout: 1800 } }] }],
		},
		{
			prompt: WORKING_REQUEST,
			steps: [{ text: "Starting the checks.", tools: [{ name: "bash", args: { command: "sleep 1800", timeout: 1800 } }], promptTokens: 27_000 }],
		},
		{
			prompt: TERMINAL_REQUEST,
			steps: [
				{ tools: [{ name: "read", args: { path: "src/webview/lib/attachments.ts" } }], promptTokens: 24_000 },
				{
					text: "`src/webview/lib/attachments.ts` exports the attachment limits (`MAX_ATTACHMENT_BYTES`, `MAX_DRAFT_BYTES`), `formatBytes`, `rawTotal`, `sizeRejection`, `readImageAttachment` and `imageFilesFrom`.",
					promptTokens: 31_000,
				},
			],
		},
		...STOPPED_SESSIONS.map(session => ({ prompt: session.prompt, steps: [{ text: session.reply }] })),
	];
}
