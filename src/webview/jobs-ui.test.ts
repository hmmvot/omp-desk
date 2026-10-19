/** The Jobs row, the working row's job link, the tool cards' job chip and the `proc://` links, rendered by the real React app in an owned headless Chromium. */
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
const textRequest = message => message.type === "omp:chat-prompt" || message.type === "omp:chat-steer" || message.type === "omp:chat-follow-up";
// How the fake host answers a sent message: the admission status, the command_output line OMP prints (or none), or hold the answer back.
let answer = { status: "explained", reply: null, hold: false };
let held = null;
let replies = 0;
function answerRequest(request, how) {
 if (how.reply !== null) { replies += 1; push({ ephemeral: [...current.ephemeral, { id: "reply-" + replies, kind: "command_output", anchorId: null, seq: replies, timestamp: replies, payload: { text: how.reply } }] }); }
 receive({ type: "omp:chat-send-result", epoch: current.epoch, requestId: request.requestId, status: how.status });
}
const client = new ChatClient({ post(message) {
 const delivered = guestTransport.post(message);
 if (delivered && textRequest(message)) { if (answer.hold) held = message; else queueMicrotask(() => answerRequest(message, answer)); }
 return delivered;
} }); client.attach(guestTransport);
let current = { ...snapshotOf(createChatModel(), epoch), phase: "live", state: {
 model: { provider: "one", id: "old", name: "Original", contextWindow: 1000000 }, thinkingLevel: "low", isStreaming: false, isCompacting: false, queuedMessageCount: 0,
 contextUsage: { tokens: 40700, contextWindow: 1000000, percent: 4.07 }
} };
function receive(message) { window.dispatchEvent(new MessageEvent("message", { data: message })); }
function push(patch = {}) { current = { ...current, ...patch }; const parts = splitChatSnapshot(current, "ui-snapshot");
 receive(parts.snapshot); for (const chunk of parts.chunks) receive(chunk);
}
const iso = at => new Date(at).toISOString();
const row = (id, parentId, at, message) => ({ type: "message", id, parentId, timestamp: iso(at), message: { timestamp: at, ...message } });
window.ui = {
 token: location.search, current: () => current, receive, push,
 view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Owned UI session", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); },
 answerWith(status, reply = null) { answer = { status, reply, hold: false }; },
 holdAnswers() { answer = { ...answer, hold: true }; },
 release(status, reply = null) { const request = held; held = null; answerRequest(request, { status, reply }); },
 prompts: () => window.sent.filter(textRequest).map(message => message.text),
 // The transcript of background jobs: each {id, label, ago, state, type, call, delivered} is a call that started one; more are further messages.
 jobs(list, patch = {}, more = []) {
  const { pending, ...rest } = patch; const now = Date.now(); let parent = "u"; const entries = [row("u", null, now - 600000, { role: "user", content: "go" })];
  list.forEach((job, index) => {
   const call = job.call ?? "call-" + job.id, a = "a" + index, r = "r" + index;
   entries.push(row(a, parent, now - job.ago - 100, { role: "assistant", model: "m", stopReason: "toolUse", content: [{ type: "toolCall", id: call, name: "bash", arguments: { i: job.label, command: job.label } }] }));
   entries.push(row(r, a, now - job.ago, { role: "toolResult", toolCallId: call, toolName: "bash", isError: false, content: [{ type: "text", text: "Backgrounded as job " + job.id }], details: { async: { state: job.state ?? "running", jobId: job.id, type: job.type ?? "bash" } } }));
   parent = r;
   if (job.delivered) { const d = "d" + index; entries.push(row(d, parent, now - 500, { role: "custom", customType: "async-result", display: true, content: "done", details: { jobs: [{ jobId: job.id, type: "bash", status: job.delivered, label: job.label, durationMs: 1000 }] } })); parent = d; }
  });
  more.forEach((message, index) => { const id = "m" + index; entries.push(row(id, parent, now - 800 + index, message)); parent = id; });
  entries.push(row("z", parent, now - 1000, { role: "assistant", model: "m", stopReason: "stop", content: [{ type: "text", text: "Started." }] }));
  push({ entries, durableCount: entries.length, settled: false, ...rest, ...(pending === undefined ? {} : { state: { ...current.state, hasPendingAsyncWork: pending } }) });
 },
 commands(list) { push({ commands: list }); },
 live(id, call, state = "running", type = "bash") { push({ jobFrames: [...(current.jobFrames ?? []).filter(frame => frame.id !== id), { id, state, type, callId: call, at: Date.now() }] }); },
 frame(frame) { receive({ type: "omp:chat-event", epoch: current.epoch, frame }); },
};
const nonce=readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); push();
`;

// Skipped when no Chromium-based browser is found; set OMP_TEST_CHROMIUM to point at one.
test("background jobs in the Jobs row, the working row, tool cards and proc:// links", { skip: browserPath === undefined, timeout: 300_000 }, async t => {
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
		const nativeInterval=window.setInterval.bind(window), nativeClearInterval=window.clearInterval.bind(window), timers=new Map();let timerId=0;
		window.setInterval=(fn,ms,...args)=>{if(ms!==2000&&ms!==1000)return nativeInterval(fn,ms,...args);const id=--timerId;timers.set(id,{fn,ms,args});return id};
		window.clearInterval=id=>{if(!timers.delete(id))nativeClearInterval(id)};
		window.fixtureClock={setNow(value){Date.now=()=>value},fire(ms){for(const timer of [...timers.values()])if(timer.ms===ms)timer.fn(...timer.args)},count(ms){return [...timers.values()].filter(timer=>timer.ms===ms).length}};
		window.acquireVsCodeApi=()=>({postMessage(message){window.sent.push(message);document.dispatchEvent(new Event("fixture-post"))},setState(){}});</script>
		</head>`));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/`;
	const profile = await mkdtemp(join(tmpdir(), "omp-jobs-ui-"));
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
		// A fixed viewport: the rows' height cap is a share of it, so the bound tests need a known one.
		await ui.call("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });

		async function open(name: string): Promise<void> {
			const loaded = ui.event("Page.loadEventFired");
			await ui.call("Page.navigate", { url: url + "?" + name });
			await loaded;
			await ui.wait("window.ui?.token === '?" + name + "' && document.querySelector('#root').firstElementChild");
		}
		const KILL = "[{name:'jobs',source:'builtin',subcommands:[{name:'kill'}]}]";
		const text = (selector: string) => ui.evaluate<string>("document.querySelector(" + JSON.stringify(selector) + ")?.textContent ?? ''");
		const exists = (selector: string) => ui.evaluate<boolean>("document.querySelector(" + JSON.stringify(selector) + ") !== null");
		const prompts = () => ui.evaluate<string[]>("window.ui.prompts()");
		const JOB = "{id:'bg_1',label:'npm run dev',ago:180000}";
		/** A fresh page with the given background jobs; "live" marks a job as reported by this OMP process. */
		async function setup(name: string, jobs: string, options: { patch?: string; commands?: boolean; live?: string[]; expand?: boolean } = {}): Promise<void> {
			await open(name);
			if (options.commands !== false) await ui.evaluate("window.ui.commands(" + KILL + ")");
			await ui.evaluate("window.ui.jobs([" + jobs + "], " + (options.patch ?? "{pending:true}") + ")");
			for (const id of options.live ?? []) await ui.evaluate("window.ui.live('" + id + "','call-" + id + "')");
			if (options.expand !== false) {
				await ui.wait("document.querySelector('.omp-hud--jobs .omp-hud-toggle')");
				await ui.evaluate("document.querySelector('.omp-hud--jobs .omp-hud-toggle').click()");
				await ui.wait("document.querySelector('.omp-hud--jobs .omp-hud-rows')");
			}
		}
		const feedback = () => text(".omp-hud-jobs-feedback");
		const jobLine = (id: string) => ".omp-hud-job-item[data-job-id='" + id + "']";

		await t.test("the Jobs row is hidden while nothing is pending and states what runs when OMP reports pending work", async () => {
			await open("jobs-summary");
			await ui.evaluate("window.ui.jobs([" + JOB + "], {settled:true})");
			await ui.wait("document.querySelector('.omp-transcript')");
			assert.equal(await exists(".omp-hud--jobs"), false, "a settled chat with nothing pending has no Jobs row");
			await ui.evaluate("window.ui.jobs([" + JOB + "], {pending:true})");
			await ui.wait("document.querySelector('.omp-hud--jobs .omp-hud-summary')");
			assert.match(await text(".omp-hud--jobs .omp-hud-summary"), /^1 background job · bash: npm run dev · \d+m( \d+s)?$/);
			assert.equal(await exists(".omp-hud--jobs .omp-hud-rows"), false, "collapsed: one line");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud--jobs .omp-hud-toggle').getAttribute('aria-expanded')"), "false");
			await ui.evaluate("window.ui.jobs([" + JOB + "], {settled:true,pending:false})");
			await ui.wait("!document.querySelector('.omp-hud--jobs')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("an expanded row lists type, label and age, with a Cancel only for a job this process reported", async () => {
			await setup("jobs-rows", JOB, { commands: false });
			const line = await text(jobLine("bg_1"));
			assert.match(line, /bg_1/);
			assert.match(line, /bash: npm run dev/);
			assert.match(line, /\d+m/);
			assert.equal(await exists(jobLine("bg_1") + " .omp-hud-cancel"), false, "a job from history alone has no Cancel");
			assert.ok(await exists(".omp-hud-jobs-note"), "the honesty note follows the list");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud--jobs .omp-hud-toggle').getAttribute('aria-expanded')"), "true");
			await ui.evaluate("window.ui.commands(" + KILL + ");window.ui.live('bg_1','call-bg_1')");
			await ui.wait("document.querySelector(\"" + jobLine("bg_1") + " .omp-hud-cancel\")");
			assert.equal(await ui.evaluate("document.querySelector(\"" + jobLine("bg_1") + " .omp-hud-cancel\").getAttribute('aria-label')"), "Cancel bg_1");
			assert.deepEqual(await prompts(), []);
		});

		await t.test("Cancel is disabled with its reason when OMP lists no /jobs kill, and nothing is sent", async () => {
			await setup("jobs-no-kill", JOB, { commands: false, live: ["bg_1"] });
			await ui.wait("document.querySelector(\"" + jobLine("bg_1") + " .omp-hud-cancel\")");
			const state = await ui.evaluate<{ job: boolean; all: boolean; title: string; allTitle: string }>("(()=>{const job=document.querySelector(\"" + jobLine("bg_1") + " .omp-hud-cancel\"),all=document.querySelector('.omp-hud-cancel-all');return{job:job.disabled,all:all.disabled,title:job.title,allTitle:all.title}})()");
			assert.equal(state.job, true);
			assert.equal(state.all, true);
			assert.match(state.title, /did not list a \/jobs kill command/);
			assert.match(state.allTitle, /did not list a \/jobs kill command/);
			await ui.evaluate("window.ui.commands([{name:'jobs',source:'builtin'}])");
			await ui.wait("document.querySelector('.omp-hud-cancel-all').disabled && /did not list/.test(document.querySelector('.omp-hud-cancel-all').title)");
			await ui.evaluate("document.querySelector('.omp-hud-cancel-all').click();document.querySelector(\"" + jobLine("bg_1") + " .omp-hud-cancel\").click()");
			assert.deepEqual(await prompts(), []);
			await ui.evaluate("window.ui.commands(" + KILL + ")");
			await ui.wait("!document.querySelector('.omp-hud-cancel-all').disabled && !document.querySelector(\"" + jobLine("bg_1") + " .omp-hud-cancel\").disabled");
		});

		await t.test("Cancel all asks twice and sends exactly /jobs kill all; OMP's answer shows with a Dismiss", async () => {
			await setup("jobs-cancel-all", JOB, { live: ["bg_1"] });
			await ui.evaluate("window.ui.answerWith('explained','Cancelled 1 background job.')");
			assert.equal(await text(".omp-hud-cancel-all"), "Cancel all");
			await ui.evaluate("document.querySelector('.omp-hud-cancel-all').click()");
			await ui.wait("document.querySelector('.omp-hud-cancel-all').textContent==='Confirm cancel all'");
			assert.deepEqual(await prompts(), [], "the first click only arms");
			await ui.evaluate("document.querySelector('.omp-hud-cancel-all').click()");
			await ui.wait("document.querySelector('.omp-hud-jobs-feedback')?.textContent.includes('Cancelled 1 background job')");
			assert.deepEqual(await prompts(), ["/jobs kill all"]);
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud-jobs-feedback').getAttribute('role')"), "status");
			assert.equal(await text(".omp-hud-cancel-all"), "Cancel all", "armed state is reset");
			await ui.evaluate("[...document.querySelectorAll('.omp-hud-jobs-feedback button')].find(button=>button.textContent==='Dismiss').click()");
			await ui.wait("!document.querySelector('.omp-hud-jobs-feedback')");
		});

		await t.test("one job's Cancel sends /jobs kill <id>, shows Cancelling… while OMP is silent and then OMP's answer", async () => {
			await setup("jobs-cancel-one", JOB, { live: ["bg_1"] });
			await ui.evaluate("window.ui.holdAnswers()");
			await ui.evaluate("document.querySelector(\"" + jobLine("bg_1") + " .omp-hud-cancel\").click()");
			await ui.wait("document.querySelector(\"" + jobLine("bg_1") + " .omp-hud-cancel\")?.textContent==='Cancelling…'");
			assert.deepEqual(await prompts(), ["/jobs kill bg_1"]);
			assert.match(await feedback(), /Cancelling bg_1… waiting for OMP's answer/);
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud-cancel-all').disabled"), true, "one cancel is open at a time");
			await ui.evaluate("window.ui.release('explained','Could not cancel background job bg_1.')");
			await ui.wait("document.querySelector('.omp-hud-job-outcome')");
			assert.match(await text(".omp-hud-job-outcome"), /^Could not cancel background job bg_1/);
			assert.ok(await ui.evaluate("document.querySelector('.omp-hud-job-outcome').className.includes('omp-hud-tone--warning')"), "a failed cancel warns");
			assert.equal(await text(jobLine("bg_1") + " .omp-hud-cancel"), "Cancel", "the job is still listed and running");
			await ui.evaluate("window.ui.answerWith('explained','Cancelled background job bg_1.')");
			await ui.evaluate("document.querySelector(\"" + jobLine("bg_1") + " .omp-hud-cancel\").click()");
			await ui.wait("document.querySelector('.omp-hud-job-outcome')?.textContent.startsWith('Cancelled background job bg_1')");
			assert.ok(await ui.evaluate("document.querySelector('.omp-hud-job-outcome').className.includes('omp-hud-tone--success')"));
			assert.deepEqual(await prompts(), ["/jobs kill bg_1", "/jobs kill bg_1"]);
		});

		await t.test("a message OMP took for the model is refused, an unconfirmed send and a silent command say so, each with a Dismiss", async () => {
			await setup("jobs-refusals", JOB, { live: ["bg_1"] });
			const cancel = "document.querySelector(\"" + jobLine("bg_1") + " .omp-hud-cancel\").click()";
			const dismiss = async () => {
				await ui.evaluate("[...document.querySelectorAll('.omp-hud-jobs-feedback button')].find(button=>button.textContent==='Dismiss').click()");
				await ui.wait("!document.querySelector('.omp-hud-jobs-feedback')");
			};
			await ui.evaluate("window.ui.answerWith('accepted')");
			await ui.evaluate(cancel);
			await ui.wait("document.querySelector('.omp-hud-job-outcome')");
			assert.match(await text(".omp-hud-job-outcome"), /took \/jobs kill as a message for the model, not as a command/);
			assert.ok(await ui.evaluate("document.querySelector('.omp-hud-job-outcome').className.includes('omp-hud-tone--warning')"));
			await dismiss();
			await ui.evaluate("window.ui.answerWith('unconfirmed')");
			await ui.evaluate(cancel);
			await ui.wait("document.querySelector('.omp-hud-job-outcome')");
			assert.match(await text(".omp-hud-job-outcome"), /./);
			await dismiss();
			await ui.evaluate("window.ui.answerWith('explained')");
			await ui.evaluate(cancel);
			await ui.wait("document.querySelector('.omp-hud-job-outcome')", );
			assert.match(await text(".omp-hud-job-outcome"), /OMP ran the command but sent no answer/);
			await dismiss();
			assert.deepEqual(await prompts(), ["/jobs kill bg_1", "/jobs kill bg_1", "/jobs kill bg_1"]);
		});

		await t.test("OMP answering that no such job runs removes it from the list", async () => {
			await setup("jobs-gone", JOB, { live: ["bg_1"] });
			await ui.evaluate("window.ui.answerWith('explained','No running background job with id \"bg_1\".')");
			await ui.evaluate("document.querySelector(\"" + jobLine("bg_1") + " .omp-hud-cancel\").click()");
			await ui.wait("!document.querySelector(\"" + jobLine("bg_1") + "\")");
			assert.match(await text(".omp-hud--jobs .omp-hud-summary"), /^Background work is pending · no job is named in this chat$/);
			assert.match(await feedback(), /No running background job/);
			assert.deepEqual(await prompts(), ["/jobs kill bg_1"]);
		});

		await t.test("a list that may be missing jobs says so, an agent is left to the Agents row, and pending work no job names is not a count of zero", async () => {
			await setup("jobs-incomplete", JOB, { expand: false });
			await ui.evaluate("window.ui.jobs([" + JOB + "], {pending:true,olderCount:12})");
			await ui.wait("/^at least 1 background job · bash: npm run dev/.test(document.querySelector('.omp-hud--jobs .omp-hud-summary')?.textContent??'')");
			// A running agent is a task job: the Agents row shows it, and pending work that may be its alone draws no Jobs row.
			await ui.evaluate("window.ui.jobs([{id:'bg_2',label:'agent run',ago:60000,type:'task'}], {pending:true,olderCount:0})");
			await ui.wait("!document.querySelector('.omp-hud--jobs')");
			await ui.evaluate("window.ui.jobs([], {pending:true,olderCount:0})");
			await ui.wait("document.querySelector('.omp-hud--jobs .omp-hud-summary')?.textContent==='Background work is pending · no job is named in this chat'");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud--jobs .omp-hud-summary').className.includes('warn') || document.querySelector('.omp-hud--jobs').outerHTML.includes('warn')"), true, "drawn as a warning");
			// A tool call of the turn still running (an eval whose job is not named yet) may be all OMP is waiting for: no row, not the warning.
			await ui.evaluate("window.ui.push({activeTools:[{toolCallId:'eval-1',toolName:'eval',args:{},startedAt:Date.now()}]})");
			await ui.wait("!document.querySelector('.omp-hud--jobs')");
			await ui.evaluate("window.ui.push({activeTools:[]})");
			await ui.wait("document.querySelector('.omp-hud--jobs .omp-hud-summary')?.textContent==='Background work is pending · no job is named in this chat'");
		});

		await t.test("a short viewport drops the note before a job and folds the rest into +N more", async () => {
			const many = Array.from({ length: 6 }, (_, index) => "{id:'bg_" + (index + 1) + "',label:'job " + (index + 1) + "',ago:" + (60000 + index * 1000) + "}").join(",");
			await open("jobs-height");
			await ui.evaluate("window.ui.commands(" + KILL + ");window.ui.jobs([" + many + "], {pending:true})");
			await ui.wait("document.querySelector('.omp-hud--jobs .omp-hud-toggle')");
			await ui.evaluate("document.querySelector('.omp-hud--jobs .omp-hud-toggle').click()");
			await ui.wait("document.querySelector('.omp-hud--jobs .omp-hud-rows')");
			const tall = await ui.evaluate<{ jobs: number; more: string | null; note: boolean }>("(()=>{const list=document.querySelector('.omp-hud--jobs .omp-hud-rows');return{jobs:list.querySelectorAll('.omp-hud-job-item').length,more:list.querySelector('.omp-hud-more')?.textContent??null,note:list.querySelector('.omp-hud-jobs-note')!==null}})()");
			assert.deepEqual(tall, { jobs: 6, more: null, note: true }, "six jobs and the note fit a tall viewport");
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 1000, height: 300, deviceScaleFactor: 1, mobile: false });
			await ui.wait("document.querySelector('.omp-hud--jobs .omp-hud-more')");
			const short = await ui.evaluate<{ jobs: number; more: string; note: boolean }>("(()=>{const list=document.querySelector('.omp-hud--jobs .omp-hud-rows');return{jobs:list.querySelectorAll('.omp-hud-job-item').length,more:list.querySelector('.omp-hud-more').textContent,note:list.querySelector('.omp-hud-jobs-note')!==null}})()");
			assert.ok(short.jobs >= 1 && short.jobs < 6, "fewer jobs: " + short.jobs);
			assert.equal(short.more, "+" + (6 - short.jobs) + " more");
			assert.equal(short.note, false, "the note went first");
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
			await ui.wait("!document.querySelector('.omp-hud--jobs .omp-hud-more')");
		});

		const waiting = "{working:false,asyncPaused:true,workingIntent:'Хвост лога push',displayTurns:[{id:1,startedAt:Date.now()-600000,completedAt:null,complete:false,memberKeys:[]}]}";
		await t.test("while jobs hold the turn open the working row's wait is a button that shows them in the Jobs row", async () => {
			await setup("jobs-working", "{id:'bg_1',label:'Хвост лога push',ago:60000}", { patch: waiting, live: ["bg_1"], expand: false });
			await ui.wait("document.querySelector('.omp-working-status-link')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-working-status-link').tagName"), "BUTTON");
			assert.match(await text(".omp-working-status-link"), /^Waiting for background job: /);
			assert.match(await text(".omp-working-status .omp-sr-only[role=status]"), /Waiting for background job/, "the live region still announces the wait");
			assert.equal(await ui.evaluate("document.querySelector('.omp-working-status-link').closest('[role=status]')"), null, "the control is outside the live region");
			assert.equal(await exists(".omp-hud--jobs .omp-hud-rows"), false);
			await ui.evaluate("document.querySelector('.omp-working-status-link').click()");
			await ui.wait("document.querySelector('.omp-hud--jobs .omp-hud-job--focus')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud--jobs .omp-hud-toggle').getAttribute('aria-expanded')"), "true");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud-job--focus').dataset.jobId"), "bg_1");
			assert.deepEqual(await prompts(), []);
		});

		await t.test("with several jobs the link opens the row without choosing one, and other working states have no link", async () => {
			await setup("jobs-working-many", "{id:'bg_1',label:'one',ago:60000},{id:'bg_2',label:'two',ago:50000}", { patch: waiting, expand: false });
			await ui.wait("document.querySelector('.omp-working-status-link')");
			await ui.evaluate("document.querySelector('.omp-working-status-link').click()");
			await ui.wait("document.querySelector('.omp-hud--jobs .omp-hud-rows')");
			assert.equal(await exists(".omp-hud-job--focus"), false);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-hud--jobs .omp-hud-job-item').length"), 2);
			await ui.evaluate("window.ui.push({working:true,asyncPaused:false,workingIntent:'Reading'})");
			await ui.wait("!document.querySelector('.omp-working-status-link') && document.querySelector('.omp-working-status-text')");
			assert.notEqual(await ui.evaluate("document.querySelector('.omp-working-status-text').tagName"), "BUTTON");
			await ui.evaluate("window.ui.push({working:false,asyncPaused:true,uiRequests:[{id:'status-ask',method:'confirm',title:'Proceed?',message:''}]})");
			await ui.wait("document.querySelector('.omp-working-status-text')?.textContent==='Waiting for your answer'");
			assert.equal(await exists(".omp-working-status-link"), false);
		});

		const card = (call: string) => "[data-tool-call-id='" + call + "']";
		await t.test("a background bash card shows a live chip and a Cancel beside its head, and settles when a frame says so", async () => {
			await setup("jobs-card", JOB, { live: ["bg_1"], expand: false });
			await ui.wait("document.querySelector(\"" + card("call-bg_1") + " .omp-job-chip\")");
			const chip = card("call-bg_1") + " .omp-job-chip";
			assert.match(await text(chip), /^running · /);
			assert.equal(await ui.evaluate("document.querySelector(\"" + chip + "\").dataset.jobId"), "bg_1");
			assert.equal(await ui.evaluate("document.querySelector(\"" + chip + "\").closest('.omp-tool-head') !== null"), true, "the chip is part of the head");
			const place = await ui.evaluate<{ inHead: boolean; sibling: boolean }>("(()=>{const cancel=document.querySelector(\"" + card("call-bg_1") + " .omp-job-cancel\");const head=document.querySelector(\"" + card("call-bg_1") + " .omp-tool-head\");return{inHead:cancel.closest('.omp-tool-head')!==null||head.contains(cancel),sibling:cancel.parentElement===head.parentElement}})()");
			assert.deepEqual(place, { inHead: false, sibling: true });
			await ui.evaluate("window.ui.frame({type:'tool_execution_update',toolCallId:'call-bg_1',toolName:'bash',args:{},partialResult:{content:[],details:{async:{state:'completed',jobId:'bg_1',type:'bash'}}}})");
			await ui.wait("document.querySelector(\"" + chip + "\")?.dataset.jobState==='completed'");
			assert.match(await text(chip), /^done/);
			assert.equal(await exists(card("call-bg_1") + " .omp-job-cancel"), false, "no Cancel once it settled");
			assert.deepEqual(await prompts(), []);
		});

		await t.test("the chip says failed or cancelled as the job's last frame does", async () => {
			for (const state of ["failed", "cancelled"]) {
				await setup("jobs-card-" + state, JOB, { live: ["bg_1"], expand: false });
				await ui.wait("document.querySelector(\"" + card("call-bg_1") + " .omp-job-cancel\")");
				await ui.evaluate("window.ui.frame({type:'tool_execution_update',toolCallId:'call-bg_1',toolName:'bash',args:{},partialResult:{content:[],details:{async:{state:'" + state + "',jobId:'bg_1',type:'bash'}}}})");
				await ui.wait("document.querySelector(\"" + card("call-bg_1") + " .omp-job-chip\")?.dataset.jobState==='" + state + "'");
				assert.match(await text(card("call-bg_1") + " .omp-job-chip"), new RegExp("^" + state));
				assert.equal(await exists(card("call-bg_1") + " .omp-job-cancel"), false);
			}
		});

		await t.test("a delivered async result settles the chip", async () => {
			await setup("jobs-card-delivered", "{id:'bg_1',label:'npm run dev',ago:180000,delivered:'completed'}", { live: ["bg_1"], expand: false, patch: "{pending:true}" });
			await ui.wait("document.querySelector(\"" + card("call-bg_1") + " .omp-job-chip\")?.dataset.jobState==='completed'");
			assert.match(await text(card("call-bg_1") + " .omp-job-chip"), /^done/);
			assert.equal(await exists(card("call-bg_1") + " .omp-job-cancel"), false);
		});

		await t.test("an old card with no end evidence and nothing pending shows no chip, and a reused id stays on its own call's card", async () => {
			await setup("jobs-card-old", JOB, { patch: "{settled:true,pending:false}", expand: false });
			await ui.wait("document.querySelector(\"" + card("call-bg_1") + "\")");
			assert.equal(await exists(".omp-job-chip"), false);
			assert.equal(await exists(".omp-job-cancel"), false);
			await ui.evaluate("window.ui.jobs([{id:'bg_1',label:'first run',ago:300000,call:'call-a',delivered:'completed'},{id:'bg_1',label:'second run',ago:90000,call:'call-b'}], {pending:true})");
			await ui.evaluate("window.ui.live('bg_1','call-b')");
			await ui.wait("document.querySelector(\"" + card("call-b") + " .omp-job-chip\")");
			assert.match(await text(card("call-b") + " .omp-job-chip"), /^running/);
			assert.equal(await exists(card("call-a") + " .omp-job-chip"), false, "the earlier call's card does not show the later job");
			assert.equal(await exists(card("call-a") + " .omp-job-cancel"), false);
		});

		const assistant = (content: string) => "{role:'assistant',model:'m',stopReason:'stop',content:[{type:'text',text:" + JSON.stringify(content) + "}]}";
		const readCard = "{role:'assistant',model:'m',stopReason:'toolUse',content:[{type:'toolCall',id:'call-read',name:'read',arguments:{path:'proc://bg_1'}}]},{role:'toolResult',toolCallId:'call-read',toolName:'read',isError:false,content:[{type:'text',text:'job output'}],details:{proc:{jobs:[]}}}";
		const waitCard = "{role:'assistant',model:'m',stopReason:'toolUse',content:[{type:'toolCall',id:'call-wait',name:'wait',arguments:{}}]},{role:'toolResult',toolCallId:'call-wait',toolName:'wait',isError:false,content:[{type:'text',text:'settled'}],details:{jobs:[{id:'bg_1',type:'bash',status:'completed',label:'npm run dev',durationMs:1200},{id:'bg_2',type:'bash',status:'completed',label:'lint',durationMs:900}]}}";
		const links = [assistant("See proc://bg_1 for the log."), assistant("Run \`proc://bg_1\`."), assistant("Open [the job](proc://bg_1)."), assistant("Look at proc://bg_9 too."), assistant("Never act on proc://bg_1/kill."), readCard, assistant("Then the wait."), waitCard].join(",");
		await t.test("proc:// addresses in prose, code, link labels and cards are links that only show the job", async () => {
			await setup("jobs-links", JOB, { commands: true, live: ["bg_1"], expand: false });
			await ui.evaluate("window.ui.jobs([" + JOB + "], {pending:true}, [" + links + "]);window.ui.live('bg_1','call-bg_1')");
			await ui.wait("document.querySelectorAll('.omp-proc-link').length >= 6");
			await ui.evaluate("document.querySelector(\"[data-tool-call-id='call-wait'] .omp-tool-head\").click()");
			await ui.wait("document.querySelector('.omp-native-job .omp-proc-link')");
			const found = await ui.evaluate<string[]>("[...document.querySelectorAll('.omp-proc-link')].map(link=>link.dataset.procTarget)");
			assert.ok(found.filter(target => target === "proc://bg_1").length >= 5, "prose, code, labelled, read target and wait id: " + JSON.stringify(found));
			assert.ok(found.includes("proc://bg_9") && found.includes("proc://bg_1/kill"));
			assert.ok(await ui.evaluate("!!document.querySelector('.omp-native-job .omp-proc-link')"), "the wait card's job id links");
			assert.ok(await ui.evaluate("!!document.querySelector('code .omp-proc-link, .omp-proc-link code, .omp-proc-link')"));
			assert.equal(await exists(".omp-hud--jobs .omp-hud-rows"), false, "nothing is revealed before a click");
			const click = (target: string) => ui.evaluate("document.querySelector(\"[data-proc-target='" + target + "']\").click()");
			await click("proc://bg_1");
			await ui.wait("document.querySelector('.omp-hud--jobs .omp-hud-job--focus')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud--jobs .omp-hud-toggle').getAttribute('aria-expanded')"), "true");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud-job--focus').dataset.jobId"), "bg_1");
			await click("proc://bg_9");
			await ui.wait("document.querySelector('.omp-hud-job--focus')?.dataset.jobId==='bg_9'");
			assert.match(await text(".omp-hud-job--focus"), /no such job/);
			await click("proc://bg_1/kill");
			await ui.wait("document.querySelector('.omp-hud-job--focus')?.dataset.jobId==='bg_1'");
			assert.deepEqual(await prompts(), [], "a link, even proc://bg_1/kill, never sends anything");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>/^omp:chat-(prompt|steer|follow-up|command)$/.test(message.type))"), []);
		});

		await t.test("a proc:// link to an ended job reveals it with how it ended", async () => {
			await open("jobs-link-ended");
			await ui.evaluate("window.ui.commands(" + KILL + ");window.ui.jobs([{id:'bg_1',label:'npm run dev',ago:180000,delivered:'failed'}], {settled:true,pending:false}, [" + assistant("Check proc://bg_1 now.") + "])");
			await ui.wait("document.querySelector('.omp-proc-link')");
			assert.equal(await exists(".omp-hud--jobs"), false, "nothing is pending: no row yet");
			await ui.evaluate("document.querySelector('.omp-proc-link').click()");
			await ui.wait("document.querySelector('.omp-hud--jobs .omp-hud-job--focus')");
			assert.match(await text(".omp-hud-job--focus"), /bg_1.*failed/);
			assert.equal(await exists(".omp-hud-job--focus .omp-hud-cancel"), false, "an ended job has no Cancel");
			assert.deepEqual(await prompts(), []);
			await ui.evaluate("document.querySelector('.omp-hud--jobs .omp-hud-toggle').click()");
			await ui.wait("!document.querySelector('.omp-hud--jobs')");
		});
	} finally {
		page?.socket.close(); browser?.socket.close();
		child.kill();
		await once(child, "exit").catch(() => undefined);
		server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
