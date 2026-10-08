/**
 * Detect that the installed extension was replaced on disk under a running extension host.
 *
 * `code --install-extension <vsix> --force` extracts over the same folder
 * (`hmmvot.omp-desk-<version>`) while the window keeps running the code it loaded at
 * activation. The host process itself is unaffected — child entries are staged outside the install
 * folder (ADR-0012) — but everything the host reads from that folder *later* is the new build: a
 * Webview document built after the install loads the new `media/guest.js` against the old host's
 * message handling. VS Code does not restart the extension host for a same-version reinstall, so
 * nothing tells the user. This module is the missing signal: the files the running host depends on
 * are fingerprinted at activation and re-checked when a document is about to be built and on a
 * timer, and a changed fingerprint means "reload the window to finish updating".
 *
 * Bytes decide, not timestamps: re-installing an identical VSIX rewrites every file but is not
 * drift. Nothing here imports `vscode`.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** The packaged files a running host and its documents must agree on. */
export const PACKAGE_DRIFT_FILES: readonly string[] = [
	"out/extension.js",
	"media/guest.js",
	"media/shell.js",
	"out/omp-host-control.mjs",
	"out/verified-pipe.ps1",
	"out/pty/pty-broker.js",
];

export type PackageDriftVerdict =
	| { readonly kind: "same" }
	/** `files` are package-relative paths whose bytes differ from, or are missing since, activation. */
	| { readonly kind: "changed"; readonly files: readonly string[] };

interface Recorded {
	readonly size: number;
	readonly mtimeMs: number;
	readonly sha256: string;
}

/** A stat reading and whether the bytes behind it matched the baseline, so an unchanged stat is not re-hashed. */
interface Observed {
	readonly size: number;
	readonly mtimeMs: number;
	readonly matches: boolean;
}

const SAME: PackageDriftVerdict = { kind: "same" };

function sha256Of(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export class PackageDrift {
	readonly #root: string;
	readonly #files: readonly string[];
	readonly #observed = new Map<string, Observed>();
	#baseline: Map<string, Recorded> | null = null;

	constructor(root: string, files: readonly string[] = PACKAGE_DRIFT_FILES) {
		this.#root = root;
		this.#files = files;
	}

	/**
	 * Record what the running host started from. Never rejects: a file that cannot be read is not part
	 * of this package and is not watched. Until the baseline exists {@link check} reports `same`.
	 */
	async capture(): Promise<void> {
		const baseline = new Map<string, Recorded>();
		for (const file of this.#files) {
			const path = join(this.#root, file);
			try {
				const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
				baseline.set(file, { size: info.size, mtimeMs: info.mtimeMs, sha256: sha256Of(bytes) });
			} catch {
				// Absent from this package build.
			}
		}
		this.#baseline ??= baseline;
	}

	/**
	 * Compare the files on disk with the baseline, synchronously: it runs on the path that builds a
	 * document. A changed size or timestamp costs one read and hash; an unchanged one costs a stat.
	 * A file that vanished is reported changed, because that is what an install in progress looks like.
	 */
	check(): PackageDriftVerdict {
		const baseline = this.#baseline;
		if (baseline === null) return SAME;
		const changed: string[] = [];
		for (const [file, recorded] of baseline) {
			const path = join(this.#root, file);
			let info: { size: number; mtimeMs: number };
			try {
				info = statSync(path);
			} catch {
				changed.push(file);
				continue;
			}
			if (info.size === recorded.size && info.mtimeMs === recorded.mtimeMs) continue;
			const known = this.#observed.get(file);
			if (known !== undefined && known.size === info.size && known.mtimeMs === info.mtimeMs) {
				if (!known.matches) changed.push(file);
				continue;
			}
			let matches: boolean;
			try {
				matches = sha256Of(readFileSync(path)) === recorded.sha256;
			} catch {
				changed.push(file);
				continue;
			}
			this.#observed.set(file, { size: info.size, mtimeMs: info.mtimeMs, matches });
			if (!matches) changed.push(file);
		}
		return changed.length === 0 ? SAME : { kind: "changed", files: changed };
	}
}
