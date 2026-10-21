import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEntry } from "../../chat/messages.ts";
import { projectTranscript } from "../../chat/transcript.ts";
import { clearFindCache, findIdOf, findPattern, findUnitsOf, matchAt, positionOf, searchUnits, segmentOf } from "./transcript-find.ts";

const entry = (id: string, message: Record<string, unknown>): ChatEntry => ({ type: "message", id, parentId: null, timestamp: "2026-10-17T00:00:00Z", message: { timestamp: 1, ...message } } as ChatEntry);
const user = (id: string, content: string, extra: Record<string, unknown> = {}) => entry(id, { role: "user", content, ...extra });
const reply = (id: string, content: unknown[]) => entry(id, { role: "assistant", model: "m", stopReason: "stop", content });
const call = (id: string, tool: string, args: Record<string, unknown>, intent?: string) => entry(id, { role: "assistant", model: "m", stopReason: "toolUse", content: [{ type: "toolCall", id: `call-${id}`, name: tool, arguments: args, ...(intent === undefined ? {} : { intent }) }] });
const result = (id: string, callId: string, tool: string, text: string) => entry(id, { role: "toolResult", toolCallId: callId, toolName: tool, isError: false, content: [{ type: "text", text }] });
/** Markdown shown as written: the renderer's own projection lives with its component. */
const plain = (text: string): string => text;
const unitsOf = (entries: ChatEntry[]) => findUnitsOf(projectTranscript(entries), undefined, plain);

describe("the units Find searches", () => {
	it("are the user's messages, the replies' text and thinking, and each tool call's head and output, oldest first", () => {
		const units = unitsOf([
			user("u1", "Where is the quokka?"),
			reply("a1", [{ type: "thinking", thinking: "A quokka lives in Australia" }, { type: "text", text: "On Rottnest Island." }]),
			call("c1", "bash", { command: "echo quokka" }, "Probing the marsupial"),
			result("r1", "call-c1", "bash", "quokka\nsecond line"),
		]);
		assert.deepEqual(units.map(unit => unit.id), ["u1", "a1", "a1:content:2", "call:call-c1"]);
		assert.deepEqual(units[1]!.segments.map(segment => segment.part), ["thinking"]);
		assert.deepEqual(units[3]!.segments.map(segment => segment.part), ["head", "output"]);
		assert.match(units[3]!.segments[0]!.text, /Bash/);
		assert.match(units[3]!.segments[0]!.text, /echo quokka/);
		assert.match(units[3]!.segments[0]!.text, /Probing the marsupial/);
		assert.equal(units[3]!.segments[1]!.text, "quokka\nsecond line");
		assert.equal(units[3]!.callId, "call-c1");
	});

	it("leave out what Find does not search: an agent-attributed input, a result whose call card is loaded, and a row with no text", () => {
		const units = unitsOf([
			user("u1", "typed"),
			user("u2", "from an agent", { synthetic: true }),
			call("c1", "bash", { command: "ls" }),
			result("r1", "call-c1", "bash", "out"),
			reply("a1", [{ type: "thinking", thinking: "   " }]),
		]);
		assert.deepEqual(units.map(unit => unit.id), ["u1", "call:call-c1"], "the result is searched once, with its call");
	});

	it("do not read the reply being written, whatever its text, and read it once it is complete", () => {
		const message = (text: string) => ({ role: "assistant", model: "m", timestamp: 2, stopReason: "stop", content: [{ type: "text", text }] }) as never;
		const seen: string[] = [];
		const spy = (text: string): string => { seen.push(text); return text; };
		const history = [user("u1", "quokka"), reply("a1", [{ type: "text", text: "settled quokka" }])];
		for (const text of ["quokka", "quokka and", "quokka and more quokka"]) {
			const cards = projectTranscript(history, { stream: message(text), streamId: "live" });
			assert.deepEqual(findUnitsOf(cards, undefined, spy).map(unit => unit.id), ["u1", "a1"], "the streaming card is not a unit");
		}
		assert.deepEqual(seen.filter(text => text.startsWith("quokka and")), [], "no prefix of the streaming reply was parsed or cached");
		clearFindCache();
		const done = findUnitsOf(projectTranscript([...history, reply("a2", [{ type: "text", text: "quokka and more quokka" }])]), undefined, spy);
		assert.deepEqual(done.map(unit => unit.id), ["u1", "a1", "a2"]);
	});

	it("take a result whose call is older than the loaded history as a call of its own", () => {
		const cards = projectTranscript([result("r9", "call-gone", "read", "orphan text")]);
		const units = findUnitsOf(cards, undefined, plain);
		assert.deepEqual(units.map(unit => unit.id), ["call:call-gone"]);
		assert.equal(findIdOf(cards[0]!), "call:call-gone", "the row of that card is named by the same id");
	});

	it("keep a unit between two projections of the same entries, so a streaming tail is the only one counted again", () => {
		const entries = [user("u1", "hello"), call("c1", "bash", { command: "ls" })];
		const first = unitsOf(entries), second = unitsOf(entries);
		assert.equal(first[0], second[0], "the same entry gives the same unit, so a streaming tail is the only one counted again");
		assert.equal(first[1], second[1]);
	});
});

describe("counting matches", () => {
	const entries = [
		user("u1", "alpha Beta alpha"),
		reply("a1", [{ type: "thinking", thinking: "alpha" }, { type: "text", text: "no match" }, { type: "text", text: "ALPHA alpha" }]),
		call("c1", "bash", { command: "echo alpha" }),
		result("r1", "call-c1", "bash", "alpha\nalpha"),
	];

	it("counts case-insensitively by default and exactly on request, literally", () => {
		const units = unitsOf(entries);
		const loose = searchUnits(units, findPattern("alpha", false));
		assert.deepEqual(loose.counts, [2, 1, 2, 3], "a reply's thinking and its text are cards, hence rows, of their own");
		assert.equal(loose.total, 8);
		assert.equal(searchUnits(units, findPattern("alpha", true)).total, 7);
		assert.equal(searchUnits(units, findPattern("a.ha", false)).total, 0, "a dot is a dot, not a pattern");
		assert.equal(searchUnits(units, findPattern("(", false)).total, 0, "a query that is not a regular expression is still a query");
		assert.equal(findPattern("", false), null);
		assert.equal(searchUnits(units, null).total, 0);
	});

	it("numbers the matches across units and finds each back", () => {
		const search = searchUnits(unitsOf(entries), findPattern("alpha", false));
		const found = Array.from({ length: search.total }, (_, index) => matchAt(search, index)!);
		assert.deepEqual(found.map(match => `${match.id}#${match.occurrence}`), [
			"u1#0", "u1#1", "a1#0", "a1:content:2#0", "a1:content:2#1", "call:call-c1#0", "call:call-c1#1", "call:call-c1#2",
		]);
		for (const [index, match] of found.entries()) assert.equal(positionOf(search, match), index);
		assert.equal(matchAt(search, -1), null);
		assert.equal(matchAt(search, search.total), null);
		assert.equal(positionOf(search, { id: "u1", occurrence: 5 }), -1);
		assert.equal(positionOf(search, { id: "gone", occurrence: 0 }), -1);
	});

	it("skips units without a match and says which part of a unit holds a match", () => {
		const search = searchUnits(unitsOf(entries), findPattern("second", false));
		assert.equal(search.total, 0);
		const narrow = searchUnits(unitsOf(entries), findPattern("beta", false));
		assert.deepEqual(matchAt(narrow, 0), { id: "u1", occurrence: 0 });
		const units = unitsOf(entries);
		const all = searchUnits(units, findPattern("alpha", false));
		assert.equal(segmentOf(units[1]!, 0)?.part, "thinking");
		assert.equal(segmentOf(units[2]!, 0)?.part, "text");
		assert.equal(segmentOf(units[3]!, 0)?.part, "head");
		assert.equal(segmentOf(units[3]!, 1)?.part, "output");
		assert.equal(segmentOf(units[3]!, 3), null);
		assert.equal(all.total, 8);
	});
});
