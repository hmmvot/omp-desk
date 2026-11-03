import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startMockServer, SUBAGENT_STEPS, toolCallOf, type MockServer } from "../fixtures/mock-openai-server.ts";

interface Delta {
	readonly content?: string;
	readonly tool_calls?: readonly { readonly index: number; readonly function?: { readonly name?: string; readonly arguments?: string } }[];
}

/** The streamed completion for `messages`: the text it says and the one tool call it makes (name and decoded arguments). */
async function complete(server: MockServer, messages: readonly object[], tools: readonly string[]): Promise<{ text: string; call: { name: string; args: Record<string, unknown> } | null }> {
	const response = await fetch(`${server.url}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: "mock-model", stream: true, messages, tools: tools.map(name => ({ type: "function", function: { name } })) }),
	});
	let text = "";
	let name = "";
	let args = "";
	for (const line of (await response.text()).split("\n")) {
		if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
		const delta: Delta | undefined = JSON.parse(line.slice(6)).choices[0]?.delta;
		text += delta?.content ?? "";
		for (const call of delta?.tool_calls ?? []) {
			name += call.function?.name ?? "";
			args += call.function?.arguments ?? "";
		}
	}
	return { text, call: name === "" ? null : { name, args: JSON.parse(args) } };
}

describe("mock model server tool markers", () => {
	let server: MockServer;
	before(async () => { server = await startMockServer(); });
	after(async () => { await server.close(); });

	it("reads the marker's command up to the first closing bracket", () => {
		assert.deepEqual(toolCallOf(`start [bg:node -e "setTimeout(()=>{},9)"] now`)?.args, { command: `node -e "setTimeout(()=>{},9)"`, async: true, i: "Starting a background job" });
		assert.deepEqual(toolCallOf("[tool:notes.md]")?.args, { path: "notes.md" });
		assert.equal(toolCallOf("plain words"), null);
	});

	it("answers [bg:<command>] with one async bash call, then with the tool-result text once the result is in", async () => {
		const asked = { role: "user", content: "run [bg:node -e 1]" };
		const first = await complete(server, [asked], ["bash", "read"]);
		assert.deepEqual(first.call, { name: "bash", args: { command: "node -e 1", async: true, i: "Starting a background job" } });
		assert.equal(first.text, "");
		const followUp = await complete(server, [asked, { role: "assistant", content: "", tool_calls: [] }, { role: "tool", tool_call_id: "call_mock_1", content: "Background job bg_1 started" }], ["bash", "read"]);
		assert.deepEqual(followUp, { text: "Tool result received.", call: null });
	});

	it("keeps [tool:<path>] a read call, and answers in text when the tool the marker names is not offered", async () => {
		assert.deepEqual((await complete(server, [{ role: "user", content: "[tool:a.txt]" }], ["read"])).call, { name: "read", args: { path: "a.txt" } });
		const without = await complete(server, [{ role: "user", content: "[bg:node -e 1]" }], ["read"]);
		assert.equal(without.call, null);
		assert.match(without.text, /^Mock reply to: \[bg:node -e 1\]/);
	});

	it("answers [agent:<name>] with a task call in the shape the offered schema asks for, and the subagent's own requests with blocking bash steps, then a closing text", async () => {
		const single = toolCallOf("spawn [agent:Prober]", [{ function: { name: "task", parameters: { properties: { task: {}, solutionSpace: {} } } } }]);
		assert.equal(single?.name, "task");
		assert.equal(single?.args.name, "Prober");
		assert.match(String(single?.args.task), /\[subagent-work\]/);
		const batch = toolCallOf("spawn [agent:Prober]", [{ function: { name: "task", parameters: { properties: { context: {}, tasks: {} } } } }]);
		assert.equal(typeof batch?.args.context, "string");
		assert.deepEqual((batch?.args.tasks as { name: string }[]).map(item => item.name), ["Prober"]);
		const task = String(single?.args.task);
		const first = toolCallOf(task, [], 0);
		assert.equal(first?.name, "bash");
		assert.equal(first?.args.async, undefined, "the subagent's calls block, so its run lasts");
		assert.match(String(first?.args.command), /setTimeout\(\(\)=>\{\},\d+\)/);
		assert.equal(toolCallOf(task, [], SUBAGENT_STEPS - 1)?.args.i, `Probe step ${SUBAGENT_STEPS} of ${SUBAGENT_STEPS}`);
		assert.equal(toolCallOf(task, [], SUBAGENT_STEPS), null, "after its steps the subagent only says it is done");
		const finished = await complete(server, [{ role: "user", content: task }, ...Array.from({ length: SUBAGENT_STEPS }, () => ({ role: "tool", tool_call_id: "x", content: "ok" }))], ["bash"]);
		assert.deepEqual(finished, { text: "Probe finished.", call: null });
	});
});
