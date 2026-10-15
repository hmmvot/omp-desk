/**
 * The one-shot native module stager (ADR-0076 decision 4): a real child, run from the TypeScript
 * source under this runner, stages the installed `koffi.node` into a real storage directory and
 * verifies the tree natively; its verdict is read back. Windows only (the addon is a Windows module).
 *
 * Runner: `node --test src/runtime/native-stage-client.test.ts`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { formatToolSpawn, setToolSpawnObserver, type ToolSpawn } from "../host/tool-spawn-trace.ts";
import { installedAddonAsset } from "../host/win32-test-support.ts";
import { parseVerdict, runNativeStage } from "./native-stage-client.ts";

const ENTRY = fileURLToPath(new URL("./native-stage.ts", import.meta.url));

describe("parseVerdict", () => {
	const digest = "a".repeat(64);
	it("reads a staged verdict and a refusal from the last line", () => {
		assert.deepEqual(parseVerdict(`noise\n${JSON.stringify({ kind: "staged", path: "C:\\x\\koffi.node", sha256: digest })}\n`), { kind: "staged", path: "C:\\x\\koffi.node", sha256: digest });
		assert.deepEqual(parseVerdict(`{"kind":"refused","reason":"no"}`), { kind: "refused", reason: "no" });
	});

	it("refuses everything that is not exactly one verdict", () => {
		for (const text of ["", "not json", "null", "[]", `{"kind":"staged"}`, `{"kind":"staged","path":"p","sha256":"short"}`, `{"kind":"staged","path":1,"sha256":"${digest}"}`, `{"kind":"other"}`, `{"kind":"refused"}`]) {
			assert.equal(parseVerdict(text).kind, "refused", JSON.stringify(text));
		}
	});
});

describe("runNativeStage against a real child", { skip: process.platform !== "win32" }, () => {
	const directories: string[] = [];
	afterEach(async () => {
		setToolSpawnObserver(null);
		for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
	});
	const storage = async (): Promise<string> => {
		const directory = await mkdtemp(path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "omp-native-stage-"));
		directories.push(directory);
		return directory;
	};

	it("stages the packaged module under its digest, verifies the tree, and traces one node spawn", async () => {
		const addon = await installedAddonAsset();
		const storageDir = await storage();
		const traces: ToolSpawn[] = [];
		setToolSpawnObserver(trace => traces.push(trace));
		const verdict = await runNativeStage({ entry: ENTRY, packaged: addon.path, storageDir });
		assert.equal(verdict.kind, "staged", verdict.kind === "refused" ? verdict.reason : "");
		if (verdict.kind !== "staged") return;
		assert.equal(verdict.sha256, addon.sha256);
		assert.ok(verdict.path.startsWith(storageDir), "the copy lives under the storage directory, outside the install folder");
		assert.equal(path.basename(verdict.path), "koffi.node");
		assert.equal(createHash("sha256").update(await readFile(verdict.path)).digest("hex"), addon.sha256);
		assert.deepEqual(traces.map(trace => `${trace.tool} ${trace.purpose} ${trace.outcome}`), ["node native module staging ok"]);
		assert.ok(!formatToolSpawn(traces[0]!).includes(storageDir), "a trace names no path");

		// A second run finds the copy in place and reports the same one.
		assert.deepEqual(await runNativeStage({ entry: ENTRY, packaged: addon.path, storageDir }), verdict);
	});

	it("refuses a packaged file that is not a loadable module and names why", async () => {
		const storageDir = await storage();
		const fake = path.join(storageDir, "fake.node");
		await writeFile(fake, "not a module");
		const verdict = await runNativeStage({ entry: ENTRY, packaged: fake, storageDir: path.join(storageDir, "store") });
		assert.equal(verdict.kind, "refused");
		assert.match(verdict.kind === "refused" ? verdict.reason : "", /native module/);
	});

	it("refuses a packaged file that is missing", async () => {
		const storageDir = await storage();
		const verdict = await runNativeStage({ entry: ENTRY, packaged: path.join(storageDir, "missing.node"), storageDir });
		assert.equal(verdict.kind, "refused");
	});

	it("kills a child that misses its deadline and reports a timeout", async () => {
		const addon = await installedAddonAsset();
		const traces: ToolSpawn[] = [];
		setToolSpawnObserver(trace => traces.push(trace));
		const verdict = await runNativeStage({ entry: ENTRY, packaged: addon.path, storageDir: await storage(), deadlineMs: 1 });
		assert.equal(verdict.kind, "refused");
		assert.match(verdict.kind === "refused" ? verdict.reason : "", /did not answer in 1 ms/);
		assert.equal(traces[0]?.outcome, "timeout");
	});
});
