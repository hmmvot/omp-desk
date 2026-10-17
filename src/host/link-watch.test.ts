import assert from "node:assert/strict";
import { afterEach, beforeEach, test, mock } from "node:test";
import { FileEventGate, globRegExp } from "./link-watch.ts";

const UNITY = "D:\\Work\\repo\\Unity";
const REPO = "D:\\Work\\repo";

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 }));
afterEach(() => mock.timers.reset());

/** A gate over folders and per-folder exclude patterns that records what it reports. */
function rig(excludes: Record<string, readonly string[]>, folders: readonly string[] = Object.keys(excludes)) {
	const reported: string[] = [];
	const gate = new FileEventGate({
		folders: () => folders,
		excludes: folder => excludes[folder] ?? [],
		dropFiles: () => reported.push("files"),
		dropContent: () => reported.push("content"),
	});
	return { gate, reported };
}

const settle = () => mock.timers.tick(5_000);

test("globRegExp follows VS Code's globs and gives up on syntax it does not know", () => {
	const matches = (pattern: string, text: string) => globRegExp(pattern)?.test(text);
	assert.equal(matches("**/.git", ".git"), true);
	assert.equal(matches("**/.git", "sub/.git"), true);
	assert.equal(matches("**/.git", "sub/.gitignore"), false);
	assert.equal(matches("Temp", "Temp"), true);
	assert.equal(matches("Temp", "Assets/Temp"), false, "a pattern without ** is anchored at the folder");
	assert.equal(matches("Library/**", "Library/a/b.dll"), true);
	assert.equal(matches("**/*.meta", "Assets/Scripts/A.cs.meta"), true);
	assert.equal(matches("**/*.meta", "A.meta"), true);
	assert.equal(matches("*.meta", "Assets/A.meta"), false);
	assert.equal(matches("**/node_modules/**", "web/node_modules/x/y.js"), true);
	assert.equal(matches("{**/*.cs,**/*.js}", "a/b.js"), true);
	assert.equal(matches("a?c", "abc"), true);
	assert.equal(matches("a?c", "a/c"), false);
	assert.equal(matches("[abc].txt", "b.txt"), true);
	assert.equal(matches("[!abc].txt", "b.txt"), false);
	assert.equal(globRegExp("a\\b"), null);
	assert.equal(globRegExp("{a,b"), null);
	assert.equal(globRegExp("a}"), null);
	assert.equal(globRegExp("[a"), null);
});

test("an event under a folder's own files.exclude or under .git does not invalidate; one for a source file does", () => {
	const { gate, reported } = rig({ [UNITY]: ["Temp", "**/Library", "**/*.meta"], [REPO]: ["Unity"] }, [UNITY, REPO]);
	// `Temp/` is hidden by the Unity folder's own excludes, although the repository root (which holds it too) hides `Unity` as a whole: both hide it.
	gate.event("created", `${UNITY}\\Temp\\UnityLockfile`);
	gate.event("deleted", `${UNITY}\\Library\\Bee\\artifacts\\x.dll`);
	gate.event("created", `${UNITY}\\Assets\\Scripts\\Session.cs.meta`);
	gate.event("changed", `${REPO}\\.git\\index`);
	gate.event("created", `${REPO}\\.git\\objects\\ab\\cdef`);
	gate.event("deleted", `${UNITY}\\.git`);
	settle();
	assert.deepEqual(reported, [], "nothing a lookup can return changed");
	gate.event("created", `${UNITY}\\Assets\\Scripts\\Session.cs`);
	settle();
	assert.deepEqual(reported, ["files"], "a normal source file does");
	gate.event("changed", `${UNITY}\\Assets\\Scripts\\Session.cs`);
	settle();
	assert.deepEqual(reported, ["files", "content"], "a change of contents is only a content invalidation");
	gate.dispose();
});

test("a file hidden by one workspace folder but visible to another that holds it still invalidates", () => {
	// The repository root hides nothing; the Unity folder inside it hides `Temp`. The root's search still returns `Unity/Temp/x.cs`.
	const { gate, reported } = rig({ [UNITY]: ["Temp"], [REPO]: [] }, [UNITY, REPO]);
	gate.event("created", `${UNITY}\\Temp\\x.cs`);
	settle();
	assert.deepEqual(reported, ["files"]);
	gate.dispose();
});

test("a pattern the matcher does not understand, a path outside every folder and an excludes change never hide an event they should not", () => {
	const excludes: Record<string, string[]> = { [UNITY]: ["a\\b"] };
	const { gate, reported } = rig(excludes);
	gate.event("created", "E:\\Elsewhere\\Session.cs");
	gate.event("created", `${UNITY}\\a\\b\\x.cs`);
	settle();
	assert.deepEqual(reported, ["files"], "ignored only when certain");
	excludes[UNITY] = ["Temp"];
	gate.event("created", `${UNITY}\\Temp\\a.txt`);
	settle();
	assert.deepEqual(reported, ["files", "files"], "the patterns are cached until told to read again");
	gate.resetExcludes();
	gate.event("created", `${UNITY}\\Temp\\a.txt`);
	settle();
	assert.deepEqual(reported, ["files", "files"], "the new excludes apply after a reset");
	gate.dispose();
});

test("a burst of events is one invalidation", () => {
	const { gate, reported } = rig({ [UNITY]: [] });
	for (let index = 0; index < 50; index++) {
		gate.event(index % 2 === 0 ? "created" : "deleted", `${UNITY}\\Assets\\Generated\\File${index}.cs`);
		mock.timers.tick(10);
	}
	assert.deepEqual(reported, [], "nothing is reported while the burst goes on");
	mock.timers.tick(250);
	assert.deepEqual(reported, ["files"]);
	settle();
	assert.deepEqual(reported, ["files"], "and nothing more afterwards");
	gate.event("changed", `${UNITY}\\Assets\\A.cs`);
	gate.event("created", `${UNITY}\\Assets\\B.cs`);
	settle();
	assert.deepEqual(reported, ["files", "files"], "contents and files in one burst are reported as files, which includes contents");
	gate.dispose();
});

test("a burst that never pauses is still reported after the maximum wait", () => {
	const { gate, reported } = rig({ [UNITY]: [] });
	for (let elapsed = 0; elapsed < 2_500; elapsed += 100) {
		gate.event("created", `${UNITY}\\Assets\\Import${elapsed}.cs`);
		mock.timers.tick(100);
	}
	assert.ok(reported.length >= 1, "an endless stream does not hold the invalidation off forever");
	gate.dispose();
});

test("a rename by the user is an invalidation without a path", () => {
	const { gate, reported } = rig({ [UNITY]: ["Assets"] });
	gate.renamed();
	settle();
	assert.deepEqual(reported, ["files"]);
	gate.dispose();
});
