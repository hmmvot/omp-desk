/** The queued-messages row above the composer, rendered by the real React app in an owned headless Chromium. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
const liveState = { model: { provider: "one", id: "old", name: "Original", contextWindow: 1000000 }, thinkingLevel: "low", isStreaming: false, isCompacting: false, queuedMessageCount: 0,
 contextUsage: { tokens: 40700, contextWindow: 1000000, percent: 4.07 } };
let current = { ...snapshotOf(createChatModel(), epoch), phase: "live", state: liveState };
function receive(message) { window.dispatchEvent(new MessageEvent("message", { data: message })); }
function push(patch = {}) { current = { ...current, ...patch }; const parts = splitChatSnapshot(current, "ui-snapshot");
 receive(parts.snapshot); for (const chunk of parts.chunks) receive(chunk);
}
window.ui = {
 token: location.search, current: () => current, receive, push, epoch,
 view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Owned UI session", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); },
 // The host's readback: the queue as OMP reports it, through the same frame the real host forwards.
 queue(steering, followUp) { receive({ type: "omp:chat-event", epoch, frame: { type: "queue_update", queuedMessageCount: steering.length + followUp.length, queuedMessages: { steering, followUp } } }); },
 answer(request, results, at = epoch) { receive({ type: "omp:chat-queue-result", epoch: at, requestId: request.requestId, purpose: request.purpose, results }); },
 removals: () => window.sent.filter(message => message.type === "omp:chat-queue-remove"),
};
const nonce=readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); push({ state: liveState });
`;

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// Skipped when no Chromium-based browser is found; set OMP_TEST_CHROMIUM to point at one.
test("queued messages row: list, cancel, edit, already-sent race and bottom anchor", { skip: browserPath === undefined, timeout: 160_000 }, async t => {
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
		const html = createGuestHtml(webview, extensionUri, "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d", null);
		const nonce = /<script nonce="([^"]+)"/.exec(html)![1]!;
		response.end(html.replace("</head>", `<style nonce="${nonce}">:root {
			--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#dddddd;--vscode-editorWidget-background:#252526;
			--vscode-button-background:#007acc;--vscode-button-foreground:white;--vscode-input-background:#3c3c3c;
			--vscode-input-foreground:#ddd;--vscode-panel-border:#555;--vscode-font-family:Arial;--vscode-font-size:13px;
		}</style><script nonce="${nonce}">window.sent=[];window.errors=[];window.addEventListener("error",event=>window.errors.push(event.message));
		window.acquireVsCodeApi=()=>({postMessage(message){window.sent.push(message);document.dispatchEvent(new Event("fixture-post"))},setState(){}});</script>
		</head>`));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/`;
	const profile = await mkdtemp(join(tmpdir(), "omp-queued-messages-ui-"));
	const child = spawn(browserPath!, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
		"--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
	let browser: Cdp | undefined;
	let page: Cdp | undefined;
	try {
		const readiness = Promise.withResolvers<string>();
		let stderr = "";
		// A launch-failure bound only. It is generous: the browser suites start Chromium at once, beside the broker
		// end-to-end tests, and a loaded CI runner took over 20 s.
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
		await ui.call("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
		async function open(name: string): Promise<void> {
			const loaded = ui.event("Page.loadEventFired");
			await ui.call("Page.navigate", { url: `${url}?${name}` });
			await loaded;
			await ui.wait(`window.ui?.token === '?${name}' && document.querySelector('#root').firstElementChild`);
		}
		const history = `(()=>{const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
		 return Array.from({length:14},(_,i)=>i%2===0?row('u'+i,{role:'user',timestamp:1000+i,content:'Prompt '+i}):row('a'+i,{role:'assistant',model:'m',timestamp:1000+i,stopReason:'stop',content:[{type:'text',text:'Reply '+i+'\\n\\n'+Array.from({length:6},(_,line)=>'Line '+i+'.'+line+' of readable history text.').join('\\n\\n')}]}))})()`;
		const frames = "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))";
		// The scroll controller's wheel intent expires on the platform clock (250 ms), outside the test's control; no event signals its end.
		const sleep = (ms: number) => ui.evaluate(`new Promise(r=>setTimeout(r,${ms}))`);
		const settle = () => ui.evaluate(`(async()=>{const root=document.querySelector('.omp-transcript');let previous='',stable=0;const deadline=performance.now()+5000;
		 while(stable<3&&performance.now()<deadline){await ${frames};const now=root.scrollHeight+':'+root.clientHeight+':'+root.scrollTop;stable=now===previous?stable+1:0;previous=now}})()`);
		const load = async (name: string) => {
			await open(name);
			await ui.evaluate(`window.ui.push({entries:${history},durableCount:14,working:false,settled:true})`);
			await ui.wait("document.querySelector('.omp-transcript').scrollHeight>1000");
			await settle();
		};
		const rows = () => ui.evaluate<{ kind: string; text: string; title: string; height: number; truncated: boolean }[]>(`[...document.querySelectorAll('.omp-queue-rows > .omp-queue-item:not(.omp-queue-more)')].map(li=>{const text=li.querySelector('.omp-queue-text');return{kind:li.querySelector('.omp-queue-kind')?.textContent??'',text:text.textContent,title:text.title,height:li.getBoundingClientRect().height,truncated:text.scrollWidth>text.clientWidth}})`);
		const LONG = "Please also double check that every one of the generated migration scripts is idempotent, because the last time we ran them twice the second run failed halfway through and left the schema in a state nobody could explain.";
		const typeDraft = async (text: string) => {
			await ui.evaluate("document.querySelector('.omp-composer textarea').focus()");
			await ui.call("Input.insertText", { text });
		};
		const draft = () => ui.evaluate<string>("document.querySelector('.omp-composer textarea').value");

		await t.test("lists the host's queue — steering then follow-up, in order — one truncated line each with the full text in a tooltip, in the dock directly above the composer", async () => {
			await load("queue-list");
			assert.equal(await ui.evaluate("document.querySelector('.omp-queue')"), null, "an empty queue shows no row");
			await ui.evaluate(`window.ui.queue(['fix the lint'],['second\\nline',${JSON.stringify(LONG)}])`);
			await ui.wait("document.querySelectorAll('.omp-queue-rows > .omp-queue-item').length===3");
			const listed = await rows();
			assert.deepEqual(listed.map(row => [row.kind, row.text]), [["Steering", "fix the lint"], ["Follow-up", "second line"], ["Follow-up", LONG]], "steering first, then follow-up, kinds distinguished");
			assert.equal(listed[1]!.title, "second\nline", "the tooltip carries the exact message");
			assert.equal(listed[2]!.title, LONG);
			assert.ok(listed.every(row => row.height <= 20.5), `one line each: ${listed.map(row => row.height)}`);
			assert.equal(listed[2]!.truncated, true, "a long message is cut with an ellipsis, not wrapped");
			assert.equal(listed[0]!.truncated, false);
			const layout = await ui.evaluate<{ inDock: boolean; directlyAbove: boolean; outsideTranscript: boolean; summary: string; width: number; composerWidth: number }>(`(()=>{
			 const queue=document.querySelector('.omp-queue'),dock=document.querySelector('.omp-dock'),composer=document.querySelector('.omp-composer');
			 return{inDock:dock.contains(queue)&&dock.contains(composer),directlyAbove:queue.nextElementSibling===composer,outsideTranscript:!document.querySelector('.omp-transcript').contains(queue),
			  summary:queue.querySelector('.omp-hud-summary').textContent,width:queue.getBoundingClientRect().width,composerWidth:composer.getBoundingClientRect().width}})()`);
			assert.ok(layout.inDock && layout.directlyAbove && layout.outsideTranscript);
			assert.equal(layout.summary, "1 steering · 2 follow-ups");
			assert.ok(layout.width <= 840, "the TODO/Agents rows' column width");
			await ui.evaluate("window.ui.queue([],['first follow-up','second follow-up'])");
			await ui.wait("document.querySelectorAll('.omp-queue-item--followUp').length===2 && !document.querySelector('.omp-queue-kind')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-state-queued')"), null, "the queue has no duplicate footer chip");
			assert.deepEqual((await rows()).map(row => row.text), ["first follow-up", "second follow-up"], "follow-up-only rows keep message content without repeated prefixes");
			await ui.evaluate("window.ui.queue([],[])");
			await ui.wait("document.querySelector('.omp-queue') === null");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("sits after the TODO and Agents rows in the same column, styled like them", async () => {
			await ui.evaluate(`window.ui.push({todoSeed:[{name:'Plan',tasks:[{content:'Current work',status:'in_progress'}]}]});window.ui.queue([],['next thing'])`);
			await ui.wait("document.querySelector('.omp-hud--todo') && document.querySelector('.omp-queue')");
			const same = await ui.evaluate<{ order: boolean; left: number[]; right: number[]; font: string[]; head: number[]; hover: string[] }>(`(()=>{
			 const hud=document.querySelector('.omp-hud-stack'),queue=document.querySelector('.omp-queue');const a=hud.getBoundingClientRect(),b=queue.getBoundingClientRect();
			 const title=getComputedStyle(document.querySelector('.omp-hud--todo .omp-hud-toggle')),mine=getComputedStyle(queue.querySelector('.omp-queue-title'));
			 const hover=selector=>[...document.styleSheets].flatMap(sheet=>[...sheet.cssRules]).filter(rule=>rule.selectorText&&rule.selectorText.split(',').some(part=>part.trim()===selector)).map(rule=>rule.style.background);
			 return{order:Boolean(hud.compareDocumentPosition(queue)&Node.DOCUMENT_POSITION_FOLLOWING),left:[a.left,b.left],right:[a.right,b.right],font:[title.fontSize,mine.fontSize],
			  head:[document.querySelector('.omp-hud--todo .omp-hud-head').getBoundingClientRect().height,queue.querySelector('.omp-queue-head').getBoundingClientRect().height],hover:hover('.omp-queue-action:hover:not(:disabled)')}})()`);
			assert.ok(same.order, "after the HUD rows, before the composer");
			assert.ok(Math.abs(same.left[0]! - same.left[1]!) <= 1 && Math.abs(same.right[0]! - same.right[1]!) <= 1, "the same column");
			assert.equal(same.font[0], same.font[1]);
			assert.equal(same.head[0], same.head[1], "the same header height");
			assert.ok(same.hover.some(value => value.includes("--vscode-list-hoverBackground")), "the same hover background");
			await ui.evaluate("window.ui.push({todoSeed:[]});window.ui.queue([],[])");
		});

		await t.test("Remove sends one cancel naming the message's queue and exact text; the row follows the host's readback, not the click", async () => {
			await load("queue-cancel");
			await ui.evaluate(`window.ui.queue(['steer me'],['keep\\nthis','drop this one'])`);
			await ui.wait("document.querySelectorAll('.omp-queue-remove').length===3");
			await ui.evaluate("document.querySelectorAll('.omp-queue-remove')[2].click()");
			const [request] = await ui.evaluate<{ requestId: string; purpose: string; epoch: unknown; items: unknown }[]>("window.ui.removals()");
			assert.equal(request!.purpose, "cancel");
			assert.deepEqual(request!.items, [{ queue: "followUp", text: "drop this one" }]);
			assert.deepEqual(request!.epoch, { nonce: "host-ui-test", counter: 1 });
			assert.equal(await ui.evaluate("window.sent.filter(message=>/^omp:chat-(prompt|steer|follow-up)$/.test(message.type)).length"), 0, "a cancel never sends a prompt");
			assert.equal(await ui.evaluate("[...document.querySelectorAll('.omp-queue-action')].every(button=>button.disabled)"), true, "buttons wait for the host's answer");
			assert.equal((await rows()).length, 3, "the row is still listed until the host's readback drops it");
			await ui.evaluate("window.ui.answer(window.ui.removals()[0],[{status:'removed'}]);window.ui.queue(['steer me'],['keep\\nthis'])");
			await ui.wait("document.querySelectorAll('.omp-queue-rows > .omp-queue-item').length===2 && !document.querySelector('.omp-queue-remove').disabled");
			assert.equal(await ui.evaluate("document.querySelector('.omp-queue-status')"), null, "a clean removal says nothing");
			assert.equal(await draft(), "", "nothing goes into the composer");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a message OMP delivered between the click and the command is reported as already sent, never silently dropped", async () => {
			await ui.evaluate("document.querySelectorAll('.omp-queue-remove')[1].click()");
			await ui.evaluate("window.ui.answer(window.ui.removals().at(-1),[{status:'gone'}])");
			await ui.wait("document.querySelector('.omp-queue-status')");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-queue-status').textContent"), /1 queued message was already sent or is no longer queued, so it could not be removed\./);
			assert.equal(await ui.evaluate("document.querySelector('.omp-queue-status').getAttribute('role')"), "status");
			assert.equal(await draft(), "", "an already-sent message is not duplicated into the composer");
			await ui.evaluate("window.ui.queue(['steer me'],[])");
			await ui.wait("document.querySelectorAll('.omp-queue-rows > .omp-queue-item').length===1");
			assert.ok(await ui.evaluate("Boolean(document.querySelector('.omp-queue-status'))"), "the notice outlives the list change until dismissed");
			await ui.evaluate("document.querySelector('.omp-queue-status .omp-queue-action').click()");
			await ui.wait("document.querySelector('.omp-queue-status') === null");
		});

		await t.test("Edit appends the message to an existing draft and keeps what was typed", async () => {
			await load("queue-edit");
			await ui.evaluate(`window.ui.queue([],['rework the intro','second one'])`);
			await ui.wait("document.querySelectorAll('.omp-queue-edit').length===2");
			await typeDraft("my half-typed idea");
			assert.equal(await draft(), "my half-typed idea");
			await ui.evaluate("document.querySelectorAll('.omp-queue-edit')[0].click()");
			const [request] = await ui.evaluate<{ purpose: string; items: unknown }[]>("window.ui.removals()");
			assert.equal(request!.purpose, "edit");
			assert.deepEqual(request!.items, [{ queue: "followUp", text: "rework the intro" }]);
			assert.equal(await draft(), "my half-typed idea", "nothing moves until OMP removed the message");
			// The conversation's epoch moved while the command ran (any reconcile does that); the answer carries the request's own epoch and is still honoured.
			await ui.evaluate("window.ui.answer(window.ui.removals()[0],[{status:'removed'}],{nonce:'other-epoch',counter:99});window.ui.queue([],['second one'])");
			await ui.wait("document.querySelector('.omp-composer textarea').value.includes('rework the intro')");
			assert.equal(await draft(), "my half-typed idea\n\nrework the intro", "appended after the draft, not overwriting it");
			assert.equal(await ui.evaluate("document.activeElement===document.querySelector('.omp-composer textarea')"), true, "focus moves to the composer");
			assert.equal(await ui.evaluate("window.sent.filter(message=>/^omp:chat-(prompt|steer|follow-up)$/.test(message.type)).length"), 0, "editing sends nothing");
			assert.deepEqual((await rows()).map(row => row.text), ["second one"]);
		});

		await t.test("Edit into an empty composer puts the text there, and a message with an image re-attaches it under a fresh marker that sends", async () => {
			await load("queue-edit-image");
			await ui.evaluate(`window.ui.queue([],['compare [Image #1, 1x1] please'])`);
			await ui.wait("document.querySelector('.omp-queue-edit')");
			await ui.evaluate("document.querySelector('.omp-queue-edit').click()");
			await ui.evaluate(`window.ui.answer(window.ui.removals()[0],[{status:'removed',images:[{type:'image',mimeType:'image/png',data:'${PNG}'}]}]);window.ui.queue([],[])`);
			await ui.wait("document.querySelector('.omp-composer textarea').value.includes('compare')");
			assert.equal(await draft(), "compare [Image #1, 1x1] please");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-attachment').length"), 1, "the image is attached again");
			await ui.evaluate("document.querySelector('button[aria-label=\"Send message\"]').click()");
			const sent = await ui.evaluate<{ type: string; text: string; images: { mimeType: string; data: string }[] }>("window.sent.filter(message=>message.type==='omp:chat-prompt').at(-1)");
			assert.equal(sent.text, "compare [Image #1, 1x1] please");
			assert.deepEqual(sent.images.map(image => [image.mimeType, image.data]), [["image/png", PNG]]);
		});

		await t.test("Edit all dequeues every message in order into the composer, after the draft, and reports the ones already sent", async () => {
			await load("queue-edit-all");
			await ui.evaluate(`window.ui.queue(['s1'],['f1','f2'])`);
			await ui.wait("document.querySelector('.omp-queue-all')");
			await typeDraft("draft");
			await ui.evaluate("document.querySelector('.omp-queue-all').click()");
			const [request] = await ui.evaluate<{ purpose: string; items: unknown }[]>("window.ui.removals()");
			assert.equal(request!.purpose, "edit");
			assert.deepEqual(request!.items, [{ queue: "steering", text: "s1" }, { queue: "followUp", text: "f1" }, { queue: "followUp", text: "f2" }]);
			await ui.evaluate("window.ui.answer(window.ui.removals()[0],[{status:'removed'},{status:'gone'},{status:'removed'}]);window.ui.queue([],[])");
			await ui.wait("document.querySelector('.omp-queue-status')");
			assert.equal(await draft(), "draft\n\ns1\n\nf2", "only what OMP removed, in queue order, after the draft");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-queue-status').textContent"), /1 queued message was already sent or is no longer queued, so it could not be edited\./);
		});

		await t.test("a removal OMP never confirmed keeps the text reachable in the notice", async () => {
			await load("queue-unknown");
			await ui.evaluate(`window.ui.queue([],['maybe gone'])`);
			await ui.wait("document.querySelector('.omp-queue-edit')");
			await ui.evaluate("document.querySelector('.omp-queue-edit').click()");
			await ui.evaluate("window.ui.answer(window.ui.removals()[0],[{status:'unknown'}])");
			await ui.wait("document.querySelector('.omp-queue-status')");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-queue-status').textContent"), /did not confirm/);
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-queue-status').title"), /maybe gone/);
			assert.equal(await draft(), "", "an unconfirmed message is not put in the composer twice");
			assert.equal((await rows()).length, 1, "the list is still the host's readback");
		});

		await t.test("a read-only conversation lists the queue but cannot change it", async () => {
			await load("queue-readonly");
			await ui.evaluate(`window.ui.push({readOnlyReason:'This panel cannot write to the session.'});window.ui.queue(['a'],['b'])`);
			await ui.wait("document.querySelector('.omp-queue-all')?.disabled===true");
			assert.equal(await ui.evaluate("[...document.querySelectorAll('.omp-queue-action,.omp-queue-all')].every(button=>button.disabled)"), true);
			await ui.evaluate("document.querySelector('.omp-queue-remove').click()");
			assert.equal(await ui.evaluate("window.ui.removals().length"), 0);
		});

		await t.test("the row appearing, growing, shrinking and disappearing keeps the transcript's bottom line fixed against the dock, following and detached", async () => {
			await load("queue-anchor");
			const probe = (key: string) => `(()=>{const dock=document.querySelector('.omp-dock').getBoundingClientRect().top,root=document.querySelector('.omp-transcript'),rootBottom=root.getBoundingClientRect().bottom;
			 const key=${JSON.stringify(key)};const rows=[...root.querySelectorAll('[data-anchor-key]')];
			 const target=key?rows.find(row=>row.dataset.anchorKey===key):rows.filter(row=>row.getBoundingClientRect().top<rootBottom).at(-1);
			 const rect=target.getBoundingClientRect();return{key:target.dataset.anchorKey,offset:rect.top-dock,dock,tail:Math.abs(root.scrollHeight-root.clientHeight-root.scrollTop)<=1,btn:Boolean(document.querySelector('.omp-jump-latest'))}})()`;
			for (const mode of ["following", "detached"]) {
				await ui.evaluate("window.ui.queue([],[])");
				await ui.wait("document.querySelector('.omp-queue') === null");
				await settle();
				if (mode === "detached") {
					const point = await ui.evaluate<{ x: number; y: number }>("(()=>{const rect=document.querySelector('.omp-transcript').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()");
					await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
					await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: -130 });
					await ui.wait("document.querySelector('.omp-jump-latest')");
					await sleep(600);
					await settle();
				}
				const base = await ui.evaluate<{ key: string; offset: number; dock: number; btn: boolean }>(probe(""));
				assert.equal(base.btn, mode === "detached");
				const check = async (label: string) => {
					await ui.evaluate(frames); await settle();
					const now = await ui.evaluate<{ offset: number; tail: boolean; btn: boolean; dock: number }>(probe(base.key));
					assert.ok(Math.abs(now.offset - base.offset) <= 1, `${mode}: ${label} moved the bottom line by ${now.offset - base.offset}px`);
					assert.equal(now.btn, mode === "detached", `${mode}: ${label} kept the jump-to-latest state`);
					if (mode === "following") assert.ok(now.tail, `${mode}: ${label} stays pinned to the tail`);
					return now.dock;
				};
				await ui.evaluate("window.ui.queue(['one'],['two','three'])");
				await ui.wait("document.querySelectorAll('.omp-queue-rows > .omp-queue-item').length===3");
				const grown = await check("the row appearing");
				assert.ok(grown < base.dock - 40, `${mode}: the dock grew by the row (${base.dock} -> ${grown})`);
				await ui.evaluate("window.ui.queue([],['three'])");
				await ui.wait("document.querySelectorAll('.omp-queue-rows > .omp-queue-item').length===1");
				await check("the row shrinking");
				await ui.evaluate("document.querySelector('.omp-queue-remove').click()");
				await ui.evaluate("window.ui.answer(window.ui.removals().at(-1),[{status:'gone'}])");
				await ui.wait("document.querySelector('.omp-queue-status')");
				await check("the already-sent notice appearing");
				await ui.evaluate("window.ui.queue([],[])");
				await ui.evaluate("document.querySelector('.omp-queue-status .omp-queue-action').click()");
				await ui.wait("document.querySelector('.omp-queue') === null");
				await check("the row disappearing");
				await ui.evaluate("window.ui.removals().length=0;window.sent.length=0");
				if (mode === "following") assert.equal(await ui.evaluate("document.querySelector('.omp-jump-latest')"), null);
			}
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a long queue folds behind +N more instead of growing the dock without bound, and Edit all still takes everything", async () => {
			await load("queue-cap");
			const many = Array.from({ length: 30 }, (_, index) => `message ${index}`);
			await ui.evaluate(`window.ui.queue([],${JSON.stringify(many)})`);
			await ui.wait("document.querySelector('.omp-queue-more')");
			const shown = await ui.evaluate<{ rows: number; more: string; height: number; viewport: number; scrolling: boolean }>(`(()=>{const queue=document.querySelector('.omp-queue');
			 return{rows:document.querySelectorAll('.omp-queue-rows > .omp-queue-item:not(.omp-queue-more)').length,more:document.querySelector('.omp-queue-more').textContent,height:queue.getBoundingClientRect().height,viewport:innerHeight,
			  scrolling:[...queue.querySelectorAll('*')].some(node=>['auto','scroll'].includes(getComputedStyle(node).overflowY))}})()`);
			assert.equal(shown.more, `+${30 - shown.rows} more`);
			assert.ok(shown.rows <= 5);
			assert.ok(shown.height <= shown.viewport * 0.3, `the row stays within its share of the viewport: ${shown.height}`);
			assert.equal(shown.scrolling, false, "no scroll region");
			await ui.evaluate("document.querySelector('.omp-queue-all').click()");
			assert.equal(await ui.evaluate("window.ui.removals()[0].items.length"), 30, "Edit all names every message, hidden ones included");
		});

		await t.test("Send now promotes one follow-up during a turn by exact reference, and reports one OMP already delivered", async () => {
			await load("queue-promote");
			await ui.evaluate(`window.ui.queue(['steer me'],['urgent one','later one'])`);
			await ui.wait("document.querySelectorAll('.omp-queue-remove').length===3");
			assert.equal(await ui.evaluate("document.querySelector('.omp-queue-promote')"), null, "nothing to promote ahead of while no turn runs");
			await ui.evaluate("window.ui.push({working:true,settled:false});window.ui.queue(['steer me'],['urgent one','later one'])");
			await ui.wait("document.querySelectorAll('.omp-queue-promote').length===2");
			await ui.evaluate("document.querySelectorAll('.omp-queue-promote')[0].click()");
			const [request] = await ui.evaluate<{ purpose: string; items: unknown }[]>("window.ui.removals()");
			assert.equal(request!.purpose, "promote");
			assert.deepEqual(request!.items, [{ queue: "followUp", text: "urgent one" }], "steering is never offered; only the clicked follow-up is named");
			await ui.evaluate("window.ui.answer(window.ui.removals()[0],[{status:'removed'}]);window.ui.queue(['steer me','urgent one'],['later one'])");
			await ui.wait("document.querySelectorAll('.omp-queue-promote').length===1 && !document.querySelector('.omp-queue-promote').disabled");
			assert.equal(await ui.evaluate("document.querySelector('.omp-queue-status')"), null, "a clean promotion says nothing");
			assert.equal(await draft(), "", "Send now never touches the composer");
			await ui.evaluate("document.querySelector('.omp-queue-promote').click()");
			await ui.evaluate("window.ui.answer(window.ui.removals().at(-1),[{status:'gone'}])");
			await ui.wait("document.querySelector('.omp-queue-status')");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-queue-status').textContent"), /already sent or is no longer queued, so it could not be sent now/);
			assert.equal(await ui.evaluate("window.sent.filter(message=>/^omp:chat-(prompt|steer|follow-up)$/.test(message.type)).length"), 0, "promotion sends no new prompt");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Alt+Up in the composer takes the newest queued message back into the draft, after what is typed", async () => {
			await load("queue-alt-up");
			await ui.evaluate(`window.ui.queue(['steer first'],['older follow-up','newest follow-up'])`);
			await ui.wait("document.querySelectorAll('.omp-queue-edit').length===3");
			await typeDraft("typed");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, modifiers: 1 });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, modifiers: 1 });
			const [request] = await ui.evaluate<{ purpose: string; items: unknown }[]>("window.ui.removals()");
			assert.equal(request!.purpose, "edit");
			assert.deepEqual(request!.items, [{ queue: "followUp", text: "newest follow-up" }]);
			await ui.evaluate("window.ui.answer(window.ui.removals()[0],[{status:'removed'}]);window.ui.queue(['steer first'],['older follow-up'])");
			await ui.wait("document.querySelector('.omp-composer textarea').value.includes('newest follow-up')");
			assert.equal(await draft(), "typed\n\nnewest follow-up");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, modifiers: 1 });
			assert.deepEqual((await ui.evaluate<{ items: unknown }[]>("window.ui.removals()")).at(-1)!.items, [{ queue: "followUp", text: "older follow-up" }], "the next press takes the next newest");
			assert.equal(await ui.evaluate("window.sent.filter(message=>/^omp:chat-(prompt|steer|follow-up)$/.test(message.type)).length"), 0);
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
