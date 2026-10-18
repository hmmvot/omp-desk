import assert from "node:assert/strict";
import { it } from "node:test";
import { formatMetric, readExperimentRun, readLoggedExperiment } from "./autoresearch.ts";
import { isMcpToolName, mcpArgsSummary, mcpOutputText, mcpToolLabel } from "./mcp-tool.ts";
import { readYieldSubmission, yieldItems, yieldLabels } from "./yield-submission.ts";

const submission = (patch: Partial<Parameters<typeof readYieldSubmission>[0]>) => readYieldSubmission({ args: {}, details: {}, text: "", isError: false, settled: true, ...patch });

it("a yield reads the accepted data over the data as sent, and an abort over an error argument", () => {
	assert.deepEqual(submission({ args: { data: [1] }, details: { data: [1, 2], status: "success", type: ["findings"] } }).size, "2 items");
	const aborted = submission({ args: { error: "sent" }, details: { status: "aborted", error: "taken", data: undefined } });
	assert.equal(aborted.error, "taken");
	assert.equal(aborted.aborted, true);
	assert.equal(submission({ args: { error: "sent" }, details: { status: "aborted" }, text: "Task aborted: sent" }).error, "Task aborted: sent");
	assert.equal(submission({ args: { error: "sent" }, details: { status: "aborted" } }).error, "Aborted", "an abort with no message of its own is just aborted, as in the terminal UI");
	assert.equal(submission({ details: { status: "aborted" } }).error, "Aborted");
});

it("a yield the tool rejected ignores its details and reads the failure from the text", () => {
	const rejected = submission({ args: { data: { a: 1 } }, details: { data: "stale" }, text: "  Output does not match schema.  ", isError: true });
	assert.equal(rejected.error, "Output does not match schema.");
	assert.deepEqual(rejected.data, { a: 1 });
	assert.equal(submission({ isError: true }).error, "Submit Result failed");
});

it("a yield's target is its workpool item or its incremental section labels", () => {
	assert.equal(submission({ args: { key: 2, type: ["x"] } }).target, "item 2");
	assert.equal(submission({ args: { type: ["a", "b"] } }).target, "a, b");
	assert.equal(submission({ args: { type: "result" } }).target, undefined);
	assert.equal(submission({ args: { type: [] } }).target, undefined);
	assert.equal(submission({ args: { type: ["a"] }, details: { type: ["b"] } }).target, "b", "the tool's normalised type wins");
});

it("yield items and labels read a lone record, a list or nothing", () => {
	assert.deepEqual(yieldItems({ type: "result" }), [{ type: "result" }]);
	assert.deepEqual(yieldItems([{ a: 1 }, 5, null]), [{ a: 1 }]);
	assert.deepEqual(yieldItems(undefined), []);
	assert.deepEqual(yieldLabels("result"), ["result"]);
	assert.deepEqual(yieldLabels(["a", 1, "b"]), ["a", "b"]);
	assert.deepEqual(yieldLabels(undefined), []);
});

it("MCP tools are identified by their minted name alone", () => {
	assert.equal(isMcpToolName("mcp__figma_get_node"), true);
	for (const name of ["mcp__", "mcp_figma_get_node", "read", "xmcp__a_b", ""]) assert.equal(isMcpToolName(name), false, name);
	assert.equal(mcpToolLabel("read", { serverName: "s", mcpToolName: "t" }), null, "details alone never make a tool an MCP tool");
	assert.equal(mcpToolLabel("mcp__figma_get_node", { serverName: "Figma", mcpToolName: "get_node" }), "Figma/get_node");
	assert.equal(mcpToolLabel("mcp__figma_get_node", { serverName: "", mcpToolName: "get_node" }), "figma/get_node");
	assert.equal(mcpToolLabel("mcp__nounderscore", {}), "mcp__nounderscore");
});

it("an arguments summary quotes strings to 24 characters, counts containers and drops the intent field", () => {
	assert.equal(mcpArgsSummary({ q: "a\nb\tc", n: 2, ok: false, none: null, list: [1, 2], map: { a: 1, b: 2 }, i: "intent", __partialJson: "{" }), 'q="a\\nb\\tc", n=2, ok=false, none=null, list=[2 items], map={2 keys}');
	assert.equal(mcpArgsSummary({ text: "x".repeat(40) }), `text="${"x".repeat(23)}…"`);
	assert.equal(mcpArgsSummary({ text: "y".repeat(1_000_000) }), `text="${"y".repeat(23)}…"`);
	assert.equal(mcpArgsSummary({}), "");
	assert.equal(mcpArgsSummary({ i: "only intent" }), "");
	const wide = mcpArgsSummary(Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`key${index}`, "v"])));
	assert.ok(wide.endsWith(", …") && wide.length <= 165);
});

it("a result's own metadata cuts the notice the text rules do not know, and a JSON paragraph is left alone", () => {
	const meta = { truncation: { direction: "middle", totalLines: 9 } };
	assert.equal(mcpOutputText("{}\n\n[Showing head and tail bytes of 9 lines; 4.0KB elided. Read artifact://2 for full output]\n", { meta }), "{}");
	assert.equal(mcpOutputText("body\n\n[Full output was not saved completely (artifact write failed)]", { meta: { artifactError: "write" } }), "body");
	assert.equal(mcpOutputText("rows\n\n[1, 2]", { meta }), "rows\n\n[1, 2]");
	assert.equal(mcpOutputText("body\n\n[Showing lines 1-2 of 9]", {}), "body\n\n[Showing lines 1-2 of 9]", "without metadata the text is the output");
});

it("metrics are grouped by thousands, integers whole and others to two decimals", () => {
	assert.equal(formatMetric(1234567, "ms"), "1,234,567ms");
	assert.equal(formatMetric(0.5, "s"), "0.50s");
	assert.equal(formatMetric(-1234.567, ""), "-1,234.57");
	assert.equal(formatMetric(null, "ms"), "-");
});

it("experiment details are read only in the shape OMP writes", () => {
	assert.equal(readLoggedExperiment({}), null);
	assert.equal(readLoggedExperiment({ experiment: { status: "bogus" }, state: {} }), null);
	assert.equal(readExperimentRun({ phase: "running", elapsed: "3s" }), null);
	assert.equal(readExperimentRun({ command: "x", durationSeconds: "3" }), null);
	const crashed = readExperimentRun({ command: "bash autoresearch.sh", durationSeconds: 3, exitCode: null, timedOut: false, tailOutput: "" });
	assert.equal(crashed?.label, "FAIL");
	assert.equal(crashed?.summary, "exit=null 3.0s");
});
