import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { formatGistDuration, toolGist, type GistPart } from "./tool-gist.ts";
import { splitToolNotices } from "./tool-notices.ts";

interface Call { id: string; tool: string; args: Record<string, unknown>; resultText: string; details: Record<string, unknown>; isError: boolean }
const calls: readonly Call[] = JSON.parse(readFileSync(new URL("../webview/fixtures/tool-calls.json", import.meta.url), "utf8"));
const gistOf = (id: string, extra: { startedAt?: number; endedAt?: number; observedMs?: number } = {}): string => {
	const real = calls.find(item => item.id === id) ?? assert.fail(`fixture ${id}`);
	const split = splitToolNotices(real.resultText);
	const parts: readonly GistPart[] = toolGist({ name: real.tool, args: real.args, details: real.details, body: split.body, notices: split.notices, failed: real.isError, settled: true, ...extra });
	return parts.map(part => part.text).join(" · ");
};

it("is silent about an exit code of 0, says the lines and the exact duration", () => {
	assert.match(gistOf("bash-ndjson"), /^25 lines · 931 ms$/);
	assert.doesNotMatch(gistOf("bash-ndjson"), /exit/);
});

it("leads with the exit code of a failing command, then its size and duration", () => {
	assert.match(gistOf("bash-tsc-npm-typecheck-fail"), /^exit 2 · \d+ lines? · 4\.67 s$/);
	assert.match(gistOf("bash-fail-exit127"), /^exit 127/);
	assert.match(gistOf("bash-timeout"), /exit 1 · timed out/);
});

it("says background for a backgrounded command and counts what the output has", () => {
	assert.match(gistOf("bash-background-job-started"), /^background/);
});

it("gists search and listing results by what they found", () => {
	assert.match(gistOf("grep-multi-file-limited"), /matches?/);
	assert.match(gistOf("glob-list"), /^8 files$/);
	assert.match(gistOf("glob-result-limit"), /200 files · limit reached/);
	assert.match(gistOf("find-hits"), /hits?/);
});

it("derives a duration from timestamps only above 1.5 s and marks it approximate, while an observed one is exact", () => {
	assert.doesNotMatch(gistOf("read-text-file", { startedAt: 1000, endedAt: 2400 }), /≈/, "1.4 s is mostly the model's own time");
	assert.match(gistOf("read-text-file", { startedAt: 1000, endedAt: 5200 }), /≈ 4\.20 s$/);
	const observed = gistOf("read-text-file", { startedAt: 1000, endedAt: 5200, observedMs: 3100 });
	assert.match(observed, /3\.10 s$/); assert.doesNotMatch(observed, /≈/);
	assert.doesNotMatch(gistOf("bash-ndjson", { startedAt: 1000, endedAt: 9000 }), /≈/, "an exact wall time wins over the derived one");
});

it("says failed for a failed call that no part already marks as an error", () => {
	assert.match(gistOf("lsp-timeout-error"), /^failed/);
	assert.match(gistOf("mcp-error"), /^failed/);
});

it("formats durations as the gist shows them", () => {
	assert.deepEqual([205, 4670, 41300, 125000].map(formatGistDuration), ["205 ms", "4.67 s", "41.3 s", "2m 5s"]);
});

it("says a wait took as long as the longest job it settled", () => {
	const parts = toolGist({ name: "wait", args: {}, details: { jobs: [{ id: "a", status: "completed", durationMs: 1200 }, { id: "b", status: "completed", durationMs: 9100 }, { id: "c", status: "running", durationMs: 99000 }] }, body: "", notices: [], failed: false, settled: true });
	assert.deepEqual(parts.map(part => part.text), ["2 jobs settled", "9.10 s"]);
});

it("holds an observed duration to the same floor as a derived one, and marks only the derived one approximate", () => {
	const base = { name: "lsp", args: {}, details: {}, body: "", notices: [], failed: false, settled: true } as const;
	assert.deepEqual(toolGist({ ...base, observedMs: 1400 }).map(part => part.text), []);
	assert.deepEqual(toolGist({ ...base, observedMs: 4200 }).map(part => part.text), ["4.20 s"]);
	assert.deepEqual(toolGist({ ...base, startedAt: 1_000, endedAt: 5_200 }).map(part => part.text), ["≈ 4.20 s"]);
});
