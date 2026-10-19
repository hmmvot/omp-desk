/**
 * OMP's magic keywords painted by the real React app in an owned headless Chromium (docs/designs/2026-10-19-chat-magic-keywords.md):
 * the composer and the user's sent messages show the hue gradient on `ultrathink`, `orchestrate`, `workflowz` and `jevify` where OMP
 * acts on them, and nowhere else; the paint changes no DOM, no caret and no IME composition; OMP's settings switch it off; the
 * colours read on every theme kind; the shimmer stops for reduced motion.
 */
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
import { contrastRatio, hexToRgb, magicStopColour, MAGIC_THEME_KINDS, type MagicThemeKind } from "../shared/magic-colour.ts";
import { MAGIC_GRADIENT_STOPS, MAGIC_KEYWORDS, magicStopAt, magicStopHue } from "../shared/magic-keywords.ts";
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
		 function cleanup(){observer.disconnect();document.removeEventListener('fixture-post',check);clearTimeout(timer)}
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
import { attachMagicKeywordSettings } from "./lib/magic-keyword-settings";
import { scanBubble, placeKeywords } from "./lib/magic-keyword-scan";
import { findMagicKeywords } from "../shared/magic-keywords";
import { adoptNonceForCreatedStyles } from "./lib/nonce-styles";
import { installComposerDriver } from "./test-support/composer-driver";
attachSessionView(guestTransport);
attachMagicKeywordSettings(guestTransport);
installComposerDriver(window);
// The page's clock and the shimmer's frame timers belong to the test: a phase is set with \`window.clockNow\` and the frames armed are counted, so nothing waits for time to pass.
const realNow = Date.now.bind(Date);
Date.now = () => window.clockNow ?? realNow();
const armed = new Set();
const realSetTimeout = window.setTimeout.bind(window), realClearTimeout = window.clearTimeout.bind(window);
window.setTimeout = (handler, delay, ...args) => {
 if (delay !== 70) return realSetTimeout(handler, delay, ...args);
 const id = realSetTimeout(() => { armed.delete(id); handler(...args); }, delay);
 armed.add(id);
 return id;
};
window.clearTimeout = id => { armed.delete(id); realClearTimeout(id); };
window.windowFocused = true;
document.hasFocus = () => window.windowFocused;
const epoch = { nonce: "host-ui-test", counter: 1 };
const client = new ChatClient(guestTransport); client.attach(guestTransport);
const liveState = { model: { provider: "one", id: "old", name: "Original", contextWindow: 1000000 }, thinkingLevel: "low", isStreaming: false, isCompacting: false, queuedMessageCount: 0,
 contextUsage: { tokens: 40700, contextWindow: 1000000, percent: 4.07 } };
let current = { ...snapshotOf(createChatModel(), epoch), phase: "live", state: liveState };
function receive(message) { window.dispatchEvent(new MessageEvent("message", { data: message })); }
function push(patch = {}) { current = { ...current, ...patch }; const parts = splitChatSnapshot(current, "ui-snapshot");
 receive(parts.snapshot); for (const chunk of parts.chunks) receive(chunk);
}
const row = (id, message) => ({ type: "message", id, parentId: null, timestamp: "2026-10-19T00:00:00Z", message: { timestamp: 1, ...message } });
window.ui = {
 token: location.search, current: () => current, receive, push, epoch, liveState,
 view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Owned UI session", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); },
 keywords(list) { receive({ type: "omp:chat-magic-keywords", keywords: list }); },
 /** The transcript holds exactly these user prompts (and nothing else). */
 prompts(...texts) { push({ entries: texts.map((text, index) => row("u" + index, typeof text === "string" ? { role: "user", content: text } : text)), durableCount: texts.length, working: false, settled: true }); },
 reads: () => window.sent.filter(message => message.type === "omp:chat-magic-keywords-read"),
};
// What the page paints: every character of every painted keyword, by place, in document order.
window.magic = {
 chars(place) {
  const out = [];
  for (const [name, highlight] of CSS.highlights) {
   const match = /^omp-magic-([a-z]+)-(\\d+)$/.exec(name);
   if (!match) continue;
   for (const range of highlight) {
    const parent = range.startContainer.parentElement;
    const owner = parent?.closest(".omp-composer-input") ? "composer" : parent?.closest(".omp-user") ? "bubble" : "other";
    if (place === undefined || owner === place) out.push({ id: match[1], stop: Number(match[2]), text: range.toString(), name, range, priority: highlight.priority });
   }
  }
  out.sort((a, b) => a.range.compareBoundaryPoints(Range.START_TO_START, b.range));
  return out;
 },
 text(place) { return this.chars(place).map(item => item.text).join(""); },
 stops(place) { return this.chars(place).map(item => item.stop); },
 ids(place) { return [...new Set(this.chars(place).map(item => item.id))]; },
 names() { return [...CSS.highlights.keys()].filter(name => name.startsWith("omp-magic-")); },
 /** Scans a rendered message the way the paint does: the text of the ranges it would paint, and how many there are. */
 probe(html) { const root = document.createElement("div"); root.innerHTML = '<div class="omp-md">' + html + '</div>'; const scanned = scanBubble(root); const placed = placeKeywords(scanned, findMagicKeywords(scanned.text)); return { text: placed.map(item => item.chars.map(range => range.toString()).join("")).join(""), chars: placed.reduce((sum, item) => sum + item.chars.length, 0) }; },
 /** The colour a highlight paints with, as the cascade computes it for the text of the composer. */
 colour(name) { return getComputedStyle(window.composer.el(), "::highlight(" + name + ")").color; },
 decoration(name) { return getComputedStyle(window.composer.el(), "::highlight(" + name + ")").textDecorationLine; },
 /** The colour a surface really paints, flattened over its ancestors (VS Code themes use translucent tints). */
 surface(selector) {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1; const context = canvas.getContext("2d");
  const rgba = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); const v = context.getImageData(0, 0, 1, 1).data; return [v[0], v[1], v[2], v[3] / 255]; };
  const composite = (front, back) => { const alpha = front[3]; return front.slice(0, 3).map((value, index) => value * alpha + back[index] * (1 - alpha)); };
  const background = node => node ? composite(rgba(getComputedStyle(node).backgroundColor), background(node.parentElement)) : [255, 255, 255];
  return background(document.querySelector(selector)).map(Math.round);
 },
 /** Resolves with the painted text once it is the expected one (a paint is not a DOM change, so no observer sees it). */
 async until(place, expected) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) { if (this.text(place) === expected) return expected; await this.frame(); }
  return this.text(place);
 },
 async frame(count = 1) { for (let index = 0; index < count; index++) { const gate = Promise.withResolvers(); requestAnimationFrame(gate.resolve); await gate.promise; } },
 timers() { return armed.size; },
 async untilTimers(expected) { const deadline = performance.now() + 5000; while (performance.now() < deadline) { if (armed.size === expected) break; await this.frame(); } return armed.size; },
 async untilStops(place, expected) { const deadline = performance.now() + 5000; const want = JSON.stringify(expected); while (performance.now() < deadline) { if (JSON.stringify(this.stops(place)) === want) break; await this.frame(); } return this.stops(place); },
};
const nonce=readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); push({ state: liveState });
`;

const MOTION_ALLOWED = [{ name: "prefers-reduced-motion", value: "no-preference" }];
const MOTION_REDUCED = [{ name: "prefers-reduced-motion", value: "reduce" }];

// Skipped when no Chromium-based browser is found; set OMP_TEST_CHROMIUM to point at one.
test("magic keywords: the composer and the sent messages paint OMP's keywords, and only those", { skip: browserPath === undefined, timeout: 280_000 }, async t => {
	const bundled = await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") },
		bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' } });
	const script = bundled.outputFiles[0]!.text;
	const server = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
		if (pathname === "/codicons/codicon.css" || pathname === "/codicons/codicon.ttf") {
			const file = pathname.endsWith(".css") ? "codicon.css" : "codicon.ttf";
			response.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : "font/ttf");
			response.end(readFileSync(join(process.cwd(), "node_modules/@vscode/codicons/dist", file)));
			return;
		}
		if (pathname === "/ui.js") { response.setHeader("Content-Type", "text/javascript"); response.end(script); return; }
		response.setHeader("Content-Type", "text/html");
		const webview = {
			cspSource: "'self'",
			asWebviewUri: (uri: { path: string }) => ({ toString: () => uri.path.endsWith(".js") ? "/ui.js" : "/codicons/codicon.css" }),
		} as unknown as vscode.Webview;
		const extensionUri = { path: "/extension", with({ path }: { path: string }) { return { path }; } } as unknown as vscode.Uri;
		const html = createGuestHtml(webview, extensionUri, "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d", null);
		const nonce = /<script nonce="([^"]+)"/.exec(html)![1]!;
		response.end(html.replace("</head>", `<style nonce="${nonce}">:root {
			--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#dddddd;--vscode-foreground:#dddddd;--vscode-editorWidget-background:#252526;
			--vscode-button-background:#007acc;--vscode-button-foreground:white;--vscode-input-background:#3c3c3c;--vscode-focusBorder:#007fd4;
			--vscode-input-foreground:#ddd;--vscode-panel-border:#555;--vscode-font-family:Arial;--vscode-font-size:13px;
		}</style><script nonce="${nonce}">window.sent=[];window.errors=[];window.addEventListener("error",event=>window.errors.push(event.message));
		window.acquireVsCodeApi=()=>({postMessage(message){window.sent.push(message);document.dispatchEvent(new Event("fixture-post"))},setState(){}});</script>
		</head>`));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/`;
	const profile = await mkdtemp(join(tmpdir(), "omp-magic-ui-"));
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
		// The OS motion setting leaks into headless Chromium (CI images often turn animations off); pin the default.
		await ui.call("Emulation.setEmulatedMedia", { features: MOTION_ALLOWED });
		await ui.call("Emulation.setDeviceMetricsOverride", { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
		async function open(name: string): Promise<void> {
			const loaded = ui.event("Page.loadEventFired");
			await ui.call("Page.navigate", { url: `${url}?${name}` });
			await loaded;
			await ui.wait(`window.ui?.token === '?${name}' && document.querySelector('.omp-composer-input')`);
		}
		const settle = (): Promise<unknown> => ui.evaluate("window.magic.frame(2)");
		const press = async (key: string, code: string, windowsVirtualKeyCode: number, extra: Record<string, unknown> = {}): Promise<void> => {
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, ...extra });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
		};
		const typeKey = (character: string): Promise<void> => press(character, `Key${character.toUpperCase()}`, character.toUpperCase().charCodeAt(0), { text: character });
		const ctrlZ = (): Promise<void> => press("z", "KeyZ", 90, { modifiers: 2 });
		/** Puts `text` in the composer through the platform's own editing commands and lets the paint follow. */
		const draft = async (text: string): Promise<void> => { await ui.evaluate(`window.composer.setText(${JSON.stringify(text)})`); await settle(); };
		const value = (): Promise<string> => ui.evaluate<string>("window.composer.value()");
		const composerText = (): Promise<string> => ui.evaluate<string>("window.magic.text('composer')");
		const bubbleText = (): Promise<string> => ui.evaluate<string>("window.magic.text('bubble')");
		const stops = (place: string): Promise<number[]> => ui.evaluate<number[]>(`window.magic.stops(${JSON.stringify(place)})`);
		const showPrompt = async (...prompts: (string | Record<string, unknown>)[]): Promise<void> => {
			await ui.evaluate(`window.ui.prompts(...${JSON.stringify(prompts)})`);
			await ui.wait("document.querySelector('.omp-row--user .omp-md')");
			await settle();
		};
		const noErrors = async (): Promise<void> => assert.deepEqual(await ui.evaluate("window.errors"), []);

		await t.test("the composer paints a keyword that stands alone in prose, with the gradient's stops along the word", async () => {
			await open("composer-basic");
			await ui.evaluate("window.composer.focus()");
			assert.equal(await ui.evaluate("window.magic.names().length"), 0, "nothing is painted before a keyword is typed");
			await draft("please orchestrate this");
			assert.equal(await composerText(), "orchestrate");
			assert.deepEqual(await ui.evaluate("window.magic.ids('composer')"), ["orchestrate"]);
			assert.equal(await ui.evaluate("window.magic.chars('composer').every(item => item.priority === -1)"), true, "below Find's highlights");
			await ui.evaluate("window.composer.blur()");
			await settle();
			assert.deepEqual(await stops("composer"), Array.from({ length: 11 }, (_, index) => magicStopAt(index, 11)), "a field that does not have the keyboard shows OMP's static gradient");
			assert.deepEqual(await stops("composer"), [0, 1, 2, 3, 5, 6, 7, 8, 10, 11, 12], "pinned: eleven characters over fourteen stops, floor(index / length * 14)");
			await noErrors();
		});

		await t.test("the composer paints exactly where OMP's matcher says: not a call, a hyphenated word, a path, code, a longer word or another case", async () => {
			await open("composer-boundaries");
			const cases: [string, string][] = [
				["orchestrate", "orchestrate"],
				["orchestrate()", ""],
				["foo-orchestrate", ""],
				["orchestrate-all", ""],
				["path/orchestrate", ""],
				["orchestrate/all", ""],
				["a.orchestrate", ""],
				["orchestrate.md", ""],
				["orchestrates", ""],
				["Orchestrate", ""],
				["ORCHESTRATE", ""],
				["`orchestrate`", ""],
				["``orchestrate``", ""],
				["use `x` then orchestrate", "orchestrate"],
				["```\norchestrate\n```", ""],
				["```\norchestrate\n```\norchestrate", "orchestrate"],
				["~~~\norchestrate\n~~~", ""],
				["<b>orchestrate</b>", ""],
				["<!-- orchestrate -->", ""],
				["(orchestrate)", "orchestrate"],
				["\"orchestrate\"", "orchestrate"],
				["orchestrate, then.", "orchestrate"],
				["foo::orchestrate", ""],
				["ultrathink jevify workflowz orchestrate", "ultrathinkjevifyworkflowzorchestrate"],
				["ultrathink\n\nultrathink", "ultrathinkultrathink"],
			];
			for (const [text, painted] of cases) {
				await draft(text);
				assert.equal(await composerText(), painted, `the draft ${JSON.stringify(text)}`);
				assert.equal(await value(), text, "the draft is what was typed");
			}
			await noErrors();
		});

		await t.test("every keyword has its own gradient, and a keyword inside a chip is not painted", async () => {
			await open("composer-chips");
			await ui.evaluate("window.ui.push({commands:[{name:'skill:ultrathink',source:'skill',description:'A skill named like the keyword'}]});window.composer.focus()");
			await draft("ultrathink jevify");
			assert.deepEqual(await ui.evaluate("window.magic.ids('composer')"), ["ultrathink", "jevify"]);
			await draft("/skill:ultrathink check ultrathink");
			await ui.wait("document.querySelectorAll('.omp-composer-input .omp-chip').length===1");
			await settle();
			assert.equal(await composerText(), "ultrathink", "the skill's chip is a widget, not prose; the word after it is");
			assert.equal(await ui.evaluate("window.magic.chars('composer')[0].range.startContainer.parentElement.closest('.omp-chip')"), null);
			assert.equal(await ui.evaluate("window.magic.chars('composer')[0].range.startContainer.data"), "check ultrathink");
			await noErrors();
		});

		await t.test("painting changes no DOM, no attribute and no selection of the composer", async () => {
			await open("composer-dom");
			await ui.evaluate("window.composer.focus()");
			await draft("please ultrathink");
			assert.equal(await ui.evaluate("window.composer.el().innerHTML"), '<div class="omp-line">please ultrathink</div>');
			const before = await ui.evaluate<string[]>("window.composer.el().getAttributeNames().sort()");
			await draft("plain");
			assert.equal(await composerText(), "");
			assert.deepEqual(await ui.evaluate("window.composer.el().getAttributeNames().sort()"), before, "the same attributes with and without a keyword");
			await draft("please ultrathink");
			assert.equal(await ui.evaluate("window.composer.el().querySelectorAll('*').length"), 1, "one line element and nothing else");
			// A selection over the keyword is the selection of its characters; the paint leaves it alone.
			await ui.evaluate("window.composer.select(7, 17)");
			assert.equal(await ui.evaluate("document.getSelection().toString()"), "ultrathink");
			assert.deepEqual(await ui.evaluate("(()=>{const s=window.composer.selection();return[s.start,s.end]})()"), [7, 17]);
			assert.equal(await composerText(), "ultrathink");
			assert.deepEqual(await ui.evaluate("window.composer.roundTrip()"), []);
			await noErrors();
		});

		await t.test("typing, deleting, undo and paste keep the draft, the caret and the paint right", async () => {
			await open("composer-typing");
			await ui.evaluate("window.composer.focus()");
			for (const character of "ultrathink") await typeKey(character);
			await ui.wait("window.composer.value()==='ultrathink'");
			assert.equal(await ui.evaluate("window.magic.until('composer','ultrathink')"), "ultrathink", "complete the word and it is painted");
			// A letter right after the word binds it into a longer word: no keyword; take the letter away and the keyword is back.
			await typeKey("x");
			await ui.wait("window.composer.value()==='ultrathinkx'");
			assert.equal(await ui.evaluate("window.magic.until('composer','')"), "");
			await press("Backspace", "Backspace", 8);
			await ui.wait("window.composer.value()==='ultrathink'");
			assert.equal(await ui.evaluate("window.magic.until('composer','ultrathink')"), "ultrathink");
			// Typing on after the word: the caret is where typing put it, the paint stays on the word only.
			await ui.call("Input.insertText", { text: " and more" });
			await ui.wait("window.composer.value()==='ultrathink and more'");
			assert.deepEqual(await ui.evaluate("(()=>{const s=window.composer.selection();return[s.start,s.end]})()"), [19, 19]);
			assert.equal(await composerText(), "ultrathink");
			// A character typed inside the word splits it; undo puts it back.
			await ui.evaluate("window.composer.select(5)");
			await typeKey("q");
			await ui.wait("window.composer.value()==='ultraqthink and more'");
			assert.equal(await ui.evaluate("window.magic.until('composer','')"), "");
			await ctrlZ();
			await ui.wait("window.composer.value()==='ultrathink and more'");
			assert.equal(await ui.evaluate("window.magic.until('composer','ultrathink')"), "ultrathink", "undo repaints the word");
			assert.deepEqual(await ui.evaluate("(()=>{const s=window.composer.selection();return[s.start,s.end]})()"), [5, 5], "and puts the caret back");
			// Selecting the word and typing over it removes it, and its paint.
			await ui.evaluate("window.composer.select(0, 10)");
			await typeKey("z");
			await ui.wait("window.composer.value()==='z and more'");
			assert.equal(await ui.evaluate("window.magic.until('composer','')"), "");
			// A paste with several lines: a keyword in each, one inside a fence.
			await ui.evaluate("window.composer.select(0, 100)");
			await ui.evaluate(`(()=>{const data=new DataTransfer();data.setData('text/plain',${JSON.stringify("jevify first\n```\njevify fenced\n```\nlast jevify")});
			 window.composer.el().dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))})()`);
			await ui.wait("window.composer.value().includes('last jevify')");
			assert.equal(await ui.evaluate("window.magic.until('composer','jevifyjevify')"), "jevifyjevify", "the first and the last, not the one in the fence");
			assert.equal(await value(), "jevify first\n```\njevify fenced\n```\nlast jevify");
			await noErrors();
		});

		await t.test("a quote line and a slash command do not hide a keyword or paint a false one", async () => {
			await open("composer-quote-slash");
			await ui.evaluate("window.ui.push({commands:[{name:'shake',description:'Shake'}]});window.composer.focus()");
			await draft("> quoted ultrathink\n\nafter");
			await ui.wait("document.querySelector('.omp-line--quote')");
			await settle();
			assert.equal(await composerText(), "ultrathink", "OMP reads the quoted line as prompt text, so the quoted keyword is one");
			await draft("/ultrathink");
			assert.equal(await composerText(), "", "a slash before the word binds it into a path");
			await ui.call("Input.insertText", { text: " " });
			await draft("/sha");
			await ui.wait("document.querySelector('[aria-label=\"Slash commands\"]')");
			assert.equal(await composerText(), "");
			await noErrors();
		});

		await t.test("an IME composition keeps the draft and the DOM the browser owns, and the word is painted as soon as it reads as one", async () => {
			await open("composer-ime");
			await draft("hello ");
			await ui.evaluate("window.composer.focus();window.composer.select(6)");
			await ui.evaluate("window.composer.el().dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))");
			const compose = (text: string): Promise<unknown> => ui.evaluate(`(()=>{const field=window.composer.el();field.children[0].firstChild.data=${JSON.stringify(`hello ${text}`)};})()`);
			await compose("ultrathin");
			await settle();
			assert.equal(await composerText(), "", "an unfinished word is no keyword");
			await compose("ultrathink");
			assert.equal(await ui.evaluate("window.magic.until('composer','ultrathink')"), "ultrathink", "painted while the browser still owns the DOM");
			assert.equal(await ui.evaluate("window.composer.el().children.length"), 1, "the paint added nothing to the browser's DOM");
			await compose("ultrathinking");
			assert.equal(await ui.evaluate("window.magic.until('composer','')"), "", "a word that goes on is no keyword");
			await compose("ultrathink");
			await ui.evaluate("window.composer.el().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'ultrathink'}))");
			await ui.wait("window.composer.value()==='hello ultrathink'");
			assert.equal(await ui.evaluate("window.magic.until('composer','ultrathink')"), "ultrathink", "the settled draft is painted");
			assert.equal(await ui.evaluate("window.composer.el().innerHTML"), '<div class="omp-line">hello ultrathink</div>');
			assert.deepEqual(await ui.evaluate("window.composer.roundTrip()"), []);
			await noErrors();
		});

		await t.test("a sent message paints its keywords in prose and not in code, a call, a path or a longer word", async () => {
			await open("bubble-boundaries");
			const cases: [string, string][] = [
				["please ultrathink about this", "ultrathink"],
				["ultrathink()", ""],
				["foo-ultrathink and path/ultrathink and ultrathinks", ""],
				["use `ultrathink` here", ""],
				["use `x` and ultrathink", "ultrathink"],
				["```\nultrathink\n```\n\nafter", ""],
				["```ts\nconst ultrathink = 1;\n```\n\nultrathink", "ultrathink"],
				["**ultrathink**", "ultrathink"],
				["first paragraph\n\nultrathink\n\nlast paragraph", "ultrathink"],
				["- ultrathink\n- orchestrate\n- not-jevify", "ultrathinkorchestrate"],
				["> quoted jevify", "jevify"],
				["Ultrathink ULTRATHINK", ""],
				["see https://example.com/ultrathink for details", ""],
				["ultrathink and orchestrate and workflowz and jevify", "ultrathinkorchestrateworkflowzjevify"],
			];
			for (const [text, painted] of cases) {
				await showPrompt(text);
				assert.equal(await bubbleText(), painted, `the message ${JSON.stringify(text)}`);
			}
			assert.equal(await ui.evaluate("window.magic.chars('bubble').length > 0 && window.magic.chars('bubble').every(item => item.priority === -1)"), true, "below Find's highlights");
			await showPrompt("one ultrathink", "two orchestrate", "three");
			assert.equal(await bubbleText(), "ultrathinkorchestrate", "every message of the transcript is painted, each in its own place");
			await showPrompt("one ultrathink");
			assert.equal(await bubbleText(), "ultrathink");
			await ui.evaluate("window.ui.prompts('no keyword')");
			await ui.wait("document.querySelector('.omp-row--user')?.textContent.includes('no keyword')");
			assert.equal(await ui.evaluate("window.magic.until('bubble','')"), "", "a message that is replaced takes its paint with it");
			assert.equal(await ui.evaluate("window.magic.names().length"), 0, "and the highlights it filled are gone");
			await noErrors();
		});

		await t.test("a sent message's gradient stands still and is the composer's static gradient, over the Markdown as shown", async () => {
			await open("bubble-gradient");
			await showPrompt("a *ultrathink* word");
			assert.deepEqual(await stops("bubble"), Array.from({ length: 10 }, (_, index) => magicStopAt(index, 10)));
			const first = await stops("bubble");
			assert.equal(await ui.evaluate("window.magic.timers()"), 0, "nothing is armed that could move a message's gradient");
			await settle();
			assert.deepEqual(await stops("bubble"), first, "a message does not shimmer");
			// OMP reads the prompt's raw text, where inline markup inside a word breaks it: the page paints what OMP acts on, not what the Markdown renders to.
			for (const text of ["**ultra**think", "ultra**think**", "[ultra](https://x.y)think"]) {
				await showPrompt(text);
				assert.equal(await bubbleText(), "", `the raw text ${JSON.stringify(text)} holds no keyword for OMP`);
			}
			// A word an inline element splits is one word to the scan; the prompt's raw text decides whether OMP has it at all.
			await showPrompt("[ultra](https://x.y)think and orchestrate");
			assert.equal(await bubbleText(), "orchestrate", "the rendered text reads ultrathink, the prompt's text does not: OMP acts on the second");
			await showPrompt("ultrathink and [ultra](https://x.y)think");
			assert.equal(await bubbleText(), "ultrathink", "the word a link cuts is not painted beside the one OMP acts on");
			assert.equal(await ui.evaluate("window.magic.chars('bubble').length"), 10);
			assert.deepEqual(await ui.evaluate("window.magic.probe('<p>a <em>ultra</em>think and orch<b>estra</b>te</p>')"), { text: "ultrathinkorchestrate", chars: 21 }, "one range per character across the elements");
			assert.deepEqual(await ui.evaluate("window.magic.probe('<p>ultra<code>x</code>think <button>ultrathink</button></p>')"), { text: "", chars: 0 }, "code and controls are not text to read");
			await noErrors();
		});

		await t.test("agent-attributed input is not the user's prompt and stays plain", async () => {
			await open("bubble-synthetic");
			await ui.evaluate("window.ui.prompts({ role: 'user', content: 'ultrathink from an agent', synthetic: true }, 'a ultrathink of mine')");
			await ui.wait("document.querySelectorAll('.omp-native-message.omp-user').length===2");
			await ui.evaluate("document.querySelector('.omp-native-message.omp-user summary')?.click()");
			await settle();
			assert.equal(await bubbleText(), "ultrathink");
			assert.equal(await ui.evaluate("window.magic.chars('bubble').every(item => item.range.startContainer.parentElement.closest('.omp-user').textContent.includes('mine'))"), true);
			await noErrors();
		});

		await t.test("OMP's settings decide: the host's answer switches a keyword off everywhere, and back on", async () => {
			await open("settings-switch");
			await ui.evaluate("window.composer.focus()");
			await showPrompt("ultrathink orchestrate");
			await draft("ultrathink orchestrate jevify");
			assert.equal(await bubbleText(), "ultrathinkorchestrate", "every keyword counts until the host says otherwise");
			assert.equal(await composerText(), "ultrathinkorchestratejevify");
			assert.equal(await ui.evaluate("window.ui.reads().length"), 1, "one question, asked when the first keyword was shown; no more within the period");
			assert.deepEqual(await ui.evaluate("window.ui.reads()"), [{ type: "omp:chat-magic-keywords-read" }]);
			await ui.evaluate("window.ui.keywords(['orchestrate'])");
			assert.equal(await ui.evaluate("window.magic.until('composer','orchestrate')"), "orchestrate", "the composer follows");
			assert.equal(await ui.evaluate("window.magic.until('bubble','orchestrate')"), "orchestrate", "the message follows");
			await ui.evaluate("window.ui.keywords([])");
			assert.equal(await ui.evaluate("window.magic.until('composer','')"), "", "the master switch off: nothing in the composer");
			assert.equal(await ui.evaluate("window.magic.until('bubble','')"), "", "nothing in the message");
			assert.equal(await ui.evaluate("window.magic.names().length"), 0);
			await ui.evaluate("window.ui.keywords(['ultrathink','orchestrate','workflow','jevify'])");
			assert.equal(await ui.evaluate("window.magic.until('composer','ultrathinkorchestratejevify')"), "ultrathinkorchestratejevify");
			assert.equal(await ui.evaluate("window.magic.until('bubble','ultrathinkorchestrate')"), "ultrathinkorchestrate");
			await ui.evaluate("window.ui.keywords(['workflow'])");
			await draft("workflowz and orchestrate");
			assert.equal(await composerText(), "workflowz", "the setting is called `workflow`, the word is `workflowz`");
			assert.deepEqual(await ui.evaluate("window.magic.ids('composer')"), ["workflow"]);
			assert.equal(await ui.evaluate("window.ui.reads().length"), 1, "the paint asked once");
			await noErrors();
		});

		await t.test("a page that shows no keyword never asks the host", async () => {
			await open("settings-silent");
			await ui.evaluate("window.composer.focus()");
			await draft("an ordinary draft");
			await showPrompt("an ordinary prompt");
			await draft("orchestrate()");
			assert.equal(await ui.evaluate("window.ui.reads().length"), 0);
			await draft("orchestrate");
			await ui.wait("window.ui.reads().length===1");
			await noErrors();
		});

		await t.test("the composer's keyword shimmers on OMP's clock while it has the keyboard; a sent message, a blurred field and reduced motion keep it still", async () => {
			await open("shimmer");
			// The page's clock is the test's: the phase is whatever `Date.now()` says, so a phase is set, never waited for.
			await ui.evaluate("window.clockNow = 0");
			await showPrompt("a sent ultrathink");
			await ui.evaluate("window.composer.focus()");
			await draft("please ultrathink");
			const at = (phase: number): number[] => Array.from({ length: 10 }, (_, index) => magicStopAt(index, 10, phase));
			const onStops = (place: string, expected: number[]): Promise<number[]> => ui.evaluate<number[]>(`window.magic.untilStops(${JSON.stringify(place)}, ${JSON.stringify(expected)})`);
			const armed = (expected: number): Promise<number> => ui.evaluate<number>(`window.magic.untilTimers(${expected})`);
			assert.equal(await ui.evaluate("window.composer.focused()"), true);
			assert.equal(await armed(1), 1, "a focused field with a keyword has its next frame armed");
			assert.deepEqual(await onStops("composer", at(0)), at(0), "phase 0 is the static gradient");
			// A quarter of OMP's 1800 ms sweep, then half of it: the next frame paints the stops of that phase.
			await ui.evaluate("window.clockNow = 450");
			assert.deepEqual(await onStops("composer", at(0.25)), at(0.25), "the gradient moves along the word with the clock");
			await ui.evaluate("window.clockNow = 900");
			assert.deepEqual(await onStops("composer", at(0.5)), at(0.5));
			assert.notDeepEqual(at(0.5), at(0), "a moved phase is a different gradient");
			assert.deepEqual(await stops("bubble"), at(0), "a sent message stands still while the composer shimmers");
			// Reduced motion: the frames are disarmed and the static gradient stands at once; the clock moving changes nothing.
			await ui.call("Emulation.setEmulatedMedia", { features: MOTION_REDUCED });
			assert.equal(await armed(0), 0, "reduced motion arms no frame");
			assert.deepEqual(await onStops("composer", at(0)), at(0));
			await ui.evaluate("window.clockNow = 1350");
			await settle();
			assert.deepEqual(await stops("composer"), at(0), "reduced motion: nothing moves");
			assert.equal(await armed(0), 0);
			await ui.call("Emulation.setEmulatedMedia", { features: MOTION_ALLOWED });
			assert.equal(await armed(1), 1, "the reader accepts motion again: the frames are back");
			assert.deepEqual(await onStops("composer", at(0.75)), at(0.75));
			// A field without the keyboard shows the static gradient and arms nothing.
			await ui.evaluate("window.composer.blur()");
			assert.equal(await armed(0), 0);
			assert.deepEqual(await onStops("composer", at(0)), at(0), "blurred: the static gradient");
			await ui.evaluate("window.composer.focus()");
			assert.equal(await armed(1), 1, "focused again");
			assert.deepEqual(await onStops("composer", at(0.75)), at(0.75));
			// The window loses the keyboard to another application: the field keeps `activeElement`, the page stays visible, the document has no focus.
			await ui.evaluate("window.windowFocused = false; window.dispatchEvent(new Event('blur'))");
			assert.equal(await armed(0), 0, "a deactivated window arms no frame");
			assert.deepEqual(await onStops("composer", at(0)), at(0), "a deactivated window shows the static gradient");
			await ui.evaluate("window.windowFocused = true; window.dispatchEvent(new Event('focus'))");
			assert.equal(await armed(1), 1, "the window is back, and so are the frames");
			// The keyword leaves the draft: nothing is left to move.
			await draft("plain");
			assert.equal(await armed(0), 0);
			await noErrors();
		});

		await t.test("the gradient's colours read on every theme kind: OMP's hues, solved for 4.5:1 (7:1 in High Contrast) on the real surfaces", async () => {
			await open("themes");
			await ui.evaluate("window.composer.focus()");
			await showPrompt("ultrathink orchestrate workflowz jevify");
			await draft("ultrathink orchestrate workflowz jevify");
			await ui.evaluate("window.composer.blur()");
			await settle();
			const kindOf = (bodyClass: string): MagicThemeKind => bodyClass === "vscode-dark" ? "dark" : bodyClass === "vscode-light" ? "light" : bodyClass === "vscode-high-contrast" ? "high-contrast" : "high-contrast-light";
			const seen = new Set<MagicThemeKind>();
			for (const theme of THEMES) {
				const kind = kindOf(theme.bodyClass);
				seen.add(kind);
				await ui.evaluate(`(async()=>{document.body.className=${JSON.stringify(theme.bodyClass)};for(const [key,value]of Object.entries(${JSON.stringify(theme.tokens)}))document.body.style.setProperty(key,value);await window.magic.frame(2)})()`);
				const surfaces = { composer: await ui.evaluate<number[]>("window.magic.surface('.omp-composer')"), bubble: await ui.evaluate<number[]>("window.magic.surface('.omp-row--user .omp-body-block')") };
				const ratio = kind.startsWith("high-contrast") ? 7 : 4.5;
				for (const keyword of MAGIC_KEYWORDS) {
					for (let stop = 0; stop < MAGIC_GRADIENT_STOPS; stop++) {
						const name = `omp-magic-${keyword.id}-${stop}`;
						const colour = await ui.evaluate<string>(`window.magic.colour(${JSON.stringify(name)})`);
						const expected = hexToRgb(magicStopColour(magicStopHue(keyword, stop), kind));
						assert.equal(colour, `rgb(${expected.join(", ")})`, `${theme.name}: ${name} is the solved colour of its hue`);
						for (const [place, surface] of Object.entries(surfaces)) {
							const contrast = contrastRatio(expected, surface as unknown as [number, number, number]);
							assert.ok(contrast >= ratio, `${theme.name}: ${name} on the ${place} (${surface.join(",")}) is ${contrast.toFixed(2)}:1, under ${ratio}:1`);
						}
					}
				}
				const underline = await ui.evaluate<string>("window.magic.decoration('omp-magic-ultrathink-0')");
				assert.equal(underline, kind.startsWith("high-contrast") ? "underline" : "none", `${theme.name}: colour is the whole signal outside High Contrast, colour and underline in it`);
			}
			assert.deepEqual([...seen].sort(), [...MAGIC_THEME_KINDS].sort(), "the fixture covers every theme kind");
			await noErrors();
		});

		await t.test("Find in the conversation paints over a keyword it matches", async () => {
			await open("find-over");
			await showPrompt("ultrathink please");
			const state = await ui.evaluate<{ magic: number; findFirst: boolean }>(`(()=>{
			 const row=document.querySelector('.omp-row--user'),text=row.querySelector('.omp-md').firstChild.firstChild,range=document.createRange();
			 range.setStart(text,0);range.setEnd(text,10);const find=new Highlight(range);CSS.highlights.set('omp-find',find);
			 return{magic:[...CSS.highlights].filter(([name])=>name.startsWith('omp-magic-')).length,findFirst:find.priority>-1}})()`);
			assert.ok(state.magic > 0);
			assert.equal(state.findFirst, true, "Find's highlight outranks the keyword's, whose priority is below every default");
			await ui.evaluate("CSS.highlights.delete('omp-find')");
			await noErrors();
		});

		await t.test("without the Custom Highlight API nothing is painted and nothing breaks", async () => {
			await open("no-api");
			await ui.evaluate("window.composer.focus()");
			assert.equal(await ui.evaluate("delete CSS.highlights && !('highlights' in CSS)"), true, "the page has no highlight registry, as an older browser");
			await draft("orchestrate");
			await showPrompt("orchestrate");
			assert.equal(await value(), "orchestrate", "the composer still works");
			await noErrors();
		});
	} finally {
		page?.socket.close();
		browser?.socket.close();
		child.kill();
		server.close();
		await rm(profile, { recursive: true, force: true }).catch(() => undefined);
	}
});
