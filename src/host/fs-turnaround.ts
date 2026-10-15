/**
 * Measures, for a few seconds after activation, how long one file-system call takes to come back.
 *
 * A startup step that is a chain of small file operations (the broker state check, a claim, a catalog write) takes the sum
 * of their turnarounds, and the log only ever showed the sum. An asynchronous call waits in the process's one pool of four
 * file-system threads behind everything every extension in the host has queued, and for the event loop to run its
 * callback; a synchronous call waits for neither and shows only what the volume itself costs. Sampling both on a fixed
 * tick tells those apart: a slow asynchronous call beside a fast synchronous one is a queue, and two slow ones are the
 * volume (a scanner or a busy disk), which no change of call style removes. Diagnostic only; nothing reads the result.
 */
import * as fs from "node:fs";
import { performance } from "node:perf_hooks";
import type { Logger } from "../shared/logger";

export interface FsTurnaroundOptions {
	/** Receives the one summary line, as `info`. */
	readonly log: Logger;
	/** A path that exists; one `stat` of it is the sample. */
	readonly target: string;
	/** How many ticks to sample. Default 40. */
	readonly samples?: number;
	/** Milliseconds between ticks. Default 250. */
	readonly intervalMs?: number;
	/** Test seams. */
	readonly statAsync?: (target: string) => Promise<unknown>;
	readonly statSync?: (target: string) => unknown;
	readonly now?: () => number;
}

/** The median and the largest of the samples, whole milliseconds, or `n/a` when there are none. */
function summary(values: readonly number[]): string {
	if (values.length === 0) return "n/a";
	const sorted = [...values].sort((left, right) => left - right);
	return `median ${Math.round(sorted[Math.floor(sorted.length / 2)]!)} ms, max ${Math.round(sorted[sorted.length - 1]!)} ms`;
}

/** An asynchronous sample at least this slow is listed with its moment, so a queue can be matched with what the log says ran then. */
const SLOW_SAMPLE_MS = 100;
/** How many slow samples the line names. */
const SLOWEST_LISTED = 3;

/** The slowest samples, each with the offset from the probe's start at which it began; empty when none was slow. */
function slowest(samples: readonly { readonly at: number; readonly took: number }[]): string {
	const slow = samples.filter(sample => sample.took >= SLOW_SAMPLE_MS).sort((left, right) => right.took - left.took).slice(0, SLOWEST_LISTED);
	return slow.length === 0 ? "" : `; slowest asynchronous stats: ${slow.map(sample => `${Math.round(sample.took)} ms at +${Math.round(sample.at)} ms`).join(", ")}`;
}

/** Sample the file system's turnaround and log one summary line when the last tick has run. Returns the function that stops it. */
export function startFsTurnaroundProbe(options: FsTurnaroundOptions): () => void {
	const total = options.samples ?? 40;
	const intervalMs = options.intervalMs ?? 250;
	const now = options.now ?? (() => performance.now());
	const startedAt = now();
	const statAsync = options.statAsync ?? ((target: string) => fs.promises.stat(target));
	const statSync = options.statSync ?? ((target: string) => fs.statSync(target));
	const asynchronous: { at: number; took: number }[] = [];
	const synchronous: number[] = [];
	let ticks = 0;
	let settled = 0;
	let stopped = false;

	const report = (): void => {
		if (stopped) return;
		stopped = true;
		options.log.info(
			`window timing: startup file-system turnaround over ${ticks} samples every ${intervalMs} ms (asynchronous stat: ${summary(asynchronous.map(sample => sample.took))}; synchronous stat: ${summary(synchronous)})${slowest(asynchronous)}`,
		);
	};
	const timer = setInterval(() => {
		if (stopped) return;
		ticks++;
		const begin = now();
		try {
			statSync(options.target);
			synchronous.push(now() - begin);
		} catch {
			/* an unreadable target is one missing sample */
		}
		const asyncBegin = now();
		const finish = (): void => {
			settled++;
			if (ticks >= total && settled >= ticks) report();
		};
		void Promise.resolve(statAsync(options.target)).then(
			() => { asynchronous.push({ at: asyncBegin - startedAt, took: now() - asyncBegin }); finish(); },
			finish,
		);
		if (ticks >= total) clearInterval(timer);
	}, intervalMs);
	timer.unref();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
