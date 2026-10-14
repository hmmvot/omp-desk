/**
 * The artifact lookup of the `omp-artifact:` documents against a real temporary directory: the one accepted file name
 * shape, a symlink that leaves the directory, the size cap, and a session file that is not an OMP transcript.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	ARTIFACT_SCHEME,
	MAX_ARTIFACT_BYTES,
	artifactDocumentText,
	artifactNotice,
	artifactTool,
	artifactUriParts,
	findArtifact,
	parseArtifactUri,
	readArtifact,
} from "./artifact-lookup.ts";

const HEADER = `${JSON.stringify({ type: "session", version: 3, id: "S-1", timestamp: "2026-10-14T10:00:00.000Z", cwd: "C:\\work" })}\n`;

let root = "";
let session = "";
let artifacts = "";

before(async () => {
	root = await mkdtemp(path.join(tmpdir(), "omp-artifact-"));
	session = path.join(root, "2026-10-14T10-00-00_S-1.jsonl");
	artifacts = path.join(root, "2026-10-14T10-00-00_S-1");
	await mkdir(artifacts);
	await writeFile(session, HEADER);
	await writeFile(path.join(artifacts, "12.bash.log"), "line one\nline two\n");
	await writeFile(path.join(artifacts, "3.read.txt"), "three");
	await writeFile(path.join(artifacts, "notes.txt"), "not an artifact");
	await writeFile(path.join(artifacts, "12x.bash.log"), "wrong shape");
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("artifact URIs", () => {
	it("round-trips the id and the session file, and refuses any other scheme, path or query", () => {
		const parts = artifactUriParts("12", session);
		assert.deepEqual(parseArtifactUri({ scheme: ARTIFACT_SCHEME, ...parts }), { artifactId: "12", sessionFile: session });
		assert.equal(parseArtifactUri({ scheme: "file", ...parts }), null);
		assert.equal(parseArtifactUri({ scheme: ARTIFACT_SCHEME, path: "/12/../x", query: parts.query }), null);
		assert.equal(parseArtifactUri({ scheme: ARTIFACT_SCHEME, path: "/1234567890", query: parts.query }), null);
		assert.equal(parseArtifactUri({ scheme: ARTIFACT_SCHEME, path: "/12", query: "session=a&x=b" }), null);
		assert.equal(parseArtifactUri({ scheme: ARTIFACT_SCHEME, path: "/12", query: "session=%E0%A4%A" }), null);
	});

	it("titles the tab by the last path segment with the tool and the id, and still resolves an old bare-id address", () => {
		const parts = artifactUriParts("12", session, artifactTool("12.bash.log"));
		assert.equal(parts.path.split("/").pop(), "Full output · bash · artifact 12");
		assert.deepEqual(parseArtifactUri({ scheme: ARTIFACT_SCHEME, ...parts }), { artifactId: "12", sessionFile: session });
		assert.deepEqual(parseArtifactUri({ scheme: ARTIFACT_SCHEME, path: "/12", query: parts.query }), { artifactId: "12", sessionFile: session });
		assert.equal(artifactTool("notes.txt"), null);
	});
});

describe("findArtifact and readArtifact", () => {
	it("finds an artifact by its id whatever its type and extension, and reads its text", async () => {
		const found = await findArtifact(session, "12");
		assert.equal(found.status, "found");
		assert.equal(found.status === "found" && found.artifact.name, "12.bash.log");
		const read = await readArtifact(session, "3");
		assert.deepEqual(read, { status: "text", name: "3.read.txt", text: "three" });
		assert.equal(await artifactDocumentText({ scheme: ARTIFACT_SCHEME, ...artifactUriParts("12", session) }), "line one\nline two\n");
	});

	it("refuses an id that is not digits, a name of another shape and an id with no file, each with a sentence", async () => {
		for (const id of ["../12", "12x", "", "1234567890", "12.bash.log"]) assert.equal((await findArtifact(session, id)).status, "refused", id);
		const missing = await findArtifact(session, "99");
		assert.equal(missing.status, "refused");
		assert.match(missing.status === "refused" ? missing.reason : "", /Artifact 99 is not in this session/);
	});

	it("refuses a session file that is not an absolute .jsonl transcript with an OMP header, or is gone", async () => {
		assert.equal((await findArtifact("12.bash.log", "12")).status, "refused");
		assert.equal((await findArtifact(path.join(artifacts, "12.bash.log"), "12")).status, "refused");
		const notSession = path.join(root, "other.jsonl");
		await mkdir(path.join(root, "other"));
		await writeFile(path.join(root, "other", "5.bash.log"), "x");
		await writeFile(notSession, `${JSON.stringify({ type: "message", id: "x" })}\n`);
		const bad = await findArtifact(notSession, "5");
		assert.equal(bad.status, "refused");
		await writeFile(notSession, "not json at all\n");
		assert.equal((await findArtifact(notSession, "5")).status, "refused");
		assert.match((await findArtifact(path.join(root, "gone.jsonl"), "5") as { reason: string }).reason, /gone/);
		assert.equal((await findArtifact(path.join(root, ".jsonl"), "5")).status, "refused");
	});

	it("does not follow a symlink out of the artifacts directory", async t => {
		const outside = path.join(root, "outside.txt");
		await writeFile(outside, "secret");
		try {
			await symlink(outside, path.join(artifacts, "40.bash.log"));
		} catch {
			t.skip("this account cannot create symlinks");
			return;
		}
		const found = await findArtifact(session, "40");
		assert.equal(found.status, "refused");
		assert.equal((await readArtifact(session, "40")).status, "refused");
	});

	it("names a file over the size cap instead of reading it", async () => {
		const big = path.join(artifacts, "77.bash.log");
		await writeFile(big, Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x61));
		const read = await readArtifact(session, "77");
		assert.equal(read.status, "too-large");
		const notice = artifactNotice("77", read as Exclude<typeof read, { status: "text" }>);
		assert.match(notice, /Artifact 77 \(77\.bash\.log\) is 16\.0 MiB, more than the 16 MiB/);
		assert.match(await artifactDocumentText({ scheme: ARTIFACT_SCHEME, ...artifactUriParts("77", session) }), /more than the 16 MiB/);
	});

	it("answers a document of a foreign address with a sentence, never an empty text or a throw", async () => {
		assert.match(await artifactDocumentText({ scheme: ARTIFACT_SCHEME, path: "/x", query: "" }), /not an OMP artifact address/);
		assert.match(await artifactDocumentText({ scheme: ARTIFACT_SCHEME, ...artifactUriParts("12", path.join(root, "nope.jsonl")) }), /gone/);
	});
});
