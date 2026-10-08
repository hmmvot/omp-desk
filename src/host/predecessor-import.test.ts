/**
 * The one-time import of the predecessor build's registered folders.
 *
 * Exercised against real catalog files in a temporary profile layout
 * (`<profile>/globalStorage/<extension id>/catalog/v1/catalog.json`):
 *
 * - only the folder list moves; session rows and every other record stay behind;
 * - the predecessor's files are never written;
 * - the ledger makes the import happen once, so a folder removed afterwards stays removed;
 * - a folder this catalog already holds keeps its own record;
 * - an absent predecessor records nothing, and an unreadable one is retried later.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { WORKSPACE_FOLDERS_STORAGE_KEY, mergeWorkspaceFolderRecords } from "../views/workspace-folders.ts";
import {
	PREDECESSOR_EXTENSION_ID,
	PREDECESSOR_IMPORT_SOURCE,
	importPredecessorFolders,
	predecessorStorageDir,
} from "./predecessor-import.ts";
import { CATALOG_VERSION, catalogPaths, createCatalogStore } from "./profile-catalog.ts";
import type { CatalogStore } from "./profile-catalog.ts";

const roots: string[] = [];

after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

interface Profile {
	readonly storageDir: string;
	readonly oldDir: string;
}

async function tempProfile(): Promise<Profile> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-predecessor-"));
	roots.push(root);
	const storageDir = path.join(root, "globalStorage", "publisher.current-extension");
	await mkdir(storageDir, { recursive: true });
	return { storageDir, oldDir: path.join(root, "globalStorage", PREDECESSOR_EXTENSION_ID) };
}

function openStore(storageDir: string): CatalogStore {
	return createCatalogStore({
		paths: catalogPaths(storageDir),
		mergers: { [WORKSPACE_FOLDERS_STORAGE_KEY]: mergeWorkspaceFolderRecords },
	});
}

function folderRecord(...folders: readonly { id: string; path: string; collapsed?: boolean }[]): unknown {
	return { version: 1, folders: folders.map(folder => ({ collapsed: false, ...folder })) };
}

async function writePredecessorCatalog(oldDir: string, records: Record<string, unknown>): Promise<string> {
	const document = catalogPaths(oldDir).document;
	await mkdir(path.dirname(document), { recursive: true });
	await writeFile(document, JSON.stringify({ version: CATALOG_VERSION, revision: 7, records, imports: [], conflicts: [] }));
	return document;
}

function foldersOf(store: CatalogStore): readonly { id: string; path: string }[] {
	const record = store.get(WORKSPACE_FOLDERS_STORAGE_KEY) as { folders?: { id: string; path: string }[] } | undefined;
	return record?.folders ?? [];
}

const logs: string[] = [];
const log = (message: string): void => {
	logs.push(message);
};

describe("predecessorStorageDir", () => {
	it("is the sibling of this extension's global storage named after the old id", () => {
		const dir = path.join("C:\\", "profile", "globalStorage", "hmmvot.omp-desk");
		assert.equal(predecessorStorageDir(dir), path.join("C:\\", "profile", "globalStorage", PREDECESSOR_EXTENSION_ID));
	});
});

describe("importPredecessorFolders", () => {
	it("imports the folder list, leaves every other record and the predecessor's file alone, and writes a ledger entry", async () => {
		const { storageDir, oldDir } = await tempProfile();
		const file = await writePredecessorCatalog(oldDir, {
			[WORKSPACE_FOLDERS_STORAGE_KEY]: folderRecord(
				{ id: "folder:a", path: "C:\\work\\alpha" },
				{ id: "folder:b", path: "C:\\work\\beta", collapsed: true },
			),
			"omp.sessionIndex.v1": { version: 1, nextOrdinal: 2, entries: [{ tabId: "tab:1" }], bindings: [] },
			"omp.brokerSlots.v1": { byEditor: { e: "slot" }, byConversation: {} },
		});
		const before = await readFile(file, "utf8");
		const store = openStore(storageDir);

		const report = await importPredecessorFolders({ store, storageDir, log });

		assert.deepEqual(report, { status: "imported", folders: 2, detail: null });
		assert.deepEqual(foldersOf(store).map(folder => folder.path), ["C:\\work\\alpha", "C:\\work\\beta"]);
		assert.equal(store.get("omp.sessionIndex.v1"), undefined, "session rows are not imported");
		assert.equal(store.get("omp.brokerSlots.v1"), undefined, "broker slots are not imported");
		const ledger = store.imports();
		assert.equal(ledger.length, 1);
		assert.equal(ledger[0]?.source, PREDECESSOR_IMPORT_SOURCE);
		assert.equal(ledger[0]?.outcome, "imported");
		assert.deepEqual(ledger[0]?.keys, [WORKSPACE_FOLDERS_STORAGE_KEY]);
		assert.equal(await readFile(file, "utf8"), before, "the predecessor's catalog is never written");
		assert.ok(logs.some(line => line.includes("2 folder(s) were imported")));
	});

	it("happens once: a folder removed afterwards is not brought back, even by another window", async () => {
		const { storageDir, oldDir } = await tempProfile();
		await writePredecessorCatalog(oldDir, {
			[WORKSPACE_FOLDERS_STORAGE_KEY]: folderRecord({ id: "folder:a", path: "C:\\work\\alpha" }, { id: "folder:b", path: "C:\\work\\beta" }),
		});
		const first = openStore(storageDir);
		await importPredecessorFolders({ store: first, storageDir, log });
		await first.transactRecords([
			{ key: WORKSPACE_FOLDERS_STORAGE_KEY, base: first.get(WORKSPACE_FOLDERS_STORAGE_KEY), desired: folderRecord({ id: "folder:b", path: "C:\\work\\beta" }) },
		]);
		assert.deepEqual(foldersOf(first).map(folder => folder.id), ["folder:b"]);

		const second = openStore(storageDir);
		const report = await importPredecessorFolders({ store: second, storageDir, log });

		assert.deepEqual(report, { status: "already-imported", folders: 0, detail: null });
		assert.deepEqual(foldersOf(second).map(folder => folder.id), ["folder:b"]);
	});

	it("is additive: a folder this catalog already lists keeps its own record and the disagreement is retained", async () => {
		const { storageDir, oldDir } = await tempProfile();
		await writePredecessorCatalog(oldDir, {
			[WORKSPACE_FOLDERS_STORAGE_KEY]: folderRecord({ id: "folder:old", path: "C:\\work\\alpha" }, { id: "folder:new-only", path: "C:\\work\\gamma" }),
		});
		const store = openStore(storageDir);
		await store.transactRecords([
			{ key: WORKSPACE_FOLDERS_STORAGE_KEY, base: undefined, desired: folderRecord({ id: "folder:mine", path: "C:\\work\\alpha", collapsed: true }) },
		]);

		const report = await importPredecessorFolders({ store, storageDir, log });

		assert.equal(report.status, "imported");
		assert.equal(report.folders, 1);
		assert.deepEqual(foldersOf(store).map(folder => folder.id), ["folder:mine", "folder:new-only"]);
		assert.equal(store.conflicts().length, 1);
		assert.equal(store.conflicts()[0]?.identity, "folder:old");
	});

	it("records nothing when the predecessor has no catalog, so a later import is still possible", async () => {
		const { storageDir, oldDir } = await tempProfile();
		const store = openStore(storageDir);

		assert.deepEqual(await importPredecessorFolders({ store, storageDir, log }), { status: "absent", folders: 0, detail: null });
		assert.equal(store.imports().length, 0);

		await writePredecessorCatalog(oldDir, { [WORKSPACE_FOLDERS_STORAGE_KEY]: folderRecord({ id: "folder:a", path: "C:\\work\\alpha" }) });
		const report = await importPredecessorFolders({ store, storageDir, log });
		assert.equal(report.status, "imported");
		assert.equal(foldersOf(store).length, 1);
	});

	it("reports an unreadable predecessor catalog, changes nothing and retries on the next run", async () => {
		const { storageDir, oldDir } = await tempProfile();
		const file = catalogPaths(oldDir).document;
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, "{ not json");
		const store = openStore(storageDir);

		const failed = await importPredecessorFolders({ store, storageDir, log });

		assert.equal(failed.status, "failed");
		assert.match(failed.detail ?? "", /not valid JSON/);
		assert.equal(store.imports().length, 0, "a failed read is not a decision");
		assert.equal(await readFile(file, "utf8"), "{ not json");

		await writePredecessorCatalog(oldDir, { [WORKSPACE_FOLDERS_STORAGE_KEY]: folderRecord({ id: "folder:a", path: "C:\\work\\alpha" }) });
		assert.equal((await importPredecessorFolders({ store, storageDir, log })).status, "imported");
	});

	it("marks a predecessor without a folder list as imported so it is not read again", async () => {
		const { storageDir, oldDir } = await tempProfile();
		await writePredecessorCatalog(oldDir, { "omp.sessionIndex.v1": { version: 1, nextOrdinal: 0, entries: [], bindings: [] } });
		const store = openStore(storageDir);

		const report = await importPredecessorFolders({ store, storageDir, log });

		assert.deepEqual(report, { status: "imported", folders: 0, detail: null });
		assert.equal(store.imports()[0]?.outcome, "empty");
		assert.equal(store.imports()[0]?.keys.length, 0);
	});
});
