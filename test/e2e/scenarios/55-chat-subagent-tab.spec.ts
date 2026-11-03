/**
 * Scenario: a running subagent in the HUD Agents row and in its own tab (docs/designs/2026-11-03-agent-model-and-steady-tab.md).
 * A real `omp` on the mock model spawns a subagent (the mock's `[agent:<name>]` marker); the subagent works in ten blocking `bash`
 * calls of four seconds, so it stays running for 40 s and its transcript grows. The HUD row and the agent's tab name the model and
 * the thinking level it runs on, and over 20 s of work the tab's header, toolbar and rows are not rebuilt: the Refresh button is never
 * disabled for a background read, the body is never marked busy, and the nodes drawn at the start are the nodes at the end. When the
 * agent has finished, the tab shows its last words.
 */
import type { Frame, Page } from "@playwright/test";
import { SUBAGENT_WORK_MS } from "../fixtures/mock-openai-server.ts";
import { writeMockAgentConfig } from "../support/omp-agent.ts";
import { expect, test } from "../support/fixtures.ts";
import { sleep } from "../support/time.ts";

const REASONER = "mock-reasoner";

/** The webview frame of the agent tab: it opens beside the Chat, so both are visible and the one that holds the tab's document is looked for. */
async function agentTabFrame(page: Page, timeout = 30_000): Promise<Frame> {
	const deadline = Date.now() + timeout;
	for (;;) {
		for (const frame of page.frames()) {
			if (frame.url().startsWith("vscode-webview") && await frame.locator(".omp-detail--agent").count().catch(() => 0) > 0) return frame;
		}
		if (Date.now() > deadline) throw new Error("the agent tab's document did not appear");
		await sleep(250);
	}
}

test("a running subagent shows its model and thinking level in the HUD row and its tab, and the tab does not blink", async ({ desk, state }) => {
	test.setTimeout(300_000);
	expect(SUBAGENT_WORK_MS).toBeGreaterThan(30_000);
	// A reasoning model, so the subagent has a thinking level to show; OMP reads the files when the session's process starts. Restored below for the scenarios that follow.
	await writeMockAgentConfig(state.agentDir, state.mockUrl, { modelId: REASONER, modelName: "Mock Reasoner", reasoning: true, extraConfig: ["defaultThinkingLevel: high"] });
	try {
		const page = await desk.window("alpha-desk");
		await desk.ready(page);
		const chat = await desk.newChatSession(page, "alpha-desk", 120_000);
		await desk.send(chat, "spawn [agent:Prober]");

		// The HUD row names the model and the level.
		const agents = chat.locator("section.omp-hud--agents");
		await expect(agents).toBeVisible({ timeout: 120_000 });
		const toggle = agents.locator(".omp-hud-toggle");
		if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
		const row = agents.locator(".omp-hud-agent").first();
		const chip = row.locator(".omp-hud-model");
		await expect(chip).toHaveText(new RegExp(`^mock/${REASONER} · \\S+$`), { timeout: 60_000 });
		const shown = (await chip.textContent()) ?? "";
		const level = shown.split(" · ")[1] ?? "";
		await expect(row).toHaveAttribute("title", new RegExp(`Model: mock/${REASONER}\\nThinking: ${level}`));

		// The agent's own tab says the same beside its status.
		await row.click();
		const tab = await agentTabFrame(page);
		const tabChip = tab.locator(".omp-detail-title .omp-detail-model");
		await expect(tabChip).toHaveText(shown, { timeout: 30_000 });
		await expect(tabChip).toHaveAttribute("title", `Model: mock/${REASONER}\nThinking: ${level}`);
		await expect(tab.locator(".omp-native-child-body .omp-measured-rows")).toBeVisible({ timeout: 30_000 });
		await expect(tab.locator(".omp-native-child-body")).toHaveAttribute("aria-busy", "false");
		await sleep(5_000);

		// Over 20 s of work: the nodes the tab drew stay, and the toolbar and the header are never touched.
		await tab.locator("body").evaluate(() => {
			const body = document.querySelector(".omp-native-child-body");
			const header = document.querySelector(".omp-detail-agent-head");
			const toolbar = document.querySelector(".omp-native-child-toolbar");
			const rows = document.querySelector(".omp-native-child-body .omp-measured-rows");
			const firstRow = rows?.firstElementChild ?? null;
			if (body === null || header === null || toolbar === null || firstRow === null) throw new Error("the agent tab is not drawn yet");
			const kept = { body, header, toolbar, rows, firstRow, title: header.querySelector(".omp-detail-title"), refresh: toolbar.querySelector("button") };
			const touched: string[] = [];
			new MutationObserver(records => {
				for (const record of records) {
					if (record.type === "attributes" && record.target instanceof Element && (toolbar.contains(record.target) || record.target === body)) touched.push(`${record.attributeName} on ${record.target.tagName.toLowerCase()}.${record.target.className}`);
					if (record.type === "childList" && record.target instanceof Node && (toolbar.contains(record.target) || record.target === body || record.target === header || record.target === kept.title)) touched.push(`children of ${record.target.nodeName.toLowerCase()}`);
				}
			}).observe(document, { subtree: true, childList: true, attributes: true });
			Reflect.set(window, "__kept", kept);
			Reflect.set(window, "__touched", touched);
		});
		await sleep(20_000);
		const verdict = await tab.locator("body").evaluate(() => {
			const kept = Reflect.get(window, "__kept");
			return {
				touched: Reflect.get(window, "__touched"),
				body: kept.body === document.querySelector(".omp-native-child-body"),
				header: kept.header === document.querySelector(".omp-detail-agent-head"),
				toolbar: kept.toolbar === document.querySelector(".omp-native-child-toolbar"),
				refresh: kept.refresh === document.querySelector(".omp-native-child-toolbar button"),
				rows: kept.rows === document.querySelector(".omp-native-child-body .omp-measured-rows"),
				firstRow: kept.firstRow.isConnected,
				grew: document.querySelectorAll(".omp-native-child-body .omp-measured-rows > *").length,
			};
		});
		expect(verdict.touched, "no busy state, disabled button or rebuilt header/toolbar between real updates").toEqual([]);
		expect(verdict, "the nodes drawn before are the nodes after").toMatchObject({ body: true, header: true, toolbar: true, refresh: true, rows: true, firstRow: true });

		// The agent finishes: the tab says so and shows what it wrote last.
		await expect(tab.locator(".omp-detail-title .omp-detail-status")).toHaveText("no longer in the native registry", { timeout: SUBAGENT_WORK_MS });
		await expect(tab.locator(".omp-native-child-body")).toContainText("Probe finished.", { timeout: 30_000 });
		await expect(tab.locator(".omp-detail-title .omp-detail-model")).toHaveText(shown);
	} finally {
		await writeMockAgentConfig(state.agentDir, state.mockUrl);
	}
});
