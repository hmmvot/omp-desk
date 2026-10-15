import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { type LoggedLine, recordingLogger } from "../shared/logger.ts";
import { PtyBrokerClient } from "./pty-client.ts";
import { PTY_TREE_DIGEST_FILE, ptyPackagedTreeDigest } from "./pty-runtime.ts";

const roots: string[] = [];

after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function extension(record: string | null): Promise<{ readonly root: string; readonly hashed: string }> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-tree-record-"));
	roots.push(root);
	for (const [name, text] of [
		["out/pty/pty-broker.js", "// entry"],
		["out/pty/pty-owner-watch.ps1", "# owner watch"],
		["out/native/koffi.node", "native"],
	] as const) {
		await mkdir(path.dirname(path.join(root, name)), { recursive: true });
		await writeFile(path.join(root, name), text, "utf8");
	}
	const hashed = await ptyPackagedTreeDigest(root);
	if (record !== null) await writeFile(path.join(root, ...PTY_TREE_DIGEST_FILE.split("/")), JSON.stringify({ format: "omp-runtime-tree/v2", digest: record, files: 3 }), "utf8");
	return { root, hashed };
}

function clientOver(root: string, lines: LoggedLine[]): PtyBrokerClient {
	return new PtyBrokerClient({ storageDir: path.join(root, "storage"), extensionRoot: root, log: recordingLogger(lines), useBuildRecord: true });
}

describe("the broker tree digest an attach compares", { skip: process.platform !== "win32" }, () => {
	const RECORDED = "ab".repeat(32);

	it("is the build's record, taken without hashing the tree", async () => {
		const { root } = await extension(RECORDED);
		const identity = await clientOver(root, []).attachIdentity();
		assert.equal(identity.ready, true);
		assert.equal(identity.treeDigest, RECORDED);
	});

	it("is the hash of the tree when the build recorded none", async () => {
		const { root, hashed } = await extension(null);
		const client = clientOver(root, []);
		assert.equal((await client.attachIdentity()).treeDigest, hashed);
		assert.equal(await client.verifyPackagedTree(), "not-recorded", "nothing recorded, nothing to check");
	});

	it("is checked against the installed tree later: a matching record stays", async () => {
		const { root, hashed } = await extension(null);
		await writeFile(path.join(root, ...PTY_TREE_DIGEST_FILE.split("/")), JSON.stringify({ format: "omp-runtime-tree/v2", digest: hashed, files: 3 }), "utf8");
		const lines: LoggedLine[] = [];
		const client = clientOver(root, lines);
		assert.equal((await client.attachIdentity()).treeDigest, hashed);
		assert.equal(await client.verifyPackagedTree(), "verified");
		assert.deepEqual(lines, []);
	});

	it("is replaced by the hash, with a warning, when the record does not describe the installed tree", async () => {
		const { root, hashed } = await extension(RECORDED);
		const lines: LoggedLine[] = [];
		const client = clientOver(root, lines);
		assert.equal((await client.attachIdentity()).treeDigest, RECORDED);
		assert.equal(await client.verifyPackagedTree(), "corrected");
		assert.equal((await client.attachIdentity()).treeDigest, hashed, "every later attach compares against the hash");
		assert.equal(lines.length, 1);
		assert.equal(lines[0]?.level, "warn");
		assert.match(lines[0]?.message ?? "", /installed broker tree hashes to .* not to the .* the build recorded/);
		assert.equal(await client.verifyPackagedTree(), "not-recorded", "a corrected identity is not checked twice");
	});

	it("is not taken from a record unless the host says it is a packaged install: the tree is hashed", async () => {
		const { root, hashed } = await extension(RECORDED);
		for (const options of [{}, { useBuildRecord: false }]) {
			const client = new PtyBrokerClient({ storageDir: path.join(root, "storage"), extensionRoot: root, ...options });
			assert.equal((await client.attachIdentity()).treeDigest, hashed, "the record is not read");
			assert.equal(await client.verifyPackagedTree(), "not-recorded");
		}
	});

	it("stays unchecked, with a warning, when the installed tree cannot be hashed", async () => {
		const { root } = await extension(RECORDED);
		const lines: LoggedLine[] = [];
		const client = clientOver(root, lines);
		assert.equal((await client.attachIdentity()).treeDigest, RECORDED);
		await rm(path.join(root, "out", "pty"), { recursive: true, force: true });
		assert.equal(await client.verifyPackagedTree(), "unchecked");
		assert.match(lines[0]?.message ?? "", /could not be hashed to check the build's record/);
		assert.equal((await client.attachIdentity()).treeDigest, RECORDED, "the record stays in use as it was");
	});
});
