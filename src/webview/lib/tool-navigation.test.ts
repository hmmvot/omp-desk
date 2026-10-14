import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HEAD_SELECTOR, isHeadNavigation } from "./tool-navigation.ts";

/** An element that answers `matches` for the head selector only. */
const element = (head: boolean): Element => ({ matches: (selector: string) => head && selector === HEAD_SELECTOR }) as unknown as Element;

describe("head navigation keys", () => {
	it("are arrows, Home and End pressed on a head, and nothing else", () => {
		for (const key of ["ArrowUp", "ArrowDown", "Home", "End"]) {
			assert.equal(isHeadNavigation(key, element(true)), true, key);
			assert.equal(isHeadNavigation(key, element(false)), false, `${key} elsewhere scrolls or edits as before`);
			assert.equal(isHeadNavigation(key, null), false);
		}
		for (const key of ["PageUp", "PageDown", " ", "Enter", "Escape", "ArrowLeft"]) assert.equal(isHeadNavigation(key, element(true)), false, key);
	});
});
