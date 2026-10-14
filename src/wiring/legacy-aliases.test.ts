/**
 * The old command ids kept as aliases and the one-time rename notice (ADR-0068). Runner: `node --test src/wiring/legacy-aliases.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	LEGACY_ALIASES, LEGACY_COMMAND_IDS, OPEN_KEYBINDINGS_ACTION, RENAME_NOTICE_TEXT, announceRename, foreignOmpNames, legacyContextKey, legacyCommandTarget,
	registerLegacyAliases,
} from "./legacy-aliases.ts";
import type { LegacyAliasPort, RenameNoticePort } from "./legacy-aliases.ts";
import type { LoggedLine } from "../shared/logger.ts";
import { recordingLogger } from "../shared/logger.ts";

function aliasPort(overrides: Partial<LegacyAliasPort> = {}) {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const executed: unknown[][] = [];
	const warnings: string[] = [];
	const opened: number[] = [];
	const lines: LoggedLine[] = [];
	const port: LegacyAliasPort = {
		register: (id, handler) => {
			if (handlers.has(id)) throw new Error(`command '${id}' already exists`);
			handlers.set(id, handler);
			return { dispose: () => { handlers.delete(id); } };
		},
		execute: async (id, ...args) => { executed.push([id, ...args]); return `ran ${id}`; },
		warn: async message => { warnings.push(message); return OPEN_KEYBINDINGS_ACTION; },
		openKeybindingsFile: async () => { opened.push(1); },
		foreignCommands: new Set(),
		log: recordingLogger(lines),
		...overrides,
	};
	return { port, handlers, executed, warnings, opened, lines };
}

describe("the table", () => {
	it("maps every old id to the ompDesk. id with the same rest and adds the generated container and view commands", () => {
		assert.equal(legacyCommandTarget("omp.newSession"), "ompDesk.newSession");
		assert.equal(legacyCommandTarget("omp.chooseSessionsLayout.flat"), "ompDesk.chooseSessionsLayout.flat");
		assert.throws(() => legacyCommandTarget("ompDesk.newSession"), TypeError);
		assert.equal(LEGACY_ALIASES.length, LEGACY_COMMAND_IDS.length + 8);
		assert.equal(new Set(LEGACY_ALIASES.map(([oldId]) => oldId)).size, LEGACY_ALIASES.length);
		assert.ok(LEGACY_ALIASES.some(([oldId, target]) => oldId === "workbench.view.extension.omp" && target === "workbench.view.extension.ompDesk"));
		assert.ok(LEGACY_ALIASES.some(([oldId, target]) => oldId === "omp.sessions.focus" && target === "ompDesk.sessions.focus"));
	});

	it("gives only three context keys an old twin", () => {
		assert.equal(legacyContextKey("ompDesk.sessionMode"), "omp.sessionMode");
		assert.equal(legacyContextKey("ompDesk.streaming"), "omp.streaming");
		assert.equal(legacyContextKey("ompDesk.composerPopupOpen"), "omp.composerPopupOpen");
		assert.equal(legacyContextKey("ompDesk.catalogPending"), null);
		assert.equal(legacyContextKey("omp.sessionMode"), null);
	});
});

describe("the aliases", () => {
	it("register once per old id, forward the arguments and the result, and warn once per id with a way to the file", async () => {
		const { port, handlers, executed, warnings, opened, lines } = aliasPort();
		registerLegacyAliases(port);
		assert.equal(handlers.size, LEGACY_ALIASES.length);
		const handler = handlers.get("omp.focusComposer")!;
		assert.equal(await handler({ a: 1 }, 2), "ran ompDesk.focusComposer");
		await handler();
		await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
		assert.deepEqual(executed, [["ompDesk.focusComposer", { a: 1 }, 2], ["ompDesk.focusComposer"]]);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /omp\.focusComposer.*ompDesk\.focusComposer/);
		assert.deepEqual(opened, [1], "the action opens keybindings.json");
		assert.equal(lines.filter(line => line.message.startsWith("legacy command omp.focusComposer ran ompDesk.focusComposer")).length, 2, "every use is logged");
		await handlers.get("omp.goToSession")!();
		assert.equal(warnings.length, 2, "another old id warns on its own");
	});

	it("run the new command whatever becomes of their warning, and never warn before use", async () => {
		const dismissed = aliasPort({ warn: async () => undefined });
		registerLegacyAliases(dismissed.port);
		assert.equal(dismissed.warnings.length, 0);
		await dismissed.handlers.get("omp.newSession")!();
		assert.deepEqual(dismissed.executed, [["ompDesk.newSession"]]);
		assert.deepEqual(dismissed.opened, []);
		const failing = aliasPort({ warn: async () => { throw new Error("no window"); } });
		registerLegacyAliases(failing.port);
		assert.equal(await failing.handlers.get("omp.newSession")!(), "ran ompDesk.newSession");
	});

	it("skip an id another extension contributes, and a failed registration never stops the rest", () => {
		const foreign = new Set(["omp.newSession"]);
		const taken = aliasPort({ foreignCommands: foreign });
		taken.handlers.set("omp.openSession", () => undefined);
		registerLegacyAliases(taken.port);
		assert.equal(taken.handlers.has("omp.newSession"), false);
		assert.equal(taken.handlers.get("omp.openSession")?.toString(), "() => undefined", "an id someone registered first keeps its handler");
		assert.equal(taken.handlers.size, LEGACY_ALIASES.length - 1);
		assert.ok(taken.lines.some(line => line.message.includes("omp.newSession") && line.message.includes("another extension contributes it")));
		assert.ok(taken.lines.some(line => line.level === "warn" && line.message.includes("omp.openSession was not registered") && line.message.includes("already exists")));
	});
});

describe("the other extensions' omp. names", () => {
	const extension = (id: string, contributes: unknown) => ({ id, packageJSON: { contributes } });

	it("collect commands and settings under omp. from every extension but our own, whether configuration is one object or a list", () => {
		const found = foreignOmpNames([
			extension("hmmvot.omp-desk", { commands: [{ command: "omp.newSession" }], configuration: { properties: { "omp.chatColumn": {} } } }),
			extension("other.tool", { commands: [{ command: "omp.run" }, { command: "tool.x" }], configuration: [{ properties: { "omp.executablePath": {} } }, { properties: { "tool.y": {} } }] }),
			extension("plain.ext", {}),
			{ id: "no.manifest" },
		], "HMMVOT.omp-desk");
		assert.deepEqual([...found.commands], ["omp.run"]);
		assert.deepEqual([...found.settings], ["omp.executablePath"]);
		assert.equal(found.any, true);
	});

	it("report nothing for extensions that contribute no omp. name", () => {
		const found = foreignOmpNames([extension("a.b", { commands: [{ command: "ab.run" }], configuration: { properties: { "ab.x": {} } } })], "hmmvot.omp-desk");
		assert.equal(found.any, false);
		assert.equal(found.commands.size + found.settings.size, 0);
	});
});

describe("the rename notice", () => {
	function noticePort(overrides: Partial<RenameNoticePort> = {}) {
		const state = { shown: false, messages: [] as string[], opened: 0, lines: [] as LoggedLine[] };
		const port: RenameNoticePort = {
			priorInstall: async () => true,
			shown: () => state.shown,
			markShown: async () => { state.shown = true; },
			info: async message => { state.messages.push(message); return OPEN_KEYBINDINGS_ACTION; },
			openKeybindingsFile: async () => { state.opened += 1; },
			log: recordingLogger(state.lines),
			...overrides,
		};
		return { port, state };
	}

	it("shows once for a profile that ran an earlier OMP Desk, with an action that opens keybindings.json", async () => {
		const { port, state } = noticePort();
		await announceRename(port);
		await announceRename(port);
		assert.deepEqual(state.messages, [RENAME_NOTICE_TEXT]);
		assert.equal(state.opened, 1);
		assert.equal(state.shown, true);
	});

	it("shows nothing on a fresh install, and never asks again afterwards", async () => {
		let upgraded = false;
		const { port, state } = noticePort({ priorInstall: async () => upgraded });
		await announceRename(port);
		upgraded = true;
		await announceRename(port);
		assert.deepEqual(state.messages, []);
		assert.equal(state.shown, true);
	});

	it("marks the profile before the message appears, so closing the window with it open does not show it again", async () => {
		const order: string[] = [];
		const { port } = noticePort({ markShown: async () => { order.push("mark"); }, info: async () => { order.push("info"); return undefined; } });
		await announceRename(port);
		assert.deepEqual(order, ["mark", "info"]);
	});

	it("does not throw when the marker cannot be written", async () => {
		const { port, state } = noticePort({ markShown: async () => { throw new Error("storage busy"); } });
		await announceRename(port);
		assert.deepEqual(state.messages, []);
		assert.ok(state.lines.some(line => line.level === "warn" && line.message.includes("storage busy")));
	});
});
