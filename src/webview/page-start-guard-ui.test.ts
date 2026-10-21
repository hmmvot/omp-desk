/**
 * The chat page's start guard in an owned headless Chromium: a page whose bundle cannot be fetched (the install folder was
 * replaced or removed under a restored editor) or whose bundle loads and never mounts must show an explanation with a Reload
 * Window action, never an empty editor; a page that mounts must be left alone.
 *
 * The document is the real {@link createGuestHtml} output; only the bundle is a stand-in, and the VS Code API is a stub that, like
 * the real one, can be acquired once.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type * as vscode from "vscode";
import { PAGE_START_FAILED_MESSAGE, UNAVAILABLE_RELOAD_MESSAGE, createGuestHtml } from "../host/guest-webview.ts";

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
	/** Poll until `expression` holds, for at most `ms`. */
	async wait(expression: string, ms = 15_000): Promise<void> {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (await this.evaluate<boolean>(`Boolean(${expression})`)) return;
			await sleep(50);
		}
		throw new Error(`page condition timed out: ${expression}`);
	}
}

/** What the stand-in bundle does when the page asks for it. */
type Bundle = "missing" | "acquires-and-idles" | "mounts";

// Skipped when no Chromium-based browser is found; set OMP_TEST_CHROMIUM to point at one.
test("page start guard: a bundle that cannot load or mount is explained with a Reload Window action", { skip: browserPath === undefined, timeout: 120_000 }, async t => {
	let bundle: Bundle = "missing";
	const server = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
		response.setHeader("Cache-Control", "no-store");
		if (pathname === "/media/guest.js") {
			if (bundle === "missing") { response.statusCode = 404; response.end("not found"); return; }
			response.setHeader("Content-Type", "text/javascript");
			response.end(
				bundle === "mounts"
					? `document.getElementById("root").appendChild(Object.assign(document.createElement("main"),{textContent:"chat"}));`
					: `window.acquireVsCodeApi().postMessage({type:"bundle-ran"});`,
			);
			return;
		}
		if (pathname === "/media/codicons/codicon.css") { response.setHeader("Content-Type", "text/css"); response.end(""); return; }
		response.setHeader("Content-Type", "text/html");
		const webview = {
			cspSource: "'self'",
			asWebviewUri: (uri: { path: string }) => ({ toString: () => uri.path }),
		} as unknown as vscode.Webview;
		const extensionUri = { path: "/extension", with({ path }: { path: string }) { return { path: path.replace("/extension", "") }; } } as unknown as vscode.Uri;
		const html = createGuestHtml(webview, extensionUri, "tab:2c26b46b-68ff-4c1d-a3d8-1e0f9a0b7c6d", null);
		const nonce = /<script nonce="([^"]+)"/.exec(html)![1]!;
		// The VS Code API of a real webview can be acquired once; a second acquisition throws.
		response.end(html.replace("</head>", `<script nonce="${nonce}">window.sent=[];let acquired=false;
			window.acquireVsCodeApi=()=>{if(acquired)throw new Error("An instance of the VS Code API has already been acquired");acquired=true;return{postMessage(message){window.sent.push(message)},setState(){}}};</script></head>`));
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/`;
	const profile = await mkdtemp(join(tmpdir(), "omp-page-guard-ui-"));
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
		async function open(which: Bundle): Promise<void> {
			bundle = which;
			const loaded = ui.event("Page.loadEventFired");
			await ui.call("Page.navigate", { url: `${url}?${which}` });
			await loaded;
		}
		const alertText = () => ui.evaluate<string | null>(`document.querySelector('#root [role=alert]')?.textContent ?? null`);

		await t.test("a bundle that cannot be fetched leaves an explanation and a working Reload Window button, not an empty page", async () => {
			await open("missing");
			await ui.wait(`document.querySelector('#root [role=alert]')`);
			assert.match((await alertText())!, /could not start this page/);
			assert.equal(await ui.evaluate("document.querySelector('#root button').textContent"), "Reload Window");
			assert.deepEqual(await ui.evaluate("window.sent"), [{ type: PAGE_START_FAILED_MESSAGE, reason: "script-error" }]);
			await ui.evaluate("document.querySelector('#root button').click()");
			assert.deepEqual(await ui.evaluate("window.sent.slice(1)"), [{ type: UNAVAILABLE_RELOAD_MESSAGE }]);
		});

		await t.test("a bundle that loads and mounts nothing is explained too, even after it took the one VS Code API", async () => {
			await open("acquires-and-idles");
			assert.equal(await alertText(), null, "within the grace period the page is only starting");
			await ui.wait(`document.querySelector('#root [role=alert]')`, 12_000);
			assert.equal(await ui.evaluate("document.querySelector('#root button').textContent"), "Reload Window", "the guard shares the API the bundle acquired");
			assert.deepEqual(await ui.evaluate("window.sent"), [{ type: "bundle-ran" }, { type: PAGE_START_FAILED_MESSAGE, reason: "not-started" }]);
		});

		await t.test("a page that mounts is never covered by the explanation", async () => {
			await open("mounts");
			// A real wait: the guard's grace period is a platform timer inside the page, which fake timers here cannot advance.
			await sleep(6_500);
			assert.equal(await alertText(), null);
			assert.equal(await ui.evaluate("document.querySelector('#root main').textContent"), "chat");
			assert.deepEqual(await ui.evaluate("window.sent"), []);
		});
	} finally {
		page?.socket.close(); browser?.socket.close();
		child.kill();
		await once(child, "exit").catch(() => undefined);
		server.close();
		await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
