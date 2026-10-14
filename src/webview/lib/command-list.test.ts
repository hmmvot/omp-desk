import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatSlashCommand } from "../../chat/model.ts";
import { commandAvailability, commandRows, commandSourceLabel, filterCommandRows, insertCommandIntoDraft, pickPlan, type CommandContext } from "./command-list.ts";

const CATALOGUE: ChatSlashCommand[] = [
	{ name: "zebra", source: "builtin", description: "Last alphabetically" },
	{ name: "compact", source: "builtin", description: "Compact the context", inputHint: "[focus instructions]" },
	{ name: "export", source: "builtin", description: "Export as HTML" },
	{ name: "usage", source: "builtin", description: "Show usage" },
	{ name: "skill:review", source: "skill", description: "Review code", inputHint: "arguments" },
	{ name: "fix", source: "file", description: "Fix a bug" },
	{ name: "deploy", source: "extension", description: "Deploy" },
	{ name: "share", source: "extension", description: "An extension that reuses a builtin's name" },
	{ name: "tree", source: "builtin", description: "Identity-changing: refused in Chat" },
	{ name: "handoff", source: "builtin", description: "Identity-changing: refused in Chat" },
];

const OPEN: CommandContext = { promptBlocked: null, sessionBlocked: null, sendInFlight: false, turnRunning: false, maintenanceRunning: false, rewindBlocked: null };
const rowOf = (name: string) => commandRows(CATALOGUE).find(row => row.name === name)!;

test("GUI-supported commands come first and are marked; each group is alphabetical", () => {
	const rows = commandRows(CATALOGUE);
	const firstPlain = rows.findIndex(row => row.group === "command");
	assert.ok(firstPlain > 0);
	assert.ok(rows.slice(0, firstPlain).every(row => row.gui !== null && row.group === "gui"));
	assert.ok(rows.slice(firstPlain).every(row => row.gui === null && row.group === "command"));
	for (const group of [rows.slice(0, firstPlain), rows.slice(firstPlain)]) {
		assert.deepEqual(group.map(row => row.name), [...group.map(row => row.name)].sort((a, b) => a.localeCompare(b, "en")));
	}
	assert.deepEqual(rows.slice(0, firstPlain).map(row => row.name), ["agents", "clear", "compact", "delete", "export", "extensions", "fresh", "git", "hotkeys", "login", "logout", "models", "new", "rewind", "settings", "setup", "skills"]);
});

test("the marker names the surface a command opens", () => {
	assert.match(rowOf("settings").gui!.ui, /OMP Settings editor/);
	assert.match(rowOf("models").gui!.ui, /Models settings editor/);
	assert.match(rowOf("rewind").gui!.ui, /Rewind picker/);
	assert.match(rowOf("export").gui!.ui, /Save dialog/);
	assert.match(rowOf("compact").gui!.ui, /mode picker/);
	assert.match(rowOf("hotkeys").gui!.ui, /Keyboard Shortcuts/);
	assert.match(rowOf("login").gui!.ui, /Log In to Provider/);
	assert.match(rowOf("logout").gui!.ui, /Log Out of Provider/);
	assert.equal(rowOf("usage").gui, null);
	assert.equal(rowOf("skill:review").gui, null);
});

test("a same-named extension command is not the OMP builtin's GUI, and an advertised name suppresses Desk's stand-in", () => {
	assert.equal(rowOf("share").gui, null, "share from an extension is an ordinary command");
	assert.equal(rowOf("share").source, "Extension");
	const withGit = commandRows([{ name: "git", source: "extension", description: "My git" }]);
	assert.equal(withGit.filter(row => row.name === "git").length, 1);
	assert.equal(withGit.find(row => row.name === "git")!.gui, null);
	assert.equal(commandRows([]).some(row => row.name === "hotkeys" && row.gui !== null), true);
});

test("identity-changing commands Chat refuses are not listed", () => {
	const names = commandRows(CATALOGUE).map(row => row.name);
	assert.equal(names.includes("tree"), false);
	assert.equal(names.includes("handoff"), false);
	assert.equal(names.includes("vibe"), false, "terminal-only commands without a Desk equivalent are not listed");
});

test("source chips say where a command comes from", () => {
	assert.deepEqual(["builtin", "skill", "file", "custom", "mcp_prompt", "extension", "OMP Desk", undefined].map(commandSourceLabel), ["OMP", "Skill", "Prompt", "Prompt", "Prompt", "Extension", "Desk", "OMP"]);
});

test("search ranks by relevance inside each group and never lets a plain command outrank a GUI one", () => {
	const rows = commandRows(CATALOGUE);
	const found = filterCommandRows(rows, "/ex");
	assert.deepEqual(found.map(row => row.name), ["export", "extensions", "clear", "compact", "share"], "name prefixes first, then description matches; GUI rows ahead of plain ones");
	const byDescription = filterCommandRows(rows, "html");
	assert.deepEqual(byDescription.map(row => row.name), ["export"]);
	const fixes = filterCommandRows(rows, "fix");
	assert.deepEqual(fixes.map(row => row.name), ["fix"]);
	assert.equal(filterCommandRows(rows, "").length, rows.length);
	assert.deepEqual(filterCommandRows(rows, "no-such-command"), []);
	const mixed = filterCommandRows(rows, "e");
	const firstPlain = mixed.findIndex(row => row.group === "command");
	assert.ok(mixed.slice(firstPlain).every(row => row.group === "command"), "GUI rows stay ahead of plain ones");
	assert.deepEqual(filterCommandRows(commandRows([{ name: "plan-x" }, { name: "xplan" }, { name: "x", aliases: ["plan"] }]), "plan").map(row => row.name), ["plan-x", "x", "xplan"], "a name prefix beats an alias prefix, which beats a name substring");
});

test("a pick runs the GUI action, completes a command that takes arguments, or sends one that takes none", () => {
	assert.deepEqual(pickPlan(rowOf("settings")), { kind: "send", text: "/settings" });
	assert.deepEqual(pickPlan(rowOf("rewind")), { kind: "rewind" });
	assert.deepEqual(pickPlan(rowOf("export")), { kind: "action", command: "export-html" });
	assert.deepEqual(pickPlan(rowOf("compact")), { kind: "action", command: "compact" }, "a GUI command runs its action even though it takes arguments");
	assert.deepEqual(pickPlan(rowOf("hotkeys")), { kind: "action", command: "keyboard-shortcuts" });
	assert.deepEqual(pickPlan(rowOf("logout")), { kind: "action", command: "provider-logout" });
	assert.deepEqual(pickPlan(rowOf("skill:review")), { kind: "insert", name: "skill:review" });
	assert.deepEqual(pickPlan(rowOf("usage")), { kind: "send", text: "/usage" });
	assert.deepEqual(pickPlan(rowOf("fix")), { kind: "send", text: "/fix" });
});

test("inserting a command keeps what the draft already says", () => {
	assert.deepEqual(insertCommandIntoDraft("", "skill:review"), { text: "/skill:review ", caret: 14 });
	assert.deepEqual(insertCommandIntoDraft("/ski", "skill:review"), { text: "/skill:review ", caret: 14 });
	assert.deepEqual(insertCommandIntoDraft("/old existing args", "skill:review"), { text: "/skill:review existing args", caret: 14 });
	assert.deepEqual(insertCommandIntoDraft("look at this", "skill:review"), { text: "/skill:review look at this", caret: 14 });
	assert.deepEqual(insertCommandIntoDraft("  look [Image #1]", "fix"), { text: "/fix look [Image #1]", caret: 5 });
});

test("availability: a GUI command follows its own requirements, a plain command runs only between turns", () => {
	const running = { ...OPEN, turnRunning: true };
	const stopped = { ...OPEN, promptBlocked: "This session is not running.", sessionBlocked: "This session is not running." };
	assert.equal(commandAvailability(rowOf("usage"), OPEN), null);
	assert.match(commandAvailability(rowOf("usage"), running)!, /only between turns/);
	assert.equal(commandAvailability(rowOf("skill:review"), running), null, "completing the draft is allowed while a turn runs");
	assert.equal(commandAvailability(rowOf("skill:review"), stopped), "This session is not running.");
	assert.equal(commandAvailability(rowOf("settings"), running), null);
	assert.match(commandAvailability(rowOf("new"), running)!, /Stop it first/);
	assert.match(commandAvailability(rowOf("clear"), running)!, /abort it before resetting/);
	assert.match(commandAvailability(rowOf("fresh"), running)!, /\/fresh/);
	assert.equal(commandAvailability(rowOf("compact"), running), null, "compact interrupts a running turn");
	assert.equal(commandAvailability(rowOf("compact"), { ...OPEN, maintenanceRunning: true }), "Context maintenance is already running.");
	assert.equal(commandAvailability(rowOf("export"), stopped), "This session is not running.");
	assert.equal(commandAvailability(rowOf("hotkeys"), stopped), null, "a Desk view needs no live session");
	assert.equal(commandAvailability(rowOf("login"), stopped), null);
	assert.equal(commandAvailability(rowOf("rewind"), { ...OPEN, rewindBlocked: "busy" }), "busy");
	assert.equal(commandAvailability(rowOf("usage"), { ...OPEN, sendInFlight: true }), "Waiting for OMP to confirm the previous message.");
});
