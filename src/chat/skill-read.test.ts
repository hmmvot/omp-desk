import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSkillUrl, skillFilePath, skillReadView, stripSkillHeader } from "./skill-read.ts";
import { projectToolOverview, type ToolCard } from "./tool-overview.ts";
import { toolPresentation } from "./tool-presentation.ts";
import type { ProjectedTool } from "./transcript.ts";

const FILE = "C:\\Users\\me\\.omp\\skills\\omp-desk-release\\SKILL.md";
const header = (path = FILE): string => `[Skill file: ${path}]\n`;

const read = (id: string, path: string, result?: { text?: string; details?: Record<string, unknown>; isError?: boolean }): ToolCard => {
	const tool: ProjectedTool = {
		entryId: id, call: { type: "toolCall", id, name: "read", arguments: { path } },
		result: result === undefined ? undefined : { role: "toolResult", timestamp: 1, toolCallId: id, toolName: "read", content: [{ type: "text", text: result.text ?? "" }], isError: result.isError === true, details: result.details },
		status: result === undefined ? "running" : result.isError === true ? "error" : "complete", mutable: false, attachments: [],
	};
	return { kind: "tool", id, sourceIds: [id], ownership: "call", tool };
};

describe("parseSkillUrl", () => {
	it("names a skill, a file inside it and a read selector", () => {
		assert.deepEqual(parseSkillUrl("skill://omp-desk-release"), { name: "omp-desk-release", file: null, selector: null });
		assert.deepEqual(parseSkillUrl("skill://omp-desk-release/"), { name: "omp-desk-release", file: null, selector: null });
		assert.deepEqual(parseSkillUrl("skill://omp-desk-release/scripts/x.md"), { name: "omp-desk-release", file: "scripts/x.md", selector: null });
		assert.deepEqual(parseSkillUrl("skill://omp-desk-release/my%20notes.md"), { name: "omp-desk-release", file: "my notes.md", selector: null });
		assert.deepEqual(parseSkillUrl("  SKILL://omp-desk-release  "), { name: "omp-desk-release", file: null, selector: null });
	});

	it("peels a selector tail off the name or the file, and only a selector", () => {
		assert.deepEqual(parseSkillUrl("skill://omp-desk-release:50-80"), { name: "omp-desk-release", file: null, selector: "50-80" });
		assert.deepEqual(parseSkillUrl("skill://omp-desk-release:raw"), { name: "omp-desk-release", file: null, selector: "raw" });
		assert.deepEqual(parseSkillUrl("skill://omp-desk-release/scripts/x.md:raw:10-20"), { name: "omp-desk-release", file: "scripts/x.md", selector: "raw:10-20" });
		assert.equal(parseSkillUrl("skill://a:b"), null, "a colon that is not a selector is not a name");
	});

	it("refuses input that is not a well-formed skill URL", () => {
		for (const input of [undefined, null, 5, {}, "", "skill://", "skill:///", "skill:/name", "skills://name", "agent://name", "proc://1", "artifact://1", "history://x", "local://x.md",
			"skill://name/../secret", "skill://name/./x", "skill://name//x", "skill://name/%E0%A4%A", "skill://name?q=1", "skill://name#top", "skill://na me", "skill://name\\x", "skill://name\nx", "skill://..", "skill://name/%2Fetc"]) {
			assert.equal(parseSkillUrl(input), null, JSON.stringify(input));
		}
	});
});

describe("skillFilePath and stripSkillHeader", () => {
	it("takes the resolved path of the result, else the first line, and only an absolute path", () => {
		assert.equal(skillFilePath({ resolvedPath: FILE }, "body"), FILE);
		assert.equal(skillFilePath({}, `${header()}# Skill`), FILE);
		assert.equal(skillFilePath({}, `${header("/home/me/skill [v2]/SKILL.md")}# Skill`), "/home/me/skill [v2]/SKILL.md", "a bracket inside the path is kept");
		assert.equal(skillFilePath({ resolvedPath: "/a/SKILL.md" }, `${header()}x`), "/a/SKILL.md", "the structured path wins");
		assert.equal(skillFilePath({ resolvedPath: "relative/SKILL.md" }, "x"), null);
		assert.equal(skillFilePath({ resolvedPath: 5 }, `${header("SKILL.md")}x`), null);
		assert.equal(skillFilePath({}, `body first\n${header()}`), null, "only the first line is a header");
		assert.equal(skillFilePath({}, `[Skill file: ${FILE}] trailing\n`), null);
		assert.equal(skillFilePath({}, "[Skill file: ]\n"), null);
	});

	it("drops a pure-metadata first line and nothing else", () => {
		assert.equal(stripSkillHeader(`${header()}# Skill\nbody`), "# Skill\nbody");
		assert.equal(stripSkillHeader(`[Skill file: ${FILE}]\r\n# Skill`), "# Skill");
		assert.equal(stripSkillHeader(`[Skill file: ${FILE}]`), "");
		assert.equal(stripSkillHeader(`# Skill\n${header()}`), `# Skill\n${header()}`);
		assert.equal(stripSkillHeader("[Skill file: not closed\nx"), "[Skill file: not closed\nx");
	});
});

describe("skillReadView", () => {
	it("labels the name, the sub-file and the selector, and carries a path only once settled", () => {
		assert.deepEqual(skillReadView("skill://a/b/c.md:5", {}, header(), true), { name: "a", file: "b/c.md", selector: "5", label: "a / b/c.md:5", path: FILE });
		assert.equal(skillReadView("skill://a", {}, header(), false)?.path, null, "a running call has no link");
		assert.equal(skillReadView("skill://a", {}, "no header", true)?.path, null, "a result without a path has no link");
		assert.equal(skillReadView("src/a.ts", {}, "", true), null);
	});
});

describe("a skill read in the tool presentation and the overview", () => {
	it("presents as a Skill with the book target and its file, and keeps other internal URLs as they were", () => {
		const done = toolPresentation(read("r", "skill://omp-desk-release", { text: `${header()}# Skill`, details: { resolvedPath: FILE } }).tool, "C:/repo");
		assert.equal(done.title, "Skill");
		assert.equal(done.category, "skill");
		assert.equal(done.target, "omp-desk-release");
		assert.deepEqual(done.paths, [FILE]);
		assert.equal(done.skill?.name, "omp-desk-release");
		const sub = toolPresentation(read("r", "skill://omp-desk-release/scripts/x.md", { text: header("C:\\s\\scripts\\x.md"), details: {} }).tool);
		assert.equal(sub.target, "omp-desk-release / scripts/x.md");
		assert.deepEqual(sub.paths, ["C:\\s\\scripts\\x.md"]);
		const running = toolPresentation(read("r", "skill://omp-desk-release").tool);
		assert.deepEqual([running.title, running.target, running.paths], ["Skill", "omp-desk-release", []]);
		const failed = toolPresentation(read("r", "skill://nope", { text: "Unknown skill: nope", isError: true, details: { resolvedPath: FILE } }).tool);
		assert.deepEqual([failed.category, failed.paths, failed.failed], ["skill", [], true]);
		for (const url of ["agent://Peer", "proc://job", "artifact://3", "history://x", "local://plan.md", "https://example.test/a"]) {
			const other = toolPresentation(read("r", url, { text: "x", details: {} }).tool);
			assert.deepEqual([other.title, other.category, other.skill], ["Read", "other", null], url);
		}
		assert.equal(toolPresentation(read("r", "skill://x", { text: "x" }).tool).route.name, "read");
	});

	it("says Loaded N skills in a group, counting each skill once and keeping files apart", () => {
		const group = (...cards: ToolCard[]): string => projectToolOverview(cards, "conversation").runs[0]!.summary;
		const one = read("one", "skill://omp-desk-release", { text: header(), details: { resolvedPath: FILE } });
		const sub = read("sub", "skill://omp-desk-release/notes.md", { text: header("/s/notes.md") });
		const other = read("other", "skill://brainstorm", { text: header("/b/SKILL.md") });
		const file = read("file", "src/a.ts", { text: "x" });
		assert.equal(group(one, file), "Read 1 file · Loaded 1 skill");
		assert.equal(group(one, sub), "Loaded 1 skill");
		assert.equal(group(one, sub, other, file), "Read 1 file · Loaded 2 skills");
		assert.equal(group(read("run", "skill://a"), file), "Read 1 file · Loading 1 skill");
		assert.equal(group(read("bad", "skill://a", { text: "no", isError: true }), file), "Read 1 file · Attempted to load 1 skill · 1 failed");
	});
});
