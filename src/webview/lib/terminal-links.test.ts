import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { IBuffer, ILink } from "@xterm/xterm";
import { detectTerminalFileLinks } from "../terminal-links.ts";
import { terminalFileLinkProvider } from "./terminal-link-provider.ts";
import { TerminalLinkClient } from "./terminal-link-client.ts";
import type { GuestHostMessage, GuestWebviewMessage } from "../messages.ts";
const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as { Terminal: typeof HeadlessTerminal };

test("plain references detect relative, Windows, quoted spaces and line/column without URLs", () => {
	const text = 'src/file.ts:12:4, C:\\repo\\other.ts:9 "src/a b.ts:2:3" file.ts:7. LICENSE:2 D:\\Work Space\\plain.ts:11:5 https://example.test/a.ts';
	const links = detectTerminalFileLinks(text);
	assert.deepEqual(links.map(link => link.target), ["src/file.ts:12:4", "C:\\repo\\other.ts:9", "src/a b.ts:2:3", "file.ts:7", "LICENSE:2", "D:\\Work Space\\plain.ts:11:5"]);
	for (const link of links) assert.equal(text.slice(link.start, link.end), link.target);
});

test("backslash absolute paths are detected in inline code, bare, with spaces, and before punctuation", () => {
	const png = "D:\\Workfiles\\repo\\docs\\img\\icon-options.png";
	const cases: Array<[string, string[]]> = [
		[`path \`${png}\` done`, [png]],
		[`path ${png} done`, [png]],
		[`path ${png}.`, [png]],
		[`see (${png}), then`, [png]],
		[`file ${png}: not found`, [png]],
		[`at ${png}:12:3: boom`, [`${png}:12:3`]],
		[`\`${png}\`.`, [png]],
		[`it's at \`${png}\` and isn't gone`, [png]],
		["open D:/Workfiles/my docs/a b.png now", ["D:/Workfiles/my docs/a b.png"]],
		["read ~/notes/todo.md:4, then ~\\x.txt)", ["~/notes/todo.md:4", "~\\x.txt"]],
		["docs\\tmp\\x.png: ok", ["docs\\tmp\\x.png"]],
	];
	for (const [text, expected] of cases) {
		const links = detectTerminalFileLinks(text);
		for (const target of expected) assert.ok(links.some(link => link.target === target), `${JSON.stringify(target)} not found in ${JSON.stringify(text)}: ${JSON.stringify(links.map(link => link.target))}`);
		for (const link of links) assert.equal(text.slice(link.start, link.end), link.target, text);
	}
});

test("the provider answers a repaint-driven re-query from its cache without another host validation", async () => {
	const terminal = new Terminal({ cols: 100, rows: 6, allowProposedApi: true });
	try {
		const target = "D:\\Workfiles\\repo\\docs\\img\\icon-options.png";
		const written = Promise.withResolvers<void>();
		terminal.write(`look at \`${target}\` now\r\nsecond.ts row`, written.resolve); await written.promise;
		const validations: string[] = [];
		let clock = 0;
		const provider = terminalFileLinkProvider(terminal as unknown as { buffer: { active: IBuffer }; cols: number }, {
			validate: async value => { validations.push(value); return value === target; }, activate() {}, hover() {}, leave() {}, now: () => clock,
		});
		const first = Promise.withResolvers<ILink[] | undefined>();
		provider.provideLinks(1, first.resolve);
		const links = await first.promise;
		assert.deepEqual(links?.map(link => link.text), [target]);
		assert.ok(validations.includes(target));
		const before = validations.length;
		// Synchronous reply: xterm tears the old link down and installs the replacement in one task.
		let synchronous: ILink[] | undefined;
		provider.provideLinks(1, result => { synchronous = result; });
		assert.deepEqual(synchronous?.map(link => link.text), [target]);
		assert.deepEqual(synchronous![0]!.range, links![0]!.range);
		assert.equal(validations.length, before, "no repeated host validation while the cache is fresh");
		// A hit expires after 30 s, a miss after 5 s.
		clock = 6_000;
		const second = Promise.withResolvers<ILink[] | undefined>();
		provider.provideLinks(1, second.resolve);
		assert.ok(validations.length > before, "misses are retried after their short TTL");
		assert.deepEqual((await second.promise)?.map(link => link.text), [target]);
		assert.equal(validations.filter(value => value === target).length, 1, "positive results outlive the miss TTL");
		clock = 31_000;
		const third = Promise.withResolvers<ILink[] | undefined>();
		provider.provideLinks(1, third.resolve);
		await third.promise;
		assert.equal(validations.filter(value => value === target).length, 2, "positive results are re-validated after their TTL");
	} finally { terminal.dispose(); }
});

test("a row that repaints during validation is retried from the warm cache instead of dropping its link", async () => {
	const terminal = new Terminal({ cols: 80, rows: 4, allowProposedApi: true });
	try {
		const written = Promise.withResolvers<void>();
		terminal.write("see src/a.ts here", written.resolve); await written.promise;
		const gate = Promise.withResolvers<boolean>();
		let calls = 0;
		const provider = terminalFileLinkProvider(terminal as unknown as { buffer: { active: IBuffer }; cols: number }, {
			validate: value => { calls++; return value === "src/a.ts" ? gate.promise : Promise.resolve(false); }, activate() {}, hover() {}, leave() {},
		});
		const result = Promise.withResolvers<ILink[] | undefined>();
		provider.provideLinks(1, result.resolve);
		const repainted = Promise.withResolvers<void>();
		terminal.write("\r\x1b[1;80H*", repainted.resolve); await repainted.promise;
		gate.resolve(true);
		assert.deepEqual((await result.promise)?.map(link => link.text), ["src/a.ts"]);
		assert.ok(calls >= 1);
	} finally { terminal.dispose(); }
});

test("actual xterm cells preserve wrapped paths and wide-prefix hit ranges; missing candidates aren't clickable", async () => {
	const terminal = new Terminal({ cols: 24, rows: 6, allowProposedApi: true });
	try {
		const { promise, resolve } = Promise.withResolvers<void>();
		terminal.write("界 src/long-file-name.ts:12:4 absent.ts", resolve); await promise;
		const opened: string[] = [];
		const provider = terminalFileLinkProvider(terminal as unknown as { buffer: { active: IBuffer }; cols: number }, {
			validate: async target => target === "src/long-file-name.ts:12:4", activate: target => { opened.push(target); }, hover() {}, leave() {},
		});
		const result = Promise.withResolvers<ILink[] | undefined>();
		provider.provideLinks(2, result.resolve);
		const links = await result.promise;
		assert.equal(links?.length, 1);
		const link = links![0]!;
		assert.deepEqual(link.range, { start: { x: 4, y: 1 }, end: { x: 5, y: 2 } });
		link.activate({ preventDefault() {} } as MouseEvent, link.text);
		assert.deepEqual(opened, ["src/long-file-name.ts:12:4"]);
	} finally { terminal.dispose(); }
});

test("pane validation correlation preserves open target positions and disposal resolves pending requests", async () => {
	const sent: GuestWebviewMessage[] = [];
	let receive: (message: GuestHostMessage) => void = () => {};
	const client = new TerminalLinkClient({ post: message => { sent.push(message); return true; }, subscribe: listener => { receive = listener; return () => {}; } });
	const pending = client.validate("src/a.ts:17:6");
	receive({ type: "omp:terminal-link-validation", requestId: 99, valid: true });
	receive({ type: "omp:terminal-link-validation", requestId: 0, valid: true });
	assert.equal(await pending, true);
	client.open("src/a.ts:17:6");
	assert.deepEqual(sent.at(-1), { type: "omp:terminal-link-open", requestId: 1, target: "src/a.ts:17:6" });
	const abandoned = client.validate("src/b.ts"); client.dispose(); assert.equal(await abandoned, false);
});

test("late validation from a disposed pane cannot mark a replacement pane's missing file clickable", async () => {
	const sent: GuestWebviewMessage[] = [];
	let receive: (message: GuestHostMessage) => void = () => {};
	const transport = { post(message: GuestWebviewMessage) { sent.push(message); return true; }, subscribe(listener: (message: GuestHostMessage) => void) { receive = listener; return () => {}; } };
	const old = new TerminalLinkClient(transport);
	const oldPending = old.validate("exists.ts");
	const oldRequest = sent.at(-1)!;
	assert.ok(oldRequest.type === "omp:terminal-link-validate");
	const oldId = oldRequest.requestId;
	old.dispose(); assert.equal(await oldPending, false);
	const replacement = new TerminalLinkClient(transport);
	const pending = replacement.validate("missing.ts");
	const newRequest = sent.at(-1)!;
	assert.ok(newRequest.type === "omp:terminal-link-validate");
	const newId = newRequest.requestId;
	receive({ type: "omp:terminal-link-validation", requestId: oldId, valid: true });
	receive({ type: "omp:terminal-link-validation", requestId: newId, valid: false });
	assert.equal(await pending, false);
	replacement.dispose();
});

test("late file references on a dense terminal row are validated rather than silently dropped", async () => {
	const terminal = new Terminal({ cols: 512, rows: 2, allowProposedApi: true });
	try {
		const row = Array.from({ length: 30 }, (_, index) => `item${index}.ts`).join(" ");
		const written = Promise.withResolvers<void>();
		terminal.write(row, written.resolve); await written.promise;
		const provider = terminalFileLinkProvider(terminal as unknown as { buffer: { active: IBuffer }; cols: number }, {
			validate: async target => target === "item29.ts", activate() {}, hover() {}, leave() {},
		});
		const provided = Promise.withResolvers<ILink[] | undefined>();
		provider.provideLinks(1, provided.resolve);
		const links = await provided.promise;
		assert.deepEqual(links?.map(link => link.text), ["item29.ts"]);
		assert.equal(links![0]!.range.start.x, row.indexOf("item29.ts") + 1);
	} finally { terminal.dispose(); }
});
