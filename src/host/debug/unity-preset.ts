import type { DebugPreset } from "./policy.ts";

/**
 * The replaceable Unity layer (design section 6): with the Microsoft Unity extension (`visualstudiotoolsforunity.vstuc`)
 * installed, Desk offers an `Attach to Unity Editor` preset for its `vstuc` debug type. Replacing `vstuc` (for example
 * with a fork of the MIT `walcht/unity-dap`) changes only this file and its registration in `index.ts`.
 */

export const UNITY_EXTENSION_ID = "visualstudiotoolsforunity.vstuc";
export const UNITY_ATTACH_PRESET_ID = "unity-attach";

/** `host:port` of an Editor's debugger endpoint; a host name or an IPv4 address. */
const END_POINT = /^[A-Za-z0-9][A-Za-z0-9.-]*:\d{1,5}$/;

export interface UnityPresetHost {
	/** Whether the Microsoft Unity extension is installed in this window's extension host. */
	isInstalled(): boolean;
	isFile(path: string): boolean;
}

export function unityAttachPreset(host: UnityPresetHost): DebugPreset {
	return {
		id: UNITY_ATTACH_PRESET_ID,
		label: "Attach to Unity Editor",
		description: `Preset "${UNITY_ATTACH_PRESET_ID}" (Attach to Unity Editor) attaches the Microsoft Unity debugger (type vstuc) to the running Unity Editor of the project in the workspace folder; optional "endPoint" (host:port) and "projectPath" (the Unity project folder, when it is not the workspace folder). A script breakpoint is verified only after Unity loads its assembly, and the Editor must use Debug code optimization. Starting a test or Play Mode is not part of this tool: the user's Unity tooling does that; then wait for the stop.`,
		available: () => host.isInstalled(),
		build: ({ endPoint, projectPath }) => {
			if (endPoint !== undefined && !END_POINT.test(endPoint)) return { error: `"endPoint" must be host:port, for example 127.0.0.1:56000.` };
			if (projectPath !== undefined && !host.isFile(`${projectPath.replace(/[\\/]+$/, "")}\\ProjectSettings\\ProjectVersion.txt`)) {
				return { error: `"${projectPath}" is not a Unity project folder (ProjectSettings\\ProjectVersion.txt not found).` };
			}
			return {
				configuration: {
					name: "Attach to Unity Editor",
					type: "vstuc",
					request: "attach",
					projectPath: projectPath ?? "${workspaceFolder}",
					...(endPoint !== undefined ? { endPoint } : {}),
				},
			};
		},
	};
}
