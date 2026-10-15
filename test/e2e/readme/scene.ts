/**
 * The scene of the README screenshots (`E2E_SCENE=readme`, see global-setup.ts): a workspace named `omp-vscode` holding a
 * copy of one of this repository's own sources, taken from the current tree when the scene is created so the line numbers
 * and names the replies cite cannot go stale (src/webview/lib/attachments.ts), in a git repository of its own (so the editor
 * shows an inline blame line), a scripted model server instead of the plain mock and a model with a neutral name. Nothing here refers to anything
 * outside this repository.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../support/launcher.ts";
import type { MockAgentOptions } from "../support/omp-agent.ts";
import { readmeScripts, type SourceFacts } from "./scripts.ts";
import { startScriptedModelServer, type ScriptedModelServer } from "./scripted-model-server.ts";

export const WORKSPACE_NAME = "omp-vscode";
export const ATTACHMENTS_PATH = "src/webview/lib/attachments.ts";

/** What `writeMockAgentConfig` writes for this scene: a model with a neutral name that accepts images, quiet OMP startup, and a status line without the working directory (it would show the throwaway checkout path). */
export const AGENT_CONFIG: MockAgentOptions = {
	providerId: "demo",
	modelId: "demo-model",
	modelName: "Demo Model",
	contextWindow: 200_000,
	inputKinds: "text, image",
	reasoning: true,
	// The first two lines continue the `modelRoles:` block of the config: the roles the Models editor shows assigned.
	extraConfig: ["  smol: demo/demo-model", "  slow: demo/demo-model", "defaultThinkingLevel: high", "title:", "  icons: boring", "startup:", "  quiet: true", "  checkUpdate: false", "  changelogMode: hidden", "statusLine:", "  preset: custom", "  leftSegments: [pi, model, mode, git]"],
};

/** The agents of the scene's own OMP profile, neutral and for this project only (the names of the Agents editor besides OMP's bundled ones). */
export const FIXTURE_AGENTS: readonly { readonly name: string; readonly description: string; readonly model: string; readonly tools: string }[] = [
	{ name: "docs-writer", description: "Writes and updates the project documentation", model: "demo/demo-model", tools: "read, find, grep, write" },
	{ name: "test-runner", description: "Runs the test suite and reports the failures", model: "\"@smol\"", tools: "read, find, grep, bash" },
];

/**
 * The scene's home folder (`<base>/home`, which test-vscode.ps1 -IsolateHome makes `~` for VS Code, OMP and OMP Desk). OMP finds
 * the user-level agents it hands to subagents in `~/.omp/agent/agents` (the home folder, not `PI_CODING_AGENT_DIR`), so they
 * are written there. Nothing of the real home folder is read in this scene.
 */
export async function writeHomeProfile(home: string): Promise<void> {
	const agents = join(home, ".omp", "agent", "agents");
	await mkdir(agents, { recursive: true });
	for (const agent of FIXTURE_AGENTS) {
		await writeFile(join(agents, `${agent.name}.md`), `---\nname: ${agent.name}\ndescription: ${agent.description}\ntools: ${agent.tools}\nmodel: ${agent.model}\nthinking-level: medium\n---\n\nYou work on the omp-vscode project. ${agent.description}.\n`, "utf8");
	}
}

const GIT_IDENTITY = ["-c", "user.name=Maintainer", "-c", "user.email=maintainer@example.invalid"];

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
	return execFileSync("git", [...GIT_IDENTITY, ...args], { cwd, env, encoding: "utf8" });
}

function lineOf(text: string, needle: string): number {
	const index = text.split("\n").findIndex(line => line.startsWith(needle));
	if (index < 0) throw new Error(`"${needle}" not found in the attachments source`);
	return index + 1;
}

/** Creates `<base>/ws/omp-vscode` with the copied files and one commit dated a day ago. Both window folders are this one. */
export async function createFolders(base: string): Promise<{ folderA: string; folderB: string }> {
	const folder = join(base, "ws", WORKSPACE_NAME);
	await mkdir(join(folder, dirname(ATTACHMENTS_PATH)), { recursive: true });
	await writeFile(join(folder, ATTACHMENTS_PATH), await readFile(join(REPO_ROOT, ATTACHMENTS_PATH), "utf8"));
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
/** The lines and names the replies cite, read from `attachments`. */
export function sourceFacts(attachments: string): SourceFacts {
	return {
		attachmentBytesLine: lineOf(attachments, "export const MAX_ATTACHMENT_BYTES"),
		draftBytesLine: lineOf(attachments, "export const MAX_DRAFT_BYTES"),
		functions: [...attachments.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]),
	};
}

/** The scripted model server for the workspace created by `createFolders`. */
export async function startModelServer(folder: string, port = 0): Promise<ScriptedModelServer> {
	return startScriptedModelServer(readmeScripts(sourceFacts(await readFile(join(folder, ATTACHMENTS_PATH), "utf8"))), port);
}
