/**
 * OMP Desk — the old command ids, kept for a bounded window (ADR-0068).
 *
 * The first release after 0.3.1 (0.4.0) moved every contributed id from the bare `omp.` namespace, which is Oh My Pi's
 * own, to `ompDesk.`. An extension cannot rewrite the user's `keybindings.json`, so for the window in which
 * users are told to change it each old command id stays registered as an alias: a command that is **not
 * contributed** (no palette entry, no menu, no generated activation event) and forwards its arguments to the new
 * command and returns its result. The first use of each alias in an extension host names both ids in one warning
 * with an **Open keybindings.json** action; every use is logged.
 *
 * - The table is the set of commands contributed before the rename (92: the 87 of the released 0.3.1 plus five added on the way to 0.4.0), plus the commands VS Code generates
 *   from the container and view ids. A command added after the rename has no alias.
 * - An id another extension contributes (the namespace is Oh My Pi's, and its own integration may use it) is
 *   neither registered nor mirrored: the old name belongs to its owner now.
 * - Three context keys that default keybindings used in `when` clauses are also published under their old
 *   names, so a user's own `when` clause keeps matching. No other old context key is kept.
 *
 * Everything here, its registration in `extension.ts` and the tests that name it are removed in the
 * 1.0.0 release (ADR-0068), together with `legacy-settings.ts`.
 */
import type { Logger } from "../shared/logger.ts";

/** Every command id contributed before the rename (0.3.1's 87 plus five added on the way to 0.4.0), frozen: the new id of one is `ompDesk.` plus the rest. */
export const LEGACY_COMMAND_IDS: readonly string[] = [
	"omp.openModels", "omp.openAgents", "omp.newSession", "omp.addWorkspaceFolder", "omp.chooseSessionsLayout",
	"omp.chooseSessionsLayout.flat", "omp.chooseSessionsLayout.folders", "omp.chooseSessionsLayout.terminals",
	"omp.pinWorkspaceFolder", "omp.unpinWorkspaceFolder", "omp.resumeWorkspaceFolder", "omp.openSession",
	"omp.switchToSessionWindow", "omp.openSessionInChat", "omp.openSessionInTerminal", "omp.showSessionInChat",
	"omp.showSessionInTerminal", "omp.chooseDefaultSessionView", "omp.chooseDefaultSessionViewChat",
	"omp.chooseDefaultSessionViewTerminal", "omp.forgetSession", "omp.deleteSession", "omp.stopSessionHost",
	"omp.switchSessionViewChat", "omp.switchSessionViewTerminal", "omp.copyTerminalScreen", "omp.redrawTerminal",
	"omp.moveFileToNewWindow", "omp.goToSession", "omp.fileLink.open", "omp.fileLink.reveal", "omp.fileLink.revealInOs",
	"omp.webLink.openInEditor", "omp.webLink.openInBrowser", "omp.refreshSessions", "omp.showHostControls",
	"omp.selectModel", "omp.selectThinking", "omp.copyTools", "omp.loginProvider", "omp.enableFileEvidence",
	"omp.disableFileEvidence", "omp.showFileEvidence", "omp.deleteFileEvidence", "omp.showDiagnostics",
	"omp.copyRowDiagnostics", "omp.sendPrompt", "omp.stopTurn", "omp.focusComposer", "omp.retryTurn",
	"omp.searchPromptHistory", "omp.searchSymbolFromChat", "omp.toggleThinking", "omp.toggleToolOutput",
	"omp.compactConversation", "omp.shakeConversation", "omp.cycleModel", "omp.cycleThinkingLevel",
	"omp.exportConversationHtml", "omp.shareConversation", "omp.showChatKeyboardShortcuts", "omp.rewindConversation",
	"omp.openTerminal", "omp.reconnectTerminal", "omp.renameSession", "omp.closeSession", "omp.reloadSession",
	"omp.sendSelection", "omp.sendFile", "omp.openStats", "omp.refreshProcesses", "omp.stopProcess",
	"omp.stopOrphanedProcesses", "omp.killAll", "omp.killSession", "omp.refreshSkills", "omp.skills.showGlobal",
	"omp.skills.showSession", "omp.refreshTools", "omp.tools.showGlobal", "omp.tools.showSession", "omp.refreshMcp",
	"omp.mcp.showGlobal", "omp.mcp.showSession", "omp.refreshExtensions", "omp.extensions.showGlobal",
	"omp.extensions.showSession", "omp.inventory.open", "omp.refreshContext", "omp.context.readBreakdown",
	"omp.context.compact", "omp.context.shake",
];

/** The view ids before the rename (without prefix), each with the `.focus` command VS Code generates for it. */
const LEGACY_VIEW_NAMES: readonly string[] = ["sessions", "skills", "tools", "mcp", "extensions", "context", "deskSettings"];

const OLD_PREFIX = "omp.";
const NEW_PREFIX = "ompDesk.";

/** The command a legacy alias of a contributed command forwards to. */
export function legacyCommandTarget(oldId: string): string {
	if (!oldId.startsWith(OLD_PREFIX)) throw new TypeError(`${oldId} is not a legacy command id`);
	return NEW_PREFIX + oldId.slice(OLD_PREFIX.length);
}

/** Every alias as `[old id, command it forwards to]`: the contributed commands and the ones VS Code generates for the container and views. */
export const LEGACY_ALIASES: readonly (readonly [string, string])[] = [
	...LEGACY_COMMAND_IDS.map((id): readonly [string, string] => [id, legacyCommandTarget(id)]),
	["workbench.view.extension.omp", "workbench.view.extension.ompDesk"],
	...LEGACY_VIEW_NAMES.map((name): readonly [string, string] => [`omp.${name}.focus`, `ompDesk.${name}.focus`]),
];

/** The context keys (without prefix) that default keybindings tested in `when` clauses and that are still set under the old name. */
export const LEGACY_CONTEXT_KEYS: readonly string[] = ["sessionMode", "streaming", "composerPopupOpen"];

/** The old name of a current context key, or `null` when the key has no old twin. */
export function legacyContextKey(current: string): string | null {
	if (!current.startsWith(NEW_PREFIX)) return null;
	const rest = current.slice(NEW_PREFIX.length);
	return LEGACY_CONTEXT_KEYS.includes(rest) ? OLD_PREFIX + rest : null;
}

/** What other extensions contribute in the `omp.` namespace; the old names they own are not ours to alias, mirror or migrate. */
export interface ForeignOmpNames {
	readonly settings: ReadonlySet<string>;
	readonly commands: ReadonlySet<string>;
	/** Whether another extension contributes any command or setting named `omp.<x>`, in which case the context keys are not mirrored either. */
	readonly any: boolean;
}

interface ManifestLike {
	readonly id: string;
	readonly packageJSON?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Scan the other installed extensions' manifests for contributed commands and settings that start with `omp.`. */
export function foreignOmpNames(extensions: readonly ManifestLike[], ownId: string): ForeignOmpNames {
	const settings = new Set<string>();
	const commands = new Set<string>();
	for (const extension of extensions) {
		if (extension.id.toLowerCase() === ownId.toLowerCase() || !isRecord(extension.packageJSON)) continue;
		const contributes = extension.packageJSON.contributes;
		if (!isRecord(contributes)) continue;
		if (Array.isArray(contributes.commands)) {
			for (const command of contributes.commands) {
				if (isRecord(command) && typeof command.command === "string" && command.command.startsWith(OLD_PREFIX)) commands.add(command.command);
			}
		}
		const configuration = Array.isArray(contributes.configuration) ? contributes.configuration : [contributes.configuration];
		for (const section of configuration) {
			if (!isRecord(section) || !isRecord(section.properties)) continue;
			for (const key of Object.keys(section.properties)) if (key.startsWith(OLD_PREFIX)) settings.add(key);
		}
	}
	return { settings, commands, any: settings.size > 0 || commands.size > 0 };
}

export interface LegacyAliasPort {
	/** `vscode.commands.registerCommand`; throws when the id is already registered. */
	register(id: string, handler: (...args: unknown[]) => unknown): { dispose(): void };
	/** `vscode.commands.executeCommand`. */
	execute(id: string, ...args: unknown[]): PromiseLike<unknown>;
	/** A warning message with one action; resolves to the action taken, or `undefined`. */
	warn(message: string, action: string): PromiseLike<string | undefined>;
	openKeybindingsFile(): PromiseLike<unknown>;
	/** Command ids another extension contributes under `omp.`; an alias for one of them is not registered. */
	foreignCommands: ReadonlySet<string>;
	log: Logger;
}

export const OPEN_KEYBINDINGS_ACTION = "Open keybindings.json";

/**
 * Register one alias per legacy command. The returned disposables unregister them.
 *
 * An alias never decides anything the new command does not: it adds no argument, swallows no failure and runs
 * the new command exactly once. A registration that fails (the id is taken) is logged and skipped; it never
 * stops the others or the activation.
 */
export function registerLegacyAliases(port: LegacyAliasPort): { dispose(): void }[] {
	const warned = new Set<string>();
	const registered: { dispose(): void }[] = [];
	for (const [oldId, target] of LEGACY_ALIASES) {
		if (port.foreignCommands.has(oldId)) {
			port.log.info(`legacy command ${oldId}: another extension contributes it, so it is not an alias of ${target}`);
			continue;
		}
		try {
			registered.push(port.register(oldId, (...args: unknown[]) => {
				port.log.info(`legacy command ${oldId} ran ${target}; update the keybinding or setting that names it`);
				if (!warned.has(oldId)) {
					warned.add(oldId);
					void port.warn(
						`OMP Desk: a keybinding or setting still names the command ${oldId}. It works for now, but the command is now ${target}; the old name will stop working in a later release.`,
						OPEN_KEYBINDINGS_ACTION,
					).then(action => (action === OPEN_KEYBINDINGS_ACTION ? port.openKeybindingsFile() : undefined)).then(undefined, () => undefined);
				}
				return port.execute(target, ...args);
			}));
		} catch (error) {
			port.log.warn(`legacy command ${oldId} was not registered: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return registered;
}

export interface RenameNoticePort {
	/** Whether this profile already ran an earlier OMP Desk: its catalog exists before this activation creates one. */
	priorInstall(): Promise<boolean>;
	/** Whether the notice was shown (or decided against) in this profile. */
	shown(): boolean;
	markShown(): PromiseLike<void>;
	info(message: string, action: string): PromiseLike<string | undefined>;
	openKeybindingsFile(): PromiseLike<unknown>;
	log: Logger;
}

export const RENAME_NOTICE_TEXT =
	"OMP Desk renamed its commands, settings and context keys from omp.* to ompDesk.*. Your OMP Desk settings are moved to the new names for you. If you have your own keybindings, change omp.<command> to ompDesk.<command> in keybindings.json; the old names keep working for now, but entries that remove a default key (-omp.<command>) do not.";

/**
 * One notice per profile, on the first activation of this release in a profile that already ran an earlier
 * OMP Desk. A fresh install shows nothing. Not awaited by activation: only the profile's own marker is written
 * before the message appears, so a window that is closed with the message open does not show it again.
 */
export async function announceRename(port: RenameNoticePort): Promise<void> {
	if (port.shown()) return;
	try {
		const upgraded = await port.priorInstall();
		await port.markShown();
		if (!upgraded) return;
		port.log.info("rename notice shown");
		const action = await port.info(RENAME_NOTICE_TEXT, OPEN_KEYBINDINGS_ACTION);
		if (action === OPEN_KEYBINDINGS_ACTION) await port.openKeybindingsFile();
	} catch (error) {
		port.log.warn(`rename notice failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
