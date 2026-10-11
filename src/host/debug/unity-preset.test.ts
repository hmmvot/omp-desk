import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { text, createHarness } from "./test-harness.ts";
import { UNITY_ATTACH_PRESET_ID, unityAttachPreset } from "./unity-preset.ts";

function preset(installed = true, files: string[] = []) {
	return unityAttachPreset({ isInstalled: () => installed, isFile: path => files.includes(path) });
}

describe("Unity attach preset", () => {
	it("is available only while the Microsoft Unity extension is installed", () => {
		assert.equal(preset(true).available(), true);
		assert.equal(preset(false).available(), false);
	});

	it("builds a vstuc attach configuration, optionally with an endpoint", () => {
		const built = preset().build({});
		assert.deepEqual("configuration" in built && built.configuration, { name: "Attach to Unity Editor", type: "vstuc", request: "attach", projectPath: "${workspaceFolder}" });
		const withEndpoint = preset().build({ endPoint: "127.0.0.1:56123" });
		assert.equal("configuration" in withEndpoint && withEndpoint.configuration.endPoint, "127.0.0.1:56123");
	});

	it("rejects a malformed endpoint and a projectPath that is not a Unity project", () => {
		assert.ok("error" in preset().build({ endPoint: "not an endpoint" }));
		assert.ok("error" in preset().build({ projectPath: "C:\\nope" }));
		const ok = preset(true, ["C:\\proj\\ProjectSettings\\ProjectVersion.txt"]).build({ projectPath: "C:\\proj\\" });
		assert.equal("configuration" in ok && ok.configuration.projectPath, "C:\\proj\\");
	});

	it("describes the Unity caveats to the agent and is startable through vscode_debug_start", async () => {
		const h = createHarness({ presets: [preset()] });
		const description = String(h.tool("vscode_debug_start").description);
		assert.match(description, /verified only after Unity loads its assembly/);
		assert.match(description, /Debug code optimization/);
		assert.match(description, /not batchmode/);
		const result = await h.call("vscode_debug_start", { preset: UNITY_ATTACH_PRESET_ID, endPoint: "127.0.0.1:56000" });
		assert.equal(result.isError, undefined, text(result));
		assert.equal(h.api.started[0]!.configuration.type, "vstuc");
		assert.equal(h.api.started[0]!.configuration.endPoint, "127.0.0.1:56000");
		const bad = await h.call("vscode_debug_start", { preset: UNITY_ATTACH_PRESET_ID, endPoint: "nope" });
		assert.equal(bad.isError, true);
		h.dispose();
	});

	it("is not offered when the extension is missing", async () => {
		const h = createHarness({ presets: [preset(false)] });
		const result = await h.call("vscode_debug_start", { preset: UNITY_ATTACH_PRESET_ID });
		assert.equal(result.isError, true);
		assert.match(text(await h.call("vscode_debug_configs", {})), /Presets: none available/);
		h.dispose();
	});
});
