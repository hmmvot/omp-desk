/**
 * The two settings that decide where session editors live: `ompDesk.chatColumn` (whether they have a group of their
 * own) and `ompDesk.chatTabGroup` (at which edge of the editor area that group is created). Read when a session editor
 * is created and when the file window returns its files, never cached: a change applies to the next one.
 */

import * as vscode from "vscode";
import { chatSideOf } from "../host/chat-layout.ts";
import type { ChatSide } from "../host/chat-layout.ts";

/** Whether session editors keep their own locked editor group (`ompDesk.chatColumn`). */
export function chatColumnEnabled(): boolean {
	return vscode.workspace.getConfiguration("ompDesk").get<boolean>("chatColumn", true);
}

/** The edge a new chat group is moved to (`ompDesk.chatTabGroup`). */
export function chatTabGroupSide(): ChatSide {
	return chatSideOf(vscode.workspace.getConfiguration("ompDesk").get<string>("chatTabGroup", "left"));
}
