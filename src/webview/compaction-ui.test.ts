/**
 * A long transcript in the real Chat page (an owned headless Chromium): a reply streams into it, and an auto-compaction or
 * a resync replaces the transcript's entries.
 *
 * The page must not do work in proportion to the length of the history for something that did not change. Every frame of
 * a streaming reply used to project every loaded entry again, and a snapshot made every row a new object, so the
 * measured heights, the tool metadata and the mounted rows all missed and the whole transcript was drawn again; on a long
 * session the frames behind that queued into a run of long tasks and the working spinner stalled for seconds.
 *
 * The test counts that work instead of timing it, so it does not depend on the machine: the entries handed to the
 * position and projection steps, the tool-call presentations computed, the measured heights thrown away and the mounted
 * rows replaced. The counters are statements put next to the functions that do the work while the page is bundled (`COUNTERS`
 * below), which fails loudly if one of them is renamed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build, type Plugin } from "esbuild";
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

/** The real Chat page with the page's motion installed, as `main.tsx` does, and handles to push snapshots into it and to prepare them before the clock runs. */
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
function parts(patch) { return splitChatSnapshot({ ...current, ...patch }, "ui-snapshot"); }
function deliver(prepared) { receive(prepared.snapshot); for (const chunk of prepared.chunks) receive(chunk); }
window.ui = { receive, parts, deliver, push(patch = {}) { current = { ...current, ...patch }; deliver(parts({})); }, current: () => current,
 view(patch = {}) { receive({ type: "omp:session-view", mode: "chat", title: "Compaction", running: true, starting: false, stopping: false, canSwitch: true, reason: null, ...patch }); } };
const nonce = readCspNonce(); adoptNonceForCreatedStyles(nonce); injectGuestStyles(nonce);
createRoot(document.getElementById("root")).render(<App client={client} />); window.ui.view(); window.ui.push();
`;

/** A session of TURNS turns (a prompt, a reply with two tool calls and their results, a closing reply), the stream, and the two ways its entries are replaced. */
const SETUP = (turns: number): string => `(() => {
 const TURNS = ${turns};
 const sleep = ms => { const { promise, resolve } = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };
 const frames = () => { const { promise, resolve } = Promise.withResolvers(); requestAnimationFrame(() => requestAnimationFrame(resolve)); return promise; };
 const row = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: "2026-10-05T00:00:00Z", message });
 const prose = "The build pipeline compiles every assembly and reports \`warnings\` about stale caches, and the tests that depend on them are skipped. ";
 const entries = [];
 for (let turn = 0; turn < TURNS; turn++) {
  const base = 1_000_000 + turn * 10, id = "t" + turn;
  entries.push(
   row(id + "u", turn === 0 ? null : "t" + (turn - 1) + "z", { role: "user", content: "Do step " + turn + ". " + prose, timestamp: base }),
   row(id + "a", id + "u", { role: "assistant", timestamp: base + 1, model: "m", stopReason: "toolUse", content: [
    { type: "text", text: "## Step " + turn + "\\n\\n" + prose.repeat(2) + "\\n\\n- one\\n- two with **bold**\\n\\n\`\`\`ts\\nexport const f" + turn + " = (a: number) => a + 1;\\n\`\`\`" },
    { type: "toolCall", id: id + "c1", name: "read", arguments: { path: "src/file" + turn + ".ts" } },
    { type: "toolCall", id: id + "c2", name: "bash", arguments: { command: "echo " + turn, i: "Echo" } }] }),
   row(id + "r1", id + "a", { role: "toolResult", timestamp: base + 2, toolCallId: id + "c1", toolName: "read", isError: false, content: [{ type: "text", text: ("line of file " + turn + "\\n").repeat(10) }] }),
   row(id + "r2", id + "r1", { role: "toolResult", timestamp: base + 3, toolCallId: id + "c2", toolName: "bash", isError: false, content: [{ type: "text", text: "out " + turn }] }),
   row(id + "z", id + "r2", { role: "assistant", timestamp: base + 4, model: "m", stopReason: "stop", content: [{ type: "text", text: "Done with step " + turn + ". " + prose }] }));
 }
 const fresh = list => JSON.parse(JSON.stringify(list));
 const frame = value => window.ui.receive({ type: "omp:chat-event", epoch: window.ui.current().epoch, frame: value });
 let words = 0;
 const tick = () => {
  words += 3;
  frame({ type: "message_update", messageId: "live1", message: { role: "assistant", timestamp: 2_000_000, model: "m", stopReason: "stop", content: [{ type: "text", text: "Streaming reply: " + "alpha beta gamma delta ".repeat(Math.ceil(words / 4)).slice(0, words * 6) + "\\n\\n\`code\` and **bold** text" }] } });
 };
 const W = globalThis.__work;
 // Mounted rows that came into the page, whatever the reason: a row the page replaced is one added again.
 new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) W.rowsAdded += (node.matches(".omp-measured-row") ? 1 : 0) + node.querySelectorAll(".omp-measured-row").length; })
  .observe(document.body, { subtree: true, childList: true });
 // Wait until the page has nothing left to do: its counters and mounted rows have not changed for a while.
 const quiet = async () => { let last = "", still = 0; while (still < 6) { await frames(); await sleep(50); const now = JSON.stringify(W) + document.querySelectorAll(".omp-measured-row").length; still = now === last ? still + 1 : 0; last = now; } };
 // The loaded transcript, the two replacements prepared before anything is counted (a host sends them already split), and a stream under way.
 window.setUp = async () => {
  const kept = fresh(entries.slice(480));
  const compaction = { type: "compaction", id: "cmp1", parentId: kept.at(-1).id, timestamp: "2026-10-05T01:00:00Z", summary: "Summary of the earlier conversation. " + prose.repeat(4), firstKeptEntryId: kept[0].id, tokensBefore: 90000, tokensAfter: 12000, method: "soft" };
  window.prepared = {
   resync: window.ui.parts({ phase: "live", entries: fresh(entries), durableCount: entries.length, olderCount: 0, working: true, settled: false }),
   compact: window.ui.parts({ phase: "live", entries: [...kept, compaction], durableCount: kept.length + 1, olderCount: 480, working: true, settled: false }),
  };
  window.ui.push({ entries: fresh(entries), durableCount: entries.length, olderCount: 0, working: true, settled: false, workingIntent: "Streaming" });
  await frames(); await sleep(500);
  frame({ type: "agent_start" });
  await quiet();
 };
 // What the action made the page do, and which of the rows mounted before it are no longer the same elements.
 window.work = async action => {
  await quiet();
  const before = { ...W }, mounted = [...document.querySelectorAll(".omp-measured-row")];
  for (const element of mounted) element.dataset.mark = "kept";
  await action(); await quiet();
  const spent = {}; for (const key of Object.keys(W)) spent[key] = W[key] - before[key];
  return { ...spent, mounted: mounted.length, replaced: mounted.filter(element => !element.isConnected || element.dataset.mark !== "kept").map(element => element.dataset.windowRow ?? element.className) };
 };
 window.stream = async count => { for (let index = 0; index < count; index++) { tick(); await frames(); } };
 window.replace = which => () => window.ui.deliver(window.prepared[which]);
})()`;

interface Work { positioned: number; projected: number; toolRoutes: number; heightResets: number; heightsMeasured: number; rowsAdded: number; mounted: number; replaced: string[] }

/**
 * Counters in the bundled page: each edit puts a statement next to one of the functions that do the work. An anchor
 * that is not found exactly once fails the test, so a renamed function cannot leave a counter silently at zero.
 */
const COUNTERS: { file: RegExp; edits: [anchor: string, statement: string, where: "before" | "after"][] }[] = [
	{ file: /src[\\/]chat[\\/]transcript\.ts$/, edits: [["export function projectTranscript(entries: readonly ChatEntry[], options: TranscriptProjectionOptions = {}): TranscriptCard[] {", "globalThis.__work.projected += entries.length;", "after"]] },
	{ file: /src[\\/]chat[\\/]projection\.ts$/, edits: [["\tconst additions: { entry: ChatEntry; position: TranscriptPosition }[] = [];", "globalThis.__work.positioned += entries.length;", "before"]] },
	{ file: /src[\\/]chat[\\/]tool-presentation\.ts$/, edits: [["export function resolveToolRoute(name: string, args: Record<string, unknown>, details: Record<string, unknown>): ToolRoute {", "globalThis.__work.toolRoutes++;", "after"]] },
	{ file: /src[\\/]webview[\\/]lib[\\/]transcript-virtualizer\.ts$/, edits: [
		["measurement = { context, revision: row.revision, height: null };", "if (measurement?.height != null) globalThis.__work.heightResets++;", "before"],
		["measurement.height = height; return true;", "globalThis.__work.heightsMeasured++;", "before"],
	] },
];
const countingPlugin: Plugin = {
	name: "work-counters",
	setup(builder) {
		for (const { file, edits } of COUNTERS) {
			builder.onLoad({ filter: file }, args => {
				let contents = readFileSync(args.path, "utf8");
				for (const [anchor, statement, where] of edits) {
					assert.equal(contents.split(anchor).length - 1, 1, `counter anchor not found exactly once in ${args.path}: ${anchor}`);
					contents = contents.replace(anchor, () => where === "after" ? `${anchor} ${statement}` : `${statement} ${anchor}`);
				}
				return { contents, loader: "ts", resolveDir: dirname(args.path) };
			});
		}
	},
};

test("a long transcript costs the page nothing for what did not change: a streaming reply, a resync and a compaction", { skip: browserPath === undefined && "no Chromium is available", timeout: 300_000 }, async t => {
	const bundle = await build({
		stdin: { contents: FIXTURE, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") },
		bundle: true, write: false, format: "iife", plugins: [countingPlugin], banner: { js: "globalThis.__work = { positioned: 0, projected: 0, toolRoutes: 0, heightResets: 0, heightsMeasured: 0, rowsAdded: 0 };" }, platform: "browser", jsx: "automatic", loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' },
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
	const profile = await mkdtemp(join(tmpdir(), "omp-compaction-"));
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
		await evaluate(SETUP(900));
		await evaluate("window.setUp()");
		const work = async (what: string): Promise<Work> => {
			const outcome = await evaluate<Work>(`window.work(${what})`);
			process.stdout.write(`# ${what}: ${JSON.stringify(outcome)}\n`);
			return outcome;
		};
		const LOADED = 4500;

		await t.test("a reply streams into 4,500 loaded entries: a frame projects the reply, not the history", async () => {
			const outcome = await work("() => window.stream(40)");
			assert.ok(outcome.projected <= 3 * 40, `${outcome.projected} entries projected over 40 frames (the reply alone is one entry a frame)`);
			assert.ok(outcome.positioned <= LOADED, `${outcome.positioned} entries positioned over 40 frames (once for the history, not once a frame)`);
			assert.ok(outcome.toolRoutes <= 40, `${outcome.toolRoutes} tool presentations computed over 40 frames`);
			assert.equal(outcome.heightResets, 0, "no measured height is thrown away by a streamed frame");
			assert.ok(outcome.replaced.length <= 2, `rows replaced by a streamed frame: ${outcome.replaced.join(", ")}`);
		});

		await t.test("a resync of the same 4,500 entries projects them once and keeps every tool presentation and measured height", async () => {
			const outcome = await work("window.replace('resync')");
			assert.ok(outcome.projected <= LOADED && outcome.positioned <= LOADED, `${outcome.projected} entries projected and ${outcome.positioned} positioned for one resync`);
			assert.ok(outcome.toolRoutes <= 8, `${outcome.toolRoutes} tool presentations computed again for entries that did not change`);
			assert.equal(outcome.heightResets, 0, "no measured height is thrown away by a resync");
			assert.ok(outcome.replaced.length <= 2, `rows replaced by a resync: ${outcome.replaced.join(", ")}`);
		});

		await t.test("an auto-compaction that drops 480 older messages projects what is left once and keeps its tool presentations and measured heights", async () => {
			const outcome = await work("window.replace('compact')");
			assert.ok(outcome.projected <= LOADED && outcome.positioned <= LOADED, `${outcome.projected} entries projected and ${outcome.positioned} positioned for one compaction`);
			assert.ok(outcome.toolRoutes <= 8, `${outcome.toolRoutes} tool presentations computed again for entries that did not change`);
			assert.equal(outcome.heightResets, 0, "no measured height is thrown away by a compaction");
			assert.ok(outcome.replaced.length <= 2, `rows replaced by a compaction: ${outcome.replaced.join(", ")}`);
		});
	} finally {
		page?.socket.close();
		browser?.socket.close();
		child.kill();
		server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
	}
});
