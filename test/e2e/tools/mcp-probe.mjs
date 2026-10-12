// Spike tool: drives the hidden-desktop VS Code through an MCP browser server, to learn what an agent would see.
//
//   node test/e2e/tools/mcp-probe.mjs playwright <cdp-port> [mock-url]
//   node test/e2e/tools/mcp-probe.mjs devtools   <cdp-port>
//
// It spawns the server over stdio (`npx`, nothing is registered in any user or global MCP configuration), speaks the
// MCP JSON-RPC protocol by hand (no SDK dependency) and prints a JSON report: the tool names, whether the accessibility
// snapshot contains the extension's nested webview content (the Chat composer), whether typing and clicking inside that
// webview works, and (devtools) whether a performance trace can be recorded. The window under test must have a Chat
// session open (`npm run test:e2e` with `E2E_KEEP_ENV=1` and a session left open by a scenario, or open one by hand).
import { spawn } from "node:child_process";

const [kind, port, mockUrl] = process.argv.slice(2);
if (!["playwright", "devtools"].includes(kind) || !port) {
	console.error("usage: mcp-probe.mjs <playwright|devtools> <cdp-port> [mock-url]");
	process.exit(2);
}

const endpoint = `http://127.0.0.1:${port}`;
const command = kind === "playwright"
	? ["npx", "-y", "@playwright/mcp@latest", `--cdp-endpoint=${endpoint}`]
	: ["npx", "-y", "chrome-devtools-mcp@latest", `--browser-url=${endpoint}`, "--no-usage-statistics", "--no-performance-crux"];

const child = spawn(command[0], command.slice(1), { shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk; });
const pending = new Map();
let buffer = "";
child.stdout.on("data", chunk => {
	buffer += chunk;
	for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line === "") continue;
		let message;
		try { message = JSON.parse(line); } catch { continue; }
		const waiter = pending.get(message.id);
		if (waiter) { pending.delete(message.id); waiter(message); }
	}
});

let nextId = 1;
function request(method, params, timeoutMs = 180_000) {
	const id = nextId++;
	const reply = new Promise((resolve, reject) => {
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
		pending.set(id, message => { clearTimeout(timer); resolve(message); });
	});
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	return reply;
}
const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
const text = reply => (reply.result?.content ?? []).map(part => part.text ?? "").join("\n") + (reply.error ? `ERROR ${JSON.stringify(reply.error)}` : "");
async function call(name, args = {}, timeoutMs) {
	const started = Date.now();
	const reply = await request("tools/call", { name, arguments: args }, timeoutMs);
	return { text: text(reply), isError: reply.result?.isError === true, ms: Date.now() - started };
}
const refOf = (snapshot, pattern) => new RegExp(`${pattern}[^\\n]*\\[ref=(\\w+)\\]`).exec(snapshot)?.[1];

const report = { server: kind, command: command.join(" ") };
try {
	const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "omp-desk-e2e-probe", version: "0" } }, 300_000);
	report.serverInfo = init.result?.serverInfo;
	notify("notifications/initialized", {});
	const tools = await request("tools/list", {});
	report.tools = (tools.result?.tools ?? []).map(tool => tool.name);

	if (kind === "playwright") {
		report.tabs = (await call("browser_tabs", { action: "list" })).text.slice(0, 600);
		const snapshot = await call("browser_snapshot");
		report.snapshotMs = snapshot.ms;
		report.snapshotChars = snapshot.text.length;
		report.snapshotHasSessionsTree = /Sessions/.test(snapshot.text);
		report.snapshotHasIframe = /iframe/i.test(snapshot.text);
		report.snapshotHasChatComposer = /Message OMP/.test(snapshot.text);
		report.iframeExcerpt = snapshot.text.split("\n").filter(line => /iframe/i.test(line)).slice(0, 6).concat(snapshot.text.split("\n").filter(line => /Mock Model|Message OMP|Conversation transcript/.test(line)).slice(0, 4));
		const composer = refOf(snapshot.text, 'combobox "Message OMP"');
		const send = refOf(snapshot.text, 'button "Send message"');
		report.composerRef = composer ?? null;
		if (composer && send) {
			const typed = await call("browser_type", { element: "Chat composer", ref: composer, text: "typed through playwright mcp" });
			report.typeIsError = typed.isError;
			const afterType = await call("browser_snapshot");
			const sendNow = refOf(afterType.text, 'button "Send message"') ?? send;
			const clicked = await call("browser_click", { element: "Send message", ref: sendNow });
			report.clickIsError = clicked.isError;
			await new Promise(resolve => setTimeout(resolve, 4000));
			if (mockUrl) {
				const seen = await (await fetch(`${mockUrl}/__requests`)).json();
				report.mockReceivedTypedText = seen.some(request => request.lastUserText === "typed through playwright mcp");
			}
			const final = await call("browser_snapshot");
			report.finalSnapshotHasReply = /Mock reply to: typed through playwright mcp/.test(final.text);
		}
	} else {
		report.pages = (await call("list_pages")).text.slice(0, 600);
		const snapshot = await call("take_snapshot", { pageId: 1 });
		report.snapshotChars = snapshot.text.length;
		report.snapshotHasSessionsTree = /Sessions/.test(snapshot.text);
		report.snapshotHasChatComposer = /Message OMP/.test(snapshot.text);
		const start = await call("performance_start_trace", { pageId: 1, reload: false, autoStop: false });
		report.traceStart = start.text.slice(0, 300);
		await new Promise(resolve => setTimeout(resolve, 3000));
		const stop = await call("performance_stop_trace", { pageId: 1 }, 300_000);
		report.traceStop = stop.text.slice(0, 900);
	}
} catch (error) {
	report.error = String(error);
	report.stderrTail = stderr.slice(-800);
} finally {
	child.kill();
	spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}
console.log(JSON.stringify(report, null, 2));
process.exit(0);
