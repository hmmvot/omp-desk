/**
 * The page's copy of which magic keywords OMP acts on (`omp:chat-magic-keywords`), and the way it asks for a fresh one.
 *
 * Module-level, like `key-hints-store.ts`: `attachMagicKeywordSettings` runs in `main.tsx` before the page announces itself. The
 * answer is OMP's own: the host reads the effective `magicKeywords.*` settings of this tab's profile and folder, so a keyword
 * OMP will not act on is not painted. The page asks lazily: when a keyword stands in the composer or a sent message, and at most
 * once in {@link MAGIC_KEYWORD_REFRESH_MS}, so a setting changed since the last answer is picked up the next time a keyword is on
 * screen, and a page that never shows a keyword never starts the CLI; and again whenever the reader comes back with a keyword on
 * screen (the composer or the window gets the focus), whatever the age of the last question. Until the host answers (and where it
 * cannot: a route that does not carry the question, an OMP that cannot be run) every keyword counts, as in OMP's terminal UI, whose
 * paint follows the master switch alone.
 */
import type { GuestHostMessage, GuestWebviewMessage } from "../../protocol/messages.ts";
import { isMagicKeywordId, MAGIC_KEYWORDS, type MagicKeywordId } from "../../shared/magic-keywords.ts";

interface MagicKeywordTransport {
	subscribe(listener: (message: GuestHostMessage) => void): () => void;
	/** `false` when the message provably went nowhere; anything else means it was handed to a route. */
	post(message: GuestWebviewMessage): boolean | void;
}

/** The shortest time between two questions to the host. */
export const MAGIC_KEYWORD_REFRESH_MS = 30_000;

const EVERY_KEYWORD: ReadonlySet<MagicKeywordId> = new Set(MAGIC_KEYWORDS.map(keyword => keyword.id));
const listeners = new Set<() => void>();
let enabled: ReadonlySet<MagicKeywordId> = EVERY_KEYWORD;
let transport: MagicKeywordTransport | null = null;
let askedAt = Number.NEGATIVE_INFINITY;

/** The keywords OMP acts on, as far as the page knows. The same set object until it changes. */
export function getMagicKeywordSettings(): ReadonlySet<MagicKeywordId> {
	return enabled;
}

/** Replaces what the host said (the transport and the tests share this path); anything but a list of known keywords keeps the previous answer, and the same keywords change nothing. */
export function setMagicKeywordSettings(value: unknown): void {
	if (!Array.isArray(value) || !value.every(isMagicKeywordId)) return;
	if (value.length === enabled.size && value.every(id => enabled.has(id))) return;
	enabled = new Set(value);
	for (const listener of [...listeners]) listener();
}

export function subscribeMagicKeywordSettings(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Listens for the host's answers and remembers where to ask. Returns the function that stops listening and forgets what was heard
 * (the page never calls it; a test that attaches twice does).
 */
export function attachMagicKeywordSettings(host: MagicKeywordTransport): () => void {
	const unsubscribe = host.subscribe(message => {
		if (message.type === "omp:chat-magic-keywords") setMagicKeywordSettings(message.keywords);
	});
	transport = host;
	askedAt = Number.NEGATIVE_INFINITY;
	return () => {
		unsubscribe();
		if (transport === host) transport = null;
		enabled = EVERY_KEYWORD;
	};
}

function ask(now: number): void {
	if (transport === null) return;
	askedAt = now;
	let posted: boolean | void;
	try {
		posted = transport.post({ type: "omp:chat-magic-keywords-read" });
	} catch {
		posted = false;
	}
	if (posted === false) askedAt = Number.NEGATIVE_INFINITY;
}

/**
 * Asks the host which keywords OMP acts on now: called where a keyword is on screen. Does nothing before the page is attached or
 * within {@link MAGIC_KEYWORD_REFRESH_MS} of the last question, and a question that provably went nowhere does not count as asked.
 */
export function requestMagicKeywordSettings(now: number = Date.now()): void {
	if (now - askedAt < MAGIC_KEYWORD_REFRESH_MS) return;
	ask(now);
}

/**
 * Asks again whatever the age of the last question: the reader has come back (the composer or the window got the keyboard focus)
 * and may have changed a setting meanwhile. It counts as the last question; the host's in-flight read and its 5 s answer cache
 * still bound the work of a burst of focus events.
 */
export function refreshMagicKeywordSettings(now: number = Date.now()): void {
	ask(now);
}
