import assert from "node:assert/strict";
import { test } from "node:test";
import { argumentSuggestions, missingRequiredArgument, parseArgumentHint, slashArgumentAt, slashQueryAt, slashSuggestions, spliceArgument, spliceSlash } from "./slash-completion.ts";

 test("slash completion owns only a leading command token, not paths, prose, args or embedded skills", () => {
 assert.deepEqual(slashQueryAt("/skill:inspect args", 7), { query: "skill:", end: 14 });
 for (const [text, caret] of [["invoke /skill:inspect", 21], ["/read args", 10], ["/usr/bin/tool", 5], ["@src/file.ts", 5], [" /read", 6]] as const) assert.equal(slashQueryAt(text, caret), null);
 });

 test("denied catalogue owners hide their aliases while an allowed alias inserts its canonical command without sending", () => {
 const commands = [{ name: "worktree", aliases: ["sandbox"], source: "builtin" }, { name: "move", aliases: ["relocate"] }, { name: "skill:inspect", aliases: ["review"], source: "skill", inputHint: "files" }, { name: "status" }];
 assert.deepEqual(slashSuggestions(commands, "sandbox"), []);
 assert.deepEqual(slashSuggestions(commands, "relocate"), []);
 const found = slashSuggestions(commands, "rev"); assert.equal(found[0]?.name, "skill:inspect");
 assert.deepEqual(spliceSlash("/rev existing args", 4, found[0]!.name), { text: "/skill:inspect existing args", caret: 15 });
 });

test("native settings commands remain discoverable when OMP omits its TUI-only hub catalogue entry", () => {
 assert.equal(slashSuggestions([], "agents")[0]?.name, "agents");
 assert.equal(slashSuggestions([], "model")[0]?.name, "models");
 assert.equal(slashSuggestions([{ name: "model", aliases: ["models"], source: "builtin" }], "model").length, 1);
 assert.deepEqual(spliceSlash("/model p/m", 6, "models"), { text: "/models p/m", caret: 8 });
});

test("argument hints distinguish conventional optional and required inputs without guessing unknown formats", () => {
 assert.deepEqual(parseArgumentHint(" [focus instructions] "), { text: "[focus instructions]", requirement: "optional" });
 assert.equal(parseArgumentHint("<link>").requirement, "required");
 assert.equal(parseArgumentHint("<name> [args]").requirement, "required");
 for (const hint of [undefined, "", "focus instructions", "[broken", "<broken", "one | two"]) assert.equal(parseArgumentHint(hint).requirement, "unknown");
});

test("variants resolve aliases, filter locally, retain usage/default and splice only the first argument", () => {
 const command = { name: "shake", aliases: ["trim"], inputHint: "[elide|images|thinking]", subcommands: [{ name: "elide", description: "Hide text (default)" }, { name: "images", description: "Hide images", usage: "/shake images" }, { name: "thinking" }] };
 const query = slashArgumentAt([command], "/trim im tail", 8)!;
 assert.equal(query.command, command);
 assert.equal(query.query, "im");
 assert.deepEqual(argumentSuggestions(command, query.query), [{ name: "images", description: "Hide images", usage: "/shake images", isDefault: false }]);
 assert.equal(argumentSuggestions(command, "")[0]?.isDefault, true);
 assert.deepEqual(spliceArgument("/trim im tail", query.start, query.end, "images"), { text: "/trim images tail", caret: 13 });
 for (const [text, caret] of [["/shake", 6], ["/shake images ", 14], ["/shake images more", 18], ["say /shake ", 11]] as const) assert.equal(slashArgumentAt([command], text, caret), null);
 assert.equal(slashArgumentAt([{name:"plain"}], "/plain ", 7), null);
 assert.equal(slashArgumentAt([{name:"handoff",inputHint:"[focus instructions]"}], "/handoff ", 9), null, "denied commands do not advertise unusable hints");
});

test("required-empty guards aliases and every submit path; optional/unknown and nonempty keep send semantics", () => {
 const commands = [{name:"join", aliases:["connect"], inputHint:"<link>"}, {name:"shake",inputHint:"[variant]"}, {name:"unknown",subcommands:[{name:"one"}]}];
 for (const text of ["/join", "/join ", "/connect\t"]) assert.equal(missingRequiredArgument(commands, text), true);
 for (const text of ["/join link", "/shake ", "/unknown ", "/plain", "say /join"]) assert.equal(missingRequiredArgument(commands, text), false);
});
