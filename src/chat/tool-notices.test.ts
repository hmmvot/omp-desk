import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { backgroundJobOf, detailFooterParts, exitCodeOf, footerParts, splitToolNotices, wallTimeOf } from "./tool-notices.ts";

interface Call { id: string; tool: string; resultText: string; details: Record<string, unknown> }
const calls: readonly Call[] = JSON.parse(readFileSync(new URL("../webview/fixtures/tool-calls.json", import.meta.url), "utf8"));
const call = (id: string): Call => calls.find(item => item.id === id) ?? assert.fail(`fixture ${id}`);

it("takes the wall time and the exit code off a real failing command and keeps its output", () => {
	const real = call("bash-tsc-npm-typecheck-fail");
	const split = splitToolNotices(real.resultText);
	assert.doesNotMatch(split.body, /Wall time|Command exited/);
	assert.deepEqual(split.notices.map(notice => notice.kind), ["wall", "exit"]);
	assert.equal(exitCodeOf(real.details, split.notices), 2);
	assert.equal(wallTimeOf({}, split.notices), 4670);
});

it("leaves a notice-shaped line inside the output alone and only reads the end of the text", () => {
	const text = "Wall time: 9.00 seconds\nstill output\nCommand exited with code 7 is quoted here\nlast line";
	assert.deepEqual(splitToolNotices(text), { body: text, notices: [] });
});

it("reads the background notice of a real call, with or without the parenthesised hint", () => {
	const real = call("bash-background-job-started");
	const split = splitToolNotices(real.resultText);
	assert.equal(backgroundJobOf({}, split.notices), "bg_59");
	assert.doesNotMatch(split.body, /Do NOT poll|Backgrounded/);
	const bare = splitToolNotices("out\nBackgrounded as job bg_7; its output is injected into the conversation as a follow-up. Do NOT poll for it.");
	assert.equal(backgroundJobOf({}, bare.notices), "bg_7");
	assert.equal(bare.body, "out");
});

it("reads the truncation and artifact notices of real results, so a pretty JSON result is again only JSON", () => {
	const truncated = call("bash-trunc-middle-artifact");
	const split = splitToolNotices(truncated.resultText);
	assert.ok(split.notices.some(notice => notice.kind === "truncated"));
	assert.doesNotMatch(split.body.slice(-300), /Showing lines|Read artifact/);
	const raw = splitToolNotices(call("bash-raw-output-artifact-footer").resultText);
	assert.ok(raw.notices.some(notice => notice.kind === "raw"));
	const json = splitToolNotices(call("bash-json-pretty").resultText);
	assert.doesNotThrow(() => JSON.parse(json.body), "the notices no longer make the JSON invalid");
});

it("merges what the text and `details` say about the same artifact into one footer, with the artifact number", () => {
	const real = call("bash-trunc-middle-artifact");
	const split = splitToolNotices(real.resultText);
	const parts = footerParts(split.notices, real.details);
	const artifacts = parts.flatMap(part => part.artifact === undefined ? [] : [part.artifact]);
	assert.equal(new Set(artifacts).size, artifacts.length, "an artifact is named once");
	assert.ok(artifacts.length >= 1);
	assert.ok(parts.some(part => part.tone === "warn" && /^Output truncated/.test(part.text)));
	assert.equal(parts.filter(part => /^Output truncated/.test(part.text)).length, 1, "a truncation is said once");
	assert.deepEqual(detailFooterParts({}), []);
});

it("says a column cut and a timeout, and puts exit and wall time in the gist and the bar, not the footer", () => {
	const cut = call("bash-json-long-columntruncated");
	const parts = footerParts(splitToolNotices(cut.resultText).notices, cut.details);
	assert.ok(parts.some(part => /^Some lines truncated to \d+ (chars|bytes)/.test(part.text)));
	const timeout = call("bash-timeout");
	const timeoutParts = footerParts(splitToolNotices(timeout.resultText).notices, timeout.details);
	assert.ok(!timeoutParts.some(part => /Wall time|exited/.test(part.text)));
	assert.equal(exitCodeOf(timeout.details, []), 1);
});
