/**
 * Reload All Windows' request to another window, against a real temporary directory: a reload request reaches only
 * the window it names, is taken up (claimed) before it is answered, makes the window reload exactly once and only
 * after the request is gone, is never acted on past its lifetime, and a requester can tell a window that took it up
 * from one that deleted it unanswered (an older build) and from one that never saw it.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
	RELOAD_REQUEST_TTL_MS,
	WINDOW_REQUEST_DIRECTORY,
	awaitReloadTakenUp,
	postReloadRequest,
	postSwitchRequest,
	requestTtlMs,
	startRequestWatch,
} from "./window-requests.ts";
import type { RequestWatch, ServeContext, ServeOutcome, WindowRequest } from "./window-requests.ts";

describe("reload requests between windows", () => {
	let storage: string;
	let directory: string;
	const watches: RequestWatch[] = [];

	before(() => {
		storage = fs.mkdtempSync(path.join(os.tmpdir(), "omp-reload-requests-"));
		directory = path.join(storage, WINDOW_REQUEST_DIRECTORY);
	});

	afterEach(() => {
		for (const watch of watches.splice(0)) watch.dispose();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	after(() => {
		fs.rmSync(storage, { recursive: true, force: true });
	});

	const files = (suffix: string): string[] => (fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith(suffix)) : []);

	/**
	 * A window that serves reload requests the way the routing does: it answers and asks for its reload to run afterwards.
	 * `reloads` counts the reloads it ran; `filesAtReload` is what the directory held at that moment.
	 */
	function window(holderId: string, options: { now?: () => number; serve?: (context: ServeContext) => Promise<void> } = {}) {
		const served: WindowRequest[] = [];
		const reloads: string[][] = [];
		const watch = startRequestWatch(storage, holderId, async (request, context): Promise<ServeOutcome> => {
			served.push(request);
			await options.serve?.(context);
			return { ok: true, focused: false, afterAnswer: () => { reloads.push(fs.readdirSync(directory).filter(name => name.startsWith(`${holderId}.`))); } };
		}, { debounceMs: 20, ...(options.now === undefined ? {} : { now: options.now }) });
		watches.push(watch);
		return { served, reloads, watch };
	}

	// Real watcher and real files: the waits are real and short.
	async function pause(ms: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, ms);
		await promise;
	}

	async function until(predicate: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await pause(25);
		assert.ok(predicate(), "the awaited condition never came true");
	}

	it("makes each window it is posted to reload exactly once, and no other window", async () => {
		const first = window("holder-b");
		const second = window("holder-c");
		const bystander = window("holder-d");
		const ids = await Promise.all(["holder-b", "holder-c"].map(to => postReloadRequest(storage, { to, from: "holder-a" })));
		const answers = await Promise.all(["holder-b", "holder-c"].map((to, at) => awaitReloadTakenUp(storage, to, ids[at]!, { pollMs: 10 })));
		assert.deepEqual(answers, ["taken-up", "taken-up"]);
		await until(() => first.reloads.length === 1 && second.reloads.length === 1);
		await pause(200);
		assert.deepEqual([first.reloads.length, second.reloads.length, bystander.served.length], [1, 1, 0]);
		assert.deepEqual(first.served.map(request => [request.kind, request.from]), [["reload", "holder-a"]]);
	});

	it("reloads only after the request is taken out of the directory, so the restarted window finds nothing to act on", async () => {
		const target = window("holder-b");
		const id = await postReloadRequest(storage, { to: "holder-b", from: "holder-a" });
		await until(() => target.reloads.length === 1);
		assert.deepEqual(target.reloads[0]!.filter(name => name.endsWith(".request") || name.endsWith(".accepted")), [], "request and take-up record are gone when the reload runs");
		assert.deepEqual(files(".request"), []);
		// A window that starts afterwards, as the reloaded one does, serves nothing for it.
		const restarted = window("holder-b");
		await pause(200);
		assert.deepEqual(restarted.served, []);
		assert.equal(await awaitReloadTakenUp(storage, "holder-b", id, { pollMs: 10 }), "taken-up", "the answer it wrote is still there for the requester");
		assert.deepEqual(files(".response"), [], "the requester removes the answer");
	});

	it("is taken up before the window has finished serving it: the requester stops waiting while the window is still busy", async () => {
		const gate = Promise.withResolvers<void>();
		const target = window("holder-b", { serve: () => gate.promise });
		const id = await postReloadRequest(storage, { to: "holder-b", from: "holder-a" });
		assert.equal(await awaitReloadTakenUp(storage, "holder-b", id, { pollMs: 10, timeoutMs: 3_000 }), "taken-up");
		assert.deepEqual(files(".accepted"), [`holder-b.${id}.accepted`]);
		assert.deepEqual(target.reloads, [], "not before the window answered");
		gate.resolve();
		await until(() => target.reloads.length === 1);
	});

	it("never reloads a window for a request older than its lifetime", async () => {
		let clock = Date.parse("2026-10-13T10:00:00.000Z");
		await postReloadRequest(storage, { to: "holder-b", from: "holder-a" }, () => clock);
		clock += RELOAD_REQUEST_TTL_MS + 1;
		const target = window("holder-b", { now: () => clock });
		await until(() => files(".request").length === 0);
		await pause(100);
		assert.deepEqual([target.served, target.reloads, files(".accepted"), files(".response")], [[], [], [], []]);
		assert.equal(requestTtlMs({ kind: "reload" }), RELOAD_REQUEST_TTL_MS);
		assert.ok(RELOAD_REQUEST_TTL_MS <= requestTtlMs({ kind: "select" }), "no longer than a tab selection");
	});

	it("withdraws a request nobody took up at the bound, so a window that wakes later never reloads for it", async () => {
		const id = await postReloadRequest(storage, { to: "holder-asleep", from: "holder-a" });
		assert.equal(await awaitReloadTakenUp(storage, "holder-asleep", id, { timeoutMs: 80, pollMs: 10 }), "timeout");
		assert.deepEqual(files(".request"), [], "withdrawn");
		const late = window("holder-asleep");
		await pause(150);
		assert.deepEqual([late.served, late.reloads], [[], []]);
	});

	it("tells a window that deleted the request unanswered (an older build) from one that took it up, at once", async () => {
		const id = await postReloadRequest(storage, { to: "holder-old", from: "holder-a" });
		const started = Date.now();
		const pending = awaitReloadTakenUp(storage, "holder-old", id, { timeoutMs: 5_000, pollMs: 10 });
		// A window of a build that does not know the kind deletes the file and writes nothing.
		fs.rmSync(path.join(directory, `holder-old.${id}.request`));
		assert.equal(await pending, "unanswered");
		assert.ok(Date.now() - started < 2_000, "did not wait for the bound");
	});

	it("posts only to a holder id a window can be addressed by", async () => {
		await assert.rejects(postReloadRequest(storage, { to: "../escape", from: "holder-a" }), TypeError);
		await assert.rejects(postReloadRequest(storage, { to: "holder-b", from: "a b" }), TypeError);
	});

	it("takes a selection up like any other kind, and removes the evidence once it is answered", async () => {
		const target = window("holder-b");
		await postSwitchRequest(storage, { to: "holder-b", from: "holder-a", tabId: "tab:x", incarnation: "g_none", binding: null });
		await until(() => target.served.length === 1);
		assert.equal(target.served[0]!.kind, "select");
		await until(() => files(".accepted").length === 0);
	});
});
