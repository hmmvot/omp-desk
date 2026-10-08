/**
 * OMP Desk — which session roots a read-only history pass should scan.
 *
 * This module is deliberately separate from `./native-history.ts` (which is pure
 * and environment-free) and deliberately does *not* import OMP's own path
 * resolver. Installed OMP ships `@oh-my-pi/pi-utils` as Bun-only TypeScript whose
 * `dirs.ts` does `import { version } from "../package.json" with { type: "json" }`;
 * esbuild refuses that named JSON import ("No matching export in
 * .../pi-utils/package.json for import \"version\"") and Node cannot load the
 * source either, so depending on it would make the extension unbuildable. The
 * rules below are therefore mirrored from the 18.2.11 resolver
 * (`@oh-my-pi/pi-utils` `src/dirs.ts`):
 *
 * - config root: `<home>/<PI_CONFIG_DIR or ".omp">`
 * - active profile: `OMP_PROFILE`, else `PI_PROFILE`; empty or `default` means none
 * - profile root: `<config root>/profiles/<profile>` for a named profile
 * - agent dir: `<profile root>/agent`, or `PI_CODING_AGENT_DIR` while no profile
 *   is active (the override is ignored for a named profile, as OMP does)
 * - sessions dir: `<agent dir>/sessions`, redirected to `$XDG_DATA_HOME/omp[/profiles/<p>]/sessions`
 *   on Linux/macOS when that directory already exists (OMP's own XDG rule)
 *
 * Three properties this module owes its callers:
 *
 * 1. The ordinary default profile is scanned *independently* of whatever profile
 *    the environment selects. Running under `OMP_PROFILE=work` must not hide the
 *    default profile's own history, because resuming a default-profile file with
 *    an inherited named profile would claim the wrong profile.
 * 2. Every other root a supported OMP install can have is included too: the
 *    active override, every named profile that exists, applicable XDG storage and
 *    the exact directories the index already knows. Roots are deduplicated by
 *    canonical identity, so one directory reachable twice is scanned once.
 * 3. Every path here is a pure computation. Nothing is created, adopted,
 *    migrated, repaired or renamed — in particular `computeDefaultSessionDir` is
 *    not used, because it creates directories and can migrate legacy ones. The
 *    only filesystem calls are the directory listings and `stat`s that decide
 *    what to scan, and every failure becomes a diagnostic instead of an
 *    exception.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describeError, probePathKind } from "./native-history.ts";
import type { NativeHistoryDiagnostic, NativeHistoryRoot, NativeHistoryRootSource } from "./native-history.ts";
import { normalizeSessionIdentityKey } from "./session-index.ts";

/**
 * A path the index already knows about: an entry's exact session file, or the
 * session directory it was opened with. Used only to find directories the
 * profile roots do not cover (a custom `--session-dir`, mostly).
 */
export interface NativeHistoryExplicitPath {
	readonly path: string;
	readonly profile: string | null;
}

export interface NativeHistoryRoots {
	readonly roots: readonly NativeHistoryRoot[];
	readonly diagnostics: readonly NativeHistoryDiagnostic[];
}

/**
 * The environment OMP's path rules are evaluated against.
 *
 * Injectable so the layout rules — an inherited named profile, an agent-dir
 * override, XDG redirection, named profiles on disk — are testable for every
 * platform from one machine, without mutating the process environment or
 * depending on which OS happens to run the tests.
 */
export interface NativeHistoryEnvironment {
	/** Home directory the OMP config root is derived from. */
	readonly home: string;
	/** Environment variables; `process.env` by default. */
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Platform whose OMP path rules apply. */
	readonly platform: string;
}

/** The environment with every field not given taken from the real process. */
export function nativeHistoryEnvironment(overrides: Partial<NativeHistoryEnvironment> = {}): NativeHistoryEnvironment {
	return {
		home: overrides.home ?? os.homedir(),
		env: overrides.env ?? process.env,
		platform: overrides.platform ?? process.platform,
	};
}

/** Profile names OMP accepts; a hint that fails this could not be a profile. */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/** `<home>/<PI_CONFIG_DIR or ".omp">` — the profile-independent config root. */
function configRoot(environment: NativeHistoryEnvironment): string {
	return path.join(environment.home, environment.env.PI_CONFIG_DIR || ".omp");
}

/**
 * The profile this environment selects, or `null` for the ordinary default.
 *
 * A name that cannot be a profile is reported and ignored rather than joined
 * into a path: `OMP_PROFILE=../elsewhere` must not make this module list a
 * directory outside the config root.
 */
function activeProfile(environment: NativeHistoryEnvironment, diagnostics: NativeHistoryDiagnostic[]): string | null {
	const raw =
		environment.env.OMP_PROFILE !== undefined ? environment.env.OMP_PROFILE : environment.env.PI_PROFILE;
	const name = raw?.trim() ?? "";
	if (name.length === 0 || name === "default") return null;
	const invalid = describeInvalidProfile(name);
	if (invalid !== null) {
		diagnostics.push({ kind: "invalid-profile", root: null, detail: `OMP_PROFILE: ${invalid}` });
		return null;
	}
	return name;
}

function profileRoot(environment: NativeHistoryEnvironment, profile: string | null): string {
	const root = configRoot(environment);
	return profile === null ? root : path.join(root, "profiles", profile);
}

/** Why a profile name cannot be used as a profile: `null` when it is usable. */
function describeInvalidProfile(name: string): string | null {
	const trimmed = name.trim();
	if (trimmed.length === 0 || trimmed === "default") return null;
	if (trimmed === "." || trimmed === ".." || trimmed.endsWith(".")) {
		return `"${name}" cannot be an OMP profile name.`;
	}
	if (!PROFILE_NAME_RE.test(trimmed) || WINDOWS_RESERVED_BASENAME_RE.test(trimmed)) {
		return `"${name}" cannot be an OMP profile name.`;
	}
	return null;
}

/** `$XDG_DATA_HOME/omp` (or `.../profiles/<profile>`), when that root exists. */
async function xdgRoot(environment: NativeHistoryEnvironment, profile: string | null): Promise<string | null> {
	if (environment.platform !== "linux" && environment.platform !== "darwin") return null;
	const home = environment.env.XDG_DATA_HOME;
	if (home === undefined || home.trim().length === 0) return null;
	const root = profile === null ? path.join(home, "omp") : path.join(home, "omp", "profiles", profile);
	return (await probePathKind(root)) === "directory" ? root : null;
}

/**
 * Agent directories OMP could use for `profile`, in resolution order.
 *
 * The environment's `PI_CODING_AGENT_DIR` override is used only while no profile
 * is active — OMP ignores it for a named profile — and it names the agent
 * directory itself, so it is not joined with anything.
 */
function nativeAgentDirectories(
	environment: NativeHistoryEnvironment,
	profile: string | null,
): readonly string[] {
	const directories: string[] = [];
	if (profile === null) {
		const override = environment.env.PI_CODING_AGENT_DIR;
		if (override !== undefined && override.trim().length > 0) {
			directories.push(path.resolve(override));
		}
	}
	directories.push(path.join(profileRoot(environment, profile), "agent"));
	return directories;
}

/**
 * Session directories OMP would use for `profile`, in resolution order.
 *
 * The ordinary default profile has two possible agent directories — the explicit
 * `PI_CODING_AGENT_DIR` override (which OMP uses only while no profile is
 * active) and its own `<config root>/agent` — and this module scans both, because
 * either one can hold default-profile history from an earlier environment. A
 * named profile has exactly its own agent directory: OMP ignores the override for
 * a named profile.
 */
async function profileSessionDirectories(
	environment: NativeHistoryEnvironment,
	profile: string | null,
): Promise<string[]> {
	const directories = nativeAgentDirectories(environment, profile).map(directory =>
		path.join(directory, "sessions"),
	);
	const xdg = await xdgRoot(environment, profile);
	if (xdg !== null) directories.push(path.join(xdg, "sessions"));
	return directories;
}

/**
 * The roots one profile contributes.
 *
 * `allowMissing` is for directories the environment names outright (the default
 * profile and the active override): they are declared roots, so a missing one is
 * worth reporting instead of silently dropping. A named profile that has no
 * sessions yet contributes nothing rather than a "missing root" complaint.
 */
async function profileRoots(
	environment: NativeHistoryEnvironment,
	profile: string | null,
	source: NativeHistoryRootSource,
	allowMissing: boolean,
): Promise<NativeHistoryRoot[]> {
	const roots: NativeHistoryRoot[] = [];
	for (const directory of await profileSessionDirectories(environment, profile)) {
		if (!allowMissing && (await probePathKind(directory)) !== "directory") continue;
		roots.push({ root: directory, profile, source });
	}
	return roots;
}

/**
 * Named profiles this install has: the profile directories that exist, from both
 * the config root and the XDG root. Reading them is the whole discovery — no
 * profile is created, activated or migrated by looking.
 */
async function listProfiles(
	environment: NativeHistoryEnvironment,
	diagnostics: NativeHistoryDiagnostic[],
): Promise<string[]> {
	const profiles: string[] = [];
	const bases = [path.join(configRoot(environment), "profiles")];
	const xdg = await xdgRoot(environment, null);
	if (xdg !== null) bases.push(path.join(xdg, "profiles"));
	for (const base of bases) {
		if ((await probePathKind(base)) !== "directory") continue;
		let dirents: fs.Dirent[];
		try {
			dirents = await fs.promises.readdir(base, { withFileTypes: true });
		} catch (error) {
			diagnostics.push({ kind: "unreadable-root", root: base, detail: describeError(error) });
			continue;
		}
		for (const dirent of dirents) {
			if (dirent.isSymbolicLink() || !dirent.isDirectory()) continue;
			// A directory name that could not be selected as a profile (a space, a
			// Windows device name) is not a profile OMP could run under, so it is
			// not scanned and not complained about.
			if (describeInvalidProfile(dirent.name) !== null) continue;
			profiles.push(dirent.name);
		}
	}
	return profiles;
}

/** The root an explicit index path contributes, when it exists. */
async function explicitRoots(explicit: readonly NativeHistoryExplicitPath[]): Promise<NativeHistoryRoot[]> {
	const roots: NativeHistoryRoot[] = [];
	for (const item of explicit) {
		if (item.path.length === 0) continue;
		const absolute = path.resolve(item.path);
		const kind = await probePathKind(absolute);
		if (kind === "missing") continue;
		roots.push({
			// A session file lives in its own session directory, so that directory
			// is the root to enumerate; a directory is scanned as it stands.
			root: kind === "directory" ? absolute : path.dirname(absolute),
			profile: item.profile,
			source: "explicit",
		});
	}
	return roots;
}

/**
 * Resolve every root a read-only pass should scan: the ordinary default profile,
 * the profile the environment selects, every named profile this install has, the
 * profiles and exact paths the index recorded, and applicable XDG storage.
 *
 * Scan order is also precedence order for provenance: the first root that claims
 * a directory wins, so a directory that is both the active profile and a named
 * profile is reported as the active one.
 */
export async function resolveNativeHistoryRoots(
	explicit: readonly NativeHistoryExplicitPath[],
	profileHints: readonly (string | null)[] = [],
	environment: NativeHistoryEnvironment = nativeHistoryEnvironment(),
): Promise<NativeHistoryRoots> {
	const diagnostics: NativeHistoryDiagnostic[] = [];
	const roots: NativeHistoryRoot[] = [
		...(await profileRoots(environment, null, "default-profile", true)),
	];
	const active = activeProfile(environment, diagnostics);
	if (active !== null) {
		roots.push(...(await profileRoots(environment, active, "active-profile", true)));
	}
	const profiles = new Set<string>(await listProfiles(environment, diagnostics));
	for (const hint of profileHints) {
		if (hint === null) continue;
		const invalid = describeInvalidProfile(hint);
		if (invalid !== null) {
			diagnostics.push({ kind: "invalid-profile", root: null, detail: invalid });
			continue;
		}
		const trimmed = hint.trim();
		if (trimmed.length === 0 || trimmed === "default") continue;
		profiles.add(trimmed);
	}
	for (const profile of profiles) {
		roots.push(...(await profileRoots(environment, profile, "named-profile", false)));
	}
	roots.push(...(await explicitRoots(explicit)));
	// The same directory can be reached as a profile root, an inherited-profile
	// root and an explicit path; scanning it twice would double every candidate.
	const seen = new Set<string>();
	const unique: NativeHistoryRoot[] = [];
	for (const root of roots) {
		let key: string;
		try {
			key = normalizeSessionIdentityKey(root.root);
		} catch {
			continue;
		}
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(root);
	}
	return { roots: unique, diagnostics };
}
