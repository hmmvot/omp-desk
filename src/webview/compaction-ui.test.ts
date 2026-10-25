/**
 * A long transcript in an owned headless Chromium with the real Chat page, on a CPU slowed down as a loaded machine is:
 * a reply streams into it, and an auto-compaction or a resync replaces the transcript's entries in the middle of the stream.
 *
 * The page must stay responsive through it. Every frame of a streaming reply used to project every loaded entry again, a
 * snapshot made every row a new object so every cache missed, and the page drew every frame that arrived however long
 * drawing took, so a backlog of frames became one long task after another: the working spinner stalled for seconds
 * and the page took no input. The budgets below are counts of long tasks and shares of the main thread, measured on a
 * CPU slowed 4 times; they hold with a wide margin for the fixed page and are far exceeded by the old one.
 *
 * The clocks here are real: the page's own timers, frames and long tasks under a slowed CPU are the thing under test, and a
 * fake clock would measure nothing.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { createGuestHtml } from "../host/guest-webview.ts";

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

/** The real Chat page with the page's motion installed, as `main.tsx` does, and handles to push snapshots into it and to prepare them before the clock runs. */
const FIXTURE = `
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { guestTransport, readCspNonce } from "./bridge";
import { installPageMotion } from "./lib/page-motion";
import { ChatClient } from "./lib/chat-client";
import { createChatModel, snapshotOf } from "../chat/model";
import { splitChatSnapshot } from "../protocol/chat-messages";
import { injectGuestStyles } from "./styles";
import { attachSessionView } from "./lib/session-view";
import { attachCodeTheme } from "./lib/code-theme-store";
import { attachKeyHints } from "./lib/key-hints-store";
import { adoptNonceForCreatedStyles } from "./lib/nonce-styles";
attachSessionView(guestTransport); attachCodeTheme(guestTransport); attachKeyHints(guestTransport);
installPageMotion(window);
const epoch = { nonce: "host-ui-test", counter: 1 };
const model = { provider: "one", id: "old", name: "Original", contextWindow: 1000000 };
const client = new ChatClient({ post(message) { return guestTransport.post(message); } }); client.attach(guestTransport);
let current = { ...snapshotOf(createChatModel(), epoch), phase: "live", state: { model, thinkingLevel: "low", isStreaming: false, isCompacting: false, queuedMessageCount: 0, contextUsage: { tokens: 40700, contextWindow: 1000000, percent: 4.07 } } };
function receive(message) { window.dispatchEvent(new MessageEvent("message", { data: message })); }
function parts(patch) { return splitChatSnapshot({ ...current, ...patch }, "ui-snapshot"); }
function deliver(prepared) { receive(prepared.snapshot); for (const chunk of prepared.chunks) receive(chunk); }
window.ui = { receive, parts, deliver, push(patch = {}) { current = { ...current, ...patch }; deliver(parts({})); }, current: () => current,
 view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Compaction", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); } };
const nonce = readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); window.ui.push();
`;

/** A session of TURNS turns (a prompt, a reply with two tool calls and their results, a closing reply), the stream, and the two ways its entries are replaced. */
const SETUP = (turns: number): string => `(() => {
 const TURNS = ${turns};
 const sleep = ms => { const { promise, resolve } = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
 const frames = () => { const { promise, resolve } = Promise.withResolvers(); requestAnimationFrame(() => requestAnimationFrame(resolve)); return promise; };
 const row = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: "2026-10-05T00:00:00Z", message });
 const prose = "The build pipeline compiles every assembly and reports \`warnings\` about stale caches, and the tests that depend on them are skipped. ";
 const entries = [];
 for (let turn = 0; turn < TURNS; turn++) {
  const base = 1_000_000 + turn * 10, id = "t" + turn;
  entries.push(
   row(id + "u", turn === 0 ? null : "t" + (turn - 1) + "z", { role: "user", content: "Do step " + turn + ". " + prose, timestamp: base }),
   row(id + "a", id + "u", { role: "assistant", timestamp: base + 1, model: "m", stopReason: "toolUse", content: [
    { type: "text", text: "## Step " + turn + "\\n\\n" + prose.repeat(2) + "\\n\\n- one\\n- two with **bold**\\n\\n\`\`\`ts\\nexport const f" + turn + " = (a: number) => a + 1;\\n\`\`\`" },
    { type: "toolCall", id: id + "c1", name: "read", arguments: { path: "src/file" + turn + ".ts" } },
    { type: "toolCall", id: id + "c2", name: "bash", arguments: { command: "echo " + turn, i: "Echo" } }] }),
   row(id + "r1", id + "a", { role: "toolResult", timestamp: base + 2, toolCallId: id + "c1", toolName: "read", isError: false, content: [{ type: "text", text: ("line of file " + turn + "\\n").repeat(10) }] }),
   row(id + "r2", id + "r1", { role: "toolResult", timestamp: base + 3, toolCallId: id + "c2", toolName: "bash", isError: false, content: [{ type: "text", text: "out " + turn }] }),
   row(id + "z", id + "r2", { role: "assistant", timestamp: base + 4, model: "m", stopReason: "stop", content: [{ type: "text", text: "Done with step " + turn + ". " + prose }] }));
 }
 const fresh = list => JSON.parse(JSON.stringify(list));
 const frame = value => window.ui.receive({ type: "omp:chat-event", epoch: window.ui.current().epoch, frame: value });
 let words = 0;
 const tick = () => {
  words += 3;
  frame({ type: "message_update", messageId: "live1", message: { role: "assistant", timestamp: 2_000_000, model: "m", stopReason: "stop", content: [{ type: "text", text: "Streaming reply: " + "alpha beta gamma delta ".repeat(Math.ceil(words / 4)).slice(0, words * 6) + "\\n\\n\`code\` and **bold** text" }] } });
 };
 let timer = 0;
 // Long tasks, and when the working row's glyph takes each of its steps.
 window.longTasks = [];
 new PerformanceObserver(list => { for (const entry of list.getEntries()) window.longTasks.push(entry.duration); }).observe({ entryTypes: ["longtask"] });
 window.steps = [];
 new MutationObserver(() => { const glyph = document.querySelector(".omp-working-status-text"); if (!glyph) return; const value = glyph.style.getPropertyValue("--omp-spin"); if (value !== window.lastStep) { window.lastStep = value; window.steps.push(performance.now()); } })
  .observe(document.body, { subtree: true, attributes: true, attributeFilter: ["style"] });
 // The loaded transcript, the two replacements prepared before any clock runs (a host sends them already split), and a stream under way.
 window.setUp = async () => {
  const kept = fresh(entries.slice(480));
  const compaction = { type: "compaction", id: "cmp1", parentId: kept.at(-1).id, timestamp: "2026-10-05T01:00:00Z", summary: "Summary of the earlier conversation. " + prose.repeat(4), firstKeptEntryId: kept[0].id, tokensBefore: 90000, tokensAfter: 12000, method: "soft" };
  window.prepared = {
   resync: window.ui.parts({ phase: "live", entries: fresh(entries), durableCount: entries.length, olderCount: 0, working: true, settled: false }),
   compact: window.ui.parts({ phase: "live", entries: [...kept, compaction], durableCount: kept.length + 1, olderCount: 480, working: true, settled: false }),
  };
  window.ui.push({ entries: fresh(entries), durableCount: entries.length, olderCount: 0, working: true, settled: false, workingIntent: "Streaming" });
  await frames(); await sleep(1500);
  frame({ type: "agent_start" });
 };
 // Run \`what\` while a reply streams, and say what the page did meanwhile.
 window.during = async (what, ms) => {
  window.longTasks.length = 0; window.steps.length = 0;
  const from = performance.now();
  timer = setInterval(tick, 33);
  await sleep(1000);
  const mounted = [...document.querySelectorAll(".omp-measured-row")];
  for (const element of mounted) element.dataset.mark = "kept";
  what();
  await sleep(ms);
  clearInterval(timer);
  await frames(); await sleep(300);
  const steps = window.steps.filter(time => time > from);
  let gap = 0; for (let index = 1; index < steps.length; index++) gap = Math.max(gap, steps[index] - steps[index - 1]);
  return { tasks: window.longTasks.length, worst: Math.round(Math.max(0, ...window.longTasks)), busy: Math.round(window.longTasks.reduce((sum, value) => sum + value, 0)),
   steps: steps.length, gap: Math.round(gap), survivors: [...document.querySelectorAll(".omp-measured-row")].filter(element => element.dataset.mark === "kept").length, mounted: mounted.length };
 };
 window.replace = which => () => window.ui.deliver(window.prepared[which]);
})()`;

interface During { tasks: number; worst: number; busy: number; steps: number; gap: number; survivors: number; mounted: number }

test("a reply streaming into a long transcript keeps the page responsive while a compaction or a resync replaces the entries", { skip: browserPath === undefined && "no Chromium is available", timeout: 300_000 }, async t => {
	const bundle = await build({
		stdin: { contents: FIXTURE, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") },
		bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' },
	});
	const script = bundle.outputFiles[0]!.text;
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://fixture");
		if (url.pathname === "/codicons/codicon.css" || url.pathname === "/codicons/codicon.ttf") {
			const file = url.pathname.endsWith(".css") ? "codicon.css" : "codicon.ttf";
			response.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : "font/ttf");
			response.end(readFileSync(join(process.cwd(), "node_modules/@vscode/codicons/dist", file)));
			return;
		}
		if (url.pathname === "/ui.js") { response.setHeader("Content-Type", "text/javascript"); response.end(script); return; }
		response.setHeader("Content-Type", "text/html");
		const webview = { cspSource: "'self'", asWebviewUri: (uri: { path: string }) => ({ toString: () => uri.path.endsWith(".js") ? "/ui.js" : "/codicons/codicon.css" }) } as never;
		const extensionUri = { path: "/extension", with({ path }: { path: string }) { return { path }; } } as never;
		const html = createGuestHtml(webview, extensionUri, "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d", null);
		const nonce = /<script nonce="([^"]+)"/.exec(html)![1]!;
		response.end(html.replace("</head>", `<style nonce="${nonce}">:root{--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#ddd;--vscode-foreground:#ddd;--vscode-font-family:Arial;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace;--vscode-progressBar-background:#0e70c0;--vscode-focusBorder:#007fd4}</style><script nonce="${nonce}">window.sent=[];window.acquireVsCodeApi=()=>({postMessage(m){window.sent.push(m)},setState(){}});</script></head>`));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const profile = await mkdtemp(join(tmpdir(), "omp-compaction-"));
	const child = spawn(browserPath!, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
		"--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1000,800", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
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
		await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
		const evaluate = <T>(expression: string) => page!.evaluate<T>(expression);
		for (let attempt = 0; attempt < 400 && !await evaluate<boolean>("Boolean(window.ui)").catch(() => false); attempt++) await delay(25);
		await evaluate(SETUP(900));
		await evaluate("window.setUp()");
		// A machine that is busy with other work: the same page at a quarter of the speed.
		await page.call("Emulation.setCPUThrottlingRate", { rate: 4 });
		const during = async (what: string, ms: number): Promise<During> => {
			const outcome = await evaluate<During>(`window.during(${what}, ${ms})`);
			process.stdout.write(`# ${what}: ${JSON.stringify(outcome)}\n`);
			return outcome;
		};

		await t.test("a reply streams into 4,500 loaded entries without long tasks piling up", async () => {
			const outcome = await during("() => {}", 2500);
			assert.ok(outcome.tasks <= 14, `${outcome.tasks} long tasks (${outcome.busy} ms) in the 3 s of a stream`);
			assert.ok(outcome.busy <= 1200, `${outcome.busy} ms of long tasks in the 3 s of a stream`);
			assert.ok(outcome.gap <= 700, `the working spinner paused for ${outcome.gap} ms`);
		});

		await t.test("a resync of the same 4,500 entries does not stall the page", async () => {
			const outcome = await during("window.replace('resync')", 2500);
			assert.ok(outcome.tasks <= 16, `${outcome.tasks} long tasks (${outcome.busy} ms) around a resync`);
			assert.ok(outcome.busy <= 1400, `${outcome.busy} ms of long tasks around a resync`);
			assert.ok(outcome.worst <= 800, `the longest task of a resync was ${outcome.worst} ms`);
			assert.ok(outcome.gap <= 1500, `the working spinner paused for ${outcome.gap} ms around a resync`);
		});

		await t.test("an auto-compaction that drops 480 older messages in the middle of the stream does not stall the page", async () => {
			const outcome = await during("window.replace('compact')", 2500);
			assert.ok(outcome.tasks <= 16, `${outcome.tasks} long tasks (${outcome.busy} ms) around a compaction`);
			assert.ok(outcome.busy <= 1400, `${outcome.busy} ms of the page's time went to long tasks around a compaction`);
			assert.ok(outcome.gap <= 900, `the working spinner paused for ${outcome.gap} ms around a compaction`);
		});
	} finally {
		page?.socket.close();
		browser?.socket.close();
		child.kill();
		server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
	}
});
