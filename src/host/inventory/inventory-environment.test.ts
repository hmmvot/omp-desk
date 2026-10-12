import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRuntimeResolver, NO_BUN, noPackageSource, RESOLVE_TTL_MS } from "./inventory-environment.ts";
import type { RuntimeResolution } from "./inventory-environment.ts";

const good: RuntimeResolution = { ok: true, bun: "C:/b/bun.exe", packageRoot: "C:/b/pkg", launcher: "C:/b/omp.exe", release: "18.8.5" };
function harness(results: Array<RuntimeResolution | Error>) {
	const state = { clock: 0, calls: 0, logs: [] as string[], gate: null as Promise<void> | null };
	const resolve = createRuntimeResolver({
		now: () => state.clock, log: message => { state.logs.push(message); },
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
	it("keeps the earlier answer when a later resolution fails, and says so in the log", async () => {
		const h = harness([good, { ok: false, unavailable: noPackageSource("C:/l/omp.exe", "18.8.4") }, new Error("No usable OMP launcher was found.\n  - timed out")]);
		await h.resolve();
		h.state.clock += RESOLVE_TTL_MS + 1;
		assert.deepEqual(await h.resolve(), { at: h.state.clock, bun: "C:/b/bun.exe", packageRoot: "C:/b/pkg" });
		h.state.clock += RESOLVE_TTL_MS + 1;
		assert.ok("bun" in await h.resolve(), "a thrown resolution keeps it too");
		assert.equal(h.state.logs.filter(line => /failed after/.test(line)).length, 2);
		assert.equal(h.state.logs.filter(line => /keeping the Bun and OMP package found earlier/.test(line)).length, 2);
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
});
