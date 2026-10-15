/**
 * Whether an executable that runs in place may host a broker
 * ([ADR-0074](../../docs/decisions/0074-run-chat-brokers-on-the-sessions-own-bun-runtime-with-code-exe-as-fallback.md)).
 *
 * [ADR-0012](../../docs/decisions/0012-run-child-process-entries-from-staged-copies.md) copies the broker's own entry
 * tree into owner-only storage. The runtime executable that loads that entry is never copied: it runs where it is
 * installed. What stands in for staging is the rule [ADR-0054](../../docs/decisions/0054-verify-private-windows-storage-with-security-identifiers.md)
 * draws for a path the broker is reached through: judged with security identifiers, every owner is a permitted
 * principal (the current account, SYSTEM, Administrators, TrustedInstaller and the owner placeholders), and no other principal may replace or re-permission what the path names or
 * anything above it. The executable file itself is held harder than a directory: another principal may read and
 * execute it and nothing else, because a write right to the file is a right to change the code the broker runs.
 * The volume root is the platform's trust anchor and is not read.
 *
 * Signatures are deliberately not part of the rule (the design explains why).
 */

import path from "node:path";
import {
	isPermittedAclPrincipal,
	parseWindowsAcl,
	namedPrincipal,
	readStorageSecurity,
	permissionsPermitReplacement,
	type PrivateStorageSecurityRead,
} from "./private-storage.ts";

export interface ExecutableTrustProbe {
	/** Replaces the native read of the account SID, every access list and every owner. */
	readonly readSecurity?: (paths: readonly string[]) => Promise<PrivateStorageSecurityRead>;
}

export type ExecutableTrust =
	| { readonly ok: true; readonly paths: readonly string[] }
	| { readonly ok: false; readonly reason: string };

/**
 * Rights another principal may hold on the executable file: read data, read extended attributes, execute, read
 * attributes, read control, synchronize, and the generic read and execute bits. Everything else (any write, append,
 * delete, re-permission or unknown bit) fails closed.
 */
const FILE_READ_EXECUTE_MASK = 0xa01200a9;

/** Whether `permissions` give more than read and execute. */
export function permissionsPermitModification(permissions: number): boolean {
	return ((permissions >>> 0) & ~FILE_READ_EXECUTE_MASK) !== 0;
}

/** The directories above `file` below its volume root, nearest first. */
function carrierDirectories(file: string): readonly string[] {
	const directories: string[] = [];
	let current = path.dirname(path.resolve(file));
	while (path.dirname(current) !== current) {
		directories.push(current);
		current = path.dirname(current);
	}
	return directories;
}

/**
 * Judge one executable at its real path. `file` must be absolute and already resolved through links by the caller
 * (the caller starts that same path). Never throws: anything that cannot be read is a refusal with its reason.
 */
export async function verifyExecutableTrust(file: string, probe: ExecutableTrustProbe = {}): Promise<ExecutableTrust> {
	if (!path.isAbsolute(file)) return { ok: false, reason: `${file} is not an absolute path` };
	const directories = carrierDirectories(file);
	const paths = [file, ...directories];
	let security: PrivateStorageSecurityRead;
	try {
		security = await (probe.readSecurity ?? readStorageSecurity)(paths);
	} catch (error) {
		return { ok: false, reason: `the access of ${file} could not be read (${error instanceof Error ? error.message : String(error)})` };
	}
	if (security.failure !== null) return { ok: false, reason: `the access of ${file} could not be read (${security.failure})` };
	const sid = security.sid;
	if (sid === null) return { ok: false, reason: "the owning account SID could not be read" };
	for (const target of paths) {
		const isFile = target === file;
		// The executable and the folder it sits in decide what the broker loads (the application folder is the first place
		// Windows looks for a DLL), so another principal may only read and execute there. The folders above it are
		// pass-through folders: another principal may add entries but not replace or re-permission the folder.
		const strict = isFile || target === path.dirname(file);
		const label = isFile ? "the executable" : strict ? "the executable's folder" : "the directory";
		const report = security.reports.get(target.toLowerCase());
		if (report === undefined || !report.acl.ok) {
			return { ok: false, reason: `the access of ${target} could not be verified (${report?.acl.detail ?? "the SID reader returned no report"})` };
		}
		const acl = parseWindowsAcl(report.acl.stdout);
		if (!acl.parsed) return { ok: false, reason: `the access listing of ${target} could not be read` };
		for (const entry of acl.entries) {
			if (entry.denied || isPermittedAclPrincipal(entry.principal, sid)) continue;
			const excessive = strict ? permissionsPermitModification(entry.permissions) : permissionsPermitReplacement(entry.permissions);
			if (!excessive) continue;
			return {
				ok: false,
				reason: `${label} ${target} lets ${await namedPrincipal(entry.principal)} ${strict ? "change" : "replace or re-permission"} it (${entry.permissions})`,
			};
		}
		// An owner outside the trusted set can rewrite the access rules of what it owns.
		if (report.owner === null) return { ok: false, reason: `the owner of ${target} could not be read` };
		if (!isPermittedAclPrincipal(report.owner, sid)) {
			return { ok: false, reason: `${label} ${target} is owned by ${await namedPrincipal(report.owner)}, beyond the same-user boundary` };
		}
	}
	return { ok: true, paths };
}
