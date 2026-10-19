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
import { CLEAR_MARKER_TYPE } from "../chat/clear.ts";
import { NAVIGATE_REFUSAL_SENTENCES, rewindPreview } from "../chat/rewind.ts";
import { composeFileBlocks, fileMarker, splitFileBlocks } from "../shared/file-blocks.ts";
import { REWIND_ARGUMENTS_SENTENCE, parseCommands } from "../protocol/rpc.ts";

const browserPath = [process.env.OMP_TEST_CHROMIUM,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));
/** Motion as an unconfigured user has it, independent of the machine running the suite. */
const MOTION_ALLOWED = [{ name: "prefers-reduced-motion", value: "no-preference" }];
/** The `<kbd>` texts of the empty chat, in DOM order, with the manifest's default keys. */
const EMPTY_STATE_KBDS = ["/", "@", "Ctrl+V", "Shift", "↑", "Ctrl+Alt+Y", "Enter", "Alt+Enter", "Alt+↑", "Esc", "Ctrl+F", "Alt+Q", "Esc Esc", "Ctrl+Alt+T", "Ctrl+O", "Alt+Q", "Ctrl+Shift+L", "Ctrl+Alt+Q", "Ctrl+Alt+N"];

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
import { guestTransport, readCspNonce, fixtureBridgeOperation } from "./bridge";
import { ChatClient } from "./lib/chat-client";
import { createChatModel, snapshotOf } from "../chat/model";
import { splitChatSnapshot } from "../protocol/chat-messages";
import { injectGuestStyles } from "./styles";
import { injectShellStyles } from "./lib/terminal-styles";
import { attachSessionView, sessionViewSnapshot } from "./lib/session-view";
import { attachCodeTheme } from "./lib/code-theme-store";
import { attachKeyHints } from "./lib/key-hints-store";
import { attachInsertedText } from "./lib/insert-text";
import { adoptNonceForCreatedStyles } from "./lib/nonce-styles";
import { installFocusTrace } from "./lib/focus-trace";
import { installTypeToFocus } from "./lib/type-to-focus";
import { installComposerDriver } from "./test-support/composer-driver";
import { requestQuote } from "./lib/quote-sink";
import { captureSelection } from "./lib/quote-selection";
installFocusTrace(window, element => element.classList.contains("omp-composer-input"), detail => guestTransport.post({ type: "omp:focus-trace", detail }));
installTypeToFocus(window);
installComposerDriver(window);
window.requestQuote = requestQuote;
window.captureQuote = () => captureSelection(window.getSelection(), document.querySelector(".omp-transcript"));
attachSessionView(guestTransport);
attachCodeTheme(guestTransport);
attachKeyHints(guestTransport);
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
 bridgeOperation: fixtureBridgeOperation,
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
test("compact chat's rendered behavioral boundaries", { skip: browserPath === undefined, timeout: 420_000 }, async t => {
	const bundled = await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") },
		bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' },
		plugins: [{ name: "bridge-operation-test-access", setup(builder) {
			builder.onLoad({ filter: /[/\\]webview[/\\]bridge\.ts$/ }, args => ({
				contents: `${readFileSync(args.path, "utf8")}\nexport { bridgeOperation as fixtureBridgeOperation };`,
				loader: "ts", resolveDir: join(process.cwd(), "src/webview"),
			}));
		} }] });
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
			--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#dddddd;--vscode-foreground:#dddddd;--vscode-editorWidget-background:#252526;
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

		await t.test("Context cleared disclosure hides dropped history, relocates earlier loading and keeps it read-only", async () => {
			await reset("cleared-history", "detailed");
			await ui.evaluate(`(()=>{
			 const entry=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-11T00:00:00Z',message:{timestamp:1,...message}});
			 window.clearedRows=[entry('dropped-user',{role:'user',content:'Dropped prompt'}),
			  entry('dropped-answer',{role:'assistant',model:'m',stopReason:'error',errorMessage:'Durable failure',content:[{type:'text',text:'Dropped answer'}]}),
			  {type:'reset_boundary',id:'clear-boundary',parentId:'dropped-answer',timestamp:'2026-10-11T00:00:01Z'},
			  {type:'custom',id:'clear-marker',parentId:'clear-boundary',timestamp:'2026-10-11T00:00:01Z',customType:${JSON.stringify(CLEAR_MARKER_TYPE)},data:{v:1,requestId:'00112233445566778899aabbccddeeff',boundaryId:'clear-boundary'}},
			  entry('current-user',{role:'user',content:'Current prompt'}),
			  entry('current-answer',{role:'assistant',model:'m',stopReason:'stop',content:[{type:'text',text:'Current answer'}]})];
			 window.ui.push({entries:window.clearedRows,durableCount:6,olderCount:7,working:false,settled:true,
			  commands:[{name:'omp-desk-navigate',source:'extension',description:'OMP Desk navigation'}],
			  branches:[{entryId:'dropped-answer',branches:[{tipId:'old-tip',firstPromptId:'old-prompt',firstPrompt:'Earlier branch',messages:2,prompts:1}]}]});
			})()`);
			await ui.wait("document.querySelector('.omp-cleared-history summary') && document.querySelector('.omp-transcript').textContent.includes('Current answer')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-cleared-history summary').textContent"), "Context cleared · at least 2 messages dropped");
			assert.equal(await ui.evaluate("document.querySelector('.omp-transcript').textContent.includes('Dropped prompt')"), false);
			assert.equal(await ui.evaluate("document.querySelector('.omp-transcript').textContent.includes('Dropped answer')"), false);
			assert.equal(await ui.evaluate("document.querySelector('.omp-earlier')"), null, "disk history is reachable only inside the disclosure");
			assert.equal(await ui.evaluate("document.querySelector('.omp-branch-point-toggle')"), null, "a pre-boundary branch point is not reassigned");
			assert.equal(await ui.evaluate("document.querySelectorAll('[aria-label=\"Rewind to here\"]').length"), 1, "the current prompt retains Rewind");
			await ui.evaluate("document.querySelector('.omp-cleared-history summary').click()");
			await ui.wait("document.querySelector('.omp-cleared-history-cards')?.textContent.includes('Dropped answer')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-cleared-history-cards').textContent.includes('Dropped prompt')"), true);
			assert.equal(await ui.evaluate("document.querySelector('.omp-cleared-history-cards [aria-label=\"Rewind to here\"]')"), null);
			assert.equal(await ui.evaluate("document.querySelector('.omp-cleared-history-cards .omp-reply-footer, .omp-cleared-history-cards .omp-retry-turn')"), null);
			assert.equal(await ui.evaluate("document.querySelector('.omp-cleared-history .omp-earlier button').textContent"), "load earlier messages (7 older)");
			assert.equal(await ui.evaluate("document.querySelector('.omp-transcript-content > .omp-earlier')"), null);
			await ui.evaluate("document.querySelector('.omp-cleared-history .omp-earlier button').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-load-older')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-cleared-history .omp-earlier button').disabled"), true);
			assert.equal(await ui.evaluate("document.querySelector('.omp-cleared-history .omp-earlier button').textContent"), "loading earlier messages…");
			await ui.evaluate(`window.ui.push({entries:[{type:'message',id:'earlier-user',parentId:null,timestamp:'2026-10-10T00:00:00Z',message:{role:'user',timestamp:0,content:'Earlier loaded prompt'}},...window.clearedRows],durableCount:7,olderCount:0})`);
			await ui.wait("document.querySelector('.omp-cleared-history-cards')?.textContent.includes('Earlier loaded prompt')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-cleared-history summary').textContent"), "Context cleared · 3 messages dropped");
			assert.equal(await ui.evaluate("document.querySelector('.omp-earlier')"), null);
			await ui.evaluate("document.querySelector('.omp-cleared-history summary').focus()");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await ui.wait("!document.querySelector('.omp-cleared-history-cards')");
			assert.equal(await ui.evaluate("document.activeElement===document.querySelector('.omp-cleared-history summary')"), true);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Context cleared disclosure survives page unmounts and earlier boundaries do not nest", async () => {
			await reset("cleared-history-pages", "detailed", true);
			await ui.evaluate(`(()=>{
			 const entry=(id,text)=>({type:'message',id,parentId:null,timestamp:'2026-10-11T00:00:00Z',message:{role:'user',timestamp:1,content:text}});
			 const boundary=id=>({type:'reset_boundary',id,parentId:null,timestamp:'2026-10-11T00:00:00Z'});
			 const marker=boundaryId=>({type:'custom',id:'marker-'+boundaryId,parentId:null,timestamp:'2026-10-11T00:00:00Z',customType:${JSON.stringify(CLEAR_MARKER_TYPE)},data:{v:1,requestId:'00112233445566778899aabbccddeeff',boundaryId}});
			 window.ui.push({entries:[entry('old','Old cleared prompt'),boundary('old-clear'),marker('old-clear'),entry('recent','Recently cleared prompt'),boundary('last-clear'),marker('last-clear'),
			  ...Array.from({length:120},(_,index)=>entry('current-'+index,'Current paged prompt '+index))],durableCount:126,olderCount:5,working:false,settled:true});
			})()`);
			await ui.wait("document.querySelector('.omp-history-pages') && document.querySelector('.omp-transcript').textContent.includes('Current paged prompt 119')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-earlier')"), null);
			await ui.evaluate("document.querySelector('.omp-history-pages button').click()");
			await ui.wait("document.querySelector('.omp-cleared-history summary')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-cleared-history summary').textContent"), "Context cleared · 1 messages dropped");
			await ui.evaluate("document.querySelector('.omp-cleared-history summary').click()");
			await ui.wait("document.querySelector('.omp-cleared-history-cards')?.textContent.includes('Recently cleared prompt')");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-cleared-history').length"), 1);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-cleared-history-cards .omp-native-divider').length"), 1, "the earlier boundary is an ordinary divider");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-cleared-history-cards .omp-cleared-history, .omp-cleared-history-cards details').length"), 0, "and not a nested disclosure");
			assert.equal(await ui.evaluate("document.querySelector('.omp-cleared-history-cards').textContent.includes('Old cleared prompt')"), true);
			await ui.evaluate("document.querySelectorAll('.omp-history-pages button')[1].click()");
			await ui.wait("!document.querySelector('.omp-cleared-history')");
			await ui.evaluate("document.querySelector('.omp-history-pages button').click()");
			await ui.wait("document.querySelector('.omp-cleared-history-cards')?.textContent.includes('Recently cleared prompt')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-cleared-history details').open"), true);
			assert.equal(await ui.evaluate("document.querySelector('.omp-cleared-history .omp-earlier button').textContent"), "load earlier messages (5 older)");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

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
			await ui.evaluate("window.composer.focus()");
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
			assert.equal(await ui.evaluate("document.querySelector('.omp-working-status .omp-sr-only').getAttribute('aria-live')"), "polite");
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
				await ui.evaluate("window.composer.focus()");
				await ui.call("Input.insertText", { text });
				await ui.evaluate("document.querySelector('[aria-label=\"Send message\"]').click()");
				await ui.wait("window.composer.value()===''");
				assert.equal(await ui.evaluate("document.querySelector('.omp-turn-progress')"), null, "native settings do not start a turn");
			}
		});

		await t.test("while only background work keeps the turn open the row names the wait and times it from the agent's last message", async () => {
			await reset("background-wait");
			await ui.evaluate(`(() => {
			 const now = Date.now(), iso = at => new Date(at).toISOString();
			 const row = (id, parentId, at, message) => ({ type: 'message', id, parentId, timestamp: iso(at), message: { timestamp: at, ...message } });
			 window.ui.push({ entries: [
			  row('u', null, now - 4_200_000, { role: 'user', content: 'push it' }),
			  row('a', 'u', now - 4_190_000, { role: 'assistant', model: 'm', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call-push', name: 'bash', arguments: { i: 'Хвост лога push', command: 'git push origin main' } }] }),
			  row('r', 'a', now - 4_180_000, { role: 'toolResult', toolCallId: 'call-push', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'Backgrounded as job job-1' }], details: { async: { state: 'running', jobId: 'job-1', type: 'bash' } } }),
			  row('z', 'r', now - 125_000, { role: 'assistant', model: 'm', stopReason: 'stop', content: [{ type: 'text', text: 'Pushing in the background.' }] })
			 ], durableCount: 4, working: false, settled: false, asyncPaused: true, workingIntent: 'Хвост лога push',
			 displayTurns: [{ id: 1, startedAt: now - 4_200_000, completedAt: null, complete: false, memberKeys: [] }] });
			})()`);
			await ui.wait("document.querySelector('.omp-working-status-text').textContent==='Waiting for background job: Хвост лога push'");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-working-status-elapsed').textContent"), /^2m \d\ds$/, "the wait since the agent's last message, not the 1h 10m of the whole turn");
			await ui.evaluate("window.ui.push({working:true,asyncPaused:false})");
			await ui.wait("document.querySelector('.omp-working-status-text').textContent==='Хвост лога push'");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-working-status-elapsed').textContent"), /^1h /, "the agent works again: the normal intent and the turn timer");
			await ui.evaluate("window.ui.push({working:false,asyncPaused:true,uiRequests:[{id:'status-ask',method:'confirm',title:'Proceed?',message:''}]})");
			await ui.wait("document.querySelector('.omp-working-status-text').textContent==='Waiting for your answer'");
		});

		await t.test("a /clear waiting for OMP shows what it waits for until it runs", async () => {
			await reset("clear-pending");
			await ui.evaluate("window.ui.push({clearPending:'unsettled'})");
			await ui.wait("document.querySelector('.omp-footer-feedback[data-clear-pending]')?.textContent.includes('/clear will run when OMP finishes the interrupted turn.')");
			await ui.evaluate("window.ui.push({clearPending:null})");
			await ui.wait("!document.querySelector('.omp-footer-feedback[data-clear-pending]')");
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
			await ui.evaluate("window.composer.focus()");
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
			await ui.wait("document.querySelector('.omp-output-more')");
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
			// Invalidated offscreen closed rows return to the 26px tool-row estimate (within 4px of this fixture's headers).
			assert.ok(await ui.evaluate<number>("Math.abs(document.querySelector('.omp-transcript').scrollHeight-window.regressionAnchor.total)")<=80*4, "spacers retain the tall source rather than losing its several thousand pixels");
			await ui.evaluate("document.querySelector('.omp-transcript').style.fontSize='15px'");
			await ui.settleGeometry(".omp-transcript");
			assert.ok(await ui.evaluate<number>(drift)<=2, "font remeasure stays detached and anchored");
			assert.ok(await ui.evaluate("Boolean(document.querySelector('.omp-jump-latest'))"));
			await ui.evaluate("document.querySelector('.omp-output-more').click()");
			await ui.wait("document.querySelector('.omp-window')");
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

		await t.test("large read, command and diff output rest as a 12-row preview with exact markers, Show all reveals it in outer flow, Collapse closes and a re-open starts at the preview", async () => {
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
				await ui.wait("document.querySelector('.omp-output-marker')");
				const preview = await ui.evaluate<string>("document.querySelector('.omp-tool-body').textContent");
				if (name === "bash") {
					assert.match(preview, /OUTPUT_LINE_499_END/); assert.match(preview, /OUTPUT_LINE_488_END/); assert.doesNotMatch(preview, /OUTPUT_LINE_487_END/);
					assert.match(preview, /… \(488 earlier lines, showing 12 of 500\)/, "a command's preview is its tail, with the marker on top");
				} else {
					assert.match(preview, /OUTPUT_LINE_0_END/); assert.match(preview, /OUTPUT_LINE_11_END/); assert.doesNotMatch(preview, /OUTPUT_LINE_12_END/);
					assert.match(preview, /… 488 more lines/, "everything else previews its head, with the marker below");
				}
				assert.match(preview, /Show all 500 lines/);
				assert.equal(await ui.evaluate("Array.from(document.querySelector('.omp-transcript').querySelectorAll('*')).some(node=>/auto|scroll/.test(getComputedStyle(node).overflowY))"), false);
				// A real pointer press moves focus into the body first; Show all must still apply while that focus holds the body.
				const button = await ui.evaluate<{ x: number; y: number }>("(()=>{const b=document.querySelector('.omp-output-more').getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2}})()");
				await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: button.x, y: button.y });
				await ui.call("Input.dispatchMouseEvent", { type: "mousePressed", x: button.x, y: button.y, button: "left", clickCount: 1 });
				await ui.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: button.x, y: button.y, button: "left", clickCount: 1 });
				await ui.wait("document.querySelector('.omp-window')");
				assert.ok(Number(await ui.evaluate("document.querySelector('.omp-window').dataset.windowRows")) >= 500, "the full view of a long output is windowed");
				assert.doesNotMatch(await ui.evaluate<string>("document.querySelector('.omp-tool-body').textContent"), /OUTPUT_LINE_250_END/, "rows far from the visible ones are not in the page");
				// Collapse closes the card even with focus inside it, and the card starts at the preview when opened again.
				await ui.evaluate("document.querySelector('.omp-tool-collapse button').focus()");
				await ui.evaluate("document.querySelector('.omp-tool-collapse button').click()");
				await ui.wait("!document.querySelector('[data-tool-call-id=\"long-output\"] .omp-tool-body')");
				assert.equal(await ui.evaluate("document.activeElement?.classList.contains('omp-tool-head')"), true, "focus returns to the head");
				await ui.evaluate("document.querySelector('[data-tool-call-id=\"long-output\"] .omp-tool-head').click()");
				await ui.wait("document.querySelector('.omp-output-marker')");
				assert.equal(await ui.evaluate("document.querySelector('.omp-window')"), null, "Show all was reset by the collapse");
			}
		});

		await t.test("finished reply Copy uses canonical Markdown and reports clipboard failure", async () => {
			await reset("paseo-reply-copy");
			await ui.evaluate(`window.ui.thinking([{type:'thinking',thinking:'Excluded reasoning'},{type:'text',text:'**Canonical** reply'}]);
			 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(text){window.copiedReply=text}}})`);
			await ui.wait("document.querySelector('.omp-reply-copy')");
			assert.deepEqual(await ui.evaluate("(()=>{const b=document.querySelector('.omp-reply-copy');return [b.getAttribute('aria-label'),b.textContent,getComputedStyle(b).borderTopWidth]})()"), ["Copy reply", "", "0px"]);
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
			assert.equal(await ui.evaluate("Array.from(document.querySelectorAll('.omp-native-disclosure summary')).filter(node => node.textContent?.startsWith('Thought')).length"), 0);
			await ui.evaluate(`window.ui.thinking([{type:'thinking',thinking:'Reasoned conclusion',signature:'INTERNAL_THINKING_SIGNATURE'},{type:'redactedThinking',data:'INTERNAL_REDACTED_PAYLOAD'},{type:'text',text:'Answer'}])`);
			await ui.wait("Array.from(document.querySelectorAll('.omp-native-disclosure summary')).filter(node => node.textContent === 'Thought').length === 1");
			await ui.evaluate("Array.from(document.querySelectorAll('.omp-native-disclosure')).filter(node => node.querySelector(':scope > summary')?.textContent?.startsWith('Thought')).forEach(node => node.open = true)");
			await ui.wait("document.querySelector('.omp-transcript')?.textContent.includes('Reasoned conclusion')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-transcript').textContent.includes('INTERNAL_')"), false);
		});

		await t.test("live tool details follow through the outer controller and pause native detail DOM on focus", async () => {
			await reset("paseo-detail-latest", "overview");
			await ui.evaluate(`window.detailArgs={path:'paseo-live.ts',content:Array.from({length:180},(_,index)=>'export const line'+index+' = '+index+';').join('\\n')};
			 window.detailMessage={role:'assistant',model:'m',timestamp:1000,stopReason:'toolUse',content:[{type:'toolCall',id:'detail-latest',name:'write',arguments:window.detailArgs}]};
			 window.pushDetail=()=>window.ui.push({stream:{messageId:'detail-latest-message',message:window.detailMessage},streamPosition:{anchorId:null,seq:1},working:true,settled:false,activeTools:[{toolCallId:'detail-latest',toolName:'write',args:window.detailArgs,startedAt:1000}]});window.pushDetail()`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"detail-latest\"] .omp-native-source')?.textContent.includes('line179')");
			assert.ok(await ui.evaluate<number>("document.querySelectorAll('[data-tool-call-id=\"detail-latest\"] .omp-native-code-line').length")<=13, "a live write shows the tail of its content as a bounded preview");
			assert.match(await ui.evaluate<string>("document.querySelector('[data-tool-call-id=\"detail-latest\"] .omp-output-marker').textContent"), /earlier lines.*· live/);
			await ui.settleGeometry(".omp-transcript");
			assert.ok(await ui.evaluate("(()=>{const root=document.querySelector('.omp-transcript');return root.scrollHeight-root.clientHeight-root.scrollTop<=2})()"), "live source follows via outer controller");
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"detail-latest\"] .omp-tool-body').focus({preventScroll:true})");
			await ui.wait("document.activeElement?.classList.contains('omp-tool-body')");
			const heldTop = await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollTop");
			await ui.evaluate("window.detailArgs={...window.detailArgs,content:window.detailArgs.content+'\\nexport const addedWhileFocused = 999;'};window.pushDetail()");
			await ui.settleGeometry('[data-tool-call-id="detail-latest"] .omp-tool-body');
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"detail-latest\"] .omp-tool-body').textContent.includes('addedWhileFocused')"), false, "native held detail DOM stays stable while canonical content grows");
			assert.equal(await ui.evaluate("document.querySelector('.omp-transcript').scrollTop"), heldTop);
			await ui.evaluate("window.composer.focus()");
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
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"read-live\"] .omp-tool-head').click();window.composer.focus()");
			await ui.call("Input.insertText", { text: "Unsent draft survives" });
			await ui.wait("document.querySelector('[data-tool-call-id=\"read-live\"] .omp-tool-body')?.textContent.includes('Canonical source output')");
			// The density is a setting the host pushes; the page keeps the draft and the open call across the change.
			await ui.evaluate("window.ui.density('detailed')");
			await ui.wait("document.querySelector('.omp-tool-overview')===null");
			assert.equal(await ui.evaluate("window.composer.value()"), "Unsent draft survives");
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
			await ui.evaluate("window.composer.focus()");
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
			assert.equal(await ui.evaluate("window.composer.value()"), "Density must retain this draft");
			await ui.evaluate("document.getSelection().removeAllRanges();document.activeElement.click();window.composer.focus();window.ui.density('overview')");
			await ui.wait("document.querySelector('.omp-tool-overview') && !document.querySelector('[data-tool-call-id=\"density-read\"]')");
			assert.equal(await ui.evaluate("window.composer.focused()"), true);
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
			const iconLeft = (id: string): string => `document.querySelector('[data-tool-call-id="${id}"] .omp-tool-head > .codicon:not(.codicon-chevron-right):not(.codicon-chevron-down):not(.codicon-blank)').getBoundingClientRect().left`;
			assert.equal(await ui.evaluate<number>(`${iconLeft("bare-sleep")}-${iconLeft("bare-out")}`), 0, "a row with nothing to disclose keeps the twistie slot, so its icon stays in the column");
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
			  clipped:aux.scrollWidth>aux.clientWidth&&style.textOverflow==='ellipsis'&&style.whiteSpace==='nowrap',muted:style.color===getComputedStyle(head.querySelector('.omp-tool-name')).color,
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
					assert.equal(row.muted, true, `${id} intent uses the same muted colour as the tool name`);
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

		await t.test("with ompDesk.toolIntentDescriptions on a head with an intent reads icon, name, intent, target; the path loses its directories before the file name and the target everything before the intent; links stay; off or without an intent the head is unchanged", async () => {
			await reset("tool-intent-first", "detailed");
			const longIntent = "Checking that a long intent keeps its words in the collapsed head while the path and the command give way to it first";
			const shortIntent = "Reading the Jobs HUD";
			const readPath = "src/webview/components/deeply/nested/JobsHud.tsx:28-45";
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const call=(id,name,args,intent)=>({type:'toolCall',id,name,arguments:args,...(intent?{intent}:{})});
			 const result=(id,name,text,details)=>row('r-'+id,{role:'toolResult',timestamp:2,toolCallId:id,toolName:name,isError:false,content:[{type:'text',text}],details});
			 const turn=(id,calls)=>row('a-'+id,{role:'assistant',model:'m',timestamp:2,stopReason:'toolUse',content:calls});
			 window.ui.push({entries:[
			  turn('long',[call('ifr-long','read',{path:${JSON.stringify(readPath)}},${JSON.stringify(longIntent)})]),result('ifr-long','read','const a = 1;',{}),
			  turn('short',[call('ifr-short','read',{path:${JSON.stringify(readPath)}},${JSON.stringify(shortIntent)})]),result('ifr-short','read','const a = 1;',{}),
			  turn('edit',[call('ifr-edit','edit',{path:'src/webview/components/JobsHud.tsx'},${JSON.stringify(shortIntent)})]),result('ifr-edit','edit','Updated src/webview/components/JobsHud.tsx',{diff:'+1 new',firstChangedLine:3}),
			  turn('bash',[call('ifr-bash','bash',{command:'npm run typecheck -- --pretty false --incremental false'},${JSON.stringify(longIntent)})]),result('ifr-bash','bash','ok',{exitCode:0}),
			  turn('none',[call('ifr-none','read',{path:${JSON.stringify(readPath)}})]),result('ifr-none','read','const a = 1;',{})],working:false,settled:true});
			 window.answered=new Set();
			 window.answerLinks=setInterval(()=>{for(const message of window.sent){
			  if(message.type!=='omp:terminal-link-validate'||window.answered.has(message.requestId))continue;
			  window.answered.add(message.requestId);
			  window.ui.receive({type:'omp:terminal-link-validation',requestId:message.requestId,valid:true});
			 }},5);
			})()`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"ifr-none\"] .omp-tool-head') && document.querySelector('[data-tool-call-id=\"ifr-bash\"] .omp-tool-head')");
			await ui.wait("document.querySelector('[data-tool-call-id=\"ifr-short\"] .omp-file-link')");
			const order = (id: string): Promise<string[]> => ui.evaluate(`(()=>{
			 const kind=node=>node.classList.contains('codicon')?'icon':node.classList.contains('omp-tool-name')?'name':node.classList.contains('omp-tool-aux--intent')?'intent':node.classList.contains('omp-tool-digest')?'target':node.classList.contains('omp-gist')?'gist':'';
			 return [...document.querySelector('[data-tool-call-id="${id}"] .omp-tool-head').children].map(kind).filter((value,index,all)=>value!==''&&value!==all[index-1]);})()`);
			const preferences = (toolIntent: boolean): Promise<unknown> => ui.evaluate(`window.ui.receive({type:'omp:chat-display-preferences',epoch:window.ui.current().epoch,toolCallDetail:'detailed',accessibilitySupport:false,toolIntent:${toolIntent}})`);
			const unchanged = ["icon", "name", "target", "intent"];
			const leading = ["icon", "name", "intent", "target"];
			const withoutGist = async (id: string): Promise<string[]> => (await order(id)).filter(kind => kind !== "gist");
			for (const id of ["ifr-long", "ifr-short", "ifr-edit", "ifr-bash"]) assert.deepEqual(await withoutGist(id), unchanged, `${id}: the setting off keeps icon, name, target, intent`);
			assert.deepEqual(await withoutGist("ifr-none"), ["icon", "name", "target"]);
			await preferences(true);
			await ui.wait("document.querySelector('[data-tool-call-id=\"ifr-long\"] .omp-tool-head--intent-first')");
			for (const id of ["ifr-long", "ifr-short", "ifr-edit", "ifr-bash"]) {
				assert.deepEqual(await withoutGist(id), leading, `${id}: the setting on leads with the intent`);
				const all = await order(id);
				if (all.includes("gist")) assert.equal(all.at(-1), "gist", `${id}: the facts stay at the right, after the target`);
			}
			assert.deepEqual(await withoutGist("ifr-none"), ["icon", "name", "target"], "no intent: today's head");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"ifr-none\"] .omp-tool-head--intent-first')"), null);
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"ifr-none\"] .omp-path-dir')"), null, "no intent: the path is cut at its end as before");

			const geometry = (id: string) => ui.evaluate<{ head: [number, number]; intent: [number, number]; digest: [number, number]; intentClipped: boolean; headOverflow: boolean; colours: { intent: string; digest: string; foreground: string; muted: string }; height: number;
				path: null | { dir: [number, number] | null; file: [number, number]; fileText: string; dirText: string; fileClipped: boolean; dirClipped: boolean; textRight: number | null; textLeft: number | null } }>(`(()=>{
			 const head=document.querySelector('[data-tool-call-id="${id}"] .omp-tool-head'),span=node=>{const rect=node.getBoundingClientRect();return[rect.left,rect.right]};
			 const intent=head.querySelector('.omp-tool-aux--intent'),digest=head.querySelector('.omp-tool-digest'),dir=head.querySelector('.omp-path-dir'),file=head.querySelector('.omp-path-file');
			 const probe=value=>{const node=document.createElement('span');node.style.color=value;document.body.append(node);const colour=getComputedStyle(node).color;node.remove();return colour};
			 let textRight=null,textLeft=null;
			 if(dir){const range=document.createRange();range.selectNodeContents(dir.querySelector('bdi'));const rect=range.getBoundingClientRect();textRight=rect.right;textLeft=rect.left}
			 return {head:span(head),intent:span(intent),digest:span(digest),intentClipped:intent.scrollWidth>intent.clientWidth,headOverflow:head.scrollWidth>head.clientWidth+1,height:head.getBoundingClientRect().height,
			  colours:{intent:getComputedStyle(intent).color,digest:getComputedStyle(digest).color,foreground:probe('var(--vscode-foreground)'),muted:probe('var(--omp-muted)')},
			  path:file?{dir:dir?span(dir):null,file:span(file),fileText:file.textContent,dirText:dir?dir.textContent:'',fileClipped:file.scrollWidth>file.clientWidth,dirClipped:Boolean(dir)&&dir.scrollWidth>dir.clientWidth,textRight,textLeft}:null};})()`);
			const setWidth = async (width: number): Promise<void> => {
				await ui.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
				await ui.settleGeometry(".omp-transcript");
			};

			await setWidth(1000);
			const wide = await geometry("ifr-short");
			assert.equal(wide.colours.intent, wide.colours.foreground, "the intent is in the foreground colour");
			assert.equal(wide.colours.digest, wide.colours.muted, "the target is muted");
			assert.notEqual(wide.colours.foreground, wide.colours.muted);
			assert.ok(wide.intent[1] <= wide.digest[0] + 0.5, "the target starts after the intent ends");
			assert.ok(wide.path !== null && !wide.path.dirClipped && !wide.path.fileClipped && wide.path.fileText === "JobsHud.tsx:28-45" && wide.path.dirText === "src/webview/components/deeply/nested/", `room enough: the whole path (${JSON.stringify(wide.path)})`);
			assert.equal(wide.intentClipped, false);

			// A path shrinks from its start: the directories give way and the file name with its line range stays whole inside the head.
			await setWidth(480);
			const narrow = await geometry("ifr-short");
			assert.ok(narrow.path !== null && narrow.path.dirClipped, `the directories no longer fit (${JSON.stringify(narrow.path)})`);
			assert.equal(narrow.path.fileText, "JobsHud.tsx:28-45");
			assert.equal(narrow.path.fileClipped, false, "the file name and its line range are whole");
			assert.ok(narrow.path.file[0] >= narrow.head[0] && narrow.path.file[1] <= narrow.head[1] + 0.5, "the file name's box is inside the head");
			assert.ok(narrow.path.file[1] <= narrow.digest[1] + 0.5 && narrow.path.file[0] >= narrow.digest[0] - 0.5, "and inside the target");
			assert.equal(narrow.intentClipped, false, "the intent is whole while only the target is short");
			assert.ok(narrow.path.dir !== null && narrow.path.textRight !== null && narrow.path.textLeft !== null && Math.abs(narrow.path.textRight - narrow.path.dir[1]) <= 1.5 && narrow.path.textLeft < narrow.path.dir[0], "the ellipsis is at the start of the directories: their end stays visible");
			assert.equal(narrow.headOverflow, false);
			assert.ok(narrow.height < 40, `one line (${narrow.height}px)`);

			// The target gives way completely before the intent loses a character: at no width is the intent cut while the target still shows.
			for (const width of [1000, 800, 640, 520, 460, 400, 360, 320, 280]) {
				await setWidth(width);
				for (const id of ["ifr-long", "ifr-edit", "ifr-bash"]) {
					const row = await geometry(id);
					const intentCut = row.intentClipped;
					assert.ok(!intentCut || row.digest[1] - row.digest[0] <= 1, `${id} at ${width}px: the intent is cut only once the target is gone (target ${row.digest[1] - row.digest[0]}px)`);
					assert.equal(row.headOverflow, false, `${id} at ${width}px: no overflow`);
					assert.ok(row.height < 40, `${id} at ${width}px: one line (${row.height}px)`);
				}
			}
			await setWidth(320);
			const small = await geometry("ifr-long");
			assert.equal(small.intentClipped, true, "320px: the long intent is cut with an ellipsis");
			assert.ok(small.digest[1] - small.digest[0] <= 1, "320px: the target collapsed first");
			assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('[data-tool-call-id=\"ifr-bash\"] .omp-tool-digest')).textOverflow"), "ellipsis", "a command keeps its end ellipsis");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"ifr-bash\"] .omp-path-dir')"), null);

			// The path is still a link: the file name is a link target, the full path is the tooltip, a click opens the file at its line and does not toggle the row.
			await setWidth(480);
			const link = await ui.evaluate<{ target: string; hit: boolean; title: string; expanded: string | null }>(`(()=>{
			 const tool=document.querySelector('[data-tool-call-id="ifr-short"]'),link=tool.querySelector('.omp-file-link'),file=link.querySelector('.omp-path-file'),rect=file.getBoundingClientRect();
			 const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
			 return {target:link.dataset.fileTarget,hit:Boolean(hit&&hit.closest('.omp-file-link')===link),title:tool.querySelector('.omp-tool-digest').title,expanded:tool.querySelector('.omp-tool-head').getAttribute('aria-expanded')}})()`);
			assert.equal(link.hit, true, "the file name is what a pointer hits");
			assert.equal(link.title, readPath, "the whole path stays in the tooltip");
			assert.match(link.target, /JobsHud\.tsx:28$/, "the link opens the file at its first line");
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"ifr-short\"] .omp-path-file').click()");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:terminal-link-open').map(message=>message.target)"), [link.target]);
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"ifr-short\"] .omp-tool-head').getAttribute('aria-expanded')"), "false", "the link click does not toggle the row");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"ifr-edit\"] .omp-file-link .omp-path-file').textContent"), "JobsHud.tsx", "an edit's single path is a link laid out the same way");

			// Off again: today's order, everywhere.
			await preferences(false);
			await ui.wait("!document.querySelector('.omp-tool-head--intent-first')");
			for (const id of ["ifr-long", "ifr-short", "ifr-edit", "ifr-bash"]) assert.deepEqual(await withoutGist(id), unchanged, `${id}: off again`);
			assert.equal(await ui.evaluate("document.querySelector('.omp-path-dir')"), null);
			await ui.call("Emulation.clearDeviceMetricsOverride");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
			await ui.evaluate("clearInterval(window.answerLinks)");
		});

		await t.test("slash alias acceptance inserts canonical skill text without sending; next Enter sends, Escape preserves draft", async () => {
			await reset("paseo-slash");
			await ui.evaluate("window.ui.push({commands:[{name:'skill:inspect',source:'skill',aliases:['review'],inputHint:'files',description:'Inspect source'},{name:'worktree',aliases:['sandbox']}]});window.composer.focus()");
			await ui.call("Input.insertText", { text: "/rev" });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')?.textContent.includes('skill:inspect')");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
			await ui.wait("window.composer.value()==='/skill:inspect '");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 0);
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-prompt' && message.text==='/skill:inspect')");
			await ui.call("Input.insertText", { text: "/skill" });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')!==null");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')===null");
			assert.equal(await ui.evaluate("window.composer.value()"), "/skill");
		});

		await t.test("arrow keys keep the active suggestion visible in a scrolled list, wrapping both ways, while hovering never scrolls", async () => {
			await reset("slash-scroll");
			await ui.evaluate("window.ui.push({commands:Array.from({length:30},(_,i)=>({name:'cmd'+String(i).padStart(2,'0'),description:'Command '+i}))});window.composer.focus()");
			const key = async (key: string, code: number) => { await ui.call("Input.dispatchKeyEvent", {type:"keyDown",key,code:key,windowsVirtualKeyCode:code}); await ui.call("Input.dispatchKeyEvent", {type:"keyUp",key,code:key,windowsVirtualKeyCode:code}); };
			await ui.call("Input.insertText", { text: "/cmd" });
			await ui.wait("document.querySelectorAll('[aria-label=\"Slash commands\"] [role=\"option\"]').length===30");
			const view = () => ui.evaluate<{ active: string; visible: boolean; scrolled: boolean }>(`(()=>{const list=document.querySelector('[aria-label="Slash commands"]');const active=list.querySelector('[aria-selected="true"]');
			 const l=list.getBoundingClientRect(),a=active.getBoundingClientRect();return{active:active.querySelector('strong').textContent,visible:a.top>=l.top-0.5&&a.bottom<=l.bottom+0.5,scrolled:list.scrollTop>0}})()`);
			assert.equal(await ui.evaluate("(()=>{const list=document.querySelector('[aria-label=\"Slash commands\"]');return list.scrollHeight>list.clientHeight})()"), true, "the fixture overflows the list");
			for (let step = 1; step <= 20; step++) await key("ArrowDown", 40);
			assert.deepEqual(await view(), { active: "/cmd20", visible: true, scrolled: true }, "moving down scrolls the active option into view");
			for (let step = 0; step < 20; step++) await key("ArrowUp", 38);
			assert.deepEqual(await view(), { active: "/cmd00", visible: true, scrolled: false }, "moving back up scrolls up to it");
			await key("ArrowUp", 38);
			assert.deepEqual(await view(), { active: "/cmd29", visible: true, scrolled: true }, "wrapping to the last option reveals it");
			await key("ArrowDown", 40);
			assert.deepEqual(await view(), { active: "/cmd00", visible: true, scrolled: false }, "wrapping to the first option reveals it");
			const box = await ui.evaluate<{ x: number; y: number }>("(()=>{const list=document.querySelector('[aria-label=\"Slash commands\"]');const options=[...list.querySelectorAll('[role=\"option\"]')];const l=list.getBoundingClientRect();const partial=options.find(o=>{const r=o.getBoundingClientRect();return r.top<l.bottom&&r.bottom>l.bottom});const r=partial.getBoundingClientRect();return{x:r.left+r.width/2,y:(r.top+l.bottom)/2}})()");
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
			assert.equal(await ui.evaluate("document.querySelector('[aria-label=\"Slash commands\"]').scrollTop"), 0, "hovering a partly visible option does not scroll the list under the pointer");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("slash argument variants filter, navigate, insert by keyboard and click without sending, and dismiss safely", async () => {
			await reset("slash-arguments");
			await ui.evaluate("window.ui.push({commands:[{name:'shake',aliases:['trim'],inputHint:'[elide|images|thinking]',subcommands:[{name:'elide',description:'Hide old text (default)'},{name:'images',description:'Remove images',usage:'/shake images'},{name:'thinking',description:'Remove thinking'}]}]});window.composer.focus()");
			const key = async (key: string, code = key, windowsVirtualKeyCode = 0) => { await ui.call("Input.dispatchKeyEvent", {type:"keyDown",key,code,windowsVirtualKeyCode}); await ui.call("Input.dispatchKeyEvent", {type:"keyUp",key,code,windowsVirtualKeyCode}); };
			await ui.call("Input.insertText", {text:"/trim "});
			await ui.wait("document.querySelector('[aria-label=\"Command arguments\"] [role=\"option\"]')");
			assert.equal(await ui.evaluate("document.querySelectorAll('[aria-label=\"Command arguments\"] [role=\"option\"]').length"), 3);
			assert.equal(await ui.evaluate("document.querySelectorAll('[aria-label=\"Command arguments\"] [aria-selected=\"true\"]').length"), 0, "empty optional argument has no forced selection");
			assert.equal(await ui.evaluate("document.querySelector('[aria-label=\"Command arguments\"]').textContent.includes('optional') && document.querySelector('[aria-label=\"Command arguments\"]').textContent.includes('default')"), true);
			await key("ArrowDown", "ArrowDown", 40); await key("ArrowDown", "ArrowDown", 40); await key("Enter", "Enter", 13);
			await ui.wait("window.composer.value()==='/trim images '");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 0);
			await key("Enter", "Enter", 13);
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-prompt' && message.text==='/trim images')");
			await ui.call("Input.insertText", {text:"/shake thi"});
			await ui.wait("document.querySelectorAll('[aria-label=\"Command arguments\"] [role=\"option\"]').length===1");
			await key("Tab", "Tab", 9);
			await ui.wait("window.composer.value()==='/shake thinking '");
			await key("Enter", "Enter", 13);
			await ui.call("Input.insertText", {text:"/shake "});
			await ui.wait("document.querySelector('[aria-label=\"Command arguments\"]')");
			await key("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('[aria-label=\"Command arguments\"]')");
			assert.equal(await ui.evaluate("window.composer.value()"), "/shake ");
			await key("Enter", "Enter", 13);
			await ui.call("Input.insertText", {text:"/shake im"});
			await ui.wait("document.querySelector('[aria-label=\"Command arguments\"] .omp-slash-hint')?.textContent==='/shake images'");
			await ui.evaluate("document.querySelector('[aria-label=\"Command arguments\"] [role=\"option\"]').click()");
			await ui.wait("window.composer.value()==='/shake images '");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').map(message=>message.text)"), ["/trim images","/shake thinking","/shake"]);
		});

		await t.test("the Commands button lists GUI-supported commands first and marked, searches, runs a GUI command, completes one that takes arguments and sends one that takes none, never touching the draft", async () => {
			await reset("commands-button");
			await ui.evaluate("window.ui.push({commands:[{name:'usage',source:'builtin',description:'Show usage'},{name:'compact',source:'builtin',description:'Compact the context',inputHint:'[focus instructions]'},{name:'export',source:'builtin',description:'Export as HTML'},{name:'skill:review',source:'skill',description:'Review code',inputHint:'arguments'},{name:'fix',source:'file',description:'Fix a bug'},{name:'tree',source:'builtin',description:'Identity change'},{name:'handoff',source:'builtin',description:'Identity change'}]})");
			const key = async (key: string, code = key, windowsVirtualKeyCode = 0) => { await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode }); await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode }); };
			const rows = () => ui.evaluate<{ name: string; group: string; marked: boolean; chip: string; disabled: boolean }[]>("[...document.querySelectorAll('.omp-commands-option')].map(row=>({name:row.querySelector('strong').textContent,group:row.dataset.group,marked:row.querySelector('.omp-commands-gui')!==null,chip:row.querySelector('.omp-native-badge').textContent,disabled:row.getAttribute('aria-disabled')==='true'}))");
			const open = async () => { await ui.evaluate("document.querySelector('.omp-composer-commands').click()"); await ui.wait("document.querySelector('.omp-commands-popup')"); };
			const prompts = () => ui.evaluate<string[]>("window.sent.filter(message=>message.type==='omp:chat-prompt'||message.type==='omp:chat-steer').map(message=>message.text)");
			const actions = () => ui.evaluate<string[]>("window.sent.filter(message=>message.type==='omp:chat-command').map(message=>message.command)");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer-toolbar-actions .omp-composer-commands .codicon-terminal-cmd')!==null"), true);
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer-commands').getAttribute('aria-label')"), "Commands");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-composer-commands').title"), /type \//);
			await open();
			assert.equal(await ui.evaluate("document.activeElement===document.querySelector('.omp-commands-search')"), true, "the search box is focused on open");
			const listed = await rows();
			const firstPlain = listed.findIndex(row => row.group === "command");
			assert.ok(firstPlain > 0, "there are GUI commands and plain ones");
			assert.ok(listed.slice(0, firstPlain).every(row => row.marked && row.group === "gui") && listed.slice(firstPlain).every(row => !row.marked), "GUI rows come first and only they are marked");
			assert.deepEqual(listed.slice(firstPlain).map(row => row.name), ["/btw", "/fix", "/skill:review", "/usage"], "ordinary commands follow, alphabetically");
			for (const name of ["/settings", "/models", "/agents", "/rewind", "/clear", "/compact", "/export", "/hotkeys", "/git", "/login", "/logout"]) assert.ok(listed.some(row => row.name === name && row.group === "gui"), `${name} is GUI-supported`);
			assert.deepEqual(listed.filter(row => ["/tree", "/handoff", "/vibe"].includes(row.name)), [], "commands Chat cannot run are not listed");
			assert.deepEqual([listed.find(row => row.name === "/fix")!.chip, listed.find(row => row.name === "/skill:review")!.chip, listed.find(row => row.name === "/export")!.chip, listed.find(row => row.name === "/settings")!.chip], ["Prompt", "Skill", "OMP", "Desk"]);
			assert.match(await ui.evaluate<string>("[...document.querySelectorAll('.omp-commands-option')].find(row=>row.textContent.startsWith('/settings')).querySelector('.omp-commands-gui').title"), /OMP Settings editor/);
			assert.match(await ui.evaluate<string>("[...document.querySelectorAll('.omp-commands-option')].find(row=>row.textContent.startsWith('/export')).querySelector('.omp-commands-gui').getAttribute('aria-label')"), /Save dialog/);
			// Search filters; a GUI match stays ahead of a plain one.
			await ui.call("Input.insertText", { text: "/ex" });
			await ui.wait("document.querySelectorAll('.omp-commands-option').length<8");
			assert.deepEqual((await rows()).slice(0, 2).map(row => row.name), ["/export", "/extensions"]);
			assert.equal((await rows()).some(row => row.name === "/usage"), false);
			await ui.evaluate("(()=>{const input=document.querySelector('.omp-commands-search');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(input,'zzz');input.dispatchEvent(new Event('input',{bubbles:true}))})()");
			await ui.wait("document.querySelector('.omp-commands-empty')");
			// Escape closes and returns focus to the button.
			await key("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-commands-popup')");
			assert.equal(await ui.evaluate("document.activeElement===document.querySelector('.omp-composer-commands')"), true);
			assert.deepEqual(await prompts(), [], "opening and closing sent nothing");
			// A GUI command runs its action directly: a host action message, or the typed text Desk's host answers.
			await open();
			await ui.call("Input.insertText", { text: "export" });
			await ui.wait("document.querySelectorAll('.omp-commands-option').length===1");
			await key("Enter", "Enter", 13);
			await ui.wait("!document.querySelector('.omp-commands-popup')");
			assert.deepEqual(await actions(), ["export-html"]);
			await open();
			await ui.evaluate("[...document.querySelectorAll('.omp-commands-option')].find(row=>row.textContent.startsWith('/hotkeys')).click()");
			assert.deepEqual(await actions(), ["export-html", "keyboard-shortcuts"]);
			await open();
			await ui.evaluate("[...document.querySelectorAll('.omp-commands-option')].find(row=>row.textContent.startsWith('/logout')).click()");
			assert.deepEqual(await actions(), ["export-html", "keyboard-shortcuts", "provider-logout"]);
			await open();
			await ui.evaluate("[...document.querySelectorAll('.omp-commands-option')].find(row=>row.textContent.startsWith('/settings')).click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-prompt'&&message.text==='/settings')");
			assert.equal(await ui.evaluate("window.composer.value()"), "");
			// A command that takes arguments completes the draft: `/name ` with the caret after it, the rest of the draft kept.
			await ui.evaluate("window.composer.focus()");
			await ui.call("Input.insertText", { text: "keep this text" });
			await open();
			await ui.evaluate("[...document.querySelectorAll('.omp-commands-option')].find(row=>row.textContent.startsWith('/skill:review')).click()");
			await ui.wait("window.composer.value()==='/skill:review keep this text'");
			assert.deepEqual(await ui.evaluate("(()=>{const s=window.composer.selection();return[window.composer.focused(),s.start,s.end]})()"), [true, 14, 14]);
			assert.deepEqual(await prompts(), ["/settings"], "an argument command is never sent by the pick");
			// A command that takes none is sent as its own message; the draft stays exactly as it is.
			await open();
			await ui.evaluate("[...document.querySelectorAll('.omp-commands-option')].find(row=>row.textContent.startsWith('/usage')).click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-prompt'&&message.text==='/usage')");
			assert.equal(await ui.evaluate("window.composer.value()"), "/skill:review keep this text");
			// An empty draft takes the completion alone.
			await ui.evaluate("window.composer.setText('')");
			await ui.wait("window.composer.value()===''");
			await open();
			await ui.evaluate("[...document.querySelectorAll('.omp-commands-option')].find(row=>row.textContent.startsWith('/skill:review')).click()");
			await ui.wait("window.composer.value()==='/skill:review '");
			assert.deepEqual(await ui.evaluate("(()=>{const s=window.composer.selection();return[s.start,s.end]})()"), [14, 14]);
			// Keyboard: arrows move the highlight, Enter picks.
			await ui.evaluate("window.composer.setText('')");
			await open();
			assert.equal(await ui.evaluate("document.querySelector('.omp-commands-option--active').getAttribute('aria-selected')"), "true");
			await key("ArrowUp", "ArrowUp", 38);
			assert.equal(await ui.evaluate("document.querySelector('.omp-commands-option--active').querySelector('strong').textContent"), "/usage", "ArrowUp from the first row wraps to the last");
			await key("ArrowDown", "ArrowDown", 40);
			assert.equal(await ui.evaluate("document.querySelector('.omp-commands-option--active').querySelector('strong').textContent"), "/agents");
			await key("Escape", "Escape", 27);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the Commands list disables what cannot run now, with the reason, and keeps working while a turn runs", async () => {
			await reset("commands-states");
			await ui.evaluate("window.ui.push({commands:[{name:'usage',source:'builtin',description:'Show usage'},{name:'skill:review',source:'skill',inputHint:'arguments'},{name:'compact',source:'builtin',inputHint:'[focus]'},{name:'export',source:'builtin'}],working:true})");
			await ui.evaluate("document.querySelector('.omp-composer-commands').click()");
			await ui.wait("document.querySelector('.omp-commands-popup')");
			const state = (name: string) => ui.evaluate<{ disabled: boolean; reason: string }>(`(()=>{const row=[...document.querySelectorAll('.omp-commands-option')].find(row=>row.querySelector('strong').textContent===${JSON.stringify(name)});return{disabled:row.getAttribute('aria-disabled')==='true',reason:row.querySelector('.omp-commands-reason')?.textContent??''}})()`);
			assert.deepEqual(await state("/usage"), { disabled: false, reason: "" }, "an OMP command is sent as a prompt during a turn, as OMP's terminal UI does");
			assert.match((await state("/new")).reason, /Stop it first/);
			assert.match((await state("/clear")).reason, /abort it before resetting/);
			assert.match((await state("/rewind")).reason, /./, "Rewind says why it cannot open during a turn");
			for (const name of ["/skill:review", "/settings", "/compact", "/export", "/hotkeys", "/login", "/logout"]) assert.deepEqual(await state(name), { disabled: false, reason: "" }, name);
			await ui.evaluate("[...document.querySelectorAll('.omp-commands-option')].find(row=>row.textContent.startsWith('/usage')).click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-steer'&&message.text==='/usage')");
			await ui.evaluate("document.querySelector('.omp-composer-commands').click()");
			await ui.wait("document.querySelector('.omp-commands-popup')");
			await ui.evaluate("[...document.querySelectorAll('.omp-commands-option')].find(row=>row.textContent.startsWith('/settings')).click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-steer'&&message.text==='/settings')");
			await ui.evaluate("window.ui.push({working:false,phase:'stopped'})");
			await ui.wait("window.composer.disabled()");
			await ui.evaluate("document.querySelector('.omp-composer-commands').click()");
			await ui.wait("document.querySelector('.omp-commands-popup')");
			assert.match((await state("/usage")).reason, /not running/);
			assert.match((await state("/export")).reason, /not running/);
			assert.deepEqual(await state("/hotkeys"), { disabled: false, reason: "" }, "a Desk view needs no live session");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the Commands list fits a 360px panel and the toolbar keeps its rows", async () => {
			await reset("commands-narrow");
			await ui.evaluate("window.ui.push({commands:[{name:'skill:a-rather-long-skill-name-for-narrow-panels',source:'skill',description:'A description long enough to wrap onto several lines inside the narrow list so the popup width is really exercised',inputHint:'arguments'}]})");
			for (const width of [360, 240]) {
				await ui.call("Emulation.setDeviceMetricsOverride", { width, height: 700, deviceScaleFactor: 1, mobile: false });
				await ui.settleGeometry(".omp-composer");
				await ui.evaluate("document.querySelector('.omp-composer-commands').click()");
				await ui.wait("document.querySelector('.omp-commands-popup')");
				await ui.settleGeometry(".omp-commands-popup");
				const fit = await ui.evaluate<{ left: number; right: number; top: number; overflow: boolean; scrolls: boolean; rowsWide: boolean; button: boolean }>(`(()=>{const p=document.querySelector('.omp-commands-popup').getBoundingClientRect(),b=document.querySelector('.omp-composer-commands').getBoundingClientRect(),card=document.querySelector('.omp-composer').getBoundingClientRect(),list=document.querySelector('.omp-commands-list');
				 return{left:p.left,right:p.right,top:p.top,overflow:document.documentElement.scrollWidth>innerWidth,scrolls:list.scrollWidth>list.clientWidth,rowsWide:[...document.querySelectorAll('.omp-commands-option')].some(row=>row.getBoundingClientRect().right>p.right+0.5),button:b.left>=card.left&&b.right<=card.right&&b.bottom<=card.bottom}})()`);
				assert.ok(fit.left >= 0 && fit.right <= width && fit.top >= 0, `the popup stays inside the ${width}px panel`);
				assert.equal(fit.overflow || fit.scrolls || fit.rowsWide, false, `${width}px: nothing overflows horizontally`);
				assert.equal(fit.button, true, `${width}px: the button stays inside the card`);
				await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
				await ui.wait("!document.querySelector('.omp-commands-popup')");
			}
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 360, height: 700, deviceScaleFactor: 1, mobile: false });
			await ui.settleGeometry(".omp-composer");
			const rowsOfToolbar = await ui.evaluate<number>("new Set([...document.querySelectorAll('.omp-composer-toolbar-actions button')].filter(node=>node.getBoundingClientRect().width>2).map(node=>Math.round(node.getBoundingClientRect().top))).size");
			assert.equal(rowsOfToolbar, 1, "the toolbar's action buttons, Commands included, share one row at 360px");
			await ui.call("Emulation.clearDeviceMetricsOverride");
		});

		await t.test("the keyboard button sits before Commands, names the effective key, posts the shortcuts command, and shares the row at 360px", async () => {
			await reset("keyboard-button");
			const sentOfType = (type: string) => ui.evaluate<unknown[]>(`window.sent.filter(message=>message.type===${JSON.stringify(type)})`);
			const facts = () => ui.evaluate<{ order: string[]; label: string | null; title: string; icon: boolean; disabled: boolean; size: number[] }>("(()=>{const button=document.querySelector('.omp-composer-toolbar-actions .omp-composer-keyboard'),box=button.getBoundingClientRect();return{order:[...document.querySelectorAll('.omp-composer-toolbar-actions .omp-btn')].map(node=>node.classList.contains('omp-composer-keyboard')?'keyboard':node.classList.contains('omp-composer-commands')?'commands':'other'),label:button.getAttribute('aria-label'),title:button.title,icon:button.querySelector('.codicon.codicon-keyboard[aria-hidden]')!==null,disabled:button.disabled,size:[box.width,box.height]}})()");
			const first = await facts();
			assert.deepEqual(first.order.slice(0, 2), ["keyboard", "commands"]);
			assert.deepEqual({ label: first.label, title: first.title, icon: first.icon, disabled: first.disabled, size: first.size }, { label: "Keyboard shortcuts", title: "Keyboard shortcuts (Ctrl+/)", icon: true, disabled: false, size: [28, 28] });
			await ui.evaluate("window.ui.receive({type:'omp:chat-keys',keys:[{command:'ompDesk.showChatKeyboardShortcuts',key:'Ctrl+Alt+/',conflicts:[],more:0}]})");
			await ui.wait("document.querySelector('.omp-composer-keyboard').title==='Keyboard shortcuts (Ctrl+Alt+/)'");
			await ui.evaluate("window.ui.receive({type:'omp:chat-keys',keys:[{command:'ompDesk.showChatKeyboardShortcuts',key:null,conflicts:[],more:0}]})");
			await ui.wait("document.querySelector('.omp-composer-keyboard').title==='Keyboard shortcuts'");
			await ui.evaluate("document.querySelector('.omp-composer-keyboard').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-command')");
			assert.deepEqual(await sentOfType("omp:chat-command"), [{ type: "omp:chat-command", command: "keyboard-shortcuts" }]);
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 360, height: 700, deviceScaleFactor: 1, mobile: false });
			await ui.settleGeometry(".omp-composer");
			assert.equal(await ui.evaluate("new Set([...document.querySelectorAll('.omp-composer-toolbar-actions button')].filter(node=>node.getBoundingClientRect().width>2).map(node=>Math.round(node.getBoundingClientRect().top))).size"), 1, "Keyboard, Commands and the prompt actions share one row at 360px");
			await ui.call("Emulation.clearDeviceMetricsOverride");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("optional-empty and hint-only Enter send; required-empty stays open across Escape and every submit route", async () => {
			await reset("slash-argument-enter");
			await ui.evaluate("window.ui.push({commands:[{name:'shake',inputHint:'[variant]',subcommands:[{name:'elide'}]},{name:'focus',inputHint:'[focus instructions]'},{name:'join',inputHint:'<link>'},{name:'required',inputHint:'<action>',subcommands:[{name:'one'}]},{name:'raw',inputHint:'unrecognized hint syntax'}]});window.composer.focus()");
			const enter = () => ui.call("Input.dispatchKeyEvent", {type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
			for (const text of ["/shake ", "/focus ", "/raw "]) {
				await ui.call("Input.insertText", {text});
				await ui.wait("document.querySelector('[aria-label=\"Command arguments\"]')");
				if (text !== "/shake ") assert.equal(await ui.evaluate("document.querySelectorAll('[aria-label=\"Command arguments\"] [role=\"option\"]').length"), 0);
				await enter();
				await ui.wait("window.composer.value()===''");
			}
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').map(message=>message.text)"), ["/shake","/focus","/raw"]);
			await ui.call("Input.insertText", {text:"/join "});
			await ui.wait("document.querySelector('[aria-label=\"Command arguments\"]')");
			await enter();
			assert.equal(await ui.evaluate("window.composer.value()"), "/join ");
			await ui.call("Input.dispatchKeyEvent", {type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
			await ui.wait("!document.querySelector('[aria-label=\"Command arguments\"]')");
			await ui.evaluate("document.querySelector('button[aria-label=\"Send message\"]').click()");
			await ui.wait("document.querySelector('[aria-label=\"Command arguments\"]')");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 3);
			await ui.evaluate("window.ui.receive({type:'omp:webview-action',action:'send-prompt'})");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 3, "host send action cannot bypass the required-empty guard");
			await ui.call("Input.insertText", {text:"test-link"});
			await enter();
			await ui.wait("window.composer.value()===''");
			await ui.call("Input.insertText", {text:"/required "}); await enter();
			assert.equal(await ui.evaluate("window.composer.value()"), "/required ");
			assert.equal(await ui.evaluate("document.querySelector('[aria-label=\"Command arguments\"]')!==null"), true);
			await ui.call("Input.dispatchKeyEvent", {type:"keyDown",key:"ArrowDown",code:"ArrowDown",windowsVirtualKeyCode:40}); await enter();
			await ui.wait("window.composer.value()==='/required one '");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 4);
		});

		await t.test("IME owns argument arrows, Enter, Tab and clicks, including required-empty input", async () => {
			await reset("slash-argument-ime");
			await ui.evaluate("window.ui.push({commands:[{name:'required',inputHint:'<action>',subcommands:[{name:'one'},{name:'two'}]}]});window.composer.focus()");
			await ui.call("Input.insertText", {text:"/required "});
			await ui.wait("document.querySelector('[aria-label=\"Command arguments\"]')");
			await ui.evaluate(`(()=>{
			 const input=window.composer.el(); input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
			 for(const key of ['ArrowDown','Enter','Tab'])input.dispatchEvent(new KeyboardEvent('keydown',{key,code:key,isComposing:true,bubbles:true}));
			 document.querySelector('[aria-label="Command arguments"] [role="option"]').click();
			})()`);
			assert.equal(await ui.evaluate("window.composer.value()"), "/required ");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 0);
			await ui.evaluate("window.composer.el().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))");
			await ui.call("Input.dispatchKeyEvent", {type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
			await ui.wait("window.composer.value()==='/required one '");
		});

		await t.test("an editor reference from the host lands at the caret with a space around it, keeps the rest of the draft, focuses the input and never submits", async () => {
			await reset("editor-reference");
			await ui.evaluate("window.composer.focus()");
			await ui.call("Input.insertText", { text: "fix  the bug" });
			await ui.evaluate("window.composer.select(4,4);window.composer.blur()");
			await ui.evaluate("window.ui.receive({type:'omp:insert-text',text:'@src/a.ts [lines 12-30]'})");
			await ui.wait("window.composer.value()==='fix @src/a.ts [lines 12-30] the bug'");
			assert.deepEqual(
				await ui.evaluate("(()=>{const s=window.composer.selection();return{focused:window.composer.focused(),caret:s.start===s.end?s.start:-1}})()"),
				{ focused: true, caret: "fix @src/a.ts [lines 12-30] ".length },
				"the caret follows the inserted reference, past the space that already followed it",
			);
			// Pasted at the end of a draft that does not end in whitespace: one leading space, one trailing space.
			await ui.evaluate("window.composer.select(window.composer.value().length)");
			await ui.evaluate("window.ui.receive({type:'omp:insert-text',text:'@b.ts @c.ts'})");
			await ui.wait("window.composer.value()==='fix @src/a.ts [lines 12-30] the bug @b.ts @c.ts '");
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
			 window.composer.focus();
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
			await ui.evaluate("window.ui.push({commands:[{name:'skill:inspect',source:'skill',inputHint:'files'}]});window.composer.focus()");
			await ui.call("Input.insertText", { text: "/skill:i" });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			await ui.evaluate(`const input=window.composer.el();input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
			 input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',code:'Tab',isComposing:true,bubbles:true}));`);
			assert.equal(await ui.evaluate("window.composer.value()"), "/skill:i");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 0);
			await ui.evaluate("window.composer.el().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));window.ui.push({commands:[]})");
			await ui.wait("!document.querySelector('[aria-label=\"Slash commands\"]')");
			assert.equal(await ui.evaluate("window.composer.value()"), "/skill:i");
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

		await t.test("on the review step Enter submits the answers: after a typed last answer, after a picked one, and from the Submit tab; Enter on a review row still opens its question", async () => {
			await reset("ask-review-enter");
			const enter = async () => {
				for (const type of ["keyDown", "keyUp"]) await ui.call("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
			};
			const responses = "window.sent.filter(message=>message.type==='omp:chat-ui-response').length";
			const ask = (id: string) => `window.ui.push({uiRequests:[{id:'${id}',method:'ask',title:'t',questions:[
			 {id:'a',header:'A',question:'A?',multi:false,options:[{label:'Yes'},{label:'No'}]},
			 {id:'b',header:'B',question:'B?',multi:false,options:[{label:'Yes'},{label:'No'}]}]}],working:true,settled:false})`;
			// A typed "Other" answer to the last question, committed with Enter, lands on review; the next Enter submits.
			await ui.evaluate(ask("enter-typed"));
			await ui.wait("document.querySelectorAll('.omp-ask-option').length===3");
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[0].click()");
			await ui.wait("document.querySelectorAll('.omp-ask-tab')[1].getAttribute('aria-selected')==='true'");
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[2].click()");
			await ui.wait("document.querySelector('.omp-ask-custom textarea')");
			await ui.call("Input.insertText", { text: "typed answer" });
			await enter();
			await ui.wait("document.querySelector('.omp-ask-review')");
			assert.equal(await ui.evaluate(responses), 0, "committing the last answer only opens review");
			await enter();
			await ui.wait(`${responses}===1`);
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-ui-response').at(-1).response"), { id: "enter-typed", answers: [{ id: "a", selectedOptions: ["Yes"] }, { id: "b", selectedOptions: [], customInput: "typed answer" }] });
			await ui.evaluate("window.ui.push({uiRequests:[],working:false,settled:true})");
			await ui.wait("!document.querySelector('.omp-ask')");
			// A clicked last answer lands on review too; Enter on a review row opens that question, and Enter from the Submit tab submits.
			await ui.evaluate(ask("enter-picked"));
			await ui.wait("document.querySelectorAll('.omp-ask-option').length===3");
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[0].click()");
			await ui.wait("document.querySelectorAll('.omp-ask-tab')[1].getAttribute('aria-selected')==='true'");
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[1].click()");
			await ui.wait("document.querySelector('.omp-ask-review')");
			await ui.evaluate("document.querySelectorAll('.omp-ask-review-row')[0].focus()");
			await enter();
			await ui.wait("document.querySelectorAll('.omp-ask-tab')[0].getAttribute('aria-selected')==='true'");
			assert.equal(await ui.evaluate(responses), 1, "a review row opens its question and sends nothing");
			await ui.evaluate("document.querySelector('.omp-ask-tab--submit').focus()");
			await enter();
			await ui.wait("document.querySelector('.omp-ask-review')");
			await ui.evaluate("document.querySelector('.omp-ask-tab--submit').focus()");
			await enter();
			await ui.wait(`${responses}===2`);
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-ui-response').at(-1).response"), { id: "enter-picked", answers: [{ id: "a", selectedOptions: ["Yes"] }, { id: "b", selectedOptions: ["No"] }] });
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

		await t.test("the editor dialog of OMP's /review is multi-line (prefilled, Shift+Enter adds a line, Enter submits the text as typed) and the input dialog and Cancel answer once each", async () => {
			await reset("review-dialogs");
			const answers = () => ui.evaluate<unknown[]>("window.sent.filter(message=>message.type==='omp:chat-ui-response').map(message=>message.response)");
			const enter = async (shift: boolean) => {
				for (const type of ["keyDown", "keyUp"]) await ui.call("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: shift ? 8 : 0, ...(type === "keyDown" ? { text: "\r" } : {}) });
			};
			await ui.evaluate("window.ui.push({uiRequests:[{id:'rv-edit',method:'editor',title:'Enter custom review instructions',prefill:'Review the following:\\n\\n',promptStyle:true}]})");
			await ui.wait("document.querySelector('.omp-ask textarea')");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-ask-title').textContent"), /^Enter custom review instructions/);
			assert.equal(await ui.evaluate("document.querySelector('.omp-ask textarea').value"), "Review the following:\n\n", "the prefill is the draft, blank lines kept");
			await ui.evaluate("(()=>{const field=document.querySelector('.omp-ask textarea');field.focus();field.setSelectionRange(field.value.length,field.value.length)})()");
			await ui.call("Input.insertText", { text: "check the error handling" });
			await enter(true);
			await ui.call("Input.insertText", { text: "and the tests" });
			assert.equal(await ui.evaluate("document.querySelector('.omp-ask textarea').value"), "Review the following:\n\ncheck the error handling\nand the tests", "Shift+Enter adds a line and sends nothing");
			assert.deepEqual(await answers(), []);
			assert.ok(await ui.evaluate<number>("document.querySelector('.omp-ask textarea').getBoundingClientRect().height") > 40, "the field grows with its lines");
			await enter(false);
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-ui-response' && message.response.id==='rv-edit')");
			assert.deepEqual(await answers(), [{ id: "rv-edit", value: "Review the following:\n\ncheck the error handling\nand the tests" }]);

			await ui.evaluate("window.ui.push({uiRequests:[{id:'rv-input',method:'input',title:'Search open pull requests — title, author, or #123'}]})");
			await ui.wait("document.querySelector('.omp-ask textarea') && document.querySelector('.omp-ask-title').textContent.startsWith('Search open pull requests')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-ask textarea').value"), "");
			await ui.evaluate("document.querySelector('.omp-ask textarea').focus()");
			await ui.call("Input.insertText", { text: "#12" });
			await ui.evaluate("[...document.querySelectorAll('.omp-ask .omp-btn--primary')].find(button=>button.textContent.trim()==='Submit').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-ui-response' && message.response.id==='rv-input')");
			assert.deepEqual((await answers()).at(-1), { id: "rv-input", value: "#12" });

			await ui.evaluate("window.ui.push({uiRequests:[{id:'rv-cancel',method:'select',title:'Review Mode',options:[{label:'1. Review against a base branch (PR Style)'},{label:'2. Review uncommitted changes'}]}]})");
			await ui.wait("document.querySelectorAll('.omp-ask-options button').length===2");
			await ui.evaluate("[...document.querySelectorAll('.omp-ask-actions button')].find(button=>button.textContent.trim()==='Cancel').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-ui-response' && message.response.id==='rv-cancel')");
			assert.deepEqual((await answers()).at(-1), { id: "rv-cancel", cancelled: true });
			await ui.evaluate("window.ui.push({uiRequests:[],working:false,settled:true})");
		});

		await t.test("a command that asks and then ends without a turn leaves no working animation, whichever of its prompt result and its send acknowledgement the page gets first", async () => {
			const frames = "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))";
			for (const [name, resultFirst] of [["review-end-result-first", true], ["review-end-ack-first", false]] as const) {
				await reset(name);
				await ui.evaluate("window.ui.admission(false);window.composer.focus()");
				await ui.call("Input.insertText", { text: "/review" });
				await ui.evaluate("document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
				await ui.wait("window.ui.sends().length===1");
				await ui.evaluate("window.ui.push({uiRequests:[{id:'rv-end',method:'select',title:'Review Mode',options:[{label:'1. Review against a base branch (PR Style)'},{label:'2. Review uncommitted changes'}]}]})");
				await ui.wait("document.querySelectorAll('.omp-ask-options button').length===2");
				const acknowledge = "window.ui.sendReply(undefined,'accepted')";
				const finish = "window.ui.push({uiRequests:[]});window.ui.receive({type:'omp:chat-event',epoch:window.ui.current().epoch,frame:{type:'prompt_result',id:'vsc:'+window.ui.sends().at(-1).requestId,status:'completed',agentInvoked:false,sessionSettled:true}})";
				await ui.evaluate(resultFirst ? finish : acknowledge);
				await ui.evaluate(frames);
				await ui.evaluate(resultFirst ? acknowledge : finish);
				await ui.wait("document.querySelector('.omp-ask')===null");
				await ui.evaluate(frames);
				assert.equal(await ui.evaluate("document.querySelector('.omp-turn-progress')!==null"), false, `${name}: the progress bar stays on although no turn runs`);
			}
			await ui.evaluate("window.ui.admission(true)");
		});

		await t.test("Escape cancels every kind of dialog like its Cancel button, answers once, never stops the turn, and owns the key while the dialog is open", async () => {
			const escape = async (extra: Record<string, unknown> = {}): Promise<void> => {
				await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, ...extra });
				await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			};
			const answers = () => ui.evaluate<unknown[]>("window.sent.filter(message=>message.type==='omp:chat-ui-response').map(message=>message.response)");
			const aborts = () => ui.evaluate<number>("window.sent.filter(message=>message.type==='omp:chat-abort').length");
			const popupReports = () => ui.evaluate<boolean[]>("window.sent.filter(message=>message.type==='omp:composer-popup').map(message=>message.open)");
			const frames = "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))";
			const questions = `[{id:'color',question:'Which color?',multi:false,options:[{label:'Red'},{label:'Green'}]},{id:'checks',question:'Checks?',multi:true,options:[{label:'Typecheck'},{label:'Tests'}]}]`;
			const dialogs: readonly (readonly [string, string, string])[] = [
				["select", "{id:'esc-select',method:'select',title:'Review Mode',options:[{label:'1. Review against a base branch (PR Style)'},{label:'2. Review uncommitted changes'}]}", ".omp-ask-options button"],
				["input", "{id:'esc-input',method:'input',title:'Search open pull requests'}", ".omp-ask textarea"],
				["editor", "{id:'esc-editor',method:'editor',title:'Enter custom review instructions',prefill:'Review the following:\\n\\n',promptStyle:true}", ".omp-ask textarea"],
				["confirm", "{id:'esc-confirm',method:'confirm',title:'Apply?',message:'Apply the change?'}", ".omp-ask .omp-btn--primary"],
				["ask", `{id:'esc-ask',method:'ask',title:'t',questions:${questions}}`, ".omp-ask-option"],
			];
			for (const [method, request, anchor] of dialogs) {
				await reset(`escape-${method}`);
				// A turn is running behind the dialog, as when a command opened it; Escape must not stop it.
				await ui.evaluate(`window.ui.push({uiRequests:[${request}],working:true,settled:false})`);
				await ui.wait(`document.querySelector('${anchor}')`);
				await ui.wait("window.sent.filter(message=>message.type==='omp:composer-popup').at(-1)?.open===true");
				const id = request.match(/id:'([^']+)'/)![1]!;
				if (method === "input" || method === "editor") await ui.evaluate("document.querySelector('.omp-ask textarea').focus()");
				await escape();
				await ui.wait(`window.sent.some(message=>message.type==='omp:chat-ui-response' && message.response.id==='${id}')`);
				await ui.evaluate(frames);
				assert.deepEqual(await answers(), [{ id, cancelled: true }], `${method}: one cancelled answer`);
				assert.equal(await aborts(), 0, `${method}: Escape on a dialog never stops the turn`);
				assert.equal(await ui.evaluate("document.querySelector('.omp-ask')===null"), true, `${method}: the dialog is gone`);
				assert.equal((await popupReports()).at(-1), false, `${method}: the stop key is armed again once the dialog is gone`);
				await escape();
				await ui.evaluate(frames);
				assert.deepEqual(await answers(), [{ id, cancelled: true }], `${method}: a second Escape answers nothing`);
			}

			// The "Other" field of a question: one Escape closes the whole dialog, as in VS Code's quick pick.
			await reset("escape-ask-other");
			await ui.evaluate(`window.ui.push({uiRequests:[{id:'esc-other',method:'ask',title:'t',questions:${questions}}],working:true,settled:false})`);
			await ui.wait("document.querySelectorAll('.omp-ask-option').length===3");
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[2].click()");
			await ui.wait("document.querySelector('.omp-ask-custom textarea')");
			await ui.call("Input.insertText", { text: "half typed" });
			await escape();
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-ui-response' && message.response.id==='esc-other')");
			assert.deepEqual((await answers()).at(-1), { id: "esc-other", cancelled: true });
			assert.equal(await aborts(), 0);

			// An IME composition keeps its Escape.
			await reset("escape-composing");
			await ui.evaluate("window.ui.push({uiRequests:[{id:'esc-ime',method:'input',title:'Search'}],working:true,settled:false})");
			await ui.wait("document.querySelector('.omp-ask textarea')");
			await ui.evaluate("document.querySelector('.omp-ask textarea').focus()");
			await ui.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Process", code: "Escape", windowsVirtualKeyCode: 229 });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await ui.evaluate(frames);
			assert.deepEqual(await answers(), [], "Escape during a composition does not cancel the dialog");

			// A dialog that is not on screen does not take the key; the transcript find bar still closes first.
			await reset("escape-find");
			await ui.evaluate("window.ui.push({uiRequests:[{id:'esc-find',method:'select',title:'Mode',options:[{label:'A'}]}],working:true,settled:false})");
			await ui.wait("document.querySelectorAll('.omp-ask-options button').length===1");
			await ui.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}))");
			if (await ui.evaluate<boolean>("document.querySelector('.omp-find-input')!==null")) {
				await ui.evaluate("document.querySelector('.omp-find-input').focus()");
				await escape();
				await ui.evaluate(frames);
				assert.deepEqual(await answers(), [], "Escape in the find bar closes the bar, not the dialog");
				assert.equal(await ui.evaluate("document.querySelector('.omp-find-input')===null"), true);
			}
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
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"bash-ui\"] .omp-tool-head .omp-chip--err')"), null, "the head repeats no badge beside its one icon");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"bash-ui\"] .omp-output-bar .omp-chip--err').textContent"), "EXIT 2", "the output bar says the exit code once");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"bash-ui\"] .omp-tool-head .omp-gist--err').textContent"), "exit 2", "and so does the head gist, closed or open");
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
			assert.match(task, /1 agent: Worker/);
			assert.match(await ui.evaluate<string>("document.querySelector('[data-tool-call-id=\"task-disclosure\"] .omp-tool-digest').title"), /Worker · scout · running/, "the per-agent list is the digest's tooltip");
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
			// An agent's own block opens closed: its activity shows, its assignment waits for a click on its head.
			await ui.wait("document.querySelector('[data-tool-call-id=\"task-disclosure\"] .omp-native-agent-head')");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"task-disclosure\"] .omp-native-agent-head').getAttribute('aria-expanded')"), "false");
			const closedAgent = await ui.evaluate<string>("document.querySelector('[data-tool-call-id=\"task-disclosure\"]').textContent");
			assert.ok(closedAgent.includes("Expanded agent activity"), "the closed agent block keeps its activity");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"task-disclosure\"] .omp-native-agent-body')"), null, "the closed agent block hides its assignment section");
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"task-disclosure\"] .omp-native-agent-head').click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"task-disclosure\"] .omp-native-agent-head').getAttribute('aria-expanded')==='true'");
			const expanded = await ui.evaluate<string>("document.querySelector('.omp-transcript').textContent");
			for (const detail of ["Goal", "Shared context detail", "Assigned detail", "Expanded agent activity", "Expanded wait detail", "assignment_identifier", "tail-row-39", "Long objective detail 79"]) assert.ok(expanded.includes(detail), detail);
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
			// A running agent's time advances with the clock between progress events; pin it so the 12s the registry reported stays exact.
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
			for (const content of ["worker", "implementer", "read · Inspecting native source", "12s"]) assert.ok(roster.includes(content), content);
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

		await t.test("a /context-style report renders its SGR colors as styled spans and shows no escape fragment, in handled output, widgets and bash executions", async () => {
			await reset("native-ansi");
			await ui.evaluate("document.documentElement.style.setProperty('--vscode-terminal-ansiRed','#c12345')");
			const ESC = "\u001b";
			const bar = `[${ESC}[38;2;107;114;128m░░░░${ESC}[39m${ESC}[38;2;156;163;176m░${ESC}[39m${ESC}[1m${ESC}[38;2;0;180;255m░░░${ESC}[22m${ESC}[39m] 1%  5700 tokens`;
			const report = [`Context window: 200000 tokens (3% used)`, `  ${"System prompt".padEnd(16)} ${bar}`, `  ${"Auto-compact buf".padEnd(16)} [${ESC}[31m████${ESC}[0m] 82%  16384 tokens${ESC}[2K`, `  ${ESC}]8;;https://example.test/docs${ESC}\\Docs link${ESC}]8;;${ESC}\\ ${ESC}[48;5;196m${ESC}[38;5;21mindexed${ESC}[0m ${ESC}[7mswap${ESC}[0m`].join("\r\n");
			const frame = (value: Record<string, unknown>) => ui.evaluate(`window.ui.receive({type:'omp:chat-event',epoch:window.ui.current().epoch,frame:${JSON.stringify(value)}})`);
			await ui.evaluate(`window.ui.push({entries:[{type:'message',id:'shell',parentId:null,timestamp:'2026-10-02T00:00:00Z',message:{role:'bashExecution',timestamp:1,command:'ls',output:${JSON.stringify(`${ESC}[32mgreen line${ESC}[0m\nplain`)},exitCode:0,cancelled:false,truncated:false}}]})`);
			await frame({ type: "command_output", text: report });
			await frame({ type: "ui_widget", key: "styled", lines: [`${ESC}[1;35mwidget bold${ESC}[0m text`] });
			await ui.wait("document.querySelector('.omp-command-output') && document.querySelector('.omp-extension-widget-line') && document.querySelector('.omp-native-output span')");
			const shown = await ui.evaluate<{ text: string; widget: string; shell: string; hasEscape: boolean; spans: number }>(`(()=>{
			 const out=document.querySelector('.omp-command-output'),all=document.body.textContent;
			 return{text:out.textContent,widget:document.querySelector('.omp-extension-widget-line').textContent,shell:document.querySelector('.omp-native-output').textContent,hasEscape:/\\u001b|\\[38;|\\[39m|\\[1m|\\[0m|\\]8;;|\\[2K/.test(all),spans:out.querySelectorAll('span').length}
			})()`);
			assert.equal(shown.hasEscape, false, "no escape fragment is visible anywhere on the page");
			assert.match(shown.text, /System prompt\s+\[░░░░░░░░\] 1%  5700 tokens/);
			assert.match(shown.text, /\[████\] 82%  16384 tokens\n/);
			assert.match(shown.text, /Docs link indexed swap/);
			assert.doesNotMatch(shown.text, /example\.test|\r/);
			assert.equal(shown.widget, "widget bold text");
			assert.match(shown.shell, /^green line\nplain/);
			assert.ok(shown.spans > 0);
			const colors = await ui.evaluate<Record<string, string>>(`(()=>{
			 const find=(root,text)=>Array.from(root.querySelectorAll('span')).find(node=>node.textContent===text);
			 const out=document.querySelector('.omp-command-output'),style=node=>getComputedStyle(node);
			 const indexed=find(out,'indexed'),swap=find(out,'swap');
			 return{truecolor:style(find(out,'░░░░')).color,truecolorTail:style(find(out,'░░░')).color,tailWeight:style(find(out,'░░░')).fontWeight,palette:style(find(out,'████')).color,indexedColor:style(indexed).color,indexedBg:style(indexed).backgroundColor,swapColor:style(swap).color,swapBg:style(swap).backgroundColor,editorBg:getComputedStyle(document.body).backgroundColor,widgetWeight:style(find(document.querySelector('.omp-extension-widget-line'),'widget bold')).fontWeight,widgetColor:style(find(document.querySelector('.omp-extension-widget-line'),'widget bold')).color,shellColor:style(find(document.querySelector('.omp-native-output'),'green line')).color}
			})()`);
			assert.equal(colors.truecolor, "rgb(107, 114, 128)");
			assert.equal(colors.truecolorTail, "rgb(0, 180, 255)");
			assert.equal(colors.tailWeight, "700");
			assert.equal(colors.palette, "rgb(193, 35, 69)", "the 16 palette colors follow the theme's terminal variables");
			assert.equal(colors.indexedColor, "rgb(0, 0, 255)");
			assert.equal(colors.indexedBg, "rgb(255, 0, 0)");
			assert.notEqual(colors.swapColor, colors.swapBg, "an inverse run swaps foreground and background");
			assert.equal(colors.widgetWeight, "700");
			assert.notEqual(colors.widgetColor, colors.shellColor);
			assert.equal(colors.shellColor.startsWith("rgb("), true);
		});

		await t.test("no available models turn the model trigger into a login action, and models restore its picker", async () => {
			await reset("provider-login");
			await ui.evaluate("window.ui.receive({type:'omp:footer-metadata',provider:null,branch:null,windows:[],accounts:[],accountSelection:null,hasAvailableModels:false})");
			await ui.wait("document.querySelector('.omp-footer-trigger-label').textContent==='Log In to Provider'");
			assert.equal(await ui.evaluate("document.querySelector('.omp-footer-trigger').disabled"), false);
			assert.equal(await ui.evaluate("window.ui.bridgeOperation({type:'omp:chat-command',command:'provider-login'})"), "provider-login");
			assert.equal(await ui.evaluate("window.ui.bridgeOperation({type:'omp:chat-command',command:'cycle-model'})"), null, "other quick actions keep their existing panel-only contract");
			const requests = await ui.evaluate<number>("window.ui.requests().length");
			await ui.evaluate("document.querySelector('.omp-footer-trigger').click()");
			assert.equal(await ui.evaluate("window.sent.at(-1).type==='omp:chat-command' && window.sent.at(-1).command==='provider-login'"), true);
			assert.equal(await ui.evaluate("window.ui.requests().length"), requests, "login is not a model mutation or a catalogue request");
			await ui.evaluate("window.ui.receive({type:'omp:footer-metadata',provider:'one',branch:null,windows:[],accounts:[],accountSelection:null,hasAvailableModels:true})");
			await ui.wait("document.querySelector('.omp-footer-trigger-label').textContent===window.ui.original.name");
			await ui.evaluate("document.querySelector('.omp-footer-trigger').click()");
			await ui.wait("window.ui.last().picker==='model'");
			await ui.evaluate("window.ui.reply()");
			assert.equal(await ui.evaluate("window.ui.requests().some(request=>request.action==='set-model')"), false, "a login menu choice returns no model selection");
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

		await t.test("a choice the host holds shows in both pickers with a pending mark, picking OMP's own value is a new choice, and the mark clears when the host drops it", async () => {
			await reset("held-choice");
			const label = (index: number): string => `document.querySelectorAll('.omp-footer-trigger')[${index}].querySelector('.omp-footer-trigger-label').textContent`;
			assert.equal(await ui.evaluate("document.querySelector('.omp-footer-trigger').dataset.pending"), undefined, "nothing is held by default");
			await ui.evaluate("window.ui.push({pendingControl:{model:{provider:'two',id:'new',name:'Held Model'},thinking:'xhigh'}})");
			await ui.wait("document.querySelector('.omp-footer-trigger').dataset.pending==='true' && document.querySelector('.omp-footer-trigger--level').dataset.pending==='true'");
			assert.equal(await ui.evaluate(label(0)), "Held Model");
			assert.equal(await ui.evaluate(label(1)), "xhigh");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-footer-trigger .codicon-clock').length"), 2);
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-footer-trigger').title"), /Waiting to apply Held Model\. OMP applies it as soon as it is ready\./);
			assert.equal(await ui.evaluate("document.querySelector('.omp-footer-trigger').disabled"), false, "a held choice does not lock the picker");
			await ui.evaluate("document.querySelector('.omp-footer-trigger').click()");
			await ui.wait("window.ui.last().picker === 'model'");
			await ui.evaluate("window.ui.reply(window.ui.last(), {selectedModel:window.ui.original})");
			await ui.wait("window.ui.last().action === 'set-model'");
			assert.equal(await ui.evaluate("window.ui.last().model.id===window.ui.original.id"), true, "OMP's own value, chosen while another is held, is sent so the host cancels the held one");
			await ui.evaluate("window.ui.push({pendingControl:null});window.ui.reply()");
			await ui.wait("document.querySelector('.omp-footer-trigger').dataset.pending===undefined && document.querySelector('.omp-footer-trigger--level').dataset.pending===undefined");
			assert.equal(await ui.evaluate(label(0)), await ui.evaluate("window.ui.original.name"));
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-footer-trigger .codicon-clock').length"), 0);
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
			await ui.evaluate("window.composer.focus();window.fixtureClock.setNow(1800285240002);window.fixtureClock.fire(60000);document.querySelector('.omp-context-trigger').focus()");
			await ui.wait("document.querySelector('.omp-context-quota')?.textContent==='7d · 42% used · resets now / refreshing'");
		});
		await t.test("context hover and keyboard Escape preserve focus and never stop a working turn", async () => {
			await reset("context-escape");
			await ui.evaluate("window.ui.push({working:true});window.composer.focus()");
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
			assert.equal(await ui.evaluate("window.composer.focused()"), true);
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
			await ui.evaluate("document.querySelector('.omp-context-trigger').focus()");
			await ui.wait("document.querySelector('.omp-context-trigger').getAttribute('aria-expanded')==='true'");
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
			await ui.wait("!document.querySelector('.omp-context-popover')");
			assert.equal(await ui.evaluate("document.activeElement===document.querySelector('.omp-context-trigger')"), true);
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-abort').length"), 0);
			await ui.evaluate("window.composer.focus()");
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

		await t.test("the branch lives in one composer toolbar row with the pickers and Send, and there is no Tools output control", async () => {
			await reset("tools-in-composer");
			await ui.evaluate("window.ui.receive({type:'omp:footer-metadata',provider:'one',branch:'layout-branch',windows:[],accounts:[],accountSelection:null})");
			await ui.wait("document.querySelector('.omp-composer-branch')");
			assert.deepEqual(await ui.evaluate(`(()=>{
			 const toolbar=document.querySelector('.omp-composer-toolbar'),pickers=[...toolbar.querySelectorAll('.omp-footer-trigger')],
			  centers=[...toolbar.querySelectorAll('.omp-composer-attach,.omp-footer-trigger,.omp-composer-branch,.omp-context-trigger,.omp-btn--primary')].filter(node=>node.getBoundingClientRect().width>0).map(node=>{const rect=node.getBoundingClientRect();return rect.top+rect.height/2});
			 return {composerToolbars:document.querySelectorAll('.omp-composer-toolbar').length,metadataRows:document.querySelectorAll('.omp-composer-metadata').length,chrome:document.querySelectorAll('.omp-chat-chrome,.omp-tools-menu,.omp-tools-options,.omp-tools-trigger').length,
			  branchInToolbar:toolbar.contains(document.querySelector('.omp-composer-branch')),
			  order:[...toolbar.querySelectorAll('.omp-composer-attach,.omp-footer-trigger,.omp-composer-branch')].map(node=>node.className.includes('branch')?'branch':node.className.includes('attach')?'attach':'picker').join(),
			  pickers:pickers.length,oneRow:Math.max(...centers)-Math.min(...centers)<10};})()`),
				{ composerToolbars: 1, metadataRows: 0, chrome: 0, branchInToolbar: true, order: "picker,picker,branch,attach", pickers: 2, oneRow: true });
			// The density is a setting, not a control of the page: a pushed preference changes the rows and nothing is posted back.
			await ui.evaluate("window.sent.length=0;window.ui.density('detailed')");
			await ui.wait("document.querySelector('.omp-composer-toolbar') !== null");
			assert.equal(await ui.evaluate("window.sent.some(message=>message.type==='omp:chat-tool-detail')"), false);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("composer controls stay contained while branch and secondary controls give way before the model and thinking pickers", async () => {
			await reset("layout");
			await ui.evaluate("window.ui.receive({type:'omp:draft-restore',requestId:1889,text:'first\\nsecond\\nthird',attachments:0,recoverable:[],documents:[]})");
			await ui.evaluate("window.ui.receive({type:'omp:footer-metadata',provider:'one',branch:'layout-branch',windows:[],accounts:[],accountSelection:null})");
			await ui.evaluate("window.ui.push({state:{...window.ui.current().state,model:{...window.ui.current().state.model,name:'A long model name that remains selectable'}}})");
			await ui.wait("window.composer.el().getBoundingClientRect().height > 60");
			for (const busy of [false, true]) {
				await ui.evaluate(`window.ui.push({working:${busy},state:{...window.ui.current().state,queuedMessageCount:${busy ? 3 : 0}}})`);
				for (const width of [1000, 760, 590, 460, 300, 240, 160]) {
					await ui.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
					await ui.settleGeometry(".omp-composer");
					const layout = await ui.evaluate<{ overflow: boolean; contained: boolean; ordered: boolean; queued: boolean; spread: number; branch: boolean }>(`(() => {
					 const card=document.querySelector('.omp-composer').getBoundingClientRect(),input=window.composer.el().getBoundingClientRect(),
					  toolbar=document.querySelector('.omp-composer-toolbar'),bar=toolbar.getBoundingClientRect(),
					  shown=node=>node!==null&&node.getBoundingClientRect().width>0,
					  controls=[...toolbar.querySelectorAll('button,.omp-chip,.omp-composer-branch')].filter(node=>node.getBoundingClientRect().width>2).map(node=>node.getBoundingClientRect()),
					  centers=controls.map(rect=>rect.top+rect.height/2);
					 return {overflow:document.documentElement.scrollWidth>innerWidth,
					  contained:controls.every(rect=>rect.left>=card.left&&rect.right<=card.right&&rect.top>=card.top&&rect.bottom<=card.bottom),
					  ordered:input.bottom<=bar.top,spread:Math.max(...centers)-Math.min(...centers),
					  branch:shown(document.querySelector('.omp-composer-branch')),
					  queued:document.querySelector('.omp-state-queued')!==null}; })()`);
					const where = `${width}px busy=${busy}`;
					assert.equal(layout.overflow, false, where);
					assert.equal(layout.contained, true, `${where}: every control remains inside the rounded card`);
					assert.equal(layout.ordered, true, `${where}: the multiline input sits above the toolbar`);
					assert.equal(layout.queued, false, "queued messages are not repeated in the toolbar");
					assert.equal(layout.branch, width > 860, `${where}: the branch is the first thing to collapse`);
					assert.equal(await ui.evaluate("document.querySelector('.omp-tools-trigger')"), null, `${where}: there is no Tools output control to give way`);
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
					await ui.evaluate("window.composer.focus()");
				}
			}
			await ui.call("Emulation.clearDeviceMetricsOverride");
		});

		await t.test("composer text is inset inside a padded focus frame that autosizes and caps, in the prompt and the ask variant", async () => {
			await reset("composer-padding");
			await ui.call("Emulation.setFocusEmulationEnabled", { enabled: true });
			await ui.evaluate("document.documentElement.style.setProperty('--vscode-focusBorder','#007fd4');window.composer.focus()");
			await ui.call("Input.insertText", { text: "Padded text" });
			await ui.wait("window.composer.value()==='Padded text'");
			const frame = await ui.evaluate<{ pl: number; pr: number; pt: number; pb: number; outline: string; offset: number; height: number; left: number; top: number; toolbarGap: number }>(`(()=>{
			 const ta=window.composer.el(),card=document.querySelector('.omp-composer').getBoundingClientRect(),box=ta.getBoundingClientRect(),s=getComputedStyle(ta),toolbar=document.querySelector('.omp-composer-toolbar').getBoundingClientRect();
			 return {pl:parseFloat(s.paddingLeft),pr:parseFloat(s.paddingRight),pt:parseFloat(s.paddingTop),pb:parseFloat(s.paddingBottom),outline:s.outlineStyle+' '+s.outlineWidth,offset:parseFloat(s.outlineOffset),height:box.height,
			  left:box.left-card.left,top:box.top-card.top,toolbarGap:toolbar.top-box.bottom};})()`);
			assert.ok(frame.pl >= 10 && frame.pl <= 12 && frame.pr >= 10 && frame.pr <= 12, `horizontal padding ${frame.pl}/${frame.pr}`);
			assert.ok(frame.pt >= 8 && frame.pt <= 10 && frame.pb >= 8 && frame.pb <= 10, `vertical padding ${frame.pt}/${frame.pb}`);
			assert.equal(frame.outline.startsWith("none"), true, "the field draws no ring of its own");
			assert.equal(await ui.evaluate("(()=>{const card=document.querySelector('.omp-composer');window.composer.focus();const probe=document.createElement('i');probe.style.color='var(--vscode-focusBorder, #007fd4)';document.body.append(probe);const same=getComputedStyle(card).borderTopColor===getComputedStyle(probe).color;probe.remove();return same})()"), true, "the focused card is the one ring");
			assert.ok(frame.left > 0 && frame.top > 0, "the frame sits inside the rounded card");
			assert.equal(frame.height, 2 * 20 + frame.pt + frame.pb, "a short draft autosizes to the two-line minimum plus padding");
			assert.ok(frame.toolbarGap >= 0, "the actions row stays below the input");
			await ui.evaluate(`window.ui.receive({type:'omp:draft-restore',requestId:1958,text:${JSON.stringify(Array.from({ length: 14 }, (_, index) => `line ${index}`).join("\n"))},attachments:0,recoverable:[],documents:[]})`);
			await ui.wait("window.composer.el().getBoundingClientRect().height > 100");
			const capped = await ui.evaluate<{ height: number; overflowY: string }>("(()=>{const ta=window.composer.el(),s=getComputedStyle(ta);return{height:ta.getBoundingClientRect().height,overflowY:s.overflowY}})()");
			assert.equal(capped.height, 8 * 20 + 20, "growth stops at eight lines plus padding");
			assert.equal(capped.overflowY, "auto", "longer drafts scroll inside the field");
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
			const probe = "(()=>{const ta=window.composer.el(),s=getComputedStyle(ta);return{placeholder:window.composer.placeholder(),height:ta.getBoundingClientRect().height,min:2*parseFloat(s.lineHeight)+parseFloat(s.paddingTop)+parseFloat(s.paddingBottom),toolbar:document.querySelector('.omp-composer-toolbar').getBoundingClientRect().height}})()";
			const idle = await ui.evaluate<{ height: number; min: number; toolbar: number }>(probe);
			assert.equal(idle.height, idle.min, "an empty live composer is two lines tall");
			for (const phase of ["stopped", "view-only"]) {
				await ui.evaluate(`window.ui.push({phase:'${phase}',readOnlyReason:${JSON.stringify(host)}})`);
				await ui.wait("window.composer.placeholder().startsWith('This session is not running')");
				const shown = await ui.evaluate<{ placeholder: string; height: number; min: number; toolbar: number }>(probe);
				assert.equal(shown.placeholder, "This session is not running. Resume it to send a message.", phase);
				assert.equal(shown.height, shown.min, `${phase}: the composer keeps its two-line minimum`);
				assert.equal(shown.toolbar, idle.toolbar, `${phase}: the toolbar row keeps its height`);
			}
			await ui.evaluate("window.ui.push({phase:'live',readOnlyReason:'Another editor controls this session'})");
			await ui.wait("window.composer.placeholder()==='Another editor controls this session'");
			await ui.call("Emulation.clearDeviceMetricsOverride");
		});

		await t.test("Resume and Stop acknowledge the click in the same frame with the host silent, name the host's step in the banner, and give the button back when the host ends it", async () => {
			await reset("pending-resume");
			await ui.evaluate("window.ui.push({phase:'view-only',readOnlyReason:'stopped'})");
			await ui.wait("[...document.querySelectorAll('.omp-composer button')].some(button=>button.textContent==='Resume')");
			// One synchronous script: the click, then the very next frame's reading, before any host message could arrive.
			const clicked = await ui.evaluate<{ text: string; disabled: boolean; spinner: boolean; busy: string | null; placeholder: string }>(`new Promise(resolve=>{
			 [...document.querySelectorAll('.omp-composer button')].find(button=>button.textContent==='Resume').click();
			 requestAnimationFrame(()=>{const button=[...document.querySelectorAll('.omp-composer button')].find(candidate=>candidate.textContent.includes('Starting'));
			  resolve({text:button.textContent.trim(),disabled:button.disabled,spinner:button.querySelector('.codicon-loading')!==null,busy:button.getAttribute('aria-busy'),placeholder:window.composer.placeholder()});});})`);
			assert.deepEqual(clicked, { text: "Starting…", disabled: true, spinner: true, busy: "true", placeholder: "Starting the session…" });
			assert.equal(await ui.evaluate("document.querySelector('.omp-notice-description').textContent"), "Starting the session…", "the banner acknowledges too");
			await ui.evaluate("document.querySelector('.omp-composer button[disabled]')?.click()");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-resume').length"), 1, "a second click sends nothing");
			const requestId = await ui.evaluate<string>("window.sent.find(message=>message.type==='omp:chat-resume').requestId");
			await ui.evaluate(`window.ui.receive({type:'omp:chat-operation',operation:{kind:'resume',step:'ownership',elapsedMs:7400,requestId:${JSON.stringify(requestId)},still:false}})`);
			await ui.wait("document.querySelector('.omp-notice-description')?.textContent==='Starting the session · checking for another OMP process · 7 s'");
			assert.equal(await ui.evaluate("document.querySelector('.omp-notice').getAttribute('aria-busy')"), "true");
			await ui.evaluate(`window.ui.receive({type:'omp:chat-operation',operation:null,ended:{kind:'resume',requestId:${JSON.stringify(requestId)},status:'refused'}})`);
			await ui.wait("[...document.querySelectorAll('.omp-composer button')].some(button=>button.textContent==='Resume'&&!button.disabled)");
			assert.equal(await ui.evaluate("window.composer.placeholder()"), "This session is not running. Resume it to send a message.");

			await reset("pending-stop");
			await ui.evaluate("window.ui.push({working:true})");
			await ui.wait("document.querySelector('[aria-label=\"Stop the running turn\"]')");
			const stopped = await ui.evaluate<{ label: string; disabled: boolean; spinner: boolean }>(`new Promise(resolve=>{
			 document.querySelector('[aria-label="Stop the running turn"]').click();
			 requestAnimationFrame(()=>{const button=document.querySelector('[aria-label="Stopping the turn"]');resolve({label:button.textContent.trim(),disabled:button.disabled,spinner:button.querySelector('.codicon-loading')!==null});});})`);
			assert.deepEqual(stopped, { label: "Stopping…", disabled: true, spinner: true });
			await ui.evaluate("window.ui.push({working:false})");
			await ui.wait("!document.querySelector('[aria-label=\"Stopping the turn\"]')");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-abort').length"), 1);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("an autonomous exit shows plain-text stderr and a stopped-session provider login action", async () => {
			await reset("child-exit-reason");
			await ui.evaluate(`window.ui.push({phase:'stopped',code:'child-exited',readOnlyReason:'stopped',exitReason:{exitCode:1,stderr:'No default model selected. Use /login.\\n<script>not markup</script>'}})`);
			await ui.wait("document.querySelector('.omp-notice-description')?.textContent.includes('OMP exited with code 1.')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-notice-description').textContent.includes('<script>not markup</script>')"), true);
			assert.equal(await ui.evaluate("document.querySelector('.omp-notice-description script')"), null);
			await ui.evaluate("Array.from(document.querySelectorAll('.omp-notice button')).find(button=>button.textContent==='Log In to Provider').click()");
			assert.equal(await ui.evaluate("window.sent.at(-1).type==='omp:chat-command' && window.sent.at(-1).command==='provider-login'"), true);
			await ui.evaluate("window.ui.push({phase:'stopped',exitReason:{exitCode:1,stderr:'Could not restore model fixture/missing'}})");
			await ui.wait("document.querySelector('.omp-notice-description')?.textContent.includes('Could not restore model fixture/missing')");
			assert.equal(await ui.evaluate("Array.from(document.querySelectorAll('.omp-notice button')).some(button=>button.textContent==='Log In to Provider')"), false);
			await ui.evaluate("window.ui.push({phase:'live',code:null,readOnlyReason:null,exitReason:undefined})");
			await ui.wait("!document.querySelector('.omp-notice')");
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
			  controls:card.querySelectorAll('.omp-footer-trigger').length,enabled:!card.querySelector('.omp-footer-trigger').disabled,
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
			// The fit at attach is measured while the layout is still settling (here it is a row short), so the report that matters is the
			// last one: each report is debounced behind the fixture clock, and a layout that settles after the first one has its own
			// report after the next tick. The wait fires the clock on every DOM change and every message the page posts, and is done
			// when the terminal shows exactly the rows of the newest report, whichever layout step that report came from.
			const lastReport = "window.sent.filter(message=>message.type==='omp:terminal-resize').at(-1)";
			await ui.wait(`(window.fixtureClock.fire(120),document.querySelectorAll('.xterm-rows > div').length===${lastReport}.rows)`);
			const resized = await ui.evaluate<{ cols: number; rows: number }>(`(()=>{const m=${lastReport};return {cols:m.cols,rows:m.rows}})()`);
			assert.equal(resized.cols, fit.cols, "the PTY is asked for the pane's own columns");
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
			 window.composer.focus();window.composerNode=window.composer.el();
			 window.sample=()=>{const a=window.composer.el(),sel=window.composer.selection(),r=a.getBoundingClientRect(),c=document.querySelector('.omp-composer').getBoundingClientRect(),t=document.querySelector('.omp-transcript');
			  return {same:a===window.composerNode,top:r.top,height:r.height,composerTop:c.top,composerHeight:c.height,gap:t.scrollHeight-t.clientHeight-t.scrollTop,focused:window.composer.focused(),value:window.composer.value(),start:sel.start,end:sel.end,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth}};
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
			assert.ok(samples.every(sample => sample.same && sample.focused), "the field is never remounted or blurred");
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
			await ui.evaluate("window.ui.push({working:true,settled:false});window.composer.focus()");
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
			assert.equal(await ui.evaluate("window.composer.value()"), "draft kept");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
			assert.equal(await ui.evaluate("window.composer.focused()"), true, "the composer takes back the focus its re-attach took by disabling it");
		});
		const focusTraces = (): Promise<string[]> => ui.evaluate("window.sent.filter(message=>message.type==='omp:focus-trace').map(message=>message.detail)");
		await t.test("a composer disabled while the user types is focused again when it is writable, and the trace says why it lost focus", async () => {
			await reset("held-focus");
			await ui.evaluate("window.composer.focus()");
			await ui.call("Input.insertText", { text: "typing" });
			await ui.evaluate("window.ui.push({phase:'resyncing'})");
			await ui.wait("window.composer.disabled() && document.activeElement===document.body");
			await ui.evaluate("window.ui.push({phase:'live'})");
			await ui.wait("!window.composer.disabled() && window.composer.focused()");
			await ui.call("Input.insertText", { text: " on" });
			assert.equal(await ui.evaluate("window.composer.value()"), "typing on");
			await ui.wait("window.sent.some(message=>message.type==='omp:focus-trace')");
			const [line] = await focusTraces();
			assert.match(line!, /^composer disabled while it held focus \| /);
			assert.match(line!, /composer not writable: phase=resyncing/);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});
		await t.test("a composer the user left while it was disabled is not focused again", async () => {
			await reset("held-focus-left");
			await ui.evaluate("window.composer.focus()");
			await ui.evaluate("window.ui.push({phase:'attaching'})");
			await ui.wait("window.composer.disabled()");
			await ui.evaluate("document.querySelector('.omp-transcript').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
			await ui.evaluate("window.ui.push({phase:'live'})");
			await ui.wait("!window.composer.disabled()");
			assert.equal(await ui.evaluate("window.composer.focused()"), false);
		});
		await t.test("a composer blurred by script is reported with the caller, and one the user left is not", async () => {
			await reset("focus-trace-blur");
			await ui.evaluate("window.composer.focus()");
			await ui.evaluate("new Promise(resolve=>setTimeout(resolve,500))");
			await ui.evaluate("window.composer.blur()");
			await ui.wait("window.sent.some(message=>message.type==='omp:focus-trace')");
			const [line] = await focusTraces();
			assert.match(line!, /^composer lost focus to none \| /);
			assert.match(line!, /blur\(\) div\.omp-composer-input by /);
			await ui.evaluate("new Promise(resolve=>setTimeout(resolve,1100))");
			await ui.evaluate("window.composer.focus()");
			await ui.evaluate("document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));window.composer.blur()");
			await ui.evaluate("new Promise(resolve=>setTimeout(resolve,100))");
			assert.equal((await focusTraces()).length, 1, "a blur right after a pointer press is the user's");
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
		await t.test("a process that no longer serves the conversation offers Restart and no Reconnect", async () => {
			await reset("identity-restart");
			await ui.evaluate("window.ui.push({phase:'failed',code:'identity-mismatch'})");
			await ui.wait("[...document.querySelectorAll('.omp-notice button')].some(button=>button.textContent==='Restart')");
			assert.equal(await ui.evaluate("[...document.querySelectorAll('.omp-notice button')].some(button=>button.textContent==='Reconnect')"), false);
			await ui.evaluate("[...document.querySelectorAll('.omp-notice button')].find(button=>button.textContent==='Restart').click()");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-restart').length"), 1);
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
			await ui.evaluate("window.ui.push({commands:[{name:'skill:inspect',source:'skill',description:'Inspect source'}]});window.composer.focus()");
			await ui.call("Input.insertText", { text: "/ins" });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			await ui.evaluate("document.querySelector('[aria-label=\"Slash commands\"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
			await settleFrames();
			assert.ok(await ui.evaluate("Boolean(document.querySelector('[aria-label=\"Slash commands\"]'))"), "a press inside the list keeps it");
			await ui.evaluate("document.querySelector('.omp-transcript').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
			await ui.wait("!document.querySelector('[aria-label=\"Slash commands\"]')");
			assert.equal(await ui.evaluate("window.composer.value()"), "/ins", "dismissing keeps the draft");
			// Context popover first, picker second: the picker is the newest layer and takes the first Escape.
			await ui.call("Input.insertText", { text: "p" });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			await clickAt(await centerOf(".omp-context-trigger"));
			await ui.wait("document.querySelector('.omp-context-popover')");
			await ui.wait("window.sent.filter(message=>message.type==='omp:composer-popup').at(-1)?.open===true");
			await ui.evaluate("window.composer.focus()");
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
		  window.composer.focus();
		  window.composer.el().dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));};
		})()`);
		const draftValue = (): Promise<string> => ui.evaluate("window.composer.value()");
		const strip = (): Promise<string[]> => ui.evaluate("[...document.querySelectorAll('.omp-attachment-number')].map(node=>node.textContent)");
		const pasteImage = async (width: number, height: number, marker: string): Promise<void> => {
			await ui.evaluate(`window.pasteImage(${width},${height})`);
			await ui.wait(`window.composer.value().includes(${JSON.stringify(marker)})`);
		};
		const markers = (): Promise<{ start: number; end: number; number: number }[]> => ui.evaluate("(()=>{const value=window.composer.value();return[...value.matchAll(/\\[Image #(\\d+)[^\\]]*\\]/g)].map(match=>({start:match.index,end:match.index+match[0].length,number:Number(match[1])}))})()");
		const setSelection = (start: number, end: number): Promise<unknown> => ui.evaluate(`window.composer.select(${start},${end})`);
		const selection = (): Promise<{ start: number; end: number }> => ui.evaluate("(()=>{const {start,end}=window.composer.selection();return{start,end}})()");
		/** Polls a draft/selection condition (selection changes are not DOM mutations), reporting the draft when it never holds. */
		const waitDraft = async (expression: string): Promise<void> => {
			const held = await ui.evaluate<boolean>(`(async()=>{const deadline=performance.now()+15000;while(performance.now()<deadline){if(${expression})return true;await new Promise(resolve=>requestAnimationFrame(resolve));}return false})()`);
			if (held) return;
			const state = await ui.evaluate("(()=>{const s=window.composer.selection();return{value:window.composer.value(),start:s.start,end:s.end,focused:window.composer.focused()}})()");
			assert.fail(`draft condition never held: ${expression}\n${JSON.stringify(state)}`);
		};
		const FIRST = "A [Image #1, 10x6] B [Image #2, 20x8] C [Image #3, 30x9] D";
		/** Three pasted images with typed text between them. */
		const buildDraft = async (name: string): Promise<void> => {
			await reset(name);
			await installImages();
			await ui.evaluate("window.composer.focus()");
			await ui.call("Input.insertText", { text: "A " });
			await pasteImage(10, 6, "[Image #1, 10x6]");
			await ui.call("Input.insertText", { text: "B " });
			await pasteImage(20, 8, "[Image #2, 20x8]");
			await ui.call("Input.insertText", { text: "C " });
			await pasteImage(30, 9, "[Image #3, 30x9]");
			await ui.call("Input.insertText", { text: "D" });
			await ui.wait(`window.composer.value()===${JSON.stringify(FIRST)}`);
		};

		await t.test("pasted images become sequentially numbered `[Image #N, WxH]` markers at the caret, with matching labelled thumbnails and an inline chip", async () => {
			await buildDraft("image-refs-insert");
			assert.equal(await draftValue(), FIRST);
			assert.deepEqual(await strip(), ["#1", "#2", "#3"]);
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-attachment-thumb')].map(img=>img.alt)"), ["Image #1", "Image #2", "Image #3"]);
			// Inserting in the middle of existing text goes at the caret, not at the end.
			const [, second] = await markers();
			await setSelection(second!.end + 1, second!.end + 1);
			await ui.wait(`window.composer.selection().start===${second!.end + 1}`);
			await pasteImage(40, 11, "[Image #4, 40x11]");
			assert.equal(await draftValue(), "A [Image #1, 10x6] B [Image #2, 20x8] [Image #4, 40x11] C [Image #3, 30x9] D");
			assert.deepEqual(await strip(), ["#1", "#2", "#3", "#4"]);
			// Every marker is an atomic inline chip that holds its own text, labelled like its thumbnail.
			const chips = await ui.evaluate<{ box: number[]; marks: { r: number[]; bg: string; color: string; text: string; role: string | null; label: string | null; editable: string | null }[] }>(`(()=>{
			 const box=window.composer.el().getBoundingClientRect();
			 return{box:[box.left,box.top,box.right,box.bottom],marks:[...document.querySelectorAll('.omp-composer-input .omp-chip')].map(mark=>{const r=mark.getBoundingClientRect();const s=getComputedStyle(mark);return{r:[r.left,r.top,r.right,r.bottom],bg:s.backgroundColor,color:s.color,text:mark.textContent,role:mark.getAttribute('role'),label:mark.getAttribute('aria-label'),editable:mark.getAttribute('contenteditable')}})};})()`);
			assert.equal(chips.marks.length, 4);
			assert.deepEqual(chips.marks.map(mark => mark.label), ["Image #1", "Image #2", "Image #4", "Image #3"]);
			for (const mark of chips.marks) {
				const [left, top, right, bottom] = mark.r as [number, number, number, number];
				assert.ok(right - left > 20 && left >= chips.box[0]! && right <= chips.box[2]! && top >= chips.box[1]! && bottom <= chips.box[3]! && mark.bg !== "rgba(0, 0, 0, 0)", JSON.stringify({ mark, box: chips.box }));
				assert.ok(mark.color !== "rgba(0, 0, 0, 0)" && /^\[Image #\d+, \d+x\d+\]$/.test(mark.text) && mark.role === "img" && mark.editable === "false", JSON.stringify(mark));
			}
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		// Fenced code blocks in the draft (docs/designs/2026-10-15-composer-code-blocks.md).
		const setDraft = (text: string): Promise<unknown> => ui.evaluate(`window.composer.setText(${JSON.stringify(text)})`);
		const areaState = (): Promise<{ value: string; start: number; end: number; focused: boolean }> => ui.evaluate("(()=>{const s=window.composer.selection();return{value:window.composer.value(),start:s.start,end:s.end,focused:window.composer.focused()}})()");
		const undo = (): Promise<void> => press("z", "KeyZ", 90, { modifiers: 2, commands: ["undo"] });
		const tab = (modifiers = 0): Promise<void> => press("Tab", "Tab", 9, modifiers ? { modifiers } : {});
		const sendCount = (): Promise<number> => ui.evaluate("window.ui.sends().length");
		const codeHint = (): Promise<string | null> => ui.evaluate("document.querySelector('.omp-composer-hint--code')?.textContent ?? null");

		await t.test("inside a fenced block Enter and Tab edit like an editor and send nothing; outside it Enter sends, and Ctrl+Enter sends from inside", async () => {
			await reset("code-block-keys");
			await ui.evaluate("window.composer.focus()");
			await ui.call("Input.insertText", { text: "Look at the loop" });
			await press("Enter", "Enter", 13);
			await ui.wait("window.ui.sends().length===1");
			await ui.evaluate("window.ui.sendReply()");
			await ui.wait("window.composer.value()===''");
			assert.equal(await codeHint(), null, "no hint outside a block");
			await setDraft("Look:\n```ts");
			await press("Enter", "Enter", 13);
			assert.deepEqual(await areaState(), { value: "Look:\n```ts\n\n```", start: 12, end: 12, focused: true }, "Enter after an opening fence supplies the closing one and rests between them");
			assert.match((await codeHint())!, /Ctrl\+Enter: send.*Enter: new line.*Tab: indent.*Shift\+Tab: outdent/);
			await ui.call("Input.insertText", { text: "if (x) {" });
			await press("Enter", "Enter", 13);
			await tab();
			await ui.call("Input.insertText", { text: "y();" });
			await press("Enter", "Enter", 13);
			assert.equal((await areaState()).value, "Look:\n```ts\nif (x) {\n    y();\n    \n```", "Enter keeps the indentation of the line");
			await tab(8);
			await ui.call("Input.insertText", { text: "}" });
			const typed = await areaState();
			assert.deepEqual(typed, { value: "Look:\n```ts\nif (x) {\n    y();\n}\n```", start: 31, end: 31, focused: true }, "Shift+Tab outdents and the focus stayed in the composer");
			assert.equal(await sendCount(), 1, "nothing was sent from inside the block");
			await press("Enter", "Enter", 13, { modifiers: 2 });
			await ui.wait("window.ui.sends().length===2");
			assert.equal(await ui.evaluate("window.ui.sends()[1].text"), typed.value, "the sent text is the draft, fences included, unchanged");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Tab and Shift+Tab work on a selection of lines, fence lines stay put, and every key is one native Undo step", async () => {
			await reset("code-block-selection");
			const ORIGINAL = "```\na\n    b\n\nc\n```";
			await setDraft(ORIGINAL);
			await setSelection(4, 14);
			await tab();
			const indented = "```\n    a\n        b\n\n    c\n```";
			assert.deepEqual(await areaState(), { value: indented, start: 4, end: 26, focused: true });
			await tab(8);
			assert.deepEqual(await areaState(), { value: ORIGINAL, start: 4, end: 14, focused: true });
			await undo();
			await ui.wait(`window.composer.value()===${JSON.stringify(indented)}`);
			await undo();
			await ui.wait(`window.composer.value()===${JSON.stringify(ORIGINAL)}`);
			// Tab on a fence line changes nothing and does not leave.
			await setSelection(2, 2);
			await tab();
			assert.deepEqual(await areaState(), { value: ORIGINAL, start: 2, end: 2, focused: true });
			// Enter inside the block is one undo step.
			await setDraft("```\n  x\n```");
			await setSelection(7, 7);
			await press("Enter", "Enter", 13);
			await ui.wait("window.composer.value()==='```\\n  x\\n  \\n```'");
			await undo();
			await ui.wait("window.composer.value()==='```\\n  x\\n```'");
			// So is the supplied closing fence.
			await setDraft("```ts");
			await press("Enter", "Enter", 13);
			await ui.wait("window.composer.value()==='```ts\\n\\n```'");
			await undo();
			await ui.wait("window.composer.value()==='```ts'");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Shift+Enter and Alt+Enter inside a block are newlines, and a selection that straddles a fence keeps Enter sending", async () => {
			await reset("code-block-modifiers");
			await setDraft("a\n```\nb\n```");
			await setSelection(7, 7);
			await press("Enter", "Enter", 13, { modifiers: 8 });
			assert.deepEqual(await areaState(), { value: "a\n```\nb\n\n```", start: 8, end: 8, focused: true });
			await press("Enter", "Enter", 13, { modifiers: 1 });
			assert.deepEqual(await areaState(), { value: "a\n```\nb\n\n\n```", start: 9, end: 9, focused: true });
			assert.equal(await sendCount(), 0, "neither sends");
			await setSelection(0, 8);
			await press("Enter", "Enter", 13);
			await ui.wait("window.ui.sends().length===1");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("an IME composition leaves Enter and Tab inside a block alone", async () => {
			await reset("code-block-ime");
			await setDraft("```\nab\n```");
			await setSelection(6, 6);
			const prevented = await ui.evaluate<boolean[]>(`(()=>{
			 const area=window.composer.el();const out=[];
			 const key=init=>{const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,...init});area.dispatchEvent(event);out.push(event.defaultPrevented)};
			 key({key:'Enter',isComposing:true});key({key:'Tab',keyCode:229});
			 area.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
			 key({key:'Enter'});key({key:'Tab'});
			 area.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}));
			 return out;})()`);
			assert.deepEqual(prevented, [false, false, false, false]);
			assert.equal((await areaState()).value, "```\nab\n```");
			assert.equal(await sendCount(), 0);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("slash and @ completions do not open or search inside a block, and still do outside it", async () => {
			await reset("code-block-completions");
			await ui.evaluate("window.ui.push({commands:[{name:'shake',description:'Shake'}]});window.composer.focus()");
			const popup = (): Promise<boolean> => ui.evaluate("Boolean(document.querySelector('[aria-label=\"Slash commands\"],[aria-label=\"Workspace files\"]'))");
			const lookups = (): Promise<number> => ui.evaluate("window.sent.filter(message=>message.type==='omp:complete-files').length");
			const quiet = (): Promise<unknown> => ui.evaluate("new Promise(resolve=>setTimeout(resolve,500))");
			await setDraft("/sh");
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			await setDraft("```\n/sh");
			await quiet();
			assert.equal(await popup(), false, "a slash inside a block is code");
			const before = await lookups();
			await setDraft("```\n@sr");
			await quiet();
			assert.equal(await popup(), false);
			assert.equal(await lookups(), before, "no file search runs inside a block");
			await setDraft("```\n@sr\n```\n@sr");
			await ui.wait(`window.sent.filter(message=>message.type==='omp:complete-files').length>${before}`);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("only the lines of a fenced block use the editor font on a band; clicks land where the caret belongs at wrap boundaries and while scrolled", async () => {
			await reset("code-block-layout");
			await installImages();
			const prose = "Why does this long first line of prose wrap in the composer when it is wider than the box? ".repeat(2).trimEnd();
			const code = "const wrapped = computeSomethingWithAVeryLongName(argumentNumberOne, argumentNumberTwo, argumentNumberThree);";
			const draft = `${prose}\n\`\`\`ts\n${code}\n    short();\n\`\`\`\nafter text\nmore\nmore\nmore`;
			assert.equal(await ui.evaluate("getComputedStyle(window.composer.el()).fontFamily.includes('Consolas')"), false, "proportional while the draft has no fence");
			await setDraft(draft);
			await ui.wait("document.querySelector('.omp-line--code')");
			const faces = await ui.evaluate<{ prose: string; fence: string; code: string; after: string; band: string; proseBand: string; codeLines: number; scrollbar: number }>(`(()=>{
			 const field=window.composer.el(),lines=[...field.children],style=line=>getComputedStyle(line);
			 return{prose:style(lines[0]).fontFamily,fence:style(lines[1]).fontFamily,code:style(lines[2]).fontFamily,after:style(lines[5]).fontFamily,band:style(lines[2]).backgroundColor,proseBand:style(lines[0]).backgroundColor,codeLines:field.querySelectorAll('.omp-line--code').length,scrollbar:field.offsetWidth-field.clientWidth}})()`);
			assert.ok(faces.fence.includes("Consolas") && faces.code === faces.fence, JSON.stringify(faces));
			assert.ok(!faces.prose.includes("Consolas") && faces.after === faces.prose, `prose stays proportional: ${JSON.stringify(faces)}`);
			assert.ok(faces.band !== "rgba(0, 0, 0, 0)" && faces.proseBand === "rgba(0, 0, 0, 0)", JSON.stringify(faces));
			assert.equal(faces.codeLines, 4, "the fences and the two lines between them are the block");
			assert.ok(faces.scrollbar > 0, "the draft is tall enough to scroll, so the wrapping width includes the scrollbar gutter");
			// Where the browser itself puts the caret for a click: the band must cover exactly the block's rows.
			const fenceLength = "```ts\n".length;
			const block = { start: prose.length + 1, end: draft.indexOf("\nafter text") };
			const rowOfWrap = await ui.evaluate<number>(`(()=>{
			 const text=window.composer.el().children[2].firstChild;const range=document.createRange();
			 const topOf=index=>{range.setStart(text,index);range.setEnd(text,index+1);return range.getBoundingClientRect().top};
			 const first=topOf(0);
			 for(let i=1;i<${code.length};i++)if(topOf(i)>first+5)return i;
			 return -1;})()`);
			assert.ok(rowOfWrap > 20, "the long code line wraps inside the band");
			const probe = async (scrollTop: number): Promise<number> => {
				await ui.evaluate(`(()=>{window.composer.el().scrollTop=${scrollTop}})()`);
				await settleFrames();
				const geometry = await ui.evaluate<{ left: number; right: number; top: number; bottom: number; band: { top: number; bottom: number; left: number; right: number }; wrapY: number }>(`(()=>{
				 const field=window.composer.el(),box=field.getBoundingClientRect(),lines=[...field.children];
				 const first=lines[1].getBoundingClientRect(),last=lines[4].getBoundingClientRect();
				 const text=lines[2].firstChild;const range=document.createRange();const at=${rowOfWrap};
				 range.setStart(text,at);range.setEnd(text,at+1);const wrap=range.getBoundingClientRect();
				 return{left:box.left,right:box.right-(field.offsetWidth-field.clientWidth),top:box.top,bottom:box.bottom,band:{top:first.top,bottom:last.bottom,left:first.left,right:first.right},wrapY:wrap.top+wrap.height/2}})()`);
				assert.ok(geometry.band.left <= geometry.left + 0.5 && geometry.band.right >= geometry.right - 0.5, `the band reaches the field's edges: ${JSON.stringify(geometry)}`);
				const visible = (y: number): boolean => y > geometry.top + 4 && y < geometry.bottom - 4;
				const targets: [string, number, number, number][] = [
					["the last row above the band ends at the end of the prose", geometry.band.top - 10, geometry.right - 16, block.start - 1],
					["the band's first row starts at the opening fence", geometry.band.top + 10, geometry.left + 13, block.start],
					["the second row of the wrapped code line starts at the wrap point", geometry.wrapY, geometry.left + 13, block.start + fenceLength + rowOfWrap],
					["the band's last row ends at the closing fence", geometry.band.bottom - 10, geometry.right - 16, block.end],
					["the first row below the band starts the next line", geometry.band.bottom + 10, geometry.left + 13, block.end + 1],
				];
				let checked = 0;
				for (const [what, y, x, expected] of targets) {
					if (!visible(y)) continue;
					await clickAt({ x, y });
					const { start } = await areaState();
					assert.equal(start, expected, `${what} (scrollTop ${scrollTop}) ${JSON.stringify({ x, y, geometry, rowOfWrap, fenceLength, block })}`);
					// The hint follows the caret: shown with the caret in the block, gone with it outside.
					await ui.wait(`(document.querySelector('.omp-composer-hint--code')?.textContent ?? '')!=='' === ${expected >= block.start && expected <= block.end}`);
					assert.equal(await ui.evaluate("window.composer.el().getBoundingClientRect().top"), geometry.top, "the hint changing its words never moves the text");
					checked++;
				}
				return checked;
			};
			assert.ok(await probe(0) >= 3, "rows checked at the top");
			assert.ok(await probe(10_000) >= 2, "rows checked after scrolling to the bottom");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("an image marker typed into a block keeps its chip inside the band, and the draft is proportional again once the fence is gone", async () => {
			await reset("code-block-chip");
			await installImages();
			await setDraft("```\n");
			await pasteImage(10, 6, "[Image #1, 10x6]");
			await ui.wait("document.querySelector('.omp-line--code .omp-chip')");
			const inside = await ui.evaluate<boolean>(`(()=>{const chip=document.querySelector('.omp-line--code .omp-chip'),band=chip.closest('.omp-line--code').getBoundingClientRect(),mark=chip.getBoundingClientRect();
			 return mark.left>=band.left&&mark.right<=band.right&&mark.top>=band.top-0.5&&mark.bottom<=band.bottom+0.5})()`);
			assert.equal(inside, true, "the chip sits inside the band");
			assert.deepEqual(await strip(), ["#1"]);
			await setDraft("plain");
			await ui.wait("!document.querySelector('.omp-line--code')");
			assert.equal(await ui.evaluate("getComputedStyle(window.composer.el()).fontFamily.includes('Consolas')"), false);
			assert.equal(await codeHint(), null);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Shift+Tab on an unindented line is the keyboard's way out of a block, backwards; Escape alone changes nothing", async () => {
			await reset("code-block-leave");
			await setDraft("```\n  x");
			await tab(8);
			assert.deepEqual(await areaState(), { value: "```\nx", start: 5, end: 5, focused: true }, "the first Shift+Tab outdents");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer-hint--code').getAttribute('role')"), "status", "the hint is announced when it appears");
			await tab(8);
			const left = await areaState();
			assert.equal(left.focused, false, "the next one has nothing to outdent and leaves the textarea");
			assert.equal(left.value, "```\nx");
			await setSelection(5, 5);
			await press("Escape", "Escape", 27);
			await tab();
			assert.deepEqual(await areaState(), { value: "```\nx   ", start: 8, end: 8, focused: true }, "Escape arms nothing: Tab still indents");
			assert.equal(await sendCount(), 0);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("adjacent blocks and a block beside an empty line add no row: one line is one row and the bands touch", async () => {
			await reset("code-block-rows");
			const rows = (): Promise<{ lines: number; heights: number[]; gaps: number[] }> => ui.evaluate("(()=>{const lines=[...window.composer.el().children].map(line=>line.getBoundingClientRect());return{lines:lines.length,heights:lines.map(rect=>rect.height),gaps:lines.slice(1).map((rect,index)=>rect.top-lines[index].bottom)}})()");
			for (const draft of ["```\na\n```\n```\nb\n```", "\n```\na\n```\n\n```ts\nb\n```\n", "text\n```\n```\n```\n```\ntail"]) {
				await setDraft(draft);
				await ui.wait("document.querySelector('.omp-line--code')");
				const { lines, heights, gaps } = await rows();
				assert.equal(lines, draft.split("\n").length, `a line element per line of ${JSON.stringify(draft)}`);
				assert.ok(heights.every(height => height === 20) && gaps.every(gap => gap === 0), `each row is one 20px line and the bands touch: ${JSON.stringify({ heights, gaps })}`);
			}
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a quote line is a band with a bar and muted proportional text, a nested fence is monospace inside it, a > line in a block stays code, and typing > rebuilds only that line", async () => {
			await reset("quote-band");
			const draft = "intro\n> quoted line\n> ```ts\n> const x = 1;\n> ```\n> > nested\n\nafter\n```\n> not a quote\n```";
			await setDraft(draft);
			await ui.wait("document.querySelector('.omp-line--quote')");
			const facts = await ui.evaluate<{ classes: string[]; prose: string; quote: string; nested: string; bar: string; tint: string; plainTint: string; nestedTint: string; heights: number[]; gaps: number[] }>(`(()=>{
			 const lines=[...window.composer.el().children],style=line=>getComputedStyle(line),rects=lines.map(line=>line.getBoundingClientRect());
			 return{classes:lines.map(line=>line.className.replace('omp-line','').trim()),prose:style(lines[0]).fontFamily,quote:style(lines[1]).fontFamily,nested:style(lines[3]).fontFamily,bar:style(lines[1]).borderLeftWidth,
			  tint:style(lines[1]).backgroundColor,plainTint:style(lines[0]).backgroundColor,nestedTint:style(lines[3]).backgroundColor,heights:rects.map(rect=>rect.height),gaps:rects.slice(1).map((rect,index)=>rect.top-rects[index].bottom)}})()`);
			assert.deepEqual(facts.classes, ["", "omp-line--quote", "omp-line--quote omp-line--quote-code", "omp-line--quote omp-line--quote-code", "omp-line--quote omp-line--quote-code", "omp-line--quote", "", "", "omp-line--code omp-line--fence", "omp-line--code", "omp-line--code omp-line--fence"]);
			assert.ok(!facts.prose.includes("Consolas") && facts.quote === facts.prose, `quote text stays proportional: ${JSON.stringify(facts)}`);
			assert.ok(facts.nested.includes("Consolas"), `a fence nested in a quote is monospace: ${JSON.stringify(facts)}`);
			assert.equal(facts.bar, "3px");
			assert.ok(facts.tint !== "rgba(0, 0, 0, 0)" && facts.plainTint === "rgba(0, 0, 0, 0)" && facts.nestedTint === facts.tint, `one band, with no second one for the nested fence: ${JSON.stringify(facts)}`);
			assert.ok(facts.heights.every(height => height === 20) && facts.gaps.every(gap => gap === 0), `each row is one 20px line: ${JSON.stringify(facts)}`);
			assert.deepEqual(await ui.evaluate("window.composer.roundTrip()"), [], "every model offset round-trips through the DOM with quote lines in the draft");
			// Typing > at the start of a line makes that line a quote and nothing else is rebuilt; removing it rebuilds that line again.
			await ui.evaluate("[...window.composer.el().children].forEach((line,index)=>{line.__keep=index})");
			const afterAt = draft.indexOf("\nafter") + 1;
			await ui.evaluate("window.composer.focus()");
			await setSelection(afterAt, afterAt);
			await ui.call("Input.insertText", { text: ">" });
			await waitDraft(`window.composer.value()===${JSON.stringify(`${draft.slice(0, afterAt)}>${draft.slice(afterAt)}`)}`);
			assert.deepEqual(await ui.evaluate("[...window.composer.el().children].map(line=>line.__keep===undefined?'new':line.__keep)"), [0, 1, 2, 3, 4, 5, 6, "new", 8, 9, 10]);
			assert.equal(await ui.evaluate("window.composer.el().children[7].className"), "omp-line omp-line--quote");
			await press("Backspace", "Backspace", 8);
			await waitDraft(`window.composer.value()===${JSON.stringify(draft)}`);
			assert.deepEqual(await ui.evaluate("[...window.composer.el().children].map(line=>line.__keep===undefined?'new':line.__keep)"), [0, 1, 2, 3, 4, 5, 6, "new", 8, 9, 10]);
			assert.equal(await ui.evaluate("window.composer.el().children[7].className"), "omp-line");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the quote band follows the theme: a solid band with the text colour's bar in forced colours, the theme's contrast border in High Contrast", async () => {
			await reset("quote-band-themes");
			await setDraft("> quoted");
			await ui.wait("document.querySelector('.omp-line--quote')");
			const read = (): Promise<{ bar: string; text: string; background: string }> => ui.evaluate("(()=>{const style=getComputedStyle(document.querySelector('.omp-line--quote'));return{bar:style.borderLeftColor,text:style.color,background:style.backgroundColor}})()");
			await ui.evaluate("document.body.classList.add('vscode-high-contrast');document.documentElement.style.setProperty('--vscode-contrastBorder','#ff0000')");
			assert.equal((await read()).bar, "rgb(255, 0, 0)", "High Contrast uses the theme's own border");
			await ui.evaluate("document.body.classList.remove('vscode-high-contrast');document.documentElement.style.removeProperty('--vscode-contrastBorder')");
			// setEmulatedMedia replaces every feature: keep the file's motion pin, or a CI image's OS setting leaks into the tests after this one.
			await ui.call("Emulation.setEmulatedMedia", { features: [...MOTION_ALLOWED, { name: "forced-colors", value: "active" }] });
			try {
				const forced = await read();
				assert.equal(forced.bar, forced.text, "the bar is drawn in the system text colour");
				assert.match(forced.background, /^rgb\(/, "an opaque system background, not the tint");
			} finally {
				await ui.call("Emulation.setEmulatedMedia", { features: [...MOTION_ALLOWED, { name: "forced-colors", value: "none" }] });
			}
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Enter, Shift+Enter and Alt+Enter continue a quote and an empty quote line lets go of it, Shift+Tab leaves it, Ctrl+Enter sends, Backspace at its prefix removes a level, Delete joins the next quote line, and no completion opens in one", async () => {
			await reset("quote-keys");
			await ui.evaluate("window.ui.push({commands:[{name:'shake',description:'Shake'}]});window.composer.focus()");
			const shiftEnter = (): Promise<void> => press("Enter", "Enter", 13, { modifiers: 8 });
			const altEnter = (): Promise<void> => press("Enter", "Enter", 13, { modifiers: 1 });
			const shiftTab = (): Promise<void> => press("Tab", "Tab", 9, { modifiers: 8 });
			await setDraft("> ab");
			await setSelection(3, 3);
			await press("Enter", "Enter", 13);
			assert.deepEqual(await areaState(), { value: "> a\n> b", start: 6, end: 6, focused: true }, "Enter is a line break that carries the prefix");
			assert.equal(await sendCount(), 0, "Enter in a quote sends nothing");
			await undo();
			await waitDraft("window.composer.value()==='> ab'");
			assert.equal((await areaState()).value, "> ab", "one Ctrl+Z takes the whole continuation back");
			for (const key of [shiftEnter, altEnter]) {
				await setDraft("> > ab");
				await setSelection(5, 5);
				await key();
				assert.deepEqual(await areaState(), { value: "> > a\n> > b", start: 10, end: 10, focused: true });
			}
			assert.equal(await sendCount(), 0);
			// An empty quote line lets go of one level, the caret staying on the line.
			await setDraft("> a\n> ");
			await setSelection(6, 6);
			await press("Enter", "Enter", 13);
			assert.deepEqual(await areaState(), { value: "> a\n", start: 4, end: 4, focused: true }, "Enter on an empty quote line leaves the quote");
			await undo();
			await waitDraft("window.composer.value()==='> a\\n> '");
			await setDraft("> a\n> > ");
			await setSelection(8, 8);
			await press("Enter", "Enter", 13);
			assert.deepEqual(await areaState(), { value: "> a\n> ", start: 6, end: 6, focused: true }, "a nested line drops one level");
			assert.equal(await sendCount(), 0);
			// Shift+Tab leaves the quote: a plain line after the current one, one level out for a nested line, and the focus stays in the field.
			await setDraft("> a");
			await setSelection(3, 3);
			await shiftTab();
			assert.deepEqual(await areaState(), { value: "> a\n", start: 4, end: 4, focused: true }, "a new plain line, the caret on it, the focus kept");
			await undo();
			await waitDraft("window.composer.value()==='> a'");
			await setDraft("> > ab");
			await setSelection(4, 4);
			await shiftTab();
			assert.deepEqual(await areaState(), { value: "> > ab\n> ", start: 9, end: 9, focused: true }, "one level out for a nested line, the text after the caret stays where it was");
			await setDraft("> a\n> ");
			await setSelection(6, 6);
			await shiftTab();
			assert.deepEqual(await areaState(), { value: "> a\n", start: 4, end: 4, focused: true }, "on an empty quote line it removes the prefix");
			assert.equal(await sendCount(), 0);
			// With the caret inside the prefix Shift+Tab is the browser's: the text is untouched.
			await setDraft("> a");
			await setSelection(1, 1);
			await shiftTab();
			assert.equal((await areaState()).value, "> a");
			await ui.evaluate("window.composer.focus()");
			// A fenced block nested in the quote: a blank line there stays in the quote.
			await setDraft("> ```ts\n> \n> ```");
			await setSelection(10, 10);
			await press("Enter", "Enter", 13);
			assert.deepEqual(await areaState(), { value: "> ```ts\n> \n> \n> ```", start: 13, end: 13, focused: true }, "Enter inside a nested fence keeps the prefix, even on an empty line");
			await setDraft("> > x");
			await setSelection(4, 4);
			await press("Backspace", "Backspace", 8);
			assert.deepEqual(await areaState(), { value: "> x", start: 2, end: 2, focused: true }, "one level at a time");
			await press("Backspace", "Backspace", 8);
			assert.deepEqual(await areaState(), { value: "x", start: 0, end: 0, focused: true }, "the last level takes the whole prefix");
			await setDraft("> a\n> b");
			await setSelection(3, 3);
			await press("Delete", "Delete", 46);
			assert.deepEqual(await areaState(), { value: "> ab", start: 3, end: 3, focused: true }, "the next line's prefix goes with the line break");
			// Ctrl+Enter sends from inside a quote line, and the hint says so.
			await setDraft("> q");
			await setSelection(3, 3);
			assert.match((await codeHint())!, /^Quote · Ctrl\+Enter: send · Enter: new line · Shift\+Tab: leave the quote$/, "the hint names the quote keys while the caret is in a quote line");
			await press("Enter", "Enter", 13, { modifiers: 2 });
			await ui.wait("window.ui.sends().length===1");
			assert.equal(await ui.evaluate("window.ui.sends()[0].text"), "> q");
			await ui.evaluate("window.ui.sendReply()");
			await ui.wait("window.composer.value()===''");
			// The hint row stays while the draft holds a quote, empty with the caret elsewhere; the field names it as its description only inside a quote.
			await setDraft("> q\nplain");
			await setSelection(9, 9);
			assert.equal(await codeHint(), "");
			assert.equal(await ui.evaluate("window.composer.el().getAttribute('aria-describedby')"), null);
			await setSelection(2, 2);
			await ui.wait("(document.querySelector('.omp-composer-hint--code')?.textContent??'')!==''");
			assert.equal(await ui.evaluate("window.composer.el().getAttribute('aria-describedby')===document.querySelector('.omp-composer-hint--code').id"), true);
			// No completion popup or file search opens in a quote line, and both still open outside it.
			const popup = (): Promise<boolean> => ui.evaluate("Boolean(document.querySelector('[aria-label=\"Slash commands\"],[aria-label=\"Workspace files\"]'))");
			const lookups = (): Promise<number> => ui.evaluate("window.sent.filter(message=>message.type==='omp:complete-files').length");
			const quiet = (): Promise<unknown> => ui.evaluate("new Promise(resolve=>setTimeout(resolve,500))");
			await setDraft("> /sh");
			await quiet();
			assert.equal(await popup(), false, "a slash in a quote is the agent's text");
			const before = await lookups();
			await setDraft("> @sr");
			await quiet();
			assert.equal(await popup(), false);
			assert.equal(await lookups(), before, "no file search runs in a quote line");
			await setDraft("> q\n@sr");
			await ui.wait(`window.sent.filter(message=>message.type==='omp:complete-files').length>${before}`);
			// An IME composition leaves Enter and Shift+Tab alone.
			const sentBefore = await sendCount();
			await setDraft("> a");
			await setSelection(3, 3);
			const prevented = await ui.evaluate<boolean[]>(`(()=>{
			 const area=window.composer.el();const out=[];
			 const key=init=>{const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,...init});area.dispatchEvent(event);out.push(event.defaultPrevented)};
			 key({key:'Enter',isComposing:true});key({key:'Tab',shiftKey:true,keyCode:229});
			 area.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
			 key({key:'Enter'});key({key:'Tab',shiftKey:true});
			 area.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}));
			 return out;})()`);
			assert.deepEqual(prevented, [false, false, false, false]);
			assert.equal((await areaState()).value, "> a");
			assert.equal(await sendCount(), sentBefore, "nothing was sent");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		const quoteIn = (source: string): Promise<unknown> => ui.evaluate(`window.requestQuote({kind:'selection',plain:false,source:${JSON.stringify(source)}})`);
		const hintText = (): Promise<string | null> => codeHint();

		await t.test("a quote lands at the end of the draft after a blank line, the caret on the line under it with the focus in the field, and one Ctrl+Z takes it back", async () => {
			await reset("quote-insert");
			await ui.call("Emulation.setFocusEmulationEnabled", { enabled: true });
			try {
				await setDraft("hello");
				await ui.evaluate("window.composer.el().blur()");
				await quoteIn("a\n\n```ts\nx\n```");
				const expected = "hello\n\n> a\n>\n> ```ts\n> x\n> ```\n";
				await waitDraft(`window.composer.value()===${JSON.stringify(expected)}`);
				assert.deepEqual(await areaState(), { value: expected, start: expected.length, end: expected.length, focused: true }, "the caret is on the empty line under the quote and the field has the focus");
				assert.equal(await hintText(), "Quoted 5 lines into the draft");
				assert.equal(await ui.evaluate("window.composer.el().children.length"), 8, "the quote's five lines, the blank line, hello and the line under the quote");
				await undo();
				await waitDraft("window.composer.value()==='hello'");
				// An empty draft, a draft with a comment and a second quote.
				await setDraft("");
				await quoteIn("first");
				await waitDraft("window.composer.value()==='> first\\n'");
				await ui.call("Input.insertText", { text: "my comment" });
				await quoteIn("second");
				await waitDraft(`window.composer.value()===${JSON.stringify("> first\nmy comment\n\n> second\n")}`);
				assert.equal(await sendCount(), 0, "quoting never sends");
				assert.deepEqual(await ui.evaluate("window.errors"), []);
			} finally {
				await ui.call("Emulation.setFocusEmulationEnabled", { enabled: false });
			}
		});

		await t.test("a quote is refused while the hand-off holds the draft and nothing is inserted later; over the limit and empty it says why", async () => {
			await reset("quote-refusals");
			await setDraft("kept");
			await ui.evaluate("window.ui.receive({type:'omp:draft-request',requestId:900})");
			await ui.wait("window.sent.some(message=>message.type==='omp:draft-reply'&&message.requestId===900)&&window.composer.readOnly()");
			await quoteIn("must not land");
			await ui.wait("(document.querySelector('.omp-composer-hint--code')?.textContent??'').startsWith('Your draft is being moved to a new editor')");
			await ui.evaluate("window.ui.receive({type:'omp:draft-release',requestId:900})");
			await ui.wait("!window.composer.readOnly()");
			await settleFrames();
			assert.equal((await areaState()).value, "kept", "released, still nothing inserted");
			await quoteIn("x".repeat(31_482));
			await ui.wait("document.querySelector('.omp-composer-hint--code')?.textContent==='That selection is 31 482 characters; Quote takes at most 20 000.'");
			await quoteIn("  \n ");
			await ui.wait("document.querySelector('.omp-composer-hint--code')?.textContent==='Select text in the conversation first'");
			await quoteIn("x".repeat(20_000));
			await ui.wait("window.composer.value().length>20000");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("each quote run has a Remove quote button in its gutter: named, a Tab stop, beside the first visible line, never over text; a click removes the run and its line break as one undo step and keeps focus", async () => {
			await reset("quote-remove");
			await ui.call("Emulation.setFocusEmulationEnabled", { enabled: true });
			try {
				await setDraft("intro\n\n> first quote\n> second line\nmy comment\n\n> other quote\n");
				await ui.wait("document.querySelectorAll('.omp-quote-remove').length===2");
				const buttons = (): Promise<{ label: string; disabled: boolean; top: number; right: number; lineTop: number; textLeft: number }[]> => ui.evaluate(`(()=>{
				 const field=window.composer.el(),lines=[...field.children];
				 return[...document.querySelectorAll('.omp-quote-remove')].map(button=>{
				  const rect=button.getBoundingClientRect(),line=lines.find(candidate=>candidate.classList.contains('omp-line--quote')&&Math.abs(candidate.getBoundingClientRect().top-rect.top)<4);
				  const range=document.createRange();range.setStart(line.firstChild,0);range.setEnd(line.firstChild,1);
				  return{label:button.getAttribute('aria-label'),disabled:button.disabled,top:rect.top,right:rect.right,lineTop:line.getBoundingClientRect().top,textLeft:range.getBoundingClientRect().left}})})()`);
				const found = await buttons();
				assert.deepEqual(found.map(button => button.label), ["Remove quote: «first quote»", "Remove quote: «other quote»"]);
				assert.ok(found.every(button => Math.abs(button.top - button.lineTop) < 2 && button.right <= button.textLeft), `each is beside its run's first line and left of the text: ${JSON.stringify(found)}`);
				// A Tab stop after the field.
				await ui.evaluate("window.composer.focus()");
				await press("Tab", "Tab", 9);
				assert.equal(await ui.evaluate("document.activeElement?.getAttribute('aria-label')"), "Remove quote: «first quote»");
				// A click keeps the field's focus and selection, removes the run and its line break, and leaves the comment.
				await ui.evaluate("window.composer.focus()");
				await setSelection(2, 4);
				await clickAt(await centerOf(".omp-quote-remove"));
				await waitDraft(`window.composer.value()===${JSON.stringify("intro\n\nmy comment\n\n> other quote\n")}`);
				const after = await areaState();
				assert.equal(after.focused, true, "the field kept the focus through the click");
				assert.equal(await ui.evaluate("document.querySelectorAll('.omp-quote-remove').length"), 1);
				await undo();
				await waitDraft(`window.composer.value()===${JSON.stringify("intro\n\n> first quote\n> second line\nmy comment\n\n> other quote\n")}`);
				// A click on the last character of a full-width quote line places the caret there and removes nothing.
				const lastChar = await ui.evaluate<{ x: number; y: number }>(`(()=>{const line=window.composer.el().children[2],text=line.firstChild,range=document.createRange();range.setStart(text,text.length-1);range.setEnd(text,text.length);const box=range.getBoundingClientRect();return{x:box.right-1,y:box.top+box.height/2}})()`);
				await clickAt(lastChar);
				await settleFrames();
				const placed = await areaState();
				assert.equal(placed.value.includes("first quote"), true, "no quote was removed");
				assert.equal(placed.start, "intro\n\n> first quote".length);
				assert.deepEqual(await ui.evaluate("window.errors"), []);
			} finally {
				await ui.call("Emulation.setFocusEmulationEnabled", { enabled: false });
			}
		});

		await t.test("every way a quote goes is one Ctrl+Z from coming back, whether the removal was a click or a key on the Remove quote button, a deleted selection or Backspace taking prefix levels, and the focus is in the field afterwards", async () => {
			await reset("quote-undo");
			await ui.call("Emulation.setFocusEmulationEnabled", { enabled: true });
			try {
				const draft = "intro\n\n> first quote\n> second line\nmy comment\n\n> other quote\n";
				const removed = "intro\n\nmy comment\n\n> other quote\n";
				const quoteStart = "intro\n\n".length;
				/** Ctrl+Z as the keyboard sends it: only the keydown the field's handler reads, no editing command to fall back on. */
				const ctrlZ = (): Promise<void> => press("z", "KeyZ", 90, { modifiers: 2 });
				const expectRestored = async (what: string, expected: string): Promise<void> => {
					await ctrlZ();
					await waitDraft(`window.composer.value()===${JSON.stringify(expected)}`);
					assert.equal((await areaState()).focused, true, `${what}: the field has the focus after Ctrl+Z`);
				};
				const expectRemoved = async (what: string, caret: number): Promise<void> => {
					await waitDraft(`window.composer.value()===${JSON.stringify(removed)}`);
					assert.deepEqual(await areaState(), { value: removed, start: caret, end: caret, focused: true }, `${what}: the caret is where the quote was and the field has the focus`);
				};
				const prepare = async (): Promise<void> => {
					await setDraft(draft);
					await ui.wait("document.querySelectorAll('.omp-quote-remove').length===2");
				};
				// The mouse with the focus elsewhere (a press on the button keeps the focus where it is, and that was not the field).
				await prepare();
				await ui.evaluate("window.composer.el().blur()");
				assert.equal((await areaState()).focused, false);
				await clickAt(await centerOf(".omp-quote-remove"));
				await expectRemoved("click with the field unfocused", quoteStart);
				await expectRestored("click with the field unfocused", draft);
				// The mouse with the field focused.
				await prepare();
				await ui.evaluate("window.composer.focus()");
				await setSelection(2, 4);
				await clickAt(await centerOf(".omp-quote-remove"));
				await expectRemoved("click with the field focused", quoteStart);
				await expectRestored("click with the field focused", draft);
				// The keyboard: Tab from the field, then Enter or Space on the button; the button is gone after the removal, so the focus must not be lost with it.
				for (const [name, key, code, keyCode, text] of [["Enter", "Enter", "Enter", 13, "\r"], ["Space", " ", "Space", 32, " "]] as const) {
					await prepare();
					await ui.evaluate("window.composer.focus()");
					await setSelection(0, 0);
					await press("Tab", "Tab", 9);
					assert.equal(await ui.evaluate("document.activeElement?.getAttribute('aria-label')"), "Remove quote: «first quote»");
					await press(key, code, keyCode, { text });
					await expectRemoved(`${name} on the button`, quoteStart);
					await expectRestored(`${name} on the button`, draft);
				}
				// A selection over the quote lines, deleted by Backspace and by Delete.
				for (const key of ["Backspace", "Delete"]) {
					await prepare();
					await ui.evaluate("window.composer.focus()");
					await setSelection(quoteStart, quoteStart + "> first quote\n> second line".length);
					await press(key, key, key === "Backspace" ? 8 : 46);
					await waitDraft(`window.composer.value()===${JSON.stringify("intro\n\n\nmy comment\n\n> other quote\n")}`);
					await expectRestored(`${key} on the selected quote`, draft);
				}
				// Backspace taking the prefix level by level: each level is a step of its own.
				await setDraft("> > x");
				await ui.evaluate("window.composer.focus()");
				await setSelection(4, 4);
				await press("Backspace", "Backspace", 8);
				await waitDraft("window.composer.value()==='> x'");
				await press("Backspace", "Backspace", 8);
				await waitDraft("window.composer.value()==='x'");
				await expectRestored("second level", "> x");
				await expectRestored("first level", "> > x");
				assert.deepEqual(await ui.evaluate("window.errors"), []);
			} finally {
				await ui.call("Emulation.setFocusEmulationEnabled", { enabled: false });
			}
		});

		await t.test("the Remove quote buttons follow an edit, a scroll and a resize, are absent for a run scrolled out of view, wait out an IME composition and are disabled while the draft is held", async () => {
			await reset("quote-remove-layout");
			await ui.call("Emulation.setFocusEmulationEnabled", { enabled: true });
			try {
				const filler = Array.from({ length: 14 }, (_, index) => `filler line ${index}`).join("\n");
				await setDraft(`${filler}\n\n> a quote that is long enough to wrap when the panel is made narrow, so that its first line stays where it is\n`);
				await ui.wait("document.querySelectorAll('.omp-quote-remove').length===1");
				const follow = (): Promise<{ matches: boolean; present: number }> => ui.evaluate(`(()=>{const button=document.querySelector('.omp-quote-remove');if(!button)return{matches:false,present:0};
				 const line=[...window.composer.el().children].find(candidate=>candidate.classList.contains('omp-line--quote'));return{matches:Math.abs(button.getBoundingClientRect().top-line.getBoundingClientRect().top)<2,present:1}})()`);
				const scroll = async (top: number): Promise<void> => { await ui.evaluate(`window.composer.el().scrollTop=${top}`); await settleFrames(); await settleFrames(); };
				await scroll(1_000_000);
				assert.deepEqual(await follow(), { matches: true, present: 1 }, "at the bottom, beside the quote");
				await scroll(0);
				assert.equal((await follow()).present, 0, "a run scrolled out of the field has no button");
				await scroll(1_000_000);
				assert.deepEqual(await follow(), { matches: true, present: 1 });
				// An edit above the quote moves it; the button moves with it.
				await ui.evaluate("window.composer.focus()");
				await setSelection(0, 0);
				await ui.call("Input.insertText", { text: "one\ntwo\nthree\n" });
				await settleFrames();
				await scroll(1_000_000);
				assert.deepEqual(await follow(), { matches: true, present: 1 }, "after an edit");
				// A resize wraps the quote and the field's height changes; the button stays at its first line.
				await ui.call("Emulation.setDeviceMetricsOverride", { width: 240, height: 900, deviceScaleFactor: 1, mobile: false });
				await ui.settleGeometry(".omp-composer");
				await scroll(1_000_000);
				assert.deepEqual(await follow(), { matches: true, present: 1 }, "after a resize");
				await ui.call("Emulation.clearDeviceMetricsOverride");
				await ui.settleGeometry(".omp-composer");
				// A composition in progress: the click waits for its settle, in the same editor.
				await setDraft("note\n\n> held quote\n");
				await ui.wait("document.querySelectorAll('.omp-quote-remove').length===1");
				await ui.evaluate("window.composer.focus()");
				await setSelection("note\n\n> held quote\n".length, "note\n\n> held quote\n".length);
				await ui.call("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
				await ui.wait("window.composer.value().endsWith('か')");
				await ui.evaluate("document.querySelector('.omp-quote-remove').click()");
				await settleFrames();
				assert.equal((await areaState()).value.includes("held quote"), true, "nothing changes while the composition is open");
				await ui.call("Input.insertText", { text: "か" });
				await ui.wait("!window.composer.value().includes('held quote')");
				assert.ok((await areaState()).value.startsWith("note"), "the quote went and the rest stayed");
				// While the hand-off holds the draft the button is disabled.
				await setDraft("> held\n");
				await ui.wait("document.querySelectorAll('.omp-quote-remove').length===1");
				await ui.evaluate("window.ui.receive({type:'omp:draft-request',requestId:901})");
				await ui.wait("window.composer.readOnly()");
				assert.equal(await ui.evaluate("document.querySelector('.omp-quote-remove').disabled"), true);
				await ui.evaluate("window.ui.receive({type:'omp:draft-release',requestId:901})");
				await ui.wait("!window.composer.readOnly() && !document.querySelector('.omp-quote-remove').disabled");
				assert.deepEqual(await ui.evaluate("window.errors"), []);
			} finally {
				await ui.call("Emulation.clearDeviceMetricsOverride");
				await ui.call("Emulation.setFocusEmulationEnabled", { enabled: false });
			}
		});

		type Captured = { kind: "quote"; source: string; plain: boolean } | { kind: "none"; message: string };
		/** The transcript holds exactly these messages (every one a root). */
		const showMessages = (messages: unknown[]): Promise<unknown> => ui.evaluate(`(()=>{
		 const entries=${JSON.stringify(messages)}.map((message,index)=>({type:'message',id:'q-'+index,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message}));
		 window.ui.push({entries,durableCount:entries.length,working:false,settled:true})})()`);
		const assistantMessage = (content: unknown[], extra: Record<string, unknown> = {}) => ({ role: "assistant", model: "m", timestamp: 2, stopReason: "stop", content, ...extra });
		/** Selects from the first `start` in the transcript's text to the first `end` after it, and captures it as the page does. */
		const quoteBetween = (start: string, end: string): Promise<Captured> => ui.evaluate(`(()=>{
		 const S=${JSON.stringify(start)},E=${JSON.stringify(end)};
		 const walker=document.createTreeWalker(document.querySelector('.omp-transcript'),NodeFilter.SHOW_TEXT);
		 let from=null,to=null,node;
		 while((node=walker.nextNode())){
		  if(from===null){const i=node.data.indexOf(S);if(i>=0)from=[node,i]}
		  if(from!==null){const j=node.data.indexOf(E,node===from[0]?from[1]+S.length:0);if(j>=0){to=[node,j+E.length];break}}
		 }
		 if(from===null||to===null)return{kind:'none',message:'needle not found: '+S+' / '+E};
		 const range=document.createRange();range.setStart(from[0],from[1]);range.setEnd(to[0],to[1]);
		 const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
		 return window.captureQuote()})()`);
		const quotedMarkdown = async (start: string, end: string): Promise<string> => {
			const result = await quoteBetween(start, end);
			assert.equal(result.kind, "quote", result.kind === "none" ? result.message : undefined);
			return result.kind === "quote" ? result.source : "";
		};

		const REPLY = [
			"Intro with **bold** and `code` and [the docs](https://example.com/docs).",
			"- first item\n- second item with *emphasis*",
			"> quoted line\n> second quoted",
			"```ts\nconst a = 1;\nconst b = 2;\n```",
			"| name | value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |",
			"````md\n```\ninner\n```\n````",
		].join("\n\n");

		await t.test("a selection in a reply is captured as the source Markdown of exactly what is selected: tokens whole or as shown text, list markers, quote lines, code re-fenced, a table with its header", async () => {
			await reset("quote-capture");
			await showMessages([assistantMessage([{ type: "text", text: REPLY }])]);
			await ui.wait("document.querySelector('.omp-md table') && document.querySelectorAll('.omp-md [data-md-leaf]').length===9");
			assert.equal(await quotedMarkdown("bold", "docs"), "**bold** and `code` and [the docs](https://example.com/docs)", "a token the selection covers whole is source");
			assert.equal(await quotedMarkdown("ld", "and"), "ld and", "a token the selection cuts is its shown text");
			assert.equal(await quotedMarkdown("first", "emphasis"), "- first item\n- second item with *emphasis*", "markers stay when the selection starts at the item");
			assert.equal(await quotedMarkdown("rst", "second"), "rst item\n- second", "and go when it starts inside");
			assert.equal(await quotedMarkdown("quoted line", "second quoted"), "> quoted line\n> second quoted", "a quote inside the reply is sliced from its own lines");
			assert.equal(await quotedMarkdown("ted line", "second"), "> ted line\n> second");
			assert.equal(await quotedMarkdown("const a", "= 2;"), "```ts\nconst a = 1;\nconst b = 2;\n```");
			assert.equal(await quotedMarkdown("a = 1;", "const b"), "```ts\na = 1;\nconst b\n```", "a partial block is re-fenced with its language");
			assert.equal(await quotedMarkdown("beta", "2"), "| name | value |\n| --- | --- |\n| beta | 2 |", "a table keeps its header and separator");
			assert.equal(await quotedMarkdown("```", "```"), "````md\n```\ninner\n```\n````", "a fence inside a longer fence stays inside a longer one");
			assert.equal(await quotedMarkdown("Intro", "docs"), "Intro with **bold** and `code` and [the docs](https://example.com/docs)");
			const everything = await quoteBetween("Intro", "inner");
			assert.equal(everything.kind === "quote" && everything.plain, false, "nothing degraded");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a selection inside one table cell quotes that cell's text alone; across cells it quotes a table narrowed to the touched columns; from outside the table it takes the rows whole", async () => {
			await reset("quote-capture-table");
			const table = ["Before.", "| name | kind | note |\n| :-- | :-: | --: |\n| **Всё — параметры** | text | a \\| b |\n| beta | code | `x` |", "After."].join("\n\n");
			await showMessages([assistantMessage([{ type: "text", text: table }])]);
			await ui.wait("document.querySelector('.omp-md table') && document.querySelectorAll('.omp-md tbody tr').length===2");
			/** Selects the whole content of body cell (`row`, `column`); `overshoot` ends the range at the start of the next cell, as a triple click does. */
			const quoteCell = (row: number, column: number, overshoot: boolean): Promise<Captured> => ui.evaluate(`(()=>{
			 const cells=[...document.querySelectorAll('.omp-md tbody tr')[${row}].children];
			 const range=document.createRange();range.selectNodeContents(cells[${column}]);
			 if(${overshoot})range.setEnd(cells[${column + 1}],0);
			 const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
			 return window.captureQuote()})()`);
			const only = async (result: Promise<Captured>): Promise<string> => {
				const quote = await result;
				assert.equal(quote.kind, "quote", quote.kind === "none" ? quote.message : undefined);
				assert.equal(quote.kind === "quote" && quote.plain, false, "nothing degraded");
				return quote.kind === "quote" ? quote.source : "";
			};
			assert.equal(await only(quoteCell(0, 0, false)), "**Всё — параметры**", "a whole bold run stays bold source, with no header, separator or pipes");
			assert.equal(await only(quoteCell(0, 0, true)), "**Всё — параметры**", "a range that ends at the start of the next cell (a triple click) still lies in one cell");
			assert.equal(await only(quoteCell(0, 2, false)), "a | b", "an escaped pipe is a plain pipe once the cell stands alone");
			assert.equal(await quotedMarkdown("— п", "ар"), "— пар", "a token the selection cuts is its shown text");
			assert.equal(await quotedMarkdown("text", "a |"), "| kind | note |\n| :-: | --: |\n| text | a \\| |", "across two cells of a row: the two columns, the end cell cut");
			assert.equal(await quotedMarkdown("text", "beta"), "| name | kind |\n| :-- | :-: |\n| **Всё — параметры** | text |\n| beta | code |", "across two rows: the rectangle between the two cells");
			assert.equal(await quotedMarkdown("Before", "beta"), "Before.\n\n| name | kind | note |\n| :-- | :-: | --: |\n| **Всё — параметры** | text | a \\| b |\n| beta | code | `x` |", "from outside the table the rows are whole");
			assert.equal(await quotedMarkdown("beta", "After."), "| name | kind | note |\n| :-- | :-: | --: |\n| beta | code | `x` |\n\nAfter.", "and so are the rows of a selection that ends after it");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a selection across a user message, a tool row and a reply quotes the two messages and nothing of the tool; chrome, whitespace, a collapsed range and the composer are not quotable", async () => {
			await reset("quote-capture-rows");
			await showMessages([
				{ role: "user", timestamp: 1, content: "Please check `this` file" },
				assistantMessage([{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/a.ts" } }], { stopReason: "toolUse" }),
				{ role: "toolResult", timestamp: 3, toolCallId: "r1", toolName: "read", isError: false, content: [{ type: "text", text: "RESULT_TEXT_MARK" }], details: {} },
				assistantMessage([{ type: "text", text: "Done: `ok` now" }]),
			]);
			await ui.wait("document.querySelector('[data-tool-name=\"read\"]') && document.querySelectorAll('.omp-md').length>=2");
			const joined = await quoteBetween("this", "ok");
			assert.deepEqual(joined, { kind: "quote", source: "`this` file\n\nDone: `ok`", plain: false });
			// Only chrome: the tool's head.
			const chrome = await ui.evaluate<Captured>(`(()=>{const head=document.querySelector('[data-tool-name="read"] .omp-tool-head');const range=document.createRange();range.selectNodeContents(head);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return window.captureQuote()})()`);
			assert.equal(chrome.kind, "none");
			// A collapsed range, a whitespace-only range and a selection in the composer.
			assert.deepEqual(await ui.evaluate("(()=>{getSelection().removeAllRanges();return window.captureQuote()})()"), { kind: "none", message: "Select text in the conversation first" });
			await setDraft("typed words");
			assert.deepEqual(await ui.evaluate("(()=>{const field=window.composer.el();const range=document.createRange();range.selectNodeContents(field);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return window.captureQuote()})()"), { kind: "none", message: "Select text in the conversation first" });
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("thinking is quotable once it is open; the reply's unrelated blocks contribute nothing", async () => {
			await reset("quote-capture-thinking");
			await showMessages([assistantMessage([{ type: "thinking", thinking: "Plan: **step** one" }, { type: "text", text: "Answer text" }])]);
			await ui.wait("document.querySelector('.omp-thinking summary')");
			await ui.evaluate("document.querySelector('.omp-thinking summary').click()");
			await ui.wait("document.querySelector('.omp-thinking .omp-md')");
			assert.equal(await quotedMarkdown("step", "one"), "**step** one");
			assert.equal(await quotedMarkdown("Plan", "Answer"), "Plan: **step** one\n\nAnswer");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a sent user message shows `_`, `*` and `~` as typed and quotes them exactly, while the same text in a reply is styled; code, quotes and links of the message still render", async () => {
			await reset("quote-user-literal");
			const typed = "obj._method() ..... obj._otherMethod() and 1*234*343 and **b** ~~s~~ with `code` and [docs](https://example.com/d)";
			await showMessages([
				{ role: "user", timestamp: 1, content: `> quoted _x_\n\n${typed}` },
				assistantMessage([{ type: "text", text: typed }]),
			]);
			await ui.wait("document.querySelectorAll('.omp-md').length>=2");
			const shape = await ui.evaluate<{ text: string; styled: number; code: number; quotes: number; replyStyled: number }>(`(()=>{
			 const [user,reply]=document.querySelectorAll('.omp-md');
			 return {text:user.textContent,styled:user.querySelectorAll('em,strong,s,del,i,b').length,code:user.querySelectorAll('code').length,quotes:user.querySelectorAll('blockquote').length,replyStyled:reply.querySelectorAll('em,strong,s').length}})()`);
			assert.equal(shape.text, "quoted _x_obj._method() ..... obj._otherMethod() and 1*234*343 and **b** ~~s~~ with code and docs", "every typed character is shown; only the code span and the link drop their markup");
			assert.equal(shape.styled, 0, "nothing of a user message is emphasised, struck through or bold");
			assert.equal(shape.code, 1, "a code span is still code");
			assert.equal(shape.quotes, 1, "a quote is still a quote");
			assert.ok(shape.replyStyled > 0, "the same text in a reply is styled");
			assert.equal(await quotedMarkdown("obj", "~~s~~"), "obj._method() ..... obj._otherMethod() and 1*234*343 and **b** ~~s~~", "a user message quotes as typed");
			assert.equal(await quotedMarkdown("234", "343"), "234*343");
			assert.equal(await quotedMarkdown("_method", "_other"), "_method() ..... obj._other");
			assert.equal(await quotedMarkdown("quoted", "_x_"), "> quoted _x_");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		const FILE_NOTES = "# Notes\nconst a = 1;\nask @src/a.ts now\n</file>\n";
		const FILE_PLAN = "alpha\nbeta";
		const FILE_PROSE = `Summarise ${fileMarker(1, "notes.md")} and ${fileMarker(2, "plan.txt")}`;
		const FILE_MESSAGE = composeFileBlocks(FILE_PROSE, [
			{ number: 1, name: "notes.md", label: "docs/notes.md", content: FILE_NOTES },
			{ number: 2, name: "plan.txt", label: null, content: FILE_PLAN },
		]);
		/** The code lines of an opened row, as the file's own lines: the line number and its separator cut off each. */
		const fileRowLines = (index: number): Promise<string[]> => ui.evaluate(`(()=>{
		 const body=document.querySelectorAll('.omp-file-row')[${index}].querySelector('.omp-file-row-body');
		 return [...body.querySelectorAll('.omp-native-code-line')].map(line=>line.textContent.slice(line.querySelector('.omp-native-line-number').textContent.length+1).replace(/\\n$/,''))})()`);

		await t.test("a sent message with two files draws its prose and two closed rows that open to the original text, mount nothing while closed, and copy the prose, the file, and the whole text when it does not parse", async () => {
			await reset("file-rows");
			assert.ok(FILE_MESSAGE.includes("\u200b"), "the wire form of the sample escapes the sigils in the file");
			await ui.evaluate("window.copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(text){window.copied.push(text)}}})");
			await showMessages([{ role: "user", timestamp: 1, content: FILE_MESSAGE }]);
			await ui.wait("document.querySelectorAll('.omp-file-row').length===2");
			const shown = await ui.evaluate<{ prose: string; names: string[]; titles: string[]; meta: string[]; open: boolean[]; bodies: number; code: boolean; md: number }>(`(()=>({
			 prose:document.querySelector('.omp-row--user .omp-md').textContent,
			 names:[...document.querySelectorAll('.omp-file-row-name')].map(node=>node.textContent),
			 titles:[...document.querySelectorAll('.omp-file-row-head')].map(node=>node.title),
			 meta:[...document.querySelectorAll('.omp-file-row-meta')].map(node=>node.textContent),
			 open:[...document.querySelectorAll('.omp-file-row details')].map(node=>node.open),
			 bodies:document.querySelectorAll('.omp-file-row-body,.omp-file-row .omp-native-source').length,
			 code:document.querySelector('.omp-transcript').textContent.includes('const a = 1'),
			 md:document.querySelectorAll('.omp-file-row .omp-md').length}))()`);
			assert.equal(shown.prose, FILE_PROSE, "the prose is drawn as before, markers included as plain text");
			assert.deepEqual(shown.names, ["notes.md", "plan.txt"], "one row per block, in block order");
			assert.deepEqual(shown.titles, ["docs/notes.md", "no path"], "a path block's title is its label, a name block's is `no path`");
			assert.deepEqual(shown.meta, [`4 lines · ${new TextEncoder().encode(FILE_NOTES).length} B`, `2 lines · ${new TextEncoder().encode(FILE_PLAN).length} B`], "lines and the UTF-8 size of the original text");
			assert.deepEqual(shown.open, [false, false], "rows are closed by default");
			assert.equal(shown.bodies, 0, "a closed row mounts no content");
			assert.equal(shown.code, false, "and none of the file's text is in the page");
			assert.equal(shown.md, 0, "a row is not Markdown");

			await ui.evaluate("document.querySelectorAll('.omp-file-row summary')[0].click()");
			await ui.wait("document.querySelectorAll('.omp-file-row-body').length===1");
			assert.deepEqual(await fileRowLines(0), ["# Notes", "const a = 1;", "ask @src/a.ts now", "</file>"], "an opened row shows the original text: no escape, the </file> inside it as written");
			assert.equal(await ui.evaluate("document.querySelector('.omp-transcript').textContent.includes('\\u200b')"), false, "no U+200B reaches the reader");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-file-row')[1].querySelector('.omp-file-row-body')"), null, "the other row stays closed");
			await ui.evaluate("document.querySelectorAll('.omp-file-row summary')[1].click()");
			await ui.wait("document.querySelectorAll('.omp-file-row-body').length===2");
			assert.deepEqual(await fileRowLines(1), ["alpha", "beta"]);
			await ui.evaluate("document.querySelectorAll('.omp-file-row summary')[0].click()");
			await ui.wait("document.querySelectorAll('.omp-file-row-body').length===1");
			assert.equal(await ui.evaluate("document.querySelector('.omp-transcript').textContent.includes('const a = 1')"), false, "closing a row unmounts its content");

			// The message's own Copy is the text as sent less the blocks; a row's Copy is its file, as written.
			await ui.evaluate("document.querySelector('[aria-label=\"Copy message\"]').click()");
			await ui.wait("window.copied.length===1");
			await ui.evaluate("document.querySelector('[aria-label=\"Copy notes.md\"]').click()");
			await ui.wait("window.copied.length===2");
			assert.deepEqual(await ui.evaluate("window.copied"), [FILE_PROSE, FILE_NOTES]);

			// The same rows after the history is replaced by a snapshot (the second row is still open, so close it first): closed again, and the same rows.
			await ui.evaluate("document.querySelectorAll('.omp-file-row summary')[1].click()");
			await ui.wait("document.querySelectorAll('.omp-file-row-body').length===0");
			await showMessages([{ role: "user", timestamp: 1, content: [{ type: "text", text: FILE_MESSAGE }] }]);
			await ui.wait("document.querySelectorAll('.omp-file-row').length===2");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-file-row-body').length"), 0);
			assert.equal(await ui.evaluate("document.querySelector('.omp-row--user .omp-md').textContent"), FILE_PROSE, "an array of content blocks is split the same way");

			// A text that does not end in a valid chain is drawn as it is today: Markdown, no rows, Copy copies it whole.
			const forged = `${FILE_MESSAGE}\ntrailing words`;
			await showMessages([{ role: "user", timestamp: 1, content: forged }]);
			await ui.wait("document.querySelector('.omp-row--user .omp-md')?.textContent.includes('trailing words')");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-file-row').length"), 0);
			assert.ok((await ui.evaluate<string>("document.querySelector('.omp-row--user .omp-md').textContent")).includes("const a = 1"), "the text is all there, as prose");
			await ui.evaluate("window.copied=[];document.querySelector('[aria-label=\"Copy message\"]').click()");
			await ui.wait("window.copied.length===1");
			assert.deepEqual(await ui.evaluate("window.copied"), [forged]);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the prompt of a skill card draws its file rows under its header and stays out of the Expanded skill disclosure", async () => {
			await reset("file-rows-skill");
			const prompt = composeFileBlocks(`/skill:inspect ${fileMarker(1, "notes.md")}`, [{ number: 1, name: "notes.md", label: "docs/notes.md", content: FILE_NOTES }]);
			await showMessages([
				{ role: "custom", customType: "skill-prompt", content: "Expanded skill body", details: { name: "inspect", args: "", prompt }, attribution: "user", display: true, timestamp: 1 },
				{ role: "custom", customType: "skill-prompt", content: "Other body", details: { name: "inspect", args: "", prompt: `${prompt}\ntrailing` }, attribution: "user", display: true, timestamp: 2 },
			]);
			await ui.wait("document.querySelectorAll('.omp-native-skill').length===2");
			const shape = await ui.evaluate<{ rows: number[]; underHeader: boolean; header: string; closed: boolean; body: boolean }>(`(()=>{
			 const [parsed]=document.querySelectorAll('.omp-native-skill');
			 const rows=[...document.querySelectorAll('.omp-native-skill')].map(skill=>skill.querySelectorAll('.omp-file-row').length);
			 const row=parsed.querySelector('.omp-file-row');
			 return {rows,underHeader:row.parentElement.parentElement===parsed&&row.parentElement.previousElementSibling===parsed.querySelector('header'),header:parsed.querySelector('header').textContent,closed:!row.querySelector('details').open,body:Boolean(row.querySelector('.omp-file-row-body'))}})()`);
			assert.deepEqual(shape.rows, [1, 0], "the card that parses has a row; the one that does not has none");
			assert.equal(shape.underHeader, true, "the rows follow the header");
			assert.match(shape.header, /\/skill:inspect \[File #1: notes\.md\]/, "the header holds the prose only");
			assert.equal(shape.closed && !shape.body, true, "closed, with no content mounted");
			await ui.evaluate("document.querySelector('.omp-native-skill .omp-file-row summary').click()");
			await ui.wait("document.querySelector('.omp-native-skill .omp-file-row-body')");
			assert.deepEqual(await fileRowLines(0), ["# Notes", "const a = 1;", "ask @src/a.ts now", "</file>"]);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("quote capture never reads a file row: a selection from the prose through an opened row quotes the prose only, and one inside a row has nothing to quote", async () => {
			await reset("file-rows-quote");
			await showMessages([
				{ role: "user", timestamp: 1, content: FILE_MESSAGE },
				assistantMessage([{ type: "text", text: "Reply text" }]),
			]);
			await ui.wait("document.querySelectorAll('.omp-file-row').length===2");
			await ui.evaluate("document.querySelectorAll('.omp-file-row summary')[0].click()");
			await ui.wait("document.querySelector('.omp-file-row-body .omp-native-code-line')");
			const select = (script: string): Promise<Captured> => ui.evaluate(`(()=>{
			 const range=document.createRange();${script}
			 const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return window.captureQuote()})()`);
			const across = await select("const prose=document.querySelector('.omp-row--user .omp-md');const body=document.querySelector('.omp-file-row-body');range.setStart(prose,0);range.setEnd(body,body.childNodes.length);");
			assert.equal(across.kind, "quote", across.kind === "none" ? across.message : undefined);
			if (across.kind === "quote") {
				assert.match(across.source, /^Summarise /, "the prose is quoted");
				assert.doesNotMatch(across.source, /const a|alpha|ask @|\u200b/, "none of the file's text is");
			}
			const through = await select("const body=document.querySelector('.omp-file-row-body');range.setStart(document.querySelector('.omp-file-row-name'),0);range.setEnd(body,body.childNodes.length);");
			assert.deepEqual(through, { kind: "none", message: "That selection has no message text to quote" }, "a row's name, summary and content have nothing to quote");
			const alone = await select("range.selectNodeContents(document.querySelector('.omp-file-row-body'));");
			assert.deepEqual(alone, { kind: "none", message: "That selection has no message text to quote" });
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the host's quote-selection action (Alt+Q, the context menu item) quotes the selection through the composer, or says why there is nothing to quote; no Quote button is drawn", async () => {
			await reset("quote-triggers");
			await ui.call("Emulation.setFocusEmulationEnabled", { enabled: true });
			try {
				await showMessages([
					{ role: "user", timestamp: 1, content: "Ask about `this` thing" },
					assistantMessage([{ type: "text", text: "Reply with `code` inside" }]),
				]);
				await ui.wait("document.querySelectorAll('.omp-md').length>=2 && document.querySelector('.omp-reply-footer')");
				// A selection raises no button of its own, and no message row or footer carries a Quote button.
				await quoteBetween("this", "thing");
				await settleFrames();
				assert.equal(await ui.evaluate("document.querySelectorAll('.omp-quote-selection,[aria-label^=\"Quote message\"],[aria-label^=\"Quote reply\"]').length"), 0);
				await ui.evaluate("window.ui.receive({type:'omp:webview-action',action:'quote-selection'})");
				await waitDraft("window.composer.value()==='> `this` thing\\n'");
				assert.deepEqual(await areaState(), { value: "> `this` thing\n", start: 15, end: 15, focused: true }, "the caret is on the line under the quote, in the field");
				await undo();
				await waitDraft("window.composer.value()===''");
				// A second selection after a comment lands after a blank line; the chrome of a row is not quotable.
				await quoteBetween("Reply", "inside");
				await ui.evaluate("window.ui.receive({type:'omp:webview-action',action:'quote-selection'})");
				await waitDraft("window.composer.value()==='> Reply with `code` inside\\n'");
				await setDraft("");
				await ui.evaluate("(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('.omp-reply-footer'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);window.ui.receive({type:'omp:webview-action',action:'quote-selection'})})()");
				await ui.wait("document.querySelector('.omp-composer-hint--code')?.textContent==='Select text in the conversation first'||document.querySelector('.omp-composer-hint--code')?.textContent==='That selection has no message text to quote'");
				await ui.evaluate("getSelection().removeAllRanges();window.ui.receive({type:'omp:webview-action',action:'quote-selection'})");
				await ui.wait("document.querySelector('.omp-composer-hint--code')?.textContent==='Select text in the conversation first'");
				assert.equal((await areaState()).value, "", "nothing was inserted");
				assert.equal(await sendCount(), 0, "quoting never sends");
				assert.deepEqual(await ui.evaluate("window.errors"), []);
			} finally {
				await ui.call("Emulation.setFocusEmulationEnabled", { enabled: false });
			}
		});

		await t.test("the host's omp:insert-quote puts every editor selection into the draft as its own quote in one undo step, drops an over-long one and never sends", async () => {
			await reset("quote-editor");
			await ui.call("Emulation.setFocusEmulationEnabled", { enabled: true });
			try {
				await ui.evaluate("window.ui.receive({type:'omp:insert-quote',quotes:[{location:'src/app.ts:42-43',fileName:'app.ts',languageId:'typescript',text:'const x = 1;\\nconst y = 2;'}]})");
				await waitDraft("window.composer.value()==='> `src/app.ts:42-43`\\n> ```ts\\n> const x = 1;\\n> const y = 2;\\n> ```\\n'");
				const state = await areaState();
				assert.equal(state.start, state.value.length, "the caret is on the line under the quote");
				assert.equal(state.focused, true, "the focus is in the composer");
				// A prose document and a document with no path: two quotes of one insertion, a blank line between them, one undo step.
				await ui.evaluate("window.ui.receive({type:'omp:insert-quote',quotes:[{location:'docs/a.md:3',fileName:'a.md',languageId:'markdown',text:'# Title\\n\\nbody'},{location:null,fileName:'',languageId:'plaintext',text:'loose'}]})");
				const both = "> `src/app.ts:42-43`\n> ```ts\n> const x = 1;\n> const y = 2;\n> ```\n\n> `docs/a.md:3`\n>\n> # Title\n>\n> body\n\n> loose\n";
				await waitDraft(`window.composer.value()===${JSON.stringify(both)}`);
				await undo();
				await waitDraft("window.composer.value()==='> `src/app.ts:42-43`\\n> ```ts\\n> const x = 1;\\n> const y = 2;\\n> ```\\n'");
				// Over the limit: the page's parser drops the message (the host refuses such a selection before it posts anything), so nothing is inserted.
				await ui.evaluate("window.ui.receive({type:'omp:insert-quote',quotes:[{location:'big.ts:1',fileName:'big.ts',languageId:'typescript',text:'x'.repeat(20001)}]})");
				await settleFrames();
				assert.equal((await areaState()).value, "> `src/app.ts:42-43`\n> ```ts\n> const x = 1;\n> const y = 2;\n> ```\n", "nothing was inserted");
				assert.equal(await sendCount(), 0, "quoting never sends");
				assert.deepEqual(await ui.evaluate("window.errors"), []);
			} finally {
				await ui.call("Emulation.setFocusEmulationEnabled", { enabled: false });
			}
		});

		await t.test("Shift+Arrow extends a selection that exists in the transcript and the action quotes it, but a collapsed caret there cannot be extended: a selection cannot be started from the keyboard alone (measured, an accessibility gap)", async () => {
			await reset("quote-keyboard");
			await showMessages([assistantMessage([{ type: "text", text: "Keyboard **quoted words** here" }])]);
			await ui.wait("document.querySelector('.omp-md p')");
			// A collapsed caret in transcript text is not extended by Shift+Arrow (the transcript is not editable and caret browsing is off).
			await ui.evaluate("(()=>{const text=document.querySelector('.omp-md p').firstChild;getSelection().setBaseAndExtent(text,0,text,0)})()");
			for (let step = 0; step < 3; step++) await press("ArrowRight", "ArrowRight", 39, { modifiers: 8 });
			assert.equal(await ui.evaluate("getSelection().toString()"), "", "nothing is selected by keys alone");
			// A selection that exists (a drag, a double click) is extended by Shift+Arrow.
			await ui.evaluate("(()=>{const text=document.querySelector('.omp-md p').firstChild;getSelection().setBaseAndExtent(text,0,text,1)})()");
			for (let step = 0; step < 8; step++) await press("ArrowRight", "ArrowRight", 39, { modifiers: 8 });
			const selected = await ui.evaluate<string>("getSelection().toString()");
			await ui.evaluate("window.ui.receive({type:'omp:webview-action',action:'quote-selection'})");
			await waitDraft("window.composer.value().startsWith('> ')");
			assert.equal((await areaState()).value, `> ${selected}\n`, `Shift+Arrow selected ${JSON.stringify(selected)} and the action quoted exactly it`);
			assert.ok(selected.length >= 4, "the keys moved the selection");
		});

		await t.test("a marker is atomic for the caret and selection: it cannot be entered, and arrows hop over it", async () => {
			await buildDraft("image-refs-caret");
			const [, second] = await markers();
			await setSelection(second!.start + 4, second!.start + 4);
			await ui.wait(`(()=>{const a=window.composer.selection();return a.start===a.end&&(a.start===${second!.start}||a.start===${second!.end})})()`);
			await setSelection(second!.end, second!.end);
			await waitDraft(`window.composer.selection().start===${second!.end}`);
			await press("ArrowLeft", "ArrowLeft", 37);
			await waitDraft(`window.composer.selection().start===${second!.start}`);
			assert.deepEqual(await selection(), { start: second!.start, end: second!.start }, "one ArrowLeft crosses the whole marker");
			await press("ArrowRight", "ArrowRight", 39);
			await waitDraft(`window.composer.selection().start===${second!.end}`);
			assert.deepEqual(await selection(), { start: second!.end, end: second!.end }, "one ArrowRight crosses it back");
			await press("ArrowLeft", "ArrowLeft", 37, { modifiers: 8 });
			await waitDraft(`window.composer.selection().start===${second!.start}`);
			assert.deepEqual(await selection(), { start: second!.start, end: second!.end }, "Shift+Arrow selects the marker whole");
			// A selection that starts mid-marker (a drag from inside the chip's text) grows to the marker's edges.
			await ui.evaluate(`(()=>{const chip=document.querySelector('.omp-chip[aria-label="Image #2"]');const next=chip.nextSibling;document.getSelection().setBaseAndExtent(chip.firstChild,3,next,2)})()`);
			await waitDraft(`window.composer.selection().start===${second!.start}`);
			assert.deepEqual(await selection(), { start: second!.start, end: second!.end + 2 });
			// A real click inside a marker lands on its nearest edge.
			const inside = await ui.evaluate<{ x: number; y: number }>("(()=>{const r=document.querySelector('.omp-chip[aria-label=\"Image #3\"]').getBoundingClientRect();return{x:r.left+r.width*0.85,y:r.top+r.height/2}})()");
			await clickAt(inside);
			const third = (await markers())[2]!;
			await waitDraft(`window.composer.selection().start===${third.end}`);
			assert.deepEqual(await selection(), { start: third.end, end: third.end });
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("one Backspace or Delete removes a whole marker and its attachment; numbering is stable; Undo and Redo keep text and attachments in step", async () => {
			await buildDraft("image-refs-delete");
			const [first, second] = await markers();
			await setSelection(second!.end, second!.end);
			await ui.wait(`window.composer.selection().start===${second!.end}`);
			await press("Backspace", "Backspace", 8, { commands: ["deleteBackward"] });
			const withoutSecond = FIRST.replace("[Image #2, 20x8]", "");
			await ui.wait(`window.composer.value()===${JSON.stringify(withoutSecond)}`);
			assert.deepEqual(await strip(), ["#1", "#3"], "#3 keeps its number");
			assert.equal(await ui.evaluate("document.querySelector('.omp-attachment[data-image-number=\"2\"]')"), null);
			// Undo brings the marker and the attachment back together; Redo removes both again.
			await press("z", "KeyZ", 90, { modifiers: 2, commands: ["undo"] });
			await ui.wait(`window.composer.value()===${JSON.stringify(FIRST)}`);
			await ui.wait("document.querySelectorAll('.omp-attachment-number').length===3");
			assert.deepEqual(await strip(), ["#1", "#2", "#3"]);
			await press("z", "KeyZ", 90, { modifiers: 10, commands: ["redo"] });
			await ui.wait(`window.composer.value()===${JSON.stringify(withoutSecond)}`);
			assert.deepEqual(await strip(), ["#1", "#3"]);
			// The next image continues after the highest number ever issued in this draft.
			await pasteImage(50, 12, "[Image #4, 50x12]");
			assert.deepEqual(await strip(), ["#1", "#3", "#4"]);
			// Forward Delete in front of the first marker.
			await setSelection(first!.start, first!.start);
			await ui.wait(`window.composer.selection().start===${first!.start}`);
			await press("Delete", "Delete", 46, { commands: ["deleteForward"] });
			await ui.wait("!window.composer.value().includes('[Image #1')");
			assert.deepEqual(await strip(), ["#3", "#4"]);
			// A word-wise delete right after a marker takes the marker whole, never a fragment of it.
			const fourth = (await markers()).find(marker => marker.number === 4)!;
			await setSelection(fourth.end, fourth.end);
			await waitDraft(`window.composer.selection().start===${fourth.end}`);
			await press("Backspace", "Backspace", 8, { modifiers: 2, commands: ["deleteWordBackward"] });
			await waitDraft("!window.composer.value().includes('[Image #4')");
			assert.deepEqual(await strip(), ["#3"]);
			assert.doesNotMatch(await draftValue(), /Image #4|50x12/);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a selection that cuts into a marker deletes it whole, and removing a thumbnail removes its marker (Undo restores both)", async () => {
			await buildDraft("image-refs-selection");
			const [first, second] = await markers();
			await setSelection(first!.end + 1, second!.start + 5);
			await ui.wait(`window.composer.selection().end===${second!.end}`);
			await press("Backspace", "Backspace", 8, { commands: ["deleteBackward"] });
			await ui.wait("!window.composer.value().includes('[Image #2')");
			assert.equal(await draftValue(), "A [Image #1, 10x6] " + " C [Image #3, 30x9] D");
			assert.deepEqual(await strip(), ["#1", "#3"]);
			// The thumbnail's × removes its marker from the text.
			await ui.evaluate("document.querySelector('.omp-attachment[data-image-number=\"1\"] .omp-attachment-remove').click()");
			await ui.wait("!window.composer.value().includes('[Image #1')");
			assert.deepEqual(await strip(), ["#3"]);
			assert.equal(await draftValue(), "A   C [Image #3, 30x9] D");
			await press("z", "KeyZ", 90, { modifiers: 2, commands: ["undo"] });
			await ui.wait("window.composer.value().includes('[Image #1')");
			assert.deepEqual(await strip(), ["#1", "#3"], "Undo of the × restores marker and attachment together");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a 4 MB image attaches and sends whole; an image over 5 MiB and a prompt over 10 MiB are refused by size, naming the limit", async () => {
			await reset("image-limits");
			await ui.evaluate(`(()=>{
			 window.pasteBytes=(size,name)=>{const bytes=new Uint8Array(size);bytes.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
			  const data=new DataTransfer();data.items.add(new File([bytes],name,{type:'image/png'}));
			  window.composer.focus();
			  window.composer.el().dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));};
			})()`);
			const MiB = 1024 * 1024;
			await ui.evaluate(`window.pasteBytes(${4 * MiB},'screenshot-4mb.png')`);
			await ui.wait("document.querySelectorAll('.omp-attachment-number').length===1");
			assert.equal(await ui.evaluate("document.querySelector('.omp-attach-error')"), null, "a 4 MB screenshot is not refused");
			await ui.evaluate(`window.pasteBytes(${5 * MiB + 1},'huge.png')`);
			await ui.wait("document.querySelector('.omp-attach-error')");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-attach-error').textContent"), /huge\.png: 5\.0 MB exceeds the 5\.0 MB limit per image/);
			assert.deepEqual(await strip(), ["#1"]);
			await ui.evaluate(`window.pasteBytes(${4 * MiB},'second.png')`);
			await ui.wait("document.querySelectorAll('.omp-attachment-number').length===2");
			await ui.evaluate(`window.pasteBytes(${4 * MiB},'third.png')`);
			await ui.wait("document.querySelector('.omp-attach-error')?.textContent.includes('third.png')");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-attach-error').textContent"), /12\.0 MB of images; the limit is 10\.0 MB per prompt/);
			assert.deepEqual(await strip(), ["#1", "#2"]);
			await ui.evaluate("window.ui.admission(true);window.composer.focus()");
			await ui.call("Input.insertText", { text: "look" });
			await ui.evaluate("document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await ui.wait("window.ui.sends().length===1");
			const sent = await ui.evaluate<{ images: { data: string }[] }>("window.ui.sends()[0]");
			assert.deepEqual(sent.images.map(image => image.data.length), [Math.ceil((4 * MiB) / 3) * 4, Math.ceil((4 * MiB) / 3) * 4], "both images travel whole");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		const dropOn = (target: string, type: string, items: string): Promise<{ prevented: boolean }> =>
			ui.evaluate(`(()=>{const data=new DataTransfer();${items};
			 const event=new DragEvent(${JSON.stringify(type)},{dataTransfer:data,bubbles:true,cancelable:true});
			 ${target}.dispatchEvent(event);return {prevented:event.defaultPrevented};})()`);
		const dropFile = "data.items.add(new File([new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3])],'dropped.png',{type:'image/png'}))";

		await t.test("dropping image files on the composer attaches them, and the drop target shows while a droppable drag is over it", async () => {
			await reset("drop-files");
			// What the VS Code shell script does: it listens on the window and, told of a file drag, has the workbench block this page.
			await ui.evaluate("window.shellSaw=[];for(const type of ['dragenter','dragover','drop'])window.addEventListener(type,event=>window.shellSaw.push(type))");
			assert.equal((await dropOn("window.composer.el()", "dragover", dropFile)).prevented, true, "a file drag is accepted over the field");
			await ui.wait("document.querySelector('.omp-composer--dropping')");
			await ui.evaluate("document.querySelector('.omp-composer').dispatchEvent(new DragEvent('dragleave',{bubbles:true,relatedTarget:null}))");
			await ui.wait("!document.querySelector('.omp-composer--dropping')");
			assert.equal((await dropOn("document.querySelector('.omp-composer-toolbar')", "drop", dropFile)).prevented, true, "a drop on the composer card is taken");
			await ui.wait("document.querySelectorAll('.omp-attachment-number').length===1");
			assert.equal((await dropOn("document.querySelector('.omp-transcript')", "drop", dropFile)).prevented, true, "a drop anywhere on the Chat page attaches to the composer");
			await ui.wait("document.querySelectorAll('.omp-attachment-number').length===2");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer--dropping')"), null);
			// Text and links stay with the browser.
			assert.deepEqual(await ui.evaluate("window.shellSaw"), [], "the shell script is never told of a drag the composer takes");
			assert.equal((await dropOn("window.composer.el()", "dragover", "data.setData('text/plain','just text')")).prevented, false);
			assert.deepEqual(await ui.evaluate("window.shellSaw"), ["dragover"], "a drag the composer leaves alone still reaches it");
			assert.equal((await dropOn("window.composer.el()", "drop", "data.setData('text/uri-list','https://example.com/a.png')")).prevented, false, "a web link is not a file");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:attach-uris').length"), 0);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("dropping from VS Code's Explorer asks the host to read the file URIs, attaches what it returns and reports what it refused", async () => {
			await reset("drop-uris");
			const tinyPng = "iVBORw0KGgoBAgM=";
			const uris = "file:///c%3A/repo/shot.png\\r\\nfile:///c%3A/repo/notes.txt\\r\\nhttps://example.com/x.png";
			assert.equal((await dropOn("window.composer.el()", "dragover", "data.setData('application/vnd.code.uri-list','file:///c%3A/repo/shot.png')")).prevented, true, "an Explorer drag is accepted by its type");
			assert.equal((await dropOn("window.composer.el()", "drop", `data.setData('application/vnd.code.uri-list','${uris}')`)).prevented, true);
			await ui.wait("window.sent.some(message=>message.type==='omp:attach-uris')");
			const request = await ui.evaluate<{ requestId: number; uris: string[] }>("window.sent.find(message=>message.type==='omp:attach-uris')");
			assert.deepEqual(request.uris, ["file:///c%3A/repo/shot.png", "file:///c%3A/repo/notes.txt"], "only file: URIs are asked for");
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer-attach').disabled"), true, "the composer shows it is reading");
			await ui.evaluate(`window.ui.receive({type:'omp:attached-files',requestId:${request.requestId + 1},items:[{kind:'image',name:'stale.png',mimeType:'image/png',data:${JSON.stringify(tinyPng)}}],refusals:[]})`);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-attachment-number').length"), 0, "an answer to another request is ignored");
			await ui.evaluate(`window.ui.receive({type:'omp:attached-files',requestId:${request.requestId},items:[{kind:'image',name:'shot.png',mimeType:'image/png',data:${JSON.stringify(tinyPng)}}],refusals:['notes.txt: not a PNG, JPEG, GIF, or WebP image.']})`);
			await ui.wait("document.querySelectorAll('.omp-attachment-number').length===1");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-attach-error').textContent"), /notes\.txt: not a PNG, JPEG, GIF, or WebP image\./);
			assert.equal(await ui.evaluate("document.querySelector('.omp-composer-attach').disabled"), false, "reading is over");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		const attachDocument = async (name: string, ref = "AbCdEf012345", bytes = 16, chars = 16): Promise<void> => {
			const before = await ui.evaluate<number>("window.sent.filter(message=>message.type==='omp:attach-uris').length");
			await dropOn("window.composer.el()", "drop", `data.setData('application/vnd.code.uri-list','file:///c%3A/repo/docs/${name}')`);
			await ui.wait(`window.sent.filter(message=>message.type==='omp:attach-uris').length===${before + 1}`);
			const request = await ui.evaluate<{ requestId: number }>("window.sent.filter(message=>message.type==='omp:attach-uris').at(-1)");
			await ui.evaluate(`window.ui.receive({type:'omp:attached-files',requestId:${request.requestId},items:[{kind:'document',name:${JSON.stringify(name)},ref:${JSON.stringify(ref)},bytes:${bytes},chars:${chars}}],refusals:[]})`);
		};
		const pasteFile = (name: string, type: string, body: string): Promise<unknown> =>
			ui.evaluate(`(()=>{const data=new DataTransfer();data.items.add(new File([${JSON.stringify(body)}],${JSON.stringify(name)},{type:${JSON.stringify(type)}}));
			 window.composer.el().dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))})()`);

		await t.test("a dropped Explorer .md attaches as a document: a marker and a tile with no file text, a stale reply is ignored, and × then Undo bring back both", async () => {
			await reset("drop-document");
			await dropOn("window.composer.el()", "drop", "data.setData('application/vnd.code.uri-list','file:///c%3A/repo/docs/notes.md')");
			await ui.wait("window.sent.some(message=>message.type==='omp:attach-uris')");
			const request = await ui.evaluate<{ requestId: number }>("window.sent.find(message=>message.type==='omp:attach-uris')");
			await ui.evaluate(`window.ui.receive({type:'omp:attached-files',requestId:${request.requestId + 1},items:[{kind:'document',name:'stale.md',ref:'ZyXwVu987654',bytes:3,chars:3}],refusals:[]})`);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-attachment[data-file-number]').length"), 0, "an answer to another request is ignored");
			await ui.evaluate(`window.ui.receive({type:'omp:attached-files',requestId:${request.requestId},items:[{kind:'document',name:'notes.md',ref:'AbCdEf012345',bytes:2048,chars:2000}],refusals:[]})`);
			await ui.wait("document.querySelector('.omp-attachment[data-file-number=\"1\"]')");
			assert.match(await draftValue(), /\[File #1: notes\.md\]/, "the marker is in the draft");
			const tile = await ui.evaluate<{ ext: string; name: string; size: string; number: string; icon: string; text: string }>(`(()=>{const item=document.querySelector('.omp-attachment[data-file-number="1"]');
			 return {ext:item.querySelector('.omp-attachment-ext').textContent,name:item.querySelector('.omp-attachment-name').textContent,size:item.querySelector('.omp-attachment-size').textContent,number:item.querySelector('.omp-attachment-number').textContent,icon:item.querySelector('.codicon').className,text:item.textContent};})()`);
			assert.deepEqual([tile.ext, tile.number], ["MD", "#1"]);
			assert.match(tile.name, /notes\.md/);
			assert.match(tile.size, /2(\.0)? KB|2 KiB|2048/i, "the size is the file's");
			assert.match(tile.icon, /markdown/, "Markdown has its own icon");
			assert.equal(await ui.evaluate("document.querySelector('.omp-attachment[data-file-number=\"1\"] .omp-attachment-figure').title"), "read from disk when sent");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-attachment-thumb').length"), 0, "no thumbnail, no file text");
			// The × removes the marker with the tile; Undo brings both back.
			await ui.evaluate("document.querySelector('.omp-attachment[data-file-number=\"1\"] .omp-attachment-remove').click()");
			await ui.wait("!document.querySelector('.omp-attachment[data-file-number]')");
			assert.doesNotMatch(await draftValue(), /\[File #1/);
			await ui.evaluate("window.composer.focus()");
			await press("z", "KeyZ", 90, { modifiers: 2, commands: ["undo"] });
			await ui.wait("document.querySelector('.omp-attachment[data-file-number=\"1\"]')");
			assert.match(await draftValue(), /\[File #1: notes\.md\]/, "Undo restored the marker");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a send with a linked file reads it first, sends nothing until the host answers, carries its text in a block, and a missing file refuses the send and keeps the draft", async () => {
			await reset("send-linked");
			await attachDocument("notes.md");
			await ui.wait("document.querySelector('.omp-attachment[data-file-number=\"1\"]')");
			await ui.evaluate("window.ui.admission(true);window.composer.focus()");
			await press("End", "End", 35, { modifiers: 2 });
			await ui.call("Input.insertText", { text: " read it" });
			await ui.evaluate("document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:read-files')");
			const read = await ui.evaluate<{ requestId: number; files: { number: number; ref: string }[]; budget: number }>("window.sent.find(message=>message.type==='omp:read-files')");
			assert.deepEqual(read.files, [{ number: 1, ref: "AbCdEf012345" }]);
			assert.ok(read.budget > 0 && read.budget <= 200_000, "the host is told how much text the draft can still take");
			assert.equal(await sendCount(), 0, "nothing is sent while the host reads");
			// A missing file refuses the send; the draft, marker and tile stay.
			await ui.evaluate(`window.ui.receive({type:'omp:files-read',requestId:${read.requestId},files:[],failures:[{number:1,name:'notes.md',reason:'notes.md was deleted or moved, so nothing was sent.'}]})`);
			await ui.wait("document.querySelector('.omp-attach-error')?.textContent.includes('notes.md was deleted')");
			assert.equal(await sendCount(), 0);
			assert.match(await draftValue(), /\[File #1: notes\.md\]/);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-attachment[data-file-number]').length"), 1);
			// The same send again, now answered: one prompt, the prose then the block, no images.
			await ui.evaluate("document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await ui.wait("window.sent.filter(message=>message.type==='omp:read-files').length===2");
			const again = await ui.evaluate<{ requestId: number }>("window.sent.filter(message=>message.type==='omp:read-files').at(-1)");
			await ui.evaluate(`window.ui.receive({type:'omp:files-read',requestId:${again.requestId},files:[{number:1,label:'docs/notes.md',content:'see @src/a.ts\\n',dirty:false}],failures:[]})`);
			await ui.wait("window.ui.sends().length===1");
			const sent = await ui.evaluate<{ type: string; text: string; images?: unknown[] }>("window.ui.sends()[0]");
			assert.equal(sent.type, "omp:chat-prompt");
			assert.equal(sent.images, undefined, "a document is not an image");
			const split = splitFileBlocks(sent.text);
			assert.match(split.prose, /^\[File #1: notes\.md\]\s*read it$/);
			assert.deepEqual(split.blocks.map(block => [block.number, block.name, block.label, block.content]), [[1, "notes.md", "docs/notes.md", "see @src/a.ts\n"]]);
			assert.ok(sent.text.includes(`path="docs/notes.md" n="1" chars="${"\u200bsee @src/a.ts\n".length}"`), "the block counts the escaped text");
			assert.ok(sent.text.includes("\u200b@src/a.ts"), "the file's @ mention is escaped on the wire");
			await ui.evaluate("window.ui.sendReply()");
			await ui.wait("window.composer.value()==='' && !document.querySelector('.omp-attachment[data-file-number]')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a pasted .md and a Shift-dropped one give the same marker and tile, a send needs no read and carries a named block, and a steer carries the same", async () => {
			await reset("paste-document");
			await pasteFile("notes.md", "text/markdown", "# Notes\n@src/a.ts\n");
			await ui.wait("document.querySelector('.omp-attachment[data-file-number=\"1\"]')");
			const pasted = await draftValue();
			assert.match(pasted, /\[File #1: notes\.md\]/);
			assert.equal(await ui.evaluate("document.querySelector('.omp-attachment[data-file-number=\"1\"] .omp-attachment-figure').title"), "no path: the text is held in the draft");
			await ui.evaluate("window.ui.admission(true);window.composer.focus()");
			await press("End", "End", 35, { modifiers: 2 });
			await ui.call("Input.insertText", { text: " go" });
			await ui.evaluate("document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await ui.wait("window.ui.sends().length===1");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:read-files').length"), 0, "a held file is not read again");
			const sent = await ui.evaluate<{ type: string; text: string }>("window.ui.sends()[0]");
			assert.deepEqual(splitFileBlocks(sent.text).blocks.map(block => [block.number, block.name, block.label, block.content]), [[1, "notes.md", null, "# Notes\n@src/a.ts\n"]]);
			assert.match(sent.text, /<file name="notes\.md" n="1" chars="\d+">/);
			await ui.evaluate("window.ui.sendReply()");
			await ui.wait("window.composer.value()===''");
			// Dropped with Shift, an OS file arrives as a File: the same marker and tile.
			await dropOn("window.composer.el()", "drop", "data.items.add(new File(['# Notes\\n@src/a.ts\\n'],'notes.md',{type:'text/markdown'}))");
			await ui.wait("document.querySelector('.omp-attachment[data-file-number]')");
			assert.match(await draftValue(), /\[File #1: notes\.md\]/);
			// A steer while a turn runs carries the same block.
			await ui.evaluate("window.ui.push({working:true,settled:false,state:{...window.ui.current().state,isStreaming:true}});window.composer.focus()");
			await press("End", "End", 35, { modifiers: 2 });
			await ui.call("Input.insertText", { text: " steer" });
			await ui.evaluate("document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await ui.wait("window.ui.sends().length===2");
			const steer = await ui.evaluate<{ type: string; text: string }>("window.ui.sends()[1]");
			assert.equal(steer.type, "omp:chat-steer");
			assert.deepEqual(splitFileBlocks(steer.text).blocks.map(block => block.content), ["# Notes\n@src/a.ts\n"]);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a pasted file that is not text is refused by name and attaches nothing; an empty text file is a valid document", async () => {
			await reset("paste-refused");
			await pasteFile("report.pdf", "application/pdf", "%PDF-1.7\n\u0000\u0001binary");
			await ui.wait("document.querySelector('.omp-attach-error')?.textContent.includes('report.pdf')");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-attachment[data-file-number]').length"), 0);
			await pasteFile("empty.txt", "text/plain", "");
			await ui.wait("document.querySelector('.omp-attachment[data-file-number]')");
			assert.match(await draftValue(), /\[File #1: empty\.txt\]/);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a 2.6 MB text file dropped from the operating system is refused cleanly and leaves nothing behind: the next small file is accepted by dragenter, dragover and drop, and becomes a chip", async () => {
			await reset("drop-huge-then-small");
			await ui.evaluate(`window.hugeLog=()=>{const line='[0000000] Unity PlayMode line '+'x'.repeat(440)+'\\r\\n';return line.repeat(Math.ceil(2649137/line.length)).slice(0,2649137)};`);
			const huge = "data.items.add(new File([window.hugeLog()],'Unity_PlayMode.log',{type:''}))";
			const small = "data.items.add(new File(['a small file\\r\\n'.repeat(150)],'notes.txt',{type:'text/plain'}))";
			const attachState = (): Promise<{ label: string | null; disabled: boolean; dropping: boolean; error: string }> => ui.evaluate(`(()=>{const button=document.querySelector('.omp-composer-attach');return{label:button.getAttribute('aria-label'),disabled:button.disabled,dropping:document.querySelector('.omp-composer--dropping')!==null,error:document.querySelector('.omp-attach-error')?.textContent??''}})()`);
			for (const round of [1, 2]) {
				assert.equal((await dropOn("window.composer.el()", "dragenter", huge)).prevented, true, `round ${round}: a file drag is accepted on entering`);
				assert.equal((await dropOn("window.composer.el()", "dragover", huge)).prevented, true);
				assert.equal((await dropOn("window.composer.el()", "drop", huge)).prevented, true, `round ${round}: the drop is taken, so VS Code never opens the file`);
				await ui.wait("document.querySelector('.omp-attach-error')?.textContent.includes('Unity_PlayMode.log is 2.5 MB')");
				const refused = await attachState();
				assert.deepEqual([refused.label, refused.disabled, refused.dropping], ["Attach files", false, false], `round ${round}: reading is over, the button is usable, the drop target is gone`);
			}
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-attachment').length"), 0, "a refused file attaches nothing");
			assert.equal((await dropOn("window.composer.el()", "dragenter", small)).prevented, true, "after the refusal a file drag is still accepted on entering");
			assert.equal((await dropOn("window.composer.el()", "dragover", small)).prevented, true, "and over the field");
			await ui.wait("document.querySelector('.omp-composer--dropping')");
			assert.equal((await dropOn("window.composer.el()", "drop", small)).prevented, true, "and its drop is taken");
			await ui.wait("document.querySelector('.omp-attachment[data-file-number=\"1\"]')");
			assert.match(await draftValue(), /\[File #1: notes\.txt\]/);
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:attach-uris').length"), 0, "an operating system drop reads in the page and asks the host for nothing");
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
			await ui.wait("window.composer.value()==='' && !document.querySelector('.omp-composer-hint[role=\"status\"]')");
			assert.deepEqual(await strip(), []);
			assert.equal(await ui.evaluate("window.ui.sends().length"), 1);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("late accepted steering retains newer edits and leaves Stop usable during admission", async () => {
			await reset("steer-admission-edited");
			await ui.evaluate("window.ui.admission(false);window.ui.push({working:true,settled:false,state:{...window.ui.current().state,isStreaming:true}});window.composer.focus()");
			await ui.call("Input.insertText", { text: "Original steering" });
			await ui.evaluate("document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await ui.wait("window.ui.sends().length===1 && document.querySelector('button[aria-keyshortcuts=\"Enter\"]').disabled");
			assert.equal(await ui.evaluate("window.ui.sends()[0].type"), "omp:chat-steer");
			await ui.evaluate("document.querySelector('[aria-label=\"Stop the running turn\"]').click();window.composer.focus()");
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
			await ui.wait("window.composer.value().includes('A [Image #4, 10x6]')");
			assert.equal(await draftValue(), "New draft\n\nA [Image #4, 10x6] B [Image #5, 20x8] C [Image #6, 30x9] D");
			assert.deepEqual(await strip(), ["#4", "#5", "#6"]);
			await ui.evaluate("document.querySelector('[aria-label=\"Dismiss recoverable message\"]').click()");
			await ui.wait("!document.querySelector('[aria-label=\"Dismiss recoverable message\"]')");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 1);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a refused edited send retains the original while an unchanged uncertain draft is not duplicated by recovery", async () => {
			await reset("send-admission-refused");
			await ui.evaluate("window.ui.admission(false);window.composer.focus()");
			await ui.call("Input.insertText", { text: "Refused original" });
			await ui.evaluate("document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await setSelection(0, "Refused original".length);
			await ui.call("Input.insertText", { text: "New work" });
			await ui.evaluate("window.ui.sendReply(undefined,'refused','Not admitted')");
			await ui.wait("document.querySelector('[aria-label=\"Dismiss recoverable message\"]')");
			assert.equal(await draftValue(), "New work");
			assert.equal(await ui.evaluate("document.querySelector('.omp-attach-error details pre').textContent"), "Refused original");
			await reset("send-admission-held");
			await ui.evaluate("window.ui.admission(false);window.composer.focus()");
			await ui.call("Input.insertText", { text: "Still held" });
			await ui.evaluate("document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click();window.ui.sendReply(undefined,'unconfirmed','Delivery unknown')");
			await ui.wait("document.querySelector('[aria-label=\"Dismiss recoverable message\"]')");
			await ui.evaluate("[...document.querySelectorAll('.omp-attach-error button')].find(button=>button.textContent==='Add to draft').click()");
			assert.equal(await draftValue(), "Still held");
			assert.equal(await ui.evaluate("window.composer.focused()"), true);
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
			await ui.wait("window.sent.some(message=>message.type==='omp:draft-reply'&&message.requestId===700)&&window.composer.readOnly()");
			const captured = await ui.evaluate<{ captured: boolean; text: string; attachments: number; recoverable: { text: string; attachments: number; unconfirmed: boolean }[] }>("window.sent.find(message=>message.type==='omp:draft-reply'&&message.requestId===700)");
			assert.equal(captured.captured, true);
			assert.equal(captured.text, "Latest draft");
			assert.equal(captured.attachments, 0);
			assert.deepEqual(captured.recoverable, [{ text: FIRST, attachments: 3, unconfirmed: true }, { text: "Second input", attachments: 0, unconfirmed: true }]);
			await ui.call("Input.insertText", { text: "must not mutate" });
			await ui.evaluate("window.ui.receive({type:'omp:insert-text',text:'@source.ts'});window.ui.sendReply();window.ui.receive({type:'omp:draft-release',requestId:701})");
			assert.equal(await draftValue(), "Latest draft");
			assert.equal(await ui.evaluate("window.composer.readOnly()"), true);
			await ui.evaluate("window.ui.receive({type:'omp:draft-release',requestId:700})");
			await ui.wait("!window.composer.readOnly()&&window.composer.value().includes('@source.ts')");
			assert.ok((await draftValue()).includes("Latest draft"), "a late accepted admission cannot erase deferred new input");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 2);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("capture refuses incomplete IME and image reads and pauses native prefilling until release", async () => {
			await reset("capture-incomplete");
			await installImages();
			await ui.evaluate("window.composer.el().dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));window.ui.receive({type:'omp:draft-request',requestId:710})");
			assert.equal(await ui.evaluate("window.sent.find(message=>message.type==='omp:draft-reply'&&message.requestId===710).captured"), false);
			await ui.evaluate("window.composer.el().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))");
			await ui.evaluate(`(async()=>{
			 const blob=await window.makePng(9,9),data=new DataTransfer();data.items.add(new File([blob],'capture.png',{type:'image/png'}));
			 window.composer.el().dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
			 window.ui.receive({type:'omp:draft-request',requestId:711});
			})()`);
			assert.equal(await ui.evaluate("window.sent.find(message=>message.type==='omp:draft-reply'&&message.requestId===711).captured"), false);
			await ui.wait("document.querySelector('.omp-attachment-number')");
			await ui.evaluate("window.ui.receive({type:'omp:draft-request',requestId:712})");
			await ui.wait("window.composer.readOnly()");
			const original = await draftValue();
			await ui.evaluate("window.ui.receive({type:'omp:chat-event',epoch:window.ui.current().epoch,frame:{type:'ui_editor_text',text:'Native prefill'}})");
			assert.equal(await draftValue(), original);
			await ui.evaluate("window.ui.receive({type:'omp:draft-release',requestId:712})");
			await ui.wait("window.composer.value()==='Native prefill'");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("restored current and original text are one-shot, retain missing-image warnings and reserve marker numbers", async () => {
			await reset("restore-input");
			const restored = { type: "omp:draft-restore", requestId: 720, text: "Current [Image #5, 10x6]", attachments: 1, recoverable: [
				{ text: "Original [Image #9, 9x9]", attachments: 2, unconfirmed: true },
				{ text: "Refused text", attachments: 0, unconfirmed: false },
			], documents: [] };
			await ui.evaluate(`window.ui.receive(${JSON.stringify(restored)})`);
			await ui.wait("document.querySelectorAll('[aria-label=\"Dismiss recoverable message\"]').length===2&&document.querySelector('[aria-label=\"Dismiss attachment warning\"]')");
			assert.equal(await draftValue(), restored.text);
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-attach-error details pre')].map(node=>node.textContent)"), restored.recoverable.map(record => record.text));
			await installImages();
			await ui.evaluate("window.composer.focus()");
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
			await ui.wait(`window.composer.value()===${JSON.stringify(FIRST)}`);
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
			await ui.wait(`window.composer.selection().start===${second!.end}`);
			await press("Backspace", "Backspace", 8, { commands: ["deleteBackward"] });
			await ui.wait("!window.composer.value().includes('[Image #2')");
			await ui.evaluate("document.querySelector('button[aria-keyshortcuts=\"Enter\"]').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-prompt')");
			const sent = await ui.evaluate<{ text: string; images: { type: string; mimeType: string; data: string }[] }>("window.sent.find(message=>message.type==='omp:chat-prompt')");
			assert.equal(sent.text, "A [Image #1, 10x6] B  C [Image #2, 30x9] D", "markers are renumbered 1..K, the deleted one is gone");
			const pasted = await ui.evaluate<string[]>("window.pasted");
			assert.deepEqual(sent.images.map(image => image.data), [pasted[0], pasted[2]], "image K is the image behind marker K");
			assert.ok(sent.images.every(image => image.type === "image" && image.mimeType === "image/png"));
			await ui.wait("window.composer.value()===''");
			// The strip is published as its own state (`publishImages`) beside the draft text: wait for it instead of reading it in the same turn as the field.
			await ui.wait("document.querySelectorAll('.omp-attachment-number').length===0");
			assert.deepEqual(await strip(), []);
			await installImages();
			await pasteImage(7, 5, "[Image #1, 7x5]");
			assert.deepEqual(await strip(), ["#1"], "a new draft starts again at #1");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("an image arriving during an IME composition waits for it: the composition is never interrupted", async () => {
			await reset("image-refs-ime");
			await installImages();
			await ui.evaluate("window.composer.focus()");
			await ui.call("Input.insertText", { text: "かな" });
			await ui.evaluate("window.composer.el().dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))");
			await ui.evaluate("window.pasteImage(9,9)");
			await ui.wait("window.pasted.length===1 && !document.querySelector('.omp-composer-attach .codicon-loading')");
			await settleFrames();
			assert.equal(await draftValue(), "かな", "nothing is inserted while composing");
			await ui.evaluate("window.composer.el().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))");
			await ui.wait("window.composer.value().includes('[Image #1, 9x9]')");
			assert.equal(await draftValue(), "かな [Image #1, 9x9] ");
			assert.deepEqual(await strip(), ["#1"]);
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 0);
		});

		// The editing surface (docs/designs/2026-10-15-composer-contenteditable-surface.md): the page's own undo stack, plain-text
		// clipboard, caret mapping, retained selection, composition window and freeze.
		const typeKey = (character: string): Promise<void> => press(character, `Key${character.toUpperCase()}`, character.toUpperCase().charCodeAt(0), { text: character });
		const ctrlKey = (key: string, code: string, keyCode: number, modifiers = 2): Promise<void> => press(key, code, keyCode, { modifiers });
		const ctrlZ = (): Promise<void> => ctrlKey("z", "KeyZ", 90);
		const ctrlY = (): Promise<void> => ctrlKey("y", "KeyY", 89);
		const ctrlShiftZ = (): Promise<void> => ctrlKey("z", "KeyZ", 90, 10);
		const dispatchClipboard = (type: "paste" | "copy" | "cut", plain: string, html = ""): Promise<{ prevented: boolean; copied: string }> => ui.evaluate(`(()=>{
		 const data=new DataTransfer();${type === "paste" ? `data.setData('text/plain',${JSON.stringify(plain)});${html === "" ? "" : `data.setData('text/html',${JSON.stringify(html)});`}` : ""}
		 const event=new ClipboardEvent(${JSON.stringify(type)},{clipboardData:data,bubbles:true,cancelable:true});
		 window.composer.el().dispatchEvent(event);return{prevented:event.defaultPrevented,copied:data.getData('text/plain')}})()`);

		await t.test("Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z drive the page's own undo stack: a typing run is one step, a newline and an insertion stand alone, and Edit > Undo is inert", async () => {
			await reset("surface-undo");
			await ui.evaluate("window.composer.focus()");
			for (const character of "abc") await typeKey(character);
			await ui.wait("window.composer.value()==='abc'");
			await ui.call("Input.insertText", { text: "\n" });
			await ui.call("Input.insertText", { text: "def" });
			await ui.wait("window.composer.value()==='abc\\ndef'");
			await ctrlZ();
			await ui.wait("window.composer.value()==='abc\\n'");
			await ctrlZ();
			await ui.wait("window.composer.value()==='abc'");
			await ctrlZ();
			await ui.wait("window.composer.value()===''");
			assert.deepEqual(await selection(), { start: 0, end: 0 }, "the caret is where it was before the step");
			await ctrlZ();
			assert.equal(await draftValue(), "", "nothing is left to undo");
			await ctrlY();
			await ui.wait("window.composer.value()==='abc'");
			await ctrlShiftZ();
			await ui.wait("window.composer.value()==='abc\\n'");
			await ctrlY();
			await ui.wait("window.composer.value()==='abc\\ndef'");
			assert.deepEqual(await selection(), { start: 7, end: 7 });
			// A new edit drops what could be redone.
			await ctrlZ();
			await ui.wait("window.composer.value()==='abc\\n'");
			await ui.call("Input.insertText", { text: "xyz" });
			await ctrlY();
			assert.equal(await draftValue(), "abc\nxyz", "typing after an undo clears the redo stack");
			// The workbench's Edit > Undo is a native command the page does not take part in.
			assert.equal(await ui.evaluate("document.execCommand('undo')"), false);
			await settleFrames();
			assert.equal(await draftValue(), "abc\nxyz");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a send starts a fresh undo stack, while history recall and an accepted completion are one undoable step", async () => {
			await reset("surface-writes");
			await ui.evaluate(`const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.ui.push({commands:[{name:'shake',description:'Shake'},{name:'shape',description:'Shape'}],entries:[row('u1',{role:'user',timestamp:1,content:'first prompt'}),row('a1',{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:'ok'}]})],durableCount:2,working:false,settled:true});
			 window.composer.focus()`);
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('first prompt')");
			await press("ArrowUp", "ArrowUp", 38);
			await ui.wait("window.composer.value()==='first prompt'");
			await ctrlZ();
			await ui.wait("window.composer.value()===''");
			await ctrlY();
			await ui.wait("window.composer.value()==='first prompt'");
			// An accepted completion is one step: undo puts the typed text back.
			await setDraft("/sha");
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			await press("Tab", "Tab", 9);
			await ui.wait("window.composer.value()==='/shake '");
			await ctrlZ();
			await ui.wait("window.composer.value()==='/sha'");
			// A send clears the draft for good: nothing of it can be brought back.
			await setDraft("kept for the send");
			await press("Enter", "Enter", 13);
			await ui.wait("window.ui.sends().length===1");
			await ui.evaluate("window.ui.sendReply()");
			await ui.wait("window.composer.value()===''");
			await ctrlZ();
			await settleFrames();
			assert.equal(await draftValue(), "", "the sent draft is not restorable");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("paste inserts only the plain text with normalised line endings, copy and cut write the draft's own text, and cut is one undo step", async () => {
			await reset("surface-clipboard");
			await installImages();
			await ui.evaluate("window.composer.focus()");
			const pasted = await dispatchClipboard("paste", "a\r\nb\rc", "<b>bold</b> <i>more</i>");
			assert.equal(pasted.prevented, true);
			await ui.wait("window.composer.value()==='a\\nb\\nc'");
			assert.equal(await ui.evaluate("window.composer.el().querySelector('b,i,br:not(:only-child)')"), null, "no formatting and no stray node came from the HTML");
			assert.equal(await ui.evaluate("window.composer.el().children.length"), 3);
			await ctrlZ();
			await ui.wait("window.composer.value()===''");
			// A real paste (the workbench's Edit > Paste and Ctrl+V reach the page this way) takes the text too.
			await ui.evaluate("(()=>{const source=document.createElement('textarea');source.value='from the clipboard';document.body.append(source);source.select();const copied=document.execCommand('copy');source.remove();window.composer.focus();return copied;})()");
			await ui.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2, commands: ["paste"] });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2 });
			await ui.wait("window.composer.value()==='from the clipboard'");
			await setDraft("one\ntwo");
			await setSelection(1, 6);
			await ui.wait("window.composer.selection().start===1 && window.composer.selection().end===6");
			const copied = await dispatchClipboard("copy", "");
			assert.deepEqual(copied, { prevented: true, copied: "ne\ntw" });
			assert.equal(await draftValue(), "one\ntwo", "copy changes nothing");
			const cut = await dispatchClipboard("cut", "");
			assert.deepEqual(cut, { prevented: true, copied: "ne\ntw" });
			await ui.wait("window.composer.value()==='oo'");
			await ctrlZ();
			await ui.wait("window.composer.value()==='one\\ntwo'");
			assert.deepEqual(await selection(), { start: 1, end: 6 }, "undoing the cut selects what it removed");
			// A selection across chips copies the markers as the literal text the model holds.
			await buildDraft("surface-clipboard-chips");
			await ui.evaluate("window.composer.selectAll()");
			await ui.wait(`window.composer.selection().end===${FIRST.length}`);
			assert.deepEqual(await dispatchClipboard("copy", ""), { prevented: true, copied: FIRST });
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("plain text dropped on the field lands at the pointer, and a single-line insertText or a multi-line one keeps one line element per line", async () => {
			await reset("surface-drop");
			await setDraft("hello world");
			const point = await ui.evaluate<{ x: number; y: number }>("(()=>{const text=window.composer.el().children[0].firstChild;const range=document.createRange();range.setStart(text,5);range.setEnd(text,6);const box=range.getBoundingClientRect();return{x:box.left+1,y:box.top+box.height/2}})()");
			const dropped = await ui.evaluate<boolean>(`(()=>{const data=new DataTransfer();data.setData('text/plain','XYZ');
			 const event=new DragEvent('drop',{dataTransfer:data,clientX:${point.x},clientY:${point.y},bubbles:true,cancelable:true});window.composer.el().dispatchEvent(event);return event.defaultPrevented})()`);
			assert.equal(dropped, true);
			await ui.wait("window.composer.value()==='helloXYZ world'");
			await ctrlZ();
			await ui.wait("window.composer.value()==='hello world'");
			await ui.evaluate("window.composer.select(11)");
			await ui.call("Input.insertText", { text: "\nsecond\nthird" });
			await ui.wait("window.composer.value()==='hello world\\nsecond\\nthird'");
			assert.equal(await ui.evaluate("window.composer.el().children.length"), 3, "a line element per line");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("pasting or dropping several lines on a quote line keeps every line in the quote as one undo step; at column 0, outside a quote and in a top-level block it is the plain paste", async () => {
			await reset("quote-paste");
			await ui.evaluate("window.composer.focus()");
			const pasteAt = async (draft: string, start: number, end: number, plain: string, expected: string, what: string): Promise<void> => {
				await setDraft(draft);
				await ui.evaluate("window.composer.focus()");
				await setSelection(start, end);
				assert.equal((await dispatchClipboard("paste", plain)).prevented, true);
				await waitDraft(`window.composer.value()===${JSON.stringify(expected)}`);
				await ctrlZ();
				await waitDraft(`window.composer.value()===${JSON.stringify(draft)}`);
				assert.deepEqual(await ui.evaluate("window.errors"), [], what);
			};
			// The maintainer's case: the caret after `> `, several lines, CRLF and a lone CR, an empty line.
			await pasteAt("> ", 2, 2, "one\r\ntwo\rthree\r\n\r\nfour", "> one\n> two\n> three\n>\n> four", "plain lines after `> `");
			await pasteAt("> > a\n\nz", 5, 5, "x\ny", "> > ax\n> > y\n\nz", "a nested prefix is repeated whole");
			await pasteAt("  > a", 5, 5, "x\ny", "  > ax\n  > y", "an indented prefix is repeated whole");
			await pasteAt("> a\n\nz", 3, 3, "> x\n> y", "> a> x\n> y\n\nz", "a quote line pasted after text is text there");
			await pasteAt("> ", 2, 2, "> x\n> y", "> x\n> y", "an already quoted block is not nested again");
			await pasteAt("> ```ts\n> a\n> ```", 11, 11, "x\ny", "> ```ts\n> ax\n> y\n> ```", "inside a fenced block nested in the quote");
			await pasteAt("> a\nb", 3, 5, "x\ny", "> ax\n> y", "a selection from the quote into a plain line takes the prefix of the line it starts on");
			// The plain paste: column 0 before the `>`, inside the prefix, a line that is not a quote, a top-level block.
			await pasteAt("> a", 0, 0, "x\ny", "x\ny> a", "column 0");
			await pasteAt("> > a", 3, 3, "x\ny", "> >x\ny a", "inside the prefix");
			await pasteAt("a", 1, 1, "x\ny", "ax\ny", "outside a quote");
			await pasteAt("```\n> a\n```", 7, 7, "x\ny", "```\n> ax\ny\n```", "a `>` line in a top-level block is code");
			// The caret lands after the pasted text, in the field.
			await setDraft("> ");
			await ui.evaluate("window.composer.focus()");
			await setSelection(2, 2);
			await dispatchClipboard("paste", "x\ny\n");
			await waitDraft(`window.composer.value()===${JSON.stringify("> x\n> y\n> ")}`);
			assert.deepEqual(await areaState(), { value: "> x\n> y\n> ", start: 10, end: 10, focused: true });
			// A drop of plain text goes through the same insertion.
			await setDraft("> hello");
			await ui.evaluate("window.composer.focus()");
			const point = await ui.evaluate<{ x: number; y: number }>("(()=>{const text=window.composer.el().children[0].firstChild;const range=document.createRange();range.setStart(text,3);range.setEnd(text,4);const box=range.getBoundingClientRect();return{x:box.left+1,y:box.top+box.height/2}})()");
			const dropped = await ui.evaluate<boolean>(`(()=>{const data=new DataTransfer();data.setData('text/plain','X\\r\\nY');
			 const event=new DragEvent('drop',{dataTransfer:data,clientX:${point.x},clientY:${point.y},bubbles:true,cancelable:true});window.composer.el().dispatchEvent(event);return event.defaultPrevented})()`);
			assert.equal(dropped, true);
			await waitDraft(`window.composer.value()===${JSON.stringify("> hX\n> Yello")}`);
			await ctrlZ();
			await waitDraft("window.composer.value()==='> hello'");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("every offset of a draft with chips, blocks and empty lines maps to the DOM and back to itself", async () => {
			await buildDraft("surface-round-trip");
			await setDraft("A [Image #1, 10x6][Image #2, 20x8] B\n[Image #3, 30x9]\n\n```\ncode [Image #1, 10x6]\n\n```\n[Image #2, 20x8]\nlast ");
			await ui.wait("document.querySelectorAll('.omp-composer-input .omp-chip').length===5");
			assert.deepEqual(await ui.evaluate("window.composer.roundTrip()"), []);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-line--code .omp-chip').length"), 1, "the chip in the block's line");
			// A selection from one line to another maps to a range that includes the line break between them.
			await ui.evaluate("(()=>{const field=window.composer.el();document.getSelection().setBaseAndExtent(field.children[0].firstChild,2,field.children[1].lastChild,0)})()");
			await waitDraft("window.composer.selection().end>window.composer.selection().start");
			const across = await ui.evaluate<{ start: number; end: number }>("(()=>{const {start,end}=window.composer.selection();return{start,end}})()");
			assert.equal(across.start, 2);
			assert.ok(across.end > "A [Image #1, 10x6][Image #2, 20x8] B\n".length - 1);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the field is a labelled multiline textbox whose open completion list is announced through aria-controls, aria-activedescendant and a status", async () => {
			await reset("surface-aria");
			await ui.evaluate("window.ui.push({commands:[{name:'shake',description:'Shake'},{name:'shape',description:'Shape'}]})");
			const attributes = (): Promise<Record<string, string | null>> => ui.evaluate(`(()=>{const field=window.composer.el();const names=['role','aria-multiline','aria-label','aria-autocomplete','aria-haspopup','aria-controls','aria-activedescendant','aria-describedby','aria-disabled','aria-readonly','contenteditable','spellcheck','autocapitalize'];
			 return Object.fromEntries(names.map(name=>[name,field.getAttribute(name)]))})()`);
			assert.deepEqual(await attributes(), { role: "textbox", "aria-multiline": "true", "aria-label": "Message OMP", "aria-autocomplete": "list", "aria-haspopup": "listbox", "aria-controls": null, "aria-activedescendant": null, "aria-describedby": null, "aria-disabled": null, "aria-readonly": null, contenteditable: "true", spellcheck: "false", autocapitalize: "off" });
			await ui.evaluate("window.composer.focus()");
			await setDraft("/sha");
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			const list = await ui.evaluate<string>("document.querySelector('[aria-label=\"Slash commands\"]').id");
			const open = await attributes();
			assert.equal(open["aria-controls"], list);
			assert.equal(open["aria-activedescendant"], `${list}-0`);
			await ui.wait("document.querySelector('.omp-suggest-wrapper [role=status]').textContent==='2 suggestions'");
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('[aria-label=\"Slash commands\"]')");
			assert.equal((await attributes())["aria-controls"], null, "no list, no aria-controls");
			await ui.evaluate("window.ui.push({phase:'resyncing'})");
			await ui.wait("window.composer.disabled()");
			assert.equal((await attributes()).contenteditable, "false", "a field that cannot take a prompt is not editable");
			await ui.evaluate("window.ui.push({phase:'live'})");
			await ui.wait("!window.composer.disabled()");
			assert.equal((await attributes()).contenteditable, "true");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the selection is kept while the field has none, and focusing it puts it back instead of at the start", async () => {
			await reset("surface-retained-selection");
			// Earlier tests leave the page unfocused, where a focus() fires no focus event; a real window is focused.
			await ui.call("Emulation.setFocusEmulationEnabled", { enabled: true });
			try {
				await setDraft("hello world");
				await ui.evaluate("window.composer.select(2,5)");
				await waitDraft("window.composer.selection().start===2 && window.composer.selection().end===5");
				await ui.evaluate("(()=>{window.composer.blur();getSelection().removeAllRanges()})()");
				await settleFrames();
				await ui.evaluate("window.composer.focus()");
				await waitDraft("window.composer.selection().start===2 && window.composer.selection().end===5");
				assert.deepEqual(await selection(), { start: 2, end: 5 });
			} finally {
				await ui.call("Emulation.setFocusEmulationEnabled", { enabled: false });
			}
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a composition read back from the browser's own edits is one undo step, and nothing is lost to a send awaiting confirmation", async () => {
			await reset("surface-ime-real");
			await ui.evaluate("window.composer.focus()");
			await ui.call("Input.insertText", { text: "ab" });
			await ui.wait("window.composer.value()==='ab'");
			await ui.call("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
			await ui.wait("window.composer.value()==='abか'");
			await ui.call("Input.insertText", { text: "か" });
			await ui.wait("document.querySelector('button[aria-keyshortcuts=\"Enter\"]') && window.composer.value()==='abか'");
			await settleFrames();
			await ctrlZ();
			await ui.wait("window.composer.value()==='ab'");
			await ctrlZ();
			await ui.wait("window.composer.value()===''");
			// A send waiting for OMP's confirmation never erases what is composed meanwhile.
			await reset("surface-send-then-compose");
			await ui.evaluate("window.ui.admission(false);window.composer.focus()");
			await ui.call("Input.insertText", { text: "hello" });
			await press("Enter", "Enter", 13);
			await ui.wait("window.ui.sends().length===1");
			await ui.evaluate("(()=>{const field=window.composer.el();field.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));field.children[0].firstChild.data+='かな'})()");
			await ui.evaluate("window.ui.sendReply()");
			await ui.wait("!document.querySelector('button[aria-keyshortcuts=\"Enter\"]').disabled");
			await ui.evaluate("window.composer.el().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'かな'}))");
			await ui.wait("window.composer.value()==='helloかな'");
			await settleFrames();
			assert.equal(await draftValue(), "helloかな", "the confirmed send did not erase the composed text");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("work that arrives during a composition waits for it, and a field replaced by a dialog settles the composition first", async () => {
			await buildDraft("surface-ime-deferred");
			await ui.evaluate("(()=>{const field=window.composer.el();field.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))})()");
			await ui.evaluate("document.querySelector('.omp-attachment[data-image-number=\"2\"] .omp-attachment-remove').click()");
			await settleFrames();
			assert.equal(await draftValue(), FIRST, "the thumbnail's x waits for the composition");
			// A hand-off cannot capture a draft that is being composed.
			await ui.evaluate("window.ui.receive({type:'omp:draft-request',requestId:51})");
			await ui.wait("window.sent.some(message=>message.type==='omp:draft-reply'&&message.requestId===51)");
			assert.equal(await ui.evaluate("window.sent.find(message=>message.type==='omp:draft-reply'&&message.requestId===51).captured"), false);
			await ui.evaluate("window.composer.el().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))");
			await ui.wait(`window.composer.value()===${JSON.stringify(FIRST.replace("[Image #2, 20x8]", ""))}`);
			assert.deepEqual(await strip(), ["#1", "#3"]);
			// A dialog takes the field away mid-composition: the composed text is read back before the field goes.
			await ui.evaluate("window.composer.el().dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))");
			await ui.evaluate("(()=>{const text=window.composer.el().children[0].firstChild;text.data='かな '+text.data})()");
			await ui.evaluate("window.ui.push({uiRequests:[{id:'compose-ask',method:'input',title:'Name?',placeholder:'type here'}]})");
			await ui.wait("!window.composer.exists()");
			await ui.evaluate("window.ui.push({uiRequests:[]})");
			await ui.wait("window.composer.exists()");
			assert.ok((await draftValue()).startsWith("かな A "), `the composed text survived the dialog: ${await draftValue()}`);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a draft hand-off freezes the field against typing, paste and composition until it is released", async () => {
			await reset("surface-freeze");
			await ui.evaluate("window.composer.focus()");
			await ui.call("Input.insertText", { text: "held draft" });
			await ui.wait("window.composer.value()==='held draft'");
			await ui.evaluate("window.ui.receive({type:'omp:draft-request',requestId:61})");
			await ui.wait("window.sent.some(message=>message.type==='omp:draft-reply'&&message.requestId===61)");
			const reply = await ui.evaluate<{ captured: boolean; text: string }>("window.sent.find(message=>message.type==='omp:draft-reply'&&message.requestId===61)");
			assert.equal(reply.captured, true);
			assert.equal(reply.text, "held draft");
			assert.deepEqual(await ui.evaluate("(()=>{const field=window.composer.el();return[field.getAttribute('contenteditable'),field.getAttribute('aria-readonly'),window.composer.readOnly()]})()"), ["false", "true", true]);
			await ui.call("Input.insertText", { text: " more" });
			await dispatchClipboard("paste", "pasted");
			await ui.evaluate("window.composer.el().dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))");
			await settleFrames();
			await ctrlZ();
			assert.equal(await draftValue(), "held draft", "nothing changes the held draft");
			await ui.evaluate("window.ui.receive({type:'omp:draft-release',requestId:61})");
			await ui.wait("!window.composer.readOnly()");
			assert.equal(await ui.evaluate("window.composer.el().getAttribute('contenteditable')"), "true");
			await ui.evaluate("window.composer.focus()");
			await ui.call("Input.insertText", { text: "!" });
			await ui.wait("window.composer.value()==='held draft!'");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		// Commands and skills as atomic chips (docs/designs/2026-10-18-composer-command-skill-chips.md).
		const CHIP_COMMANDS = "[{name:'compact',description:'Compact the context'},{name:'status'},{name:'worktree',source:'builtin'},{name:'skill:review',source:'skill',description:'Review code',inputHint:'files'},{name:'skill:other',source:'skill'}]";
		interface CommandChip { kind: string | undefined; text: string; label: string | null; role: string | null; editable: string | null; spaced: string | undefined; background: string; icon: number }
		const commandChips = (): Promise<CommandChip[]> => ui.evaluate(`[...document.querySelectorAll('.omp-composer-input .omp-chip[data-kind="command"],.omp-composer-input .omp-chip[data-kind="skill"]')].map(chip=>({kind:chip.dataset.kind,text:chip.textContent,label:chip.getAttribute('aria-label'),role:chip.getAttribute('role'),editable:chip.getAttribute('contenteditable'),spaced:chip.dataset.spaced,background:getComputedStyle(chip).backgroundColor,icon:getComputedStyle(chip,'::before').content.codePointAt(1)}))`);
		const chipSetup = async (name: string): Promise<void> => {
			await reset(name);
			await ui.evaluate(`window.ui.push({commands:${CHIP_COMMANDS}});window.composer.focus()`);
		};
		const waitChips = (count: number): Promise<void> => ui.wait(`document.querySelectorAll('.omp-composer-input .omp-chip[data-kind="command"],.omp-composer-input .omp-chip[data-kind="skill"]').length===${count}`);

		await t.test("a command or a skill picked from the list is one chip, the same style with a terminal prompt or a book, holding the literal token and its space, and the text sent is unchanged", async () => {
			await chipSetup("chips-pick");
			await ui.call("Input.insertText", { text: "/skill:rev" });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			assert.deepEqual(await commandChips(), [], "a name still being typed is text");
			await press("Tab", "Tab", 9);
			await waitDraft("window.composer.value()==='/skill:review '");
			await waitChips(1);
			const [skill] = await commandChips();
			assert.deepEqual({ ...skill!, background: "" }, { kind: "skill", text: "/skill:review ", label: "Skill review", role: "group", editable: "false", spaced: "true", background: "", icon: 0xeaa4 });
			assert.notEqual(skill!.background, "rgba(0, 0, 0, 0)", "the chip is drawn on a tinted background");
			assert.deepEqual(await selection(), { start: 14, end: 14 }, "the caret rests after the chip");
			assert.equal(await ui.evaluate("document.querySelector('[aria-label=\"Slash commands\"]')"), null, "no popup opens on a chip");
			assert.deepEqual(await ui.evaluate("window.composer.roundTrip()"), []);
			await ui.call("Input.insertText", { text: "src/a.ts" });
			await waitDraft("window.composer.value()==='/skill:review src/a.ts'");
			await press("Enter", "Enter", 13);
			await ui.wait("window.ui.sends().length===1");
			assert.equal(await ui.evaluate("window.ui.sends()[0].text"), "/skill:review src/a.ts", "the text sent is the draft, token and arguments, unchanged");
			await ui.evaluate("window.ui.sendReply()");
			await waitDraft("window.composer.value()===''");
			await waitChips(0);
			await ui.call("Input.insertText", { text: "/comp" });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			await press("Tab", "Tab", 9);
			await waitDraft("window.composer.value()==='/compact '");
			await waitChips(1);
			const [command] = await commandChips();
			assert.deepEqual({ ...command!, background: "" }, { kind: "command", text: "/compact ", label: "Command compact", role: "group", editable: "false", spaced: "true", background: "", icon: 0xea85 });
			assert.equal(command!.background, skill!.background, "one chip style for both; the icon and the label tell them apart");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a typed name is a chip the moment it is complete and keeps its space or line break when one follows, while an unknown command, a path and a denied command stay plain text", async () => {
			await chipSetup("chips-typed");
			await ui.call("Input.insertText", { text: "/compact" });
			await waitDraft("window.composer.value()==='/compact'");
			await waitChips(1);
			assert.deepEqual([(await commandChips())[0]!.text, (await commandChips())[0]!.spaced], ["/compact", undefined], "a complete name at the end of the draft is a chip with nothing after it");
			await ui.call("Input.insertText", { text: " " });
			await waitChips(1);
			await waitDraft("window.composer.value()==='/compact '");
			assert.deepEqual([(await commandChips())[0]!.text, (await commandChips())[0]!.spaced], ["/compact ", "true"]);
			await setDraft("/compact");
			await waitDraft("window.composer.value()==='/compact'");
			await press("Enter", "Enter", 13, { modifiers: 8, commands: ["insertLineBreak"] });
			await waitDraft("window.composer.value()==='/compact\\n'");
			await waitChips(1);
			assert.deepEqual([(await commandChips())[0]!.text, (await commandChips())[0]!.spaced], ["/compact", undefined], "a line break follows the chip and is not part of it");
			assert.deepEqual(await ui.evaluate("window.composer.roundTrip()"), []);
			for (const text of ["/foo bar", "/foo", "/usr/bin x", "/comp now", "/compac", "/compactx", "/Compact", "/Compact now", "x /compact now", "/compact/x now", "/worktree now", "/worktree"]) {
				await setDraft(text);
				await waitDraft(`window.composer.value()===${JSON.stringify(text)}`);
				await settleFrames();
				assert.deepEqual(await commandChips(), [], `${JSON.stringify(text)} is text`);
			}
			// The send trims the left edge, so a draft that starts with a blank still runs the command and shows the chip.
			await setDraft(" /compact now");
			await waitDraft("window.composer.value()===' /compact now'");
			await waitChips(1);
			assert.equal((await commandChips())[0]!.text, "/compact ");
			assert.deepEqual(await ui.evaluate("window.composer.roundTrip()"), []);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		// A leading name that is exactly a command or a skill is a block at once; the suggestion list stays open with that entry first and selected.
		const REPORT_COMMANDS = "[{name:'skill:bug-report',source:'skill',description:'Write a bug report'},{name:'skill:report',source:'skill',description:'Report skill'},{name:'reports',source:'extension',description:'Several reports'},{name:'report',source:'custom',description:'File a report'}]";
		const slashRows = (): Promise<{ labels: string[]; selected: string[] }> => ui.evaluate(`(()=>{const list=document.querySelector('[aria-label="Slash commands"]');if(!list)return{labels:[],selected:[]};return{labels:[...list.querySelectorAll('[role="option"] strong')].map(n=>n.textContent),selected:[...list.querySelectorAll('[role="option"][aria-selected="true"] strong')].map(n=>n.textContent)}})()`);
		await t.test("an exact name keeps the list open with that command first and selected and is a chip without Space; one more character or one deleted character turns it back into text and completion goes on", async () => {
			await reset("chips-exact");
			await ui.evaluate(`window.ui.push({commands:${REPORT_COMMANDS}});window.composer.focus()`);
			const back = (): Promise<void> => press("Backspace", "Backspace", 8, { commands: ["deleteBackward"] });
			await ui.call("Input.insertText", { text: "/repor" });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			assert.deepEqual(await commandChips(), [], "a prefix is text");
			assert.deepEqual((await slashRows()).labels, ["/reports", "/report", "/skill:bug-report", "/skill:report"], "commands above skills");
			await ui.call("Input.insertText", { text: "t" });
			await waitDraft("window.composer.value()==='/report'");
			await waitChips(1);
			assert.deepEqual([(await commandChips())[0]!.text, (await commandChips())[0]!.label, (await commandChips())[0]!.spaced], ["/report", "Command report", undefined]);
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			assert.deepEqual(await slashRows(), { labels: ["/report", "/reports", "/skill:bug-report", "/skill:report"], selected: ["/report"] }, "the exact command leads, is the one selected row, and commands stay above skills");
			assert.deepEqual(await selection(), { start: 7, end: 7 }, "the caret rests after the block");
			assert.deepEqual(await ui.evaluate("window.composer.roundTrip()"), []);
			// One more character: text again, and completion continues with the longer query.
			await ui.call("Input.insertText", { text: "x" });
			await waitDraft("window.composer.value()==='/reportx'");
			await waitChips(0);
			assert.equal(await ui.evaluate("document.querySelector('[aria-label=\"Slash commands\"]')"), null, "nothing matches /reportx");
			// Deleting it brings the block back; deleting one more makes the rest text.
			await back();
			await waitDraft("window.composer.value()==='/report'");
			await waitChips(1);
			assert.deepEqual((await slashRows()).selected, ["/report"]);
			await back();
			await waitDraft("window.composer.value()==='/repor'");
			await waitChips(0);
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			assert.deepEqual(await selection(), { start: 6, end: 6 });
			await ctrlZ();
			await waitDraft("window.composer.value()==='/reportx'");
			await setDraft("/report");
			await waitDraft("window.composer.value()==='/report'");
			await waitChips(1);
			// Delete before the block removes its first character the same way.
			await setSelection(0, 0);
			await waitDraft("window.composer.selection().start===0");
			await press("Delete", "Delete", 46, { commands: ["deleteForward"] });
			await waitDraft("window.composer.value()==='report'");
			await waitChips(0);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Enter on an exact name accepts it as for any suggestion, so the block takes its space and the next Enter sends; a name that takes arguments still takes a space and the arguments after the block", async () => {
			await reset("chips-exact-enter");
			await ui.evaluate(`window.ui.push({commands:${REPORT_COMMANDS.slice(0, -1)},{name:'skill:review',source:'skill',description:'Review code',inputHint:'files'}]});window.composer.focus()`);
			await ui.call("Input.insertText", { text: "/report" });
			await waitChips(1);
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			await press("Enter", "Enter", 13);
			await waitDraft("window.composer.value()==='/report '");
			await waitChips(1);
			assert.equal((await commandChips())[0]!.spaced, "true");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0, "Enter with the list open accepts and does not send");
			assert.equal(await ui.evaluate("document.querySelector('[aria-label=\"Slash commands\"]')"), null);
			await press("Enter", "Enter", 13);
			await ui.wait("window.ui.sends().length===1");
			assert.equal(await ui.evaluate("window.ui.sends()[0].text"), "/report", "the text sent is the draft");
			await ui.evaluate("window.ui.sendReply()");
			await waitDraft("window.composer.value()===''");
			await ui.call("Input.insertText", { text: "/skill:review" });
			await waitChips(1);
			assert.equal((await commandChips())[0]!.label, "Skill review");
			await ui.call("Input.insertText", { text: " " });
			await waitDraft("window.composer.value()==='/skill:review '");
			await ui.call("Input.insertText", { text: "src/a.ts" });
			await waitDraft("window.composer.value()==='/skill:review src/a.ts'");
			assert.deepEqual([(await commandChips())[0]!.text, (await commandChips())[0]!.spaced], ["/skill:review ", "true"], "the arguments follow the block");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		// Typed key by key at idle with the catalogue a real OMP lists: a builtin `reload-plugins`, a prompt-template file command `report` and skills.
		const REAL_COMMANDS = "[{name:'compact',source:'builtin',description:'Compact the context'},{name:'reload-plugins',source:'builtin',description:'Reload all plugins'},{name:'skill:omp-desk-bug-triage',source:'skill',description:'Use to triage and research OMP Desk bugs and write a report'},{name:'skill:omp-desk-release',source:'skill',description:'Release a new OMP Desk version'},{name:'report',source:'file',description:'Pause, report progress and next step, then resume'},{name:'skill:report-writer',source:'skill',description:'Write a report'}]";
		const typeNames = async (text: string): Promise<{ typed: string; labels: string[]; selected: string[]; chips: string[] }[]> => {
			const seen = [];
			for (const char of text) {
				await typeKey(char);
				await waitDraft(`window.composer.value().endsWith(${JSON.stringify(char)})`);
				await settleFrames();
				seen.push({ typed: await draftValue(), ...(await slashRows()), chips: (await commandChips()).map(chip => chip.text) });
			}
			return seen;
		};
		await t.test("typed key by key at idle, /report (a file command) keeps its list open at every length, first and selected at the full name and a chip, with the skills below it", async () => {
			await reset("chips-real-report");
			await ui.evaluate(`window.ui.push({commands:${REAL_COMMANDS},working:false});window.composer.focus()`);
			const seen = await typeNames("/report");
			for (const step of seen) assert.ok(step.labels.length > 0, `the list is open after ${JSON.stringify(step.typed)}`);
			const full = seen.at(-1)!;
			assert.deepEqual(full.labels, ["/report", "/skill:report-writer"], "the exact file command is first, the skill whose name contains it follows");
			assert.deepEqual(full.selected, ["/report"]);
			assert.deepEqual(full.chips, ["/report"]);
			assert.deepEqual(seen.slice(0, -1).map(step => step.chips), [[], [], [], [], [], []], "no prefix is a chip");
			assert.deepEqual(seen[2]!.labels, ["/rewind", "/fresh", "/reload-plugins", "/report", "/skill:omp-desk-bug-triage", "/skill:omp-desk-release", "/skill:report-writer"], "at /re every command is listed above every skill");
			await typeKey("s");
			await waitDraft("window.composer.value()==='/reports'");
			await settleFrames();
			assert.deepEqual([(await commandChips()).length, (await slashRows()).labels.length], [0, 0], "nothing matches /reports");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("typed key by key at idle, /reload reaches OMP's /reload-plugins: the row is in the list at /rel, /reloa and /reload, and /reload-plugins is the exact chip", async () => {
			await reset("chips-real-reload");
			await ui.evaluate(`window.ui.push({commands:${REAL_COMMANDS},working:false});window.composer.focus()`);
			const seen = await typeNames("/reload");
			for (const step of seen.slice(1)) assert.ok(step.labels.includes("/reload-plugins"), `/reload-plugins is listed after ${JSON.stringify(step.typed)}`);
			assert.deepEqual(seen.at(-1)!.labels, ["/reload-plugins"]);
			assert.deepEqual(seen.at(-1)!.chips, [], "/reload is only a prefix, so it is text");
			for (const char of "-plugins") await typeKey(char);
			await waitDraft("window.composer.value()==='/reload-plugins'");
			await waitChips(1);
			assert.deepEqual(await slashRows(), { labels: ["/reload-plugins"], selected: ["/reload-plugins"] });
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a skill is a chip mid-text exactly where OMP invokes it: the first valid token, not after another command or a shell sigil, not an unknown skill", async () => {
			await chipSetup("chips-mid-text");
			await setDraft("please /skill:review the file");
			await waitChips(1);
			assert.deepEqual([(await commandChips())[0]!.label, await ui.evaluate("document.querySelector('.omp-chip[data-kind=\"skill\"]').previousSibling.data")], ["Skill review", "please "]);
			assert.deepEqual(await ui.evaluate("window.composer.roundTrip()"), []);
			await setDraft("a /skill:other b /skill:review c");
			await waitDraft("window.composer.value()==='a /skill:other b /skill:review c'");
			await waitChips(1);
			assert.equal((await commandChips())[0]!.label, "Skill other", "only the first token is invoked");
			for (const text of ["a /skill:nope b /skill:review c", "/compact do /skill:review x", "!ls /skill:review x", "a /skill:review", "a/skill:review b"]) {
				await setDraft(text);
				await waitDraft(`window.composer.value()===${JSON.stringify(text)}`);
				await settleFrames();
				assert.deepEqual((await commandChips()).filter(chip => chip.kind === "skill"), [], `${JSON.stringify(text)}: OMP does not invoke a skill here`);
			}
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the caret cannot enter a command chip and the arrows skip it, one Backspace right after it or Delete right before it removes it whole, and each is one undo step", async () => {
			await chipSetup("chips-keys");
			await setDraft("/compact now");
			await waitChips(1);
			const back = (): Promise<void> => press("Backspace", "Backspace", 8, { commands: ["deleteBackward"] });
			await setSelection(9, 9);
			await waitDraft("window.composer.selection().start===9");
			await back();
			await waitDraft("window.composer.value()==='now'");
			await waitChips(0);
			await ctrlZ();
			await waitDraft("window.composer.value()==='/compact now'");
			await waitChips(1);
			assert.deepEqual(await selection(), { start: 9, end: 9 }, "undo puts the caret where Backspace found it");
			await setSelection(0, 0);
			await waitDraft("window.composer.selection().start===0");
			await press("Delete", "Delete", 46, { commands: ["deleteForward"] });
			await waitDraft("window.composer.value()==='now'");
			await ctrlZ();
			await waitDraft("window.composer.value()==='/compact now'");
			// The word-wise delete takes the chip whole too.
			await setSelection(9, 9);
			await waitDraft("window.composer.selection().start===9");
			await press("Backspace", "Backspace", 8, { modifiers: 2, commands: ["deleteWordBackward"] });
			await waitDraft("window.composer.value()==='now'");
			await ctrlZ();
			await waitDraft("window.composer.value()==='/compact now'");
			// One arrow crosses the whole chip, in both directions; Shift+Arrow selects it whole.
			await setSelection(0, 0);
			await waitDraft("window.composer.selection().start===0");
			await press("ArrowRight", "ArrowRight", 39);
			await waitDraft("window.composer.selection().start===9");
			assert.deepEqual(await selection(), { start: 9, end: 9 });
			await press("ArrowLeft", "ArrowLeft", 37);
			await waitDraft("window.composer.selection().start===0");
			await press("ArrowRight", "ArrowRight", 39, { modifiers: 8 });
			await waitDraft("window.composer.selection().end===9");
			assert.deepEqual(await selection(), { start: 0, end: 9 });
			// A point inside the chip's text snaps to an edge; a selection that cuts into it takes it whole.
			await ui.evaluate("(()=>{const chip=document.querySelector('.omp-chip[data-kind=\"command\"]');document.getSelection().setBaseAndExtent(chip.firstChild,3,chip.firstChild,3)})()");
			await waitDraft("(()=>{const a=window.composer.selection();return a.start===a.end&&(a.start===0||a.start===9)})()");
			await ui.evaluate("(()=>{const chip=document.querySelector('.omp-chip[data-kind=\"command\"]');document.getSelection().setBaseAndExtent(chip.firstChild,3,chip.nextSibling,2)})()");
			await waitDraft("window.composer.selection().end===11&&window.composer.selection().start===0");
			await back();
			await waitDraft("window.composer.value()==='w'");
			await ctrlZ();
			await waitDraft("window.composer.value()==='/compact now'");
			// Typing over a selection that holds the chip replaces it whole.
			await setSelection(0, 11);
			await waitDraft("window.composer.selection().end===11");
			await ui.call("Input.insertText", { text: "x" });
			await waitDraft("window.composer.value()==='xw'");
			await ctrlZ();
			await waitDraft("window.composer.value()==='/compact now'");
			// A real click inside the chip lands on its nearest edge.
			const spot = (fraction: number): Promise<{ x: number; y: number }> => ui.evaluate(`(()=>{const r=document.querySelector('.omp-chip[data-kind="command"]').getBoundingClientRect();return{x:r.left+r.width*${fraction},y:r.top+r.height/2}})()`);
			await setSelection(12, 12);
			await waitDraft("window.composer.selection().start===12");
			await clickAt(await spot(0.85));
			await waitDraft("window.composer.selection().start===9");
			await clickAt(await spot(0.1));
			await waitDraft("window.composer.selection().start===0");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("undo, paste, history recall, a prompt picked in the history search and a restored draft all show the chip, because the chip is a rule over the text and the catalogue", async () => {
			await chipSetup("chips-sources");
			await ui.evaluate(`const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.ui.push({entries:[row('u1',{role:'user',timestamp:1,content:'/skill:review src/a.ts'}),row('a1',{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:'ok'}]})],durableCount:2,working:false,settled:true});
			 window.composer.focus()`);
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('src/a.ts')");
			await press("ArrowUp", "ArrowUp", 38);
			await waitDraft("window.composer.value()==='/skill:review src/a.ts'");
			await waitChips(1);
			await ctrlZ();
			await waitDraft("window.composer.value()===''");
			await waitChips(0);
			await ctrlY();
			await waitDraft("window.composer.value()==='/skill:review src/a.ts'");
			await waitChips(1);
			await ctrlZ();
			await waitDraft("window.composer.value()===''");
			// Paste.
			assert.equal((await dispatchClipboard("paste", "/compact now")).prevented, true);
			await waitDraft("window.composer.value()==='/compact now'");
			await waitChips(1);
			await ctrlZ();
			await waitDraft("window.composer.value()===''");
			await waitChips(0);
			// The history search (Ctrl+Alt+Y) hands the picked prompt to the page.
			await ui.evaluate("window.ui.receive({type:'omp:recall-prompt',text:'/skill:other b.ts',documents:[],notes:[]})");
			await waitDraft("window.composer.value()==='/skill:other b.ts'");
			await waitChips(1);
			assert.equal((await commandChips())[0]!.label, "Skill other");
			// A draft restored after a reload, and a catalogue that arrives after the draft or changes under it.
			await reset("chips-restore");
			await ui.evaluate(`window.ui.receive({type:'omp:draft-restore',requestId:730,text:'/compact x',attachments:0,recoverable:[],documents:[]})`);
			await waitDraft("window.composer.value()==='/compact x'");
			await settleFrames();
			assert.deepEqual(await commandChips(), [], "the session has not listed its commands yet");
			await ui.evaluate("window.composer.select(10)");
			await waitDraft("window.composer.selection().start===10");
			await ui.evaluate(`window.ui.push({commands:${CHIP_COMMANDS}})`);
			await waitChips(1);
			assert.deepEqual(await selection(), { start: 10, end: 10 }, "the caret stays where it was when the chip is drawn around it");
			await ui.evaluate("window.ui.push({commands:[]})");
			await waitChips(0);
			await ui.evaluate("window.composer.select(4)");
			await waitDraft("window.composer.selection().start===4");
			await ui.evaluate(`window.ui.push({commands:${CHIP_COMMANDS}})`);
			await waitChips(1);
			await waitDraft("(()=>{const a=window.composer.selection();return a.start===a.end&&(a.start===0||a.start===9)})()");
			await ui.evaluate("window.ui.push({commands:[{name:'status'}]})");
			await waitChips(0);
			assert.equal(await draftValue(), "/compact x", "a command that leaves the catalogue is text again and the draft is untouched");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("while a turn runs a command and a skill are chips as when idle, because the host sends both as a prompt (OMP's terminal UI does) and the text sent is unchanged", async () => {
			await chipSetup("chips-working");
			await setDraft("/skill:review x");
			await waitChips(1);
			await ui.evaluate("window.ui.push({working:true})");
			await settleFrames();
			assert.equal((await commandChips())[0]!.label, "Skill review", "a skill invocation reaches OMP as a prompt whatever the turn is doing");
			assert.equal(await draftValue(), "/skill:review x", "the draft is the same text");
			await setDraft("please run /skill:review on it");
			await waitDraft("window.composer.value()==='please run /skill:review on it'");
			await waitChips(1);
			await setDraft("/compact x");
			await waitDraft("window.composer.value()==='/compact x'");
			await waitChips(1);
			assert.equal((await commandChips())[0]!.label, "Command compact", "a builtin is sent as a prompt during a turn too");
			await setDraft("/clear x");
			await waitDraft("window.composer.value()==='/clear x'");
			await waitChips(1);
			assert.equal((await commandChips())[0]!.label, "Command clear", "Chat answers its own commands whatever the turn is doing");
			await setDraft("/CLEAR x");
			await waitDraft("window.composer.value()==='/CLEAR x'");
			await waitChips(1);
			for (const text of ["/foo x", "/usr/bin/x now", "/Compact x"]) {
				await setDraft(text);
				await waitDraft(`window.composer.value()===${JSON.stringify(text)}`);
				await settleFrames();
				assert.deepEqual(await commandChips(), [], `${text} stays text during a turn`);
			}
			await setDraft("/compact keep files");
			await waitChips(1);
			await press("Enter", "Enter", 13);
			await ui.wait("window.ui.sends().length===1");
			assert.deepEqual(await ui.evaluate("(({type,text})=>({type,text}))(window.ui.sends()[0])"), { type: "omp:chat-steer", text: "/compact keep files" }, "the page still posts a steer with the draft unchanged; the host picks the command");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a quote beside a chip, an IME composition next to it and a send leave the chip and the text intact", async () => {
			await chipSetup("chips-neighbours");
			await ui.call("Emulation.setFocusEmulationEnabled", { enabled: true });
			try {
				await setDraft("/skill:review x");
				await waitChips(1);
				await ui.evaluate("window.ui.receive({type:'omp:insert-quote',quotes:[{location:'src/app.ts:1',fileName:'app.ts',languageId:'typescript',text:'const x = 1;'}]})");
				await waitDraft("window.composer.value().startsWith('/skill:review x')&&window.composer.value().includes('> `src/app.ts:1`')");
				await ui.wait("document.querySelector('.omp-line--quote')");
				await waitChips(1);
				assert.deepEqual(await ui.evaluate("window.composer.roundTrip()"), []);
				await ctrlZ();
				await waitDraft("window.composer.value()==='/skill:review x'");
				await waitChips(1);
				// A composition at the end of the line and one straight after the chip.
				await setSelection(15, 15);
				await waitDraft("window.composer.selection().start===15");
				await ui.call("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
				await waitDraft("window.composer.value()==='/skill:review xか'");
				await ui.call("Input.insertText", { text: "か" });
				await settleFrames();
				await waitChips(1);
				assert.equal(await draftValue(), "/skill:review xか");
				await ctrlZ();
				await waitDraft("window.composer.value()==='/skill:review x'");
				await setSelection(14, 14);
				await waitDraft("window.composer.selection().start===14");
				await ui.call("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
				await waitDraft("window.composer.value()==='/skill:review かx'");
				await ui.call("Input.insertText", { text: "か" });
				await settleFrames();
				await waitChips(1);
				assert.equal(await draftValue(), "/skill:review かx");
				assert.deepEqual([(await commandChips())[0]!.text, await ui.evaluate("window.composer.roundTrip()")], ["/skill:review ", []]);
				assert.equal(await sendCount(), 0);
				assert.deepEqual(await ui.evaluate("window.errors"), []);
			} finally {
				await ui.call("Emulation.setFocusEmulationEnabled", { enabled: false });
			}
		});

		await t.test("the catalogue a real OMP 18.11.1 session advertises (86 skills as `skill:<name>`, nested names, builtins with aliases) draws every skill and command as a chip", async () => {
			const wire: unknown[] = JSON.parse(readFileSync(new URL("./test-support/available-commands-18.11.1.json", import.meta.url), "utf8"));
			const real = JSON.stringify(parseCommands(wire));
			await reset("chips-real-catalogue");
			// The draft was restored before the session listed its commands: no chip until the catalogue arrives.
			await ui.evaluate("window.composer.focus()");
			await setDraft("/skill:backlog first look");
			await settleFrames();
			assert.deepEqual(await commandChips(), []);
			await ui.evaluate(`window.ui.push({commands:${real}})`);
			await waitChips(1);
			assert.deepEqual((await commandChips()).map(chip => [chip.kind, chip.text]), [["skill", "/skill:backlog "]]);
			for (const [draft, kind, text] of [
				["/skill:agents/tracker-cli check it", "skill", "/skill:agents/tracker-cli "],
				["/skill:brainstorm", "skill", "/skill:brainstorm"],
				["/compact keep files", "command", "/compact "],
				["/review focus", "command", "/review "],
				["/security scan", "command", "/security "],
				["/model gpt", "command", "/model "],
				["read it with /skill:create-plan now", "skill", "/skill:create-plan "],
			] as const) {
				await setDraft(draft);
				await waitDraft(`window.composer.value()===${JSON.stringify(draft)}`);
				await settleFrames();
				assert.deepEqual((await commandChips()).map(chip => [chip.kind, chip.text]), [[kind, text]], draft);
			}
			// Picked from the list, typed by hand: the same chip.
			await setDraft("");
			await ui.call("Input.insertText", { text: "/skill:back" });
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			await press("Tab", "Tab", 9);
			await waitDraft("window.composer.value()==='/skill:backlog '");
			await waitChips(1);
			await setDraft("");
			await ui.call("Input.insertText", { text: "/skill:brainstorm " });
			await waitChips(1);
			assert.deepEqual((await commandChips()).map(chip => [chip.kind, chip.text]), [["skill", "/skill:brainstorm "]]);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the chip follows the theme in both colour schemes", async () => {
			const schemes = {
				dark: { "editor-background": "#1f1f1f", "editor-foreground": "#cccccc", foreground: "#cccccc", "editorWidget-background": "#202020", "panel-border": "#2b2b2b", "widget-border": "#313131", "input-background": "#313131", "input-foreground": "#cccccc", "button-background": "#0078d4", descriptionForeground: "#9d9d9d", "textLink-foreground": "#4daafc", "font-family": "'Segoe UI', sans-serif" },
				light: { "editor-background": "#ffffff", "editor-foreground": "#3b3b3b", foreground: "#3b3b3b", "editorWidget-background": "#f8f8f8", "panel-border": "#e5e5e5", "widget-border": "#c8c8c8", "input-background": "#ffffff", "input-foreground": "#3b3b3b", "button-background": "#005fb8", descriptionForeground: "#616161", "textLink-foreground": "#005fb8", "font-family": "'Segoe UI', sans-serif" },
			} as const;
			const backgrounds: string[] = [];
			for (const [scheme, variables] of Object.entries(schemes)) {
				await chipSetup(`chips-theme-${scheme}`);
				await ui.evaluate(`document.body.className='vscode-${scheme}';document.body.setAttribute('data-vscode-theme-id','${scheme}');${Object.entries(variables).map(([name, value]) => `document.documentElement.style.setProperty('--vscode-${name}',${JSON.stringify(value)})`).join(";")}`);
				await ui.call("Emulation.setDeviceMetricsOverride", { width: 720, height: 560, deviceScaleFactor: 2, mobile: false });
				for (const [name, draft, kind] of [["skill", "/skill:review src/webview/components/Composer.tsx", "skill"], ["command", "/compact keep the open files", "command"], ["mid-text-skill", "please check the diff with /skill:review before I commit", "skill"]] as const) {
					await setDraft(draft);
					await waitChips(1);
					await ui.evaluate("document.querySelector('.omp-chip[data-kind]')?.getBoundingClientRect()");
					await settleFrames();
					const [chip] = await commandChips();
					assert.equal(chip!.kind, kind);
					assert.notEqual(chip!.background, "rgba(0, 0, 0, 0)", `${scheme} ${name}: the chip has a background of its own`);
					if (name === "skill") backgrounds.push(chip!.background);
					if (process.env.OMP_UI_SCREENSHOT_DIR) {
						const box = await ui.evaluate<{ x: number; y: number; width: number; height: number }>("(()=>{const r=document.querySelector('.omp-composer').getBoundingClientRect();return{x:Math.max(0,r.left-8),y:Math.max(0,r.top-8),width:r.width+16,height:r.height+16}})()");
						const image = await ui.call("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } });
						await mkdir(process.env.OMP_UI_SCREENSHOT_DIR, { recursive: true });
						await writeFile(join(process.env.OMP_UI_SCREENSHOT_DIR, `composer-chip-${name}-${scheme}.png`), Buffer.from(String(image.data), "base64"));
					}
				}
				await ui.call("Emulation.clearDeviceMetricsOverride");
			}
			assert.notEqual(backgrounds[0], backgrounds[1], "the tint is the theme's link colour, so it differs between the schemes");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
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
			await ui.evaluate("window.composer.focus()");
			const typing = async (text: string) => { await ui.call("Input.insertText", { text }); await ui.evaluate(frame); };
			const newline = async () => { await ui.call("Input.insertText", { text: "\n" }); await ui.evaluate(frame); };
			for (const mode of ["following", "detached"]) {
				if (mode === "detached") {
					await ui.evaluate("window.composer.setText('')");
					await ui.evaluate(frame);
					const point = await ui.evaluate<{ x: number; y: number }>("(()=>{const rect=document.querySelector('.omp-transcript').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()");
					await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
					await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: -130 });
					await ui.wait("document.querySelector('.omp-jump-latest')");
					await ui.evaluate("new Promise(r=>setTimeout(r,600))");
					await ui.settleGeometry(".omp-transcript");
					await ui.evaluate("window.composer.focus()");
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
				await ui.evaluate("window.composer.setText('')");
				await ui.evaluate(frame);
				const shrunk = await ui.evaluate<{ offset: number }>(probe(base.key));
				if (mode === "following") assert.ok(await ui.evaluate("(()=>{const r=document.querySelector('.omp-transcript');return Math.abs(r.scrollHeight-r.clientHeight-r.scrollTop)<=1})()"), "following stays at the tail after the dock shrinks");
				else assert.ok(Math.abs(shrunk.offset - base.offset) <= 1, `detached: shrinking the dock moved the bottom line by ${shrunk.offset - base.offset}px`);
			}
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a message the user sends from the composer returns a scrolled-up transcript to the tail and follows it: a prompt, a steer and a queued follow-up", async () => {
			await reset("send-follows-tail");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 window.mk=(i)=>i%2===0?row('u'+i,{role:'user',timestamp:1000+i,content:'Prompt '+i}):row('a'+i,{role:'assistant',model:'m',timestamp:1000+i,stopReason:'stop',content:[{type:'text',text:'Reply '+i+'\\n\\n'+Array.from({length:6},(_,line)=>'Line '+i+'.'+line+' of readable history text.').join('\\n\\n')}]});
			 window.hist=Array.from({length:14},(_,i)=>window.mk(i));
			 window.ui.push({entries:window.hist,durableCount:window.hist.length,working:false,settled:true});
			})()`);
			await ui.settleGeometry(".omp-transcript");
			const atTail = "(()=>{const r=document.querySelector('.omp-transcript');return Math.abs(r.scrollHeight-r.clientHeight-r.scrollTop)<=1})()";
			const visible = (text: string) => `(()=>{const root=document.querySelector('.omp-transcript').getBoundingClientRect();return [...document.querySelectorAll('.omp-transcript *')].some(el=>el.children.length===0&&el.textContent.includes(${JSON.stringify(text)})&&el.getBoundingClientRect().bottom>root.top&&el.getBoundingClientRect().top<root.bottom)})()`;
			const detach = async () => {
				const point = await ui.evaluate<{ x: number; y: number }>("(()=>{const rect=document.querySelector('.omp-transcript').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()");
				await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
				await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: -2000 });
				await ui.wait("document.querySelector('.omp-jump-latest')");
				await ui.evaluate("new Promise(r=>setTimeout(r,600))");
				await ui.settleGeometry(".omp-transcript");
				assert.equal(await ui.evaluate(atTail), false, "scrolled away from the tail");
			};
			let next = 14;
			for (const { kind, working, button } of [{ kind: "prompt", working: false, button: "Send message" }, { kind: "steer", working: true, button: "Steer the running turn" }, { kind: "follow-up", working: true, button: "Queue follow-up" }]) {
				await ui.evaluate(`window.ui.push({working:${working},settled:${!working}})`);
				await detach();
				// New output alone leaves the reader where they are.
				const held = await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollTop");
				await ui.evaluate(`window.hist=[...window.hist,window.mk(${next}),window.mk(${next + 1})];window.ui.push({entries:window.hist,durableCount:window.hist.length})`);
				await ui.evaluate("new Promise(r=>setTimeout(r,400))");
				assert.ok(Math.abs(await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollTop") - held) <= 1, "output arriving while detached keeps the reading position");
				assert.equal(await ui.evaluate("Boolean(document.querySelector('.omp-jump-latest'))"), true);
				next += 2;
				const sends = await ui.evaluate<number>("window.ui.sends().length");
				await ui.evaluate("window.composer.focus()");
				await ui.call("Input.insertText", { text: `Typed while scrolled up ${kind}` });
				await ui.evaluate(`document.querySelector('button[aria-label="${button}"]').click()`);
				await ui.wait(`window.ui.sends().length===${sends + 1}`);
				await ui.wait("!document.querySelector('.omp-jump-latest')");
				// The reply to it arrives after the send: the view follows it.
				await ui.evaluate(`window.hist=[...window.hist,${JSON.stringify({ type: "message", id: `mine${next}`, parentId: null, timestamp: new Date(1000).toISOString(), message: { role: "user", timestamp: 2000 + next, content: `Typed while scrolled up ${kind}` } })},window.mk(${next + 1})];window.ui.push({entries:window.hist,durableCount:window.hist.length})`);
				await ui.settleGeometry(".omp-transcript");
				assert.equal(await ui.evaluate(atTail), true, `${kind}: back at the tail`);
				assert.equal(await ui.evaluate("Boolean(document.querySelector('.omp-jump-latest'))"), false);
				assert.equal(await ui.evaluate(visible(`Typed while scrolled up ${kind}`)), true, `${kind}: the user's own message is on screen`);
				assert.equal(await ui.evaluate(visible(`Reply ${next + 1}`)), true, "the reply is on screen");
				next += 2;
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

		await t.test("an agent:// URL in a reply, in code and as a link destination is a link only once the host proves this session has the agent, and a click posts a plain open request", async () => {
			await reset("chat-internal-links");
			const prose = "The review is in agent://DocsReview and `agent://Parent.Child`, see [the report](agent://DocsReview/reports/0), not agent://Missing or `agent://Missing`.";
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.ui.push({entries:[
			  row('assistant',{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:${JSON.stringify(`${prose}\n\n\`\`\`\nagent://DocsReview in a fence\n\`\`\``)}}]}),
			 ],durableCount:1,working:false,settled:true});
			 // The host's answers: the session has these two agents and nothing else.
			 const proven=['agent://DocsReview','agent://Parent.Child'];
			 window.answered=new Set();
			 window.answerLinks=setInterval(()=>{for(const message of window.sent){
			  if(message.type!=='omp:terminal-link-validate'||window.answered.has(message.requestId))continue;
			  window.answered.add(message.requestId);
			  window.ui.receive({type:'omp:terminal-link-validation',requestId:message.requestId,valid:proven.includes(message.target)});
			 }},5);
			})()`);
			await ui.wait("document.querySelectorAll('.omp-internal-link').length>=3");
			const facts = await ui.evaluate<{ targets: string[]; texts: string[]; inCode: number; reply: string; fenced: number; focusable: boolean; missingAsked: boolean; missingLinked: boolean; fileAsked: boolean; menu: boolean }>(`(()=>{
			 const links=[...document.querySelectorAll('.omp-internal-link')];
			 const reply=document.querySelector('.omp-md');
			 return {targets:links.map(link=>link.dataset.internalTarget),texts:links.map(link=>link.textContent),inCode:reply.querySelectorAll('code .omp-internal-link').length,
			  reply:reply.querySelector('p').textContent,fenced:reply.querySelectorAll('pre .omp-internal-link').length,focusable:links.every(link=>link.tabIndex===0&&link.getAttribute('role')==='link'),
			  missingAsked:window.sent.some(message=>message.type==='omp:terminal-link-validate'&&message.target==='agent://Missing'),
			  missingLinked:links.some(link=>link.textContent.includes('Missing')),
			  fileAsked:window.sent.some(message=>message.type==='omp:terminal-link-validate'&&message.target.startsWith('agent://')&&message.target!==message.target.trim()),
			  menu:links.some(link=>link.hasAttribute('data-vscode-context'))};
			})()`);
			assert.deepEqual(facts.targets, ["agent://DocsReview", "agent://Parent.Child", "agent://DocsReview"], "the JSON path of a destination is not part of what opens");
			assert.deepEqual(facts.texts, ["agent://DocsReview", "agent://Parent.Child", "the report"]);
			assert.equal(facts.inCode, 1, "a code span is one link inside the code element");
			assert.equal(facts.reply, prose.replace("[the report](agent://DocsReview/reports/0)", "the report").replaceAll("`", ""), "link detection never alters the rendered text");
			assert.equal(facts.fenced, 0, "fenced code stays text");
			assert.ok(facts.focusable, "links are keyboard reachable");
			assert.ok(facts.missingAsked && !facts.missingLinked, "an agent the host does not know stays text, in prose and in code");
			assert.equal(facts.menu, false, "no file menu: there is no path");
			const opens = () => ui.evaluate<Record<string, unknown>[]>("window.sent.filter(message=>message.type==='omp:terminal-link-open').map(({requestId,...rest})=>rest)");
			assert.deepEqual(await opens(), [], "validation alone never opens anything");
			await ui.evaluate("document.querySelector('[data-internal-target=\"agent://Parent.Child\"]').click()");
			assert.deepEqual(await opens(), [{ type: "omp:terminal-link-open", target: "agent://Parent.Child" }], "a plain click posts the open request for the canonical URL, naming no folder");
			await ui.evaluate("document.querySelector('[data-internal-target=\"agent://DocsReview\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
			assert.deepEqual((await opens()).at(-1), { type: "omp:terminal-link-open", target: "agent://DocsReview" }, "Enter activates a focused link");
			await ui.evaluate("document.querySelector('[data-internal-target=\"agent://Parent.Child\"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:true,shiftKey:true}))");
			assert.deepEqual((await opens()).at(-1), { type: "omp:terminal-link-open", target: "agent://Parent.Child", action: "os" }, "Ctrl+Shift+Click asks to show the file behind the link");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
			await ui.evaluate("clearInterval(window.answerLinks)");
		});

		await t.test("a commit hash in an assistant reply, in code and in prose, is a link only once the host proves it is the commit HEAD points at, and a HEAD move re-asks only the commit spans; a click posts a plain open request, and a symbol lookup is made only for a span that is no commit", async () => {
			await reset("chat-commit-links");
			const prose = "Fixed in `c7398070` and a1b2c3d4e5 and `BadFace1`, not `FaceBead1`, `1234567` or deadbeef-rc.";
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.ui.push({entries:[
			  row('user',{role:'user',timestamp:1,content:'Is c7398070 in the log?'}),
			  row('assistant',{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:${JSON.stringify(`${prose}\n\n\`\`\`\nc7398070 in a fence\n\`\`\``)}}]}),
			 ],durableCount:2,working:false,settled:true});
			 // The host's answers: these three commits are the HEAD of the session's repository in turn (a stand-in for the host's proof) and nothing else is one; no symbol is known.
			 window.proven=['commit://c7398070','commit://a1b2c3d4e5','commit://badface1'];
			 window.answered=new Set();
			 window.symbolsAsked=[];
			 window.answerLinks=setInterval(()=>{for(const message of window.sent){
			  if(window.answered.has(message.requestId)&&message.type!=='omp:terminal-link-symbols')continue;
			  if(message.type==='omp:terminal-link-validate'){
			   window.answered.add(message.requestId);
			   window.ui.receive({type:'omp:terminal-link-validation',requestId:message.requestId,valid:window.proven.includes(message.target)});
			  }else if(message.type==='omp:terminal-link-symbols'&&!window.answered.has('s'+message.requestId)){
			   window.answered.add('s'+message.requestId);
			   window.symbolsAsked.push(...message.tokens);
			   window.ui.receive({type:'omp:terminal-link-symbol-resolution',requestId:message.requestId,results:message.tokens.map(token=>({token,status:'none'}))});
			   document.dispatchEvent(new Event('fixture-post'));
			  }
			 }},5);
			})()`);
			await ui.wait("document.querySelectorAll('.omp-commit-link').length>=3 && window.symbolsAsked.includes('FaceBead1')");
			const facts = await ui.evaluate<{ targets: string[]; texts: string[]; inCode: number; reply: string; user: number; fenced: number; focusable: boolean; asked: string[]; symbols: string[]; menu: boolean }>(`(()=>{
			 const links=[...document.querySelectorAll('.omp-commit-link')];
			 const reply=[...document.querySelectorAll('.omp-md')].find(node=>node.textContent.startsWith('Fixed in'));
			 const user=[...document.querySelectorAll('.omp-md')].find(node=>node.textContent.startsWith('Is c73'));
			 return {targets:links.map(link=>link.dataset.commitTarget),texts:links.map(link=>link.textContent),inCode:reply.querySelectorAll('code .omp-commit-link').length,
			  reply:reply.querySelector('p').textContent,user:user.querySelectorAll('.omp-commit-link').length,fenced:reply.querySelectorAll('pre .omp-commit-link').length,
			  focusable:links.every(link=>link.tabIndex===0&&link.getAttribute('role')==='link'),
			  asked:window.sent.filter(message=>message.type==='omp:terminal-link-validate'&&message.target.startsWith('commit://')).map(message=>message.target),
			  symbols:window.symbolsAsked,menu:links.some(link=>link.hasAttribute('data-vscode-context'))};
			})()`);
			assert.deepEqual(facts.targets, ["commit://c7398070", "commit://a1b2c3d4e5", "commit://badface1"]);
			assert.deepEqual(facts.texts, ["c7398070", "a1b2c3d4e5", "BadFace1"]);
			assert.equal(facts.inCode, 2, "a code span is one link inside the code element");
			assert.equal(facts.reply, prose.replaceAll("`", ""), "link detection never alters the rendered text");
			assert.equal(facts.user, 0, "the user's own text is never linked");
			assert.equal(facts.fenced, 0, "fenced code stays text");
			assert.ok(facts.focusable, "links are keyboard reachable");
			assert.ok(["commit://facebead1", "commit://1234567"].every(target => facts.asked.includes(target)), "an unknown candidate in code is asked about, and stays text");
			assert.ok(!facts.asked.includes("commit://deadbeef") && !facts.asked.some(target => target.includes("rc")), "prose that is not a hash is never asked");
			assert.ok(facts.symbols.includes("FaceBead1") && !facts.symbols.includes("c7398070") && !facts.symbols.includes("BadFace1"), "a span the host says is no commit is looked up as a symbol; a real commit is not, even when it reads as one");
			assert.equal(facts.menu, false, "no file menu: there is no path");
			const opens = () => ui.evaluate<Record<string, unknown>[]>("window.sent.filter(message=>message.type==='omp:terminal-link-open').map(({requestId,...rest})=>rest)");
			assert.deepEqual(await opens(), [], "validation alone never opens anything");
			await ui.evaluate("document.querySelector('[data-commit-target=\"commit://c7398070\"]').click()");
			assert.deepEqual(await opens(), [{ type: "omp:terminal-link-open", target: "commit://c7398070" }], "a plain click posts the open request for the canonical target, naming no folder");
			await ui.evaluate("document.querySelector('[data-commit-target=\"commit://a1b2c3d4e5\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
			assert.deepEqual((await opens()).at(-1), { type: "omp:terminal-link-open", target: "commit://a1b2c3d4e5" }, "Enter activates a focused link");
			// HEAD moves: the host says so, and only the commit spans ask again. The link of the old HEAD turns back into text and the span of the new HEAD becomes a link.
			const linked = () => ui.evaluate<string>("[...document.querySelectorAll('.omp-commit-link')].map(link=>link.dataset.commitTarget).join()");
			const sentBefore = await ui.evaluate<number>("window.sent.length");
			await ui.evaluate("window.proven=['commit://a1b2c3d4e5'];window.ui.receive({type:'omp:terminal-link-commits-changed'})");
			await ui.wait("[...document.querySelectorAll('.omp-commit-link')].map(link=>link.dataset.commitTarget).join()==='commit://a1b2c3d4e5'");
			assert.equal(await linked(), "commit://a1b2c3d4e5", "the old HEAD's link is text again");
			const reasked = await ui.evaluate<string[]>(`window.sent.slice(${sentBefore}).map(message=>message.type+' '+(message.target??''))`);
			assert.ok(reasked.length > 0 && reasked.every(entry => entry.startsWith("omp:terminal-link-validate commit://") || entry.startsWith("omp:terminal-link-symbols ")), `a HEAD move asks only commit spans, never a file (${reasked.join(", ")})`);
			await ui.evaluate("window.proven=['commit://c7398070'];window.ui.receive({type:'omp:terminal-link-commits-changed'})");
			await ui.wait("[...document.querySelectorAll('.omp-commit-link')].map(link=>link.dataset.commitTarget).join()==='commit://c7398070'");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
			await ui.evaluate("clearInterval(window.answerLinks)");
		});

		await t.test("a skill read is a Skill row with the book icon and the skill name, linked to the real SKILL.md once the result names it, and groups as Loaded N skill", async () => {
			const skillFile = "C:\\Users\\me\\.omp\\skills\\omp-desk-release\\SKILL.md";
			const subFile = "C:\\Users\\me\\.omp\\skills\\omp-desk-release\\scripts\\x.md";
			const entries = (settled: boolean): string => `(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 const call=(id,path)=>({type:'toolCall',id,name:'read',arguments:{path},intent:'Loading the release skill'});
			 const result=(id,text,details)=>row('res-'+id,{role:'toolResult',toolCallId:id,toolName:'read',timestamp:4,isError:false,content:[{type:'text',text}],details});
			 const entries=[
			  row('user',{role:'user',timestamp:1,content:'Release it'}),
			  row('calls',{role:'assistant',model:'m',timestamp:3,stopReason:'toolUse',content:[call('skill-main','skill://omp-desk-release'),call('skill-sub','skill://omp-desk-release/scripts/x.md'),call('skill-pending','skill://brainstorm'),call('file-read','src/a.ts')]}),
			  result('skill-main','[Skill file: '+${JSON.stringify(skillFile)}+']\\n# Release skill\\nStep one',{resolvedPath:${JSON.stringify(skillFile)},contentType:'text/markdown'}),
			  result('skill-sub','[Skill file: '+${JSON.stringify(subFile)}+']\\nsub file text',{}),
			  result('file-read','file text',{}),
			  ...(${settled} ? [result('skill-pending','[Skill file: C:\\\\skills\\\\brainstorm\\\\SKILL.md]\\nbrainstorm text',{})] : []),
			 ];
			 window.ui.push({entries,durableCount:entries.length,working:false,settled:true});
			 window.answered=new Set();
			 window.answerLinks=setInterval(()=>{for(const message of window.sent){
			  if(message.type!=='omp:terminal-link-validate'||window.answered.has(message.requestId))continue;
			  window.answered.add(message.requestId);
			  window.ui.receive({type:'omp:terminal-link-validation',requestId:message.requestId,valid:[${JSON.stringify(skillFile)},${JSON.stringify(subFile)}].includes(message.target)});
			 }},5);
			})()`;
			await reset("skill-read", "detailed");
			await ui.evaluate(entries(false));
			await ui.wait("document.querySelectorAll('[data-tool-call-id=\"skill-main\"] .omp-file-link, [data-tool-call-id=\"skill-sub\"] .omp-file-link').length===2");
			const rowFacts = (id: string): Promise<{ icons: string[]; name: string; digest: string; links: string[]; linkText: string[]; intent: string }> => ui.evaluate(`(()=>{
			 const head=document.querySelector('[data-tool-call-id="${id}"] .omp-tool-head');
			 const links=[...head.querySelectorAll('.omp-file-link')];
			 return {icons:[...head.querySelectorAll(':scope > .codicon')].map(node=>node.className.replace('codicon codicon-','')),name:head.querySelector('.omp-tool-name').textContent,digest:head.querySelector('.omp-tool-digest').textContent,
			  links:links.map(link=>link.dataset.fileTarget),linkText:links.map(link=>link.textContent),intent:head.querySelector('.omp-tool-aux--intent')?.textContent??''}})()`);
			const main = await rowFacts("skill-main");
			assert.ok(main.icons.includes("book") && !main.icons.includes("file"), `the book icon, not the file icon (${main.icons})`);
			assert.deepEqual([main.name, main.digest, main.links, main.linkText], ["Skill", "omp-desk-release", [skillFile], ["omp-desk-release"]]);
			assert.equal(main.intent, "Loading the release skill", "the intent stays as for other tools");
			const sub = await rowFacts("skill-sub");
			assert.deepEqual([sub.name, sub.digest, sub.links], ["Skill", "omp-desk-release / scripts/x.md", [subFile]], "the sub-file opens from the header line when the details name no path");
			const pending = await rowFacts("skill-pending");
			assert.deepEqual([pending.name, pending.digest, pending.links], ["Skill", "brainstorm", []], "no result yet: the name without a link");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"file-read\"] .omp-tool-name').textContent"), "Read", "an ordinary read keeps its title");
			const sentOpen = (): Promise<string[]> => ui.evaluate("window.sent.filter(message=>message.type==='omp:terminal-link-open').map(message=>message.target)");
			assert.deepEqual(await sentOpen(), []);
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"skill-main\"] .omp-file-link').click()");
			assert.deepEqual(await sentOpen(), [skillFile], "a click on the name posts the open request for the SKILL.md path");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"skill-main\"] .omp-tool-head').getAttribute('aria-expanded')"), "false", "the link click does not toggle the row");
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"skill-main\"] .omp-tool-head').click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"skill-main\"] .omp-tool-body')?.textContent.includes('Step one')");
			const body = await ui.evaluate<string>("document.querySelector('[data-tool-call-id=\"skill-main\"] .omp-tool-body').textContent");
			assert.ok(body.includes("Release skill") && !body.includes("[Skill file:"), "the body is the skill text without the metadata line");
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"skill-main\"] .omp-tool-name').textContent"), "Skill", "the expanded head keeps its title");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
			await ui.evaluate("clearInterval(window.answerLinks)");

			await reset("skill-read-overview", "overview");
			await ui.evaluate(entries(true));
			await ui.wait("document.querySelector('.omp-overview-head')");
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-overview-head')].map(node=>node.textContent)"), ["Read 1 file · Loaded 2 skills"]);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
			await ui.evaluate("clearInterval(window.answerLinks)");
		});

		await t.test("typing with nothing editable focused goes into the composer exactly once, while native keys, other fields and an unwritable composer are left alone", async () => {
			await reset("type-to-focus");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.ui.push({entries:[
			  row('user',{role:'user',timestamp:1,content:'Check please'}),
			  row('assistant',{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:'Reply with src/proof.ts:12 inside.'}]}),
			  row('call',{role:'assistant',model:'m',timestamp:3,stopReason:'toolUse',content:[{type:'toolCall',id:'read-1',name:'read',arguments:{path:'src/proof.ts:40-60'}}]}),
			  row('result',{role:'toolResult',toolCallId:'read-1',toolName:'read',timestamp:4,isError:false,content:[{type:'text',text:'forty'}]}),
			 ],durableCount:4,working:false,settled:true});
			 window.answered=new Set();
			 window.answerLinks=setInterval(()=>{for(const message of window.sent){
			  if(message.type!=='omp:terminal-link-validate'||window.answered.has(message.requestId))continue;
			  window.answered.add(message.requestId);
			  window.ui.receive({type:'omp:terminal-link-validation',requestId:message.requestId,valid:true});
			 }},5);
			})()`);
			await ui.wait("document.querySelector('.omp-file-link') && document.querySelector('.omp-reply-copy') && document.querySelector('[data-tool-name=\"read\"] .omp-tool-head')");
			const key = async (name: string, code: string, windowsVirtualKeyCode: number, extra: Record<string, unknown> = {}): Promise<void> => {
				await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: name, code, windowsVirtualKeyCode, ...extra });
				await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode });
			};
			const typeText = async (text: string): Promise<void> => {
				for (const character of text) await key(character, `Key${character.toUpperCase()}`, character.toUpperCase().charCodeAt(0), { text: character });
			};
			const state = (): Promise<{ value: string; composerFocused: boolean }> => ui.evaluate("({value:window.composer.value(),composerFocused:window.composer.focused()})");
			const clearComposer = (): Promise<void> => ui.evaluate("(()=>{window.composer.setText('');window.composer.blur();})()");
			const focusOn = (selector: string): Promise<void> => ui.evaluate(selector === "body" ? "document.activeElement?.blur()" : `document.querySelector(${JSON.stringify(selector)}).focus()`);

			for (const selector of ["body", "[data-tool-name=\"read\"] .omp-tool-head", ".omp-md .omp-file-link", ".omp-reply-copy"]) {
				await clearComposer();
				await focusOn(selector);
				assert.equal((await state()).composerFocused, false, `${selector} holds the focus before typing`);
				await typeText("abc");
				await ui.wait("window.composer.value().length>=3");
				assert.deepEqual(await state(), { value: "abc", composerFocused: true }, `abc typed over ${selector} lands once in the composer`);
			}

			// The caret goes to the end of what the draft already holds.
			await clearComposer();
			await ui.evaluate("(()=>{window.composer.setText('xy');window.composer.select(0,0);window.composer.blur();})()");
			await typeText("z");
			await ui.wait("window.composer.value().length>=3");
			assert.equal((await state()).value, "xyz");

			// Space and Enter keep their native meaning on a focused button; they neither type nor send.
			await clearComposer();
			const head = "[data-tool-name=\"read\"] .omp-tool-head";
			const expanded = (): Promise<string | null> => ui.evaluate(`document.querySelector(${JSON.stringify(head)}).getAttribute('aria-expanded')`);
			await focusOn(head);
			const before = await expanded();
			await key(" ", "Space", 32, { text: " " });
			await ui.wait(`document.querySelector(${JSON.stringify(head)}).getAttribute('aria-expanded')!==${JSON.stringify(before)}`);
			assert.deepEqual(await state(), { value: "", composerFocused: false });
			assert.equal(await ui.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(head)})`), true, "Space leaves the focus on the button it activated");
			const afterSpace = await expanded();
			await key("Enter", "Enter", 13, { text: "\r" });
			await ui.wait(`document.querySelector(${JSON.stringify(head)}).getAttribute('aria-expanded')!==${JSON.stringify(afterSpace)}`);
			assert.equal((await state()).value, "");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-prompt').length"), 0, "Enter on a button sends nothing");

			// Chords, IME and dead keys are not text.
			await focusOn("body");
			await key("k", "KeyK", 75, { modifiers: 2 });
			await key("Process", "KeyK", 229);
			await key("Dead", "Quote", 222);
			await key("ArrowDown", "ArrowDown", 40);
			assert.equal((await state()).composerFocused, false, "chords, IME, dead keys and navigation keep the focus where it is");

			// Another field the user is typing in is untouched.
			await ui.evaluate("(()=>{const probe=document.createElement('input');probe.id='probe';document.body.append(probe);probe.focus();})()");
			await typeText("k");
			assert.equal(await ui.evaluate("document.getElementById('probe').value"), "k");
			assert.equal((await state()).value, "", "an editable target keeps its own typing");
			await ui.evaluate("document.getElementById('probe').remove()");

			// Ctrl+V on a focused non-field pastes into the composer, once.
			await clearComposer();
			await focusOn(head);
			await ui.evaluate("(()=>{const source=document.createElement('textarea');source.value='pasted text';document.body.append(source);source.select();const copied=document.execCommand('copy');source.remove();return copied;})()");
			await ui.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2, commands: ["paste"] });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2 });
			await ui.wait("window.composer.value()==='pasted text'");
			assert.equal((await state()).composerFocused, true);

			// A composer that cannot take text gets nothing, and the focus stays where it was.
			await clearComposer();
			await ui.evaluate("window.ui.push({phase:'resyncing'})");
			await ui.wait("window.composer.disabled()");
			await focusOn(head);
			await typeText("q");
			assert.deepEqual(await state(), { value: "", composerFocused: false });
			assert.equal(await ui.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(head)})`), true);
			await ui.evaluate("window.ui.push({phase:'live'})");
			await ui.wait("!window.composer.disabled()");
			await ui.evaluate("window.ui.receive({type:'omp:draft-request',requestId:900})");
			await ui.wait("window.composer.readOnly()");
			await focusOn(head);
			await typeText("q");
			assert.deepEqual(await state(), { value: "", composerFocused: false }, "a read-only composer is not a typing target");
			await ui.evaluate("window.ui.receive({type:'omp:draft-release',requestId:900})");
			await ui.wait("!window.composer.readOnly()");

			// While an ask replaces the composer there is nothing to type into; the ask keeps its focus.
			await ui.evaluate("window.ui.push({uiRequests:[{id:'type-ask',method:'ask',title:'t',questions:[{id:'only',question:'Proceed?',multi:false,options:[{label:'Yes'},{label:'No'}]}]}],working:true,settled:false})");
			await ui.wait("document.querySelectorAll('.omp-ask-option').length===3 && !window.composer.exists()");
			await ui.evaluate("document.querySelector('.omp-ask-option').focus()");
			await typeText("x");
			assert.equal(await ui.evaluate("document.activeElement===document.querySelector('.omp-ask-option')"), true);
			assert.equal(await ui.evaluate("window.composer.exists()"), false);
			// Its own "Other" field is an editable target and keeps what is typed into it.
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[2].click()");
			await ui.wait("document.querySelector('.omp-ask-custom textarea')");
			await typeText("x");
			await ui.wait("document.querySelector('.omp-ask-custom textarea').value==='x'");
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
			 window.composer.focus()`);
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('second prompt')");
			await press("ArrowUp", "ArrowUp", 38);
			await ui.wait("window.composer.value()==='second prompt'");
			await press("ArrowUp", "ArrowUp", 38);
			await ui.wait("window.composer.value()==='first prompt'");
			await press("ArrowUp", "ArrowUp", 38);
			assert.equal(await draftValue(), "first prompt", "the oldest prompt is the end of the walk");
			await press("ArrowDown", "ArrowDown", 40);
			await ui.wait("window.composer.value()==='second prompt'");
			await press("ArrowDown", "ArrowDown", 40);
			await ui.wait("window.composer.value()===''");
			await ui.call("Input.insertText", { text: "typed draft" });
			await press("ArrowUp", "ArrowUp", 38);
			assert.equal(await draftValue(), "typed draft", "a typed draft is never replaced");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Up and Down leave history while the caret has a visual row to move to: a soft-wrapped prompt is several rows, not one line", async () => {
			await reset("quick-history-wrapped");
			const long = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
			await ui.evaluate(`const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.ui.push({entries:[row('u1',{role:'user',timestamp:1,content:'first prompt'}),row('a1',{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:'ok'}]}),
			  row('u2',{role:'user',timestamp:3,content:${JSON.stringify(long)}}),row('a2',{role:'assistant',model:'m',timestamp:4,stopReason:'stop',content:[{type:'text',text:'ok'}]})],durableCount:4,working:false,settled:true});
			 window.composerBox=window.composer.el();window.composer.focus()`);
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('word59')");
			const caret = (): Promise<number> => ui.evaluate("window.composer.selection().start");
			const setCaret = (at: number): Promise<unknown> => ui.evaluate(`window.composer.select(${at})`);
			await press("ArrowUp", "ArrowUp", 38);
			await ui.wait(`window.composer.value()===${JSON.stringify(long)}`);
			assert.ok(await ui.evaluate<boolean>("window.composerBox.scrollHeight>=window.composerBox.clientHeight&&window.composerBox.scrollHeight>=60"), "the recalled prompt wraps over several rows");
			assert.equal(await caret(), long.length, "the recalled prompt has the caret at its end");
			const middle = Math.floor(long.length / 2);
			await press("ArrowUp", "ArrowUp", 38);
			assert.equal(await draftValue(), long, "Up on the last row moves the caret up a row, not to older history");
			assert.ok((await caret()) < long.length, "the caret moved");
			await setCaret(middle);
			await press("ArrowUp", "ArrowUp", 38);
			assert.equal(await draftValue(), long, "Up in the middle of a wrapped paragraph moves the caret");
			assert.ok((await caret()) < middle, "up one row");
			await setCaret(middle);
			await press("ArrowDown", "ArrowDown", 40);
			assert.equal(await draftValue(), long, "Down in the middle of a wrapped paragraph moves the caret");
			assert.ok((await caret()) > middle, "down one row");
			await setCaret(0);
			await press("ArrowDown", "ArrowDown", 40);
			assert.equal(await draftValue(), long, "Down on the first row of a wrapped paragraph moves the caret");
			assert.ok((await caret()) > 0, "down one row");
			await setCaret(10);
			await press("ArrowUp", "ArrowUp", 38);
			await ui.wait("window.composer.value()==='first prompt'");
			await press("ArrowDown", "ArrowDown", 40);
			await ui.wait(`window.composer.value()===${JSON.stringify(long)}`);
			await press("ArrowDown", "ArrowDown", 40);
			await ui.wait("window.composer.value()===''");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Stop hands the still-queued messages back into the draft, after what is typed, and says when some could not come back", async () => {
			await reset("quick-stop-restore");
			await ui.evaluate("window.ui.push({working:true,settled:false,state:{...window.ui.current().state,isStreaming:true}});window.composer.focus()");
			await ui.wait("document.querySelector('[aria-label=\"Stop the running turn\"]')");
			await ui.call("Input.insertText", { text: "typed" });
			await ui.evaluate("document.querySelector('[aria-label=\"Stop the running turn\"]').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-abort')");
			await ui.evaluate(`const abort=window.sent.find(message=>message.type==='omp:chat-abort');
			 window.ui.receive({type:'omp:chat-abort-result',epoch:window.ui.current().epoch,requestId:abort.requestId,status:'accepted',entries:[{text:'queued steer'},{text:'queued follow-up'}],truncated:true})`);
			await ui.wait("window.composer.value().includes('queued follow-up')");
			const restored = await draftValue();
			assert.ok(restored.startsWith("typed") && restored.indexOf("queued steer") < restored.indexOf("queued follow-up"), restored);
			await ui.wait("document.querySelector('.omp-attach-error')?.textContent.includes('could not hand back every queued message')");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0, "restored messages are not sent");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("extension widgets render at their placement as plain text, and a warning notice is dismissible", async () => {
			await reset("quick-extension-surfaces");
			const frame = (value: Record<string, unknown>) => ui.evaluate(`window.ui.receive({type:'omp:chat-event',epoch:window.ui.current().epoch,frame:${JSON.stringify(value)}})`);
			await frame({ type: "ui_widget", key: "build", lines: ["Build: <b>green</b>", "2 warnings"] });
			await frame({ type: "ui_widget", key: "hint", lines: ["below the editor"], placement: "belowEditor" });
			await ui.wait("document.querySelectorAll('.omp-extension-widget').length===2");
			const placed = await ui.evaluate<{ above: string[]; below: string[]; markup: number; aboveFirst: boolean }>(`(()=>{
			 const above=document.querySelector('.omp-extension-widgets--aboveEditor'),below=document.querySelector('.omp-extension-widgets--belowEditor'),input=window.composer.el();
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
			await frame({ type: "ui_notify", level: "warning", message: "Index rebuilt" });
			await ui.wait("document.querySelector('.omp-extension-notice--warning .omp-extension-notice-text')?.textContent==='Index rebuilt'");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Alt+click on the model or thinking level cycles through the host, and Compact and Shake in the context popover ask the host", async () => {
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
			await ui.evaluate("window.composer.focus();document.querySelector('.omp-context-trigger').focus()");
			await ui.wait("document.querySelector('.omp-context-shake')");
			await ui.evaluate("document.querySelector('.omp-context-shake').click()");
			assert.deepEqual(await commands(), ["cycle-model", "cycle-thinking", "compact", "shake"]);
			await ui.wait("!document.querySelector('.omp-context-popover')");
			await ui.evaluate("window.composer.focus();window.ui.push({working:true,settled:false})");
			await ui.wait("document.querySelector('[aria-label=\"Stop the running turn\"]')");
			await ui.evaluate("document.querySelector('.omp-context-trigger').focus()");
			await ui.wait("document.querySelector('.omp-context-compact')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-context-compact').disabled"), false, "as in the TUI, Compact runs during a turn");
			assert.equal(await ui.evaluate("document.querySelector('.omp-context-compact').title"), "Interrupts the running turn, compacts, then the turn continues");
			await ui.evaluate("window.ui.push({maintenance:{action:'compact',reason:'manual',status:'working'}})");
			await ui.wait("document.querySelector('.omp-context-compact')?.disabled===true");
			assert.equal(await ui.evaluate("document.querySelector('.omp-context-shake').disabled"), true, "one maintenance pass at a time");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a compaction is a divider across the transcript, as in the TUI, and a completed pass adds no status line", async () => {
			await reset("quick-compaction-divider");
			const frame = (value: Record<string, unknown>) => ui.evaluate(`window.ui.receive({type:'omp:chat-event',epoch:window.ui.current().epoch,frame:${JSON.stringify(value)}})`);
			const at = new Date(Date.UTC(2026, 9, 9, 9, 45)).toISOString();
			const entries = [
				{ type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "earlier work" }], timestamp: 1 } },
				{ type: "compaction", id: "c1", parentId: "u1", timestamp: at, summary: "Summary of the earlier work", firstKeptEntryId: "u1", tokensBefore: 400161, tokensAfter: 47758 },
			];
			await ui.evaluate(`window.ui.push(${JSON.stringify({ entries, durableCount: entries.length, leafId: "c1" })})`);
			await frame({ type: "auto_compaction_end", action: "context-full", aborted: false, willRetry: false });
			await ui.wait("document.querySelector('.omp-native-summary--divider summary')");
			const divider = await ui.evaluate<{ text: string; rules: boolean }>(`(()=>{const summary=document.querySelector('.omp-native-summary--divider summary');
			 const rule=pseudo=>getComputedStyle(summary,pseudo).borderTopStyle==='solid';return{text:summary.textContent,rules:rule('::before')&&rule('::after')}})()`);
			assert.deepEqual(divider, { text: "Compacted · 400k → 47.8k tokens", rules: true });
			// A keyboard-focused divider shows the theme's focus ring like every other control in the transcript, not the browser's default one.
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
			await ui.evaluate("document.documentElement.style.setProperty('--vscode-focusBorder','#007fd4')");
			assert.deepEqual(await ui.evaluate(`(()=>{const summary=document.querySelector('.omp-native-summary--divider summary');summary.focus();
			 const probe=document.createElement('i');probe.style.color='var(--vscode-focusBorder, #007fd4)';document.body.append(probe);
			 const style=getComputedStyle(summary),shown={visible:summary.matches(':focus-visible'),style:style.outlineStyle,themed:style.outlineColor===getComputedStyle(probe).color};
			 probe.remove();summary.blur();return shown})()`), { visible: true, style: "solid", themed: true }, "the divider's focus ring is the themed one");
			assert.equal(await ui.evaluate("document.querySelector('.omp-transcript').textContent.includes('complete')"), false, "no 'context-full · complete' line");
			await ui.evaluate("document.querySelector('.omp-native-summary--divider summary').click()");
			await ui.wait("document.querySelector('.omp-native-summary--divider').textContent.includes('Summary of the earlier work')");
			await frame({ type: "auto_compaction_end", action: "context-full", aborted: true, willRetry: false });
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('Context-full maintenance cancelled')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("every compaction path ends as one divider: OMP's report text never shows as command output, a failure is a notice, and no row is empty", async () => {
			const at = new Date(Date.UTC(2026, 9, 9, 9, 45)).toISOString();
			const user = { type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "earlier work" }], timestamp: 1 } };
			const compaction = { type: "compaction", id: "c1", parentId: "u1", timestamp: at, summary: "Summary of the earlier work", firstKeptEntryId: "u1", tokensBefore: 269158, tokensAfter: 58986 };
			const REPORT = "Compaction complete. Tokens: 269158 -> 58986 (saved 210172).";
			const FAILURE = "Compaction failed: Nothing to compact (session too small)";
			const start = async (name: string) => {
				await reset(name);
				await ui.evaluate(`window.ui.push(${JSON.stringify({ entries: [user], durableCount: 1, leafId: "u1" })})`);
			};
			const frame = (value: Record<string, unknown>) => ui.evaluate(`window.ui.receive({type:'omp:chat-event',epoch:window.ui.current().epoch,frame:${JSON.stringify(value)}})`);
			// The session file trails the report: its compaction entry reaches the page as a later reconciled row.
			const entryArrives = () => ui.evaluate(`window.ui.receive({type:'omp:chat-entries',epoch:window.ui.current().epoch,entries:${JSON.stringify([compaction])},leafId:'c1'})`);
			const shown = () => ui.evaluate<{ dividers: string[]; text: string; empty: number; notices: string[] }>(`(()=>{
			 const root=document.querySelector('.omp-transcript');
			 return{dividers:[...root.querySelectorAll('.omp-native-summary--divider summary')].map(summary=>summary.textContent),text:root.textContent,
			  empty:[...root.querySelectorAll('.omp-row')].filter(row=>row.textContent.trim()==='').length,
			  notices:[...root.querySelectorAll('.omp-native-message.omp-warning')].map(notice=>notice.textContent)}})()`);
			const settle = () => ui.evaluate("(()=>{const done=Promise.withResolvers();requestAnimationFrame(()=>requestAnimationFrame(done.resolve));return done.promise})()");
			const oneDivider = async (label: string) => {
				await ui.wait("document.querySelector('.omp-native-summary--divider summary')");
				await settle();
				const view = await shown();
				assert.deepEqual(view.dividers, ["Compacted · 269k → 59k tokens"], `${label}: exactly one divider with the amount`);
				assert.equal(view.text.includes("Command output"), false, `${label}: no command output block`);
				assert.equal(view.text.includes("Compaction complete"), false, `${label}: OMP's report text is not shown`);
				assert.equal(view.empty, 0, `${label}: no empty box`);
			};

			// `/compact` typed in the composer, or the Commands popup's picker answered by the host as the same prompt: OMP emits no maintenance event, only the report after the commit.
			await start("quick-compaction-typed");
			await frame({ type: "command_output", text: REPORT });
			await settle();
			let view = await shown();
			assert.equal(view.text.includes("Command output") || view.text.includes("Compaction complete"), false, "typed: the report is not shown before the entry arrives");
			assert.equal(view.empty, 0, "typed: no empty box before the entry arrives");
			await entryArrives();
			await oneDivider("typed");

			// Context view or popover Compact (`session.maintain`): the host's own progress pair wraps OMP's report.
			await start("quick-compaction-maintain");
			await frame({ type: "auto_compaction_start", action: "snapcompact", reason: "manual" });
			await frame({ type: "command_output", text: REPORT });
			await frame({ type: "auto_compaction_end", action: "snapcompact", aborted: false, willRetry: false });
			await entryArrives();
			await oneDivider("maintain");

			// OMP's own automatic compaction: only the event pair.
			await start("quick-compaction-auto");
			await frame({ type: "auto_compaction_start", action: "context-full", reason: "threshold" });
			await frame({ type: "auto_compaction_end", action: "context-full", aborted: false, willRetry: false });
			await entryArrives();
			await oneDivider("auto");

			// A failure is a short notice in the transcript's notice style, for the typed command and for the host's pass alike, and a shake's own output keeps its block.
			await start("quick-compaction-failed-typed");
			await frame({ type: "command_output", text: FAILURE });
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('Nothing to compact')");
			view = await shown();
			assert.equal(view.text.includes("Command output"), false, "failed typed: not raw command output");
			assert.equal(view.notices.length, 1, "failed typed: one notice");
			assert.match(view.notices[0]!, /Compaction failed.*Nothing to compact \(session too small\)/);
			assert.equal(view.empty, 0);
			await start("quick-compaction-failed-maintain");
			await frame({ type: "auto_compaction_start", action: "soft", reason: "manual" });
			await frame({ type: "command_output", text: FAILURE });
			await frame({ type: "auto_compaction_end", action: "soft", aborted: false, willRetry: false, skipped: true });
			await ui.wait("document.querySelector('.omp-transcript').textContent.includes('Nothing to compact')");
			await settle();
			view = await shown();
			assert.equal(view.text.includes("Command output"), false, "failed maintain: not raw command output");
			assert.equal(view.notices.length, 1, "failed maintain: one notice");
			assert.equal(view.empty, 0, "failed maintain: no empty box");
			await start("quick-shake-output");
			await frame({ type: "auto_compaction_start", action: "shake", reason: "manual" });
			await frame({ type: "command_output", text: "Shook 12 tool results (~7941 tokens freed)." });
			await frame({ type: "auto_compaction_end", action: "shake", aborted: false, willRetry: false });
			await ui.wait("document.querySelector('.omp-command-output')");
			await settle();
			view = await shown();
			assert.match(view.text, /Command output.*Shook 12 tool results/);
			assert.equal(view.empty, 0, "shake: no empty box after a completed pass");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the host's thinking and tool defaults open or close every block once, and a block changed afterwards keeps its own state", async () => {
			await reset("quick-transcript-defaults");
			const prefs = (thinkingExpanded: boolean, toolsExpanded: boolean) => ui.evaluate(`window.ui.receive({type:'omp:chat-display-preferences',epoch:window.ui.current().epoch,toolCallDetail:'overview',accessibilitySupport:false,thinkingExpanded:${thinkingExpanded},toolsMode:'${toolsExpanded ? "all" : "collapsed"}'})`);
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

		await t.test("the tool groups mode opens every group with its calls collapsed, a later group joins it, and Ctrl+O and a manual toggle still work from it", async () => {
			await reset("quick-tool-groups-mode");
			// Two open groups with six expanded calls are taller than the default window: the transcript mounts only what is near the viewport, so the test gives it room.
			const window0 = await ui.evaluate<{ width: number; height: number }>("({width:innerWidth,height:innerHeight})");
			await ui.call("Emulation.setDeviceMetricsOverride", { width: window0.width, height: 1400, deviceScaleFactor: 1, mobile: false });
			const mode = (toolsMode: "collapsed" | "groups" | "all") => ui.evaluate(`window.ui.receive({type:'omp:chat-display-preferences',epoch:window.ui.current().epoch,toolCallDetail:'overview',accessibilitySupport:false,thinkingExpanded:false,toolsMode:'${toolsMode}'})`);
			const turn = (n: number) => `[row('u${n}',{role:'user',timestamp:${n * 10},content:'Turn ${n}'}),
			  row('a${n}',{role:'assistant',model:'m',timestamp:${n * 10 + 1},stopReason:'toolUse',content:[{type:'toolCall',id:'edit-${n}',name:'edit',arguments:{path:'src/a${n}.ts'}},{type:'toolCall',id:'bash-${n}',name:'bash',arguments:{command:'echo ${n}'}},{type:'toolCall',id:'read-${n}',name:'read',arguments:{path:'src/b${n}.ts'}}]}),
			  row('re${n}',{role:'toolResult',toolCallId:'edit-${n}',toolName:'edit',timestamp:${n * 10 + 2},isError:false,content:[{type:'text',text:'Updated src/a${n}.ts'}],details:{diff:'+1 new'}}),
			  row('rb${n}',{role:'toolResult',toolCallId:'bash-${n}',toolName:'bash',timestamp:${n * 10 + 3},isError:false,content:[{type:'text',text:'${n}'}]}),
			  row('rr${n}',{role:'toolResult',toolCallId:'read-${n}',toolName:'read',timestamp:${n * 10 + 4},isError:false,content:[{type:'text',text:'file body ${n}'}]}),
			  row('z${n}',{role:'assistant',model:'m',timestamp:${n * 10 + 5},stopReason:'stop',content:[{type:'text',text:'Done ${n}'}]})]`;
			const push = (turns: number[]) => ui.evaluate(`(()=>{const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.ui.push({entries:[${turns.map(turn).join(",")}].flat(),durableCount:${turns.length * 6},working:false,settled:true})})()`);
			const facts = () => ui.evaluate<{ groups: string[]; calls: string[]; texts: string[] }>(`({groups:[...document.querySelectorAll('.omp-overview-head')].map(head=>head.getAttribute('aria-expanded')),
			 calls:[...document.querySelectorAll('.omp-overview-member .omp-tool-head')].map(head=>head.getAttribute('aria-expanded')),texts:[...document.querySelectorAll('.omp-overview-member .omp-tool-head')].map(head=>head.textContent)})`);
			await push([1]);
			await ui.wait("document.querySelector('.omp-overview-head')");
			assert.deepEqual(await facts(), { groups: ["false"], calls: [], texts: [] }, "collapsed: the group is closed");
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-overview-head').textContent"), /Edited 1 file · Ran 1 command · Read 1 file/);

			await mode("groups");
			await ui.wait("document.querySelectorAll('.omp-overview-member .omp-tool-head').length===3");
			const opened = await facts();
			assert.deepEqual(opened.groups, ["true"], "the group is open");
			assert.deepEqual(opened.calls, ["false", "false", "false"], "every call inside is one collapsed line");
			assert.match(opened.texts.join("|"), /Edit.*a1\.ts.*\|.*Bash.*echo 1.*\|.*Read.*b1\.ts/s);
			assert.equal(await ui.evaluate("document.querySelector('.omp-tool-body')"), null, "no call shows its body");

			await push([1, 2]);
			await ui.wait("document.querySelectorAll('.omp-overview-member .omp-tool-head').length===6");
			if (process.env.OMP_UI_SCREENSHOT_DIR) {
				const dark = { "editor-background": "#1f1f1f", "editor-foreground": "#cccccc", foreground: "#cccccc", "editorWidget-background": "#202020", "panel-border": "#2b2b2b", "widget-border": "#313131", "input-background": "#313131", "button-background": "#0078d4", descriptionForeground: "#9d9d9d", "font-family": "'Segoe UI', sans-serif" };
				await ui.evaluate(`document.body.className='vscode-dark';document.body.setAttribute('data-vscode-theme-id','Dark Modern');${Object.entries(dark).map(([name, value]) => `document.documentElement.style.setProperty('--vscode-${name}',${JSON.stringify(value)})`).join(";")}`);
				await ui.call("Emulation.setDeviceMetricsOverride", { width: 760, height: 900, deviceScaleFactor: 2, mobile: false });
				await ui.settleGeometry(".omp-transcript");
				const image = await ui.call("Page.captureScreenshot", { format: "png" });
				await mkdir(process.env.OMP_UI_SCREENSHOT_DIR, { recursive: true });
				await writeFile(join(process.env.OMP_UI_SCREENSHOT_DIR, "tool-groups-mode.png"), Buffer.from(String(image.data), "base64"));
				await ui.call("Emulation.clearDeviceMetricsOverride");
				await ui.evaluate(`document.body.className='';document.body.removeAttribute('data-vscode-theme-id');${Object.keys(dark).map(name => `document.documentElement.style.removeProperty('--vscode-${name}')`).join(";")}`);
			}
			assert.deepEqual(await facts(), { groups: ["true", "true"], calls: Array(6).fill("false"), texts: (await facts()).texts }, "a group that arrives later renders open with collapsed calls");

			await ui.evaluate("document.querySelector('[data-tool-call-id=\"read-2\"] .omp-tool-head').click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"read-2\"] .omp-tool-head').getAttribute('aria-expanded')==='true'");
			assert.deepEqual((await facts()).calls, ["false", "false", "false", "false", "false", "true"], "a call opened by hand opens alone");
			await ui.evaluate("document.querySelectorAll('.omp-overview-head')[0].click()");
			await ui.wait("document.querySelectorAll('.omp-overview-member .omp-tool-head').length===3");
			assert.deepEqual((await facts()).groups, ["false", "true"], "a group closed by hand closes alone");
			await ui.evaluate("document.querySelectorAll('.omp-overview-head')[0].click()");
			await ui.wait("document.querySelectorAll('.omp-overview-member .omp-tool-head').length===6");

			await mode("collapsed");
			await ui.wait("!document.querySelector('.omp-overview-member')");
			assert.deepEqual((await facts()).groups, ["false", "false"], "pressing it again collapses everything");
			await mode("groups");
			await ui.wait("document.querySelectorAll('.omp-overview-member .omp-tool-head').length===6");
			assert.deepEqual(await facts(), { groups: ["true", "true"], calls: Array(6).fill("false"), texts: (await facts()).texts }, "the hand-opened call was reset by the key");

			await mode("all");
			await ui.wait("document.querySelectorAll('.omp-overview-member .omp-tool-head[aria-expanded=\"true\"]').length===6");
			assert.ok((await facts()).groups.length > 0 && (await facts()).groups.every(value => value === "true"), "Ctrl+O from groups expands every call and keeps the groups open");
			await mode("groups");
			await ui.wait("document.querySelectorAll('.omp-overview-member .omp-tool-head[aria-expanded=\"false\"]').length===6");
			assert.deepEqual((await facts()).groups, ["true", "true"], "the groups key from all folds the calls and keeps the groups open");
			await mode("all");
			await mode("collapsed");
			await ui.wait("!document.querySelector('.omp-overview-member')");
			assert.deepEqual((await facts()).groups, ["false", "false"], "Ctrl+O from all collapses everything");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
			await ui.call("Emulation.setDeviceMetricsOverride", { ...window0, deviceScaleFactor: 1, mobile: false });
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
			const closed = async (): Promise<void> => {
				await settleFrames();
				assert.equal(await ui.evaluate("document.querySelector('.omp-rewind-bar--picking')"), null);
			};
			await ui.evaluate("window.composer.focus()");
			await press("Escape", "Escape", 27);
			await closed();
			await ui.call("Input.insertText", { text: "x" });
			await press("Escape", "Escape", 27);
			await press("Escape", "Escape", 27);
			await closed();
			assert.equal(await draftValue(), "x", "a draft is never replaced by Rewind");
			await press("Backspace", "Backspace", 8);
			await ui.wait("window.composer.value()===''");
			await press("Escape", "Escape", 27);
			await press("Escape", "Escape", 27);
			await ui.wait(`document.querySelector('.omp-rewind-bar--picking') && ${barFocused}`);
			assert.equal(await pickedPreview(), "fix the parser", "picking starts at the newest prompt");
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-rewind-bar--picking')");
			for (const command of ["/rewind", "/branch"]) {
				await ui.evaluate("window.composer.focus()");
				await ui.call("Input.insertText", { text: command });
				await ui.evaluate("document.querySelector('[aria-label=\"Send message\"]').click()");
				await ui.wait(`document.querySelector('.omp-rewind-bar--picking') && ${barFocused}`);
				assert.equal(await draftValue(), "", `${command} is consumed`);
				assert.equal(await pickedPreview(), "fix the parser");
				await press("Escape", "Escape", 27);
				await ui.wait("!document.querySelector('.omp-rewind-bar--picking')");
			}
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0, "neither command reaches OMP");
			await ui.evaluate("window.composer.focus()");
			await ui.call("Input.insertText", { text: "/branch foo" });
			await ui.evaluate("document.querySelector('[aria-label=\"Send message\"]').click()");
			await ui.wait(`document.querySelector('.omp-dock').innerText.includes(${JSON.stringify(REWIND_ARGUMENTS_SENTENCE)})`);
			assert.equal(await draftValue(), "/branch foo", "with arguments it is not Rewind: the page refuses it and keeps the draft");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0);
			await closed();
			assert.deepEqual(await navigations(), []);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the host's open-rewind action opens the picker a typed /branch opens, and says the same when the conversation has no earlier message", async () => {
			await reset("rewind-host-action");
			await pushRewind();
			await ui.wait("document.querySelectorAll('[aria-label=\"Rewind to here\"]').length===2");
			await ui.evaluate("window.ui.receive({type:'omp:webview-action',action:'open-rewind'})");
			await ui.wait(`document.querySelector('.omp-rewind-bar--picking') && ${barFocused}`);
			assert.equal(await pickedPreview(), "fix the parser", "picking starts at the newest prompt, as for a typed /branch");
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-rewind-bar--picking')");
			const noEarlierMessage = "There is no earlier message in this conversation to rewind to.";
			const notice = (): Promise<string | null> => ui.evaluate("document.querySelector('.omp-rewind-bar--notice > span')?.textContent ?? null");
			await pushRewind({ entries: [], durableCount: 0, leafId: null });
			await ui.wait("document.querySelectorAll('[aria-label=\"Rewind to here\"]').length===0");
			await ui.evaluate("window.ui.receive({type:'omp:webview-action',action:'open-rewind'})");
			await ui.wait("document.querySelector('.omp-rewind-bar--notice')");
			assert.equal(await notice(), noEarlierMessage);
			assert.equal(await ui.evaluate("document.querySelector('.omp-rewind-bar--picking')"), null);
			await ui.evaluate("document.querySelector('[aria-label=\"Dismiss rewind notice\"]').click()");
			await ui.wait("!document.querySelector('.omp-rewind-bar')");
			await ui.evaluate("window.composer.focus()");
			await ui.call("Input.insertText", { text: "/branch" });
			await ui.evaluate("document.querySelector('[aria-label=\"Send message\"]').click()");
			await ui.wait("document.querySelector('.omp-rewind-bar--notice')");
			assert.equal(await notice(), noEarlierMessage, "a typed /branch says the same");
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0, "neither route reaches OMP");
			assert.deepEqual(await navigations(), []);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Esc Esc with the focus on the page around the composer opens Rewind; one Esc, a draft, a working session, an open popup or a focused input do not", async () => {
			await reset("rewind-page-escape");
			await pushRewind();
			await ui.wait("document.querySelectorAll('[aria-label=\"Rewind to here\"]').length===2");
			const onTranscript = async (): Promise<void> => {
				await ui.evaluate("(()=>{const t=document.querySelector('.omp-transcript');t.setAttribute('tabindex','-1');t.focus()})()");
				assert.equal(await ui.evaluate("document.activeElement===document.querySelector('.omp-transcript')"), true);
			};
			const closed = async (): Promise<void> => {
				await settleFrames();
				assert.equal(await ui.evaluate("document.querySelector('.omp-rewind-bar--picking')"), null);
			};
			await onTranscript();
			await press("Escape", "Escape", 27);
			await closed();
			// The pair window runs in real time; wait it out so the lone Escape above is not the first of the pair.
			await new Promise(resolve => setTimeout(resolve, 650));
			await onTranscript();
			await press("Escape", "Escape", 27);
			await press("Escape", "Escape", 27);
			await ui.wait(`document.querySelector('.omp-rewind-bar--picking') && ${barFocused}`);
			assert.equal(await pickedPreview(), "fix the parser", "picking starts at the newest prompt");
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-rewind-bar--picking')");
			// Focus on the page body, with nothing focused.
			await ui.evaluate("document.activeElement.blur()");
			await press("Escape", "Escape", 27);
			await press("Escape", "Escape", 27);
			await ui.wait("document.querySelector('.omp-rewind-bar--picking')");
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-rewind-bar--picking')");
			// A draft is never replaced by Rewind.
			await ui.evaluate("window.composer.focus()");
			await ui.call("Input.insertText", { text: "x" });
			await onTranscript();
			await press("Escape", "Escape", 27);
			await press("Escape", "Escape", 27);
			await closed();
			assert.equal(await draftValue(), "x");
			await ui.evaluate("window.composer.focus()");
			await press("Backspace", "Backspace", 8);
			await ui.wait("window.composer.value()===''");
			// Another editable field keeps its own Escape and is not counted.
			await ui.evaluate("(()=>{const i=document.createElement('input');i.id='probe-field';document.body.append(i);i.focus()})()");
			await press("Escape", "Escape", 27);
			await press("Escape", "Escape", 27);
			await closed();
			await ui.evaluate("document.getElementById('probe-field').remove()");
			// A working session: Escape belongs to Stop.
			await pushRewind({ working: true });
			await onTranscript();
			await press("Escape", "Escape", 27);
			await press("Escape", "Escape", 27);
			await closed();
			await pushRewind({ working: false });
			// An open popup takes the Escape first.
			await ui.evaluate("document.querySelector('.omp-context-trigger').click()");
			await ui.wait("document.querySelector('.omp-context-popover')");
			await onTranscript();
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-context-popover')");
			await closed();
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-abort').length"), 0);
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
			await ui.wait("window.composer.value()==='fix the parser' && !document.querySelector('.omp-rewind-bar')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-attach-error')"), null, "an empty composer has nothing to keep");
			// OMP's rewound branch: the target's parent, then the marker, which is the leaf.
			const marker = { type: "custom", id: "m1", parentId: "a1", timestamp: rewindAt(9), customType: "omp-desk/navigation",
				data: { v: 1, requestId: "0123456789abcdef0123456789abcdef", kind: "rewind", from: "a2", target: "u2", to: "a1", summarized: false } };
			await pushRewind({ entries: [...rewindRows.slice(0, 2), marker], durableCount: 3, leafId: "m1" });
			await ui.wait("document.querySelector('.omp-rewind-bar--undo')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-rewind-bar--undo').textContent"), "RewoundUndo");
			// A prompt sent from here moves the conversation on: the bar goes at once, not when the turn is saved.
			await pushRewind({ entries: [...rewindRows.slice(0, 2), marker], durableCount: 3, leafId: "m1", working: true });
			await ui.wait("!document.querySelector('.omp-rewind-bar--undo')");
			await pushRewind({ entries: [...rewindRows.slice(0, 2), marker], durableCount: 3, leafId: "m1" });
			await ui.wait("document.querySelector('.omp-rewind-bar--undo')");
			await ui.evaluate("[...document.querySelectorAll('.omp-rewind-bar--undo button')].find(button=>button.textContent==='Undo').click()");
			await ui.wait("window.sent.filter(message=>message.type==='omp:chat-navigate').length===2");
			assert.deepEqual((await navigations())[1], { ...(await navigations())[1]!, kind: "undo", targetId: "a2", expectedLeafId: "m1", summarize: false });
			await ui.wait("document.querySelector('.omp-rewind-bar[role=status]')?.textContent==='Undoing the rewind…'");
			await answerNavigation({ status: "done", kind: "undo", summarized: false });
			await ui.wait("window.composer.value()===''");
			// Back on the original branch, with a draft of the user's own.
			await pushRewind();
			await ui.wait("!document.querySelector('.omp-rewind-bar') && document.querySelectorAll('[aria-label=\"Rewind to here\"]').length===2");
			await ui.evaluate("window.composer.focus()");
			await ui.call("Input.insertText", { text: "my own draft" });
			await startFromRow(0);
			await press("Enter", "Enter", 13);
			await ui.wait("window.sent.filter(message=>message.type==='omp:chat-navigate').length===3");
			assert.deepEqual((await navigations())[2], { ...(await navigations())[2]!, kind: "rewind", targetId: "u1", expectedLeafId: "a2", summarize: false });
			await answerNavigation({ status: "done", kind: "rewind", summarized: false, draft: { text: "first prompt\nwith a second line", images: [], unavailableImages: 0 } });
			await ui.wait("window.composer.value()==='first prompt\\nwith a second line'");
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
			await ui.evaluate("window.composer.focus()");
			await press("Escape", "Escape", 27);
			await press("Escape", "Escape", 27);
			await ui.wait(`document.querySelector('.omp-rewind-bar--picking') && ${barFocused}`);
			assert.equal(await ui.evaluate("document.querySelector('.omp-rewind-blocked')"), null);
			await pushRewind({ branches, working: true, settled: false });
			const busy = NAVIGATE_REFUSAL_SENTENCES.busy;
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
			await ui.evaluate("window.composer.focus()");
			await press("Escape", "Escape", 27);
			await press("Escape", "Escape", 27);
			await settleFrames();
			assert.equal(await ui.evaluate("document.querySelector('.omp-rewind-bar--picking')"), null);
			// A chat process started without the navigate command: picking explains, nothing is offered.
			await pushRewind({ branches, commands: [] });
			await ui.wait("document.querySelectorAll('[aria-label=\"Rewind to here\"]').length===0 && !document.querySelector('[aria-label=\"Stop the running turn\"]')");
			await ui.evaluate("window.composer.focus()");
			await press("Escape", "Escape", 27);
			await press("Escape", "Escape", 27);
			const unsupported = NAVIGATE_REFUSAL_SENTENCES["restart-needed"];
			await ui.wait(`document.querySelector('.omp-rewind-blocked')?.textContent===${JSON.stringify(unsupported)}`);
			assert.deepEqual(await offered(), ["Cancel"]);
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-rewind-bar--picking')");
			assert.equal((await navigations()).length, 1);
			assert.equal(await ui.evaluate("window.ui.sends().length"), 0);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("an empty chat names the folder and model, shows the key hints, lists the folder's recent sessions and opens one by the answer's id and ordinal; a short answer is asked again, a full one is not", async () => {
			await reset("empty-state");
			await ui.evaluate("window.ui.push({header:{id:'empty-h',cwd:'D:/work/alpha-desk/',timestamp:'2026-10-13T10:00:00.000Z'},entries:[],durableCount:0,working:false,settled:true})");
			await ui.wait("document.querySelector('.omp-empty-state') && window.sent.some(message=>message.type==='omp:recent-sessions-request')");
			const start = await ui.evaluate<{ head: string; keys: string[]; recents: number }>("({head:document.querySelector('.omp-empty-head').textContent,keys:[...document.querySelectorAll('.omp-empty-key kbd')].map(node=>node.textContent),recents:document.querySelectorAll('.omp-empty-recent button').length})");
			assert.match(start.head, /alpha-desk/);
			assert.match(start.head, /Original · low/);
			assert.deepEqual(start.keys, EMPTY_STATE_KBDS);
			assert.equal(start.recents, 0, "hints alone until the host answers");
			// Answers the latest request in one step, so a timer cannot slip a newer request between reading its id and replying.
			const answer = (items: string, offset = 0) => ui.evaluate<number>(`(()=>{const request=window.sent.filter(message=>message.type==='omp:recent-sessions-request').at(-1);window.ui.receive({type:'omp:recent-sessions',requestId:request.requestId+${offset},items:${items}});return request.requestId})()`);
			const hours = (count: number) => `Date.now()-${count}*3600000`;
			await answer(`[{title:'Stale',updatedAt:${hours(1)}}]`, 1000);
			await settleFrames();
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-empty-recent button').length"), 0, "an answer to another request is dropped");
			const first = await answer(`[{title:'Replace the whitespace split in the tokenizer',updatedAt:${hours(2)}},{title:'How does the parser work?',updatedAt:${hours(24)}}]`);
			await ui.wait("document.querySelectorAll('.omp-empty-recent button').length===2");
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-empty-recent button')].map(row=>[row.querySelector('.omp-empty-recent-title').textContent,row.querySelector('.omp-empty-recent-age').textContent])"), [["Replace the whitespace split in the tokenizer", "2h"], ["How does the parser work?", "1d"]]);
			// The rows take the click: nothing of the centred frame is above them.
			assert.equal(await ui.evaluate("(()=>{const button=document.querySelector('.omp-empty-recent button');button.scrollIntoView({block:'center'});const row=button.getBoundingClientRect();return button.contains(document.elementFromPoint(row.left+row.width/2,row.top+row.height/2))})()"), true, "the row can be scrolled to when the groups take the height, and then takes the click");
			await ui.evaluate("document.querySelector('.omp-empty-recent button').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:open-recent')");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:open-recent').at(-1)"), { type: "omp:open-recent", requestId: first, index: 0 });
			// Two rows are fewer than the list holds: the tree may still be reading, so the page asks again (the fixture's clock holds the 4 s timer).
			const asked = () => ui.evaluate<number>("window.sent.filter(message=>message.type==='omp:recent-sessions-request').length");
			const before = await asked();
			await ui.evaluate("window.fixtureClock.fire(4000)");
			await ui.wait(`window.sent.filter(message=>message.type==='omp:recent-sessions-request').length>${before}`);
			const second = await answer(`[{title:'One',updatedAt:${hours(1)}},{title:'Two',updatedAt:${hours(2)}},{title:'Three',updatedAt:${hours(3)}}]`);
			await ui.wait("document.querySelectorAll('.omp-empty-recent button').length===3");
			await ui.evaluate("document.querySelectorAll('.omp-empty-recent button')[2].click()");
			await ui.wait("window.sent.filter(message=>message.type==='omp:open-recent').length===2");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:open-recent').at(-1)"), { type: "omp:open-recent", requestId: second, index: 2 });
			const full = await asked();
			await ui.evaluate("window.fixtureClock.fire(4000)");
			await settleFrames();
			assert.equal(await asked(), full, "a full answer is not asked for again");
			// Once the conversation has content the empty state is gone, and the italic line was never the only thing there.
			await ui.evaluate("window.ui.thinking([{type:'text',text:'Hello'}])");
			await ui.wait("!document.querySelector('.omp-empty-state')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a new session whose only entries are not rendered (model and thinking setup, memory recall, a hidden notice, a title change) still shows the empty state, and the first user message removes it", async () => {
			await reset("empty-state-hidden-entries");
			const stamp = "2026-10-13T10:00:00.000Z";
			await ui.evaluate(`window.setupEntries=[
			 {type:'model_change',id:'m0',parentId:null,timestamp:'${stamp}',model:'anthropic/claude-opus-5-5'},
			 {type:'thinking_level_change',id:'t0',parentId:'m0',timestamp:'${stamp}',thinkingLevel:'medium',configured:null},
			 {type:'title_change',id:'tc0',parentId:'t0',timestamp:'${stamp}',title:'New session',source:'user'},
			 {type:'custom',id:'mr0',parentId:'tc0',timestamp:'${stamp}',customType:'memory_recall',data:{version:1}},
			 {type:'custom_message',id:'xd0',parentId:'mr0',timestamp:'${stamp}',customType:'xdev-mount-notice',display:false,content:'<system-notice>xd:// device inventory changed.</system-notice>'}
			];
			window.ui.push({header:{id:'hidden-h',cwd:'D:/work/alpha-desk/',timestamp:'${stamp}'},entries:window.setupEntries,durableCount:5,working:false,settled:true})`);
			await ui.wait("document.querySelector('.omp-empty-state')");
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-empty-key kbd')].map(node=>node.textContent)"), EMPTY_STATE_KBDS);
			assert.match(await ui.evaluate<string>("document.querySelector('.omp-empty-head').textContent"), /alpha-desk/);
			await ui.evaluate(`window.ui.push({entries:[...window.setupEntries,{type:'message',id:'u1',parentId:'xd0',timestamp:'${stamp}',message:{role:'user',timestamp:1,content:'First prompt'}}],durableCount:6})`);
			await ui.wait("!document.querySelector('.omp-empty-state') && document.querySelector('.omp-transcript')?.textContent.includes('First prompt')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		const emptyChat = async (name: string): Promise<void> => {
			await reset(name);
			await ui.evaluate("window.ui.push({header:{id:'keys-h',cwd:'D:/work/omp-vscode/',timestamp:'2026-10-13T10:00:00.000Z'},entries:[],durableCount:0,working:false,settled:true})");
			await ui.wait("document.querySelector('.omp-empty-state') && window.sent.some(message=>message.type==='omp:recent-sessions-request')");
		};
		const emptyKeys = () => ui.evaluate<string[]>("[...document.querySelectorAll('.omp-empty-key kbd')].map(node=>node.textContent)");
		const sentOfType = (type: string) => ui.evaluate<unknown[]>(`window.sent.filter(message=>message.type===${JSON.stringify(type)})`);

		await t.test("the empty chat groups its key hints in four titled groups, one hint per line, and puts the shortcuts link before the recent sessions", async () => {
			await emptyChat("empty-state-groups");
			await ui.evaluate("(()=>{const request=window.sent.filter(message=>message.type==='omp:recent-sessions-request').at(-1);window.ui.receive({type:'omp:recent-sessions',requestId:request.requestId,items:[{title:'Fix the tokenizer',updatedAt:Date.now()-3600000},{title:'Review the parser',updatedAt:Date.now()-7200000}]})})()");
			await ui.wait("document.querySelectorAll('.omp-empty-recent button').length===2");
			assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.omp-empty-group')].map(group=>({title:group.querySelector('h3').textContent,rows:[...group.querySelectorAll('dl.omp-empty-keys > .omp-empty-key')].map(row=>[[...row.querySelectorAll('dt kbd')].map(node=>node.textContent),row.querySelector('dd').textContent])}))"), [
				{ title: "Start", rows: [[["/"], "commands and skills"], [["@"], "attach a file"], [["Ctrl+V", "Shift"], "an attachment"], [["↑"], "an earlier prompt"], [["Ctrl+Alt+Y"], "search prompts"]] },
				{ title: "While the agent works", rows: [[["Enter"], "steer"], [["Alt+Enter"], "queue"], [["Alt+↑"], "take a queued message back"], [["Esc"], "stop"]] },
				{ title: "In the conversation", rows: [[["Ctrl+F"], "find"], [["Alt+Q"], "quote the selected text"], [["Esc Esc"], "rewind"], [["Ctrl+Alt+T", "Ctrl+O"], "thinking / tool calls"]] },
				{ title: "From the editor and anywhere", rows: [[["Alt+Q"], "in an editor: quote the selection, or reference the caret line"], [["Ctrl+Shift+L"], "composer"], [["Ctrl+Alt+Q"], "go to session"], [["Ctrl+Alt+N"], "new session"]] },
			]);
			assert.deepEqual(await emptyKeys(), EMPTY_STATE_KBDS);
			assert.equal(await ui.evaluate("document.querySelector('.omp-empty-key dt').textContent"), "/");
			assert.equal(await ui.evaluate("[...document.querySelectorAll('.omp-empty-key dt')][2].textContent"), "Ctrl+V or Shift+drag");
			assert.equal(await ui.evaluate("document.querySelector('.omp-empty-conflict, .omp-empty-key-conflict')"), null, "no marker without a conflict");
			assert.equal(await ui.evaluate("document.querySelector('.omp-empty-shortcuts').textContent"), "All keyboard shortcuts (Ctrl+/)");
			assert.equal(await ui.evaluate("(()=>{const link=document.querySelector('.omp-empty-shortcuts'),recent=[...document.querySelectorAll('.omp-empty-state h3')].find(node=>node.textContent==='Recent in this folder'),last=[...document.querySelectorAll('.omp-empty-group')].at(-1);return Boolean(last.compareDocumentPosition(link)&Node.DOCUMENT_POSITION_FOLLOWING)&&Boolean(link.compareDocumentPosition(recent)&Node.DOCUMENT_POSITION_FOLLOWING)})()"), true, "groups, then the link, then the recents");
			assert.deepEqual(await ui.evaluate("({frame:getComputedStyle(document.querySelector('.omp-empty-state')).pointerEvents,body:getComputedStyle(document.querySelector('.omp-empty-state-body')).pointerEvents,link:getComputedStyle(document.querySelector('.omp-empty-shortcuts')).pointerEvents})"), { frame: "none", body: "none", link: "auto" });
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the empty chat's groups sit in two columns on a wide panel and in one on a narrow one, with nothing overflowing", async () => {
			await emptyChat("empty-state-columns");
			const layout = () => ui.evaluate<{ columns: number; tops: number[]; lefts: number[]; overflow: boolean; clipped: boolean; centred: boolean }>(`(()=>{
			 const groups=[...document.querySelectorAll('.omp-empty-group')].map(node=>node.getBoundingClientRect()),body=document.querySelector('.omp-empty-state-body').getBoundingClientRect(),container=document.querySelector('.omp-empty-groups');
			 return{columns:getComputedStyle(container).gridTemplateColumns.split(' ').length,tops:groups.map(rect=>Math.round(rect.top)),lefts:groups.map(rect=>Math.round(rect.left)),overflow:document.documentElement.scrollWidth>innerWidth,
			  clipped:[...document.querySelectorAll('.omp-empty-keys dd')].some(node=>node.getBoundingClientRect().right>innerWidth+0.5),centred:Math.abs(body.left+body.width/2-innerWidth/2)<2}})()`);
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
			await ui.settleGeometry(".omp-empty-state-body");
			const wide = await layout();
			assert.equal(wide.columns, 2);
			assert.equal(wide.tops[0], wide.tops[1], "the first two groups share a row");
			assert.equal(wide.tops[2], wide.tops[3], "so do the last two");
			assert.ok(wide.tops[2] > wide.tops[0], "the second row is below the first");
			assert.equal(wide.lefts[0], wide.lefts[2]);
			assert.ok(wide.lefts[1] > wide.lefts[0] + 200, "the second column is beside the first");
			assert.equal(wide.overflow || wide.clipped, false);
			assert.equal(wide.centred, true, "the frame stays centred");
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 360, height: 700, deviceScaleFactor: 1, mobile: false });
			await ui.settleGeometry(".omp-empty-state-body");
			const narrow = await layout();
			assert.equal(narrow.columns, 1);
			assert.equal(new Set(narrow.lefts).size, 1, "one column");
			assert.deepEqual([...narrow.tops].sort((a, b) => a - b), narrow.tops, "the groups stack in order");
			assert.equal(new Set(narrow.tops).size, 4);
			assert.equal(narrow.overflow || narrow.clipped, false);
			await ui.call("Emulation.clearDeviceMetricsOverride");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a host key list replaces the default key, a removed key shows none, a conflict gets a warning button with its tooltip that opens the key's conflict, and the next list can clear it", async () => {
			await emptyChat("empty-state-host-keys");
			const hint = (command: string, key: string | null, conflicts: Array<{ by: string; command: string }> = [], more = 0) => ({ command, key, conflicts, more });
			const send = (hints: unknown[]) => ui.evaluate(`window.ui.receive({type:'omp:chat-keys',keys:${JSON.stringify(hints)}})`);
			const markers = () => ui.evaluate<Array<{ before: string; tip: string | null; label: string | null; icon: boolean }>>("[...document.querySelectorAll('.omp-empty-key-conflict')].map(button=>({before:button.previousElementSibling.textContent,tip:button.title,label:button.getAttribute('aria-label'),icon:button.querySelector('.codicon.codicon-warning')!==null}))");
			await send([hint("ompDesk.toggleThinking", "Ctrl+Alt+Shift+T"), hint("ompDesk.toggleToolOutput", null)]);
			await ui.wait("[...document.querySelectorAll('.omp-empty-key kbd')].some(node=>node.textContent==='Ctrl+Alt+Shift+T')");
			const replaced = [...EMPTY_STATE_KBDS];
			replaced[replaced.indexOf("Ctrl+Alt+T")] = "Ctrl+Alt+Shift+T";
			replaced[replaced.indexOf("Ctrl+O")] = "none";
			assert.deepEqual(await emptyKeys(), replaced);
			assert.equal(await ui.evaluate("document.querySelector('kbd.omp-empty-key--none').textContent"), "none");
			assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('kbd.omp-empty-key--none')).color!==getComputedStyle(document.querySelector('.omp-empty-key kbd')).color"), true, "none is muted");
			assert.deepEqual(await markers(), []);
			const taken = { by: "IntelliJ IDEA Keymap", command: "git.sync" };
			await send([hint("ompDesk.toggleThinking", "Ctrl+Alt+Shift+T", [taken, { by: "your keybindings.json", command: "editor.action.foo" }], 2)]);
			await ui.wait("document.querySelector('.omp-empty-key-conflict')");
			const tip = "Ctrl+Alt+Shift+T may be taken by IntelliJ IDEA Keymap: git.sync\nCtrl+Alt+Shift+T may be taken by your keybindings.json: editor.action.foo\nand 2 more";
			assert.deepEqual(await markers(), [{ before: "Ctrl+Alt+Shift+T", tip, label: tip, icon: true }], "only the conflicted key has a marker, right after its kbd");
			assert.deepEqual(await ui.evaluate("(()=>{const button=document.querySelector('.omp-empty-key-conflict'),style=getComputedStyle(button),box=button.getBoundingClientRect(),top=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return{type:button.type,events:style.pointerEvents,focusable:button.tabIndex>=0,warning:style.color!==getComputedStyle(document.querySelector('.omp-empty-keys dd')).color,clickable:button.contains(top)}})()"), { type: "button", events: "auto", focusable: true, warning: true, clickable: true });
			await ui.evaluate("document.querySelector('.omp-empty-key-conflict').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:open-key-conflict')");
			assert.deepEqual(await sentOfType("omp:open-key-conflict"), [{ type: "omp:open-key-conflict", command: "ompDesk.toggleThinking" }]);
			// A single conflict has no "and N more" line.
			await send([hint("ompDesk.findInChat", "Ctrl+F", [{ by: "Some Extension", command: "some.find" }])]);
			await ui.wait("document.querySelector('.omp-empty-key-conflict')?.title==='Ctrl+F may be taken by Some Extension: some.find'");
			assert.equal((await markers()).length, 1);
			// A list without conflicts removes the marker, and a command the list no longer names is back to its default.
			await send([hint("ompDesk.findInChat", "Ctrl+F")]);
			await ui.wait("!document.querySelector('.omp-empty-key-conflict')");
			assert.deepEqual(await emptyKeys(), EMPTY_STATE_KBDS);
			await ui.evaluate("window.ui.receive({type:'omp:chat-keys',keys:[]})");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a garbage omp:chat-keys leaves the shown keys unchanged", async () => {
			await emptyChat("empty-state-garbage-keys");
			await ui.evaluate("window.ui.receive({type:'omp:chat-keys',keys:[{command:'ompDesk.toggleThinking',key:'Ctrl+Alt+Shift+T',conflicts:[],more:0}]})");
			await ui.wait("[...document.querySelectorAll('.omp-empty-key kbd')].some(node=>node.textContent==='Ctrl+Alt+Shift+T')");
			const shown = await emptyKeys();
			for (const keys of ["'nope'", "[{command:'evil.command',key:'A',conflicts:[],more:0}]", "[{command:'ompDesk.toggleThinking',key:7,conflicts:[],more:0}]", "[{command:'ompDesk.toggleThinking',key:'F1',conflicts:[{by:3,command:'x'}],more:0}]", "[{command:'ompDesk.toggleThinking',key:'F1',conflicts:[],more:-1}]"]) {
				await ui.evaluate(`window.ui.receive({type:'omp:chat-keys',keys:${keys}})`);
				await settleFrames();
				assert.deepEqual(await emptyKeys(), shown, keys);
			}
			assert.equal(await ui.evaluate("document.querySelector('.omp-empty-key-conflict')"), null);
		});

		await t.test("the shortcuts link names the effective key and asks the host for Keyboard Shortcuts", async () => {
			await emptyChat("empty-state-shortcuts-link");
			assert.equal(await ui.evaluate("document.querySelector('.omp-empty-shortcuts').tagName"), "BUTTON");
			await ui.evaluate("window.ui.receive({type:'omp:chat-keys',keys:[{command:'ompDesk.showChatKeyboardShortcuts',key:'Ctrl+K Ctrl+S',conflicts:[],more:0}]})");
			await ui.wait("document.querySelector('.omp-empty-shortcuts').textContent==='All keyboard shortcuts (Ctrl+K Ctrl+S)'");
			await ui.evaluate("document.querySelector('.omp-empty-shortcuts').click()");
			await ui.wait("window.sent.some(message=>message.type==='omp:chat-command')");
			assert.deepEqual(await sentOfType("omp:chat-command"), [{ type: "omp:chat-command", command: "keyboard-shortcuts" }]);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("an aborted reply is one muted line with its own message, a provider error one line, and Handed off is set in the UI font", async () => {
			await reset("notices");
			await ui.evaluate(`window.row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.ui.push({entries:[window.row('u1',{role:'user',timestamp:1,content:'Do it'}),window.row('a1',{role:'assistant',model:'m',timestamp:2,stopReason:'aborted',errorMessage:'Interrupted by user',content:[]}),
			  window.row('u2',{role:'user',timestamp:3,content:'Again'}),window.row('a2',{role:'assistant',model:'m',timestamp:4,stopReason:'aborted',content:[]}),
			  window.row('u3',{role:'user',timestamp:5,content:'Once more'}),window.row('a3',{role:'assistant',model:'m',timestamp:6,stopReason:'error',errorMessage:'Provider overloaded; try again later',content:[]}),
			  {type:'compaction',id:'handoff',parentId:null,timestamp:'2026-10-01T00:00:00.000Z',summary:'Summary',method:'handoff',firstKeptEntryId:'u3',tokensBefore:48400,tokensAfter:9400}],durableCount:7,working:false,settled:true})`);
			await ui.wait("document.querySelectorAll('.omp-turn-aborted').length===2 && document.querySelector('.omp-turn-error') && document.querySelector('.omp-native-summary-amount')");
			const notices = await ui.evaluate<{ aborted: string[]; strong: number; icon: boolean; muted: boolean; role: string | null; error: { text: string; strong: string; lines: number; color: boolean }; label: string[]; amount: string[] }>(`(()=>{
			 const [own,plain]=[...document.querySelectorAll('.omp-turn-aborted')],error=document.querySelector('.omp-turn-error'),amount=document.querySelector('.omp-native-summary-amount'),label=document.querySelector('.omp-native-summary-label');
			 const line=getComputedStyle(error),text=error.querySelector('span');
			 return{aborted:[own.textContent,plain.textContent],strong:own.querySelectorAll('strong').length,icon:own.querySelector('.codicon-circle-slash')!==null,muted:getComputedStyle(own).color!==getComputedStyle(document.body).color,role:own.getAttribute('role'),
			  error:{text:error.textContent,strong:error.querySelector('strong').textContent,lines:Math.round(error.getBoundingClientRect().height/parseFloat(line.lineHeight==='normal'?'18':line.lineHeight)),color:line.color!==getComputedStyle(own).color},
			  label:[getComputedStyle(label).fontSize],amount:[getComputedStyle(amount).fontFamily,getComputedStyle(label).fontFamily,amount.textContent]}})()`);
			assert.deepEqual(notices.aborted, ["Interrupted by user", "Aborted"], "the reply's own message, or Aborted when it has none");
			assert.equal(notices.strong, 0, "no bold block above the message");
			assert.ok(notices.icon && notices.muted && notices.role === "status");
			assert.equal(notices.error.strong, "Provider error");
			assert.equal(notices.error.text, "Provider errorProvider overloaded; try again later");
			assert.equal(notices.error.lines, 1, "one line at this width");
			assert.ok(notices.error.color, "the error colour, not the muted one");
			assert.deepEqual(notices.label, ["12px"]);
			assert.equal(notices.amount[0], notices.amount[1], "the amount is set in the UI font like its label");
			assert.match(notices.amount[2]!, /48\.4k → 9\.4k tokens/);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the working row spins and shimmers, and stops under reduced motion; High Contrast keeps plain muted text", async () => {
			await reset("working-motion");
			await ui.evaluate("window.ui.push({working:true,settled:false,workingIntent:'Reading the parser'})");
			await ui.wait("document.querySelector('.omp-working-status-text:not(:empty)')");
			const motion = () => ui.evaluate<{ text: string; glyph: string; spin: string; sweep: string; clip: string; height: number }>(`(()=>{
			 const text=document.querySelector('.omp-working-status-text'),text_=getComputedStyle(text),glyph=getComputedStyle(text,'::before');
			 return{text:text.textContent,glyph:glyph.content,spin:glyph.animationName,sweep:text_.animationName,clip:text_.backgroundClip,height:document.querySelector('.omp-working-status').getBoundingClientRect().height}})()`);
			const moving = await motion();
			assert.equal(moving.text, "Reading the parser");
			assert.equal(moving.glyph, '"\ueb19"', "the codicon loading glyph precedes the text");
			assert.notEqual(moving.spin, "none");
			assert.notEqual(moving.sweep, "none");
			assert.equal(moving.clip, "text");
			assert.equal(moving.height, 24, "the row keeps its fixed height");
			await ui.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
			const still = await motion();
			assert.deepEqual([still.spin, still.sweep], ["none", "none"], "reduced motion stops both");
			await ui.call("Emulation.setEmulatedMedia", { features: MOTION_ALLOWED });
			await ui.evaluate("document.body.classList.add('vscode-high-contrast')");
			assert.deepEqual(await ui.evaluate("(()=>{const style=getComputedStyle(document.querySelector('.omp-working-status-text'));return[style.animationName,style.backgroundImage]})()"), ["none", "none"], "no text shimmer in High Contrast");
			await ui.evaluate("document.body.classList.remove('vscode-high-contrast')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the ask dialog keeps the composer toolbar, has Cancel and Stop as text buttons and flat rows, and High Contrast keeps its borders", async () => {
			await reset("ask-flat");
			await ui.evaluate(`window.ui.push({uiRequests:[{id:'ask-flat',method:'ask',title:'t',questions:[{id:'scope',header:'Scope',question:'Which scope?',multi:true,options:[{label:'Narrow'},{label:'Whole repository'}]},{id:'checks',question:'Which checks?',multi:false,options:[{label:'Typecheck'}]}]}],working:true,settled:false})`);
			await ui.wait("document.querySelector('.omp-ask-option') && document.querySelector('.omp-ask-actions .omp-btn--stop')");
			await ui.evaluate("document.documentElement.style.setProperty('--vscode-focusBorder','#007fd4')");
			await ui.evaluate("document.querySelectorAll('.omp-ask-option')[0].click()");
			await ui.wait("document.querySelector('.omp-ask-option--checked')");
			const flat = () => ui.evaluate<{ toolbar: boolean; actions: string[][]; unchecked: string; checked: string; tabIdle: string; tabActive: string; primary: string }>(`(()=>{
			 const edge=node=>getComputedStyle(node).borderTopColor,fill=node=>getComputedStyle(node).backgroundColor;
			 return{toolbar:document.querySelector('.omp-composer-toolbar').getBoundingClientRect().height>0,
			  actions:[...document.querySelectorAll('.omp-ask-actions .omp-btn')].map(button=>[button.textContent.trim(),edge(button),fill(button)]),
			  unchecked:edge(document.querySelectorAll('.omp-ask-option:not(.omp-ask-option--checked)')[0]),checked:edge(document.querySelector('.omp-ask-option--checked')),
			  tabIdle:edge(document.querySelector('.omp-ask-tab:not(.omp-ask-tab--active)')),tabActive:edge(document.querySelector('.omp-ask-tab--active')),
			  primary:fill(document.querySelector('.omp-ask-panel .omp-btn--primary'))}})()`);
			const normal = await flat();
			assert.equal(normal.toolbar, true, "the toolbar stays while a question is open");
			assert.deepEqual(normal.actions.map(([label]) => label), ["Cancel", "Stop"]);
			for (const [label, edge, fill] of normal.actions) assert.deepEqual([edge, fill], ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"], `${label} has no resting border or fill`);
			assert.equal(normal.unchecked, "rgba(0, 0, 0, 0)", "an unchosen option is a flat row");
			assert.equal(normal.checked, "rgb(0, 127, 212)", "the chosen option keeps its focus edge");
			assert.equal(normal.tabIdle, "rgba(0, 0, 0, 0)");
			assert.equal(normal.tabActive, "rgb(0, 127, 212)");
			assert.notEqual(normal.primary, "rgba(0, 0, 0, 0)", "Next stays the one filled control");
			await ui.evaluate("document.documentElement.style.setProperty('--vscode-contrastBorder','#6fc3df');document.body.classList.add('vscode-high-contrast')");
			const contrast = await flat();
			for (const [label, edge] of contrast.actions) assert.equal(edge, "rgb(111, 195, 223)", `${label} keeps the contrast border in High Contrast`);
			assert.equal(contrast.unchecked, "rgb(111, 195, 223)");
			assert.equal(contrast.tabIdle, "rgb(111, 195, 223)");
			await ui.evaluate("document.body.classList.remove('vscode-high-contrast')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		const CODE_THEME = "{id:'Dark Modern',rules:[{scopes:['storage.type'],foreground:'#569CD6'},{scopes:['string'],foreground:'#CE9178'},{scopes:['constant.numeric'],foreground:'#B5CEA8'}]}";
		const codeReply = (text: string) => `window.ui.push({entries:[{type:'message',id:'reply',parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message:{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:${JSON.stringify(text)}}]}}],durableCount:1,working:false,settled:true})`;

		await t.test("fenced code is coloured with the editor theme's colours after the first paint, and Copy still gives the plain source", async () => {
			await reset("code-highlight");
			await ui.evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(text){window.copied=text}}})`);
			const source = "const a = 1; // note\nconst b = \"two\";";
			await ui.evaluate(codeReply(`Run:\n\n\`\`\`ts\n${source}\n\`\`\`\n\n\`\`\`nosuchlang\nconst c = 3;\n\`\`\`\n\nDone.`));
			await ui.wait("document.querySelectorAll('.omp-md pre code').length===2");
			assert.equal(await ui.evaluate("document.querySelectorAll('code[data-highlighted]').length"), 0, "no theme yet: plain code, as before");
			await ui.evaluate(`window.ui.receive({type:'omp:chat-code-theme',themes:[${CODE_THEME},{id:'Light Modern',rules:[{scopes:['storage.type'],foreground:'#0000FF'}]}]})`);
			await ui.wait("document.querySelector('code[data-language=\"ts\"][data-highlighted]')");
			const facts = await ui.evaluate<{ text: string; colours: Array<[string, string]>; plainLanguage: boolean; base: string; foreground: string }>(`(()=>{
			 const code=document.querySelector('code[data-language="ts"]'), other=document.querySelector('code[data-language="nosuchlang"]');
			 return {text:code.textContent,colours:[...code.querySelectorAll('span')].map(span=>[span.textContent,span.style.color]),
			  plainLanguage:!other.hasAttribute('data-highlighted')&&other.children.length===0,base:getComputedStyle(code).color,foreground:getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-foreground').trim()}})()`);
			assert.equal(facts.text, source, "colour never changes the text");
			assert.deepEqual(facts.colours, [["const", "rgb(86, 156, 214)"], ["1", "rgb(181, 206, 168)"], ["const", "rgb(86, 156, 214)"], ['"two"', "rgb(206, 145, 120)"]]);
			assert.equal(facts.plainLanguage, true, "a language we do not know stays plain");
			assert.equal(facts.base, "rgb(221, 221, 221)", "text no rule colours is the editor's text colour");
			await ui.evaluate("document.querySelector('.omp-code-copy').click()");
			await ui.wait("window.copied!==undefined");
			assert.equal(await ui.evaluate("window.copied"), source, "Copy gives the source, not the coloured text");
			// A theme change re-colours the same text without a new render of the message.
			// The page picks the theme VS Code says is active (its id on the body), never the first candidate by guess.
			await ui.evaluate("document.body.setAttribute('data-vscode-theme-id','Light Modern')");
			await ui.wait("document.querySelector('code[data-language=\"ts\"] span')?.style.color==='rgb(0, 0, 255)'");
			await ui.evaluate("document.body.setAttribute('data-vscode-theme-id','Some Other Theme')");
			await ui.wait("!document.querySelector('code[data-highlighted]')");
			await ui.evaluate("document.body.setAttribute('data-vscode-theme-id','Dark Modern')");
			await ui.wait("document.querySelector('code[data-language=\"ts\"] span')?.style.color==='rgb(86, 156, 214)'");
			await ui.evaluate("document.body.removeAttribute('data-vscode-theme-id');window.ui.receive({type:'omp:chat-code-theme',themes:[]})");
			await ui.wait("!document.querySelector('code[data-highlighted]')");
			assert.equal(await ui.evaluate("document.querySelector('code[data-language=\"ts\"]').textContent"), source);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("an unfinished fence is coloured only once its text has stopped changing, and keeps its colour while it grows", async () => {
			await reset("code-highlight-streaming");
			await ui.evaluate(`window.ui.receive({type:'omp:chat-code-theme',themes:[${CODE_THEME}]})`);
			await ui.evaluate(codeReply("```ts\nconst a = 1;"));
			await ui.wait("document.querySelector('code[data-language=\"ts\"]')");
			assert.equal(await ui.evaluate("document.querySelector('code[data-highlighted]')"), null, "an open fence is plain while it may still change");
			await ui.wait("document.querySelector('code[data-highlighted] span')");
			await ui.evaluate(codeReply("```ts\nconst a = 1;\nconst b"));
			await ui.wait("document.querySelector('code[data-language=\"ts\"]').textContent==='const a = 1;\\nconst b'");
			const grown = await ui.evaluate<{ coloured: boolean; text: string }>("({coloured:document.querySelector('code[data-language=\"ts\"]').hasAttribute('data-highlighted'),text:document.querySelector('code[data-language=\"ts\"]').textContent})");
			assert.equal(grown.coloured, true, "the text already coloured stays coloured while the new text arrives");
			await ui.evaluate("window.ui.receive({type:'omp:chat-code-theme',themes:[]})");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		/** One finished tool call (`details` and result text as OMP sends them), its card opened. */
		const toolCard = async (id: string, name: string, args: unknown, details: unknown = {}, expand = true) => {
			await ui.evaluate(`(()=>{
			 const row=(id,parentId,message)=>({type:'message',id,parentId,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.ui.push({entries:[row('c-${id}',null,{role:'assistant',model:'m',timestamp:1,stopReason:'toolUse',content:[{type:'toolCall',id:${JSON.stringify(id)},name:${JSON.stringify(name)},arguments:${JSON.stringify(args)}}]}),
			  row('r-${id}','c-${id}',{role:'toolResult',timestamp:2,toolCallId:${JSON.stringify(id)},toolName:${JSON.stringify(name)},isError:false,content:[{type:'text',text:'done'}],details:${JSON.stringify(details)}})],durableCount:2,working:false,settled:true})})()`);
			await ui.wait(`document.querySelector('[data-tool-call-id="${id}"] .omp-tool-head')`);
			if (expand) await ui.evaluate(`document.querySelector('[data-tool-call-id="${id}"] .omp-tool-head').click()`);
			if (expand) await ui.wait(`document.querySelector('[data-tool-call-id="${id}"] .omp-tool-body')`);
		};
		const codeSpans = (id: string, scope: string) => ui.evaluate<Array<[string, string]>>(`[...document.querySelectorAll('[data-tool-call-id="${id}"] ${scope} span')].filter(span=>!span.className&&span.style.color).map(span=>[span.textContent,span.style.color])`);

		await t.test("a Write card's file content is coloured by the file's language with the editor theme, line numbers and copy text untouched; an unknown extension stays plain", async () => {
			await reset("code-highlight-write");
			const python = "def tree(a):\n    n = 1\n    return \"leaf\"\n";
			await toolCard("hl-write-py", "write", { path: ".workspace/notes/compile_tree.py", content: python });
			assert.deepEqual(await codeSpans("hl-write-py", ".omp-native-code-line"), [], "no theme yet: plain, as before");
			await ui.evaluate(`window.ui.receive({type:'omp:chat-code-theme',themes:[${CODE_THEME}]})`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"hl-write-py\"] .omp-native-code-line span[style]')");
			assert.deepEqual(await codeSpans("hl-write-py", ".omp-native-code-line"), [["def", "rgb(86, 156, 214)"], ["1", "rgb(181, 206, 168)"], ["\"leaf\"", "rgb(206, 145, 120)"]]);
			const facts = await ui.evaluate<{ rows: string[]; numbers: string[]; text: string }>(`(()=>{const card=document.querySelector('[data-tool-call-id="hl-write-py"]');
			 const rows=[...card.querySelectorAll('.omp-native-code-line')];
			 return {rows:rows.map(row=>row.textContent.replace(/^\\s*\\d+\\s/,'')),numbers:rows.map(row=>row.querySelector('.omp-native-line-number').textContent),text:card.querySelector('.omp-native-code').textContent}})()`);
			assert.deepEqual(facts.rows.slice(0, 3), ["def tree(a):\n", "    n = 1\n", "    return \"leaf\"\n"], "colour never changes the text");
			assert.deepEqual(facts.numbers.slice(0, 3), ["1", "2", "3"], "line numbers stay");
			await toolCard("hl-write-txt", "write", { path: "notes/readme.zzz", content: python });
			assert.deepEqual(await codeSpans("hl-write-txt", ".omp-native-code-line"), [], "an unknown extension stays plain");
			await toolCard("hl-write-docker", "write", { path: "ci/Dockerfile", content: "FROM node:20\nENV A=\"b\"\n" });
			await ui.wait("document.querySelector('[data-tool-call-id=\"hl-write-docker\"] .omp-native-code-line span[style]')");
			assert.ok((await codeSpans("hl-write-docker", ".omp-native-code-line")).some(([text]) => text === "\"b\""), "a special file name picks its language");
			await ui.evaluate("window.ui.receive({type:'omp:chat-code-theme',themes:[]})");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("an Edit card keeps its diff backgrounds, signs and numbers and colours the code of every line", async () => {
			await reset("code-highlight-edit");
			await ui.evaluate(`document.documentElement.style.setProperty('--vscode-diffEditor-insertedLineBackground','rgb(10, 80, 10)');document.documentElement.style.setProperty('--vscode-diffEditor-removedLineBackground','rgb(90, 10, 10)')`);
			await ui.evaluate(`window.ui.receive({type:'omp:chat-code-theme',themes:[${CODE_THEME}]})`);
			await toolCard("hl-edit-ts", "edit", { path: "src/a.ts" }, { path: "src/a.ts", diff: " 1|const a = 1;\n-2|const b = \"old\";\n+2|const b = \"new\";\n 3|let c = 3;", firstChangedLine: 2 });
			await ui.wait("document.querySelector('[data-tool-call-id=\"hl-edit-ts\"] .omp-native-diff-add span[style]')");
			const facts = await ui.evaluate<Array<{ cls: string; sign: string; number: string; text: string; colours: Array<[string, string]>; background: string }>>(`[...document.querySelectorAll('[data-tool-call-id="hl-edit-ts"] .omp-native-diff .omp-pre > span')].map(row=>({cls:row.className,
			 sign:row.querySelector('.omp-native-diff-sign')?.textContent,number:row.querySelector('.omp-native-line-number')?.textContent,text:row.textContent,
			 colours:[...row.querySelectorAll('span')].filter(span=>!span.className&&span.style.color).map(span=>[span.textContent,span.style.color]),background:getComputedStyle(row).backgroundColor}))`);
			assert.deepEqual(facts.map(row => [row.cls, row.sign, row.number]), [["", " ", "1"], ["omp-native-diff-remove", "-", "2"], ["omp-native-diff-add", "+", "2"], ["", " ", "3"]]);
			assert.deepEqual(facts.map(row => row.text), [" 1const a = 1;\n", "-2const b = \"old\";\n", "+2const b = \"new\";\n", " 3let c = 3;\n"], "the diff's own text is unchanged");
			assert.deepEqual(facts[1]!.colours, [["const", "rgb(86, 156, 214)"], ["\"old\"", "rgb(206, 145, 120)"]], "a removed line is read as the old file");
			assert.deepEqual(facts[2]!.colours, [["const", "rgb(86, 156, 214)"], ["\"new\"", "rgb(206, 145, 120)"]]);
			assert.deepEqual(facts[3]!.colours, [["let", "rgb(86, 156, 214)"], ["3", "rgb(181, 206, 168)"]], "context lines are coloured too");
			assert.equal(facts[1]!.background, "rgb(90, 10, 10)", "the removed background stays");
			assert.equal(facts[2]!.background, "rgb(10, 80, 10)", "the added background stays");
			await toolCard("hl-edit-unknown", "edit", { path: "data/a.zzz" }, { path: "data/a.zzz", diff: "-1|const a = 1;\n+1|const a = 2;" });
			assert.equal(await ui.evaluate("document.querySelectorAll('[data-tool-call-id=\"hl-edit-unknown\"] .omp-native-diff .omp-pre span[style]').length"), 0, "an unknown extension's diff stays plain");
			await ui.evaluate("window.ui.receive({type:'omp:chat-code-theme',themes:[]})");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a Bash card's command is coloured as shell in its header, and a Read card's file as its language", async () => {
			await reset("code-highlight-bash-read");
			await ui.evaluate(`window.ui.receive({type:'omp:chat-code-theme',themes:[${CODE_THEME}]})`);
			await toolCard("hl-bash", "bash", { command: "echo \"hi\" && pwd" }, { exitCode: 0 }, false);
			await ui.wait("document.querySelector('[data-tool-call-id=\"hl-bash\"] .omp-tool-digest span[style]')");
			assert.deepEqual(await codeSpans("hl-bash", ".omp-tool-digest"), [["\"hi\"", "rgb(206, 145, 120)"]]);
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"hl-bash\"] .omp-tool-digest').textContent"), "echo \"hi\" && pwd");
			await toolCard("hl-read", "read", { path: "src/a.ts:10-12" }, { displayContent: { text: "const a = 1;\nconst b = \"x\";", startLine: 10 } });
			await ui.wait("document.querySelector('[data-tool-call-id=\"hl-read\"] .omp-native-code-line span[style]')");
			assert.deepEqual(await codeSpans("hl-read", ".omp-native-code-line"), [["const", "rgb(86, 156, 214)"], ["1", "rgb(181, 206, 168)"], ["const", "rgb(86, 156, 214)"], ["\"x\"", "rgb(206, 145, 120)"]]);
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"hl-read\"] .omp-native-line-number').textContent"), "10", "the first line number is the read's own");
			await ui.evaluate("window.ui.receive({type:'omp:chat-code-theme',themes:[]})");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a Write still streaming is coloured once its text settles and keeps that colour while it grows", async () => {
			await reset("code-highlight-write-streaming");
			await ui.evaluate(`window.ui.receive({type:'omp:chat-code-theme',themes:[${CODE_THEME}]})`);
			await ui.evaluate(`window.liveWrite=content=>{const args={path:'live.ts',content};const message={role:'assistant',model:'m',timestamp:1000,stopReason:'toolUse',content:[{type:'toolCall',id:'hl-live',name:'write',arguments:args}]};
			 window.ui.push({stream:{messageId:'hl-live-message',message},streamPosition:{anchorId:null,seq:1},working:true,settled:false,activeTools:[{toolCallId:'hl-live',toolName:'write',args,startedAt:1000}]})};window.liveWrite('const a = 1;')`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"hl-live\"] .omp-native-code-line')");
			assert.equal(await ui.evaluate("document.querySelectorAll('[data-tool-call-id=\"hl-live\"] .omp-native-code-line span[style]').length"), 0, "plain while the text may still change");
			await ui.wait("document.querySelector('[data-tool-call-id=\"hl-live\"] .omp-native-code-line span[style]')");
			await ui.evaluate("window.liveWrite('const a = 1;\\nconst b')");
			await ui.wait("document.querySelectorAll('[data-tool-call-id=\"hl-live\"] .omp-native-code-line').length===2");
			assert.ok(await ui.evaluate("document.querySelector('[data-tool-call-id=\"hl-live\"] .omp-native-code-line span[style]')!==null"), "the coloured text stays coloured while the new text arrives");
			await ui.evaluate("window.ui.receive({type:'omp:chat-code-theme',themes:[]})");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("inline code is the theme's string colour on a tint of it, and a link in it or around it looks the same", async () => {
			await reset("inline-code-colour");
			const root = "document.documentElement.style";
			await ui.evaluate(`${root}.setProperty('--vscode-textPreformat-foreground','#d0d0d0');${root}.setProperty('--vscode-textPreformat-background','#3c3c3c')`);
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message});
			 window.ui.push({entries:[row('reply',{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:'Plain \`plain\`, web [\`web\`](https://example.com/a), file \`src/proof.ts\`.'}]})],durableCount:1,working:false,settled:true});
			 const proven=['src/proof.ts'];window.answered=new Set();
			 window.answerLinks=setInterval(()=>{for(const message of window.sent){
			  if(message.type!=='omp:terminal-link-validate'||window.answered.has(message.requestId))continue;
			  window.answered.add(message.requestId);
			  window.ui.receive({type:'omp:terminal-link-validation',requestId:message.requestId,valid:proven.includes(message.target)});
			 }},5)})()`);
			await ui.wait("document.querySelector('.omp-file-link') && document.querySelector('.omp-web-link > code')");
			const inline = `(()=>{
			 const style=node=>{const s=getComputedStyle(node);return{color:s.color,background:s.backgroundColor,line:s.textDecorationLine,lineColor:s.textDecorationColor}};
			 const plain=[...document.querySelectorAll('.omp-md p code')].find(node=>node.textContent==='plain'), web=document.querySelector('.omp-web-link > code');
			 const link=document.querySelector('.omp-file-link'), code=link.closest('code')??link.querySelector('code')??link, mark=link.closest('code')?link:code;
			 const painted=style(code);
			 return{plain:style(plain),web:style(web),file:{color:painted.color,background:painted.background,line:style(mark).line,lineColor:style(mark).lineColor},linkColor:style(link)}})()`;
			const fallback = await ui.evaluate<Record<string, Record<string, string> | null>>(inline);
			assert.equal(fallback.plain!.color, "rgb(208, 208, 208)", "without a string colour the preformatted-text colours stand");
			assert.equal(fallback.plain!.background, "rgb(60, 60, 60)");
			await ui.evaluate("window.ui.receive({type:'omp:chat-code-theme',themes:[{id:'Dark Modern',rules:[{scopes:['string'],foreground:'#CE9178'}]}]})");
			await ui.wait(`getComputedStyle(document.querySelector('.omp-md p code')).color==='rgb(206, 145, 120)'`);
			const themed = await ui.evaluate<Record<string, Record<string, string> | null>>(inline);
			assert.match(themed.plain!.background, /0\.14/, "the string colour at 14% on transparent");
			assert.equal(themed.plain!.line, "none", "plain code has no underline");
			for (const linked of ["web", "file"]) {
				assert.equal(themed[linked]!.color, themed.plain!.color, `${linked} link code keeps the code colour`);
				assert.equal(themed[linked]!.background, themed.plain!.background, `${linked} link code keeps the code tint`);
				assert.equal(themed[linked]!.line, "underline", `${linked} link code is marked by an underline`);
				assert.match(themed[linked]!.lineColor, /\/ 0\.55\)/, `${linked} link underline is faint`);
			}
			assert.equal(themed.linkColor!.color, themed.plain!.color, "the file link takes the code's colour");
			// High Contrast keeps the theme's own preformatted colours: no tint.
			await ui.evaluate("document.body.classList.add('vscode-high-contrast')");
			const contrast = await ui.evaluate<Record<string, Record<string, string> | null>>(inline);
			assert.equal(contrast.plain!.color, "rgb(208, 208, 208)");
			assert.equal(contrast.plain!.background, "rgb(60, 60, 60)");
			assert.equal(contrast.web!.background, contrast.plain!.background);
			await ui.evaluate(`document.body.classList.remove('vscode-high-contrast');clearInterval(window.answerLinks);window.ui.receive({type:'omp:chat-code-theme',themes:[]});${root}.removeProperty('--vscode-textPreformat-foreground');${root}.removeProperty('--vscode-textPreformat-background')`);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("long lines wrap and only a block that cannot wrap scrolls: the transcript and the page never scroll sideways at 360, 480 and 900 px", async () => {
			await reset("chat-overflow", "detailed");
			const path = "omp-vscode/src/Transcript/Layouts/Wrapping/Specializations/TranscriptWrapSpecialist/Cases/TranscriptWrapSpecialist_Case03_Feature_m_LongLineRules_ConfigurationOverride_Final.json";
			const provenPath = "proven/Transcript/Layouts/Wrapping/Specializations/TranscriptWrapSpecialist/Cases/TranscriptWrapSpecialist_Case03_Feature_m_LongLineRules.ts:12:4";
			const word = "Supercalifragilisticexpialidocious".repeat(6);
			const url = `https://example.com/very/long/path/${"segment-".repeat(24)}end?query=${"abcdef".repeat(30)}&b=1`;
			const columns = Array.from({ length: 14 }, (_, index) => `column-name-${String(index).padStart(2, "0")}`);
			const table = [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, `| ${columns.map((_, index) => `cell-value-${index}`).join(" | ")} |`].join("\n");
			const reply = [
				`Path \`${path}\` ends the line.`,
				`Proven file \`${provenPath}\` and a [link \`${path}\`](https://example.com/a) and a [${word}](https://example.com/b).`,
				`URL ${url} then a word ${word} done.`,
				`## Heading ${word}`,
				`- list item with \`${path}\`\n- list item ${word}`,
				`> quote ${word}`,
				table,
				`\`\`\`ts\nconst longLine = "${"0123456789".repeat(40)}";\n\`\`\``,
			].join("\n\n");
			const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({ role: "assistant", model: "m", timestamp: 2, stopReason: "stop", content, ...extra });
			const toolCall = (id: string, name: string, args: unknown) => assistant([{ type: "toolCall", id, name, arguments: args }], { stopReason: "toolUse" });
			const toolResult = (id: string, name: string, text: string, details: unknown = {}) => ({ role: "toolResult", timestamp: 3, toolCallId: id, toolName: name, isError: false, content: [{ type: "text", text }], details });
			/** The transcript holds exactly these messages (every one a root, as the other fixtures do). */
			const show = (messages: unknown[]) => ui.evaluate(`(()=>{
			 const entries=${JSON.stringify(messages)}.map((message,index)=>({type:'message',id:'of-'+index,parentId:null,timestamp:'2026-10-01T00:00:00.000Z',message}));
			 window.ui.push({entries,durableCount:entries.length,working:false,settled:true})})()`);
			await ui.evaluate(`(()=>{
			 window.answered=new Set();
			 window.answerLinks=setInterval(()=>{for(const message of window.sent){
			  if(message.type!=='omp:terminal-link-validate'||window.answered.has(message.requestId))continue;
			  window.answered.add(message.requestId);
			  window.ui.receive({type:'omp:terminal-link-validation',requestId:message.requestId,valid:message.target.startsWith('proven/')});
			 }},5);
			 // Every element that sticks out of the transcript's right edge without a scrolling block of its own around it.
			 window.culprits=()=>{const t=document.querySelector('.omp-transcript'),limit=t.getBoundingClientRect().right,out=[];
			  for(const el of t.querySelectorAll('*')){const r=el.getBoundingClientRect();if(r.width===0||r.right<=limit+1)continue;
			   let clipped=false;for(let p=el.parentElement;p&&p!==t;p=p.parentElement){const o=getComputedStyle(p).overflowX;if(o==='auto'||o==='scroll'||o==='hidden'||o==='clip'){clipped=true;break}}
			   if(!clipped)out.push(el.tagName.toLowerCase()+'.'+String(el.className).split(' ').join('.')+' right='+Math.round(r.right)+' "'+(el.textContent||'').slice(0,24)+'"')}
			  return out.slice(0,40)};
			 // The nearest ancestor that scrolls sideways: the block that owns the overflow.
			 window.scroller=el=>{for(let p=el.parentElement;p;p=p.parentElement){const o=getComputedStyle(p).overflowX;if(o==='auto'||o==='scroll')return p}return null};
			 window.lines=el=>({height:el.getBoundingClientRect().height,line:parseFloat(getComputedStyle(el).lineHeight),rects:el.getClientRects().length});
			 // The last character of every line but the last one of an inline element.
			 window.lineEnds=el=>{const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),chars=[];
			  for(let node=walker.nextNode();node;node=walker.nextNode()){for(let i=0;i<node.data.length;i++){const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);const rects=range.getClientRects();if(rects.length)chars.push({c:node.data[i],top:Math.round(rects[0].top)})}}
			  return chars.filter((item,i)=>i+1<chars.length&&chars[i+1].top>item.top+2).map(item=>item.c)};
			})()`);
			/** At each width: the transcript and the page never scroll sideways, nothing sticks out of it, and `read`'s answer passes `check`. */
			const atEachWidth = async <T>(label: string, settle: string, read: string, check: (facts: T, where: string) => void) => {
				for (const width of [360, 480, 900]) {
					await ui.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
					await ui.settleGeometry(`.omp-transcript,${settle}`);
					const facts = await ui.evaluate<{ transcript: [number, number]; page: [number, number]; culprits: string[]; read: T }>(`(()=>{const t=document.querySelector('.omp-transcript');
					 return {transcript:[t.scrollWidth,t.clientWidth],page:[document.documentElement.scrollWidth,innerWidth],culprits:window.culprits(),read:${read}}})()`);
					const where = `${label} at ${width}px`;
					assert.ok(facts.transcript[0] <= facts.transcript[1], `the transcript does not scroll sideways: ${where} (${facts.transcript.join(" over ")}); sticking out: ${facts.culprits.join(" | ")}`);
					assert.ok(facts.page[0] <= facts.page[1], `the page does not scroll sideways: ${where}`);
					assert.deepEqual(facts.culprits, [], `nothing sticks out of the transcript: ${where}`);
					check(facts.read, where);
				}
			};

			// A reply: inline path, file and web links, a URL, long words, a list, a heading, a quote, a wide table and a long code line; then a long user message.
			await show([assistant([{ type: "text", text: reply }]), { role: "user", timestamp: 20, content: `Please look at ${path} and ${word} and ${url}` }]);
			await ui.wait("document.querySelector('.omp-md table') && document.querySelector('.omp-md pre') && document.querySelector('.omp-user') && document.querySelector('.omp-file-link')");
			type Prose = { path: Lines | null; ends: string[]; pathText: string; pathSelected: string | null; proven: string[]; user: Lines | null; table: Block; fence: Block; links: { target: string; rects: number }[] };
			type Lines = { height: number; line: number; rects: number };
			type Block = { own: boolean; scroll: [number, number] };
			await atEachWidth<Prose>("a reply and a user message", ".omp-md table,.omp-md pre", `(()=>{
			 const pathCode=[...document.querySelectorAll('.omp-md p code')].find(code=>code.textContent.startsWith('omp-vscode/src')&&!code.closest('.omp-file-link,.omp-web-link'));
			 const block=el=>{const host=window.scroller(el);return {own:host!==null&&host!==document.querySelector('.omp-transcript'),scroll:host?[host.scrollWidth,host.clientWidth]:[0,0]}};
			 const ends=pathCode?window.lineEnds(pathCode):[];
			 const select=el=>{const range=document.createRange();range.selectNodeContents(el);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);const text=selection.toString();selection.removeAllRanges();return text};
			 const proven=document.querySelector('.omp-md [data-file-target^="proven/"]');
			 return {ends,pathText:pathCode?.textContent,pathSelected:pathCode?select(pathCode):null,proven:proven?[proven.textContent,proven.dataset.fileTarget]:[],
			  path:pathCode?window.lines(pathCode):null,user:document.querySelector('.omp-user')?window.lines(document.querySelector('.omp-user')):null,
			  table:block(document.querySelector('.omp-md table')),fence:block(document.querySelector('.omp-md pre code')),
			  links:[...document.querySelectorAll('.omp-md .omp-file-link, .omp-md .omp-web-link')].map(link=>({target:link.dataset.fileTarget??link.dataset.webUrl??'',rects:link.getClientRects().length}))}})()`,
			(facts, where) => {
				assert.ok(facts.path !== null && facts.path.height > facts.path.line * 1.5 && facts.path.rects > 1, `a long inline path wraps: ${where} (${facts.path?.height}px over ${facts.path?.line}px lines)`);
				assert.ok(facts.ends.length >= 1, `the path is on several lines: ${where}`);
				assert.ok(facts.ends.every(end => /[/._-]/.test(end)), `every line of the path ends at a separator, never mid-word: ${where} (${facts.ends.join(" ")})`);
				if (where.endsWith("at 360px")) assert.ok(facts.ends.includes("/"), `a line of the path ends at a "/" boundary: ${where} (${facts.ends.join(" ")})`);
				assert.equal(facts.pathText, path, `the path's text is unchanged: ${where}`);
				assert.equal(facts.pathSelected, path, `selecting the path copies exactly it: ${where}`);
				assert.deepEqual(facts.proven, [provenPath, provenPath], `a proven file link keeps its text and target: ${where}`);
				assert.ok(facts.user !== null && facts.user.height > facts.user.line * 3, `a long user message wraps: ${where} (${facts.user?.height}px over ${facts.user?.line}px lines)`);
				assert.ok(facts.links.length >= 3 && facts.links.some(link => link.target.startsWith("proven/")), `file and web links are rendered: ${where}`);
				assert.ok(facts.table.own && facts.table.scroll[0] > facts.table.scroll[1], `the wide table scrolls inside its own block: ${where} (${facts.table.scroll.join(" over ")})`);
				assert.ok(facts.fence.own && facts.fence.scroll[0] > facts.fence.scroll[1], `the long code line scrolls inside its own block: ${where} (${facts.fence.scroll.join(" over ")})`);
			});

			// Thinking and a provider error with long words and URLs.
			await show([assistant([{ type: "thinking", thinking: `Thinking about ${path} and ${word}` }, { type: "text", text: `Reasoned ${word}` }], { stopReason: "error", errorMessage: `Request failed: ${word} ${url}` })]);
			await ui.wait("document.querySelector('.omp-turn-error')");
			await atEachWidth<null>("thinking and a provider error", ".omp-turn-error", "null", () => {});

			// Tool cards, each opened: a Write line, a Bash command, an Edit diff line, a Read line and Grep matches.
			const cards: [string, string, unknown, string, unknown][] = [
				["of-write", "write", { path: "out/long.txt", content: `${"x".repeat(400)}\nshort` }, "done", {}],
				["of-bash", "bash", { command: `node ${path} --flag=${"a".repeat(200)} --other ${"b".repeat(100)}` }, `${"y".repeat(400)}\nok`, { exitCode: 0 }],
				["of-edit", "edit", { path: "src/a.ts" }, "done", { path: "src/a.ts", diff: ` 1|const a = 1;\n-2|const b = "${"o".repeat(300)}";\n+2|const b = "${"n".repeat(300)}";\n 3|let c = 3;`, firstChangedLine: 2 }],
				["of-read", "read", { path }, "done", { displayContent: { text: `${"r".repeat(400)}\nshort`, startLine: 1 } }],
				["of-grep", "grep", { pattern: word, path }, `${path}:12:${word}\n${path}:13:${"g".repeat(300)}`, {}],
			];
			for (const [id, name, args, text, details] of cards) {
				await show([toolCall(id, name, args), toolResult(id, name, text, details)]);
				await ui.wait(`document.querySelector('[data-tool-call-id="${id}"] .omp-tool-head')`);
				await ui.evaluate(`document.querySelector('[data-tool-call-id="${id}"] .omp-tool-head').click()`);
				await ui.wait(`document.querySelector('[data-tool-call-id="${id}"] .omp-tool-body')`);
				await atEachWidth<{ right: number; limit: number }>(`the ${name} card`, `[data-tool-call-id="${id}"]`,
					`({right:document.querySelector('[data-tool-call-id="${id}"] .omp-tool-head').getBoundingClientRect().right,limit:t.getBoundingClientRect().right})`,
					(facts, where) => assert.ok(facts.right <= facts.limit + 1, `the title stays in its row: ${where}`));
			}

			// The Ask dialog with long options stays inside its card and the page.
			const long = `${"An answer that goes on and on about ".repeat(3)}${word}`;
			await show([]);
			await ui.evaluate(`window.ui.push({uiRequests:[{id:'of-ask',method:'ask',title:'t',questions:[{id:'only',question:${JSON.stringify(`Which of ${path}?`)},multi:false,options:[{label:${JSON.stringify(long)},description:${JSON.stringify(`${url} ${word}`)}},{label:${JSON.stringify(path)}}]}]}],working:true,settled:false})`);
			await ui.wait("document.querySelectorAll('.omp-ask-option').length===3");
			await atEachWidth<{ card: [number, number]; outside: number }>("the Ask dialog", ".omp-ask", `(()=>{const card=document.querySelector('.omp-ask'),right=card.getBoundingClientRect().right;
			 return {card:[card.scrollWidth,card.clientWidth],outside:[...card.querySelectorAll('*')].filter(el=>el.getBoundingClientRect().right>right+1).length}})()`,
			(facts, where) => assert.ok(facts.card[0] <= facts.card[1] && facts.outside === 0, `long Ask options wrap inside the card: ${where} (${facts.card.join(" over ")}, ${facts.outside} outside)`));
			await ui.evaluate("clearInterval(window.answerLinks)");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		// Find in the conversation: the transcript is windowed, so Ctrl+F searches the model and brings the match's row into the page.
		const CTRL = 2, ALT = 1, SHIFT = 8;
		const findState = (): Promise<{ status: string; input: string; focused: boolean; note: string } | null> => ui.evaluate(`(()=>{const bar=document.querySelector('.omp-find');if(!bar)return null;
		 return{status:bar.querySelector('.omp-find-status').textContent,input:bar.querySelector('.omp-find-input').value,focused:document.activeElement===bar.querySelector('.omp-find-input'),note:bar.querySelector('.omp-find-note')?.textContent??''}})()`);
		/** The painted current match: its text, the row that holds it, whether it is inside the transcript's viewport, and how many matches are painted. */
		const findCurrent = (): Promise<{ text: string; row: string | null; visible: boolean; painted: number } | null> => ui.evaluate(`(()=>{const h=CSS.highlights.get('omp-find-current'),r=h&&[...h][0];if(!r)return null;
		 const box=r.getBoundingClientRect(),root=document.querySelector('.omp-transcript').getBoundingClientRect();
		 return{text:r.toString(),row:r.startContainer.parentElement.closest('[data-find-id]')?.dataset.findId??null,visible:box.height>0&&box.top>=root.top-1&&box.bottom<=root.bottom+1,painted:CSS.highlights.get('omp-find')?.size??0}})()`);
		/** Painting a highlight changes no DOM, so `ui.wait` (which re-checks on DOM changes) cannot see it: poll on frames. */
		const waitCurrent = (row: string): Promise<unknown> => ui.evaluate(`(async()=>{const deadline=performance.now()+15000;
		 while(performance.now()<deadline){const h=CSS.highlights.get('omp-find-current'),r=h&&[...h][0];
		  if(r&&r.startContainer.parentElement.closest('[data-find-id]')?.dataset.findId===${JSON.stringify(row)})return true;
		  await new Promise(resolve=>requestAnimationFrame(resolve))}
		 throw new Error('the current match was not painted in row '+${JSON.stringify(row)})})()`);
		const popupReports = (): Promise<boolean[]> => ui.evaluate("window.sent.filter(message=>message.type==='omp:composer-popup').map(message=>message.open)");

		await t.test("Ctrl+F searches the whole loaded conversation, not the rows in the page: a match in an unmounted row is loaded, scrolled to and painted, Enter and Shift+Enter wrap, the count follows, Esc closes and returns the focus", async () => {
			await reset("find-long");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const entries=[];
			 for(let index=0;index<600;index++){
			  if(index%2===0)entries.push(row('u'+index,{role:'user',timestamp:1000+index,content:index===300?'Where does the zebrafish live?':'Prompt '+index}));
			  else entries.push(row('a'+index,{role:'assistant',model:'m',timestamp:1000+index,stopReason:'stop',content:[{type:'text',text:'Reply '+index+(index===21?' with a **zebrafish** in bold':index===589?' with a late zebrafish':'')+'\\n\\n'+'Plain filler prose for the reply. '.repeat(6)}]}));
			 }
			 window.ui.push({entries,durableCount:entries.length,working:false,settled:true,olderCount:0});
			})()`);
			await ui.wait("document.querySelector('.omp-transcript').scrollHeight>5000 && document.querySelector('[data-find-id=\"a589\"]')");
			await ui.settleGeometry(".omp-transcript");
			assert.equal(await ui.evaluate("document.querySelector('[data-find-id=\"a21\"]')"), null, "the early reply is not in the page");
			assert.equal(await ui.evaluate("document.querySelector('.omp-find')"), null, "no find bar until it is asked for");
			await ui.evaluate("window.composer.focus()");
			await press("f", "KeyF", 70, { modifiers: CTRL });
			await ui.wait("document.querySelector('.omp-find')");
			assert.equal((await findState())?.focused, true, "the bar's field has the focus");
			assert.equal(await popupReports().then(reports => reports.at(-1)), true, "while the field has the focus the host's stop-turn key is disarmed");
			await ui.call("Input.insertText", { text: "zebrafish" });
			await ui.wait("document.querySelector('.omp-find-status').textContent==='3 of 3'");
			await waitCurrent("a589");
			await ui.settleGeometry(".omp-transcript");
			assert.deepEqual(await findCurrent().then(match => match === null ? null : { text: match.text, row: match.row, visible: match.visible }), { text: "zebrafish", row: "a589", visible: true }, "the search starts at the newest match, painted and on screen");
			assert.ok((await findCurrent())!.painted >= 1);

			// Next from the last wraps to the first: a reply 570 rows up, not mounted until now; its bold word is found as it reads.
			await press("Enter", "Enter", 13);
			await ui.wait("document.querySelector('.omp-find-status').textContent==='1 of 3'");
			await waitCurrent("a21");
			await ui.settleGeometry(".omp-transcript");
			assert.deepEqual(await findCurrent().then(match => match === null ? null : { text: match.text, row: match.row, visible: match.visible }), { text: "zebrafish", row: "a21", visible: true }, "the unmounted row is loaded, scrolled to and its match painted");
			assert.equal(await ui.evaluate("Boolean(document.querySelector('.omp-jump-latest'))"), true, "the reader is detached from the tail, as after any jump");

			await press("Enter", "Enter", 13, { modifiers: SHIFT });
			await ui.wait("document.querySelector('.omp-find-status').textContent==='3 of 3'");
			await waitCurrent("a589");
			await press("Enter", "Enter", 13, { modifiers: SHIFT });
			await ui.wait("document.querySelector('.omp-find-status').textContent==='2 of 3'");
			await waitCurrent("u300");
			await press("F3", "F3", 114);
			await ui.wait("document.querySelector('.omp-find-status').textContent==='3 of 3'");
			await press("F3", "F3", 114, { modifiers: SHIFT });
			await ui.wait("document.querySelector('.omp-find-status').textContent==='2 of 3'");

			// A query is literal and case-insensitive until Match Case (Alt+C) is on.
			await press("a", "KeyA", 65, { modifiers: CTRL });
			await ui.call("Input.insertText", { text: "ZEBRA.ISH" });
			await ui.wait("document.querySelector('.omp-find-status').textContent==='No results'");
			await press("a", "KeyA", 65, { modifiers: CTRL });
			await ui.call("Input.insertText", { text: "ZEBRAFISH" });
			await ui.wait("document.querySelector('.omp-find-status').textContent==='3 of 3'");
			await press("c", "KeyC", 67, { modifiers: ALT });
			await ui.wait("document.querySelector('.omp-find-status').textContent==='No results' && document.querySelector('[aria-label=\"Match case\"]').getAttribute('aria-pressed')==='true'");
			await press("c", "KeyC", 67, { modifiers: ALT });
			await ui.wait("document.querySelector('.omp-find-status').textContent==='3 of 3'");

			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-find')");
			assert.equal(await ui.evaluate("window.composer.focused()"), true, "Escape returns the focus to where it was");
			assert.equal(await ui.evaluate("CSS.highlights.has('omp-find')||CSS.highlights.has('omp-find-current')"), false, "nothing stays painted");
			assert.equal(await popupReports().then(reports => reports.at(-1)), false, "the stop-turn key is armed again");
			await press("F3", "F3", 114);
			await settleFrames();
			assert.equal(await ui.evaluate("document.querySelector('.omp-find')"), null, "F3 does nothing while the bar is closed");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("Find opens what hides a match: a thinking block, a collapsed call's output and its group; it names the earlier messages it does not search, and a selection seeds the field", async () => {
			await reset("find-hidden");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const entries=[
			  row('u1',{role:'user',timestamp:1,content:'Tell me about the quokka'}),
			  row('a1',{role:'assistant',model:'m',timestamp:2,stopReason:'toolUse',content:[{type:'thinking',thinking:'Considering what a quokka is'},{type:'toolCall',id:'t1',name:'bash',arguments:{command:'echo hi'}}]}),
			  row('r1',{role:'toolResult',toolCallId:'t1',toolName:'bash',timestamp:3,isError:false,content:[{type:'text',text:'the quokka output line\\nsecond line'}]}),
			  row('a2',{role:'assistant',model:'m',timestamp:4,stopReason:'stop',content:[{type:'text',text:'Done.'}]}),
			 ];
			 window.ui.push({entries,durableCount:4,working:false,settled:true,olderCount:3});
			})()`);
			await ui.wait("document.querySelector('[data-find-id=\"a2\"]')");
			assert.equal(await ui.evaluate("Boolean(document.querySelector('.omp-thinking .omp-md'))"), false, "the thinking block is closed");
			assert.equal(await ui.evaluate("Boolean(document.querySelector('[data-tool-call-id=\"t1\"] .omp-tool-body'))"), false, "the call's output is closed");
			await ui.evaluate("window.ui.receive({type:'omp:webview-action',action:'find-in-chat'})");
			await ui.wait("document.querySelector('.omp-find')");
			assert.equal((await findState())?.focused, true, "the host's Find in Chat command opens the same bar");
			await ui.call("Input.insertText", { text: "quokka" });
			await ui.wait("document.querySelector('.omp-find-status').textContent==='3 of 3'");
			assert.equal((await findState())?.note, "3 earlier messages are not loaded.", "the bar says what it did not search");

			// The newest match is in the output of a call that is closed (and may sit in a collapsed group): both open.
			await ui.wait("document.querySelector('[data-tool-call-id=\"t1\"] .omp-tool-body')");
			await waitCurrent("call:t1");
			assert.equal((await findCurrent())?.text, "quokka");
			assert.equal(await ui.evaluate("Boolean(document.querySelector('[data-tool-call-id=\"t1\"]')?.closest('[data-find-id]')?.querySelector('.omp-tool-body'))"), true);

			// The one before it is thinking: the block opens to show it.
			await press("Enter", "Enter", 13, { modifiers: SHIFT });
			await ui.wait("document.querySelector('.omp-find-status').textContent==='2 of 3'");
			await waitCurrent("a1");
			assert.equal(await ui.evaluate("Boolean(document.querySelector('details.omp-thinking[open] .omp-md'))"), true, "the thinking block is open");
			assert.equal((await findCurrent())?.text, "quokka");
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-find')");

			// A text selection in the transcript seeds the field.
			await ui.evaluate("(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('[data-find-id=\"u1\"] .omp-md'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range)})()");
			await press("f", "KeyF", 70, { modifiers: CTRL });
			await ui.wait("document.querySelector('.omp-find-input')?.value==='Tell me about the quokka'");
			await ui.wait("document.querySelector('.omp-find-status').textContent==='1 of 1'");
			await waitCurrent("u1");
			// A second Ctrl+F, and the host's keybinding that follows the same press, leave the focused field's text and caret alone.
			await ui.evaluate("document.querySelector('.omp-find-input').setSelectionRange(4,4)");
			await press("f", "KeyF", 70, { modifiers: CTRL });
			await ui.evaluate("window.ui.receive({type:'omp:webview-action',action:'find-in-chat'})");
			await settleFrames();
			assert.deepEqual(await ui.evaluate("(()=>{const input=document.querySelector('.omp-find-input');return[input.value,input.selectionStart,input.selectionEnd,document.activeElement===input]})()"), ["Tell me about the quokka", 4, 4, true], "nothing reselected under the reader's caret");
			// Alt+C on a Cyrillic layout is the same key: the character is "с", the physical key is C.
			await press("с", "KeyC", 67, { modifiers: ALT });
			await ui.wait("document.querySelector('[aria-label=\"Match case\"]').getAttribute('aria-pressed')==='true'");
			await press("с", "KeyC", 67, { modifiers: ALT });
			await ui.wait("document.querySelector('[aria-label=\"Match case\"]').getAttribute('aria-pressed')==='false'");
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-find')");
			// Ctrl+F on a Cyrillic layout: the key is "а", the physical key is F, and VS Code reads it as Ctrl+F.
			await press("а", "KeyF", 70, { modifiers: CTRL });
			await ui.wait("document.querySelector('.omp-find-input')");
			assert.equal((await findState())?.focused, true, "the bar opens on a layout that types another script");
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-find')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("in accessible paged history Find shows the page that holds the match", async () => {
			await reset("find-paged", "overview", true);
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const entries=Array.from({length:250},(_,index)=>index%2===0
			  ?row('u'+index,{role:'user',timestamp:1000+index,content:'Prompt '+index})
			  :row('a'+index,{role:'assistant',model:'m',timestamp:1000+index,stopReason:'stop',content:[{type:'text',text:'Reply '+index+(index===11||index===249?' mentions the zebrafish':'')}]}));
			 window.ui.push({entries,durableCount:250,working:false,settled:true,olderCount:0});
			})()`);
			await ui.wait("document.querySelector('[data-find-id=\"a249\"]')");
			assert.equal(await ui.evaluate("document.querySelector('[data-find-id=\"a11\"]')"), null, "the early reply is on another page");
			await ui.evaluate("window.composer.focus()");
			await press("f", "KeyF", 70, { modifiers: CTRL });
			await ui.wait("document.querySelector('.omp-find')");
			await ui.call("Input.insertText", { text: "zebrafish" });
			await ui.wait("document.querySelector('.omp-find-status').textContent==='2 of 2'");
			await press("Enter", "Enter", 13);
			await ui.wait("document.querySelector('.omp-find-status').textContent==='1 of 2'");
			await waitCurrent("a11");
			assert.equal((await findCurrent())?.text, "zebrafish");
			await press("Escape", "Escape", 27);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("during a streaming turn Escape on a bar button closes the bar and the stop-turn key stays disarmed; the reply being written is read once it is complete", async () => {
			await reset("find-streaming");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 window.findLive=text=>({role:'assistant',model:'m',timestamp:3000,stopReason:'stop',content:[{type:'text',text}]});
			 const entries=[row('u1',{role:'user',timestamp:1,content:'Tell me about the quokka'}),row('a1',{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:'The quokka is a small wallaby.'}]})];
			 window.findEntries=entries;
			 window.ui.push({entries,durableCount:2,working:true,settled:false,stream:{messageId:'live-find',message:window.findLive('quokka being written')},streamPosition:{anchorId:null,seq:1}});
			})()`);
			await ui.wait("document.querySelector('[data-find-id=\"a1\"]')");
			await ui.evaluate("window.composer.focus()");
			await press("f", "KeyF", 70, { modifiers: CTRL });
			await ui.wait("document.querySelector('.omp-find')");
			await ui.call("Input.insertText", { text: "quokka" });
			await ui.wait("document.querySelector('.omp-find-status').textContent==='2 of 2'");
			// The reply being written is not read per delta: more matches in it change nothing until it is complete.
			await ui.evaluate("window.ui.push({stream:{messageId:'live-find',message:window.findLive('quokka being written, quokka again, and a quokka more')}})");
			await settleFrames();
			assert.equal(await ui.evaluate("document.querySelector('.omp-find-status').textContent"), "2 of 2", "the streaming reply is not searched");
			assert.equal(await ui.evaluate("document.querySelector('.omp-find')!==null"), true);

			// Focus on a button of the bar: Escape is still the bar's, never the turn's.
			await ui.evaluate("document.querySelector('[aria-label=\"Next match\"]').focus()");
			await settleFrames();
			assert.equal(await ui.evaluate("document.activeElement.getAttribute('aria-label')"), "Next match");
			assert.equal(await popupReports().then(reports => reports.at(-1)), true, "with a bar button focused the host's stop-turn key is still disarmed");
			await press("Escape", "Escape", 27);
			await ui.wait("!document.querySelector('.omp-find')");
			assert.equal(await popupReports().then(reports => reports.at(-1)), false, "closed: the stop-turn key is armed again");
			assert.equal(await ui.evaluate("window.sent.filter(message=>message.type==='omp:chat-abort').length"), 0, "the turn was not stopped");

			// Once the reply is complete it is searched like any other.
			await ui.evaluate(`window.ui.push({stream:null,working:false,settled:true,entries:[...window.findEntries,{type:'message',id:'a2',parentId:null,timestamp:new Date(3000).toISOString(),message:window.findLive('quokka being written, quokka again, and a quokka more')}],durableCount:3})`);
			await ui.wait("document.querySelector('[data-find-id=\"a2\"]')");
			await ui.evaluate("window.composer.focus()");
			await press("f", "KeyF", 70, { modifiers: CTRL });
			await ui.wait("document.querySelector('.omp-find-status').textContent==='5 of 5'");
			await press("Escape", "Escape", 27);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the query is searched once typing pauses: the field keeps what was typed, Enter searches at once, and the status follows the searched query", async () => {
			await reset("find-debounce");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 window.ui.push({entries:[row('u1',{role:'user',timestamp:1,content:'A quokka and a numbat'}),row('a1',{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:'Numbat facts. Numbat again.'}]})],durableCount:2,working:false,settled:true,olderCount:0});
			})()`);
			await ui.wait("document.querySelector('[data-find-id=\"a1\"]')");
			await ui.evaluate("window.composer.focus()");
			await press("f", "KeyF", 70, { modifiers: CTRL });
			await ui.wait("document.querySelector('.omp-find-input')");
			// Typed and read back within two frames, well inside the pause: the field has the text, nothing has been searched yet.
			const early = await ui.evaluate<{ value: string; status: string }>(`(async()=>{
			 const input=document.querySelector('.omp-find-input');
			 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'quokka');input.dispatchEvent(new Event('input',{bubbles:true}));
			 for(let frame=0;frame<2;frame++)await new Promise(resolve=>requestAnimationFrame(resolve));
			 return{value:input.value,status:document.querySelector('.omp-find-status').textContent}})()`);
			assert.deepEqual(early, { value: "quokka", status: "" }, "no search per keystroke");
			await ui.wait("document.querySelector('.omp-find-status').textContent==='1 of 1'");
			// A new query whose Enter comes before the pause is searched by that Enter instead of stepping the old one.
			const flushed = await ui.evaluate<string>(`(async()=>{
			 const input=document.querySelector('.omp-find-input');
			 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'numbat');input.dispatchEvent(new Event('input',{bubbles:true}));
			 await new Promise(resolve=>requestAnimationFrame(resolve));
			 input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true,cancelable:true}));
			 for(let frame=0;frame<4;frame++)await new Promise(resolve=>requestAnimationFrame(resolve));
			 return document.querySelector('.omp-find-status').textContent})()`);
			assert.equal(flushed, "3 of 3", "Enter searches the field's text before the pause is over");
			await ui.wait("document.querySelector('.omp-find-status').textContent==='3 of 3'");
			assert.equal(await ui.evaluate("document.querySelector('.omp-find-input').value"), "numbat");
			await press("Escape", "Escape", 27);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the current match's thinking block and tool output reopen when its row comes back after scrolling away, unless the reader collapsed them by hand; the next jump opens them again", async () => {
			await reset("find-remount");
			await ui.evaluate(`(()=>{
			 const row=(id,message)=>({type:'message',id,parentId:null,timestamp:new Date(1000).toISOString(),message});
			 const entries=[];
			 for(let index=0;index<600;index++){
			  if(index%2===0)entries.push(row('u'+index,{role:'user',timestamp:1000+index,content:'Prompt '+index}));
			  else if(index===21)entries.push(row('a21',{role:'assistant',model:'m',timestamp:1021,stopReason:'stop',content:[{type:'thinking',thinking:'Pondering the zebrafish at length'},{type:'text',text:'Reply 21 plain'}]}));
			  else if(index===101){
			   entries.push(row('a101',{role:'assistant',model:'m',timestamp:1101,stopReason:'toolUse',content:[{type:'toolCall',id:'t1',name:'bash',arguments:{command:'echo hi'}}]}));
			   entries.push(row('r101',{role:'toolResult',toolCallId:'t1',toolName:'bash',timestamp:1102,isError:false,content:[{type:'text',text:'the zebrafish output line'}]}));
			  }
			  else entries.push(row('a'+index,{role:'assistant',model:'m',timestamp:1000+index,stopReason:'stop',content:[{type:'text',text:'Reply '+index+'\\n\\n'+'Plain filler prose for the reply. '.repeat(6)}]}));
			 }
			 window.ui.push({entries,durableCount:entries.length,working:false,settled:true,olderCount:0});
			})()`);
			await ui.wait("document.querySelector('.omp-transcript').scrollHeight>5000 && document.querySelector('[data-find-id=\"a599\"]')");
			await ui.settleGeometry(".omp-transcript");
			await ui.evaluate("window.composer.focus()");
			await press("f", "KeyF", 70, { modifiers: CTRL });
			await ui.wait("document.querySelector('.omp-find')");
			await ui.call("Input.insertText", { text: "zebrafish" });
			await ui.wait("document.querySelector('.omp-find-status').textContent==='2 of 2'");
			const thinkingOpen = "Boolean(document.querySelector('[data-find-id=\"a21\"] details.omp-thinking[open] .omp-md'))";
			const outputOpen = "Boolean(document.querySelector('[data-find-id=\"call:t1\"] .omp-tool-body'))";
			const mounted = (id: string): string => `Boolean(document.querySelector('[data-find-id=${JSON.stringify(id)}]'))`;
			/** Wheels down until the row is unmounted, then back up until it is mounted again: the way a reader scrolls it out of the list and back. */
			const awayAndBack = async (id: string): Promise<void> => {
				const point = await ui.evaluate<{ x: number; y: number }>("(()=>{const r=document.querySelector('.omp-transcript').getBoundingClientRect();return{x:r.left+100,y:r.top+100}})()");
				const wheel = async (deltaY: number): Promise<void> => {
					await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY });
					// Native wheel intent uses the platform clock, outside the fixture's fake interval clock.
					await ui.evaluate("(()=>{const {promise,resolve}=Promise.withResolvers();setTimeout(resolve,650);return promise})()");
					await ui.settleGeometry(".omp-transcript");
				};
				await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
				await wheel(9000);
				await ui.wait(`!${mounted(id)}`);
				await wheel(-9000);
				await ui.wait(mounted(id));
				await ui.settleGeometry(".omp-transcript");
				await settleFrames();
			};

			// The newest match is the call's output: opened by the jump, still open when its row comes back.
			await waitCurrent("call:t1");
			await ui.wait(outputOpen);
			await awayAndBack("call:t1");
			assert.equal(await ui.evaluate(outputOpen), true, "the output is open after its row came back");

			// Collapsed by hand: it stays collapsed when the row comes back.
			await ui.evaluate("document.querySelector('[data-find-id=\"call:t1\"] .omp-tool-head').click()");
			await ui.wait(`!${outputOpen}`);
			await settleFrames();
			await awayAndBack("call:t1");
			assert.equal(await ui.evaluate(outputOpen), false, "a block the reader collapsed stays collapsed");

			// The thinking block holds the other match: opened by the jump, reopened when the row comes back.
			await press("Enter", "Enter", 13);
			await ui.wait("document.querySelector('.omp-find-status').textContent==='1 of 2'");
			await waitCurrent("a21");
			assert.equal(await ui.evaluate(thinkingOpen), true, "the jump opened the thinking block");
			await awayAndBack("a21");
			await ui.wait(thinkingOpen);
			assert.equal(await ui.evaluate("document.querySelectorAll('[data-find-id=\"a21\"] details.omp-thinking').length"), 1);

			// Collapsed by hand: it stays closed through another trip.
			await ui.evaluate("document.querySelector('[data-find-id=\"a21\"] details.omp-thinking > summary').click()");
			await ui.wait(`!${thinkingOpen}`);
			await settleFrames();
			await awayAndBack("a21");
			await settleFrames();
			assert.equal(await ui.evaluate("Boolean(document.querySelector('[data-find-id=\"a21\"] details.omp-thinking[open]'))"), false, "the collapsed thinking block stays closed");

			// A new jump clears the flag: Enter to the call and Enter back to the thinking opens each again.
			await press("Enter", "Enter", 13);
			await ui.wait("document.querySelector('.omp-find-status').textContent==='2 of 2'");
			await ui.wait(outputOpen);
			await press("Enter", "Enter", 13);
			await ui.wait("document.querySelector('.omp-find-status').textContent==='1 of 2'");
			await ui.wait(thinkingOpen);
			await press("Escape", "Escape", 27);
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
