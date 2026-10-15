import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBareFileName } from "../shared/code-symbols.ts";
import type { BareFileName } from "../shared/code-symbols.ts";
import { FileNameLinkResolver, MAX_FILE_NAME_RESULTS, distinctRoots, excludeGlob, fileChoiceLabel, fileNameGlob, fileNameOutcome, fileNameTarget, workspaceFileNameSource } from "./file-name-links.ts";
import type { FileNameResolverOptions, FileNameSource, FindFilesApi } from "./file-name-links.ts";

const CWD = "D:\\Work\\Game";
const scope = { cwd: CWD, roots: [CWD] };
const file = (content: string): BareFileName => {
	const parsed = parseBareFileName(content);
	assert.ok(parsed !== null, content);
	return parsed;
};
const at = (relative: string) => `${CWD}\\${relative}`;
/** One turn of the event loop, so promise continuations that were already due have run. */
function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** A file search over a fixed list of paths: every path that ends with the name (any case; the name may carry directories, `/`-separated) and lies below a folder. */
function search(paths: readonly string[], overrides: Partial<{ truncated: boolean; fail: "throw" | "hang" | "null" }> = {}) {
	const asked: { name: string; folders: readonly string[] }[] = [];
	const source: FileNameSource = {
		async find(name, folders, signal) {
			asked.push({ name, folders });
			if (overrides.fail === "throw") throw new Error("search failed");
			if (overrides.fail === "null") return null;
			if (overrides.fail === "hang") {
				const { promise, resolve } = Promise.withResolvers<null>();
				signal.addEventListener("abort", () => resolve(null), { once: true });
				return promise;
			}
			const found = paths.filter(candidate => candidate.toLowerCase().endsWith(`\\${name.replaceAll("/", "\\").toLowerCase()}`) && folders.some(folder => candidate.toLowerCase().startsWith(`${folder.toLowerCase()}\\`)));
			return { paths: found, truncated: overrides.truncated ?? false };
		},
	};
	return { source, asked };
}
const resolver = (paths: readonly string[], options: FileNameResolverOptions = {}, overrides: Parameters<typeof search>[1] = {}) => {
	const { source, asked } = search(paths, overrides);
	return { resolver: new FileNameLinkResolver(source, { isFile: async () => false, ...options }), asked };
};

test("one file of that name below the session's folder is a link to it, relative to the cwd, with the span's line and column", async () => {
	const { resolver: files, asked } = resolver([at("Assets\\Scenes\\session-index.ts"), at("Assets\\Scenes\\Other.cs")]);
	assert.deepEqual(await files.resolve(file("session-index.ts:849"), scope), { status: "found", target: "Assets/Scenes/session-index.ts:849" });
	assert.deepEqual(await files.resolve(file("session-index.ts:849:7"), scope), { status: "found", target: "Assets/Scenes/session-index.ts:849:7" });
	assert.deepEqual(await files.resolve(file("session-index.ts(849,3)"), scope), { status: "found", target: "Assets/Scenes/session-index.ts:849:3" });
	assert.deepEqual(await files.resolve(file("session-index.ts"), scope), { status: "found", target: "Assets/Scenes/session-index.ts" }, "no position, none in the target");
	assert.equal(asked.length, 1, "the position is not part of the question: the four spans share one search");
	assert.deepEqual(asked[0], { name: "session-index.ts", folders: [CWD] });
});

test("no file of that name is none, and none is remembered for a short time", async () => {
	let now = 0;
	const { resolver: files, asked } = resolver([at("Other.cs")], { now: () => now, noneTtlMs: 40 });
	assert.deepEqual(await files.resolve(file("Missing.cs:3"), scope), { status: "none" });
	assert.deepEqual(await files.resolve(file("Missing.cs:9"), scope), { status: "none" });
	assert.equal(asked.length, 1);
	now = 50;
	await files.resolve(file("Missing.cs"), scope);
	assert.equal(asked.length, 2, "an expired answer is asked again");
});

test("several files of that name are a choice, counted, never a guessed one", async () => {
	const { resolver: files } = resolver([at("A\\Settings.cs"), at("B\\Settings.cs"), at("C\\Settings.cs")]);
	assert.deepEqual(await files.resolve(file("Settings.cs:12"), scope), { status: "ambiguous", definitions: 3, files: true });
	assert.deepEqual(await files.lookup("Settings.cs", scope), { state: "many", paths: [at("A\\Settings.cs"), at("B\\Settings.cs"), at("C\\Settings.cs")] }, "sorted, case-insensitively");
});

test("a name that also exists directly in the session's folder keeps that match, whatever else the search finds", async () => {
	const own = at("Settings.cs");
	const { source, asked } = search([at("Sub\\Settings.cs"), at("Other\\Settings.cs")]);
	const files = new FileNameLinkResolver(source, { isFile: async candidate => candidate === own });
	assert.deepEqual(await files.resolve(file("Settings.cs:5"), scope), { status: "found", target: "Settings.cs:5" });
	assert.deepEqual(asked, [], "the folder's own file is the answer: no search runs");
});

test("exactly one of several inside the cwd narrows to it; a workspace folder above the cwd is still searched", async () => {
	const project = "D:\\Work";
	const inner = { cwd: CWD, roots: [CWD, project] };
	const { resolver: files, asked } = resolver([at("src\\index.ts"), "D:\\Work\\Tools\\index.ts", "D:\\Work\\Web\\index.ts"]);
	assert.deepEqual(await files.resolve(file("index.ts:4"), inner), { status: "found", target: "src/index.ts:4" });
	assert.deepEqual(asked[0]!.folders, [CWD, project], "every workspace folder is searched, the one inside another too; a file both find is one match");
	const outside = resolver(["D:\\Work\\Tools\\index.ts"]);
	assert.deepEqual(await outside.resolver.resolve(file("index.ts"), inner), { status: "found", target: "D:\\Work\\Tools\\index.ts" }, "outside the cwd the target is absolute");
	const twoInside = resolver([at("a\\index.ts"), at("b\\index.ts"), "D:\\Work\\Tools\\index.ts"]);
	assert.deepEqual(await twoInside.resolver.resolve(file("index.ts"), inner), { status: "ambiguous", definitions: 3, files: true });
});

test("a file outside the session's folders, or a non-file location, never counts", async () => {
	const { resolver: files } = resolver(["D:\\Work\\Elsewhere\\Loader.cs", at("Loader.cs.bak"), "D:\\Work\\GameExtra\\Loader.cs"]);
	assert.deepEqual(await files.resolve(file("Loader.cs"), scope), { status: "none" }, "a source that returns more than asked, a sibling folder with a longer name, a different file name");
	const stray = new FileNameLinkResolver({ find: async () => ({ paths: ["D:\\Work\\Elsewhere\\Loader.cs", at("Loader.cs"), "vscode-remote://x/Loader.cs"], truncated: false }) }, { isFile: async () => false });
	assert.deepEqual(await stray.resolve(file("Loader.cs"), scope), { status: "found", target: "Loader.cs" });
	assert.deepEqual(await new FileNameLinkResolver(search([]).source).resolve(file("Loader.cs"), { cwd: "", roots: [] }), { status: "none" }, "no session folder, no search");
});

test("Windows rules: names and paths compare case-insensitively, and the same file reported twice is one", async () => {
	const { resolver: files } = resolver([at("Assets\\session-index.ts")]);
	assert.deepEqual(await files.resolve(file("Session-Index.ts:2"), scope), { status: "found", target: "Assets/session-index.ts:2" }, "the model's spelling of the name finds the file");
	const duplicate = new FileNameLinkResolver({ find: async () => ({ paths: [at("Assets\\session-index.ts"), at("assets\\Session-Index.ts")], truncated: false }) }, { isFile: async () => false });
	assert.deepEqual(await duplicate.resolve(file("Session-Index.ts:2"), scope), { status: "found", target: "Assets/session-index.ts:2" });
	assert.deepEqual(fileNameTarget("D:\\work\\GAME\\a\\B.cs", CWD, { line: 3 }), "a/B.cs:3", "containment is case-insensitive");
});

test("a search that stopped at its limit never proves a file unique and never narrows to the cwd", async () => {
	const capped = resolver([at("a\\Index.ts"), "D:\\Work\\Other\\Index.ts"], {}, { truncated: true });
	assert.deepEqual(await capped.resolver.resolve(file("Index.ts"), { cwd: CWD, roots: [CWD, "D:\\Work"] }), { status: "ambiguous", definitions: 2, files: true }, "one inside the cwd, but more may exist");
	const single = resolver([at("a\\Index.ts")], {}, { truncated: true });
	assert.deepEqual(await single.resolver.resolve(file("Index.ts"), scope), { status: "unavailable" });
	const empty = resolver([], {}, { truncated: true });
	assert.deepEqual(await empty.resolver.resolve(file("Index.ts"), scope), { status: "unavailable" }, "an empty capped answer is not a verdict");
});

test("a failed or timed-out search is unavailable and not repeated by the page's retries within its short memory", async () => {
	let now = 0;
	for (const fail of ["throw", "null", "hang"] as const) {
		const { resolver: files, asked } = resolver([at("A.cs")], { now: () => now, queryTimeoutMs: 15, failedTtlMs: 100 }, { fail });
		assert.deepEqual(await files.resolve(file("A.cs"), scope), { status: "unavailable" }, fail);
		assert.deepEqual(await files.resolve(file("A.cs"), scope), { status: "unavailable" });
		assert.equal(asked.length, 1, `${fail}: the retry is answered from the failure memory`);
		now = 200;
		await files.resolve(file("A.cs"), scope);
		assert.equal(asked.length, 2, `${fail}: after the memory expires it searches again`);
		now = 0;
	}
});

test("a cwd check that hangs is bounded like the search: unavailable, remembered for a while, and no search starts", async () => {
	const { source, asked } = search([at("Sub\\A.cs")]);
	let stats = 0;
	const files = new FileNameLinkResolver(source, { isFile: () => { stats++; return Promise.withResolvers<boolean>().promise; }, queryTimeoutMs: 15, failedTtlMs: 1000 });
	assert.deepEqual(await files.resolve(file("A.cs"), scope), { status: "unavailable" });
	assert.deepEqual(await files.resolve(file("A.cs:3"), scope), { status: "unavailable" });
	assert.equal(stats, 1, "the page's retry is answered from the failure memory: no second stat");
	assert.deepEqual(asked, [], "a lookup whose first step did not settle never starts the search");
});

test("at most the configured searches run at once, the slot is held until the search settles, and a full line refuses at once without remembering it", async () => {
	const release: (() => void)[] = [];
	let running = 0;
	let peak = 0;
	const source: FileNameSource = { find: () => {
		const { promise, resolve } = Promise.withResolvers<{ paths: string[]; truncated: boolean }>();
		running++;
		peak = Math.max(peak, running);
		release.push(() => { running--; resolve({ paths: [], truncated: false }); });
		return promise;
	} };
	const files = new FileNameLinkResolver(source, { isFile: async () => false, maxConcurrent: 2, maxWaiting: 1, queryTimeoutMs: 1000 });
	const first = files.lookup("A1.cs", scope);
	const second = files.lookup("A2.cs", scope);
	const third = files.lookup("A3.cs", scope);
	await tick();
	assert.equal(running, 2, "two run, one waits");
	assert.deepEqual(await files.lookup("A4.cs", scope), { state: "unavailable" }, "the line is full: refused at once");
	release.splice(0).forEach(done => done());
	await tick();
	await tick();
	assert.equal(release.length, 1, "settlement hands the slot to the waiting lookup");
	release.splice(0).forEach(done => done());
	await Promise.all([first, second, third]);
	assert.ok(peak <= 2);
	assert.equal((await Promise.all([files.lookup("A4.cs", scope)])).length, 1);
	release.splice(0).forEach(done => done());
});

test("an invalidation drops cached answers; a search that was running and found nothing that still exists is unavailable and not cached", async () => {
	let version = 1;
	const release: (() => void)[] = [];
	const source: FileNameSource = { find: () => {
		const { promise, resolve } = Promise.withResolvers<{ paths: string[]; truncated: boolean }>();
		const answer = version;
		release.push(() => resolve({ paths: answer === 1 ? [at("Old.cs")] : [at("New.cs")], truncated: false }));
		return promise;
	} };
	const files = new FileNameLinkResolver(source, { isFile: async () => false });
	const stale = files.lookup("Loader.cs", scope);
	await tick();
	files.invalidate();
	release.splice(0).forEach(done => done());
	assert.deepEqual(await stale, { state: "unavailable" });
	version = 2;
	const fresh = files.lookup("Loader.cs", scope);
	await tick();
	release.splice(0).forEach(done => done());
	assert.deepEqual(await fresh, { state: "none" }, "the new search ran: its (empty) answer is the answer, nothing stale is reused");
});

test("a search that was running when files changed still answers, with each file it found proven to exist, and caches nothing", async () => {
	const existing = new Set([at("Assets\\Scenes\\session-index.ts"), at("Assets\\Other\\session-index.ts")]);
	let searches = 0;
	const release: (() => void)[] = [];
	const source: FileNameSource = { find: () => {
		searches++;
		const { promise, resolve } = Promise.withResolvers<{ paths: string[]; truncated: boolean }>();
		release.push(() => resolve({ paths: [at("Assets\\Scenes\\session-index.ts"), at("Assets\\Other\\session-index.ts")], truncated: false }));
		return promise;
	} };
	const files = new FileNameLinkResolver(source, { isFile: async candidate => existing.has(candidate) });
	const running = files.lookup("session-index.ts", scope);
	await tick();
	files.invalidate();
	release.splice(0).forEach(done => done());
	assert.deepEqual(await running, { state: "many", paths: [at("Assets\\Other\\session-index.ts"), at("Assets\\Scenes\\session-index.ts")] }, "files changing somewhere else do not discard a finished search");
	const again = files.lookup("session-index.ts", scope);
	await tick();
	assert.equal(searches, 2, "the stale answer was not cached");
	existing.delete(at("Assets\\Other\\session-index.ts"));
	files.invalidate();
	release.splice(0).forEach(done => done());
	assert.deepEqual(await again, { state: "unique", path: at("Assets\\Scenes\\session-index.ts") }, "a file that vanished while the search ran is dropped from the answer");
	existing.clear();
	const gone = files.lookup("session-index.ts", scope);
	await tick();
	files.invalidate();
	release.splice(0).forEach(done => done());
	assert.deepEqual(await gone, { state: "unavailable" }, "nothing left to prove is no verdict: not none, since a file may have appeared meanwhile");
});

test("an invalidation does not drop a lookup that waits for a search slot: it runs after the change and is answered", async () => {
	const release: (() => void)[] = [];
	const asked: string[] = [];
	const source: FileNameSource = { find: name => {
		asked.push(name);
		const { promise, resolve } = Promise.withResolvers<{ paths: string[]; truncated: boolean }>();
		release.push(() => resolve({ paths: [at(`Sub\\${name}`)], truncated: false }));
		return promise;
	} };
	const files = new FileNameLinkResolver(source, { isFile: async () => false, maxConcurrent: 1, queryTimeoutMs: 1000 });
	const first = files.lookup("A.cs", scope);
	const waiting = files.lookup("B.cs", scope);
	await tick();
	files.invalidate();
	release.splice(0).forEach(done => done());
	await tick();
	release.splice(0).forEach(done => done());
	assert.deepEqual(await first, { state: "unavailable" }, "the running search is stale and its file is not there to prove");
	assert.deepEqual(await waiting, { state: "unique", path: at("Sub\\B.cs") }, "the waiting lookup searched after the invalidation: nothing stale in its answer, so nothing to throw away");
	assert.deepEqual(asked, ["A.cs", "B.cs"]);
	assert.equal(files.generation, 1);
});

test("the tail of a path is a lookup: it matches whole directory names at the end of the path, in any case, with either separator", async () => {
	const { resolver: files, asked } = resolver([
		at("omp-vscode\\Assets\\Code\\src\\host\\session-index.ts"),
		at("omp-vscode\\Assets\\Code\\src\\Nohost\\session-index.ts"),
		at("omp-vscode\\Assets\\Code\\src\\host\\Other.cs"),
		at("omp-vscode\\Assets\\Code\\host\\Sub\\session-index.ts"),
	]);
	assert.deepEqual(await files.resolve(file("host/session-index.ts:579"), scope), { status: "found", target: "omp-vscode/Assets/Code/src/host/session-index.ts:579" });
	assert.deepEqual(asked[0], { name: "host/session-index.ts", folders: [CWD] }, "the search is for the path tail, not for the name alone");
	assert.deepEqual(await files.resolve(file("host\\session-index.ts(12,3)"), scope), { status: "found", target: "omp-vscode/Assets/Code/src/host/session-index.ts:12:3" }, "case and separator do not matter");
	assert.deepEqual(await files.lookup("src/host/session-index.ts", scope), { state: "unique", path: at("omp-vscode\\Assets\\Code\\src\\host\\session-index.ts") });
	assert.deepEqual(await files.resolve(file("Cheat/session-index.ts"), scope), { status: "none" }, "half a directory name is not the end of a path");
	assert.deepEqual(await files.resolve(file("host/Missing.cs"), scope), { status: "none" });
});

test("several files ending with the same path are a choice, and the one in the session's folder narrows it, like a bare name", async () => {
	const many = resolver([at("A\\host\\session-index.ts"), at("B\\host\\session-index.ts"), "D:\\Work\\Tools\\host\\session-index.ts"]);
	const wide = { cwd: CWD, roots: [CWD, "D:\\Work"] };
	assert.deepEqual(await many.resolver.resolve(file("host/session-index.ts"), wide), { status: "ambiguous", definitions: 3, files: true });
	assert.deepEqual(await many.resolver.lookup("host/session-index.ts", wide), { state: "many", paths: [at("A\\host\\session-index.ts"), at("B\\host\\session-index.ts"), "D:\\Work\\Tools\\host\\session-index.ts"] });
	const narrowed = resolver([at("A\\host\\session-index.ts"), "D:\\Work\\Tools\\host\\session-index.ts"]);
	assert.deepEqual(await narrowed.resolver.resolve(file("host/session-index.ts"), wide), { status: "found", target: "A/host/session-index.ts" });
});

test("the path tail of a file directly below the session's folder is that file, and no search runs", async () => {
	const own = at("host\\session-index.ts");
	const { source, asked } = search([at("Elsewhere\\host\\session-index.ts")]);
	const files = new FileNameLinkResolver(source, { isFile: async candidate => candidate === own });
	assert.deepEqual(await files.resolve(file("host/session-index.ts:5"), scope), { status: "found", target: "host/session-index.ts:5" });
	assert.deepEqual(asked, []);
});

test("each workspace folder is searched once, a folder inside another too", () => {
	assert.deepEqual(distinctRoots(["D:\\Work\\Game", "D:\\Work", "d:\\work", "E:\\Other"]), ["D:\\Work\\Game", "D:\\Work", "E:\\Other"]);
	assert.deepEqual(distinctRoots(["D:\\Work\\Game"]), ["D:\\Work\\Game"]);
});

test("a file of a project opened next to the repository root that hides it is found, once", async () => {
	// The user's layout: workspace folders `omp-vscode\omp-vscode` (the Unity project) and `omp-vscode` (the repository), whose own files.exclude hides `omp-vscode`.
	const repo = "D:\\Work\\omp-vscode";
	const project = `${repo}\\omp-vscode`;
	const loader = `${project}\\Assets\\session-index.ts`;
	const api: FindFilesApi = {
		workspace: {
			async findFiles(include, exclude) {
				const base = (include as { base: string }).base;
				return base === repo && exclude === "omp-vscode" ? [] : [{ scheme: "file", fsPath: loader }];
			},
			getConfiguration: (section, scope) => ({ get: <T>(key: string) => (section === "files" && key === "exclude" && (scope as { path: string }).path === repo ? { omp-vscode: true } : undefined) as T | undefined }),
		},
		RelativePattern: class { base: string; pattern: string; constructor(base: string, pattern: string) { this.base = base; this.pattern = pattern; } },
		CancellationTokenSource: class { token = {}; cancel() {} dispose() {} },
		Uri: { file: (path: string) => ({ path }) },
	};
	const files = new FileNameLinkResolver(workspaceFileNameSource(api), { isFile: async () => false });
	assert.deepEqual(await files.resolve(file("session-index.ts"), { cwd: repo, roots: [project, repo] }), { status: "found", target: "omp-vscode/Assets/session-index.ts" });
});

test("the search glob is the exact name at any depth, each letter in both cases, with no glob character of its own", () => {
	assert.equal(fileNameGlob("session-index.ts"), "**/[sS][cC][eE][nN][eE][lL][oO][aA][dD][eE][rR].[cC][sS]");
	assert.equal(fileNameGlob("a-b_1.d.ts"), "**/[aA]-[bB]_1.[dD].[tT][sS]");
	assert.equal(fileNameGlob("ß.cs"), "**/ß.[cC][sS]", "a letter whose case form is longer is left alone");
	assert.equal(fileNameGlob("host/session-index.ts"), "**/[cC][hH][eE][aA][tT][sS]/[uU][tT][iI][lL][iI][tT][iI][eE][sS].[cC][sS]", "the directories of a path tail are part of the pattern, so a name that many files carry does not fill the result limit");
});

test("the exclude glob holds every enabled pattern of files.exclude and search.exclude, nothing conditional", () => {
	assert.equal(excludeGlob(undefined, undefined), null);
	assert.equal(excludeGlob({ "**/.git": true }, { "**/node_modules": false }), "**/.git");
	assert.equal(excludeGlob({ "**/.git": true, "**/*.meta": { when: "$(basename).cs" } }, { "**/node_modules": true, "**/.git": true }), "{**/.git,**/node_modules}");
});

test("the VS Code adapter searches each folder with the pattern, the excludes and the limit, keeps file locations, and cancels with the signal", async () => {
	const calls: { include: unknown; exclude: unknown; max: number }[] = [];
	let cancelled = 0;
	let disposed = 0;
	const api: FindFilesApi = {
		workspace: {
			async findFiles(include, exclude, max) { calls.push({ include, exclude, max }); return [{ scheme: "file", fsPath: at("a\\A.cs") }, { scheme: "vscode-remote", fsPath: "/x/A.cs" }]; },
			getConfiguration: section => ({ get: <T>(key: string) => (section === "files" && key === "exclude" ? { "**/.git": true } : section === "search" && key === "exclude" ? { "**/node_modules": true } : undefined) as T | undefined }),
		},
		RelativePattern: class { base: string; pattern: string; constructor(base: string, pattern: string) { this.base = base; this.pattern = pattern; } },
		CancellationTokenSource: class { token = {}; cancel() { cancelled++; } dispose() { disposed++; } },
		Uri: { file: (path: string) => ({ path }) },
	};
	const found = await workspaceFileNameSource(api).find("A.cs", ["D:\\Work", "E:\\More"], new AbortController().signal);
	assert.deepEqual(found, { paths: [at("a\\A.cs"), at("a\\A.cs")], truncated: false });
	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map(call => ({ ...(call.include as object) })), [{ base: "D:\\Work", pattern: "**/[aA].[cC][sS]" }, { base: "E:\\More", pattern: "**/[aA].[cC][sS]" }]);
	assert.ok(calls.every(call => call.exclude === "{**/.git,**/node_modules}" && call.max === MAX_FILE_NAME_RESULTS));
	assert.equal(disposed, 1);
	assert.equal(cancelled, 0);
	const controller = new AbortController();
	controller.abort();
	await workspaceFileNameSource(api).find("A.cs", ["D:\\Work"], controller.signal);
	assert.equal(cancelled, 1, "an already aborted signal cancels the search at once");
	const full = { ...api, workspace: { ...api.workspace, findFiles: async () => Array.from({ length: MAX_FILE_NAME_RESULTS }, (_, index) => ({ scheme: "file", fsPath: at(`d${index}\\A.cs`) })) } };
	assert.equal((await workspaceFileNameSource(full).find("A.cs", ["D:\\Work"], new AbortController().signal))?.truncated, true);
});

test("the outcome of a lookup, the picker row of a file and the span grammar", () => {
	assert.deepEqual(fileNameOutcome({ state: "none" }, file("A.cs"), CWD), { status: "none" });
	assert.deepEqual(fileNameOutcome({ state: "unavailable" }, file("A.cs"), CWD), { status: "unavailable" });
	assert.deepEqual(fileChoiceLabel(at("Assets\\Scenes\\session-index.ts"), CWD, [CWD]), { label: "session-index.ts", description: "Assets/Scenes" });
	assert.deepEqual(fileChoiceLabel(at("session-index.ts"), CWD, [CWD]), { label: "session-index.ts", description: "." });
	assert.deepEqual(fileChoiceLabel("D:\\Work\\Tools\\a.cs", CWD, [CWD, "D:\\Work"]), { label: "a.cs", description: "Tools" }, "relative to the workspace folder that holds it");
	assert.deepEqual(fileChoiceLabel("E:\\Else\\a.cs", CWD, [CWD]), { label: "a.cs", description: "E:/Else" }, "absolute when no folder holds it");
});
