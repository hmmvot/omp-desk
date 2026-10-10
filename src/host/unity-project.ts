/**
 * OMP Desk — finding the Unity projects under a folder (ADR-0057).
 *
 * The Unity extensions (vstuc, C# Dev Kit) only work in a VS Code window whose workspace root
 * is the Unity project folder, so a session for a repository that holds a Unity project has to
 * run in a window that has that folder open. A Unity project folder is a directory that has
 * both `ProjectSettings/ProjectVersion.txt` and `Assets/`.
 *
 * The search is bounded: the folder itself, then its subfolders down to two levels, skipping
 * dot-directories and the directories Unity or Node fill with generated trees. A directory that
 * is a Unity project is not searched further. This module is VS Code–free.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

/** Directories never searched, compared case-insensitively. */
export const UNITY_SEARCH_SKIPPED = ["node_modules", "library", "temp", "logs"] as const;
/** How deep below the folder a project is looked for. */
export const UNITY_SEARCH_DEPTH = 2;
/** Directories read by one search, however large the tree. */
const MAX_SEARCHED_DIRECTORIES = 400;

/** Whether `directory` is a Unity project folder: `ProjectSettings/ProjectVersion.txt` and `Assets/`. */
export async function isUnityProject(directory: string): Promise<boolean> {
	try {
		const [version, assets] = await Promise.all([
			fsp.stat(path.join(directory, "ProjectSettings", "ProjectVersion.txt")),
			fsp.stat(path.join(directory, "Assets")),
		]);
		return version.isFile() && assets.isDirectory();
	} catch {
		return false;
	}
}

async function subdirectories(directory: string): Promise<string[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fsp.readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && !(UNITY_SEARCH_SKIPPED as readonly string[]).includes(entry.name.toLowerCase()))
		.map(entry => path.join(directory, entry.name))
		.sort();
}

/**
 * The Unity project folders that a launch in `folder` stands for: `[folder]` when it is itself
 * one, otherwise the projects below it down to {@link UNITY_SEARCH_DEPTH} levels (none when it
 * has none). Never throws; an unreadable directory has no projects.
 */
export async function findUnityProjects(folder: string): Promise<string[]> {
	if (await isUnityProject(folder)) return [folder];
	const found: string[] = [];
	let level = [folder];
	let budget = MAX_SEARCHED_DIRECTORIES;
	for (let depth = 1; depth <= UNITY_SEARCH_DEPTH && level.length > 0 && budget > 0; depth++) {
		const next: string[] = [];
		for (const directory of level) {
			for (const child of await subdirectories(directory)) {
				if (budget-- <= 0) return found;
				if (await isUnityProject(child)) found.push(child);
				else next.push(child);
			}
		}
		level = next;
	}
	return found;
}

/** Remembers each folder's answer for a short time: a launch asks about the same folder again and again. */
export class UnityProjectCache {
	readonly #entries = new Map<string, { readonly at: number; readonly projects: Promise<string[]> }>();
	readonly #now: () => number;
	readonly #ttlMs: number;

	constructor(options: { readonly now?: () => number; readonly ttlMs?: number } = {}) {
		this.#now = options.now ?? Date.now;
		this.#ttlMs = options.ttlMs ?? 60_000;
	}

	/** The Unity projects a launch in `folder` stands for. */
	projects(folder: string): Promise<string[]> {
		const now = this.#now();
		const cached = this.#entries.get(folder);
		if (cached !== undefined && now - cached.at <= this.#ttlMs) return cached.projects;
		if (this.#entries.size >= 64) this.#entries.clear();
		const projects = findUnityProjects(folder);
		this.#entries.set(folder, { at: now, projects });
		return projects;
	}

	clear(): void {
		this.#entries.clear();
	}
}
