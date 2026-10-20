/** A reader scrolled up in a busy, live-ticking Chat stays where they scrolled, in the real React app in an owned headless Chromium. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { build } from "esbuild";
import type * as vscode from "vscode";
import { createGuestHtml } from "../host/guest-webview.ts";

const browserPath = [process.env.OMP_TEST_CHROMIUM,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));
/** Motion as an unconfigured user has it, independent of the machine running the suite. */
const MOTION_ALLOWED = [{ name: "prefers-reduced-motion", value: "no-preference" }];

class Cdp {
	#next = 0;
	#pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
	#events = new Map<string, (() => void)[]>();
	readonly socket: WebSocket;
	constructor(socket: WebSocket) {
		this.socket = socket;
		socket.addEventListener("message", event => {
			const frame = JSON.parse(String(event.data)) as { id?: number; method?: string; result?: Record<string, unknown>; error?: { message: string } };
			if (frame.id === undefined) {
				if (frame.method) { for (const resolve of this.#events.get(frame.method) ?? []) resolve(); this.#events.delete(frame.method); }
				return;
			}
			const pending = this.#pending.get(frame.id);
			if (!pending) return;
			this.#pending.delete(frame.id);
			if (frame.error) pending.reject(new Error(frame.error.message)); else pending.resolve(frame.result ?? {});
		});
		socket.addEventListener("close", () => {
			for (const pending of this.#pending.values()) pending.reject(new Error("owned browser connection closed"));
			this.#pending.clear();
		});
	}
	static async connect(url: string): Promise<Cdp> {
		const socket = new WebSocket(url);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("headless browser connection failed")), { once: true });
		await promise;
		return new Cdp(socket);
	}
	call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const id = ++this.#next;
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		this.#pending.set(id, { resolve, reject });
		this.socket.send(JSON.stringify({ id, method, params }));
		return promise;
	}
	event(method: string): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#events.set(method, [...(this.#events.get(method) ?? []), resolve]);
		return promise;
	}
	async evaluate<T>(expression: string): Promise<T> {
		const result = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
		if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
		const remote = result.result;
		assert.ok(remote !== null && typeof remote === "object");
		return ("value" in remote ? remote.value : undefined) as T;
	}
	async wait(expression: string): Promise<void> {
		await this.evaluate(`(async () => {
		 const {promise,resolve,reject}=Promise.withResolvers(); let timer;
		 const observer=new MutationObserver(check);
		 function cleanup(){observer.disconnect();document.removeEventListener('fixture-post',check);clearTimeout(timer);}
		 function check(){ if (${expression}) { cleanup(); resolve(); } }
		 observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
		 document.addEventListener('fixture-post',check);
		 timer=setTimeout(()=>{cleanup();reject(new Error('render condition timed out: '+${JSON.stringify(expression)}))},15000);
		 check(); await promise;
		})()`);
	}
	async settleGeometry(selector: string): Promise<void> {
		await this.evaluate(`(async()=>{
		 const deadline=performance.now()+15000;let previous='',stable=0;
		 while(stable<3){
		  await new Promise(resolve=>requestAnimationFrame(resolve));
		  const elements=[...document.querySelectorAll(${JSON.stringify(selector)})];
		  const geometry=JSON.stringify(elements.map(element=>{const rect=element.getBoundingClientRect();return[rect.x,rect.y,rect.width,rect.height,element.scrollTop,element.scrollHeight]}));
		  stable=geometry===previous?stable+1:0;previous=geometry;
		  if(performance.now()>deadline)throw new Error('Geometry did not settle');
		 }
		})()`);
	}
}

const fixture = `
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { guestTransport, readCspNonce } from "./bridge";
import { ChatClient } from "./lib/chat-client";
import { createChatModel, snapshotOf } from "../chat/model";
import { splitChatSnapshot } from "../protocol/chat-messages";
import { injectGuestStyles } from "./styles";
import { attachSessionView } from "./lib/session-view";
import { adoptNonceForCreatedStyles } from "./lib/nonce-styles";
import { installComposerDriver } from "./test-support/composer-driver";
attachSessionView(guestTransport);
installComposerDriver(window);
const epoch = { nonce: "host-ui-test", counter: 1 };
const client = new ChatClient({ post: message => guestTransport.post(message) }); client.attach(guestTransport);
let current = { ...snapshotOf(createChatModel(), epoch), phase: "live", state: {
 model: { provider: "one", id: "old", name: "Original", contextWindow: 1000000 }, thinkingLevel: "low", isStreaming: false, isCompacting: false, queuedMessageCount: 0,
 contextUsage: { tokens: 40700, contextWindow: 1000000, percent: 4.07 }
} };
function receive(message) { window.dispatchEvent(new MessageEvent("message", { data: message })); }
function push(patch = {}) { current = { ...current, ...patch }; const parts = splitChatSnapshot(current, "ui-snapshot");
 receive(parts.snapshot); for (const chunk of parts.chunks) receive(chunk);
}
const iso = at => new Date(at).toISOString();
const row = (id, at, message) => ({ type: "message", id, parentId: null, timestamp: iso(at), message: { timestamp: at, ...message } });
const output = (second, lines) => ({ content: [{ type: "text", text: Array.from({ length: lines }, (_, line) => "second " + second + " line " + line).join("\\n") }] });
window.ui = {
 token: location.search, current: () => current, receive, push,
 view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Owned UI session", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); },
 // A working turn: prose, then one reply carrying 32 calls (reads, running commands with live output, background jobs, a Wait), the Jobs row and live clocks.
 busy() {
  const now = Date.now(); let second = 0;
  const prose = Array.from({ length: 30 }, (_, index) => row("older-" + index, now - 900000 + index, { role: "assistant", model: "m", stopReason: "stop", content: [{ type: "text", text: "Older paragraph " + index + " " + "long readable paragraph ".repeat(20) }] }));
  const reads = Array.from({ length: 12 }, (_, index) => ({ type: "toolCall", id: "read-" + index, name: "read", arguments: { path: "src/file-" + index + ".ts" } }));
  const runs = Array.from({ length: 16 }, (_, index) => ({ type: "toolCall", id: "run-" + index, name: "bash", arguments: { i: "Live run " + index, command: "npm run live-" + index } }));
  const jobs = Array.from({ length: 3 }, (_, index) => ({ type: "toolCall", id: "job-" + index, name: "bash", arguments: { i: "Full run " + index, command: "npm run full-" + index, async: true } }));
  const wait = { type: "toolCall", id: "wait-1", name: "wait", arguments: {} };
  const results = [
   ...reads.map((call, index) => row("r-" + call.id, now - 5000 + index, { role: "toolResult", toolCallId: call.id, toolName: "read", isError: false, content: [{ type: "text", text: "Source " + index }] })),
   ...jobs.map((call, index) => row("r-" + call.id, now - 4000 + index, { role: "toolResult", toolCallId: call.id, toolName: "bash", isError: false, content: [{ type: "text", text: "Backgrounded as job bg_" + index }], details: { async: { state: "running", jobId: "bg_" + index, type: "bash" } } })),
  ];
  const entries = [row("u", now - 1000000, { role: "user", content: "go" }), ...prose, row("tools", now - 6000, { role: "assistant", model: "m", stopReason: "toolUse", content: [...reads, ...runs, ...jobs, wait] }), ...results];
  const waitJobs = tick => jobs.map((call, index) => ({ id: "bg_" + index, type: "bash", status: "running", label: "Full run " + index, durationMs: 60000 + tick * 1000 }));
  window.ui.second = () => {
   second += 1; const c = current;
   push({ activeTools: [...runs.map((call, index) => ({ toolCallId: call.id, toolName: "bash", args: call.arguments, startedAt: now - 30000 - index * 1000, partialResult: output(second, 80) })),
     { toolCallId: "wait-1", toolName: "wait", args: {}, startedAt: now - 60000, partialResult: { content: [{ type: "text", text: "" }], details: { op: "wait", jobs: waitJobs(second) } } }],
    jobFrames: jobs.map((call, index) => ({ id: "bg_" + index, state: "running", type: "bash", callId: call.id, at: Date.now() })) });
  };
  push({ entries, durableCount: entries.length, working: true, settled: false, state: { ...current.state, hasPendingAsyncWork: true } });
  window.ui.second();
 },
};
const nonce=readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); push();
`;

// Skipped when no Chromium-based browser is found; set OMP_TEST_CHROMIUM to point at one.
test("a reader scrolled up in a busy, live-ticking Chat stays where they scrolled", { skip: browserPath === undefined, timeout: 300_000 }, async t => {
	const bundled = await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") },
		bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' } });
	const script = bundled.outputFiles[0]!.text;
	const server = createServer((request, response) => {
		const fixtureUrl = new URL(request.url ?? "/", "http://fixture");
		const pathname = fixtureUrl.pathname;
		if (pathname === "/codicons/codicon.css" || pathname === "/codicons/codicon.ttf") {
			const file = pathname.endsWith(".css") ? "codicon.css" : "codicon.ttf";
			response.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : "font/ttf");
			response.end(readFileSync(join(process.cwd(), "node_modules/@vscode/codicons/dist", file)));
			return;
		}
		if (pathname === "/ui.js") {
			response.setHeader("Content-Type", "text/javascript"); response.end(script); return;
		}
		response.setHeader("Content-Type", "text/html");
		const webview = {
			cspSource: "'self'",
			asWebviewUri: (uri: { path: string }) => ({ toString: () => uri.path.endsWith(".js") ? "/ui.js" : "/codicons/codicon.css" }),
		} as unknown as vscode.Webview;
		const extensionUri = {
			path: "/extension", with({ path }: { path: string }) { return { path }; },
		} as unknown as vscode.Uri;
		const name = fixtureUrl.search.slice(1);
		const html = createGuestHtml(webview, extensionUri, "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d", null);
		const nonce = /<script nonce="([^"]+)"/.exec(html)![1]!;
		response.end(html.replace("</head>", `<style nonce="${nonce}">:root {
			--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#dddddd;--vscode-foreground:#dddddd;--vscode-editorWidget-background:#252526;
			--vscode-button-background:#007acc;--vscode-button-foreground:white;--vscode-input-background:#3c3c3c;
			--vscode-input-foreground:#ddd;--vscode-panel-border:#555;--vscode-font-family:Arial;--vscode-font-size:13px;
		}</style><script nonce="${nonce}">window.sent=[];window.errors=[];window.addEventListener("error",event=>window.errors.push(event.message));
		window.acquireVsCodeApi=()=>({postMessage(message){window.sent.push(message);document.dispatchEvent(new Event("fixture-post"))},setState(){}});</script>
		</head>`));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/`;
	const profile = await mkdtemp(join(tmpdir(), "omp-scroll-live-"));
	const child = spawn(browserPath!, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
		"--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
	let browser: Cdp | undefined;
	let page: Cdp | undefined;
	try {
		const readiness = Promise.withResolvers<string>();
		let stderr = "";
		// An external process cannot use the test runner's fake clock; this is only a launch-failure bound. It is generous:
		// the browser suites start Chromium at once, beside the broker end-to-end tests, and a loaded CI runner took over 20 s.
		const timer = setTimeout(() => readiness.reject(new Error("owned headless browser did not publish a DevTools endpoint")), 60_000);
		child.once("error", error => { clearTimeout(timer); readiness.reject(error); });
		child.stderr!.on("data", data => {
			stderr += String(data);
			const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
			if (match) { clearTimeout(timer); readiness.resolve(match[1]!); }
		});
		const endpoint = await readiness.promise;
		browser = await Cdp.connect(endpoint);
		const target = await browser.call("Target.createTarget", { url: "about:blank" });
		const targets = await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json() as { id: string; webSocketDebuggerUrl: string }[];
		page = await Cdp.connect(targets.find(row => row.id === target.targetId)!.webSocketDebuggerUrl);
		const ui = page;
		await ui.call("Page.enable");
		// The OS motion setting leaks into headless Chromium (CI images often turn animations off); pin the default.
		await ui.call("Emulation.setEmulatedMedia", { features: MOTION_ALLOWED });
		await ui.call("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
		const loaded = ui.event("Page.loadEventFired");
		await ui.call("Page.navigate", { url: url + "?scroll" });
		await loaded;
		await ui.wait("window.ui?.token === '?scroll' && document.querySelector('#root').firstElementChild");

		await t.test("a native scroll the intent window no longer covers is where the reader is: live ticks never restore the position from before it", async () => {
			await ui.evaluate("window.ui.busy()");
			await ui.wait("document.querySelector('.omp-overview-head') && document.querySelector('.omp-hud--jobs') && document.querySelector('[data-tool-name=\"wait\"]')");
			await ui.evaluate(`(()=>{
			 const group=document.querySelector('.omp-overview-head');
			 if(group.getAttribute('aria-expanded')!=='true')group.click();
			})()`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"run-8\"]')");
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"run-8\"] .omp-tool-head').click();document.querySelector('[data-tool-call-id=\"run-8\"] .omp-tool-head').focus({preventScroll:true})");
			await ui.settleGeometry(".omp-transcript");
			const point = await ui.evaluate<{ x: number; y: number }>("(()=>{const rect=document.querySelector('.omp-transcript').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()");
			const read = `(()=>{const root=document.querySelector('.omp-transcript'),top=root.getBoundingClientRect().top;const row=[...root.querySelectorAll('.omp-measured-row')].find(node=>node.getBoundingClientRect().bottom>top);return{scrollTop:root.scrollTop,key:row.dataset.windowRow,offset:row.getBoundingClientRect().top-top,detached:Boolean(document.querySelector('.omp-jump-latest'))}})()`;
			// A real wheel detaches the reader; the controller's own 250 ms intent expiry then ends the interval it owns.
			const expireIntent = "(()=>{const {promise,resolve}=Promise.withResolvers();setTimeout(resolve,650);return promise})()";
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
			await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: -120 });
			await ui.wait("document.querySelector('.omp-jump-latest')");
			await ui.evaluate(expireIntent);
			await ui.settleGeometry(".omp-transcript");
			// The compositor's scroll reaches the page late (a stalled main thread, a long animation): no wheel, key or pointer interval covers it.
			await ui.evaluate("document.querySelector('.omp-transcript').scrollTop-=1400");
			await ui.settleGeometry(".omp-transcript");
			const settled = await ui.evaluate<{ scrollTop: number; key: string; offset: number; detached: boolean }>(read);
			assert.equal(settled.detached, true);
			for (let second = 0; second < 4; second++) {
				await ui.evaluate("window.ui.second()");
				await ui.settleGeometry(".omp-transcript");
				const now = await ui.evaluate<{ scrollTop: number; key: string; offset: number; detached: boolean }>(read);
				assert.equal(now.key, settled.key, `second ${second}: the first visible row changed`);
				assert.ok(Math.abs(now.offset - settled.offset) <= 2, `second ${second}: the row moved ${now.offset - settled.offset}px`);
				assert.ok(Math.abs(now.scrollTop - settled.scrollTop) <= 80, `second ${second}: scrollTop went from ${settled.scrollTop} to ${now.scrollTop}`);
				assert.equal(now.detached, true, `second ${second}: still reading`);
			}
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});
	} finally {
		page?.socket.close(); browser?.socket.close();
		child.kill();
		await once(child, "exit").catch(() => undefined);
		server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
