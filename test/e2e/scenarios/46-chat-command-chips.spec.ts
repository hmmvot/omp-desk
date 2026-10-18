/**
 * Scenario: a command and a skill that the draft names are one chip each, in a real window against a real `omp`
 * (docs/designs/2026-10-18-composer-command-skill-chips.md). The catalogue is the one OMP advertises over `rpc-ui`
 * (skills as `skill:<name>`, `source: "skill"`), so this is the check that the real wire shape reaches the chip scan, which
 * the page tests only exercise with a recorded copy of that payload.
 */
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
