/**
 * Whether the provider served a different model than a reply requested, the way OMP's terminal UI decides it.
 *
 * A textual comparison of the two ids is wrong in both directions (a snapshot suffix or a gateway prefix is the same
 * model; a codename is not comparable at all), so the verdict is the installed OMP's own `classifyModel`, run by the
 * bounded Bun helper `media/served-model.mjs` against the selected install, never a rule kept here. Nothing is read
 * until a page asks, and a failed read answers "unknown" without being remembered as a classification.
 */
import { spawn } from "node:child_process";
import type { ServedModelPair, ServedModelVerdict } from "../chat/served-model.ts";
import { SERVED_MODEL_PAIR_LIMIT } from "../protocol/messages.ts";
import { isRecord } from "../shared/guards.ts";

/** How long the helper may take: it imports the catalog module graph of the installed OMP once. */
const HELPER_TIMEOUT_MS = 30_000;
const MAX_HELPER_OUTPUT = 16 * 1024;

function isVerdict(value: unknown): value is ServedModelVerdict {
	return value === "mismatch" || value === "same" || value === "unknown";
}

/** The helper's JSON answer for `count` pairs, validated; `null` for anything else. */
export function parseServedModelAnswer(value: unknown, count: number): ServedModelVerdict[] | null {
	if (!isRecord(value) || value.ok !== true || !Array.isArray(value.verdicts) || value.verdicts.length !== count) return null;
	const verdicts: ServedModelVerdict[] = [];
	for (const candidate of value.verdicts) {
		if (!isVerdict(candidate)) return null;
		verdicts.push(candidate);
	}
	return verdicts;
}

/** Run the staged helper against one OMP package root; `null` when the verdicts cannot be read. */
export function readServedModels(input: {
	readonly bunPath: string;
	readonly helperPath: string;
	readonly packageRoot: string;
	readonly cwd: string;
	readonly pairs: readonly ServedModelPair[];
}): Promise<ServedModelVerdict[] | null> {
	const { pairs } = input;
	if (pairs.length === 0) return Promise.resolve([]);
	if (pairs.length > SERVED_MODEL_PAIR_LIMIT) return Promise.resolve(null);
	const { promise, resolve } = Promise.withResolvers<ServedModelVerdict[] | null>();
	let output = "";
	let settled = false;
	const finish = (value: ServedModelVerdict[] | null): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(value);
	};
	const child = spawn(input.bunPath, [input.helperPath, "--package-root", input.packageRoot], {
		cwd: input.cwd, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"],
	});
	const timer = setTimeout(() => { child.kill(); finish(null); }, HELPER_TIMEOUT_MS);
	timer.unref?.();
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		output += chunk;
		if (output.length > MAX_HELPER_OUTPUT) { child.kill(); finish(null); }
	});
	// A helper that exits before reading its input closes the pipe: the answer is then the exit, not this error.
	child.stdin.on("error", () => undefined);
	child.on("error", () => finish(null));
	child.on("close", () => {
		const line = output.trim().split(/\r?\n/).findLast(part => part.startsWith("{")) ?? "";
		try { finish(parseServedModelAnswer(JSON.parse(line), pairs.length)); }
		catch { finish(null); }
	});
	child.stdin.end(`${JSON.stringify({ pairs })}\n`);
	return promise;
}

/** Reads the verdicts of the pairs the memo does not hold yet; `null` when they cannot be read. */
export type ServedModelReader = (pairs: ServedModelPair[]) => Promise<ServedModelVerdict[] | null>;

/** Bound on remembered pairs: a transcript holds few distinct (provider, requested, served) triples. */
const MEMO_LIMIT = 512;

/**
 * The verdicts already read, per install: a pair's verdict is a property of the installed classifier, so another
 * install (root or version) starts from nothing. A failed read answers "unknown" for its pairs without remembering
 * it, so a later ask reads again; a successful read remembers every verdict it returned.
 */
export class ServedModelMemo {
	#installKey: string | null = null;
	readonly #verdicts = new Map<string, ServedModelVerdict>();

	/** One verdict per pair, in order. */
	async resolve(installKey: string, pairs: readonly ServedModelPair[], read: ServedModelReader): Promise<ServedModelVerdict[]> {
		if (this.#installKey !== installKey) {
			this.#installKey = installKey;
			this.#verdicts.clear();
		}
		const keyOf = (pair: ServedModelPair): string => `${installKey}\0${pair.provider}\0${pair.requested}\0${pair.served}`;
		// The answer of this ask, whatever the memo ends up holding.
		const answers = new Map<string, ServedModelVerdict>();
		const missing = new Map<string, ServedModelPair>();
		for (const pair of pairs) {
			const key = keyOf(pair);
			const known = this.#verdicts.get(key);
			if (known !== undefined) answers.set(key, known);
			else missing.set(key, pair);
		}
		if (missing.size > 0) {
			const asked = [...missing.values()];
			const verdicts = await read(asked);
			if (verdicts !== null && verdicts.length === asked.length) {
				// The install may have changed while the helper ran: its verdicts then answer this ask only.
				const current = this.#installKey === installKey;
				if (current && this.#verdicts.size + asked.length > MEMO_LIMIT) this.#verdicts.clear();
				asked.forEach((pair, index) => {
					const verdict = verdicts[index] ?? "unknown";
					answers.set(keyOf(pair), verdict);
					if (current) this.#verdicts.set(keyOf(pair), verdict);
				});
			}
		}
		return pairs.map(pair => answers.get(keyOf(pair)) ?? "unknown");
	}
}
