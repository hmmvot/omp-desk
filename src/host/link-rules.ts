/**
 * The window's user-defined link rules (`docs/designs/2026-10-27-chat-link-rules.md`): the compiled rules of the user's own setting, and the
 * open of a clicked rule link. Pure: the setting's value, the problem report and the browser arrive as dependencies
 * (`wiring/link-rules.ts` reads the real ones).
 *
 * A click carries a rule position and the matched characters. The rule is looked up in the host's own current rules and run again on
 * those characters, and the URL is built here; a URL is never taken from the page.
 */
import { buildLinkRuleUrl, compileLinkRules, linkRuleEntries, parseLinkRuleTarget } from "../shared/link-rules.ts";
import type { LinkRule, LinkRuleEntry, LinkRuleProblem } from "../shared/link-rules.ts";
import type { TerminalLinkRequest, WebLinkMode } from "../shared/terminal-links.ts";

export interface LinkRulesSnapshot {
	readonly rules: readonly LinkRule[];
	/** What the pages are sent. */
	readonly entries: readonly LinkRuleEntry[];
}

export interface LinkRuleSource {
	/** The rules of the setting as it is now; the setting is read and, when it changed, compiled and its problems reported (once per distinct value). */
	current(): LinkRulesSnapshot;
}

export interface LinkRuleSourceDeps {
	/** The setting's value from the user's own settings only; `undefined` when unset. */
	readonly read: () => unknown;
	/** Called once for each distinct value of the setting that holds refused rules. */
	readonly report: (problems: readonly LinkRuleProblem[]) => void;
}

export function createLinkRuleSource(deps: LinkRuleSourceDeps): LinkRuleSource {
	let signature: string | null = null;
	let snapshot: LinkRulesSnapshot = { rules: [], entries: [] };
	return {
		current() {
			const raw = deps.read();
			let next: string;
			try { next = JSON.stringify(raw) ?? "undefined"; }
			catch { next = "unserializable"; }
			if (next === signature) return snapshot;
			signature = next;
			const { rules, problems } = compileLinkRules(raw);
			snapshot = { rules, entries: linkRuleEntries(rules) };
			if (problems.length > 0) deps.report(problems);
			return snapshot;
		},
	};
}

/** The sentence for the log and for the one notice about refused rules; rule numbers count from 1 as the user reads the list. */
export function describeLinkRuleProblems(problems: readonly LinkRuleProblem[]): string {
	return problems.map(problem => `rule ${problem.index + 1}: ${problem.message}`).join("; ");
}

export interface LinkRuleOpenHost {
	/** Whether the page that asked is still the document this host answers (the same check every link open makes). */
	readonly isCurrent: () => boolean;
	/** Opens an `http(s)` URL the host built: in an editor tab (`editor`, a plain click) or the external browser (`external`, Ctrl+Click). */
	readonly openUrl: (url: string, mode: WebLinkMode) => Promise<void>;
	readonly warn: (message: string) => void;
}

/**
 * Open the rule link a page's click named: `request.target` is `link-rule://<position>/<matched characters>`. Returns whether the target
 * was a rule target at all (any other request is for another handler). A rule that is gone, or no longer matches exactly the
 * characters, opens nothing and says so.
 */
export async function handleLinkRuleOpen(request: TerminalLinkRequest, source: LinkRuleSource, host: LinkRuleOpenHost): Promise<boolean> {
	const target = parseLinkRuleTarget(request.target);
	if (target === null) return false;
	if (request.type !== "omp:terminal-link-open") return true;
	const rule = source.current().rules.find(candidate => candidate.id === target.id);
	const url = rule === undefined ? null : buildLinkRuleUrl(rule, target.text);
	if (url === null) {
		host.warn("This text no longer matches a link rule of ompDesk.chatLinkRules, so nothing was opened.");
		return true;
	}
	if (!host.isCurrent()) return true;
	await host.openUrl(url, request.mode ?? "editor");
	return true;
}
