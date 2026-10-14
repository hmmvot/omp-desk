/**
 * OMP Desk — the folder a session runs in for an opened folder.
 *
 * One rule, one resolver, for Sessions and for the Settings, Models and Agents editors
 * (`docs/decisions/0073-run-sessions-at-the-checkout-root-and-let-the-editors-follow.md`):
 *
 * - `ompDesk.runSessionsAtRepositoryRoot` on (the default): the root of the version-control
 *   checkout the opened folder lies in (`checkout-root.ts`: the nearest ancestor with a root
 *   marker, the folder itself included), or the folder itself when it lies in none.
 * - Off: the opened folder itself.
 *
 * Nothing about agent files enters the rule. The editors call {@link sessionFolderFor}; Sessions
 * remembers the same answer in a {@link SessionFolderResolver} because its code is synchronous.
 */
import { findCheckoutRoot, probePathKind } from "./checkout-root.ts";
import type { CheckoutMemo, CheckoutSearch, PathKindProbe } from "./checkout-root.ts";

/** The folder sessions run in for `folder`; `enabled` is the setting as read for that folder. */
export async function sessionFolderFor(folder: string, enabled: boolean, search: CheckoutSearch = {}): Promise<string> {
	if (!enabled) return folder;
	const found = await findCheckoutRoot(folder, search);
	return found === null ? folder : found.root;
}

/**
 * Remembers what each opened folder resolved to, so the synchronous Sessions code never touches
 * the disk. Until a folder is resolved it stands for itself; {@link resolve} reads the disk again
 * and says whether any answer differs from what was shown. The setting is not applied here: the
 * resolver always answers "the checkout root", and the caller decides per folder whether to use it.
 */
export class SessionFolderResolver {
	readonly #search: CheckoutSearch;
	#resolved = new Map<string, string>();
	#latest = 0;
	#newest: Promise<boolean> = Promise.resolve(false);

	constructor(search: { readonly probe?: PathKindProbe; readonly home?: string | null; readonly p4config?: string | null } = {}) {
		this.#search = { probe: search.probe ?? probePathKind, ...search };
	}

	/** What `root` is shown as now when sessions run at the checkout root: its resolved root, or itself while unresolved. */
	lookup(root: string): string {
		return this.#resolved.get(root) ?? root;
	}

	/**
	 * Resolve exactly these roots again (a repository may have appeared since the last time) and remember the
	 * answers, forgetting every other root. Whether any root is now shown as another folder than before; `false` too
	 * when a newer call superseded this one, which reports itself. It settles only when the newest call has published,
	 * so a caller that awaits it can look a folder up afterwards whichever call it was.
	 */
	async resolve(roots: readonly string[]): Promise<boolean> {
		const call = ++this.#latest;
		const unique = [...new Set(roots)];
		const work = (async (): Promise<boolean> => {
			// The folders of one pass climb through the same directories: each is probed once.
			const memo: CheckoutMemo = new Map();
			const answers = await Promise.all(unique.map(async root => [root, await sessionFolderFor(root, true, { ...this.#search, memo })] as const));
			if (call !== this.#latest) return false;
			const previous = this.#resolved;
			this.#resolved = new Map(answers);
			return answers.some(([root, answer]) => answer !== (previous.get(root) ?? root));
		})();
		this.#newest = work.catch(() => false);
		const changed = await work;
		for (let newest = this.#newest; call !== this.#latest; newest = this.#newest) {
			await newest;
			if (newest === this.#newest) break;
		}
		return changed;
	}
}
