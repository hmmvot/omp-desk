/**
 * Tests for the Chat broker runtime decision's pure parts
 * ([ADR-0074](../../docs/decisions/0074-run-chat-brokers-on-the-sessions-own-bun-runtime-with-code-exe-as-fallback.md)).
 *
 * Runner: `node --test src/host/chat-broker-runtime.test.ts`
 *
 * What matters here: only a verified Bun at least as new as the minimum, found through a bun shim at an
 * absolute `bun.exe`, is a candidate; every other launch names the cause that the log will carry.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MIN_BUN_VERSION,
	describeChatBrokerChoice,
	inspectBunLaunch,
	isSupportedBunVersion,
} from "./chat-broker-runtime.ts";

const BUN = "C:\\Users\\someone\\.bun\\bin\\bun.exe";

describe("isSupportedBunVersion", () => {
	it("accepts the minimum and anything newer", () => {
		assert.equal(MIN_BUN_VERSION, "1.4.0");
		for (const version of ["1.4.0", "1.4.3", "1.4.10", "1.5.0", "1.5.0-canary", "2.0.0", "10.0.0", "1.4.0+build.7"]) {
			assert.equal(isSupportedBunVersion(version), true, version);
		}
	});

	it("refuses anything older, a pre-release of the minimum, and text that is not a version", () => {
		for (const version of ["1.3.14", "1.3.99", "0.9.0", "1.4.0-canary", "1.4.0-rc.1", "", "bun", "1.4", "1.4.0.1", "v1.4.0", " 1.4.0", "1.4.x", "garbage"]) {
			assert.equal(isSupportedBunVersion(version), false, JSON.stringify(version));
		}
	});
});

describe("inspectBunLaunch", () => {
	const windows = { platform: "win32" as const, arch: "x64" };

	it("refuses a platform that is not Windows x64", async () => {
		for (const deps of [{ platform: "linux" as const, arch: "x64" }, { platform: "darwin" as const, arch: "arm64" }, { platform: "win32" as const, arch: "arm64" }]) {
			const result = await inspectBunLaunch({ command: BUN, launcher: "bun-shim" }, { ...deps, realpath: async file => file });
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.fallback.code, "platform");
				assert.match(result.fallback.detail, new RegExp(`${deps.platform} ${deps.arch}`));
			}
		}
	});

	it("refuses a launch built by hand and a compiled OMP program", async () => {
		let resolved = 0;
		const realpath = async (file: string): Promise<string> => {
			resolved += 1;
			return file;
		};
		for (const binary of [{ command: BUN }, { command: BUN, launcher: "program" as const }]) {
			const result = await inspectBunLaunch(binary, { ...windows, realpath });
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.fallback.code, "launcher");
		}
		assert.equal(resolved, 0);
	});

	it("refuses a command that is not an absolute path to bun.exe", async () => {
		for (const command of ["bun.exe", "bun", ".\\bun.exe", "C:\\tools\\node.exe", "C:\\tools\\bun.cmd", "C:\\tools\\bun.exe.old"]) {
			const result = await inspectBunLaunch({ command, launcher: "bun-shim" }, { ...windows, realpath: async file => file });
			assert.equal(result.ok, false, command);
			if (!result.ok) {
				assert.equal(result.fallback.code, "executable");
				assert.match(result.fallback.detail, /not an absolute path to bun\.exe/);
			}
		}
	});

	it("refuses a command whose real path cannot be resolved, naming the error", async () => {
		const result = await inspectBunLaunch({ command: BUN, launcher: "bun-shim" }, {
			...windows,
			realpath: async () => {
				throw new Error("ENOENT: no such file");
			},
		});
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.fallback.code, "executable");
			assert.match(result.fallback.detail, /could not be resolved/);
			assert.match(result.fallback.detail, /ENOENT/);
		}
	});

	it("refuses a command that resolves to something that is not bun.exe", async () => {
		const result = await inspectBunLaunch({ command: BUN, launcher: "bun-shim" }, { ...windows, realpath: async () => "C:\\elsewhere\\node.exe" });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.fallback.code, "executable");
			assert.match(result.fallback.detail, /resolves to C:\\elsewhere\\node\.exe/);
		}
	});

	it("returns the executable at its real path", async () => {
		const seen: string[] = [];
		const result = await inspectBunLaunch({ command: BUN, launcher: "bun-shim" }, {
			...windows,
			realpath: async file => {
				seen.push(file);
				return "D:\\real\\versions\\1.4.3\\BUN.EXE";
			},
		});
		assert.deepEqual(result, { ok: true, executable: "D:\\real\\versions\\1.4.3\\BUN.EXE" });
		assert.deepEqual(seen, [BUN]);
	});
});

describe("describeChatBrokerChoice", () => {
	it("says Bun, its version and its path, and that an update does not end the broker", () => {
		const text = describeChatBrokerChoice({ kind: "bun", executable: BUN, version: "1.4.3" });
		assert.match(text, /^Chat broker runtime: Bun 1\.4\.3/);
		assert.ok(text.includes(BUN));
		assert.match(text, /does not end it/);
	});

	it("says VS Code and the cause of the fallback", () => {
		const text = describeChatBrokerChoice({ kind: "vscode", fallback: { code: "version", detail: "the runtime reported Bun 1.3.14, older than 1.4.0" } });
		assert.match(text, /^Chat broker runtime: VS Code \(Code\.exe\)/);
		assert.ok(text.includes("because the runtime reported Bun 1.3.14, older than 1.4.0"));
		assert.match(text, /a VS Code update ends it/);
	});
});
