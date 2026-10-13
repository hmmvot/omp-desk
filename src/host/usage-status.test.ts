import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUsageStatus, formatReadingAge, formatResetCountdown, formatUsageWindow, selectUsageWindows, usageSeverity } from "./usage-status.ts";
import type { UsageStatusSource } from "./usage-status.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const after = (days: number, hours: number, minutes: number): number => NOW + days * D + hours * H + minutes * MIN;
const source = (windows: UsageStatusSource["windows"], extra: Partial<UsageStatusSource> = {}): UsageStatusSource =>
	({ provider: "anthropic", windows, accountSelection: null, readAt: NOW - 3 * MIN, ...extra });

describe("formatResetCountdown", () => {
	it("trims leading zero components and pads inner ones", () => {
		assert.equal(formatResetCountdown(after(2, 3, 5), NOW), "2:03:05");
		assert.equal(formatResetCountdown(after(0, 4, 7), NOW), "4:07");
		assert.equal(formatResetCountdown(after(0, 0, 9), NOW), "9");
		assert.equal(formatResetCountdown(after(1, 0, 0), NOW), "1:00:00");
		assert.equal(formatResetCountdown(after(0, 1, 0), NOW), "1:00");
		assert.equal(formatResetCountdown(after(12, 23, 59), NOW), "12:23:59");
	});

	it("rounds the minutes up so the count never reads 0 before the reset", () => {
		assert.equal(formatResetCountdown(NOW + 1, NOW), "1");
		assert.equal(formatResetCountdown(NOW + 59_999, NOW), "1");
		assert.equal(formatResetCountdown(NOW + MIN, NOW), "1");
		assert.equal(formatResetCountdown(NOW + MIN + 1, NOW), "2");
		assert.equal(formatResetCountdown(after(0, 0, 59) + 1, NOW), "1:00", "59 min and a bit rolls into the hour");
		assert.equal(formatResetCountdown(after(0, 23, 59) + 1, NOW), "1:00:00", "23 h 59 min and a bit rolls into the day");
	});

	it("shows nothing for a reset in the past, now, missing or not a number", () => {
		assert.equal(formatResetCountdown(NOW, NOW), null);
		assert.equal(formatResetCountdown(NOW - 1, NOW), null);
		assert.equal(formatResetCountdown(null, NOW), null);
		assert.equal(formatResetCountdown(undefined, NOW), null);
		assert.equal(formatResetCountdown(Number.NaN, NOW), null);
		assert.equal(formatResetCountdown(Number.POSITIVE_INFINITY, NOW), null);
	});
});

describe("formatUsageWindow", () => {
	it("joins label, rounded percent and countdown", () => {
		assert.equal(formatUsageWindow({ label: "5h", usedPercent: 41.6, resetsAt: after(0, 2, 13) }, NOW), "5h 42% · 2:13");
	});

	it("leaves out a missing percent or a missing/passed reset", () => {
		assert.equal(formatUsageWindow({ label: "5h", usedPercent: undefined, resetsAt: after(0, 2, 13) }, NOW), "5h · 2:13");
		assert.equal(formatUsageWindow({ label: "5h", usedPercent: Number.NaN, resetsAt: after(0, 2, 13) }, NOW), "5h · 2:13");
		assert.equal(formatUsageWindow({ label: "7d", usedPercent: 18, resetsAt: null }, NOW), "7d 18%");
		assert.equal(formatUsageWindow({ label: "7d", usedPercent: 18 }, NOW), "7d 18%");
		assert.equal(formatUsageWindow({ label: "7d", usedPercent: 18, resetsAt: NOW - MIN }, NOW), "7d 18%", "a reset already in the past shows no countdown until the next refresh");
	});

	it("floors a monthly percent like the footer does", () => {
		assert.equal(formatUsageWindow({ label: "monthly", usedPercent: 42.9, resetsAt: null }, NOW), "monthly 42%");
	});
});

describe("selectUsageWindows", () => {
	it("shows 5h then 7d in that order whatever order they arrive in", () => {
		const windows = [{ label: "7d", usedPercent: 18, resetsAt: null }, { label: "5h", usedPercent: 42, resetsAt: null }];
		assert.deepEqual(selectUsageWindows(windows).map(window => window.label), ["5h", "7d"]);
	});

	it("shows what the provider reports when neither 5h nor 7d exists, and never invents the missing one", () => {
		const windows = [{ label: "1d", usedPercent: 10, resetsAt: null }, { label: "monthly", usedPercent: 20, resetsAt: null }];
		assert.deepEqual(selectUsageWindows(windows).map(window => window.label), ["1d", "monthly"]);
		assert.deepEqual(selectUsageWindows([{ label: "5h", usedPercent: 10, resetsAt: null }, ...windows]).map(window => window.label), ["5h"]);
		assert.deepEqual(selectUsageWindows([{ label: "7d", usedPercent: 10, resetsAt: null }]).map(window => window.label), ["7d"]);
	});

	it("skips a window that reports neither a percent nor a reset time", () => {
		assert.deepEqual(selectUsageWindows([{ label: "5h" }, { label: "7d", usedPercent: 5 }]).map(window => window.label), ["7d"]);
		assert.deepEqual(selectUsageWindows([{ label: "5h", usedPercent: null, resetsAt: null }]), []);
	});
});

describe("usageSeverity", () => {
	const at = (usedPercent: number, resetsAt: number | null = null) => [{ label: "5h", usedPercent, resetsAt }];
	it("maps 80 % to warning and 95 % to error, on the percent shown", () => {
		assert.equal(usageSeverity(at(79.4), NOW), "none");
		assert.equal(usageSeverity(at(79.5), NOW), "warning", "79.5 is displayed as 80%");
		assert.equal(usageSeverity(at(80), NOW), "warning");
		assert.equal(usageSeverity(at(94.4), NOW), "warning");
		assert.equal(usageSeverity(at(95), NOW), "error");
		assert.equal(usageSeverity(at(100), NOW), "error");
		assert.equal(usageSeverity([], NOW), "none");
	});

	it("takes the worst of the shown windows", () => {
		assert.equal(usageSeverity([{ label: "5h", usedPercent: 10, resetsAt: null }, { label: "7d", usedPercent: 96, resetsAt: null }], NOW), "error");
		assert.equal(usageSeverity([{ label: "5h", usedPercent: 85, resetsAt: null }, { label: "7d", usedPercent: 20, resetsAt: null }], NOW), "warning");
	});

	it("ignores a window whose reset has passed and one without a percent", () => {
		assert.equal(usageSeverity(at(99, NOW - MIN), NOW), "none");
		assert.equal(usageSeverity(at(99, NOW + MIN), NOW), "error");
		assert.equal(usageSeverity([{ label: "5h", resetsAt: NOW + MIN }], NOW), "none");
	});
});

describe("formatReadingAge", () => {
	it("reads in the largest sensible unit", () => {
		assert.equal(formatReadingAge(NOW - 30_000, NOW), "Read just now");
		assert.equal(formatReadingAge(NOW + MIN, NOW), "Read just now");
		assert.equal(formatReadingAge(NOW - 3 * MIN, NOW), "Read 3 min ago");
		assert.equal(formatReadingAge(NOW - 2 * H - MIN, NOW), "Read 2 h ago");
		assert.equal(formatReadingAge(NOW - 3 * D, NOW), "Read 3 d ago");
		assert.equal(formatReadingAge(null, NOW), "Reading time unknown");
	});
});

describe("buildUsageStatus", () => {
	const local = (epochMs: number): string => `T${(epochMs - NOW) / MIN}`;

	it("produces the user's format for both windows", () => {
		const model = buildUsageStatus(source([
			{ label: "5h", usedPercent: 42, resetsAt: after(0, 2, 13) },
			{ label: "7d", usedPercent: 18, resetsAt: after(3, 4, 0) },
		]), NOW, local);
		assert.equal(model?.text, "5h 42% · 2:13  \u2502  7d 18% · 3:04:00");
		assert.equal(model?.severity, "none");
	});

	it("keeps a missing time or percent out of the text", () => {
		assert.equal(buildUsageStatus(source([{ label: "5h", usedPercent: 42, resetsAt: null }, { label: "7d", usedPercent: 18, resetsAt: after(1, 0, 0) }]), NOW, local)?.text, "5h 42%  \u2502  7d 18% · 1:00:00");
		assert.equal(buildUsageStatus(source([{ label: "5h", resetsAt: after(0, 0, 9) }]), NOW, local)?.text, "5h · 9");
	});

	it("shows other windows in the same style when 5h and 7d are absent", () => {
		assert.equal(buildUsageStatus(source([{ label: "monthly", usedPercent: 61.2, resetsAt: after(10, 2, 0) }]), NOW, local)?.text, "monthly 61% · 10:02:00");
		assert.equal(buildUsageStatus(source([{ label: "1d", usedPercent: 7, resetsAt: after(0, 5, 5) }]), NOW, local)?.text, "1d 7% · 5:05");
	});

	it("is hidden without a provider, a reading or anything to show", () => {
		assert.equal(buildUsageStatus(null, NOW, local), null);
		assert.equal(buildUsageStatus(source([{ label: "5h", usedPercent: 1, resetsAt: null }], { provider: null }), NOW, local), null);
		assert.equal(buildUsageStatus(source([{ label: "5h", usedPercent: 1, resetsAt: null }], { provider: "" }), NOW, local), null);
		assert.equal(buildUsageStatus(source([]), NOW, local), null);
		assert.equal(buildUsageStatus(source([{ label: "5h" }]), NOW, local), null);
	});

	it("shows the percent and no time once a reset has passed, until the next refresh", () => {
		const model = buildUsageStatus(source([{ label: "5h", usedPercent: 97, resetsAt: NOW - MIN }, { label: "7d", usedPercent: 18, resetsAt: after(2, 0, 5) }]), NOW, local);
		assert.equal(model?.text, "5h 97%  \u2502  7d 18% · 2:00:05");
		assert.equal(model?.severity, "none", "the passed window no longer counts");
		assert.match(model?.tooltip ?? "", /5h: 97% used · reset time T-1 has passed; waiting for the next refresh/);
	});

	it("builds the tooltip: provider, windows with local reset times, account note and age", () => {
		const model = buildUsageStatus(source([
			{ label: "5h", usedPercent: 85, resetsAt: after(0, 2, 13) },
			{ label: "7d", usedPercent: 18, resetsAt: null },
		], { accountSelection: "Active account unavailable: showing the first provider report in OMP CLI order." }), NOW, local);
		assert.equal(model?.severity, "warning");
		assert.equal(model?.tooltip, [
			"OMP Desk provider usage: anthropic",
			"5h: 85% used · resets T133 (in 2:13)",
			"7d: 18% used",
			"Active account unavailable: showing the first provider report in OMP CLI order.",
			"Read 3 min ago. Click to refresh.",
		].join("\n"));
	});

	it("marks error at 95 % of any shown window", () => {
		assert.equal(buildUsageStatus(source([{ label: "5h", usedPercent: 12, resetsAt: null }, { label: "7d", usedPercent: 95, resetsAt: null }]), NOW, local)?.severity, "error");
	});
});
