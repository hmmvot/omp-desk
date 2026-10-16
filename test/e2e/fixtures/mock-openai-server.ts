/**
 * A deterministic OpenAI-compatible `/v1/chat/completions` server for the end-to-end suite.
 *
 * OMP is configured (models.yml, see test/e2e/support/omp-agent.ts) with this server as a custom `openai-completions`
 * provider, so a Chat turn needs no provider key and no network. The reply is chosen from the last user message:
 *
 *   - `[tool:<path>]` anywhere in it: the first completion calls OMP's `read` tool on `<path>`; once a tool result is in
 *     the conversation the model answers with `Tool result received.`
 *   - `[slow]` : the text is streamed in small chunks with a delay, so a turn stays running for a while
 *   - anything else: `Mock reply to: <text>`, followed by ` [image bytes: <n>,…]` when the last user message carries images.
 *
 * `GET /__requests` returns the recorded request summaries as JSON; `DELETE /__requests` clears them.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const MOCK_MODEL_ID = "mock-model";
export const MOCK_PROVIDER_ID = "mock";
/** The most characters of a user message a recorded request keeps whole. */
export const FULL_USER_TEXT_LIMIT = 400_000;

export interface RecordedRequest {
	readonly model: string;
	readonly stream: boolean;
	readonly toolNames: readonly string[];
	readonly lastRole: string;
	readonly lastUserText: string;
	/** The whole user text (system reminders cut), bounded at {@link FULL_USER_TEXT_LIMIT} characters: what a file block's content is checked against. */
	readonly fullUserText: string;
	readonly messageCount: number;
	readonly hasToolResult: boolean;
	readonly imageBytes: readonly number[];
	readonly reply: string;
}

export interface MockServer {
	readonly port: number;
	readonly url: string;
	readonly requests: RecordedRequest[];
	close(): Promise<void>;
}

interface ChatMessage {
	readonly role?: string;
	readonly content?: unknown;
}

interface ChatRequest {
	readonly model?: string;
	readonly stream?: boolean;
	readonly messages?: readonly ChatMessage[];
	readonly tools?: readonly { readonly function?: { readonly name?: string } }[];
}

/** The user's own words: OMP prefixes some turns with `<system-reminder>…</system-reminder>` blocks the model sees. */
function textOf(content: unknown): string {
	const raw = typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part: unknown) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : "")).join("")
			: "";
	return raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

/** Decoded byte sizes of the `data:` images in one message's content parts (what the model would be shown). */
function imageSizesOf(content: unknown): number[] {
	if (!Array.isArray(content)) return [];
	const sizes: number[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null || !("image_url" in part)) continue;
		const image = part.image_url;
		const url = typeof image === "object" && image !== null && "url" in image ? String(image.url) : "";
		const comma = url.indexOf(",");
		if (url.startsWith("data:image/") && comma > 0) sizes.push(Buffer.from(url.slice(comma + 1), "base64").length);
	}
	return sizes;
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function sse(response: ServerResponse, payload: unknown): void {
	response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null): unknown {
	return { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

async function respond(request: IncomingMessage, response: ServerResponse, requests: RecordedRequest[]): Promise<void> {
	const body: ChatRequest = JSON.parse(await readBody(request));
	const messages = body.messages ?? [];
	const model = body.model ?? MOCK_MODEL_ID;
	const lastUser = [...messages].reverse().find(message => message.role === "user");
	const userText = textOf(lastUser?.content);
	const last = messages.at(-1);
	const hasToolResult = messages.some(message => message.role === "tool");
	const toolNames = (body.tools ?? []).map(tool => tool.function?.name ?? "");
	const toolMatch = /\[tool:([^\]]+)\]/.exec(userText);

	// A turn that already carries a tool result is the follow-up completion; the user's marker is still in its history.
	const callTool = toolMatch !== null && last?.role === "user" && toolNames.includes("read");
	const images = imageSizesOf(lastUser?.content);
	const imageNote = images.length === 0 ? "" : ` [image bytes: ${images.join(",")}]`;
	const reply = callTool ? "" : hasToolResult && toolMatch !== null ? "Tool result received." : `Mock reply to: ${userText.replace(/\s+/g, " ").trim().slice(0, 200)}${imageNote}`;
	requests.push({ model, stream: body.stream === true, toolNames, lastRole: last?.role ?? "", lastUserText: userText.slice(0, 200), fullUserText: userText.slice(0, FULL_USER_TEXT_LIMIT), messageCount: messages.length, hasToolResult, imageBytes: images, reply: callTool ? `<tool call read ${toolMatch![1]}>` : reply });

	const id = `chatcmpl-mock-${requests.length}`;
	const usage = { prompt_tokens: 120 + messages.length * 10, completion_tokens: 12, total_tokens: 132 + messages.length * 10 };
	if (body.stream !== true) {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({
			id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
			choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage,
		}));
		return;
	}
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	sse(response, chunk(id, model, { role: "assistant", content: "" }, null));
	if (callTool) {
		const args = JSON.stringify({ path: toolMatch![1] });
		sse(response, chunk(id, model, { tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "read", arguments: "" } }] }, null));
		sse(response, chunk(id, model, { tool_calls: [{ index: 0, function: { arguments: args } }] }, null));
		sse(response, chunk(id, model, {}, "tool_calls"));
	} else {
		const slow = userText.includes("[slow]");
		const pieces = slow ? reply.match(/.{1,6}/g) ?? [reply] : [reply];
		for (const piece of pieces) {
			sse(response, chunk(id, model, { content: piece }, null));
			if (slow) await delay(120);
		}
		sse(response, chunk(id, model, {}, "stop"));
	}
	sse(response, { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage });
	response.write("data: [DONE]\n\n");
	response.end();
}

/** Listens on 127.0.0.1; port 0 picks a free one. */
export async function startMockServer(port = 0): Promise<MockServer> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer((request, response) => {
		const path = (request.url ?? "").split("?")[0];
		if (path === "/__requests") {
			if (request.method === "DELETE") requests.length = 0;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(requests));
			return;
		}
		if (request.method === "POST" && path.endsWith("/chat/completions")) {
			respond(request, response, requests).catch(error => {
				if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: String(error) } }));
			});
			return;
		}
		if (request.method === "GET" && path.endsWith("/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ object: "list", data: [{ id: MOCK_MODEL_ID, object: "model", owned_by: "mock" }] }));
			return;
		}
		response.writeHead(404, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { message: `no route for ${request.method} ${path}` } }));
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(port, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("mock server has no TCP address");
	const bound = address.port;
	return {
		port: bound,
		url: `http://127.0.0.1:${bound}`,
		requests,
		close: () => {
			const closed = Promise.withResolvers<void>();
			server.closeAllConnections();
			server.close(() => closed.resolve());
			return closed.promise;
		},
	};
}
