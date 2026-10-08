/**
 * The folder-shell owner hint: what the extension host may offer the broker, and what
 * it must refuse to offer.
 *
 * Runner: `node --test src/host/shell-owner.test.ts`
 *
 * Every case is about refusal: an unreadable or nonsensical value must produce no
 * association at all. A hint that guessed (`12abc` -> 12) could match a real, unrelated
 * process, so these tests pin the strict reading.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { folderShellOwnerHint } from "./shell-owner.ts";

describe("folder shell owner hint", () => {
	it("carries the three discovered ids when all of them are usable", () => {
		assert.deepEqual(folderShellOwnerHint({ extensionHostPid: 4242, parentPid: 1000, vscodePid: "999" }), {
			extensionHostPid: 4242,
			parentPid: 1000,
			mainPid: 999,
		});
	});

	it("trims the surrounding whitespace the environment may carry", () => {
		assert.deepEqual(folderShellOwnerHint({ extensionHostPid: 4242, parentPid: 1000, vscodePid: " 999\n" }), {
			extensionHostPid: 4242,
			parentPid: 1000,
			mainPid: 999,
		});
	});

	it("refuses a missing candidate main entirely", () => {
		assert.equal(folderShellOwnerHint({ extensionHostPid: 4242, parentPid: 1000, vscodePid: undefined }), null);
	});

	it("refuses an empty or whitespace-only candidate main", () => {
		for (const value of ["", " ", "\t\n"]) {
			assert.equal(folderShellOwnerHint({ extensionHostPid: 4242, parentPid: 1000, vscodePid: value }), null, value);
		}
	});

	it("refuses a candidate main that is not a plain decimal pid", () => {
		// `Number.parseInt` would read several of these as a number; none of them is one.
		for (const value of ["12abc", "0x10", "1.5", "-5", "+5", "1e3", "999 1000", "abc", "٣"]) {
			assert.equal(folderShellOwnerHint({ extensionHostPid: 4242, parentPid: 1000, vscodePid: value }), null, value);
		}
	});

	it("refuses a candidate main of zero", () => {
		assert.equal(folderShellOwnerHint({ extensionHostPid: 4242, parentPid: 1000, vscodePid: "0" }), null);
	});

	it("refuses a candidate main beyond the safe integer range", () => {
		assert.equal(
			folderShellOwnerHint({ extensionHostPid: 4242, parentPid: 1000, vscodePid: "99999999999999999999" }),
			null,
		);
	});

	it("refuses a candidate main that names this very process", () => {
		// The VS Code main process cannot be the extension host, so this is a stale or
		// foreign value, never an owner.
		assert.equal(folderShellOwnerHint({ extensionHostPid: 4242, parentPid: 1000, vscodePid: "4242" }), null);
	});

	it("refuses an unusable extension-host or parent pid", () => {
		const unusable = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2];
		for (const value of unusable) {
			assert.equal(folderShellOwnerHint({ extensionHostPid: value, parentPid: 1000, vscodePid: "999" }), null, `host ${value}`);
			assert.equal(folderShellOwnerHint({ extensionHostPid: 4242, parentPid: value, vscodePid: "999" }), null, `parent ${value}`);
		}
	});
});
