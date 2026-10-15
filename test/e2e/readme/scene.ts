/**
 * The scene of the README screenshots (`E2E_SCENE=readme`, see global-setup.ts): a workspace named `omp-vscode` holding a
 * committed copy of one of this repository's own sources (`workspace/attachments.ts.txt`, kept as it was at commit ceb1106
 * so the numbers the scripted replies cite stay true) in a git repository of its own (so the editor shows an inline blame
 * line), a scripted model server instead of the plain mock and a model with a neutral name. Nothing here refers to anything
 * outside this repository.
 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { MockAgentOptions } from "../support/omp-agent.ts";
import { readmeScripts, type SourceFacts } from "./scripts.ts";
import { startScriptedModelServer, type ScriptedModelServer } from "./scripted-model-server.ts";

export const WORKSPACE_NAME = "omp-vscode";
const SOURCE_COPY = resolve(__dirname, "workspace", "attachments.ts.txt");
export const ATTACHMENTS_PATH = "src/webview/lib/attachments.ts";

/** What `writeMockAgentConfig` writes for this scene: a model with a neutral name that accepts images, quiet OMP startup, and a status line without the working directory (it would show the throwaway checkout path). */
export const AGENT_CONFIG: MockAgentOptions = {
	providerId: "demo",
	modelId: "demo-model",
	modelName: "Demo Model",
	contextWindow: 200_000,
	inputKinds: "text, image",
	reasoning: true,
	extraConfig: ["defaultThinkingLevel: high", "title:", "  icons: boring", "startup:", "  quiet: true", "  checkUpdate: false", "  changelogMode: hidden", "statusLine:", "  preset: custom", "  leftSegments: [pi, model, mode, git]"],
};

const GIT_IDENTITY = ["-c", "user.name=Maintainer", "-c", "user.email=maintainer@example.invalid"];

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
	return execFileSync("git", [...GIT_IDENTITY, ...args], { cwd, env, encoding: "utf8" });
}

function lineOf(text: string, needle: string): number {
	const index = text.split("\n").findIndex(line => line.startsWith(needle));
	if (index < 0) throw new Error(`"${needle}" not found in the workspace copy`);
	return index + 1;
}

/** Creates `<base>/ws/omp-vscode` with the copied files and one commit dated a day ago. Both window folders are this one. */
export async function createFolders(base: string): Promise<{ folderA: string; folderB: string }> {
	const folder = join(base, "ws", WORKSPACE_NAME);
	await mkdir(join(folder, dirname(ATTACHMENTS_PATH)), { recursive: true });
	await copyFile(SOURCE_COPY, join(folder, ATTACHMENTS_PATH));
	// The copy imports modules the workspace does not hold: no red squiggles in the picture.
	await mkdir(join(folder, ".vscode"), { recursive: true });
	await writeFile(join(folder, ".vscode", "settings.json"), JSON.stringify({ "typescript.validate.enable": false }, null, 2));
	const committed = new Date(Date.now() - 20 * 3_600_000).toISOString();
	git(folder, ["init", "-q", "-b", "main"]);
	git(folder, ["add", "."]);
	git(folder, ["commit", "-q", "-m", "Import the attachment helpers"], { ...process.env, GIT_AUTHOR_DATE: committed, GIT_COMMITTER_DATE: committed });
	return { folderA: folder, folderB: folder };
}

/** The scripted model server for the workspace created by `createFolders`. */
export async function startModelServer(folder: string, port = 0): Promise<ScriptedModelServer> {
	const attachments = await readFile(join(folder, ATTACHMENTS_PATH), "utf8");
	const facts: SourceFacts = {
		attachmentBytesLine: lineOf(attachments, "export const MAX_ATTACHMENT_BYTES"),
		draftBytesLine: lineOf(attachments, "export const MAX_DRAFT_BYTES"),
	};
	return startScriptedModelServer(readmeScripts(facts), port);
}

