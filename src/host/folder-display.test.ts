import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { realpath } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { displayFolderPath, onDiskFolder, scopePickerFolders } from "./folder-display.ts";

let root = "";

before(async () => {
	root = await promisify(realpath.native)(await mkdtemp(path.join(tmpdir(), "omp-display-")));
	await mkdir(path.join(root, "Omp-Vscode"));
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("onDiskFolder", () => {
	it("gives a case-folded Windows path the case the folder has on disk", { skip: process.platform !== "win32" }, async () => {
		assert.equal(await onDiskFolder(path.join(root, "Omp-Vscode").toLowerCase()), path.join(root, "Omp-Vscode"));
	});

	it("keeps a folder that is gone as it was given", async () => {
		const gone = path.join(root, "gone");
		assert.equal(await onDiskFolder(gone), gone);
	});
});

describe("displayFolderPath", () => {
	it("upper-cases a lower-case Windows drive letter and nothing else", () => {
		assert.equal(displayFolderPath("c:\\Users\\me\\repo"), "C:\\Users\\me\\repo");
		assert.equal(displayFolderPath("d:/work/omp-vscode"), "D:/work/omp-vscode");
		assert.equal(displayFolderPath("c:"), "C:");
		assert.equal(displayFolderPath("C:\\Users\\me"), "C:\\Users\\me");
		assert.equal(displayFolderPath("\\\\host\\share\\x"), "\\\\host\\share\\x");
		assert.equal(displayFolderPath("/home/c:/x"), "/home/c:/x");
		assert.equal(displayFolderPath("cd:\\x"), "cd:\\x");
	});

	it("is what a folder that is gone is shown as, on Windows", { skip: process.platform !== "win32" }, async () => {
		const gone = path.join(root, "gone");
		assert.equal(await onDiskFolder(gone.replace(/^[A-Z]/, letter => letter.toLowerCase())), gone);
	});
});

describe("scopePickerFolders", () => {
	it("spells a listed folder as it is on disk, one entry per directory, the editor's own folder winning a tie", { skip: process.platform !== "win32" }, async () => {
		const folded = path.join(root, "Omp-Vscode").toLowerCase();
		assert.deepEqual(await scopePickerFolders([folded, path.join(root, "gone")], null), [path.join(root, "Omp-Vscode"), path.join(root, "gone")]);
		assert.deepEqual(await scopePickerFolders([folded], path.join(root, "Omp-Vscode")), [path.join(root, "Omp-Vscode")]);
	});

	it("lists the editor's own folder even when the Sessions view does not", async () => {
		const gone = path.join(root, "gone");
		assert.deepEqual(await scopePickerFolders([], gone), [gone]);
		assert.deepEqual(await scopePickerFolders([], null), []);
	});
});
