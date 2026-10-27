/**
 * User link rules (`docs/designs/2026-10-27-chat-link-rules.md`): screening, compilation, URL building, matching and the click target.
 *
 * Runner: `node --test src/shared/link-rules.test.ts`
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_LINK_RULES, MAX_MATCHES_PER_TEXT, MAX_MATCH_LENGTH, MAX_SCANNED_TEXT, buildLinkRuleUrl, compileLinkRule, compileLinkRules, findLinkRuleMatches,
	linkRuleEntries, linkRuleTarget, linkRuleTitle, matchWholeLinkRule, parseLinkRuleEntry, parseLinkRuleTarget, screenPattern,
} from "./link-rules.ts";
import type { LinkRule } from "./link-rules.ts";

const ISSUE = { name: "Issue", pattern: "#(\\d+)\\b", url: "https://example.test/<owner>/<repo>/issues/$1" };

function rule(raw: Record<string, unknown>, id = 0): LinkRule {
	const compiled = compileLinkRule(raw, id);
	assert.equal(typeof compiled, "object", `${JSON.stringify(raw)} compiles (${String(compiled)})`);
	return compiled as LinkRule;
}

describe("screenPattern", () => {
	it("accepts the patterns a tracker needs", () => {
		for (const pattern of ["#(\\d+)", "\\b[A-Z][A-Z0-9]+-\\d+\\b", "(?:foo|bar)-\\d{1,6}", "[\\w.-]{1,39}/[\\w.-]{1,40}#\\d{1,9}", "(?<![\\w/])#\\d+", "[+*]\\d+", "a{2,5}b+", "(?<key>[A-Z]+)-(?<n>\\d+)", "(?:ab){2}", "(\\d+)?", "(?:v\\d+\\.)?x"]) {
			assert.equal(screenPattern(pattern), null, pattern);
		}
	});

	it("refuses a repeated group that holds a repeat or an alternative, however it is written: the exponential family", () => {
		for (const pattern of ["(a+)+", "(\\d*)*", "(?:a+b)+", "((a+))+", "(x{2,})*", "(a|b+)+", "(?:\\w+\\.)*x", "(a|a)+$", "(a|ab)+c", "(?:a|aa)+b", "(a?){30}a{30}", "(?:foo|bar){2}", "(\\d+){2}", "([a-z]+-){1,3}", "(?:ab|cd)*"]) {
			assert.match(screenPattern(pattern) ?? "", /may only be made optional/, pattern);
		}
	});

	it("refuses back-references and too many repeats, and counts a repeat of any kind", () => {
		assert.match(screenPattern("(a)\\1") ?? "", /back-references/);
		assert.match(screenPattern("(?<n>a)\\k<n>") ?? "", /back-references/);
		for (const pattern of [".*.*.*x", "\\w+\\w+\\w+x", "\\w+\\w+.{1,40}x", ".*.*.{1,40}x", "\\w+.{1,40}\\w+x", ".{1,40}\\w+\\w+x", "\\w+\\w{1,40}\\w{1,40}!", "a{1,30}b{1,30}c{1,30}d{1,30}", "a{1,500}b{1,500}c{1,41}"]) {
			assert.match(screenPattern(pattern) ?? "", /repeats cost too much/, pattern);
		}
		for (const pattern of ["\\w{1,40}\\w{1,40}\\w{1,40}a?a?a?a?a?!", ".*.*a?a?a?a?a?a?x", ".*.*(a|b)?(a|b)?(a|b)?x"]) assert.match(screenPattern(pattern) ?? "", /repeats cost too much/, "an optional counts: " + pattern);
		for (const pattern of ["a+b+", ".*.*x", "\\w+.{1,40}x", "a{1,30}b{1,30}c{1,30}", "[\\w.-]{1,39}/[\\w.-]{1,40}#\\d{1,9}", "a{1,500}b{1,500}"]) assert.equal(screenPattern(pattern), null, pattern);
		for (const pattern of ["(a|a){0000000000000000000041,}", "(?:a|a){0000000000000000000041,}"]) assert.match(screenPattern(pattern) ?? "", /may only be made optional/, "a quantifier is read however long its digits are: " + pattern);
		assert.match(screenPattern("a?b?c?d?e?f?g?h?i?") ?? "", /at most 8 quantifiers/);
		assert.equal(screenPattern("a?b?c?d?e?f?g?h?"), null);
		assert.equal(screenPattern("a{3}b{3}c{3}d{3}"), null, "an exact count is a quantifier but never variable");
	});

	it("ignores quantifier characters inside a class, after an escape and in a group prefix", () => {
		assert.equal(screenPattern("[a+*]+\\+\\*[+]x\\("), null, "a class and an escaped character hold literal quantifier characters");
		assert.equal(screenPattern("(\\))+"), null, "an escaped parenthesis opens no group");
		assert.equal(screenPattern("(?:a)(?=b)(?!c)(?<=d)(?<!e)(?<n>f)"), null, "a group prefix is not a quantifier");
		assert.match(screenPattern("(?:a)(?=b)(?!c)(?<=d)(?<!e)(?<n>f)a?b?c?d?e?f?g?h?i?") ?? "", /at most 8 quantifiers/, "and only the real ones are counted");
	});
});

describe("compileLinkRule", () => {
	it("compiles a rule, counts its groups and keeps its position as the id", () => {
		const compiled = rule(ISSUE, 4);
		assert.equal(compiled.id, 4);
		assert.equal(compiled.groups, 1);
		assert.equal(compiled.name, "Issue");
		assert.equal(compiled.ignoreCase, false);
		assert.equal(compiled.regex.flags, "g");
		assert.equal(rule({ pattern: "ab", url: "https://example.test/", ignoreCase: true }).regex.flags, "gi");
	});

	it("refuses what is not a rule, with the reason", () => {
		const refused = (raw: unknown, expected: RegExp) => assert.match(String(compileLinkRule(raw, 0)), expected, JSON.stringify(raw));
		refused(7, /must be an object/);
		refused({ url: "https://example.test/" }, /pattern must be a non-empty string/);
		refused({ pattern: "", url: "https://example.test/" }, /non-empty/);
		refused({ pattern: "a" }, /url must be a string/);
		refused({ pattern: "(", url: "https://example.test/" }, /not a valid regular expression/);
		refused({ pattern: "x*", url: "https://example.test/" }, /empty text/);
		refused({ pattern: "(a+)+", url: "https://example.test/" }, /may only be made optional/);
		refused({ pattern: "a", url: "https://example.test/", extra: 1 }, /unknown property "extra"/);
		refused({ pattern: "a", url: "https://example.test/", ignoreCase: "yes" }, /ignoreCase/);
		refused({ pattern: "a".repeat(257), url: "https://example.test/" }, /longer than 256/);
		refused({ pattern: "a", url: "https://example.test/", name: "n".repeat(81) }, /name must be/);
	});

	it("refuses a template that could send the click somewhere the user did not name", () => {
		const url = (template: string) => String(compileLinkRule({ pattern: "(a)", url: template }, 0));
		assert.match(url("ftp://example.test/$1"), /http/);
		assert.match(url("javascript:alert($1)"), /http/);
		assert.match(url("/relative/$1"), /http/);
		assert.match(url("https://$1.example.test/"), /host/);
		assert.match(url("https://example.test$1"), /host/, "a placeholder right after the host is still in the host");
		assert.match(url("https://example.test:$1/"), /host/);
		assert.match(url("https://example.test/$2"), /capture group the pattern does not have/);
		assert.match(url("https://example.test/$x"), /not a placeholder/);
		assert.match(url("https:///$1"), /host/, "the URL parser reads the host of https:///x from after the slashes");
		assert.match(url("https://\\\\$1"), /host/);
		assert.match(url("https://example.test\\\\$1"), /host/);
		assert.match(url(`https://example.test/${"a".repeat(1100)}`), /longer than 1024/);
		assert.equal(typeof compileLinkRule({ pattern: "(a)", url: "https://example.test?q=$1#$0" }, 0), "object", "a placeholder in the query or fragment is fine");
	});
});

describe("compileLinkRules", () => {
	it("keeps the position of a rule when an earlier one is refused, and reports each refusal with its position", () => {
		const { rules, problems } = compileLinkRules([{ pattern: "(", url: "https://example.test/" }, ISSUE, "nope"]);
		assert.deepEqual(rules.map(entry => entry.id), [1]);
		assert.deepEqual(problems.map(problem => problem.index), [0, 2]);
	});

	it("treats an unset setting as no rules, and anything but a list as one problem", () => {
		assert.deepEqual(compileLinkRules(undefined), { rules: [], problems: [] });
		assert.deepEqual(compileLinkRules(null), { rules: [], problems: [] });
		assert.deepEqual(compileLinkRules({ pattern: "a" }).rules, []);
		assert.equal(compileLinkRules("a").problems.length, 1);
	});

	it("uses the first rules of a long list and says so once", () => {
		const many = Array.from({ length: MAX_LINK_RULES + 5 }, (_, index) => ({ pattern: `k${index}-\\d+`, url: "https://example.test/$0" }));
		const { rules, problems } = compileLinkRules(many);
		assert.equal(rules.length, MAX_LINK_RULES);
		assert.equal(problems.length, 1);
		assert.match(problems[0]?.message ?? "", /first 20/);
	});

	it("hands the page entries it can compile again, with ids and without the compiled regular expression", () => {
		const entries = linkRuleEntries(compileLinkRules([ISSUE]).rules);
		assert.deepEqual(entries, [{ id: 0, pattern: ISSUE.pattern, url: ISSUE.url, ignoreCase: false, name: "Issue" }]);
		assert.deepEqual(parseLinkRuleEntry(entries[0]), entries[0]);
		assert.equal(typeof compileLinkRule(entries[0], 0), "object", "the entry is a rule the shared compiler accepts");
		assert.equal(parseLinkRuleEntry({ ...entries[0], id: -1 }), null);
		assert.equal(parseLinkRuleEntry({ ...entries[0], pattern: "" }), null);
		assert.equal(parseLinkRuleEntry({ ...entries[0], ignoreCase: 1 }), null);
		assert.equal(parseLinkRuleEntry({ ...entries[0], name: 3 }), null);
		assert.equal(parseLinkRuleEntry("x"), null);
	});
});

describe("buildLinkRuleUrl", () => {
	it("substitutes capture groups, URL-encoded as one component each, and $0 and $$", () => {
		const encoded = rule({ pattern: "(\\w+)/([^\\s]+)", url: "https://example.test/find?who=$1&what=$2&all=$0&cost=$$5" });
		assert.equal(buildLinkRuleUrl(encoded, "a b"), null, "a space ends the match, so the whole text is not one match");
		assert.equal(buildLinkRuleUrl(encoded, "me/x y"), null);
		assert.equal(buildLinkRuleUrl(encoded, "me/q&a=1#frag?"), "https://example.test/find?who=me&what=q%26a%3D1%23frag%3F&all=me%2Fq%26a%3D1%23frag%3F&cost=$5");
		assert.equal(buildLinkRuleUrl(rule(ISSUE), "#42"), "https://example.test/%3Cowner%3E/%3Crepo%3E/issues/42", "a literal angle bracket in the template is encoded by the URL parser");
	});

	it("builds from the text on its own: the whole text must be exactly one match", () => {
		const issue = rule({ pattern: "#(\\d+)", url: "https://example.test/issues/$1" });
		assert.equal(buildLinkRuleUrl(issue, "#42"), "https://example.test/issues/42");
		assert.equal(buildLinkRuleUrl(issue, "x#42"), null);
		assert.equal(buildLinkRuleUrl(issue, "#42 "), null);
		assert.equal(buildLinkRuleUrl(issue, ""), null);
		assert.equal(buildLinkRuleUrl(issue, `#${"1".repeat(MAX_MATCH_LENGTH)}`), null, "longer than the bound");
	});

	it("an optional group that did not take part is empty", () => {
		const optional = rule({ pattern: "ab(c)?", url: "https://example.test/$0/$1" });
		assert.equal(buildLinkRuleUrl(optional, "ab"), "https://example.test/ab/");
	});

	it("never changes the host, whatever the matched text holds", () => {
		const open = rule({ pattern: "go:(\\S+)", url: "https://example.test/$1" });
		for (const hostile of ["go:@evil.test", "go:.evil.test", "go:/\\evil.test", "go:%2F%2Fevil.test", "go:\u0000x", "go:http://evil.test/"]) {
			const built = buildLinkRuleUrl(open, hostile);
			if (built !== null) assert.equal(new URL(built).host, "example.test", hostile);
		}
		assert.equal(buildLinkRuleUrl(open, "go:@evil.test"), "https://example.test/%40evil.test");
	});

	it("honours ignoreCase", () => {
		assert.equal(buildLinkRuleUrl(rule({ pattern: "bug-(\\d+)", url: "https://example.test/$1", ignoreCase: true }), "BUG-7"), "https://example.test/7");
		assert.equal(buildLinkRuleUrl(rule({ pattern: "bug-(\\d+)", url: "https://example.test/$1" }), "BUG-7"), null);
	});
});

describe("findLinkRuleMatches", () => {
	const rules = compileLinkRules([
		{ pattern: "\\bPROJ-(\\d+)\\b", url: "https://example.test/browse/$1", name: "Tracker" },
		{ pattern: "#(\\d+)\\b", url: "https://example.test/issues/$1" },
	]).rules;

	it("finds the matches in order with their exact characters and built URLs", () => {
		const text = "See #12, PROJ-345 and (#9).";
		const found = findLinkRuleMatches(rules, text);
		assert.deepEqual(found.map(match => [text.slice(match.start, match.end), match.url, match.rule.id]), [
			["#12", "https://example.test/issues/12", 1],
			["PROJ-345", "https://example.test/browse/345", 0],
			["#9", "https://example.test/issues/9", 1],
		]);
	});

	it("honours the boundaries the pattern writes and adds none of its own", () => {
		assert.deepEqual(findLinkRuleMatches(rules, "XPROJ-5 PROJ-5X NOPROJ-1").map(match => match.start), []);
		const loose = compileLinkRules([{ pattern: "PROJ-\\d+", url: "https://example.test/$0" }]).rules;
		assert.deepEqual(findLinkRuleMatches(loose, "XPROJ-5 PROJ-5X").map(match => match.start), [1, 8], "without \\b the rule matches inside words");
	});

	it("lets the earlier rule win an overlap, whichever starts first", () => {
		const overlapping = compileLinkRules([
			{ pattern: "ab-\\d+", url: "https://example.test/first/$0" },
			{ pattern: "b-\\d", url: "https://example.test/second/$0" },
			{ pattern: "\\d{2}", url: "https://example.test/third/$0" },
		]).rules;
		const found = findLinkRuleMatches(overlapping, "ab-12 and b-3");
		assert.deepEqual(found.map(match => match.url), ["https://example.test/first/ab-12", "https://example.test/second/b-3"]);
	});

	it("skips empty matches and matches longer than the bound", () => {
		const lookahead = compileLinkRules([{ pattern: "(?<=#)(?=\\d)", url: "https://example.test/" }]).rules;
		assert.deepEqual(findLinkRuleMatches(lookahead, "#1"), []);
		const long = compileLinkRules([{ pattern: "x+", url: "https://example.test/" }]).rules;
		assert.deepEqual(findLinkRuleMatches(long, "x".repeat(MAX_MATCH_LENGTH + 1)), []);
		assert.equal(findLinkRuleMatches(long, "x".repeat(MAX_MATCH_LENGTH)).length, 1);
	});

	it("drops a match that needs the characters around it, because the host re-runs the match on its own", () => {
		const needsContext = compileLinkRules([{ pattern: "#\\d+(?= fixed)", url: "https://example.test/$0" }]).rules;
		assert.deepEqual(findLinkRuleMatches(needsContext, "#5 fixed"), []);
		const lookbehind = compileLinkRules([{ pattern: "(?<![\\w/])#(\\d+)", url: "https://example.test/$1" }]).rules;
		assert.deepEqual(findLinkRuleMatches(lookbehind, "a/#5 b #6").map(match => match.start), [7], "a lookbehind that holds on its own is honoured in the text");
	});

	it("stops at the match limit and reads at most the first 2000 characters, in pieces cut at whitespace", () => {
		const issue = compileLinkRules([{ pattern: "#\\d+", url: "https://example.test/$0" }]).rules;
		assert.equal(findLinkRuleMatches(issue, Array.from({ length: 100 }, (_, index) => `#${index}`).join(" ")).length, MAX_MATCHES_PER_TEXT);
		const words = "word ".repeat(380);
		assert.deepEqual(findLinkRuleMatches(issue, `#1 ${words}#2 ${words}#3`).map(match => match.start), [0, 3 + words.length], "the third is past 2000 characters");
		const across = "x".repeat(496) + " ".repeat(1) + "#12 " + "y".repeat(20) + " #34";
		assert.deepEqual(findLinkRuleMatches(issue, across).map(match => across.slice(match.start, match.end)), ["#12", "#34"], "a match is whole wherever a piece is cut at whitespace");
		const word = "z".repeat(MAX_SCANNED_TEXT);
		assert.deepEqual(findLinkRuleMatches(compileLinkRules([{ pattern: "z{1,40}", url: "https://example.test/$0" }]).rules, word).length, MAX_MATCHES_PER_TEXT);
		const softCut = "a".repeat(499) + " #123";
		assert.deepEqual(findLinkRuleMatches(compileLinkRules([{ pattern: "\\s#(\\d+)", url: "https://example.test/$1" }]).rules, softCut).map(match => softCut.slice(match.start, match.end)), [" #123"], "the whitespace a piece is cut at belongs to the next piece");
		const hard = "z".repeat(498) + "#12345 tail";
		assert.deepEqual(findLinkRuleMatches(issue, hard), [], "a match a cut in the middle of a word would shorten is dropped, not linked short");
	});

	it("finds nothing without rules or text", () => {
		assert.deepEqual(findLinkRuleMatches([], "#1"), []);
		assert.deepEqual(findLinkRuleMatches(rules, ""), []);
	});

	it("is repeatable: scanning leaves no state in the compiled rule", () => {
		const first = findLinkRuleMatches(rules, "#1 #2");
		assert.deepEqual(findLinkRuleMatches(rules, "#1 #2"), first);
	});
});

describe("unpaired surrogates", () => {
	it("never throw, in a URL or in a target: a reply may hold one and a render must not fail", () => {
		const any = rule({ pattern: "k:.+", url: "https://example.test/$0" });
		const text = "k:a\uD800b\uDC00c";
		assert.equal(buildLinkRuleUrl(any, text), "https://example.test/k%3Aa%EF%BF%BDb%EF%BF%BDc");
		assert.equal(findLinkRuleMatches([any], `see ${text}`).length, 1);
		assert.equal(linkRuleTarget(0, text), "link-rule://0/k%3Aa%EF%BF%BDb%EF%BF%BDc");
		assert.equal(buildLinkRuleUrl(any, "k:\uD83D\uDE00"), "https://example.test/k%3A%F0%9F%98%80", "a pair is kept");
	});
});

describe("matchWholeLinkRule", () => {
	const rules = compileLinkRules([{ pattern: "PROJ-(\\d+)", url: "https://example.test/$1" }]).rules;
	it("matches a code span only when the rule matches all of it, whitespace around it aside", () => {
		assert.deepEqual(matchWholeLinkRule(rules, " PROJ-7 "), { rule: rules[0], text: "PROJ-7", url: "https://example.test/7" });
		assert.equal(matchWholeLinkRule(rules, "see PROJ-7"), null);
		assert.equal(matchWholeLinkRule(rules, "PROJ-7()"), null);
		assert.equal(matchWholeLinkRule(rules, "  "), null);
	});
});

describe("the click target", () => {
	it("carries a rule position and the matched characters, and nothing else", () => {
		const target = linkRuleTarget(3, "a b/é#1");
		assert.equal(target, "link-rule://3/a%20b%2F%C3%A9%231");
		assert.deepEqual(parseLinkRuleTarget(target), { id: 3, text: "a b/é#1" });
	});

	it("refuses every other string, a bad escape, an empty text and an oversize one", () => {
		for (const target of ["https://example.test/", "commit://abcdef1", "link-rule://x/1", "link-rule://3/", "link-rule://3", "link-rule://3/%E0%A4%A", "link-rule://1000/a", "link-rule://-1/a", `link-rule://1/${"a".repeat(MAX_MATCH_LENGTH + 1)}`]) {
			assert.equal(parseLinkRuleTarget(target), null, target);
		}
	});
});

describe("linkRuleTitle", () => {
	it("shows the name when there is one, always the URL, and what the click does", () => {
		assert.equal(linkRuleTitle({ name: "Issue" }, "https://example.test/1"), "Issue\nhttps://example.test/1\nOpen in editor · Ctrl+Click to open in browser");
		assert.equal(linkRuleTitle({ name: null }, "https://example.test/1"), "https://example.test/1\nOpen in editor · Ctrl+Click to open in browser");
	});
});
