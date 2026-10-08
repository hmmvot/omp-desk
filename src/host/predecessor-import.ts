/**
 * OMP Desk — the one-time import of the folder list a predecessor build registered.
 *
 * Local builds made before the first release were installed under another extension
 * id (`omp-vscode.omp-vscode`). VS Code keys global storage by extension id, so this
 * extension starts with an empty catalog and the user's registered folders would
 * appear to be gone. This module copies exactly that one record — the registered
 * folder list — from the predecessor's catalog into this one, and nothing else.
 *
 * ## Rules
 *
 * - **Folders only.** Session rows, claims, broker slots, shell slots and panel records
 *   describe processes and ownership of the predecessor; importing them would authorize
 *   transports no record of this build proves. Session history lives in OMP's own files
 *   and reappears through each folder's Resume Session.
 * - **Additive and read-only elsewhere.** The predecessor's catalog is read, never
 *   locked, written or deleted. A folder this catalog already holds keeps its record.
 * - **Once.** The commit carries a ledger entry in the same transaction as the folders,
 *   so a folder the user removes afterwards is never resurrected, and an interrupted
 *   import simply runs again.
 * - **Absence and failure are not decisions.** A predecessor with no catalog records
 *   nothing, and an unreadable one is reported and retried on the next activation.
 */
import * as path from "node:path";
import { WORKSPACE_FOLDERS_STORAGE_KEY, unionWorkspaceFolderRecords } from "../views/workspace-folders.ts";
import { catalogDigest, catalogPaths, readCatalogDocument } from "./profile-catalog.ts";
import type { CatalogStore } from "./profile-catalog.ts";

/** The extension id of the builds this one replaces. */
export const PREDECESSOR_EXTENSION_ID = "omp-vscode.omp-vscode";

/** The ledger identity of this import. */
export const PREDECESSOR_IMPORT_SOURCE = `predecessor:${PREDECESSOR_EXTENSION_ID}`;

export interface PredecessorImportDeps {
	/** This window's catalog. */
	readonly store: CatalogStore;
	/** This extension's global storage directory (`globalStorageUri.fsPath`). */
	readonly storageDir: string;
	readonly log: (message: string) => void;
	readonly now?: () => Date;
}

export interface PredecessorImportReport {
	/**
	 * `imported` — the predecessor's folder list was read and committed;
	 * `already-imported` — the ledger already records this source;
	 * `absent` — no predecessor catalog exists, so there is nothing to import;
	 * `failed` — the predecessor's catalog or this catalog could not be used; nothing changed.
	 */
	readonly status: "imported" | "already-imported" | "absent" | "failed";
	/** Folders added to this catalog. */
	readonly folders: number;
	readonly detail: string | null;
}

/** Where the predecessor's global storage lives: a sibling of this extension's. */
export function predecessorStorageDir(storageDir: string): string {
	return path.join(path.dirname(path.resolve(storageDir)), PREDECESSOR_EXTENSION_ID);
}

/**
 * Import the predecessor's registered folders, once.
 *
 * Never throws: every failure is reported in the result and logged.
 */
export async function importPredecessorFolders(deps: PredecessorImportDeps): Promise<PredecessorImportReport> {
	if (deps.store.imports().some(record => record.source === PREDECESSOR_IMPORT_SOURCE)) {
		return { status: "already-imported", folders: 0, detail: null };
	}
	const predecessorDir = predecessorStorageDir(deps.storageDir);
	let folderRecord: unknown;
	try {
		const document = readCatalogDocument(catalogPaths(predecessorDir));
		if (document === null) return { status: "absent", folders: 0, detail: null };
		folderRecord = Object.prototype.hasOwnProperty.call(document.records, WORKSPACE_FOLDERS_STORAGE_KEY)
			? document.records[WORKSPACE_FOLDERS_STORAGE_KEY]
			: undefined;
	} catch (error) {
		const detail = messageOf(error);
		deps.log(`predecessor import: the folder list of ${PREDECESSOR_EXTENSION_ID} could not be read and was not imported: ${detail}`);
		return { status: "failed", folders: 0, detail };
	}
	const at = (deps.now ?? (() => new Date()))().toISOString();
	const counts = { folders: 0 };
	try {
		await deps.store.run(tx => {
			if (folderRecord !== undefined && folderRecord !== null) {
				const merged = unionWorkspaceFolderRecords({
					existing: tx.latest(WORKSPACE_FOLDERS_STORAGE_KEY),
					incoming: folderRecord,
					source: PREDECESSOR_IMPORT_SOURCE,
					at,
				});
				for (const conflict of merged.conflicts) tx.addConflict(WORKSPACE_FOLDERS_STORAGE_KEY, conflict);
				if (merged.quarantined.length > 0) {
					tx.addConflict(WORKSPACE_FOLDERS_STORAGE_KEY, {
						identity: PREDECESSOR_IMPORT_SOURCE,
						reason: `the predecessor's folder list was retained but not applied: ${merged.quarantined.join("; ")}`,
						retained: tx.latest(WORKSPACE_FOLDERS_STORAGE_KEY) ?? null,
						rejected: folderRecord,
					});
				} else {
					counts.folders = merged.added;
					tx.set(WORKSPACE_FOLDERS_STORAGE_KEY, merged.value);
				}
			}
			tx.addImport({
				source: PREDECESSOR_IMPORT_SOURCE,
				digest: catalogDigest(folderRecord ?? null),
				at,
				outcome: counts.folders > 0 ? "imported" : "empty",
				keys: folderRecord === undefined || folderRecord === null ? [] : [WORKSPACE_FOLDERS_STORAGE_KEY],
				detail: null,
			});
		});
	} catch (error) {
		const detail = messageOf(error);
		deps.log(`predecessor import: the folder list of ${PREDECESSOR_EXTENSION_ID} was not imported: ${detail}`);
		return { status: "failed", folders: 0, detail };
	}
	deps.log(`predecessor import: ${counts.folders} folder(s) were imported from ${PREDECESSOR_EXTENSION_ID}`);
	return { status: "imported", folders: counts.folders, detail: null };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
