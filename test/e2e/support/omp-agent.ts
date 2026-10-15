/**
 * Prepares an isolated OMP agent directory (`PI_CODING_AGENT_DIR`) whose only model is the local mock server.
 *
 * OMP 18.8.5 defines custom providers in `<agentDir>/models.yml` (`providers.<id>.{baseUrl, apiKey, api, models[]}`,
 * schema: pi-coding-agent `src/config/models-config-schema-bundle.ts`) and the default model in the global settings file
 * `<agentDir>/config.yml` (`modelRoles.default: <provider>/<model>`). No real provider key is involved: `apiKey` is a
 * literal placeholder that only the mock server sees.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SKILL_NAME } from "./fixtures-constants.ts";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "../fixtures/mock-openai-server.ts";

export async function writeMockAgentConfig(agentDir: string, mockUrl: string): Promise<void> {
	await mkdir(agentDir, { recursive: true });
	const models = [
		"providers:",
		`  ${MOCK_PROVIDER_ID}:`,
		`    baseUrl: ${mockUrl}/v1`,
		"    apiKey: mock-key-not-a-secret",
		"    api: openai-completions",
		"    models:",
		`      - id: ${MOCK_MODEL_ID}`,
		"        name: Mock Model",
		"        contextWindow: 64000",
		"        maxTokens: 4096",
		"        supportsTools: true",
		"        input: [text, image]",
		"        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
		"",
	].join("\n");
	const config = [
		"modelRoles:",
		`  default: ${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
		"",
	].join("\n");
	await writeFile(join(agentDir, "models.yml"), models, "utf8");
	await writeFile(join(agentDir, "config.yml"), config, "utf8");
}

/**
 * An owned skill in the isolated agent directory (`<agentDir>/skills/<name>/SKILL.md`, OMP's native user level). The
 * Skills view lists it in its own first group "Global", so the latency scenario can wait for a known leaf row; a skill in
 * the fixture workspace's `.claude/skills` was not discovered by the inventory.
 */
export async function writeFixtureSkill(agentDir: string): Promise<void> {
	const dir = join(agentDir, "skills", SKILL_NAME);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\nname: ${SKILL_NAME}\ndescription: Fixture skill owned by the OMP Desk end-to-end suite.\n---\n\nNothing to do.\n`, "utf8");
}

/**
 * User settings of the throwaway VS Code, written before its first start (the launcher keeps an existing file).
 * The four first-run switches are the launcher's own defaults; the rest keep the window drivable over CDP:
 * `window.dialogStyle: custom` renders modal confirmations (Kill, Delete...) as DOM instead of a native Win32 dialog
 * that CDP cannot see and that would block the window.
 */
export async function writeProfileSettings(dataDir: string): Promise<void> {
	const userDir = join(dataDir, "User");
	await mkdir(userDir, { recursive: true });
	const settings = {
		"security.workspace.trust.enabled": false,
		"chat.disableAIFeatures": true,
		"workbench.startupEditor": "none",
		"workbench.welcomePage.walkthroughs.openOnInstall": false,
		"window.dialogStyle": "custom",
		"update.mode": "none",
		"telemetry.telemetryLevel": "off",
		"extensions.autoUpdate": false,
		"extensions.autoCheckUpdates": false,
	};
	await writeFile(join(userDir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
}
