/**
 * A scripted OpenAI-compatible `/v1/chat/completions` server for the README screenshots: every conversation the screenshots
 * need is written down as a `ModelScript`, so the Chat shows the same rows, tool calls, TODO list and subagent each run.
 *
 * A request is answered from the script whose `prompt` the last user message contains. The step is the number of assistant
 * messages that follow that user message (every completion adds exactly one), so a turn with tool calls walks through its steps
 * one tool round at a time. A step is a reply text, tool calls, or both (the text first). Requests that match no script get
 * `Done.`. OMP also asks the session's own model for a title in a side turn whose last user message is a `<title-request>`; it is answered
 * with `<title/>` (no title), because the screenshots name their sessions through the Sessions view's Rename.
 *
 * The `task` tool is described to the model in two shapes depending on OMP's settings (a single task, or a batch with a shared
 * `context`); a script names the task once (`{ name, task }`) and the server fills in what the advertised schema asks for.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ScriptToolCall {
	readonly name: string;
	readonly args: Record<string, unknown>;
}

export interface ScriptStep {
	readonly text?: string;
	readonly tools?: readonly ScriptToolCall[];
	/** Prompt tokens reported for this completion; the Chat's context ring and the Context view show them. */
	readonly promptTokens?: number;
}

export interface ModelScript {
	/** A part of the user's message that selects this script. */
	readonly prompt: string;
	readonly steps: readonly ScriptStep[];
}

interface ChatMessage {
	readonly role?: string;
	readonly content?: unknown;
}

interface ToolDefinition {
	readonly function?: { readonly name?: string; readonly parameters?: { readonly properties?: Record<string, unknown> } };
}

interface ChatRequest {
	readonly model?: string;
	readonly stream?: boolean;
	readonly messages?: readonly ChatMessage[];
	readonly tools?: readonly ToolDefinition[];
}

/** The text parts of a message, without the `<system-reminder>` blocks OMP prepends. */
function textOf(content: unknown): string {
	const raw = typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part: unknown) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : "")).join("")
			: "";
	return raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

function sse(response: ServerResponse, payload: unknown): void {
	response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null): unknown {
	return { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

/** The arguments of a scripted call, shaped for the schema the model was given for that tool. */
function argumentsFor(call: ScriptToolCall, tools: readonly ToolDefinition[]): Record<string, unknown> {
	if (call.name !== "task") return call.args;
	const properties = tools.find(tool => tool.function?.name === "task")?.function?.parameters?.properties ?? {};
	const task = { agent: "task", solutionSpace: "one measurement, no design choices", ...call.args };
	return "tasks" in properties ? { context: "Goal: measure first, change nothing.", tasks: [task] } : task;
}

async function respond(request: IncomingMessage, response: ServerResponse, scripts: readonly ModelScript[]): Promise<void> {
	const chunks: Buffer[] = [];
	for await (const part of request) chunks.push(part as Buffer);
	const body: ChatRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	const messages = body.messages ?? [];
	const model = body.model ?? "mock-model";
	const lastUserIndex = messages.findLastIndex(message => message.role === "user");
	const userText = textOf(messages[lastUserIndex]?.content);
	const isTitleRequest = userText.startsWith("<title-request>");
	const script = scripts.find(candidate => userText.includes(candidate.prompt));

	let text = "Done.";
	let calls: readonly ScriptToolCall[] = [];
	let promptTokens = 120 + messages.length * 10;
	if (isTitleRequest) {
		text = "<title/>";
	} else if (script !== undefined) {
		const assistantTurns = messages.slice(lastUserIndex + 1).filter(message => message.role === "assistant").length;
		const step = script.steps[assistantTurns];
		text = step?.text ?? "";
		calls = step?.tools ?? [];
		promptTokens = step?.promptTokens ?? promptTokens;
	}

	const id = `chatcmpl-script-${Date.now().toString(36)}`;
	const usage = { prompt_tokens: promptTokens, completion_tokens: 40, total_tokens: promptTokens + 40 };
	if (body.stream !== true) {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }));
		return;
	}
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	sse(response, chunk(id, model, { role: "assistant", content: "" }, null));
	if (text !== "") sse(response, chunk(id, model, { content: text }, null));
	for (const [index, call] of calls.entries()) {
		sse(response, chunk(id, model, { tool_calls: [{ index, id: `call_${id}_${index}`, type: "function", function: { name: call.name, arguments: "" } }] }, null));
		sse(response, chunk(id, model, { tool_calls: [{ index, function: { arguments: JSON.stringify(argumentsFor(call, body.tools ?? [])) } }] }, null));
	}
	sse(response, chunk(id, model, {}, calls.length > 0 ? "tool_calls" : "stop"));
	sse(response, { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage });
	response.write("data: [DONE]\n\n");
	response.end();
}

export interface ScriptedModelServer {
	readonly port: number;
	readonly url: string;
	close(): Promise<void>;
}

/** Listens on 127.0.0.1; port 0 picks a free one. */
export async function startScriptedModelServer(scripts: readonly ModelScript[], port = 0): Promise<ScriptedModelServer> {
	const server: Server = createServer((request, response) => {
		const path = (request.url ?? "").split("?")[0];
		if (request.method === "POST" && path.endsWith("/chat/completions")) {
			respond(request, response, scripts).catch(error => {
				if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: String(error) } }));
			});
			return;
		}
		if (request.method === "GET" && path.endsWith("/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model", owned_by: "mock" }] }));
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
	if (address === null || typeof address === "string") throw new Error("scripted model server has no TCP address");
	return {
		port: address.port,
		url: `http://127.0.0.1:${address.port}`,
		close: () => {
			const closed = Promise.withResolvers<void>();
			server.closeAllConnections();
			server.close(() => closed.resolve());
			return closed.promise;
		},
	};
}
