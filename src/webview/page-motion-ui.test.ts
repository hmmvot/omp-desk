/**
 * The page's spinners in an owned headless Chromium with the real Chat page: the working row's glyph, the running wait row's spinner
 * and the starting banner's spinner keep turning through a long run, a remount of their rows and animation frames the browser loses,
 * and a turned glyph never makes the block around it scroll.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { createGuestHtml } from "../host/guest-webview.ts";

const browserPath = [process.env.OMP_TEST_CHROMIUM,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));

class Cdp {
	#next = 0;
	readonly #pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
	readonly socket: WebSocket;
	constructor(socket: WebSocket) {
		this.socket = socket;
		socket.addEventListener("message", event => {
			const frame = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
			const pending = frame.id === undefined ? undefined : this.#pending.get(frame.id);
			if (frame.id === undefined || pending === undefined) return;
			this.#pending.delete(frame.id);
			if (frame.error) pending.reject(new Error(frame.error.message)); else pending.resolve(frame.result ?? {});
		});
	}
	static async connect(url: string): Promise<Cdp> {
		const socket = new WebSocket(url);
		const opened = Promise.withResolvers<void>();
		socket.addEventListener("open", () => opened.resolve(), { once: true });
		socket.addEventListener("error", () => opened.reject(new Error("headless browser connection failed")), { once: true });
		await opened.promise;
		return new Cdp(socket);
	}
	call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const id = ++this.#next;
		const answer = Promise.withResolvers<Record<string, unknown>>();
		this.#pending.set(id, answer);
		this.socket.send(JSON.stringify({ id, method, params }));
		return answer.promise;
	}
	async evaluate<T>(expression: string): Promise<T> {
		const result = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
		if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
		const remote = result.result;
		assert.ok(remote !== null && typeof remote === "object");
		return ("value" in remote ? remote.value : undefined) as T;
	}
}

/** The real Chat page with the page's motion installed, as `main.tsx` does, and a handle to push snapshots into it. */
const FIXTURE = `
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { guestTransport, readCspNonce } from "./bridge";
import { installPageMotion } from "./lib/page-motion";
import { ChatClient } from "./lib/chat-client";
import { createChatModel, snapshotOf } from "../chat/model";
import { splitChatSnapshot } from "../protocol/chat-messages";
import { injectGuestStyles } from "./styles";
import { attachSessionView } from "./lib/session-view";
import { attachCodeTheme } from "./lib/code-theme-store";
import { attachKeyHints } from "./lib/key-hints-store";
import { adoptNonceForCreatedStyles } from "./lib/nonce-styles";
attachSessionView(guestTransport); attachCodeTheme(guestTransport); attachKeyHints(guestTransport);
installPageMotion(window);
const epoch = { nonce: "host-ui-test", counter: 1 };
const model = { provider: "one", id: "old", name: "Original", contextWindow: 1000000 };
const client = new ChatClient({ post(message) { return guestTransport.post(message); } }); client.attach(guestTransport);
let current = { ...snapshotOf(createChatModel(), epoch), phase: "live", state: { model, thinkingLevel: "low", isStreaming: false, isCompacting: false, queuedMessageCount: 0, contextUsage: { tokens: 40700, contextWindow: 1000000, percent: 4.07 } } };
function receive(message) { window.dispatchEvent(new MessageEvent("message", { data: message })); }
function push(patch = {}) { current = { ...current, ...patch }; const parts = splitChatSnapshot(current, "ui-snapshot"); receive(parts.snapshot); for (const chunk of parts.chunks) receive(chunk); }
window.ui = { push, receive, view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Motion", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); } };
const nonce = readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); push();
`;

/** A running wait row (the job's own clock and spinner) under a working turn, and the probe of what moves. */
const SETUP = `(() => {
 const row = (id, message) => ({ type: "message", id, parentId: null, timestamp: "2026-10-05T00:00:00Z", message });
 const call = row("call-w1", { role: "assistant", timestamp: 1, model: "m", stopReason: "toolUse", content: [{ type: "toolCall", id: "w1", name: "wait", arguments: {} }] });
 const job = durationMs => ({ id: "bg_415", type: "bash", status: "running", label: "Compile", durationMs });
 const active = durationMs => ({ toolCallId: "w1", toolName: "wait", args: {}, startedAt: Date.now() - 1000, partialResult: { content: [{ type: "text", text: "" }], details: { op: "wait", jobs: [job(durationMs)] } } });
 window.live = durationMs => window.ui.push({ working: true, settled: false, workingIntent: "Compile", startedAt: Date.now() - 5000, entries: [call], durableCount: 1, activeTools: [active(durationMs)] });
 window.gone = () => window.ui.push({ working: false, settled: true, workingIntent: null, entries: [], durableCount: 0, activeTools: [] });
 window.angles = () => {
  const status = document.querySelector(".omp-working-status-text");
  const spinner = document.querySelector('[data-tool-call-id="w1"] .codicon-modifier-spin');
  return { status: status?.style.getPropertyValue("--omp-spin") ?? null, spinner: spinner?.style.getPropertyValue("--omp-spin") ?? null };
 };
 window.live(1000);
})()`;

interface Angles { status: string | null; spinner: string | null }

test("spinners keep turning through a long run, a remount and lost animation frames, and never make their block scroll", { skip: browserPath === undefined && "no Chromium is available" }, async t => {
	const bundle = await build({
		stdin: { contents: FIXTURE, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") },
		bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' },
	});
	const script = bundle.outputFiles[0]!.text;
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://fixture");
		if (url.pathname === "/codicons/codicon.css" || url.pathname === "/codicons/codicon.ttf") {
			const file = url.pathname.endsWith(".css") ? "codicon.css" : "codicon.ttf";
			response.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : "font/ttf");
			response.end(readFileSync(join(process.cwd(), "node_modules/@vscode/codicons/dist", file)));
			return;
		}
		if (url.pathname === "/ui.js") { response.setHeader("Content-Type", "text/javascript"); response.end(script); return; }
		response.setHeader("Content-Type", "text/html");
		const webview = { cspSource: "'self'", asWebviewUri: (uri: { path: string }) => ({ toString: () => uri.path.endsWith(".js") ? "/ui.js" : "/codicons/codicon.css" }) } as never;
		const extensionUri = { path: "/extension", with({ path }: { path: string }) { return { path }; } } as never;
		const html = createGuestHtml(webview, extensionUri, "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d", null);
		const nonce = /<script nonce="([^"]+)"/.exec(html)![1]!;
		response.end(html.replace("</head>", `<style nonce="${nonce}">:root{--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#ddd;--vscode-foreground:#ddd;--vscode-font-family:Arial;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace;--vscode-progressBar-background:#0e70c0;--vscode-focusBorder:#007fd4}</style><script nonce="${nonce}">window.sent=[];window.acquireVsCodeApi=()=>({postMessage(m){window.sent.push(m)},setState(){}});</script></head>`));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const profile = await mkdtemp(join(tmpdir(), "omp-page-motion-"));
	const child = spawn(browserPath!, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
		"--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1000,800", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
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
		const created = await browser.call("Target.createTarget", { url: `http://127.0.0.1:${address.port}/` });
		const targets = await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json() as { id: string; webSocketDebuggerUrl: string }[];
		page = await Cdp.connect(targets.find(row => row.id === created.targetId)!.webSocketDebuggerUrl);
		await page.call("Emulation.setFocusEmulationEnabled", { enabled: true });
		await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
		const evaluate = <T>(expression: string) => page!.evaluate<T>(expression);
		for (let attempt = 0; attempt < 400 && !await evaluate<boolean>("Boolean(window.ui)").catch(() => false); attempt++) await delay(25);
		await evaluate(SETUP);

		// The browser's own timers and frames are the thing under test, so these waits are real: a glyph's steps are 125 ms apart.
		const sample = async (span: number): Promise<{ status: Set<string | null>; spinner: Set<string | null> }> => {
			const status = new Set<string | null>();
			const spinner = new Set<string | null>();
			for (let waited = 0; waited < span; waited += 50) {
				const angles = await evaluate<Angles>("window.angles()");
				status.add(angles.status);
				spinner.add(angles.spinner);
				await delay(50);
			}
			return { status, spinner };
		};
		const turning = async (what: string, span = 1600): Promise<void> => {
			const seen = await sample(span);
			assert.ok(seen.status.size >= 6, `${what}: the working row's glyph shows ${seen.status.size} positions in ${span} ms`);
			assert.ok(seen.spinner.size >= 6, `${what}: the wait row's spinner shows ${seen.spinner.size} positions in ${span} ms`);
		};

		await t.test("the working row's glyph and the wait row's spinner turn", async () => { await turning("at the start"); });

		await t.test("they still turn after a long run in which the wait row is updated again and again", async () => {
			for (let index = 0; index < 60; index++) { await evaluate(`window.live(${2000 + index * 250})`); await delay(100); }
			await turning("after the run");
		});

		await t.test("they turn again when their rows are taken away and put back", async () => {
			for (let round = 0; round < 4; round++) {
				await evaluate("window.gone()");
				await delay(300 + round * 200);
				await evaluate(`window.live(${9000 + round})`);
				await delay(200);
				await turning(`after remount ${round}`, 1000);
			}
		});

		await t.test("they turn again when the browser lost the animation frame the loop was waiting for", async () => {
			// What the page cannot tell: the frame it asked for never runs (a page that was not drawn, a dropped request). The watchdog asks again.
			await evaluate("window.nativeFrame = window.requestAnimationFrame; window.requestAnimationFrame = () => 1; 1");
			await delay(400);
			await evaluate("window.requestAnimationFrame = window.nativeFrame; 1");
			await turning("after a lost frame", 2600);
		});

		await t.test("they turn at once when the page is focused again after a lost frame", async () => {
			await evaluate("window.requestAnimationFrame = () => 1; 1");
			await delay(400);
			await evaluate("window.requestAnimationFrame = window.nativeFrame; window.dispatchEvent(new Event('focus')); 1");
			await turning("after focus", 1000);
		});

		await t.test("the starting banner's spinner turns inside its own box: the notices block never gets a scrollbar, at any step", async () => {
			await evaluate("window.ui.push({ phase: 'attaching', header: { id: 'joining-h', cwd: 'D:/work/alpha-desk/', timestamp: '2026-10-13T10:00:00.000Z' }, entries: [], durableCount: 0, working: false, settled: true, activeTools: [] })");
			await evaluate("window.ui.receive({ type: 'omp:chat-operation', operation: { kind: 'resume', step: 'boot', elapsedMs: 8400, requestId: null, still: false } })");
			await delay(300);
			const angles = new Set<string>();
			for (let waited = 0; waited < 2400; waited += 40) {
				const state = await evaluate<{ scrollHeight: number; clientHeight: number; angle: string }>("(() => { const notices = document.querySelector('.omp-notices'); return { scrollHeight: notices.scrollHeight, clientHeight: notices.clientHeight, angle: notices.querySelector('.codicon-modifier-spin').style.getPropertyValue('--omp-spin') }; })()");
				assert.ok(state.scrollHeight <= state.clientHeight, `the notices block scrolls (${state.scrollHeight} > ${state.clientHeight}) with the spinner at ${state.angle}`);
				angles.add(state.angle);
				await delay(40);
			}
			assert.ok(angles.size >= 6, `the banner's spinner turned through ${angles.size} positions, the diagonal ones among them`);
		});
	} finally {
		page?.socket.close();
		browser?.socket.close();
		child.kill();
		server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
	}
});
