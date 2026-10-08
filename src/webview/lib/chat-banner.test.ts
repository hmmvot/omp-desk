/**
 * Tests for the one line a conversation shows about its state.
 *
 * The rule defended: a failure is shown as a fixed sentence chosen by a bounded code, never
 * as text the child or a newer host supplied, and a state the page cannot map is shown as
 * the generic sentence rather than as nothing.
 *
 * Runner: `node --test src/webview/lib/chat-banner.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChatModel } from "../../chat/model.ts";
import type { ChatModel, ChatPhase } from "../../chat/model.ts";
import { RPC_ERROR_SENTENCES } from "../../host/rpc/protocol.ts";
import { chatBanner, errorSentence } from "./chat-banner.ts";

function model(phase: ChatPhase, patch: Partial<ChatModel> = {}): ChatModel {
	return { ...createChatModel(), phase, ...patch };
}

describe("chatBanner", () => {
	it("says nothing about a live, writable conversation", () => {
		assert.equal(chatBanner(model("live")), null);
	});

	it("shows the host's reason for a live conversation it locked", () => {
		assert.deepEqual(chatBanner(model("live", { readOnlyReason: "Another window controls this session." })), {
			level: "warn",
			icon: "warning",
			text: "Another window controls this session.",
		});
	});

	it("maps a failure code to its fixed sentence and offers Reconnect only for a recoverable one", () => {
		assert.deepEqual(chatBanner(model("failed", { code: "ready-timeout" })), {
			level: "error",
			icon: "error",
			text: RPC_ERROR_SENTENCES["ready-timeout"],
			action: "reconnect",
		});
		assert.deepEqual(chatBanner(model("failed", { code: "brand-new-code" })), { level: "error", icon: "error", text: errorSentence("brand-new-code") });
		assert.equal(chatBanner(model("failed", { code: null }))?.action, undefined);
	});

	it("shows the generic sentence for a code it does not know, never the code itself", () => {
		const banner = chatBanner(model("failed", { code: "brand-new-code" }));
		assert.equal(banner?.text, errorSentence("brand-new-code"));
		assert.ok(!banner?.text.includes("brand-new-code"));
		assert.equal(errorSentence("constructor"), errorSentence(null), "an inherited property name is not a code");
	});

	it("names every phase in which the composer cannot be used", () => {
		for (const phase of ["starting", "attaching", "resyncing", "stopped", "failed", "view-only", "legacy"] as const) {
			const banner = chatBanner(model(phase));
			assert.ok(banner !== null && banner.text.length > 0, phase);
		}
	});

	it("overrides host details and failure codes when Resume is available", () => {
		for (const phase of ["stopped", "view-only"] as const) {
			const banner = chatBanner(model(phase, { code: "ready-timeout", readOnlyReason: "HOST_INTERNAL_STOPPED_INTENT" }));
			assert.equal(banner?.icon, "debug-stop");
			assert.equal(banner?.action, undefined);
			assert.doesNotMatch(banner?.text ?? "", /HOST_INTERNAL|timeout|changing|stopping/);
			assert.match(banner?.text ?? "", /Resume/);
		}
		assert.match(chatBanner(model("legacy"))?.text ?? "", /Close the tab/);
	});
});
