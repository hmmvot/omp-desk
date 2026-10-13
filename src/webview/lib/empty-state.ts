/** What the empty chat shows of a folder and of a conversation's age; pure, so it is tested without a page. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "now", "5m", "2h", "1d", "3mo", "2y": the age of a conversation in the empty state's one narrow column. */
export function shortAge(updatedAt: number, now: number): string {
	const age = now - updatedAt;
	if (!(age >= MINUTE)) return "now";
	if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
	if (age < DAY) return `${Math.floor(age / HOUR)}h`;
	if (age < 30 * DAY) return `${Math.floor(age / DAY)}d`;
	if (age < 365 * DAY) return `${Math.floor(age / (30 * DAY))}mo`;
	return `${Math.floor(age / (365 * DAY))}y`;
}

/** The last name of a folder path, whichever separator it uses. */
export function folderName(cwd: string): string {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || cwd;
}
