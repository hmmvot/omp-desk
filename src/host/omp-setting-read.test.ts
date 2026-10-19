/** Reading OMP settings through OMP's own CLI (`src/host/omp-setting-read.ts`). Runner: `node --test src/host/omp-setting-read.test.ts`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readOmpSetting, readOmpSettings, SETTING_READ_TIMEOUT_MS, TODO_CLEAR_DELAY_SETTING } from "./omp-setting-read.ts";
import type { OmpCliResult, OmpCommand } from "./native-terminal.ts";

const executable: OmpCommand = { command: "omp-bin", prefixArgs: ["prefix.js"] };

function reading(result: Partial<OmpCliResult> | Error) {
	const calls: { args: readonly string[]; timeoutMs: number; options: { cwd?: string; env?: Readonly<Record<string, string>> } }[] = [];
	const read = () => readOmpSetting({
		executable, cwd: "D:\\project", env: { OMP_PROFILE: "work" }, key: TODO_CLEAR_DELAY_SETTING,
		run: async (_executable, args, timeoutMs, options) => {
			calls.push({ args, timeoutMs, options });
			if (result instanceof Error) throw result;
			return { stdout: "", stderr: "", exitCode: 0, ...result };
		},
	});
	return { calls, read };
}

describe("readOmpSetting", () => {
	it("asks OMP's CLI for the key as JSON, in the session's folder and profile, and returns the value as OMP prints it", async () => {
		const answer = JSON.stringify({ key: TODO_CLEAR_DELAY_SETTING, value: 300, type: "number", description: "Delay" }, null, 2);
		const { calls, read } = reading({ stdout: `${answer}\n` });
		assert.equal(await read(), 300);
		assert.deepEqual(calls, [{ args: ["config", "get", "tasks.todoClearDelay", "--json"], timeoutMs: SETTING_READ_TIMEOUT_MS, options: { cwd: "D:\\project", env: { OMP_PROFILE: "work" } } }]);
		assert.equal(await reading({ stdout: JSON.stringify({ key: TODO_CLEAR_DELAY_SETTING, value: -1 }) }).read(), -1);
		assert.equal(await reading({ stdout: JSON.stringify({ key: TODO_CLEAR_DELAY_SETTING, value: "soon" }) }).read(), "soon", "the caller judges the value");
	});

	it("rejects when OMP fails, prints no JSON, or answers for another setting, and never puts OMP's output into the error", async () => {
		await assert.rejects(reading({ exitCode: 1, stdout: "secret-token", stderr: "secret-token" }).read(), error => error instanceof Error && error.message === "omp config get tasks.todoClearDelay exited with 1");
		await assert.rejects(reading({ stdout: "secret-token" }).read(), error => error instanceof Error && error.message === "omp config get tasks.todoClearDelay printed no JSON");
		await assert.rejects(reading({ stdout: JSON.stringify({ key: "other.key", value: 1 }) }).read(), /another setting/);
		await assert.rejects(reading({ stdout: JSON.stringify({ key: TODO_CLEAR_DELAY_SETTING }) }).read(), /another setting/);
		await assert.rejects(reading({ stdout: "[1]" }).read(), /another setting/);
		await assert.rejects(reading(new Error("spawn failed")).read(), /spawn failed/);
	});
});

function listing(result: Partial<OmpCliResult> | Error, keys: readonly string[] = ["magicKeywords.enabled", "magicKeywords.ultrathink", "magicKeywords.workflow"]) {
	const calls: { args: readonly string[]; timeoutMs: number; options: { cwd?: string; env?: Readonly<Record<string, string>> } }[] = [];
	const read = () => readOmpSettings({
		executable, cwd: "D:\\project", env: { OMP_PROFILE: "work" }, keys,
		run: async (_executable, args, timeoutMs, options) => {
			calls.push({ args, timeoutMs, options });
			if (result instanceof Error) throw result;
			return { stdout: "", stderr: "", exitCode: 0, ...result };
		},
	});
	return { calls, read };
}

describe("readOmpSettings", () => {
	it("asks OMP's CLI for the whole list once, in the session's folder and profile, and returns only the requested keys that carry a value", async () => {
		const list = {
			"magicKeywords.enabled": { value: true, type: "boolean", description: "Master" },
			"magicKeywords.ultrathink": { value: false, type: "boolean", description: "One" },
			"magicKeywords.workflow": { type: "boolean", description: "Listed without a value" },
			"magicKeywords.jevify": { value: true, type: "boolean", description: "Not asked for" },
			[TODO_CLEAR_DELAY_SETTING]: { value: 300, type: "number", description: "Not asked for" },
		};
		const { calls, read } = listing({ stdout: `${JSON.stringify(list, null, 2)}\n` }, ["magicKeywords.enabled", "magicKeywords.ultrathink", "magicKeywords.workflow", "magicKeywords.orchestrate"]);
		assert.deepEqual(await read(), { "magicKeywords.enabled": true, "magicKeywords.ultrathink": false });
		assert.deepEqual(calls, [{ args: ["config", "list", "--json"], timeoutMs: SETTING_READ_TIMEOUT_MS, options: { cwd: "D:\\project", env: { OMP_PROFILE: "work" } } }]);
	});

	it("returns nothing for keys an OMP without the settings does not list", async () => {
		assert.deepEqual(await listing({ stdout: JSON.stringify({ [TODO_CLEAR_DELAY_SETTING]: { value: 300 } }) }).read(), {});
		assert.deepEqual(await listing({ stdout: "{}" }).read(), {});
		assert.deepEqual(await listing({ stdout: JSON.stringify({ "magicKeywords.enabled": "on" }) }).read(), {}, "an entry that is not an object has no value");
	});

	it("rejects when OMP fails, prints no JSON, or prints no object, and never puts OMP's output into the error", async () => {
		await assert.rejects(listing({ exitCode: 1, stdout: "secret-token", stderr: "secret-token" }).read(), error => error instanceof Error && error.message === "omp config list exited with 1");
		await assert.rejects(listing({ stdout: "secret-token" }).read(), error => error instanceof Error && error.message === "omp config list printed no JSON");
		await assert.rejects(listing({ stdout: "[1]" }).read(), /not print an object/);
		await assert.rejects(listing({ stdout: "null" }).read(), /not print an object/);
		await assert.rejects(listing({ stdout: "\"secret-token\"" }).read(), error => error instanceof Error && !error.message.includes("secret-token"));
		await assert.rejects(listing(new Error("spawn failed")).read(), /spawn failed/);
	});
});
