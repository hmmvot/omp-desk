/**
 * Regression tests for detecting a reinstall under a running extension host.
 *
 * Runner: `node --test src/host/package-drift.test.ts`
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { PackageDrift } from "./package-drift.ts";

const FILES = ["out/extension.js", "media/guest.js"] as const;
const roots: string[] = [];

after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function installedPackage(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-drift-"));
	roots.push(root);
	await mkdir(path.join(root, "out"), { recursive: true });
	await mkdir(path.join(root, "media"), { recursive: true });
	await writeFile(path.join(root, "out/extension.js"), "host build A");
	await writeFile(path.join(root, "media/guest.js"), "guest build A");
	return root;
}

async function watching(root: string): Promise<PackageDrift> {
	const drift = new PackageDrift(root, [...FILES, "out/not-in-this-build.mjs"]);
	await drift.capture();
	return drift;
}

describe("PackageDrift", () => {
	it("reports nothing until the activation baseline exists", async () => {
		const root = await installedPackage();
		const drift = new PackageDrift(root, FILES);
		await writeFile(path.join(root, "media/guest.js"), "guest build B");
		assert.deepEqual(drift.check(), { kind: "same" });
	});

	it("is the same while the package is untouched, and ignores files the build never had", async () => {
		const drift = await watching(await installedPackage());
		assert.deepEqual(drift.check(), { kind: "same" });
	});

	it("reports the file a reinstall replaced with other bytes — the guest a new document would load", async () => {
		const root = await installedPackage();
		const drift = await watching(root);
		await writeFile(path.join(root, "media/guest.js"), "guest build B, protocol unchanged");
		assert.deepEqual(drift.check(), { kind: "changed", files: ["media/guest.js"] });
		// A second look at the same unchanged file gives the same answer without a different verdict.
		assert.deepEqual(drift.check(), { kind: "changed", files: ["media/guest.js"] });
	});

	it("does not call a byte-identical reinstall drift, even though every timestamp moved", async () => {
		const root = await installedPackage();
		const drift = await watching(root);
		const later = new Date(Date.now() + 60_000);
		for (const file of FILES) {
			await writeFile(path.join(root, file), file === "out/extension.js" ? "host build A" : "guest build A");
			await utimes(path.join(root, file), later, later);
		}
		assert.deepEqual(drift.check(), { kind: "same" });
	});

	it("reports a file that vanished, which is what an install in progress looks like", async () => {
		const root = await installedPackage();
		const drift = await watching(root);
		await rm(path.join(root, "out/extension.js"));
		assert.deepEqual(drift.check(), { kind: "changed", files: ["out/extension.js"] });
	});

	it("returns to the same when the original bytes are restored", async () => {
		const root = await installedPackage();
		const drift = await watching(root);
		await writeFile(path.join(root, "media/guest.js"), "guest build B");
		const first = new Date(Date.now() + 30_000);
		await utimes(path.join(root, "media/guest.js"), first, first);
		assert.equal(drift.check().kind, "changed");
		await writeFile(path.join(root, "media/guest.js"), "guest build A");
		const later = new Date(Date.now() + 120_000);
		await utimes(path.join(root, "media/guest.js"), later, later);
		assert.deepEqual(drift.check(), { kind: "same" });
	});
});
