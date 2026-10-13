import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuestHostMessage } from "../../protocol/messages.ts";
import { attachCodeTheme, codeThemeSnapshot, setCodeThemes, subscribeCodeTheme } from "./code-theme-store.ts";

const DARK = { id: "Dark Modern", rules: [{ scopes: ["string"], foreground: "#CE9178" }] };
const LIGHT = { id: "Light Modern", rules: [{ scopes: ["string"], foreground: "#A31515" }] };

test("the page colours code only with themes it validated, and tells its listeners when the active one changes", () => {
	let heard = 0;
	const stop = subscribeCodeTheme(() => heard++);
	assert.equal(codeThemeSnapshot().styler, null);
	setCodeThemes([DARK, LIGHT]);
	assert.equal(codeThemeSnapshot().theme?.id, "Dark Modern", "without a theme id on the page the first candidate is used");
	assert.equal(codeThemeSnapshot().styler?.styleOf(["string.quoted"]).color, "#CE9178");
	setCodeThemes([DARK, LIGHT]);
	assert.equal(heard, 1, "the same themes again change nothing");
	setCodeThemes([{ id: "Broken", rules: [{ scopes: ["string"], foreground: "red" }] }]);
	assert.equal(codeThemeSnapshot().styler, null, "a message that fails validation is no theme");
	setCodeThemes([LIGHT]);
	assert.equal(codeThemeSnapshot().theme?.id, "Light Modern");
	setCodeThemes([]);
	assert.equal(codeThemeSnapshot().styler, null);
	assert.equal(heard, 4);
	stop();
	setCodeThemes([DARK]);
	assert.equal(heard, 4, "an unsubscribed listener hears nothing");
	setCodeThemes([]);
});

test("the host's omp:chat-code-theme message replaces the candidates and nothing else does", () => {
	let listener: ((message: GuestHostMessage) => void) | null = null;
	attachCodeTheme({ subscribe(next) { listener = next; return () => { listener = null; }; } });
	assert.ok(listener !== null);
	const send = listener as (message: GuestHostMessage) => void;
	send({ type: "omp:chat-code-theme", themes: [DARK] });
	assert.equal(codeThemeSnapshot().theme?.id, "Dark Modern");
	send({ type: "omp:chat-code-theme", themes: [] });
	assert.equal(codeThemeSnapshot().theme, null);
});
