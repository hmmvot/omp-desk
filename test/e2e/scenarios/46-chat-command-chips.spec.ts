/**
 * Scenario: a command and a skill that the draft names are one chip each, in a real window against a real `omp`
 * (docs/designs/2026-10-18-composer-command-skill-chips.md). The catalogue is the one OMP advertises over `rpc-ui`
 * (skills as `skill:<name>`, `source: "skill"`), so this is the check that the real wire shape reaches the chip scan, which
 * the page tests only exercise with a recorded copy of that payload.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FrameLocator, Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";
import { SKILL_NAME } from "../support/fixtures-constants.ts";

const chips = (chat: FrameLocator): Locator => chat.locator(".omp-composer-input .omp-chip[data-kind]");

test("a skill and a command typed or picked in a real Chat are chips, and Backspace removes one whole", async ({ desk }) => {
	test.setTimeout(240_000);
	const page = await desk.window("alpha-desk");
	await desk.ready(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const box = desk.composer(chat);
	const draft = () => desk.readDraft(box);

	await box.click();
	await box.pressSequentially("/compact ");
	await expect(chips(chat)).toHaveCount(1, { timeout: 30_000 });
	await expect(chips(chat).first()).toHaveAttribute("data-kind", "command");

	await box.press("Backspace");
	await expect.poll(draft).toBe("");
	await expect(chips(chat)).toHaveCount(0);

	// Typed by hand.
	await box.pressSequentially(`/skill:${SKILL_NAME} `);
	await expect(chips(chat), `the real catalogue lists /skill:${SKILL_NAME}; the draft is ${JSON.stringify(await draft())}`).toHaveCount(1, { timeout: 30_000 });
	await expect(chips(chat).first()).toHaveAttribute("data-kind", "skill");
	await box.press("Backspace");
	await expect.poll(draft).toBe("");

	// Picked from the suggestions.
	await box.pressSequentially("/skill:e2e-fix");
	const option = chat.locator("[role=option]").filter({ hasText: SKILL_NAME }).first();
	await expect(option).toBeVisible({ timeout: 30_000 });
	await box.press("Tab");
	await expect.poll(draft).toBe(`/skill:${SKILL_NAME} `);
	await expect(chips(chat)).toHaveCount(1);
	await expect(chips(chat).first()).toHaveAttribute("data-kind", "skill");

	// Picked with Enter and with the mouse.
	await box.press("Control+a");
	await box.press("Delete");
	await expect.poll(draft).toBe("");
	await box.pressSequentially("/skill:e2e-fix");
	await expect(option).toBeVisible({ timeout: 30_000 });
	await box.press("Enter");
	await expect.poll(draft).toBe(`/skill:${SKILL_NAME} `);
	await expect(chips(chat), "picked with Enter").toHaveCount(1);
	await box.press("Backspace");
	await expect.poll(draft).toBe("");
	await box.pressSequentially("/skill:e2e-fix");
	await expect(option).toBeVisible({ timeout: 30_000 });
	await option.click();
	await expect.poll(draft).toBe(`/skill:${SKILL_NAME} `);
	await expect(chips(chat), "picked with the mouse").toHaveCount(1);
	await box.press("Backspace");
	await expect.poll(draft).toBe("");

	// What the user sees: the chip in the real theme (E2E_SHOTS_DIR receives the picture).
	const shots = process.env.E2E_SHOTS_DIR;
	if (shots) {
		await mkdir(shots, { recursive: true });
		await box.pressSequentially("review the changes");
		await box.screenshot({ path: join(shots, "chat-command-chip-skill.png") });
	}
});

/** The model-visible user text of every request the mock has seen. */
async function modelPrompts(mockUrl: string): Promise<string[]> {
	const requests: { fullUserText: string }[] = await (await fetch(`${mockUrl}/__requests`)).json();
	return requests.map(request => request.fullUserText);
}

test("a skill sent while a turn runs is expanded by OMP, steered or queued as a follow-up, and is drawn as a chip meanwhile", async ({ desk, state }) => {
	test.setTimeout(300_000);
	const page = await desk.window("alpha-desk");
	await desk.ready(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const stop = chat.getByRole("button", { name: "Stop the running turn" });
	for (const [how, send] of [["steer", "Enter"], ["follow-up", "Alt+Enter"]] as const) {
		const marker = `${how}-${Date.now().toString(36)}`;
		await desk.send(chat, `[slow] ${marker} ${"streaming ".repeat(40)}`);
		await expect(stop, "a turn is running").toBeVisible({ timeout: 60_000 });
		const busy = desk.composerWhileBusy(chat);
		await busy.click();
		await busy.pressSequentially(`/skill:${SKILL_NAME} ${marker}`);
		await expect(chips(chat), "the skill is a chip during the turn").toHaveCount(1, { timeout: 30_000 });
		await expect(chips(chat).first()).toHaveAttribute("data-kind", "skill");
		await busy.press(send);
		// The model receives the skill's body, not the literal token.
		await expect.poll(async () => (await modelPrompts(state.mockUrl)).some(text => text.includes("Nothing to do.") && text.includes(marker)), { timeout: 150_000, message: `the ${how}'s skill was expanded` }).toBe(true);
		await expect(chat.locator(".omp-native-skill").filter({ hasText: marker }), "the transcript shows a skill row").toHaveCount(1, { timeout: 60_000 });
		const literal = (await modelPrompts(state.mockUrl)).filter(text => text.trimStart().startsWith(`/skill:${SKILL_NAME} ${marker}`));
		expect(literal, "no request carries the literal token as its message").toEqual([]);
		await expect(stop, "the turns end").toHaveCount(0, { timeout: 150_000 });
	}
});

test("OMP's commands sent while a turn runs are run by OMP as in its terminal UI: /export writes its file, /compact compacts the conversation, and both are chips meanwhile", async ({ desk, state }) => {
	test.setTimeout(300_000);
	const page = await desk.window("alpha-desk");
	await desk.ready(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	await desk.send(chat, "first warmup");
	await expect(chat.getByText("Mock reply to: first warmup")).toBeVisible({ timeout: 60_000 });
	// Distinct words: OMP's loop guard interrupts a turn that repeats itself.
	const words = Array.from({ length: 200 }, (_, i) => `w${i * 7919 % 1000}`).join(" ");
	const stop = chat.getByRole("button", { name: "Stop the running turn" });

	await desk.send(chat, `[slow] export ${words}`);
	await expect(stop, "a turn is running").toBeVisible({ timeout: 60_000 });
	const busy = desk.composerWhileBusy(chat);
	await busy.click();
	await busy.pressSequentially("/export mid-turn.html");
	await expect(chips(chat), "the command is a chip during the turn").toHaveCount(1, { timeout: 30_000 });
	await expect(chips(chat).first()).toHaveAttribute("data-kind", "command");
	await busy.press("Enter");
	await expect(chat.getByText("Session exported to: mid-turn.html"), "OMP ran /export at once").toBeVisible({ timeout: 60_000 });
	expect(existsSync(join(state.base, "ws", "alpha-desk", "mid-turn.html")), "the export file exists").toBe(true);
	await expect(stop, "the turn ended on its own").toHaveCount(0, { timeout: 150_000 });

	await desk.send(chat, `[slow] compact ${words}`);
	await expect(stop, "a turn is running").toBeVisible({ timeout: 60_000 });
	await busy.click();
	await busy.pressSequentially("/compact keep the notes");
	await expect(chips(chat)).toHaveCount(1, { timeout: 30_000 });
	await busy.press("Enter");
	await expect.poll(async () => (await modelPrompts(state.mockUrl)).some(text => text.startsWith("Resume the user's latest intent")), { timeout: 150_000, message: "/compact compacted the conversation and resumed the turn" }).toBe(true);
	const literal = (await modelPrompts(state.mockUrl)).filter(text => text.trimStart().startsWith("/compact keep the notes") || text.trimStart().startsWith("/export mid-turn.html"));
	expect(literal, "no request carries a command as its message").toEqual([]);
	await expect(stop, "the turns end").toHaveCount(0, { timeout: 150_000 });
});
