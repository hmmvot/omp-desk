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
	LAUNCH_REQUEST_TTL_MS,
	PENDING_LAUNCH_DIRECTORY,
	PENDING_LAUNCH_TTL_MS,
	REQUEST_TTL_MS,
	WINDOW_REQUEST_DIRECTORY,
	awaitPendingLaunchAnswer,
	awaitRequestAnswer,
	pendingKeyOf,
	planFolderLaunch,
	planWindowFocus,
	planWindowSwitch,
	postLaunchRequest,
	postPendingLaunch,
	postSwitchRequest,
	requestTtlMs,
	startPendingLaunchWatch,
	startRequestWatch,
	withdrawPendingLaunch,
	withdrawRequest,
	windowUriIdentity,
} from "./window-requests.ts";
import type { FolderWindow, LaunchAction, LaunchRequest, RequestWatch, ServeContext, ServeOutcome, SwitchRequest, WindowRequest } from "./window-requests.ts";
import type { OpenWindow } from "./window-registry.ts";

const WS = { path: "C:/work/app", match: "folder" } as const;
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
	function owner(holderId: string, answer: ServeOutcome | ((request: WindowRequest, context: ServeContext) => Promise<ServeOutcome>) = SELECTED, now?: () => number) {
		const served: WindowRequest[] = [];
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
		assert.equal(await awaitRequestAnswer(storage, "holder-b", id, { timeoutMs: 5_000, pollMs: 20 }), "served");
		assert.equal(target.served.length, 1);
		const first = target.served[0] as SwitchRequest;
		assert.deepEqual([first.tabId, first.incarnation, first.from], ["tab:1", "inc-1", "holder-a"]);
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.deepEqual(bystander.served, [], "a request addressed to another holder is none of this window's business");
		assert.deepEqual(fs.readdirSync(directory), [], "the request and its response are both cleaned up");
	});

	it("serves a request that was waiting before the owner's watcher started, once", async () => {
		const id = await post("holder-b");
		const target = owner("holder-b");
		assert.equal(await awaitRequestAnswer(storage, "holder-b", id, { timeoutMs: 5_000, pollMs: 20 }), "served");
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.equal(target.served.length, 1);
	});

	it("recovers a request whose watch event was dropped when told to look again", async () => {
		const target = owner("holder-b");
		// Written by hand with the platform watcher unable to see it in time: rescan is the recovery.
		fs.mkdirSync(directory, { recursive: true });
		const request = { version: 1, kind: "select", id: "id-late", to: "holder-b", from: "holder-a", tabId: "tab:1", incarnation: "inc-1", binding: null, createdAt: new Date().toISOString() };
		fs.writeFileSync(path.join(directory, "holder-b.id-late.request"), JSON.stringify(request));
		target.watch.rescan();
		await until(() => target.served.length === 1);
		await until(() => fs.existsSync(path.join(directory, "holder-b.id-late.response")));
	});

	it("reports a refusal when the owner no longer has the tab", async () => {
		owner("holder-b", REFUSED);
		const id = await post("holder-b", "tab:gone");
		assert.equal(await awaitRequestAnswer(storage, "holder-b", id, { timeoutMs: 5_000, pollMs: 20 }), "refused");
	});

	it("reports a window that selected the tab but is not in front", async () => {
		owner("holder-b", { ok: true, focused: false });
		const id = await post("holder-b");
		assert.equal(await awaitRequestAnswer(storage, "holder-b", id, { timeoutMs: 5_000, pollMs: 20 }), "unfocused");
	});

	it("reports a refusal, not a crash, when serving throws", async () => {
		const target = owner("holder-b", async () => { throw new Error("editor exploded"); });
		const id = await post("holder-b");
		assert.equal(await awaitRequestAnswer(storage, "holder-b", id, { timeoutMs: 5_000, pollMs: 20 }), "refused");
		assert.ok(target.errors.some(detail => detail.includes("editor exploded")));
	});

	it("times out when nobody serves it, and withdraws the request so a late owner does not act on it", async () => {
		const id = await post("holder-asleep");
		assert.equal(await awaitRequestAnswer(storage, "holder-asleep", id, { timeoutMs: 100, pollMs: 20 }), "timeout");
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
		assert.equal(await awaitRequestAnswer(storage, "holder-b", id, { timeoutMs: 50, pollMs: 10 }), "timeout", "the requester gives up and withdraws");
		release();
		await until(() => wantedAtTheBoundary !== null);
		assert.equal(wantedAtTheBoundary, false);
	});

	it("withdraws a request on demand, so a slow focus change cannot leave it actionable", async () => {
		const id = await post("holder-late");
		await withdrawRequest(storage, "holder-late", id);
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
		const answer = awaitRequestAnswer(storage, "holder-b", id, { timeoutMs: 600, pollMs: 20 });
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
		assert.equal((target.served[0] as SwitchRequest).binding, null);
		await postSwitchRequest(storage, { to: "holder-b", from: "holder-a", tabId: "tab:2", incarnation: "inc-1", binding: "slot.7" });
		await until(() => target.served.length === 2);
		assert.equal((target.served[1] as SwitchRequest).binding, "slot.7");
	});

	describe("launch requests", () => {
		const NEW: LaunchAction = { kind: "new-session", folderId: "folder:abc-123" };
		const OPEN: LaunchAction = { kind: "open-session", tabId: "tab:1", verb: "resumed", mode: "terminal" };

		it("reaches only the window it names, once, carrying exactly what to start", async () => {
			const target = owner("holder-b");
			const bystander = owner("holder-c");
			const id = await postLaunchRequest(storage, { to: "holder-b", from: "holder-a", workspace: WS, launch: OPEN });
			assert.equal(await awaitRequestAnswer(storage, "holder-b", id, { timeoutMs: 5_000, pollMs: 20 }), "served");
			assert.equal(target.served.length, 1);
			const request = target.served[0]!;
			assert.equal(request.kind, "launch");
			assert.deepEqual(request.kind === "launch" ? request.launch : null, OPEN);
			assert.equal(request.from, "holder-a");
			await new Promise(resolve => setTimeout(resolve, 100));
			assert.deepEqual(bystander.served, [], "a launch is never started by a window it was not addressed to");
		});

		it("tells a refusal that is definite because the window runs an older build from an ordinary one, and from a forged one", async () => {
			const older = owner("holder-b", { ok: false, focused: false, refusal: "stale-build" });
			const id = await postLaunchRequest(storage, { to: "holder-b", from: "holder-a", workspace: WS, launch: NEW });
			assert.equal(await awaitRequestAnswer(storage, "holder-b", id, { timeoutMs: 5_000, pollMs: 20 }), "stale-build");
			assert.equal(older.served.length, 1);
			// An answer that is not a refusal never carries a reason, and an unknown reason is no answer at all.
			const directory = path.join(storage, "window-requests");
			const forged = async (name: string, body: object) => {
				fs.writeFileSync(path.join(directory, `holder-x.${name}.response`), JSON.stringify({ version: 1, id: name, focused: false, ...body }));
				return await awaitRequestAnswer(storage, "holder-x", name, { timeoutMs: 300, pollMs: 20 });
			};
			assert.equal(await forged("id-forged-1", { ok: true, refusal: "stale-build" }), "timeout");
			assert.equal(await forged("id-forged-2", { ok: false, refusal: "who-knows" }), "timeout");
			assert.equal(await forged("id-forged-3", { ok: false }), "refused", "a build that predates reasons sends none");
		});

		it("answers a refusal as refused and a window that never answers as a timeout, withdrawing the request", async () => {
			const refusing = owner("holder-b", REFUSED);
			const id = await postLaunchRequest(storage, { to: "holder-b", from: "holder-a", workspace: WS, launch: NEW });
			assert.equal(await awaitRequestAnswer(storage, "holder-b", id, { timeoutMs: 5_000, pollMs: 20 }), "refused");
			assert.equal(refusing.served.length, 1);
			const silent = await postLaunchRequest(storage, { to: "holder-asleep", from: "holder-a", workspace: WS, launch: NEW });
			assert.equal(await awaitRequestAnswer(storage, "holder-asleep", silent, { timeoutMs: 80, pollMs: 10 }), "timeout");
			const late = owner("holder-asleep");
			await new Promise(resolve => setTimeout(resolve, 150));
			assert.deepEqual(late.served, [], "a window that wakes later does not start a launch nobody waits for");
		});

		it("is not started once its requester withdrew it, even when the receiver is slow", async () => {
			const id = await postLaunchRequest(storage, { to: "holder-b", from: "holder-a", workspace: WS, launch: NEW });
			let wanted: boolean | null = null;
			const gate = Promise.withResolvers<void>();
			const target = owner("holder-b", async (_request, context) => {
				await gate.promise;
				wanted = await context.stillWanted();
				return wanted ? SELECTED : REFUSED;
			});
			await until(() => target.served.length === 1);
			await withdrawRequest(storage, "holder-b", id);
			gate.resolve();
			await until(() => wanted !== null);
			assert.equal(wanted, false);
		});

		it("serves a duplicate delivery of one request once", async () => {
			const target = owner("holder-b");
			const id = await postLaunchRequest(storage, { to: "holder-b", from: "holder-a", workspace: WS, launch: NEW });
			const name = `holder-b.${id}.request`;
			await until(() => target.served.length === 1);
			await until(() => fs.existsSync(path.join(directory, `holder-b.${id}.response`)));
			const original = fs.readFileSync(path.join(directory, `holder-b.${id}.response`), "utf8");
			assert.match(original, /"ok":true/);
			fs.writeFileSync(path.join(directory, name), JSON.stringify({ version: 1, kind: "launch", id, to: "holder-b", from: "holder-a", createdAt: new Date().toISOString(), workspace: WS, launch: NEW }));
			target.watch.rescan();
			await until(() => !fs.existsSync(path.join(directory, name)));
			assert.equal(target.served.length, 1, "the same request is not started again");
		});

		it("lives longer than a selection, and is dropped when older than that", async () => {
			assert.ok(LAUNCH_REQUEST_TTL_MS > REQUEST_TTL_MS);
			assert.equal(requestTtlMs({ kind: "launch" }), LAUNCH_REQUEST_TTL_MS);
			assert.equal(requestTtlMs({ kind: "select" }), REQUEST_TTL_MS);
			// Near the real time: posting sweeps files by their real modification time.
			let clock = Date.now();
			await postLaunchRequest(storage, { to: "holder-b", from: "holder-a", workspace: WS, launch: NEW }, () => clock);
			await post("holder-b", "tab:9", () => clock);
			clock += REQUEST_TTL_MS + 1_000;
			const target = owner("holder-b", SELECTED, () => clock);
			await until(() => fs.readdirSync(directory).filter(name => name.endsWith(".request")).length === 0);
			assert.deepEqual(target.served.map(request => request.kind), ["launch"], "only the launch is still within its lifetime");
			const stale = await postLaunchRequest(storage, { to: "holder-b", from: "holder-a", workspace: WS, launch: NEW }, () => clock - LAUNCH_REQUEST_TTL_MS - 1);
			target.watch.rescan();
			await until(() => !fs.existsSync(path.join(directory, `holder-b.${stale}.request`)));
			assert.equal(target.served.length, 1);
		});

		it("refuses to post, and ignores in a file, a launch that names no valid target", async () => {
			const bad: unknown[] = [
				{ kind: "new-session", folderId: "C:/not/an/id" },
				{ kind: "new-session", folderId: "folder:has space" },
				{ kind: "resume-folder" },
				{ kind: "open-session", tabId: "", verb: "resumed", mode: null },
				{ kind: "open-session", tabId: "tab:1", verb: "launch", mode: null },
				{ kind: "open-session", tabId: "tab:1", verb: "opened", mode: "split" },
				{ kind: "stop-everything" },
			];
			for (const launch of bad) await assert.rejects(postLaunchRequest(storage, { to: "holder-b", from: "holder-a", workspace: WS, launch: launch as LaunchAction }), TypeError);
			const target = owner("holder-b");
			fs.mkdirSync(directory, { recursive: true });
			bad.forEach((launch, at) => fs.writeFileSync(path.join(directory, `holder-b.bad-${at}.request`), JSON.stringify({ version: 1, kind: "launch", id: `bad-${at}`, to: "holder-b", from: "holder-a", createdAt: new Date().toISOString(), workspace: WS, launch })));
			await until(() => fs.readdirSync(directory).filter(name => name.endsWith(".request")).length === 0);
			assert.deepEqual(target.served, []);
			for (const workspace of [{ path: "", match: "folder" }, { path: "C:/x", match: "anywhere" }, { path: "x".repeat(5_000), match: "root" }]) {
				await assert.rejects(postLaunchRequest(storage, { to: "holder-b", from: "holder-a", workspace: workspace as typeof WS, launch: NEW }), TypeError);
			}
			await assert.rejects(postLaunchRequest(storage, { to: "../escape", from: "holder-a", workspace: WS, launch: NEW }), TypeError);
		});
	});
});

describe("planning a switch to the window that holds a session", () => {
	const window = (holderId: string, windowUri: string | null, here = false): OpenWindow => ({
		holderId, here, startedAt: "2026-10-10T09:00:00.000Z", windowUri, label: holderId, folders: [], liveCwds: [], rows: {}, focusedAt: null, stale: false,
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

describe("planning where a launch for a folder starts", () => {
	const window = (holderId: string, focusedAt: string | null, patch: Partial<FolderWindow> = {}): FolderWindow =>
		({ holderId, here: false, startedAt: "2026-10-10T09:00:00.000Z", focusedAt, ...patch });

	it("starts here when this window has the folder, whatever else has it", () => {
		assert.deepEqual(planFolderLaunch([window("a", null, { here: true }), window("b", "2026-10-10T10:00:00.000Z")]), { kind: "here" });
	});

	it("starts here when no live window has the folder (a pinned folder, or one only a session keeps)", () => {
		assert.deepEqual(planFolderLaunch([]), { kind: "here" });
	});

	it("goes to the one other window that has it", () => {
		assert.deepEqual(planFolderLaunch([window("b", null)]), { kind: "window", holderId: "b" });
	});

	it("goes to the most recently focused of several other windows, whatever order they are listed in", () => {
		const windows = [window("b", "2026-10-10T10:00:00.000Z"), window("c", "2026-10-10T11:00:00.000Z"), window("d", "2026-10-10T09:30:00.000Z")];
		assert.deepEqual(planFolderLaunch(windows), { kind: "window", holderId: "c" });
		assert.deepEqual(planFolderLaunch([...windows].reverse()), { kind: "window", holderId: "c" });
	});

	it("asks for a new window only when the caller wants one and no live window has the folder", () => {
		assert.deepEqual(planFolderLaunch([], "new-window"), { kind: "new-window" });
		assert.deepEqual(planFolderLaunch([], "here"), { kind: "here" });
		assert.deepEqual(planFolderLaunch([window("b", null)], "new-window"), { kind: "window", holderId: "b" });
		assert.deepEqual(planFolderLaunch([window("a", null, { here: true })], "new-window"), { kind: "here" });
	});

	it("never chooses a window on an older build: another window is used, and when every window is one the launch starts here", () => {
		assert.deepEqual(planFolderLaunch([window("b", "2026-10-10T12:00:00.000Z", { stale: true }), window("c", "2026-10-10T09:30:00.000Z")]), { kind: "window", holderId: "c" });
		assert.deepEqual(planFolderLaunch([window("b", null, { stale: true })]), { kind: "here", staleHolders: ["b"] });
		assert.deepEqual(planFolderLaunch([window("b", null, { stale: true }), window("c", null, { stale: true })]), { kind: "here", staleHolders: ["b", "c"] });
		assert.deepEqual(planFolderLaunch([window("a", null, { here: true }), window("b", null, { stale: true })]), { kind: "here" }, "this window has it: not a stale hand-over");
	});

	it("starts here instead of opening a new window when the only window with the folder is on an older build", () => {
		assert.deepEqual(planFolderLaunch([window("b", null, { stale: true })], "new-window"), { kind: "here", staleHolders: ["b"] });
		assert.deepEqual(planFolderLaunch([], "new-window"), { kind: "new-window" });
	});

	it("ranks a window that published no focus time last, then breaks ties by start and holder id", () => {
		assert.deepEqual(planFolderLaunch([window("z", null), window("y", "2026-10-10T08:00:00.000Z")]), { kind: "window", holderId: "y" });
		assert.deepEqual(planFolderLaunch([window("z", null), window("y", null, { startedAt: "2026-10-10T09:30:00.000Z" })]), { kind: "window", holderId: "z" }, "the earlier started");
		assert.deepEqual(planFolderLaunch([window("z", null), window("y", null)]), { kind: "window", holderId: "y" }, "the lower holder id");
		assert.deepEqual(planFolderLaunch([window("z", "garbage"), window("y", "2026-10-10T08:00:00.000Z")]), { kind: "window", holderId: "y" }, "an unreadable time is no time");
	});
});

describe("planning how to bring a window forward", () => {
	const open = (holderId: string, windowUri: string | null): OpenWindow => ({
		holderId, here: false, startedAt: "2026-10-10T09:00:00.000Z", windowUri, label: holderId, folders: [], liveCwds: [], rows: {}, focusedAt: null, stale: false,
	});

	it("focuses the window by its registered URI", () => {
		assert.deepEqual(planWindowFocus("b", null, [open("a", "file:///a"), open("b", "file:///b")]), { kind: "switch", uri: "file:///b" });
	});

	it("does not focus an unsaved window, or one another window shows the same URI for", () => {
		assert.deepEqual(planWindowFocus("b", null, [open("b", null)]), { kind: "manual", reason: "no-uri" });
		assert.deepEqual(planWindowFocus("b", null, [open("b", "file:///x"), open("c", "file:///x")]), { kind: "manual", reason: "ambiguous" });
	});
});

describe("pending launches for a window that is still starting", () => {
	let storage: string;
	let directory: string;
	const watches: RequestWatch[] = [];
	const KEY = pendingKeyOf("file:///c:/work/unity-app");
	const OTHER_KEY = pendingKeyOf("file:///c:/work/another");
	const NEW: LaunchAction = { kind: "new-session", folderId: "folder:repo" };
	const UNITY = { path: "C:/work/unity-app", match: "root" } as const;

	before(() => {
		storage = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pending-launches-"));
		directory = path.join(storage, PENDING_LAUNCH_DIRECTORY);
	});
	afterEach(() => {
		for (const watch of watches.splice(0)) watch.dispose();
		fs.rmSync(directory, { recursive: true, force: true });
		fs.rmSync(path.join(storage, WINDOW_REQUEST_DIRECTORY), { recursive: true, force: true });
	});
	after(() => {
		fs.rmSync(storage, { recursive: true, force: true });
	});

	function claimant(holderId: string, keys: () => readonly string[], answer: ServeOutcome = SELECTED, now?: () => number) {
		const served: LaunchRequest[] = [];
		const watch = startPendingLaunchWatch(storage, holderId, keys, async request => { served.push(request); return answer; }, { debounceMs: 20, ...(now === undefined ? {} : { now }) });
		watches.push(watch);
		return { served, watch };
	}
	async function until(predicate: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
		assert.ok(predicate(), "the awaited condition never came true");
	}
	const pending = () => fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith(".pending")) : [];

	it("is claimed by the window that has the folder, served as a request to it, and answered to the requester", async () => {
		const id = await postPendingLaunch(storage, { from: "holder-a", key: KEY, workspace: UNITY, launch: NEW });
		const target = claimant("holder-new", () => [KEY]);
		assert.equal(await awaitPendingLaunchAnswer(storage, id, { timeoutMs: 5_000, pollMs: 20 }), "served");
		assert.equal(target.served.length, 1);
		const request = target.served[0]!;
		assert.deepEqual([request.kind, request.to, request.from, request.workspace, request.launch], ["launch", "holder-new", "holder-a", UNITY, NEW]);
		assert.deepEqual(pending(), [], "nothing is left to start twice");
		assert.deepEqual(fs.readdirSync(directory), [], "the claimed file is deleted");
	});

	it("is claimed when it is posted after the window started watching", async () => {
		const target = claimant("holder-new", () => [KEY]);
		const id = await postPendingLaunch(storage, { from: "holder-a", key: KEY, workspace: UNITY, launch: NEW });
		assert.equal(await awaitPendingLaunchAnswer(storage, id, { timeoutMs: 5_000, pollMs: 20 }), "served");
		assert.equal(target.served.length, 1);
	});

	it("is started by exactly one of several windows that could claim it", async () => {
		const first = claimant("holder-one", () => [KEY]);
		const second = claimant("holder-two", () => [KEY]);
		const third = claimant("holder-three", () => [KEY]);
		const ids = await Promise.all(Array.from({ length: 6 }, () => postPendingLaunch(storage, { from: "holder-a", key: KEY, workspace: UNITY, launch: NEW })));
		for (const id of ids) assert.equal(await awaitPendingLaunchAnswer(storage, id, { timeoutMs: 5_000, pollMs: 20 }), "served");
		await new Promise(resolve => setTimeout(resolve, 150));
		const requests = [...first.served, ...second.served, ...third.served];
		assert.equal(requests.length, 6, "every launch is started once, however many windows race for it");
		assert.equal(new Set(requests.map(request => request.id)).size, 6);
	});

	it("is left alone by a window that has another folder open until that window has this one", async () => {
		let keys = [OTHER_KEY];
		const target = claimant("holder-new", () => keys);
		const id = await postPendingLaunch(storage, { from: "holder-a", key: KEY, workspace: UNITY, launch: NEW });
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.deepEqual(target.served, []);
		assert.equal(pending().length, 1);
		keys = [OTHER_KEY, KEY];
		target.watch.rescan();
		assert.equal(await awaitPendingLaunchAnswer(storage, id, { timeoutMs: 5_000, pollMs: 20 }), "served");
	});

	it("passes a refusal as an older build back to the requester, and leaves nothing behind", async () => {
		const older = claimant("holder-new", () => [KEY], { ok: false, focused: false, refusal: "stale-build" });
		const id = await postPendingLaunch(storage, { from: "holder-a", key: KEY, workspace: UNITY, launch: NEW });
		assert.equal(await awaitPendingLaunchAnswer(storage, id, { timeoutMs: 5_000, pollMs: 20 }), "stale-build");
		assert.equal(older.served.length, 1);
		await until(() => fs.readdirSync(directory).length === 0);
	});

	it("reports a refusal, and drops a launch older than its lifetime without starting it", async () => {
		const refusing = claimant("holder-new", () => [KEY], { ok: false, focused: false });
		const id = await postPendingLaunch(storage, { from: "holder-a", key: KEY, workspace: UNITY, launch: NEW });
		assert.equal(await awaitPendingLaunchAnswer(storage, id, { timeoutMs: 5_000, pollMs: 20 }), "refused");
		assert.equal(refusing.served.length, 1);
		refusing.watch.dispose();
		const future = Date.now() + PENDING_LAUNCH_TTL_MS + 5_000;
		const stale = claimant("holder-late", () => [KEY], SELECTED, () => future);
		await postPendingLaunch(storage, { from: "holder-a", key: KEY, workspace: UNITY, launch: NEW });
		await until(() => pending().length === 0);
		assert.deepEqual(stale.served, []);
	});

	it("is not started once its requester withdrew it", async () => {
		const id = await postPendingLaunch(storage, { from: "holder-a", key: KEY, workspace: UNITY, launch: NEW });
		await withdrawPendingLaunch(storage, KEY, id);
		const target = claimant("holder-new", () => [KEY]);
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.deepEqual(target.served, []);
		assert.equal(await awaitPendingLaunchAnswer(storage, id, { timeoutMs: 80, pollMs: 10 }), "timeout");
	});

	it("ignores forged files: a malformed body, a wrong name or an oversized one", async () => {
		const target = claimant("holder-new", () => [KEY]);
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, `${KEY}.id-1.pending`), "{ not json");
		fs.writeFileSync(path.join(directory, `${KEY}.id-2.pending`), JSON.stringify({ version: 1, kind: "launch", id: "other", to: "pending", from: "holder-a", createdAt: new Date().toISOString(), workspace: UNITY, launch: NEW }));
		fs.writeFileSync(path.join(directory, `${KEY}.id-3.pending`), "x".repeat(64 * 1024));
		fs.writeFileSync(path.join(directory, `${KEY}.id-4.pending`), JSON.stringify({ version: 1, kind: "launch", id: "id-4", to: "pending", from: "holder-a", createdAt: new Date().toISOString(), workspace: { path: "C:/x", match: "anywhere" }, launch: NEW }));
		target.watch.rescan();
		await until(() => fs.readdirSync(directory).length === 0);
		assert.deepEqual(target.served, []);
	});

	it("keeps the launch withdrawable until it is admitted: one claimed before the requester gave up is not started after it", async () => {
		const gate = Promise.withResolvers<void>();
		let wantedAtAdmission: boolean | null = null;
		const watch = startPendingLaunchWatch(storage, "holder-new", () => [KEY], async (_request, context) => {
			await gate.promise;
			wantedAtAdmission = await context.stillWanted();
			return wantedAtAdmission ? SELECTED : REFUSED;
		}, { debounceMs: 20 });
		watches.push(watch);
		const id = await postPendingLaunch(storage, { from: "holder-a", key: KEY, workspace: UNITY, launch: NEW });
		await until(() => fs.existsSync(path.join(directory, `${KEY}.${id}.claimed`)));
		assert.equal(pending().length, 1, "claimed but not admitted: the file is still there to be withdrawn");
		await withdrawPendingLaunch(storage, KEY, id);
		gate.resolve();
		await until(() => wantedAtAdmission !== null);
		assert.equal(wantedAtAdmission, false, "the receiver sees that the requester gave up");
		await until(() => fs.readdirSync(directory).length === 0);
	});

	it("never lets a served launch be claimed again when its pending file could not be deleted", async () => {
		let invocations = 0;
		const serve = async (): Promise<ServeOutcome> => { invocations++; return SELECTED; };
		const failing = async (): Promise<void> => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); };
		const first = startPendingLaunchWatch(storage, "holder-one", () => [KEY], serve, { debounceMs: 20, removeFile: failing });
		const second = startPendingLaunchWatch(storage, "holder-two", () => [KEY], serve, { debounceMs: 20, removeFile: failing });
		watches.push(first, second);
		const id = await postPendingLaunch(storage, { from: "holder-a", key: KEY, workspace: UNITY, launch: NEW });
		assert.equal(await awaitPendingLaunchAnswer(storage, id, { timeoutMs: 5_000, pollMs: 20 }), "served");
		await until(() => invocations === 1 && fs.existsSync(path.join(directory, `${KEY}.${id}.claimed`)));
		for (let at = 0; at < 10; at++) {
			first.rescan();
			second.rescan();
			await new Promise(resolve => setTimeout(resolve, 30));
		}
		assert.equal(invocations, 1, "the launch is served once though its file survived and both windows rescanned");
		assert.ok(fs.existsSync(path.join(directory, `${KEY}.${id}.claimed`)), "the marker stays while the file does");
	});

	it("bounds the work a held launch and repeated scans can pile up, and serves every launch for its keys in the end", async () => {
		const gate = Promise.withResolvers<void>();
		let active = 0;
		let peak = 0;
		const served: string[] = [];
		const watch = startPendingLaunchWatch(storage, "holder-new", () => [KEY], async request => {
			peak = Math.max(peak, ++active);
			await gate.promise;
			active--;
			served.push(request.id);
			return SELECTED;
		}, { debounceMs: 20 });
		watches.push(watch);
		fs.mkdirSync(directory, { recursive: true });
		for (let at = 0; at < 40; at++) fs.writeFileSync(path.join(directory, `${OTHER_KEY}.other-${at}.pending`), "{}");
		const ids = await Promise.all(Array.from({ length: 5 }, () => postPendingLaunch(storage, { from: "holder-a", key: KEY, workspace: UNITY, launch: NEW })));
		for (let at = 0; at < 20; at++) watch.rescan();
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.equal(peak, 1, "launches are admitted one at a time");
		gate.resolve();
		for (const id of ids) assert.equal(await awaitPendingLaunchAnswer(storage, id, { timeoutMs: 5_000, pollMs: 20 }), "served");
		assert.deepEqual([...served].sort(), [...ids].sort(), "each launch once, though the scans repeated");
		assert.equal(fs.readdirSync(directory).filter(name => name.startsWith(OTHER_KEY)).length, 40, "files for other windows' keys are left alone");
	});

	it("sweeps pending and claimed files nobody finished, whoever sees them", async () => {
		fs.mkdirSync(directory, { recursive: true });
		const old = [`${OTHER_KEY}.old-1.pending`, `${OTHER_KEY}.old-2.claimed`];
		for (const name of old) {
			const file = path.join(directory, name);
			fs.writeFileSync(file, "{}");
			const past = new Date(Date.now() - 3_600_000);
			fs.utimesSync(file, past, past);
		}
		const watch = startPendingLaunchWatch(storage, "holder-new", () => [KEY], async () => SELECTED, { debounceMs: 20 });
		watches.push(watch);
		await until(() => fs.readdirSync(directory).length === 0);
	});

	it("refuses to post for a key or id that could name another file", async () => {
		await assert.rejects(postPendingLaunch(storage, { from: "holder-a", key: "../escape", workspace: UNITY, launch: NEW }), TypeError);
		await assert.rejects(postPendingLaunch(storage, { from: "../escape", key: KEY, workspace: UNITY, launch: NEW }), TypeError);
		assert.match(KEY, /^[0-9a-f]{32}$/);
		assert.notEqual(KEY, OTHER_KEY);
	});
});
