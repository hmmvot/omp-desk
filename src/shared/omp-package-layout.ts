import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Where an OMP package's own `@oh-my-pi/*` dependencies sit, for the staged workers that import OMP's TypeScript
 * source (settings, config, inventory).
 *
 * The layout is the package manager's, not OMP's. `bun install -g` puts every dependency beside the package
 * (`…/node_modules/@oh-my-pi/pi-utils` next to `…/@oh-my-pi/pi-coding-agent`). `npm install -g` of the same release
 * nests them inside it (`…/@oh-my-pi/pi-coding-agent/node_modules/@oh-my-pi/pi-utils`, nothing beside it), and a
 * hoisted npm or pnpm tree is the first layout again. So the answer is found where Node would find it from the
 * package itself: in the package's own `node_modules`, then in the `node_modules` the package is installed into.
 * The search stops there: a package of the same name in some folder further up (a home folder's stray
 * `node_modules`) is not part of this install and is never borrowed for it.
 *
 * Only a directory whose manifest names the wanted package counts, so an unrelated folder of the same name is never
 * imported. Pure apart from reading manifests.
 */
const SCOPE = "@oh-my-pi";

/** The directories that could hold `@oh-my-pi/<name>` for a package at `packageRoot`, nearest first. */
export function ompDependencyCandidates(packageRoot: string, name: string): string[] {
	const root = path.resolve(packageRoot);
	const found = [path.join(root, "node_modules", SCOPE, name)];
	for (let directory = path.dirname(root); ; directory = path.dirname(directory)) {
		if (path.basename(directory) === "node_modules") {
			found.push(path.join(directory, SCOPE, name));
			return found;
		}
		if (path.dirname(directory) === directory) return found;
	}
}

function namesPackage(directory: string, expected: string): boolean {
	try {
		const manifest: unknown = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
		return typeof manifest === "object" && manifest !== null && "name" in manifest && manifest.name === expected;
	} catch {
		return false;
	}
}

/** The directory of `@oh-my-pi/<name>` that the OMP package at `packageRoot` itself resolves, or `null` when there is none. */
export function findOmpDependencyRoot(packageRoot: string, name: string): string | null {
	const expected = `${SCOPE}/${name}`;
	for (const candidate of ompDependencyCandidates(packageRoot, name)) if (namesPackage(candidate, expected)) return candidate;
	return null;
}

/**
 * As {@link findOmpDependencyRoot}, refusing with a sentence that names the package and where it was looked for.
 * `fail` builds the error, so a worker can refuse with the one kind of error its caller may show.
 */
export function ompDependencyRoot(packageRoot: string, name: string, fail: (message: string) => Error = message => new Error(message)): string {
	const found = findOmpDependencyRoot(packageRoot, name);
	if (found !== null) return found;
	const looked = ompDependencyCandidates(packageRoot, name).join(" and ");
	throw fail(`The installed OMP package at ${packageRoot} has no ${SCOPE}/${name} beside or inside it (looked in ${looked}).`);
}
