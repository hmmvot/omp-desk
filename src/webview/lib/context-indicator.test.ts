import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFooterMetadata } from "../footer-metadata.ts";
import { contextTokenLabel, quotaWindowLabel, sessionCostLabel } from "./context-indicator.ts";

const metadata = { type: "omp:footer-metadata", provider: "native", branch: "main", windows: [], accounts: [], accountSelection: null };

describe("native context details", () => {
	it("formats compact token units and session dollars to two decimals", () => {
		assert.equal(`${contextTokenLabel(132000)} / ${contextTokenLabel(1000000)} tokens`, "132k / 1M tokens");
		assert.equal(contextTokenLabel(12500), "12.5k");
		assert.equal(contextTokenLabel(999), "999");
		assert.equal(sessionCostLabel(12.345), "Session cost $12.35");
	});
	it("keeps unknown token counts distinct from reported zero", () => {
		assert.equal(contextTokenLabel(undefined), "?");
		assert.equal(contextTokenLabel(0), "0");
	});
	it("omits unavailable, unpriced and malformed cost without losing other native metadata", () => {
		for (const sessionCost of [undefined, 0, "0.42", Infinity]) {
			const parsed = parseFooterMetadata({ ...metadata, sessionCost });
			assert.ok(parsed);
			assert.equal(parsed.branch, "main");
			assert.equal(sessionCostLabel(parsed.sessionCost), null);
		}
		assert.equal(sessionCostLabel(parseFooterMetadata({ ...metadata, sessionCost: 0.42 })?.sessionCost), "Session cost $0.42");
	});
	it("preserves reported model availability without inventing it from absent or malformed metadata", () => {
		assert.equal(parseFooterMetadata(metadata)?.hasAvailableModels, undefined);
		for (const hasAvailableModels of [true, false]) {
			assert.equal(parseFooterMetadata({ ...metadata, hasAvailableModels })?.hasAvailableModels, hasAvailableModels);
		}
		assert.equal(parseFooterMetadata({ ...metadata, hasAvailableModels: "false" }), null);
	});
	it("formats reset countdowns across minute, hour and day boundaries from native timestamps", () => {
		const now = 1800000000000;
		const label = (minutes: number): string => quotaWindowLabel({ label: "5h", usedPercent: 7, resetsAt: now + minutes * 60000 }, now);
		assert.equal(label(0.5), "5h · 7% used · resets in 1m");
		assert.equal(label(59), "5h · 7% used · resets in 59m");
		assert.equal(label(60), "5h · 7% used · resets in 1h");
		assert.equal(label(134), "5h · 7% used · resets in 2h 14m");
		assert.equal(label(1439), "5h · 7% used · resets in 23h 59m");
		assert.equal(label(1440), "5h · 7% used · resets in 1d");
		assert.equal(label(3 * 1440 + 5 * 60), "5h · 7% used · resets in 3d 5h");
	});
	it("omits an unreported reset instead of assuming the window length, and marks expired resets pending refresh", () => {
		const now = 1800000000000;
		assert.equal(quotaWindowLabel({ label: "7d", usedPercent: 42, resetsAt: null }, now), "7d · 42% used");
		assert.equal(quotaWindowLabel({ label: "5h", usedPercent: 7, resetsAt: now }, now), "5h · 7% used · resets now / refreshing");
		assert.equal(quotaWindowLabel({ label: "5h", usedPercent: 7, resetsAt: now - 1 }, now), "5h · 7% used · resets now / refreshing");
	});
});
