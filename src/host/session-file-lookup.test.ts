/**
 * The session files an internal OMP URL names (a subagent's output, a `local://` file) against a real temporary directory:
 * OMP's own layout, nested subagents, paths that try to leave the folder, a symlink that does, and the read-only document text.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { MAX_ARTIFACT_BYTES } from "./artifact-lookup.ts";
import { SESSION_FILE_SCHEME, findSessionFile, parseSessionFileUri, readSessionFile, sessionFileDocumentText, sessionFileUriParts } from "./session-file-lookup.ts";

const HEADER = `${JSON.stringify({ type: "session", version: 3, id: "S-1", timestamp: "2026-10-17T10:00:00.000Z", cwd: "C:\\work" })}\n`;

let root = "";
let session = "";
let other = "";
let artifacts = "";

before(async () => {
	root = await mkdtemp(path.join(tmpdir(), "omp-session-file-"));
	session = path.join(root, "2026-10-17T10-00-00_S-1.jsonl");
	artifacts = path.join(root, "2026-10-17T10-00-00_S-1");
	other = path.join(root, "2026-10-17T11-00-00_S-2.jsonl");
	await mkdir(path.join(artifacts, "Parent", "Parent.Child"), { recursive: true });
	await mkdir(path.join(artifacts, "local", "notes"), { recursive: true });
	await writeFile(session, HEADER);
	await writeFile(other, HEADER);
	await mkdir(path.join(root, "2026-10-17T11-00-00_S-2"));
	await writeFile(path.join(root, "2026-10-17T11-00-00_S-2", "Foreign.md"), "foreign output");
	await writeFile(path.join(artifacts, "UniformFieldsReview.md"), "# Review\nall good\n");
	await writeFile(path.join(artifacts, "UniformFieldsReview.jsonl"), "{}\n");
	await writeFile(path.join(artifacts, "Parent.md"), "parent output");
	await writeFile(path.join(artifacts, "Parent", "Parent.Child.md"), "child output");
	await writeFile(path.join(artifacts, "Parent", "Parent.Child", "Parent.Child.Grand.md"), "grandchild output");
	await writeFile(path.join(artifacts, "local", "plan.md"), "the plan");
	await writeFile(path.join(artifacts, "local", "notes", "a b.md"), "spaced note");
	await writeFile(path.join(artifacts, "local", "blob.bin"), Buffer.from([1, 2, 0, 3]));
	await writeFile(path.join(artifacts, "secret.txt"), "outside local");
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("session file URIs", () => {
	it("round-trips an agent id, a local path and the session file, titled by the last segment", () => {
		const agent = sessionFileUriParts({ kind: "agent", id: "Parent.Child" }, session);
		assert.equal(agent.path, "/agent/Parent.Child.md");
		assert.deepEqual(parseSessionFileUri({ scheme: SESSION_FILE_SCHEME, ...agent }), { ref: { kind: "agent", id: "Parent.Child" }, sessionFile: session });
		const local = sessionFileUriParts({ kind: "local", path: "notes/a b.md" }, session);
		assert.equal(local.path.split("/").pop(), "a b.md");
		assert.deepEqual(parseSessionFileUri({ scheme: SESSION_FILE_SCHEME, ...local }), { ref: { kind: "local", path: "notes/a b.md" }, sessionFile: session });
	});

	it("refuses another scheme, a path of another shape, an id outside the grammar, a segment that leaves the folder and a malformed query", () => {
		const query = sessionFileUriParts({ kind: "agent", id: "X" }, session).query;
		for (const [scheme, uriPath, uriQuery] of [
			["file", "/agent/X.md", query], [SESSION_FILE_SCHEME, "/agent/X", query], [SESSION_FILE_SCHEME, "/agent/../X.md", query], [SESSION_FILE_SCHEME, "/agent/a/b.md", query],
			[SESSION_FILE_SCHEME, "/agent/x y.md", query], [SESSION_FILE_SCHEME, "/local/../x", query], [SESSION_FILE_SCHEME, "/local/a//b", query], [SESSION_FILE_SCHEME, "/local/a\\b", query],
			[SESSION_FILE_SCHEME, "/local/C:/x", query], [SESSION_FILE_SCHEME, "/other/x", query], [SESSION_FILE_SCHEME, "/agent/X.md", "session=a&x=b"], [SESSION_FILE_SCHEME, "/agent/X.md", "session=%E0%A4%A"], [SESSION_FILE_SCHEME, "/agent/X.md", ""],
		] as const) assert.equal(parseSessionFileUri({ scheme, path: uriPath, query: uriQuery }), null, `${scheme} ${uriPath} ${uriQuery}`);
	});
});

describe("finding the files of a session", () => {
	it("finds an agent's published output next to the transcript, and a nested agent's in its parent's folder, one level deeper per generation", async () => {
		const flat = await findSessionFile(session, { kind: "agent", id: "UniformFieldsReview" });
		assert.deepEqual(flat.status === "found" ? [flat.found.file, flat.found.name] : flat, [path.join(artifacts, "UniformFieldsReview.md"), "UniformFieldsReview.md"]);
		const child = await findSessionFile(session, { kind: "agent", id: "Parent.Child" });
		assert.equal(child.status === "found" ? child.found.file : child, path.join(artifacts, "Parent", "Parent.Child.md"));
		const grand = await findSessionFile(session, { kind: "agent", id: "Parent.Child.Grand" });
		assert.equal(grand.status === "found" ? grand.found.file : grand, path.join(artifacts, "Parent", "Parent.Child", "Parent.Child.Grand.md"));
		const parent = await findSessionFile(session, { kind: "agent", id: "Parent" });
		assert.equal(parent.status === "found" ? parent.found.file : parent, path.join(artifacts, "Parent.md"));
	});

	it("is scoped to the session it is asked about: another session's output, a missing id and an id outside the grammar are refused", async () => {
		assert.equal((await findSessionFile(session, { kind: "agent", id: "Foreign" })).status, "refused", "the output of another session is not this one's");
		assert.equal((await findSessionFile(other, { kind: "agent", id: "Foreign" })).status, "found");
		assert.equal((await findSessionFile(session, { kind: "agent", id: "Missing" })).status, "refused");
		assert.equal((await findSessionFile(session, { kind: "agent", id: "../local/plan" })).status, "refused");
		assert.equal((await findSessionFile(session, { kind: "agent", id: "Parent..Child" })).status, "refused");
	});

	it("finds a scratch file only below the local folder and refuses a path that leaves it", async () => {
		const plan = await findSessionFile(session, { kind: "local", path: "plan.md" });
		assert.equal(plan.status === "found" ? plan.found.file : plan, path.join(artifacts, "local", "plan.md"));
		assert.equal((await findSessionFile(session, { kind: "local", path: "notes/a b.md" })).status, "found");
		for (const bad of ["../secret.txt", "notes/../../secret.txt", "..", "", "notes", "missing.md", "a//b", "C:/x", "notes\\a b.md"]) {
			assert.equal((await findSessionFile(session, { kind: "local", path: bad })).status, "refused", bad);
		}
	});

	it("refuses a directory, a session file that is gone, one that is not a transcript and a relative one", async () => {
		assert.equal((await findSessionFile(session, { kind: "local", path: "notes" })).status, "refused");
		assert.equal((await findSessionFile(path.join(root, "nope.jsonl"), { kind: "local", path: "plan.md" })).status, "refused");
		assert.equal((await findSessionFile(path.join(artifacts, "local", "plan.md"), { kind: "local", path: "plan.md" })).status, "refused");
		assert.equal((await findSessionFile("relative.jsonl", { kind: "local", path: "plan.md" })).status, "refused");
	});

	it("does not follow a junction or a symlink out of the folder", async t => {
		await symlink(root, path.join(artifacts, "local", "escape"), "junction");
		assert.equal((await findSessionFile(session, { kind: "local", path: "escape/2026-10-17T10-00-00_S-1.jsonl" })).status, "refused", "a junction that leaves the folder is refused");
		try { await symlink(path.join(artifacts, "secret.txt"), path.join(artifacts, "local", "link.md")); }
		catch { return t.skip("this account cannot create file symlinks"); }
		assert.equal((await findSessionFile(session, { kind: "local", path: "link.md" })).status, "refused", "a symlink is never followed, even to a file in the same session");
	});
});

describe("reading them", () => {
	it("reads text, refuses binary and names a file that is too large", async () => {
		assert.deepEqual(await readSessionFile(session, { kind: "agent", id: "UniformFieldsReview" }), { status: "text", name: "UniformFieldsReview.md", text: "# Review\nall good\n" });
		const binary = await readSessionFile(session, { kind: "local", path: "blob.bin" });
		assert.equal(binary.status, "refused");
		await writeFile(path.join(artifacts, "local", "huge.md"), Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 97));
		const huge = await readSessionFile(session, { kind: "local", path: "huge.md" });
		assert.equal(huge.status, "too-large");
	});

	it("answers a document with the text or one sentence, never an empty text or a throw", async () => {
		assert.equal(await sessionFileDocumentText({ scheme: SESSION_FILE_SCHEME, ...sessionFileUriParts({ kind: "local", path: "plan.md" }, session) }), "the plan");
		assert.match(await sessionFileDocumentText({ scheme: SESSION_FILE_SCHEME, ...sessionFileUriParts({ kind: "agent", id: "Foreign" }, session) }), /not in this session's folder/);
		assert.match(await sessionFileDocumentText({ scheme: SESSION_FILE_SCHEME, path: "/agent/x", query: "" }), /not an OMP session file address/);
		assert.match(await sessionFileDocumentText({ scheme: SESSION_FILE_SCHEME, ...sessionFileUriParts({ kind: "local", path: "huge.md" }, session) }), /more than the 16 MiB/);
		assert.match(await sessionFileDocumentText({ scheme: SESSION_FILE_SCHEME, ...sessionFileUriParts({ kind: "local", path: "plan.md" }, path.join(root, "nope.jsonl")) }), /gone/);
	});
});
