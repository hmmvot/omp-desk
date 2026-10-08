/** The pinned TODO/Agents rows and the detail tabs, rendered by the real React app in an owned headless Chromium. */
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
import { createDetailHtml, createGuestHtml } from "../host/guest-webview.ts";

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
import { splitChatSnapshot } from "./chat-messages";
import { injectGuestStyles } from "./styles";
import { attachSessionView } from "./lib/session-view";
import { adoptNonceForCreatedStyles } from "./lib/nonce-styles";
attachSessionView(guestTransport);
const epoch = { nonce: "host-ui-test", counter: 1 };
const client = new ChatClient(guestTransport); client.attach(guestTransport);
let current = { ...snapshotOf(createChatModel(), epoch), phase: "live", state: {
 model: { provider: "one", id: "old", name: "Original", contextWindow: 1000000 }, thinkingLevel: "low", isStreaming: false, isCompacting: false, queuedMessageCount: 0,
 contextUsage: { tokens: 40700, contextWindow: 1000000, percent: 4.07 }
} };
function receive(message) { window.dispatchEvent(new MessageEvent("message", { data: message })); }
function push(patch = {}) { current = { ...current, ...patch }; const parts = splitChatSnapshot(current, "ui-snapshot");
 receive(parts.snapshot); for (const chunk of parts.chunks) receive(chunk);
}
window.ui = {
 token: location.search, current: () => current, receive, push,
 view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Owned UI session", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); },
 reads: () => window.sent.filter(message => message.type === "omp:chat-subagent-read"),
 answer(request, page) { receive({ type: "omp:chat-subagent-chunk", requestId: request.requestId, epoch: request.epoch, subagentId: request.subagentId, index: 0, chunks: 1, text: JSON.stringify(page) }); },
};
const nonce=readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); if (!location.search.includes("delayed")) push();
`;

const message = (id: string, parentId: string | null, text: string) => `{type:'message',id:'${id}',parentId:${parentId === null ? "null" : `'${parentId}'`},timestamp:'2026-10-02T00:00:00Z',message:{role:'assistant',timestamp:1,model:'m',stopReason:'stop',content:[{type:'text',text:'${text}'}]}}`;

// Skipped when no Chromium-based browser is found; set OMP_TEST_CHROMIUM to point at one.
test("pinned TODO and Agents rows and their detail tabs", { skip: browserPath === undefined, timeout: 130_000 }, async t => {
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
		const html = name.startsWith("detail-todo") ? createDetailHtml(webview, extensionUri, { kind: "todo" })
			: name.startsWith("detail-agents") ? createDetailHtml(webview, extensionUri, { kind: "agents" })
			: name.startsWith("detail-agent") ? createDetailHtml(webview, extensionUri, { kind: "agent", agentId: "Worker One" })
			: name.startsWith("detail-invalid") ? createDetailHtml(webview, extensionUri, { kind: "todo" }).replace('content="todo"', 'content="plan"')
			: createGuestHtml(webview, extensionUri, "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d", null);
		const nonce = /<script nonce="([^"]+)"/.exec(html)![1]!;
		response.end(html.replace("</head>", `<style nonce="${nonce}">:root {
			--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#dddddd;--vscode-editorWidget-background:#252526;
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
	const profile = await mkdtemp(join(tmpdir(), "omp-todo-agents-ui-"));
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
			await ui.call("Page.navigate", { url: `${url}?${name}` });
			await loaded;
			await ui.wait(`window.ui?.token === '?${name}' && document.querySelector('#root').firstElementChild`);
		}
		const tasks = (prefix: string, count: number, status: string) => Array.from({ length: count }, (_, index) => `{content:'${prefix} ${index}',status:'${status}'}`).join(",");
		const todoSeed = `[{name:'Plan',tasks:[${tasks("Planned", 4, "completed")}]},
		 {name:'Build',tasks:[${tasks("Built", 2, "completed")},{content:'Current work',status:'in_progress',notes:['first note','second note'],details:'Why it matters'},${tasks("Later", 4, "pending")},{content:'Stuck work',status:'blocked',blocker:'Awaiting CI'}]},
		 {name:'Ship',tasks:[${tasks("Release", 2, "pending")}]}]`;
		const agents = (count: number) => `Array.from({length:${count}},(_,index)=>({id:index===0?'Worker One':'Reader'+index,index,agent:index===0?'implementer':'scout',agentSource:'bundled',status:'running',lastUpdate:1,description:'Job '+index,task:'Assignment text '+index,assignment:'Assignment text '+index,progress:{id:index===0?'Worker One':'Reader'+index,status:'running',currentTool:'read',lastIntent:'Inspecting '+index,durationMs:12345,tokens:4800}}))`;

		await t.test("collapsed rows are one line each with one counter, and cannot scroll", async () => {
			await open("rows-collapsed");
			await ui.evaluate(`window.ui.push({agents:${agents(3)},agentAvailability:'available',todoSeed:${todoSeed},entries:[${message("a", null, "hello")}]})`);
			await ui.wait("document.querySelector('.omp-hud--todo') && document.querySelector('.omp-hud--agents')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud-rows')"), null, "collapsed rows list nothing");
			const todo = await ui.evaluate<{ text: string; counters: number; expanded: string | null }>("(()=>{const head=document.querySelector('.omp-hud--todo .omp-hud-toggle');return{text:head.textContent,counters:head.querySelectorAll('.omp-hud-counter').length,expanded:head.getAttribute('aria-expanded')}})()");
			assert.match(todo.text, /Current work/);
			assert.equal(todo.counters, 1, "one counter, not a second status chip");
			assert.equal(todo.expanded, "false");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-hud--todo .omp-hud-counter').getAttribute('title')"), /\d+ of \d+/, "the counter names itself");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-hud--agents .omp-hud-toggle').textContent"), /3 running/);
			assert.equal(await ui.evaluate("[...document.querySelectorAll('.omp-hud, .omp-hud *')].every(node=>{const s=getComputedStyle(node);return s.overflowY!=='auto'&&s.overflowY!=='scroll'})"), true);
			assert.equal(await ui.evaluate("[...document.querySelectorAll('.omp-hud-head')].every(head=>head.getBoundingClientRect().height<=34)"), true, "each collapsed row is one line high");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("expanded TODO shows a bounded walking viewport that always includes the actionable task", async () => {
			await ui.evaluate("document.querySelector('.omp-hud--todo .omp-hud-toggle').click()");
			await ui.wait("document.querySelector('.omp-hud--todo .omp-hud-rows')");
			const controls = await ui.evaluate<{ controls: string | null; target: boolean; expanded: string | null }>("(()=>{const head=document.querySelector('.omp-hud--todo .omp-hud-toggle');return{controls:head.getAttribute('aria-controls'),target:document.getElementById(head.getAttribute('aria-controls')||'x')===document.querySelector('.omp-hud--todo .omp-hud-rows'),expanded:head.getAttribute('aria-expanded')}})()");
			assert.equal(controls.expanded, "true"); assert.equal(controls.target, true, "aria-controls names the rows list");
			const rows = await ui.evaluate<{ lines: number; text: string; more: string | null; taskRows: number }>("(()=>{const list=document.querySelector('.omp-hud--todo .omp-hud-rows');return{lines:list.querySelectorAll(':scope > li').length,text:list.textContent,more:list.querySelector('.omp-hud-more')?.textContent??null,taskRows:list.querySelectorAll('.omp-hud-task').length}})()");
			assert.ok(rows.lines <= 9, `at most eight rows and the +N more line: ${rows.lines}`);
			assert.match(rows.text, /Current work/);
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud--todo .omp-hud-phase .omp-hud-text').textContent"), "II. Build", "the actionable task retains its phase identity");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-hud--todo .omp-hud-counter').length"), 1, "the global count appears once");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud--todo .omp-hud-phase .omp-hud-dim')"), null, "phase headings do not duplicate counts");
			assert.doesNotMatch(rows.text, /Planned 0/, "earlier closed history is omitted");
			assert.doesNotMatch(rows.text, /Release 0/, "later phases are headers only");
			assert.equal(rows.more, `+${14 - rows.taskRows} more`);
			assert.doesNotMatch(rows.text, /first note|Why it matters|Awaiting CI/, "notes, details and blockers belong to the TODO tab");
			assert.match(rows.text, /⁺²/, "the note marker");
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-hud, .omp-hud *')].filter(node=>!node.classList.contains('omp-sr-only')&&node.scrollHeight>node.clientHeight+1).map(node=>node.className+':'+node.scrollHeight+'/'+node.clientHeight)"), [], "no clipped or scrolling content");
			await ui.evaluate("document.querySelector('.omp-hud--todo .omp-hud-more').click()");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:open-detail').at(-1)"), { type: "omp:open-detail", kind: "todo" });
			await ui.evaluate("document.querySelector('.omp-hud--todo .omp-hud-toggle').click()");
			await ui.wait("document.querySelector('.omp-hud--todo .omp-hud-rows') === null && document.querySelector('.omp-hud--todo .omp-hud-toggle').getAttribute('aria-expanded') === 'false'");
		});

		await t.test("expanded Agents shows eight lines and opens one agent's tab without reading any child", async () => {
			await ui.evaluate(`window.ui.push({agents:${agents(11)}})`);
			await ui.evaluate("document.querySelector('.omp-hud--agents .omp-hud-toggle').click()");
			await ui.wait("document.querySelectorAll('.omp-hud--agents .omp-hud-agent').length === 8");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud--agents .omp-hud-more').textContent"), "+3 more");
			const first = await ui.evaluate<string>("document.querySelector('.omp-hud--agents .omp-hud-agent').textContent");
			assert.match(first, /Worker One/); assert.match(first, /implementer/); assert.match(first, /read · Inspecting 0/);
			assert.doesNotMatch(first, /Job 0/, "the spawn description is not in the row; it is in the tooltip");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-hud--agents .omp-hud-agent').title"), /Job 0/);
			assert.doesNotMatch(first, /tokens|4\.8k|running/, "statistics and status words are not inline");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud--agents .omp-hud-agent').tagName"), "BUTTON", "a native button: Enter and Space activate it");
			await ui.evaluate("document.querySelector('.omp-hud--agents .omp-hud-agent').click()");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:open-detail').at(-1)"), { type: "omp:open-detail", kind: "agent", agentId: "Worker One" });
			assert.equal(await ui.evaluate("window.ui.reads().length"), 0, "the pinned row never reads a child");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud--agents').scrollHeight <= document.querySelector('.omp-hud--agents').clientHeight + 1"), true);
		});

		await t.test("a running row's glyph rotates unless motion is reduced", async () => {
			const animation = "getComputedStyle(document.querySelector('.omp-hud--agents .omp-hud-agent .codicon-loading')).animationName";
			assert.notEqual(await ui.evaluate(animation), "none", "the running glyph has a running animation, like the tool rows' spinner");
			await ui.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
			assert.equal(await ui.evaluate(animation), "none", "reduced motion stops it");
			await ui.call("Emulation.setEmulatedMedia", { features: MOTION_ALLOWED });
		});

		await t.test("an Agents row is glyph, id, type, activity and time: only the activity truncates, the task description is the tooltip", async () => {
			const nextFrames = "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))";
			const description = "Chat ask dialog layout and every other long thing the assignment text said, which is far wider than any row";
			const activity = "wait · Wait for the full suite and every long running verification that the main agent asked for";
			const roster = ["ReleasePrep", "SendSelection", "AskDialogRefresh"].map((id, index) => `{id:'${id}',index:${index},agent:'implementer',agentSource:'bundled',status:'running',lastUpdate:1,description:${JSON.stringify(description)},progress:{id:'${id}',status:'running',currentTool:'wait',lastIntent:${JSON.stringify(activity.slice("wait · ".length))},durationMs:${119600 + index}}}`).join(",");
			const bare = `{id:'Quiet',index:9,agent:'task',agentSource:'bundled',status:'running',lastUpdate:1,description:${JSON.stringify(description)}}`;
			// A running agent's time advances with the clock between progress events; pin it so the reported 2m 00s stays exact on a slow machine.
			await ui.evaluate("window.fixtureClock.setNow(1800000000000)");
			for (const width of [800, 320]) {
				await ui.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
				await ui.evaluate(`window.ui.push({agents:[${roster},${bare}],agentAvailability:'available'})`);
				await ui.wait("document.querySelectorAll('.omp-hud--agents .omp-hud-agent').length === 4");
				await ui.evaluate(nextFrames);
				const rows = await ui.evaluate<{ id: string; idClipped: boolean; badge: string; badgeClipped: boolean; elapsed: string; elapsedClipped: boolean; elapsedInside: boolean; activity: string | null; activityClipped: boolean; text: string; title: string; height: number }[]>(`[...document.querySelectorAll('.omp-hud--agents .omp-hud-agent')].map(line=>{
				 const box=line.getBoundingClientRect(), clipped=node=>node!==null&&node.scrollWidth>node.clientWidth+1, id=line.querySelector('.omp-hud-agent-id'), badge=line.querySelector('.omp-hud-badge'), elapsed=line.querySelector('.omp-hud-elapsed'), activity=line.querySelector('.omp-hud-activity');
				 return{id:id.textContent,idClipped:clipped(id),badge:badge?.textContent??'',badgeClipped:clipped(badge),elapsed:elapsed?.textContent??'',elapsedClipped:clipped(elapsed),elapsedInside:elapsed===null||elapsed.getBoundingClientRect().right<=box.right+1,activity:activity?.textContent??null,activityClipped:clipped(activity),text:line.textContent,title:line.title,height:box.height}})`);
				for (const row of rows) {
					assert.equal(row.idClipped || row.badgeClipped || row.elapsedClipped, false, `${width}px ${row.id}: the id, badge and time are never truncated`);
					assert.equal(row.elapsedInside, true, `${width}px ${row.id}: the time stays inside the row`);
					assert.doesNotMatch(row.text, /Chat ask dialog/, `${width}px ${row.id}: the description is not in the row`);
					assert.match(row.title, /Chat ask dialog layout/, `${width}px ${row.id}: the tooltip carries the task description`);
				}
				const [prep, send, refs, quiet] = rows as [typeof rows[number], typeof rows[number], typeof rows[number], typeof rows[number]];
				assert.deepEqual([prep.id, prep.badge, prep.elapsed], ["ReleasePrep", "implementer", "2m 00s"]);
				assert.deepEqual([send.id, refs.id], ["SendSelection", "AskDialogRefresh"]);
				assert.match(send.title, /Wait for the full suite and every long running verification/, `${width}px: the tooltip carries the full activity`);
				assert.equal(prep.activityClipped, true, `${width}px: the long activity is what is cut, with an ellipsis`);
				assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('.omp-hud--agents .omp-hud-activity')).textOverflow"), "ellipsis");
				assert.deepEqual([quiet.badge, quiet.activity], ["", null], "no type means no badge and no activity means no text, never the description");
				assert.ok(quiet.height <= 20.5, `an idle row is one line (${quiet.height})`);
				if (width === 800) assert.ok(rows.every(row => row.height <= 20.5), `one line each at 800px: ${rows.map(row => row.height)}`);
			}
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
		});

		// The native `progress.durationMs` only moves when an OMP progress event arrives; the displayed time must not wait for one.
		const T0 = 1_800_000_000_000;
		const clocked = (id: string, index: number, status: string, durationMs: number) => `{id:'${id}',index:${index},agent:'implementer',agentSource:'bundled',status:'${status}',lastUpdate:1,description:'Job',progress:{id:'${id}',status:'${status}',durationMs:${durationMs}}}`;
		const roster = (alpha: [string, number], beta: [string, number]) => `window.ui.push({agents:[${clocked("Alpha", 0, alpha[0], alpha[1])},${clocked("Beta", 1, beta[0], beta[1])}],agentAvailability:'available'})`;
		const tick = (ms: number) => ui.evaluate(`window.fixtureClock.setNow(${T0 + ms});window.fixtureClock.fire(1000)`);
		const rowTimes = "[...document.querySelectorAll('.omp-hud--agents .omp-hud-agent')].map(row=>row.querySelector('.omp-hud-elapsed')?.textContent??'').join(' ')";
		await t.test("the Agents row's per-agent time ticks every second with no progress events, freezes at completion, and no timer runs while nothing is running", async () => {
			await open("agents-clock");
			await ui.evaluate(`window.fixtureClock.setNow(${T0})`);
			await ui.evaluate(roster(["running", 69_000], ["running", 226_000]));
			await ui.wait("document.querySelector('.omp-hud--agents .omp-hud-toggle')");
			assert.equal(await ui.evaluate("window.fixtureClock.count(1000)"), 0, "collapsed rows show no time, so nothing ticks");
			await ui.evaluate("document.querySelector('.omp-hud--agents .omp-hud-toggle').click()");
			await ui.wait(`${rowTimes}==='1m 09s 3m 46s'`);
			assert.equal(await ui.evaluate("window.fixtureClock.count(1000)"), 1, "one shared interval serves every running row");
			await tick(5_000);
			await ui.wait(`${rowTimes}==='1m 14s 3m 51s'`);
			await tick(65_000);
			await ui.wait(`${rowTimes}==='2m 14s 4m 51s'`);
			// A progress event with the authoritative value agrees with the local estimate.
			await ui.evaluate(`window.fixtureClock.setNow(${T0 + 66_000})`);
			await ui.evaluate(roster(["running", 135_000], ["running", 292_000]));
			await ui.wait(`${rowTimes}==='2m 15s 4m 52s'`);
			// Alpha completes with its final duration and stops; Beta keeps going.
			await ui.evaluate(roster(["completed", 140_000], ["running", 292_000]));
			await ui.wait(`${rowTimes}==='2m 20s 4m 52s'`);
			await tick(100_000);
			await ui.wait(`${rowTimes}==='2m 20s 5m 26s'`);
			assert.equal(await ui.evaluate("window.fixtureClock.count(1000)"), 1);
			// Nothing running: the final durations stand and no interval remains.
			await ui.evaluate(roster(["completed", 140_000], ["failed", 330_000]));
			await ui.wait(`${rowTimes}==='2m 20s 5m 30s'`);
			await tick(200_000);
			assert.equal(await ui.evaluate(rowTimes), "2m 20s 5m 30s");
			assert.equal(await ui.evaluate("window.fixtureClock.count(1000)"), 0, "no timer while nothing is running");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the Agents tab and a single agent's tab tick their times between progress events too", async () => {
			await open("detail-agents-clock");
			await ui.evaluate(`window.fixtureClock.setNow(${T0})`);
			await ui.evaluate(`window.ui.push({agents:[${clocked("Worker One", 0, "running", 69_000)},${clocked("Reader1", 1, "completed", 226_000)}],agentAvailability:'available'})`);
			const tabTimes = "[...document.querySelectorAll('.omp-detail-agent')].map(row=>row.querySelector('.omp-hud-elapsed').textContent).join(' ')";
			await ui.wait(`${tabTimes}==='1m 09s 3m 46s'`);
			assert.equal(await ui.evaluate("document.querySelector('.omp-detail-agent .omp-native-agent-stats')"), null, "elapsed is shown once in the row heading");
			await tick(8_000);
			await ui.wait(`${tabTimes}==='1m 17s 3m 46s'`);
			await open("detail-agent-clock");
			await ui.evaluate(`window.fixtureClock.setNow(${T0})`);
			await ui.evaluate(`window.ui.push({agents:[${clocked("Worker One", 0, "running", 69_000)}],agentAvailability:'available'})`);
			const title = "document.querySelector('.omp-detail-title .omp-hud-elapsed')?.textContent";
			await ui.wait(`${title}==='1m 09s'`);
			assert.equal(await ui.evaluate("document.querySelector('.omp-detail-agent-line .omp-native-agent-stats')"), null, "elapsed is not repeated in progress");
			await tick(8_000);
			await ui.wait(`${title}==='1m 17s'`);
			await ui.evaluate(`window.ui.push({agents:[${clocked("Worker One", 0, "completed", 80_000)}],agentAvailability:'available'})`);
			await ui.wait(`${title}==='1m 20s'`);
			await tick(60_000);
			assert.equal(await ui.evaluate(title), "1m 20s");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		const history = `(()=>{const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
		 return Array.from({length:14},(_,i)=>i%2===0?row('u'+i,{role:'user',timestamp:1000+i,content:'Prompt '+i}):row('a'+i,{role:'assistant',model:'m',timestamp:1000+i,stopReason:'stop',content:[{type:'text',text:'Reply '+i+'\\n\\n'+Array.from({length:6},(_,line)=>'Line '+i+'.'+line+' of readable history text.').join('\\n\\n')}]}))})()`;
		const frames = "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))";
		// The scroll controller's wheel intent expires on the platform clock (250 ms), outside the fixture's fake interval clock; no event signals its end.
		const sleep = (ms: number) => ui.evaluate(`new Promise(r=>setTimeout(r,${ms}))`);
		// Transcript geometry settles over several frames after a push (measured rows); wait until it stops changing.
		const settle = () => ui.evaluate(`(async()=>{const root=document.querySelector('.omp-transcript');let previous='',stable=0;const deadline=performance.now()+5000;
		 while(stable<3&&performance.now()<deadline){await ${frames};const now=root.scrollHeight+':'+root.clientHeight+':'+root.scrollTop;stable=now===previous?stable+1:0;previous=now}})()`);
		const loadDock = async (name: string) => {
			await open(name);
			await ui.evaluate(`window.ui.push({entries:${history},durableCount:14,working:false,settled:true,agents:${agents(3)},agentAvailability:'available',todoSeed:${todoSeed}})`);
			await ui.wait("document.querySelector('.omp-hud--todo') && document.querySelector('.omp-hud--agents') && document.querySelector('.omp-transcript').scrollHeight>1000");
			await settle();
		};

		await t.test("the rows sit after the transcript and before the composer, inside the chat column, as flat tool rows", async () => {
			await loadDock("rows-dock");
			const layout = await ui.evaluate<Record<string, boolean | number | string>>(`(()=>{
			 const rect=selector=>document.querySelector(selector).getBoundingClientRect();
			 const stack=document.querySelector('.omp-hud-stack'),transcript=document.querySelector('.omp-transcript'),composer=document.querySelector('.omp-composer'),dock=document.querySelector('.omp-dock');
			 const follows=(a,b)=>Boolean(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING);
			 const hud=getComputedStyle(document.querySelector('.omp-hud--todo')),toggle=getComputedStyle(document.querySelector('.omp-hud--todo .omp-hud-toggle')),tool=document.querySelector('.omp-tool-head');
			 return{transcriptBeforeStack:follows(transcript,stack),stackBeforeComposer:follows(stack,composer),inDock:dock.contains(stack)&&dock.contains(composer),outsideTranscript:!transcript.contains(stack)&&document.querySelectorAll('.omp-transcript .omp-hud, .omp-main .omp-hud').length===0,
			  transcriptBottom:rect('.omp-transcript').bottom,dockTop:rect('.omp-dock').top,stackTop:rect('.omp-hud-stack').top,stackBottom:rect('.omp-hud-stack').bottom,composerTop:rect('.omp-composer').top,
			  stackLeft:rect('.omp-hud-stack').left,stackRight:rect('.omp-hud-stack').right,composerLeft:rect('.omp-composer').left,composerRight:rect('.omp-composer').right,contentLeft:rect('.omp-transcript-content').left,
			  stackWidth:rect('.omp-hud-stack').width,backgroundOfRow:hud.backgroundColor,toggleBackground:toggle.backgroundColor,borderBottom:parseFloat(hud.borderBottomWidth),toggleFontSize:toggle.fontSize,togglePadding:toggle.padding,
			  rowCount:document.querySelectorAll('.omp-hud').length,transcriptHeight:transcript.clientHeight}})()`);
			assert.equal(layout.transcriptBeforeStack, true, "DOM order: transcript, then the rows");
			assert.equal(layout.stackBeforeComposer, true, "DOM order: rows, then the composer");
			assert.equal(layout.inDock, true, "rows and composer share the bottom block");
			assert.equal(layout.outsideTranscript, true, "the rows are not inside the scrolling transcript or the transcript column");
			assert.ok((layout.transcriptBottom as number) <= (layout.stackTop as number) + 0.5, "the transcript viewport ends above the rows");
			assert.ok(Math.abs((layout.dockTop as number) - (layout.stackTop as number)) <= 0.5, "the rows are the top of the bottom block");
			assert.ok(Math.abs((layout.stackBottom as number) - (layout.composerTop as number)) <= 8, `the rows sit directly above the composer card (${layout.stackBottom} vs ${layout.composerTop})`);
			assert.ok((layout.stackWidth as number) <= 840.5, "same max width as the transcript column and the dock");
			assert.ok(Math.abs((layout.stackLeft as number) - (layout.composerLeft as number)) <= 1 && Math.abs((layout.stackRight as number) - (layout.composerRight as number)) <= 1, "same horizontal extent as the composer card");
			assert.ok(Math.abs((layout.stackLeft as number) - (layout.contentLeft as number)) <= 1, `aligned with the transcript column (${layout.stackLeft} vs ${layout.contentLeft})`);
			assert.equal(layout.backgroundOfRow, "rgba(0, 0, 0, 0)", "no panel background");
			assert.equal(layout.toggleBackground, "rgba(0, 0, 0, 0)");
			assert.equal(layout.borderBottom, 0, "no band rule");
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-hud-toggle')].map(toggle=>[...toggle.children].slice(0,3).map(node=>node.className.replace(/^codicon /,'')))"), [["codicon-chevron-right", "codicon-checklist", "omp-hud-label"], ["codicon-chevron-right", "codicon-organization", "omp-hud-label"]], "chevron, icon, bold label, like a tool row");
			assert.equal(layout.rowCount, 2);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a row has the tool row's font size, padding and hover", async () => {
			await ui.evaluate(`window.ui.push({entries:[...window.ui.current().entries,{type:'message',id:'tc',parentId:null,timestamp:new Date(1000).toISOString(),message:{role:'assistant',model:'m',timestamp:2000,stopReason:'toolUse',content:[{type:'toolCall',id:'call-1',name:'bash',arguments:{command:'echo hi'}}]}}]})`);
			await ui.wait("document.querySelector('.omp-tool-head')");
			const same = await ui.evaluate<{ fontSize: string[]; padding: string[]; hover: string[]; codicon: string[] }>(`(()=>{
			 const tool=document.querySelector('.omp-tool-head'),hud=document.querySelector('.omp-hud--todo .omp-hud-toggle');
			 const read=(node,props)=>props.map(p=>getComputedStyle(node)[p]);
			 const hoverRule=selector=>[...document.styleSheets].flatMap(sheet=>[...sheet.cssRules]).filter(rule=>rule.selectorText&&rule.selectorText.split(',').some(part=>part.trim()===selector)).map(rule=>rule.style.background||rule.style.backgroundColor);
			 return{fontSize:[getComputedStyle(tool).fontSize,getComputedStyle(hud).fontSize],padding:[getComputedStyle(tool).padding,getComputedStyle(hud).padding],
			  hover:[...hoverRule('.omp-tool-head:hover'),...hoverRule('.omp-hud-toggle:hover')],codicon:[getComputedStyle(tool.querySelector('.codicon')).fontSize,getComputedStyle(hud.querySelector('.codicon')).fontSize]}})()`);
			assert.equal(same.fontSize[0], same.fontSize[1], "same font size as .omp-tool-head");
			assert.equal(same.padding[0], same.padding[1], "same padding as .omp-tool-head");
			assert.equal(same.codicon[0], same.codicon[1], "same chevron size");
			assert.deepEqual([...new Set(same.hover)], ["var(--vscode-list-hoverBackground)"], "same hover background");
		});

		await t.test("expanding or collapsing a row, or a row appearing or disappearing, keeps the bottom visible line fixed against the bottom block's top, following and detached", async () => {
			await loadDock("rows-anchor");
			const probe = (key: string) => `(()=>{const dock=document.querySelector('.omp-dock').getBoundingClientRect().top,root=document.querySelector('.omp-transcript'),rootBottom=root.getBoundingClientRect().bottom;
			 const key=${JSON.stringify(key)};const rows=[...root.querySelectorAll('[data-anchor-key]')];
			 const target=key?rows.find(row=>row.dataset.anchorKey===key):rows.filter(row=>row.getBoundingClientRect().top<rootBottom).at(-1);
			 const rect=target.getBoundingClientRect();return{key:target.dataset.anchorKey,offset:rect.top-dock,dock,top:root.scrollTop,tail:Math.abs(root.scrollHeight-root.clientHeight-root.scrollTop)<=1,btn:Boolean(document.querySelector('.omp-jump-latest'))}})()`;
			for (const mode of ["following", "detached"]) {
				await ui.evaluate(`window.ui.push({agents:${agents(3)},todoSeed:${todoSeed}})`);
				await ui.wait("document.querySelector('.omp-hud--todo') && document.querySelector('.omp-hud--agents')");
				for (const selector of [".omp-hud--todo .omp-hud-toggle[aria-expanded=true]", ".omp-hud--agents .omp-hud-toggle[aria-expanded=true]"]) await ui.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
				await settle();
				if (mode === "detached") {
					const point = await ui.evaluate<{ x: number; y: number }>("(()=>{const rect=document.querySelector('.omp-transcript').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()");
					await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
					await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: -130 });
					await ui.wait("document.querySelector('.omp-jump-latest')");
					await sleep(600);
					await settle();
				}
				const base = await ui.evaluate<{ key: string; offset: number; tail: boolean; btn: boolean }>(probe(""));
				assert.equal(base.btn, mode === "detached");
				const check = async (label: string) => {
					await ui.evaluate(frames); await settle();
					const now = await ui.evaluate<{ offset: number; tail: boolean; btn: boolean; dock: number }>(probe(base.key));
					assert.ok(Math.abs(now.offset - base.offset) <= 1, `${mode}: ${label} moved the bottom line by ${now.offset - base.offset}px`);
					assert.equal(now.btn, mode === "detached", `${mode}: ${label} kept the jump-to-latest state`);
					if (mode === "following") assert.ok(now.tail, `${mode}: ${label} stays pinned to the tail`);
					return now.dock;
				};
				const docks = [base.offset];
				const toggle = async (selector: string, label: string) => { await ui.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); docks.push(await check(label)); };
				const dockBefore = await ui.evaluate<number>("document.querySelector('.omp-dock').getBoundingClientRect().top");
				await toggle(".omp-hud--todo .omp-hud-toggle", "expanding TODO");
				const dockTodo = await ui.evaluate<number>("document.querySelector('.omp-dock').getBoundingClientRect().top");
				assert.ok(dockTodo < dockBefore - 40, `${mode}: expanding TODO grew the bottom block (${dockBefore} -> ${dockTodo})`);
				await toggle(".omp-hud--agents .omp-hud-toggle", "expanding Agents");
				await toggle(".omp-hud--todo .omp-hud-toggle", "collapsing TODO");
				await toggle(".omp-hud--agents .omp-hud-toggle", "collapsing Agents");
				await ui.evaluate("window.ui.push({agents:[],todoSeed:[]})");
				await ui.wait("document.querySelector('.omp-hud') === null");
				await check("both rows disappearing");
				await ui.evaluate(`window.ui.push({agents:${agents(3)},todoSeed:${todoSeed}})`);
				await ui.wait("document.querySelector('.omp-hud--todo') && document.querySelector('.omp-hud--agents')");
				await check("both rows appearing");
				assert.ok(await ui.evaluate("window.ui.current().entries.length>0"));
				if (mode === "following") await ui.evaluate("document.querySelector('.omp-hud--todo .omp-hud-toggle').click()");
			}
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("both rows expanded in a short window are capped at 40% of the viewport by showing fewer rows plus +N more, never a scroll region", async () => {
			await loadDock("rows-cap");
			await ui.evaluate(`window.ui.push({agents:${agents(11)}})`);
			await ui.wait("document.querySelector('.omp-hud--agents')?.textContent.includes('11 running')");
			await ui.evaluate("document.querySelectorAll('.omp-hud-toggle').forEach(toggle=>toggle.click())");
			await ui.wait("document.querySelector('.omp-hud--todo .omp-hud-rows') && document.querySelector('.omp-hud--agents .omp-hud-rows')");
			const measure = (): Promise<{ viewport: number; stack: number; agentRows: number; agentMore: string | null; todoMore: string | null; todoRows: number; scrolling: boolean; actionable: boolean }> => ui.evaluate(`(()=>{
			 const list=selector=>document.querySelector(selector);
			 return{viewport:innerHeight,stack:list('.omp-hud-stack').getBoundingClientRect().height,agentRows:document.querySelectorAll('.omp-hud--agents .omp-hud-agent').length,agentMore:list('.omp-hud--agents .omp-hud-more')?.textContent??null,
			  todoRows:document.querySelectorAll('.omp-hud--todo .omp-hud-rows > li').length,todoMore:list('.omp-hud--todo .omp-hud-more')?.textContent??null,actionable:list('.omp-hud--todo .omp-hud-rows')?.textContent.includes('Current work')??false,
			  scrolling:[...document.querySelectorAll('.omp-hud, .omp-hud *')].some(node=>{const s=getComputedStyle(node);return s.overflowY==='auto'||s.overflowY==='scroll'||(!node.classList.contains('omp-sr-only')&&node.scrollHeight>node.clientHeight+1)})}})()`);
			const heights: number[] = [];
			for (const height of [900, 700, 500, 400]) {
				await ui.call("Emulation.setDeviceMetricsOverride", { width: 1000, height, deviceScaleFactor: 1, mobile: false });
				await ui.evaluate(frames); await ui.evaluate(frames);
				const now = await measure();
				heights.push(now.stack);
				assert.equal(now.viewport, height);
				assert.ok(now.stack <= height * 0.4 + 0.5, `at ${height}px the rows take ${now.stack}px, over 40%`);
				assert.equal(now.scrolling, false, `at ${height}px no scroll region or clipped content`);
				assert.ok(now.agentRows >= 1 && now.agentMore !== null, `at ${height}px the agents show a few rows plus +N more (${now.agentRows} ${now.agentMore})`);
				assert.equal(Number(now.agentMore!.replace(/\D+/g, "")), 11 - now.agentRows, "the count names exactly the agents not shown");
				assert.ok(now.todoMore !== null && now.actionable, `at ${height}px the TODO keeps its actionable task and a +N more row`);
			}
			assert.ok(heights.every((value, index) => index === 0 || value <= heights[index - 1]! + 0.5), `shorter windows never grow the rows (${heights.join(", ")})`);
			assert.ok(heights[0]! > heights.at(-1)!, "the cap actually reduced the rows");
			// With only one row open the whole share is its own: the original eight rows still fit a tall window.
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
			await ui.evaluate("document.querySelector('.omp-hud--todo .omp-hud-toggle').click()");
			await ui.wait("document.querySelectorAll('.omp-hud--agents .omp-hud-agent').length===8 && document.querySelector('.omp-hud--todo .omp-hud-rows')===null");
			assert.ok((await measure()).stack <= 900 * 0.4 + 0.5);
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("at 320px the rows truncate cleanly: one line each, no horizontal overflow", async () => {
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
			await loadDock("rows-narrow");
			await ui.evaluate("document.querySelectorAll('.omp-hud-toggle').forEach(toggle=>toggle.click())");
			await ui.wait("document.querySelector('.omp-hud--todo .omp-hud-rows') && document.querySelector('.omp-hud--agents .omp-hud-rows')");
			await ui.evaluate(frames);
			const narrow = await ui.evaluate<{ overflow: number; width: number; stack: { left: number; right: number }; headHeights: number[]; lineHeights: number[]; escaped: string[]; truncated: boolean; openInside: boolean }>(`(()=>{
			 const stack=document.querySelector('.omp-hud-stack').getBoundingClientRect();
			 const escaped=[...document.querySelectorAll('.omp-hud *')].filter(node=>!node.classList.contains('omp-sr-only')&&node.getBoundingClientRect().width>0&&(node.getBoundingClientRect().right>stack.right+1||node.getBoundingClientRect().left<stack.left-1)).map(node=>node.className+' '+Math.round(node.getBoundingClientRect().left)+'-'+Math.round(node.getBoundingClientRect().right)+' in '+Math.round(stack.left)+'-'+Math.round(stack.right)+' '+node.parentElement.textContent.slice(0,60));
			 return{overflow:document.documentElement.scrollWidth,width:innerWidth,stack:{left:stack.left,right:stack.right},headHeights:[...document.querySelectorAll('.omp-hud-head')].map(node=>node.getBoundingClientRect().height),
			  lineHeights:[...document.querySelectorAll('.omp-hud-line')].map(node=>node.getBoundingClientRect().height),escaped,
			  truncated:[...document.querySelectorAll('.omp-hud-summary')].some(node=>node.scrollWidth>node.clientWidth),
			  openInside:[...document.querySelectorAll('.omp-hud-open')].every(node=>node.getBoundingClientRect().right<=stack.right+1&&node.getBoundingClientRect().width>0)}})()`);
			assert.ok(narrow.overflow <= narrow.width, `no page-level horizontal overflow (${narrow.overflow} > ${narrow.width})`);
			assert.ok(narrow.stack.left >= 0 && narrow.stack.right <= narrow.width);
			assert.ok(narrow.headHeights.every(height => height <= 26.5), `each header stays one line: ${narrow.headHeights}`);
			assert.ok(narrow.lineHeights.every(height => height <= 20.5), `each row stays one line: ${narrow.lineHeights}`);
			assert.deepEqual(narrow.escaped, [], "nothing spills out of the column");
			assert.equal(narrow.truncated, true, "a long summary is cut with an ellipsis, not wrapped");
			assert.equal(narrow.openInside, true, "the open-in-tab button stays reachable");
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the TODO tab shows every task with its blocker, details and notes", async () => {
			await open("detail-todo");
			await ui.evaluate(`window.ui.push({todoSeed:${todoSeed},agents:${agents(1)},agentAvailability:'available'})`);
			await ui.wait("document.querySelector('.omp-detail-task')");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-detail-task').length"), 14);
			const text = await ui.evaluate<string>("document.querySelector('.omp-detail').textContent");
			for (const part of ["Planned 0", "Release 1", "Awaiting CI", "Why it matters", "first note", "second note", "Plan", "Build", "Ship"]) assert.ok(text.includes(part), part);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-detail-count').length"), 1, "the TODO tab has one global count");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-detail-phase h2 .omp-hud-dim').length"), 0, "phase headings keep identity without repeating counts");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer, .omp-transcript')"), null, "a detail tab is not a chat page");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type!=='omp:ready').length"), 0, "a detail tab sends nothing but its announcement while idle");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("web links in the TODO tab's details and notes open from the detail document: click for an editor tab, Ctrl+Enter for the browser", async () => {
			await open("detail-todo");
			await ui.evaluate(`window.ui.push({todoSeed:[{name:'Build',tasks:[{content:'Linked work',status:'in_progress',details:'See [the docs](https://example.com/docs) first.',notes:['Then https://example.com/notes.']}]}],agents:${agents(1)},agentAvailability:'available'})`);
			await ui.wait("document.querySelectorAll('.omp-detail .omp-web-link').length === 2");
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-detail .omp-web-link')].map(link=>[link.textContent,link.dataset.webUrl])"), [["the docs", "https://example.com/docs"], ["https://example.com/notes", "https://example.com/notes"]]);
			await ui.evaluate("window.sent.length=0; document.querySelector('.omp-detail .omp-web-link').click()");
			await ui.evaluate("document.querySelectorAll('.omp-detail .omp-web-link')[1].dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}))");
			assert.deepEqual(await ui.evaluate("window.sent.map(({type,target,mode})=>({type,target,mode}))"), [
				{ type: "omp:terminal-link-open", target: "https://example.com/docs", mode: "editor" },
				{ type: "omp:terminal-link-open", target: "https://example.com/notes", mode: "external" },
			]);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the Agents tab lists every agent and opens one from its row", async () => {
			await open("detail-agents");
			await ui.evaluate(`window.ui.push({agents:${agents(11)},agentAvailability:'available'})`);
			await ui.wait("document.querySelectorAll('.omp-detail-agent').length === 11");
			await ui.evaluate("document.querySelector('.omp-detail-agent').click()");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:open-detail').at(-1)"), { type: "omp:open-detail", kind: "agent", agentId: "Worker One" });
		});

		await t.test("a roster card shows its activity once, keeps only stats on the stats line, rotates its glyph, and opens the agent from its name or by keyboard", async () => {
			const card = await ui.evaluate<{ whole: number; stats: string; lines: string[]; spin: string; tag: string; name: string }>(`(()=>{
			 const first=document.querySelector('.omp-detail-agent');
			 return{whole:first.textContent.split('read · Inspecting 0').length-1,stats:first.querySelector('.omp-native-agent-stats').textContent,
			  lines:[...first.querySelectorAll('.omp-detail-agent-line')].map(node=>node.textContent),spin:getComputedStyle(first.querySelector('.codicon-loading')).animationName,tag:first.tagName,name:first.querySelector('strong').textContent}})()`);
			assert.equal(card.whole, 1, "the current tool and intent appear once");
			assert.deepEqual(card.lines, ["Job 0", "read · Inspecting 0"], "description, then the one activity line");
			assert.equal(card.stats, "4.8k tokens", "elapsed is not duplicated in progress statistics");
			assert.equal(await ui.evaluate("document.querySelector('.omp-detail-agent').querySelectorAll('.omp-hud-elapsed').length"), 1, "elapsed appears once in the heading");
			assert.notEqual(card.spin, "none", "the glyph rotates in the detail document");
			assert.equal(card.tag, "BUTTON", "a focusable button: Enter and Space activate it");
			await ui.evaluate("window.sent.length=0; document.querySelector('.omp-detail-agent strong').click()");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:open-detail')"), [{ type: "omp:open-detail", kind: "agent", agentId: "Worker One" }], "clicking the name opens that agent's tab");
		});

		await t.test("an agent opened before the parent snapshot stays loading until its first read resolves", async () => {
			const capture = async (name: string) => {
				const directory = process.env.OMP_UI_SCREENSHOT_DIR;
				if (directory === undefined) return;
				const image = await ui.call("Page.captureScreenshot", { format: "png" });
				assert.equal(typeof image.data, "string");
				await mkdir(directory, { recursive: true });
				await writeFile(join(directory, name), Buffer.from(String(image.data), "base64"));
			};
			await open("detail-agent-delayed");
			await ui.wait("document.querySelector('.omp-detail-body--agent [aria-busy=\"true\"]')");
			assert.equal(await ui.evaluate("window.ui.reads().length"), 0, "no child request without an authoritative parent epoch");
			assert.equal(await ui.evaluate("document.querySelector('.omp-native-child-unavailable')"), null);
			await ui.evaluate(`window.ui.push({agents:${agents(1)},agentAvailability:'available'})`);
			await ui.wait("window.ui.reads().length === 1");
			assert.equal(await ui.evaluate("document.querySelector('.omp-native-child-body')?.getAttribute('aria-busy')"), "true");
			assert.equal(await ui.evaluate("document.querySelector('.omp-native-child-unavailable')"), null, "pending read is not a stopped parent");
			await capture("agent-first-read-loading.png");
			await ui.evaluate(`window.ui.answer(window.ui.reads()[0],{status:'available',entries:[${message("initial-child", null, "Loaded child")}],olderCount:0,fromByte:0,nextByte:100,reset:false})`);
			await ui.wait("document.querySelector('.omp-native-child-body')?.textContent.includes('Loaded child')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-native-child-body')?.getAttribute('aria-busy')"), "false");
			await capture("agent-first-read-loaded.png");
		});

		await t.test("a not-live child reply is a read failure unless the parent is confirmed stopped", async () => {
			await open("detail-agent");
			await ui.wait("window.ui.reads().length === 1");
			await ui.evaluate("window.ui.answer(window.ui.reads()[0],{status:'unavailable',reason:'not-live'})");
			await ui.wait("document.querySelector('.omp-native-child-unavailable')");
			assert.doesNotMatch(await ui.evaluate<string>("document.querySelector('.omp-native-child-unavailable').textContent"), /parent session is stopped/);
			await open("detail-agent-delayed");
			await ui.evaluate("window.ui.push({phase:'stopped'})");
			await ui.wait("window.ui.reads().length === 1");
			await ui.evaluate("window.ui.answer(window.ui.reads()[0],{status:'unavailable',reason:'not-live'})");
			await ui.wait("document.querySelector('.omp-native-child-unavailable')");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-native-child-unavailable').textContent"), /parent session is stopped/);
		});

		await t.test("an agent tab reads its child lazily, refreshes while running, and keeps the rows when a refresh fails", async () => {
			await open("detail-agent");
			await ui.evaluate(`window.ui.push({agents:${agents(2)},agentAvailability:'available'})`);
			await ui.wait("window.ui.reads().length === 1");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-detail-title').textContent"), /Worker One/);
			await ui.evaluate("window.fixtureClock.fire(2000)");
			assert.equal(await ui.evaluate("window.ui.reads().length"), 1, "a tick while the first read is in flight starts no second read");
			await ui.evaluate(`window.ui.answer(window.ui.reads()[0],{status:'available',entries:[${message("c1", null, "First child row")}],olderCount:0,fromByte:0,nextByte:100,reset:false})`);
			await ui.wait("document.querySelector('.omp-native-child-body')?.textContent.includes('First child row')");
			assert.equal(await ui.evaluate("window.fixtureClock.count(2000)"), 1, "a running agent refreshes on a timer");
			await ui.evaluate("window.fixtureClock.fire(2000)");
			await ui.wait("window.ui.reads().length === 2");
			assert.equal(await ui.evaluate("window.ui.reads()[1].fromByte"), 100, "refresh is incremental from the last offset");
			await ui.evaluate(`window.ui.answer(window.ui.reads()[1],{status:'available',entries:[${message("c2", "c1", "Second child row")},{type:'message',id:'c3',parentId:'c2',timestamp:'2026-10-02T00:00:01Z',message:{role:'assistant',timestamp:2,model:'m',stopReason:'toolUse',content:[{type:'toolCall',id:'call-open',name:'bash',arguments:{command:'sleep 120'}}]}}],olderCount:0,fromByte:100,nextByte:200,reset:false})`);
			await ui.wait("document.querySelector('.omp-native-child-body').textContent.includes('Second child row')");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"call-open\"]')?.getAttribute('data-tool-status')"), "running", "a live child's unanswered call is running, not skipped");
			await ui.evaluate("window.fixtureClock.fire(2000)");
			await ui.wait("window.ui.reads().length === 3");
			await ui.evaluate("window.ui.answer(window.ui.reads()[2],{status:'unavailable',reason:'read-failed'})");
			await ui.wait("document.querySelector('.omp-native-child-stale')");
			const body = await ui.evaluate<string>("document.querySelector('.omp-native-child-body').textContent");
			assert.ok(body.includes("First child row") && body.includes("Second child row"), "a failed refresh does not blank the rows already read");
			assert.match(body, /Showing the rows already read/);
			await ui.evaluate("window.ui.push({agents:[]})");
			await ui.wait("document.querySelector('.omp-detail-status')?.textContent.includes('no longer in the native registry')");
			assert.equal(await ui.evaluate("window.fixtureClock.count(2000)"), 0, "the timer stops when the agent leaves the registry");
			assert.ok((await ui.evaluate<string>("document.querySelector('.omp-native-child-body').textContent")).includes("Second child row"));
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"call-open\"]')?.getAttribute('data-tool-status')"), "skipped", "once the agent has left the registry the unanswered call is no longer in flight");
		});

		await t.test("the agent detail has an icon refresh, a tool-style assignment disclosure and no duplicate initial assignment card", async () => {
			await open("detail-agent");
			await ui.evaluate(`window.ui.push({agents:${agents(1)},agentAvailability:'available'})`);
			await ui.wait("window.ui.reads().length === 1");
			await ui.evaluate(`window.ui.answer(window.ui.reads()[0],{status:'available',entries:[{type:'message',id:'assignment',parentId:null,timestamp:'2026-10-02T00:00:00Z',message:{role:'user',timestamp:1,content:'Assignment text 0'}}],olderCount:0,fromByte:0,nextByte:100,reset:false})`);
			await ui.wait("document.querySelector('.omp-transcript')?.textContent.includes('Assignment text 0')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-detail-assignment')"), null, "the transcript already shows the assignment");
			assert.equal(await ui.evaluate("document.querySelector('.omp-native-child-toolbar .omp-btn .codicon-refresh')!==null"), true);
			assert.equal(await ui.evaluate("document.querySelector('.omp-native-child-toolbar .omp-btn').textContent.trim()"), "", "Refresh is icon-only with a tooltip");
			await ui.evaluate("document.querySelector('.omp-native-child-toolbar .omp-btn').click()");
			await ui.wait("window.ui.reads().length === 2");
			await ui.evaluate("window.ui.answer(window.ui.reads()[1],{status:'available',entries:[],olderCount:0,fromByte:100,nextByte:100,reset:true})");
			await ui.wait("window.ui.reads().length === 3");
			await ui.evaluate(`window.ui.answer(window.ui.reads()[2],{status:'available',entries:[${message("different", null, "Different transcript content")}],olderCount:0,fromByte:0,nextByte:100,reset:false})`);
			await ui.wait("document.querySelector('.omp-detail-assignment button')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-detail-assignment summary')"), null);
			await ui.evaluate("document.querySelector('.omp-detail-assignment button').click()");
			await ui.wait("document.querySelector('.omp-detail-assignment .omp-tool-body')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-detail-assignment button').getAttribute('aria-expanded')"), "true");
			assert.equal(await ui.evaluate("document.querySelector('.omp-detail-assignment .codicon-chevron-down')!==null"), true);
			if (process.env.OMP_UI_SCREENSHOT_DIR) {
				const image = await ui.call("Page.captureScreenshot", { format: "png" });
				assert.equal(typeof image.data, "string");
				await mkdir(process.env.OMP_UI_SCREENSHOT_DIR, { recursive: true });
				await writeFile(join(process.env.OMP_UI_SCREENSHOT_DIR, "agent-assignment.png"), Buffer.from(String(image.data), "base64"));
			}
		});

		await t.test("the agent tab's running glyph rotates in the detail document too", async () => {
			await open("detail-agent");
			await ui.evaluate(`window.ui.push({agents:${agents(2)},agentAvailability:'available'})`);
			await ui.wait("document.querySelector('.omp-detail-title .codicon-loading')");
			assert.notEqual(await ui.evaluate("getComputedStyle(document.querySelector('.omp-detail-title .codicon-loading')).animationName"), "none");
			await ui.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
			assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('.omp-detail-title .codicon-loading')).animationName"), "none");
			await ui.call("Emulation.setEmulatedMedia", { features: MOTION_ALLOWED });
		});

		await t.test("a detail document that names nothing the extension can show says so and shows no session", async () => {
			await open("detail-invalid");
			assert.match(await ui.evaluate<string>("document.body.textContent"), /names nothing the extension can show/);
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer, .omp-transcript, .omp-hud')"), null);
		});
	} finally {
		page?.socket.close(); browser?.socket.close();
		child.kill();
		await once(child, "exit").catch(() => undefined);
		server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
