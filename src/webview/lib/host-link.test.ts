import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostLink } from "./host-link.ts";

describe("HostLink", () => {
	it("trusts the panel route until a connection that was up is lost", () => {
		const link = new HostLink();
		assert.equal(link.refuses("omp:chat-prompt"), false, "a page whose bridge never came up is not lost");
		link.noteConnection(true);
		assert.equal(link.refuses("omp:chat-prompt"), false);
	});

	it("refuses every chat command while the connection is lost, and only those", () => {
		const link = new HostLink();
		link.noteConnection(true);
		link.noteConnection(false);
		for (const type of ["omp:chat-prompt", "omp:chat-steer", "omp:chat-follow-up", "omp:chat-abort", "omp:chat-ui-response"]) {
			assert.equal(link.refuses(type), true, type);
		}
		for (const type of ["omp:ready", "omp:control-request", "omp:composer-popup"]) {
			assert.equal(link.refuses(type), false, type);
		}
	});

	it("accepts chat commands again once the connection is back", () => {
		const link = new HostLink();
		link.noteConnection(false);
		link.noteConnection(true);
		assert.equal(link.refuses("omp:chat-prompt"), false);
	});
});
