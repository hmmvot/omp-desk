import assert from "node:assert/strict";
import { test } from "node:test";
import { recordingLogger, type LoggedLine } from "../shared/logger.ts";
import { parseProviderUsageJson, projectProviderUsage, ProviderUsageCache, PROVIDER_USAGE_REFRESH_MS, UsageFailureNotes } from "./provider-usage.ts";

function limit(window: string, usedFraction: number, scope: Record<string, unknown> = {}) {
	return { id: window, window: { id: window, resetsAt: 2_000_000 }, amount: { usedFraction }, scope };
}
const json = (reports: unknown[]) => JSON.stringify({ reports });

test("current provider uses actual existing windows and a single TUI-preferred model group", () => {
	const reading = parseProviderUsageJson(json([
		{ provider: "other", limits: [limit("5h", 1)] },
		{ provider: "current", metadata: { email: "masked*" }, limits: [
			limit("5h", .42), limit("7d", .18), limit("7d", .99, { tier: "fable" }),
			limit("5h", .12, { modelId: "specific" }), limit("monthly", .75, { modelId: "other-model" }),
			{ amount: { usedFraction: 1 } }, { window: { id: "unmeasured" }, amount: { remainingFraction: .1 } },
		] },
	]), "current");
	assert.ok(reading);
	assert.deepEqual(projectProviderUsage(reading, "ordinary").windows.map(window => [window.label, window.usedPercent]), [["5h", 42], ["7d", 18]]);
	assert.deepEqual(projectProviderUsage(reading, "SPECIFIC").windows.map(window => [window.label, window.usedPercent]), [["5h", 12]]);
	assert.deepEqual(parseProviderUsageJson(json([]), "current"), { accounts: [] });
});

test("ambiguous accounts use documented first-report fallback and preserve all masked tooltip windows", () => {
	const reading = parseProviderUsageJson(json([
		{ provider: "current", metadata: { email: "first*" }, limits: [limit("monthly", .421)] },
		{ provider: "current", metadata: { email: "second@example.com" }, limits: [limit("monthly", .8)] },
	]), "current");
	assert.ok(reading);
	const usage = projectProviderUsage(reading, "model");
	assert.deepEqual(usage.windows, [{ label: "monthly", usedPercent: 42.1, resetsAt: 2_000_000 }]);
	assert.deepEqual(usage.accounts.map(account => account.label), ["first*", "account 2"]);
	assert.equal(usage.accounts[1]?.windows[0]?.usedPercent, 80);
	assert.match(usage.accountSelection ?? "", /first provider report/);
	assert.equal(JSON.stringify(usage).includes("second@example.com"), false);
});

test("per-provider attempts coalesce, throttle at five minutes and retain the last reading after errors", async () => {
	let now = 0, calls = 0;
	const logged: LoggedLine[] = [];
	const cache = new ProviderUsageCache(() => now, recordingLogger(logged));
	const pending = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number }>();
	const run = () => { calls++; return pending.promise; };
	const first = cache.refresh("current", "model", run);
	const joined = cache.refresh("current", "model", run);
	assert.equal(calls, 1);
	pending.resolve({ stdout: json([{ provider: "current", limits: [limit("5h", .42)] }]), stderr: "", exitCode: 0 });
	assert.deepEqual(await first, await joined);
	now = PROVIDER_USAGE_REFRESH_MS - 1;
	await cache.refresh("current", "model", run);
	assert.equal(calls, 1);
	now++;
	const result = await cache.refresh("current", "model", async () => { calls++; throw new Error("secret account identity"); });
	assert.equal(calls, 2);
	assert.equal(result.windows[0]?.usedPercent, 42);
	assert.deepEqual(logged, [{ level: "warn", message: "Provider usage refresh failed (Error); retaining the last value." }], "the kind is logged, never the text of the failure");
	await cache.refresh("current", "model", run);
	assert.equal(calls, 2);
	await cache.refresh("other", "model", async () => { calls++; return { stdout: json([]), stderr: "", exitCode: 0 }; });
	assert.equal(calls, 3);
});

test("a forced refresh skips the throttle, joins an in-flight read, and readAt marks only successful reads", async () => {
	let now = 1000, calls = 0;
	const cache = new ProviderUsageCache(() => now);
	const ok = async () => { calls++; return { stdout: json([{ provider: "current", limits: [limit("5h", .42)] }]), stderr: "", exitCode: 0 }; };
	assert.equal(cache.readAt("current"), null);
	await cache.refresh("current", "model", ok);
	assert.equal(cache.readAt("current"), 1000);
	now = 2000;
	await cache.refresh("current", "model", ok);
	assert.equal(calls, 1, "within the throttle");
	await cache.refresh("current", "model", ok, true);
	assert.equal(calls, 2, "forced");
	assert.equal(cache.readAt("current"), 2000);
	now = 3000;
	await cache.refresh("current", "model", async () => { calls++; throw new Error("down"); }, true);
	assert.equal(cache.readAt("current"), 2000, "a failed read keeps the last successful time");
	const pending = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number }>();
	const first = cache.refresh("current", "model", () => { calls++; return pending.promise; }, true);
	const joined = cache.refresh("current", "model", ok, true);
	assert.equal(calls, 4);
	pending.resolve({ stdout: "not json", stderr: "", exitCode: 0 });
	await Promise.all([first, joined]);
	assert.equal(cache.readAt("current"), 2000);
});

test("a failed usage read names its cause, once for each distinct cause per owner", () => {
	const notes = new UsageFailureNotes();
	const tab = {};
	const timeout = new Error("The OMP --version probe did not finish within 15 s");
	assert.equal(
		notes.note(tab, "resolving the OMP executable", timeout),
		"Provider usage: resolving the OMP executable failed (The OMP --version probe did not finish within 15 s); retaining the last value.",
	);
	assert.equal(notes.note(tab, "resolving the OMP executable", timeout), null, "the same cause is not repeated for this tab");
	assert.match(notes.note(tab, "resolving the OMP executable", new Error("No usable OMP launcher was found.")) ?? "", /No usable OMP launcher/);
	assert.match(notes.note(tab, "publishing the usage", timeout) ?? "", /publishing the usage failed/, "a refresh failure is a different cause from a resolution failure");
	assert.notEqual(notes.note({}, "resolving the OMP executable", timeout), null, "another tab says it again");
});

test("a refresh that throws logs why", async () => {
	const lines: LoggedLine[] = [];
	const cache = new ProviderUsageCache(Date.now, recordingLogger(lines));
	await cache.refresh("anthropic", "m", async () => { throw Object.assign(new Error("spawn EPERM for account a@b.c"), { code: "EPERM" }); });
	assert.match(lines.map(line => line.message).join("\n"), /Provider usage refresh failed \(Error EPERM\)/);
});
