import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractContextFiles, isAbsoluteWindowsPath, isContextReportText, parseContextReport, parseSessionStats } from "./context-parse.ts";

/** The text installed OMP 18.8.5 printed for `/context` in an RPC child (a zero category is omitted). */
const REPORT = [
	"Context window: 20000 tokens (11% used)",
	"  System prompt    [████░░░░░░░░░░░░░░░░░░░░] 15%  2998 tokens",
	"  System tools     [█████░░░░░░░░░░░░░░░░░░░] 21%  4293 tokens",
	"  System context   [██░░░░░░░░░░░░░░░░░░░░░░] 7%  1325 tokens",
	"  Skills           [█░░░░░░░░░░░░░░░░░░░░░░░] 4%  745 tokens",
	"  Auto-compact buf [████████████████████░░░░] 82%  16384 tokens",
	"  Free             [██░░░░░░░░░░░░░░░░░░░░░░] 8%  1516 tokens",
].join("\n");

describe("/context report", () => {
	it("reads the window, the rows OMP printed and writes out its truncated label", () => {
		const report = parseContextReport(REPORT)!;
		assert.equal(report.contextWindow, 20000);
		assert.equal(report.usedPercent, 11);
		assert.deepEqual(report.rows, [
			{ label: "System prompt", tokens: 2998 }, { label: "System tools", tokens: 4293 }, { label: "System context", tokens: 1325 },
			{ label: "Skills", tokens: 745 }, { label: "Auto-compact buffer", tokens: 16384 }, { label: "Free", tokens: 1516 },
		]);
		assert.deepEqual(report.notes, []);
		assert.equal(report.unavailable, null);
	});
	it("keeps a category OMP adds later and any line it does not know, verbatim and bounded", () => {
		const text = `${REPORT}\n  Plans            [█░░░░░░░░░░░░░░░░░░░░░░░] 1%  120 tokens\nSnapcompact (estimated wire savings):\n  System prompt: stays text (no net savings)\n${"x".repeat(1000)}`;
		const report = parseContextReport(text)!;
		assert.ok(report.rows.some(row => row.label === "Plans" && row.tokens === 120));
		assert.equal(report.notes[0], "Snapcompact (estimated wire savings):");
		assert.equal(report.notes[1], "System prompt: stays text (no net savings)");
		assert.equal(report.notes[2]!.length, 240);
	});
	it("strips terminal styling and carriage returns before reading", () => {
		const styled = REPORT.replaceAll("\n", "\r\n").replace("[████", "\u001b[32m[████").replace("1325 tokens", "1325 tokens\u001b[0m");
		assert.deepEqual(parseContextReport(styled)?.rows.find(row => row.label === "System context"), { label: "System context", tokens: 1325 });
	});
	it("reads OMP's themed report: truecolor runs inside every bar, far longer than its plain text", () => {
		const bar = (filled: number): string => `[\u001b[38;2;107;114;128m${"░".repeat(24 - filled)}\u001b[39m${Array.from({ length: filled }, () => "\u001b[1m\u001b[38;2;0;180;255m█\u001b[22m\u001b[39m").join("")}] 1%`;
		const styled = ["Context window: 200000 tokens (3% used)", ...Array.from({ length: 12 }, (_, index) => `  ${`Row ${index}`.padEnd(16)} ${bar(24)}  ${index + 1} tokens`)].join("\n");
		assert.ok(styled.length > 8_192, "the styled text exceeds the plain-text bound");
		const report = parseContextReport(styled);
		assert.equal(report?.rows.length, 12);
		assert.deepEqual(report?.rows[3], { label: "Row 3", tokens: 4 });
		assert.equal(isContextReportText(`\u001b[1mContext window:\u001b[22m 5 tokens (1% used)`), true);
	});
	it("answers an explicit unavailable state for OMP's no-model text and reads its minimal fallback form", () => {
		const none = parseContextReport("Context usage is unavailable: no model is selected for this session.")!;
		assert.equal(none.unavailable, "Context usage is unavailable: no model is selected for this session.");
		assert.deepEqual(none.rows, []);
		const minimal = parseContextReport("Context\nWindow: 200000\nUsed: 5000")!;
		assert.equal(minimal.contextWindow, 200000);
		assert.deepEqual(minimal.rows, [{ label: "Used", tokens: 5000 }]);
	});
	it("is not a report unless the text begins like one, and never accepts an oversize or malformed header", () => {
		assert.equal(parseContextReport("Compaction complete. Tokens: 900 -> 300 (saved 600)."), null);
		assert.equal(parseContextReport("Context window: lots"), null);
		assert.equal(parseContextReport(`Context window: 1 tokens (1% used)\n${"y".repeat(9000)}`), null);
		assert.equal(parseContextReport(""), null);
		assert.equal(isContextReportText("Nothing to shake."), false);
		assert.equal(isContextReportText("Context window: 5 tokens (1% used)"), true);
	});
});

describe("session stats", () => {
	const good = { sessionId: "s", userMessages: 2, assistantMessages: 2, toolCalls: 3, toolResults: 3, totalMessages: 10, premiumRequests: 0,
		tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 7, cacheWrite: 9, total: 141 }, cost: 0.5 };
	it("keeps the counts and the billed tokens", () => {
		assert.deepEqual(parseSessionStats(good), { userMessages: 2, assistantMessages: 2, toolCalls: 3, toolResults: 3, totalMessages: 10, premiumRequests: 0,
			tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 7, cacheWrite: 9 } });
	});
	it("keeps a fractional premium multiplier", () => {
		for (const premium of [0.25, 0.33, 1.5]) assert.equal(parseSessionStats({ ...good, premiumRequests: premium })?.premiumRequests, premium);
	});
	it("refuses a payload with a non-integer, negative or missing field instead of showing part of it", () => {
		assert.equal(parseSessionStats({ ...good, toolCalls: -1 }), null);
		assert.equal(parseSessionStats({ ...good, userMessages: 1.5 }), null);
		assert.equal(parseSessionStats({ ...good, tokens: { ...good.tokens, input: "100" } }), null);
		assert.equal(parseSessionStats({ ...good, tokens: undefined }), null);
		assert.equal(parseSessionStats(null), null);
		assert.equal(parseSessionStats({ ...good, premiumRequests: undefined })?.premiumRequests, 0, "a missing premium figure is zero");
		assert.equal(parseSessionStats({ ...good, premiumRequests: -0.25 }), null);
		assert.equal(parseSessionStats({ ...good, premiumRequests: "1" }), null);
	});
});

const PROJECT = (files: string, dir = "") => [
	"<project-context>",
	"<workstation>",
	"- OS: win32",
	"</workstation>",
	"",
	"<repo-rules>",
	"MUST follow these context files for all tasks:",
	files,
	"</repo-rules>",
	"",
	dir,
	"</project-context>",
].join("\n");
const FILE = (file: string, content: string) => `<file path="${file}">\n${content}\n</file>`;

describe("context files in the system prompt", () => {
	it("lists the files OMP rendered, in order, with their content length", () => {
		const prompt = ["You are an agent.", PROJECT(`${FILE("C:\\proj\\AGENTS.md", "# Rules\nBe brief.")}\n${FILE("C:\\Users\\me\\.omp\\agent\\AGENTS.md", "user")}`)];
		assert.deepEqual(extractContextFiles(prompt), { files: [{ path: "C:\\proj\\AGENTS.md", chars: 17 }, { path: "C:\\Users\\me\\.omp\\agent\\AGENTS.md", chars: 4 }], onDemand: [] });
	});
	it("reads the directory rule files OMP asks the agent to read on demand", () => {
		const dir = "<dir-context>\nSome directories may have rules; deeper rules override higher ones.\nBefore changes in these directories, MUST read:\n- C:\\proj\\src\\AGENTS.md\n- relative\\AGENTS.md\n- \\\\server\\share\\AGENTS.md\n</dir-context>";
		assert.deepEqual(extractContextFiles([PROJECT(FILE("C:\\proj\\AGENTS.md", "x"), dir)]).onDemand, ["C:\\proj\\src\\AGENTS.md", "\\\\server\\share\\AGENTS.md"]);
	});
	it("reports none when the prompt has no such section, and handles an empty file", () => {
		assert.deepEqual(extractContextFiles(["You are an agent."]), { files: [], onDemand: [] });
		assert.deepEqual(extractContextFiles([PROJECT(FILE("C:\\proj\\EMPTY.md", ""))]).files, [{ path: "C:\\proj\\EMPTY.md", chars: 0 }]);
	});
	it("drops a path that is not an absolute Windows path and never lets content impersonate the section end", () => {
		const hostile = FILE("..\\evil.md", "x") + "\n" + FILE("C:\\proj\\a.md", "text with </file> inside and <file path=\"C:\\nope.md\"> mention");
		const result = extractContextFiles([PROJECT(hostile)]);
		assert.deepEqual(result.files.map(file => file.path), ["C:\\proj\\a.md"]);
	});
	it("is bounded: at most 64 files and nothing past the scan limit", () => {
		const many = Array.from({ length: 80 }, (_, index) => FILE(`C:\\p\\f${index}.md`, "x")).join("\n");
		assert.equal(extractContextFiles([PROJECT(many)]).files.length, 64);
		assert.deepEqual(extractContextFiles(["z".repeat(5 * 1024 * 1024), PROJECT(FILE("C:\\p\\late.md", "x"))]).files, []);
	});
	it("accepts drive and UNC paths only, without control characters", () => {
		for (const ok of ["C:\\a.md", "d:/x/y.md", "\\\\host\\share\\a.md"]) assert.equal(isAbsoluteWindowsPath(ok), true, ok);
		for (const bad of ["a.md", "\\a.md", "C:a.md", "C:\\a\nb.md", "C:\\a|b.md", "", "C:\\" + "x".repeat(2000)]) assert.equal(isAbsoluteWindowsPath(bad), false, bad);
	});
});
