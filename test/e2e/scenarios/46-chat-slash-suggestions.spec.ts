/**
 * Scenario: the `/` suggestions typed key by key in a real Chat at idle, against the catalogue a real `omp` advertises
 * (docs/designs/2026-10-18-composer-command-skill-chips.md, second amendment of 2026-10-19). `report` is a prompt-template file
 * command (source `file`) and `reload-plugins` an OMP builtin, so this is the check that the list stays open at the full name
 * of each, with the exact entry selected and first, and that the full name is a chip without a space.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FrameLocator, Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures.ts";

const chips = (chat: FrameLocator): Locator => chat.locator(".omp-composer-input .omp-chip[data-kind]");
const options = (chat: FrameLocator): Locator => chat.getByRole("listbox", { name: "Slash commands" }).getByRole("option");

test("a typed /report (a file command) and /reload (OMP's /reload-plugins) keep the list open at every length and the full name is a chip", async ({ desk, state }) => {
	test.setTimeout(240_000);
	const commands = join(state.base, "ws", "alpha-desk", ".omp", "commands");
	await mkdir(commands, { recursive: true });
	await writeFile(join(commands, "report.md"), "---\ndescription: Pause, report progress and next step, then resume the work\n---\nReport progress now.\n");
	const page = await desk.window("alpha-desk");
	await desk.ready(page);
	const chat = await desk.newChatSession(page, "alpha-desk");
	const box = desk.composer(chat);
	const draft = () => desk.readDraft(box);

	await box.click();
	await box.pressSequentially("/r");
	await expect(options(chat).first(), "the list opens").toBeVisible({ timeout: 30_000 });
	await expect(options(chat).filter({ hasText: "/report" }).first(), "the real catalogue lists the file command").toBeVisible({ timeout: 30_000 });
	for (const char of "eport") {
		await box.pressSequentially(char);
		await expect(options(chat).first(), `the list is open after ${JSON.stringify(await draft())}`).toBeVisible();
	}
	await expect.poll(draft).toBe("/report");
	await expect(chips(chat), "the full name is a chip without a space").toHaveCount(1, { timeout: 30_000 });
	await expect(options(chat).first()).toContainText("/report");
	await expect(chat.getByRole("listbox", { name: "Slash commands" }).locator("[aria-selected=true]")).toHaveCount(1);
	await expect(chat.getByRole("listbox", { name: "Slash commands" }).locator("[aria-selected=true]")).toContainText("/report");

	// One more character is text again and the list follows the longer query; deleting it brings the chip back.
	await box.pressSequentially("x");
	await expect(chips(chat)).toHaveCount(0);
	await box.press("Backspace");
	await expect.poll(draft).toBe("/report");
	await expect(chips(chat)).toHaveCount(1);
	await expect(options(chat).first()).toBeVisible();
	await box.press("Backspace");
	await expect.poll(draft).toBe("/repor");
	await expect(chips(chat)).toHaveCount(0);
	await expect(options(chat).first()).toBeVisible();

	await box.press("Control+a");
	await box.press("Delete");
	await expect.poll(draft).toBe("");
	await box.pressSequentially("/relo");
	await expect(options(chat).filter({ hasText: "/reload-plugins" }).first(), "OMP's /reload-plugins is listed for /relo").toBeVisible({ timeout: 30_000 });
	for (const char of "ad") {
		await box.pressSequentially(char);
		await expect(options(chat).filter({ hasText: "/reload-plugins" }).first(), `/reload-plugins is listed after ${JSON.stringify(await draft())}`).toBeVisible();
	}
});
