/**
 * Which typed `/name` commands Chat answers instead of sending: the installed registry minus what the session
 * advertises. Runner: `node --test src/host/slash-registry.test.ts`.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSlashRegistry, readSlashRegistry, tuiCommandGuidance, tuiOnlyCommand, type BuiltinSlashEntry } from "./slash-registry.ts";

const REGISTRY: BuiltinSlashEntry[] = [
	{ name: "hotkeys", aliases: [], handled: false },
	{ name: "setup", aliases: ["providers"], handled: false },
	{ name: "compact", aliases: [], handled: true },
	{ name: "plan", aliases: [], handled: false },
];

describe("terminal-only slash commands", () => {
	it("names an unhandled builtin, by name or alias, and only as the leading token", () => {
		assert.equal(tuiOnlyCommand("/hotkeys", REGISTRY, []), "hotkeys");
		assert.equal(tuiOnlyCommand("  /HotKeys please", REGISTRY, []), "hotkeys");
		assert.equal(tuiOnlyCommand("/providers", REGISTRY, []), "setup", "an alias resolves to its builtin");
		assert.equal(tuiOnlyCommand("explain /hotkeys", REGISTRY, []), null, "a command mentioned in prose is text");
		assert.equal(tuiOnlyCommand("/hotkeys-extra", REGISTRY, []), null);
	});

	it("never refuses a handled builtin, an advertised command, or anything while the registry is unknown", () => {
		assert.equal(tuiOnlyCommand("/compact focus", REGISTRY, []), null, "rpc mode runs a handled builtin");
		assert.equal(tuiOnlyCommand("/plan", REGISTRY, [{ name: "plan", source: "extension" } as never]), null, "an extension command that reuses the name passes");
		assert.equal(tuiOnlyCommand("/setup", REGISTRY, [{ name: "configure", aliases: ["setup"] } as never]), null);
		assert.equal(tuiOnlyCommand("/hotkeys", null, []), null);
	});

	it("maps the commands Desk has an equivalent for and explains every other one", () => {
		assert.deepEqual(tuiCommandGuidance("hotkeys"), { command: "hotkeys", action: "keyboard-shortcuts", line: "/hotkeys is a terminal command; opened the OMP keyboard shortcuts instead." });
		assert.equal(tuiCommandGuidance("git").action, "source-control");
		assert.equal(tuiCommandGuidance("login").action, "provider-login");
		assert.equal(tuiCommandGuidance("copy").action, undefined);
		assert.match(tuiCommandGuidance("vibe").line, /^\/vibe was not sent: it works only in OMP's terminal UI/);
	});

	it("accepts only the helper's well-formed answer", () => {
		assert.deepEqual(parseSlashRegistry({ ok: true, commands: [{ name: "plan", aliases: ["p", "bad name", 7], handled: false }, { name: "", handled: true }, { name: "x" }] }), [{ name: "plan", aliases: ["p"], handled: false }]);
		assert.equal(parseSlashRegistry({ ok: false }), null);
		assert.equal(parseSlashRegistry({ ok: true, commands: [] }), null);
		assert.equal(parseSlashRegistry("nope"), null);
	});
});

const packageRoot = process.env.OMP_SLASH_TEST_PACKAGE_ROOT ?? path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
const bunPath = process.env.OMP_SLASH_TEST_BUN ?? path.join(os.homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
const helperPath = fileURLToPath(new URL("../../media/slash-registry.mjs", import.meta.url));

describe("installed OMP registry", () => {
	it("reads the installed builtins: handled ones run in rpc mode, terminal-only ones are refused", { skip: !existsSync(packageRoot) || !existsSync(bunPath), timeout: 60_000 }, async () => {
		const registry = await readSlashRegistry({ bunPath, helperPath, packageRoot, cwd: os.tmpdir() });
		assert.ok(registry !== null && registry.length > 10);
		assert.equal(registry.find(entry => entry.name === "compact")?.handled, true);
		assert.equal(tuiOnlyCommand("/hotkeys", registry, []), "hotkeys");
		assert.equal(tuiOnlyCommand("/retry", registry, []), null);
	});

	it("answers null for a package root that holds no registry", async () => {
		assert.equal(await readSlashRegistry({ bunPath: existsSync(bunPath) ? bunPath : process.execPath, helperPath, packageRoot: os.tmpdir(), cwd: os.tmpdir() }), null);
	});
});
