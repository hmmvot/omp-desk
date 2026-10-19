/** Reading one OMP setting through OMP's own CLI (`src/host/omp-setting-read.ts`). Runner: `node --test src/host/omp-setting-read.test.ts`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readOmpSetting, SETTING_READ_TIMEOUT_MS, TODO_CLEAR_DELAY_SETTING } from "./omp-setting-read.ts";
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
