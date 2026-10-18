/**
 * Whether a reply was served by another model than requested: the helper's answer, the per-install memo, and the
 * verdicts the installed OMP's own classifier gives. Runner: `node --test src/host/served-model.test.ts`.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ServedModelPair, ServedModelVerdict } from "../chat/served-model.ts";
import { parseServedModelAnswer, readServedModels, ServedModelMemo } from "./served-model.ts";

const pair = (requested: string, served: string, provider = "anthropic"): ServedModelPair => ({ provider, requested, served });

describe("the served-model answer", () => {
	it("accepts exactly one verdict literal per asked pair", () => {
		assert.deepEqual(parseServedModelAnswer({ ok: true, verdicts: ["same", "mismatch", "unknown"] }, 3), ["same", "mismatch", "unknown"]);
		assert.equal(parseServedModelAnswer({ ok: true, verdicts: ["same"] }, 2), null, "a missing verdict");
		assert.equal(parseServedModelAnswer({ ok: true, verdicts: ["same", "same"] }, 1), null, "an extra verdict");
		assert.equal(parseServedModelAnswer({ ok: true, verdicts: ["Same"] }, 1), null);
		assert.equal(parseServedModelAnswer({ ok: true, verdicts: [true] }, 1), null);
		assert.equal(parseServedModelAnswer({ ok: false }, 0), null);
		assert.equal(parseServedModelAnswer({ verdicts: ["same"] }, 1), null);
		assert.equal(parseServedModelAnswer({ ok: true, verdicts: "same" }, 1), null);
		assert.equal(parseServedModelAnswer("nope", 1), null);
		assert.equal(parseServedModelAnswer(null, 1), null);
	});
});

describe("the served-model memo", () => {
	/** A reader that answers `mismatch` for ids it was given a `served` of "other", else `same`, and records what it was asked. */
	const reader = () => {
		const asked: ServedModelPair[][] = [];
		return {
			asked,
			read: async (pairs: ServedModelPair[]): Promise<ServedModelVerdict[] | null> => {
				asked.push(pairs);
				return pairs.map(candidate => candidate.served === "other" ? "mismatch" : "same");
			},
		};
	};

	it("reads a pair once per install and answers the repeat from memory", async () => {
		const memo = new ServedModelMemo();
		const fake = reader();
		const pairs = [pair("a", "a-1"), pair("b", "other")];
		assert.deepEqual(await memo.resolve("root-1@1", pairs, fake.read), ["same", "mismatch"]);
		assert.deepEqual(await memo.resolve("root-1@1", [pair("b", "other"), pair("a", "a-1"), pair("c", "c-1")], fake.read), ["mismatch", "same", "same"]);
		assert.deepEqual(fake.asked, [pairs, [pair("c", "c-1")]], "the second ask reads only the new pair");
	});

	it("asks for a pair repeated within one request once, and answers every position", async () => {
		const memo = new ServedModelMemo();
		const fake = reader();
		assert.deepEqual(await memo.resolve("k", [pair("a", "other"), pair("a", "other"), pair("a", "x")], fake.read), ["mismatch", "mismatch", "same"]);
		assert.deepEqual(fake.asked, [[pair("a", "other"), pair("a", "x")]]);
	});

	it("keys on the provider too, so the same ids under another provider are read again", async () => {
		const memo = new ServedModelMemo();
		const fake = reader();
		await memo.resolve("k", [pair("a", "b", "anthropic")], fake.read);
		await memo.resolve("k", [pair("a", "b", "openrouter")], fake.read);
		assert.equal(fake.asked.length, 2);
	});

	it("drops everything when the install changes, and never answers one install's verdicts for another's", async () => {
		const memo = new ServedModelMemo();
		const pairs = [pair("a", "a-1")];
		let verdict: ServedModelVerdict = "same";
		const read = async (asked: ServedModelPair[]): Promise<ServedModelVerdict[]> => asked.map(() => verdict);
		assert.deepEqual(await memo.resolve("root@1", pairs, read), ["same"]);
		verdict = "mismatch";
		assert.deepEqual(await memo.resolve("root@1", pairs, read), ["same"], "the same install keeps its answer");
		assert.deepEqual(await memo.resolve("root@2", pairs, read), ["mismatch"], "a new release reads again");
		verdict = "same";
		assert.deepEqual(await memo.resolve("root@1", pairs, read), ["same"], "going back is a change too");
	});

	it("answers unknown for a failed read, a short answer or a throwing reader, and reads those pairs again next time", async () => {
		const memo = new ServedModelMemo();
		const pairs = [pair("a", "b"), pair("c", "d")];
		assert.deepEqual(await memo.resolve("k", pairs, async () => null), ["unknown", "unknown"]);
		assert.deepEqual(await memo.resolve("k", pairs, async () => ["mismatch"]), ["unknown", "unknown"], "a count that does not match is no answer");
		const fake = reader();
		assert.deepEqual(await memo.resolve("k", pairs, fake.read), ["same", "same"]);
		assert.deepEqual(fake.asked, [pairs], "the failures were not remembered as classifications");
		assert.deepEqual(await memo.resolve("k", pairs, fake.read), ["same", "same"]);
		assert.equal(fake.asked.length, 1, "a successful read is remembered");
		await assert.rejects(memo.resolve("k", [pair("e", "f")], async () => { throw new Error("spawn failed"); }), /spawn failed/, "a reader that throws is the caller's to handle");
		assert.deepEqual(await memo.resolve("k", [pair("e", "f")], fake.read), ["same"], "and nothing was remembered for it");
	});

	it("remembers a genuine unknown verdict: that one is a classification, not a failure", async () => {
		const memo = new ServedModelMemo();
		const asked: number[] = [];
		const read = async (pairs: ServedModelPair[]): Promise<ServedModelVerdict[]> => { asked.push(pairs.length); return pairs.map(() => "unknown"); };
		await memo.resolve("k", [pair("claude-opus-5", "numbat-v6-example")], read);
		await memo.resolve("k", [pair("claude-opus-5", "numbat-v6-example")], read);
		assert.deepEqual(asked, [1]);
	});

	it("does not let a read that finished after an install change poison the new install", async () => {
		const memo = new ServedModelMemo();
		const pairs = [pair("a", "b")];
		let release: () => void = () => undefined;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const slow = memo.resolve("old@1", pairs, async () => { await gate; return ["mismatch"]; });
		assert.deepEqual(await memo.resolve("new@1", pairs, async () => ["same"]), ["same"]);
		release();
		assert.deepEqual(await slow, ["mismatch"], "the old ask still gets its own install's answer");
		assert.deepEqual(await memo.resolve("new@1", pairs, async () => assert.fail("remembered for the new install")), ["same"]);
	});
});

const packageRoot = process.env.OMP_SLASH_TEST_PACKAGE_ROOT ?? path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
const bunPath = process.env.OMP_SLASH_TEST_BUN ?? path.join(os.homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
const helperPath = fileURLToPath(new URL("../../media/served-model.mjs", import.meta.url));
const installed = existsSync(packageRoot) && existsSync(bunPath);

describe("installed OMP classifier", () => {
	it("gives the verdicts of the terminal UI's served-model rule", { skip: !installed, timeout: 60_000 }, async () => {
		const pairs = [
			pair("claude-haiku-4-5", "claude-haiku-4-5-20251001"),
			pair("claude-opus-5", "anthropic/claude-opus-5"),
			pair("anthropic/claude-opus-5", "claude-opus-5", "openrouter"),
			pair("claude-opus-5", "claude-haiku-4-5"),
			pair("anthropic/claude-opus-5", "anthropic/claude-haiku-4-5", "openrouter"),
			pair("claude-opus-5", "numbat-v6-example"),
			pair("claude-opus-5", "claude-opus-5"),
			pair("some-unclassifiable-codename", "some-unclassifiable-codename"),
		];
		const verdicts = await readServedModels({ bunPath, helperPath, packageRoot, cwd: os.tmpdir(), pairs });
		assert.deepEqual(verdicts, [
			"same", // a snapshot suffix: the same class, family and revision
			"same", // a gateway prefix classifies like the bare id
			"same", // ... on both sides and under a router provider
			"mismatch", // another family and revision
			"mismatch", // a substitution through a router
			"unknown", // an internal codename cannot be classified, so it is unverifiable, not a mismatch
			"same", // the identical id never reaches the classifier
			"same",
		]);
	});

	it("answers null for a package root without the catalog, for an empty pair list it asks nothing", { skip: !installed, timeout: 60_000 }, async () => {
		assert.equal(await readServedModels({ bunPath, helperPath, packageRoot: os.tmpdir(), cwd: os.tmpdir(), pairs: [pair("a", "b")] }), null);
		assert.deepEqual(await readServedModels({ bunPath, helperPath, packageRoot, cwd: os.tmpdir(), pairs: [] }), []);
	});

	it("refuses more than the bound of pairs without starting the helper", async () => {
		const many = Array.from({ length: 9 }, (_, index) => pair(`m${index}`, `n${index}`));
		assert.equal(await readServedModels({ bunPath: "does-not-exist", helperPath, packageRoot, cwd: os.tmpdir(), pairs: many }), null);
	});
});
