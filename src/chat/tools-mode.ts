/**
 * The Chat transcript's global tool display mode: three fold states for every tool group and call.
 *
 * - `collapsed`: groups closed, calls closed (the default).
 * - `groups`: every group open, every call inside it a collapsed one-line row.
 * - `all`: every group open, every call expanded (the TUI's `Ctrl+O`).
 *
 * Two commands move between them. `Ctrl+O` (`ompDesk.toggleToolOutput`) expands or collapses everything; `Ctrl+Shift+O`
 * (`ompDesk.toggleToolGroups`) opens or closes the groups only.
 */

export type ToolsMode = "collapsed" | "groups" | "all";

/** Which of the two commands was run. */
export type ToolsModeKey = "output" | "groups";

export function isToolsMode(value: unknown): value is ToolsMode {
	return value === "collapsed" || value === "groups" || value === "all";
}

/**
 * The mode the next press of a command leads to.
 *
 * | from        | `Ctrl+O` (output) | `Ctrl+Shift+O` (groups) |
 * | ----------- | ----------------- | ----------------------- |
 * | `collapsed` | `all`             | `groups`                |
 * | `groups`    | `all`             | `collapsed`             |
 * | `all`       | `collapsed`       | `groups`                |
 *
 * `Ctrl+O` is Expand/Collapse All: it expands anything that is not fully expanded and collapses from `all`. The groups
 * key toggles the groups level: from `groups` it closes them, from anything else it lands on `groups` (from `all` the
 * calls fold back into one-line rows and the groups stay open).
 */
export function nextToolsMode(current: ToolsMode, key: ToolsModeKey): ToolsMode {
	if (key === "output") return current === "all" ? "collapsed" : "all";
	return current === "groups" ? "collapsed" : "groups";
}

/**
 * The mode kept in `globalState` under the key that has always held the `Ctrl+O` default. It is stored as `true` for
 * `all` (what every earlier build wrote), the string `"groups"` for `groups`, and anything else reads as `collapsed`,
 * so a remembered value survives an upgrade and a downgrade reads `"groups"` as collapsed.
 */
export function toolsModeFromStored(value: unknown): ToolsMode {
	if (value === true) return "all";
	return value === "groups" ? "groups" : "collapsed";
}

export function toolsModeToStored(mode: ToolsMode): true | "groups" | false {
	return mode === "all" ? true : mode === "groups" ? "groups" : false;
}
