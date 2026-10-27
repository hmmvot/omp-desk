/**
 * The window's link rules and the open of a clicked rule link (`docs/designs/2026-10-27-chat-link-rules.md`).
 *
 * Runner: `node --test src/host/link-rules.test.ts`
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLinkRuleSource, describeLinkRuleProblems, handleLinkRuleOpen } from "./link-rules.ts";
import type { LinkRuleOpenHost } from "./link-rules.ts";
import { linkRuleTarget } from "../shared/link-rules.ts";
import type { LinkRuleProblem } from "../shared/link-rules.ts";
import type { TerminalLinkRequest } from "../shared/terminal-links.ts";

const ISSUE = { pattern: "#(\\d+)\\b", url: "https://example.test/issues/$1" };
const TICKET = { pattern: "\\bPROJ-(\\d+)\\b", url: "https://example.test/browse/$1", name: "Tracker" };

function source(initial: unknown) {
	let value = initial;
	const reports: LinkRuleProblem[][] = [];
	return {
		set: (next: unknown) => { value = next; },
		reports,
		source: createLinkRuleSource({ read: () => value, report: problems => reports.push([...problems]) }),
	};
}

function openRequest(target: string, over: Record<string, unknown> = {}): TerminalLinkRequest {
	return { type: "omp:terminal-link-open", requestId: 1, target, ...over } as TerminalLinkRequest;
}

function host(over: Partial<LinkRuleOpenHost> = {}): { host: LinkRuleOpenHost; opened: string[]; warnings: string[] } {
	const opened: string[] = [];
	const warnings: string[] = [];
	return { opened, warnings, host: { isCurrent: () => true, openExternal: async url => { opened.push(url); }, warn: message => warnings.push(message), ...over } };
}

describe("createLinkRuleSource", () => {
	it("compiles the setting, hands out entries with the position of each rule and reads nothing twice", () => {
		const { source: rules } = source([ISSUE, TICKET]);
		const snapshot = rules.current();
		assert.deepEqual(snapshot.entries.map(entry => [entry.id, entry.name]), [[0, null], [1, "Tracker"]]);
		assert.equal(rules.current(), snapshot, "the same value is not compiled again");
	});

	it("is empty while the setting is unset", () => {
		assert.deepEqual(source(undefined).source.current().entries, []);
	});

	it("reports a refused rule once for a value, again for a new one, and still serves the valid ones", () => {
		const bad = { pattern: "(", url: "https://example.test/" };
		const { source: rules, reports, set } = source([bad, ISSUE]);
		assert.deepEqual(rules.current().entries.map(entry => entry.id), [1]);
		rules.current();
		rules.current();
		assert.equal(reports.length, 1);
		assert.equal(reports[0]?.[0]?.index, 0);
		set([bad, ISSUE, { pattern: "x*", url: "https://example.test/" }]);
		rules.current();
		assert.equal(reports.length, 2, "a changed value is reported again");
		set([ISSUE]);
		rules.current();
		assert.equal(reports.length, 2, "a value without refused rules reports nothing");
	});

	it("follows a change to the setting, including its removal", () => {
		const { source: rules, set } = source([ISSUE]);
		assert.equal(rules.current().entries.length, 1);
		set(undefined);
		assert.deepEqual(rules.current().entries, []);
	});

	it("numbers rules from 1 in the sentence for the user", () => {
		assert.equal(describeLinkRuleProblems([{ index: 0, message: "a" }, { index: 3, message: "b" }]), "rule 1: a; rule 4: b");
	});
});

describe("handleLinkRuleOpen", () => {
	it("builds the URL itself from the rule and the matched characters and opens it externally", async () => {
		const { source: rules } = source([ISSUE, TICKET]);
		const fixture = host();
		assert.equal(await handleLinkRuleOpen(openRequest(linkRuleTarget(1, "PROJ-45")), rules, fixture.host), true);
		assert.equal(await handleLinkRuleOpen(openRequest(linkRuleTarget(0, "#7")), rules, fixture.host), true);
		assert.deepEqual(fixture.opened, ["https://example.test/browse/45", "https://example.test/issues/7"]);
		assert.deepEqual(fixture.warnings, []);
	});

	it("never opens an address the page supplies: only a rule target is handled, and it is not even a candidate otherwise", async () => {
		const { source: rules } = source([ISSUE]);
		const fixture = host();
		for (const target of ["https://evil.example/x", "http://evil.example/", "javascript:alert(1)", "commit://abcdef1", "link-rule:https://evil.example/", "link-rule://0", "./a.ts"]) {
			assert.equal(await handleLinkRuleOpen(openRequest(target, { mode: "external" }), rules, fixture.host), false, target);
		}
		assert.deepEqual(fixture.opened, []);
	});

	it("opens nothing when the text is not what the rule matches on its own, whatever the page names", async () => {
		const { source: rules } = source([ISSUE]);
		const fixture = host();
		for (const text of ["not an issue", "#7 and more", "see #7", "https://evil.example/", "#7\nhttps://evil.example/"]) {
			assert.equal(await handleLinkRuleOpen(openRequest(linkRuleTarget(0, text)), rules, fixture.host), true, text);
		}
		assert.deepEqual(fixture.opened, []);
		assert.equal(fixture.warnings.length, 5, "the user is told each time that nothing was opened");
	});

	it("opens nothing for a rule that is gone or was renumbered by the setting's change, and for a stale page", async () => {
		const { source: rules, set } = source([ISSUE, TICKET]);
		const fixture = host();
		set([TICKET]);
		await handleLinkRuleOpen(openRequest(linkRuleTarget(1, "PROJ-45")), rules, fixture.host);
		assert.deepEqual(fixture.opened, [], "position 1 no longer exists");
		await handleLinkRuleOpen(openRequest(linkRuleTarget(0, "#7")), rules, fixture.host);
		assert.deepEqual(fixture.opened, [], "position 0 is now another rule that does not match the text");
		const stale = host({ isCurrent: () => false });
		await handleLinkRuleOpen(openRequest(linkRuleTarget(0, "PROJ-1")), rules, stale.host);
		assert.deepEqual(stale.opened, []);
	});

	it("takes a rule from the user's current setting, so a rule removed from it cannot be opened by an old page", async () => {
		const { source: rules, set } = source([ISSUE]);
		const fixture = host();
		set(undefined);
		await handleLinkRuleOpen(openRequest(linkRuleTarget(0, "#7")), rules, fixture.host);
		assert.deepEqual(fixture.opened, []);
	});

	it("a validate request for a rule target opens nothing and is still this handler's", async () => {
		const { source: rules } = source([ISSUE]);
		const fixture = host();
		assert.equal(await handleLinkRuleOpen({ type: "omp:terminal-link-validate", requestId: 2, target: linkRuleTarget(0, "#7") }, rules, fixture.host), true);
		assert.deepEqual(fixture.opened, []);
	});
});
