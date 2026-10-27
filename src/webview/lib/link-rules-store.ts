/**
 * The page's copy of the user's link rules (`omp:chat-link-rules`, `docs/designs/2026-10-27-chat-link-rules.md`).
 *
 * Module-level, like `key-hints-store.ts`: the host posts the message as soon as it has seen the page's announcement, which can be
 * before React has mounted, so `attachLinkRules` runs in `main.tsx` before `omp:ready`. Markdown detects rule links while it parses, so
 * it reads {@link currentLinkRules} and re-parses when {@link useLinkRulesVersion} changes. Every rule is compiled here again from
 * the entry the host sent: a rule that does not pass the shared checks is dropped, whatever the host said.
 */
import { useSyncExternalStore } from "react";
import { compileLinkRule, MAX_LINK_RULES } from "../../shared/link-rules.ts";
import type { LinkRule, LinkRuleEntry } from "../../shared/link-rules.ts";
import type { GuestHostMessage } from "../../protocol/messages.ts";

interface LinkRulesTransport {
	subscribe(listener: (message: GuestHostMessage) => void): () => void;
}

const NONE: readonly LinkRule[] = [];
const listeners = new Set<() => void>();
let rules: readonly LinkRule[] = NONE;
let signature = "[]";
let version = 0;
let detach: (() => void) | null = null;

/** Replace the rules (tests and the transport share this one path); the same content changes nothing. */
export function setLinkRules(entries: readonly LinkRuleEntry[]): void {
	const next = entries.slice(0, MAX_LINK_RULES);
	const key = JSON.stringify(next);
	if (key === signature) return;
	signature = key;
	const compiled: LinkRule[] = [];
	for (const entry of next) {
		const rule = compileLinkRule(entry, entry.id);
		if (typeof rule !== "string") compiled.push(rule);
	}
	rules = compiled.length === 0 ? NONE : compiled;
	version++;
	for (const listener of [...listeners]) listener();
}

export function attachLinkRules(transport: LinkRulesTransport): void {
	detach?.();
	detach = transport.subscribe(message => {
		if (message.type === "omp:chat-link-rules") setLinkRules(message.rules);
	});
}

/** The rules in force now; the same array until they change. */
export function currentLinkRules(): readonly LinkRule[] {
	return rules;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/** A number that changes whenever the rules do, for what is derived from them at parse time. */
export function useLinkRulesVersion(): number {
	return useSyncExternalStore(subscribe, () => version, () => version);
}
