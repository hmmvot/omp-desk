/** The opened tool call in Chat (design 2026-10-14): 12-row preview, markers, Show all, Collapse, gist, footer, Copy and streaming, against real calls, in an owned headless Chromium. */
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
import { splitToolNotices } from "../chat/tool-notices.ts";

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
			assert.match(await text(`${card(call)} .omp-output-disclosure`), /lines hidden/, "the full view pages a very long result");
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
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-output-bar:not(.omp-tool-input *) .omp-iconbtn`)}).click()`);
			await ui.wait("window.clip!==null");
			assert.equal(await ui.evaluate("window.clip"), splitToolNotices(call.resultText).body);
			await ui.wait(`document.querySelector(${JSON.stringify(`${card(call)} .omp-output-bar [role=status]`)})`);
			assert.match(await text(`${card(call)} .omp-output-bar [role=status]`), /^Copied the output \(25 lines, [\d,]+ characters\)$/);
			await ui.evaluate("navigator.clipboard.writeText=async()=>{throw new Error('Denied')}");
			await ui.evaluate(`document.querySelector(${JSON.stringify(`${card(call)} .omp-output-bar:not(.omp-tool-input *) .omp-iconbtn`)}).click()`);
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
	} finally {
		page?.socket.close(); browser?.socket.close();
		child.kill();
		server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
	}
});
