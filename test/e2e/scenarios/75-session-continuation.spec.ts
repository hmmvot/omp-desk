/**
 * Scenario: a session OMP 18.13 continued in a newer file. A second `omp --session <file>` process opens the file a Chat
 * holds and moves off it at its first write: the conversation goes on in `<time>_<newId>.jsonl` (new session id, header
 * `continuationOf`), and asking OMP for the old file opens the newer one. Stop and Open in Chat, and Reload Window, must
 * attach to it without `identity-mismatch`, the row must follow the file (one row, not two), and the Chat must go on.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { deskLogLines } from "../support/desk-log.ts";
import { expect, test } from "../support/fixtures.ts";
import { recordedSession, recordedSessions, taskkillTree } from "../support/records.ts";
import type { RunState } from "../support/state.ts";

const IDENTITY_FAILURE = /identity check failed|identity-mismatch|identity-diverged|session-mismatch/;

interface Frame { type?: string; id?: string }

/** One `omp --mode rpc --session <file>` process of the run's own agent directory, driven over stdin/stdout for one turn. */
async function promptSecondProcess(state: RunState, sessionFile: string, text: string): Promise<void> {
	const child: ChildProcess = spawn("omp", ["--mode", "rpc", "--cwd", state.folderA, "--session", sessionFile], {
		cwd: state.folderA,
		shell: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, PI_CODING_AGENT_DIR: state.agentDir, USERPROFILE: state.homeDir, HOME: state.homeDir },
	});
	const frames: Frame[] = [];
	let buffered = "";
	child.stderr!.resume();
	child.stdout!.on("data", (chunk: Buffer) => {
		buffered += chunk.toString("utf8");
		for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
			const line = buffered.slice(0, end);
			buffered = buffered.slice(end + 1);
			try { frames.push(JSON.parse(line)); } catch { /* not a frame */ }
		}
	});
	const settled = (found: (frame: Frame) => boolean, message: string) => expect.poll(() => frames.some(found), { message, timeout: 90_000 }).toBe(true);
	try {
		child.stdin!.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
		await settled(frame => frame.type === "response" && frame.id === "state", "the second process answers get_state");
		child.stdin!.write(`${JSON.stringify({ id: "go", type: "prompt", message: text })}\n`);
		await settled(frame => frame.type === "agent_end", "the second process finishes its turn");
	} finally {
		if (child.pid !== undefined) await taskkillTree(child.pid).catch(() => undefined);
	}
}

/** The session files of `dir` whose header names a `continuationOf` (the continuations OMP wrote). */
function continuationFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter(name => name.endsWith(".jsonl"))
		.map(name => join(dir, name))
		.filter(file => /"continuationOf"/.test(readFileSync(file, "utf8").slice(0, 4096)));
}

test("a session OMP continued in a newer file resumes and reloads as the same row", async ({ desk, state }) => {
	const page = await desk.window("alpha-desk");
	await desk.ready(page);
	const marker = `cont-${Date.now().toString(36)}`;
	const chat = await desk.newChatSession(page, "alpha-desk");
	await desk.send(chat, marker);
	await expect(chat.getByText(`Mock reply to: ${marker}`)).toBeVisible();
	await expect.poll(() => recordedSession(state, marker)?.sessionFile ?? null, { message: "Desk records the session file" }).not.toBeNull();
	const first = recordedSession(state, marker)!;
	const oldFile = first.sessionFile!;
	const failuresBefore = deskLogLines(state.dataDir, IDENTITY_FAILURE).length;

	// OMP's own move: a second process opens the held file and continues the conversation in a new one.
	await promptSecondProcess(state, oldFile, `continued ${marker}`);
	await expect.poll(() => continuationFiles(dirname(oldFile)).length, { message: "OMP wrote a continuation file" }).toBe(1);
	const newFile = continuationFiles(dirname(oldFile))[0]!;
	expect(basename(newFile)).not.toBe(basename(oldFile));

	const tree = await desk.sessionsTree(page);
	const row = tree.getByRole("treeitem", { name: new RegExp(marker) });
	await desk.rowMenu(page, row, "Close");
	const question = desk.dialog(page);
	await expect(question).toContainText("Close the OMP session");
	await question.getByRole("button", { name: "Close", exact: true }).click();
	await expect(row).not.toHaveAccessibleName(/process running/, { timeout: 60_000 });
	await desk.chat(page).getByRole("button", { name: "Resume", exact: true }).click();
	await expect(row).toHaveAccessibleName(/process running/, { timeout: 90_000 });

	const resumed = desk.chat(page);
	await expect(resumed.getByText(`Mock reply to: continued ${marker}`)).toBeVisible({ timeout: 60_000 });
	await expect.poll(() => recordedSession(state, marker)?.sessionFile ?? null, { message: "the row follows the conversation to the newer file" }).toBe(newFile);
	expect(recordedSession(state, marker)!.sessionId, "the row records the continuation's own session id").not.toBe(first.sessionId);
	expect(recordedSessions(state, marker), "one row for the conversation").toHaveLength(1);
	await expect(row, "one row in the Sessions list").toHaveCount(1);
	await desk.send(resumed, `after resume ${marker}`);
	await expect(resumed.getByText(`Mock reply to: after resume ${marker}`)).toBeVisible({ timeout: 60_000 });

	const after = await desk.reloadWindow(page, "alpha-desk");
	const treeAfter = await desk.sessionsTree(after);
	await desk.revealSessionRow(after, treeAfter.getByRole("treeitem", { name: new RegExp(`${marker}, .*process running`) }), 60_000);
	const chatAfter = desk.chat(after);
	await expect(chatAfter.getByText(`Mock reply to: after resume ${marker}`)).toBeVisible({ timeout: 60_000 });
	await desk.send(chatAfter, `after reload ${marker}`);
	await expect(chatAfter.getByText(`Mock reply to: after reload ${marker}`)).toBeVisible({ timeout: 60_000 });
	expect(recordedSession(state, marker)!.sessionFile, "the reload kept the newer file").toBe(newFile);
	expect(recordedSessions(state, marker), "still one row").toHaveLength(1);
	expect(deskLogLines(state.dataDir, IDENTITY_FAILURE).length, "no identity failure in the Desk log").toBe(failuresBefore);
});
