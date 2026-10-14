import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { realpath } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { onDiskFolder } from "./folder-display.ts";

let root = "";

before(async () => {
	root = await promisify(realpath.native)(await mkdtemp(path.join(tmpdir(), "omp-display-")));
	await mkdir(path.join(root, "Game"));
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("onDiskFolder", () => {
	it("gives a case-folded Windows path the case the folder has on disk", { skip: process.platform !== "win32" }, async () => {
		assert.equal(await onDiskFolder(path.join(root, "Game").toLowerCase()), path.join(root, "Game"));
	});

	it("keeps a folder that is gone as it was given", async () => {
		const gone = path.join(root, "gone");
		assert.equal(await onDiskFolder(gone), gone);
	});
});
