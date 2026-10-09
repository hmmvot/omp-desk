import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, hostname } from "node:os";
import { FILE_LINK_MENU_SECTION, isTerminalLinkTarget, webLinkUrl } from "../webview/terminal-links.ts";
import type { TerminalLinkRequest, TerminalLinkValidation, WebLinkMode } from "../webview/terminal-links.ts";

/** The position a target may carry after its path: group 1 is the line, group 2 the column. */
const POSITION_SUFFIX = /(?::L?|#L)(\d+)(?:[:C](\d+))?(?:-L?\d+(?:[:C]\d+)?)?$/i;
export interface TerminalFileLocation { readonly path: string; readonly line: number; readonly column: number }
/**
 * The panel viewType and link target a Chat file link's context-menu command was invoked with, or `null`.
 * The object comes from the page's `data-vscode-context`, so it is checked like any page message.
 */
export function fileLinkMenuTarget(argument: unknown): { readonly webview: string; readonly target: string } | null {
	if (typeof argument !== "object" || argument === null) return null;
	const { webview, webviewSection, ompFileLinkTarget } = argument as Record<string, unknown>;
	if (webviewSection !== FILE_LINK_MENU_SECTION || typeof webview !== "string" || !isTerminalLinkTarget(ompFileLinkTarget)) return null;
	return { webview, target: ompFileLinkTarget };
}
/**
 * Resolve a terminal file reference against `cwd` to an absolute local path, or `null`.
 * Line and column are one-based, as in the terminal; {@link openTerminalFile} converts
 * them to VS Code's zero-based positions.
 */
export function resolveTerminalFileReference(target: string, cwd: string, home: string = homedir()): TerminalFileLocation | null {
	if (!isTerminalLinkTarget(target) || !cwd) return null;
	let filename = target;
	let line = 1;
	let column = 1;
	if (/^vscode:/i.test(target)) {
		try {
			const uri = new URL(target);
			if (uri.host !== "file" || uri.username || uri.password || uri.search || uri.hash) return null;
			filename = decodeURIComponent(uri.pathname);
			if (/^\/[a-z]:[\\/]/i.test(filename)) filename = filename.slice(1);
			if (!/^(?:[a-z]:[\\/]|\/)/i.test(filename)) return null;
		} catch { return null; }
	} else if (/^file:/i.test(target)) {
		try {
			const uri = new URL(target);
			if (uri.hostname && uri.hostname !== "localhost" && uri.hostname.toLowerCase() !== hostname().toLowerCase()) return null;
			uri.hostname = "";
			const fragment = /^#(?:L)?(\d+)(?::|,|C)?(\d+)?(?:-L?\d+(?:[:,C]?\d+)?)?$/i.exec(uri.hash);
			const uriLine = uri.searchParams.get("line") ?? fragment?.[1];
			const uriColumn = uri.searchParams.get("column") ?? uri.searchParams.get("col") ?? fragment?.[2];
			if (uriLine !== undefined && uriLine !== null) line = Number(uriLine);
			if (uriColumn !== undefined && uriColumn !== null) column = Number(uriColumn);
			uri.search = ""; uri.hash = "";
			filename = fileURLToPath(uri);
		} catch { return null; }
	} else if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target) && !/^[^:]+:L?\d+(?::\d+)?(?:-L?\d+(?::\d+)?)?$/i.test(target)) {
		return null;
	}
	// `:12`, `:12:3`, `:12-30`, `:L12` and the editor-style `#L12`, `#L12-30`, `#L12C3`: the start of a range is where the file opens.
	const suffix = POSITION_SUFFIX.exec(filename);
	if (suffix) {
		filename = filename.slice(0, suffix.index);
		line = Number(suffix[1]); column = Number(suffix[2] ?? 1);
	}
	if (!isTerminalLinkTarget(filename)) return null;
	if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) return null;
	// `~/x` is the user's home, as in a shell; `~user` is not supported.
	if (/^~(?:[\\/]|$)/.test(filename)) filename = home + filename.slice(1);
	// Network/UNC and drive-relative paths are not local absolute file references.
	if (/^[\\/]{2}/.test(filename) || /^[a-z]:(?![\\/])/i.test(filename)) return null;
	const paths = /^[a-z]:[\\/]/i.test(cwd) || /^[a-z]:[\\/]/i.test(filename) ? path.win32 : path;
	return { path: paths.resolve(cwd, filename), line, column };
}

/** An existing local file, or with `folders` an existing file or folder, that `target` names; `null` otherwise. */
export async function existingTerminalFile(target: string, cwd: string, home?: string, folders = false): Promise<(TerminalFileLocation & { readonly folder: boolean }) | null> {
	const location = resolveTerminalFileReference(target, cwd, home);
	if (location === null) return null;
	try {
		const found = await stat(location.path);
		return found.isFile() ? { ...location, folder: false } : folders && found.isDirectory() ? { ...location, folder: true } : null;
	} catch { return null; }
}

/** The slice of the VS Code API that opening a terminal file reference needs. */
export interface TerminalFileOpenApi {
	readonly Uri: { file(path: string): unknown };
	readonly Range: new (startLine: number, startCharacter: number, endLine: number, endCharacter: number) => unknown;
	readonly commands: { executeCommand(command: string, ...args: unknown[]): PromiseLike<unknown> };
}
/**
 * Open `location` in a new, non-preview tab through the workbench's default-editor
 * resolution, so images, PDFs and other binaries get their viewer (`showTextDocument`
 * rejects those). The selection only applies to text editors; viewers ignore it.
 */
export async function openTerminalFile(api: TerminalFileOpenApi, location: TerminalFileLocation): Promise<void> {
	const position = [location.line - 1, location.column - 1] as const;
	await api.commands.executeCommand("vscode.open", api.Uri.file(location.path), {
		preview: false,
		selection: new api.Range(position[0], position[1], position[0], position[1]),
	});
}

/** The slice of the VS Code API that revealing a path needs. */
export interface PathRevealApi<Uri> {
	readonly Uri: { file(path: string): Uri };
	readonly commands: { executeCommand(command: string, ...args: unknown[]): PromiseLike<unknown> };
	readonly workspace: { getWorkspaceFolder(uri: Uri): unknown };
}
/**
 * Select `path` in VS Code's Explorer through the workbench's own Reveal in Explorer command, which
 * shows the Explorer. Only a path inside an open workspace folder has a row there; `false` otherwise.
 */
export async function revealPathInExplorer<Uri>(api: PathRevealApi<Uri>, path: string): Promise<boolean> {
	const uri = api.Uri.file(path);
	if (api.workspace.getWorkspaceFolder(uri) === undefined) return false;
	await api.commands.executeCommand("revealInExplorer", uri);
	return true;
}
/**
 * Open the folder holding `target` in File Explorer with `target` selected. VS Code's `revealFileInOS` command is not
 * used: while its Explorer list has focus it reveals the Explorer's own selection instead of the argument, which is
 * exactly the state a Ctrl+Click on a link leaves behind.
 */
export function revealPathInOs(target: string): Promise<void> {
	const explorer = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe");
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	// `/select,"path"` must reach Explorer unquoted as a whole; a Windows path cannot contain `"`.
	const child = spawn(explorer, [`/select,"${target}"`], { detached: true, stdio: "ignore", windowsVerbatimArguments: true });
	child.once("error", reject);
	child.once("spawn", () => { child.unref(); resolve(); });
	return promise;
}

/** The slice of the VS Code API that opening a web link needs. */
export interface WebLinkOpenApi<Uri> {
	readonly Uri: { parse(value: string, strict?: boolean): Uri };
	readonly commands: { executeCommand(command: string, ...args: unknown[]): PromiseLike<unknown> };
	readonly env: { openExternal(target: Uri): PromiseLike<boolean> };
}
/**
 * Open a host-validated `http(s)` URL: `editor` in an editor tab through the built-in Simple
 * Browser's API command (which itself defers to VS Code's integrated browser where one exists),
 * `external` through `env.openExternal`, VS Code's own path to the default browser.
 */
export async function openWebLink<Uri>(api: WebLinkOpenApi<Uri>, url: string, mode: WebLinkMode): Promise<void> {
	const uri = api.Uri.parse(url, true);
	if (mode === "external") await api.env.openExternal(uri);
	else await api.commands.executeCommand("simpleBrowser.api.open", uri, { preserveFocus: false });
}

export interface TerminalLinkHost {
	readonly cwd: string;
	/** Whether the document and session that sent the request are still current; checked after asynchronous disk validation. */
	isCurrent(): boolean;
	reply(message: TerminalLinkValidation): void;
	openFile(location: TerminalFileLocation): Promise<void>;
	/** Select `path` in VS Code's Explorer, showing it; `false` when no open workspace folder contains it. */
	revealInExplorer(path: string): Promise<boolean>;
	/** Show `path` selected in the system file manager. */
	revealInOs(path: string): Promise<void>;
	openUrl(url: string, mode: WebLinkMode): Promise<void>;
	/** Short user-visible notice, so an activation that cannot complete is never silent. */
	warn(message: string): void;
}
/**
 * Answer a link validation or activation request from the page. Both re-resolve the
 * target on the host; nothing here executes a command or an arbitrary URI. A web link
 * opens only as a re-validated `http:`/`https:` URL, in the editor unless the page asked
 * for the external browser.
 */
export async function handleTerminalLink(request: TerminalLinkRequest, host: TerminalLinkHost, home?: string): Promise<void> {
	if (request.type === "omp:terminal-link-open" && /^\s*https?:/i.test(request.target)) {
		const url = webLinkUrl(request.target);
		if (!host.isCurrent()) return;
		if (url === null) {
			host.warn(`cannot open "${request.target}": not a valid web address.`);
			return;
		}
		try { await host.openUrl(url, request.mode ?? "editor"); }
		catch (error) { host.warn(`cannot open ${url}: ${error instanceof Error ? error.message : String(error)}`); }
		return;
	}
	const location = await existingTerminalFile(request.target, host.cwd, home, request.folders === true);
	if (!host.isCurrent()) return;
	if (request.type === "omp:terminal-link-validate") {
		host.reply({ type: "omp:terminal-link-validation", requestId: request.requestId, valid: location !== null });
		return;
	}
	if (location === null) {
		host.warn(`cannot open "${request.target}": no such ${request.folders === true ? "file or folder" : "file"} in this session's folder.`);
		return;
	}
	try {
		if (request.action === "os") {
			await host.revealInOs(location.path);
			return;
		}
		// A folder has no tab to open: any click on it reveals it in the Explorer. Ctrl+Click only reveals, a file too.
		if (request.action !== "reveal" && !location.folder) {
			await host.openFile(location);
			return;
		}
		if (!await host.revealInExplorer(location.path)) {
			host.warn(`${location.path} is not in a folder open in this window, so the Explorer cannot show it. Ctrl+Shift+Click shows it in File Explorer.`);
		}
	} catch (error) { host.warn(`cannot open ${location.path}: ${error instanceof Error ? error.message : String(error)}`); }
}
