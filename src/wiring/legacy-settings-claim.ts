/**
 * OMP Desk — the profile-wide claim on the User layer for the settings move (ADR-0068 amendment, 2026-10-13).
 *
 * Every window of a profile reads and writes the same `settings.json`. When three windows start together after an
 * update they used to move the same keys three times over, each write queued behind the others'. One window takes
 * this claim and moves; the others wait for its release and find the values moved.
 *
 * The claim is one file in the extension's global storage, which VS Code gives each profile its own: created
 * exclusively, removed on release, and ignored once its modification time is older than `staleMs` (a window that died
 * mid-move). Nothing here is a lock the move depends on for correctness: the move is idempotent and equal writes
 * converge, so a claim the storage refuses to coordinate (any error but "exists") is simply granted.
 */
import { mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { UserLayerClaim } from "./legacy-settings.ts";

/** The move takes seconds; a claim older than this belongs to a window that is gone. */
export const CLAIM_STALE_MS = 60_000;
const POLL_MS = 150;

export interface FileClaimOptions {
	readonly staleMs?: number;
	readonly pollMs?: number;
	readonly now?: () => number;
}

export interface FileClaim {
	claimUserLayer(): Promise<UserLayerClaim | null>;
	waitForRelease(maxMs: number): Promise<boolean>;
}

export function fileClaim(file: string, options: FileClaimOptions = {}): FileClaim {
	const staleMs = options.staleMs ?? CLAIM_STALE_MS;
	const pollMs = options.pollMs ?? POLL_MS;
	const now = options.now ?? Date.now;
	const release: UserLayerClaim = {
		release: () => unlink(file).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		}),
	};

	/** `true` while another window's claim exists and is fresh. */
	const held = async (): Promise<boolean> => {
		try {
			return now() - (await stat(file)).mtimeMs < staleMs;
		} catch {
			return false;
		}
	};

	const create = async (): Promise<"created" | "exists"> => {
		try {
			const handle = await open(file, "wx");
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() }));
			} finally {
				await handle.close();
			}
			return "created";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
			throw error;
		}
	};

	return {
		async claimUserLayer() {
			try {
				await mkdir(path.dirname(file), { recursive: true });
				if (await create() === "created") return release;
				if (await held()) return null;
				// A window that died mid-move left it: take it over.
				await unlink(file).catch(() => undefined);
				return await create() === "created" ? release : null;
			} catch {
				// The storage refuses coordination; the move is idempotent, so it runs unclaimed.
				return { release: () => Promise.resolve() };
			}
		},
		async waitForRelease(maxMs) {
			const deadline = now() + maxMs;
			while (await held()) {
				if (now() >= deadline) return false;
				await sleep(pollMs);
			}
			return true;
		},
	};
}
