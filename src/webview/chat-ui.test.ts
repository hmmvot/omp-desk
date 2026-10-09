/** Real React interactions in an owned headless Chromium, never an installed VS Code window. */
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
import { createGuestHtml, createShellHtml } from "../host/guest-webview.ts";
import { desktopToastXml } from "../host/desktop-notifications.ts";
import type { ChatEntry } from "../chat/messages.ts";
import { rewindPreview } from "../chat/rewind.ts";
import { REWIND_ARGUMENTS_SENTENCE } from "../host/rpc/protocol.ts";

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
		// The caller owns the evaluated expression; CDP transports its JSON value without changing its shape.
		return ("value" in remote ? remote.value : undefined) as T;
	}
	async wait(expression: string): Promise<void> {
		// Real DOM mutations cross a process boundary; only a failure deadline uses wall-clock time.
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
import { ShellView } from "./components/ShellView";
import { guestTransport, readCspNonce } from "./bridge";
import { ChatClient } from "./lib/chat-client";
import { createChatModel, snapshotOf } from "../chat/model";
import { splitChatSnapshot } from "./chat-messages";
import { injectGuestStyles } from "./styles";
import { injectShellStyles } from "./lib/terminal-styles";
import { attachSessionView, sessionViewSnapshot } from "./lib/session-view";
import { attachInsertedText } from "./lib/insert-text";
import { adoptNonceForCreatedStyles } from "./lib/nonce-styles";
attachSessionView(guestTransport);
attachInsertedText(guestTransport, () => sessionViewSnapshot().mode);
const epoch = { nonce: "host-ui-test", counter: 1 };
const original = { provider: "one", id: "old", name: "Original", contextWindow: 1000000 };
const next = { provider: "two", id: "new", name: "Next", contextWindow: 1000000 };
let autoAdmission = true;
const textRequest = message => message.type === "omp:chat-prompt" || message.type === "omp:chat-steer" || message.type === "omp:chat-follow-up";
const client = new ChatClient({ post(message) {
 const delivered = guestTransport.post(message);
 if (delivered && autoAdmission && textRequest(message)) queueMicrotask(() => receive({ type: "omp:chat-send-result", epoch: current.epoch, requestId: message.requestId, status: "accepted" }));
 return delivered;
} }); client.attach(guestTransport);
let current = { ...snapshotOf(createChatModel(), epoch), phase: "live", state: {
 model: original, thinkingLevel: "low", isStreaming: false, isCompacting: false, queuedMessageCount: 0,
 contextUsage: { tokens: 40700, contextWindow: 1000000, percent: 4.07 }
} };
function receive(message) { window.dispatchEvent(new MessageEvent("message", { data: message })); }
function push(patch = {}) { current = { ...current, ...patch }; const parts = splitChatSnapshot(current, "ui-snapshot");
 receive(parts.snapshot); for (const chunk of parts.chunks) receive(chunk);
}
window.ui = {
 token: location.search, original, next, current: () => current, receive, push,
 admission(enabled) { autoAdmission = enabled; },
 sends: () => window.sent.filter(textRequest),
 sendReply(request = window.ui.sends().at(-1), status = "accepted", reason) { receive({ type: "omp:chat-send-result", epoch: current.epoch, requestId: request.requestId, status, ...(reason === undefined ? {} : { reason }) }); },
 density(toolCallDetail, accessibilitySupport = false) { receive({ type: "omp:chat-display-preferences", epoch: current.epoch, toolCallDetail, accessibilitySupport }); },
 view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Owned UI session", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); },
 requests: () => window.sent.filter(message => message.type === "omp:control-request"),
 last: () => window.ui.requests().at(-1),
 reply(request = window.ui.last(), patch = {}) { receive({ type: "omp:control-state", scope: request.scope,
 requestId: request.requestId, available: true, model: current.state.model, thinkingLevel: current.state.thinkingLevel,
 mutationMode: "best-effort", ...patch }); },
 thinking(content) { push({ entries: [{ type: "message", id: "assistant", parentId: null, timestamp: "2026-10-01T00:00:00.000Z",
 message: { role: "assistant", api: "openai-responses", provider: "one", model: "old", content, stopReason: "stop", timestamp: 1,
 usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }], durableCount: 1 }); }
};
const nonce=readCspNonce(); adoptNonceForCreatedStyles(nonce); location.search.includes("folder-shell") ? injectShellStyles(nonce) : injectGuestStyles(nonce);
// The folder shell's own view, not the managed-session App, for the document whose query names it.
createRoot(document.getElementById("root")).render(location.search.includes("folder-shell") ? <ShellView /> : <App client={client} />); window.ui.view(); push();
`;

// Skipped on machines with no Chromium-based browser installed. One browser hosts every
// subtest; the timeout only guards a hang and must cover the whole set under suite load.
test("compact chat's rendered behavioral boundaries", { skip: browserPath === undefined, timeout: 280_000 }, async t => {
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
		const html = fixtureUrl.search.endsWith("-shell")
			? createShellHtml(webview, extensionUri, "shell:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d")
			: createGuestHtml(webview, extensionUri, "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d", null);
		const nonce = /<script nonce="([^"]+)"/.exec(html)![1]!;
		// VS Code always defines the editor font for a webview; without it the terminal's
		// fallback chain decides, and that depends on which glyph fonts a machine has.
		response.end(html.replace("</head>", `<style nonce="${nonce}">:root {
			--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#dddddd;--vscode-editorWidget-background:#252526;
			--vscode-editorSuggestWidget-background:#252526;--vscode-editorSuggestWidget-foreground:#dddddd;
			--vscode-button-background:#007acc;--vscode-button-foreground:white;--vscode-input-background:#3c3c3c;
			--vscode-input-foreground:#ddd;--vscode-panel-border:#555;--vscode-font-family:Arial;--vscode-font-size:13px;
			--vscode-editor-font-family:Consolas, "Courier New", monospace;
		}</style><script nonce="${nonce}">window.sent=[];window.errors=[];window.addEventListener("error",event=>window.errors.push(event.message));
		const nativeSet=window.setTimeout.bind(window), nativeClear=window.clearTimeout.bind(window), timers=new Map();let timerId=0;
		window.setTimeout=(fn,ms,...args)=>{if(ms!==45000&&ms!==35000&&ms!==6000&&ms!==4000&&ms!==120)return nativeSet(fn,ms,...args);const id=--timerId;timers.set(id,{fn,ms,args});return id};
		window.clearTimeout=id=>{if(!timers.delete(id))nativeClear(id)};
		const nativeInterval=window.setInterval.bind(window), nativeClearInterval=window.clearInterval.bind(window);
		window.setInterval=(fn,ms,...args)=>{if(ms!==60000&&ms!==1000)return nativeInterval(fn,ms,...args);const id=--timerId;timers.set(id,{fn,ms,args,repeat:true});return id};
		window.clearInterval=id=>{if(!timers.delete(id))nativeClearInterval(id)};
		window.fixtureClock={setNow(value){Date.now=()=>value},fire(ms){for(const [id,timer] of [...timers])if(timer.ms===ms){if(!timer.repeat)timers.delete(id);timer.fn(...timer.args)}}};
		window.acquireVsCodeApi=()=>({postMessage(message){window.sent.push(message);document.dispatchEvent(new Event("fixture-post"))},setState(){}});</script>
		</head>`));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/`;
	const profile = await mkdtemp(join(tmpdir(), "omp-chat-ui-"));
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
		async function reset(name: string, density: "overview" | "detailed" = "overview", paged = false): Promise<void> {
			const loaded = ui.event("Page.loadEventFired");
			await ui.call("Page.navigate", { url: `${url}?${name}` });
			await loaded;
			try {
				await ui.wait(`window.ui?.token === '?${name}' && document.querySelector('.omp-footer-trigger') && window.ui.requests().length === 1`);
			} catch (error) {
				throw new Error(JSON.stringify(await ui.evaluate("({token:window.ui?.token,sent:window.sent,text:document.body.textContent,errors:window.errors})")), { cause: error });
			}
			await ui.evaluate("window.ui.reply()");
			await ui.wait("!document.querySelector('.omp-footer-trigger').disabled");
			await ui.evaluate(`window.ui.density(${JSON.stringify(density)})`);
			if (paged) await ui.evaluate(`window.ui.density(${JSON.stringify(density)}, true)`);
		}

		await t.test("reserved working row and overlay preserve transcript geometry through tool and idle transitions", async () => {
			await reset("working-status-geometry", "detailed");
			await ui.evaluate(`window.statusRows=Array.from({length:40},(_,index)=>({type:'message',id:'status-row-'+index,parentId:null,timestamp:new Date(1000+index).toISOString(),
			 message:{role:'assistant',model:'m',timestamp:1000+index,stopReason:'toolUse',content:[{type:'toolCall',id:'status-call-'+index,name:'read',arguments:{path:'source-'+index+'.ts'}}]}}));
			 window.ui.push({entries:window.statusRows,working:false,settled:true});
			 window.statusFrame=frame=>window.ui.receive({type:'omp:chat-event',epoch:window.ui.current().epoch,frame});
			 window.statusGeometry=()=>{const root=document.querySelector('.omp-transcript'),row=root.querySelector('.omp-transcript-content').lastElementChild,r=row.getBoundingClientRect(),c=document.querySelector('.omp-composer').getBoundingClientRect();return{scrollHeight:root.scrollHeight,scrollTop:root.scrollTop,rowTop:r.top,rowHeight:r.height,rowBottom:r.bottom,composerTop:c.top,composerHeight:c.height}};`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"status-call-39\"]') && document.querySelector('.omp-transcript').scrollHeight>500");
			await ui.settleGeometry(".omp-transcript,.omp-working-status,.omp-composer");
			const baseline = await ui.evaluate<{ scrollHeight: number; scrollTop: number; rowTop: number; rowHeight: number; rowBottom: number; composerTop: number; composerHeight: number }>("window.statusGeometry()");
			const sameGeometry = async (): Promise<void> => {
				const current = await ui.evaluate<typeof baseline>("window.statusGeometry()");
				// Native skipped/running badges can differ by half a CSS pixel; the reserved slot and integer scroll geometry must not.
				assert.ok(Math.abs(current.rowTop - baseline.rowTop) < 1 && Math.abs(current.rowBottom - baseline.rowBottom) < 1);
				assert.deepEqual({ ...current, rowTop: baseline.rowTop, rowBottom: baseline.rowBottom }, baseline);
			};
			assert.equal(await ui.evaluate("document.querySelector('.omp-turn-progress')!==null"), false);
			await ui.evaluate("window.statusFrame({type:'agent_start'})");
			await ui.wait("document.querySelector('.omp-working-status-text').textContent==='Working' && document.querySelector('.omp-turn-progress')");
			await ui.settleGeometry(".omp-transcript,.omp-working-status,.omp-composer");
			await sameGeometry();
			await ui.evaluate(`window.statusFrame({type:'message_update',messageId:'status-stream',message:{role:'assistant',model:'m',timestamp:1039,stopReason:'toolUse',content:[{type:'toolCall',id:'status-call-39',name:'read',arguments:{i:' Reading source... ',path:'source-39.ts'}}]}})`);
			await ui.wait("document.querySelector('.omp-working-status-text').textContent==='Reading source'");
			await ui.settleGeometry(".omp-transcript,.omp-working-status");
			await sameGeometry();
			await ui.evaluate(`window.statusFrame({type:'tool_execution_start',toolCallId:'status-call-39',toolName:'read',args:{i:'Checking behavior.',path:'source-39.ts'}})`);
			await ui.wait("document.querySelector('.omp-working-status-text').textContent==='Checking behavior'");
			await ui.settleGeometry(".omp-transcript,.omp-working-status");
			await sameGeometry();
			await ui.evaluate("window.statusFrame({type:'tool_execution_end',toolCallId:'status-call-39',toolName:'read',result:{},isError:false});window.statusFrame({type:'agent_end'})");
			await ui.wait("!document.querySelector('[aria-label=\"Stop the running turn\"]')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-turn-progress')!==null"), true, "progress stays through engine-end to settle");
			await ui.settleGeometry(".omp-transcript,.omp-working-status");
			await sameGeometry();
			await ui.evaluate("window.statusFrame({type:'session_settled'})");
			await ui.wait("document.querySelector('.omp-working-status-text').textContent==='' && !document.querySelector('.omp-turn-progress')");
			await ui.settleGeometry(".omp-transcript,.omp-working-status");
			await sameGeometry();
			await ui.evaluate("window.ui.push({maintenance:{status:'working',action:'handoff',reason:'Compacting context'}})");
			await ui.wait("document.querySelector('.omp-working-status-text').textContent==='handoff · Compacting context…'");
			await ui.settleGeometry(".omp-transcript,.omp-working-status");
			await sameGeometry();
			assert.equal(await ui.evaluate("document.querySelector('.omp-shimmer')"), null);
		});

		await t.test("turn progress starts on send, persists through asks, reduces motion and throttles announcements", async () => {
			await reset("working-status-accessibility");
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "Inspect the source" });
			await ui.evaluate("document.querySelector('[aria-label=\"Send message\"]').click()");
			await ui.wait("document.querySelector('.omp-turn-progress')");
			await ui.evaluate("window.ui.push({working:true,settled:false,workingIntent:'First intent'})");
			await ui.wait("document.querySelector('.omp-working-status .omp-sr-only').textContent==='First intent'");
			await ui.evaluate(`window.announcements=[];window.statusObserver=new MutationObserver(()=>window.announcements.push({text:document.querySelector('.omp-working-status .omp-sr-only').textContent,at:performance.now()}));window.statusObserver.observe(document.querySelector('.omp-working-status .omp-sr-only'),{childList:true,characterData:true,subtree:true});window.ui.push({workingIntent:'Second intent'});`);
			await ui.wait("document.querySelector('.omp-working-status-text').textContent==='Second intent'");
			await ui.evaluate("window.ui.push({workingIntent:'Latest intent'})");
			await ui.wait("document.querySelector('.omp-working-status .omp-sr-only').textContent==='Latest intent'");
			assert.equal(await ui.evaluate("window.announcements.length"), 1, "rapid intents coalesce into one polite announcement");
			assert.equal(await ui.evaluate("document.querySelector('.omp-working-status').getAttribute('aria-live')"), "polite");
			await ui.evaluate("window.statusObserver.disconnect();window.ui.push({uiRequests:[{id:'status-ask',method:'confirm',title:'Proceed?',message:''}]})");
			await ui.wait("document.querySelector('.omp-working-status-text').textContent==='Waiting for your answer'");
			assert.equal(await ui.evaluate("document.querySelector('.omp-turn-progress')!==null"), true);
			await ui.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
			assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('.omp-turn-progress'),'::before').animationName"), "none");
			assert.equal(await ui.evaluate("document.querySelector('.omp-turn-progress').getBoundingClientRect().height"), 2);
			await ui.call("Emulation.setEmulatedMedia", { features: MOTION_ALLOWED });
			await ui.evaluate("window.ui.push({working:false,settled:true,uiRequests:[]})");
			await ui.wait("!document.querySelector('.omp-turn-progress') && document.querySelector('.omp-working-status-text').textContent===''");
			for (const text of ["/models", "/agents ignored"]) {
				await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
				await ui.call("Input.insertText", { text });
				await ui.evaluate("document.querySelector('[aria-label=\"Send message\"]').click()");
				await ui.wait("document.querySelector('.omp-composer textarea').value===''");
				assert.equal(await ui.evaluate("document.querySelector('.omp-turn-progress')"), null, "native settings do not start a turn");
			}
		});

		await t.test("only outer user movement detaches, and source position survives prepend, resize and same-session rejoin", async () => {
			await reset("paseo-scroll-source");
			await ui.evaluate(`window.historyRows=Array.from({length:180},(_,index)=>({type:'message',id:'row-'+index,parentId:null,timestamp:new Date(1000+index).toISOString(),
			 message:{role:'assistant',model:'m',timestamp:1000+index,stopReason:'stop',content:[{type:'text',text:'Row '+index+'\\n\\n'+('Readable long history paragraph. '.repeat(24))}]}}));
			 window.ui.push({entries:window.historyRows,working:false,settled:true})`);
			await ui.wait("document.querySelector('.omp-transcript').scrollHeight>5000");
			await ui.evaluate("(()=>{const {promise,resolve}=Promise.withResolvers();requestAnimationFrame(()=>requestAnimationFrame(resolve));return promise})()");
			assert.equal(await ui.evaluate("(()=>{const root=document.querySelector('.omp-transcript');return root.scrollHeight-root.clientHeight-root.scrollTop<2})()"), true);
			await ui.evaluate("document.querySelector('.omp-transcript').scrollTop=0");
			await ui.evaluate("(()=>{const {promise,resolve}=Promise.withResolvers();requestAnimationFrame(()=>requestAnimationFrame(resolve));return promise})()");
			assert.equal(await ui.evaluate("document.querySelector('.omp-jump-latest')"), null, "scroll events alone cannot signal intent");
			await ui.evaluate("window.historyRows.push({...window.historyRows.at(-1),id:'new-row',message:{...window.historyRows.at(-1).message,timestamp:2000}});window.ui.push({entries:[...window.historyRows]})");
			await ui.settleGeometry(".omp-transcript");
			const point = await ui.evaluate<{ x: number; y: number }>("(()=>{const rect=document.querySelector('.omp-transcript').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()");
			await ui.evaluate("(()=>{const {promise,resolve}=Promise.withResolvers();document.querySelector('.omp-transcript').addEventListener('scroll',resolve,{once:true});window.wheelMovement=promise})()");
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
			await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: -400 });
			await ui.wait("document.querySelector('.omp-jump-latest')");
			await ui.evaluate("window.wheelMovement");
			await ui.settleGeometry(".omp-transcript");
			await ui.evaluate(`(()=>{
			 const root=document.querySelector('.omp-transcript'),top=root.getBoundingClientRect().top;
			 const row=Array.from(root.querySelectorAll('[data-anchor-key]')).find(node=>node.getBoundingClientRect().bottom>top);
			 window.readerAnchor={key:row.dataset.anchorKey,offset:row.getBoundingClientRect().top-top};
			 document.querySelector('.omp-earlier button').click();
			})()`);
			await ui.evaluate("(()=>{const {promise,resolve}=Promise.withResolvers();requestAnimationFrame(()=>requestAnimationFrame(resolve));return promise})()");
			const drift = "Math.abs(Array.from(document.querySelectorAll('[data-anchor-key]')).find(node=>node.dataset.anchorKey===window.readerAnchor.key).getBoundingClientRect().top-document.querySelector('.omp-transcript').getBoundingClientRect().top-window.readerAnchor.offset)";
			assert.ok(await ui.evaluate<number>(drift) <= 2, "prepend retains the same visible source");
			await ui.evaluate("document.querySelector('.omp-transcript').style.fontSize='18px';window.ui.push({phase:'resyncing'})");
			await ui.evaluate("(()=>{const {promise,resolve}=Promise.withResolvers();requestAnimationFrame(()=>requestAnimationFrame(resolve));return promise})()");
			await ui.evaluate("window.ui.push({phase:'live'})");
			await ui.evaluate("(()=>{const {promise,resolve}=Promise.withResolvers();requestAnimationFrame(()=>requestAnimationFrame(resolve));return promise})()");
			assert.ok(await ui.evaluate<number>(drift) <= 2, "resize and same-session reconnect do not force the tail");
			await ui.evaluate("document.querySelector('.omp-jump-latest').click()");
			await ui.wait("!document.querySelector('.omp-jump-latest')");
			await ui.evaluate("(()=>{const {promise,resolve}=Promise.withResolvers();requestAnimationFrame(()=>requestAnimationFrame(resolve));return promise})()");
			assert.equal(await ui.evaluate("(()=>{const root=document.querySelector('.omp-transcript');return root.scrollHeight-root.clientHeight-root.scrollTop<2})()"), true);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("10k mixed loaded cards retain bounded DOM and a distant focused reply while scrolling", async () => {
			await reset("paseo-10k-mixed");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 window.longHistory=[];
			 for(let index=0;index<10000;index++){
			  if(index%10===0){
			   window.longHistory.push(row('call-'+index,{role:'assistant',model:'m',timestamp:1000+index,stopReason:'toolUse',content:[{type:'toolCall',id:'read-'+index,name:'read',arguments:{path:'src/file-'+index+'.ts'}}]}));
			   window.longHistory.push(row('result-'+index,{role:'toolResult',toolCallId:'read-'+index,toolName:'read',timestamp:1000+index,isError:false,content:[{type:'text',text:'Read source '+index}]}));
			  }else window.longHistory.push(row('mixed-'+index,index%2===0?{role:'user',timestamp:1000+index,content:'Prompt '+index}:{role:'assistant',model:'m',timestamp:1000+index,stopReason:'stop',content:[{type:'text',text:'Reply '+index+'\\n\\n'+('Variable readable prose. '.repeat(index%5+1))}]}));
			  if(index%250===0)window.longHistory.push(row('hidden-'+index,{role:'custom',customType:'private',display:false,timestamp:index,content:'SECRET_HIDDEN_ACTIVITY'}));
			 }
			 window.ui.push({entries:window.longHistory,durableCount:window.longHistory.length,working:false,settled:true,olderCount:0});
			})()`);
			await ui.wait("document.querySelector('.omp-earlier button')");
			await ui.evaluate(`(async()=>{
			 for(let page=0;page<101;page++){
			  const button=document.querySelector('.omp-earlier button');if(!button)break;button.click();
			  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
			 }
			})()`);
			await ui.settleGeometry(".omp-transcript");
			assert.equal(await ui.evaluate("document.querySelector('.omp-earlier button')"), null);
			assert.ok(await ui.evaluate<number>("document.querySelectorAll('.omp-transcript-content > .omp-measured-rows > .omp-measured-row').length") <= 80);
			const point = await ui.evaluate<{ x: number; y: number }>("(()=>{const rect=document.querySelector('.omp-transcript').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()");
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
			await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: -1_000_000 });
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('Reply 1')");
			await ui.settleGeometry(".omp-transcript");
			await ui.evaluate("window.heldReply=document.querySelector('.omp-reply-copy');window.heldReply.focus()");
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
			await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: 1_000_000 });
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('Reply 9999')");
			assert.equal(await ui.evaluate("document.activeElement===window.heldReply && document.body.contains(window.heldReply)"), true);
			assert.ok(await ui.evaluate<number>("document.querySelectorAll('.omp-transcript-content > .omp-measured-rows > .omp-measured-row').length") <= 80);
			assert.doesNotMatch(await ui.evaluate<string>("document.querySelector('.omp-transcript').textContent"), /SECRET_HIDDEN_ACTIVITY/);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a 10k-call expanded run grows in outer flow with bounded member mounts", async () => {
			await reset("paseo-10k-tools");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const entries=Array.from({length:10000},(_,index)=>[
			  row('call-'+index,{role:'assistant',model:'m',timestamp:index,stopReason:'toolUse',content:[{type:'toolCall',id:'read-'+index,name:'read',arguments:{path:'src/large-'+index+'.ts'}}]}),
			  row('result-'+index,{role:'toolResult',toolCallId:'read-'+index,toolName:'read',timestamp:index,isError:false,content:[{type:'text',text:'Complete file '+index}]})]).flat();
			 window.ui.push({entries,durableCount:entries.length,working:false,settled:true,olderCount:0});
			})()`);
			await ui.wait("document.querySelector('.omp-earlier button')");
			await ui.evaluate(`(async()=>{
			 for(let page=0;page<101;page++){
			  const button=document.querySelector('.omp-earlier button');if(!button)break;button.click();
			  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
			 }
			})()`);
			assert.equal(await ui.evaluate("document.querySelector('.omp-earlier button')"), null);
			await ui.evaluate("document.querySelector('.omp-overview-head').click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"read-0\"]')");
			await ui.settleGeometry(".omp-transcript");
			assert.ok(await ui.evaluate<number>("document.querySelectorAll('.omp-overview-member [data-tool-call-id]').length") <= 80);
			assert.ok(await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollHeight") > 100_000);
			assert.equal(await ui.evaluate("document.querySelector('.omp-overview-list')"), null);
			const point = await ui.evaluate<{ x: number; y: number }>("(()=>{const rect=document.querySelector('.omp-transcript').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()");
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
			await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: 1_000_000 });
			await ui.wait("document.querySelector('[data-tool-call-id=\"read-9999\"]')");
			assert.ok(await ui.evaluate<number>("document.querySelectorAll('.omp-overview-member [data-tool-call-id]').length") <= 80);
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"read-9999\"] .omp-tool-head').focus({preventScroll:true})");
			await ui.settleGeometry(".omp-transcript");
			assert.ok(await ui.evaluate("Boolean(document.querySelector('.omp-overview-head'))"), "focused member retains its controlling summary as a bounded mount exception");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
			await ui.wait("document.querySelector('.omp-overview-head')?.getAttribute('aria-expanded')==='false'");
			assert.equal(await ui.evaluate("document.activeElement===document.querySelector('.omp-overview-head')"), true);
			assert.equal(await ui.evaluate("document.querySelector('.omp-overview-member')"), null);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("accessible pages preserve earlier reading and defer a live last-page replacement while focused", async () => {
			await reset("paseo-paged-history", "overview", true);
			await ui.evaluate(`window.pagedRows=Array.from({length:300},(_,index)=>({type:'message',id:'paged-'+index,parentId:null,timestamp:new Date(1000+index).toISOString(),message:index%2===0?{role:'user',timestamp:1000+index,content:'Paged prompt '+index}:{role:'assistant',model:'m',timestamp:1000+index,completedAt:2000+index,stopReason:'stop',content:[{type:'text',text:'Paged reply '+index}]}}));
			 window.ui.push({entries:window.pagedRows,durableCount:300,working:false,settled:true,olderCount:0})`);
			await ui.wait("document.querySelector('.omp-history-pages') && document.querySelector('.omp-transcript').textContent.includes('Paged prompt 200')");
			await ui.evaluate("document.querySelector('.omp-history-pages button').click()");
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('Paged prompt 100')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-transcript').textContent.includes('Paged reply 299')"), false);
			await ui.evaluate(`window.pagedRows.push(...Array.from({length:10},(_,index)=>({...window.pagedRows[index],id:'paged-'+(300+index),message:{...window.pagedRows[index].message,timestamp:1300+index,content:index%2===0?'Paged prompt '+(300+index):[{type:'text',text:'Paged reply '+(300+index)}]}})));window.ui.push({entries:[...window.pagedRows],durableCount:310})`);
			await ui.wait("document.querySelector('.omp-history-pages').textContent.includes('110 new activities')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-transcript').textContent.includes('Paged prompt 100')"), true);
			await ui.evaluate("document.querySelector('.omp-history-pages button:last-child').click()");
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('Paged reply 309')");
			await ui.evaluate("window.pagedFocus=document.querySelector('.omp-reply-copy');window.pagedFocus.focus()");
			await ui.wait("document.querySelector('.omp-history-pages button').disabled");
			await ui.evaluate(`window.pagedRows.push(...Array.from({length:100},(_,index)=>({...window.pagedRows[index],id:'paged-'+(310+index),message:{...window.pagedRows[index].message,timestamp:1310+index,content:index%2===0?'Paged prompt '+(310+index):[{type:'text',text:'Paged reply '+(310+index)}]}})));window.ui.push({entries:[...window.pagedRows],durableCount:410})`);
			await ui.wait("document.querySelector('.omp-history-pages').textContent.includes('100 new activities')");
			assert.equal(await ui.evaluate("document.activeElement===window.pagedFocus && document.body.contains(window.pagedFocus)"), true);
			assert.equal(await ui.evaluate("document.querySelector('.omp-transcript').textContent.includes('Paged reply 409')"), false);
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('Paged reply 409')");
			assert.ok(await ui.evaluate<number>("document.querySelectorAll('.omp-transcript-content > .omp-measured-rows > .omp-measured-row').length") <= 100);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("selected ending edits retain their native detail DOM through group expansion until selection is released", async () => {
			await reset("paseo-selected-edit");
			await ui.evaluate(`window.selectedEdit={role:'assistant',model:'m',timestamp:1000,stopReason:'toolUse',content:[{type:'toolCall',id:'selected-edit',name:'edit',arguments:{path:'src/live.ts'}},{type:'toolCall',id:'selected-read',name:'read',arguments:{path:'src/other.ts'}}]};
			 window.ui.push({stream:{messageId:'selected-edit-message',message:window.selectedEdit},streamPosition:{anchorId:null,seq:1},working:true,settled:false,activeTools:[{toolCallId:'selected-edit',toolName:'edit',args:{path:'src/live.ts'},startedAt:1000,streamUpdate:{editDiffPreview:{diff:'-old\\n+live'}}}]})`);
			await ui.wait("document.querySelector('.omp-native-diff-add')");
			await ui.evaluate("window.selectedEditNode=document.querySelector('.omp-native-diff-add').firstChild;const range=document.createRange();range.selectNodeContents(window.selectedEditNode);document.getSelection().removeAllRanges();document.getSelection().addRange(range)");
			await ui.settleGeometry(".omp-transcript");
			await ui.evaluate("document.querySelector('.omp-overview-head').click()");
			await ui.wait("document.querySelector('.omp-overview-head').getAttribute('aria-expanded')==='true'");
			await ui.evaluate("document.querySelector('.omp-overview-head').click()");
			await ui.wait("document.querySelector('.omp-overview-head').getAttribute('aria-expanded')==='false'");
			assert.equal(await ui.evaluate("document.getSelection().anchorNode===window.selectedEditNode && document.body.contains(window.selectedEditNode)"), true);
			await ui.evaluate(`window.ui.push({stream:null,working:false,settled:true,activeTools:[],entries:[
			 {type:'message',id:'selected-call',parentId:null,timestamp:new Date(1000).toISOString(),message:window.selectedEdit},
			 {type:'message',id:'selected-result',parentId:'selected-call',timestamp:new Date(2000).toISOString(),message:{role:'toolResult',timestamp:2000,toolCallId:'selected-edit',toolName:'edit',isError:false,content:[{type:'text',text:'Applied edit'}],details:{diff:'-old\\n+final'}}},
			 {type:'message',id:'selected-read-result',parentId:'selected-result',timestamp:new Date(2001).toISOString(),message:{role:'toolResult',timestamp:2001,toolCallId:'selected-read',toolName:'read',isError:false,content:[{type:'text',text:'Other source'}]}}
			 ]})`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"selected-edit\"]')?.getAttribute('data-tool-status')==='complete'");
			assert.equal(await ui.evaluate("document.getSelection().anchorNode===window.selectedEditNode && document.getSelection().toString()==='+live'"), true);
			await ui.evaluate("document.getSelection().removeAllRanges()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"selected-edit\"]')===null");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("wheel over expanded group details moves only the outer transcript and stays detached through measurement", async () => {
			await reset("paseo-outer-group-scroll");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const prose=Array.from({length:40},(_,index)=>row('older-'+index,{role:'assistant',model:'m',timestamp:index,stopReason:'stop',content:[{type:'text',text:'Older paragraph '+index+' '+('long readable paragraph '.repeat(20))}]}));
			 const tools=Array.from({length:60},(_,index)=>[
			  row('call-'+index,{role:'assistant',model:'m',timestamp:100+index,stopReason:'toolUse',content:[{type:'toolCall',id:'read-'+index,name:'read',arguments:{path:'src/file-'+index+'.ts'}}]}),
			  row('result-'+index,{role:'toolResult',toolCallId:'read-'+index,toolName:'read',timestamp:200+index,isError:false,content:[{type:'text',text:Array.from({length:3000},(_,line)=>'Source '+index+' line '+line).join('\\n')}]})]).flat();
			 window.ui.push({entries:[...prose,...tools],working:false,settled:true});
			})()`);
			await ui.wait("document.querySelector('.omp-overview-head')");
			const closedHeight = await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollHeight");
			await ui.evaluate("document.querySelector('.omp-overview-head').click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"read-59\"]')");
			await ui.settleGeometry(".omp-transcript");
			assert.ok(await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollHeight") > closedHeight + 800);
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"read-59\"] .omp-tool-head').click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"read-59\"] .omp-tool-body')");
			await ui.settleGeometry(".omp-transcript");
			assert.ok(await ui.evaluate<number>("document.querySelectorAll('[data-tool-call-id=\"read-59\"] .omp-native-code-line').length") <= 220, "large read source starts as a bounded head/tail");
			assert.equal(await ui.evaluate("Array.from(document.querySelector('.omp-transcript').querySelectorAll('*')).filter(node=>/auto|scroll/.test(getComputedStyle(node).overflowY)).length"), 0, "no nested vertical scroll owners");
			const point = await ui.evaluate<{ x: number; y: number; before: number }>("(()=>{const root=document.querySelector('.omp-transcript'),rect=root.getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.bottom-60,before:root.scrollTop}})()");
			// Actual compositor wheel + the controller's real 250ms intent expiry must both settle.
			const expireIntent = "(()=>{const {promise,resolve}=Promise.withResolvers();setTimeout(resolve,600);return promise})()";
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
			await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: -20 });
			await ui.wait("document.querySelector('.omp-jump-latest')");
			await ui.evaluate(expireIntent);
			await ui.settleGeometry(".omp-transcript");
			const after = await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollTop");
			assert.ok(after < point.before - 5, "even wheel movement inside bottom proximity detaches before layout can repin");
			await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: -400 });
			await ui.evaluate(expireIntent);
			const up = await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollTop");
			assert.ok(up < after - 100);
			await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: 200 });
			await ui.evaluate(expireIntent);
			assert.ok(await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollTop") > up + 100);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("expanded Read snapshots keep measured spacers and detached anchors consistent across wheel, remeasure and resize", async () => {
			await reset("paseo-expanded-read-regression");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const calls=Array.from({length:80},(_,index)=>({type:'toolCall',id:'regression-read-'+index,name:'read',arguments:{path:'src/regression.ts:'+index}}));
			 window.regressionEntries=[row('reads',{role:'assistant',model:'m',timestamp:1,stopReason:'toolUse',content:calls}),
			  ...calls.map((call,index)=>row('result-'+index,{role:'toolResult',timestamp:2,toolCallId:call.id,toolName:'read',isError:false,content:[{type:'text',text:Array.from({length:index===77?3000:5},(_,line)=>'READ '+index+' LINE '+line).join('\\n')}]})),
			  row('finished',{role:'assistant',model:'m',timestamp:3,stopReason:'stop',content:[{type:'text',text:'Finished all eighty reads.'}]})];
			 window.ui.push({entries:window.regressionEntries,working:false,settled:true});
			})()`);
			await ui.wait("document.querySelector('.omp-overview-head')");
			await ui.evaluate("document.querySelector('.omp-overview-head').click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"regression-read-77\"]')");
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"regression-read-77\"] .omp-tool-head').click()");
			await ui.wait("document.querySelector('.omp-output-disclosure')");
			await ui.settleGeometry(".omp-transcript");
			const point = await ui.evaluate<{x:number;y:number;top:number}>(`(()=>{
			 const root=document.querySelector('.omp-transcript'),body=document.querySelector('[data-tool-call-id="regression-read-77"] .omp-tool-body'),r=root.getBoundingClientRect(),b=body.getBoundingClientRect();
			 const x=b.left+100,y=Math.min(r.bottom-100,b.bottom-30);
			 if(!body.contains(document.elementFromPoint(x,y)))throw new Error('Wheel must hit expanded Read body');
			 return{x,y,top:root.scrollTop};
			})()`);
			// Real compositor wheel delivery and the controller's platform-clock intent expiry cross the browser process.
			const expireIntent = "(()=>{const {promise,resolve}=Promise.withResolvers();setTimeout(resolve,650);return promise})()";
			await ui.call("Input.dispatchMouseEvent", {type:"mouseMoved",x:point.x,y:point.y});
			await ui.call("Input.dispatchMouseEvent", {type:"mouseWheel",x:point.x,y:point.y,deltaX:0,deltaY:-100});
			await ui.evaluate(expireIntent);
			await ui.settleGeometry(".omp-transcript");
			assert.ok(await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollTop") < point.top-50, "wheel over Read cannot restore the pre-wheel anchor");
			await ui.evaluate(`(()=>{
			 const root=document.querySelector('.omp-transcript'),top=root.getBoundingClientRect().top;
			 const row=[...root.querySelectorAll('.omp-measured-row')].find(row=>row.getBoundingClientRect().bottom>top);
			 window.regressionAnchor={key:row.dataset.windowRow,offset:row.getBoundingClientRect().top-top,height:row.getBoundingClientRect().height,total:root.scrollHeight};
			 window.ui.push({entries:structuredClone(window.regressionEntries)});
			})()`);
			await ui.settleGeometry(".omp-transcript");
			const drift = `(()=>{const root=document.querySelector('.omp-transcript'),a=window.regressionAnchor,row=[...root.querySelectorAll('.omp-measured-row')].find(row=>row.dataset.windowRow===a.key);return row?Math.abs(row.getBoundingClientRect().top-root.getBoundingClientRect().top-a.offset):Infinity})()`;
			assert.ok(await ui.evaluate<number>(drift)<=2, `equivalent snapshot retains the visible source anchor: ${JSON.stringify(await ui.evaluate(`(()=>{const root=document.querySelector('.omp-transcript');return{anchor:window.regressionAnchor,top:root.scrollTop,total:root.scrollHeight,rows:[...root.querySelectorAll('.omp-measured-row')].map(row=>({key:row.dataset.windowRow,top:row.getBoundingClientRect().top-root.getBoundingClientRect().top,height:row.getBoundingClientRect().height}))}})()`))}`);
			assert.equal(await ui.evaluate(`(()=>{const a=window.regressionAnchor,row=[...document.querySelectorAll('.omp-measured-row')].find(row=>row.dataset.windowRow===a.key);return row.getBoundingClientRect().height})()`), await ui.evaluate("window.regressionAnchor.height"), "unchanged expanded height replaces its invalidated estimate without another ResizeObserver notification");
			// Invalidated offscreen closed rows return to the 40px estimate (within 4px of this fixture's headers).
			assert.ok(await ui.evaluate<number>("Math.abs(document.querySelector('.omp-transcript').scrollHeight-window.regressionAnchor.total)")<=80*4, "spacers retain the tall source rather than losing its several thousand pixels");
			await ui.evaluate("document.querySelector('.omp-transcript').style.fontSize='15px'");
			await ui.settleGeometry(".omp-transcript");
			assert.ok(await ui.evaluate<number>(drift)<=2, "font remeasure stays detached and anchored");
			assert.ok(await ui.evaluate("Boolean(document.querySelector('.omp-jump-latest'))"));
			await ui.evaluate("document.querySelector('.omp-output-disclosure button').click()");
			await ui.settleGeometry(".omp-transcript");
			assert.ok(await ui.evaluate<number>(drift)<=2, "in-flow More preserves the detached source anchor");
			for (const deltaY of [-800,-5000,600,5000]) {
				await ui.call("Input.dispatchMouseEvent", {type:"mouseWheel",x:point.x,y:point.y,deltaX:0,deltaY});
				await ui.evaluate(expireIntent);
				await ui.settleGeometry(".omp-transcript");
				assert.equal(await ui.evaluate(`(()=>{
				 const root=document.querySelector('.omp-transcript'),r=root.getBoundingClientRect(),rows=[...root.querySelectorAll('.omp-measured-row')];
				 const visible=rows.filter(row=>{const b=row.getBoundingClientRect();return b.bottom>r.top&&b.top<r.bottom});
				 return visible.length>0&&visible.every(row=>row.textContent.trim().length>0)&&[...document.querySelector('.omp-measured-rows').children].every((row,index,all)=>index===0||Math.abs(row.getBoundingClientRect().top-all[index-1].getBoundingClientRect().bottom)<=1);
				})()`), true, "scrolling past expanded Read has visible rows and contiguous row/spacer flow");
				assert.ok(await ui.evaluate<number>("document.querySelectorAll('.omp-measured-row').length")<=80);
			}
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("fully loaded detached history retains its source through a font cycle and explicitly jumps despite held tool focus", async () => {
			await reset("paseo-loaded-font-jump");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const entries=Array.from({length:160},(_,index)=>[
			  row('call-'+index,{role:'assistant',model:'m',timestamp:1,stopReason:'toolUse',content:[{type:'toolCall',id:'font-read-'+index,name:'read',arguments:{path:'src/source.ts:'+index}}]}),
			  row('result-'+index,{role:'toolResult',timestamp:2,toolCallId:'font-read-'+index,toolName:'read',isError:false,content:[{type:'text',text:'First source line\\nSecond source line\\nThird source line\\nFourth source line\\nFifth source line'}]})]).flat();
			 window.ui.push({entries,working:false,settled:true});
			})()`);
			await ui.wait("document.querySelector('.omp-earlier button')");
			await ui.evaluate("document.querySelector('.omp-earlier button').click();document.querySelector('.omp-overview-head').click()");
			await ui.wait("document.querySelector('.omp-measured-rows').dataset.admittedRows==='161'");
			await ui.evaluate("document.querySelector('.omp-jump-latest').click()");
			await ui.settleGeometry(".omp-transcript");
			await ui.evaluate("document.querySelectorAll('.omp-tool-head[aria-expanded=false]').forEach(head=>head.click())");
			await ui.settleGeometry(".omp-transcript");
			const point = await ui.evaluate<{x:number;y:number}>("(()=>{const r=document.querySelector('.omp-transcript').getBoundingClientRect();return{x:r.left+100,y:r.top+100}})()");
			await ui.call("Input.dispatchMouseEvent", {type:"mouseWheel",...point,deltaX:0,deltaY:-1200});
			// Native wheel intent uses the platform clock, outside the fixture's fake interval clock.
			await ui.evaluate("(()=>{const {promise,resolve}=Promise.withResolvers();setTimeout(resolve,650);return promise})()");
			await ui.settleGeometry(".omp-transcript");
			await ui.evaluate(`(()=>{
			 const root=document.querySelector('.omp-transcript'),top=root.getBoundingClientRect().top;
			 const rows=[...root.querySelectorAll('.omp-measured-row')],a=rows.find(row=>row.getBoundingClientRect().bottom>top);
			 window.fontAnchor={key:a.dataset.windowRow,offset:a.getBoundingClientRect().top-top};
			 const head=rows.find(row=>row.getBoundingClientRect().top>top+100)?.querySelector('.omp-tool-head');
			 head.focus({preventScroll:true});head.click();
			})()`);
			await ui.settleGeometry(".omp-transcript");
			const drift = `(()=>{const root=document.querySelector('.omp-transcript'),a=window.fontAnchor,row=[...root.querySelectorAll('.omp-measured-row')].find(row=>row.dataset.windowRow===a.key);return row?Math.abs(row.getBoundingClientRect().top-root.getBoundingClientRect().top-a.offset):Infinity})()`;
			for (const font of ["18px",""]) {
				await ui.evaluate(`document.querySelector('.omp-transcript').style.fontSize=${JSON.stringify(font)}`);
				await ui.settleGeometry(".omp-transcript");
				assert.ok(await ui.evaluate<number>(drift)<=2, `full-history ${font || "inherited"} font remeasure preserves the source`);
				assert.ok(await ui.evaluate("Boolean(document.querySelector('.omp-jump-latest'))"));
			}
			await ui.evaluate("document.querySelector('.omp-jump-latest').click()");
			await ui.settleGeometry(".omp-transcript");
			assert.ok(await ui.evaluate("(()=>{const r=document.querySelector('.omp-transcript');return r.scrollHeight-r.clientHeight-r.scrollTop<=2&&!document.querySelector('.omp-jump-latest')})()"), "explicit Jump reaches the actual bottom even with a retained focused header");
			await ui.call("Input.dispatchMouseEvent", {type:"mouseWheel",...point,deltaX:0,deltaY:-800});
			await ui.evaluate("(()=>{const {promise,resolve}=Promise.withResolvers();setTimeout(resolve,650);return promise})()");
			await ui.evaluate("(()=>{const tool=document.activeElement.closest('.omp-tool');if(!tool.querySelector('.omp-tool-body'))tool.querySelector('.omp-tool-head').click()})()");
			await ui.wait("document.activeElement.closest('.omp-tool').querySelector('.omp-tool-body')");
			await ui.evaluate("document.activeElement.closest('.omp-tool').querySelector('.omp-tool-body').focus({preventScroll:true})");
			await ui.settleGeometry(".omp-transcript");
			await ui.evaluate("document.querySelector('.omp-jump-latest').click()");
			await ui.settleGeometry(".omp-transcript");
			assert.ok(await ui.evaluate("(()=>{const r=document.querySelector('.omp-transcript');return r.scrollHeight-r.clientHeight-r.scrollTop<=2&&!document.querySelector('.omp-jump-latest')})()"), "explicit Jump also overrides a pre-existing native body hold");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("detached group expansion and collapse preserve the summary source offset", async () => {
			await reset("paseo-group-anchor");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const prose=(id)=>row(id,{role:'assistant',model:'m',timestamp:1,stopReason:'stop',content:[{type:'text',text:('Readable '+id+' paragraph. ').repeat(100)}]});
			 const calls=Array.from({length:4},(_,index)=>({type:'toolCall',id:'anchor-read-'+index,name:'read',arguments:{path:'src/anchor-'+index+'.ts'}}));
			 window.ui.push({entries:[prose('before'),row('tools',{role:'assistant',model:'m',timestamp:2,stopReason:'toolUse',content:calls}),
			  ...calls.map((call,index)=>row('result-'+index,{role:'toolResult',timestamp:3,toolCallId:call.id,toolName:'read',isError:false,content:[{type:'text',text:'Source '+index}]})),prose('after')],working:false,settled:true});
			})()`);
			await ui.wait("document.querySelector('.omp-overview-head')");
			await ui.settleGeometry(".omp-transcript");
			const point = await ui.evaluate<{x:number;y:number}>("(()=>{const r=document.querySelector('.omp-transcript').getBoundingClientRect();return{x:r.left+100,y:r.top+100}})()");
			await ui.call("Input.dispatchMouseEvent", {type:"mouseWheel",...point,deltaX:0,deltaY:-200});
			await ui.wait("document.querySelector('.omp-jump-latest')");
			await ui.settleGeometry(".omp-transcript");
			await ui.evaluate("document.querySelector('.omp-overview-head').scrollIntoView({block:'center'});document.querySelector('.omp-overview-head').focus({preventScroll:true})");
			await ui.settleGeometry(".omp-transcript");
			const offset = await ui.evaluate<number>("document.querySelector('.omp-overview-head').getBoundingClientRect().top-document.querySelector('.omp-transcript').getBoundingClientRect().top");
			for (const expanded of [true,false]) {
				await ui.evaluate("document.querySelector('.omp-overview-head').click()");
				await ui.wait(`document.querySelector('.omp-overview-head').getAttribute('aria-expanded')==='${expanded}'`);
				await ui.settleGeometry(".omp-transcript");
				assert.ok(Math.abs(await ui.evaluate<number>("document.querySelector('.omp-overview-head').getBoundingClientRect().top-document.querySelector('.omp-transcript').getBoundingClientRect().top")-offset)<=2);
				assert.ok(await ui.evaluate("Boolean(document.querySelector('.omp-jump-latest'))"));
			}
		});

		await t.test("large read, command and diff output disclose head, tail and hidden lines in outer flow", async () => {
			for (const name of ["read", "bash", "edit"]) {
				await reset(`paseo-output-${name}`, "detailed");
				await ui.evaluate(`(()=>{
				 const text=Array.from({length:500},(_,index)=>'${name === "edit" ? "+" : ""}OUTPUT_LINE_'+index+'_END').join('\\n');
				 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
				 window.ui.push({entries:[row('call',{role:'assistant',model:'m',timestamp:1,stopReason:'toolUse',content:[{type:'toolCall',id:'long-output',name:'${name}',arguments:{path:'src/output.ts',command:'echo output'}}]}),
				  row('result',{role:'toolResult',timestamp:2,toolCallId:'long-output',toolName:'${name}',isError:false,content:[{type:'text',text}],details:${name === "edit" ? "{diff:text,path:'src/output.ts'}" : "{}"}})],working:false,settled:true});
				})()`);
				await ui.wait("document.querySelector('[data-tool-call-id=\"long-output\"] .omp-tool-head')");
				await ui.evaluate("document.querySelector('[data-tool-call-id=\"long-output\"] .omp-tool-head').click()");
				await ui.wait("document.querySelector('.omp-output-disclosure')");
				const initial = await ui.evaluate<string>("document.querySelector('.omp-tool-body').textContent");
				assert.match(initial, /OUTPUT_LINE_0_END/); assert.match(initial, /OUTPUT_LINE_499_END/);
				assert.doesNotMatch(initial, /OUTPUT_LINE_250_END|OUTPUT_LINE_450_END/);
				assert.equal(await ui.evaluate("Array.from(document.querySelector('.omp-transcript').querySelectorAll('*')).some(node=>/auto|scroll/.test(getComputedStyle(node).overflowY))"), false);
				await ui.evaluate("document.querySelector('.omp-output-disclosure button').click()");
				await ui.wait("document.querySelector('.omp-tool-body').textContent.includes('OUTPUT_LINE_250_END')");
				assert.doesNotMatch(await ui.evaluate<string>("document.querySelector('.omp-tool-body').textContent"), /OUTPUT_LINE_450_END/);
				await ui.evaluate("document.querySelector('.omp-output-disclosure button:nth-child(2)').click()");
				await ui.wait("!document.querySelector('.omp-output-disclosure')");
				assert.match(await ui.evaluate<string>("document.querySelector('.omp-tool-body').textContent"), /OUTPUT_LINE_450_END/);
			}
		});

		await t.test("finished reply Copy uses canonical Markdown and reports clipboard failure", async () => {
			await reset("paseo-reply-copy");
			await ui.evaluate(`window.ui.thinking([{type:'thinking',thinking:'Excluded reasoning'},{type:'text',text:'**Canonical** reply'}]);
			 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(text){window.copiedReply=text}}})`);
			await ui.wait("document.querySelector('.omp-reply-copy')");
			await ui.evaluate("document.querySelector('.omp-reply-copy').click()");
			await ui.wait("window.copiedReply==='**Canonical** reply'");
			assert.equal(await ui.evaluate("document.querySelector('.omp-reply-footer [role=status]').textContent"), "Copied");
			await ui.evaluate("navigator.clipboard.writeText=async()=>{throw new Error('Denied')};document.querySelector('.omp-reply-copy').click()");
			await ui.wait("document.querySelector('.omp-reply-footer [role=status]')?.textContent.includes('Copy failed')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("native selection freezes live append DOM and reduced motion paints whole canonical arrivals", async () => {
			await reset("paseo-paced-selection");
			await ui.evaluate(`window.liveReply={role:'assistant',model:'m',timestamp:1000,stopReason:'stop',content:[{type:'text',text:'Seed text'}]};
			 window.ui.push({stream:{messageId:'paced',message:window.liveReply},streamPosition:{anchorId:null,seq:1},working:true,settled:false})`);
			await ui.wait("document.querySelector('.omp-paced-slot')?.textContent==='Seed text'");
			await ui.evaluate(`const slot=document.querySelector('.omp-paced-slot');const range=document.createRange();range.selectNodeContents(slot);
			 const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));
			 window.wholeReply='Seed text '+'chunk '.repeat(300)+'FINAL';
			 window.liveReply={...window.liveReply,content:[{type:'text',text:window.wholeReply}]};window.ui.push({stream:{messageId:'paced',message:window.liveReply}})`);
			await ui.evaluate("(()=>{const {promise,resolve}=Promise.withResolvers();requestAnimationFrame(()=>requestAnimationFrame(resolve));return promise})()");
			assert.equal(await ui.evaluate("document.querySelector('.omp-paced-slot').textContent"), "Seed text");
			assert.equal(await ui.evaluate("getSelection().toString()"), "Seed text");
			await ui.evaluate("getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'))");
			await ui.wait("document.querySelector('.omp-paced-slot')?.textContent===window.wholeReply");
			await ui.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
			await ui.evaluate("window.wholeReply+=' REDUCED';window.liveReply={...window.liveReply,content:[{type:'text',text:window.wholeReply}]};window.ui.push({stream:{messageId:'paced',message:window.liveReply}})");
			await ui.wait("document.querySelector('.omp-paced-slot')?.textContent===window.wholeReply");
			await ui.call("Emulation.setEmulatedMedia", { features: MOTION_ALLOWED });
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("only readable reasoning is expandable; empty and provider-redacted blocks are invisible", async () => {
			await reset("thinking");
			await ui.evaluate(`window.ui.thinking([{type:'thinking',thinking:''},{type:'thinking',thinking:'  \\n\\t  '},{type:'text',text:'Answer'}])`);
			await ui.wait("document.querySelector('.omp-transcript')?.textContent.includes('Answer')");
			assert.equal(await ui.evaluate("Array.from(document.querySelectorAll('.omp-native-disclosure summary')).filter(node => node.textContent?.startsWith('Thinking')).length"), 0);
			await ui.evaluate(`window.ui.thinking([{type:'thinking',thinking:'Reasoned conclusion',signature:'INTERNAL_THINKING_SIGNATURE'},{type:'redactedThinking',data:'INTERNAL_REDACTED_PAYLOAD'},{type:'text',text:'Answer'}])`);
			await ui.wait("Array.from(document.querySelectorAll('.omp-native-disclosure summary')).filter(node => node.textContent?.startsWith('Thinking')).length === 1");
			await ui.evaluate("Array.from(document.querySelectorAll('.omp-native-disclosure')).filter(node => node.querySelector(':scope > summary')?.textContent?.startsWith('Thinking')).forEach(node => node.open = true)");
			await ui.wait("document.querySelector('.omp-transcript')?.textContent.includes('Reasoned conclusion')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-transcript').textContent.includes('INTERNAL_')"), false);
		});

		await t.test("live tool details follow through the outer controller and pause native detail DOM on focus", async () => {
			await reset("paseo-detail-latest", "overview");
			await ui.evaluate(`window.detailArgs={path:'paseo-live.ts',content:Array.from({length:180},(_,index)=>'export const line'+index+' = '+index+';').join('\\n')};
			 window.detailMessage={role:'assistant',model:'m',timestamp:1000,stopReason:'toolUse',content:[{type:'toolCall',id:'detail-latest',name:'write',arguments:window.detailArgs}]};
			 window.pushDetail=()=>window.ui.push({stream:{messageId:'detail-latest-message',message:window.detailMessage},streamPosition:{anchorId:null,seq:1},working:true,settled:false,activeTools:[{toolCallId:'detail-latest',toolName:'write',args:window.detailArgs,startedAt:1000}]});window.pushDetail()`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"detail-latest\"] .omp-native-source .omp-pre')?.scrollHeight>1000");
			await ui.settleGeometry(".omp-transcript");
			assert.ok(await ui.evaluate("(()=>{const root=document.querySelector('.omp-transcript');return root.scrollHeight-root.clientHeight-root.scrollTop<=2})()"), "live source follows via outer controller");
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"detail-latest\"] .omp-tool-body').focus({preventScroll:true})");
			await ui.wait("document.activeElement?.classList.contains('omp-tool-body')");
			const heldTop = await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollTop");
			await ui.evaluate("window.detailArgs={...window.detailArgs,content:window.detailArgs.content+'\\nexport const addedWhileFocused = 999;'};window.pushDetail()");
			await ui.settleGeometry('[data-tool-call-id="detail-latest"] .omp-tool-body');
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"detail-latest\"] .omp-tool-body').textContent.includes('addedWhileFocused')"), false, "native held detail DOM stays stable while canonical content grows");
			assert.equal(await ui.evaluate("document.querySelector('.omp-transcript').scrollTop"), heldTop);
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"detail-latest\"] .omp-tool-body').textContent.includes('addedWhileFocused')");
			await ui.settleGeometry(".omp-transcript");
			assert.ok(await ui.evaluate("(()=>{const root=document.querySelector('.omp-transcript');return root.scrollHeight-root.clientHeight-root.scrollTop<=2})()"), "release follows latest source in outer flow");
		});

		await t.test("overview exposes a live write once, collapses it at result, and preserves manual detail and draft across density changes", async () => {
			await reset("paseo-live-overview");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-04T00:00:00Z',message});
			 const message={role:'assistant',timestamp:10,model:'m',stopReason:'toolUse',content:[
			  {type:'toolCall',id:'read-live',name:'read',arguments:{path:'a.ts'}},
			  {type:'toolCall',id:'write-live',name:'write',arguments:{path:'b.ts',content:'const actualLiveWrite = 1;'}}]};
			 window.paseo={row,message};window.ui.push({entries:[],working:true,stream:{messageId:'paseo-stream',message},activeTools:[{toolCallId:'write-live',toolName:'write',args:message.content[1].arguments,startedAt:10}]});
			})()`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"write-live\"] .omp-tool-body')?.textContent.includes('actualLiveWrite')");
			assert.equal(await ui.evaluate("document.querySelectorAll('[data-tool-call-id=\"write-live\"]').length"), 1);
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"read-live\"]')"), null);
			await ui.evaluate(`window.ui.push({stream:null,working:false,activeTools:[],entries:[
			 window.paseo.row('call',window.paseo.message),
			 window.paseo.row('read-result',{role:'toolResult',timestamp:11,toolCallId:'read-live',toolName:'read',isError:false,content:[{type:'text',text:'Canonical source output'}]}),
			 window.paseo.row('write-result',{role:'toolResult',timestamp:12,toolCallId:'write-live',toolName:'write',isError:true,content:[{type:'text',text:'Actual write failure'}]})]})`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"write-live\"]')===null && document.querySelector('.omp-overview-head')?.textContent.includes('failed')");
			await ui.evaluate("document.querySelector('.omp-overview-head').click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"read-live\"]')!==null");
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"read-live\"] .omp-tool-head').click();document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "Unsent draft survives" });
			await ui.wait("document.querySelector('[data-tool-call-id=\"read-live\"] .omp-tool-body')?.textContent.includes('Canonical source output')");
			// The chip only asks the host to open its native picker; the host then writes the setting and pushes the new density back.
			await ui.evaluate("document.querySelector('.omp-tools-trigger').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-tool-detail')");
			await ui.evaluate("window.ui.density('detailed')");
			await ui.wait("document.querySelector('.omp-tool-overview')===null");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer textarea').value"), "Unsent draft survives");
			assert.match(await ui.evaluate<string>("document.querySelector('[data-tool-call-id=\"read-live\"] .omp-tool-body').textContent"), /Canonical source output/);
			await ui.evaluate("window.ui.density('overview')");
			await ui.wait("document.querySelector('.omp-overview-member')!==null");
			assert.match(await ui.evaluate<string>("document.querySelector('[data-tool-call-id=\"read-live\"] .omp-tool-body').textContent"), /Canonical source output/);
		});

		await t.test("global density changes preserve focused tool headers and native selected detail both ways without opening manual disclosures", async () => {
			await reset("paseo-density-interaction", "detailed");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 window.ui.push({entries:[
			  row('density-call',{role:'assistant',model:'m',timestamp:1000,stopReason:'toolUse',content:[{type:'toolCall',id:'density-read',name:'read',arguments:{path:'src/selected.ts'}},{type:'toolCall',id:'density-read-2',name:'read',arguments:{path:'src/second.ts'}}]}),
			  row('density-result',{role:'toolResult',timestamp:2000,toolCallId:'density-read',toolName:'read',isError:false,content:[{type:'text',text:'Canonical selected source'}]}),
			  row('density-result-2',{role:'toolResult',timestamp:2001,toolCallId:'density-read-2',toolName:'read',isError:false,content:[{type:'text',text:'Second selected source'}]})],working:false,settled:true});
			})()`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"density-read\"] .omp-tool-head')");
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "Density must retain this draft" });
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"density-read\"] .omp-tool-head').focus();window.ui.density('overview')");
			await ui.wait("document.querySelector('.omp-tool-overview') && document.activeElement?.closest('[data-tool-call-id]')?.dataset.toolCallId==='density-read'");
			assert.equal(await ui.evaluate("document.activeElement.getAttribute('aria-expanded')"), "false");
			assert.equal(await ui.evaluate("document.querySelector('.omp-overview-head').getAttribute('aria-expanded')"), "false");
			await ui.evaluate("window.ui.density('detailed')");
			await ui.wait("!document.querySelector('.omp-tool-overview') && document.activeElement?.closest('[data-tool-call-id]')?.dataset.toolCallId==='density-read'");
			await ui.evaluate("document.activeElement.click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"density-read\"] .omp-tool-body')");
			await ui.evaluate(`(()=>{
			 const body=document.querySelector('[data-tool-call-id="density-read"] .omp-tool-body'),walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);
			 let node;while((node=walker.nextNode()))if(node.textContent.includes('Canonical selected source'))break;
			 const range=document.createRange();range.selectNodeContents(node);document.getSelection().removeAllRanges();document.getSelection().addRange(range);
			 window.densitySelection=document.getSelection().toString();window.ui.density('overview');
			})()`);
			await ui.wait("document.querySelector('.omp-tool-overview') && document.getSelection().toString()===window.densitySelection && document.activeElement?.closest('[data-tool-call-id]')?.dataset.toolCallId==='density-read'");
			assert.equal(await ui.evaluate("document.querySelector('.omp-overview-head').getAttribute('aria-expanded')"), "false");
			await ui.evaluate("window.ui.density('detailed')");
			await ui.wait("!document.querySelector('.omp-tool-overview') && document.getSelection().toString()===window.densitySelection && document.activeElement?.closest('[data-tool-call-id]')?.dataset.toolCallId==='density-read'");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer textarea').value"), "Density must retain this draft");
			await ui.evaluate("document.getSelection().removeAllRanges();document.activeElement.click();document.querySelector('.omp-composer textarea').focus();window.ui.density('overview')");
			await ui.wait("document.querySelector('.omp-tool-overview') && !document.querySelector('[data-tool-call-id=\"density-read\"]')");
			assert.equal(await ui.evaluate("document.activeElement===document.querySelector('.omp-composer textarea')"), true);
		});

		await t.test("a lone tool call is a plain row with no group summary, two calls form a group, and shrinking restores the plain row", async () => {
			await reset("paseo-singleton-rows");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const call=(id,command)=>({type:'toolCall',id,name:'bash',arguments:{command}});
			 const result=(id,text)=>({role:'toolResult',timestamp:2,toolCallId:id,toolName:'bash',isError:false,content:[{type:'text',text}]});
			 window.solo={row,call,result};
			 window.ui.push({entries:[
			  row('solo-user',{role:'user',timestamp:1,content:'Run echo hi once'}),
			  row('solo-call',{role:'assistant',model:'m',timestamp:2,stopReason:'toolUse',content:[call('solo-bash','echo hi')]}),
			  row('solo-result',result('solo-bash','hi'))],working:false,settled:true});
			})()`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"solo-bash\"] .omp-tool-head')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-tool-overview')"), null, "no group wraps a single call");
			assert.equal(await ui.evaluate("document.querySelector('.omp-overview-head')"), null);
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"solo-bash\"] .omp-tool-head').getAttribute('aria-expanded')"), "false");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"solo-bash\"] .omp-tool-body')"), null);
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"solo-bash\"] .omp-tool-head').click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"solo-bash\"] .omp-tool-body')?.textContent.includes('hi')");
			await ui.evaluate(`window.ui.push({entries:[
			 window.solo.row('solo-user',{role:'user',timestamp:1,content:'Run echo hi once'}),
			 window.solo.row('solo-call',{role:'assistant',model:'m',timestamp:2,stopReason:'toolUse',content:[window.solo.call('solo-bash','echo hi')]}),
			 window.solo.row('solo-result',window.solo.result('solo-bash','hi')),
			 window.solo.row('solo-text',{role:'assistant',model:'m',timestamp:3,stopReason:'stop',content:[{type:'text',text:'One command done.'}]}),
			 window.solo.row('pair-call',{role:'assistant',model:'m',timestamp:3,stopReason:'toolUse',content:[window.solo.call('pair-one','echo one'),window.solo.call('pair-two','echo two')]}),
			 window.solo.row('pair-result-one',window.solo.result('pair-one','one')),
			 window.solo.row('pair-result-two',window.solo.result('pair-two','two'))],working:false,settled:true})`);
			await ui.wait("document.querySelectorAll('.omp-overview-head').length===1");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-overview-head').textContent"), /Ran 2 commands/);
			assert.ok(await ui.evaluate("Boolean(document.querySelector('[data-tool-call-id=\"solo-bash\"]'))"), "the earlier lone call stays a plain row beside the group");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"pair-one\"]')"), null, "group members stay closed behind the summary");
			await ui.evaluate(`window.ui.push({entries:[
			 window.solo.row('pair-call',{role:'assistant',model:'m',timestamp:3,stopReason:'toolUse',content:[window.solo.call('pair-one','echo one')]}),
			 window.solo.row('pair-result-one',window.solo.result('pair-one','one'))],working:false,settled:true})`);
			await ui.wait("document.querySelector('.omp-overview-head')===null && document.querySelector('[data-tool-call-id=\"pair-one\"] .omp-tool-head')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a live run growing from one to two calls keeps its focused row, detached anchor and scroll position", async () => {
			await reset("paseo-singleton-growth");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const call=(id,command)=>({type:'toolCall',id,name:'bash',arguments:{command}});
			 const result=(id,text)=>({role:'toolResult',timestamp:2,toolCallId:id,toolName:'bash',isError:false,content:[{type:'text',text}]});
			 const prose=Array.from({length:30},(_,index)=>row('grow-prose-'+index,{role:'assistant',model:'m',timestamp:index,stopReason:'stop',content:[{type:'text',text:'Earlier paragraph '+index+' '+('long readable paragraph '.repeat(20))}]}));
			 window.grow={row,call,result,prose};
			 window.ui.push({entries:[...prose,
			  row('grow-call',{role:'assistant',model:'m',timestamp:100,stopReason:'toolUse',content:[call('grow-1','echo one')]}),
			  row('grow-result',result('grow-1','one'))],working:false,settled:true});
			})()`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"grow-1\"] .omp-tool-head')");
			await ui.settleGeometry(".omp-transcript");
			await ui.evaluate("window.growHead=document.querySelector('[data-tool-call-id=\"grow-1\"] .omp-tool-head');window.growHead.focus({preventScroll:true})");
			const point = await ui.evaluate<{ x: number; y: number }>("(()=>{const rect=document.querySelector('.omp-transcript').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.bottom-60}})()");
			const expireIntent = "(()=>{const {promise,resolve}=Promise.withResolvers();setTimeout(resolve,600);return promise})()";
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
			await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: -40 });
			await ui.wait("document.querySelector('.omp-jump-latest')");
			await ui.evaluate(expireIntent);
			await ui.settleGeometry(".omp-transcript");
			const before = await ui.evaluate<{ top: number; head: number }>("({top:document.querySelector('.omp-transcript').scrollTop,head:window.growHead.getBoundingClientRect().top})");
			await ui.evaluate(`window.ui.push({entries:[...window.grow.prose,
			 window.grow.row('grow-call',{role:'assistant',model:'m',timestamp:100,stopReason:'toolUse',content:[window.grow.call('grow-1','echo one')]}),
			 window.grow.row('grow-result',window.grow.result('grow-1','one')),
			 window.grow.row('grow-call-2',{role:'assistant',model:'m',timestamp:101,stopReason:'toolUse',content:[window.grow.call('grow-2','echo two')]}),
			 window.grow.row('grow-result-2',window.grow.result('grow-2','two'))],working:false,settled:true})`);
			await ui.wait("document.querySelector('.omp-overview-head')");
			await ui.settleGeometry(".omp-transcript");
			assert.equal(await ui.evaluate("document.activeElement===window.growHead && document.body.contains(window.growHead)"), true, "the focused call keeps its DOM and focus while it joins a group");
			assert.ok(await ui.evaluate("Boolean(document.activeElement.closest('.omp-overview-member'))"), "the focused call is now a member of the group");
			const after = await ui.evaluate<{ top: number; head: number; latest: boolean }>("({top:document.querySelector('.omp-transcript').scrollTop,head:window.growHead.getBoundingClientRect().top,latest:Boolean(document.querySelector('.omp-jump-latest'))})");
			assert.equal(after.latest, true, "the reader stays detached through the transition");
			assert.ok(Math.abs(after.top - before.top) <= 2, `scroll jumped by ${after.top - before.top}px`);
			assert.ok(Math.abs(after.head - before.head) <= 40, "the focused row remains where the reader left it");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a settled call with an empty result and no error is one static row, while output, errors and live calls keep their disclosure", async () => {
			await reset("paseo-bare-rows");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const call=(id,command,intent)=>({type:'toolCall',id,name:'bash',arguments:{command},intent});
			 const result=(id,text,details,isError=false)=>({role:'toolResult',timestamp:2,toolCallId:id,toolName:'bash',isError,content:[{type:'text',text}],details});
			 window.bare={row,call,result};
			 window.ui.push({entries:[
			  row('bare-call',{role:'assistant',model:'m',timestamp:2,stopReason:'toolUse',content:[call('bare-sleep','sleep 5','Waiting five seconds')]}),
			  row('bare-result',result('bare-sleep','(no output)',{exitCode:0})),
			  row('text',{role:'assistant',model:'m',timestamp:3,stopReason:'stop',content:[{type:'text',text:'between'}]}),
			  row('fail-call',{role:'assistant',model:'m',timestamp:4,stopReason:'toolUse',content:[call('bare-fail','false','Checking')]}),
			  row('fail-result',result('bare-fail','(no output)',{exitCode:1})),
			  row('text-2',{role:'assistant',model:'m',timestamp:5,stopReason:'stop',content:[{type:'text',text:'between again'}]}),
			  row('out-call',{role:'assistant',model:'m',timestamp:6,stopReason:'toolUse',content:[call('bare-out','echo hi')]}),
			  row('out-result',result('bare-out','hi',{exitCode:0}))],working:false,settled:true});
			})()`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"bare-out\"]')");
			const bare = await ui.evaluate<{ tag: string; body: boolean; chevron: boolean; expanded: string | null; text: string; height: number }>(`(()=>{const tool=document.querySelector('[data-tool-call-id="bare-sleep"]'),head=tool.querySelector('.omp-tool-head');return{tag:head.tagName,body:Boolean(tool.querySelector('.omp-tool-body')),chevron:Boolean(tool.querySelector('.codicon-chevron-right,.codicon-chevron-down')),expanded:head.getAttribute('aria-expanded'),text:tool.textContent,height:tool.getBoundingClientRect().height}})()`);
			assert.equal(bare.tag, "DIV", "a row with nothing to disclose is not a button");
			assert.equal(bare.expanded, null);
			assert.equal(bare.body, false);
			assert.equal(bare.chevron, false);
			for (const part of ["Bash", "sleep 5", "Waiting five seconds", "no output"]) assert.ok(bare.text.includes(part), part);
			assert.ok(bare.height < 40, `one line, not three (${bare.height}px)`);
			const gap = await ui.evaluate<number>(`(()=>{const tool=document.querySelector('[data-tool-call-id="bare-sleep"]');return tool.querySelector('.omp-tool-aux--intent').getBoundingClientRect().left-tool.querySelector('.omp-tool-digest').getBoundingClientRect().right})()`);
			assert.ok(gap >= 0 && gap < 24, `intent follows the command directly (${gap}px)`);
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"bare-fail\"] .omp-tool-head').tagName"), "BUTTON", "a non-zero exit keeps its details");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"bare-out\"] .omp-tool-head').tagName"), "BUTTON", "real output keeps its disclosure");
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"bare-fail\"] .omp-tool-head').click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"bare-fail\"] .omp-tool-body')");
			await ui.evaluate(`window.ui.push({working:true,settled:false,entries:[window.bare.row('live-call',{role:'assistant',model:'m',timestamp:2,stopReason:'toolUse',content:[window.bare.call('bare-live','sleep 2','Pausing')]})],activeTools:[{toolCallId:'bare-live',toolName:'bash',args:{command:'sleep 2'},intent:'Pausing',startedAt:2}]})`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"bare-live\"] .omp-tool-head')");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"bare-live\"] .omp-tool-head').tagName"), "BUTTON", "a running call stays expandable");
			await ui.evaluate(`window.ui.push({working:false,settled:true,activeTools:[],entries:[window.bare.row('live-call',{role:'assistant',model:'m',timestamp:2,stopReason:'toolUse',content:[window.bare.call('bare-live','sleep 2','Pausing')]}),window.bare.row('live-result',window.bare.result('bare-live','(no output)',{exitCode:0}))]})`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"bare-live\"] .omp-tool-head')?.tagName==='DIV'");
			await ui.evaluate(`window.ui.push({working:false,settled:true,activeTools:[],entries:[window.bare.row('live-call',{role:'assistant',model:'m',timestamp:2,stopReason:'toolUse',content:[window.bare.call('bare-live','sleep 2','Pausing')]}),window.bare.row('live-result',window.bare.result('bare-live','finally printed',{exitCode:0}))]})`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"bare-live\"] .omp-tool-head')?.tagName==='BUTTON'");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("saved images render as decoded <img> and unresolved or undecodable ones become an honest placeholder, never a broken image", async () => {
			await reset("saved-images");
			const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8i8AAAAASUVORK5CYII=";
			await ui.evaluate(`window.ui.push({entries:[{type:'message',id:'img-user',parentId:null,timestamp:new Date(1000).toISOString(),message:{role:'user',timestamp:1,content:[
			 {type:'text',text:'Look at these'},
			 {type:'image',mimeType:'image/png',data:${JSON.stringify(PNG)}},
			 {type:'image',mimeType:'image/png',data:'blob:sha256:${"0".repeat(64)}'},
			 {type:'image',mimeType:'image/png',data:'AAAA'}]}}],working:false,settled:true})`);
			await ui.wait("document.querySelectorAll('.omp-native-image').length===3");
			await ui.wait("document.querySelectorAll('.omp-image-unavailable').length===2");
			const state = await ui.evaluate<{ imgs: number; loaded: number; placeholders: string[] }>(`(()=>{
			 const imgs=[...document.querySelectorAll('.omp-native-image img')];
			 return {imgs:imgs.length,loaded:imgs.filter(img=>img.complete&&img.naturalWidth>0&&img.naturalHeight>0).length,
			  placeholders:[...document.querySelectorAll('.omp-image-unavailable')].map(node=>node.textContent)};})()`);
			assert.equal(state.imgs, 1, "only the decodable image keeps an <img>");
			assert.equal(state.loaded, 1, "and it has a real decoded size");
			assert.deepEqual(state.placeholders, ["Image not available in saved history", "Image not available in saved history"]);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a tool's intent is a muted ellipsized header line in both states, once, for every family, group member and width", async () => {
			await reset("tool-header-intent");
			const intent = "Checking that the intent stays visible in a collapsed tool row and is cut off with an ellipsis when space runs out";
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const call=(id,name,args)=>({type:'toolCall',id,name,arguments:args,intent:${JSON.stringify(intent)}});
			 const result=(id,name,text,details,isError=false)=>({role:'toolResult',timestamp:2,toolCallId:id,toolName:name,isError,content:[{type:'text',text}],details});
			 window.intentRows={row,call,result};
			 window.ui.push({entries:[
			  row('i-bash',{role:'assistant',model:'m',timestamp:2,stopReason:'toolUse',content:[call('intent-bash','bash',{command:'echo hi'})]}),
			  row('i-bash-r',result('intent-bash','bash','hi',{exitCode:0})),
			  row('i-text',{role:'assistant',model:'m',timestamp:3,stopReason:'stop',content:[{type:'text',text:'between'}]}),
			  row('i-fail',{role:'assistant',model:'m',timestamp:4,stopReason:'toolUse',content:[call('intent-fail','bash',{command:'false'})]}),
			  row('i-fail-r',result('intent-fail','bash','boom',{exitCode:1})),
			  row('i-text2',{role:'assistant',model:'m',timestamp:5,stopReason:'stop',content:[{type:'text',text:'between again'}]}),
			  row('i-read',{role:'assistant',model:'m',timestamp:6,stopReason:'toolUse',content:[call('intent-read','read',{path:'src/a.ts'})]}),
			  row('i-read-r',result('intent-read','read','const a = 1;',{})),
			  row('i-text3',{role:'assistant',model:'m',timestamp:7,stopReason:'stop',content:[{type:'text',text:'and a group'}]}),
			  row('i-pair',{role:'assistant',model:'m',timestamp:8,stopReason:'toolUse',content:[call('intent-g1','bash',{command:'echo one'}),call('intent-g2','bash',{command:'echo two'})]}),
			  row('i-pair-1',result('intent-g1','bash','one',{exitCode:0})),
			  row('i-pair-2',result('intent-g2','bash','two',{exitCode:0}))],working:false,settled:true});
			})()`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"intent-read\"] .omp-tool-head') && document.querySelector('.omp-overview-head')");
			await ui.evaluate("document.querySelector('.omp-overview-head').click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"intent-g1\"] .omp-tool-head') && document.querySelector('[data-tool-call-id=\"intent-g2\"] .omp-tool-head')");
			const ids = ["intent-bash", "intent-fail", "intent-read", "intent-g1", "intent-g2"];
			const measure = (id: string) => ui.evaluate<{ collapsed: boolean; text: string; title: string; height: number; clipped: boolean; muted: boolean; overflow: boolean; chipInside: boolean }>(`(()=>{
			 const tool=document.querySelector('[data-tool-call-id="${id}"]'),head=tool.querySelector('.omp-tool-head'),aux=head.querySelector('.omp-tool-aux--intent'),chip=head.querySelector('.omp-chip'),box=head.getBoundingClientRect();
			 const style=getComputedStyle(aux);
			 return {collapsed:head.getAttribute('aria-expanded')==='false'&&!tool.querySelector('.omp-tool-body'),text:aux.textContent,title:aux.title,height:box.height,
			  clipped:aux.scrollWidth>aux.clientWidth&&style.textOverflow==='ellipsis'&&style.whiteSpace==='nowrap',muted:style.color===getComputedStyle(head.querySelector('.omp-tool-digest')).color,
			  overflow:head.scrollWidth>head.clientWidth+1,chipInside:!chip||chip.getBoundingClientRect().right<=box.right+0.5};})()`);
			for (const width of [800, 320, 160]) {
				await ui.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
				await ui.settleGeometry(".omp-transcript");
				for (const id of ids) {
					const row = await measure(id);
					assert.equal(row.collapsed, true, `${id} is collapsed`);
					assert.equal(row.text, intent, `${id} shows its intent while collapsed at ${width}px`);
					assert.equal(row.title, intent, `${id} keeps the full text in its title`);
					assert.ok(row.height < 40, `${id} header stays one line at ${width}px (${row.height}px)`);
					assert.equal(row.muted, true, `${id} intent uses the muted digest colour`);
					assert.equal(row.overflow, false, `${id} header does not overflow at ${width}px`);
					assert.equal(row.chipInside, true, `${id} keeps its state chip inside the header at ${width}px`);
					if (width <= 320) assert.equal(row.clipped, true, `${id} truncates with an ellipsis at ${width}px`);
				}
			}
			await ui.call("Emulation.clearDeviceMetricsOverride");
			for (const id of ["intent-bash", "intent-g1"]) {
				await ui.evaluate(`document.querySelector('[data-tool-call-id="${id}"] .omp-tool-head').click()`);
				await ui.wait(`document.querySelector('[data-tool-call-id="${id}"] .omp-tool-body')`);
				const expanded = await ui.evaluate<{ occurrences: number; inBody: boolean; legacy: boolean }>(`(()=>{
				 const tool=document.querySelector('[data-tool-call-id="${id}"]');
				 return {occurrences:tool.textContent.split(${JSON.stringify(intent)}).length-1,inBody:tool.querySelector('.omp-tool-body').textContent.includes(${JSON.stringify(intent)}),legacy:Boolean(tool.querySelector('.omp-tool-intent'))};})()`);
				assert.deepEqual(expanded, { occurrences: 1, inBody: false, legacy: false }, `${id} shows the intent once, in the header, when expanded`);
			}
			assert.equal(await ui.evaluate("document.querySelectorAll('[data-tool-call-id=\"intent-fail\"] .omp-tool-status--failed').length"), 1, "the failed call keeps one status icon");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("slash alias acceptance inserts canonical skill text without sending; next Enter sends, Escape preserves draft", async () => {
			await reset("paseo-slash");
			await ui.evaluate("window.ui.push({commands:[{name:'skill:inspect',source:'skill',aliases:['review'],inputHint:'files',description:'Inspect source'},{name:'worktree',aliases:['sandbox']}]});document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "/rev" });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')?.textContent.includes('skill:inspect')");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
			await ui.wait("document.querySelector('.omp-composer textarea').value==='/skill:inspect '");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 0);
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-prompt' && message.text==='/skill:inspect')");
			await ui.call("Input.insertText", { text: "/skill" });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')!==null");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')===null");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer textarea').value"), "/skill");
		});

		await t.test("slash argument variants filter, navigate, insert by keyboard and click without sending, and dismiss safely", async () => {
			await reset("slash-arguments");
			await ui.evaluate("window.ui.push({commands:[{name:'shake',aliases:['trim'],inputHint:'[elide|images|thinking]',subcommands:[{name:'elide',description:'Hide old text (default)'},{name:'images',description:'Remove images',usage:'/shake images'},{name:'thinking',description:'Remove thinking'}]}]});document.querySelector('.omp-composer textarea').focus()");
			const key = async (key: string, code = key, windowsVirtualKeyCode = 0) => { await ui.call("Input.dispatchKeyEvent", {type:"keyDown",key,code,windowsVirtualKeyCode}); await ui.call("Input.dispatchKeyEvent", {type:"keyUp",key,code,windowsVirtualKeyCode}); };
			await ui.call("Input.insertText", {text:"/trim "});
			await ui.wait("document.querySelector('[aria-label=\"Command arguments\"] [role=\"option\"]')");
			assert.equal(await ui.evaluate("document.querySelectorAll('[aria-label=\"Command arguments\"] [role=\"option\"]').length"), 3);
			assert.equal(await ui.evaluate("document.querySelectorAll('[aria-label=\"Command arguments\"] [aria-selected=\"true\"]').length"), 0, "empty optional argument has no forced selection");
			assert.equal(await ui.evaluate("document.querySelector('[aria-label=\"Command arguments\"]').textContent.includes('optional') && document.querySelector('[aria-label=\"Command arguments\"]').textContent.includes('default')"), true);
			await key("ArrowDown", "ArrowDown", 40); await key("ArrowDown", "ArrowDown", 40); await key("Enter", "Enter", 13);
			await ui.wait("document.querySelector('.omp-composer textarea').value==='/trim images '");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 0);
			await key("Enter", "Enter", 13);
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-prompt' && message.text==='/trim images')");
			await ui.call("Input.insertText", {text:"/shake thi"});
			await ui.wait("document.querySelectorAll('[aria-label=\"Command arguments\"] [role=\"option\"]').length===1");
			await key("Tab", "Tab", 9);
			await ui.wait("document.querySelector('.omp-composer textarea').value==='/shake thinking '");
			await key("Enter", "Enter", 13);
			await ui.call("Input.insertText", {text:"/shake "});
			await ui.wait("document.querySelector('[aria-label=\"Command arguments\"]')");
			await key("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('[aria-label=\"Command arguments\"]')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer textarea').value"), "/shake ");
			await key("Enter", "Enter", 13);
			await ui.call("Input.insertText", {text:"/shake im"});
			await ui.wait("document.querySelector('[aria-label=\"Command arguments\"] .omp-slash-hint')?.textContent==='/shake images'");
			await ui.evaluate("document.querySelector('[aria-label=\"Command arguments\"] [role=\"option\"]').click()");
			await ui.wait("document.querySelector('.omp-composer textarea').value==='/shake images '");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').map(message=>message.text)"), ["/trim images","/shake thinking","/shake"]);
		});

		await t.test("optional-empty and hint-only Enter send; required-empty stays open across Escape and every submit route", async () => {
			await reset("slash-argument-enter");
			await ui.evaluate("window.ui.push({commands:[{name:'shake',inputHint:'[variant]',subcommands:[{name:'elide'}]},{name:'focus',inputHint:'[focus instructions]'},{name:'join',inputHint:'<link>'},{name:'required',inputHint:'<action>',subcommands:[{name:'one'}]},{name:'raw',inputHint:'unrecognized hint syntax'}]});document.querySelector('.omp-composer textarea').focus()");
			const enter = () => ui.call("Input.dispatchKeyEvent", {type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
			for (const text of ["/shake ", "/focus ", "/raw "]) {
				await ui.call("Input.insertText", {text});
				await ui.wait("document.querySelector('[aria-label=\"Command arguments\"]')");
				if (text !== "/shake ") assert.equal(await ui.evaluate("document.querySelectorAll('[aria-label=\"Command arguments\"] [role=\"option\"]').length"), 0);
				await enter();
				await ui.wait("document.querySelector('.omp-composer textarea').value===''");
			}
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').map(message=>message.text)"), ["/shake","/focus","/raw"]);
			await ui.call("Input.insertText", {text:"/join "});
			await ui.wait("document.querySelector('[aria-label=\"Command arguments\"]')");
			await enter();
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer textarea').value"), "/join ");
			await ui.call("Input.dispatchKeyEvent", {type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
			await ui.wait("!document.querySelector('[aria-label=\"Command arguments\"]')");
			await ui.evaluate("document.querySelector('button[aria-label=\"Send message\"]').click()");
			await ui.wait("document.querySelector('[aria-label=\"Command arguments\"]')");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 3);
			await ui.evaluate("window.ui.receive({type:'omp:webview-action',action:'send-prompt'})");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 3, "host send action cannot bypass the required-empty guard");
			await ui.call("Input.insertText", {text:"test-link"});
			await enter();
			await ui.wait("document.querySelector('.omp-composer textarea').value===''");
			await ui.call("Input.insertText", {text:"/required "}); await enter();
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer textarea').value"), "/required ");
			assert.equal(await ui.evaluate("document.querySelector('[aria-label=\"Command arguments\"]')!==null"), true);
			await ui.call("Input.dispatchKeyEvent", {type:"keyDown",key:"ArrowDown",code:"ArrowDown",windowsVirtualKeyCode:40}); await enter();
			await ui.wait("document.querySelector('.omp-composer textarea').value==='/required one '");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 4);
		});

		await t.test("IME owns argument arrows, Enter, Tab and clicks, including required-empty input", async () => {
			await reset("slash-argument-ime");
			await ui.evaluate("window.ui.push({commands:[{name:'required',inputHint:'<action>',subcommands:[{name:'one'},{name:'two'}]}]});document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", {text:"/required "});
			await ui.wait("document.querySelector('[aria-label=\"Command arguments\"]')");
			await ui.evaluate(`(()=>{
			 const input=document.querySelector('.omp-composer textarea'); input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
			 for(const key of ['ArrowDown','Enter','Tab'])input.dispatchEvent(new KeyboardEvent('keydown',{key,code:key,isComposing:true,bubbles:true}));
			 document.querySelector('[aria-label="Command arguments"] [role="option"]').click();
			})()`);
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer textarea').value"), "/required ");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 0);
			await ui.evaluate("document.querySelector('.omp-composer textarea').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))");
			await ui.call("Input.dispatchKeyEvent", {type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
			await ui.wait("document.querySelector('.omp-composer textarea').value==='/required one '");
		});

		await t.test("an editor reference from the host lands at the caret with a space around it, keeps the rest of the draft, focuses the input and never submits", async () => {
			await reset("editor-reference");
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "fix  the bug" });
			await ui.evaluate("document.querySelector('.omp-composer textarea').setSelectionRange(4,4);document.activeElement.blur()");
			await ui.evaluate("window.ui.receive({type:'omp:insert-text',text:'@src/a.ts [lines 12-30]'})");
			await ui.wait("document.querySelector('.omp-composer textarea').value==='fix @src/a.ts [lines 12-30] the bug'");
			assert.deepEqual(
				await ui.evaluate("(()=>{const box=document.querySelector('.omp-composer textarea');return{focused:document.activeElement===box,caret:box.selectionStart===box.selectionEnd?box.selectionStart:-1}})()"),
				{ focused: true, caret: "fix @src/a.ts [lines 12-30] ".length },
				"the caret follows the inserted reference, past the space that already followed it",
			);
			// Pasted at the end of a draft that does not end in whitespace: one leading space, one trailing space.
			await ui.evaluate("(()=>{const box=document.querySelector('.omp-composer textarea');box.setSelectionRange(box.value.length,box.value.length)})()");
			await ui.evaluate("window.ui.receive({type:'omp:insert-text',text:'@b.ts @c.ts'})");
			await ui.wait("document.querySelector('.omp-composer textarea').value==='fix @src/a.ts [lines 12-30] the bug @b.ts @c.ts '");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt'||message.type==='omp:chat-steer'||message.type==='omp:chat-follow-up').length"), 0, "an insertion never submits");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("high-contrast selected skill options keep their name, source, description and argument hint readable", async () => {
			await reset("paseo-selected-skill-contrast");
			await ui.evaluate(`(()=>{
			 window.__contrastRestore={style:document.documentElement.getAttribute('style'),bodyClass:document.body.className};
			 document.body.className='vscode-high-contrast';
			 const colors={'editor-background':'#000000','foreground':'#ffffff','descriptionForeground':'#ffffff','editorSuggestWidget-background':'#000000','editorSuggestWidget-foreground':'#ffffff','editorSuggestWidget-selectedBackground':'#ffffff','editorSuggestWidget-selectedForeground':'#000000'};
			 for(const [name,value] of Object.entries(colors))document.documentElement.style.setProperty('--vscode-'+name,value);
			 window.ui.push({commands:[{name:'skill:inspect',source:'skill',description:'Inspect the selected source',inputHint:'files'}]});
			 document.querySelector('.omp-composer textarea').focus();
			})()`);
			try {
				await ui.call("Input.insertText", { text: "/skill:" });
				await ui.wait("document.querySelector('[aria-label=\"Slash commands\"] [aria-selected=\"true\"]')");
				const contrasts = await ui.evaluate<{ part: string; ratio: number }[]>(`(()=>{
				 const option=document.querySelector('[aria-label="Slash commands"] [aria-selected="true"]');
				 const luminance=color=>color.match(/[\\d.]+/g).slice(0,3).map(Number).map(value=>value/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
				 const background=luminance(getComputedStyle(option).backgroundColor);
				 return [['name','strong'],['source','.omp-native-badge'],['description','.omp-slash-description'],['argument hint','.omp-native-muted']].map(([part,selector])=>{
				  const foreground=luminance(getComputedStyle(option.querySelector(selector)).color);
				  return {part,ratio:(Math.max(background,foreground)+0.05)/(Math.min(background,foreground)+0.05)};
				 });
				})()`);
				for (const { part, ratio } of contrasts) assert.ok(ratio >= 4.5, `selected skill ${part} contrast ${ratio} must remain readable`);
			} finally {
				await ui.evaluate(`(()=>{
				 const previous=window.__contrastRestore;
				 if(previous.style===null)document.documentElement.removeAttribute('style');else document.documentElement.setAttribute('style',previous.style);
				 document.body.className=previous.bodyClass;delete window.__contrastRestore;
				})()`);
			}
		});

		await t.test("advisor blockers stay discoverable and guaranteed skills retain exact versus reconstructed provenance and expanded content", async () => {
			await reset("paseo-advisor-skills");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const custom=(customType,content,details,attribution='agent')=>({role:'custom',customType,content,details,attribution,display:true,timestamp:1000});
			 window.ui.push({entries:[
			  row('advisor',custom('advisor','Not the structured notes',{notes:[{note:'Secondary nit',severity:'nit'},{note:'First blocker',severity:'blocker'},{note:'Second blocker',severity:'blocker'},{note:'Third blocker',severity:'blocker'},{note:'Fourth blocker',severity:'blocker'},{note:'Unclassified valid note',severity:'unrecognized'},{note:'   ',severity:'blocker'},null]})),
			  row('fallback',custom('advisor','Actual advisor fallback',{notes:[null,{note:''}]})),
			  row('legacy-skill',custom('skill-prompt',[{type:'text',text:'Legacy expanded body'}],{name:'inspect',args:'src'},'user')),
			  row('exact-skill',custom('skill-prompt',[{type:'text',text:'Exact expanded body'},{type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8i8AAAAASUVORK5CYII='}],{name:'inspect',args:'src',prompt:'Before /skill:inspect src after'},'user')),
			  row('autoload',custom('skill-prompt','AGENT_SKILL_EXPANSION',{name:'autoload',args:'internal'},'agent')),
			  row('hidden-advisor',{...custom('advisor','HIDDEN_ADVISOR',{notes:[{note:'HIDDEN_BLOCKER',severity:'blocker'}]}),display:false})
			 ],working:false,settled:true});
			})()`);
			await ui.wait("document.querySelectorAll('.omp-native-advisor').length===2 && document.querySelectorAll('.omp-native-skill').length===3");
			const compact = await ui.evaluate<string>("document.querySelector('.omp-native-advisor').textContent");
			assert.match(compact, /4 blockers/);
			assert.match(compact, /First blocker/);
			assert.doesNotMatch(compact, /Secondary nit|Fourth blocker|HIDDEN_/);
			await ui.evaluate("document.querySelector('.omp-native-advisor summary').click()");
			await ui.wait("document.querySelector('.omp-native-advisor').textContent.includes('Fourth blocker')");
			const full = await ui.evaluate<string>("document.querySelector('.omp-native-advisor details').textContent");
			assert.ok(full.indexOf("Secondary nit") < full.indexOf("First blocker"), "full disclosure keeps producer order");
			assert.match(full, /severity unknown/);
			const skills = await ui.evaluate<string[]>("[...document.querySelectorAll('.omp-native-skill')].map(skill=>skill.textContent)");
			assert.match(skills[0]!, /Invoked \/skill:inspect · src.*reconstructed/);
			assert.match(skills[1]!, /Before \/skill:inspect src after/);
			assert.doesNotMatch(skills[1]!, /reconstructed/);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-row--user .omp-native-skill').length"), 2);
			assert.equal(await ui.evaluate("document.querySelector('.omp-transcript').textContent.includes('Legacy expanded body')"), false);
			await ui.evaluate("document.querySelectorAll('.omp-native-skill summary')[0].click();document.querySelectorAll('.omp-native-skill summary')[1].click()");
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('Legacy expanded body') && document.querySelector('.omp-native-skill img')");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-native-skill img').src"), /^data:image\/png;base64,/);
			assert.match(await ui.evaluate<string>("document.querySelectorAll('.omp-native-advisor')[1].textContent"), /Actual advisor fallback/);
			assert.doesNotMatch(await ui.evaluate<string>("document.querySelector('.omp-transcript').textContent"), /HIDDEN_ADVISOR|HIDDEN_BLOCKER/);
		});

		await t.test("IME cannot accept slash completion or send, and a pushed catalogue removal withdraws the option without losing draft", async () => {
			await reset("paseo-slash-ime");
			await ui.evaluate("window.ui.push({commands:[{name:'skill:inspect',source:'skill',inputHint:'files'}]});document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "/skill:i" });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			await ui.evaluate(`const input=document.querySelector('.omp-composer textarea');input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
			 input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',code:'Tab',isComposing:true,bubbles:true}));`);
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer textarea').value"), "/skill:i");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 0);
			await ui.evaluate("document.querySelector('.omp-composer textarea').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));window.ui.push({commands:[]})");
			await ui.wait("!document.querySelector('[aria-label=\"Slash commands\"]')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer textarea').value"), "/skill:i");
		});

		await t.test("narrow theme-sized viewports retain a docked ask without page overflow and keyboard disclosures expose real accessibility nodes", async () => {
			await reset("paseo-responsive-accessibility");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 window.ui.push({entries:[
			  row('width-user',{role:'user',timestamp:1000,content:'Explain the deliberately long source path and show the available answer options.'}),
			  row('width-call',{role:'assistant',model:'m',timestamp:1100,stopReason:'toolUse',content:[{type:'toolCall',id:'width-read',name:'read',arguments:{path:'src/a/very/long/path/that/must/not/widen/the/whole/document.ts'}},{type:'toolCall',id:'width-read-2',name:'read',arguments:{path:'src/second.ts'}}]}),
			  row('width-result',{role:'toolResult',timestamp:1200,toolCallId:'width-read',toolName:'read',isError:false,content:[{type:'text',text:'Native file content'}]}),
			  row('width-result-2',{role:'toolResult',timestamp:1201,toolCallId:'width-read-2',toolName:'read',isError:false,content:[{type:'text',text:'Second file content'}]})],
			  uiRequests:[{id:'width-ask',method:'select',title:'Choose a safe option',options:[{label:'Proceed with the explanation'},{label:'Do not proceed'}]}],working:true,settled:false});
			})()`);
			await ui.wait("document.querySelector('.omp-ask-options button') && document.querySelector('.omp-overview-head')");
			const themes = [
				{ name: "vscode-light", background: "#ffffff", foreground: "#333333", border: "#666666" },
				{ name: "vscode-dark", background: "#1e1e1e", foreground: "#dddddd", border: "#555555" },
				{ name: "vscode-high-contrast", background: "#000000", foreground: "#ffffff", border: "#ffffff" },
			];
			for (const theme of themes) for (const width of [320, 160]) {
				await ui.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: width === 160 ? 2 : 1, mobile: false });
				await ui.evaluate(`document.body.className=${JSON.stringify(theme.name)};
				 document.documentElement.style.setProperty('--vscode-editor-background',${JSON.stringify(theme.background)});
				 document.documentElement.style.setProperty('--vscode-foreground',${JSON.stringify(theme.foreground)});
				 document.documentElement.style.setProperty('--vscode-widget-border',${JSON.stringify(theme.border)});`);
				await ui.settleGeometry(".omp-transcript,.omp-composer");
				const layout = await ui.evaluate<{ width: number; overflow: number; outside: boolean }>("({width:innerWidth,overflow:document.documentElement.scrollWidth,outside:!document.querySelector('.omp-transcript').contains(document.querySelector('.omp-ask'))})");
				assert.ok(layout.overflow <= layout.width + 1, `${theme.name} at ${width}px must not overflow the whole page`);
				assert.equal(layout.outside, true, "live ask stays outside the virtualized history");
			}
			await ui.call("Emulation.clearDeviceMetricsOverride");
			await ui.evaluate("document.querySelector('.omp-overview-head').focus()");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
			await ui.wait("document.querySelector('.omp-overview-head').getAttribute('aria-expanded')==='true' && document.querySelector('[data-tool-call-id=\"width-read\"]')");
			const tree = await ui.call("Accessibility.getFullAXTree");
			const nodes = tree.nodes as { ignored: boolean; role?: { value: string }; name?: { value: string } }[];
			assert.ok(nodes.some(node => !node.ignored && node.role?.value === "region" && node.name?.value === "Conversation transcript"));
			assert.ok(nodes.some(node => !node.ignored && node.role?.value === "group" && node.name?.value === "Read 2 files"));
			assert.ok(nodes.some(node => !node.ignored && node.role?.value === "button" && node.name?.value === "Proceed with the explanation"));
			await ui.evaluate("document.querySelector('.omp-ask-options button').click();document.querySelector('.omp-ask-options button')?.click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-ui-response')");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-ui-response' && message.response.id==='width-ask').length"), 1);
			await ui.evaluate("window.ui.push({uiRequests:[],working:false,settled:true})");
			await ui.wait("!document.querySelector('.omp-ask')");
		});

		await t.test("pending questions and approvals never render working activity, and an Ask waits with a question icon", async () => {
			await reset("pending-answer", "detailed");
			await ui.evaluate(`window.ui.push({working:true,settled:false,uiRequests:[{id:'approval',method:'confirm',title:'Continue?',message:'Apply the change?'}]})`);
			await ui.wait("document.querySelector('.omp-ask')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-shimmer')"), null, "approval blocks the turn's working indicator");
			await ui.evaluate(`window.ui.push({entries:[{type:'message',id:'ask-call',parentId:null,timestamp:new Date(1000).toISOString(),message:{role:'assistant',model:'m',timestamp:1,stopReason:'toolUse',content:[{type:'toolCall',id:'question',name:'ask',arguments:{question:'Which scope?'}}]}}],activeTools:[{toolCallId:'question',toolName:'ask',args:{question:'Which scope?'},startedAt:1}],uiRequests:[{id:'answer',method:'select',title:'Which scope?',options:[{label:'One file'}]}]})`);
			await ui.wait("document.querySelector('[data-tool-name=\"ask\"] .codicon-question')");
			const face = await ui.evaluate<string>("document.querySelector('[data-tool-name=\"ask\"]').textContent");
			assert.match(face, /Waiting for your answer/);
			assert.doesNotMatch(face, /working|running/i);
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-name=\"ask\"] .codicon-loading, [data-tool-name=\"ask\"] .omp-chip')"), null);
		});

		await t.test("ask options give the label the whole row with the description below it; a multi-question ask has one tab per question, keeps answers across switches, switches by keyboard and submits every answer once", async () => {
			await reset("ask-tabs");
			const questions = `[
			 {id:'scope',header:'Scope',question:'Which scope should the change cover?',multi:false,recommended:0,options:[{label:'Leave it empty for now',description:'Leave the field empty for now and fill it in later without blocking the rest of the form'},{label:'Whole repository'}]},
			 {id:'checks',header:'A very long header that must truncate inside the tab strip',question:'Which checks should run?',multi:true,options:[{label:'Typecheck'},{label:'Unit tests',description:'node --test'}]},
			 {id:'rollout',question:'Anything else you want to add about the rollout plan for this change?',multi:false,options:[{label:'No'}]}]`;
			await ui.evaluate(`window.ui.push({uiRequests:[{id:'ask3',method:'ask',title:'t',questions:${questions}}],working:true,settled:false})`);
			await ui.wait("document.querySelectorAll('.omp-ask-tab').length===4 && document.querySelector('.omp-ask-option')");

			// Layout: the label owns the row's text column and the description sits below it, muted, at the label's left edge.
			await ui.evaluate("document.documentElement.style.setProperty('--vscode-descriptionForeground','#888888')");
			for (const width of [320, 640]) {
				await ui.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
				await ui.settleGeometry(".omp-ask-option");
				const layout = await ui.evaluate<{ labelW: number; textW: number; rowInner: number; descBelow: boolean; sameLeft: boolean; muted: boolean; overflow: number; width: number; labelLines: number }>(`(()=>{
				 const row=document.querySelector('.omp-ask-option'),label=row.querySelector('.omp-ask-option-label'),desc=row.querySelector('.omp-ask-option-desc'),text=row.querySelector('.omp-ask-option-text');
				 const l=label.getBoundingClientRect(),d=desc.getBoundingClientRect(),t=text.getBoundingClientRect(),r=row.getBoundingClientRect(),marker=row.querySelector('.omp-ask-option-marker').getBoundingClientRect(),cs=getComputedStyle(row);
				 return {labelW:l.width,textW:t.width,rowInner:r.width-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)-2-marker.width-parseFloat(cs.columnGap),
				  descBelow:d.top>=l.bottom-0.5,sameLeft:Math.abs(d.left-l.left)<1,muted:getComputedStyle(desc).color!==getComputedStyle(label).color,
				  overflow:document.documentElement.scrollWidth,width:innerWidth,labelLines:Math.round(l.height/parseFloat(getComputedStyle(label).lineHeight||'16'))};
				})()`);
				assert.ok(layout.labelW >= layout.rowInner - 1, `${width}px: the label takes the whole text column (${layout.labelW} of ${layout.rowInner})`);
				assert.ok(Math.abs(layout.textW - layout.rowInner) <= 1, `${width}px: the text column takes the whole row`);
				assert.equal(layout.descBelow, true, "the description is below the label");
				assert.equal(layout.sameLeft, true, "the description has the label's indent");
				assert.equal(layout.muted, true, "the description is muted");
				assert.ok(layout.overflow <= layout.width + 1, `${width}px: the ask does not overflow the page`);
			}
			await ui.call("Emulation.clearDeviceMetricsOverride");

			// One tab per question plus Submit; none answered yet.
			const tabs = () => ui.evaluate<{ label: string; selected: boolean; answered: boolean }[]>("[...document.querySelectorAll('.omp-ask-tab')].map(tab=>({label:tab.querySelector('.omp-ask-tab-label').textContent,selected:tab.getAttribute('aria-selected')==='true',answered:tab.classList.contains('omp-ask-tab--answered')}))");
			assert.deepEqual((await tabs()).map(tab => tab.label), ["Scope", "A very long header that…", "Anything else you want…", "Submit"]);
			assert.deepEqual((await tabs()).map(tab => tab.selected), [true, false, false, false]);
			assert.deepEqual((await tabs()).map(tab => tab.answered), [false, false, false, false]);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-ask-tab[role=tab]').length"), 4);

			// Answering a single-select commits and moves on; the tab is marked answered.
			await ui.evaluate("document.querySelector('.omp-ask-option').click()");
			await ui.wait("document.querySelectorAll('.omp-ask-tab')[1].getAttribute('aria-selected')==='true'");
			assert.deepEqual((await tabs()).map(tab => tab.answered), [true, false, false, false]);
			assert.match(await ui.evaluate<string>("document.querySelectorAll('.omp-ask-tab')[0].getAttribute('aria-label')"), /\(answered\)/);
			// Multi-select toggles two options without leaving the question.
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[0].click()");
			await ui.wait("document.querySelectorAll('.omp-ask-option--checked').length===1");
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[1].click()");
			await ui.wait("document.querySelectorAll('.omp-ask-option--checked').length===2");
			assert.equal((await tabs())[1]?.selected, true);

			// Free switching by click keeps every answer.
			await ui.evaluate("document.querySelectorAll('.omp-ask-tab')[0].click()");
			await ui.wait("document.querySelectorAll('.omp-ask-tab')[0].getAttribute('aria-selected')==='true'");
			assert.equal(await ui.evaluate("document.querySelector('.omp-ask-option--checked .omp-ask-option-label').textContent"), "Leave it empty for now (Recommended)");
			await ui.evaluate("document.querySelectorAll('.omp-ask-tab')[1].click()");
			await ui.wait("document.querySelectorAll('.omp-ask-option--checked').length===2");

			// Keyboard: ArrowRight/ArrowLeft cycle through the tabs, Submit included, with wrap-around.
			const press = async (key: string, code: string, keyCode: number) => {
				await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
				await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
			};
			const selectedTab = () => ui.evaluate<number>("[...document.querySelectorAll('.omp-ask-tab')].findIndex(tab=>tab.getAttribute('aria-selected')==='true')");
			await ui.evaluate("document.querySelectorAll('.omp-ask-tab')[1].focus()");
			await press("ArrowRight", "ArrowRight", 39);
			await ui.wait("document.querySelectorAll('.omp-ask-tab')[2].getAttribute('aria-selected')==='true' && document.activeElement===document.querySelectorAll('.omp-ask-tab')[2]");
			await press("ArrowRight", "ArrowRight", 39);
			await ui.wait("document.querySelectorAll('.omp-ask-tab')[3].getAttribute('aria-selected')==='true'");
			await press("ArrowRight", "ArrowRight", 39);
			await ui.wait("document.querySelectorAll('.omp-ask-tab')[0].getAttribute('aria-selected')==='true'");
			await press("ArrowLeft", "ArrowLeft", 37);
			await ui.wait("document.querySelectorAll('.omp-ask-tab')[3].getAttribute('aria-selected')==='true'");
			assert.equal(await selectedTab(), 3);
			// Keyboard switching also works from an answer row, and the answers are all still there.
			await press("ArrowLeft", "ArrowLeft", 37);
			await ui.wait("document.querySelectorAll('.omp-ask-tab')[2].getAttribute('aria-selected')==='true'");
			await ui.evaluate("document.querySelector('.omp-ask-option').focus()");
			await press("ArrowLeft", "ArrowLeft", 37);
			await ui.wait("document.querySelectorAll('.omp-ask-tab')[1].getAttribute('aria-selected')==='true'");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-ask-option--checked').length"), 2, "the multi-select answers survived the switches");

			// A custom answer on the last question, then the review tab lists every answer and the unanswered one is flagged.
			await ui.evaluate("document.querySelectorAll('.omp-ask-tab')[2].click()");
			await ui.wait("document.querySelectorAll('.omp-ask-tab')[2].getAttribute('aria-selected')==='true'");
			await ui.evaluate("[...document.querySelectorAll('.omp-ask-option')].find(row=>row.textContent.includes('Other')).click()");
			await ui.wait("document.querySelector('.omp-ask-custom textarea')");
			await ui.call("Input.insertText", { text: "Ship it behind a flag" });
			await ui.evaluate("document.querySelector('.omp-ask-custom .omp-btn--primary').click()");
			await ui.wait("document.querySelectorAll('.omp-ask-tab')[3].getAttribute('aria-selected')==='true' && document.querySelector('.omp-ask-review')");
			assert.deepEqual((await tabs()).map(tab => tab.answered), [true, true, true, false]);
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-ask-review-a')].map(a=>a.textContent)"), ["Leave it empty for now (Recommended)", "Typecheck, Unit tests", "“Ship it behind a flag”"]);
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-ui-response').length"), 0, "nothing is sent before Submit");

			// One submit sends every answer, in question order, exactly once.
			await ui.evaluate("document.querySelector('.omp-ask-panel .omp-btn--primary').click();document.querySelector('.omp-ask-panel .omp-btn--primary')?.click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-ui-response')");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-ui-response').map(message=>message.response)"), [{
				id: "ask3",
				answers: [
					{ id: "scope", selectedOptions: ["Leave it empty for now"] },
					{ id: "checks", selectedOptions: ["Typecheck", "Unit tests"] },
					{ id: "rollout", selectedOptions: [], customInput: "Ship it behind a flag" },
				],
			}]);
			await ui.evaluate("window.ui.push({uiRequests:[],working:false,settled:true})");
			await ui.wait("!document.querySelector('.omp-ask')");
		});

		await t.test("Other is selected immediately and typing answers a question before Next or review, without an extra commit", async () => {
			await reset("ask-other-draft");
			await ui.evaluate(`window.ui.push({uiRequests:[{id:'ask-other',method:'ask',title:'t',questions:[
			 {id:'color',header:'Color',question:'Which color?',multi:false,options:[{label:'Red'},{label:'Green'},{label:'Blue'}]},
			 {id:'checks',question:'Checks?',multi:true,options:[{label:'Typecheck'},{label:'Tests'}]},
			 {id:'final',question:'Proceed?',multi:false,options:[{label:'Yes'},{label:'No'}]}]}],working:true,settled:false})`);
			await ui.wait("document.querySelectorAll('.omp-ask-option').length===4");
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[3].click()");
			await ui.wait("document.querySelector('.omp-ask-custom textarea')");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-ask-option')[3].getAttribute('aria-checked')"), "true");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-ask-option')[3].querySelector('.codicon-circle-large-filled')!==null"), true);
			await ui.call("Input.insertText", { text: "Custom violet" });
			await ui.wait("document.querySelectorAll('.omp-ask-tab')[0].classList.contains('omp-ask-tab--answered')");
			await ui.evaluate("document.querySelector('.omp-ask-panel > .omp-composer-actions .omp-btn').click()");
			await ui.wait("document.querySelector('.omp-ask-options').getAttribute('role')==='group'");
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[0].click()");
			await ui.wait("document.querySelectorAll('.omp-ask-option')[0].getAttribute('aria-checked')==='true'");
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[1].click()");
			await ui.wait("document.querySelectorAll('.omp-ask-option--checked').length===2");
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[0].click()");
			await ui.wait("document.querySelectorAll('.omp-ask-option')[0].getAttribute('aria-checked')==='false'");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-ask-option')[0].querySelector('.codicon-blank')!==null"), true);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-ask-option')[1].querySelector('.codicon-check')!==null"), true);
			await ui.evaluate("document.querySelectorAll('.omp-ask-tab')[2].click()");
			await ui.wait("document.querySelector('.omp-ask-options').getAttribute('role')==='radiogroup'");
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[0].click()");
			await ui.wait("document.querySelector('.omp-ask-review')");
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-ask-review-a')].map(a=>a.textContent)"), ["“Custom violet”", "Tests", "Yes"]);
			await ui.evaluate("document.querySelectorAll('.omp-ask-tab')[2].click()");
			await ui.wait("document.querySelector('.omp-ask-option--checked .codicon-circle-large-filled')");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-ask-option--checked').length"), 1);
			assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('.codicon-circle-large-filled'),'::before').content!==getComputedStyle(document.querySelector('.codicon-circle-large-outline'),'::before').content"), true);
			await ui.evaluate("document.querySelector('.omp-ask-tab--submit').click()");
			await ui.wait("document.querySelector('.omp-ask-review')");
			await ui.evaluate("document.querySelector('.omp-ask-panel .omp-btn--primary').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-ui-response')");
			assert.deepEqual(await ui.evaluate("window.sent.find(message=>message.type==='omp:chat-ui-response').response"), {
				id: "ask-other", answers: [
					{ id: "color", selectedOptions: [], customInput: "Custom violet" },
					{ id: "checks", selectedOptions: ["Tests"] },
					{ id: "final", selectedOptions: ["Yes"] },
				],
			});
			await ui.evaluate("window.ui.push({uiRequests:[],working:false,settled:true})");
		});

		await t.test("the ask tab strip wraps instead of overflowing at narrow widths and a lone single-select question has no tabs and answers at once", async () => {
			await reset("ask-tabs-narrow");
			const many = Array.from({ length: 6 }, (_, index) => `{id:'q${index}',header:'Header number ${index} that is far too long to fit',question:'Question ${index}?',multi:false,options:[{label:'Yes'},{label:'No'}]}`).join(",");
			await ui.evaluate(`window.ui.push({uiRequests:[{id:'ask-many',method:'ask',title:'t',questions:[${many}]}],working:true,settled:false})`);
			await ui.wait("document.querySelectorAll('.omp-ask-tab').length===7");
			for (const width of [320, 160]) {
				await ui.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
				await ui.settleGeometry(".omp-ask-tabs");
				const fit = await ui.evaluate<{ overflow: number; width: number; strip: number; stripClient: number; tabsOutside: number }>(`(()=>{
				 const strip=document.querySelector('.omp-ask-tabs'),box=document.querySelector('.omp-ask').getBoundingClientRect();
				 return {overflow:document.documentElement.scrollWidth,width:innerWidth,strip:strip.scrollWidth,stripClient:strip.clientWidth,
				  tabsOutside:[...document.querySelectorAll('.omp-ask-tab')].filter(tab=>tab.getBoundingClientRect().right>box.right+1).length};
				})()`);
				assert.ok(fit.overflow <= fit.width + 1, `${width}px: the page does not overflow`);
				assert.ok(fit.strip <= fit.stripClient + 1, `${width}px: the tab strip does not scroll sideways`);
				assert.equal(fit.tabsOutside, 0, `${width}px: every tab stays inside the card`);
			}
			await ui.call("Emulation.clearDeviceMetricsOverride");
			await ui.evaluate("window.ui.push({uiRequests:[{id:'ask-one',method:'ask',title:'t',questions:[{id:'only',question:'Proceed?',multi:false,options:[{label:'Yes'},{label:'No'}]}]}]})");
			await ui.wait("document.querySelector('.omp-ask') && !document.querySelector('.omp-ask-tab') && document.querySelectorAll('.omp-ask-option').length===3");
			await ui.evaluate("document.querySelector('.omp-ask-option').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-ui-response' && message.response.id==='ask-one')");
			assert.deepEqual(await ui.evaluate("window.sent.find(message=>message.type==='omp:chat-ui-response' && message.response.id==='ask-one').response"), { id: "ask-one", answers: [{ id: "only", selectedOptions: ["Yes"] }] });
			await ui.evaluate("window.ui.push({uiRequests:[{id:'ask-one-custom',method:'ask',title:'t',questions:[{id:'only',question:'Proceed?',multi:false,options:[{label:'Yes'},{label:'No'}]}]}]})");
			await ui.wait("document.querySelectorAll('.omp-ask-option').length===3");
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[2].click()");
			await ui.wait("document.querySelector('.omp-ask-custom textarea')");
			await ui.call("Input.insertText", { text: "With a custom plan" });
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-ask-option')[2].getAttribute('aria-checked')"), "true");
			await ui.evaluate("document.querySelector('.omp-ask-custom .omp-btn--primary').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-ui-response' && message.response.id==='ask-one-custom')");
			assert.deepEqual(await ui.evaluate("window.sent.find(message=>message.type==='omp:chat-ui-response' && message.response.id==='ask-one-custom').response"), { id: "ask-one-custom", answers: [{ id: "only", selectedOptions: [], customInput: "With a custom plan" }] });
			await ui.evaluate("window.ui.push({uiRequests:[],working:false,settled:true})");
		});

		await t.test("transcript displays native content but never internal entries, fields or role echoes", async () => {
			await reset("native-visibility", "detailed", true);
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-02T00:00:00Z',message});
			 const usage={input:123456789,output:0,cacheRead:0,cacheWrite:0,totalTokens:123456789,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
			 window.ui.push({entries:[
			  row('user',{role:'user',timestamp:1,attribution:'user',content:[{type:'text',text:'Visible prompt',signature:'INTERNAL_USER_SIGNATURE'}],inputMetadata:'INTERNAL_USER_METADATA'}),
			  row('assistant',{role:'assistant',timestamp:2,provider:'INTERNAL_PROVIDER',model:'INTERNAL_MODEL',responseId:'INTERNAL_RESPONSE',stopReason:'toolUse',usage,content:[{type:'thinking',thinking:'Visible reasoning',signature:'INTERNAL_THINKING_SIGNATURE'},{type:'text',text:'Visible before tool',signature:'INTERNAL_TEXT_SIGNATURE'},{type:'toolCall',id:'visible-call',name:'grep',arguments:{pattern:'visible-query'}},{type:'text',text:'Visible after tool'}]}),
			  row('result',{role:'toolResult',timestamp:3,toolCallId:'visible-call',toolName:'grep',isError:false,content:[{type:'text',text:'Visible tool output'}],details:{privateField:'INTERNAL_RESULT'}}),
			  {type:'model_change',id:'model',parentId:null,timestamp:'2026-10-02T00:00:00Z',model:'visible-model',privateField:'INTERNAL_MODEL_CHANGE'},
			  {type:'thinking_level_change',id:'thinking',parentId:null,timestamp:'2026-10-02T00:00:00Z',thinkingLevel:'high',privateField:'INTERNAL_THINKING_CHANGE'},
			  row('custom-visible',{role:'custom',timestamp:4,customType:'visible-extension',display:true,content:'Visible extension content',details:{privateField:'INTERNAL_CUSTOM_DETAILS'}}),
			  row('developer',{role:'developer',timestamp:5,content:'INTERNAL_DEVELOPER'}),
			  row('unknown-role',{role:'credential_pin',timestamp:6,content:'INTERNAL_ROLE'}),
			  row('hidden-custom',{role:'custom',timestamp:7,customType:'hidden-extension',display:false,content:'INTERNAL_CUSTOM'}),
			  {type:'custom_message',id:'hidden-collab',parentId:null,timestamp:'2026-10-02T00:00:00Z',customType:'collab-prompt',display:false,content:'INTERNAL_COLLAB'},
			  {type:'custom',id:'custom-metadata',parentId:null,timestamp:'2026-10-02T00:00:00Z',customType:'private-state',data:{privateField:'INTERNAL_CUSTOM_ENTRY'}},
			  {type:'model_usage',id:'usage',parentId:null,timestamp:'2026-10-02T00:00:00Z',data:'INTERNAL_USAGE_ENTRY'},
			  {type:'credential_pin',id:'credential',parentId:null,timestamp:'2026-10-02T00:00:00Z',data:'INTERNAL_CREDENTIAL_ENTRY'},
			  row('usage-only',{role:'assistant',timestamp:8,model:'INTERNAL_MODEL',stopReason:'stop',usage,content:[{type:'redactedThinking',data:'INTERNAL_REDACTED_PAYLOAD'},{type:'anthropicServerTool',block:{name:'INTERNAL_SERVER_TOOL'}}]})
			 ]});
			})()`);
			await ui.wait("document.querySelector('.omp-transcript')?.textContent.includes('Visible extension content')");
			await ui.evaluate("document.querySelector('.omp-transcript details').open = true");
			await ui.wait("document.querySelector('.omp-transcript')?.textContent.includes('Visible reasoning')");
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"visible-call\"] .omp-tool-head').click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"visible-call\"] .omp-tool-body') !== null");
			const visible = await ui.evaluate<string>("document.querySelector('.omp-transcript').textContent");
			for (const body of ["Visible prompt", "Visible before tool", "Visible after tool", "Visible tool output", "visible-model"]) assert.ok(visible.includes(body), body);
			assert.match(visible, /thinking level.*high/i, "the real thinking change remains readable");
			assert.doesNotMatch(visible, /INTERNAL_|123456789/);
		});

		await t.test("native tool lifecycle keeps meaningful status, expansion and interrupted wait visibility", async () => {
			await reset("native-tool-lifecycle", "detailed");
			await ui.evaluate(`(()=>{
			 const args={command:'printf native-output',cwd:null,env:null,timeout:null};
			 const assistant={role:'assistant',timestamp:1,model:'native-model',stopReason:'toolUse',content:[{type:'toolCall',id:'bash-ui',name:'bash',arguments:args}]};
			 window.shellFixture={args,assistant,call:{type:'message',id:'bash-call',parentId:null,timestamp:'2026-10-02T00:00:00Z',message:assistant},
			  result:{type:'message',id:'bash-result',parentId:'bash-call',timestamp:'2026-10-02T00:00:01Z',message:{role:'toolResult',timestamp:2,toolCallId:'bash-ui',toolName:'bash',isError:false,content:[{type:'text',text:'native-output'}],details:{exitCode:0,timeoutSeconds:300,requestedTimeoutSeconds:300,privateField:'INTERNAL_RESULT'}}}};
			 window.ui.push({entries:[],working:true,stream:{messageId:'stream-call',message:assistant},activeTools:[]});
			})()`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"bash-ui\"]')?.getAttribute('data-tool-status') === 'queued'");
			await ui.evaluate(`window.ui.push({activeTools:[{toolCallId:'bash-ui',toolName:'bash',args:window.shellFixture.args,startedAt:1,partialResult:{content:[{type:'text',text:'partial-output'}]}}]})`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"bash-ui\"]')?.getAttribute('data-tool-status') === 'running'");
			await ui.evaluate("window.ui.push({stream:null,working:false,activeTools:[],entries:[window.shellFixture.call,window.shellFixture.result]})");
			await ui.wait("document.querySelector('[data-tool-call-id=\"bash-ui\"]')?.getAttribute('data-tool-status') === 'complete'");
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"bash-ui\"] .omp-tool-head').click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"bash-ui\"] .omp-tool-head').getAttribute('aria-expanded') === 'true'");
			const expanded = await ui.evaluate<string>("document.querySelector('[data-tool-call-id=\"bash-ui\"]').textContent");
			assert.ok(expanded.includes("printf native-output") && expanded.includes("native-output"));
			assert.doesNotMatch(expanded, /INTERNAL_|timeoutSeconds|cwd|null|300/);
			await ui.evaluate(`window.ui.push({entries:[window.shellFixture.call,{...window.shellFixture.result,message:{...window.shellFixture.result.message,isError:true,content:[{type:'text',text:'Actual command failure'}],details:{exitCode:2}}}]})`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"bash-ui\"]')?.getAttribute('data-tool-status') === 'error'");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"bash-ui\"] .omp-tool-body').textContent.split('Actual command failure').length-1"), 1, "stderr is printed once");
			assert.equal(await ui.evaluate("document.querySelectorAll('[data-tool-call-id=\"bash-ui\"] .omp-tool-head .codicon-error').length"), 1);
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"bash-ui\"] .omp-chip--err')"), null);
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-02T00:00:00Z',message});
			 window.ui.push({entries:[
			  row('wait-call',{role:'assistant',timestamp:3,model:'native-model',stopReason:'toolUse',content:[{type:'toolCall',id:'call_wait|fc_native',name:'wait',arguments:{i:'Waiting for task agents'}}]}),
			  row('wait-result',{role:'toolResult',timestamp:4,toolCallId:'call_wait|fc_native',toolName:'wait',isError:true,content:[{type:'text',text:'MODEL_ONLY_RETRY_GUIDANCE'}],details:{source:'interrupt_skipped',__interrupted:true,execution:'started'}}),
			  row('completion',{role:'custom',timestamp:5,customType:'async-result',display:true,content:'MODEL_ONLY_JOB_RESULT',details:{jobs:[{jobId:'Worker',type:'task'}]}})
			 ]});
			})()`);
			await ui.wait("document.querySelector('.omp-native-async-result')?.textContent.includes('Worker')");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-name=\"wait\"]') === null"), true);
			assert.doesNotMatch(await ui.evaluate<string>("document.querySelector('.omp-transcript').textContent"), /MODEL_ONLY_/);
		});

		await t.test("flat task, wait and command disclosures retain complete user content without exposing private payloads", async () => {
			await reset("native-tool-disclosure", "detailed", true);
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-02T00:00:00Z',message});
			 const tail=Array.from({length:40},(_,index)=>'tail-row-'+index).join('\\n')+'\\nwrapped start '+('x'.repeat(5000))+' wrapped end';
			 window.ui.push({entries:[
			  row('call',{role:'assistant',timestamp:1,model:'m',stopReason:'toolUse',content:[
			   {type:'toolCall',id:'task-disclosure',name:'task',arguments:{context:'# Goal\\nShared context detail',tasks:[{name:'Worker',agent:'scout',task:'Assigned detail'}]}},
			   {type:'toolCall',id:'wait-disclosure',name:'wait',arguments:{}},
			   {type:'toolCall',id:'bash-disclosure',name:'bash',arguments:{command:'print long output'}},
			   {type:'toolCall',id:'goal-disclosure',name:'goal',arguments:{op:'status'}}]}),
			  row('task',{role:'toolResult',timestamp:2,toolCallId:'task-disclosure',toolName:'task',isError:false,content:[{type:'text',text:'Background task started'}],details:{results:[],async:{state:'running',jobId:'INTERNAL_JOB',type:'task'},totalDurationMs:0,progress:[{id:'Worker',agent:'scout',status:'running',task:'Assigned detail',currentTool:'read',lastIntent:'Expanded agent activity',durationMs:0}]}}),
			  row('wait',{role:'toolResult',timestamp:3,toolCallId:'wait-disclosure',toolName:'wait',isError:false,content:[{type:'text',text:'INTERNAL_WAIT'}],details:{jobs:[{id:'Worker',type:'task',status:'completed',durationMs:12000,label:'Expanded job description',resultText:'{"summary":"Expanded wait detail","assignment_identifier":"not provided"}'}]}}),
			  row('bash',{role:'toolResult',timestamp:4,toolCallId:'bash-disclosure',toolName:'bash',isError:false,content:[{type:'text',text:tail}],details:{exitCode:0}}),
			  row('goal',{role:'toolResult',timestamp:5,toolCallId:'goal-disclosure',toolName:'goal',isError:false,content:[{type:'text',text:''}],details:{goal:{objective:Array.from({length:80},(_,index)=>'Long objective detail '+index).join('\\n'),status:'active',tokensUsed:12}}})
			 ]});
			})()`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"wait-disclosure\"]')?.textContent.includes('settled')");
			const task = await ui.evaluate<string>("document.querySelector('[data-tool-call-id=\"task-disclosure\"]').textContent");
			assert.match(task, /Worker.*scout.*running/s);
			assert.doesNotMatch(task, /Goal|Shared context detail|Assigned detail|Expanded agent activity|Background task started|0ms|INTERNAL_/);
			const wait = await ui.evaluate<string>("document.querySelector('[data-tool-call-id=\"wait-disclosure\"]').textContent");
			assert.match(wait, /Worker settled.*12s/s, "the one-line face names the job, its outcome and clock");
			assert.doesNotMatch(wait, /Expanded job description/);
			assert.match(await ui.evaluate<string>("document.querySelector('[data-tool-call-id=\"wait-disclosure\"] .omp-tool-head').title"), /Worker · task · completed · 12s · Expanded job description/, "the label is in the tooltip");
			assert.doesNotMatch(wait, /Expanded wait detail|assignment_identifier|INTERNAL_/);
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"bash-disclosure\"] pre')"), null);
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"goal-disclosure\"] .omp-tool-body')"), null);
			await ui.evaluate("document.querySelectorAll('.omp-native-tool > .omp-tool-head').forEach(button=>button.click())");
			await ui.wait("document.querySelector('[data-tool-call-id=\"task-disclosure\"] .omp-tool-head').getAttribute('aria-expanded')==='true'");
			const expanded = await ui.evaluate<string>("document.querySelector('.omp-transcript').textContent");
			for (const detail of ["Goal", "Shared context detail", "Assigned detail", "Expanded agent activity", "Expanded wait detail", "assignment_identifier", "tail-row-0", "Long objective detail 79"]) assert.ok(expanded.includes(detail), detail);
			assert.doesNotMatch(expanded, /Background task started|0ms|INTERNAL_/);
			await ui.evaluate("document.querySelectorAll('.omp-native-tool > .omp-tool-head').forEach(button=>button.click())");
			await ui.wait("document.querySelector('[data-tool-call-id=\"task-disclosure\"] .omp-tool-head').getAttribute('aria-expanded')==='false'");
			assert.doesNotMatch(await ui.evaluate<string>("document.querySelector('[data-tool-call-id=\"task-disclosure\"]').textContent"), /Shared context detail|Assigned detail|Expanded agent activity/);
			assert.doesNotMatch(await ui.evaluate<string>("document.querySelector('[data-tool-call-id=\"wait-disclosure\"]').textContent"), /Expanded wait detail|assignment_identifier/);
		});

		await t.test("HUD disclosures and overview runs preserve child-read laziness and full tool details", async () => {
			await reset("native-huds");
			// The HUD rows' combined height is a share of the viewport; these bounds assume a tall one.
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
			// A running agent's time advances with the clock between progress events; pin it so the 12.3s the registry reported stays exact.
			await ui.evaluate("window.fixtureClock.setNow(1800000000000)");
			await ui.evaluate(`window.ui.push({
			 agents:[{id:'worker',index:0,agent:'implementer',agentSource:'INTERNAL_AGENT_SOURCE',status:'running',lastUpdate:1790907963935,parentToolCallId:'INTERNAL_PARENT_CALL',description:'Implement native UI',task:'INTERNAL_FULL_TASK',assignment:'INTERNAL_DUPLICATE_ASSIGNMENT',progress:{id:'worker',status:'running',currentTool:'read',lastIntent:'Inspecting native source',currentToolArgs:'INTERNAL_RAW_TOOL_ARGS',durationMs:12345,tokens:4800,contextTokens:3600,contextWindow:128000,cost:0.07,resolvedModel:'INTERNAL_ROUTING_MODEL',recentOutput:['INTERNAL_RECENT_OUTPUT'],privateField:'INTERNAL_PROGRESS_PAYLOAD'}}],
			 agentAvailability:'available',
			 todoSeed:[{name:'Ship',tasks:[{content:'Completed task',status:'completed'},{content:'Abandoned task',status:'abandoned'},{content:'Pending task',status:'pending',details:'Task details',notes:['Task note']},{content:'Blocked task',status:'blocked',blocker:'Awaiting CI'}]}],
			 entries:[{type:'message',id:'reads',parentId:null,timestamp:'2026-10-02T00:00:00Z',message:{role:'assistant',timestamp:1,model:'native-model',stopReason:'toolUse',content:[{type:'toolCall',id:'read-one',name:'read',arguments:{path:'first.ts'}},{type:'toolCall',id:'read-two',name:'read',arguments:{path:'second.ts'}}]}},
			  {type:'message',id:'result-one',parentId:'reads',timestamp:'2026-10-02T00:00:01Z',message:{role:'toolResult',timestamp:2,toolName:'read',toolCallId:'read-one',content:[{type:'text',text:'First source output'}],isError:false}},
			  {type:'message',id:'result-two',parentId:'result-one',timestamp:'2026-10-02T00:00:02Z',message:{role:'toolResult',timestamp:3,toolName:'read',toolCallId:'read-two',content:[{type:'text',text:'Second source output'}],isError:false}}]})`);
			await ui.wait("document.querySelector('.omp-tool-overview') && document.querySelector('.omp-hud--todo')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud--agents .omp-hud-toggle').getAttribute('aria-expanded')"), "false");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud--todo .omp-hud-toggle').getAttribute('aria-expanded')"), "false");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud--todo .omp-hud-toggle').textContent.includes('2/4')"), true);
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud-rows') === null"), true);
			await ui.evaluate("document.querySelector('.omp-hud--agents .omp-hud-toggle').click();document.querySelector('.omp-hud--todo .omp-hud-toggle').click();document.querySelector('.omp-overview-head').click()");
			await ui.wait("document.querySelectorAll('.omp-overview-member .omp-tool-head').length===2");
			await ui.evaluate("document.querySelectorAll('.omp-overview-member .omp-tool-head').forEach(button=>button.click())");
			await ui.wait("document.querySelector('.omp-hud--agents .omp-hud-rows')?.textContent.includes('Inspecting native source') && document.querySelector('.omp-hud--todo .omp-hud-rows')?.textContent.includes('Pending task') && document.querySelector('.omp-transcript')?.textContent.includes('Second source output')");
			const roster = await ui.evaluate<string>("document.querySelector('.omp-hud--agents .omp-hud-rows').textContent");
			for (const content of ["worker", "implementer", "read · Inspecting native source", "12.3s"]) assert.ok(roster.includes(content), content);
			assert.equal(roster.includes("Implement native UI"), false, "the spawn description is the row's tooltip, not its text");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-hud--agents .omp-hud-agent').title"), /Implement native UI/);
			assert.doesNotMatch(roster, /INTERNAL_|1790907963935|Source|Index|Last update|Parent tool call|Assignment|Native registry|Native progress|Statistics|tokens|\$0\.07|running/);
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud--agents dl, .omp-hud--agents pre, .omp-hud--agents .omp-native-child') === null"), true, "no stats table or inline child transcript in the pinned row");
			const todoRows = await ui.evaluate<string>("document.querySelector('.omp-hud--todo .omp-hud-rows').textContent");
			assert.match(todoRows, /Blocked task.*\(blocked\)/s);
			assert.match(todoRows, /Pending task.*\u207a\u00b9/s, "the TUI's compact note marker");
			assert.doesNotMatch(todoRows, /Task note|Task details|Awaiting CI|Blocker/, "notes, details and blockers are not inline");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-subagent-read').length"), 0, "child reads are lazy");
			await ui.evaluate("document.querySelector('.omp-hud--agents .omp-hud-agent').click()");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:open-detail').at(-1)"), { type: "omp:open-detail", kind: "agent", agentId: "worker" });
			await ui.evaluate("document.querySelector('.omp-hud--todo .omp-hud-open').click()");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:open-detail').at(-1)"), { type: "omp:open-detail", kind: "todo" });
			await ui.evaluate("document.querySelector('.omp-hud--agents .omp-hud-open').click()");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:open-detail').at(-1)"), { type: "omp:open-detail", kind: "agents" });
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-subagent-read').length"), 0, "opening detail tabs is the host's job; the chat page reads no child");
			await ui.evaluate("window.ui.push({agents:[],todoSeed:[],entries:[]})");
			await ui.wait("document.querySelector('.omp-hud--agents') === null && document.querySelector('.omp-hud--todo') === null");
		});

		await t.test("a long agent roster is bounded without a scroll region and task/wait show native content without coordination payloads", async () => {
			await reset("native-compact-agents", "detailed");
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-02T00:00:00Z',message});
			 const taskArgs={tasks:[{name:'ReaderOne',agent:'scout',task:'Inspect source'}]};
			 window.ui.push({agents:Array.from({length:25},(_,index)=>({id:index===0?'ReaderOne':'Reader'+index,index,agent:'scout',agentSource:'INTERNAL_SOURCE',status:'running',lastUpdate:1790907963935,parentToolCallId:index===0?'task-compact':'INTERNAL_PARENT',description:'Inspect source without dumping full assignment',task:index===0?'Inspect source':'INTERNAL_TASK',assignment:index===0?'Inspect source':'INTERNAL_ASSIGNMENT',progress:{id:index===0?'ReaderOne':'Reader'+index,status:'running',currentTool:'read',lastIntent:'Inspecting source',durationMs:12000}})),agentAvailability:'available',
			  entries:[
			   row('call',{role:'assistant',timestamp:1,model:'m',stopReason:'toolUse',content:[{type:'toolCall',id:'task-compact',name:'task',arguments:taskArgs},{type:'toolCall',id:'wait-compact',name:'wait',arguments:{}}]}),
			   row('task',{role:'toolResult',timestamp:2,toolCallId:'task-compact',toolName:'task',isError:false,content:[{type:'text',text:'INTERNAL_MODEL_ACK'}],details:{results:[],async:{state:'running',jobId:'INTERNAL_JOB_ID',type:'task'},totalDurationMs:5}}),
			   row('wait',{role:'toolResult',timestamp:3,toolCallId:'wait-compact',toolName:'wait',isError:false,content:[{type:'text',text:'INTERNAL_WAIT_PAYLOAD'}],details:{jobs:[{id:'ReaderOne',type:'task',status:'completed',label:'Inspect source',durationMs:12000,resultText:'Visible result summary',resolvedModelIdentity:'INTERNAL_MODEL_ID',resolvedModel:'INTERNAL_MODEL',resolvedThinkingLevel:'INTERNAL_THINKING',agentUrlId:'INTERNAL_AGENT_URL'}]}})
			  ]});
			})()`);
			await ui.wait("document.querySelector('[data-tool-name=\"wait\"]')?.textContent.includes('settled')");
			await ui.evaluate("document.querySelector('.omp-hud--agents .omp-hud-toggle').click();document.querySelectorAll('.omp-native-tool .omp-tool-head').forEach(button=>button.click())");
			await ui.wait("document.querySelector('.omp-hud--agents .omp-hud-rows') !== null && document.querySelector('[data-tool-name=\"task\"] .omp-tool-head').getAttribute('aria-expanded') === 'true'");
			const content = await ui.evaluate<string>("document.querySelector('.omp-main').textContent");
			assert.match(content, /ReaderOne/); assert.doesNotMatch(content, /Background task started/); assert.match(content, /Visible result summary/);
			assert.match(await ui.evaluate<string>("document.querySelector('[data-tool-name=\"task\"]').textContent"), /ReaderOne.*running.*read.*Inspecting source/s);
			assert.doesNotMatch(content, /INTERNAL_|resolvedModel|resolvedThinkingLevel|agentUrlId|jobId|totalDurationMs|5ms|1790907963935/);
			assert.equal(await ui.evaluate("document.querySelector('.omp-main dl') === null"), true);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-hud--agents .omp-hud-agent').length"), 8, "at most eight agent rows");
			assert.equal(await ui.evaluate("document.querySelector('.omp-hud--agents .omp-hud-more').textContent"), "+17 more");
			assert.equal(await ui.evaluate("Array.from(document.querySelectorAll('.omp-hud, .omp-hud *')).every(node=>{const style=getComputedStyle(node);return style.overflowY!=='auto'&&style.overflowY!=='scroll'&&node.scrollHeight<=node.clientHeight+1})"), true, "no nested scroll region in the pinned rows");
			await ui.evaluate("document.querySelector('.omp-hud--agents .omp-hud-more').click()");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:open-detail').at(-1)"), { type: "omp:open-detail", kind: "agents" });
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-subagent-read').length"), 0, "opening the roster and tool cards does not read children");
		});

		await t.test("native execution, provider errors and chronological notices render rather than disappearing", async () => {
			await reset("native-messages");
			await ui.evaluate(`window.ui.push({entries:[
			  {type:'message',id:'shell',parentId:null,timestamp:'2026-10-02T00:00:00Z',message:{role:'bashExecution',timestamp:1,command:'echo hello',output:'Shell output',exitCode:0,cancelled:false,truncated:false}},
			  {type:'message',id:'python',parentId:'shell',timestamp:'2026-10-02T00:00:01Z',message:{role:'pythonExecution',timestamp:2,code:'print(1)',output:'Python output',exitCode:1,cancelled:false,truncated:false}},
			  {type:'message',id:'error',parentId:'python',timestamp:'2026-10-02T00:00:02Z',message:{role:'assistant',timestamp:3,model:'native-model',stopReason:'error',content:[],errorMessage:'Provider unavailable'}}
			 ],ephemeral:[{id:'notice',kind:'notice',anchorId:'shell',seq:1,timestamp:1,payload:{level:'warning',source:'Native source',message:'Positioned notice'}},{id:'ttsr',kind:'ttsr_triggered',anchorId:'python',seq:2,timestamp:2,payload:{rules:[{name:'Safety rule'}]}},{id:'command',kind:'command_output',anchorId:'ttsr',seq:3,timestamp:3,payload:{text:'Slash command output'}}]})`);
			await ui.wait("document.querySelector('.omp-transcript')?.textContent.includes('Provider unavailable')");
			const text = await ui.evaluate<string>("document.querySelector('.omp-transcript').textContent");
			assert.ok(text.indexOf("Shell output") < text.indexOf("Positioned notice") && text.indexOf("Positioned notice") < text.indexOf("Python output"));
			assert.ok(text.includes("Safety rule") && text.includes("Slash command output") && text.includes("Provider error"));
		});

		await t.test("model selection sends once and waits for pushed host readback, including mismatched replies", async () => {
			await reset("model");
			assert.equal(await ui.evaluate("window.ui.last().picker"), undefined);
			await ui.evaluate("document.querySelector('.omp-footer-trigger').click()");
			await ui.wait("window.ui.last().picker === 'model'");
			await ui.evaluate("window.ui.reply(window.ui.last(), {selectedModel:window.ui.next})");
			await ui.wait("window.ui.last().action === 'set-model'");
			const request = await ui.evaluate<{ model: { provider: string; id: string }; actionSeq: string }>("window.ui.last()");
			assert.equal(request.model.provider, "two"); assert.equal(request.model.id, "new"); assert.match(request.actionSeq, /^\d+$/);
			assert.equal(await ui.evaluate("document.querySelector('.omp-footer-trigger-label').textContent===window.ui.original.name && document.querySelector('.omp-footer-trigger .codicon-loading')!==null"), true, "the original model remains visible while the host request is pending");
			await ui.evaluate("window.ui.reply({...window.ui.last(),requestId:window.ui.last().requestId-1});window.ui.reply({...window.ui.last(),scope:crypto.randomUUID()})");
			assert.equal(await ui.evaluate("document.querySelector('.omp-footer-trigger').disabled"), true);
			await ui.evaluate("window.ui.receive({type:'omp:control-invalidate'})");
			assert.equal(await ui.evaluate("window.ui.requests().filter(request=>request.action==='set-model').length"), 1);
			await ui.evaluate("window.ui.push({state:{...window.ui.current().state,model:window.ui.next}});window.ui.reply()");
			await ui.wait("document.querySelector('.omp-footer-trigger').textContent.startsWith('Next')");
			await ui.wait("window.ui.last().action === 'snapshot'");
			assert.equal(await ui.evaluate("window.ui.last().picker"), undefined);
			await ui.evaluate("window.ui.reply()");
			await ui.wait("!document.querySelector('.omp-footer-trigger').disabled");
		});

		await t.test("thinking is host-listed, non-optimistic and can read back a clamped level", async () => {
			await reset("level");
			await ui.evaluate("document.querySelectorAll('.omp-footer-trigger')[1].click()");
			await ui.wait("window.ui.last().picker === 'thinking'");
			await ui.evaluate("window.ui.reply(window.ui.last(), {selectedThinking:'high'})");
			await ui.wait("window.ui.last().action === 'set-thinking'");
			assert.equal(await ui.evaluate("window.ui.last().level"), "high");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-footer-trigger')[1].querySelector('.omp-footer-trigger-label').textContent===window.ui.current().state.thinkingLevel && document.querySelectorAll('.omp-footer-trigger')[1].querySelector('.codicon-loading')!==null"), true, "thinking stays non-optimistic while a mutation is pending");
			await ui.evaluate("window.ui.reply({ ...window.ui.last() }, { thinkingLevel:'high' })");
			await ui.wait("!document.querySelectorAll('.omp-footer-trigger')[1].disabled");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-footer-trigger')[1].textContent.trim()"), "low");
			await ui.evaluate("window.ui.push({state:{...window.ui.current().state,thinkingLevel:'high'}})");
			await ui.wait("document.querySelectorAll('.omp-footer-trigger')[1].textContent.trim() === 'high'");
		});

		await t.test("timeouts and refusals are transient, preserve readback and never replay a mutation", async () => {
			await reset("outcome");
			await ui.evaluate("document.querySelectorAll('.omp-footer-trigger')[1].click()");
			await ui.wait("window.ui.last().picker === 'thinking'");
			await ui.evaluate("window.ui.reply(window.ui.last(), {selectedThinking:'high'})");
			await ui.wait("document.querySelectorAll('.omp-footer-trigger')[1].disabled && window.ui.last().action === 'set-thinking'");
			await ui.evaluate("window.fixtureClock.fire(35000)");
			await ui.wait("document.querySelector('.omp-footer-feedback')");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-footer-trigger')[1].disabled"), true);
			await ui.evaluate("window.fixtureClock.fire(6000)");
			await ui.wait("!document.querySelector('.omp-footer-feedback')");
			assert.equal(await ui.evaluate("window.ui.requests().filter(request=>request.action==='set-thinking').length"), 1);
			await ui.evaluate("window.ui.reply(window.ui.last(),{notice:'The host rejected the change.'})");
			await ui.wait("document.querySelector('.omp-footer-feedback > span')?.textContent === 'The host rejected the change.'");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-footer-trigger')[1].textContent.trim()"), "low");
			await ui.evaluate("window.fixtureClock.fire(6000)");
			await ui.wait("!document.querySelector('.omp-footer-feedback')");
			await ui.wait("!document.querySelectorAll('.omp-footer-trigger')[1].disabled");
		});

		await t.test("native picker cancellation sends no mutation and remains available after a long open", async () => {
			await reset("dismiss");
			await ui.evaluate("document.querySelector('.omp-footer-trigger').click()");
			await ui.wait("window.ui.last().picker === 'model'");
			await ui.evaluate("window.fixtureClock.fire(35000)");
			assert.equal(await ui.evaluate("document.querySelector('.omp-footer-feedback')"), null);
			assert.equal(await ui.evaluate("document.querySelector('.omp-footer-trigger').disabled"), true);
			await ui.evaluate("window.ui.reply()");
			await ui.wait("!document.querySelector('.omp-footer-trigger').disabled");
			assert.equal(await ui.evaluate("window.ui.requests().filter(request=>request.action!=='snapshot').length"), 0);
		});

		await t.test("route replacement cancels a native picker and cannot apply its late choice", async () => {
			await reset("route");
			await ui.evaluate("document.querySelector('.omp-footer-trigger').click();window.oldPick=window.ui.last()");
			await ui.wait("window.ui.last().picker === 'model'");
			await ui.evaluate("window.ui.receive({type:'omp:route-offer',hostGeneration:'a'.repeat(32),documentId:'b'.repeat(32),routeGeneration:'c'.repeat(32),status:'ready'})");
			await ui.wait("window.ui.last().picker === undefined");
			await ui.evaluate("window.ui.reply(window.oldPick,{selectedModel:window.ui.next});window.ui.reply()");
			await ui.wait("!document.querySelector('.omp-footer-trigger').disabled");
			assert.equal(await ui.evaluate("window.ui.requests().filter(request=>request.action==='set-model').length"), 0);
		});

		await t.test("thinking selection for an overtaken model never writes to the new model", async () => {
			await reset("thinking-race");
			await ui.evaluate("document.querySelectorAll('.omp-footer-trigger')[1].click()");
			await ui.wait("window.ui.last().picker === 'thinking'");
			await ui.evaluate("window.ui.push({state:{...window.ui.current().state,model:window.ui.next}});window.ui.reply(window.ui.last(),{model:window.ui.original,selectedThinking:'high'})");
			await ui.wait("!document.querySelector('.omp-footer-trigger').disabled");
			assert.equal(await ui.evaluate("window.ui.requests().filter(request=>request.action==='set-thinking').length"), 0);
		});

		await t.test("context popover shows only current-provider quotas, account resets and authoritative cost", async () => {
			await reset("metadata");
			await ui.evaluate("window.fixtureClock.setNow(2000000000000-8040000)");
			await ui.evaluate(`window.ui.receive({type:'omp:footer-metadata',provider:'one',branch:'main',sessionCost:12.345,
			 windows:[{label:'5h',usedPercent:42,resetsAt:2000000000000},{label:'7d',usedPercent:18,resetsAt:null}],
			 accounts:[{label:'first*',windows:[{label:'5h',usedPercent:42,resetsAt:2000000000000}]},{label:'second*',windows:[{label:'7d',usedPercent:18,resetsAt:null}]}],
			 accountSelection:'Active account unavailable: showing the first provider report in OMP CLI order.'})`);
			await ui.evaluate("document.querySelector('.omp-context-trigger').focus()");
			await ui.wait("document.querySelector('.omp-context-quota')?.textContent==='5h · 42% used · resets in 2h 14m'");
			const tooltip = await ui.evaluate<string>("document.querySelector('.omp-context-quota').title");
			assert.match(tooltip, /first\*/); assert.match(tooltip, /second\*/); assert.match(tooltip, /resets/);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-context-quota')[1].textContent"), "7d · 18% used");
			assert.equal(await ui.evaluate("document.querySelector('.omp-context-quota').title.includes(new Date(2000000000000).toLocaleString())"), true);
			assert.equal(await ui.evaluate("document.querySelector('.omp-context-quota').getAttribute('aria-label').includes(new Date(2000000000000).toLocaleString())"), true);
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer-toolbar .omp-composer-branch').textContent.trim()"), "main");
			assert.equal(await ui.evaluate("document.querySelector('.omp-context-cost').textContent"), "Session cost $12.35");
			assert.equal(await ui.evaluate("document.querySelector('.omp-context-trigger').getAttribute('aria-label')"), "Context window 4% used");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-context-popover').textContent"), /40\.7k \/ 1M tokens/);
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer-state')"), null, "metadata is not duplicated in state chips");
			await ui.evaluate("window.ui.receive({type:'omp:footer-metadata',provider:'one',branch:'main',sessionCost:0,windows:[{label:'5h',usedPercent:42,resetsAt:null},{label:'7d',usedPercent:18,resetsAt:null}],accounts:[],accountSelection:null})");
			await ui.wait("!document.querySelector('.omp-context-cost')");
			await ui.evaluate("window.ui.push({state:{...window.ui.current().state,contextUsage:{tokens:40700,contextWindow:1000000,percent:null}}})");
			await ui.wait("document.querySelector('.omp-context-trigger').getAttribute('aria-label')==='Context window usage unavailable'");
			assert.equal(await ui.evaluate("document.querySelector('.omp-context-progress')"), null, "unknown percentage is not estimated from known token counts");
			await ui.evaluate("window.ui.push({state:{...window.ui.current().state,model:window.ui.next}})");
			await ui.wait("!document.querySelector('.omp-context-quota')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer-toolbar .omp-composer-branch').textContent.trim()"), "main");
		});
		await t.test("open quota countdown ticks each minute, marks expiry and takes fresh authoritative resets", async () => {
			await reset("quota-countdown");
			await ui.evaluate(`window.fixtureClock.setNow(1800000000000);
			 window.ui.receive({type:'omp:footer-metadata',provider:'one',branch:null,windows:[{label:'5h',usedPercent:7,resetsAt:1800008040000}],accounts:[],accountSelection:null});
			 document.querySelector('.omp-context-trigger').focus()`);
			await ui.wait("document.querySelector('.omp-context-quota')?.textContent==='5h · 7% used · resets in 2h 14m'");
			await ui.evaluate("window.fixtureClock.setNow(1800000060000);window.fixtureClock.fire(60000)");
			await ui.wait("document.querySelector('.omp-context-quota')?.textContent==='5h · 7% used · resets in 2h 13m'");
			await ui.evaluate("window.fixtureClock.setNow(1800008040001);window.fixtureClock.fire(60000)");
			await ui.wait("document.querySelector('.omp-context-quota')?.textContent==='5h · 7% used · resets now / refreshing'");
			await ui.evaluate("window.ui.receive({type:'omp:footer-metadata',provider:'one',branch:null,windows:[{label:'7d',usedPercent:42,resetsAt:1800285240001}],accounts:[],accountSelection:null})");
			await ui.wait("document.querySelector('.omp-context-quota')?.textContent==='7d · 42% used · resets in 3d 5h'");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await ui.wait("!document.querySelector('.omp-context-popover')");
			await ui.evaluate("document.querySelector('textarea').focus();window.fixtureClock.setNow(1800285240002);window.fixtureClock.fire(60000);document.querySelector('.omp-context-trigger').focus()");
			await ui.wait("document.querySelector('.omp-context-quota')?.textContent==='7d · 42% used · resets now / refreshing'");
		});
		await t.test("context hover and keyboard Escape preserve focus and never stop a working turn", async () => {
			await reset("context-escape");
			await ui.evaluate("window.ui.push({working:true});document.querySelector('textarea').focus()");
			await ui.wait("document.querySelector('[aria-label=\"Stop the running turn\"]')");
			const point = await ui.evaluate<{ x: number; y: number }>("(()=>{const rect=document.querySelector('.omp-context-trigger').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()");
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
			await ui.wait("document.querySelector('.omp-context-popover')");
			const popover = await ui.evaluate<{ x: number; y: number }>("(()=>{const rect=document.querySelector('.omp-context-popover').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.bottom-2}})()");
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y - 18 });
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...popover });
			assert.ok(await ui.evaluate("Boolean(document.querySelector('.omp-context-popover'))"), "hover remains stable across the trigger/popover gap");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await ui.wait("!document.querySelector('.omp-context-popover')");
			assert.equal(await ui.evaluate("document.activeElement===document.querySelector('textarea')"), true);
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
			await ui.evaluate("document.querySelector('.omp-context-trigger').focus()");
			await ui.wait("document.querySelector('.omp-context-trigger').getAttribute('aria-expanded')==='true'");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await ui.wait("!document.querySelector('.omp-context-popover')");
			assert.equal(await ui.evaluate("document.activeElement===document.querySelector('.omp-context-trigger')"), true);
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-abort').length"), 0);
			await ui.evaluate("document.querySelector('textarea').focus()");
		});

		await t.test("read-only and unavailable controls cannot mutate and explain why", async () => {
			await reset("gates");
			await ui.evaluate("window.ui.reply(window.ui.last(),{mutationMode:'unavailable'})");
			await ui.wait("document.querySelector('.omp-footer-trigger').disabled");
			assert.equal(await ui.evaluate("document.querySelector('.omp-footer-trigger').title"), "The host cannot apply changes.");
			await ui.evaluate("window.ui.reply()");
			await ui.wait("!document.querySelector('.omp-footer-trigger').disabled");
			await ui.evaluate("window.ui.push({readOnlyReason:'Another editor controls this session'})");
			await ui.wait("document.querySelector('.omp-footer-trigger').disabled");
			assert.equal(await ui.evaluate("document.querySelector('.omp-footer-trigger').title"), "Another editor controls this session");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-notice').length"), 1, "read-only reason appears once in the banner");
			await ui.evaluate("document.querySelector('.omp-footer-trigger').click()");
			assert.equal(await ui.evaluate("window.ui.last().picker"), undefined);
			await ui.evaluate("window.ui.push({phase:'stopped',readOnlyReason:'The session is stopped'})");
			await ui.wait("document.querySelector('.omp-notice .codicon-debug-stop') && document.querySelector('.omp-composer button').disabled");
			await ui.evaluate("window.ui.push({phase:'starting',readOnlyReason:null})");
			await ui.wait("document.querySelector('.omp-notice .codicon-debug-start')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer-state')"), null);
		});

		await t.test("the Tools chip and the branch live in one composer toolbar row, with no top-right Tools control, and the chip asks the host to open its native picker", async () => {
			await reset("tools-in-composer");
			await ui.evaluate("window.ui.receive({type:'omp:footer-metadata',provider:'one',branch:'layout-branch',windows:[],accounts:[],accountSelection:null})");
			await ui.wait("document.querySelector('.omp-composer-branch')");
			assert.deepEqual(await ui.evaluate(`(()=>{
			 const toolbar=document.querySelector('.omp-composer-toolbar'),tools=document.querySelectorAll('.omp-tools-trigger'),pickers=[...toolbar.querySelectorAll('.omp-footer-trigger')],attach=toolbar.querySelector('.omp-composer-attach').getBoundingClientRect(),
			  centers=[...toolbar.querySelectorAll('.omp-composer-attach,.omp-footer-trigger,.omp-tools-trigger,.omp-composer-branch,.omp-context-trigger,.omp-btn--primary')].filter(node=>node.getBoundingClientRect().width>0).map(node=>{const rect=node.getBoundingClientRect();return rect.top+rect.height/2}),size=tools[0].getBoundingClientRect();
			 return {composerToolbars:document.querySelectorAll('.omp-composer-toolbar').length,metadataRows:document.querySelectorAll('.omp-composer-metadata').length,chrome:document.querySelectorAll('.omp-chat-chrome,.omp-tools-menu,.omp-tools-options').length,
			  tools:tools.length,toolsInToolbar:toolbar.contains(tools[0]),branchInToolbar:toolbar.contains(document.querySelector('.omp-composer-branch')),
			  order:[...toolbar.querySelectorAll('.omp-composer-attach,.omp-footer-trigger,.omp-tools-trigger,.omp-composer-branch')].map(node=>node.className.includes('tools')?'tools':node.className.includes('branch')?'branch':node.className.includes('attach')?'attach':'picker').join(),
			  pickers:pickers.length,iconButton:tools[0].classList.contains('omp-btn')&&!tools[0].classList.contains('omp-chip')&&size.width===28&&size.height===28&&size.width===attach.width&&size.height===attach.height,oneRow:Math.max(...centers)-Math.min(...centers)<10};})()`),
				{ composerToolbars: 1, metadataRows: 0, chrome: 0, tools: 1, toolsInToolbar: true, branchInToolbar: true, order: "picker,picker,tools,branch,attach", pickers: 2, iconButton: true, oneRow: true });
			assert.equal(await ui.evaluate("document.querySelector('.omp-tools-trigger').hasAttribute('aria-expanded')"), false);
			// The chip names the live choice, and its accessible name follows the setting from either owner.
			const chip = () => ui.evaluate<{ text: string; name: string; title: string; icon: boolean }>("(()=>{const chip=document.querySelector('.omp-tools-trigger');return{text:chip.textContent.trim(),name:chip.getAttribute('aria-label'),title:chip.title,icon:chip.querySelector('.codicon-tools')!==null}})()");
			assert.deepEqual(await chip(), { text: "", name: "Tools output: Overview", title: "Tools output: Overview", icon: true });
			await ui.evaluate("window.ui.density('detailed')");
			await ui.wait("document.querySelector('.omp-tools-trigger').getAttribute('aria-label')==='Tools output: Detailed'");
			assert.deepEqual(await chip(), { text: "", name: "Tools output: Detailed", title: "Tools output: Detailed", icon: true });
			await ui.evaluate("window.ui.density('overview')");
			await ui.wait("document.querySelector('.omp-tools-trigger').getAttribute('aria-label')==='Tools output: Overview'");
			// The chip opens no in-page popover: one click is one request that asks the host for its native picker, and the page
			// never names the value (the host writes the setting from its own pick and pushes the readback).
			await ui.evaluate("window.sent.length=0;document.querySelector('.omp-tools-trigger').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-tool-detail')");
			const asks = await ui.evaluate<Record<string, unknown>[]>("window.sent.filter(message=>message.type==='omp:chat-tool-detail')");
			assert.equal(asks.length, 1);
			assert.deepEqual(Object.keys(asks[0]!).sort(), ["epoch", "requestId", "type"]);
			assert.equal(await ui.evaluate("document.querySelector('.omp-tools-options,[role=radiogroup],input[type=radio]')"), null, "no custom popover appears");
			assert.equal(await ui.evaluate("document.querySelector('.omp-tools-trigger').hasAttribute('aria-expanded')"), false);
			assert.equal((await chip()).name, "Tools output: Overview", "the chip changes only when the host pushes the new setting");
			await ui.evaluate("window.ui.density('detailed')");
			await ui.wait("document.querySelector('.omp-tools-trigger').getAttribute('aria-label')==='Tools output: Detailed'");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("composer controls stay contained while branch and secondary controls give way before the model and thinking pickers", async () => {
			await reset("layout");
			await ui.evaluate("window.ui.receive({type:'omp:draft-restore',requestId:1889,text:'first\\nsecond\\nthird',attachments:0,recoverable:[]})");
			await ui.evaluate("window.ui.receive({type:'omp:footer-metadata',provider:'one',branch:'layout-branch',windows:[],accounts:[],accountSelection:null})");
			await ui.evaluate("window.ui.push({state:{...window.ui.current().state,model:{...window.ui.current().state.model,name:'A long model name that remains selectable'}}})");
			await ui.wait("document.querySelector('textarea').getBoundingClientRect().height > 60");
			for (const busy of [false, true]) {
				await ui.evaluate(`window.ui.push({working:${busy},state:{...window.ui.current().state,queuedMessageCount:${busy ? 3 : 0}}})`);
				for (const width of [1000, 760, 590, 460, 300, 240, 160]) {
					await ui.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
					await ui.settleGeometry(".omp-composer");
					const layout = await ui.evaluate<{ overflow: boolean; contained: boolean; ordered: boolean; queued: boolean; spread: number; branch: boolean; tools: number }>(`(() => {
					 const card=document.querySelector('.omp-composer').getBoundingClientRect(),input=document.querySelector('textarea').getBoundingClientRect(),
					  toolbar=document.querySelector('.omp-composer-toolbar'),bar=toolbar.getBoundingClientRect(),
					  shown=node=>node!==null&&node.getBoundingClientRect().width>0,
					  controls=[...toolbar.querySelectorAll('button,.omp-chip,.omp-composer-branch')].filter(node=>node.getBoundingClientRect().width>2).map(node=>node.getBoundingClientRect()),
					  centers=controls.map(rect=>rect.top+rect.height/2);
					 return {overflow:document.documentElement.scrollWidth>innerWidth,
					  contained:controls.every(rect=>rect.left>=card.left&&rect.right<=card.right&&rect.top>=card.top&&rect.bottom<=card.bottom),
					  ordered:input.bottom<=bar.top,spread:Math.max(...centers)-Math.min(...centers),
					  branch:shown(document.querySelector('.omp-composer-branch')),tools:document.querySelector('.omp-tools-trigger').getBoundingClientRect().width,
					  queued:document.querySelector('.omp-state-queued')!==null}; })()`);
					const where = `${width}px busy=${busy}`;
					assert.equal(layout.overflow, false, where);
					assert.equal(layout.contained, true, `${where}: every control remains inside the rounded card`);
					assert.equal(layout.ordered, true, `${where}: the multiline input sits above the toolbar`);
					assert.equal(layout.queued, false, "queued messages are not repeated in the toolbar");
					assert.equal(layout.branch, width > 860, `${where}: the branch is the first thing to collapse`);
					assert.equal(layout.tools, width > 590 ? 28 : 0, `${where}: secondary Tools gives way after the branch`);
					assert.equal(await ui.evaluate("[...document.querySelectorAll('.omp-footer-trigger')].every(node=>getComputedStyle(node).flexShrink==='0' && parseFloat(getComputedStyle(node).minWidth)>0)"), true, "pickers keep a non-shrinking minimum");
					assert.equal(await ui.evaluate("document.querySelector('.omp-footer-trigger .codicon-chevron-down').getAttribute('aria-hidden')"), "true");
					if (busy) {
						assert.equal(await ui.evaluate("document.querySelector('[aria-keyshortcuts=\"Alt+Enter\"] .codicon-list-ordered')!==null"), true, "follow-up has a distinct queue icon");
						assert.equal(await ui.evaluate("document.querySelector('[aria-keyshortcuts=\"Enter\"] .codicon-send')!==null"), true);
					}
					if (width > 380) assert.ok(layout.spread < 10, `${where}: controls fit in one row`);
					if (process.env.OMP_UI_SCREENSHOT_DIR && width >= 240) {
						const image = await ui.call("Page.captureScreenshot", { format: "png" });
						assert.equal(typeof image.data, "string");
						await mkdir(process.env.OMP_UI_SCREENSHOT_DIR, { recursive: true });
						await writeFile(join(process.env.OMP_UI_SCREENSHOT_DIR, `composer-${width}-${busy ? "busy" : "idle"}.png`), Buffer.from(String(image.data), "base64"));
					}
					await ui.evaluate("document.querySelector('.omp-context-trigger').focus()");
					await ui.wait("document.querySelector('.omp-context-popover')");
					const popover = await ui.evaluate<{ left: number; right: number; overflow: boolean }>("(()=>{const rect=document.querySelector('.omp-context-popover').getBoundingClientRect();return{left:rect.left,right:rect.right,overflow:document.documentElement.scrollWidth>innerWidth}})()");
					assert.ok(popover.left >= 0 && popover.right <= width && !popover.overflow, `popover fits ${where}`);
					await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
					await ui.wait("!document.querySelector('.omp-context-popover')");
					await ui.evaluate("document.querySelector('textarea').focus()");
				}
			}
			await ui.call("Emulation.clearDeviceMetricsOverride");
		});

		await t.test("composer text is inset inside a padded focus frame that autosizes and caps, in the prompt and the ask variant", async () => {
			await reset("composer-padding");
			await ui.call("Emulation.setFocusEmulationEnabled", { enabled: true });
			await ui.evaluate("document.documentElement.style.setProperty('--vscode-focusBorder','#007fd4');document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "Padded text" });
			await ui.wait("document.querySelector('.omp-composer textarea').value==='Padded text'");
			const frame = await ui.evaluate<{ pl: number; pr: number; pt: number; pb: number; outline: string; offset: number; height: number; left: number; top: number; toolbarGap: number }>(`(()=>{
			 const ta=document.querySelector('.omp-composer textarea'),card=document.querySelector('.omp-composer').getBoundingClientRect(),box=ta.getBoundingClientRect(),s=getComputedStyle(ta),toolbar=document.querySelector('.omp-composer-toolbar').getBoundingClientRect();
			 return {pl:parseFloat(s.paddingLeft),pr:parseFloat(s.paddingRight),pt:parseFloat(s.paddingTop),pb:parseFloat(s.paddingBottom),outline:s.outlineStyle+' '+s.outlineWidth,offset:parseFloat(s.outlineOffset),height:box.height,
			  left:box.left-card.left,top:box.top-card.top,toolbarGap:toolbar.top-box.bottom};})()`);
			assert.ok(frame.pl >= 10 && frame.pl <= 12 && frame.pr >= 10 && frame.pr <= 12, `horizontal padding ${frame.pl}/${frame.pr}`);
			assert.ok(frame.pt >= 8 && frame.pt <= 10 && frame.pb >= 8 && frame.pb <= 10, `vertical padding ${frame.pt}/${frame.pb}`);
			assert.equal(frame.outline, "solid 1px", "the focus ring is drawn on the padded textarea");
			assert.ok(frame.offset <= 0, "and stays inside its border box, so it wraps the padding rather than the glyphs");
			assert.ok(frame.left > 0 && frame.top > 0, "the frame sits inside the rounded card");
			assert.equal(frame.height, 2 * 20 + frame.pt + frame.pb, "a short draft autosizes to the two-line minimum plus padding");
			assert.ok(frame.toolbarGap >= 0, "the actions row stays below the input");
			await ui.evaluate(`window.ui.receive({type:'omp:draft-restore',requestId:1958,text:${JSON.stringify(Array.from({ length: 14 }, (_, index) => `line ${index}`).join("\n"))},attachments:0,recoverable:[]})`);
			await ui.wait("document.querySelector('.omp-composer textarea').getBoundingClientRect().height > 100");
			const capped = await ui.evaluate<{ height: number; overflowY: string }>("(()=>{const ta=document.querySelector('.omp-composer textarea'),s=getComputedStyle(ta);return{height:ta.getBoundingClientRect().height,overflowY:s.overflowY}})()");
			assert.equal(capped.height, 8 * 20 + 20, "growth stops at eight lines plus padding");
			assert.equal(capped.overflowY, "auto", "longer drafts scroll inside the textarea");
			await ui.evaluate("window.ui.push({uiRequests:[{id:'pad-ask',method:'input',title:'Name?',placeholder:'type here'}]})");
			await ui.wait("document.querySelector('.omp-ask textarea')");
			const ask = await ui.evaluate<{ pl: number; pt: number; height: number }>("(()=>{const ta=document.querySelector('.omp-ask textarea'),s=getComputedStyle(ta);return{pl:parseFloat(s.paddingLeft),pt:parseFloat(s.paddingTop),height:ta.getBoundingClientRect().height}})()");
			assert.ok(ask.pl >= 10 && ask.pt >= 8, `ask editor padding ${ask.pl}/${ask.pt}`);
			assert.equal(ask.height, 20 + 2 * ask.pt + 2, "the bordered ask editor autosizes to line, padding and border");
			await ui.call("Emulation.setFocusEmulationEnabled", { enabled: false });
		});

		await t.test("a stopped or view-only session says plainly that it is not running, in a composer tall enough for two lines; other read-only reasons keep the host's text", async () => {
			await reset("stopped-placeholder");
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
			const host = "The session file exists and no live owner was proven. This session's launcher intent is stopped, so nothing was started or attached; choose Open to run it.";
			const probe = "(()=>{const ta=document.querySelector('.omp-composer textarea'),s=getComputedStyle(ta);return{placeholder:ta.placeholder,height:ta.getBoundingClientRect().height,min:2*parseFloat(s.lineHeight)+parseFloat(s.paddingTop)+parseFloat(s.paddingBottom),toolbar:document.querySelector('.omp-composer-toolbar').getBoundingClientRect().height}})()";
			const idle = await ui.evaluate<{ height: number; min: number; toolbar: number }>(probe);
			assert.equal(idle.height, idle.min, "an empty live composer is two lines tall");
			for (const phase of ["stopped", "view-only"]) {
				await ui.evaluate(`window.ui.push({phase:'${phase}',readOnlyReason:${JSON.stringify(host)}})`);
				await ui.wait("document.querySelector('.omp-composer textarea').placeholder.startsWith('This session is not running')");
				const shown = await ui.evaluate<{ placeholder: string; height: number; min: number; toolbar: number }>(probe);
				assert.equal(shown.placeholder, "This session is not running. Resume it to send a message.", phase);
				assert.equal(shown.height, shown.min, `${phase}: the composer keeps its two-line minimum`);
				assert.equal(shown.toolbar, idle.toolbar, `${phase}: the toolbar row keeps its height`);
			}
			await ui.evaluate("window.ui.push({phase:'live',readOnlyReason:'Another editor controls this session'})");
			await ui.wait("document.querySelector('.omp-composer textarea').placeholder==='Another editor controls this session'");
			await ui.call("Emulation.clearDeviceMetricsOverride");
		});

		await t.test("ask transitions retain host controls, metadata and command feedback inside the same dock", async () => {
			await reset("ask-dock");
			await ui.evaluate(`window.ui.receive({type:'omp:footer-metadata',provider:'one',branch:'dock-branch',windows:[],accounts:[],accountSelection:null});
			 window.ui.push({uiRequests:[{id:'dock-ask',method:'confirm',title:'Continue?',message:'Continue with this action?'}]});
			 window.ui.receive({type:'omp:chat-event',epoch:window.ui.current().epoch,frame:{type:'command_feedback',message:'Native command feedback'}})`);
			await ui.wait("document.querySelector('.omp-ask') && document.querySelector('.omp-footer-feedback')");
			assert.deepEqual(await ui.evaluate(`(()=>{
			 const card=document.querySelector('.omp-composer'),ask=card.querySelector('.omp-ask').getBoundingClientRect(),toolbar=card.querySelector('.omp-composer-toolbar').getBoundingClientRect();
			 return {branch:card.querySelector('.omp-composer-toolbar .omp-composer-branch').textContent.trim(),
			  controls:card.querySelectorAll('.omp-footer-trigger:not(.omp-tools-trigger)').length,enabled:!card.querySelector('.omp-footer-trigger').disabled,
			  afterAsk:toolbar.top>=ask.bottom,feedback:card.querySelector('.omp-footer-feedback > span').textContent,
			  dismiss:card.querySelector('.omp-footer-feedback button')?.getAttribute('aria-label')!==null};})()`),
				{ branch: "dock-branch", controls: 2, enabled: true, afterAsk: true, feedback: "Native command feedback", dismiss: true });
			await ui.evaluate("window.ui.push({uiRequests:[]})");
			await ui.wait("!document.querySelector('.omp-ask') && document.querySelector('.omp-composer-attach')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer .omp-composer-branch').textContent.trim()"), "dock-branch");
			assert.equal(await ui.evaluate("window.ui.requests().length"), 1, "switching to/from an ask does not discard host control readback");
			await ui.evaluate("window.fixtureClock.fire(6000);window.fixtureClock.fire(45000)");
			assert.equal(await ui.evaluate("document.querySelector('.omp-footer-feedback > span').textContent"), "Native command feedback", "native feedback stays until acknowledged");
			await ui.evaluate("document.querySelector('.omp-footer-feedback button').click()");
			await ui.wait("!document.querySelector('.omp-footer-feedback')");
		});
		for (const surface of ["chat", "shell"]) await t.test(`OSC 8 and validated plain file clicks carry editor positions, and OSC 8 web links open like Chat web links, in the ${surface} terminal`, async () => {
			await reset(`file-links-${surface}`);
			await ui.evaluate("window.ui.view({mode:'terminal'})");
			await ui.wait("document.querySelector('.xterm') && window.sent.some(message=>message.type==='omp:terminal-attach')");
			const output = "src/proof.ts:12:4\r\n\u001b]8;;vscode://file/D:/repo/proof.ts:23:7\u001b\\OMP file\u001b]8;;\u001b\\\r\nabsent.ts:2\r\n\u001b]8;;https://example.com/docs\u001b\\OMP docs\u001b]8;;\u001b\\\r\n";
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'0123456789abcdef0123456789abcdef',seq:0,phase:'attached',input:true,cols:80,rows:24,snapshot:'follows'});
			 window.ui.receive({type:'omp:terminal-snapshot',generation:'0123456789abcdef0123456789abcdef',seq:0,bytes:btoa(${JSON.stringify(output)})})`);
			await ui.wait("document.querySelector('.xterm-rows')?.textContent.includes('absent.ts')");
			await ui.settleGeometry(".omp-terminal-host, .xterm-rows > div");
			const points = await ui.evaluate<Array<{ x: number; y: number }>>(`Array.from(document.querySelectorAll('.xterm-rows > div')).slice(0,4).map(row=>{
			 const rect=row.querySelector('span').getBoundingClientRect();return {x:rect.left+20,y:rect.top+rect.height/2};})`);
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...points[0] });
			await ui.wait("window.sent.some(message=>message.type==='omp:terminal-link-validate' && message.target==='src/proof.ts:12:4')");
			await ui.evaluate(`window.sent.filter(message=>message.type==='omp:terminal-link-validate').forEach(message=>
			 window.ui.receive({type:'omp:terminal-link-validation',requestId:message.requestId,valid:message.target==='src/proof.ts:12:4'}))`);
			await ui.wait("document.querySelector('.omp-terminal-host').title.includes('Click to open src/proof.ts:12:4')");
			assert.equal(await ui.evaluate(`getComputedStyle(document.elementFromPoint(${points[0]!.x},${points[0]!.y})).cursor`), "pointer");
			assert.ok(await ui.evaluate<boolean>("Array.from(document.querySelectorAll('.xterm-rows span')).some(span=>span.style.textDecoration.includes('underline') && span.textContent.includes('src/proof.ts'))"));
			for (const point of points.slice(0, 2)) {
				await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
				await ui.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
				await ui.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
			}
			await ui.wait("window.sent.filter(message=>message.type==='omp:terminal-link-open').length===2");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:terminal-link-open').map(message=>message.target)"), [
				"src/proof.ts:12:4", "vscode://file/D:/repo/proof.ts:23:7",
			]);
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...points[2] });
			await ui.wait("window.sent.some(message=>message.type==='omp:terminal-link-validate' && message.target==='absent.ts:2')");
			await ui.evaluate(`window.sent.filter(message=>message.type==='omp:terminal-link-validate' && message.target==='absent.ts:2').forEach(message=>
			 window.ui.receive({type:'omp:terminal-link-validation',requestId:message.requestId,valid:false}))`);
			await ui.call("Input.dispatchMouseEvent", { type: "mousePressed", ...points[2], button: "left", clickCount: 1 });
			await ui.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...points[2], button: "left", clickCount: 1 });
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:terminal-link-open').length"), 2);
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...points[3] });
			await ui.wait("document.querySelector('.omp-terminal-host').title === 'https://example.com/docs\\nOpen in editor · Ctrl+Click to open in browser'");
			for (const modifiers of [0, 2]) {
				await ui.call("Input.dispatchMouseEvent", { type: "mousePressed", ...points[3], button: "left", clickCount: 1, modifiers });
				await ui.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...points[3], button: "left", clickCount: 1, modifiers });
			}
			await ui.wait("window.sent.filter(message=>message.type==='omp:terminal-link-open').length===4");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:terminal-link-open').slice(2).map(({target,mode})=>({target,mode}))"), [
				{ target: "https://example.com/docs", mode: "editor" }, { target: "https://example.com/docs", mode: "external" },
			], "a plain click asks for an editor tab, Ctrl+Click for the browser");
		});

		await t.test("a hovered backslash path in inline code keeps a stable pointer and validates once while the TUI repaints, then opens on click", async () => {
			await reset("file-links-stability");
			await ui.evaluate("window.ui.view({mode:'terminal'})");
			await ui.wait("document.querySelector('.xterm') && window.sent.some(message=>message.type==='omp:terminal-attach')");
			const target = "D:\\Workfiles\\repo\\docs\\img\\subagent-icon-options.png";
			const output = `header\r\n\r\nAssistant: the image is at \u001b[36m\`${target}\`\u001b[39m for review.\r\nSecond line, no path here.\r\n`;
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'0123456789abcdef0123456789abcdef',seq:0,phase:'attached',input:true,cols:120,rows:24,snapshot:'follows'});
			 window.ui.receive({type:'omp:terminal-snapshot',generation:'0123456789abcdef0123456789abcdef',seq:0,bytes:btoa(${JSON.stringify(output)})})`);
			await ui.wait("document.querySelector('.xterm-rows')?.textContent.includes('for review')");
			await ui.settleGeometry(".omp-terminal-host, .xterm-rows > div");
			// A fake host that answers after a realistic round trip, plus a TUI that repaints a status row continuously.
			await ui.evaluate(`(() => {
			 const answered = new Set();
			 setInterval(() => { for (const message of window.sent) {
			  if (message.type !== 'omp:terminal-link-validate' || answered.has(message.requestId)) continue;
			  answered.add(message.requestId);
			  setTimeout(() => window.ui.receive({type:'omp:terminal-link-validation',requestId:message.requestId,valid:message.target.endsWith('.png')}), 25);
			 } }, 5);
			 let seq = 0;
			 setInterval(() => window.ui.receive({type:'omp:terminal-data',generation:'0123456789abcdef0123456789abcdef',seq:++seq,bytes:btoa('\\x1b7\\x1b[1;100Hclock '+seq+'\\x1b[24;1Hworking '+seq+'\\x1b8')}), 25);
			 const cursor = window.__cursor = { samples: 0, nonPointer: 0, armed: false, x: 0, y: 0 };
			 const sample = () => { if (cursor.armed) { cursor.samples++; if (getComputedStyle(document.elementFromPoint(cursor.x, cursor.y)).cursor !== 'pointer') cursor.nonPointer++; } requestAnimationFrame(sample); };
			 requestAnimationFrame(sample);
			})()`);
			const box = await ui.evaluate<{ x: number; y: number; width: number }>(`(() => {
			 const row = Array.from(document.querySelectorAll('.xterm-rows > div')).find(candidate => candidate.textContent.includes('subagent')), walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
			 for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			  const at = node.textContent.indexOf('subagent'); if (at < 0) continue;
			  const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 8);
			  const rect = range.getBoundingClientRect(); return { x: rect.left, y: rect.top + rect.height / 2, width: rect.width };
			 }
			 throw new Error('path text not found: ' + row.textContent);
			})()`);
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + 2, y: box.y });
			await ui.wait(`document.querySelector('.omp-terminal-host').title.includes('Click to open')`);
			await ui.evaluate(`Object.assign(window.__cursor, { armed: true, x: ${box.x + 2}, y: ${box.y} })`);
			for (let step = 0; step < 50; step++) {
				const x = box.x + 2 + (step % 4) * (box.width / 8 - 1);
				await ui.evaluate(`Object.assign(window.__cursor, { x: ${x} })`);
				await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: box.y });
				// Real-time hover over a repainting screen is the behavior under test; fake time cannot reproduce Chromium's render cadence.
				const pause = Promise.withResolvers<void>(); setTimeout(pause.resolve, 40); await pause.promise;
			}
			const cursor = await ui.evaluate<{ samples: number; nonPointer: number }>("window.__cursor");
			assert.ok(cursor.samples > 60, `sampled ${cursor.samples} frames`);
			assert.equal(cursor.nonPointer, 0, "hovering the link never flips the cursor back to the text I-beam");
			const validations = await ui.evaluate<string[]>("window.sent.filter(message=>message.type==='omp:terminal-link-validate').map(message=>message.target)");
			assert.equal(validations.filter(value => value === target).length, 1, `validations: ${JSON.stringify(validations)}`);
			const pointer = { x: box.x + 2, y: box.y };
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...pointer });
			await ui.call("Input.dispatchMouseEvent", { type: "mousePressed", ...pointer, button: "left", clickCount: 1 });
			await ui.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...pointer, button: "left", clickCount: 1 });
			await ui.wait("window.sent.some(message=>message.type==='omp:terminal-link-open')");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:terminal-link-open').map(message=>message.target)"), [target]);
		});

		await t.test("native start admission shows progress instead of stopped or unattached controls", async () => {
			await reset("native-start-admission");
			await ui.evaluate("window.ui.view({mode:'terminal',running:false,starting:true,canSwitch:false,reason:'Previous stopped state'})");
			await ui.wait("document.querySelector('.omp-terminal-note[role=\"status\"]')?.textContent==='Starting…'");
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'0123456789abcdef0123456789abcdef',seq:0,phase:'unavailable',input:false,cols:80,rows:24,snapshot:'none',reason:'Not attached yet'});
			 window.fixtureClock.fire(4000)`);
			assert.equal(await ui.evaluate("document.querySelector('.omp-native-session-actions,.omp-notices')"), null);
			assert.equal(await ui.evaluate("document.querySelector('.omp-terminal-state--err,.omp-terminal-state--warn')"), null);
			assert.equal(await ui.evaluate("document.querySelector('.omp-terminal-note[role=\"status\"]')?.textContent"), "Starting…");
			await ui.evaluate("window.ui.view({mode:'terminal',running:false,starting:false,canSwitch:true})");
			await ui.wait("document.querySelector('.omp-native-session-actions')");
			assert.equal(await ui.evaluate("Array.from(document.querySelectorAll('.omp-terminal-note')).some(note=>note.textContent==='Starting…')"), false);
		});

		await t.test("the folder shell fills its own document and refits when the editor height changes", async () => {
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
			const loaded = ui.event("Page.loadEventFired");
			await ui.call("Page.navigate", { url: `${url}?height-folder-shell` });
			await loaded;
			await ui.wait("document.querySelector('.xterm') && window.sent.some(message=>message.type==='omp:terminal-attach')");
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'0123456789abcdef0123456789abcdef',seq:0,phase:'attached',input:true,cols:80,rows:24,snapshot:'follows'});
			 window.ui.receive({type:'omp:terminal-snapshot',generation:'0123456789abcdef0123456789abcdef',seq:0,bytes:btoa('Shell ready\\r\\n')})`);
			await ui.settleGeometry(".omp-app,.omp-terminal-host");
			await ui.wait("(window.fixtureClock.fire(120),window.sent.some(message=>message.type==='omp:terminal-resize'))");
			const initial = await ui.evaluate<{ height: number; viewport: number; rows: number }>("({height:document.querySelector('.omp-terminal-host').getBoundingClientRect().height,viewport:innerHeight,rows:window.sent.filter(message=>message.type==='omp:terminal-resize').at(-1).rows})");
			assert.ok(initial.height >= initial.viewport - 8, JSON.stringify(initial));
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 900, height: 420, deviceScaleFactor: 1, mobile: false });
			await ui.settleGeometry(".omp-app,.omp-terminal-host");
			await ui.wait(`(window.fixtureClock.fire(120),window.sent.some(message=>message.type==='omp:terminal-resize'&&message.rows<${initial.rows}))`);
			const resized = await ui.evaluate<{ height: number; viewport: number }>("({height:document.querySelector('.omp-terminal-host').getBoundingClientRect().height,viewport:innerHeight})");
			assert.ok(resized.height >= resized.viewport - 8 && resized.height < initial.height, JSON.stringify(resized));
			await ui.call("Emulation.clearDeviceMetricsOverride");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("native xterm retains real output through resize, stopping, and stopped recovery", async () => {
			await reset("session-modes");
			await ui.evaluate("window.ui.view({mode:'terminal'})");
			await ui.wait("document.querySelector('.xterm') && !document.querySelector('.omp-composer')");
			await ui.wait("window.sent.some(message=>message.type==='omp:terminal-attach')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-terminal-note[role=\"status\"]')?.textContent"), "Starting…", "terminal startup is explicit before host readiness");
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'0123456789abcdef0123456789abcdef',seq:0,phase:'attached',input:true,cols:80,rows:24,snapshot:'follows',description:'Process cleanup information'});
			 window.ui.receive({type:'omp:terminal-snapshot',generation:'0123456789abcdef0123456789abcdef',seq:0,bytes:btoa('Native TUI output\\r\\n')});
			 window.ui.receive({type:'omp:terminal-data',generation:'0123456789abcdef0123456789abcdef',seq:1,bytes:btoa('Native continuation\\r\\n')})`);
			await ui.wait("document.querySelector('.xterm-rows')?.textContent.includes('Native TUI output')");
			assert.ok(await ui.evaluate<boolean>("document.querySelector('.omp-terminal-host').getBoundingClientRect().height>100"));
			assert.equal(await ui.evaluate("document.title"), "Owned UI session");
			assert.equal(await ui.evaluate("document.querySelector('.omp-terminal-head,.omp-terminal-grid')"), null, "terminal chrome does not repeat editor title or grid metadata");
			assert.equal(await ui.evaluate("document.querySelector('.omp-terminal').textContent.includes('driving') || document.querySelector('.omp-terminal').textContent.includes('Process cleanup information')"), false);
			assert.equal(await ui.evaluate("document.querySelector('.omp-terminal').title.includes('driving') && document.querySelector('.omp-terminal').title.includes('Process cleanup information')"), true, "ownership and cleanup information remain in the tooltip");
			await ui.evaluate("window.beforeTerminalResize=window.sent.filter(message=>message.type==='omp:terminal-attach').at(-1).cols; document.querySelector('.omp-terminal-host').style.width='480px'");
			await ui.wait("(window.fixtureClock.fire(120),window.sent.some(message=>message.type==='omp:terminal-resize' && message.cols<window.beforeTerminalResize))");
			assert.ok(await ui.evaluate<boolean>("document.querySelector('.xterm-rows')?.textContent.includes('Native TUI output')"));
			await ui.evaluate("window.ui.view({mode:'terminal',stopping:true,reason:'OMP is finishing queued work'})");
			await ui.wait("document.body.textContent.includes('OMP is finishing queued work')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-native-session-actions')"), null);
			await ui.evaluate("window.ui.view({mode:'terminal',running:false})");
			await ui.wait("document.querySelector('.omp-native-session-actions')?.textContent.includes('Start in Terminal')");
			await ui.evaluate("Array.from(document.querySelectorAll('.omp-native-session-actions button')).find(button=>button.textContent==='Open in Chat').click()");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:session-mode').at(-1).mode"), "chat");
			await ui.evaluate("window.ui.view({mode:'chat'})");
			await ui.wait("document.querySelector('.omp-composer') && !document.querySelector('.xterm')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the owning pane renders at its own fit after a screen restored at the host's grid, so xterm and the PTY cannot disagree", async () => {
			await reset("owner-refit");
			await ui.evaluate("window.ui.view({mode:'terminal'})");
			await ui.wait("document.querySelector('.xterm') && window.sent.some(message=>message.type==='omp:terminal-attach')");
			const fit = await ui.evaluate<{ cols: number; rows: number }>("(()=>{const m=window.sent.filter(message=>message.type==='omp:terminal-attach').at(-1);return {cols:m.cols,rows:m.rows}})()");
			assert.ok(fit.rows > 14 && fit.cols > 90, `the pane measured a real grid: ${JSON.stringify(fit)}`);
			const generation = "0123456789abcdef0123456789abcdef";
			// Another editor's earlier size: the screen is restored at the host's grid while this pane is not yet the owner.
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'${generation}',seq:0,phase:'attached',input:false,cols:80,rows:10,snapshot:'follows'});
			 window.ui.receive({type:'omp:terminal-snapshot',generation:'${generation}',seq:0,bytes:btoa('Restored at the host grid\\r\\n')})`);
			await ui.wait("document.querySelectorAll('.xterm-rows > div').length===10 && document.querySelector('.xterm-rows').textContent.includes('Restored at the host grid')");
			// The broker then grants this pane input: the PTY is resized to the pane's fit, and the terminal must follow it.
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'${generation}',seq:0,phase:'attached',input:true,cols:80,rows:10,snapshot:'none'})`);
			await ui.wait("(window.fixtureClock.fire(120),window.sent.some(message=>message.type==='omp:terminal-resize'))");
			const resized = await ui.evaluate<{ cols: number; rows: number }>("(()=>{const m=window.sent.filter(message=>message.type==='omp:terminal-resize').at(-1);return {cols:m.cols,rows:m.rows}})()");
			assert.equal(resized.cols, fit.cols, "the PTY is asked for the pane's own columns");
			// The fit at attach is measured while the layout is still settling (here it is a row short), so the PTY gets the settled one.
			await ui.wait(`document.querySelectorAll('.xterm-rows > div').length===${resized.rows}`);
			assert.ok(await ui.evaluate<boolean>("document.querySelector('.xterm-rows').textContent.includes('Restored at the host grid')"), "the restored screen is still there");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the owner reports its fit once it has settled, and again whenever it regains input", async () => {
			await reset("owner-settle");
			await ui.evaluate("window.ui.view({mode:'terminal'})");
			await ui.wait("document.querySelector('.xterm') && window.sent.some(message=>message.type==='omp:terminal-attach')");
			const generation = "0123456789abcdef0123456789abcdef";
			const resizes = "window.sent.filter(message=>message.type==='omp:terminal-resize')";
			const state = (input: boolean) => `window.ui.receive({type:'omp:terminal-state',generation:'${generation}',seq:0,phase:'attached',input:${input},cols:80,rows:24,snapshot:'none'})`;
			const lastGrid = `(()=>{const m=${resizes}.at(-1);return {cols:m.cols,rows:m.rows}})()`;
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'${generation}',seq:0,phase:'attached',input:false,cols:80,rows:24,snapshot:'follows'});
			 window.ui.receive({type:'omp:terminal-snapshot',generation:'${generation}',seq:0,bytes:btoa('Restored\\r\\n')})`);
			await ui.evaluate(state(true));
			// An editor still being laid out passes through several fits: the PTY hears none of them until the fit holds still.
			const frames = "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))";
			await ui.evaluate("document.querySelector('.omp-terminal-host').style.width='560px'");
			await ui.evaluate(frames);
			await ui.evaluate("document.querySelector('.omp-terminal-host').style.width='520px'");
			await ui.evaluate(frames);
			assert.equal(await ui.evaluate(`${resizes}.length`), 0, "no fit is reported while the layout is still moving");
			await ui.evaluate("window.fixtureClock.fire(120)");
			assert.equal(await ui.evaluate(`${resizes}.length`), 1, "the settled fit is reported once");
			const settled = await ui.evaluate<{ cols: number; rows: number }>(lastGrid);
			assert.ok(settled.cols < 80, `the report is the last fit, not the first: ${JSON.stringify(settled)}`);
			// Another owner may have changed the grid meanwhile, and the host refuses a page that does not own input: the pane
			// that gets input back must say its fit again even though it did not change.
			await ui.evaluate(state(false));
			await ui.evaluate(state(true));
			await ui.evaluate("window.fixtureClock.fire(120)");
			assert.equal(await ui.evaluate(`${resizes}.length`), 2);
			assert.deepEqual(await ui.evaluate(lastGrid), settled);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a second screen restored while the first is still unparsed replaces it: the screen is never shown twice", async () => {
			await reset("double-restore");
			await ui.evaluate("window.ui.view({mode:'terminal'})");
			await ui.wait("document.querySelector('.xterm') && window.sent.some(message=>message.type==='omp:terminal-attach')");
			const generation = "0123456789abcdef0123456789abcdef";
			// A page that was hidden or busy holds bytes it has accepted but not parsed. Two restores arrive in the same
			// task (a reattach answered twice, or a restore after a window was minimized), so nothing is parsed between them.
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'${generation}',seq:0,phase:'attached',input:true,cols:80,rows:24,snapshot:'follows'});
			 window.ui.receive({type:'omp:terminal-snapshot',generation:'${generation}',seq:0,bytes:btoa('STALE screen\\r\\nSTALE footer\\r\\n')});
			 window.ui.receive({type:'omp:terminal-data',generation:'${generation}',seq:1,bytes:btoa('STALE live frame\\r\\n')});
			 window.ui.receive({type:'omp:terminal-state',generation:'${generation}',seq:1,phase:'attached',input:true,cols:80,rows:24,snapshot:'follows'});
			 window.ui.receive({type:'omp:terminal-snapshot',generation:'${generation}',seq:1,bytes:btoa('CURRENT screen\\r\\nCURRENT footer\\r\\n')})`);
			await ui.wait("document.querySelector('.xterm-rows')?.textContent.includes('CURRENT footer')");
			const text = await ui.evaluate<string>("document.querySelector('.xterm-rows').textContent");
			assert.doesNotMatch(text, /STALE/, "the older screen was parsed before the reset, not after it");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a terminal response timeout does not claim a connected extension host was lost", async () => {
			await reset("terminal-response-timeout");
			await ui.evaluate(`window.ui.receive({type:'omp:route-offer',hostGeneration:'a'.repeat(32),documentId:'b'.repeat(32),routeGeneration:'c'.repeat(32),status:'ready'});
			 window.ui.view({mode:'terminal'})`);
			await ui.wait("document.querySelector('.xterm') && window.sent.some(message=>message.type==='omp:terminal-attach')");
			const before = await ui.evaluate<string>("document.querySelector('.omp-terminal-note').textContent");
			await ui.evaluate("window.fixtureClock.fire(4000)");
			await ui.wait(`document.querySelector('.omp-terminal-note')?.textContent !== ${JSON.stringify(before)}`);
			assert.equal(await ui.evaluate("document.querySelector('.omp-terminal-note').classList.contains('omp-terminal-state--warn')"), true);
			assert.doesNotMatch(await ui.evaluate<string>("document.querySelector('.omp-terminal-note').textContent"), /extension host connection lost/);
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'0123456789abcdef0123456789abcdef',seq:0,phase:'attached',input:true,cols:80,rows:24,snapshot:'follows'});
			 window.ui.receive({type:'omp:terminal-snapshot',generation:'0123456789abcdef0123456789abcdef',seq:0,bytes:btoa('Recovered terminal output\\r\\n')})`);
			await ui.wait("document.querySelector('.xterm-rows')?.textContent.includes('Recovered terminal output') && !document.querySelector('.omp-terminal-note')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a native pane mounted before its host recovers when the successor is published", async () => {
			await reset("native-publication");
			await ui.evaluate("window.ui.view({mode:'terminal',running:false,canSwitch:false})");
			await ui.wait("document.querySelector('.xterm') && window.sent.some(message=>message.type==='omp:terminal-attach')");
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'00000000000000000000000000000000',seq:0,phase:'unavailable',input:false,cols:80,rows:24,snapshot:'none',reason:'Native broker is not attached yet'})`);
			await ui.wait("document.body.textContent.includes('Native broker is not attached yet')");
			await ui.evaluate("window.ui.view({mode:'terminal',running:true,canSwitch:false})");
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'0123456789abcdef0123456789abcdef',seq:0,phase:'attached',input:false,cols:80,rows:24,snapshot:'follows'});
			 window.ui.receive({type:'omp:terminal-snapshot',generation:'0123456789abcdef0123456789abcdef',seq:0,cols:80,rows:24,alt:false,truncated:false,bytes:btoa('Native successor ready\\r\\n')})`);
			await ui.wait("document.querySelector('.xterm-rows')?.textContent.includes('Native successor ready')");
			await ui.evaluate("window.ui.view({mode:'terminal',canSwitch:true})");
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'0123456789abcdef0123456789abcdef',seq:0,phase:'attached',input:true,cols:80,rows:24,snapshot:'none'})`);
			assert.deepEqual(await ui.evaluate("Array.from(document.querySelectorAll('.omp-terminal-note'),node=>node.textContent.trim())"), []);
			await ui.evaluate("document.querySelector('.xterm-helper-textarea').focus()");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
			await ui.wait("window.sent.some(message=>message.type==='omp:terminal-input' && message.generation==='0123456789abcdef0123456789abcdef' && atob(message.data)==='\\u001b[B')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-native-session-actions')"), null);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		// The OMP TUI counts Unicode 11+ widths and parks the hardware cursor by that count; the
		// renderer's own advance must match or the cursor and the next typed character land a
		// column away from the insertion point (U+231A, U+1F600 and a CJK ideograph are two cells).
		for (const document of ["chat", "shell"]) await t.test(`the real ${document} renderer advances wide emoji and CJK by the cells the TUI counted`, async () => {
			await reset(`native-wide-${document}`);
			await ui.evaluate("window.ui.view({mode:'terminal'})");
			await ui.wait("document.querySelector('.xterm') && window.sent.some(message=>message.type==='omp:terminal-attach')");
			// `> ⌚😀你x`: the TUI counts 2 + 2 + 2 + 2 cells before `x`, so `x` is column 9 (1-based).
			const output = "\u001b[2J\u001b[H> \u231A\u{1F600}\u4F60x\u001b[9G";
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'0123456789abcdef0123456789abcdef',seq:0,phase:'attached',input:true,cols:80,rows:24,snapshot:'follows'});
			 window.ui.receive({type:'omp:terminal-snapshot',generation:'0123456789abcdef0123456789abcdef',seq:0,bytes:btoa(unescape(encodeURIComponent(${JSON.stringify(output)})))})`);
			await ui.wait("document.querySelector('.xterm-rows')?.textContent.includes('x')");
			await ui.evaluate("document.querySelector('.xterm-helper-textarea').focus()");
			await ui.wait("document.querySelector('.xterm-cursor')");
			assert.equal(await ui.evaluate("document.querySelector('.xterm-cursor')?.textContent"), "x", "the cursor sits on the character the TUI addressed");
			// Live output continues from the same column: the typed character replaces `x`.
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-data',generation:'0123456789abcdef0123456789abcdef',seq:1,bytes:btoa('Z')})`);
			await ui.wait("document.querySelector('.xterm-rows')?.textContent.includes('\\u4F60Z')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		for (const document of ["chat", "shell"]) await t.test(`the real ${document} CSP preserves ANSI palette, indexed and RGB foreground/background in snapshots and live output`, async () => {
			await reset(`native-colors-${document}`);
			await ui.evaluate(`document.documentElement.style.setProperty('--vscode-terminal-ansiRed','#c12345');
			 document.documentElement.style.setProperty('--vscode-terminal-ansiBlue','#1f2e3d');window.ui.view({mode:'terminal'})`);
			await ui.wait("document.querySelector('.xterm') && window.sent.some(message=>message.type==='omp:terminal-attach')");
			const colors = (prefix: string) => `\u001b[31;44m${prefix}16\u001b[0m \u001b[38;5;196;48;5;22m${prefix}256\u001b[0m \u001b[38;2;17;83;197;48;2;41;67;89m${prefix}RGB\u001b[0m\r\n`;
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'0123456789abcdef0123456789abcdef',seq:0,phase:'attached',input:true,cols:80,rows:24,snapshot:'follows'});
			 window.ui.receive({type:'omp:terminal-snapshot',generation:'0123456789abcdef0123456789abcdef',seq:0,cols:80,rows:24,alt:false,truncated:false,bytes:btoa(${JSON.stringify(colors("Snapshot"))})})`);
			await ui.wait("document.querySelector('.xterm-rows')?.textContent.includes('SnapshotRGB')");
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-data',generation:'0123456789abcdef0123456789abcdef',seq:1,bytes:btoa(${JSON.stringify(colors("Live"))})})`);
			await ui.wait("document.querySelector('.xterm-rows')?.textContent.includes('LiveRGB')");
			for (const prefix of ["Snapshot", "Live"]) {
				for (const [suffix, foreground, background] of [
					["16", "rgb(193, 35, 69)", "rgb(31, 46, 61)"],
					["256", "rgb(255, 0, 0)", "rgb(0, 95, 0)"],
					["RGB", "rgb(17, 83, 197)", "rgb(41, 67, 89)"],
				]) {
					const token = `${prefix}${suffix}`;
					assert.deepEqual(await ui.evaluate(`(() => {
					 const node=Array.from(document.querySelectorAll('.xterm-rows span')).find(node=>node.textContent.includes(${JSON.stringify(token)}));
					 const style=getComputedStyle(node);return [style.color,style.backgroundColor];})()`), [foreground, background], token);
				}
			}
		});

		for (const document of ["chat", "shell"]) await t.test(`the real ${document} CSP still blocks unnonced stylesheet elements and scripts`, async () => {
			await reset(`style-policy-${document}`);
			const before = await ui.evaluate<string>("getComputedStyle(document.querySelector('.omp-footer-trigger')).display");
			await ui.evaluate(`window.untrustedScriptRan=false;
			 document.head.insertAdjacentHTML('beforeend','<style>.omp-footer-trigger{display:none!important}</style>');
			 const script=document.createElement('script');script.textContent='window.untrustedScriptRan=true';document.head.appendChild(script)`);
			assert.equal(await ui.evaluate("window.untrustedScriptRan"), false);
			assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('.omp-footer-trigger')).display"), before);
		});

		await t.test("desktop toast text cannot inject XML elements or activation attributes", async () => {
			const title = `Unicode Ω 🚀 & </text><actions><action content="injected"/></actions> ' "$($env:USERNAME)"`;
			const body = "Folder & <name> — Finished — waiting for your input";
			const launchUri = `vscode://hmmvot.omp-desk/session/owned?literal="'&<>`;
			const xml = desktopToastXml({ title, body, launchUri });
			const parsed = await ui.evaluate(`(() => {
			 const document=new DOMParser().parseFromString(${JSON.stringify(xml)},'application/xml');
			 return {error:document.querySelector('parsererror')?.textContent??null,
			  title:document.querySelectorAll('text')[0]?.textContent,body:document.querySelectorAll('text')[1]?.textContent,
			  launch:document.documentElement.getAttribute('launch'),actions:document.querySelectorAll('actions,action').length}; })()`);
			assert.deepEqual(parsed, { error: null, title, body, launch: launchUri, actions: 0 });
		});

		await t.test("desktop toast XML remains valid for prohibited controls and malformed UTF-16", async () => {
			const xml = desktopToastXml({ title: "Bad\u0000\u0085\u202E\uD800X", body: "Line one\nHidden second line", launchUri: "vscode://hmmvot.omp-desk/session/owned" });
			const parsed = await ui.evaluate(`(() => {
			 const document=new DOMParser().parseFromString(${JSON.stringify(xml)},'application/xml');
			 return {error:document.querySelector('parsererror')?.textContent??null,text:Array.from(document.querySelectorAll('text'),node=>node.textContent)}; })()`);
			assert.deepEqual(parsed, { error: null, text: ["Bad\uFFFDX", "Line one"] });
		});

		await t.test("desktop toast bounds preserve whole code points and exclude Unicode line-separated payloads", async () => {
			const xml = desktopToastXml({ title: `A${"🚀".repeat(300)}`, body: "Visible\u2028Hidden payload", launchUri: "vscode://hmmvot.omp-desk/session/owned" });
			const parsed = await ui.evaluate<{ error: string | null; title: string; body: string }>(`(() => {
			 const document=new DOMParser().parseFromString(${JSON.stringify(xml)},'application/xml');
			 return {error:document.querySelector('parsererror')?.textContent??null,
			  title:document.querySelectorAll('text')[0]?.textContent,body:document.querySelectorAll('text')[1]?.textContent}; })()`);
			assert.equal(parsed.error, null);
			assert.match(parsed.title, /^A(?:🚀)+$/u);
			assert.equal(parsed.body, "Visible");
		});

		await t.test("live terminal font changes refit owned cells without losing output or resizing a read-only PTY", async () => {
			await reset("native-font-settings");
			await ui.evaluate("window.ui.view({mode:'terminal'})");
			await ui.wait("document.querySelector('.xterm') && window.sent.some(message=>message.type==='omp:terminal-attach')");
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-font',fontFamily:'monospace',fontSize:12,lineHeight:1,letterSpacing:0});
			 window.ui.receive({type:'omp:terminal-state',generation:'0123456789abcdef0123456789abcdef',seq:0,phase:'attached',input:true,cols:80,rows:24,snapshot:'follows'});
			 window.ui.receive({type:'omp:terminal-snapshot',generation:'0123456789abcdef0123456789abcdef',seq:0,bytes:btoa('Native fonts keep this screen\\r\\n')});
			 window.ui.receive({type:'omp:terminal-data',generation:'0123456789abcdef0123456789abcdef',seq:1,bytes:btoa('continued\\r\\n')})`);
			await ui.wait("document.querySelector('.xterm-rows')?.textContent.includes('Native fonts keep this screen')");
			const before = await ui.evaluate<{ cols: number; rows: number; rowHeight: number }>(`(() => {
			 const grid=window.sent.filter(message=>message.type==='omp:terminal-resize'||message.type==='omp:terminal-attach').at(-1);
			 return {cols:grid.cols,rows:grid.rows,rowHeight:document.querySelector('.xterm-rows > div').getBoundingClientRect().height}; })()`);
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-font',fontFamily:'serif',fontSize:24,lineHeight:1.5,letterSpacing:2})`);
			await ui.wait(`getComputedStyle(document.querySelector('.xterm-rows')).fontSize==='24px' && (window.fixtureClock.fire(120),
			 window.sent.some(message=>message.type==='omp:terminal-resize' && message.cols<${before.cols} && message.rows<${before.rows}))`);
			const after = await ui.evaluate<{ family: string; cols: number; rows: number; rowHeight: number; text: string }>(`(() => {
			 const rows=document.querySelector('.xterm-rows'), grid=window.sent.filter(message=>message.type==='omp:terminal-resize').at(-1);
			 return {family:getComputedStyle(rows).fontFamily,cols:grid.cols,rows:grid.rows,
			  rowHeight:rows.firstElementChild.getBoundingClientRect().height,text:rows.textContent}; })()`);
			assert.match(after.family, /serif/);
			assert.ok(after.cols < before.cols && after.rows < before.rows);
			assert.ok(after.rowHeight >= before.rowHeight * 2.5);
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-font',fontFamily:'serif',fontSize:24,lineHeight:1.5,letterSpacing:6})`);
			await ui.wait(`(window.fixtureClock.fire(120),window.sent.some(message=>message.type==='omp:terminal-resize' && message.cols<${after.cols} && message.rows===${after.rows}))`);
			assert.match(after.text, /Native fonts keep this screen/);
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-state',generation:'0123456789abcdef0123456789abcdef',seq:1,phase:'attached',input:false,cols:80,rows:24,snapshot:'none'});
			 window.beforePassiveFont=window.sent.filter(message=>message.type==='omp:terminal-resize').length;
			 window.ui.receive({type:'omp:terminal-font',fontFamily:'monospace',fontSize:16,lineHeight:1.2,letterSpacing:1})`);
			await ui.wait("getComputedStyle(document.querySelector('.xterm-rows')).fontSize==='16px'");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:terminal-resize').length"), await ui.evaluate("window.beforePassiveFont"));
			assert.match(await ui.evaluate<string>("document.querySelector('.xterm-rows').textContent"), /Native fonts keep this screen/);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});
		await t.test("a live wait is one header line that ticks locally, merges repeated polls and settles into one line", async () => {
			await reset("wait-live");
			const command = "npm run typecheck --silent && npm test";
			await ui.evaluate(`(() => {
			 window.fixtureClock.setNow(1800000000000);
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-05T00:00:00Z',message});
			 const call=id=>row('call-'+id,{role:'assistant',timestamp:1,model:'m',stopReason:'toolUse',content:[{type:'toolCall',id,name:'wait',arguments:{}}]});
			 const result=(id,jobs,text)=>row('result-'+id,{role:'toolResult',timestamp:2,toolCallId:id,toolName:'wait',isError:false,content:[{type:'text',text:text??''}],details:{op:'wait',jobs}});
			 const job=(durationMs,status='running',extra={})=>({id:'bg_21',type:'bash',status,label:${JSON.stringify(command)},durationMs,...extra});
			 const active=(id,jobs)=>({toolCallId:id,toolName:'wait',args:{},startedAt:1,partialResult:{content:[{type:'text',text:''}],details:{op:'wait',jobs}}});
			 const live=(entries,id,durationMs)=>window.ui.push({working:true,settled:false,entries,durableCount:entries.length,activeTools:[active(id,[job(durationMs)])]});
			 window.waitFixture={call,result,job,live};
			 live([call('w1')],'w1',113000);
			})()`);
			const clock = "[data-tool-call-id=\"w1\"] .omp-tool-head .omp-tool-elapsed";
			await ui.wait(`document.querySelector('${clock}')`);
			const face = await ui.evaluate<{ head: string; tag: string; toggles: number; chevrons: number; chips: number; body: boolean; rows: number; title: string; height: number; lone: boolean; right: boolean }>(`(() => {
			 const tool=document.querySelector('[data-tool-call-id="w1"]'),head=tool.querySelector('.omp-tool-head'),clock=head.querySelector('.omp-tool-elapsed'),box=head.getBoundingClientRect();
			 return {head:head.textContent,tag:head.tagName,toggles:tool.querySelectorAll('button,[aria-expanded],[tabindex]').length,chevrons:tool.querySelectorAll('.codicon-chevron-right,.codicon-chevron-down').length,chips:head.querySelectorAll('.omp-chip').length,
			  body:Boolean(tool.querySelector('.omp-tool-body')),rows:tool.querySelectorAll('[data-job-id],.omp-wait-rows').length,title:head.title,height:tool.getBoundingClientRect().height,lone:!document.querySelector('.omp-overview-head'),
			  right:box.right-clock.getBoundingClientRect().right<16&&clock.getBoundingClientRect().left>box.left+box.width/2};})()`);
			assert.match(face.head, /Waiting on 1 job/); assert.match(face.head, /bg_21/); assert.match(face.head, /1m 53s/);
			assert.equal(face.tag, "DIV", "expanding would only repeat the line, so the row is not a disclosure");
			assert.equal(face.toggles, 0, "nothing to toggle or focus"); assert.equal(face.chevrons, 0);
			assert.equal(face.chips, 0, "no running badge next to the spinner");
			assert.equal(face.body, false);
			assert.equal(face.rows, 0, "no second line: the job is not a row under the header");
			assert.ok(face.height < 40, `one line (${face.height}px)`);
			assert.ok(face.lone, "a lone wait is a plain row");
			assert.ok(face.right, "the clock sits in the right-aligned slot");
			assert.ok(face.title.includes(`bg_21 · bash · running · 1m 53s · ${command}`), "the tooltip carries the full command");
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 240, height: 900, deviceScaleFactor: 1, mobile: false });
			await ui.settleGeometry(".omp-chat");
			assert.equal(await ui.evaluate("(()=>{const head=document.querySelector('[data-tool-call-id=\"w1\"] .omp-tool-head'),title=head.querySelector('.omp-wait-title-short'),r=title.getBoundingClientRect(),h=head.getBoundingClientRect();return title.textContent==='Wait'&&r.width>0&&r.left>=h.left&&r.right<=h.right})()"), true, "the narrow Wait title remains visible");
			assert.doesNotMatch(await ui.evaluate<string>("document.querySelector('[data-tool-call-id=\"w1\"] .omp-tool-head').textContent"), /×1/);
			if (process.env.OMP_UI_SCREENSHOT_DIR) {
				const image = await ui.call("Page.captureScreenshot", { format: "png" });
				await mkdir(process.env.OMP_UI_SCREENSHOT_DIR, { recursive: true });
				await writeFile(join(process.env.OMP_UI_SCREENSHOT_DIR, "wait-240.png"), Buffer.from(String(image.data), "base64"));
			}
			await ui.call("Emulation.clearDeviceMetricsOverride");
			const duration = () => ui.evaluate<string>(`document.querySelector('${clock}').textContent`);
			// Between progress ticks the clock advances from the last authoritative duration.
			await ui.evaluate("window.fixtureClock.setNow(1800000007000);window.fixtureClock.fire(1000)");
			await ui.wait(`document.querySelector('${clock}')?.textContent==='2m 00s'`);
			// A stale tick never runs the clock backwards; a fresh one takes over.
			await ui.evaluate("window.waitFixture.live([window.waitFixture.call('w1')],'w1',118000)");
			await ui.evaluate("window.fixtureClock.setNow(1800000008000);window.fixtureClock.fire(1000)");
			assert.equal(await duration(), "2m 00s");
			await ui.evaluate("window.waitFixture.live([window.waitFixture.call('w1')],'w1',130000)");
			await ui.wait(`document.querySelector('${clock}')?.textContent==='2m 10s'`);
			// A second poll replaces the first one, live and once durable.
			const { call, result, job, live } = { call: "window.waitFixture.call", result: "window.waitFixture.result", job: "window.waitFixture.job", live: "window.waitFixture.live" };
			await ui.evaluate(`${live}([${call}('w1'),${result}('w1',[${job}(131000)]),${call}('w2')],'w2',140000)`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"w2\"] .omp-tool-elapsed')");
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('[data-tool-name=\"wait\"]')].map(node=>node.dataset.toolCallId)"), ["w2"]);
			// Anything visible between two polls keeps both.
			await ui.evaluate(`window.ui.push({entries:[${call}('w1'),${result}('w1',[${job}(131000)]),{type:'message',id:'between',parentId:null,timestamp:'2026-10-05T00:00:01Z',message:{role:'assistant',timestamp:3,model:'m',stopReason:'stop',content:[{type:'text',text:'still waiting'}]}},${call}('w2')],durableCount:4})`);
			await ui.wait("document.querySelectorAll('[data-tool-name=\"wait\"]').length===2");
			// The finished wait is one line (the lone job, its outcome and clock); results appear only on expansion.
			await ui.evaluate(`window.ui.push({working:false,settled:true,activeTools:[],entries:[${call}('w1'),${result}('w1',[${job}(131000)]),${call}('w2'),${result}('w2',[${job}(125000,'completed',{exitCode:0,resultText:'VISIBLE_RESULT'}),{id:'bg_22',type:'bash',status:'running',label:'sleep 900',durationMs:5}])],durableCount:4})`);
			await ui.wait("[...document.querySelectorAll('[data-tool-name=\"wait\"]')].length===1 && document.querySelector('[data-tool-call-id=\"w2\"]')?.textContent.includes('settled')");
			const settled = await ui.evaluate<{ text: string; height: number }>("(()=>{const tool=document.querySelector('[data-tool-call-id=\"w2\"]');return{text:tool.textContent,height:tool.getBoundingClientRect().height}})()");
			assert.match(settled.text, /bg_21 settled/); assert.match(settled.text, /2m 05s/);
			assert.doesNotMatch(settled.text, /VISIBLE_RESULT|sleep 900/);
			assert.ok(settled.height < 40, `one line (${settled.height}px)`);
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"w2\"] .omp-tool-head').click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"w2\"] .omp-tool-body')?.textContent.includes('VISIBLE_RESULT')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});
		for (const density of ["overview", "detailed"] as const) await t.test(`${density}: task, wait, IRC and generic calls between prose ${density === "overview" ? "collapse into one summary line" : "stay individual rows"}`, async () => {
			await reset(`collapse-${density}`, density);
			await ui.evaluate(`(() => {
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-05T00:00:00Z',message});
			 const prose=(id,text)=>row(id,{role:'assistant',timestamp:1,model:'m',stopReason:'stop',content:[{type:'text',text}]});
			 const calls=[['e1','edit',{path:'a.ts'}],['r1','read',{path:'b.ts'}],['t1','task',{tasks:[{id:'Worker',agent:'scout',task:'Look'}]}],['w1','wait',{}],['i1','write',{path:'agent://Worker',content:'hi'}],['n1','context_notes',{}]];
			 const details={t1:{results:[],progress:[{id:'Worker',agent:'scout',status:'running',task:'Look'}],async:{state:'running',jobId:'J',type:'task'}},w1:{op:'wait',jobs:[{id:'Worker',type:'task',status:'completed',label:'Look',durationMs:1900000}]},i1:{message:{to:'Worker',receipts:[{to:'Worker',outcome:'delivered'}]}},e1:{diff:'+x'}};
			 const irc=(id,kind,body)=>row(id,{role:'custom',timestamp:3,customType:kind,display:true,content:'',details:{from:'Coordinator',to:'Reader',body,message:body}});
			 const entries=[prose('before','Before the tools'),irc('relay-before','irc:relay','First relay'),row('call',{role:'assistant',timestamp:2,model:'m',stopReason:'toolUse',content:calls.slice(0,3).map(([id,name,arguments_])=>({type:'toolCall',id,name,arguments:arguments_}))}),
			  irc('incoming-middle','irc:incoming','Incoming report'),row('call-tail',{role:'assistant',timestamp:2,model:'m',stopReason:'toolUse',content:calls.slice(3).map(([id,name,arguments_])=>({type:'toolCall',id,name,arguments:arguments_}))}),
			  ...calls.map(([id,name])=>row('res-'+id,{role:'toolResult',timestamp:3,toolCallId:id,toolName:name,isError:false,content:[{type:'text',text:'ok '+id}],details:details[id]??{}})),
			  ...Array.from({length:10},(_,index)=>irc('relay-'+index,'irc:relay','Relay message '+index)),prose('after','After the tools')];
			 window.ui.push({working:false,settled:true,activeTools:[],entries,durableCount:entries.length});
			})()`);
			await ui.wait("document.body.textContent.includes('After the tools')");
			const face = await ui.evaluate<{ heads: string[]; tools: string[]; wait: { text: string; height: number } | null }>(`(() => {
			 const wait=document.querySelector('[data-tool-name="wait"]');
			 return {heads:[...document.querySelectorAll('.omp-overview-head')].map(node=>node.textContent),tools:[...document.querySelectorAll('[data-tool-name]')].map(node=>node.dataset.toolName),
			  wait:wait?{text:wait.textContent,height:wait.getBoundingClientRect().height}:null};})()`);
			if (density === "overview") {
				assert.deepEqual(face.heads, ["Edited 1 file · Read 1 file · Spawned 1 agent · Waited for 1 job · 13 messages · 1 tool call"]);
				assert.deepEqual(face.tools, [], "every tool is inside the one collapsed summary");
				assert.equal(await ui.evaluate("document.querySelectorAll('.omp-native-irc').length"), 0, "native custom messages are collapsed into the same run");
				if (process.env.OMP_UI_SCREENSHOT_DIR) {
					await ui.settleGeometry(".omp-chat");
					const image = await ui.call("Page.captureScreenshot", { format: "png" });
					assert.equal(typeof image.data, "string");
					await mkdir(process.env.OMP_UI_SCREENSHOT_DIR, { recursive: true });
					await writeFile(join(process.env.OMP_UI_SCREENSHOT_DIR, "irc-overview-collapsed.png"), Buffer.from(image.data as string, "base64"));
				}
				await ui.evaluate("document.querySelector('.omp-overview-head').click()");
				await ui.wait("document.querySelectorAll('[data-tool-name]').length===6");
			} else {
				assert.deepEqual(face.heads, []);
				assert.deepEqual(face.tools, ["edit", "read", "task", "wait", "write", "context_notes"]);
			}
			await ui.wait("document.querySelectorAll('.omp-native-irc').length===12");
			await ui.evaluate("document.querySelector('.omp-native-irc .omp-tool-head').click()");
			await ui.wait("document.querySelector('.omp-native-irc .omp-tool-body')?.textContent.includes('First relay')");
			await ui.evaluate("window.ui.push({entries:[...window.ui.current().entries]})");
			await ui.wait("document.querySelectorAll('.omp-native-irc').length===12 && document.querySelector('.omp-native-irc .omp-tool-body')?.textContent.includes('First relay')");
			const wait = await ui.evaluate<{ text: string; height: number }>("(()=>{const tool=document.querySelector('[data-tool-name=\"wait\"]');return{text:tool.textContent,height:tool.getBoundingClientRect().height}})()");
			assert.match(wait.text, /Wait.*Worker settled.*31m 40s/);
			assert.ok(wait.height < 40, `the wait row is one line (${wait.height}px)`);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});
		for (const [width, branch] of [[800, null], [800, "main"], [320, null], [320, "main"]] as const) await t.test(`typing is undisturbed while tool rows come and go at ${width}px${branch ? " with a branch chip" : ""}`, async () => {
			await reset(`composer-stability-${width}-${branch ?? "none"}`);
			await ui.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
			if (branch) await ui.evaluate(`window.ui.receive({type:'omp:footer-metadata',provider:'one',branch:${JSON.stringify(branch)},windows:[],accounts:[],accountSelection:null})`);
			await ui.evaluate(`(() => {
			 const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
			 const call=index=>({type:'message',id:'tc-'+index,parentId:null,timestamp:new Date(1000+index).toISOString(),message:{role:'assistant',api:'x',provider:'one',model:'old',stopReason:'toolUse',timestamp:1000+index,usage,content:[{type:'toolCall',id:'t-'+index,name:'bash',arguments:{command:'echo '+index}}]}});
			 const result=index=>({type:'message',id:'tr-'+index,parentId:null,timestamp:new Date(1000+index).toISOString(),message:{role:'toolResult',toolCallId:'t-'+index,toolName:'bash',isError:false,timestamp:1000+index,content:[{type:'text',text:'out '+index}]}});
			 const settled=Array.from({length:6},(_, index)=>[call(index),result(index)]).flat();
			 const phases=[
			  {working:true,settled:false,entries:[...settled,call(9)],durableCount:13,activeTools:[{toolCallId:'t-9',toolName:'bash',args:{command:'echo 9'},startedAt:1}]},
			  {working:true,settled:false,entries:[...settled,call(9),result(9)],durableCount:14,activeTools:[]},
			  {working:false,settled:true,entries:[...settled,call(9),result(9)],durableCount:14,activeTools:[]},
			  {working:false,settled:true,entries:settled.slice(0,4),durableCount:4,activeTools:[]},
			 ];
			 window.phase=step=>window.ui.push(phases[step%phases.length]);
			 window.phase(2);
			 const area=document.querySelector('.omp-composer textarea');area.focus();window.composerNode=area;
			 window.sample=()=>{const a=document.querySelector('.omp-composer textarea'),r=a.getBoundingClientRect(),c=document.querySelector('.omp-composer').getBoundingClientRect(),t=document.querySelector('.omp-transcript');
			  return {same:a===window.composerNode,top:r.top,height:r.height,composerTop:c.top,composerHeight:c.height,gap:t.scrollHeight-t.clientHeight-t.scrollTop,focused:document.activeElement===a,value:a.value,start:a.selectionStart,end:a.selectionEnd,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth}};
			 window.frames2=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
			})()`);
			await ui.evaluate("window.frames2()");
			const typed = "abcdefghijklmnopqrstuvwx";
			const samples: Record<string, unknown>[] = [];
			for (const [step, char] of [...typed].entries()) {
				await ui.call("Input.dispatchKeyEvent", { type: "char", text: char, key: char });
				await ui.evaluate(`window.phase(${step})`);
				await ui.evaluate("window.frames2()");
				samples.push({ step, expected: typed.slice(0, step + 1), ...await ui.evaluate<Record<string, unknown>>("window.sample()") });
			}
			// The empty draft shows a placeholder that may wrap and so is not a baseline for the typed one.
			const baseline = samples[0] as Record<string, number>;
			const drift = (key: string): number => Math.max(...samples.map(sample => Math.abs(Number(sample[key]) - baseline[key]!)));
			assert.ok(samples.every(sample => sample.same && sample.focused), "the textarea is never remounted or blurred");
			assert.ok(samples.every(sample => sample.value === sample.expected && sample.start === sample.end && sample.end === String(sample.value).length), "no character is dropped and the caret stays at the end");
			assert.ok(drift("top") <= 1 && drift("composerTop") <= 1 && drift("composerHeight") <= 1 && drift("height") <= 1, JSON.stringify({ baseline, top: drift("top"), composerTop: drift("composerTop"), composerHeight: drift("composerHeight"), height: drift("height") }));
			assert.ok(samples.every(sample => Number(sample.gap) <= 2), "the followed transcript stays at its tail");
			assert.ok(samples.every(sample => sample.overflow === false), "no page overflow");
			await ui.call("Emulation.clearDeviceMetricsOverride");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});
		for (const surface of ["chat", "folder-shell"]) await t.test(`Ctrl+C in the ${surface === "chat" ? "native session" : "folder shell"} terminal ${surface === "chat" ? "never reaches the program" : "copies a selection and otherwise interrupts"}`, async () => {
			const interrupts = surface === "folder-shell";
			if (interrupts) {
				// The folder shell's own document and view, not a managed session's.
				const loaded = ui.event("Page.loadEventFired");
				await ui.call("Page.navigate", { url: `${url}?terminal-copy-folder-shell` });
				await loaded;
			} else {
				await reset("terminal-copy-chat");
				await ui.evaluate("window.ui.view({mode:'terminal'})");
			}
			await ui.wait("document.querySelector('.xterm') && window.sent.some(message=>message.type==='omp:terminal-attach')");
			await ui.evaluate(`window.copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(text){window.copied.push(text)}}});
			 window.ui.receive({type:'omp:terminal-state',generation:'0123456789abcdef0123456789abcdef',seq:0,phase:'attached',input:true,cols:80,rows:24,snapshot:'follows'});
			 window.ui.receive({type:'omp:terminal-snapshot',generation:'0123456789abcdef0123456789abcdef',seq:0,bytes:btoa('draft in the OMP input\\r\\nsecond row\\r\\n')})`);
			await ui.wait("document.querySelector('.xterm-rows')?.textContent.includes('second row')");
			await ui.settleGeometry(".omp-terminal-host, .xterm-rows > div");
			const row = await ui.evaluate<{ left: number; right: number; y: number }>(`(()=>{
			 const rect=document.querySelector('.xterm-rows > div span').getBoundingClientRect();return {left:rect.left+1,right:rect.right-1,y:rect.top+rect.height/2};})()`);
			const drag = async (modifiers = 0): Promise<void> => {
				for (const [type, x, buttons] of [["mousePressed", row.left, 1], ["mouseMoved", row.right, 1], ["mouseReleased", row.right, 0]] as const) {
					await ui.call("Input.dispatchMouseEvent", { type, x, y: row.y, button: "left", buttons, clickCount: 1, modifiers });
				}
				await ui.evaluate("document.querySelector('.xterm-helper-textarea').focus()");
			};
			// `layout` is what the OS reports for the physical C key: Latin, or Russian where
			// the key is Cyrillic es (U+0441) but the code is still KeyC.
			const ctrlC = async (layout: "latin" | "russian", extra = 0): Promise<void> => {
				const key = layout === "latin" ? (extra & 8 ? "C" : "c") : (extra & 8 ? "\u0421" : "\u0441");
				for (const type of ["rawKeyDown", "keyUp"]) await ui.call("Input.dispatchKeyEvent", { type, key, code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 2 | extra });
			};
			// Input posts are asynchronous, so absence is only established after a later sentinel
			// keystroke ('q') has arrived: everything sent before it is already in the log.
			let sentinels = 0;
			const inputs = async (): Promise<string[]> => {
				sentinels++;
				for (const type of ["keyDown", "keyUp"]) await ui.call("Input.dispatchKeyEvent", { type, key: "q", code: "KeyQ", text: type === "keyDown" ? "q" : undefined, windowsVirtualKeyCode: 81 });
				await ui.wait(`window.sent.filter(message=>message.type==='omp:terminal-input' && atob(message.data)==='q').length===${sentinels}`);
				return (await ui.evaluate<string[]>("window.sent.filter(message=>message.type==='omp:terminal-input').map(message=>atob(message.data))")).filter(data => data !== "q");
			};
			const copied = () => ui.evaluate<string[]>("window.copied");
			// A real click, as the user's, gives the page keyboard focus; a click is not a selection.
			for (const [type, buttons] of [["mousePressed", 1], ["mouseReleased", 0]] as const) {
				await ui.call("Input.dispatchMouseEvent", { type, x: row.left, y: row.y, button: "left", buttons, clickCount: 1 });
			}
			await ui.evaluate("document.querySelector('.xterm-helper-textarea').focus()");
			await ctrlC("latin");
			assert.deepEqual(await inputs(), interrupts ? ["\u0003"] : []);
			await ctrlC("russian");
			assert.deepEqual(await inputs(), interrupts ? ["\u0003", "\u0003"] : []);
			assert.deepEqual(await copied(), [], "nothing is selected, so nothing is copied");
			// A selection by mouse drag is copied, never sent, in either layout.
			for (const layout of ["latin", "russian"] as const) {
				const before = (await inputs()).length;
				await drag();
				await ctrlC(layout);
				await ui.wait(`window.copied.length===${layout === "latin" ? 1 : 2}`);
				assert.match((await copied()).at(-1)!, /^draft/);
				assert.equal((await inputs()).length, before, "a copy never reaches the program");
			}
			// The copy consumed the selection: the same key is again the shell's interrupt and the
			// native session's no-op.
			await ctrlC("latin");
			assert.deepEqual(await inputs(), interrupts ? ["\u0003", "\u0003", "\u0003"] : []);
			assert.equal((await copied()).length, 2);
			// Ctrl+Shift+C claims the key even with nothing selected, in both layouts.
			const afterInterrupts = (await inputs()).length;
			await ctrlC("latin", 8);
			await ctrlC("russian", 8);
			assert.equal((await inputs()).length, afterInterrupts);
			// Paste still flows through the browser's paste event, untouched by the copy chords;
			// a ^C inside pasted text does not reach a native session.
			await ui.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2 });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2 });
			await ui.evaluate(`(()=>{const data=new DataTransfer();data.setData('text/plain','pasted\\u0003 words');
			 document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))})()`);
			await ui.wait("window.sent.some(message=>message.type==='omp:terminal-input' && atob(message.data).includes(' words'))");
			assert.equal((await inputs()).at(-1), interrupts ? "pasted\u0003 words" : "pasted words");
			// A program that enables mouse tracking takes plain drags: nothing is selected, so the
			// chord still copies nothing and sends nothing. Shift+drag forces a local selection.
			await ui.evaluate(`window.ui.receive({type:'omp:terminal-data',generation:'0123456789abcdef0123456789abcdef',seq:1,bytes:btoa('\\x1b[?1000h\\x1b[?1006hmouse mode on\\r\\n')})`);
			await ui.wait("document.querySelector('.xterm-rows')?.textContent.includes('mouse mode on')");
			const beforeMouse = (await copied()).length;
			await drag();
			await ctrlC("latin");
			await ctrlC("russian");
			assert.equal((await copied()).length, beforeMouse, "a drag the program owns selects nothing in the renderer");
			assert.equal((await inputs()).filter(data => data.includes("\u0003") && !data.startsWith("pasted")).length, interrupts ? 5 : 0);
			await drag(8);
			await ctrlC("latin");
			await ui.wait(`window.copied.length===${beforeMouse + 1}`);
			assert.match((await copied()).at(-1)!, /^draft/);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});
		await t.test("a remembered working state is not shown while the session is being re-attached, and the draft survives", async () => {
			await reset("work-unknown");
			await ui.evaluate("window.ui.push({working:true,settled:false});document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "draft kept" });
			// Busy is shown by the composer's own Stop and Steer, never by a separate chip in the state area.
			await ui.wait("document.querySelector('[aria-label=\"Stop the running turn\"]') && document.querySelector('[aria-label=\"Steer the running turn\"]')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer-state')"), null);
			for (const phase of ["resyncing", "attaching", "failed"]) {
				await ui.evaluate(`window.ui.push({phase:${JSON.stringify(phase)}})`);
				await ui.wait(`document.querySelector('.omp-notice') && !document.querySelector('[aria-label="Stop the running turn"]') && !document.querySelector('.omp-shimmer')`);
			}
			await ui.evaluate("window.ui.push({phase:'live'})");
			await ui.wait("document.querySelector('[aria-label=\"Stop the running turn\"]')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer textarea').value"), "draft kept");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});
		await t.test("a recoverable failure offers Reconnect, which asks the host once, while a non-recoverable one does not", async () => {
			await reset("reconnect-action");
			await ui.evaluate("window.ui.push({phase:'failed',code:'identity-changed'})");
			await ui.wait("document.querySelector('.omp-notice .codicon-error')");
			assert.equal(await ui.evaluate("[...document.querySelectorAll('.omp-notice button')].some(button=>button.textContent==='Reconnect')"), false);
			await ui.evaluate("window.ui.push({phase:'failed',code:'ready-timeout'})");
			await ui.wait("[...document.querySelectorAll('.omp-notice button')].some(button=>button.textContent==='Reconnect')");
			await ui.evaluate("[...document.querySelectorAll('.omp-notice button')].find(button=>button.textContent==='Reconnect').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-reconnect')");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-reconnect').length"), 1);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});
		await t.test("unanswered native state offers generation-bound Restart through reconnect, but clears on authoritative recovery", async () => {
			await reset("restart-action");
			await ui.evaluate("window.ui.push({phase:'failed',code:'state-failed'})");
			await ui.wait("[...document.querySelectorAll('.omp-notice button')].some(button=>button.textContent==='Restart')");
			await ui.evaluate("[...document.querySelectorAll('.omp-notice button')].find(button=>button.textContent==='Restart').click()");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-restart').map(message=>message.epoch)"), [{ nonce: "host-ui-test", counter: 1 }]);
			await ui.evaluate("window.ui.push({phase:'resyncing',code:null,epoch:{nonce:'host-ui-test',counter:2}})");
			await ui.wait("[...document.querySelectorAll('.omp-notice button')].some(button=>button.textContent==='Restart')");
			await ui.evaluate("window.ui.push({phase:'live',code:null})");
			await ui.wait("![...document.querySelectorAll('.omp-notice button')].some(button=>button.textContent==='Restart')");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});
		await t.test("a failure banner keeps its full height and Reconnect button visible above a tall transcript", async () => {
			await reset("reconnect-action");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const entries=Array.from({length:40},(_,index)=>row('tall-'+index,{role:'assistant',model:'m',timestamp:1000+index,stopReason:'stop',content:[{type:'text',text:'Row '+index+'\\n\\n'+('Readable long history paragraph. '.repeat(24))}]}));
			 window.ui.push({entries,working:false,settled:true,phase:'failed',code:'ready-timeout'});
			})()`);
			await ui.wait("document.querySelector('.omp-transcript').scrollHeight>3000 && [...document.querySelectorAll('.omp-notice button')].some(button=>button.textContent==='Reconnect')");
			await ui.settleGeometry(".omp-notices");
			const geometry = await ui.evaluate<{ shown: number; content: number; inside: boolean }>(`(()=>{
			 const notices=document.querySelector('.omp-notices'),box=notices.getBoundingClientRect();
			 const button=[...notices.querySelectorAll('button')].find(b=>b.textContent==='Reconnect').getBoundingClientRect();
			 return{shown:box.height,content:Math.min(notices.scrollHeight,112),inside:button.top>=box.top-0.5&&button.bottom<=box.bottom+0.5&&button.height>0};
			})()`);
			assert.ok(geometry.shown >= geometry.content - 0.5, `notices squeezed to ${geometry.shown}px of ${geometry.content}px`);
			assert.equal(geometry.inside, true);
		});

		// Chat layers: one outside-dismissal rule.
		const settleFrames = (): Promise<unknown> => ui.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
		const press = async (key: string, code: string, windowsVirtualKeyCode: number, extra: Record<string, unknown> = {}): Promise<void> => {
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, ...extra });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
		};
		const clickAt = async (point: { x: number; y: number }): Promise<void> => {
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
			await ui.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
			await ui.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
		};
		const centerOf = (selector: string): Promise<{ x: number; y: number }> => ui.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);

		await t.test("the context popover and the slash picker follow the same outside-press rule, and Escape closes only the newest layer", async () => {
			await reset("layers-dismiss");
			await ui.evaluate("document.querySelector('.omp-context-trigger').click()");
			await ui.wait("document.querySelector('.omp-context-popover')");
			await ui.evaluate("document.querySelector('.omp-context-popover').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
			await settleFrames();
			assert.ok(await ui.evaluate("Boolean(document.querySelector('.omp-context-popover'))"), "a press inside the popover keeps it");
			await ui.evaluate("document.querySelector('.omp-transcript').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
			await ui.wait("!document.querySelector('.omp-context-popover')");
			await ui.evaluate("window.ui.push({commands:[{name:'skill:inspect',source:'skill',description:'Inspect source'}]});document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "/ins" });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			await ui.evaluate("document.querySelector('[aria-label=\"Slash commands\"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
			await settleFrames();
			assert.ok(await ui.evaluate("Boolean(document.querySelector('[aria-label=\"Slash commands\"]'))"), "a press inside the list keeps it");
			await ui.evaluate("document.querySelector('.omp-transcript').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
			await ui.wait("!document.querySelector('[aria-label=\"Slash commands\"]')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer textarea').value"), "/ins", "dismissing keeps the draft");
			// Context popover first, picker second: the picker is the newest layer and takes the first Escape.
			await ui.call("Input.insertText", { text: "p" });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			await clickAt(await centerOf(".omp-context-trigger"));
			await ui.wait("document.querySelector('.omp-context-popover')");
			await ui.wait("window.sent.filter(message=>message.type==='omp:composer-popup').at(-1)?.open===true");
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "e" });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('[aria-label=\"Slash commands\"]')");
			assert.ok(await ui.evaluate("Boolean(document.querySelector('.omp-context-popover'))"), "the popover opened earlier is not closed by the same Escape");
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-context-popover')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the context hover card takes VS Code's hover widget border and shadow, lifts its background toward the foreground, and stays flat in high contrast", async () => {
			await reset("context-hover-card");
			await ui.evaluate("(()=>{const style=document.documentElement.style;style.setProperty('--vscode-editorHoverWidget-background','#202a44');style.setProperty('--vscode-editorHoverWidget-foreground','#e0e0e0');style.setProperty('--vscode-editorHoverWidget-border','#336699');style.setProperty('--vscode-widget-border','#996633');style.setProperty('--vscode-widget-shadow','rgba(1, 2, 3, 0.5)');style.setProperty('--vscode-foreground','#ffffff')})()");
			await ui.evaluate("document.querySelector('.omp-context-trigger').click()");
			await ui.wait("document.querySelector('.omp-context-popover')");
			// Computed colours may serialise as color(srgb …); a 1×1 canvas reads them back as bytes whatever the syntax.
			const card = () => ui.evaluate<{ background: number[]; color: number[]; border: number[]; borderWidth: string; shadow: string; strong: number[]; composer: number[] }>(`(()=>{
			 const rgb=value=>{const context=document.createElement('canvas').getContext('2d');context.fillStyle=value;context.fillRect(0,0,1,1);return[...context.getImageData(0,0,1,1).data].slice(0,3)};
			 const card=getComputedStyle(document.querySelector('.omp-context-popover'));
			 return{background:rgb(card.backgroundColor),color:rgb(card.color),border:rgb(card.borderTopColor),borderWidth:card.borderTopWidth,shadow:card.boxShadow,
			  strong:rgb(getComputedStyle(document.querySelector('.omp-context-popover strong')).color),composer:rgb(getComputedStyle(document.querySelector('.omp-composer')).backgroundColor)}})()`);
			const near = (actual: number[], expected: number[], message: string): void => assert.ok(actual.every((channel, index) => Math.abs(channel - expected[index]!) <= 1), `${message}: ${actual} vs ${expected}`);
			const hover = await card();
			// 86% of #202a44 plus 14% of white.
			near(hover.background, [63, 72, 94], "the background is the hover widget colour lifted toward the foreground");
			assert.deepEqual({ color: hover.color, border: hover.border, borderWidth: hover.borderWidth, strong: hover.strong, shadow: hover.shadow.includes("rgba(1, 2, 3, 0.5)") && hover.shadow.includes("16px") },
				{ color: [224, 224, 224], border: [51, 102, 153], borderWidth: "1px", strong: [224, 224, 224], shadow: true });
			assert.notDeepEqual(hover.background, hover.composer, "the card is not the composer's colour");
			await ui.evaluate("document.documentElement.style.removeProperty('--vscode-editorHoverWidget-border')");
			assert.deepEqual((await card()).border, [153, 102, 51], "without a hover border the widget border is used");
			// High contrast keeps the exact hover colours and draws no shadow: the border already separates the card.
			await ui.evaluate("document.body.classList.add('vscode-high-contrast')");
			const flat = await card();
			assert.deepEqual({ background: flat.background, shadow: flat.shadow }, { background: [32, 42, 68], shadow: "none" });
			await ui.evaluate("document.body.classList.remove('vscode-high-contrast')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		// Numbered image references.
		const installImages = (): Promise<unknown> => ui.evaluate(`(()=>{
		 window.pasted=[];
		 window.makePng=async(width,height)=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
		  const context=canvas.getContext('2d');context.fillStyle='rgb('+(width*7%255)+','+(height*13%255)+',120)';context.fillRect(0,0,width,height);
		  return new Promise(resolve=>canvas.toBlob(resolve,'image/png'));};
		 window.pasteImage=async(width,height)=>{const blob=await window.makePng(width,height);
		  const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);window.pasted.push(btoa(binary));
		  const data=new DataTransfer();data.items.add(new File([blob],'shot-'+width+'.png',{type:'image/png'}));
		  const area=document.querySelector('.omp-composer textarea');area.focus();
		  area.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));};
		})()`);
		const draftValue = (): Promise<string> => ui.evaluate("document.querySelector('.omp-composer textarea').value");
		const strip = (): Promise<string[]> => ui.evaluate("[...document.querySelectorAll('.omp-attachment-number')].map(node=>node.textContent)");
		const pasteImage = async (width: number, height: number, marker: string): Promise<void> => {
			await ui.evaluate(`window.pasteImage(${width},${height})`);
			await ui.wait(`document.querySelector('.omp-composer textarea').value.includes(${JSON.stringify(marker)})`);
		};
		const markers = (): Promise<{ start: number; end: number; number: number }[]> => ui.evaluate("(()=>{const value=document.querySelector('.omp-composer textarea').value;return[...value.matchAll(/\\[Image #(\\d+)[^\\]]*\\]/g)].map(match=>({start:match.index,end:match.index+match[0].length,number:Number(match[1])}))})()");
		const setSelection = (start: number, end: number): Promise<unknown> => ui.evaluate(`(()=>{const area=document.querySelector('.omp-composer textarea');area.focus();area.setSelectionRange(${start},${end})})()`);
		const selection = (): Promise<{ start: number; end: number }> => ui.evaluate("(()=>{const area=document.querySelector('.omp-composer textarea');return{start:area.selectionStart,end:area.selectionEnd}})()");
		/** Polls a draft/selection condition (selection changes are not DOM mutations), reporting the draft when it never holds. */
		const waitDraft = async (expression: string): Promise<void> => {
			const held = await ui.evaluate<boolean>(`(async()=>{const deadline=performance.now()+15000;while(performance.now()<deadline){if(${expression})return true;await new Promise(resolve=>requestAnimationFrame(resolve));}return false})()`);
			if (held) return;
			const state = await ui.evaluate("(()=>{const a=document.querySelector('.omp-composer textarea');return{value:a.value,start:a.selectionStart,end:a.selectionEnd,focused:document.activeElement===a}})()");
			assert.fail(`draft condition never held: ${expression}\n${JSON.stringify(state)}`);
		};
		const FIRST = "A [Image #1, 10x6] B [Image #2, 20x8] C [Image #3, 30x9] D";
		/** Three pasted images with typed text between them. */
		const buildDraft = async (name: string): Promise<void> => {
			await reset(name);
			await installImages();
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "A " });
			await pasteImage(10, 6, "[Image #1, 10x6]");
			await ui.call("Input.insertText", { text: "B " });
			await pasteImage(20, 8, "[Image #2, 20x8]");
			await ui.call("Input.insertText", { text: "C " });
			await pasteImage(30, 9, "[Image #3, 30x9]");
			await ui.call("Input.insertText", { text: "D" });
			await ui.wait(`document.querySelector('.omp-composer textarea').value===${JSON.stringify(FIRST)}`);
		};

		await t.test("pasted images become sequentially numbered `[Image #N, WxH]` markers at the caret, with matching labelled thumbnails and a painted chip", async () => {
			await buildDraft("image-refs-insert");
			assert.equal(await draftValue(), FIRST);
			assert.deepEqual(await strip(), ["#1", "#2", "#3"]);
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-attachment-thumb')].map(img=>img.alt)"), ["Image #1", "Image #2", "Image #3"]);
			// Inserting in the middle of existing text goes at the caret, not at the end.
			const [, second] = await markers();
			await setSelection(second!.end + 1, second!.end + 1);
			await ui.wait(`document.querySelector('.omp-composer textarea').selectionStart===${second!.end + 1}`);
			await pasteImage(40, 11, "[Image #4, 40x11]");
			assert.equal(await draftValue(), "A [Image #1, 10x6] B [Image #2, 20x8] [Image #4, 40x11] C [Image #3, 30x9] D");
			assert.deepEqual(await strip(), ["#1", "#2", "#3", "#4"]);
			// Every marker is painted as a chip exactly over its text.
			const chips = await ui.evaluate<{ box: number[]; marks: { r: number[]; bg: string; text: string }[] }>(`(()=>{
			 const area=document.querySelector('.omp-composer textarea');const box=area.getBoundingClientRect();
			 return{box:[box.left,box.top,box.right,box.bottom],marks:[...document.querySelectorAll('.omp-image-ref-mark')].map(mark=>{const r=mark.getBoundingClientRect();return{r:[r.left,r.top,r.right,r.bottom],bg:getComputedStyle(mark).backgroundColor,text:mark.textContent}})};})()`);
			assert.equal(chips.marks.length, 4);
			for (const mark of chips.marks) {
				const [left, top, right, bottom] = mark.r as [number, number, number, number];
				assert.ok(right - left > 20 && left >= chips.box[0]! && right <= chips.box[2]! && top >= chips.box[1]! && bottom <= chips.box[3]! && mark.bg !== "rgba(0, 0, 0, 0)", JSON.stringify({ mark, box: chips.box }));
			}
			assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('.omp-image-ref-mark')).color"), "rgba(0, 0, 0, 0)", "the chip layer carries no second copy of the text");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a marker is atomic for the caret and selection: it cannot be entered, and arrows hop over it", async () => {
			await buildDraft("image-refs-caret");
			const [, second] = await markers();
			await setSelection(second!.start + 4, second!.start + 4);
			await ui.wait(`(()=>{const a=document.querySelector('.omp-composer textarea');return a.selectionStart===a.selectionEnd&&(a.selectionStart===${second!.start}||a.selectionStart===${second!.end})})()`);
			await setSelection(second!.end, second!.end);
			await waitDraft(`document.querySelector('.omp-composer textarea').selectionStart===${second!.end}`);
			await press("ArrowLeft", "ArrowLeft", 37);
			await waitDraft(`document.querySelector('.omp-composer textarea').selectionStart===${second!.start}`);
			assert.deepEqual(await selection(), { start: second!.start, end: second!.start }, "one ArrowLeft crosses the whole marker");
			await press("ArrowRight", "ArrowRight", 39);
			await waitDraft(`document.querySelector('.omp-composer textarea').selectionStart===${second!.end}`);
			assert.deepEqual(await selection(), { start: second!.end, end: second!.end }, "one ArrowRight crosses it back");
			await press("ArrowLeft", "ArrowLeft", 37, { modifiers: 8 });
			await waitDraft(`document.querySelector('.omp-composer textarea').selectionStart===${second!.start}`);
			assert.deepEqual(await selection(), { start: second!.start, end: second!.end }, "Shift+Arrow selects the marker whole");
			// A selection that starts mid-marker grows to the marker's edges.
			await setSelection(second!.start + 3, second!.end + 2);
			await waitDraft(`document.querySelector('.omp-composer textarea').selectionStart===${second!.start}`);
			assert.deepEqual(await selection(), { start: second!.start, end: second!.end + 2 });
			// A real click inside a marker lands on its nearest edge.
			const inside = await ui.evaluate<{ x: number; y: number }>("(()=>{const r=document.querySelector('.omp-image-ref-mark[data-image-number=\"3\"]').getBoundingClientRect();return{x:r.left+r.width*0.85,y:r.top+r.height/2}})()");
			await clickAt(inside);
			const third = (await markers())[2]!;
			await waitDraft(`document.querySelector('.omp-composer textarea').selectionStart===${third.end}`);
			assert.deepEqual(await selection(), { start: third.end, end: third.end });
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("one Backspace or Delete removes a whole marker and its attachment; numbering is stable; Undo and Redo keep text and attachments in step", async () => {
			await buildDraft("image-refs-delete");
			const [first, second] = await markers();
			await setSelection(second!.end, second!.end);
			await ui.wait(`document.querySelector('.omp-composer textarea').selectionStart===${second!.end}`);
			await press("Backspace", "Backspace", 8, { commands: ["deleteBackward"] });
			const withoutSecond = FIRST.replace("[Image #2, 20x8]", "");
			await ui.wait(`document.querySelector('.omp-composer textarea').value===${JSON.stringify(withoutSecond)}`);
			assert.deepEqual(await strip(), ["#1", "#3"], "#3 keeps its number");
			assert.equal(await ui.evaluate("document.querySelector('.omp-attachment[data-image-number=\"2\"]')"), null);
			// Undo brings the marker and the attachment back together; Redo removes both again.
			await press("z", "KeyZ", 90, { modifiers: 2, commands: ["undo"] });
			await ui.wait(`document.querySelector('.omp-composer textarea').value===${JSON.stringify(FIRST)}`);
			await ui.wait("document.querySelectorAll('.omp-attachment-number').length===3");
			assert.deepEqual(await strip(), ["#1", "#2", "#3"]);
			await press("z", "KeyZ", 90, { modifiers: 10, commands: ["redo"] });
			await ui.wait(`document.querySelector('.omp-composer textarea').value===${JSON.stringify(withoutSecond)}`);
			assert.deepEqual(await strip(), ["#1", "#3"]);
			// The next image continues after the highest number ever issued in this draft.
			await pasteImage(50, 12, "[Image #4, 50x12]");
			assert.deepEqual(await strip(), ["#1", "#3", "#4"]);
			// Forward Delete in front of the first marker.
			await setSelection(first!.start, first!.start);
			await ui.wait(`document.querySelector('.omp-composer textarea').selectionStart===${first!.start}`);
			await press("Delete", "Delete", 46, { commands: ["deleteForward"] });
			await ui.wait("!document.querySelector('.omp-composer textarea').value.includes('[Image #1')");
			assert.deepEqual(await strip(), ["#3", "#4"]);
			// A word-wise delete right after a marker takes the marker whole, never a fragment of it.
			const fourth = (await markers()).find(marker => marker.number === 4)!;
			await setSelection(fourth.end, fourth.end);
			await waitDraft(`document.querySelector('.omp-composer textarea').selectionStart===${fourth.end}`);
			await press("Backspace", "Backspace", 8, { modifiers: 2, commands: ["deleteWordBackward"] });
			await waitDraft("!document.querySelector('.omp-composer textarea').value.includes('[Image #4')");
			assert.deepEqual(await strip(), ["#3"]);
			assert.doesNotMatch(await draftValue(), /Image #4|50x12/);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a selection that cuts into a marker deletes it whole, and removing a thumbnail removes its marker (Undo restores both)", async () => {
			await buildDraft("image-refs-selection");
			const [first, second] = await markers();
			await setSelection(first!.end + 1, second!.start + 5);
			await ui.wait(`document.querySelector('.omp-composer textarea').selectionEnd===${second!.end}`);
			await press("Backspace", "Backspace", 8, { commands: ["deleteBackward"] });
			await ui.wait("!document.querySelector('.omp-composer textarea').value.includes('[Image #2')");
			assert.equal(await draftValue(), "A [Image #1, 10x6] " + " C [Image #3, 30x9] D");
			assert.deepEqual(await strip(), ["#1", "#3"]);
			// The thumbnail's × removes its marker from the text.
			await ui.evaluate("document.querySelector('.omp-attachment[data-image-number=\"1\"] .omp-attachment-remove').click()");
			await ui.wait("!document.querySelector('.omp-composer textarea').value.includes('[Image #1')");
			assert.deepEqual(await strip(), ["#3"]);
			assert.equal(await draftValue(), "A   C [Image #3, 30x9] D");
			await press("z", "KeyZ", 90, { modifiers: 2, commands: ["undo"] });
			await ui.wait("document.querySelector('.omp-composer textarea').value.includes('[Image #1')");
			assert.deepEqual(await strip(), ["#1", "#3"], "Undo of the × restores marker and attachment together");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("pending admission keeps text and images, blocks duplicate send routes, and clears only after the matching receipt", async () => {
			await buildDraft("send-admission-pending");
			await ui.evaluate("window.ui.admission(false);document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await ui.wait("window.ui.sends().length===1 && document.querySelector('button[aria-keyshortcuts=\"Enter\"]').disabled");
			assert.equal(await draftValue(), FIRST);
			assert.deepEqual(await strip(), ["#1", "#2", "#3"]);
			await press("Enter", "Enter", 13);
			await ui.evaluate("window.ui.receive({type:'omp:webview-action',action:'send-prompt'});document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click();window.ui.sendReply({...window.ui.sends()[0],requestId:'0'.repeat(32)})");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 1, "neither duplicate actions nor unrelated receipts settle the send");
			assert.equal(await draftValue(), FIRST);
			await ui.evaluate("window.ui.sendReply()");
			await ui.wait("document.querySelector('.omp-composer textarea').value==='' && !document.querySelector('.omp-composer-hint[role=\"status\"]')");
			assert.deepEqual(await strip(), []);
			assert.equal(await ui.evaluate("window.ui.sends().length"), 1);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("late accepted steering retains newer edits and leaves Stop usable during admission", async () => {
			await reset("steer-admission-edited");
			await ui.evaluate("window.ui.admission(false);window.ui.push({working:true,settled:false,state:{...window.ui.current().state,isStreaming:true}});document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "Original steering" });
			await ui.evaluate("document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await ui.wait("window.ui.sends().length===1 && document.querySelector('button[aria-keyshortcuts=\"Enter\"]').disabled");
			assert.equal(await ui.evaluate("window.ui.sends()[0].type"), "omp:chat-steer");
			await ui.evaluate("document.querySelector('[aria-label=\"Stop the running turn\"]').click();document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: " plus newer work" });
			await ui.evaluate("window.ui.sendReply()");
			await ui.wait("!document.querySelector('button[aria-keyshortcuts=\"Enter\"]').disabled");
			assert.equal(await draftValue(), "Original steering plus newer work");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-abort').length"), 1);
			assert.equal(await ui.evaluate("window.ui.sends().length"), 1);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("uncertain admission preserves the original images and recovers into an edited draft without overwrite or automatic retry", async () => {
			await buildDraft("send-admission-recover");
			await ui.evaluate("window.ui.admission(false);document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await ui.wait("window.ui.sends().length===1");
			await setSelection(0, FIRST.length);
			await ui.call("Input.insertText", { text: "New draft" });
			await ui.evaluate("window.fixtureClock.fire(45000)");
			await ui.wait("document.querySelector('[aria-label=\"Dismiss recoverable message\"]')");
			assert.equal(await draftValue(), "New draft");
			assert.equal(await ui.evaluate("document.querySelector('.omp-attach-error details pre').textContent"), FIRST);
			await ui.evaluate("window.fixtureClock.fire(6000);window.fixtureClock.fire(45000);window.ui.push({epoch:{nonce:'host-ui-test',counter:2}})");
			assert.equal(await ui.evaluate("document.querySelectorAll('[aria-label=\"Dismiss recoverable message\"]').length"), 1, "the notice survives time and reconciliation");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 1, "uncertain delivery is never retried automatically");
			await ui.evaluate("[...document.querySelectorAll('.omp-attach-error button')].find(button=>button.textContent==='Add to draft').click()");
			await ui.wait("document.querySelector('.omp-composer textarea').value.includes('A [Image #4, 10x6]')");
			assert.equal(await draftValue(), "New draft\n\nA [Image #4, 10x6] B [Image #5, 20x8] C [Image #6, 30x9] D");
			assert.deepEqual(await strip(), ["#4", "#5", "#6"]);
			await ui.evaluate("document.querySelector('[aria-label=\"Dismiss recoverable message\"]').click()");
			await ui.wait("!document.querySelector('[aria-label=\"Dismiss recoverable message\"]')");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 1);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a refused edited send retains the original while an unchanged uncertain draft is not duplicated by recovery", async () => {
			await reset("send-admission-refused");
			await ui.evaluate("window.ui.admission(false);document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "Refused original" });
			await ui.evaluate("document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await setSelection(0, "Refused original".length);
			await ui.call("Input.insertText", { text: "New work" });
			await ui.evaluate("window.ui.sendReply(undefined,'refused','Not admitted')");
			await ui.wait("document.querySelector('[aria-label=\"Dismiss recoverable message\"]')");
			assert.equal(await draftValue(), "New work");
			assert.equal(await ui.evaluate("document.querySelector('.omp-attach-error details pre').textContent"), "Refused original");
			await reset("send-admission-held");
			await ui.evaluate("window.ui.admission(false);document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "Still held" });
			await ui.evaluate("document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click();window.ui.sendReply(undefined,'unconfirmed','Delivery unknown')");
			await ui.wait("document.querySelector('[aria-label=\"Dismiss recoverable message\"]')");
			await ui.evaluate("[...document.querySelectorAll('.omp-attach-error button')].find(button=>button.textContent==='Add to draft').click()");
			assert.equal(await draftValue(), "Still held");
			assert.equal(await ui.evaluate("document.activeElement===document.querySelector('.omp-composer textarea')"), true);
			assert.equal(await ui.evaluate("window.ui.sends().length"), 1);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a complete capture freezes current, pending and recovery text through late admission and releases only its token", async () => {
			await buildDraft("capture-input");
			await ui.evaluate("window.ui.admission(false);document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await setSelection(0, FIRST.length);
			await ui.call("Input.insertText", { text: "Second input" });
			await ui.evaluate("window.ui.sendReply(undefined,'unconfirmed','Delivery unknown')");
			await ui.wait("document.querySelector('[aria-label=\"Dismiss recoverable message\"]')");
			await ui.evaluate("document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await ui.wait("window.ui.sends().length===2");
			await setSelection(0, "Second input".length);
			await ui.call("Input.insertText", { text: "Latest draft" });
			await ui.evaluate("window.ui.receive({type:'omp:draft-request',requestId:700})");
			await ui.wait("window.sent.some(message=>message.type==='omp:draft-reply'&&message.requestId===700)&&document.querySelector('.omp-composer textarea').readOnly");
			const captured = await ui.evaluate<{ captured: boolean; text: string; attachments: number; recoverable: { text: string; attachments: number; unconfirmed: boolean }[] }>("window.sent.find(message=>message.type==='omp:draft-reply'&&message.requestId===700)");
			assert.equal(captured.captured, true);
			assert.equal(captured.text, "Latest draft");
			assert.equal(captured.attachments, 0);
			assert.deepEqual(captured.recoverable, [{ text: FIRST, attachments: 3, unconfirmed: true }, { text: "Second input", attachments: 0, unconfirmed: true }]);
			await ui.call("Input.insertText", { text: "must not mutate" });
			await ui.evaluate("window.ui.receive({type:'omp:insert-text',text:'@source.ts'});window.ui.sendReply();window.ui.receive({type:'omp:draft-release',requestId:701})");
			assert.equal(await draftValue(), "Latest draft");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer textarea').readOnly"), true);
			await ui.evaluate("window.ui.receive({type:'omp:draft-release',requestId:700})");
			await ui.wait("!document.querySelector('.omp-composer textarea').readOnly&&document.querySelector('.omp-composer textarea').value.includes('@source.ts')");
			assert.ok((await draftValue()).includes("Latest draft"), "a late accepted admission cannot erase deferred new input");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 2);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("capture refuses incomplete IME and image reads and pauses native prefilling until release", async () => {
			await reset("capture-incomplete");
			await installImages();
			await ui.evaluate("document.querySelector('.omp-composer textarea').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));window.ui.receive({type:'omp:draft-request',requestId:710})");
			assert.equal(await ui.evaluate("window.sent.find(message=>message.type==='omp:draft-reply'&&message.requestId===710).captured"), false);
			await ui.evaluate("document.querySelector('.omp-composer textarea').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))");
			await ui.evaluate(`(async()=>{
			 const blob=await window.makePng(9,9),data=new DataTransfer();data.items.add(new File([blob],'capture.png',{type:'image/png'}));
			 document.querySelector('.omp-composer textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
			 window.ui.receive({type:'omp:draft-request',requestId:711});
			})()`);
			assert.equal(await ui.evaluate("window.sent.find(message=>message.type==='omp:draft-reply'&&message.requestId===711).captured"), false);
			await ui.wait("document.querySelector('.omp-attachment-number')");
			await ui.evaluate("window.ui.receive({type:'omp:draft-request',requestId:712})");
			await ui.wait("document.querySelector('.omp-composer textarea').readOnly");
			const original = await draftValue();
			await ui.evaluate("window.ui.receive({type:'omp:chat-event',epoch:window.ui.current().epoch,frame:{type:'ui_editor_text',text:'Native prefill'}})");
			assert.equal(await draftValue(), original);
			await ui.evaluate("window.ui.receive({type:'omp:draft-release',requestId:712})");
			await ui.wait("document.querySelector('.omp-composer textarea').value==='Native prefill'");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("restored current and original text are one-shot, retain missing-image warnings and reserve marker numbers", async () => {
			await reset("restore-input");
			const restored = { type: "omp:draft-restore", requestId: 720, text: "Current [Image #5, 10x6]", attachments: 1, recoverable: [
				{ text: "Original [Image #9, 9x9]", attachments: 2, unconfirmed: true },
				{ text: "Refused text", attachments: 0, unconfirmed: false },
			] };
			await ui.evaluate(`window.ui.receive(${JSON.stringify(restored)})`);
			await ui.wait("document.querySelectorAll('[aria-label=\"Dismiss recoverable message\"]').length===2&&document.querySelector('[aria-label=\"Dismiss attachment warning\"]')");
			assert.equal(await draftValue(), restored.text);
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-attach-error details pre')].map(node=>node.textContent)"), restored.recoverable.map(record => record.text));
			await installImages();
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
			await pasteImage(9, 9, "[Image #10, 9x9]");
			const edited = await draftValue();
			await ui.evaluate(`window.ui.receive(${JSON.stringify(restored)})`);
			assert.equal(await draftValue(), edited);
			assert.equal(await ui.evaluate("document.querySelectorAll('[aria-label=\"Dismiss recoverable message\"]').length"), 2);
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0);
			assert.ok(await ui.evaluate("window.sent.some(message=>message.type==='omp:draft-restored'&&message.requestId===720)"));
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("late accepted admission does not clear edits undone back to the original image draft", async () => {
			await buildDraft("send-admission-undo");
			await ui.evaluate("window.ui.admission(false);document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await ui.wait("window.ui.sends().length===1");
			await ui.evaluate("document.querySelector('.omp-attachment[data-image-number=\"2\"] .omp-attachment-remove').click()");
			await press("z", "KeyZ", 90, { modifiers: 2, commands: ["undo"] });
			await ui.wait(`document.querySelector('.omp-composer textarea').value===${JSON.stringify(FIRST)}`);
			await ui.evaluate("window.ui.sendReply()");
			await ui.wait("!document.querySelector('button[aria-keyshortcuts=\"Enter\"]').disabled");
			assert.equal(await draftValue(), FIRST);
			assert.deepEqual(await strip(), ["#1", "#2", "#3"]);
			assert.equal(await ui.evaluate("window.ui.sends().length"), 1);
		});

		await t.test("send puts the markers in the text and the images on the wire in the same order, densely renumbered; numbering restarts for the next draft", async () => {
			await buildDraft("image-refs-send");
			const [, second] = await markers();
			await setSelection(second!.end, second!.end);
			await ui.wait(`document.querySelector('.omp-composer textarea').selectionStart===${second!.end}`);
			await press("Backspace", "Backspace", 8, { commands: ["deleteBackward"] });
			await ui.wait("!document.querySelector('.omp-composer textarea').value.includes('[Image #2')");
			await ui.evaluate("document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-prompt')");
			const sent = await ui.evaluate<{ text: string; images: { type: string; mimeType: string; data: string }[] }>("window.sent.find(message=>message.type==='omp:chat-prompt')");
			assert.equal(sent.text, "A [Image #1, 10x6] B  C [Image #2, 30x9] D", "markers are renumbered 1..K, the deleted one is gone");
			const pasted = await ui.evaluate<string[]>("window.pasted");
			assert.deepEqual(sent.images.map(image => image.data), [pasted[0], pasted[2]], "image K is the image behind marker K");
			assert.ok(sent.images.every(image => image.type === "image" && image.mimeType === "image/png"));
			await ui.wait("document.querySelector('.omp-composer textarea').value===''");
			assert.deepEqual(await strip(), []);
			await installImages();
			await pasteImage(7, 5, "[Image #1, 7x5]");
			assert.deepEqual(await strip(), ["#1"], "a new draft starts again at #1");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("an image arriving during an IME composition waits for it: the composition is never interrupted", async () => {
			await reset("image-refs-ime");
			await installImages();
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "かな" });
			await ui.evaluate("document.querySelector('.omp-composer textarea').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))");
			await ui.evaluate("window.pasteImage(9,9)");
			await ui.wait("window.pasted.length===1 && !document.querySelector('.omp-composer-attach .codicon-loading')");
			await settleFrames();
			assert.equal(await draftValue(), "かな", "nothing is inserted while composing");
			await ui.evaluate("document.querySelector('.omp-composer textarea').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))");
			await ui.wait("document.querySelector('.omp-composer textarea').value.includes('[Image #1, 9x9]')");
			assert.equal(await draftValue(), "かな [Image #1, 9x9] ");
			assert.deepEqual(await strip(), ["#1"]);
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 0);
		});

		await t.test("a user message renders each `[Image #N, WxH]` marker as a reference to its Nth thumbnail, labelled #N; the same text elsewhere stays text", async () => {
			await reset("image-refs-transcript");
			await installImages();
			const png = await ui.evaluate<string>(`(async()=>{const blob=await window.makePng(6,4);const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary)})()`);
			await ui.evaluate(`window.ui.push({working:false,settled:true,entries:[
			 {type:'message',id:'u-img',parentId:null,timestamp:new Date(1000).toISOString(),message:{role:'user',timestamp:1,content:[
			  {type:'text',text:'Compare [Image #1, 6x4] with [Image #2, 6x4] and [Image #3, 6x4]'},
			  {type:'image',mimeType:'image/png',data:${JSON.stringify(png)}},{type:'image',mimeType:'image/png',data:${JSON.stringify(png)}}]}},
			 {type:'message',id:'a-img',parentId:'u-img',timestamp:new Date(2000).toISOString(),message:{role:'assistant',api:'openai-responses',provider:'one',model:'old',stopReason:'stop',timestamp:2,
			  usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},content:[{type:'text',text:'You wrote [Image #1, 6x4] twice.'}]}}],durableCount:2})`);
			await ui.wait("document.querySelectorAll('.omp-image-ref').length===2 && document.querySelectorAll('.omp-native-image-label').length===2");
			const rendered = await ui.evaluate<{ refs: string[]; labels: string[]; userText: string; assistantRefs: number; assistantText: string }>(`(()=>{
			 const user=document.querySelector('.omp-user');const transcript=document.querySelector('.omp-transcript');
			 return{refs:[...user.querySelectorAll('.omp-image-ref')].map(node=>node.textContent),labels:[...user.querySelectorAll('.omp-native-image-label')].map(node=>node.textContent),
			  userText:user.querySelector('.omp-md').textContent,assistantRefs:transcript.querySelectorAll('.omp-image-ref').length-user.querySelectorAll('.omp-image-ref').length,assistantText:transcript.textContent}})()`);
			assert.deepEqual(rendered.refs, ["Image #1", "Image #2"], "#3 has no image, so it stays plain text");
			assert.deepEqual(rendered.labels, ["#1", "#2"]);
			assert.match(rendered.userText, /and \[Image #3, 6x4\]$/);
			assert.equal(rendered.assistantRefs, 0);
			assert.match(rendered.assistantText, /\[Image #1, 6x4\]/);
			await ui.evaluate("document.querySelectorAll('.omp-image-ref')[1].click()");
			assert.equal(await ui.evaluate("document.activeElement?.dataset?.imageNumber"), "2", "the reference focuses its thumbnail");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});
		await t.test("following pins every painted frame while a reply streams, and only upward input detaches and shows jump-to-latest", async () => {
			await reset("stream-follow");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 window.hist=Array.from({length:12},(_,i)=>i%2===0?row('u'+i,{role:'user',timestamp:1000+i,content:'Prompt '+i}):row('a'+i,{role:'assistant',model:'m',timestamp:1000+i,stopReason:'stop',content:[{type:'text',text:'Reply '+i+'\\n\\n'+'Some readable history text. '.repeat(30)}]}));
			 window.liveText='Streaming start. ';
			 window.mk=()=>({role:'assistant',model:'m',timestamp:5000,stopReason:'stop',content:[{type:'text',text:window.liveText}]});
			 window.ui.push({entries:window.hist,durableCount:window.hist.length,working:true,settled:false,stream:{messageId:'live',message:window.mk()},streamPosition:{anchorId:null,seq:1}});
			 const doc=['# Heading','Paragraph with **bold** and a [link](https://example.com) wrapping across the narrow panel for several lines of text.','1. first item with words\\n2. second item with words\\n3. third item with a long tail that wraps around','> quote that wraps around the panel width easily and keeps going','Closing paragraph. '.repeat(8)].join('\\n\\n').repeat(8);
			 window.doc=doc;window.pos=0;
			 window.step=()=>{window.pos=Math.min(doc.length,window.pos+17);window.liveText='Streaming start. '+doc.slice(0,window.pos);window.ui.receive({type:'omp:chat-event',epoch:window.ui.current().epoch,frame:{type:'message_update',messageId:'live',message:window.mk()}})};
			})()`);
			await ui.settleGeometry(".omp-transcript");
			// Painted state is sampled where a frame is committed: after the controller's own observer, never between a React commit and the frame that pins it.
			await ui.evaluate(`(()=>{
			 const root=document.querySelector('.omp-transcript');window.painted=[];window.buttonSeen=false;
			 const sample=()=>{window.painted.push({top:root.scrollTop,max:root.scrollHeight-root.clientHeight});if(document.querySelector('.omp-jump-latest'))window.buttonSeen=true};
			 window.sampler=new ResizeObserver(sample);window.sampler.observe(root);window.sampler.observe(root.firstElementChild);
			 window.mo=new MutationObserver(()=>{if(document.querySelector('.omp-jump-latest'))window.buttonSeen=true});window.mo.observe(document.body,{childList:true,subtree:true});
			 window.feed=setInterval(window.step,30);
			})()`);
			await ui.evaluate("new Promise(r=>setTimeout(r,3000))");
			const streamed = await ui.evaluate<{ samples: number; worst: number; button: boolean; grown: number }>(`(()=>{clearInterval(window.feed);window.sampler.disconnect();window.mo.disconnect();const root=document.querySelector('.omp-transcript');
			 return {samples:window.painted.length,worst:Math.max(...window.painted.map(p=>Math.abs(p.max-p.top))),button:window.buttonSeen,grown:window.painted.at(-1).max-window.painted[0].max}})()`);
			assert.ok(streamed.samples > 20 && streamed.grown > 300, `stream actually grew the transcript (${JSON.stringify(streamed)})`);
			assert.ok(streamed.worst <= 1, `following pins every committed frame, worst gap ${streamed.worst}px`);
			assert.equal(streamed.button, false, "following never shows jump-to-latest");
			// Downward input while following is not intent to leave.
			// This exercises real Chromium compositor/paint ordering; fake timers cannot drive native wheel delivery.
			// Sample in ResizeObserver after the controller, not a CDP-forced layout between streaming commits and paint.
			const point = await ui.evaluate<{ x: number; y: number }>("(()=>{const rect=document.querySelector('.omp-transcript').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()");
			await ui.evaluate("window.painted=[];window.sampler.observe(document.querySelector('.omp-transcript'));window.sampler.observe(document.querySelector('.omp-transcript').firstElementChild);window.feed=setInterval(window.step,30)");
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
			for (let nudge = 0; nudge < 6; nudge++) { await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: 40 }); await ui.evaluate("new Promise(r=>setTimeout(r,60))"); }
			await ui.evaluate("new Promise(r=>setTimeout(r,400))");
			assert.equal(await ui.evaluate("Boolean(document.querySelector('.omp-jump-latest'))"), false, "wheel nudges downward keep following");
			const downward = await ui.evaluate<{ samples: number; worst: number }>("(()=>{window.sampler.disconnect();return{samples:window.painted.length,worst:Math.max(...window.painted.map(p=>Math.abs(p.max-p.top)))}})()");
			assert.ok(downward.samples > 0 && downward.worst <= 1, `still pinned at every painted frame after downward nudges: ${JSON.stringify(downward)}`);
			// Upward wheel during streaming detaches and shows the button.
			await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: -120 });
			await ui.wait("document.querySelector('.omp-jump-latest')");
			await ui.evaluate("new Promise(r=>setTimeout(r,600))");
			const held = await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollTop");
			await ui.evaluate("new Promise(r=>setTimeout(r,500))");
			assert.ok(Math.abs(await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollTop") - held) <= 1, "detached reading position holds while the reply keeps growing");
			await ui.evaluate("clearInterval(window.feed)");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the bottom visible line stays fixed against the dock top while typing and pasting, following or detached", async () => {
			await reset("dock-anchor");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 window.hist=Array.from({length:14},(_,i)=>i%2===0?row('u'+i,{role:'user',timestamp:1000+i,content:'Prompt '+i}):row('a'+i,{role:'assistant',model:'m',timestamp:1000+i,stopReason:'stop',content:[{type:'text',text:'Reply '+i+'\\n\\n'+Array.from({length:6},(_,line)=>'Line '+i+'.'+line+' of readable history text.').join('\\n\\n')}]}));
			 window.ui.push({entries:window.hist,durableCount:window.hist.length,working:false,settled:true});
			})()`);
			await ui.settleGeometry(".omp-transcript");
			// The row crossing the dock's top edge, identified once and measured relative to that edge afterwards.
			const probe = (key: string) => `(()=>{const dock=document.querySelector('.omp-composer').getBoundingClientRect().top,root=document.querySelector('.omp-transcript'),rootBottom=root.getBoundingClientRect().bottom;
			 const key=${JSON.stringify(key)};const rows=[...root.querySelectorAll('[data-anchor-key]')];
			 const target=key?rows.find(row=>row.dataset.anchorKey===key):rows.filter(row=>row.getBoundingClientRect().top<rootBottom).at(-1);
			 const rect=target.getBoundingClientRect();return{key:target.dataset.anchorKey,offset:rect.top-dock,rootBottom,dock,top:root.scrollTop,max:root.scrollHeight-root.clientHeight,btn:Boolean(document.querySelector('.omp-jump-latest'))}})()`;
			const frame = "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))";
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
			const typing = async (text: string) => { await ui.call("Input.insertText", { text }); await ui.evaluate(frame); };
			const newline = async () => { await ui.call("Input.insertText", { text: "\n" }); await ui.evaluate(frame); };
			for (const mode of ["following", "detached"]) {
				if (mode === "detached") {
					await ui.evaluate("document.querySelector('.omp-composer textarea').select();document.execCommand('delete')");
					await ui.evaluate(frame);
					const point = await ui.evaluate<{ x: number; y: number }>("(()=>{const rect=document.querySelector('.omp-transcript').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()");
					await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
					await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: -130 });
					await ui.wait("document.querySelector('.omp-jump-latest')");
					await ui.evaluate("new Promise(r=>setTimeout(r,600))");
					await ui.settleGeometry(".omp-transcript");
					await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
				}
				const base = await ui.evaluate<{ key: string; offset: number; btn: boolean }>(probe(""));
				assert.equal(base.btn, mode === "detached");
				const heights = [await ui.evaluate<number>("document.querySelector('.omp-composer').getBoundingClientRect().height")];
				const check = async (label: string) => {
					const now = await ui.evaluate<{ offset: number; btn: boolean }>(probe(base.key));
					assert.ok(Math.abs(now.offset - base.offset) <= 1, `${mode}: ${label} moved the bottom line by ${now.offset - base.offset}px`);
					assert.equal(now.btn, mode === "detached", `${mode}: ${label} kept the button state`);
					heights.push(await ui.evaluate<number>("document.querySelector('.omp-composer').getBoundingClientRect().height"));
				};
				await typing("first line");
				await check("typing a line");
				for (let line = 2; line <= 5; line++) { await newline(); await typing(`line ${line}`); await check(`typing line ${line}`); }
				await ui.call("Input.insertText", { text: "\npasted one\npasted two\npasted three" });
				await ui.evaluate(frame);
				await check("pasting three lines");
				assert.ok(heights.at(-1)! > heights[0]! + 80, `the dock grew (${heights.join(",")})`);
				await ui.evaluate("document.querySelector('.omp-composer textarea').select();document.execCommand('delete')");
				await ui.evaluate(frame);
				const shrunk = await ui.evaluate<{ offset: number }>(probe(base.key));
				if (mode === "following") assert.ok(await ui.evaluate("(()=>{const r=document.querySelector('.omp-transcript');return Math.abs(r.scrollHeight-r.clientHeight-r.scrollTop)<=1})()"), "following stays at the tail after the dock shrinks");
				else assert.ok(Math.abs(shrunk.offset - base.offset) <= 1, `detached: shrinking the dock moved the bottom line by ${shrunk.offset - base.offset}px`);
			}
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("IRC messages are collapsed tool-style rows that never merge into assistant prose", async () => {
			await reset("irc-row");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const custom=(customType,details,content='fallback')=>({role:'custom',customType,content,details,attribution:'agent',display:true,timestamp:1000});
			 const body='Relayed IRC body line one that is long enough to be truncated in a single preview row because it keeps going and going beyond the panel width.\\n\\n**bold relayed** second paragraph';
			 window.ui.push({entries:[
			  row('before',{role:'assistant',model:'m',timestamp:1,stopReason:'stop',content:[{type:'text',text:'Assistant prose before the relay'}]}),
			  row('irc',custom('irc:relay',{from:'Main',to:'Scout',body,pool:'pool-a'})),
			  row('after',{role:'assistant',model:'m',timestamp:3,stopReason:'stop',content:[{type:'text',text:'Assistant prose after the relay'}]}),
			  row('irc-in',custom('irc:incoming',{from:'Scout',to:'Main',message:'short incoming'}))
			 ],durableCount:4,working:false,settled:true})
			})()`);
			await ui.wait("document.querySelectorAll('.omp-native-irc').length===2");
			const facts = await ui.evaluate<{ rows: string[]; expanded: string | null; label: string; route: string; icon: boolean; kind: string; preview: string; truncated: boolean; body: boolean; prose: boolean; boxed: boolean }>(`(()=>{
			 const irc=document.querySelector('.omp-native-irc'),head=irc.querySelector('.omp-tool-head'),preview=irc.querySelector('.omp-irc-preview');
			 const wrappers=[...document.querySelectorAll('.omp-measured-row')];
			 return {rows:wrappers.map(row=>row.querySelector('.omp-native-irc')?'irc':row.textContent.includes('Assistant prose')?'prose':'other'),expanded:head.getAttribute('aria-expanded'),label:head.querySelector('.omp-tool-name').textContent,
			  route:head.querySelector('.omp-irc-route').textContent,icon:Boolean(head.querySelector('.codicon-comment-discussion')),kind:head.querySelector('.omp-irc-kind').textContent,preview:preview.textContent,truncated:preview.scrollWidth>preview.clientWidth,
			  body:Boolean(irc.querySelector('.omp-tool-body')),prose:irc.closest('.omp-measured-row').textContent.includes('Assistant prose'),boxed:getComputedStyle(irc).borderTopWidth!=='0px'}})()`);
			assert.deepEqual(facts.rows, ["prose", "irc", "prose", "irc"], "IRC rows are rows of their own between the prose replies");
			assert.equal(facts.expanded, "false", "collapsed by default");
			assert.equal(facts.label, "IRC");
			assert.equal(facts.route, "Main → Scout");
			assert.equal(facts.kind, "relay");
			assert.ok(facts.icon, "comment-discussion icon");
			assert.ok(facts.preview.startsWith("Relayed IRC body line one") && !facts.preview.includes("\n"), "one-line muted preview");
			assert.ok(facts.truncated, "long preview truncates instead of wrapping");
			assert.equal(facts.body, false);
			assert.equal(facts.prose, false);
			assert.equal(facts.boxed, false, "flat like a tool row, no card border");
			// Expanding shows the full body as Markdown.
			await ui.evaluate("document.querySelector('.omp-native-irc .omp-tool-head').click()");
			await ui.wait("document.querySelector('.omp-native-irc .omp-tool-body strong')?.textContent==='bold relayed'");
			assert.equal(await ui.evaluate("document.querySelector('.omp-native-irc .omp-tool-head').getAttribute('aria-expanded')"), "true");
			assert.ok(await ui.evaluate<boolean>("document.querySelector('.omp-native-irc .omp-tool-body').textContent.includes('Pool:')"), "details stay reachable when expanded");
			await ui.settleGeometry(".omp-transcript");
			// Expansion survives its virtualized DOM being unmounted and remounted.
			await ui.evaluate("window.ui.push({entries:[...window.ui.current().entries]})");
			await ui.settleGeometry(".omp-transcript");
			assert.equal(await ui.evaluate("document.querySelector('.omp-native-irc .omp-tool-head').getAttribute('aria-expanded')"), "true");
			await ui.evaluate("document.querySelector('.omp-native-irc .omp-tool-head').click()");
			await ui.wait("!document.querySelector('.omp-native-irc .omp-tool-body')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("file references in replies, user messages and tool rows become links only once the host proves them, and a click posts the open request", async () => {
			await reset("chat-file-links");
			const prose = "See src/proof.ts:12:4 and `./docs/my notes.md` or [the guide](docs/guide.md#L7) but not src/absent.ts.";
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.ui.push({entries:[
			  row('user',{role:'user',timestamp:1,content:'Check @src/proof.ts [lines 12-30] please'}),
			  row('assistant',{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:${JSON.stringify(`${prose}\n\n\`\`\`\nsrc/proof.ts in a fence\n\`\`\``)}}]}),
			  row('call',{role:'assistant',model:'m',timestamp:3,stopReason:'toolUse',content:[{type:'toolCall',id:'read-1',name:'read',arguments:{path:'src/proof.ts:40-60'}}]}),
			  row('result',{role:'toolResult',toolCallId:'read-1',toolName:'read',timestamp:4,isError:false,content:[{type:'text',text:'forty'}]}),
			 ],durableCount:4,working:false,settled:true});
			 // The host's answers: these files exist, nothing else does.
			 const proven=['src/proof.ts:12:4','./docs/my notes.md','docs/guide.md#L7','src/proof.ts:12','src/proof.ts','src/proof.ts:40'];
			 window.answered=new Set();
			 window.answerLinks=setInterval(()=>{for(const message of window.sent){
			  if(message.type!=='omp:terminal-link-validate'||window.answered.has(message.requestId))continue;
			  window.answered.add(message.requestId);
			  window.ui.receive({type:'omp:terminal-link-validation',requestId:message.requestId,valid:proven.includes(message.target)});
			 }},5);
			})()`);
			await ui.wait("document.querySelectorAll('.omp-file-link').length>=5");
			const facts = await ui.evaluate<{ targets: string[]; replyText: string; userText: string; fenced: number; focusable: boolean; digestText: string; absentAsked: boolean; absentLinked: boolean }>(`(()=>{
			 const links=[...document.querySelectorAll('.omp-file-link')];
			 const reply=[...document.querySelectorAll('.omp-md')].find(node=>node.textContent.startsWith('See src/proof.ts'));
			 const user=[...document.querySelectorAll('.omp-md')].find(node=>node.textContent.startsWith('Check @src'));
			 return {targets:links.map(link=>link.dataset.fileTarget),replyText:reply.querySelector('p').textContent,userText:user.textContent,
			  fenced:reply.querySelectorAll('pre .omp-file-link').length,focusable:links.every(link=>link.tabIndex===0&&link.getAttribute('role')==='link'),
			  digestText:document.querySelector('[data-tool-name="read"] .omp-tool-digest').textContent,
			  absentAsked:window.sent.some(message=>message.type==='omp:terminal-link-validate'&&message.target==='src/absent.ts'),
			  absentLinked:links.some(link=>link.textContent==='src/absent.ts')};
			})()`);
			assert.deepEqual([...new Set(facts.targets)].sort(), ["./docs/my notes.md", "docs/guide.md#L7", "src/proof.ts:12", "src/proof.ts:12:4", "src/proof.ts:40"]);
			assert.equal(facts.replyText, "See src/proof.ts:12:4 and ./docs/my notes.md or the guide but not src/absent.ts.", "link detection never alters the rendered text");
			assert.equal(facts.userText, "Check @src/proof.ts [lines 12-30] please");
			assert.equal(facts.fenced, 0, "fenced code stays text");
			assert.ok(facts.focusable, "links are keyboard reachable");
			assert.equal(facts.digestText, "src/proof.ts:40-60");
			assert.ok(facts.absentAsked && !facts.absentLinked, "a path the host does not find stays text");
			const sentOpen = () => ui.evaluate<string[]>("window.sent.filter(message=>message.type==='omp:terminal-link-open').map(message=>message.target)");
			assert.deepEqual(await sentOpen(), [], "validation alone never opens anything");
			await ui.evaluate("document.querySelector('[data-file-target=\"src/proof.ts:12:4\"]').click()");
			assert.deepEqual(await sentOpen(), ["src/proof.ts:12:4"], "a plain click posts the open request for that exact reference");
			await ui.evaluate("document.querySelector('[data-file-target=\"docs/guide.md#L7\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
			assert.equal((await sentOpen()).at(-1), "docs/guide.md#L7", "Enter activates a focused link");
			await ui.evaluate("document.querySelector('[data-file-target=\"src/proof.ts:12\"]').click()");
			assert.equal((await sentOpen()).at(-1), "src/proof.ts:12", "an @ mention opens at the first line of its note");
			await ui.evaluate("document.querySelector('[data-tool-name=\"read\"] .omp-file-link').click()");
			assert.equal((await sentOpen()).at(-1), "src/proof.ts:40", "the read row's path opens at its line selector");
			assert.notEqual(await ui.evaluate("document.querySelector('[data-tool-name=\"read\"] .omp-tool-head').getAttribute('aria-expanded')"), "true", "the link click does not toggle the row");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
			await ui.evaluate("clearInterval(window.answerLinks)");
		});

		await t.test("web links in replies, user messages and tool output open by a validated host request: click for an editor tab, Ctrl+Click for the browser, never a navigation", async () => {
			await reset("chat-web-links");
			const reply = "Read [the docs](https://example.com/docs) or https://example.com/bare. Not [this](javascript:alert(1)), [that](command:workbench.action.reloadWindow) or [data](data:text/html,x).";
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.ui.push({entries:[
			  row('user',{role:'user',timestamp:1,content:'Compare https://user.example.com/page please'}),
			  row('assistant',{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:${JSON.stringify(reply)}}]}),
			  row('call',{role:'assistant',model:'m',timestamp:3,stopReason:'toolUse',content:[{type:'toolCall',id:'search-1',name:'web_search',arguments:{query:'example'}}]}),
			  row('result',{role:'toolResult',toolCallId:'search-1',toolName:'web_search',timestamp:4,isError:false,content:[{type:'text',text:'Answer'}],details:{response:{answer:'See https://answer.example.com/a.',sources:[{title:'Example source',url:'https://source.example.com/s'}]}}}),
			 ],durableCount:4,working:false,settled:true});
			})()`);
			await ui.wait("document.querySelectorAll('.omp-web-link').length>=3");
			const facts = await ui.evaluate<{ urls: string[]; replyText: string; anchors: number; focusable: boolean; title: string; cursor: string }>(`(()=>{
			 const links=[...document.querySelectorAll('.omp-web-link')];
			 const reply=[...document.querySelectorAll('.omp-md')].find(node=>node.textContent.startsWith('Read the docs'));
			 return {urls:links.map(link=>link.dataset.webUrl),replyText:reply.textContent,anchors:document.querySelectorAll('.omp-transcript a[href]').length,
			  focusable:links.every(link=>link.tabIndex===0&&link.getAttribute('role')==='link'),title:links.find(link=>link.textContent==='the docs').title,
			  cursor:getComputedStyle(links[0]).cursor};
			})()`);
			assert.deepEqual(facts.urls.sort(), ["https://example.com/bare", "https://example.com/docs", "https://user.example.com/page"]);
			assert.equal(facts.replyText, "Read the docs or https://example.com/bare. Not this, that or data.", "only http(s) destinations link; the others keep their labels and lose their URLs");
			assert.equal(facts.anchors, 0, "the page renders no navigating anchors");
			assert.ok(facts.focusable, "links are keyboard reachable");
			assert.equal(facts.title, "https://example.com/docs\nOpen in editor · Ctrl+Click to open in browser");
			assert.equal(facts.cursor, "pointer");
			const href = await ui.evaluate<string>("location.href");
			const sentOpen = () => ui.evaluate<{ target: string; mode?: string }[]>("window.sent.filter(message=>message.type==='omp:terminal-link-open').map(({target,mode})=>({target,mode}))");
			const click = async (selector: string, modifiers = 0) => {
				const box = await ui.evaluate<{ x: number; y: number }>(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center'});const rect=node.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};})()`);
				await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
				await ui.call("Input.dispatchMouseEvent", { type: "mousePressed", ...box, button: "left", clickCount: 1, modifiers });
				await ui.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...box, button: "left", clickCount: 1, modifiers });
			};
			assert.deepEqual(await sentOpen(), [], "rendering opens nothing");
			await click("[data-web-url=\"https://example.com/docs\"]");
			assert.deepEqual((await sentOpen()).at(-1), { target: "https://example.com/docs", mode: "editor" }, "a plain click asks for an editor tab");
			await click("[data-web-url=\"https://example.com/bare\"]", 2);
			assert.deepEqual((await sentOpen()).at(-1), { target: "https://example.com/bare", mode: "external" }, "Ctrl+Click asks for the external browser");
			await ui.evaluate("document.querySelector('[data-web-url=\"https://user.example.com/page\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
			assert.deepEqual((await sentOpen()).at(-1), { target: "https://user.example.com/page", mode: "editor" }, "Enter opens a focused link in the editor");
			const ctrlEnter = await ui.evaluate<{ prevented: boolean; reachedWindow: boolean }>(`(()=>{
			 let reachedWindow=false;const spy=()=>{reachedWindow=true};window.addEventListener('keydown',spy);
			 const event=new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true});
			 document.querySelector('[data-web-url="https://user.example.com/page"]').dispatchEvent(event);
			 window.removeEventListener('keydown',spy);return {prevented:event.defaultPrevented,reachedWindow};
			})()`);
			assert.deepEqual((await sentOpen()).at(-1), { target: "https://user.example.com/page", mode: "external" }, "Ctrl+Enter opens a focused link in the browser");
			assert.deepEqual(ctrlEnter, { prevented: true, reachedWindow: false }, "Ctrl+Enter on a link never reaches VS Code's send keybinding");
			await ui.evaluate("document.querySelector('[data-tool-name=\"web_search\"] .omp-tool-head').click()");
			await ui.wait("document.querySelector('[data-tool-name=\"web_search\"] [data-web-url=\"https://source.example.com/s\"]') && document.querySelector('[data-tool-name=\"web_search\"] [data-web-url=\"https://answer.example.com/a\"]')");
			await click("[data-tool-name=\"web_search\"] [data-web-url=\"https://source.example.com/s\"]");
			assert.deepEqual((await sentOpen()).at(-1), { target: "https://source.example.com/s", mode: "editor" }, "a tool output's source link opens the same way");
			await click("[data-tool-name=\"web_search\"] [data-web-url=\"https://answer.example.com/a\"]", 2);
			assert.deepEqual((await sentOpen()).at(-1), { target: "https://answer.example.com/a", mode: "external" }, "a bare URL in tool prose too");
			assert.equal((await sentOpen()).length, 6);
			assert.ok((await sentOpen()).every(message => /^https:\/\//.test(message.target)), "no disallowed scheme is ever sent");
			assert.equal(await ui.evaluate<string>("location.href"), href, "the page never navigated itself");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("code blocks and the user's own messages copy their exact source and report clipboard failure", async () => {
			await reset("quick-copy");
			await ui.evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(text){window.copied=text}}});
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.ui.push({entries:[row('user',{role:'user',timestamp:1,content:'Explain **this**\\nplease'}),
			  row('reply',{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:'Run:\\n\\n\`\`\`ts\\nconst a = 1;\\n  const b = a;\\n\`\`\`\\n\\nDone.'}]})],durableCount:2,working:false,settled:true})`);
			await ui.wait("document.querySelector('.omp-code-copy') && document.querySelector('.omp-row-actions .omp-copy-button')");
			await ui.evaluate("document.querySelector('.omp-code-copy').click()");
			await ui.wait("window.copied!==undefined");
			assert.equal(await ui.evaluate("window.copied"), "const a = 1;\n  const b = a;", "the code only: no fences, no language, indentation kept");
			assert.equal(await ui.evaluate("document.querySelector('.omp-code-copy [role=status]').textContent"), "Copied");
			await ui.evaluate("window.copied=undefined;document.querySelector('.omp-row-actions .omp-copy-button').click()");
			await ui.wait("window.copied!==undefined");
			assert.equal(await ui.evaluate("window.copied"), "Explain **this**\nplease", "the prompt as sent, not its rendering");
			await ui.evaluate("navigator.clipboard.writeText=async()=>{throw new Error('Denied')};document.querySelector('.omp-code-copy').click()");
			await ui.wait("document.querySelector('.omp-code-copy [role=status]')?.textContent==='Copy failed'");
			assert.equal(await ui.evaluate("window.sent.filter(message=>/^omp:chat-(prompt|steer|follow-up)$/.test(message.type)).length"), 0);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Retry appears only on a failed or aborted last reply while idle, and re-runs it through OMP's /retry", async () => {
			await reset("quick-retry");
			await ui.evaluate(`window.row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.failed=[window.row('u1',{role:'user',timestamp:1,content:'Do it'}),window.row('a1',{role:'assistant',model:'m',timestamp:2,stopReason:'error',errorMessage:'Provider overloaded',content:[]})];
			 window.ui.push({entries:window.failed,durableCount:2,working:false,settled:true})`);
			await ui.wait("document.querySelector('.omp-retry-turn')");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-error').textContent"), /Provider overloaded/);
			await ui.evaluate("document.querySelector('.omp-retry-turn').click()");
			await ui.wait("window.ui.sends().length===1");
			assert.deepEqual(await ui.evaluate("(({type,text})=>({type,text}))(window.ui.sends()[0])"), { type: "omp:chat-prompt", text: "/retry" });
			await ui.evaluate("window.ui.push({working:true,settled:false})");
			await ui.wait("!document.querySelector('.omp-retry-turn')");
			await ui.evaluate("window.ui.push({working:false,settled:true,entries:[...window.failed,window.row('u2',{role:'user',timestamp:3,content:'Something else'})],durableCount:3})");
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('Something else')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-retry-turn')"), null, "a newer prompt leaves nothing to retry");
			await ui.evaluate("window.ui.push({entries:[window.failed[0],window.row('a1',{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:'Fine'}]})],durableCount:2})");
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('Fine')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-retry-turn')"), null, "a completed reply offers no retry");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Up and Down on an empty draft walk the conversation's prompts and Down past the newest restores the draft", async () => {
			await reset("quick-history");
			await ui.evaluate(`const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.ui.push({entries:[row('u1',{role:'user',timestamp:1,content:'first prompt'}),row('a1',{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:'ok'}]}),
			  row('u2',{role:'user',timestamp:3,content:'second prompt'}),row('a2',{role:'assistant',model:'m',timestamp:4,stopReason:'stop',content:[{type:'text',text:'ok'}]})],durableCount:4,working:false,settled:true});
			 document.querySelector('.omp-composer textarea').focus()`);
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('second prompt')");
			await press("ArrowUp", "ArrowUp", 38);
			await ui.wait("document.querySelector('.omp-composer textarea').value==='second prompt'");
			await press("ArrowUp", "ArrowUp", 38);
			await ui.wait("document.querySelector('.omp-composer textarea').value==='first prompt'");
			await press("ArrowUp", "ArrowUp", 38);
			assert.equal(await draftValue(), "first prompt", "the oldest prompt is the end of the walk");
			await press("ArrowDown", "ArrowDown", 40);
			await ui.wait("document.querySelector('.omp-composer textarea').value==='second prompt'");
			await press("ArrowDown", "ArrowDown", 40);
			await ui.wait("document.querySelector('.omp-composer textarea').value===''");
			await ui.call("Input.insertText", { text: "typed draft" });
			await press("ArrowUp", "ArrowUp", 38);
			assert.equal(await draftValue(), "typed draft", "a typed draft is never replaced");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Stop hands the still-queued messages back into the draft, after what is typed, and says when some could not come back", async () => {
			await reset("quick-stop-restore");
			await ui.evaluate("window.ui.push({working:true,settled:false,state:{...window.ui.current().state,isStreaming:true}});document.querySelector('.omp-composer textarea').focus()");
			await ui.wait("document.querySelector('[aria-label=\"Stop the running turn\"]')");
			await ui.call("Input.insertText", { text: "typed" });
			await ui.evaluate("document.querySelector('[aria-label=\"Stop the running turn\"]').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-abort')");
			await ui.evaluate(`const abort=window.sent.find(message=>message.type==='omp:chat-abort');
			 window.ui.receive({type:'omp:chat-abort-result',epoch:window.ui.current().epoch,requestId:abort.requestId,status:'accepted',entries:[{text:'queued steer'},{text:'queued follow-up'}],truncated:true})`);
			await ui.wait("document.querySelector('.omp-composer textarea').value.includes('queued follow-up')");
			const restored = await draftValue();
			assert.ok(restored.startsWith("typed") && restored.indexOf("queued steer") < restored.indexOf("queued follow-up"), restored);
			await ui.wait("document.querySelector('.omp-attach-error')?.textContent.includes('could not hand back every queued message')");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0, "restored messages are not sent");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("extension widgets render at their placement as plain text, and an info or warning notice is dismissible", async () => {
			await reset("quick-extension-surfaces");
			const frame = (value: Record<string, unknown>) => ui.evaluate(`window.ui.receive({type:'omp:chat-event',epoch:window.ui.current().epoch,frame:${JSON.stringify(value)}})`);
			await frame({ type: "ui_widget", key: "build", lines: ["Build: <b>green</b>", "2 warnings"] });
			await frame({ type: "ui_widget", key: "hint", lines: ["below the editor"], placement: "belowEditor" });
			await ui.wait("document.querySelectorAll('.omp-extension-widget').length===2");
			const placed = await ui.evaluate<{ above: string[]; below: string[]; markup: number; aboveFirst: boolean }>(`(()=>{
			 const above=document.querySelector('.omp-extension-widgets--aboveEditor'),below=document.querySelector('.omp-extension-widgets--belowEditor'),input=document.querySelector('.omp-composer textarea');
			 return {above:[...above.querySelectorAll('.omp-extension-widget-line')].map(node=>node.textContent),below:[...below.querySelectorAll('.omp-extension-widget-line')].map(node=>node.textContent),
			  markup:above.querySelectorAll('b').length,aboveFirst:Boolean(above.compareDocumentPosition(input)&Node.DOCUMENT_POSITION_FOLLOWING)&&Boolean(input.compareDocumentPosition(below)&Node.DOCUMENT_POSITION_FOLLOWING)};
			})()`);
			assert.deepEqual(placed, { above: ["Build: <b>green</b>", "2 warnings"], below: ["below the editor"], markup: 0, aboveFirst: true });
			await frame({ type: "ui_widget", key: "build", lines: null });
			await ui.wait("document.querySelectorAll('.omp-extension-widget').length===1");
			await frame({ type: "ui_notify", level: "warning", message: "Index is stale" });
			await ui.wait("document.querySelector('.omp-extension-notice--warning')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-extension-notice-text').textContent"), "Index is stale");
			await ui.evaluate("document.querySelector('.omp-extension-notice [aria-label=\"Dismiss notice\"]').click()");
			await ui.wait("!document.querySelector('.omp-extension-notice')");
			await frame({ type: "ui_notify", level: "info", message: "Index rebuilt" });
			await ui.wait("document.querySelector('.omp-extension-notice--info .omp-extension-notice-text')?.textContent==='Index rebuilt'");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Alt+click on the model or thinking level cycles through the host, and Compact in the context popover asks the host", async () => {
			await reset("quick-footer-actions");
			const commands = () => ui.evaluate<string[]>("window.sent.filter(message=>message.type==='omp:chat-command').map(message=>message.command)");
			const altClick = async (selector: string) => {
				const box = await ui.evaluate<{ x: number; y: number }>(`(()=>{const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()`);
				await ui.call("Input.dispatchMouseEvent", { type: "mousePressed", ...box, button: "left", clickCount: 1, modifiers: 1 });
				await ui.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...box, button: "left", clickCount: 1, modifiers: 1 });
			};
			const pickerRequests = await ui.evaluate<number>("window.ui.requests().length");
			await altClick(".omp-footer-trigger:not(.omp-footer-trigger--level)");
			await altClick(".omp-footer-trigger--level");
			assert.deepEqual(await commands(), ["cycle-model", "cycle-thinking"]);
			assert.equal(await ui.evaluate("window.ui.requests().length"), pickerRequests, "Alt+click opens no picker");
			assert.equal(await ui.evaluate("document.querySelector('.omp-context-popover')"), null);
			await ui.evaluate("document.querySelector('.omp-context-trigger').focus()");
			await ui.wait("document.querySelector('.omp-context-compact')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-context-compact').disabled"), false);
			await ui.evaluate("document.querySelector('.omp-context-compact').click()");
			assert.deepEqual(await commands(), ["cycle-model", "cycle-thinking", "compact"]);
			await ui.wait("!document.querySelector('.omp-context-popover')");
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus();window.ui.push({working:true,settled:false})");
			await ui.wait("document.querySelector('[aria-label=\"Stop the running turn\"]')");
			await ui.evaluate("document.querySelector('.omp-context-trigger').focus()");
			await ui.wait("document.querySelector('.omp-context-compact')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-context-compact').disabled"), true, "no compaction while a turn runs");
			assert.equal(await ui.evaluate("document.querySelector('.omp-context-compact').title"), "Compact after the running turn ends.");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the host's thinking and tool defaults open or close every block once, and a block changed afterwards keeps its own state", async () => {
			await reset("quick-transcript-defaults");
			const prefs = (thinkingExpanded: boolean, toolsExpanded: boolean) => ui.evaluate(`window.ui.receive({type:'omp:chat-display-preferences',epoch:window.ui.current().epoch,toolCallDetail:'overview',accessibilitySupport:false,thinkingExpanded:${thinkingExpanded},toolsExpanded:${toolsExpanded}})`);
			await ui.evaluate(`const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.ui.push({entries:[row('u1',{role:'user',timestamp:1,content:'Look'}),
			  row('a1',{role:'assistant',model:'m',timestamp:2,stopReason:'toolUse',content:[{type:'thinking',thinking:'Private chain'},{type:'toolCall',id:'only-read',name:'read',arguments:{path:'src/a.ts'}}]}),
			  row('r1',{role:'toolResult',toolCallId:'only-read',toolName:'read',timestamp:3,isError:false,content:[{type:'text',text:'file body'}]}),
			  row('a2',{role:'assistant',model:'m',timestamp:4,stopReason:'stop',content:[{type:'text',text:'Read it'}]})],durableCount:4,working:false,settled:true})`);
			await ui.wait("document.querySelector('.omp-thinking') && document.querySelector('[data-tool-name=\"read\"] .omp-tool-head')");
			const facts = () => ui.evaluate<{ thinking: boolean; tool: string | null }>("({thinking:document.querySelector('.omp-thinking').open,tool:document.querySelector('[data-tool-name=\"read\"] .omp-tool-head').getAttribute('aria-expanded')})");
			assert.deepEqual(await facts(), { thinking: false, tool: "false" }, "closed and collapsed by default");
			await prefs(true, false);
			await ui.wait("document.querySelector('.omp-thinking').open");
			assert.equal((await facts()).tool, "false", "the thinking default leaves tools alone");
			await prefs(true, true);
			await ui.wait("document.querySelector('[data-tool-name=\"read\"] .omp-tool-head').getAttribute('aria-expanded')==='true'");
			await ui.evaluate("document.querySelector('[data-tool-name=\"read\"] .omp-tool-head').click()");
			await ui.wait("document.querySelector('[data-tool-name=\"read\"] .omp-tool-head').getAttribute('aria-expanded')==='false'");
			await ui.evaluate("document.querySelector('.omp-thinking').open=false");
			await prefs(true, true);
			assert.deepEqual(await facts(), { thinking: false, tool: "false" }, "an unchanged default does not undo the user's own choice");
			await prefs(false, false);
			await prefs(true, true);
			await ui.wait("document.querySelector('.omp-thinking').open && document.querySelector('[data-tool-name=\"read\"] .omp-tool-head').getAttribute('aria-expanded')==='true'");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		// Rewind (ADR-0051): two turns; the second edits a file and runs a command, so its preview has consequences.
		const rewindAt = (n: number): string => new Date(Date.UTC(2026, 9, 9, 10, 0, n)).toISOString();
		const rewindMessage = (id: string, parentId: string | null, n: number, message: Record<string, unknown>) => ({ type: "message", id, parentId, timestamp: rewindAt(n), message: { timestamp: n, ...message } });
		const rewindReply = (id: string, parentId: string, n: number, text: string) => rewindMessage(id, parentId, n, { role: "assistant", model: "m", stopReason: "stop", content: [{ type: "text", text }] });
		const rewindCall = (id: string, parentId: string, n: number, callId: string, name: string, args: Record<string, unknown>) =>
			rewindMessage(id, parentId, n, { role: "assistant", model: "m", stopReason: "toolUse", content: [{ type: "toolCall", id: callId, name, arguments: args }] });
		const rewindResult = (id: string, parentId: string, n: number, callId: string, name: string) =>
			rewindMessage(id, parentId, n, { role: "toolResult", toolCallId: callId, toolName: name, isError: false, content: [{ type: "text", text: "ok" }] });
		const rewindRows = [
			rewindMessage("u1", null, 1, { role: "user", content: "first prompt\nwith a second line" }),
			rewindReply("a1", "u1", 2, "First answer"),
			rewindMessage("u2", "a1", 3, { role: "user", content: "fix the parser" }),
			rewindCall("c1", "u2", 4, "edit-1", "edit", { path: "src/parser.ts" }),
			rewindResult("r1", "c1", 5, "edit-1", "edit"),
			rewindCall("c2", "r1", 6, "bash-1", "bash", { command: "npm test" }),
			rewindResult("r2", "c2", 7, "bash-1", "bash"),
			rewindReply("a2", "r2", 8, "Second answer"),
		];
		/** The catalog entry the host-control module registers; without it the page says Rewind is unsupported. */
		const navigateCatalog = [{ name: "omp-desk-navigate", source: "extension", description: "OMP Desk navigation" }];
		const pushRewind = (patch: Record<string, unknown> = {}): Promise<unknown> => ui.evaluate(`(()=>{
		 window.rewindRow=text=>[...document.querySelectorAll('.omp-transcript .omp-row')].filter(row=>row.textContent.includes(text)).at(-1);
		 window.rewindState=text=>{const row=window.rewindRow(text);return row.classList.contains('omp-row--rewind-selected')?'selected':row.classList.contains('omp-row--rewind-dimmed')?'dimmed':''};
		 window.ui.push(${JSON.stringify({ entries: rewindRows, durableCount: rewindRows.length, leafId: "a2", branches: [], commands: navigateCatalog, working: false, settled: true, ...patch })});
		})()`);
		type SentNavigation = { type: string; requestId: string; kind: string; targetId: string; expectedLeafId: string | null; summarize: boolean };
		const navigations = (): Promise<SentNavigation[]> => ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-navigate')");
		const answerNavigation = (answer: Record<string, unknown>): Promise<unknown> => ui.evaluate(`(()=>{
		 const request=window.sent.filter(message=>message.type==='omp:chat-navigate').at(-1);
		 window.ui.receive({type:'omp:chat-navigate-result',requestId:request.requestId,...${JSON.stringify(answer)}});
		})()`);
		const pickedPreview = (): Promise<string | null> => ui.evaluate("document.querySelector('.omp-rewind-bar--picking .omp-rewind-target')?.textContent ?? null");
		const barFocused = "document.activeElement?.classList.contains('omp-rewind-bar--picking')";
		const startFromRow = async (index: number): Promise<void> => {
			await ui.evaluate(`document.querySelectorAll('[aria-label="Rewind to here"]')[${index}].click()`);
			await ui.wait(barFocused);
		};

		await t.test("Rewind to here enters picking: the bar previews what leaves the branch, later rows dim, keys move, Enter/Shift+Enter/summarize send and Esc cancels", async () => {
			await reset("rewind-picking");
			await pushRewind();
			await ui.wait("document.querySelectorAll('[aria-label=\"Rewind to here\"]').length===2");
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('[aria-label=\"Rewind to here\"]')].map(button=>button.closest('.omp-row').classList.contains('omp-row--user'))"), [true, true], "only the user's prompts offer it");
			// The action sits in the row's hover actions: hidden until the pointer is over the prompt.
			const actionsOpacity = async (): Promise<string> => {
				await settleFrames();
				return ui.evaluate("getComputedStyle(window.rewindRow('fix the parser').querySelector('.omp-row-actions')).opacity");
			};
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
			assert.equal(await actionsOpacity(), "0");
			const rowBox = await ui.evaluate<{ x: number; y: number }>("(()=>{const row=window.rewindRow('fix the parser');row.scrollIntoView({block:'center'});const r=row.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()");
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...rowBox });
			assert.equal(await actionsOpacity(), "1", "hovering the prompt shows its actions");
			const buttonBox = await ui.evaluate<{ x: number; y: number }>("(()=>{const r=window.rewindRow('fix the parser').querySelector('[aria-label=\"Rewind to here\"]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()");
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...buttonBox });
			await ui.call("Input.dispatchMouseEvent", { type: "mousePressed", ...buttonBox, button: "left", clickCount: 1 });
			await ui.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...buttonBox, button: "left", clickCount: 1 });
			await ui.wait(`document.querySelector('.omp-rewind-bar--picking') && ${barFocused}`);
			const leaving = (id: string): number => rewindPreview(rewindRows as unknown as ChatEntry[], id)!.messages;
			assert.equal(await ui.evaluate("document.querySelector('.omp-rewind-title').textContent"), `Rewind to: fix the parser · ${leaving("u2")} messages leave this branch`);
			assert.equal(await ui.evaluate("document.querySelector('.omp-rewind-files').textContent"), "Files changed after this point stay as they are: src/parser.ts · 1 command ran after it");
			const states = (): Promise<Record<string, string>> => ui.evaluate("Object.fromEntries(['first prompt','First answer','fix the parser','Second answer'].map(text=>[text,window.rewindState(text)]))");
			assert.deepEqual(await states(), { "first prompt": "", "First answer": "", "fix the parser": "selected", "Second answer": "dimmed" });
			assert.equal(await ui.evaluate("window.rewindRow('fix the parser').getAttribute('aria-current')"), "true");
			assert.equal(await ui.evaluate("getComputedStyle(window.rewindRow('Second answer')).opacity"), "0.45");
			// The bar owns the keyboard while picking.
			await press("ArrowUp", "ArrowUp", 38);
			await ui.wait("document.querySelector('.omp-rewind-target').textContent==='first prompt'");
			assert.equal(await ui.evaluate("document.querySelector('.omp-rewind-title').textContent"), `Rewind to: first prompt · ${leaving("u1")} messages leave this branch`);
			assert.deepEqual(await states(), { "first prompt": "selected", "First answer": "dimmed", "fix the parser": "dimmed", "Second answer": "dimmed" });
			await press("End", "End", 35);
			await ui.wait("document.querySelector('.omp-rewind-target').textContent==='fix the parser'");
			await press("Home", "Home", 36);
			await ui.wait("document.querySelector('.omp-rewind-target').textContent==='first prompt'");
			await press("ArrowDown", "ArrowDown", 40);
			await ui.wait("document.querySelector('.omp-rewind-target').textContent==='fix the parser'");
			await press("ArrowDown", "ArrowDown", 40);
			assert.equal(await pickedPreview(), "fix the parser", "the newest prompt is the end of the list");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0, "moving sends nothing");
			assert.deepEqual(await navigations(), []);
			// Enter rewinds against the leaf the page saw.
			await press("Enter", "Enter", 13);
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-navigate')");
			const [plain] = await navigations();
			assert.match(plain!.requestId, /^[0-9a-f]{32}$/);
			assert.deepEqual({ ...plain, requestId: "" }, { type: "omp:chat-navigate", requestId: "", kind: "rewind", targetId: "u2", expectedLeafId: "a2", summarize: false });
			await ui.wait("document.querySelector('.omp-rewind-bar[role=status]')?.textContent==='Rewinding…'");
			await answerNavigation({ status: "refused", reason: "stale" });
			await ui.wait("document.querySelector('.omp-rewind-bar--notice')?.textContent.includes('The conversation changed meanwhile. Pick the message again.')");
			await ui.evaluate("document.querySelector('[aria-label=\"Dismiss rewind notice\"]').click()");
			await ui.wait("!document.querySelector('.omp-rewind-bar')");
			// Shift+Enter keeps a summary of the abandoned messages.
			await startFromRow(0);
			assert.equal(await pickedPreview(), "first prompt");
			await press("Enter", "Enter", 13, { modifiers: 8 });
			await ui.wait("window.sent.filter(message=>message.type==='omp:chat-navigate').length===2");
			assert.deepEqual((await navigations())[1], { ...(await navigations())[1]!, kind: "rewind", targetId: "u1", expectedLeafId: "a2", summarize: true });
			await ui.wait("document.querySelector('.omp-rewind-bar[role=status]')?.textContent==='Rewinding… Summarizing the abandoned branch can take a while.'");
			await answerNavigation({ status: "refused", reason: "unchanged" });
			await ui.wait("document.querySelector('.omp-rewind-bar--notice')");
			// So does the button.
			await startFromRow(1);
			await ui.evaluate("[...document.querySelectorAll('.omp-rewind-actions button')].find(button=>button.textContent==='Rewind & summarize').click()");
			await ui.wait("window.sent.filter(message=>message.type==='omp:chat-navigate').length===3");
			assert.deepEqual((await navigations())[2], { ...(await navigations())[2]!, kind: "rewind", targetId: "u2", expectedLeafId: "a2", summarize: true });
			await answerNavigation({ status: "refused", reason: "cancelled" });
			await ui.wait("document.querySelector('.omp-rewind-bar--notice')?.textContent.includes('An OMP extension cancelled the rewind.')");
			// Esc leaves picking without sending anything.
			await startFromRow(1);
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-rewind-bar--picking') && !document.querySelector('.omp-row--rewind-dimmed')");
			assert.equal((await navigations()).length, 3);
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0, "Rewind never sends a prompt");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Esc Esc in an empty idle composer and /rewind or /branch alone open Rewind; one Esc, a draft or /branch with arguments do not", async () => {
			await reset("rewind-entry-points");
			await pushRewind();
			await ui.wait("document.querySelectorAll('[aria-label=\"Rewind to here\"]').length===2");
			const composer = "document.querySelector('.omp-composer textarea')";
			const closed = async (): Promise<void> => {
				await settleFrames();
				assert.equal(await ui.evaluate("document.querySelector('.omp-rewind-bar--picking')"), null);
			};
			await ui.evaluate(`${composer}.focus()`);
			await press("Escape", "Escape", 27);
			await closed();
			await ui.call("Input.insertText", { text: "x" });
			await press("Escape", "Escape", 27);
			await press("Escape", "Escape", 27);
			await closed();
			assert.equal(await draftValue(), "x", "a draft is never replaced by Rewind");
			await press("Backspace", "Backspace", 8);
			await ui.wait(`${composer}.value===''`);
			await press("Escape", "Escape", 27);
			await press("Escape", "Escape", 27);
			await ui.wait(`document.querySelector('.omp-rewind-bar--picking') && ${barFocused}`);
			assert.equal(await pickedPreview(), "fix the parser", "picking starts at the newest prompt");
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-rewind-bar--picking')");
			for (const command of ["/rewind", "/branch"]) {
				await ui.evaluate(`${composer}.focus()`);
				await ui.call("Input.insertText", { text: command });
				await ui.evaluate("document.querySelector('[aria-label=\"Send message\"]').click()");
				await ui.wait(`document.querySelector('.omp-rewind-bar--picking') && ${barFocused}`);
				assert.equal(await draftValue(), "", `${command} is consumed`);
				assert.equal(await pickedPreview(), "fix the parser");
				await press("Escape", "Escape", 27);
				await ui.wait("!document.querySelector('.omp-rewind-bar--picking')");
			}
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0, "neither command reaches OMP");
			await ui.evaluate(`${composer}.focus()`);
			await ui.call("Input.insertText", { text: "/branch foo" });
			await ui.evaluate("document.querySelector('[aria-label=\"Send message\"]').click()");
			await ui.wait(`document.querySelector('.omp-dock').innerText.includes(${JSON.stringify(REWIND_ARGUMENTS_SENTENCE)})`);
			assert.equal(await draftValue(), "/branch foo", "with arguments it is not Rewind: the page refuses it and keeps the draft");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0);
			await closed();
			assert.deepEqual(await navigations(), []);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a rewound prompt fills an empty composer, a typed draft moves to a recovery card, and Undo returns and takes the unedited prompt back", async () => {
			await reset("rewind-draft");
			await pushRewind();
			await ui.wait("document.querySelectorAll('[aria-label=\"Rewind to here\"]').length===2");
			await startFromRow(1);
			await press("Enter", "Enter", 13);
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-navigate')");
			await answerNavigation({ status: "done", kind: "rewind", summarized: false, draft: { text: "fix the parser", images: [], unavailableImages: 0 } });
			await ui.wait("document.querySelector('.omp-composer textarea').value==='fix the parser' && !document.querySelector('.omp-rewind-bar')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-attach-error')"), null, "an empty composer has nothing to keep");
			// OMP's rewound branch: the target's parent, then the marker, which is the leaf.
			const marker = { type: "custom", id: "m1", parentId: "a1", timestamp: rewindAt(9), customType: "omp-desk/navigation",
				data: { v: 1, requestId: "0123456789abcdef0123456789abcdef", kind: "rewind", from: "a2", target: "u2", to: "a1", summarized: false } };
			await pushRewind({ entries: [...rewindRows.slice(0, 2), marker], durableCount: 3, leafId: "m1" });
			await ui.wait("document.querySelector('.omp-rewind-bar--undo')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-rewind-bar--undo').textContent"), "RewoundUndo");
			await ui.evaluate("[...document.querySelectorAll('.omp-rewind-bar--undo button')].find(button=>button.textContent==='Undo').click()");
			await ui.wait("window.sent.filter(message=>message.type==='omp:chat-navigate').length===2");
			assert.deepEqual((await navigations())[1], { ...(await navigations())[1]!, kind: "undo", targetId: "a2", expectedLeafId: "m1", summarize: false });
			await ui.wait("document.querySelector('.omp-rewind-bar[role=status]')?.textContent==='Undoing the rewind…'");
			await answerNavigation({ status: "done", kind: "undo", summarized: false });
			await ui.wait("document.querySelector('.omp-composer textarea').value===''");
			// Back on the original branch, with a draft of the user's own.
			await pushRewind();
			await ui.wait("!document.querySelector('.omp-rewind-bar') && document.querySelectorAll('[aria-label=\"Rewind to here\"]').length===2");
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text: "my own draft" });
			await startFromRow(0);
			await press("Enter", "Enter", 13);
			await ui.wait("window.sent.filter(message=>message.type==='omp:chat-navigate').length===3");
			assert.deepEqual((await navigations())[2], { ...(await navigations())[2]!, kind: "rewind", targetId: "u1", expectedLeafId: "a2", summarize: false });
			await answerNavigation({ status: "done", kind: "rewind", summarized: false, draft: { text: "first prompt\nwith a second line", images: [], unavailableImages: 0 } });
			await ui.wait("document.querySelector('.omp-composer textarea').value==='first prompt\\nwith a second line'");
			await ui.wait("document.querySelector('.omp-attach-error details pre')");
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-attach-error')].map(card=>({reason:card.firstElementChild.textContent,text:card.querySelector('details pre').textContent}))"),
				[{ reason: "Your draft from before the rewind. Add it to the draft only when you want it back.", text: "my own draft" }], "the earlier draft is kept, not overwritten");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a branch marker after the card holding a branch point switches branches, and an unavailable Rewind says why instead of offering it", async () => {
			await reset("rewind-branches");
			const branches = [{ entryId: "a1", branches: [{ tipId: "old-a", firstPromptId: "old-u", firstPrompt: "an older idea", messages: 2, prompts: 1 }] }];
			await pushRewind({ branches });
			await ui.wait("document.querySelector('.omp-branch-point-toggle')");
			const placement = await ui.evaluate<{ count: number; label: string; row: string; afterBody: boolean }>(`(()=>{
			 const toggle=document.querySelector('.omp-branch-point-toggle'),row=toggle.closest('.omp-row');
			 return {count:document.querySelectorAll('.omp-branch-point').length,label:toggle.textContent,row:row.textContent.includes('First answer')&&!row.textContent.includes('fix the parser')?'a1':'other',
			  afterBody:row.textContent.indexOf('First answer')<row.textContent.indexOf('other branch')};
			})()`);
			assert.deepEqual(placement, { count: 1, label: "1 other branch · 2 messages", row: "a1", afterBody: true });
			await ui.evaluate("document.querySelector('.omp-branch-point-toggle').click()");
			await ui.wait("document.querySelector('.omp-branch-point-toggle').getAttribute('aria-expanded')==='true' && document.querySelector('.omp-branch-switch')");
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-branch-switch')].map(button=>({name:button.querySelector('.omp-branch-name').textContent,size:button.querySelector('.omp-branch-size').textContent,disabled:button.disabled}))"),
				[{ name: "an older idea", size: "2 messages", disabled: false }]);
			await ui.evaluate("document.querySelector('.omp-branch-switch').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-navigate')");
			assert.deepEqual((await navigations())[0], { ...(await navigations())[0]!, kind: "switch", targetId: "old-a", expectedLeafId: "a2", summarize: false });
			await ui.wait("document.querySelector('.omp-rewind-bar[role=status]')?.textContent==='Switching branch…'");
			await answerNavigation({ status: "done", kind: "switch", summarized: false });
			await ui.wait("!document.querySelector('.omp-rewind-bar')");
			// A turn starts (here: from another window) while picking: the bar keeps the choice but says why it cannot act.
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
			await press("Escape", "Escape", 27);
			await press("Escape", "Escape", 27);
			await ui.wait(`document.querySelector('.omp-rewind-bar--picking') && ${barFocused}`);
			assert.equal(await ui.evaluate("document.querySelector('.omp-rewind-blocked')"), null);
			await pushRewind({ branches, working: true, settled: false });
			const busy = "Rewind is unavailable while OMP is working. Wait for the turn to finish or stop it.";
			await ui.wait(`document.querySelector('.omp-rewind-blocked')?.textContent===${JSON.stringify(busy)}`);
			const offered = (): Promise<string[]> => ui.evaluate("[...document.querySelectorAll('.omp-rewind-bar--picking button')].map(button=>button.textContent)");
			assert.deepEqual(await offered(), ["Cancel"], "the actions give way to the reason");
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-branch-switch')].map(button=>({disabled:button.disabled,title:button.title}))"), [{ disabled: true, title: "Switching is unavailable right now" }]);
			await ui.evaluate(`document.querySelector('.omp-rewind-bar--picking').focus()`);
			await press("Enter", "Enter", 13);
			await press("Enter", "Enter", 13, { modifiers: 8 });
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-rewind-bar--picking')");
			assert.equal((await navigations()).length, 1, "Enter does nothing while it is unavailable");
			assert.equal(await ui.evaluate("document.querySelectorAll('[aria-label=\"Rewind to here\"]').length"), 0, "outside picking no prompt offers it while OMP works");
			// Esc Esc does not open it while OMP works.
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
			await press("Escape", "Escape", 27);
			await press("Escape", "Escape", 27);
			await settleFrames();
			assert.equal(await ui.evaluate("document.querySelector('.omp-rewind-bar--picking')"), null);
			// A chat process started without the navigate command: picking explains, nothing is offered.
			await pushRewind({ branches, commands: [] });
			await ui.wait("document.querySelectorAll('[aria-label=\"Rewind to here\"]').length===0 && !document.querySelector('[aria-label=\"Stop the running turn\"]')");
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
			await press("Escape", "Escape", 27);
			await press("Escape", "Escape", 27);
			const unsupported = "This chat process cannot rewind: it was started by an earlier OMP Desk. Restart the chat to use Rewind.";
			await ui.wait(`document.querySelector('.omp-rewind-blocked')?.textContent===${JSON.stringify(unsupported)}`);
			assert.deepEqual(await offered(), ["Cancel"]);
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-rewind-bar--picking')");
			assert.equal((await navigations()).length, 1);
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

	} finally {
		page?.socket.close();
		if (browser) await browser.call("Browser.close").catch(() => {});
		if (child.exitCode === null) {
			// Bound cleanup of this owned real process, not application timer behavior.
			const grace = Promise.withResolvers<void>();
			const timer = setTimeout(grace.resolve, 3000);
			await Promise.race([once(child, "exit"), grace.promise]);
			clearTimeout(timer);
			if (child.exitCode === null) child.kill();
		}
		browser?.socket.close();
		const closed = Promise.withResolvers<void>();
		server.close(error => error ? closed.reject(error) : closed.resolve());
		await closed.promise;
		await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
