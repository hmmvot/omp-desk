/**
 * `createRuntimeStaging`: the staging rules that moved out of `extension.ts` (ADR-0066) keep their
 * caching and refusal behaviour. The staged copies are real files under a temporary storage directory.
 *
 * The module resolves extensionless imports the way esbuild does, so it is compiled with the
 * project's bundler.
 *
 * Runner: `node --test src/runtime/runtime-entries.test.ts`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import { recordingLogger } from "../shared/logger.ts";
import type { LoggedLine } from "../shared/logger.ts";
import type { RuntimeStagingDeps, createRuntimeStaging as createRuntimeStagingType } from "./runtime-entries.ts";

let createRuntimeStaging: typeof createRuntimeStagingType;
let temp: string;

before(async () => {
	temp = await mkdtemp(path.join(tmpdir(), "omp-staging-"));
	const outfile = path.join(temp, "runtime-entries.mjs");
	await build({ entryPoints: [fileURLToPath(new URL("./runtime-entries.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm", target: "node20" });
	createRuntimeStaging = ((await import(pathToFileURL(outfile).href)) as { createRuntimeStaging: typeof createRuntimeStagingType }).createRuntimeStaging;
});
after(async () => { await rm(temp, { recursive: true, force: true }); });

async function deps(overrides: Partial<RuntimeStagingDeps> = {}) {
	const packaged = path.join(temp, `packaged-${Math.random().toString(36).slice(2)}`);
	const files = { hostControl: "host-control.mjs", controlHelper: "verified-pipe.ps1", renameHelper: "rename.mjs", runtimeProbe: "runtime-probe.mjs" };
	await mkdir(packaged, { recursive: true });
	for (const name of Object.values(files)) await writeFile(path.join(packaged, name), `content of ${name}`);
	const configured: string[] = [];
	const logs: LoggedLine[] = [];
	const base: RuntimeStagingDeps = {
		storageDir: () => path.join(packaged, "storage"),
		packagedPaths: () => ({
			hostControl: path.join(packaged, files.hostControl), controlHelper: path.join(packaged, files.controlHelper),
			renameHelper: path.join(packaged, files.renameHelper), runtimeProbe: path.join(packaged, files.runtimeProbe),
		}),
		stageNative: async () => ({ kind: "refused", reason: "not staged in this test" }),
		refusal: () => null,
		configureControlHelper: file => { configured.push(file); },
		log: recordingLogger(logs),
	};
	return { deps: { ...base, ...overrides }, configured, logs, packaged, files };
}

describe("runtime staging", () => {
	it("refuses to stage while the packaged files are no longer the ones this host loaded, and does not cache the refusal", async () => {
		let asked = 0;
		const f = await deps({ refusal: () => { asked++; return "updated on disk"; } });
		const staging = createRuntimeStaging(f.deps);
		await assert.rejects(staging.entries(), /updated on disk/);
		await assert.rejects(staging.entries(), /updated on disk/);
		assert.equal(asked, 2, "the next caller asks again instead of reusing the failure");
		assert.deepEqual(f.configured, [], "nothing was staged, so the control helper was not configured");
	});

	it("reports a native module the child refused as no module and logs why, once per attempt", async () => {
		const f = await deps({ stageNative: async () => ({ kind: "refused", reason: "the staged tree is readable by another account" }) });
		const staging = createRuntimeStaging(f.deps);
		assert.equal(await staging.native(), null);
		assert.equal(f.logs.length, 1);
		assert.match(f.logs[0]?.message ?? "", /native module could not be staged: the staged tree is readable by another account/);
		assert.equal(f.logs[0]?.level, "warn");
	});

	it("reports a child that failed to run as no module", async () => {
		const f = await deps({ stageNative: async () => { throw new Error("spawn failed"); } });
		assert.equal(await createRuntimeStaging(f.deps).native(), null);
		assert.match(f.logs[0]?.message ?? "", /native module could not be staged: spawn failed/);
	});

	it("hands out the staged copy while it holds its digest and asks the child again when it does not", async () => {
		const f = await deps();
		const copy = path.join(f.packaged, "staged.node");
		const bytes = Buffer.from("staged koffi");
		await writeFile(copy, bytes);
		let runs = 0;
		const staging = createRuntimeStaging({
			...f.deps,
			stageNative: async () => { runs++; return { kind: "staged", path: copy, sha256: createHash("sha256").update(bytes).digest("hex") }; },
		});
		assert.deepEqual(await staging.native(), { path: copy, sha256: createHash("sha256").update(bytes).digest("hex") });
		await staging.native();
		assert.equal(runs, 1, "an intact copy is reused");
		await writeFile(copy, "tampered");
		await staging.native();
		assert.equal(runs, 2, "a copy that no longer holds its digest is staged again");
	});
});
