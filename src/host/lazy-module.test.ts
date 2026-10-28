import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lazy } from "./lazy-module.ts";

describe("lazy", () => {
	it("does not run the loader until the first call", () => {
		let runs = 0;
		lazy(async () => ++runs);
		assert.equal(runs, 0);
	});

	it("runs the loader once and shares the value among concurrent and later callers", async () => {
		let runs = 0;
		const gate = Promise.withResolvers<void>();
		const get = lazy(async () => {
			runs++;
			await gate.promise;
			return { value: runs };
		});
		const first = get();
		const second = get();
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);
		assert.equal(a, b);
		assert.equal(await get(), a);
		assert.equal(runs, 1);
	});

	it("does not remember a failure: the next caller loads again and sees its own outcome", async () => {
		let runs = 0;
		const get = lazy(async () => {
			if (++runs === 1) throw new Error("first load failed");
			return "loaded";
		});
		await assert.rejects(get(), /first load failed/);
		assert.equal(await get(), "loaded");
		assert.equal(await get(), "loaded");
		assert.equal(runs, 2);
	});

	it("gives every caller of one failing load the same rejection", async () => {
		const gate = Promise.withResolvers<void>();
		const get = lazy(async () => {
			await gate.promise;
			throw new Error("down");
		});
		const callers = [get(), get()];
		gate.resolve();
		for (const result of await Promise.allSettled(callers)) {
			assert.equal(result.status, "rejected");
		}
	});
});
