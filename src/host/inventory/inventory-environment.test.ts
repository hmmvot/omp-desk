import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OmpUnavailableError } from "../omp-unavailable.ts";
import { createRuntimeResolver, NO_BUN, noPackageSource, RESOLVE_TTL_MS } from "./inventory-environment.ts";
import type { RuntimeResolution } from "./inventory-environment.ts";

const good: RuntimeResolution = { ok: true, bun: "C:/b/bun.exe", packageRoot: "C:/b/pkg", launcher: "C:/b/omp.exe", release: "18.8.5" };
function harness(results: Array<RuntimeResolution | Error>) {
	const state = { clock: 0, calls: 0, logs: [] as string[], gate: null as Promise<void> | null, key: "" };
	const resolve = createRuntimeResolver({
		now: () => state.clock, log: message => { state.logs.push(message); }, key: () => state.key,
		async resolve() { const next = results[Math.min(state.calls++, results.length - 1)]!; if (state.gate) await state.gate; if (next instanceof Error) throw next; return next; },
	});
	return { state, resolve };
}

describe("runtime resolver", () => {
	it("shares one resolution between concurrent reads and reuses it for a minute", async () => {
		const h = harness([good]);
		let release!: () => void;
		h.state.gate = new Promise<void>(resolve => { release = resolve; });
		const pending = [h.resolve(), h.resolve(), h.resolve()];
		release();
		const answers = await Promise.all(pending);
		assert.equal(h.state.calls, 1);
		assert.deepEqual(answers[0], answers[2]);
		h.state.clock += RESOLVE_TTL_MS;
		await h.resolve();
		assert.equal(h.state.calls, 1);
		h.state.clock += 1;
		await h.resolve();
		assert.equal(h.state.calls, 2);
	});
	it("keeps the earlier answer when a later resolution fails transiently, and says so in the log", async () => {
		const timedOut = new OmpUnavailableError("`omp --version` of C:/b/omp.exe did not finish within 15 s; Desk does not fall back to another OMP", { transientCause: "did not finish within 15 s" });
		const h = harness([good, timedOut, timedOut]);
		await h.resolve();
		h.state.clock += RESOLVE_TTL_MS + 1;
		assert.deepEqual(await h.resolve(), { at: h.state.clock, bun: "C:/b/bun.exe", packageRoot: "C:/b/pkg" });
		h.state.clock += RESOLVE_TTL_MS + 1;
		assert.deepEqual(await h.resolve(), { at: h.state.clock, bun: "C:/b/bun.exe", packageRoot: "C:/b/pkg" });
		assert.equal(h.state.logs.filter(line => /failed after .*\(transient\)/.test(line)).length, 2);
		assert.equal(h.state.logs.filter(line => /keeping the Bun and OMP package found earlier/.test(line)).length, 2);
		assert.equal(h.state.calls, 3, "the kept answer is only reused for the minute, then resolution is tried again");
	});
	it("drops the earlier answer when the failure is definitive: the install it described is no longer what Desk resolves", async () => {
		const h = harness([good, { ok: false, unavailable: noPackageSource("C:/l/omp.exe", "18.8.4") }, good, new Error("No usable OMP launcher was found.\n  - not OMP's program"), good]);
		await h.resolve();
		h.state.clock += RESOLVE_TTL_MS + 1;
		const compiled = await h.resolve();
		assert.match("unavailable" in compiled ? compiled.unavailable : "", /C:\/l\/omp\.exe, release 18\.8\.4/);
		h.state.clock += 1;
		assert.ok("bun" in await h.resolve(), "an unavailable answer is not cached; the next read resolves again");
		h.state.clock += RESOLVE_TTL_MS + 1;
		assert.deepEqual(await h.resolve(), { unavailable: "The installed OMP could not be resolved: No usable OMP launcher was found." });
		assert.equal(h.state.logs.filter(line => /failed after .*\(definitive\)/.test(line)).length, 2);
		assert.equal(h.state.logs.filter(line => /dropping the Bun and OMP package found earlier/.test(line)).length, 2);
		assert.equal(h.state.logs.filter(line => /keeping the Bun and OMP package found earlier/.test(line)).length, 0);
	});
	it("without an earlier answer, names the real cause rather than a generic compiled-only claim", async () => {
		const noBun = await harness([{ ok: false, unavailable: NO_BUN }]).resolve();
		assert.deepEqual(noBun, { unavailable: NO_BUN });
		assert.doesNotMatch(NO_BUN, /compiled/);
		const compiled = await harness([{ ok: false, unavailable: noPackageSource("C:/Users/u/AppData/Local/omp/omp.exe", "18.8.4") }]).resolve();
		assert.match("unavailable" in compiled ? compiled.unavailable : "", /C:\/Users\/u\/AppData\/Local\/omp\/omp\.exe, release 18\.8\.4/);
		const thrown = await harness([new Error("No usable OMP launcher was found. Tried:\n  - `omp --version` did not finish within 15000ms.")]).resolve();
		assert.deepEqual(thrown, { unavailable: "The installed OMP could not be resolved: No usable OMP launcher was found. Tried:" });
	});
	it("a failed resolution is not cached: the next read resolves again", async () => {
		const h = harness([{ ok: false, unavailable: NO_BUN }, good]);
		assert.ok("unavailable" in await h.resolve());
		assert.ok("bun" in await h.resolve());
		assert.equal(h.state.calls, 2);
	});
	it("a change of the explicit OMP path invalidates the answer found for the old one, even across a transient failure", async () => {
		const other: RuntimeResolution = { ok: true, bun: "C:/b/bun.exe", packageRoot: "C:/x/pkg", launcher: "C:/x/omp.exe", release: "18.9.0" };
		const timedOut = new OmpUnavailableError("probe of C:/x/omp.exe timed out", { transientCause: "did not finish within 15 s" });
		const h = harness([good, other, timedOut]);
		assert.ok("packageRoot" in await h.resolve());
		// Still inside the minute, but another OMP is now named: the cached answer is not served.
		h.state.key = "C:/x/omp.exe";
		const changed = await h.resolve();
		assert.equal(h.state.calls, 2);
		assert.ok("packageRoot" in changed && changed.packageRoot === "C:/x/pkg");
		// Resolution of the new OMP times out: the answer for the old OMP is not kept as if it described the new one.
		h.state.clock += RESOLVE_TTL_MS + 1;
		h.state.key = "C:/y/omp.exe";
		assert.deepEqual(await h.resolve(), { unavailable: "The installed OMP could not be resolved: probe of C:/x/omp.exe timed out" });
	});
	describe("two resolutions for different OMP settings finishing in either order", () => {
		function gated() {
			const gates: Array<PromiseWithResolvers<RuntimeResolution | Error>> = [];
			const state = { key: "A", clock: 0 };
			const resolve = createRuntimeResolver({
				now: () => state.clock, log: () => {}, key: () => state.key,
				async resolve() {
					const gate = Promise.withResolvers<RuntimeResolution | Error>();
					gates.push(gate);
					const outcome = await gate.promise;
					if (outcome instanceof Error) throw outcome;
					return outcome;
				},
			});
			return { gates, state, resolve };
		}
		const forB: RuntimeResolution = { ok: true, bun: "C:/b/bun.exe", packageRoot: "C:/x/pkg", launcher: "C:/x/omp.exe", release: "18.9.0" };

		it("an answer for the old setting that arrives late is returned to its caller but never kept, so a timeout of the new one is not answered with it", async () => {
			const h = gated();
			const a = h.resolve();
			h.state.key = "B";
			const b = h.resolve();
			assert.equal(h.gates.length, 2, "each setting has its own resolution");
			h.gates[0]!.resolve(good);
			const late = await a;
			assert.ok("packageRoot" in late && late.packageRoot === "C:/b/pkg");
			h.gates[1]!.resolve(new OmpUnavailableError("probe of B timed out", { transientCause: "did not finish within 15 s" }));
			assert.deepEqual(await b, { unavailable: "The installed OMP could not be resolved: probe of B timed out" });
		});

		it("a late failure of the old setting does not erase the answer already found for the new one", async () => {
			const h = gated();
			const a = h.resolve();
			h.state.key = "B";
			const b = h.resolve();
			h.gates[1]!.resolve(forB);
			assert.ok("packageRoot" in await b);
			h.gates[0]!.resolve(new Error("No usable OMP launcher was found."));
			assert.deepEqual(await a, { unavailable: "The installed OMP could not be resolved: No usable OMP launcher was found." });
			const again = await h.resolve();
			assert.equal(h.gates.length, 2, "the new setting's answer is still cached");
			assert.ok("packageRoot" in again && again.packageRoot === "C:/x/pkg");
		});

		it("when the setting changes away and back, only the latest attempt owns the cache: an older attempt for the same setting neither erases nor overwrites it", async () => {
			for (const late of ["failure", "success"] as const) {
				const h = gated();
				const a1 = h.resolve();
				h.state.key = "B";
				const b = h.resolve();
				h.state.key = "A";
				const a2 = h.resolve();
				assert.equal(h.gates.length, 3, "A, B and A again are three attempts");
				h.gates[2]!.resolve(good);
				assert.ok("packageRoot" in await a2);
				if (late === "failure") h.gates[0]!.resolve(new Error("No usable OMP launcher was found."));
				else h.gates[0]!.resolve({ ...good, packageRoot: "C:/old/pkg" });
				await a1;
				h.gates[1]!.resolve(forB);
				await b;
				const again = await h.resolve();
				assert.equal(h.gates.length, 3, `the newest attempt's answer is still cached after an older one's ${late}`);
				assert.ok("packageRoot" in again && again.packageRoot === "C:/b/pkg");
			}
		});
	});
});
