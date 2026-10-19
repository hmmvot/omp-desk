/**
 * Whether a `message` event came from a frame this page embeds (a reply's HTML page, `components/HtmlPageBlock.tsx`, or anything
 * that page itself opened).
 *
 * The page's own inbound channel carries the host's messages, delivered by the webview's host page, which is an ancestor of this
 * window. A page the model wrote runs in a descendant frame and can post to `parent` whatever it likes, including a copy of a host
 * message; the channel must not take it. Only the window the event names is checked, never its data: the data is the sender's.
 *
 * A `null` source (a message the page dispatched to itself, as a test does) and this window itself are not frames. A window whose
 * ancestry cannot be read counts as a frame: refusing a stranger is the safe error.
 */
export function isFromEmbeddedFrame(source: MessageEventSource | null | undefined, self: Window): boolean {
	if (source === null || source === undefined || source === self) return false;
	// A message port, a service worker: no window, and none of ours.
	if (!("parent" in source)) return false;
	try {
		let current: Window = source;
		// The nesting a frame can build is bounded by the browser; this bound only keeps a pathological chain cheap.
		for (let depth = 0; depth < 64; depth++) {
			const parent: Window | null = current.parent;
			if (parent === null || parent === current) return false;
			if (parent === self) return true;
			current = parent;
		}
		return true;
	} catch {
		return true;
	}
}
