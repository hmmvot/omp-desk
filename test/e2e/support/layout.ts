/**
 * The window layout the suite runs in.
 *
 *   - `user` (default): the maintainer's everyday layout, reproduced from files committed in `fixtures/user-layout/`: Dark
 *     Modern, compact density, a custom title bar with the command center and the compact menu, the Activity Bar at the TOP
 *     of the primary side bar on the left with OMP Desk as its only icon, the Context view directly under Sessions and
 *     expanded, no bottom panel and no secondary side bar. The editor split is not stored: OMP Desk puts sessions into
 *     their own locked group on the left and opens files in a group on the right (`ompDesk.chatColumn`).
 *   - `minimal`: the bare first-run profile (default VS Code layout, Activity Bar on the side, every view container pinned).
 *
 * `E2E_LAYOUT=minimal` selects the minimal one for a whole run. A scenario that needs it regardless calls
 * `desk.useLayout(page, "minimal")` and the layout is restored after the test.
 *
 * What is stored where, and how it is applied:
 *   - settings (`fixtures/user-layout/settings.json`) are merged into the profile's `settings.json` before the first start;
 *   - workbench state that only VS Code's state database holds (which Activity Bar icons are pinned, the order of the OMP Desk
 *     views) is written into `User/globalStorage/state.vscdb` of the fresh profile before the first start
 *     (`fixtures/user-layout/global-state.json`, key to JSON value, in the table VS Code itself reads at startup);
 *   - what VS Code keeps per workspace (an expanded view) is done through the UI by `Desk.arrangeLayout`.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type LayoutName = "user" | "minimal";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/user-layout");

export function layoutFromEnv(): LayoutName {
	const value = process.env.E2E_LAYOUT ?? "user";
	if (value !== "user" && value !== "minimal") throw new Error(`E2E_LAYOUT must be "user" or "minimal", got "${value}"`);
	return value;
}

/** Settings of a layout, merged over the profile's base settings. */
export function layoutSettings(layout: LayoutName): Record<string, unknown> {
	return layout === "user" ? JSON.parse(readFileSync(join(FIXTURE_DIR, "settings.json"), "utf8")) : {};
}

/** Writes the layout's workbench state into the (new) profile's global state database. A profile that already ran is left alone. */
export function seedGlobalState(dataDir: string, layout: LayoutName): void {
	if (layout !== "user") return;
	const directory = join(dataDir, "User", "globalStorage");
	mkdirSync(directory, { recursive: true });
	const db = new DatabaseSync(join(directory, "state.vscdb"));
	try {
		// The table VS Code creates itself (`CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`).
		db.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
		const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
		for (const [key, value] of Object.entries(JSON.parse(readFileSync(join(FIXTURE_DIR, "global-state.json"), "utf8")) as Record<string, unknown>)) insert.run(key, JSON.stringify(value));
	} finally {
		db.close();
	}
}
