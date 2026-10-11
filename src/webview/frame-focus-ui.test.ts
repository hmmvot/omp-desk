/**
 * The page's focus when VS Code focuses its webview again on a window focus, in an owned headless Chromium.
 *
 * VS Code runs `contentWindow.focus()` on the webview's frame, then 50 ms later focuses the frame's window again from
 * inside (the webview host's `focus` message). Chromium empties the page's focus on the first call; the restorer under
 * test must put the focused element back.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";

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

// VS Code's webview is two frames deep: its host page, which the workbench embeds, holds the content frame the page runs in.
const WORKBENCH = `<!doctype html><iframe id="webview" src="/host.html" style="width:600px;height:300px"></iframe>`;
const HOST = `<!doctype html><iframe id="content" src="/child.html" style="width:500px;height:200px"></iframe>`;
const CONTENT = `<!doctype html><textarea id="composer"></textarea><button id="other">Other</button><script src="/restorer.js"></script>`;

test("the composer keeps its focus when the host focuses the webview frame again", { skip: browserPath === undefined && "no Chromium is available" }, async () => {
	const bundle = await build({
		stdin: { contents: `import { restoreFocusTakenByHost } from "./src/webview/lib/frame-focus.ts"; window.install = () => restoreFocusTakenByHost(window);`, resolveDir: process.cwd(), loader: "ts" },
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
	});
	const script = bundle.outputFiles[0]!.text;
	const server = createServer((request, response) => {
		const pages: Record<string, string> = { "/restorer.js": script, "/child.html": CONTENT, "/host.html": HOST };
		response.setHeader("content-type", request.url === "/restorer.js" ? "text/javascript" : "text/html");
		response.end(pages[request.url ?? ""] ?? WORKBENCH);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const profile = await mkdtemp(join(tmpdir(), "omp-frame-focus-"));
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
		const created = await browser.call("Target.createTarget", { url: `http://127.0.0.1:${address.port}/` });
		const targets = await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json() as { id: string; webSocketDebuggerUrl: string }[];
		page = await Cdp.connect(targets.find(row => row.id === created.targetId)!.webSocketDebuggerUrl);
		await page.call("Emulation.setFocusEmulationEnabled", { enabled: true });
		const hostFrame = "document.querySelector('#webview').contentDocument";
		const frame = `${hostFrame}.querySelector('#content').contentDocument`;
		const composerReady = `Boolean(document.querySelector('#webview')?.contentDocument?.querySelector('#content')?.contentDocument?.querySelector('#composer'))`;
		// The target is still navigating from about:blank at first, which destroys the context a call runs in.
		for (let attempt = 0; attempt < 300 && !await page.evaluate<boolean>(composerReady).catch(() => false); attempt++) await delay(20);
		// VS Code's own 50 ms wait between its two focus calls runs on the platform clock; the restorer's window is measured in it.
		const sleep = (ms: number) => page!.evaluate(`new Promise(resolve => setTimeout(resolve, ${ms}))`);
		const heldByComposer = () => page!.evaluate<boolean>(`${frame}.activeElement === ${frame}.querySelector('#composer') && ${frame}.hasFocus()`);
		/** What VS Code does when its window gains focus: the workbench focuses the webview frame; its host page then focuses the content frame 50 ms later. */
		const hostRefocus = async () => {
			await page!.evaluate(`document.querySelector('#webview').contentWindow.focus()`);
			await sleep(50);
			await page!.evaluate(`${hostFrame}.querySelector('#content').contentWindow.focus()`);
			await sleep(100);
		};
		const focusComposer = () => page!.evaluate(`${frame}.defaultView.focus(); ${frame}.querySelector('#composer').focus()`);

		await focusComposer();
		assert.equal(await heldByComposer(), true);
		await hostRefocus();
		assert.equal(await heldByComposer(), false, "without the restorer the host's refocus leaves nothing focused (the defect)");

		await page.evaluate(`${frame}.defaultView.install()`);
		await focusComposer();
		await page.call("Input.insertText", { text: "draft" });
		await hostRefocus();
		assert.equal(await heldByComposer(), true, "the composer is focused again");
		await page.call("Input.insertText", { text: " kept" });
		assert.equal(await page.evaluate<string>(`${frame}.querySelector('#composer').value`), "draft kept", "typing after the refocus reaches the composer");

		await page.evaluate(`${frame}.querySelector('#other').focus()`);
		await hostRefocus();
		assert.equal(await page.evaluate<boolean>(`${frame}.activeElement === ${frame}.querySelector('#other')`), true, "whichever element the user held is the one restored");
	} finally {
		page?.socket.close();
		browser?.socket.close();
		child.kill();
		server.close();
		await rm(profile, { recursive: true, force: true }).catch(() => undefined);
	}
});
