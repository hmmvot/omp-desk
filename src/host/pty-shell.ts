/**
 * The folder shell: a second kind of PTY child, owned by the broker but not an OMP
 * host ([ADR-0024](../../docs/decisions/0024-own-omp-pty-for-in-tab-terminal.md)).
 *
 * "Open Terminal" on a folder starts a general-purpose shell in that folder. It is
 * deliberately not a managed session: no chat session is started, no host-control
 * bootstrap is preloaded, no session claim is taken, and running `omp` inside it is a
 * user-owned act whose history the folder's ordinary Resume may later discover. What
 * it shares with the managed case is the broker — one PTY, one screen, one writer
 * slot, one verified stop — because that is what makes closing the editor safe and
 * reopening the shell possible without starting a second process.
 *
 * Which shell, and why this order:
 *
 * 1. an explicitly given shell path wins, with the caller's arguments;
 * 2. otherwise the platform's modern PowerShell (`pwsh.exe`) and then Windows
 *    PowerShell (`powershell.exe`) if either is on `PATH`;
 * 3. otherwise the command processor the system names (`ComSpec`, i.e. `cmd.exe`);
 * 4. on other platforms, `$SHELL` and then `/bin/sh`.
 *
 * Nothing here reads a VS Code setting: the extension has no terminal profile of its
 * own, and inventing one would decide which shell a user's command runs in from a
 * place they did not look. The resolution is reported in the spec's title so the
 * editor says which shell it started.
 */

import { access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import process from "node:process";
import { clampPtySize, type PtyOwnerHint } from "./pty-protocol.ts";
import type { PtyLaunchSpec } from "./pty-client.ts";

/** Arguments a shell gets so it starts as an interactive shell, without a banner. */
const SHELL_ARGUMENTS: Record<string, readonly string[]> = {
	pwsh: ["-NoLogo"],
	powershell: ["-NoLogo"],
	cmd: [],
	bash: ["-i"],
	sh: [],
	zsh: ["-i"],
};

/** One folder shell, resolved to something the broker can start. */
export interface PtyResolvedShell {
	readonly file: string;
	readonly args: readonly string[];
	/** How it was chosen, for the editor's title and for diagnostics. */
	readonly origin: string;
	readonly title: string;
}

export interface PtyFolderShellRequest {
	/** Writer slot; `shell:<uuid>` for a new shell, a stable key to reattach one. */
	readonly slot: string;
	readonly cwd: string;
	readonly cols?: number;
	readonly rows?: number;
	readonly title?: string | null;
	/** An explicit shell, with its own arguments when given. */
	readonly shellPath?: string;
	readonly shellArgs?: readonly string[];
	/**
	 * The owning VS Code instance, as the extension host sees itself (ADR-0030).
	 *
	 * A hint is a candidate the broker attests for itself; `null` says this launching
	 * frontend exists and cannot attest an owning main, which disarms automatic stopping
	 * for the shell; omitting the field makes no ownership claim at all and changes
	 * nothing. The broker's own verdict is always `status.ownerStop`, never this field.
	 */
	readonly owner?: PtyOwnerHint | null;
}

/**
 * The absolute path of `name` on `PATH`, or `null`.
 *
 * Only absolute `PATH` entries are searched, and the *matched path* is returned rather
 * than the name: a relative entry would resolve against whatever directory the broker
 * happens to run in, which is not a decision a caller can see or audit, and the broker
 * refuses a non-absolute executable anyway.
 */
async function findOnPath(name: string): Promise<string | null> {
	const path = process.env.PATH ?? "";
	for (const directory of path.split(delimiter)) {
		if (directory.length === 0 || !isAbsolute(directory)) continue;
		const candidate = join(directory, name);
		try {
			await access(candidate, fsConstants.X_OK);
			if ((await stat(candidate)).isFile()) return candidate;
		} catch {
			// Not this directory.
		}
	}
	return null;
}

/** The command processor of this Windows installation, as an absolute path. */
function windowsCommandProcessor(): string {
	const comspec = process.env.ComSpec;
	if (comspec !== undefined && isAbsolute(comspec)) return comspec;
	const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	return join(root, "System32", "cmd.exe");
}

/**
 * Resolve the shell a folder terminal runs.
 *
 * An explicit path is used as given (including one that does not exist: the broker's
 * own spawn error is a better report than a guess made here). Every other candidate
 * is checked before it is chosen, and the last resort is the platform's own command
 * processor, so this cannot return a path nothing will run.
 */
export async function resolveFolderShell(request: PtyFolderShellRequest): Promise<PtyResolvedShell> {
	const explicit = request.shellPath;
	if (explicit !== undefined && explicit.length > 0) {
		const name = basenameWithoutExtension(explicit);
		return {
			file: explicit,
			args: request.shellArgs ?? SHELL_ARGUMENTS[name] ?? [],
			origin: "given",
			title: request.title ?? `${name} — ${request.cwd}`,
		};
	}
	if (process.platform === "win32") {
		for (const candidate of ["pwsh.exe", "powershell.exe"]) {
			const resolved = await findOnPath(candidate);
			if (resolved !== null) {
				const name = candidate === "pwsh.exe" ? "pwsh" : "powershell";
				return {
					file: resolved,
					args: SHELL_ARGUMENTS[name] ?? [],
					origin: `PATH (${candidate})`,
					title: request.title ?? `${name} — ${request.cwd}`,
				};
			}
		}
		const command = windowsCommandProcessor();
		return {
			file: command,
			args: SHELL_ARGUMENTS.cmd ?? [],
			origin: process.env.ComSpec === undefined ? "the Windows command processor" : "ComSpec",
			title: request.title ?? `cmd — ${request.cwd}`,
		};
	}
	const fromEnvironment = process.env.SHELL;
	if (fromEnvironment !== undefined && isAbsolute(fromEnvironment)) {
		return {
			file: fromEnvironment,
			args: SHELL_ARGUMENTS[basenameWithoutExtension(fromEnvironment)] ?? [],
			origin: "$SHELL",
			title: request.title ?? `${basenameWithoutExtension(fromEnvironment)} — ${request.cwd}`,
		};
	}
	return {
		file: "/bin/sh",
		args: [],
		origin: "the platform default",
		title: request.title ?? `sh — ${request.cwd}`,
	};
}

/** The broker spec for one folder shell: portable, and no OMP capability in sight. */
export async function folderShellLaunchSpec(request: PtyFolderShellRequest): Promise<PtyLaunchSpec> {
	const shell = await resolveFolderShell(request);
	const size = clampPtySize(request.cols, request.rows, { cols: 100, rows: 30 });
	return {
		slot: request.slot,
		kind: "folder-shell",
		file: shell.file,
		args: shell.args,
		cwd: request.cwd,
		cols: size.cols,
		rows: size.rows,
		title: shell.title,
		// Passed through unchanged, so the three states stay distinct: a hint to attest,
		// `null` for a launching frontend that cannot attest one (which disarms automatic
		// stopping), and an absent field for a caller making no ownership claim at all.
		owner: request.owner,
	};
}

function basenameWithoutExtension(file: string): string {
	const name = file.replace(/\\/g, "/").split("/").pop() ?? file;
	return name.replace(/\.exe$/i, "");
}
