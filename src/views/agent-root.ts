/**
 * OMP Desk — the folder OMP should start in for an opened folder.
 *
 * A project is often a subfolder of a Git repository (a Unity project under the repository
 * root, a package of a monorepo) while the agent files — `AGENTS.md`, `.omp/`, `.agents/` —
 * live at the repository root. `omp` started in the subfolder misses them, so the Sessions
 * view shows that ancestor instead of the opened folder.
 *
 * The rule for one opened root `R`:
 * 1. `R` itself holds an agent marker: `R` stays.
 * 2. Otherwise walk up from `R`'s parent, stopping at the first directory that holds `.git`
 *    (a directory or a file) — inclusive, never above it. `R` holding `.git` is itself that
 *    stop. No `.git` on the way up: `R` stays (the user's home holds `.omp`/`.agents`/`.claude`,
 *    so an unbounded walk would swallow every folder under it).
 * 3. The nearest directory on that walk holding a marker replaces `R`; none: `R` stays.
 *
 * Detection is filesystem I/O, so {@link AgentRootResolver} resolves asynchronously and the
 * synchronous view code reads what it remembered.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** The one list of agent markers: what makes a directory an agent root. */
export const AGENT_MARKERS: readonly { readonly name: string; readonly kind: "file" | "directory" }[] = [
	{ name: "AGENTS.md", kind: "file" },
	{ name: "CLAUDE.md", kind: "file" },
	{ name: ".agents", kind: "directory" },
	{ name: ".omp", kind: "directory" },
	{ name: ".claude", kind: "directory" },
	{ name: ".pi", kind: "directory" },
];

/** The existence probe the derivation reads the filesystem through; `null` means absent or unreadable. */
export type PathKindProbe = (target: string) => Promise<"file" | "directory" | "other" | null>;

export const probePathKind: PathKindProbe = async target => {
	try {
		const stat = await fs.promises.stat(target);
		return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
	} catch {
		return null;
	}
};

async function hasAgentMarker(directory: string, probe: PathKindProbe): Promise<boolean> {
	const kinds = await Promise.all(AGENT_MARKERS.map(marker => probe(path.join(directory, marker.name))));
	return AGENT_MARKERS.some((marker, at) => kinds[at] === marker.kind);
}

/**
 * The directory OMP should start in for an opened folder: `root` itself, or the nearest
 * ancestor with agent markers that lies within the same Git repository.
 */
export async function resolveAgentRoot(root: string, probe: PathKindProbe = probePathKind): Promise<string> {
	if (await hasAgentMarker(root, probe)) return root;
	let current = root;
	let nearest: string | null = null;
	for (;;) {
		if ((await probe(path.join(current, ".git"))) !== null) return nearest ?? root;
		const parent = path.dirname(current);
		if (parent === current) return root;
		current = parent;
		if (nearest === null && (await hasAgentMarker(current, probe))) nearest = current;
	}
}

/**
 * Remembers what each opened folder resolved to, so the synchronous Sessions code never
 * touches the disk. Until a folder is resolved it stands for itself; {@link resolve}
 * reads the disk again and says whether any answer differs from what was shown.
 */
export class AgentRootResolver {
	readonly #probe: PathKindProbe;
	#resolved = new Map<string, string>();
	#latest = 0;

	constructor(probe: PathKindProbe = probePathKind) {
		this.#probe = probe;
	}

	/** What `root` is shown as now: its resolved ancestor, or itself while unresolved. */
	lookup(root: string): string {
		return this.#resolved.get(root) ?? root;
	}

	/**
	 * Resolve exactly these roots again (agent files may have appeared since the last time) and
	 * remember the answers, forgetting every other root. Whether any root is now shown as another
	 * folder than before; `false` too when a newer call superseded this one, which reports itself.
	 */
	async resolve(roots: readonly string[]): Promise<boolean> {
		const call = ++this.#latest;
		const unique = [...new Set(roots)];
		const answers = await Promise.all(unique.map(async root => [root, await resolveAgentRoot(root, this.#probe)] as const));
		if (call !== this.#latest) return false;
		const previous = this.#resolved;
		this.#resolved = new Map(answers);
		return answers.some(([root, answer]) => answer !== (previous.get(root) ?? root));
	}
}
