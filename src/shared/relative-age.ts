/**
 * OMP Desk — how long ago a timestamp was, in the coarsest honest unit.
 *
 * Shared by a session row's tooltip, a process row's tooltip and the folder resume picker, so an
 * age reads the same wherever the launcher shows it. No editor API.
 */
const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function relativeAge(iso: string, now: number): string {
	const at = new Date(iso).getTime();
	if (Number.isNaN(at)) return "unknown";
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return relativeTimeFormatter.format(-seconds, "second");
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return relativeTimeFormatter.format(-minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (hours < 48) return relativeTimeFormatter.format(-hours, "hour");
	return relativeTimeFormatter.format(-Math.round(hours / 24), "day");
}
