/**
 * What VS Code's updater does to a running Chat, on a scratch copy of VS Code (ADR-0074).
 *
 * "Restart to Update" runs Inno Updater, which selects every process named `Code.exe` whose full image path is the install's
 * `Code.exe` and terminates it (microsoft/inno-updater, `process.rs`), after renaming `Code.exe` while it runs.
 * `test/e2e/tools/updater-emulator.ps1` does the same selection and kill against E2E_VSCODE_DIR, a SCRATCH COPY of VS Code
 * (never the everyday install: the real updater is not run and nothing here touches the user's VS Code).
 *
 * E2E_EXPECT_BROKER=bun (default): the Chat's broker is the `bun.exe` of its OMP, so the kill leaves the broker and the OMP
 * child alive and a reopened window re-adopts the same processes and transcript.
 * E2E_EXPECT_BROKER=code: `ompDesk.chatBrokerRuntime` is set to `vscode`, the broker is a `Code.exe`, the kill ends it and
 * the OMP child with it, and the session row is still there, stopped.
 */
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Desk } from "../support/desk.ts";
import { REPO_ROOT, startVsCode, waitForCdp } from "../support/launcher.ts";
import { pidAlive, recordedSession } from "../support/records.ts";
import { readState } from "../support/state.ts";
import { sleep } from "../support/time.ts";

const CODE_DIR = process.env.E2E_VSCODE_DIR;
const SCRIPT = resolve(REPO_ROOT, "test", "e2e", "tools", "updater-emulator.ps1");
const EXPECT = process.env.E2E_EXPECT_BROKER === "code" ? "code" : "bun";
const SURVIVE = EXPECT === "bun";

function updater(...args: string[]): string {
	const run = spawnSync("powershell.exe", ["-NoProfile", "-File", SCRIPT, "-CodePath", join(CODE_DIR as string, "Code.exe"), ...args], { encoding: "utf8", windowsHide: true });
	return `${run.stdout}${run.stderr}`.trim();
}

function imageOf(pid: number): string {
	return spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).Path`], { encoding: "utf8", windowsHide: true }).stdout.trim();
}

test.skip(CODE_DIR === undefined, "needs E2E_VSCODE_DIR, a scratch copy of VS Code (the updater is emulated against it, never the everyday install)");

test(`an emulated updater kill of the install's Code.exe processes: a ${EXPECT}-hosted Chat ${SURVIVE ? "survives and is re-adopted" : "ends and its row stays, stopped"}`, async () => {
	test.setTimeout(480_000);
	const state = readState();
	if (!SURVIVE) {
		const settings = join(state.dataDir, "User", "settings.json");
		const current = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
		current["ompDesk.chatBrokerRuntime"] = "vscode";
		writeFileSync(settings, JSON.stringify(current, null, "\t"));
	}
	const desk = await Desk.connect(state);
	const before = await desk.window("alpha-desk");
	await desk.ready(before);
	const marker = `upd-${Date.now().toString(36)}`;
	const chatBefore = await desk.newChatSession(before, "alpha-desk");
	await desk.send(chatBefore, marker);
	await expect(chatBefore.getByText(`Mock reply to: ${marker}`)).toBeVisible();
	await expect.poll(() => recordedSession(state, marker)?.childPid ?? null).not.toBeNull();
	await expect.poll(() => recordedSession(state, marker)?.brokerPid ?? null).not.toBeNull();
	const { childPid, brokerPid } = recordedSession(state, marker) as { childPid: number; brokerPid: number };
	const report: Record<string, unknown> = { expectBroker: EXPECT, marker, childPid, brokerPid };

	report.brokerImage = imageOf(brokerPid);
	report.childImage = imageOf(childPid);
	const brokerIsBun = /\\bun\.exe$/i.test(report.brokerImage as string);
	expect(brokerIsBun, `the broker image is ${report.brokerImage}`).toBe(SURVIVE);

	report.dryRun = updater("-DryRun");
	report.updater = updater("-Rename");
	await sleep(3_000);
	report.afterKill = { brokerAlive: pidAlive(brokerPid), childAlive: pidAlive(childPid) };
	report.restore = updater("-Restore");
	writeFileSync(join(REPO_ROOT, "out", "e2e-results", `updater-${EXPECT}.json`), JSON.stringify(report, null, 1));
	expect(pidAlive(brokerPid), "broker survival after the kill").toBe(SURVIVE);
	expect(pidAlive(childPid), "OMP child survival after the kill").toBe(SURVIVE);

	await startVsCode({ name: state.name, root: state.root, folder: state.folderA, port: state.cdpPort });
	await waitForCdp(state.cdpPort, 180_000);
	const reopened = await Desk.connect(state);
	const after = await reopened.window("alpha-desk");
	await reopened.ready(after);
	const tree = await reopened.sessionsTree(after);
	if (!SURVIVE) {
		await expect(tree.getByRole("treeitem", { name: new RegExp(marker) })).toBeVisible({ timeout: 90_000 });
		await reopened.close();
		return;
	}
	await expect(tree.getByRole("treeitem", { name: new RegExp(`${marker}, .*process running`) })).toBeVisible({ timeout: 90_000 });
	expect(recordedSession(state, marker)?.childPid, "the same OMP process serves the session").toBe(childPid);
	expect(recordedSession(state, marker)?.brokerPid, "the same broker serves the session").toBe(brokerPid);
	// A kill is not a quit: VS Code never wrote down the editor this Chat had opened, so it is not restored. The row is how a user gets it back.
	await tree.getByRole("treeitem", { name: new RegExp(`${marker}, .*process running`) }).click();
	const chat = reopened.chat(after);
	await expect(chat.getByText(`Mock reply to: ${marker}`)).toBeVisible({ timeout: 90_000 });
	await reopened.send(chat, `after updater ${marker}`);
	await expect(chat.getByText(`Mock reply to: after updater ${marker}`)).toBeVisible({ timeout: 60_000 });
	await reopened.close();
});
