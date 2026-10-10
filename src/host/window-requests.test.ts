/**
 * Asking another window to select a session's tab (ADR-0056), against a real temporary
 * directory: a request reaches only the holder it names, is answered once, expires, ignores
 * forged files, and is planned only against a holder that is another live window.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
	REQUEST_TTL_MS,
	WINDOW_REQUEST_DIRECTORY,
	awaitSwitchAnswer,
	planWindowSwitch,
	postSwitchRequest,
	startRequestWatch,
	withdrawSwitchRequest,
	windowUriIdentity,
} from "./window-requests.ts";
import type { RequestWatch, ServeContext, ServeOutcome, SwitchRequest } from "./window-requests.ts";
import type { OpenWindow } from "./window-registry.ts";

const SELECTED: ServeOutcome = { ok: true, focused: true };
const REFUSED: ServeOutcome = { ok: false, focused: false };

describe("window requests", () => {
	let storage: string;
	let directory: string;
	const watches: RequestWatch[] = [];

	before(() => {
		storage = fs.mkdtempSync(path.join(os.tmpdir(), "omp-window-requests-"));
		directory = path.join(storage, WINDOW_REQUEST_DIRECTORY);
	});

	afterEach(() => {
		for (const watch of watches.splice(0)) watch.dispose();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	after(() => {
		fs.rmSync(storage, { recursive: true, force: true });
	});

	/** Serve as `holderId`, recording what reached it; `answer` is what the window answers. */
	function owner(holderId: string, answer: ServeOutcome | ((request: SwitchRequest, context: ServeContext) => Promise<ServeOutcome>) = SELECTED, now?: () => number) {
		const served: SwitchRequest[] = [];
		const errors: string[] = [];
		const watch = startRequestWatch(storage, holderId, async (request, context) => {
			served.push(request);
			return typeof answer === "function" ? await answer(request, context) : answer;
		}, { debounceMs: 20, onError: detail => errors.push(detail), ...(now === undefined ? {} : { now }) });
		watches.push(watch);
		return { served, errors, watch };
	}

	// The platform file watcher is the thing under test; its events arrive when they arrive.
	async function until(predicate: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
		assert.ok(predicate(), "the awaited condition never came true");
	}

	const post = (to: string, tabId = "tab:1", now?: () => number) =>
		postSwitchRequest(storage, { to, from: "holder-a", tabId, incarnation: "inc-1" }, now);

	it("reaches only the holder it names, which selects the tab and answers", async () => {
		const target = owner("holder-b");
		const bystander = owner("holder-c");
		const id = await post("holder-b");
		assert.equal(await awaitSwitchAnswer(storage, "holder-b", id, { timeoutMs: 5_000, pollMs: 20 }), "served");
		assert.equal(target.served.length, 1);
		assert.deepEqual([target.served[0]!.tabId, target.served[0]!.incarnation, target.served[0]!.from], ["tab:1", "inc-1", "holder-a"]);
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.deepEqual(bystander.served, [], "a request addressed to another holder is none of this window's business");
		assert.deepEqual(fs.readdirSync(directory), [], "the request and its response are both cleaned up");
	});

	it("serves a request that was waiting before the owner's watcher started, once", async () => {
		const id = await post("holder-b");
		const target = owner("holder-b");
		assert.equal(await awaitSwitchAnswer(storage, "holder-b", id, { timeoutMs: 5_000, pollMs: 20 }), "served");
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.equal(target.served.length, 1);
	});

	it("recovers a request whose watch event was dropped when told to look again", async () => {
		const target = owner("holder-b");
		// Written by hand with the platform watcher unable to see it in time: rescan is the recovery.
		fs.mkdirSync(directory, { recursive: true });
		const request = { version: 1, id: "id-late", to: "holder-b", from: "holder-a", tabId: "tab:1", incarnation: "inc-1", binding: null, createdAt: new Date().toISOString() };
		fs.writeFileSync(path.join(directory, "holder-b.id-late.request"), JSON.stringify(request));
		target.watch.rescan();
		await until(() => target.served.length === 1);
		await until(() => fs.existsSync(path.join(directory, "holder-b.id-late.response")));
	});

	it("reports a refusal when the owner no longer has the tab", async () => {
		owner("holder-b", REFUSED);
		const id = await post("holder-b", "tab:gone");
		assert.equal(await awaitSwitchAnswer(storage, "holder-b", id, { timeoutMs: 5_000, pollMs: 20 }), "refused");
	});

	it("reports a window that selected the tab but is not in front", async () => {
		owner("holder-b", { ok: true, focused: false });
		const id = await post("holder-b");
		assert.equal(await awaitSwitchAnswer(storage, "holder-b", id, { timeoutMs: 5_000, pollMs: 20 }), "unfocused");
	});

	it("reports a refusal, not a crash, when serving throws", async () => {
		const target = owner("holder-b", async () => { throw new Error("editor exploded"); });
		const id = await post("holder-b");
		assert.equal(await awaitSwitchAnswer(storage, "holder-b", id, { timeoutMs: 5_000, pollMs: 20 }), "refused");
		assert.ok(target.errors.some(detail => detail.includes("editor exploded")));
	});

	it("times out when nobody serves it, and withdraws the request so a late owner does not act on it", async () => {
		const id = await post("holder-asleep");
		assert.equal(await awaitSwitchAnswer(storage, "holder-asleep", id, { timeoutMs: 100, pollMs: 20 }), "timeout");
		const late = owner("holder-asleep");
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.deepEqual(late.served, []);
	});

	it("tells a server that is mid-request that the requester gave up, so it does not act late", async () => {
		let release!: () => void;
		const held = new Promise<void>(resolve => { release = resolve; });
		let wantedAtTheBoundary: boolean | null = null;
		const target = owner("holder-b", async (_request, context) => {
			await held;
			wantedAtTheBoundary = await context.stillWanted();
			return wantedAtTheBoundary ? SELECTED : REFUSED;
		});
		const id = await post("holder-b");
		await until(() => target.served.length === 1);
		assert.equal(await awaitSwitchAnswer(storage, "holder-b", id, { timeoutMs: 50, pollMs: 10 }), "timeout", "the requester gives up and withdraws");
		release();
		await until(() => wantedAtTheBoundary !== null);
		assert.equal(wantedAtTheBoundary, false);
	});

	it("withdraws a request on demand, so a slow focus change cannot leave it actionable", async () => {
		const id = await post("holder-late");
		await withdrawSwitchRequest(storage, "holder-late", id);
		const late = owner("holder-late");
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.deepEqual(late.served, [], "the owner starting after the withdrawal finds nothing to act on");
		assert.deepEqual(fs.readdirSync(directory), []);
	});

	it("serves at most four requests at once however many arrive, and every one in the end", async () => {
		let active = 0;
		let peak = 0;
		const target = owner("holder-busy", async () => {
			peak = Math.max(peak, ++active);
			await new Promise(resolve => setTimeout(resolve, 40));
			active--;
			return SELECTED;
		});
		for (let at = 0; at < 24; at++) await post("holder-busy", `tab:${at}`);
		target.watch.rescan();
		await until(() => target.served.length === 24);
		assert.ok(peak <= 4, `at most four handlers ran at once, saw ${peak}`);
		assert.equal(new Set(target.served.map(request => request.id)).size, 24);
	});

	it("never serves a request twice for as long as it could still be acted on, even after many others completed", async () => {
		const target = owner("holder-b");
		const first = await post("holder-b", "tab:first");
		await until(() => target.served.length === 1);
		const name = `holder-b.${first}.request`;
		const original = { version: 1, id: first, to: "holder-b", from: "holder-a", tabId: "tab:first", incarnation: "inc-1", binding: null, createdAt: new Date().toISOString() };
		for (let at = 0; at < 300; at++) await post("holder-b", `tab:${at}`);
		await until(() => target.served.length === 301);
		// The first request's cleanup "failed": its file is back, and it is not served again.
		fs.writeFileSync(path.join(directory, name), `${JSON.stringify(original)}\n`);
		target.watch.rescan();
		await until(() => !fs.existsSync(path.join(directory, name)));
		assert.equal(target.served.length, 301);
	});

	it("never serves a request older than its lifetime or stamped far in the future", async () => {
		let clock = Date.parse("2026-10-10T10:00:00.000Z");
		const stale = await post("holder-b", "tab:1", () => clock);
		const future = await post("holder-b", "tab:2", () => clock + 3_600_000);
		clock += REQUEST_TTL_MS + 1;
		const target = owner("holder-b", SELECTED, () => clock);
		await until(() => fs.readdirSync(directory).length === 0);
		assert.deepEqual(target.served, []);
		assert.ok(stale.length > 0 && future.length > 0);
	});

	it("ignores forged requests: a name that disagrees with the body, a bad shape, an oversized body", async () => {
		const target = owner("holder-b");
		const write = (name: string, body: unknown) => fs.writeFileSync(path.join(directory, name), typeof body === "string" ? body : JSON.stringify(body));
		fs.mkdirSync(directory, { recursive: true });
		const base = { version: 1, from: "holder-a", tabId: "tab:1", incarnation: "inc-1", createdAt: new Date().toISOString() };
		write("holder-b.id-1.request", { ...base, id: "id-1", to: "holder-c" });
		write("holder-b.id-2.request", { ...base, id: "other-id", to: "holder-b" });
		write("holder-b.id-3.request", { ...base, id: "id-3", to: "holder-b", incarnation: "not an incarnation!" });
		write("holder-b.id-4.request", { ...base, id: "id-4", to: "holder-b", tabId: "" });
		write("holder-b.id-5.request", "{ not json");
		write("holder-b.id-6.request", "x".repeat(64 * 1024));
		await until(() => fs.readdirSync(directory).filter(name => name.endsWith(".request")).length === 0);
		assert.deepEqual(target.served, []);
		assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith(".response")), []);
	});

	it("does not take an uncorrelated or oversized response for the owner's answer", async () => {
		const id = await post("holder-b");
		const response = path.join(directory, `holder-b.${id}.response`);
		const answer = awaitSwitchAnswer(storage, "holder-b", id, { timeoutMs: 600, pollMs: 20 });
		fs.writeFileSync(response, JSON.stringify({ version: 1, id: "someone-elses-request", ok: true, focused: true }));
		await new Promise(resolve => setTimeout(resolve, 100));
		fs.writeFileSync(response, JSON.stringify({ ok: true }));
		await new Promise(resolve => setTimeout(resolve, 100));
		fs.writeFileSync(response, "x".repeat(64 * 1024));
		assert.equal(await answer, "timeout", "none of those is an answer, so the wait ends without one");
	});

	it("refuses to post for an id that could name another file", async () => {
		await assert.rejects(postSwitchRequest(storage, { to: "../escape", from: "holder-a", tabId: "tab:1", incarnation: "inc-1" }), TypeError);
		await assert.rejects(postSwitchRequest(storage, { to: "holder-b", from: "holder-a", tabId: "tab:1", incarnation: "bad incarnation" }), TypeError);
		await assert.rejects(postSwitchRequest(storage, { to: "holder-b", from: "holder-a", tabId: "t".repeat(201), incarnation: "inc-1" }), TypeError);
		await assert.rejects(postSwitchRequest(storage, { to: "holder-b", from: "holder-a", tabId: "tab:1", incarnation: "inc-1", binding: "no spaces allowed" }), TypeError);
	});

	it("carries the binding generation the requester saw, or null when it saw none", async () => {
		const target = owner("holder-b");
		await post("holder-b");
		await until(() => target.served.length === 1);
		assert.equal(target.served[0]!.binding, null);
		await postSwitchRequest(storage, { to: "holder-b", from: "holder-a", tabId: "tab:2", incarnation: "inc-1", binding: "slot.7" });
		await until(() => target.served.length === 2);
		assert.equal(target.served[1]!.binding, "slot.7");
	});
});

describe("planning a switch to the window that holds a session", () => {
	const window = (holderId: string, windowUri: string | null, here = false): OpenWindow => ({
		holderId, here, startedAt: "2026-10-10T09:00:00.000Z", windowUri, label: holderId, folders: [], liveCwds: [], rows: {},
	});
	const claim = (overrides: Partial<{ holderId: string | null; windowUri: string | null }> = {}) =>
		({ holderId: "holder-b", windowUri: null, ...overrides });
	const input = (overrides: Partial<Parameters<typeof planWindowSwitch>[0]> = {}): Parameters<typeof planWindowSwitch>[0] =>
		({ claim: claim(), incarnation: "inc-1", claimHolderAlive: true, ownHolderId: "holder-a", windows: [], ...overrides });

	it("switches to a live other window by its registered URI, requesting the run this catalog records", () => {
		const plan = planWindowSwitch(input({ windows: [window("holder-a", "file:///a", true), window("holder-b", "file:///b")] }));
		assert.deepEqual(plan, { kind: "switch", holderId: "holder-b", incarnation: "inc-1", uri: "file:///b" });
	});

	it("is stale when the claim is gone, held by this window, unverifiable or by a holder that is not alive", () => {
		const windows = [window("holder-b", "file:///b")];
		for (const patch of [
			{ claim: null },
			{ claim: claim({ holderId: "holder-a" }) },
			{ claimHolderAlive: false },
			{ claim: claim({ holderId: null }) },
			{ incarnation: null },
		]) assert.deepEqual(planWindowSwitch(input({ windows, ...patch })), { kind: "stale" });
	});

	it("falls back to the claim's URI only for an owner with no registry record", () => {
		const fallback = planWindowSwitch(input({ claim: claim({ windowUri: "file:///old" }) }));
		assert.deepEqual(fallback, { kind: "switch", holderId: "holder-b", incarnation: "inc-1", uri: "file:///old" });
		const authoritativeNull = planWindowSwitch(input({ claim: claim({ windowUri: "file:///old" }), windows: [window("holder-b", null)] }));
		assert.deepEqual(authoritativeNull, { kind: "manual", holderId: "holder-b", incarnation: "inc-1", reason: "no-uri" }, "a record that says the window is now unsaved overrides the claim's stale URI");
	});

	it("does not focus a window it cannot tell from another with the same URI, however the URI is spelled", () => {
		const same = planWindowSwitch(input({ windows: [window("holder-b", "file:///same"), window("holder-c", "file:///same")] }));
		assert.deepEqual(same, { kind: "manual", holderId: "holder-b", incarnation: "inc-1", reason: "ambiguous" });
		const spelled = planWindowSwitch(input({ windows: [window("holder-b", "file:///c%3A/Work/App"), window("holder-c", "file:///c%3a/work/app/")] }));
		assert.deepEqual(spelled, { kind: "manual", holderId: "holder-b", incarnation: "inc-1", reason: "ambiguous" }, "case, percent-encoding and a trailing slash name the same folder on Windows");
		const distinct = planWindowSwitch(input({ windows: [window("holder-b", "file:///c%3A/work/app"), window("holder-c", "file:///c%3A/work/app2")] }));
		assert.equal(distinct.kind, "switch");
	});

	it("never dispatches a non-file URI", () => {
		const foreign = planWindowSwitch(input({ claim: claim({ windowUri: "vscode://run/command" }) }));
		assert.deepEqual(foreign, { kind: "manual", holderId: "holder-b", incarnation: "inc-1", reason: "no-uri" });
		assert.equal(windowUriIdentity("https://example.invalid/x"), null);
		assert.equal(windowUriIdentity("not a uri"), null);
	});
});
