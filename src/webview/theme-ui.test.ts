/** Theme changes reach the real React controls and both shared xterm renderer modes. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { THEMES } from "./theme-ui-fixtures.ts";

const browserPath = [process.env.OMP_TEST_CHROMIUM, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/chromium"].find((path): path is string => path !== undefined && existsSync(path));

interface ThemeObservation {
	colors: Record<string, { color: string; background: string; opacity: string; border: string; disabled: boolean }>;
	ring: { label: string; cap: string; dash: string };
	terminals: { background: string; color: string; ansi: string }[];
	text: string[];
	errors: string[];
}
class Cdp {
	#id = 0;
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
			const pending = this.#pending.get(frame.id); if (!pending) return;
			this.#pending.delete(frame.id);
			if (frame.error) pending.reject(new Error(frame.error.message)); else pending.resolve(frame.result ?? {});
		});
		socket.addEventListener("close", () => { for (const pending of this.#pending.values()) pending.reject(new Error("owned browser closed")); this.#pending.clear(); });
	}
	static async connect(url: string): Promise<Cdp> {
		const socket = new WebSocket(url);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("owned browser failed")), { once: true });
		await promise;
		return new Cdp(socket);
	}
	call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const id = ++this.#id; const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		this.#pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); return promise;
	}
	event(method: string): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#events.set(method, [...(this.#events.get(method) ?? []), resolve]);
		return promise;
	}
	async evaluate<T>(expression: string): Promise<T> {
		const response = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
		const remote = response.result; assert.ok(remote !== null && typeof remote === "object");
		return ("value" in remote ? remote.value : undefined) as T;
	}
}

const fixture = `
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {DetailView} from './components/DetailView';
import {App} from './App';
import {guestTransport} from './bridge';
import {ChatClient} from './lib/chat-client';
import {createChatModel,snapshotOf} from '../chat/model';
import {splitChatSnapshot} from './chat-messages';
import {injectGuestStyles} from './styles';
import {attachSessionView} from './lib/session-view';
import {createTerminalRenderer} from './lib/terminal-renderer';
attachSessionView(guestTransport);injectGuestStyles('theme-test');
const client=new ChatClient(guestTransport);client.attach(guestTransport);
const snapshot={...snapshotOf(createChatModel(),{nonce:'theme-test',counter:1}),phase:'live',state:{model:{provider:'test',id:'model',name:'Model',contextWindow:100000},thinkingLevel:'low',isStreaming:true,isCompacting:false,queuedMessageCount:0,contextUsage:{tokens:4070,contextWindow:100000,percent:4.07}},todoSeed:[{name:'Theme checks',tasks:[{content:'Completed task',status:'completed'},{content:'Cancelled task',status:'abandoned'},{content:'Review controls',status:'in_progress'}]}],entries:[{type:'message',id:'answer',parentId:null,timestamp:'2026-10-08T00:00:00Z',message:{role:'assistant',model:'model',stopReason:'stop',timestamp:1,content:[{type:'text',text:${JSON.stringify("Inline `sample code` and fenced code:\n\n```ts\nconst visible = true;\n```")}}]}}]};
snapshot.working=true;snapshot.settled=false;
const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-08T00:00:00Z',message});
snapshot.entries.push(row('read-call',{role:'assistant',model:'model',timestamp:2,stopReason:'toolUse',content:[{type:'toolCall',id:'read-theme',name:'read',arguments:{path:'sample.ts'}}]}),
 row('read-result',{role:'toolResult',timestamp:3,toolCallId:'read-theme',toolName:'read',isError:false,content:[{type:'text',text:'const toolCodeIsVisible = true;'}]}),
 row('reminder',{role:'custom',customType:'native:todo_reminder',display:true,timestamp:4,content:'Historical TODO reminder',details:{attempt:1,maxAttempts:3,todos:[{content:'Earlier task snapshot',status:'pending'}]}}));
const receive=data=>window.dispatchEvent(new MessageEvent('message',{data}));
const root=createRoot(document.getElementById('root'));root.render(<App client={client}/>);
receive({type:'omp:session-view',mode:'chat',title:'Theme checks',running:true,starting:false,stopping:false,canSwitch:true,reason:null});
const parts=splitChatSnapshot(snapshot,'theme-test');receive(parts.snapshot);for(const chunk of parts.chunks)receive(chunk);
const renderers=[];
for(const [id,managed]of [['native',true],['shell',false]]){
 const host=document.getElementById(id);
 const renderer=createTerminalRenderer(host,{onData(){},onFocus(){},onLink(){},validateLink:async()=>false,copyText:async()=>true,newlineOnShiftEnter:managed,ctrlCInterrupts:!managed});
 renderer.fitToContainer();renderer.write(new TextEncoder().encode('Shared '+id+' renderer\\r\\nDefault foreground  \\x1b[34mANSI blue\\x1b[0m\\r\\nScreen survives a live theme switch'));renderers.push(renderer);
}
window.themeFixture={
 dispose(){for(const renderer of renderers)renderer.dispose()},text(){return renderers.map(renderer=>renderer.plainText())},
 push(patch){Object.assign(snapshot,patch);flushSync(()=>{const parts=splitChatSnapshot(snapshot,'theme-update');receive(parts.snapshot);for(const chunk of parts.chunks)receive(chunk)})},
 details(){flushSync(()=>root.render(<DetailView client={client} target={{kind:'todo'}}/>))},
 chat(){flushSync(()=>root.render(<App client={client}/>))},
 initialEntries:snapshot.entries,
 controls(){const request=window.sent.findLast(message=>message.type==='omp:control-request');if(request)receive({type:'omp:control-state',scope:request.scope,requestId:request.requestId,available:true,model:snapshot.state.model,thinkingLevel:snapshot.state.thinkingLevel,mutationMode:'best-effort'})},
};
window.themeReady=Promise.withResolvers();
const readyObserver=new MutationObserver(()=>{if(document.querySelector('.omp-context-trigger')&&document.querySelector('.omp-hud-toggle')){readyObserver.disconnect();window.themeReady.resolve()}});
readyObserver.observe(document.getElementById('root'),{subtree:true,childList:true});
`;

// Computed text colors are compared to their real painted backgrounds, not pinned CSS wording.
function luminance(color: string): number {
	const values = color.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
	return .2126 * values[0]! + .7152 * values[1]! + .0722 * values[2]!;
}
function contrast(first: string, second: string): number {
	const a = luminance(first), b = luminance(second); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

test("theme-aware controls and live native/shell terminal palettes", { skip: browserPath === undefined, timeout: 130_000 }, async () => {
	const bundled = await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: join(process.cwd(), "src/webview") }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' } });
	const server = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
		if (pathname === "/ui.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundled.outputFiles[0]!.text); return; }
		if (pathname === "/codicon.css" || pathname === "/codicon.ttf") { response.end(readFileSync(join(process.cwd(), "node_modules/@vscode/codicons/dist", pathname.slice(1)))); return; }
		response.setHeader("Content-Type", "text/html");
		response.end(`<html><head><link rel="stylesheet" href="/codicon.css"><style>html,body{margin:0}#root{height:520px!important}.terminals{display:flex;gap:12px;padding:12px;height:190px;background:var(--vscode-editor-background)}.terminal-box{flex:1;min-width:0}h2{font:13px sans-serif;margin:0 0 8px;color:var(--vscode-foreground)}.terminal-host{height:150px}</style><script>window.sent=[];window.errors=[];window.addEventListener('error',e=>window.errors.push(e.message));window.acquireVsCodeApi=()=>({postMessage(message){window.sent.push(message)},getState(){},setState(){}})</script></head><body><div id="root"></div><div class="terminals"><section class="terminal-box"><h2>Native Terminal</h2><div id="native" class="terminal-host"></div></section><section class="terminal-box"><h2>Folder shell</h2><div id="shell" class="terminal-host"></div></section></div><script src="/ui.js"></script></body></html>`);
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const profile = await mkdtemp(join(tmpdir(), "omp-theme-ui-"));
	const child = spawn(browserPath!, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
	let browser: Cdp | undefined, page: Cdp | undefined;
	try {
		const endpoint = Promise.withResolvers<string>(); let stderr = "";
		// Chromium is a separate process; this deadline bounds startup failure, not application timing. It is generous: the
		// browser suites start Chromium at once, beside the broker end-to-end tests, and a loaded CI runner took over 20 s.
		const timer = setTimeout(() => endpoint.reject(new Error("owned Chromium startup timed out")), 60_000);
		child.once("error", error => { clearTimeout(timer); endpoint.reject(error); });
		child.stderr!.on("data", data => { stderr += String(data); const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr); if (match) { clearTimeout(timer); endpoint.resolve(match[1]!); } });
		const url = await endpoint.promise; browser = await Cdp.connect(url);
		const target = await browser.call("Target.createTarget", { url: "about:blank" });
		const targets = await (await fetch(`http://${new URL(url).host}/json/list`)).json() as { id: string; webSocketDebuggerUrl: string }[];
		page = await Cdp.connect(targets.find(row => row.id === target.targetId)!.webSocketDebuggerUrl);
		await page.call("Emulation.setDeviceMetricsOverride", { width: 1050, height: 740, deviceScaleFactor: 1, mobile: false });
		await page.call("Page.enable");
		const loaded = page.event("Page.loadEventFired");
		await page.call("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
		await loaded;
		await page.evaluate("window.themeReady.promise");
		await page.evaluate("window.themeFixture.controls()");
		await page.evaluate("(()=>{document.querySelector('.omp-hud-toggle').click();document.querySelector('.omp-tool-head').click();const textarea=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,'A follow-up');textarea.dispatchEvent(new Event('input',{bubbles:true}));})()");
		const evidence: Record<string, unknown>[] = [];
		const capture = async (name: string): Promise<void> => {
			if (!process.env.OMP_THEME_SCREENSHOTS) return;
			await mkdir(process.env.OMP_THEME_SCREENSHOTS, { recursive: true });
			const screenshot = await page!.call("Page.captureScreenshot", { format: "png" });
			if (typeof screenshot.data !== "string") throw new Error("owned browser returned no screenshot");
			await writeFile(join(process.env.OMP_THEME_SCREENSHOTS, `${name}.png`), Buffer.from(screenshot.data, "base64"));
		};
		for (const theme of THEMES) {
			await page.evaluate(`(async()=>{document.body.className=${JSON.stringify(theme.bodyClass)};for(const [key,value]of Object.entries(${JSON.stringify(theme.tokens)}))document.body.style.setProperty(key,value);document.body.setAttribute('data-vscode-theme-id',${JSON.stringify(theme.name)});const frame=Promise.withResolvers();requestAnimationFrame(()=>requestAnimationFrame(frame.resolve));await frame.promise})()`);
			const result: ThemeObservation = await page.evaluate<ThemeObservation>(`(()=>{
			 const selectors={model:'.omp-footer-trigger',thinking:'.omp-footer-trigger--level',inline:'.omp-md p code',fenced:'.omp-md pre code',tool:'.omp-tool-body .omp-pre',reminder:'.omp-native-message.omp-native-muted',completed:'.omp-hud-task.omp-hud-tone--success .omp-hud-text',cancelled:'.omp-hud-task.omp-hud-tone--error .omp-hud-text',stop:'.omp-btn--stop',follow:'.omp-composer-toolbar-actions .omp-btn--icon-mid:not(.omp-btn--stop)',contextPercent:'.omp-context-percent'};
			 const composite=(front,back)=>{const alpha=front[3]??1;return front.slice(0,3).map((value,index)=>value*alpha+back[index]*(1-alpha))};
			 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');
			 const rgba=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);const values=context.getImageData(0,0,1,1).data;return[values[0],values[1],values[2],values[3]/255]};
			 function background(node){if(!node)return[255,255,255];return composite(rgba(getComputedStyle(node).backgroundColor),background(node.parentElement))}
			 window.themeColorProbe=selector=>{
			  const node=document.querySelector(selector);if(!node)throw new Error('missing '+selector);
			  const s=getComputedStyle(node);const painted=background(node);
			  return{color:'rgb('+composite(rgba(s.color),painted).join(', ')+')',background:'rgb('+painted.join(', ')+')',opacity:s.opacity,border:s.borderTopColor,disabled:node.disabled===true};
			 };
			 const colors=Object.fromEntries(Object.entries(selectors).map(([name,selector])=>[name,window.themeColorProbe(selector)]));
			 return{colors,ring:{label:document.querySelector('.omp-context-percent').textContent,cap:getComputedStyle(document.querySelector('.omp-context-progress')).strokeLinecap,dash:getComputedStyle(document.querySelector('.omp-context-track')).strokeDasharray},
			  terminals:['native','shell'].map(id=>{const host=document.getElementById(id);const row=host.querySelector('.xterm-rows');const ansi=host.querySelector('.xterm-fg-4');return{background:getComputedStyle(host).backgroundColor,color:getComputedStyle(row).color,ansi:getComputedStyle(ansi).color}}),
			  text:window.themeFixture.text(),errors:window.errors}
			})()`);
			assert.deepEqual(result.errors, []);
			for (const name of ["model", "thinking", "inline", "fenced", "tool", "reminder", "completed", "cancelled", "stop", "follow", "contextPercent"]) assert.ok(contrast(result.colors[name]!.color, result.colors[name]!.background) >= 4.5, `${theme.name}: ${name} text contrast`);
			assert.equal(result.colors.follow!.opacity, "1", "enabled follow-up is not dimmed");
			assert.equal(result.colors.follow!.disabled, false, "a draft can be queued as a follow-up");
			assert.equal(result.ring.label, "4%"); assert.equal(result.ring.cap, "butt"); assert.equal(result.ring.dash, "none");
			for (const terminal of result.terminals) { assert.equal(terminal.background, theme.expected.background); assert.equal(terminal.color, theme.expected.foreground); assert.equal(terminal.ansi, theme.expected.blue); }
			for (const text of result.text) assert.match(text, /Screen survives a live theme switch/);
			evidence.push({ theme: theme.name, ...result });
			const name = theme.name.toLowerCase().replaceAll(" ", "-");
			await capture(name);
			const modelBox: { x: number; y: number } = await page.evaluate<{ x: number; y: number }>("(()=>{const rect=document.querySelector('.omp-footer-trigger').getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()");
			await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...modelBox });
			const modelHover: ThemeObservation["colors"][string] = await page.evaluate<ThemeObservation["colors"][string]>("window.themeColorProbe('.omp-footer-trigger')");
			assert.equal(modelHover.disabled, false, "host-confirmed model control is enabled");
			assert.ok(contrast(modelHover.color, modelHover.background) >= 4.5, `${theme.name}: model hover contrast`);
			await capture(`${name}-pickers-hover`);
			await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
			await page.evaluate("(async()=>{document.querySelector('.omp-context-trigger').focus();const frame=Promise.withResolvers();requestAnimationFrame(frame.resolve);await frame.promise})()");
			const hover = await page.evaluate<ThemeObservation["colors"][string]>("window.themeColorProbe('.omp-context-popover')");
			assert.ok(contrast(hover.color, hover.background) >= 4.5, `${theme.name}: context hover contrast`);
			await capture(`${name}-context`);
			await page.evaluate("window.themeFixture.push({phase:'legacy'})");
			const warning = await page.evaluate<ThemeObservation["colors"][string]>("window.themeColorProbe('.omp-notice--warning')");
			assert.ok(contrast(warning.color, warning.background) >= 4.5, `${theme.name}: warning notice contrast`);
			assert.ok(await page.evaluate("!!document.querySelector('.omp-notice--warning .codicon-warning')"), "warning notice has a warning icon");
			await capture(`${name}-warning`);
			await page.evaluate("window.themeFixture.push({phase:'live',uiRequests:[{id:'theme-ask',method:'select',title:'Choose an option',options:[{label:'Continue'},{label:'Review first'}]}]})");
			const cancel = await page.evaluate<ThemeObservation["colors"][string]>("window.themeColorProbe('.omp-composer-actions .omp-btn:not(.omp-btn--stop)')");
			assert.ok(contrast(cancel.color, cancel.background) >= 4.5, `${theme.name}: ask Cancel contrast`);
			if (theme.bodyClass.includes("high-contrast")) assert.notEqual(cancel.border, "rgba(0, 0, 0, 0)", "ask Cancel has a high-contrast border");
			await capture(`${name}-ask`);
			await page.evaluate(`window.themeFixture.push({uiRequests:[{id:'native-ask',method:'ask',title:'Review choices',questions:[{id:'one',header:'A complete question title that must stay readable in review',question:'Which options should be included?',multi:true,options:[{label:'First option'},{label:'Second option'}]},{id:'two',header:'Confirmation',question:'Choose one option',multi:false,options:[{label:'Continue'},{label:'Review first'}]}]}]})`);
			await page.evaluate("document.querySelector('.omp-ask-option').click()");
			assert.equal(await page.evaluate("document.querySelector('.omp-ask-option').getAttribute('aria-checked')"), "true");
			assert.equal(await page.evaluate("document.querySelector('.omp-ask-option-marker').classList.contains('codicon-check')"), true);
			assert.equal(await page.evaluate("getComputedStyle(document.querySelector('.omp-ask-option-label')).fontFamily===getComputedStyle(document.body).fontFamily"), true, "option labels use the UI font");
			assert.equal(await page.evaluate("(()=>{const marker=document.querySelector('.omp-ask-option-marker'),expected=document.createElement('span');expected.style.color='var(--vscode-checkbox-foreground)';expected.style.background='var(--vscode-checkbox-background)';document.body.append(expected);const a=getComputedStyle(marker),b=getComputedStyle(expected),same=a.color===b.color&&a.backgroundColor===b.backgroundColor;expected.remove();return same})()"), true, "checkbox markers use native paired tokens");
			await capture(`${name}-ask-multi`);
			await page.evaluate("document.querySelector('.omp-ask-tab--submit').click()");
			assert.equal(await page.evaluate("document.querySelector('.omp-ask-review-q').textContent.includes('A complete question title that must stay readable in review')"), true);
			await capture(`${name}-ask-review`);
			await page.evaluate(`(()=>{const row=(id,message)=>({type:'message',id,parentId:null,timestamp:'2026-10-08T00:00:00Z',message});
			 window.themeFixture.push({uiRequests:[],entries:[row('failed-call',{role:'assistant',model:'model',timestamp:2,stopReason:'toolUse',content:[{type:'toolCall',id:'failed-command',name:'bash',arguments:{command:'run checks'}}]}),row('failed-result',{role:'toolResult',toolCallId:'failed-command',toolName:'bash',timestamp:3,isError:true,content:[{type:'text',text:'The command could not complete.'}],details:{exitCode:2}})]});
			 document.querySelector('[data-tool-call-id="failed-command"] .omp-tool-head').click();})()`);
			assert.equal(await page.evaluate("document.querySelectorAll('.omp-tool-head .codicon-error').length"), 1);
			assert.equal(await page.evaluate("document.querySelector('.omp-tool-body').textContent.split('The command could not complete.').length-1"), 1);
			assert.equal(await page.evaluate("document.querySelector('.omp-tool-head .omp-chip--err')"), null);
			const failedColors: Record<string, string> = await page.evaluate<Record<string, string>>(`(()=>{const head=document.querySelector('.omp-tool-head'),status=head.querySelector('.codicon-error'),expected=document.createElement('span');expected.style.color='var(--vscode-testing-iconFailed,var(--vscode-errorForeground))';document.body.append(expected);const colors={status:getComputedStyle(status).color,expected:getComputedStyle(expected).color,title:getComputedStyle(head.querySelector('.omp-tool-name')).color,normal:getComputedStyle(head).color,meta:getComputedStyle(head.querySelector('.omp-native-tool-meta')).color};expected.style.color='var(--vscode-descriptionForeground)';colors.muted=getComputedStyle(expected).color;expected.remove();return colors})()`);
			assert.equal(failedColors.status, failedColors.expected, "one failure icon uses the native failure token");
			assert.equal(failedColors.title, failedColors.normal, "failed title retains normal foreground");
			assert.equal(failedColors.meta, failedColors.muted, "exit codes remain muted metadata");
			await capture(`${name}-failed-tool`);
			evidence.push({ theme: theme.name, failedColors });
			await page.evaluate("window.themeFixture.push({entries:window.themeFixture.initialEntries})");
			await page.evaluate("window.themeFixture.details()");
			const closed = await page.evaluate<ThemeObservation["colors"]>("({completed:window.themeColorProbe('.omp-detail-task.omp-hud-tone--success .omp-detail-task-text'),cancelled:window.themeColorProbe('.omp-detail-task.omp-hud-tone--error .omp-detail-task-text')})");
			for (const task of Object.values(closed)) assert.ok(contrast(task.color, task.background) >= 4.5, `${theme.name}: TODO detail contrast`);
			await capture(`${name}-todo`);
			evidence.push({ theme: theme.name, hover, warning, cancel, closed });
			await page.evaluate("(()=>{window.themeFixture.push({phase:'live',uiRequests:[]});window.themeFixture.chat();document.querySelector('.omp-hud-toggle').click();document.querySelector('.omp-tool-head').click();const textarea=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,'A follow-up');textarea.dispatchEvent(new Event('input',{bubbles:true}));})()");
			await page.evaluate("window.themeFixture.controls()");
			for (const width of [1000, 760, 590, 460, 300]) {
				await page.call("Emulation.setDeviceMetricsOverride", { width, height: 740, deviceScaleFactor: 1, mobile: false });
				await page.evaluate("(()=>{const {promise,resolve}=Promise.withResolvers();requestAnimationFrame(()=>requestAnimationFrame(resolve));return promise})()");
				assert.equal(await page.evaluate("(()=>{const card=document.querySelector('.omp-composer').getBoundingClientRect();return[...document.querySelectorAll('.omp-composer-toolbar button')].filter(node=>node.getBoundingClientRect().width>0).every(node=>{const r=node.getBoundingClientRect();return r.left>=card.left&&r.right<=card.right})})()"), true, `${theme.name}: controls contained at ${width}px`);
				await capture(`${name}-composer-${width}`);
			}
			await page.evaluate("(()=>{const textarea=document.querySelector('.omp-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,'');textarea.dispatchEvent(new Event('input',{bubbles:true}));})()");
			await capture(`${name}-placeholder-300`);
			await page.evaluate("window.themeFixture.push({working:false})");
			await capture(`${name}-idle-placeholder-300`);
			await page.evaluate("(()=>{window.themeFixture.push({working:true});const textarea=document.querySelector('.omp-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,'A follow-up');textarea.dispatchEvent(new Event('input',{bubbles:true}));})()");
			await page.call("Emulation.setDeviceMetricsOverride", { width: 1050, height: 740, deviceScaleFactor: 1, mobile: false });
		}
		const remainder = await page.evaluate<string[]>("['native','shell'].map(id=>document.getElementById(id).style.backgroundColor)");
		await page.evaluate("(async()=>{window.themeFixture.dispose();document.body.style.setProperty('--vscode-terminal-background','#ff00ff');document.body.setAttribute('data-vscode-theme-id','disposed');await Promise.resolve()})()");
		assert.deepEqual(await page.evaluate("['native','shell'].map(id=>document.getElementById(id).style.backgroundColor)"), remainder, "disposed renderers no longer observe theme changes");
		assert.equal(await page.evaluate("document.querySelectorAll('.xterm').length"), 0, "renderer disposal removes terminal surfaces");
		if (process.env.OMP_THEME_SCREENSHOTS) await writeFile(join(process.env.OMP_THEME_SCREENSHOTS, "theme-evidence.json"), JSON.stringify(evidence, null, 2));
	} finally {
		page?.socket.close(); try { await browser?.call("Browser.close"); } catch { /* Browser shutdown may close CDP before acknowledging. */ } browser?.socket.close();
		if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
		// Chromium's helper processes can outlive the browser process briefly and still hold profile files.
		const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
