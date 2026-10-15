/** Mermaid blocks in Chat, drawn by the real React app and the real lazily loaded renderer in an owned headless Chromium under the guest document's own policy. */
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
import { mermaidBuildOptions, mermaidPreviewBuildOptions } from "../../scripts/mermaid-bundle.mjs";
import { createGuestHtml, createMermaidPreviewHtml } from "../host/guest-webview.ts";
import { mermaidSourceRefusal } from "./mermaid/contract.ts";
import { THEMES } from "./theme-ui-fixtures.ts";

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
		 timer=setTimeout(()=>{cleanup();reject(new Error('render condition timed out: '+${JSON.stringify(expression)}))},30000);
		 check(); await promise;
		})()`);
	}
	/** Two frames and a task: whatever the page had queued to start (a render, a script load) has started or never will. */
	async settle(): Promise<void> {
		await this.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))))");
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
};
const nonce=readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); push();
`;

/** The chat page's variables in one captured VS Code theme, as the Webview would define them on `<html>`. */
function themeRules(name: string): string {
	const theme = THEMES.find(candidate => candidate.name === name);
	assert.ok(theme, name);
	const tokens = { "--vscode-editor-background": theme.tokens["--vscode-editor-background"], "--vscode-editor-foreground": theme.tokens["--vscode-foreground"], ...theme.tokens };
	return Object.entries(tokens).filter(([, value]) => value !== "").map(([key, value]) => `${key}:${value}`).join(";");
}

const FLOWCHART = "flowchart TD\n  A[Start] --> B{Is it ready?}\n  B -->|Yes| C[Ship it]\n  B -->|No| D[Keep going]";
const SEQUENCE = "sequenceDiagram\n  participant Alice\n  Alice->>Bob: Hello Bob\n  Bob-->>Alice: Hi Alice";

const reply = (text: string): string => `window.ui.push({entries:[{type:'message',id:'reply',parentId:null,timestamp:'2026-10-13T00:00:00.000Z',message:{role:'assistant',model:'m',timestamp:2,stopReason:'stop',content:[{type:'text',text:${JSON.stringify(text)}}]}}],durableCount:1,working:false,settled:true})`;
const fence = (source: string, closed = true): string => (closed ? `Here:\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nDone.` : `Here:\n\n\`\`\`mermaid\n${source}`);

// Skipped when no Chromium-based browser is found; set OMP_TEST_CHROMIUM to point at one.
test("mermaid blocks in Chat", { skip: browserPath === undefined, timeout: 240_000 }, async t => {
	const bundled = await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") },
		bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' } });
	const script = bundled.outputFiles[0]!.text;
	// The renderer exactly as `npm run build` makes it (same options module), kept in memory.
	const renderer = await build({ ...mermaidBuildOptions, write: false, minify: true, legalComments: "none", logLevel: "silent" });
	const rendererScript = renderer.outputFiles[0]!.text;
	// The diagram tab's own page script, as built for the package.
	const previewScript = (await build({ ...mermaidPreviewBuildOptions, write: false, logLevel: "silent" })).outputFiles[0]!.text;
	let rendererHits = 0;
	let rendererStatus = 200;
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
		if (pathname === "/preview.js") {
			response.setHeader("Content-Type", "text/javascript"); response.end(previewScript); return;
		}
		if (pathname === "/mermaid.js") {
			rendererHits++;
			response.statusCode = rendererStatus;
			response.setHeader("Content-Type", "text/javascript");
			response.end(rendererStatus === 200 ? rendererScript : "missing");
			return;
		}
		response.setHeader("Content-Type", "text/html");
		const isPreview = pathname === "/preview";
		const webview = {
			cspSource: "'self'",
			asWebviewUri: (uri: { path: string }) => ({ toString: () => uri.path.endsWith("/mermaid.js") ? "/mermaid.js" : uri.path.endsWith("/mermaid-preview.js") ? "/preview.js" : uri.path.endsWith(".js") ? "/ui.js" : "/codicons/codicon.css" }),
		} as unknown as vscode.Webview;
		const extensionUri = {
			path: "/extension", with({ path }: { path: string }) { return { path }; },
		} as unknown as vscode.Uri;
		const html = isPreview ? createMermaidPreviewHtml(webview, extensionUri) : createGuestHtml(webview, extensionUri, "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d", null);
		const nonce = /<script nonce="([^"]+)"/.exec(html)![1]!;
		response.end(html.replace("</head>", `<style nonce="${nonce}">:root{${themeRules("Dark Modern")};--vscode-font-family:Arial;--vscode-font-size:13px;--vscode-editor-font-family:Consolas, "Courier New", monospace}</style>
		<script nonce="${nonce}">window.sent=[];window.errors=[];window.violations=[];window.alerted=false;window.alert=()=>{window.alerted=true};
		window.addEventListener("error",event=>window.errors.push(event.message));
		document.addEventListener("securitypolicyviolation",event=>window.violations.push(event.violatedDirective+" "+event.blockedURI));
		window.acquireVsCodeApi=()=>({postMessage(message){window.sent.push(message);document.dispatchEvent(new Event("fixture-post"))},setState(){}});</script>
		</head>`));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/`;
	const profile = await mkdtemp(join(tmpdir(), "omp-mermaid-ui-"));
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
		const target = await browser.call("Target.createTarget", { url: "about:blank" });
		const targets = await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json() as { id: string; webSocketDebuggerUrl: string }[];
		page = await Cdp.connect(targets.find(row => row.id === target.targetId)!.webSocketDebuggerUrl);
		const ui = page;
		await ui.call("Page.enable");
		await ui.call("Emulation.setDeviceMetricsOverride", { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
		async function open(name: string): Promise<void> {
			rendererHits = 0;
			rendererStatus = 200;
			const loaded = ui.event("Page.loadEventFired");
			await ui.call("Page.navigate", { url: `${url}?${name}` });
			await loaded;
			await ui.wait(`window.ui?.token === '?${name}' && document.querySelector('#root').firstElementChild`);
		}
		async function openPreview(name: string): Promise<void> {
			rendererHits = 0;
			rendererStatus = 200;
			const loaded = ui.event("Page.loadEventFired");
			await ui.call("Page.navigate", { url: `${url}preview?${name}` });
			await loaded;
			await ui.wait("window.sent.some(message=>message.type==='omp:mermaid-preview-ready') && document.querySelector('.bar')");
		}
		/** What the host does once the tab says it listens: send the source. */
		const sendSource = (source: string): Promise<unknown> => ui.evaluate(`window.dispatchEvent(new MessageEvent('message',{data:{type:'omp:mermaid-preview-source',source:${JSON.stringify(source)}}}))`);
		/** The SVG a drawn block shows, parsed in the page: its text and every tag and attribute it carries. */
		// The image is parsed here only to be read. Its `<style>` text is taken out first and counted as text: the page's policy would
		// (rightly) refuse a nonce-less inline style in the page's own document, and the image never needs it there.
		const svgFacts = (selector = ".omp-mermaid img") => ui.evaluate<{ text: string; tags: string[]; attributes: string[]; width: number }>(`(()=>{
		 const src=document.querySelector(${JSON.stringify(selector)}).src; const raw=decodeURIComponent(src.slice(src.indexOf(',')+1));
		 const styles=[...raw.matchAll(/<style\\b[^>]*>([\\s\\S]*?)<\\/style>/g)].map(match=>match[1]).join('\\n');
		 const doc=new DOMParser().parseFromString(raw.replace(/<style\\b[^>]*>[\\s\\S]*?<\\/style>/g,''),'image/svg+xml');
		 const tags=[...doc.querySelectorAll('*')].map(element=>element.localName.toLowerCase());
		 const attributes=[...doc.querySelectorAll('*')].flatMap(element=>[...element.attributes].map(attribute=>attribute.name.toLowerCase()+'='+attribute.value));
		 return {text:doc.documentElement.textContent+styles,tags,attributes,width:Number(document.querySelector(${JSON.stringify(selector)}).getAttribute('width'))};
		})()`);
		const clean = async (): Promise<void> => {
			// A policy violation is reported in a task of its own: let anything queued run before reading.
			await ui.settle();
			assert.deepEqual(await ui.evaluate("window.errors"), []);
			assert.deepEqual(await ui.evaluate("window.violations"), [], "the document's policy refused nothing");
			assert.equal(await ui.evaluate("window.alerted"), false);
		};

		await t.test("a transcript without a mermaid block never requests the renderer", async () => {
			await open("no-mermaid");
			await ui.evaluate(reply("Code:\n\n```ts\nconst a = 1;\n```\n\n```mermaidish\nnot mermaid\n```\n\nDone."));
			await ui.wait("document.querySelectorAll('.omp-md pre code').length===2");
			await ui.settle();
			assert.equal(rendererHits, 0, "the renderer file was not requested");
			assert.equal(await ui.evaluate("'ompMermaid' in window"), false);
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid')"), null);
			await clean();
		});

		await t.test("a closed flowchart and sequence diagram are drawn as SVG images, the renderer loads once and nothing is refused by the policy", async () => {
			await open("draw");
			await ui.evaluate(reply(`${fence(FLOWCHART)}\n\nand\n\n\`\`\`mermaid\n${SEQUENCE}\n\`\`\``));
			await ui.wait("document.querySelectorAll('.omp-mermaid--drawn img').length===2");
			assert.equal(await ui.evaluate("[...document.querySelectorAll('.omp-mermaid img')].every(img=>img.complete&&img.naturalWidth>0&&img.src.startsWith('data:image/svg+xml'))"), true);
			const flow = await svgFacts();
			assert.ok(flow.tags.includes("svg") && flow.tags.includes("path"));
			for (const label of ["Start", "Is it ready?", "Ship it", "Keep going", "Yes", "No"]) assert.ok(flow.text.includes(label), `flowchart label ${label}`);
			const all = await ui.evaluate<string[]>("[...document.querySelectorAll('.omp-mermaid img')].map(img=>decodeURIComponent(img.src.slice(img.src.indexOf(',')+1)))");
			assert.ok(all.some(svg => svg.includes("Hello Bob") && svg.includes("Alice")), "the sequence diagram's messages and actors");
			assert.ok(all.every(svg => !/foreignObject/.test(svg)), "no HTML labels");
			assert.equal(rendererHits, 1, "one request for both diagrams");
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid-note')"), null);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-mermaid .omp-code-block').length"), 0, "the code is replaced, not shown beside the diagram");
			await clean();
		});

		await t.test("a broken diagram and an unknown type stay code with one muted line saying why", async () => {
			await open("broken");
			await ui.evaluate(reply(`${fence("flowchart TD\n  A --> ")}\n\nthen\n\n\`\`\`mermaid\nbogusDiagram\n  x\n\`\`\``));
			await ui.wait("document.querySelectorAll('.omp-mermaid-note').length===2");
			const notes = await ui.evaluate<string[]>("[...document.querySelectorAll('.omp-mermaid-note')].map(note=>note.textContent)");
			assert.match(notes[0]!, /^Diagram not rendered: Parse error on line \d+$/);
			assert.match(notes[1]!, /^Diagram not rendered: No diagram type detected/);
			assert.ok(notes.every(note => !note.includes("\n") && note.length <= 200), "one line each");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-mermaid .omp-code-block pre code').length"), 2, "both stay readable code");
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid code').textContent"), "flowchart TD\n  A --> ");
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid img')"), null);
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid-bar')"), null, "nothing to toggle");
			assert.equal(await ui.evaluate("document.body.textContent.includes('omp-mermaid-')"), false);
			assert.equal(await ui.evaluate("document.querySelectorAll('body > [id^=domp-mermaid], body > [id^=omp-mermaid]').length"), 0, "a failed render leaves nothing in the page");
			await clean();
		});

		await t.test("Diagram | Source toggles the view, Copy copies the source, and the choice survives a remount", async () => {
			await open("toggle");
			await ui.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(text){window.copied=text}}})");
			await ui.evaluate(reply(fence(FLOWCHART)));
			await ui.wait("document.querySelector('.omp-mermaid--drawn img')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid-tab[aria-pressed=true]').textContent"), "Diagram");
			await ui.evaluate("document.querySelector('.omp-mermaid-copy').click()");
			await ui.wait("window.copied!==undefined");
			assert.equal(await ui.evaluate("window.copied"), FLOWCHART, "the source, not the SVG");
			await ui.evaluate("[...document.querySelectorAll('.omp-mermaid-tab')].find(tab=>tab.textContent==='Source').click()");
			await ui.wait("!document.querySelector('.omp-mermaid img') && document.querySelector('.omp-mermaid pre code')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid pre code').textContent"), FLOWCHART);
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid-tab[aria-pressed=true]').textContent"), "Source");
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-mermaid .omp-copy-button').length"), 1, "one Copy, in the toolbar");
			await ui.evaluate("window.copied=undefined;document.querySelector('.omp-mermaid-copy').click()");
			await ui.wait("window.copied!==undefined");
			assert.equal(await ui.evaluate("window.copied"), FLOWCHART);
			// The transcript unmounts rows and mounts them again; the reader's choice stays.
			await ui.evaluate("window.ui.push({entries:[],durableCount:0})");
			await ui.wait("!document.querySelector('.omp-mermaid')");
			await ui.evaluate(reply(fence(FLOWCHART)));
			await ui.wait("document.querySelector('.omp-mermaid pre code')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid img')"), null);
			await ui.evaluate("[...document.querySelectorAll('.omp-mermaid-tab')].find(tab=>tab.textContent==='Diagram').click()");
			await ui.wait("document.querySelector('.omp-mermaid--drawn img')");
			await clean();
		});

		await t.test("a block still being written shows its source and loads nothing; it is drawn when the closing fence arrives", async () => {
			await open("streaming");
			await ui.evaluate(reply(fence("flowchart TD\n  A --> B", false)));
			await ui.wait("document.querySelector('.omp-md pre code')?.textContent==='flowchart TD\\n  A --> B'");
			await ui.settle();
			assert.equal(rendererHits, 0, "an open block does not load the renderer");
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid img')"), null);
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid-bar')"), null);
			await ui.evaluate(reply(fence("flowchart TD\n  A --> B\n  B --> C", false)));
			await ui.wait("document.querySelector('.omp-md pre code').textContent.endsWith('B --> C')");
			assert.equal(rendererHits, 0, "still open, still source");
			await ui.evaluate(reply(fence("flowchart TD\n  A --> B\n  B --> C")));
			await ui.wait("document.querySelector('.omp-mermaid--drawn img')");
			assert.equal(rendererHits, 1);
			await clean();
		});

		await t.test("a diagram is drawn once per source and theme: a remount reads the cache, another theme draws again and the first is cached", async () => {
			await open("cache");
			await ui.evaluate(reply(fence(FLOWCHART)));
			await ui.wait("document.querySelector('.omp-mermaid--drawn img')");
			await ui.evaluate("window.renderCalls=0;const renderer=window.ompMermaid,original=renderer.render;renderer.render=(...args)=>{window.renderCalls++;return original(...args)}");
			const dark = await ui.evaluate<string>("document.querySelector('.omp-mermaid img').src");
			// A remount paints the image in its first render, with no gap and no new draw.
			await ui.evaluate("window.ui.push({entries:[],durableCount:0})");
			await ui.wait("!document.querySelector('.omp-mermaid')");
			await ui.evaluate(`${reply(fence(FLOWCHART))};window.firstPaint=null;new MutationObserver((records,observer)=>{const img=document.querySelector('.omp-mermaid img');if(img){window.firstPaint=img.src;observer.disconnect()}}).observe(document.body,{childList:true,subtree:true})`);
			await ui.wait("window.firstPaint!==null");
			assert.equal(await ui.evaluate("window.firstPaint"), dark, "the first paint of the remounted block is the diagram");
			assert.equal(await ui.evaluate("window.renderCalls"), 0);
			// Another theme: drawn again, and the previous one stays until it is ready.
			const light = themeRules("Light Modern");
			await ui.evaluate(`document.body.className='vscode-light';for(const rule of ${JSON.stringify(light)}.split(';')){const at=rule.indexOf(':');document.documentElement.style.setProperty(rule.slice(0,at),rule.slice(at+1))}`);
			await ui.wait("window.renderCalls===1 && document.querySelector('.omp-mermaid img').src!==" + JSON.stringify(dark));
			const drawnLight = await ui.evaluate<string>("document.querySelector('.omp-mermaid img').src");
			assert.notEqual(drawnLight, dark);
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-mermaid img').length"), 1);
			// Back to the first theme: its diagram is still cached.
			const darkRules = themeRules("Dark Modern");
			await ui.evaluate(`document.body.className='vscode-dark';for(const rule of ${JSON.stringify(darkRules)}.split(';')){const at=rule.indexOf(':');document.documentElement.style.setProperty(rule.slice(0,at),rule.slice(at+1))}`);
			await ui.wait("document.querySelector('.omp-mermaid img').src===" + JSON.stringify(dark));
			assert.equal(await ui.evaluate("window.renderCalls"), 1, "the dark diagram came from the cache");
			await clean();
		});

		await t.test("a wide diagram is scaled to the block and opens full size on click, then fits again", async () => {
			await open("wide");
			const wide = `flowchart LR\n${Array.from({ length: 9 }, (_, index) => `  N${index}[Step number ${index} of the long pipeline] --> N${index + 1}[Step number ${index + 1} of the long pipeline]`).join("\n")}`;
			await ui.evaluate(reply(fence(wide)));
			await ui.wait("document.querySelector('.omp-mermaid--drawn img')");
			const fit = await ui.evaluate<{ natural: number; shown: number; frame: number; disabled: boolean; full: boolean }>("(()=>{const img=document.querySelector('.omp-mermaid img'),zoom=document.querySelector('.omp-mermaid-zoom'),frame=document.querySelector('.omp-mermaid-frame');return{natural:Number(img.getAttribute('width')),shown:img.clientWidth,frame:frame.clientWidth,disabled:zoom.disabled,full:frame.hasAttribute('data-full')}})()");
			assert.ok(fit.natural > fit.frame, "the diagram is wider than the block");
			assert.ok(fit.shown <= fit.frame && fit.shown < fit.natural, "scaled down to the width");
			assert.equal(fit.disabled, false);
			assert.equal(fit.full, false);
			await ui.evaluate("document.querySelector('.omp-mermaid-zoom').click()");
			await ui.wait("document.querySelector('.omp-mermaid-frame[data-full]')");
			const full = await ui.evaluate<{ shown: number; scrolls: boolean; pressed: string | null }>("(()=>{const img=document.querySelector('.omp-mermaid img'),frame=document.querySelector('.omp-mermaid-frame');return{shown:img.clientWidth,scrolls:frame.scrollWidth>frame.clientWidth,pressed:document.querySelector('.omp-mermaid-zoom').getAttribute('aria-pressed')}})()");
			assert.equal(full.shown, fit.natural, "the diagram's own size");
			assert.equal(full.scrolls, true, "scrolled horizontally");
			assert.equal(full.pressed, "true");
			await ui.evaluate("document.querySelector('.omp-mermaid-zoom').click()");
			await ui.wait("!document.querySelector('.omp-mermaid-frame[data-full]')");
			// A small diagram is not scaled: nothing to enlarge.
			await ui.evaluate(reply(fence("flowchart LR\n  A --> B")));
			await ui.wait("document.querySelector('.omp-mermaid-zoom')?.disabled===true");
			await clean();
		});

		await t.test("a wide diagram, fitted or at full size, never widens the transcript: only its own frame scrolls", async () => {
			await open("narrow");
			const wide = `flowchart LR\n${Array.from({ length: 9 }, (_, index) => `  N${index}[Step number ${index} of the long pipeline] --> N${index + 1}[Step number ${index + 1} of the long pipeline]`).join("\n")}`;
			await ui.evaluate(reply(fence(wide)));
			await ui.wait("document.querySelector('.omp-mermaid--drawn img')");
			const sideways = (): Promise<{ transcript: [number, number]; frame: [number, number]; full: boolean }> => ui.evaluate("(()=>{const t=document.querySelector('.omp-transcript'),frame=document.querySelector('.omp-mermaid-frame');return{transcript:[t.scrollWidth,t.clientWidth],frame:[frame.scrollWidth,frame.clientWidth],full:frame.hasAttribute('data-full')}})()");
			for (const width of [360, 480, 900]) {
				await ui.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
				await ui.settle();
				const fitted = await sideways();
				assert.equal(fitted.full, false);
				assert.ok(fitted.transcript[0] <= fitted.transcript[1], `fitted at ${width}px the transcript does not scroll sideways (${fitted.transcript.join(" over ")})`);
				await ui.evaluate("document.querySelector('.omp-mermaid-zoom').click()");
				await ui.wait("document.querySelector('.omp-mermaid-frame[data-full]')");
				await ui.settle();
				const full = await sideways();
				assert.ok(full.transcript[0] <= full.transcript[1], `at full size at ${width}px the transcript does not scroll sideways (${full.transcript.join(" over ")})`);
				assert.ok(full.frame[0] > full.frame[1], `at full size at ${width}px the diagram's own frame scrolls (${full.frame.join(" over ")})`);
				await ui.evaluate("document.querySelector('.omp-mermaid-zoom').click()");
				await ui.wait("!document.querySelector('.omp-mermaid-frame[data-full]')");
			}
			// The same source as code, with a line longer than the panel: the code block scrolls, the transcript does not.
			await ui.evaluate(reply(fence(`flowchart LR\n  A[${"long label ".repeat(40)}] --> B`, false)));
			await ui.wait("document.querySelector('.omp-md pre code')");
			await ui.settle();
			const code = await ui.evaluate<{ transcript: [number, number]; pre: [number, number] }>("(()=>{const t=document.querySelector('.omp-transcript'),pre=document.querySelector('.omp-md pre');return{transcript:[t.scrollWidth,t.clientWidth],pre:[pre.scrollWidth,pre.clientWidth]}})()");
			assert.ok(code.transcript[0] <= code.transcript[1], "the transcript does not scroll sideways with a long source line");
			assert.ok(code.pre[0] > code.pre[1], "the source block scrolls on its own");
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
			await clean();
		});

		await t.test("a source over the cap is refused without loading the renderer", async () => {
			await open("oversize");
			await ui.evaluate(reply(fence(`flowchart TD\n${"  A --> B\n".repeat(2100)}`)));
			await ui.wait("document.querySelector('.omp-mermaid-note')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid-note > span').textContent"), "Diagram not rendered: The source is over 8,000 characters");
			await ui.settle();
			assert.equal(rendererHits, 0);
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid img')"), null);
			await clean();
		});

		await t.test("a hostile diagram cannot script, load, restyle itself with its own theme or leave an element the page would run", async () => {
			await open("hostile");
			const hostile = `%%{init: {"securityLevel":"loose","theme":"forest","themeCSS":".node rect{fill:blue}","layout":"elk","htmlLabels":true}}%%\nflowchart TD\n  A["<img src=x onerror=alert(1)>"] --> B["<script>alert(2)</script>"]\n  click A "javascript:alert(3)" "tip"\n  click B callback`;
			await ui.evaluate(reply(fence(hostile)));
			await ui.wait("document.querySelector('.omp-mermaid--drawn img')");
			const facts = await svgFacts();
			assert.deepEqual(facts.tags.filter(tag => ["script", "img", "iframe", "foreignobject", "image"].includes(tag)), [], "no active or loading element in the image");
			assert.deepEqual(facts.attributes.filter(attribute => /^on\w+=/.test(attribute) || /(^|:)href=(javascript|data|vbscript):/.test(attribute)), [], "no handler and no script link; a link a diagram keeps is inert inside an image");
			assert.ok(!facts.text.includes("#cde498") && !/fill:\s*blue/i.test(facts.text), "the diagram did not pick its own theme or CSS");
			assert.ok(facts.text.includes("#cccccc"), "it is drawn in the page's theme: Dark Modern's foreground");
			await ui.settle();
			await clean();
		});

		await t.test("a source packed with statements, or a block diagram, is refused without loading the renderer", async () => {
			await open("statements");
			const packed = `flowchart LR\n${Array.from({ length: 150 }, (_, index) => `N${index}-->N${index + 1};`).join("")}`;
			assert.ok(packed.length < 8_000, "under the character cap, over the statement cap");
			await ui.evaluate(reply(fence(packed)));
			await ui.wait("document.querySelector('.omp-mermaid-note')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid-note > span').textContent"), "Diagram not rendered: The source is over 80 statements");
			await ui.evaluate(reply(fence("block-beta\n  columns 3\n  a b c")));
			await ui.wait("document.querySelector('.omp-mermaid-note > span')?.textContent==='Diagram not rendered: Block diagrams are not drawn'");
			await ui.settle();
			assert.equal(rendererHits, 0);
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid img')"), null);
			await clean();
		});

		await t.test("a diagram with non-breaking spaces still decodes as an image", async () => {
			await open("nbsp");
			const spaced = "sequenceDiagram\n  participant Alice\n  Alice->>Bob: Hello\u00a0Bob\u00a0\u00a0again\n  Bob-->>Alice: Hi\u00a0Alice";
			await ui.evaluate(reply(fence(spaced)));
			await ui.wait("document.querySelector('.omp-mermaid--drawn img')");
			await ui.wait("document.querySelector('.omp-mermaid img').complete");
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid img').naturalWidth>0"), true, "the browser decoded the SVG as XML");
			const raw = await ui.evaluate<string>("(()=>{const src=document.querySelector('.omp-mermaid img').src;return decodeURIComponent(src.slice(src.indexOf(',')+1))})()");
			assert.ok(!raw.includes("&nbsp;"), "no HTML-only entity");
			assert.ok(!/\bnonce=/.test(raw), "the page's nonce is not copied into the image");
			assert.ok(raw.includes("\u00a0"), "the character itself is kept");
			await clean();
		});

		await t.test("only the assistant's reply text is drawn: the same fence in a user message, thinking or a tool result stays code", async () => {
			await open("eligibility");
			await ui.evaluate(`(()=>{const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-13T00:00:00.000Z',message});
			 const text=${JSON.stringify(fence(FLOWCHART))};
			 window.ui.push({entries:[
			  row('u',{role:'user',timestamp:1,content:text}),
			  row('a',{role:'assistant',model:'m',timestamp:2,stopReason:'toolUse',content:[{type:'thinking',thinking:text},{type:'toolCall',id:'call-1',name:'read',arguments:{path:'a.md'}}]}),
			  row('r',{role:'toolResult',timestamp:3,toolCallId:'call-1',toolName:'read',isError:false,content:[{type:'text',text}]})],durableCount:3,working:false,settled:true})})()`);
			await ui.wait("document.querySelector('.omp-thinking')");
			await ui.settle();
			assert.equal(await ui.evaluate("document.querySelectorAll('.omp-mermaid img, .omp-mermaid-bar').length"), 0);
			assert.equal(rendererHits, 0, "nothing asked for the renderer");
			await ui.evaluate("document.querySelector('.omp-thinking summary, .omp-thinking button')?.click()");
			await ui.wait("document.querySelectorAll('.omp-thinking pre code').length===1");
			// The same text as the assistant's reply is drawn.
			await ui.evaluate(reply(fence(FLOWCHART)));
			await ui.wait("document.querySelector('.omp-mermaid--drawn img')");
			assert.equal(rendererHits, 1);
			await clean();
		});

		await t.test("the violation check can see a violation: an inline style without the nonce is recorded", async () => {
			await open("control");
			// Inserted and removed in one task, as mermaid's own measuring element is: the violation is still reported.
			await ui.evaluate("(()=>{document.body.insertAdjacentHTML('beforeend','<style>.nobody{color:red}</style>');document.body.lastElementChild.remove()})()");
			await ui.settle();
			assert.deepEqual(await ui.evaluate("window.violations"), ["style-src-elem inline"]);
		});

		await t.test("the zoom control works from the keyboard", async () => {
			await open("keyboard");
			const wide = `flowchart LR\n${Array.from({ length: 9 }, (_, index) => `  N${index}[Step number ${index} of the long pipeline] --> N${index + 1}[Step number ${index + 1} of the long pipeline]`).join("\n")}`;
			await ui.evaluate(reply(fence(wide)));
			await ui.wait("document.querySelector('.omp-mermaid-zoom:not(:disabled)')");
			await ui.evaluate("document.querySelector('.omp-mermaid-zoom').focus()");
			const press = async (key: string, code: string, vk: number, text?: string): Promise<void> => {
				await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, ...(text === undefined ? {} : { text }) });
				await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
			};
			await press("Enter", "Enter", 13, "\r");
			await ui.wait("document.querySelector('.omp-mermaid-frame[data-full]')");
			// The full-size frame is laid out and measured before the next key: the state in which the control once read "nothing to enlarge".
			await ui.settle();
			// Every change to the control's `disabled` is recorded: a flicker takes focus away at a moment no frame boundary shows.
			await ui.evaluate("(()=>{window.zoomDisabledChanges=0;new MutationObserver(records=>{window.zoomDisabledChanges+=records.filter(record=>record.attributeName==='disabled'&&record.target.className==='omp-mermaid-zoom').length}).observe(document.querySelector('.omp-mermaid-zoom'),{attributes:true})})()");
			await press(" ", "Space", 32, " ");
			await ui.wait("!document.querySelector('.omp-mermaid-frame[data-full]')");
			await ui.settle();
			assert.equal(await ui.evaluate("window.zoomDisabledChanges"), 0, "the control is never disabled while it is fitted back and still has something to enlarge");
			assert.equal(await ui.evaluate("document.activeElement.className"), "omp-mermaid-zoom", "focus stays on the control");
			await clean();
		});

		await t.test("a theme change while a diagram is being drawn ends with the diagram in the new theme", async () => {
			await open("theme-during");
			await ui.evaluate(reply(fence(FLOWCHART)));
			await ui.wait("document.querySelector('.omp-mermaid--drawn img')");
			await ui.evaluate("(()=>{const renderer=window.ompMermaid,original=renderer.render;renderer.render=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,300));return original(...args)}})()");
			await ui.evaluate(reply(fence(SEQUENCE)));
			await ui.wait("document.querySelector('.omp-md pre code')?.textContent.startsWith('sequenceDiagram')");
			// The slow render is in flight: the reader switches to Light Modern.
			await ui.evaluate(`document.body.className='vscode-light';for(const rule of ${JSON.stringify(themeRules("Light Modern"))}.split(';')){const at=rule.indexOf(':');document.documentElement.style.setProperty(rule.slice(0,at),rule.slice(at+1))}`);
			await ui.wait("document.querySelector('.omp-mermaid--drawn img') && decodeURIComponent(document.querySelector('.omp-mermaid img').src).includes('#3b3b3b')");
			const facts = await svgFacts();
			assert.ok(facts.text.includes("Hello Bob"), "it is the sequence diagram");
			assert.ok(facts.text.includes("#3b3b3b") && !facts.text.includes("#cccccc"), "drawn in Light Modern, not the theme it was asked for in");
			await clean();
		});

		await t.test("a refused block, and only a refused block, offers to open the diagram in a tab; the click posts the source", async () => {
			await open("open-in-tab");
			const long = `flowchart TD\n${"  A --> B\n".repeat(120)}`;
			const block = "block-beta\n  columns 3\n  a b c";
			await ui.evaluate(reply(`${fence(long)}\n\nand\n\n\`\`\`mermaid\n${block}\n\`\`\`\n\nand\n\n\`\`\`mermaid\nflowchart TD\n  A --> \n\`\`\`\n\nand\n\n\`\`\`mermaid\n${"x".repeat(50_001)}\n\`\`\``));
			await ui.wait("document.querySelectorAll('.omp-mermaid-note').length===4");
			assert.deepEqual(await ui.evaluate<number[]>("[...document.querySelectorAll('.omp-mermaid')].map(block=>block.querySelectorAll('.omp-mermaid-open').length)"), [1, 1, 0, 0], "the two refused blocks have the button; a parse error and an over-the-cap source do not");
			// The long source is over the statement limit; its request is the whole source.
			await ui.evaluate("document.querySelectorAll('.omp-mermaid-open')[0].click()");
			await ui.evaluate("document.querySelectorAll('.omp-mermaid-open')[1].click()");
			const sent = await ui.evaluate<{ type: string; source: string }[]>("window.sent.filter(message=>message.type==='omp:open-mermaid')");
			assert.deepEqual(sent, [{ type: "omp:open-mermaid", source: long }, { type: "omp:open-mermaid", source: block }]);
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid img')"), null, "the transcript draws none of them");
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid-open').textContent"), "Open diagram in a tab");
			await clean();
		});

		await t.test("a renderer that is missing or from another build is reported on the block and not requested again", async () => {
			await open("missing");
			rendererStatus = 404;
			await ui.evaluate(reply(fence(FLOWCHART)));
			await ui.wait("document.querySelector('.omp-mermaid-note')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid-note').textContent"), "Diagram not rendered: Diagram renderer unavailable");
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid pre code').textContent"), FLOWCHART, "the code stays");
			await ui.evaluate(reply(fence(SEQUENCE)));
			await ui.wait("document.querySelector('.omp-md pre code').textContent.startsWith('sequenceDiagram')");
			await ui.wait("document.querySelector('.omp-mermaid-note')");
			assert.equal(rendererHits, 1, "one failed request for the page");
			assert.deepEqual(await ui.evaluate("window.errors"), []);

			await open("stale");
			await ui.evaluate("window.ompMermaid={contract:999,render(){throw new Error('unreachable')}}");
			await ui.evaluate(reply(fence(FLOWCHART)));
			await ui.wait("document.querySelector('.omp-mermaid-note')");
			assert.equal(await ui.evaluate("document.querySelector('.omp-mermaid-note').textContent"), "Diagram not rendered: Diagram renderer is out of date. Reload the window");
			assert.equal(rendererHits, 0);
			assert.deepEqual(await ui.evaluate("window.violations"), []);
		});

		await t.test("the diagram tab shows Rendering… before a render that blocks, then draws a flowchart far over the chat limits", async () => {
			await openPreview("tab-large");
			assert.equal(await ui.evaluate("document.querySelector('.status').textContent"), "Waiting for the diagram…");
			assert.equal(await ui.evaluate("[...document.querySelectorAll('.bar button')].filter(button=>!button.hidden).every(button=>button.disabled||button.textContent==='Copy source')"), true, "nothing to zoom yet");
			// The renderer is held up for a moment, as a slow diagram would: the busy state is what the reader sees meanwhile.
			await ui.evaluate("(()=>{const renderer=window.ompMermaid,original=renderer.render;window.paintedBusy=null;renderer.render=async(...args)=>{window.paintedBusy=document.querySelector('.status').textContent+'|'+(document.querySelector('.stage .waiting')?.textContent??'');await new Promise(resolve=>setTimeout(resolve,300));return original(...args)}})()");
			const large = `flowchart TD\n${Array.from({ length: 150 }, (_, index) => `  N${index} --> N${index + 1}`).join("\n")}`;
			assert.match(mermaidSourceRefusal(large) ?? "", /over 80 statements/, "the chat page would refuse it");
			await sendSource(large);
			await ui.wait("window.paintedBusy!==null");
			assert.equal(await ui.evaluate("window.paintedBusy"), "Rendering…|Rendering…", "the status and the waiting view were on screen when the render started");
			await ui.wait("document.querySelector('.stage img')");
			assert.equal(await ui.evaluate("document.querySelector('.stage img').complete && document.querySelector('.stage img').naturalWidth>0 && document.querySelector('.stage img').src.startsWith('data:image/svg+xml')"), true);
			assert.ok((await svgFacts(".stage img")).text.includes("N150"), "the last node is in the drawing");
			assert.equal(await ui.evaluate("document.querySelector('.status').textContent"), "");
			assert.equal(await ui.evaluate("document.querySelector('.stage .waiting')"), null);
			assert.equal(await ui.evaluate("[...document.querySelectorAll('.bar button')].every(button=>!button.disabled)"), true);
			assert.equal(await ui.evaluate("window.ompMermaid.contract"), 2);
			await clean();
		});

		await t.test("the diagram tab draws a block diagram the chat page refuses, and zooms: fit, 100 %, zoom in and out", async () => {
			await openPreview("tab-zoom");
			await sendSource("block-beta\n  columns 3\n  a[\"Alpha\"] b[\"Beta\"] c[\"Gamma\"]\n  d e f");
			await ui.wait("document.querySelector('.stage img')");
			assert.ok((await svgFacts(".stage img")).text.includes("Alpha"));
			const widths = () => ui.evaluate<{ natural: number; shown: number; fit: boolean }>("(()=>{const img=document.querySelector('.stage img');return{natural:Number(img.getAttribute('width')),shown:img.clientWidth,fit:document.querySelector('.stage').hasAttribute('data-fit')}})()");
			const click = (label: string) => ui.evaluate(`[...document.querySelectorAll('.bar button')].find(button=>button.textContent===${JSON.stringify(label)}).click()`);
			const first = await widths();
			assert.equal(first.fit, true);
			await click("100%");
			assert.deepEqual(await widths(), { natural: first.natural, shown: first.natural, fit: false });
			await click("+");
			assert.equal((await widths()).shown, Math.round(first.natural * 1.25));
			await click("−");
			await click("−");
			assert.equal((await widths()).shown, Math.round(first.natural / 1.25));
			await click("Fit");
			assert.equal((await widths()).fit, true);
			await clean();
		});

		await t.test("the diagram tab shows the message and the source of a diagram that cannot be drawn, and Copy source copies it", async () => {
			await openPreview("tab-broken");
			await ui.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(text){window.copied=text}}})");
			const broken = "flowchart TD\n  A --> ";
			await sendSource(broken);
			await ui.wait("document.querySelector('.failure')");
			assert.match(await ui.evaluate<string>("document.querySelector('.failure h1').textContent"), /^Diagram not rendered: Parse error on line \d+$/);
			assert.equal(await ui.evaluate("document.querySelector('.failure pre code').textContent"), broken);
			assert.equal(await ui.evaluate("document.querySelector('.stage img')"), null);
			assert.equal(await ui.evaluate("[...document.querySelectorAll('.bar button')].filter(button=>button.textContent!=='Copy source'&&!button.hidden).every(button=>button.disabled)"), true);
			assert.equal(await ui.evaluate("document.querySelector('.status').textContent"), "");
			await ui.evaluate("[...document.querySelectorAll('.bar button')].find(button=>button.textContent==='Copy source').click()");
			await ui.wait("window.copied!==undefined");
			assert.equal(await ui.evaluate("window.copied"), broken);
			await clean();
		});

		await t.test("the diagram tab follows the theme: another theme draws it again", async () => {
			await openPreview("tab-theme");
			await sendSource(FLOWCHART);
			await ui.wait("document.querySelector('.stage img')");
			const dark = await ui.evaluate<string>("document.querySelector('.stage img').src");
			await ui.evaluate(`document.body.className='vscode-light';for(const rule of ${JSON.stringify(themeRules("Light Modern"))}.split(';')){const at=rule.indexOf(':');document.documentElement.style.setProperty(rule.slice(0,at),rule.slice(at+1))}`);
			await ui.wait("document.querySelector('.stage img').src!==" + JSON.stringify(dark));
			const facts = await svgFacts(".stage img");
			assert.ok(facts.text.includes("#3b3b3b") && !facts.text.includes("#cccccc"), "drawn in Light Modern");
			assert.equal(await ui.evaluate("document.querySelector('.bar button:not([hidden])') && [...document.querySelectorAll('.bar button')].find(button=>button.textContent==='Redraw').hidden"), true, "a quick render is drawn again by itself");
			await clean();
		});

		await t.test("a diagram that took long is not drawn again by a theme change until Redraw is pressed", async () => {
			await openPreview("tab-redraw");
			await ui.evaluate("(()=>{const renderer=window.ompMermaid,original=renderer.render;window.renders=0;const clock=performance.now.bind(performance);let skew=0;performance.now=()=>clock()+skew;renderer.render=async(...args)=>{window.renders++;skew+=2500;return original(...args)}})()");
			await sendSource(FLOWCHART);
			await ui.wait("document.querySelector('.stage img')");
			const dark = await ui.evaluate<string>("document.querySelector('.stage img').src");
			await ui.evaluate(`document.body.className='vscode-light';for(const rule of ${JSON.stringify(themeRules("Light Modern"))}.split(';')){const at=rule.indexOf(':');document.documentElement.style.setProperty(rule.slice(0,at),rule.slice(at+1))}`);
			await ui.wait("[...document.querySelectorAll('.bar button')].find(button=>button.textContent==='Redraw')?.hidden===false");
			await ui.settle();
			assert.equal(await ui.evaluate("window.renders"), 1, "no second render by itself");
			assert.equal(await ui.evaluate("document.querySelector('.stage img').src"), dark, "the previous drawing stays");
			assert.equal(await ui.evaluate("document.querySelector('.status').textContent"), "The theme changed.");
			await ui.evaluate("[...document.querySelectorAll('.bar button')].find(button=>button.textContent==='Redraw').click()");
			await ui.wait("window.renders===2 && document.querySelector('.stage img').src!==" + JSON.stringify(dark));
			assert.equal(await ui.evaluate("[...document.querySelectorAll('.bar button')].find(button=>button.textContent==='Redraw').hidden"), true);
			await clean();
		});

		await t.test("a theme change while the first render runs lets it finish and show; a quick one is drawn again, a slow one offers Redraw", async () => {
			// A page variable changes without a DOM mutation, which `wait` watches for: poll it.
			const poll = (condition: string) => ui.evaluate(`new Promise(resolve=>{const check=()=>{if(${condition})resolve();else setTimeout(check,20)};check()})`);
			const THEME = `for(const rule of ${JSON.stringify(themeRules("Light Modern"))}.split(';')){const at=rule.indexOf(':');document.documentElement.style.setProperty(rule.slice(0,at),rule.slice(at+1))}`;
			for (const slow of [false, true]) {
				await openPreview(slow ? "tab-first-slow" : "tab-first-quick");
				await ui.evaluate(`(()=>{const renderer=window.ompMermaid,original=renderer.render;window.renders=0;window.release=null;const clock=performance.now.bind(performance);let skew=0;performance.now=()=>clock()+skew;
				 renderer.render=async(...args)=>{window.renders++;await new Promise(resolve=>{window.release=resolve});skew+=${slow ? 2500 : 0};return original(...args)}})()`);
				await sendSource(FLOWCHART);
				await poll("window.renders===1");
				// The reader switches theme while the first render is under way.
				await ui.evaluate(`document.body.className='vscode-light';${THEME}`);
				await ui.settle();
				assert.equal(await ui.evaluate("window.renders"), 1, "no second render starts under the first");
				await ui.evaluate("window.release()");
				if (slow) {
					await ui.wait("[...document.querySelectorAll('.bar button')].find(button=>button.textContent==='Redraw')?.hidden===false");
					assert.ok((await svgFacts(".stage img")).text.includes("#cccccc"), "the finished drawing is shown, in the theme it was asked for");
					assert.equal(await ui.evaluate("window.renders"), 1);
				} else {
					await poll("window.renders===2");
					await ui.evaluate("window.release()");
					await ui.wait("document.querySelector('.stage img') && !document.querySelector('.status').textContent");
					await ui.wait("decodeURIComponent(document.querySelector('.stage img').src).includes('#3b3b3b')");
				}
				await clean();
			}
		});

		await t.test("the diagram tab ignores a source over the cap and a message that is not the host's, and its renderer takes the tab limits from the document", async () => {
			await openPreview("tab-cap");
			await sendSource("x".repeat(50_001));
			await ui.evaluate("window.dispatchEvent(new MessageEvent('message',{data:{type:'omp:mermaid-preview-source',source:'flowchart TD\\n A-->B',extra:1}}))");
			await ui.settle();
			assert.equal(await ui.evaluate("document.querySelector('.status').textContent"), "Waiting for the diagram…");
			assert.equal(await ui.evaluate("document.querySelector('.stage img')"), null);
			// The chat page's document says nothing, so it keeps the chat limits whatever it asks for.
			await open("scope-chat");
			await ui.evaluate(reply(fence(FLOWCHART)));
			await ui.wait("document.querySelector('.omp-mermaid--drawn img')");
			const refused = await ui.evaluate<{ ok: boolean; message?: string }>("window.ompMermaid.render('x','flowchart TD\\n'+' A-->B\\n'.repeat(120),{darkMode:true,fontFamily:'Arial',fontSize:'13px',reducedMotion:false,variables:{}},'tab')");
			assert.deepEqual(refused, { ok: false, message: "The source is over 80 statements" });
		});
	} finally {
		browser?.socket.close();
		page?.socket.close();
		child.kill();
		await once(child, "exit").catch(() => undefined);
		server.close();
		await rm(profile, { recursive: true, force: true }).catch(() => undefined);
	}
});
