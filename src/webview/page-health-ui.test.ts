/**
 * The page's liveness report in an owned headless Chromium: a main thread that is kept busy leaves a long-task report with the
 * events that came before it and a beat that says how late it ran, and everything the real browser produces passes the host's parser.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { parseGuestWebviewMessage } from "../protocol/messages.ts";
import type { GuestPageHealthMessage } from "../protocol/page-health.ts";

const browserPath = [process.env.OMP_TEST_CHROMIUM,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));

class Cdp {
	#next = 0;
	readonly #pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
	readonly socket: WebSocket;
	constructor(socket: WebSocket) {
		this.socket = socket;
		socket.addEventListener("message", event => {
			const frame = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
			const pending = frame.id === undefined ? undefined : this.#pending.get(frame.id);
			if (frame.id === undefined || pending === undefined) return;
			this.#pending.delete(frame.id);
			if (frame.error) pending.reject(new Error(frame.error.message)); else pending.resolve(frame.result ?? {});
		});
	}
	static async connect(url: string): Promise<Cdp> {
		const socket = new WebSocket(url);
		const opened = Promise.withResolvers<void>();
		socket.addEventListener("open", () => opened.resolve(), { once: true });
		socket.addEventListener("error", () => opened.reject(new Error("headless browser connection failed")), { once: true });
		await opened.promise;
		return new Cdp(socket);
	}
	call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const id = ++this.#next;
		const answer = Promise.withResolvers<Record<string, unknown>>();
		this.#pending.set(id, answer);
		this.socket.send(JSON.stringify({ id, method, params }));
		return answer.promise;
	}
	async evaluate<T>(expression: string): Promise<T> {
		const result = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
		if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
		const remote = result.result;
		assert.ok(remote !== null && typeof remote === "object");
		return ("value" in remote ? remote.value : undefined) as T;
	}
}

const PAGE = `<!doctype html><title>page health</title><input id="field"><script src="/health.js"></script>`;

test("a busy main thread is reported as a long task, with the events before it and the lateness of the next beat", { skip: browserPath === undefined && "no Chromium is available" }, async () => {
	const bundle = await build({
		stdin: {
			contents: `import { installPageHealth } from "./src/webview/lib/page-health.ts";
				window.reports = [];
				let tap = () => {};
				window.receive = type => tap(type);
				window.handle = installPageHealth(window, { post: message => { window.reports.push(message); return true; }, observeInbound: next => { tap = next; return () => { tap = () => {}; }; } });`,
			resolveDir: process.cwd(), loader: "ts",
		},
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
	});
	const script = bundle.outputFiles[0]!.text;
	const server = createServer((request, response) => {
		response.setHeader("content-type", request.url === "/health.js" ? "text/javascript" : "text/html");
		response.end(request.url === "/health.js" ? script : PAGE);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const profile = await mkdtemp(join(tmpdir(), "omp-page-health-"));
	const child = spawn(browserPath!, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
		"--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
	let browser: Cdp | undefined;
	let page: Cdp | undefined;
	try {
		const readiness = Promise.withResolvers<string>();
		let stderr = "";
		const timer = setTimeout(() => readiness.reject(new Error("owned headless browser did not publish a DevTools endpoint")), 60_000);
		child.once("error", error => { clearTimeout(timer); readiness.reject(error); });
		child.stderr!.on("data", data => {
			stderr += String(data);
			const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
			if (match) { clearTimeout(timer); readiness.resolve(match[1]!); }
		});
		const endpoint = await readiness.promise;
		browser = await Cdp.connect(endpoint);
		const created = await browser.call("Target.createTarget", { url: `http://127.0.0.1:${address.port}/` });
		const targets = await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json() as { id: string; webSocketDebuggerUrl: string }[];
		page = await Cdp.connect(targets.find(row => row.id === created.targetId)!.webSocketDebuggerUrl);
		await page.call("Emulation.setFocusEmulationEnabled", { enabled: true });
		const reports = () => page!.evaluate<GuestPageHealthMessage[]>("window.reports");
		const until = async (what: string, ready: () => Promise<boolean>) => {
			for (let attempt = 0; attempt < 400; attempt++) {
				if (await ready().catch(() => false)) return;
				await delay(25);
			}
			assert.fail(`timed out waiting for ${what}; the page has ${JSON.stringify(await page!.evaluate("({ types: PerformanceObserver.supportedEntryTypes, reasons: window.reports.map(report => report.reason + ':' + report.seq) })"))}`);
		};
		await until("the first report", async () => (await reports()).length >= 1);

		// Wait for a beat, then do the things a user and the host do, and keep the thread busy for longer than a beat interval.
		const beats = async () => (await reports()).filter(report => report.reason === "beat").length;
		const before = await beats();
		await until("a beat", async () => await beats() > before);
		await page.evaluate("window.receive('omp:chat-snapshot'); document.querySelector('#field').focus(); 1");
		await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a" });
		await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "a" });
		const seen = (await reports()).length;
		// A task of the page's own (a timer), not the DevTools evaluation itself: the browser measures long tasks of the page's task queues.
		await page.evaluate("setTimeout(() => { const start = performance.now(); while (performance.now() - start < 2600); }, 0); 1");
		await until("the long-task report", async () => (await reports()).some(report => report.reason === "long-task"));

		const all = await reports();
		for (const report of all) assert.deepEqual(parseGuestWebviewMessage(report), report, `the host's parser accepts what Chromium's page sends: ${JSON.stringify(report)}`);
		const task = all.find(report => report.reason === "long-task")!;
		assert.ok(task.longTask !== undefined && task.longTask.durationMs >= 2400 && task.longTask.durationMs < 20_000, `the long task is measured: ${JSON.stringify(task.longTask)}`);
		const kinds = task.events.map(event => event.kind);
		assert.ok(kinds.includes("rx:omp:chat-snapshot"), `the host message type before the stall is in the ring: ${kinds}`);
		assert.ok(kinds.includes("key"), `the input kind before the stall is in the ring: ${kinds}`);
		assert.ok(!JSON.stringify(task).includes("\"a\""), "the key that was pressed is not reported");
		await until("the beat that ran late", async () => (await reports()).slice(seen).some(report => report.reason === "beat" && report.lateMs >= 300));
		const late = (await reports()).slice(seen).find(report => report.reason === "beat" && report.lateMs >= 300)!;
		assert.ok(late.lateMs < 20_000, `the late beat says how long the thread was stuck: ${late.lateMs}`);

		// A page that becomes hidden says so and stops beating; visible again, it reports at once.
		await page.evaluate("Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); 1");
		await until("the hidden report", async () => (await reports()).some(report => report.reason === "visibility" && !report.visible));
		const hiddenCount = (await reports()).length;
		// A real wait: the claim is that the browser's own timer, which would have beaten once in this time, no longer runs; no event marks an absent post.
		await delay(2600);
		assert.equal((await reports()).length, hiddenCount, "a hidden page posts nothing while it is hidden");
		await page.evaluate("delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); 1");
		await until("the visible report", async () => (await reports()).some(report => report.reason === "visibility" && report.visible));
	} finally {
		page?.socket.close();
		browser?.socket.close();
		child.kill();
		server.close();
		await rm(profile, { recursive: true, force: true }).catch(() => undefined);
	}
});
