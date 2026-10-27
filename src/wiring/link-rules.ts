/**
 * The window's link rules (`host/link-rules.ts`): the value comes from the user's own settings (`ompDesk.chatLinkRules`) and nowhere else.
 * The manifest declares the setting with `application` scope, so VS Code ignores a workspace or folder value of it; reading only
 * `globalValue` makes that hold here too, whatever the scope table of the running VS Code says.
 */
import * as vscode from "vscode";
import { createLinkRuleSource, describeLinkRuleProblems } from "../host/link-rules.ts";
import type { LinkRuleSource } from "../host/link-rules.ts";
import { LINK_RULES_SETTING } from "../shared/link-rules.ts";
import type { Logger } from "../shared/logger.ts";

/** The setting as the user's own `settings.json` holds it: no default, no workspace, no folder and no language override. */
export function readUserLinkRules(): unknown {
	return vscode.workspace.getConfiguration("ompDesk").inspect<unknown>(LINK_RULES_SETTING)?.globalValue;
}

/** One source per window; a value with refused rules is logged and shown once, the first time it is read. */
export function createWindowLinkRules(log: Logger, notify: (message: string) => void): LinkRuleSource {
	return createLinkRuleSource({
		read: readUserLinkRules,
		report: problems => {
			const description = describeLinkRuleProblems(problems);
			log.warn(`ompDesk.chatLinkRules: ${description}`);
			notify(`Some rules of the setting ompDesk.chatLinkRules are ignored: ${description}`);
		},
	});
}
