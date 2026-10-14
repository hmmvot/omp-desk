/** The opened tool call in Chat (design 2026-10-14): 12-row preview, markers, Show all, Collapse, gist, footer, Copy and streaming, against real calls, in an owned headless Chromium. */
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
import { splitToolNotices } from "../chat/tool-notices.ts";
import { THEMES } from "./theme-ui-fixtures.ts";

const browserPath = [process.env.OMP_TEST_CHROMIUM,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));
/** The `text` of a fixture's `displayContent`, and a fixture's list: narrowed, not cast. */
const textOf = (value: unknown): string => typeof value === "object" && value !== null && "text" in value && typeof value.text === "string" ? value.text : assert.fail("fixture has no text");
const listOf = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : assert.fail("fixture has no list");
interface Call { id: string; tool: string; args: Record<string, unknown>; resultText: string; details: Record<string, unknown>; isError: boolean }
const calls: readonly Call[] = JSON.parse(readFileSync(new URL("./fixtures/tool-calls.json", import.meta.url), "utf8"));
const real = (id: string): Call => calls.find(item => item.id === id) ?? assert.fail(`fixture ${id}`);
/** What the page shows of a result: its text without the notices OMP appends. */
const outputLines = (call: Call): number => splitToolNotices(call.resultText).body.split("\n").length;

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
		  const geometry=JSON.stringify([...document.querySelectorAll(${JSON.stringify(selector)})].map(element=>{const rect=element.getBoundingClientRect();return[rect.x,rect.y,rect.width,rect.height,element.scrollTop,element.scrollHeight]}));
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
import { attachCodeTheme } from "./lib/code-theme-store";
import { adoptNonceForCreatedStyles } from "./lib/nonce-styles";
attachSessionView(guestTransport);
attachCodeTheme(guestTransport);
const epoch = { nonce: "host-ui-test", counter: 1 };
const model = { provider: "one", id: "old", name: "Original", contextWindow: 1000000 };
const client = new ChatClient({ post(message) { return guestTransport.post(message); } }); client.attach(guestTransport);
let current = { ...snapshotOf(createChatModel(), epoch), phase: "live", state: { model, thinkingLevel: "low", isStreaming: false, isCompacting: false, queuedMessageCount: 0, contextUsage: { tokens: 40700, contextWindow: 1000000, percent: 4.07 } } };
function receive(message) { window.dispatchEvent(new MessageEvent("message", { data: message })); }
function push(patch = {}) { current = { ...current, ...patch }; const parts = splitChatSnapshot(current, "ui-snapshot"); receive(parts.snapshot); for (const chunk of parts.chunks) receive(chunk); }
window.ui = {
 token: location.search, current: () => current, receive, push,
 density(toolCallDetail) { receive({ type: "omp:chat-display-preferences", epoch: current.epoch, toolCallDetail, accessibilitySupport: false }); },
 view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Owned UI session", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); },
 requests: () => window.sent.filter(message => message.type === "omp:control-request"),
 reply() { const request = window.ui.requests().at(-1); receive({ type: "omp:control-state", scope: request.scope, requestId: request.requestId, available: true, model: current.state.model, thinkingLevel: current.state.thinkingLevel, mutationMode: "best-effort" }); },
};
const nonce = readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); push();
`;

test("an opened tool call rests as a bounded preview, shows its gist and footer, copies exactly and streams live", { skip: browserPath === undefined, timeout: 200_000 }, async t => {
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
		if (pathname === "/ui.js") { response.setHeader("Content-Type", "text/javascript"); response.end(script); return; }
		response.setHeader("Content-Type", "text/html");
		const webview = { cspSource: "'self'", asWebviewUri: (uri: { path: string }) => ({ toString: () => uri.path.endsWith(".js") ? "/ui.js" : "/codicons/codicon.css" }) } as unknown as vscode.Webview;
		const extensionUri = { path: "/extension", with({ path }: { path: string }) { return { path }; } } as unknown as vscode.Uri;
		const html = createGuestHtml(webview, extensionUri, "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d", null);
		const nonce = /<script nonce="([^"]+)"/.exec(html)![1]!;
		// The fixed clock: second ticks are fired by the test, and `Date.now` is the test's.
		response.end(html.replace("</head>", `<style nonce="${nonce}">:root {
			--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#dddddd;--vscode-foreground:#dddddd;--vscode-editorWidget-background:#252526;
			--vscode-button-background:#007acc;--vscode-button-foreground:white;--vscode-input-background:#3c3c3c;
			--vscode-input-foreground:#ddd;--vscode-panel-border:#555;--vscode-font-family:Arial;--vscode-font-size:13px;
			--vscode-editor-font-family:Consolas, "Courier New", monospace;
		}</style><script nonce="${nonce}">window.sent=[];window.errors=[];window.addEventListener("error",event=>window.errors.push(event.message));
		const nativeInterval=window.setInterval.bind(window), nativeClearInterval=window.clearInterval.bind(window), timers=new Map();let timerId=0;
		window.setInterval=(fn,ms,...args)=>{if(ms!==1000)return nativeInterval(fn,ms,...args);const id=--timerId;timers.set(id,{fn,args});return id};
		window.clearInterval=id=>{if(!timers.delete(id))nativeClearInterval(id)};
		window.fixtureClock={setNow(value){Date.now=()=>value},tick(){for(const timer of [...timers.values()])timer.fn(...timer.args)}};
		window.acquireVsCodeApi=()=>({postMessage(message){window.sent.push(message);document.dispatchEvent(new Event("fixture-post"))},setState(){}});</script>
		</head>`));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/`;
	const profile = await mkdtemp(join(tmpdir(), "omp-tool-output-ui-"));
	const child = spawn(browserPath!, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
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
		await ui.call("Emulation.setDeviceMetricsOverride", { width: 720, height: 900, deviceScaleFactor: 1, mobile: false });
		async function reset(name: string): Promise<void> {
			const loaded = ui.event("Page.loadEventFired");
			await ui.call("Page.navigate", { url: `${url}?${name}` });
			await loaded;
			await ui.wait(`window.ui?.token === '?${name}' && document.querySelector('.omp-footer-trigger') && window.ui.requests().length === 1`);
			await ui.evaluate("window.ui.reply()");
			await ui.wait("!document.querySelector('.omp-footer-trigger').disabled");
			await ui.evaluate("window.ui.density('detailed')");
		}
		/** One real call as the two durable entries Chat renders: the assistant message that made it and its result. `at` is when the result arrived. */
		const show = async (call: Call, at = 1_790_000_005_000, started = at - 4_200): Promise<void> => {
			const entries = [
				{ type: "message", id: `a-${call.id}`, parentId: null, timestamp: new Date(started).toISOString(), message: { role: "assistant", model: "m", timestamp: started - 20_000, stopReason: "toolUse", content: [{ type: "toolCall", id: call.id, name: call.tool, arguments: call.args }] } },
				{ type: "message", id: `r-${call.id}`, parentId: `a-${call.id}`, timestamp: new Date(at).toISOString(), message: { role: "toolResult", timestamp: at, toolCallId: call.id, toolName: call.tool, isError: call.isError, content: [{ type: "text", text: call.resultText }], details: call.details } },
			];
			await ui.evaluate(`window.ui.push({entries:${JSON.stringify(entries)},durableCount:2,working:false,settled:true})`);
			await ui.wait(`document.querySelector('[data-tool-call-id=${JSON.stringify(call.id)}]')`);
		};
		const card = (call: Call): string => `[data-tool-call-id=${JSON.stringify(call.id)}]`;
		const open = async (call: Call): Promise<void> => {
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-head`)}).click()`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-body`)})`);
		};
		const text = (selector: string): Promise<string> => ui.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);

		await t.test("a long command shows the tail of its output, 12 rows, with the exact count above", async () => {
			const call = real("bash-long-786-lines"); const n = outputLines(call);
			await reset("preview-bash"); await show(call); await open(call);
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-body pre:not(.omp-tool-input *)`)}).textContent.replace(/\\n$/,'').split('\\n').length`), 12);
			assert.equal(await text(`${card(call)} .omp-output-marker > span`), `… (${n - 12} earlier lines, showing 12 of ${n})`);
			assert.equal(await text(`${card(call)} .omp-output-more`), `Show all ${n} lines`);
			assert.equal(await ui.evaluate("Array.from(document.querySelector('.omp-transcript').querySelectorAll('*')).some(node=>/auto|scroll/.test(getComputedStyle(node).overflowY))"), false, "no nested vertical scroll owner");
			assert.ok(await ui.evaluate<number>(`document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-tool-body *`)}).length`) < 80, "the DOM of a 786-line result is what a 12-line one costs");
		});

		await t.test("a file, a listing and a diff show their head, 12 rows, with an exact marker below", async () => {
			const read = real("read-text-file");
			await reset("preview-read"); await show(read); await open(read);
			const shown = textOf(read.details.displayContent).split("\n").length;
			assert.equal(await ui.evaluate(`document.querySelectorAll(${JSON.stringify(`${card(read)} .omp-native-code-line`)}).length`), 12);
			assert.equal(await text(`${card(read)} .omp-output-marker > span`), `… ${shown - 12} more lines`);

			const glob = real("glob-result-limit");
			await reset("preview-glob"); await show(glob); await open(glob);
			assert.equal(await ui.evaluate(`document.querySelectorAll(${JSON.stringify(`${card(glob)} .omp-native-list > li`)}).length`), 12);
			assert.equal(await text(`${card(glob)} .omp-output-marker > span`), `… ${listOf(glob.details.files).length - 12} more files`);

			const base = real("edit-hashline-diff");
			const edit: Call = { ...base, id: "edit-long-diff", details: { ...base.details, diff: Array.from({ length: 5 }, (_, hunk) => ` ${hunk * 20}|  keep\n+${hunk * 20 + 1}|  added ${hunk}\n ${hunk * 20 + 2}|  keep\n\n`).join("") } };
			await reset("preview-edit"); await show(edit); await open(edit);
			assert.match(await text(`${card(edit)} .omp-output-marker > span`), /^… \(\d+ more hunks?, \d+ more lines?\)$|^… \d+ more lines?$/);
			assert.ok(await ui.evaluate<number>(`document.querySelectorAll(${JSON.stringify(`${card(edit)} .omp-native-diff > *`)}).length`) <= 14, "a diff preview is 12 rows");
		});

		await t.test("a result of up to 15 rows is shown whole: three rows are not worth a marker", async () => {
			const call = real("glob-list");
			await reset("preview-small"); await show(call); await open(call);
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-output-marker`)})`), null);
			assert.equal(await ui.evaluate(`document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-native-list > li`)}).length`), listOf(call.details.files).length);
		});

		await t.test("Show all, pressed with a real pointer, replaces the preview; Collapse closes the card and the next open starts at the preview", async () => {
			const call = real("bash-long-786-lines");
			await reset("show-all"); await show(call); await open(call);
			const point = await ui.evaluate<{ x: number; y: number }>(`(()=>{const b=document.querySelector(${JSON.stringify(`${card(call)} .omp-output-more`)}).getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2}})()`);
			for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await ui.call("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-collapse`)})`);
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-output-marker`)})`), null, "the preview marker is gone");
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-window`)}).dataset.windowRows`), String(outputLines(call)), "the full view windows a long result: one spacer of n rows");
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-collapse button`)}).focus()`);
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
			await ui.wait(`!document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-body`)})`);
			assert.equal(await ui.evaluate("document.activeElement?.classList.contains('omp-tool-head')"), true, "focus returns to the head");
			await open(call);
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-collapse`)})`), null, "a re-open starts at the preview");
			assert.ok(await text(`${card(call)} .omp-output-marker`));
		});

		await t.test("the head says exit code, size and exact time of a command, closed and open alike, and nothing for a clean exit", async () => {
			const gist = (call: Call): Promise<string> => text(`${card(call)} .omp-gist`);
			const ok = real("bash-ndjson"), failed = real("bash-tsc-npm-typecheck-fail"), missing = real("bash-fail-exit127"), slow = real("bash-timeout");
			for (const [call, expected] of [[ok, /^25 lines · 931 ms$/], [failed, /^exit 2 · \d+ lines? · 4\.67 s$/], [missing, /^exit 127/], [slow, /exit 1 · timed out · .* · 42\.4 s$/]] as const) {
				await reset(`gist-${call.id}`); await show(call);
				const closed = await gist(call);
				assert.match(closed, expected, call.id);
				await open(call);
				assert.equal(await gist(call), closed, `${call.id}: the head does not change when the card opens`);
			}
			await reset("gist-failed"); await show(failed);
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(failed)} .omp-gist--err`)})?.textContent`), "exit 2", "an exit code is an error part, not colour alone");
			await open(failed);
			assert.equal(await text(`${card(failed)} .omp-output-bar .omp-chip--err`), "EXIT 2");
			await reset("gist-ok"); await show(ok);
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(ok)} .omp-gist--err`)})`), null);
		});

		await t.test("a derived duration is approximate and appears only above 1.5 s; a short one stays silent", async () => {
			const call = real("read-text-file");
			await reset("derived-long"); await show(call, 1_790_000_005_000, 1_790_000_000_800);
			assert.match(await text(`${card(call)} .omp-gist`), /≈ 4\.20 s$/);
			await reset("derived-short"); await show(call, 1_790_000_001_000, 1_790_000_000_000);
			assert.doesNotMatch(await text(`${card(call)} .omp-gist`), /≈/);
		});

		await t.test("OMP's appended notices leave the output and become one footer line with a working artifact id", async () => {
			const truncated = real("bash-trunc-middle-artifact");
			await reset("footer-truncated"); await show(truncated); await open(truncated);
			const footer = await text(`${card(truncated)} .omp-tool-footer`);
			assert.match(footer, /Output truncated/); assert.match(footer, /artifact:\/\/\d+/);
			assert.doesNotMatch(await text(`${card(truncated)} .omp-tool-body`), /Wall time:|Command exited with code|\[Showing lines|\[raw output/);
			const background = real("bash-background-job-started");
			await reset("footer-background"); await show(background); await open(background);
			assert.match(await text(`${card(background)} .omp-tool-footer`), /running in background as bg_59/);
			assert.doesNotMatch(await text(`${card(background)} .omp-tool-body`), /Do NOT poll|Backgrounded as job/);
		});

		await t.test("Copy puts exactly the output on the clipboard, without the notices, and says how much", async () => {
			const call = real("bash-ndjson");
			await reset("copy"); await show(call); await open(call);
			await ui.evaluate("window.clip=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(value){window.clip=value}}})");
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-output-bar:not(.omp-tool-input *) .omp-iconbtn[aria-label^=Copy]`)}).click()`);
			await ui.wait("window.clip!==null");
			assert.equal(await ui.evaluate("window.clip"), splitToolNotices(call.resultText).body);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-output-bar [role=status]`)})`);
			assert.match(await text(`${card(call)} .omp-output-bar [role=status]`), /^Copied the output \(25 lines, [\d,]+ characters\)$/);
			await ui.evaluate("navigator.clipboard.writeText=async()=>{throw new Error('Denied')}");
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-output-bar:not(.omp-tool-input *) .omp-iconbtn[aria-label^=Copy]`)}).click()`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-output-bar [role=status]`)})?.textContent.startsWith('Copy failed')`);
		});

		await t.test("a long command is an input block with its own Copy, while a short one lives in the head", async () => {
			const call: Call = { id: "multi-line-command", tool: "bash", args: { command: "set -e\nfor f in *.ts; do\n  echo \"$f\"\ndone\n" }, resultText: "a.ts\nb.ts", details: { exitCode: 0, wallTimeMs: 40 }, isError: false };
			await reset("input-block"); await show(call); await open(call);
			assert.equal(await text(`${card(call)} .omp-tool-input .omp-output-label`), "Command");
			assert.match(await text(`${card(call)} .omp-tool-input pre`), /for f in \*\.ts; do/);
			await ui.evaluate("window.clip=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(value){window.clip=value}}})");
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-input .omp-iconbtn`)}).click()`);
			await ui.wait("window.clip!==null");
			assert.equal(await ui.evaluate("window.clip"), call.args.command);
			const short: Call = { ...real("bash-ndjson"), id: "short-command", args: { command: "jq -c . data.ndjson" } };
			await reset("no-input-block"); await show(short); await open(short);
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(short)} .omp-tool-input`)})`), null);
		});

		await t.test("a running command shows a live clock in its head and the tail of what has arrived, marked live", async () => {
			await reset("streaming");
			const output = Array.from({ length: 40 }, (_, index) => `progress ${index}`).join("\n");
			const assistant = { role: "assistant", model: "m", timestamp: 1000, stopReason: "toolUse", content: [{ type: "toolCall", id: "live-bash", name: "bash", arguments: { command: "npm run build" } }] };
			await ui.evaluate(`window.fixtureClock.setNow(100000);window.ui.push({entries:[],working:true,settled:false,stream:{messageId:'live-message',message:${JSON.stringify(assistant)}},streamPosition:{anchorId:null,seq:1},activeTools:[{toolCallId:'live-bash',toolName:'bash',args:{command:'npm run build'},startedAt:100000,partialResult:{content:[{type:'text',text:${JSON.stringify(output)}}]}}]})`);
			await ui.wait("document.querySelector('[data-tool-call-id=\"live-bash\"][data-tool-status=\"running\"]')");
			await ui.evaluate("document.querySelector('[data-tool-call-id=\"live-bash\"] .omp-tool-head').click()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"live-bash\"] .omp-output-marker')");
			assert.match(await text("[data-tool-call-id=\"live-bash\"] .omp-output-marker > span"), /^… \(28 earlier lines, showing 12 of 40\) · live$/);
			assert.equal(await ui.evaluate("document.querySelector('[data-tool-call-id=\"live-bash\"] .omp-gist')"), null, "under a second there is no clock yet");
			await ui.evaluate("window.fixtureClock.setNow(105000);window.fixtureClock.tick()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"live-bash\"] .omp-gist')?.textContent==='5.00 s'");
			await ui.evaluate("window.fixtureClock.setNow(107000);window.fixtureClock.tick()");
			await ui.wait("document.querySelector('[data-tool-call-id=\"live-bash\"] .omp-gist')?.textContent==='7.00 s'");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		const THEME = "{id:'Dark Modern',rules:[{scopes:['support.type.property-name'],foreground:'#9CDCFE'},{scopes:['string'],foreground:'#CE9178'},{scopes:['constant.numeric'],foreground:'#B5CEA8'},{scopes:['constant.language'],foreground:'#569CD6'}]}";
		const rowsOf = (call: Call): string => `${card(call)} .omp-json-row`;
		const countOf = (selector: string): Promise<number> => ui.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
		const pointerClick = async (selector: string): Promise<void> => {
			const point = await ui.evaluate<{ x: number; y: number }>(`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center',behavior:'instant'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const b=e.getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2}})()`);
			for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await ui.call("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
		};

		await t.test("newline-delimited JSON is one foldable row per record, with a count, a preview, Show all and every record in Copy", async () => {
			const call = real("bash-ndjson");
			await reset("ndjson"); await show(call); await open(call);
			assert.equal(await text(`${card(call)} .omp-format-badge`), "NDJSON · 25 records");
			assert.equal(await countOf(rowsOf(call)), 12, "the preview is 12 records");
			assert.equal(await text(`${card(call)} .omp-output-marker > span`), "… 13 more records");
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(rowsOf(call))}).textContent.startsWith('{"name":"asset_add_component"')`), true, "a record row is the record's own text");
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${rowsOf(call)} .omp-json-gutter`)}).dataset.n`), "1", "the record number is the gutter");
			// One record unfolded: its rows count in the marker, but the button still counts records; folded again, the rest of the test starts from 25 rows.
			const twisty = `${rowsOf(call)}:nth-child(1) .omp-json-twisty`;
			await pointerClick(twisty);
			await ui.wait(`document.querySelector(${JSON.stringify(twisty)}).getAttribute('aria-label')==='Collapse record'`);
			assert.equal(await text(`${card(call)} .omp-output-more`), "Show all 25 records", "unfolding a record does not change what Show all counts");
			await pointerClick(twisty);
			await ui.wait(`document.querySelector(${JSON.stringify(twisty)}).getAttribute('aria-label')==='Expand record'`);
			await pointerClick(`${card(call)} .omp-output-more`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-collapse`)})`);
			assert.equal(await countOf(rowsOf(call)), 25, "Show all gives every record");
			// A record opens as a tree of its own, one level deep (the first record the transcript's scroll position leaves in view).
			const seen = await ui.evaluate<number>(`[...document.querySelectorAll(${JSON.stringify(rowsOf(call))})].findIndex(row=>row.getBoundingClientRect().top>=document.querySelector('.omp-tool-toolbar').getBoundingClientRect().bottom&&row.getBoundingClientRect().bottom<=innerHeight)+1`);
			assert.ok(seen >= 1, "a record row is in view");
			await pointerClick(`${rowsOf(call)}:nth-child(${seen}) .omp-json-twisty`);
			await ui.wait(`document.querySelectorAll(${JSON.stringify(rowsOf(call))}).length>25`);
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${rowsOf(call)}:nth-child(${seen}) .omp-json-twisty`)}).getAttribute('aria-label')`), "Collapse record");
			assert.match(await ui.evaluate<string>(`[...document.querySelectorAll(${JSON.stringify(rowsOf(call))})].slice(${seen - 1},${seen + 3}).map(row=>row.textContent.replace(/\\n$/,'')).join('|')`), /^\{\|  "name": "asset_[a-z_]+",\|  "params": \[ … \d+ items \]\|\}(?:\|\{"name":"asset_.*)?$/);
			await ui.evaluate("window.clip=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(value){window.clip=value}}})");
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-output-bar:not(.omp-tool-input *) .omp-iconbtn[aria-label^=Copy]`)}).click()`);
			await ui.wait("window.clip!==null");
			assert.equal(await ui.evaluate("window.clip"), splitToolNotices(call.resultText).body, "Copy gives every record");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a JSON document over 400 lines is coloured with the theme, folds, expands, and switches to the text it came as", async () => {
			const call = real("bash-json-long-columntruncated");
			await reset("json-long");
			await ui.evaluate(`document.body.setAttribute('data-vscode-theme-id','Dark Modern');window.ui.receive({type:'omp:chat-code-theme',themes:[${THEME}]})`);
			await show(call); await open(call);
			assert.equal(await text(`${card(call)} .omp-format-badge`), "JSON · lines cut", "OMP cut long lines: the document is shown as JSON, never as parsed data");
			await ui.wait(`document.querySelector(${JSON.stringify(`${rowsOf(call)} span[style]`)})`);
			const colours = await ui.evaluate<Array<[string, string]>>(`[...document.querySelectorAll(${JSON.stringify(`${rowsOf(call)} span[style]`)})].slice(0,6).map(span=>[span.textContent,span.style.color])`);
			assert.deepEqual(colours.slice(0, 3), [['"success"', "rgb(156, 220, 254)"], ["true", "rgb(86, 156, 214)"], ['"command"', "rgb(156, 220, 254)"]]);
			// Folded to two levels: the nested containers of the document are one row each.
			assert.match(await text(`${rowsOf(call)}:nth-child(4)`), /"data": \{ … \d+ keys \},?\s*$|"data": \{\s*$/);
			assert.ok((await countOf(rowsOf(call))) <= 15, "the preview is 12 rows of the folded tree");
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} [aria-label="Expand all"]`)}).click()`);
			await pointerClick(`${card(call)} .omp-output-more`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-window`)})`);
			const rows = await countOf(rowsOf(call));
			assert.ok(rows > 0 && rows <= 130, `the full view windows a 531-line document (got ${rows} rows in the DOM)`);
			await ui.evaluate("document.querySelector('.omp-transcript').scrollTop=1e9");
			await ui.wait(`[...document.querySelectorAll(${JSON.stringify(rowsOf(call))})].some(row=>row.textContent.includes('"warnings"'))`);
			// Text is the text it came as; Formatted is back where it was.
			await ui.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-segment`)})].find(b=>b.textContent==='Text').click()`);
			await ui.wait(`!document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-body > .omp-json`)})`);
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-window`)}).dataset.windowRows`), String(outputLines(call)), "Text is the lines of the text it came as");
			assert.equal(await ui.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-segment`)})].map(b=>b.getAttribute('aria-pressed')).join()`), "false,true");
			await ui.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-segment`)})].find(b=>b.textContent==='Formatted').click()`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-body > .omp-json`)})`);
			await ui.evaluate("window.ui.receive({type:'omp:chat-code-theme',themes:[]});document.body.removeAttribute('data-vscode-theme-id')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a compact document is re-indented without changing a single number, and a container folds to its size and back", async () => {
			const compact = '{"id":12345678901234567890,"big":1e400,"zero":-0,"list":[1,2,3],"meta":{"a":{"b":{"c":1}}}}';
			const call: Call = { id: "mcp-compact-json", tool: "mcp__demo_tool", args: { query: "x" }, resultText: compact, details: {}, isError: false };
			await reset("json-compact"); await show(call); await open(call);
			assert.equal(await text(`${card(call)} .omp-format-badge`), "JSON · 17 lines");
			const shown = await ui.evaluate<string>(`[...document.querySelectorAll(${JSON.stringify(rowsOf(call))})].map(row=>row.textContent).join('\\n')`);
			assert.match(shown, /"id": 12345678901234567890,/); assert.match(shown, /"big": 1e400,/); assert.match(shown, /"zero": -0,/);
			assert.match(shown, /"a": \{ … 1 key \}/, "containers two levels down start folded");
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${rowsOf(call)} .omp-json-ghost--fold`)}).click()`);
			await ui.wait(`document.querySelectorAll(${JSON.stringify(rowsOf(call))}).length>12`);
			await ui.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-segment`)})].find(b=>b.textContent==='Text').click()`);
			await ui.wait(`!document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-body > .omp-json`)})`);
			assert.equal((await text(`${card(call)} .omp-tool-body > .omp-native-preview pre`)).replace(/\n$/, ""), compact, "Text is exactly the text the tool returned");
			// Arguments of an unknown tool are a tree too, one level deep, with their own fold state.
			await ui.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-segment`)})].find(b=>b.textContent==='Formatted').click()`);
			assert.match(await text(`${card(call)} .omp-tool-section .omp-json`), /"query": "x"/);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		const longCall: Call = {
			id: "bash-4200-lines", tool: "bash", args: { command: "seq 1 4200" }, isError: false, details: { exitCode: 0, wallTimeMs: 12 },
			resultText: Array.from({ length: 4200 }, (_, index) => `line ${index + 1}: ${index % 100 === 0 ? "needle" : "hay"} ${"x".repeat(24)}`).join("\n"),
		};
		const windowRows = (call: Call): Promise<string[]> => ui.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-window-layer pre > span`)})].map(row=>row.textContent.replace(/\\n$/,''))`);
		const press = async (key: string, code: string, keyCode: number): Promise<void> => {
			await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
			await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
		};
		// A reader scrolling away from the bottom (a wheel turn is what tells the transcript to stop following the latest output).
		const scrollTo = async (call: Call, row: number): Promise<void> => {
			await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: 300, y: 300, deltaX: 0, deltaY: -40 });
			await ui.evaluate(`(()=>{const scroller=document.querySelector('.omp-transcript'),block=document.querySelector(${JSON.stringify(`${card(call)} .omp-window`)});scroller.scrollTop+=block.getBoundingClientRect().top-scroller.getBoundingClientRect().top+${row}*(block.getBoundingClientRect().height-14)/Number(block.dataset.windowRows)-100})()`);
		};

		await t.test("a 4,200-line output is windowed: the DOM stays bounded whatever the scroll position, and the toolbar sticks to the top of the transcript", async () => {
			const call = longCall;
			await reset("windowed"); await show(call); await open(call);
			assert.equal(await text(`${card(call)} .omp-output-marker > span`), "… (4188 earlier lines, showing 12 of 4,200)".replace("4188", "4,188"));
			await pointerClick(`${card(call)} .omp-output-more`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-window`)})`);
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-window`)}).dataset.windowRows`), "4200");
			assert.ok((await windowRows(call)).length <= 140, "the rows in the DOM are the visible ones and a margin");
			assert.ok(await ui.evaluate<number>(`document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-tool-body *`)}).length`) < 700, "the DOM of a 4,200-line result stays small");
			assert.equal(await ui.evaluate("Array.from(document.querySelector('.omp-transcript').querySelectorAll('*')).some(node=>/auto|scroll/.test(getComputedStyle(node).overflowY))"), false, "no nested vertical scroll owner");
			await scrollTo(call, 2500);
			await ui.wait(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-window-layer pre > span`)})].some(row=>row.textContent.startsWith('line 2501:'))`);
			assert.ok((await windowRows(call)).length <= 140, "scrolling moves the window and keeps it bounded");
			const geometry = await ui.evaluate<{ stuck: number; height: number }>("(()=>{const bar=document.querySelector('.omp-tool-toolbar').getBoundingClientRect(),scroller=document.querySelector('.omp-transcript').getBoundingClientRect();return{stuck:bar.top-scroller.top,height:bar.height}})()");
			assert.ok(geometry.stuck >= -1 && geometry.stuck <= 2, `the toolbar sticks to the top of the transcript while its block scrolls (${geometry.stuck})`);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the filter works on the whole text, Escape clears it before it collapses the card, and Collapse leaves from the toolbar", async () => {
			const call = longCall;
			await reset("filter"); await show(call); await open(call);
			await pointerClick(`${card(call)} .omp-output-more`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-filter`)})`);
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-filter`)}).focus()`);
			await ui.call("Input.insertText", { text: "needle" });
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-filter-count`)})?.textContent==='42 of 4,200 lines'`);
			const shown = await ui.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-tool-body > .omp-native-preview pre > span`)})].map(row=>row.textContent)`);
			assert.equal(shown.length, 42, "the matches of the whole text, not of the rows in the page");
			assert.ok(shown.every(row => row.includes("needle")));
			await ui.evaluate("window.clip=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(value){window.clip=value}}})");
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-output-bar .omp-iconbtn[aria-label^=Copy]`)}).click()`);
			await ui.wait("window.clip!==null");
			assert.equal(await ui.evaluate<number>("window.clip.split('\\n').length"), 4200, "Copy gives the whole text, not the filtered lines");
			await press("Escape", "Escape", 27);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-filter`)}).value===''`);
			assert.equal(await ui.evaluate(`!!document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-body`)})`), true, "the first Escape only cleared the filter");
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-window`)})`);
			await press("Escape", "Escape", 27);
			await ui.wait(`!document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-body`)})`);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("wrap shows at most 1,500 lines and says so; turning it off windows the whole text again", async () => {
			const call = longCall;
			await reset("wrap"); await show(call); await open(call);
			await pointerClick(`${card(call)} .omp-output-more`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-window`)})`);
			const wrapButton = `${card(call)} .omp-tool-toolbar [aria-label="Wrap long lines"]`;
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(wrapButton)}).getAttribute('aria-pressed')`), "false", "beyond 120 lines wrap starts off");
			await ui.evaluate(`document.querySelector(${JSON.stringify(wrapButton)}).click()`);
			await ui.wait(`!document.querySelector(${JSON.stringify(`${card(call)} .omp-window`)})`);
			assert.equal(await countOf(`${card(call)} .omp-tool-body > div > .omp-native-preview pre > span, ${card(call)} .omp-tool-body .omp-native-preview pre > span`), 1500);
			assert.match(await text(`${card(call)} .omp-tool-body`), /show the first 1,500 of 4,200 lines/);
			await ui.evaluate(`document.querySelector(${JSON.stringify(wrapButton)}).click()`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-window`)})`);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a screen reader gets the whole text of a long output in the page, up to 5,000 lines", async () => {
			const call = longCall;
			await reset("reader");
			await ui.evaluate("window.ui.receive({type:'omp:chat-display-preferences',epoch:window.ui.current().epoch,toolCallDetail:'detailed',accessibilitySupport:true})");
			await show(call); await open(call);
			await pointerClick(`${card(call)} .omp-output-more`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-toolbar`)})`);
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-window`)})`), null, "no window: a windowed list is unreadable to a reader");
			assert.equal(await countOf(`${card(call)} .omp-tool-body .omp-native-preview pre > span`), 4200);
			await ui.evaluate("window.ui.receive({type:'omp:chat-display-preferences',epoch:window.ui.current().epoch,toolCallDetail:'detailed',accessibilitySupport:false})");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("rows a selection reaches stay mounted while the window moves, so a native copy gives everything selected", async () => {
			const call = longCall;
			await reset("selection"); await show(call); await open(call);
			await pointerClick(`${card(call)} .omp-output-more`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-window`)})`);
			// The transcript follows the end of the content, so Show all on a call at the bottom leaves the window at the last rows: go to the first rows before selecting them.
			await scrollTo(call, 0);
			await ui.wait(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-window-layer pre > span`)})].some(row=>row.textContent.startsWith('line 1:'))`);
			await ui.evaluate(`(()=>{const rows=[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-window-layer pre > span`)})];const start=rows.find(row=>row.textContent.startsWith('line 3:')),end=rows.find(row=>row.textContent.startsWith('line 7:'));window.anchor=start;getSelection().setBaseAndExtent(start.firstChild,0,end.firstChild,5)})()`);
			await scrollTo(call, 1200);
			await ui.wait(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-window-layer pre > span`)})].some(row=>row.textContent.startsWith('line 1201:'))`);
			assert.equal(await ui.evaluate("window.anchor.isConnected"), true, "the row holding the start of the selection is still mounted");
			assert.match(await ui.evaluate<string>("getSelection().toString()"), /^line 3:/, "and the selection is intact");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("code above the highlight caps is coloured in aligned chunks, so a scroll shows colour in the rows that arrive and never recolours the ones that stay", async () => {
			const content = Array.from({ length: 3000 }, (_, index) => `const v${index} = ${index};`).join("\n");
			const call: Call = { id: "write-3000-lines", tool: "write", args: { path: "big.ts", content }, resultText: "Successfully wrote big.ts", details: {}, isError: false };
			await reset("chunked-colour");
			await ui.evaluate(`document.body.setAttribute('data-vscode-theme-id','Dark Modern');window.ui.receive({type:'omp:chat-code-theme',themes:[${THEME}]})`);
			await show(call); await open(call);
			await pointerClick(`${card(call)} .omp-output-more`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-window`)})`);
			const coloured = (row: number): Promise<string | null> => ui.evaluate<string | null>(`(()=>{const line=[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-window .omp-native-code-line`)})].find(l=>l.textContent.includes('const v${row} ='));return line?.querySelector('span[style]')?.style.color??null})()`);
			await ui.wait(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-window .omp-native-code-line span[style]`)})].length>0`);
			await scrollTo(call, 2000);
			await ui.wait(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-window .omp-native-code-line`)})].some(l=>l.textContent.includes('const v2000 ='))`);
			await ui.wait(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-window .omp-native-code-line`)})].find(l=>l.textContent.includes('const v2000 ='))?.querySelector('span[style]')`);
			assert.equal(await coloured(2000), "rgb(181, 206, 168)", "a row far past the first 400 lines is coloured (its number)");
			await ui.evaluate("window.ui.receive({type:'omp:chat-code-theme',themes:[]});document.body.removeAttribute('data-vscode-theme-id')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("an ls -l listing is a table in a grid of its columns, the Text switch gives the same lines as text, and the badge says what was detected", async () => {
			const call = real("bash-table-ls-la");
			await reset("table"); await show(call); await open(call);
			assert.match(await text(`${card(call)} .omp-format-badge`), /^Table · \d+ rows$/);
			const row = `${card(call)} .omp-grid-row`;
			assert.ok(await countOf(row) >= 2);
			assert.equal(await ui.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(row)})).display`), "grid");
			assert.equal(await ui.evaluate(`document.querySelectorAll(${JSON.stringify(`${row}:first-child > span`)}).length`) , 7, "seven cells to a row of ls -l");
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${row} > span:nth-child(5)`)}).classList.contains('omp-cell--right')`), true, "sizes are right-aligned");
			await ui.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-segment`)})].find(b=>b.textContent==='Text').click()`);
			await ui.wait(`!document.querySelector(${JSON.stringify(row)})`);
			await ui.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-segment`)})].find(b=>b.textContent==='Formatted').click()`);
			await ui.wait(`document.querySelector(${JSON.stringify(row)})`);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a stack trace dims its frames and links the path the host proves, opening it at its line and column", async () => {
			const trace = "TypeError: x is not a function\n    at run (src/proof.ts:12:5)\n    at main (src/proof.ts:30:1)\n    at node:internal/main:1:1";
			const call: Call = { id: "bash-trace-link", tool: "bash", args: { command: "node src/proof.ts" }, resultText: trace, details: {}, isError: true };
			await reset("trace"); await show(call); await open(call);
			assert.match(await text(`${card(call)} .omp-format-badge`), /^Stack trace · 2 frames$/);
			assert.equal(await countOf(`${card(call)} .omp-row--frame`), 2, "the node: frame is not a project frame");
			await ui.wait("window.sent.some(message=>message.type==='omp:terminal-link-validate' && message.target==='src/proof.ts')");
			await ui.evaluate(`window.sent.filter(message=>message.type==='omp:terminal-link-validate').forEach(message=>window.ui.receive({type:'omp:terminal-link-validation',requestId:message.requestId,valid:message.target==='src/proof.ts'}))`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-row--frame .omp-file-link[data-file-target="src/proof.ts:12:5"]`)})`);
			assert.equal(await text(`${card(call)} .omp-row--frame .omp-file-link`), "src/proof.ts:12:5", "the characters are the same as the text");
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-row--frame .omp-file-link`)}).click()`);
			await ui.wait("window.sent.some(message=>message.type==='omp:terminal-link-open' && message.target==='src/proof.ts:12:5')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("error, warning and pass lines are tinted by their words and plain lines are not", async () => {
			const call = real("bash-tsc-npm-typecheck-fail");
			await reset("tone"); await show(call); await open(call);
			assert.equal(await text(`${card(call)} .omp-tone--err`), "src/extension.ts(902,13): error TS2304: Cannot find name 'handleGuestControlRequest'.\n");
			assert.equal(await countOf(`${card(call)} .omp-tone--err`), 1);
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tone--err`)}).textContent.includes('Command exited')`), false);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		const menuButton = (call: Call): string => `${card(call)} .omp-output-bar .omp-tool-menu > button`;
		const items = (call: Call): Promise<{ id: string; disabled: boolean; reason: string }[]> => ui.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${card(call)} .omp-output-bar [role=menuitem]`)})].map(item=>({id:item.dataset.menuItem,disabled:item.getAttribute('aria-disabled')==='true',reason:item.querySelector('.omp-tool-menu-reason')?.textContent??''}))`);
		const key = (name: string): Promise<void> => ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name }).then(() => ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name })).then(() => undefined);
		const installClipboard = (): Promise<void> => ui.evaluate("window.clip=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(value){window.clip=value}}})");

		await t.test("the ⋯ menu is a menu: arrows, Home and End move, Escape closes it before the card collapses, and a disabled item says why", async () => {
			const call = real("bash-long-786-lines");
			await reset("menu"); await show(call); await open(call);
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(menuButton(call))}).getAttribute('aria-haspopup')`), "menu");
			await ui.evaluate(`document.querySelector(${JSON.stringify(menuButton(call))}).click()`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} [role=menu]`)})`);
			assert.deepEqual((await items(call)).map(item => item.id), ["copy-command", "copy-output", "copy-details", "raw", "open-full"]);
			const open_ = (await items(call)).find(item => item.id === "open-full")!;
			assert.equal(open_.disabled, true);
			assert.match(open_.reason, /not truncated/, "an untruncated output has no full copy, and the item says so");
			const focused = (): Promise<string> => ui.evaluate("document.activeElement?.dataset?.menuItem ?? null");
			assert.equal(await focused(), "copy-command", "the first item takes focus");
			await key("ArrowDown"); assert.equal(await focused(), "copy-output");
			await key("End"); assert.equal(await focused(), "open-full");
			await key("ArrowDown"); assert.equal(await focused(), "copy-command", "the arrows wrap");
			await key("ArrowUp"); assert.equal(await focused(), "open-full");
			await key("Home"); assert.equal(await focused(), "copy-command");
			await key("Escape");
			await ui.wait(`!document.querySelector(${JSON.stringify(`${card(call)} [role=menu]`)})`);
			assert.equal(await ui.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(menuButton(call))})`), true, "Escape returns focus to the menu button");
			assert.ok(await ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-body`)}))`), "the first Escape only closed the menu; the card is still open");
			await key("Escape");
			await ui.wait(`!document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-body`)})`);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("View raw result and details shows the result as the model sees it and the details cut, Copy details JSON copies the object", async () => {
			const call = real("bash-trunc-middle-artifact");
			await reset("raw"); await show(call); await open(call); await installClipboard();
			const choose = async (id: string): Promise<void> => {
				await ui.evaluate(`document.querySelector(${JSON.stringify(menuButton(call))}).click()`);
				await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} [data-menu-item=${id}]`)})`);
				await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} [data-menu-item=${id}]`)}).click()`);
			};
			assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-raw`)})`), null);
			await choose("raw");
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-raw`)})`);
			assert.equal(await countOf(`${card(call)} .omp-tool-raw .omp-tool-input`), 2, "two blocks: the result text and the details");
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-raw [aria-label="Copy raw result"]`)}).click()`);
			await ui.wait("window.clip !== null");
			assert.equal(await ui.evaluate("window.clip"), call.resultText, "the raw result is the text exactly as the model sees it, notices included, which the body strips");
			assert.match(await ui.evaluate<string>("window.clip"), /artifact:\/\/69/);
			assert.match(await text(`${card(call)} .omp-tool-raw .omp-json`), /wallTimeMs/, "the details are a JSON tree");
			await choose("copy-details");
			await ui.wait("window.clip !== null");
			assert.deepEqual(JSON.parse(await ui.evaluate("window.clip")), JSON.parse(JSON.stringify(call.details)), "the whole details object, as JSON");
			assert.match(await text(`${card(call)} .omp-tool-menu [role=status]`), /^Copied the details \(\d+ lines, \d+ characters\)$/);
			await choose("copy-output");
			await ui.wait(`window.clip !== null && !window.clip.startsWith('{')`);
			assert.equal(await ui.evaluate("window.clip"), splitToolNotices(call.resultText).body, "Copy output copies the cleaned output");
			assert.ok(!(await ui.evaluate<string>("window.clip")).includes("artifact://69"), "without the notices");
			await choose("raw");
			await ui.wait(`!document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-raw`)})`);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("the footer's artifact link and the menu's Open full output both ask the host for that artifact, with the page's epoch and no path", async () => {
			const call = real("bash-trunc-middle-artifact");
			await reset("artifact"); await show(call); await open(call);
			await ui.evaluate("window.sent.length=0");
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-footer .omp-artifact-link`)}).click()`);
			await ui.wait("window.sent.some(message=>message.type==='omp:open-artifact')");
			const epoch = await ui.evaluate<{ nonce: string; counter: number }>("window.ui.current().epoch");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:open-artifact')"), [{ type: "omp:open-artifact", artifactId: "69", epoch }]);
			await ui.evaluate("window.sent.length=0");
			await ui.evaluate(`document.querySelector(${JSON.stringify(menuButton(call))}).click()`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} [data-menu-item=open-full]`)})`);
			assert.equal((await items(call)).find(item => item.id === "open-full")?.disabled, false);
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} [data-menu-item=open-full]`)}).click()`);
			await ui.wait("window.sent.some(message=>message.type==='omp:open-artifact')");
			assert.deepEqual(await ui.evaluate("window.sent.filter(message=>message.type==='omp:open-artifact')"), [{ type: "omp:open-artifact", artifactId: "69", epoch }]);
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		/** The calls of a long transcript, `before` of them above `target` and `after` below: one reply each, or all in one reply (`grouped`), which the overview digests as one group. */
		const showAround = async (target: Call, before: number, after: number, grouped: boolean): Promise<void> => {
			const filler = real("glob-list");
			const all: Call[] = [...Array.from({ length: before }, (_, index) => ({ ...filler, id: `before-${index}` })), target, ...Array.from({ length: after }, (_, index) => ({ ...filler, id: `after-${index}` }))];
			const entries: unknown[] = []; let parent: string | null = null;
			const at = 1_790_000_000_000;
			const result = (call: Call, replyId: string, time: number): unknown => ({ type: "message", id: `r-${call.id}`, parentId: replyId, timestamp: new Date(time).toISOString(), message: { role: "toolResult", timestamp: time, toolCallId: call.id, toolName: call.tool, isError: call.isError, content: [{ type: "text", text: call.resultText }], details: call.details } });
			const reply = (id: string, group: readonly Call[], time: number): unknown => ({ type: "message", id, parentId: parent, timestamp: new Date(time - 4_200).toISOString(), message: { role: "assistant", model: "m", timestamp: time - 4_200, stopReason: "toolUse", content: group.map(call => ({ type: "toolCall", id: call.id, name: call.tool, arguments: call.args })) } });
			if (grouped) {
				entries.push(reply("a-group", all, at + 5_000)); parent = "a-group";
				for (const call of all) { entries.push(result(call, parent!, at + 5_000)); }
			} else {
				for (const [index, call] of all.entries()) { entries.push(reply(`a-${call.id}`, [call], at + index * 1_000)); entries.push(result(call, `a-${call.id}`, at + index * 1_000 + 200)); parent = `r-${call.id}`; }
			}
			await ui.evaluate(`window.ui.density(${JSON.stringify(grouped ? "overview" : "detailed")});window.ui.push({entries:${JSON.stringify(entries)},durableCount:${entries.length},working:false,settled:true})`);
			await ui.wait(grouped ? "document.querySelector('.omp-overview-head')" : `document.querySelector(${JSON.stringify(`[data-tool-call-id=${JSON.stringify(after > 0 ? `after-${after - 1}` : target.id)}]`)})`);
		};
		const pointerAt = (selector: string): Promise<{ x: number; y: number }> => ui.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2}})()`);
		const clickAt = async (point: { x: number; y: number }): Promise<void> => {
			for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await ui.call("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
		};

		/** A tool's `⋯` menu is pressed with a real pointer on an item other than the focused first one while the transcript sits mid-way: by the wheel, the way a reader scrolls away, or because the tail grew below an open menu while the reader followed it. */
		for (const grouped of [false, true]) for (const scroll of ["wheel", "growth"] as const) await t.test(`a real mouse press on a ⋯ menu item other than the first runs it with the transcript mid-way (${grouped ? "overview group" : "detailed"}, ${scroll}): focusing a menu item never moves the transcript`, async () => {
			const call = real("bash-trunc-middle-artifact");
			await reset(`menu-pointer-${grouped}-${scroll}`); await showAround(call, 30, scroll === "wheel" ? 30 : 0, grouped);
			if (grouped) { await ui.evaluate("document.querySelector('.omp-overview-head').click()"); await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-head`)})`); }
			const scrollerTop = (): Promise<number> => ui.evaluate("document.querySelector('.omp-transcript').scrollTop");
			const headInUpperHalf = `(()=>{const h=document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-head`)}),s=document.querySelector('.omp-transcript').getBoundingClientRect(),r=h?.getBoundingClientRect();return !!r&&r.top>s.top+40&&r.top<s.top+250})()`;
			if (scroll === "wheel") {
				const wheel = { x: 300, y: 300 };
				await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...wheel });
				for (let step = 0; step < 40 && !await ui.evaluate(headInUpperHalf); step++) {
					await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", ...wheel, deltaX: 0, deltaY: -120 });
					// The wheel's intent window runs on the platform clock, which no fake clock moves.
					await ui.evaluate("(()=>{const {promise,resolve}=Promise.withResolvers();setTimeout(resolve,300);return promise})()");
				}
				assert.ok(await ui.evaluate(headInUpperHalf), "the wheel brought the call to the upper half of the viewport");
			}
			await ui.settleGeometry(".omp-transcript");
			await clickAt(await pointerAt(`${card(call)} .omp-tool-head`));
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-tool-body`)})`);
			await ui.settleGeometry(".omp-transcript");
			await clickAt(await pointerAt(menuButton(call)));
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} [role=menu]`)})`);
			await ui.settleGeometry(".omp-transcript");
			if (scroll === "growth") {
				// The reader follows the tail; a reply arrives below the open menu. The held call keeps its place, which is no longer the bottom.
				const height = await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollHeight");
				await ui.evaluate(`(()=>{const entries=window.ui.current().entries,last=entries.at(-1),late={type:"message",id:"a-late",parentId:last.id,timestamp:new Date(1_790_000_090_000).toISOString(),message:{role:"assistant",model:"m",timestamp:1_790_000_090_000,stopReason:"stop",content:[{type:"text",text:Array.from({length:12},(_,line)=>"A late reply, paragraph "+line).join("\\n\\n")}]}};window.ui.push({entries:[...entries,late],durableCount:entries.length+1})})()`);
				await ui.wait(`document.querySelector('.omp-transcript').scrollHeight > ${height} + 200`);
				await ui.settleGeometry(".omp-transcript");
				assert.equal(await ui.evaluate<boolean>("document.querySelector('.omp-jump-latest')===null"), true, "the reader is still following the tail");
			} else assert.equal(await ui.evaluate<boolean>("document.querySelector('.omp-jump-latest')!==null"), true, "the reader has left the tail");
			const before = await scrollerTop();
			await ui.evaluate("window.sent.length=0");
			const item = `${card(call)} [data-menu-item=open-full]`;
			const point = await pointerAt(item);
			assert.ok(point.y > 0 && point.y < 800, "the item is on screen");
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
			await ui.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
			await ui.settleGeometry(".omp-transcript");
			assert.equal(await ui.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(item)})`), true, "the press focused the item");
			assert.equal(await scrollerTop(), before, "focusing a menu item left the transcript where it was");
			assert.deepEqual(await pointerAt(item), point, "the item is still under the pointer");
			await ui.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
			await ui.wait("window.sent.some(message=>message.type==='omp:open-artifact')");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		/** Several real calls as one reply, so the overview groups them. */
		const showGroup = async (group: readonly Call[], at = 1_790_000_005_000): Promise<void> => {
			const entries: unknown[] = [{ type: "message", id: "a-group", parentId: null, timestamp: new Date(at - 4_000).toISOString(), message: { role: "assistant", model: "m", timestamp: at - 4_000, stopReason: "toolUse", content: group.map(call => ({ type: "toolCall", id: call.id, name: call.tool, arguments: call.args })) } }];
			let parent = "a-group";
			for (const call of group) {
				entries.push({ type: "message", id: `r-${call.id}`, parentId: parent, timestamp: new Date(at).toISOString(), message: { role: "toolResult", timestamp: at, toolCallId: call.id, toolName: call.tool, isError: call.isError, content: [{ type: "text", text: call.resultText }], details: call.details } });
				parent = `r-${call.id}`;
			}
			await ui.evaluate(`window.ui.density('overview');window.ui.push({entries:${JSON.stringify(entries)},durableCount:${entries.length},working:false,settled:true})`);
			await ui.wait("document.querySelector('.omp-overview-head')");
		};

		await t.test("a group's Expand all N and Collapse all set its members' own disclosures; arrows, Home and End travel the heads; Escape closes the menu, then the card, then the group", async () => {
			const group = [real("glob-list"), real("read-text-file"), real("bash-long-786-lines")];
			await reset("digest"); await showGroup(group);
			const head = ".omp-overview-head";
			const activeIs = (selector: string): Promise<boolean> => ui.evaluate(`document.activeElement?.matches(${JSON.stringify(selector)}) === true`);
			const activeCall = (): Promise<string | null> => ui.evaluate("document.activeElement?.closest('[data-tool-call-id]')?.dataset.toolCallId ?? null");
			const bodies = (): Promise<number> => countOf(".omp-overview-member .omp-tool-body");
			assert.equal(await countOf(".omp-overview-actions"), 0, "a closed group offers no actions");
			await ui.evaluate(`document.querySelector(${JSON.stringify(head)}).click()`);
			await ui.wait("document.querySelector('.omp-overview-actions')");
			const actions = (): Promise<{ text: string; disabled: boolean }[]> => ui.evaluate("[...document.querySelectorAll('.omp-overview-actions button')].map(b=>({text:b.textContent,disabled:b.getAttribute('aria-disabled')==='true'}))");
			assert.deepEqual(await actions(), [{ text: "Expand all 3", disabled: false }, { text: "Collapse all", disabled: true }]);
			assert.equal(await bodies(), 0);
			await ui.evaluate("[...document.querySelectorAll('.omp-overview-actions button')][0].click()");
			await ui.wait("document.querySelectorAll('.omp-overview-member .omp-tool-body').length===3");
			assert.deepEqual(await actions(), [{ text: "Expand all 3", disabled: true }, { text: "Collapse all", disabled: false }]);
			assert.equal(await ui.evaluate("document.querySelector('.omp-overview-head').getAttribute('aria-expanded')"), "true", "the group stays open");
			await ui.evaluate("[...document.querySelectorAll('.omp-overview-actions button')][1].click()");
			await ui.wait("document.querySelectorAll('.omp-overview-member .omp-tool-body').length===0");
			assert.equal(await countOf(".omp-overview-member .omp-tool-head"), 3, "Collapse all closes the members, not the group");

			// Arrows, Home and End travel the heads: the group row, then each member's head.
			await ui.evaluate(`document.querySelector(${JSON.stringify(head)}).focus()`);
			await key("ArrowDown"); assert.equal(await activeCall(), group[0]!.id);
			await key("ArrowDown"); assert.equal(await activeCall(), group[1]!.id);
			await key("End"); assert.equal(await activeCall(), group[2]!.id);
			await key("ArrowDown"); assert.equal(await activeCall(), group[2]!.id, "the last head stays the last");
			await key("ArrowUp"); assert.equal(await activeCall(), group[1]!.id);
			await key("Home"); assert.equal(await activeIs(head), true, "Home goes to the first head, the group row");
			await key("ArrowUp"); assert.equal(await activeIs(head), true);

			// Escape closes a menu first, then the card, then the group.
			await ui.evaluate("[...document.querySelectorAll('.omp-overview-actions button')][0].click()");
			await ui.wait("document.querySelectorAll('.omp-overview-member .omp-tool-body').length===3");
			const second = `[data-tool-call-id=${JSON.stringify(group[1]!.id)}]`;
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${second} .omp-output-bar .omp-tool-menu > button`)}).click()`);
			await ui.wait(`document.querySelector(${JSON.stringify(`${second} [role=menu]`)})`);
			await key("ArrowDown"); await key("ArrowUp");
			await key("Escape");
			await ui.wait(`!document.querySelector(${JSON.stringify(`${second} [role=menu]`)})`);
			assert.equal(await bodies(), 3, "the first Escape closed only the menu");
			await key("Escape");
			await ui.wait("document.querySelectorAll('.omp-overview-member .omp-tool-body').length===2");
			assert.equal(await activeCall(), group[1]!.id, "the second Escape closed the card and left focus on its head");
			assert.equal(await ui.evaluate("document.querySelector('.omp-overview-head').getAttribute('aria-expanded')"), "true");
			await key("Escape");
			await ui.wait("document.querySelector('.omp-overview-head').getAttribute('aria-expanded')==='false'");
			assert.equal(await activeIs(head), true, "the third Escape closed the group and left focus on its row");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		await t.test("a group's Expand all and Collapse all work under a real mouse press, the transcript wheel-scrolled to them each time", async () => {
			const group = [real("glob-list"), real("read-text-file"), real("bash-long-786-lines")];
			await reset("digest-pointer"); await showGroup(group);
			await clickAt(await pointerAt(".omp-overview-head"));
			await ui.wait("document.querySelector('.omp-overview-actions')");
			const action = (index: number): string => `.omp-overview-actions button:nth-child(${index})`;
			const wheel = { x: 300, y: 300 };
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...wheel });
			const onScreen = "(()=>{const r=document.querySelector('.omp-overview-actions button').getBoundingClientRect();return r.top>40&&r.bottom<700})()";
			const wheelToActions = async (): Promise<void> => {
				for (let step = 0; step < 20 && !await ui.evaluate(onScreen); step++) {
					await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", ...wheel, deltaX: 0, deltaY: -200 });
					// The wheel's intent window runs on the platform clock, which no fake clock moves.
					await ui.evaluate("(()=>{const {promise,resolve}=Promise.withResolvers();setTimeout(resolve,300);return promise})()");
				}
				assert.ok(await ui.evaluate(onScreen), "the group's buttons are on screen");
				await ui.settleGeometry(".omp-transcript");
			};
			await wheelToActions();
			const before = await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollTop");
			const expand = await pointerAt(action(1));
			await ui.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...expand });
			await ui.call("Input.dispatchMouseEvent", { type: "mousePressed", ...expand, button: "left", clickCount: 1 });
			await ui.settleGeometry(".omp-transcript");
			assert.equal(await ui.evaluate<number>("document.querySelector('.omp-transcript').scrollTop"), before, "focusing the group's button left the transcript where it was");
			assert.deepEqual(await pointerAt(action(1)), expand, "the button is still under the pointer");
			await ui.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...expand, button: "left", clickCount: 1 });
			await ui.wait("document.querySelectorAll('.omp-overview-member .omp-tool-body').length===3");
			await wheelToActions();
			await clickAt(await pointerAt(action(2)));
			await ui.wait("document.querySelectorAll('.omp-overview-member .omp-tool-body').length===0");
			assert.equal(await ui.evaluate("document.querySelector('.omp-overview-head').getAttribute('aria-expanded')"), "true", "Collapse all closes the members, not the group");
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});

		// Evidence, not a check: `OMP_UI_SCREENSHOT_DIR=<dir> node --test src/webview/tool-output-ui.test.ts` writes the scenes in three themes at two widths.
		await t.test("screenshots of the opened tool call in Dark Modern, Light Modern and High Contrast at 360 and 720 px", { skip: process.env.OMP_UI_SCREENSHOT_DIR === undefined }, async () => {
			const directory = process.env.OMP_UI_SCREENSHOT_DIR!;
			await mkdir(directory, { recursive: true });
			const codeThemes: Record<string, string> = {
				"Dark Modern": "{id:'Dark Modern',rules:[{scopes:['support.type.property-name'],foreground:'#9CDCFE'},{scopes:['string'],foreground:'#CE9178'},{scopes:['constant.numeric'],foreground:'#B5CEA8'},{scopes:['constant.language'],foreground:'#569CD6'}]}",
				"Light Modern": "{id:'Light Modern',rules:[{scopes:['support.type.property-name'],foreground:'#0451A5'},{scopes:['string'],foreground:'#A31515'},{scopes:['constant.numeric'],foreground:'#098658'},{scopes:['constant.language'],foreground:'#0000FF'}]}",
				"High Contrast": "{id:'High Contrast',rules:[{scopes:['support.type.property-name'],foreground:'#9CDCFE'},{scopes:['string'],foreground:'#CE9178'},{scopes:['constant.numeric'],foreground:'#B5CEA8'},{scopes:['constant.language'],foreground:'#569CD6'}]}",
			};
			const trunc = real("bash-trunc-middle-artifact");
			const scenes: { name: string; run: (width: number) => Promise<void> }[] = [
				{ name: "ndjson", run: async () => { const call = real("bash-ndjson"); await show(call); await open(call); await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-json-row`)})`); } },
				{ name: "bash-long", run: async () => { const call = real("bash-long-786-lines"); await show(call); await open(call); } },
				{ name: "menu-truncated", run: async () => {
					await show(trunc); await open(trunc);
					await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(trunc)} .omp-tool-head`)}).scrollIntoView({block:'start'})`);
					await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(trunc)} .omp-output-bar .omp-tool-menu > button`)}).click()`);
					await ui.wait(`document.querySelector(${JSON.stringify(`${card(trunc)} [role=menu]`)})`);
				} },
				{ name: "group", run: async () => {
					await showGroup([real("glob-list"), real("read-text-file"), real("bash-tsc-npm-typecheck-fail")]);
					await ui.evaluate("document.querySelector('.omp-overview-head').click()");
					await ui.wait("document.querySelector('.omp-overview-actions')");
					await ui.evaluate("[...document.querySelectorAll('.omp-overview-actions button')][0].click()");
					await ui.wait("document.querySelectorAll('.omp-overview-member .omp-tool-body').length===3");
					await ui.evaluate("document.querySelector('.omp-overview-head').scrollIntoView({block:'start'})");
				} },
			];
			for (const themeName of ["Dark Modern", "Light Modern", "High Contrast"]) {
				const theme = THEMES.find(candidate => candidate.name === themeName) ?? assert.fail(themeName);
				const slug = themeName.toLowerCase().replaceAll(" ", "-");
				for (const width of [360, 720]) {
					await ui.call("Emulation.setDeviceMetricsOverride", { width, height: 820, deviceScaleFactor: 1, mobile: false });
					for (const scene of scenes) {
						await reset(`shot-${slug}-${width}-${scene.name}`);
						await ui.evaluate(`(()=>{document.body.className=${JSON.stringify(theme.bodyClass)};document.body.setAttribute('data-vscode-theme-id',${JSON.stringify(themeName)});for(const [name,value] of Object.entries(${JSON.stringify(theme.tokens)}))if(value!=='')document.documentElement.style.setProperty(name,value);document.documentElement.style.setProperty('--vscode-editor-foreground',${JSON.stringify(theme.tokens["--vscode-foreground"])});window.ui.receive({type:'omp:chat-code-theme',themes:[${codeThemes[themeName]}]})})()`);
						await scene.run(width);
						await ui.evaluate("document.fonts.ready.then(()=>true)");
						await ui.settleGeometry(".omp-transcript");
						const image = await ui.call("Page.captureScreenshot", { format: "png" });
						await writeFile(join(directory, `${slug}-${width}-${scene.name}.png`), Buffer.from(String(image.data), "base64"));
					}
				}
			}
			await ui.call("Emulation.setDeviceMetricsOverride", { width: 720, height: 900, deviceScaleFactor: 1, mobile: false });
			assert.deepEqual(await ui.evaluate("window.errors"), []);
		});
	} finally {
		page?.socket.close(); browser?.socket.close();
		child.kill();
		server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
	}
});
