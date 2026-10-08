/** Test support: the Win32 8.3 short-name spelling of a directory, as the OS reports it. */
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * `directory` with its last component spelled by its 8.3 short name, or `null`
 * when the volume did not create one. `dir /x` is the only way to ask the OS for
 * it. Its columns are a date, a time (with an AM/PM marker in some locales),
 * `<DIR>`, the short name when one exists and then the long name, so only the
 * part after `<DIR>` is read.
 */
export function shortDirectoryAlias(directory: string): string | null {
	const parent = path.dirname(directory);
	const name = path.basename(directory);
	const listing = execFileSync("cmd", ["/c", "dir", "/x", parent], { encoding: "utf8" });
	const line = listing.split(/\r?\n/).find(candidate => candidate.includes("<DIR>") && candidate.trimEnd().endsWith(` ${name}`));
	const names = line?.slice(line.indexOf("<DIR>") + "<DIR>".length).trim().split(/\s+/);
	const shortName = names?.length === 2 && names[1] === name ? names[0] : undefined;
	if (!shortName || shortName === name) return null;
	return path.join(parent, shortName);
}
