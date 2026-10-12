/**
 * Tests for the composer popup state the webview reports to the host.
 *
 * Runner: `node --test src/webview/lib/composer-overlay.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composerPopupOpen, reportComposerPopupOpen, subscribeComposerPopupOpen } from "./composer-overlay.ts";

describe("the composer popup state", () => {
	it("tells subscribers about changes, ignores repeats, and stops after release", () => {
		const seen: boolean[] = [];
		const release = subscribeComposerPopupOpen(open => seen.push(open));
		assert.equal(composerPopupOpen(), false);
		// The composer reports on every render of its popup state; only real
		// changes may reach the host, or the report would be re-sent needlessly.
		reportComposerPopupOpen("completion", false);
		reportComposerPopupOpen("completion", true);
		reportComposerPopupOpen("completion", true);
		reportComposerPopupOpen("completion", false);
		assert.deepEqual(seen, [true, false]);
		assert.equal(composerPopupOpen(), false);
		release();
		reportComposerPopupOpen("completion", true);
		assert.deepEqual(seen, [true, false], "a released subscriber must stop receiving");
		reportComposerPopupOpen("completion", false);
	});
	it("keeps Escape reserved until both completion and context popovers are closed", () => {
		const seen: boolean[] = [];
		const release = subscribeComposerPopupOpen(value => seen.push(value));
		reportComposerPopupOpen("completion", true);
		reportComposerPopupOpen("context", true);
		reportComposerPopupOpen("context", false);
		assert.equal(composerPopupOpen(), true);
		assert.deepEqual(seen, [true]);
		reportComposerPopupOpen("context", true);
		reportComposerPopupOpen("completion", false);
		assert.equal(composerPopupOpen(), true);
		reportComposerPopupOpen("context", false);
		assert.deepEqual(seen, [true, false]);
		release();
	});
});
