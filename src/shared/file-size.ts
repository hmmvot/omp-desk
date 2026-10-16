/** Sizes and counts as the composer and the host write them in one sentence. */

/** "912 B", "512 KB", "1.4 MB". */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `31482` as `31 482`. */
export function groupedCount(count: number): string {
	return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
