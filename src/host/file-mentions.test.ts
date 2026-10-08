/**
 * Tests for the host-side `@` completion adapter.
 *
 * These defend the bounds a guest can reach through the panel: a malformed query
 * must never reach the file search, the include pattern must stay a plain
 * workspace "contains" search that a typed `*` cannot widen, and the returned
 * shape must be a bounded, ranked list of workspace paths — never a path that
 * could not resolve against the session working directory, which is what turns a
 * mention into prose on the host.
 *
 * The `findFiles` collaborator is a fake here, exactly as in the extension: this
 * module never needs the `vscode` API to be tested.
 *
 * Runner: `bun test src/host/file-mentions.test.ts` or
 * `node --test src/host/file-mentions.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FILE_COMPLETION_LIMIT, MAX_FILE_QUERY_LENGTH } from "../webview/messages.ts";
import type { FindFilesLike, FileSearchUri } from "./file-mentions.ts";
import { fileMentionInclude, findFileMentions, mentionPath, parseFileQuery, rankFileMentions } from "./file-mentions.ts";

function uris(...paths: string[]): FileSearchUri[] {
	return paths.map(fsPath => ({ fsPath }));
}

/** Records how the search was called, so the bounds are asserted, not assumed. */
function fakeSearch(paths: readonly string[]): { calls: [string, string | undefined, number][]; findFiles: FindFilesLike } {
	const calls: [string, string | undefined, number][] = [];
	return {
		calls,
		findFiles: (include, exclude, maxResults) => {
			calls.push([include, exclude, maxResults]);
			return uris(...paths);
		},
	};
}

describe("parseFileQuery", () => {
	it("trims and keeps an empty query, which is a valid 'list anything' request", () => {
		assert.equal(parseFileQuery("  src/li  "), "src/li");
		assert.equal(parseFileQuery(""), "");
		assert.equal(parseFileQuery("   "), "");
	});

	it("fails closed on anything that is not a bounded, control-free string", () => {
		for (const value of [undefined, null, 7, {}, [], true]) {
			assert.equal(parseFileQuery(value), null, String(value));
		}
		assert.equal(parseFileQuery("a".repeat(MAX_FILE_QUERY_LENGTH + 1)), null);
		assert.equal(parseFileQuery("bad\nname"), null);
		assert.equal(parseFileQuery("bad\u0000name"), null);
	});
});

describe("fileMentionInclude", () => {
	it("builds a contains pattern for the workspace", () => {
		assert.equal(fileMentionInclude(""), "**/*");
		assert.equal(fileMentionInclude("  "), "**/*");
		assert.equal(fileMentionInclude("src/fo"), "**/*src/fo*");
	});

	it("normalizes windows separators", () => {
		assert.equal(fileMentionInclude("src\\fo"), "**/*src/fo*");
	});

	it("strips glob metacharacters so a typed pattern cannot widen the search", () => {
		assert.equal(fileMentionInclude("a*b?c[d]{e}!(f)"), "**/*abcdef*");
		assert.equal(fileMentionInclude("**"), "**/*");
		assert.equal(fileMentionInclude("*"), "**/*");
	});
});

describe("rankFileMentions", () => {
	it("matches case-insensitively and normalizes separators", () => {
		assert.deepEqual(rankFileMentions(["src/App.tsx", "src/app.test.tsx"], "APP"), ["src/App.tsx", "src/app.test.tsx"]);
		assert.deepEqual(rankFileMentions(["src\\App.tsx"], "app"), ["src/App.tsx"]);
	});

	it("ranks basename prefixes above basename matches above path matches", () => {
		const ranked = rankFileMentions(["app/index.ts", "src/myapp.ts", "src/app.ts"], "app");
		assert.deepEqual(ranked, ["src/app.ts", "src/myapp.ts", "app/index.ts"]);
	});

	it("prefers shorter paths inside a bucket and is otherwise lexicographic", () => {
		const ranked = rankFileMentions(["src/app-longer.ts", "src/app.ts", "src/app-b.ts"], "app");
		assert.deepEqual(ranked, ["src/app.ts", "src/app-b.ts", "src/app-longer.ts"]);
	});

	it("deduplicates case-insensitively and drops unusable entries", () => {
		const tooLong = `x/${"a".repeat(600)}.ts`;
		const ranked = rankFileMentions(["src/App.tsx", "SRC/app.tsx", tooLong, "bad\nname.ts", ""], "app");
		assert.deepEqual(ranked, ["src/App.tsx"]);
	});

	it("returns everything for an empty query and bounds the list", () => {
		assert.equal(rankFileMentions(["a.ts", "b.ts"], "").length, 2);
		const many = Array.from({ length: FILE_COMPLETION_LIMIT + 5 }, (_, index) => `file-${index}.ts`);
		assert.equal(rankFileMentions(many, "").length, FILE_COMPLETION_LIMIT);
	});
});

describe("mentionPath", () => {
	it("makes paths inside the session cwd relative with forward slashes", () => {
		assert.equal(mentionPath("D:\\Work\\Repo\\src\\a.ts", "D:\\Work\\Repo"), "src/a.ts");
		assert.equal(mentionPath("/home/me/repo/src/a.ts", "/home/me/repo"), "src/a.ts");
		// A candidate that is the cwd plus a separator has no relative form.
		assert.equal(mentionPath("/home/me/repo/", "/home/me/repo"), "/home/me/repo/");
	});

	it("keeps paths outside the cwd absolute so they still resolve", () => {
		assert.equal(mentionPath("D:\\Other\\b.ts", "D:\\Work\\Repo"), "D:/Other/b.ts");
		assert.equal(mentionPath("/home/me/repo2/a.ts", "/home/me/repo"), "/home/me/repo2/a.ts");
	});

	it("falls back to absolute paths when the cwd is unknown", () => {
		assert.equal(mentionPath("D:\\Work\\Repo\\src\\a.ts", ""), "D:/Work/Repo/src/a.ts");
	});

	it("matches the cwd case-insensitively where the platform does", { skip: process.platform !== "win32" }, () => {
		assert.equal(mentionPath("d:/work/repo/src/a.ts", "D:\\Work\\Repo"), "src/a.ts");
	});
});

describe("findFileMentions", () => {
	it("asks the workspace index with bounded arguments and returns ranked relative paths", async () => {
		const search = fakeSearch(["D:\\Work\\Repo\\src\\app.ts", "D:\\Work\\Repo\\docs\\app.md"]);
		const found = await findFileMentions("app", { cwd: "D:\\Work\\Repo", findFiles: search.findFiles });
		assert.deepEqual(found, ["src/app.ts", "docs/app.md"]);
		assert.deepEqual(search.calls, [["**/*app*", undefined, 200]]);
	});

	it("never searches for a malformed query", async () => {
		const search = fakeSearch(["src/app.ts"]);
		assert.deepEqual(await findFileMentions(undefined, { cwd: "/repo", findFiles: search.findFiles }), []);
		assert.deepEqual(await findFileMentions("a".repeat(MAX_FILE_QUERY_LENGTH + 1), { cwd: "/repo", findFiles: search.findFiles }), []);
		assert.deepEqual(await findFileMentions("bad\nname", { cwd: "/repo", findFiles: search.findFiles }), []);
		assert.deepEqual(search.calls, []);
	});

	it("fails closed when the search itself fails", async () => {
		const findFiles: FindFilesLike = () => {
			throw new Error("search exploded");
		};
		assert.deepEqual(await findFileMentions("app", { cwd: "/repo", findFiles }), []);
	});

	it("ignores entries without a usable path and keeps outside-cwd files absolute", async () => {
		// Simulates a host handing back something that is not a uri at all.
		const malformed = { fsPath: 7 } as unknown as FileSearchUri;
		const findFiles: FindFilesLike = () => [{ fsPath: "/repo/src/app.ts" }, malformed, { fsPath: "/elsewhere/app.ts" }];
		assert.deepEqual(await findFileMentions("app", { cwd: "/repo", findFiles }), ["src/app.ts", "/elsewhere/app.ts"]);
	});
});
