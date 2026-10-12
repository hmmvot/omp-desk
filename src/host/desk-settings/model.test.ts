import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	buildView,
	checkValue,
	chooseTarget,
	groupViews,
	humanize,
	matchesQuery,
	parseInput,
	projectConfiguration,
	resetTargets,
	sourceOf,
} from "./model.ts";
import type { SettingDescriptor } from "./model.ts";

const SECTION = {
	title: "OMP Desk",
	properties: {
		"omp.flag": { type: "boolean", default: true, description: "A **toggle** with `code` and [a link](command:x)." },
		"omp.mode": {
			type: "string", enum: ["a", "b"], enumDescriptions: ["Alpha", "Beta"], default: "a", scope: "application", description: "Mode.",
		},
		"omp.limit": { type: "integer", minimum: 1, maximum: 10, default: 3, description: "Limit." },
		"omp.name": { type: "string", minLength: 2, pattern: "^[a-z]+$", patternErrorMessage: "Lowercase letters only.", description: "Name." },
		"omp.ratio": { type: "number", exclusiveMinimum: 0, multipleOf: 0.5, description: "Ratio." },
		"omp.list": { type: "array", items: { type: "string" }, default: [], description: "A list." },
		"omp.union": { type: ["string", "null"], description: "A union." },
		"omp.group.inner": { type: "boolean", scope: "machine", description: "Inner." },
		"omp.hidden": { type: "boolean", included: false },
	},
};

const byKey = (descriptors: readonly SettingDescriptor[], key: string): SettingDescriptor => {
	const found = descriptors.find(descriptor => descriptor.key === key);
	assert.ok(found, key);
	return found;
};

test("every contributed property becomes a control matching its schema, with no list kept elsewhere", () => {
	const descriptors = projectConfiguration(SECTION);
	assert.deepEqual(descriptors.map(descriptor => descriptor.key), ["omp.flag", "omp.mode", "omp.limit", "omp.name", "omp.ratio", "omp.list", "omp.union", "omp.group.inner"],
		"hidden (included: false) properties are skipped, the rest keep declaration order");
	assert.deepEqual(byKey(descriptors, "omp.flag").control, { kind: "boolean" });
	assert.deepEqual(byKey(descriptors, "omp.mode").control, {
		kind: "enum", options: [{ value: "a", label: "a", description: "Alpha" }, { value: "b", label: "b", description: "Beta" }],
	});
	assert.deepEqual(byKey(descriptors, "omp.limit").control, { kind: "number", integer: true, minimum: 1, maximum: 10 });
	assert.deepEqual(byKey(descriptors, "omp.ratio").control, { kind: "number", integer: false, exclusiveMinimum: 0, multipleOf: 0.5 });
	assert.deepEqual(byKey(descriptors, "omp.name").control, {
		kind: "string", multiline: false, minLength: 2, pattern: "^[a-z]+$", patternErrorMessage: "Lowercase letters only.",
	});
	assert.deepEqual(byKey(descriptors, "omp.list").control, { kind: "json" }, "arrays are edited in settings.json");
	assert.deepEqual(byKey(descriptors, "omp.union").control, { kind: "json" }, "a type union has no single faithful control");
});

test("labels, groups and descriptions follow Desk's own naming rules", () => {
	assert.equal(humanize("toolCallDetail"), "Tool Call Detail");
	assert.equal(humanize("MCPServers"), "MCP Servers");
	const descriptors = projectConfiguration(SECTION);
	assert.equal(byKey(descriptors, "omp.flag").label, "Flag");
	assert.equal(byKey(descriptors, "omp.group.inner").label, "Group: Inner");
	assert.equal(byKey(descriptors, "omp.flag").groupTitle, "General", "a single section needs no section heading");
	assert.equal(byKey(descriptors, "omp.group.inner").groupTitle, "Group");
	assert.equal(byKey(descriptors, "omp.flag").description, "A **toggle** with `code` and a link.", "links are reduced to their text");
	const two = projectConfiguration([
		{ title: "Later", order: 5, properties: { "x.b": { type: "boolean" } } },
		{ title: "First", order: 1, properties: { "x.sub.a": { type: "boolean" }, "x.c": { type: "boolean", order: 1 }, "x.d": { type: "boolean", order: 0 } } },
	]);
	assert.deepEqual(two.map(descriptor => descriptor.key), ["x.d", "x.c", "x.sub.a", "x.b"], "sections and properties are ordered by `order`");
	assert.deepEqual(two.map(descriptor => descriptor.groupTitle), ["First", "First", "First · Sub", "Later"], "several sections name their group");
	assert.deepEqual(projectConfiguration(undefined), []);
	assert.deepEqual(projectConfiguration({ title: "Broken", properties: "no" }), []);
});

test("typed values are validated against the schema as VS Code does", () => {
	const limit = byKey(projectConfiguration(SECTION), "omp.limit").control;
	assert.deepEqual(parseInput(limit, " 4 "), { ok: true, value: 4 });
	assert.equal(parseInput(limit, "").ok, false);
	assert.equal(parseInput(limit, "abc").ok, false);
	assert.equal(parseInput(limit, "0x10").ok, false, "only decimal notation is a number");
	assert.deepEqual(parseInput(limit, "2.5"), { ok: false, message: "The value must be a whole number." });
	assert.deepEqual(parseInput(limit, "11"), { ok: false, message: "The value must be at most 10." });
	assert.deepEqual(parseInput(limit, "0"), { ok: false, message: "The value must be at least 1." });
	const ratio = byKey(projectConfiguration(SECTION), "omp.ratio").control;
	assert.deepEqual(parseInput(ratio, "1.5"), { ok: true, value: 1.5 });
	assert.equal(parseInput(ratio, "0").ok, false, "exclusive minimum");
	assert.equal(parseInput(ratio, "1.2").ok, false, "multipleOf");
	const name = byKey(projectConfiguration(SECTION), "omp.name").control;
	assert.deepEqual(parseInput(name, "ab"), { ok: true, value: "ab" });
	assert.deepEqual(parseInput(name, "a"), { ok: false, message: "Enter at least 2 characters." });
	assert.deepEqual(parseInput(name, "AB"), { ok: false, message: "Lowercase letters only." });
	// What the host receives is checked again, whatever the page claimed.
	const mode = byKey(projectConfiguration(SECTION), "omp.mode").control;
	assert.equal(checkValue(mode, "c").ok, false);
	assert.equal(checkValue(mode, "b").ok, true);
	assert.equal(checkValue({ kind: "boolean" }, "true").ok, false);
	assert.equal(checkValue(limit, Number.NaN).ok, false);
	assert.equal(checkValue(limit, "3").ok, false);
	assert.equal(checkValue({ kind: "json" }, [1]).ok, false);
});

const WORKSPACE = { available: true, name: "w" };
const NO_WORKSPACE = { available: false, name: null };

test("a setting's scope decides which layers it reads and may be written to", () => {
	const descriptors = projectConfiguration(SECTION);
	const windowScoped = byKey(descriptors, "omp.flag");
	const appScoped = byKey(descriptors, "omp.mode");
	const machine = byKey(descriptors, "omp.group.inner");
	const layers = { defaultValue: "a", globalValue: "b", workspaceValue: "a" };
	assert.equal(sourceOf(windowScoped, layers, WORKSPACE), "workspace");
	assert.equal(sourceOf(appScoped, layers, WORKSPACE), "user", "VS Code ignores a workspace value of an application setting");
	assert.equal(sourceOf(machine, layers, WORKSPACE), "user");
	assert.equal(sourceOf(windowScoped, layers, NO_WORKSPACE), "user", "with no workspace there is no workspace layer");
	assert.equal(sourceOf(windowScoped, { defaultValue: true }, WORKSPACE), "default");

	assert.deepEqual(chooseTarget(windowScoped, {}, WORKSPACE, undefined), { ok: true, target: "user" }, "user is the default layer");
	assert.deepEqual(chooseTarget(windowScoped, layers, WORKSPACE, undefined), { ok: true, target: "workspace" }, "a workspace value that overrides is the layer a change must reach");
	assert.deepEqual(chooseTarget(windowScoped, layers, WORKSPACE, "user"), { ok: true, target: "user" }, "the user may still choose the user layer");
	assert.deepEqual(chooseTarget(windowScoped, {}, WORKSPACE, "workspace"), { ok: true, target: "workspace" }, "or the workspace when none overrides yet");
	assert.deepEqual(chooseTarget(appScoped, layers, WORKSPACE, undefined), { ok: true, target: "user" });
	const refused = chooseTarget(appScoped, layers, WORKSPACE, "workspace");
	assert.equal(refused.ok, false);
	assert.match(refused.ok ? "" : refused.message, /application scope and is saved in User settings only/);
	assert.equal(chooseTarget(windowScoped, {}, NO_WORKSPACE, "workspace").ok, false, "no workspace is open");
	assert.equal(chooseTarget(windowScoped, {}, WORKSPACE, "folder").ok, false, "folder layers are never written");
	assert.equal(chooseTarget(windowScoped, {}, WORKSPACE, 5).ok, false);

	assert.deepEqual(buildView(windowScoped, layers, "a", WORKSPACE, []).targets, ["user", "workspace"]);
	assert.deepEqual(buildView(appScoped, layers, "b", WORKSPACE, []).targets, ["user"]);
	assert.match(buildView(appScoped, layers, "b", WORKSPACE, []).scopeNote ?? "", /every window/);
	assert.deepEqual(buildView(windowScoped, {}, true, NO_WORKSPACE, []).targets, ["user"]);
});

test("folder values are reported only where a folder layer exists, and never as the value in effect", () => {
	const descriptors = projectConfiguration([{ properties: { "p.res": { type: "boolean", scope: "resource" }, "p.win": { type: "boolean" } } }]);
	const resource = byKey(descriptors, "p.res");
	const windowScoped = byKey(descriptors, "p.win");
	assert.deepEqual(buildView(resource, {}, undefined, WORKSPACE, ["a"]).folders, ["a"]);
	assert.deepEqual(buildView(windowScoped, {}, undefined, WORKSPACE, ["a"]).folders, []);
	assert.equal(buildView(resource, {}, undefined, WORKSPACE, ["a"]).source, "default");
});

test("reset clears every writable layer that holds a value and nothing else", () => {
	const descriptors = projectConfiguration(SECTION);
	const windowScoped = byKey(descriptors, "omp.flag");
	const appScoped = byKey(descriptors, "omp.mode");
	assert.deepEqual(resetTargets(windowScoped, { defaultValue: true }, WORKSPACE), []);
	assert.deepEqual(resetTargets(windowScoped, { globalValue: false }, WORKSPACE), ["user"]);
	assert.deepEqual(resetTargets(windowScoped, { globalValue: false, workspaceValue: false }, WORKSPACE), ["workspace", "user"], "the overriding layer first");
	assert.deepEqual(resetTargets(windowScoped, { globalValue: false, workspaceValue: false }, NO_WORKSPACE), ["user"]);
	assert.deepEqual(resetTargets(appScoped, { globalValue: "b", workspaceValue: "a" }, WORKSPACE), ["user"], "an ignored workspace value is not touched");
	assert.equal(buildView(windowScoped, { globalValue: false }, false, WORKSPACE, []).modified, true);
	assert.equal(buildView(windowScoped, { defaultValue: true }, true, WORKSPACE, []).modified, false);
});

test("search matches every term across label, key, group, description and option text", () => {
	const descriptors = projectConfiguration(SECTION);
	const entries = descriptors.map(descriptor => ({ descriptor, view: buildView(descriptor, {}, undefined, WORKSPACE, []) }));
	const groups = groupViews(entries);
	assert.deepEqual(groups.map(group => group.title), ["General", "Group"]);
	const hits = (query: string): string[] => groups.flatMap(group => group.settings.filter(view => matchesQuery(view, group.title, query)).map(view => view.key));
	assert.deepEqual(hits(""), descriptors.map(descriptor => descriptor.key));
	assert.deepEqual(hits("OMP.LIMIT"), ["omp.limit"]);
	assert.deepEqual(hits("toggle code"), ["omp.flag"], "every term must match, in any order");
	assert.deepEqual(hits("beta"), ["omp.mode"], "enum option descriptions are searched");
	assert.deepEqual(hits("inner"), ["omp.group.inner"]);
	assert.deepEqual(hits("nothing like this"), []);
});

test("the shipped manifest projects completely: every contributed omp setting has a row and a usable control", () => {
	const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { contributes: { configuration: unknown } };
	const descriptors = projectConfiguration(manifest.contributes.configuration);
	const sections = Array.isArray(manifest.contributes.configuration) ? manifest.contributes.configuration : [manifest.contributes.configuration];
	const contributed = sections.flatMap((section: { properties: Record<string, unknown> }) => Object.keys(section.properties));
	assert.deepEqual(descriptors.map(descriptor => descriptor.key).sort(), [...contributed].sort());
	for (const descriptor of descriptors) {
		assert.notEqual(descriptor.description, "", `${descriptor.key} has a description`);
		assert.notEqual(descriptor.control.kind, "json", `${descriptor.key} is editable in place`);
	}
});

test("a schema the page cannot validate fully is never offered as a control", () => {
	const projected = (property: Record<string, unknown>) => projectConfiguration({ properties: { "p.x": property } })[0]!.control;
	assert.deepEqual(projected({ type: "string", format: "uri" }), { kind: "json" }, "format is not enforced by the page");
	assert.deepEqual(projected({ type: "string", allOf: [{ minLength: 3 }] }), { kind: "json" });
	assert.deepEqual(projected({ type: "string", const: "a" }), { kind: "json" });
	assert.deepEqual(projected({ type: "string", pattern: "(" }), { kind: "json" }, "an unusable pattern cannot reject input, so no control");
	// An enumeration keeps the type's own bounds: options those bounds reject are not offered.
	assert.deepEqual(projected({ type: "integer", enum: [1, 2, 3], minimum: 2 }), { kind: "enum", options: [{ value: 2, label: "2" }, { value: 3, label: "3" }] });
	assert.deepEqual(projected({ type: "integer", enum: [1], minimum: 2 }), { kind: "json" }, "no option survives");
	assert.deepEqual(projected({ type: "string", enum: ["safe", {}] }), { kind: "json" }, "an enumeration with an entry the page cannot offer keeps its restriction");
	assert.deepEqual(projected({ type: "string", enum: [] }), { kind: "json" });
	assert.deepEqual(projected({ type: "string", enum: ["a", 1] }), { kind: "enum", options: [{ value: "a", label: "a" }] }, "an option of the wrong type is not offered");
});

test("a row names the layers Reset will clear before the user acts", () => {
	const descriptor = projectConfiguration(SECTION)[0]!;
	assert.deepEqual(buildView(descriptor, { globalValue: false, workspaceValue: false }, false, WORKSPACE, []).resetLayers, ["workspace", "user"]);
	assert.deepEqual(buildView(descriptor, { defaultValue: true }, true, WORKSPACE, []).resetLayers, []);
});
