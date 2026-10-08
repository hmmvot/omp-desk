import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProviderUsageJson, projectProviderUsage, ProviderUsageCache, PROVIDER_USAGE_REFRESH_MS } from "./provider-usage.ts";

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
	const logged: string[] = [];
	const cache = new ProviderUsageCache(() => now, message => logged.push(message));
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
	assert.deepEqual(logged, ["Provider usage refresh failed; retaining the last value."]);
	await cache.refresh("current", "model", run);
	assert.equal(calls, 2);
	await cache.refresh("other", "model", async () => { calls++; return { stdout: json([]), stderr: "", exitCode: 0 }; });
	assert.equal(calls, 3);
});
