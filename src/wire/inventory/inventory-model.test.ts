import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appliesTo, mcpServerOfTool, originClass, projectView, toggleMessage } from "./inventory-model.ts";
import type { InventoryRow, InventorySnapshot, SessionEvidence, ViewKind, ViewModel } from "./inventory-model.ts";

function row(overrides: Partial<InventoryRow> & Pick<InventoryRow, "kind" | "name">): InventoryRow {
	return { description: null, path: `C:/x/${overrides.name}`, provider: "native", providerName: "OMP", level: "user", state: "active", shadowed: false, shadowedBy: null, disabledReason: null,
		detail: null, toolPrefix: null, runtimeName: null, sources: [], toggle: { mechanism: "disabledExtensions", refusal: null }, ...overrides };
}
function snapshot(rows: InventoryRow[], extra: Partial<InventorySnapshot> = {}): InventorySnapshot {
	return { rows, cwd: "C:/p", profile: "default", projectOverridesDisabledExtensions: false, incomplete: [], incompleteReasons: [], disabledProviders: [], ...extra };
}
function view(kind: ViewKind, inventory: InventorySnapshot | { unavailable: string }, evidence: SessionEvidence | null, scope: "session" | "global" = "session"): ViewModel {
	return projectView({ view: kind, scope, inventory, evidence, profile: "default" });
}
const running = (overrides: Partial<SessionEvidence> = {}): SessionEvidence => ({ title: "Work", running: true, commands: [], tools: [], ...overrides });
const labels = (model: ViewModel): string[] => model.groups.flatMap(group => group.items.map(item => item.label));
const itemOf = (model: ViewModel, label: string) => model.groups.flatMap(group => group.items).find(item => item.label === label)!;
/** The folded "About this list" group: standing facts, never shown above the tree. */
const listed = (model: ViewModel): string[] => model.groups.filter(group => group.id !== "about").map(group => group.label);
const aboutOf = (model: ViewModel): string[] => model.groups.find(group => group.id === "about")?.items.map(item => item.tooltip) ?? [];
describe("origin classes", () => {
	it("maps provider and level to one display class", () => {
		assert.equal(originClass({ provider: "omp-managed", level: "user" }), "managed");
		assert.equal(originClass({ provider: "native", level: "project" }), "project");
		assert.equal(originClass({ provider: "agents", level: "project" }), "project");
		assert.equal(originClass({ provider: "claude-plugins", level: "project" }), "other");
		assert.equal(originClass({ provider: "native", level: "user" }), "global");
		for (const provider of ["agents", "claude", "codex", "omp-plugins", "custom"]) assert.equal(originClass({ provider, level: "user" }), "other");
	});
	it("groups rows by origin in a fixed order with counts", () => {
		const model = view("skills", snapshot([
			row({ kind: "skill", name: "z-other", provider: "agents" }), row({ kind: "skill", name: "proj", level: "project" }),
			row({ kind: "skill", name: "mine" }), row({ kind: "skill", name: "man", provider: "omp-managed" }),
		]), null, "global");
		assert.deepEqual(model.groups.map(group => group.label), ["Global (1)", "Project (1)", "Managed (1)", "Other ecosystems (1)"]);
	});
});

describe("skills projection", () => {
	const skills = [row({ kind: "skill", name: "review", runtimeName: "review" }), row({ kind: "skill", name: "off", state: "disabled", runtimeName: null }), row({ kind: "skill", name: "settings-off", runtimeName: null })];
	it("shows a checkbox that follows OMP's state and opens the source", () => {
		const model = view("skills", snapshot(skills), null, "global");
		assert.equal(itemOf(model, "review").checked, true);
		assert.equal(itemOf(model, "off").checked, false);
		assert.equal(itemOf(model, "review").openPath, "C:/x/review");
		assert.match(itemOf(model, "review").tooltip, /global OMP configuration/);
	});
	it("says 'not reported' only when the session reported skill commands and omits the claim otherwise", () => {
		const reported = view("skills", snapshot(skills), running({ commands: [{ name: "skill:other", source: "skill" }] }));
		assert.match(itemOf(reported, "review").description, /not reported by this session/);
		const withCommand = view("skills", snapshot(skills), running({ commands: [{ name: "skill:review", source: "skill" }] }));
		assert.doesNotMatch(itemOf(withCommand, "review").description, /not reported/);
		const none = view("skills", snapshot(skills), running({ commands: [{ name: "help", source: "builtin" }] }));
		assert.doesNotMatch(itemOf(none, "review").description, /not reported/);
		assert.equal(none.notice, null, "a standing fact is not a top line");
		assert.match(aboutOf(none).join(" "), /unknown/);
		const terminal = view("skills", snapshot(skills), running({ commands: null }));
		assert.doesNotMatch(itemOf(terminal, "review").description, /not reported/);
	});
	it("uses the runtime name, marks settings exclusion and lists commands no row explains", () => {
		const model = view("skills", snapshot([row({ kind: "skill", name: "dup", runtimeName: "plugin:dup" })]), running({ commands: [{ name: "skill:plugin:dup", source: "skill" }, { name: "skill:stray", source: "skill", description: "[x](command:bad)" }] }));
		assert.doesNotMatch(itemOf(model, "dup").description, /not reported/);
		assert.ok(model.groups.some(group => group.id === "session-other" && group.items[0]!.label === "stray"));
		assert.equal(model.groups.find(group => group.id === "session-other")!.items[0]!.tooltip.includes("command:bad"), true, "plain text only");
		const excluded = view("skills", snapshot(skills), null, "global");
		assert.match(itemOf(excluded, "settings-off").description, /excluded by OMP's skill settings/);
	});
	it("never offers a switch on a shadowed or refused row", () => {
		const model = view("skills", snapshot([row({ kind: "skill", name: "shadow", shadowed: true, state: "disabled" }), row({ kind: "skill", name: "locked", toggle: { mechanism: null, refusal: "its provider is disabled in OMP" } })]), null, "global");
		assert.equal(itemOf(model, "shadow").checked, null);
		assert.equal(itemOf(model, "shadow").row, null);
		assert.equal(itemOf(model, "locked").checked, null);
		assert.match(itemOf(model, "locked").tooltip, /provider is disabled/);
	});
});

describe("tools projection", () => {
	const rows = [
		row({ kind: "builtin-tool", name: "grep", provider: "builtin", level: "builtin", toggle: { mechanism: "setting", refusal: null } }),
		row({ kind: "builtin-tool", name: "read", provider: "builtin", level: "builtin", toggle: { mechanism: null, refusal: "OMP has no on/off switch for this tool" } }),
		row({ kind: "mcp", name: "foo", toolPrefix: "mcp__foo_" }), row({ kind: "mcp", name: "foo_bar", toolPrefix: "mcp__foo_bar_" }), row({ kind: "mcp", name: "solo", toolPrefix: "mcp__solo_" }),
	];
	it("groups session tools into built-in, name-matched MCP tools and other; ambiguity stays in other", () => {
		const tools = [{ name: "grep", description: "Search", active: true }, { name: "mcp__solo_ping", description: "p", active: true }, { name: "mcp__foo_bar_x", description: "x", active: null },
			{ name: "vscode_debug_start", description: "d", active: true }];
		const model = view("tools", snapshot(rows), running({ tools }));
		assert.deepEqual(model.groups.map(group => group.id), ["builtin", "mcp", "other"]);
		assert.deepEqual(model.groups.find(group => group.id === "mcp")!.items.map(item => item.label), ["mcp__solo_ping"]);
		assert.deepEqual(model.groups.find(group => group.id === "other")!.items.map(item => item.label).sort(), ["mcp__foo_bar_x", "vscode_debug_start"]);
		assert.equal(mcpServerOfTool("mcp__foo_bar_x", rows.filter(candidate => candidate.kind === "mcp")), null);
		assert.equal(mcpServerOfTool("mcp__solo_ping", rows.filter(candidate => candidate.kind === "mcp"))?.name, "solo");
	});
	it("marks absent and inactive built-ins only when the session list was read, and switches only where OMP has a switch", () => {
		const read = view("tools", snapshot(rows), running({ tools: [{ name: "read", description: "r", active: false }] }));
		assert.match(itemOf(read, "grep").description, /not in this session/);
		assert.match(itemOf(read, "read").description, /inactive in this session/);
		assert.equal(itemOf(read, "grep").checked, true);
		assert.equal(itemOf(read, "read").checked, null);
		const unread = view("tools", snapshot(rows), running({ tools: null }));
		assert.doesNotMatch(itemOf(unread, "grep").description, /not in this session/);
		assert.equal(unread.notice, null);
		assert.match(aboutOf(unread).join(" "), /could not be read/);
	});
	it("shows configuration for a stopped session and says so", () => {
		const model = view("tools", snapshot(rows), { title: "Old", running: false, commands: null, tools: null });
		assert.match(model.notice ?? "", /not running/);
		assert.ok(model.notice!.length < 80, "one short line");
		assert.equal(model.description, "Session: Old");
	});
});

describe("MCP projection", () => {
	it("never claims a connection: counts name-matched tools and says no status exists", () => {
		const servers = [row({ kind: "mcp", name: "solo", toolPrefix: "mcp__solo_", detail: "stdio · srv.exe", toggle: { mechanism: "mcp", refusal: null } }), row({ kind: "mcp", name: "idle", toolPrefix: "mcp__idle_", toggle: { mechanism: "mcp", refusal: null } })];
		const model = view("mcp", snapshot(servers), running({ tools: [{ name: "mcp__solo_a", description: "", active: true }, { name: "mcp__solo_b", description: "", active: true }] }));
		assert.match(itemOf(model, "solo").description, /^2 tools/);
		assert.match(itemOf(model, "idle").description, /^no tools/);
		assert.doesNotMatch(JSON.stringify(model), /connected/);
		assert.equal(model.notice, null);
		assert.match(aboutOf(model).join(" "), /no MCP connection status/);
		assert.match(itemOf(model, "solo").tooltip, /name prefix.*not a connection status/);
		const global = view("mcp", snapshot(servers), null, "global");
		assert.doesNotMatch(itemOf(global, "solo").description, /tool/);
	});
});

describe("MCP server named by several files", () => {
	const unity = row({ kind: "mcp", name: "unity", path: "D:/omp-vscode/.mcp.json", provider: "mcp-json", providerName: "MCP Config", level: "project", state: "disabled", disabledReason: "entry", detail: "stdio · uvx", toolPrefix: "mcp__unity_",
		toggle: { mechanism: null, refusal: ".omp/mcp.json sets enabled: false for it without defining it" },
		sources: [{ path: "D:/omp-vscode/.omp/mcp.json", providerName: "OMP", level: "project", role: "disables" }, { path: "D:/omp-vscode/.mcp.json", providerName: "MCP Config", level: "project", role: "defines" }] });
	it("shows one row that says which file disables it, lists the contributing files, and offers no switch", () => {
		const model = view("mcp", snapshot([unity, row({ kind: "mcp", name: "symbols", detail: "stdio · node", toggle: { mechanism: "mcp", refusal: null } })]), null, "global");
		const item = itemOf(model, "unity");
		assert.equal(model.groups.flatMap(group => group.items).filter(candidate => candidate.label === "unity").length, 1);
		assert.equal(item.description, "disabled by mcp.json · stdio · uvx");
		assert.equal(item.checked, null);
		assert.equal(item.openPath, "D:/omp-vscode/.mcp.json");
		assert.match(item.tooltip, /State: disabled by the entry in OMP D:\/omp-vscode\/\.omp\/mcp\.json, which only sets enabled: false/);
		assert.match(item.tooltip, /- D:\/omp-vscode\/\.omp\/mcp\.json \(OMP, project\): disables it/);
		assert.match(item.tooltip, /- D:\/omp-vscode\/\.mcp\.json \(MCP Config, project\): defines it/);
		assert.match(item.tooltip, /Cannot be switched here: \.omp\/mcp\.json sets enabled: false/);
		assert.doesNotMatch(item.description, /shadowed/);
	});
	it("says an owner entry without a command or url leaves nothing loaded", () => {
		const model = view("mcp", snapshot([row({ kind: "mcp", name: "x", state: "disabled", disabledReason: "invalid-entry", detail: "no command or url", sources: [{ path: "D:/p/.omp/mcp.json", providerName: "OMP", level: "project", role: "incomplete" }] })]), null, "global");
		assert.equal(itemOf(model, "x").description, "no definition · no command or url");
		assert.match(itemOf(model, "x").tooltip, /OMP loads nothing for it: the entry in OMP D:\/p\/\.omp\/mcp\.json has no command or url/);
	});
	it("keeps the ordinary notes for a server defined once", () => {
		const item = itemOf(view("mcp", snapshot([row({ kind: "mcp", name: "solo", detail: "stdio · srv", sources: [{ path: "C:/x/solo", providerName: "OMP", level: "user", role: "defines" }] })]), null, "global"), "solo");
		assert.doesNotMatch(item.tooltip, /Configured in/);
	});
});

describe("MCP shadow wording", () => {
	it("names the entry that shadows a lower full definition of the same name, in the tooltip of the one row", () => {
		const owner = row({ kind: "mcp", name: "s", path: "C:/home/.omp/agent/mcp.json", detail: "stdio · a", toggle: { mechanism: "mcp", refusal: null },
			sources: [{ path: "C:/home/.omp/agent/mcp.json", providerName: "OMP", level: "user", role: "defines" }, { path: "D:/p/.mcp.json", providerName: "MCP Config", level: "project", role: "ignored" }] });
		const item = itemOf(view("mcp", snapshot([owner]), null, "global"), "s");
		assert.match(item.tooltip, /- D:\/p\/\.mcp\.json \(MCP Config, project\): shadowed by C:\/home\/\.omp\/agent\/mcp\.json/);
		assert.equal(item.checked, true, "the effective row keeps its switch");
		assert.doesNotMatch(item.description, /shadowed/);
	});
	it("names the server OMP keeps instead of an alias with the same connection, without contradicting itself", () => {
		const alias = row({ kind: "mcp", name: "devtools-2", state: "shadowed", shadowed: true, shadowedBy: "devtools", disabledReason: "shadowed", detail: "http · 127.0.0.1:3000",
			toggle: { mechanism: null, refusal: "OMP keeps the server devtools, which has the same command or url, so there is nothing to switch for this one" } });
		const item = itemOf(view("mcp", snapshot([alias]), null, "global"), "devtools-2");
		assert.match(item.description, /^shadowed by devtools · /);
		assert.match(item.tooltip, /State: OMP's discovery keeps the server devtools and drops this one: both have the same command or url/);
		assert.doesNotMatch(item.tooltip, /same name/, "no contradictory same-name wording");
		assert.equal(item.checked, null);
	});
});

describe("extensions projection", () => {
	it("lists modules by origin and plugins separately", () => {
		const model = view("extensions", snapshot([row({ kind: "extension-module", name: "mod" }), row({ kind: "plugin", name: "pkg", provider: "omp-plugins", toggle: { mechanism: "plugin", refusal: null }, detail: "v1.0.0" })]), null, "global");
		assert.deepEqual(listed(model), ["Modules · Global (1)", "Plugins (1)"]);
		assert.equal(itemOf(model, "pkg").checked, true);
	});
});

describe("whole-view rules", () => {
	it("falls back to what the session reports, without switches, when OMP's inventory is unavailable", () => {
		const evidence = running({ commands: [{ name: "skill:one", source: "skill" }], tools: [{ name: "grep", description: "g", active: true }] });
		const skills = view("skills", { unavailable: "No Bun." }, evidence);
		assert.equal(skills.groups[0]!.items[0]!.checked, null);
		assert.equal(skills.notice, "No Bun.");
		assert.equal(view("mcp", { unavailable: "No Bun." }, evidence).message, "No Bun.");
		assert.equal(view("skills", { unavailable: "No Bun." }, evidence, "global").message, "No Bun.");
	});
	it("disables switches and warns for a category OMP reported as incomplete", () => {
		const model = view("skills", snapshot([row({ kind: "skill", name: "a" }), row({ kind: "mcp", name: "m", toggle: { mechanism: "mcp", refusal: null } })], { incomplete: ["skills"] }), null, "global");
		assert.equal(itemOf(model, "a").checked, null);
		assert.match(model.notice ?? "", /may be incomplete/);
		const mcp = view("mcp", snapshot([row({ kind: "mcp", name: "m", toggle: { mechanism: "mcp", refusal: null } })], { incomplete: ["skills"] }), null, "global");
		assert.equal(itemOf(mcp, "m").checked, true, "another category keeps its switches");
	});
	it("explains a project that replaces the global disabled list only in Session scope", () => {
		const inventory = snapshot([row({ kind: "skill", name: "a", toggle: { mechanism: null, refusal: "this project's config replaces the global disabledExtensions list" } })], { projectOverridesDisabledExtensions: true });
		assert.match(view("skills", inventory, running()).notice ?? "", /replaces the global list/);
		assert.equal(view("skills", inventory, null, "global").notice, null);
	});
	it("shows an empty-state message rather than an empty tree", () => {
		assert.equal(view("mcp", snapshot([]), null, "global").message, "No MCP servers configured.");
	});
	it("states the scope and a named profile in the description", () => {
		assert.equal(projectView({ view: "skills", scope: "global", inventory: snapshot([row({ kind: "skill", name: "a" })]), evidence: null, profile: "work" }).description, "Global (profile work)");
	});
});

describe("incomplete banner", () => {
	it("names the source and the reason OMP gave, only for the view they belong to", () => {
		const reasons = [{ view: "mcp" as const, reason: "[MCP Config] Failed to parse JSON in D:/p/.mcp.json" }, { view: "skills" as const, reason: "OMP's skill loader failed: boom" }];
		const mcp = view("mcp", snapshot([row({ kind: "mcp", name: "m", toggle: { mechanism: "mcp", refusal: null } })], { incomplete: ["mcp", "skills"], incompleteReasons: reasons }), null, "global");
		assert.equal(mcp.notice, "List may be incomplete: [MCP Config] Failed to parse JSON in D:/p/.mcp.json.");
		const skills = view("skills", snapshot([row({ kind: "skill", name: "a" })], { incomplete: ["mcp", "skills"], incompleteReasons: reasons }), null, "global");
		assert.match(skills.notice ?? "", /skill loader failed: boom/);
		assert.doesNotMatch(skills.notice ?? "", /\.mcp\.json/);
	});
	it("shows the first reasons and counts the rest; with none named it keeps the bare fact", () => {
		const many = [1, 2, 3, 4].map(index => ({ view: "mcp" as const, reason: `source ${index} failed` }));
		const notice = view("mcp", snapshot([row({ kind: "mcp", name: "m" })], { incomplete: ["mcp"], incompleteReasons: many }), null, "global").notice!;
		assert.equal(notice, "List may be incomplete: source 1 failed; source 2 failed (and 2 more, see the Desk log).");
		assert.equal(view("mcp", snapshot([row({ kind: "mcp", name: "m" })], { incomplete: ["mcp"] }), null, "global").notice, "List may be incomplete: some sources failed to load.");
	});
});

describe("review follow-ups", () => {
	it("keeps the incomplete warning visible when the list is empty", () => {
		const model = view("skills", snapshot([], { incomplete: ["skills"] }), null, "global");
		assert.match(model.message ?? "", /may be incomplete/);
	});
	it("never presents a project-scoped marketplace plugin as project or global", () => {
		const rows = [row({ kind: "skill", name: "mp", provider: "claude-plugins", level: "project" })];
		for (const scope of ["global", "session"] as const) assert.deepEqual(listed(view("skills", snapshot(rows), scope === "session" ? running() : null, scope)), ["Other ecosystems (1)"]);
	});
	it("names providers OMP has disabled", () => {
		const codex = view("skills", snapshot([row({ kind: "skill", name: "a" })], { disabledProviders: ["codex"] }), null, "global");
		assert.equal(codex.notice, null);
		assert.match(aboutOf(codex).join(" "), /disabled in OMP's settings \(codex\)/);
		assert.equal(codex.groups.at(-1)!.collapsed, true, "About is the last, folded group");
	});
	it("does not claim a built-in is absent from a session whose registry was not authenticated", () => {
		const builtin = [row({ kind: "builtin-tool", name: "grep", provider: "builtin", level: "builtin", toggle: { mechanism: "setting", refusal: null } })];
		const model = view("tools", snapshot(builtin), running({ tools: [{ name: "x", description: "", active: null }] }));
		assert.doesNotMatch(itemOf(model, "grep").description, /not (in|reported)/, "no per-row claim without authenticated evidence");
		assert.match(aboutOf(model).join(" "), /not marked as absent/);
	});
});

describe("top line", () => {
	const healthy = [row({ kind: "skill", name: "a" }), row({ kind: "mcp", name: "m", toggle: { mechanism: "mcp", refusal: null } }), row({ kind: "plugin", name: "p" })];
	it("is empty for a healthy list in every view and scope, however many standing facts exist", () => {
		for (const kind of ["skills", "tools", "mcp", "extensions"] as const) {
			assert.equal(view(kind, snapshot(healthy, { disabledProviders: ["codex"] }), running({ commands: null, tools: null }), "session").notice, null, kind);
			assert.equal(view(kind, snapshot(healthy, { disabledProviders: ["codex"] }), null, "global").notice, null, kind);
		}
	});
	it("is one short line, and only for an incomplete list, a project override, a stopped session or an unreadable inventory", () => {
		const incomplete = view("mcp", snapshot(healthy, { incomplete: ["mcp"] }), null, "global").notice!;
		assert.match(incomplete, /incomplete/);
		for (const text of [incomplete, view("skills", snapshot(healthy), { title: "T", running: false, commands: null, tools: null }).notice!,
			view("skills", snapshot(healthy, { projectOverridesDisabledExtensions: true }), running()).notice!]) assert.ok(text.length < 90, text);
		assert.equal(view("skills", { unavailable: "No Bun." }, running({ commands: [{ name: "skill:x", source: "skill" }] })).notice, "No Bun.");
	});
});

describe("switch outcome wording", () => {
	it("tells which kinds a running session may apply live and which need a restart", () => {
		assert.equal(appliesTo({ kind: "skill" }), "live");
		assert.equal(appliesTo({ kind: "builtin-tool" }), "live");
		assert.equal(appliesTo({ kind: "mcp" }), "next-session");
		assert.equal(appliesTo({ kind: "plugin" }), "next-session");
		assert.match(toggleMessage({ kind: "skill", name: "a" }, false, true, true), /may apply it live/);
		assert.match(toggleMessage({ kind: "extension-module", name: "e" }, true, true, true), /never loaded needs a restart/);
		assert.match(toggleMessage({ kind: "mcp", name: "m" }, false, true, true), /Restart a running session/);
		assert.match(toggleMessage({ kind: "mcp", name: "m" }, false, true, false), /new sessions/);
		assert.match(toggleMessage({ kind: "skill", name: "a" }, false, false, true), /already disabled/);
		assert.doesNotMatch(toggleMessage({ kind: "skill", name: "a" }, false, true, true), /apply it now/);
	});
});
