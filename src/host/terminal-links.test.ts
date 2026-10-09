import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { existingTerminalFile, handleTerminalLink, openTerminalFile, openWebLink, resolveTerminalFileReference } from "./terminal-links.ts";
import type { TerminalFileLocation, TerminalFileOpenApi, WebLinkOpenApi } from "./terminal-links.ts";
import { parseGuestHostMessage, parseGuestWebviewMessage } from "../webview/messages.ts";

 test("relative, Windows absolute and real OMP vscode links resolve with positions", () => {
	assert.deepEqual(resolveTerminalFileReference("src/file.ts:23:7", "D:\\repo"), { path: "D:\\repo\\src\\file.ts", line: 23, column: 7 });
	assert.deepEqual(resolveTerminalFileReference("file.ts:23", "D:\\repo"), { path: "D:\\repo\\file.ts", line: 23, column: 1 });
	assert.deepEqual(resolveTerminalFileReference("C:\\other\\file.ts:2:3", "D:\\repo"), { path: "C:\\other\\file.ts", line: 2, column: 3 });
	assert.deepEqual(resolveTerminalFileReference("vscode://file/D:/other/a%20b.ts:21:4", "D:\\repo"), { path: "D:\\other\\a b.ts", line: 21, column: 4 });
	for (const target of ["vscode://command/workbench.open", "vscode://file", "command:run", "https://example.test/a", "file://remote/share/file", "C:relative.ts", "\\\\server\\share\\file.ts", "x.ts:0", "vscode://file/D:/x%00.ts"]) {
		assert.equal(resolveTerminalFileReference(target, "D:\\repo"), null, target);
	}
});

test("Chat reference forms resolve against the session cwd: ranges, #L fragments, :L selectors and file URLs", () => {
	const cwd = "D:\\repo";
	const at = (target: string, line: number, column = 1) => assert.deepEqual(resolveTerminalFileReference(target, cwd), { path: "D:\\repo\\src\\a.ts", line, column }, target);
	at("src/a.ts", 1);
	at("./src/a.ts:12", 12);
	at("src/a.ts:12-30", 12);
	at("src/a.ts:12:4-14", 12, 4);
	at("src/a.ts:L12-L30", 12);
	at("src/a.ts#L12", 12);
	at("src/a.ts#L12-34", 12);
	at("src/a.ts#L12C5", 12, 5);
	at("D:\\repo\\src\\a.ts:7", 7);
	at("D:/repo/src/a.ts#L9-11", 9);
	at("file:///D:/repo/src/a.ts", 1);
	at("file:///D:/repo/src/a.ts#L12-34", 12);
	at("file:///D:/repo/src/a.ts#L12C3", 12, 3);
	for (const refused of ["src/a.ts:0", "src/a.ts#L0", "https://example.test/a.ts#L1", "command:run#L1", "file://remote/share/a.ts#L1"]) assert.equal(resolveTerminalFileReference(refused, cwd), null, refused);
});

test("a relative reference resolves against the cwd it is asked with and a missing or directory target is refused", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "omp-chat-links-"));
	try {
		await mkdir(join(cwd, "src"));
		await writeFile(join(cwd, "src", "a.ts"), "one\ntwo\n");
		assert.deepEqual(await existingTerminalFile("src/a.ts#L2", cwd), { path: join(cwd, "src", "a.ts"), line: 2, column: 1, folder: false });
		assert.deepEqual(await existingTerminalFile("@src/a.ts", cwd), null, "a mention marker is never part of a path");
		assert.equal(await existingTerminalFile("src/absent.ts:3", cwd), null);
		assert.equal(await existingTerminalFile("src", cwd), null);
		assert.equal(await existingTerminalFile("src/a.ts", join(cwd, "src")), null, "the same text names nothing under another cwd");
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

 test("host validates regular local files and opens exact line/column; never missing paths or directories", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "omp-links-"));
	try {
		await writeFile(join(cwd, "a b.ts"), "first\nsecond\nthird\n");
		await mkdir(join(cwd, "dir"));
		assert.deepEqual(await existingTerminalFile("a b.ts:2:3", cwd), { path: join(cwd, "a b.ts"), line: 2, column: 3, folder: false });
		assert.equal(await existingTerminalFile("absent.ts", cwd), null);
		assert.equal(await existingTerminalFile("dir", cwd), null);
		assert.equal((await existingTerminalFile(pathToFileURL(join(cwd, "a b.ts")).href, cwd))?.path, join(cwd, "a b.ts"));
		const opened: TerminalFileLocation[] = [];
		const urls: string[] = [];
		const replies: unknown[] = [];
		let current = true;
		const warnings: string[] = [];
		const host = { cwd, isCurrent: () => current, reply: (message: unknown) => { replies.push(message); }, openFile: async (location: TerminalFileLocation) => { opened.push(location); }, revealInExplorer: async () => { throw new Error("a terminal link never reveals"); }, revealInOs: async () => { throw new Error("a terminal link never reveals"); }, openUrl: async (url: string) => { urls.push(url); }, warn: (message: string) => { warnings.push(message); } };
		await handleTerminalLink({ type: "omp:terminal-link-validate", requestId: 7, target: "a b.ts:2:3" }, host);
		assert.deepEqual(replies, [{ type: "omp:terminal-link-validation", requestId: 7, valid: true }]);
		await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 8, target: "a b.ts:2:3" }, host);
		assert.deepEqual(opened, [{ path: join(cwd, "a b.ts"), line: 2, column: 3, folder: false }]);
		for (const target of ["absent.ts", "dir", "command:run", "vscode://command/run", "javascript:alert(1)"]) await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 9, target }, host);
		assert.equal(opened.length, 1); assert.deepEqual(urls, []);
		assert.equal(warnings.length, 5, "every refused activation tells the user instead of failing silently");
		assert.match(warnings[0]!, /absent\.ts/);
		await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 10, target: "https://example.test/path" }, host);
		assert.deepEqual(urls, ["https://example.test/path"]);
		current = false;
		await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 11, target: "a b.ts" }, host);
		assert.equal(opened.length, 1); assert.equal(warnings.length, 5, "a replaced document is stale, not a user-visible failure");
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a failed open surfaces a short warning with the cause", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "omp-links-"));
	try {
		await writeFile(join(cwd, "image.png"), "x");
		const warnings: string[] = [];
		const host = { cwd, isCurrent: () => true, reply() {}, openUrl: async () => {}, warn: (message: string) => { warnings.push(message); }, revealInExplorer: async () => true, revealInOs: async () => {},
			openFile: async () => { throw new Error("cannot display"); } };
		await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 1, target: "image.png" }, host);
		assert.deepEqual(warnings, [`cannot open ${join(cwd, "image.png")}: cannot display`]);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a Chat link opens a file, only reveals it or its folder in the Explorer on Ctrl+Click, and shows it in File Explorer on Ctrl+Shift+Click", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "omp-links-"));
	try {
		await writeFile(join(cwd, "a.ts"), "x");
		await mkdir(join(cwd, "dir"));
		const calls: string[] = [];
		const replies: unknown[] = [];
		const warnings: string[] = [];
		let inWorkspace = true;
		const host = { cwd, isCurrent: () => true, reply: (message: unknown) => { replies.push(message); }, openUrl: async () => {}, warn: (message: string) => { warnings.push(message); },
			openFile: async (location: TerminalFileLocation) => { calls.push(`open ${location.path}`); },
			revealInExplorer: async (path: string) => { calls.push(`explorer ${path}`); return inWorkspace; },
			revealInOs: async (path: string) => { calls.push(`os ${path}`); } };
		await handleTerminalLink({ type: "omp:terminal-link-validate", requestId: 1, target: "dir" }, host);
		await handleTerminalLink({ type: "omp:terminal-link-validate", requestId: 2, target: "dir", folders: true }, host);
		assert.deepEqual(replies, [
			{ type: "omp:terminal-link-validation", requestId: 1, valid: false },
			{ type: "omp:terminal-link-validation", requestId: 2, valid: true },
		], "only a Chat request accepts a folder");
		const file = join(cwd, "a.ts"), dir = join(cwd, "dir");
		await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 3, target: "a.ts", folders: true }, host);
		await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 4, target: "a.ts", folders: true, action: "reveal" }, host);
		await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 5, target: "a.ts", folders: true, action: "os" }, host);
		await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 6, target: "dir", folders: true }, host);
		await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 7, target: "dir", folders: true, action: "os" }, host);
		assert.deepEqual(calls, [`open ${file}`, `explorer ${file}`, `os ${file}`, `explorer ${dir}`, `os ${dir}`]);
		assert.deepEqual(warnings, []);
		inWorkspace = false;
		await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 8, target: "a.ts", folders: true, action: "reveal" }, host);
		assert.deepEqual(calls.slice(-1), [`explorer ${file}`], "Ctrl+Click opens nothing, even when the Explorer cannot show the file");
		assert.match(warnings[0]!, /not in a folder open in this window.*Ctrl\+Shift\+Click/);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Windows backslash, forward slash, drive-case, spaced and home-relative paths resolve to the same files", () => {
	const png = "D:\\work\\repo\\docs\\img\\icon-options.png";
	const expected = { path: png, line: 1, column: 1 };
	for (const target of [png, "D:/work/repo/docs/img/icon-options.png", "docs/img/icon-options.png", "docs\\img\\icon-options.png", "./docs/img/../img/icon-options.png"]) {
		assert.deepEqual(resolveTerminalFileReference(target, "D:\\work\\repo"), expected, target);
	}
	assert.deepEqual(resolveTerminalFileReference("d:\\work\\repo\\a.ts:5:2", "D:\\work\\repo"), { path: "d:\\work\\repo\\a.ts", line: 5, column: 2 }, "drive-letter case is preserved; the filesystem and Uri normalise it");
	assert.deepEqual(resolveTerminalFileReference("D:\\My Documents\\a b.png", "C:\\other"), { path: "D:\\My Documents\\a b.png", line: 1, column: 1 });
	assert.deepEqual(resolveTerminalFileReference("~/notes/a.md:3", "D:\\repo", "C:\\Users\\me"), { path: "C:\\Users\\me\\notes\\a.md", line: 3, column: 1 });
	assert.deepEqual(resolveTerminalFileReference("~\\notes\\a.md", "D:\\repo", "C:\\Users\\me"), { path: "C:\\Users\\me\\notes\\a.md", line: 1, column: 1 });
	assert.equal(resolveTerminalFileReference("~other/a.md", "D:\\repo", "C:\\Users\\me")?.path, "D:\\repo\\~other\\a.md", "only a bare ~ is home");
});

test("every file opens through vscode.open in a new tab; text keeps its line and column, images get their viewer", async () => {
	const calls: unknown[][] = [];
	class Range {
		readonly startLine: number; readonly startCharacter: number; readonly endLine: number; readonly endCharacter: number;
		constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
			this.startLine = startLine; this.startCharacter = startCharacter; this.endLine = endLine; this.endCharacter = endCharacter;
		}
	}
	const api: TerminalFileOpenApi = { Uri: { file: path => ({ fsPath: path }) }, Range,
		commands: { executeCommand: async (command, ...args) => { calls.push([command, ...args]); } } };
	await openTerminalFile(api, { path: "D:\\repo\\docs\\tmp\\subagent-icon-options.png", line: 1, column: 1 });
	await openTerminalFile(api, { path: "D:\\repo\\src\\a.ts", line: 12, column: 4 });
	assert.deepEqual(calls, [
		["vscode.open", { fsPath: "D:\\repo\\docs\\tmp\\subagent-icon-options.png" }, { preview: false, selection: new Range(0, 0, 0, 0) }],
		["vscode.open", { fsPath: "D:\\repo\\src\\a.ts" }, { preview: false, selection: new Range(11, 3, 11, 3) }],
	]);
});

 test("link wire carries complete target and rejects unsafe or injected page cwd", () => {
	assert.deepEqual(parseGuestWebviewMessage({ type: "omp:terminal-link-open", requestId: 3, target: "src/a.ts:14:9" }), { type: "omp:terminal-link-open", requestId: 3, target: "src/a.ts:14:9" });
	assert.equal(parseGuestWebviewMessage({ type: "omp:terminal-link-open", requestId: 3, target: "src/a.ts", cwd: "C:/other" }), null);
	assert.equal(parseGuestWebviewMessage({ type: "omp:terminal-link-open", requestId: 3, target: "a\n.ts" }), null);
	assert.deepEqual(parseGuestHostMessage({ type: "omp:terminal-link-validation", requestId: 3, valid: false }), { type: "omp:terminal-link-validation", requestId: 3, valid: false });
});

test("a web link opens only as a re-validated http(s) URL, in the mode the page asked for, and only for the current document", async () => {
	const urls: [string, string][] = [];
	const warnings: string[] = [];
	let current = true;
	let fail = false;
	const host = { cwd: "D:\\repo", isCurrent: () => current, reply() { throw new Error("an open is never answered"); }, openFile: async () => { throw new Error("a web link is never a file"); }, revealInExplorer: async () => true, revealInOs: async () => {},
		openUrl: async (url: string, mode: string) => { if (fail) throw new Error("command 'simpleBrowser.api.open' not found"); urls.push([url, mode]); }, warn: (message: string) => { warnings.push(message); } };
	await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 1, target: "https://example.com", mode: "editor" }, host);
	await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 2, target: "http://example.com/a b?q=1#x", mode: "external" }, host);
	await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 3, target: "HTTPS://Example.com/x" }, host);
	assert.deepEqual(urls, [["https://example.com/", "editor"], ["http://example.com/a%20b?q=1#x", "external"], ["https://example.com/x", "editor"]], "normalized, with an absent mode meaning the editor");
	await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 4, target: "https://", mode: "editor" }, host);
	await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 5, target: "http:example.com", mode: "external" }, host);
	for (const target of ["javascript:alert(1)", "data:text/html,<b>x</b>", "command:workbench.action.reloadWindow", "mailto:a@b.test", "vscode://command/x"]) {
		await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 6, target, mode: "external" }, host);
	}
	assert.equal(urls.length, 3, "nothing else is handed to a browser");
	assert.equal(warnings.length, 7);
	assert.match(warnings[0]!, /not a valid web address/);
	fail = true;
	await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 7, target: "https://example.com" }, host);
	assert.match(warnings.at(-1)!, /^cannot open https:\/\/example\.com\/: command 'simpleBrowser\.api\.open' not found$/);
	fail = false; current = false;
	await handleTerminalLink({ type: "omp:terminal-link-open", requestId: 8, target: "https://example.com", mode: "editor" }, host);
	assert.equal(urls.length, 3, "a replaced document opens nothing");
	assert.equal(warnings.length, 8);
});

test("the editor mode opens the Simple Browser API command and the external mode the default browser", async () => {
	const calls: unknown[][] = [];
	const api: WebLinkOpenApi<{ parsed: string }> = {
		Uri: { parse: (value, strict) => { assert.equal(strict, true); return { parsed: value }; } },
		commands: { executeCommand: async (command, ...args) => { calls.push([command, ...args]); } },
		env: { openExternal: async target => { calls.push(["openExternal", target]); return true; } },
	};
	await openWebLink(api, "https://example.com/", "editor");
	await openWebLink(api, "https://example.com/", "external");
	assert.deepEqual(calls, [
		["simpleBrowser.api.open", { parsed: "https://example.com/" }, { preserveFocus: false }],
		["openExternal", { parsed: "https://example.com/" }],
	]);
});

test("an open request may name where a web link opens; a validation, an unknown mode or an extra key may not", () => {
	assert.deepEqual(parseGuestWebviewMessage({ type: "omp:terminal-link-open", requestId: 4, target: "https://example.com", mode: "external" }), { type: "omp:terminal-link-open", requestId: 4, target: "https://example.com", mode: "external" });
	assert.deepEqual(parseGuestWebviewMessage({ type: "omp:terminal-link-open", requestId: 4, target: "https://example.com", mode: "editor" }), { type: "omp:terminal-link-open", requestId: 4, target: "https://example.com", mode: "editor" });
	assert.equal(parseGuestWebviewMessage({ type: "omp:terminal-link-open", requestId: 4, target: "https://example.com", mode: "tab" }), null);
	assert.equal(parseGuestWebviewMessage({ type: "omp:terminal-link-validate", requestId: 4, target: "https://example.com", mode: "editor" }), null);
	assert.equal(parseGuestWebviewMessage({ type: "omp:terminal-link-open", requestId: 4, target: "https://example.com", url: "https://other.test" }), null);
});
