import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
interface Disposable { dispose(): void }
export interface BranchObservation extends Disposable {
	refresh(): void;
	/** Settles once no `git` child started by this observation is still running (after `dispose`, once it was killed). */
	idle(): Promise<void>;
}
export interface GitRepository {
	rootUri: { fsPath: string };
	state: { HEAD: { name?: string; commit?: string; type?: number } | undefined; onDidChange(listener: () => void): Disposable };
}
export interface GitApi {
	repositories: readonly GitRepository[];
	onDidOpenRepository(listener: () => void): Disposable;
	onDidCloseRepository(listener: () => void): Disposable;
}

export function repositoryForCwd(api: GitApi, cwd: string): GitRepository | undefined {
	return api.repositories.filter(repository => {
		const relative = path.relative(repository.rootUri.fsPath, cwd);
		return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
	}).sort((left, right) => right.rootUri.fsPath.length - left.rootUri.fsPath.length)[0];
}

export async function readGitBranch(cwd: string, signal?: AbortSignal): Promise<string | null> {
	try {
		const options = { cwd, windowsHide: true, timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, ...(signal === undefined ? {} : { signal }) };
		const branch = (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], options)).stdout.trim();
		const value = branch === "HEAD" ? (await exec("git", ["rev-parse", "--short", "HEAD"], options)).stdout.trim() : branch;
		return value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
	} catch { return null; }
}

/**
 * Publish the branch name (or the short commit when HEAD is detached) for `cwd`,
 * skipping repeats. The native Git API is authoritative when a repository
 * contains `cwd`; the `git` CLI is only the fallback when none does, and a stale
 * CLI result is dropped through the generation counter.
 */
export function observeSessionBranch(cwd: string, api: GitApi | undefined, publish: (branch: string | null) => void,
	read: (cwd: string, signal?: AbortSignal) => Promise<string | null> = readGitBranch): BranchObservation {
	const stop = new AbortController();
	const reading = new Set<Promise<void>>();
	let disposed = false;
	let generation = 0;
	let repository: GitRepository | undefined;
	let stateListener: Disposable | undefined;
	let lastBranch: string | null | undefined;
	const emit = (branch: string | null): void => {
		if (branch === lastBranch) return;
		lastBranch = branch;
		publish(branch);
	};
	const refresh = (): void => {
		if (disposed) return;
		const current = api && repositoryForCwd(api, cwd);
		if (current !== repository) {
			stateListener?.dispose();
			repository = current;
			stateListener = repository?.state.onDidChange(refresh);
		}
		const revision = ++generation;
		if (repository) {
			const head = repository.state.HEAD;
			// Git RefType.Head is 0; a tag/commit HEAD is detached, even if it has a name.
			const branch = head?.type === 0 && head.name ? head.name : head?.commit?.slice(0, 7) ?? null;
			emit(branch !== null && branch.length <= 200 && !/[\u0000-\u001f\u007f]/.test(branch) ? branch : null);
		} else {
			// A `git` child keeps its working directory open, so disposal kills it rather than only ignoring its answer.
			const pending: Promise<void> = read(cwd, stop.signal)
				.then(branch => { if (!disposed && revision === generation) emit(branch); })
				.finally(() => { reading.delete(pending); });
			reading.add(pending);
		}
	};
	const open = api?.onDidOpenRepository(refresh);
	const close = api?.onDidCloseRepository(refresh);
	refresh();
	return {
		refresh,
		idle: async () => { await Promise.allSettled([...reading]); },
		dispose() { disposed = true; generation++; stop.abort(); stateListener?.dispose(); open?.dispose(); close?.dispose(); },
	};
}
