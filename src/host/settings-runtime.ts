import type { OmpCommand, OmpPackageRoot } from "./native-terminal";

/**
 * Whether the selected OMP can be read the way the Models, Agents and OMP Settings editors read it, and if not, the true reason.
 *
 * The editors run OMP's own TypeScript source in a Bun worker, because OMP's registries, agent discovery and model resolution are
 * code, not data. That needs two things of the installation: Bun, and OMP's package on disk. Bun's global and npm's global
 * installs of `@oh-my-pi/pi-coding-agent` both leave that package on disk and start it under Bun. OMP's standalone program (the
 * `omp.sh` / winget / mise binary) carries its code inside the executable: there is no source to read, and no other install's
 * package is borrowed for it. Each case gets its own sentence, because what the user can do about it differs.
 */
export type SettingsRuntimeCheck =
	| { readonly ok: true; readonly bun: string; readonly root: OmpPackageRoot }
	| { readonly ok: false; readonly message: string };

export interface SettingsRuntimeFacts {
	/** What opens: `The Agents editor`, `The OMP Settings editor`. */
	readonly surface: string;
	/** What the user can do in the terminal instead, as a sentence. */
	readonly instead: string;
	readonly executable: OmpCommand & { readonly version?: string | null };
	readonly bun: string | null;
	readonly root: OmpPackageRoot | null;
}

export function checkSettingsRuntime(facts: SettingsRuntimeFacts): SettingsRuntimeCheck {
	const { surface, instead, executable, bun, root } = facts;
	const release = executable.version === undefined || executable.version === null ? "" : `, release ${executable.version}`;
	if (root === null) {
		const entry = executable.prefixArgs.at(-1);
		if (entry === undefined) {
			return {
				ok: false,
				message: `${surface} reads the installed OMP's TypeScript source, and the OMP this window runs (${executable.command}${release}) is OMP's standalone program, ` +
					`which carries its code inside the executable: there is no source on disk to read. ${instead} ` +
					"An OMP installed with Bun (`bun install -g @oh-my-pi/pi-coding-agent`) or npm (`npm install -g @oh-my-pi/pi-coding-agent`) has it.",
			};
		}
		return {
			ok: false,
			message: `${surface} reads the installed OMP's TypeScript source, and the package that holds ${entry} has no readable source${release === "" ? "" : ` of${release.slice(1)}`} ` +
				`(its package.json or src/session/session-storage.ts is missing, or belongs to another release). ${instead}`,
		};
	}
	if (bun === null) {
		return {
			ok: false,
			message: `${surface} runs the installed OMP's TypeScript source with Bun, and no Bun runtime was found (BUN_INSTALL, ~/.bun/bin or PATH). ` +
				`Install Bun, or put its bun.exe on PATH. ${instead}`,
		};
	}
	return { ok: true, bun, root };
}
