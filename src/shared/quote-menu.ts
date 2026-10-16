/**
 * The context menu item of Chat text (`webview/context` in package.json): the transcript region carries this object in its
 * `data-vscode-context`, VS Code makes each key a context key for the menu's `when` clauses, and the item "Quote Selection" is offered
 * where `ompChatText` holds. The same key appears in the `when` clause; the contributions test ties the two together.
 */
export const CHAT_TEXT_MENU_KEY = "ompChatText";
export const CHAT_TEXT_MENU_CONTEXT = JSON.stringify({ [CHAT_TEXT_MENU_KEY]: true });
