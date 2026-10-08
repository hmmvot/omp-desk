/**
 * Tests for the panel transport's listener contract and its persisted identity.
 *
 * The listener failure these defend is silent rather than loud: a transport with
 * a single listener slot lets a second subscriber — the composer's `@`-completion
 * listener — displace the panel owner's without any error, and the panel simply
 * stops receiving its `omp:chat-state`. The buffered flush has the mirror-image
 * failure: it must happen once, for the subscriber that was there first, or a
 * message is delivered twice or not at all.
 *
 * The identity failure is the restart one: VS Code restores the editor only when
 * this document persisted its tab id through `setState`, so the write must happen
 * while the module is evaluated — before `omp:ready`, before any relay exists, and
 * for a document the extension stamped — and must carry the tab id and nothing else.
 *
 * The module reads `window`, `document` and `acquireVsCodeApi` at import time, so
 * the fakes are installed before a dynamic import, exactly as the Webview host
 * injects them.
 *
 * Runner: `bun test src/webview/bridge.test.ts` or `node --test src/webview/bridge.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PANEL_IDENTITY_VERSION } from "./panel-identity.ts";

interface DeliveredEvent {
	data: unknown;
}

const TAB_ID = "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d";
/** What the extension stamps into a panel document's `omp-tab-id` meta tag. */
const STAMPED_IDENTITY_META = {
	getAttribute: (): string => TAB_ID,
};

const messageHandlers: ((event: DeliveredEvent) => void)[] = [];
const posted: unknown[] = [];
const persisted: unknown[] = [];

/** Install the globals one Webview document injects, exactly as it injects them. */
function injectPanelGlobals(options: { stamped: string | null; canPersistState: boolean }): {
	posted: unknown[];
	persisted: unknown[];
} {
	const documentPosted: unknown[] = [];
	const documentPersisted: unknown[] = [];
	Object.defineProperty(globalThis, "window", {
		value: {
			addEventListener(type: string, handler: (event: DeliveredEvent) => void): void {
				if (type === "message") messageHandlers.push(handler);
			},
		},
		configurable: true,
		writable: true,
	});
	Object.defineProperty(globalThis, "document", {
		value: {
			querySelector: (selector: string): unknown =>
				options.stamped === null || !selector.includes("omp-tab-id")
					? null
					: { getAttribute: (): string => options.stamped ?? "" },
		},
		configurable: true,
		writable: true,
	});
	Object.defineProperty(globalThis, "acquireVsCodeApi", {
		value: () => ({
			postMessage: (message: unknown) => documentPosted.push(message),
			...(options.canPersistState ? { setState: (state: unknown) => documentPersisted.push(state) } : {}),
		}),
		configurable: true,
		writable: true,
	});
	return { posted: documentPosted, persisted: documentPersisted };
}

// A static import cannot work here: `bridge.ts` reads `window`, `document` and
// `acquireVsCodeApi` while it is being evaluated, so the fakes above must exist
// first. Same reason the Webview host injects them before the bundle runs.
const firstDocument = injectPanelGlobals({ stamped: TAB_ID, canPersistState: true });
const { guestTransport } = await import("./bridge.ts");

/** Deliver a host message the way the Webview host does. */
function deliver(data: unknown): void {
	for (const handler of messageHandlers) handler({ data });
}

const CONNECT = { type: "omp:draft-restore", requestId: 1, text: "restored draft", attachments: 0, recoverable: [] };
const COMPLETIONS = { type: "omp:file-completions", requestId: 1, paths: ["src/a.ts"] };

describe("guestTransport", () => {
	it("reports a hosted panel and posts through the injected API", () => {
		assert.equal(guestTransport.hosted, true);
		const request = { type: "omp:complete-files", requestId: 4, query: "src" } as const;
		guestTransport.post(request);
		assert.deepEqual(firstDocument.posted, [request]);
	});

	it("flushes the buffer to the first subscriber exactly once", () => {
		deliver(CONNECT);
		const first: unknown[] = [];
		const unsubscribe = guestTransport.subscribe(message => first.push(message));
		assert.deepEqual(first, [CONNECT]);

		// A second subscriber joins later: it must not replay what the first saw.
		const second: unknown[] = [];
		guestTransport.subscribe(message => second.push(message));
		assert.deepEqual(second, []);
		unsubscribe();
	});

	it("delivers every later message to every subscriber", () => {
		const first: unknown[] = [];
		const second: unknown[] = [];
		const stopFirst = guestTransport.subscribe(message => first.push(message));
		const stopSecond = guestTransport.subscribe(message => second.push(message));

		deliver(COMPLETIONS);
		deliver(CONNECT);
		assert.deepEqual(first, [COMPLETIONS, CONNECT]);
		assert.deepEqual(second, [COMPLETIONS, CONNECT]);

		stopFirst();
		stopSecond();
	});

	it("stops delivering to a subscriber that unsubscribed", () => {
		const kept: unknown[] = [];
		const dropped: unknown[] = [];
		const stopKept = guestTransport.subscribe(message => kept.push(message));
		const stopDropped = guestTransport.subscribe(message => dropped.push(message));

		deliver(COMPLETIONS);
		stopDropped();
		deliver(CONNECT);

		assert.deepEqual(kept, [COMPLETIONS, CONNECT]);
		assert.deepEqual(dropped, [COMPLETIONS]);
		stopKept();
	});

	it("never delivers a payload the boundary rejects", () => {
		const received: unknown[] = [];
		const stop = guestTransport.subscribe(message => received.push(message));
		deliver({ type: "omp:unknown", text: "restored draft" });
		deliver("not an object");
		deliver({ type: "omp:draft-restore", text: "carriage\rreturn" });
		assert.deepEqual(received, []);
		stop();
	});
});

describe("panel identity persistence", () => {
	// Every other meaningful case needs a document whose stamped id differs, and
	// the module reads its globals once while it is evaluated — so each case loads
	// its own copy. The query string is what makes Node evaluate a second module
	// instance instead of handing back the one above.
	let loads = 0;

	it("persists the tab identity while the document is evaluated, before any link", () => {
		// The load at the top of this file is the document under test here.
		assert.deepEqual(firstDocument.persisted, [{ version: PANEL_IDENTITY_VERSION, tabId: TAB_ID }]);
	});

	it("persists nothing for a document the extension did not stamp", async () => {
		injectPanelGlobals({ stamped: null, canPersistState: true });
		await import(`./bridge.ts?unstamped=${loads++}`);
		assert.deepEqual(persisted, []);
	});

	it("persists nothing for a stamped value this contract refuses", async () => {
		for (const refused of ["", "not-a-tab-id", `${TAB_ID}/../../etc`]) {
			const document = injectPanelGlobals({ stamped: refused, canPersistState: true });
			await import(`./bridge.ts?refused=${loads++}`);
			assert.deepEqual(document.persisted, [], `persisted ${refused}`);
		}
	});

	it("still hosts a panel when the injected API cannot persist state", async () => {
		const document = injectPanelGlobals({ stamped: TAB_ID, canPersistState: false });
		const module = await import(`./bridge.ts?nopersist=${loads++}`);
		assert.equal(module.guestTransport.hosted, true);
		assert.deepEqual(document.persisted, []);
	});

	it("keeps the injected globals in place for the loaded document", () => {
		assert.equal(typeof globalThis.document?.querySelector, "function");
		assert.deepEqual(persisted, []);
		assert.deepEqual(firstDocument.persisted, [{ version: PANEL_IDENTITY_VERSION, tabId: TAB_ID }]);
	});
});
