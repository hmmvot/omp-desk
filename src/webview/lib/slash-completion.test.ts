import assert from "node:assert/strict";
import { test } from "node:test";
import { argumentSuggestions, isRewindCommand, missingRequiredArgument, parseArgumentHint, slashArgumentAt, slashQueryAt, slashSuggestions, spliceArgument, spliceSlash } from "./slash-completion.ts";

 test("a leading command token lists every command and skill; paths, prose and arguments are not completion-owned", () => {
 assert.deepEqual(slashQueryAt("/skill:inspect args", 7), { query: "skill:", start: 0, end: 14, skillsOnly: false });
 assert.deepEqual(slashQueryAt("/re", 3), { query: "re", start: 0, end: 3, skillsOnly: false });
 for (const [text, caret] of [["/read args", 10], ["/usr/bin/tool", 5], ["@src/file.ts", 5], [" /read", 6], ["/", 0]] as const) assert.equal(slashQueryAt(text, caret), null, JSON.stringify([text, caret]));
 });

 test("a `/` token in the middle of the draft lists skills only, once `/s` of `/skill:` is typed after whitespace or a line start", () => {
 const at = (text: string, caret = text.length) => slashQueryAt(text, caret);
 assert.deepEqual(at("fix this /s"), { query: "s", start: 9, end: 11, skillsOnly: true });
 assert.deepEqual(at("fix this /sk"), { query: "sk", start: 9, end: 12, skillsOnly: true });
 assert.deepEqual(at("fix this /skill:"), { query: "skill:", start: 9, end: 16, skillsOnly: true });
 assert.deepEqual(at("fix this /Skill:Rev"), { query: "skill:rev", start: 9, end: 19, skillsOnly: true }, "the query is lower case, as the leading one");
 assert.deepEqual(at("fix this /skill:review"), { query: "skill:review", start: 9, end: 22, skillsOnly: true }, "an exact name keeps the list open");
 assert.deepEqual(at("one\n/sk later", 7), { query: "sk", start: 4, end: 7, skillsOnly: true }, "a line start counts, and the token ends at the whitespace after it");
 assert.deepEqual(at("a\t/sk"), { query: "sk", start: 2, end: 5, skillsOnly: true }, "a tab counts");
 assert.deepEqual(at("fix /skx later", 7), { query: "sk", start: 4, end: 8, skillsOnly: true }, "the caret in the middle of the token: the query stops at the caret, the splice takes the rest");
 assert.deepEqual(at("a /sk b /skill:other", 5), { query: "sk", start: 2, end: 5, skillsOnly: true }, "a later token does not hide this one");
 for (const text of ["fix this /", "fix this /r", "fix this /rev", "fix this /skillx", "fix this /sk:", "src/app.ts", "fix src/sk", "a/sk", "see http://x/sk", "see https://example.com/skill:x", "fix /usr/sk", "fix /s/k", "fix /sk.ts", "fix /sk/x", "fix @/sk", "fix ./sk", "a //sk"]) {
  assert.equal(at(text), null, JSON.stringify(text));
 }
 assert.equal(at("fix this /sk", 9), null, "a caret before the slash is outside the token");
 assert.equal(at("fix this /sk", 10), null, "a caret right after the slash has nothing typed yet");
 });

 test("a mid-text token opens the list only where OMP would invoke it, by the chip scan's gates", () => {
 for (const text of ["/compact do /sk", "/foo /sk", "/skill:review do /sk", " /compact /sk", "!ls /sk", "$ echo /sk", "$$ echo /sk", "$\n/sk", "a /skill:review /sk", "a /skill:nope /sk", "a /skill:ns/deep b /sk"]) {
  assert.equal(slashQueryAt(text, text.length), null, JSON.stringify(text));
 }
 assert.equal(slashQueryAt("${HOME} /sk", 11)?.skillsOnly, true, "`${` is not a sigil");
 assert.equal(slashQueryAt("$HOME /sk", 9)?.skillsOnly, true, "a `$` that is not followed by a blank is not a sigil");
 assert.equal(slashQueryAt("a /skill:ns/deep/x /sk", 22)?.skillsOnly, true, "a token OMP does not read as a skill (two slashes) is no earlier token");
 });

 test("a mid-text list holds skills only, ranked by the same rules: an exact name or alias first, then catalogue order", () => {
 const commands = [{ name: "skill:report-card", source: "skill" }, { name: "report", source: "builtin" }, { name: "skill:report", aliases: ["rp"], source: "skill" }, { name: "skill:omp-desk-bug-report", source: "skill" }, { name: "skill:rp-extra", source: "skill" }];
 assert.deepEqual(slashSuggestions(commands, "skill:report", true).map(command => command.name), ["skill:report", "skill:report-card"]);
 assert.deepEqual(slashSuggestions(commands, "skill:", true).map(command => command.name), ["skill:report-card", "skill:report", "skill:omp-desk-bug-report", "skill:rp-extra"], "no command, Desk's own included, and the catalogue order");
 assert.deepEqual(slashSuggestions(commands, "s", true).every(command => command.source === "skill"), true);
 assert.equal(slashSuggestions(commands, "rp", true)[0]?.name, "skill:report", "an exact alias leads");
 assert.deepEqual(slashSuggestions(commands, "report", false)[0]?.name, "report", "the leading list still puts commands first");
 });

 test("denied catalogue owners hide their aliases while an allowed alias inserts its canonical command without sending", () => {
 const commands = [{ name: "worktree", aliases: ["sandbox"], source: "builtin" }, { name: "move", aliases: ["relocate"] }, { name: "skill:inspect", aliases: ["review"], source: "skill", inputHint: "files" }, { name: "status" }];
 assert.deepEqual(slashSuggestions(commands, "sandbox"), []);
 assert.deepEqual(slashSuggestions(commands, "relocate"), []);
 const found = slashSuggestions(commands, "rev"); assert.equal(found[0]?.name, "skill:inspect");
 assert.deepEqual(spliceSlash("/rev existing args", { start: 0, end: 4 }, found[0]!.name), { text: "/skill:inspect existing args", caret: 15 });
 assert.deepEqual(spliceSlash("fix /sk later", { start: 4, end: 7 }, found[0]!.name), { text: "fix /skill:inspect later", caret: 19 }, "a mid-text splice takes the token and the one space after it, and writes its own");
 });

test("suggestions rank an exact name first, then every command before any skill, each in catalogue order", () => {
 const commands = [
  { name: "skill:omp-desk-bug-report", source: "skill", description: "Write a bug report" },
  { name: "skill:report", source: "skill" },
  { name: "report-card", source: "extension" },
  { name: "report", source: "custom", description: "File a report" },
  { name: "reporting", source: "builtin" },
 ];
 assert.deepEqual(slashSuggestions(commands, "report").map(command => command.name), ["report", "report-card", "reporting", "skill:omp-desk-bug-report", "skill:report"], "the exact command first, the other commands next, the skills last");
 assert.deepEqual(slashSuggestions(commands, "skill:report").map(command => command.name), ["skill:report"], "an exact skill name leads its own list");
 assert.deepEqual(slashSuggestions(commands, "rep").map(command => command.name), ["report-card", "report", "reporting", "skill:omp-desk-bug-report", "skill:report"], "without an exact name, commands lead and the catalogue order holds inside each group");
 assert.deepEqual(slashSuggestions([{ name: "skill:inspect", aliases: ["review"], source: "skill" }, { name: "review-all", source: "extension" }], "review").map(command => command.name), ["skill:inspect", "review-all"], "an exact alias is an exact match and outranks the commands");
 assert.deepEqual(slashSuggestions([{ name: "skill:a", source: "skill" }, { name: "b-skill:x" }], "skill:").map(command => command.name), ["b-skill:x", "skill:a"], "a command whose name contains the query still ranks above a skill");
 assert.equal(slashSuggestions(commands, "")[0]!.source, "OMP Desk", "an empty query has no exact entry; Desk's own commands lead");
});

test("native settings commands remain discoverable when OMP omits its TUI-only hub catalogue entry", () => {
 assert.equal(slashSuggestions([], "agents")[0]?.name, "agents");
 assert.equal(slashSuggestions([], "model")[0]?.name, "models");
 assert.equal(slashSuggestions([{ name: "model", aliases: ["models"], source: "builtin" }], "model").length, 1);
 assert.deepEqual(spliceSlash("/model p/m", { start: 0, end: 6 }, "models"), { text: "/models p/m", caret: 8 });
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

test("Chat's own /rewind, with OMP's /branch as its alias, replaces OMP's `branch` builtin; the internal navigate command stays hidden", () => {
 const commands = [{ name: "branch", aliases: ["rewind"], source: "builtin" }, { name: "omp-desk-navigate", source: "extension" }];
 for (const query of ["rew", "branch"]) {
  const found = slashSuggestions(commands, query);
  assert.deepEqual(found.map(command => command.name), ["rewind"], query);
  assert.equal(found[0]!.source, "OMP Desk");
 }
 assert.deepEqual(slashSuggestions(commands, "omp-desk"), []);
 for (const text of ["/rewind", " /REWIND ", "/rewind\n", "/branch", " /Branch "]) assert.equal(isRewindCommand(text), true, text);
 for (const text of ["/rewind now", "/rewinds", "say /rewind", "/branch 3", "/branches"]) assert.equal(isRewindCommand(text), false, text);
});

test("/clear, /new, /delete and /fresh list with Desk descriptions; the internal command stays hidden", () => {
 const commands = [{ name: "clear", source: "builtin", description: "OMP clear" }, { name: "new", source: "builtin", description: "OMP new" }, { name: "delete", source: "builtin" }, { name: "fresh", source: "builtin" }, { name: "omp-desk-clear", source: "extension" }, { name: "hotkeys", source: "builtin" }];
 for (const name of ["clear", "new", "delete", "fresh"]) {
  const found = slashSuggestions(commands, name);
  assert.deepEqual(found.map(command => command.name), [name], name);
  assert.equal(found[0]!.source, "OMP Desk");
 }
 assert.match(slashSuggestions(commands, "clear")[0]!.description!, /in place/);
 assert.match(slashSuggestions(commands, "new")[0]!.description!, /in place of this tab/);
 assert.match(slashSuggestions(commands, "fresh")[0]!.description!, /provider/);
 assert.deepEqual(slashSuggestions(commands, "omp-desk"), []);
 assert.equal(slashSuggestions(commands, "hotkeys").length, 1, "the remaining terminal-only commands stay listed");
});

test("/fork lists once with the Desk description and replaces OMP's entry of the same name", () => {
 const commands = [{ name: "fork", source: "builtin", description: "OMP fork" }, { name: "forked-work", source: "extension" }];
 const found = slashSuggestions(commands, "fork");
 assert.deepEqual(found.map(command => command.name), ["fork", "forked-work"]);
 assert.equal(found[0]!.source, "OMP Desk");
 assert.match(found[0]!.description!, /new Chat tab/);
 assert.notEqual(found[0]!.description, "OMP fork");
 assert.equal(slashSuggestions([], "fork").filter(command => command.name === "fork").length, 1);
});

test("OMP's bundled /review is listed with the Desk text; a command of the user's own that reuses the name keeps its text", () => {
 const bundled = [{ name: "review", source: "custom", description: "Launch interactive code review", inputHint: "arguments" }];
 const found = slashSuggestions(bundled, "review");
 assert.equal(found.length, 1);
 assert.match(found[0]!.description!, /uncommitted changes, a branch diff, a commit or a pull request/);
 assert.equal(found[0]!.inputHint, "[PR link] [what to focus on]");
 assert.equal(found[0]!.source, "custom", "it stays the command OMP runs");
 const typed = slashArgumentAt(bundled, "/review ", 8);
 assert.equal(typed?.hint.text, "[PR link] [what to focus on]");
 assert.equal(typed?.hint.requirement, "optional");
 assert.equal(missingRequiredArgument(bundled, "/review"), false, "a bare /review is sent: OMP asks what to review");
 const own = [{ name: "review", source: "custom", description: "Our own checklist", inputHint: "files" }];
 assert.deepEqual(slashSuggestions(own, "review")[0], own[0]);
 const later = [{ name: "review", source: "custom", description: "A later OMP text", inputHint: "arguments" }];
 assert.deepEqual(slashSuggestions(later, "review")[0], later[0]);
});
