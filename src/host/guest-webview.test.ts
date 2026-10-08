/**
 * Tests for the documents one OMP editor can show.
 *
 * Two properties matter and neither is visible by reading the render paths:
 *
 * - the chat document's CSP must name at most its own bridge listener as
 *   `connect-src` (and `'none'` when it has no bridge), so a panel cannot reach any
 *   other origin even if its code tried;
 * - a panel with nothing to show must still be able to keep its editor: it gets a
 *   document that permits no network at all, and — when the editor has a session
 *   identity — exactly one nonce-gated inline script that persists that identity
 *   and nothing else, so VS Code restores it after a restart.
 *
 * Runner: `node --test src/host/guest-webview.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as vscode from "vscode";

import { createDetailHtml, createGuestHtml, createShellHtml, createUnavailableGuestHtml } from "./guest-webview.ts";
import { parseDetailMeta } from "../webview/detail-target.ts";
import {
	PANEL_BRIDGE_META,
	PANEL_IDENTITY_META,
	PANEL_IDENTITY_VERSION,
	PANEL_IDENTITY_VERSION_EDITOR,
	SHELL_SLOT_META,
} from "../webview/panel-identity.ts";

const TAB_ID = "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d";
/** The actual editor id (`E`) a dynamic editor's view type names. */
const EDITOR_ID = "5f4d3c2b1a09f8e7d6c5b4a39281706f";

/** The `vscode.Webview` members the factory reads, with nothing else. */
const webview = {
	cspSource: "vscode-webview://0panel",
	asWebviewUri: (uri: { toString(): string }) => ({ toString: () => `https://panel.test${uri.toString()}` }),
} as unknown as vscode.Webview;

/** The `vscode.Uri` members the factory reads, with nothing else. */
const extensionUri = {
	path: "/extension",
	with({ path }: { path: string }) {
		return { path, toString: (): string => path };
	},
} as unknown as vscode.Uri;

/** The document's declared CSP, exactly as a browser would read it. */
function declaredCsp(html: string): string {
	const match = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
	assert.notEqual(match, null, "the document declares no CSP");
	return match?.[1] ?? "";
}

describe("createGuestHtml", () => {
	const html = createGuestHtml(webview, extensionUri, TAB_ID, null);

	it("permits no connection at all when the document has no bridge", () => {
		const csp = declaredCsp(html);
		assert.match(csp, /(?:^|; )connect-src 'none'$/);
		assert.match(csp, /(?:^|; )default-src 'none'/);
		assert.equal(csp.includes("ws://"), false, "no relay origin may remain in the policy");
	});

	it("loads exactly the extension's bundle, under a nonce", () => {
		const scripts = html.match(/<script[^>]*>/g) ?? [];
		assert.equal(scripts.length, 1);
		assert.match(scripts[0] ?? "", /nonce="[^"]+"/);
		assert.match(scripts[0] ?? "", /src="https:\/\/panel\.test\/extension\/media\/guest\.js"/);
	});

	it("stamps the tab identity the guest bootstrap persists", () => {
		assert.match(html, new RegExp(`<meta name="${PANEL_IDENTITY_META}" content="${TAB_ID}" />`));
	});

	it("names this document's own bridge listener in connect-src and its ticket", () => {
		const ticket = { editorId: "a".repeat(32), documentId: "b".repeat(32), bootstrapId: "c".repeat(32), port: 51234 };
		const document = createGuestHtml(webview, extensionUri, TAB_ID, ticket);
		const csp = declaredCsp(document);
		assert.match(csp, /(?:^|; )connect-src http:\/\/127\.0\.0\.1:51234 ws:\/\/127\.0\.0\.1:51234$/);
		assert.match(document, new RegExp(`<meta name="${PANEL_BRIDGE_META}" content="${"a".repeat(32)}\\.${"b".repeat(32)}\\.${"c".repeat(32)}\\.51234" />`));
		// No other loopback port is reachable.
		assert.equal(csp.includes("127.0.0.1:51235"), false);
	});
});

describe("createUnavailableGuestHtml", () => {
	it("keeps a legacy static editor restorable with no network permission at all", () => {
		const html = createUnavailableGuestHtml("The relay is not available.", { tabId: TAB_ID, editorId: null });
		const csp = declaredCsp(html);
		assert.equal(csp.includes("connect-src"), false);
		assert.match(csp, /(?:^|; )default-src 'none'/);
		assert.match(html, new RegExp(`<meta name="${PANEL_IDENTITY_META}" content="${TAB_ID}" />`));
		// Exactly one script, nonce-gated, and it persists the identity and nothing
		// else — no link, no key, no generic state API.
		const scripts = html.match(/<script[^>]*>.*?<\/script>/gs) ?? [];
		assert.equal(scripts.length, 1);
		assert.match(scripts[0] ?? "", /nonce="[^"]+"/);
		assert.match(
			scripts[0] ?? "",
			new RegExp(`setState\\(\\{"version":${PANEL_IDENTITY_VERSION},"tabId":"${TAB_ID}"\\}\\)`),
		);
		assert.equal(/link|token|secret|key/i.test(scripts[0] ?? ""), false);
	});

	it("persists the version-2 identity a dynamic editor's view type names", () => {
		const html = createUnavailableGuestHtml("The relay is not available.", { tabId: TAB_ID, editorId: EDITOR_ID });
		// The regression this defends: a fallback document that saved the version-1
		// identity on a dynamic editor made that editor unrecognizable at its next
		// restart, because the dynamic serializer requires the editor id.
		const scripts = html.match(/<script[^>]*>.*?<\/script>/gs) ?? [];
		assert.equal(scripts.length, 1);
		assert.match(
			scripts[0] ?? "",
			new RegExp(`setState\\(\\{"version":${PANEL_IDENTITY_VERSION_EDITOR},"tabId":"${TAB_ID}","editorId":"${EDITOR_ID}"\\}\\)`),
		);
		assert.equal(scripts[0]?.includes(`"version":${PANEL_IDENTITY_VERSION},`), false, "a dynamic editor must not save the version-1 state");
		assert.equal(/link|token|secret|key/i.test(scripts[0] ?? ""), false);
	});

	it("shows the reason without letting it become markup", () => {
		const html = createUnavailableGuestHtml('The relay <script>alert("x")</script> failed & stopped.', {
			tabId: TAB_ID,
			editorId: EDITOR_ID,
		});
		assert.match(html, /&lt;script&gt;alert\("x"\)&lt;\/script&gt; failed &amp; stopped\./);
		assert.equal(html.includes("<script>alert"), false);
	});

	it("persists nothing for an editor whose identity it cannot use", () => {
		const refused = [
			undefined,
			{ tabId: "", editorId: null },
			{ tabId: "not-a-tab-id", editorId: null },
			{ tabId: "tab:", editorId: null },
			// A dynamic editor with an editor id this contract refuses persists nothing
			// rather than falling back to the weaker version-1 identity.
			{ tabId: TAB_ID, editorId: "not-an-editor-id" },
			{ tabId: "not-a-tab-id", editorId: EDITOR_ID },
		] as const;
		for (const identity of refused) {
			const html = createUnavailableGuestHtml("The relay is not available.", identity);
			assert.equal(html.includes(PANEL_IDENTITY_META), false, `stamped ${JSON.stringify(identity)}`);
			assert.equal(html.includes("<script"), false, `scripted ${JSON.stringify(identity)}`);
			// Scripts would have to come from the document's own nonce, and this
			// document carries none.
			const csp = declaredCsp(html);
			assert.match(csp, /(?:^|; )script-src 'nonce-[^']+'$/);
			assert.equal(csp.includes("unsafe-inline"), false);
		}
	});
});

const SHELL_SLOT = "shell:8c2f0f0a-1c2b-4f3e-9a4d-5e6f708192a3";

describe("createShellHtml", () => {
	const html = createShellHtml(webview, extensionUri, SHELL_SLOT);

	it("loads the shell bundle under a nonce and reaches no origin at all", () => {
		const scripts = html.match(/<script[^>]*>/g) ?? [];
		assert.equal(scripts.length, 1);
		assert.match(scripts[0] ?? "", /nonce="[^"]+"/);
		assert.match(scripts[0] ?? "", /src="https:\/\/panel\.test\/extension\/media\/shell\.js"/);
		const csp = declaredCsp(html);
		// The shell pane talks only over the panel message channel, so it must not
		// be able to open a socket even if its own code tried.
		assert.match(csp, /(?:^|; )connect-src 'none'/);
		assert.match(csp, /(?:^|; )style-src 'nonce-[^']+' vscode-webview:\/\/0panel(?:;|$)/);
	});

	it("stamps the durable shell slot the serializer recovers", () => {
		assert.match(html, new RegExp(`<meta name="${SHELL_SLOT_META}" content="${SHELL_SLOT}" />`));
	});

	it("stamps no slot for an identity this contract refuses", () => {
		for (const slotId of ["", "shell:", "shell:not-a-uuid", TAB_ID, "shell:8C2F0F0A-1C2B-4F3E-9A4D-5E6F708192A3-extra"]) {
			const refused = createShellHtml(webview, extensionUri, slotId);
			assert.equal(refused.includes(SHELL_SLOT_META), false, `stamped ${JSON.stringify(slotId)}`);
		}
	});
});

describe("createDetailHtml", () => {
	it("shares the chat policy but reaches no origin, and restores nothing", () => {
		const detail = createDetailHtml(webview, extensionUri, { kind: "todo" });
		const csp = declaredCsp(detail);
		assert.match(csp, /(?:^|; )connect-src 'none'$/);
		const chat = declaredCsp(createGuestHtml(webview, extensionUri, TAB_ID, null));
		const strip = (policy: string): string => policy.replace(/'nonce-[^']+'/g, "NONCE");
		assert.equal(strip(csp), strip(chat), "the same nonce-gated policy, including style attributes");
		assert.equal(detail.includes(PANEL_IDENTITY_META), false, "no identity: VS Code has nothing to restore");
		assert.equal(detail.includes(PANEL_BRIDGE_META), false);
		assert.equal((detail.match(/<script[^>]*>/g) ?? []).length, 1);
		assert.match(detail, /<meta name="omp-detail" content="todo" \/>/);
	});

	it("names an agent by a percent-encoded id that cannot close the attribute", () => {
		const id = `Anna" onload="x & <y> ${"\u00e9"}`;
		const detail = createDetailHtml(webview, extensionUri, { kind: "agent", agentId: id });
		const content = /<meta name="omp-detail" content="([^"]*)" \/>/.exec(detail)?.[1] ?? "";
		assert.deepEqual(parseDetailMeta(content), { kind: "agent", agentId: id });
		assert.equal(/onload=/.test(detail), false);
		assert.equal(parseDetailMeta("agent:%E0%A4%A"), null);
		assert.equal(parseDetailMeta("agent:"), null);
		assert.equal(parseDetailMeta("plan"), null);
	});
});
