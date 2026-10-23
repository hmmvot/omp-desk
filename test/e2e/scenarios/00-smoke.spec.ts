/**
 * The wiring proof: Playwright locators work on the workbench (Sessions tree, view title actions), inside the nested
 * Chat webview and the Settings webview view, and a Chat turn is answered by the local mock model with no provider key.
 */
import { expect, test } from "../support/fixtures.ts";

test("workbench trees, the nested Chat webview and the mock model work through one CDP connection", async ({ desk, state }) => {
	const page = await desk.window("alpha-desk");
	await desk.ready(page);

	const tree = await desk.sessionsTree(page);
	await expect(tree).toMatchAriaSnapshot(`
		- tree "Sessions":
		  - treeitem /New Session/
		  - treeitem /Resume Session/
	`);
	// View title actions are only rendered while the view header is hovered.
	const sidebar = page.locator("[id='workbench.parts.sidebar']");
	await sidebar.getByRole("button", { name: "Sessions Section" }).hover();
	await expect(sidebar.getByRole("button", { name: /Sessions Layout/ })).toBeVisible();

	const chat = await desk.newChatSession(page, "alpha-desk");
	await expect(chat.getByRole("button", { name: "Mock Model" })).toBeVisible();
	await desk.send(chat, "hello there");
	await expect(chat.getByText("Mock reply to: hello there")).toBeVisible();
	await expect(chat.locator("body")).toMatchAriaSnapshot(`
		- region "Conversation transcript":
		  - paragraph: hello there
		  - paragraph: "Mock reply to: hello there"
	`);
	const requests: { lastUserText: string }[] = await (await fetch(`${state.mockUrl}/__requests`)).json();
	expect(requests.some(request => request.lastUserText === "hello there")).toBe(true);

	// A Settings webview *view* of the side bar, one more nested iframe, lists the extension's own settings. It is collapsed
	// again afterwards: an expanded view keeps taking the Sessions list's room for every later scenario.
	const settingsHeader = sidebar.getByRole("button", { name: /^Settings/ });
	await settingsHeader.click();
	const settings = desk.sidebarWebview(page);
	await expect(settings.getByRole("searchbox", { name: "Search settings" })).toBeVisible();
	await expect(settings.getByRole("article", { name: "Tool Call Detail" })).toBeVisible();
	await expect(settings.getByRole("combobox", { name: "Tool Call Detail" }).locator("option:checked")).toHaveText("overview");
	await settingsHeader.click();
	await expect(settingsHeader).toHaveAttribute("aria-expanded", "false");
});
