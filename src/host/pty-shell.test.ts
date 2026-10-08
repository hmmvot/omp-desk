/**
 * Tests for folder-shell resolution.
 *
 * Runner: `node --test src/host/pty-shell.test.ts`
 *
 * A folder terminal runs whatever this resolves, so what matters is that an explicit
 * shell is used verbatim (even a wrong one: the broker's spawn error names it, and a
 * guess made here would hide it), that a resolved shell is one that is actually there,
 * that the fallback is the platform's own command processor rather than an invented
 * path, and that the shell a folder gets is described in the title the editor shows.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parsePtyBrokerArgs } from "../broker/pty-broker.ts";
import { folderShellLaunchSpec, resolveFolderShell } from "./pty-shell.ts";

/** Run `body` with a temporary environment, restoring it afterwards. */
async function withEnvironment(
	values: Readonly<Record<string, string | undefined>>,
	body: () => Promise<void>,
): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(values)) {
		saved[name] = process.env[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		await body();
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

describe("folder shell", () => {
	it("uses an explicit shell verbatim, with its own arguments or a matching default", async () => {
		const explicit = await resolveFolderShell({
			slot: "shell:1",
			cwd: "C:\\work",
			shellPath: "C:\\tools\\pwsh.exe",
			shellArgs: ["-NoProfile"],
		});
		assert.equal(explicit.file, "C:\\tools\\pwsh.exe");
		assert.deepEqual(explicit.args, ["-NoProfile"]);
		assert.equal(explicit.origin, "given");
		assert.match(explicit.title, /pwsh/);

		const named = await resolveFolderShell({ slot: "shell:1", cwd: "/work", shellPath: "/usr/bin/bash" });
		assert.deepEqual(named.args, ["-i"]);

		// A shell that is not there is still used: the broker's own spawn error is the
		// honest report, and it names the file.
		const missing = await resolveFolderShell({ slot: "shell:1", cwd: "C:\\work", shellPath: "C:\\nope\\nope.exe" });
		assert.equal(missing.file, "C:\\nope\\nope.exe");
	});

	it("falls back to the platform's own command processor when nothing better is resolvable", async () => {
		await withEnvironment({ PATH: "", SHELL: undefined }, async () => {
			if (process.platform === "win32") {
				const comspec = "C:\\Windows\\System32\\cmd.exe";
				await withEnvironment({ ComSpec: comspec }, async () => {
					const shell = await resolveFolderShell({ slot: "shell:1", cwd: "C:\\work" });
					assert.equal(shell.file, comspec);
					assert.equal(shell.origin, "ComSpec");
					assert.deepEqual(shell.args, []);
					assert.match(shell.title, /cmd/);
				});
			} else {
				const shell = await resolveFolderShell({ slot: "shell:1", cwd: "/work" });
				assert.equal(shell.file, "/bin/sh");
				assert.equal(shell.origin, "the platform default");
			}
		});
	});

	it("picks a resolvable shell from PATH instead of an absent one", async () => {
		if (process.platform !== "win32") return;
		const directory = path.dirname(process.execPath);
		await withEnvironment({ PATH: directory, ComSpec: undefined }, async () => {
			const shell = await resolveFolderShell({ slot: "shell:1", cwd: "C:\\work" });
			// `node.exe` is there and neither PowerShell is: the fallback is the system's
			// own command processor, as an absolute path that exists — never a bare name
			// the broker would have to resolve in whatever directory it runs in.
			assert.equal(shell.origin, "the Windows command processor");
			assert.equal(path.isAbsolute(shell.file), true, shell.file);
			assert.equal(existsSync(shell.file), true, shell.file);
		});
	});

	it("resolves the default Windows shell to an absolute path the broker accepts", async () => {
		if (process.platform !== "win32") return;
		await withEnvironment({ ComSpec: undefined }, async () => {
			const shell = await resolveFolderShell({ slot: "shell:1", cwd: process.cwd() });
			// The broker refuses a non-absolute executable, so the default path has to be
			// absolute whether it came from PATH, from ComSpec or from the system root.
			assert.equal(path.isAbsolute(shell.file), true, `resolved shell was ${shell.file}`);
			const spec = await folderShellLaunchSpec({ slot: "shell:1", cwd: process.cwd() });
			const argv = [
				"--slot",
				spec.slot,
				"--kind",
				spec.kind,
				"--storage-dir",
				process.cwd(),
				"--tree-digest",
				"a".repeat(64),
				"--file",
				spec.file,
				"--cwd",
				process.cwd(),
				"--no-helper",
			];
			const parsed = parsePtyBrokerArgs(argv);
			assert.equal(typeof parsed === "string", false, `the broker refused the default shell: ${String(parsed)}`);
		});
	});

	it("builds a portable spec: a shell kind, the folder as its cwd, and no OMP capability", async () => {
		const spec = await folderShellLaunchSpec({ slot: "shell:1", cwd: process.cwd() });
		assert.equal(spec.kind, "folder-shell");
		assert.equal(spec.slot, "shell:1");
		assert.equal(spec.cwd, process.cwd());
		assert.equal(spec.env, undefined);
		assert.deepEqual([spec.cols, spec.rows], [100, 30]);
		// A shell nobody claims says nothing about owners, and a hint is carried through
		// verbatim as the *hint* it is: the broker attests it and reports what it proved
		// (ADR-0030). An explicit null is the third state — a launching frontend that
		// exists and cannot attest an owner — and it must survive as null.
		assert.equal(spec.owner, undefined);
		const sized = await folderShellLaunchSpec({ slot: "shell:2", cwd: process.cwd(), cols: 120, rows: 40, title: "my shell" });
		assert.deepEqual([sized.cols, sized.rows], [120, 40]);
		assert.equal(sized.title, "my shell");
		const owner = { extensionHostPid: 11, parentPid: 22, mainPid: 22 };
		const owned = await folderShellLaunchSpec({ slot: "shell:3", cwd: process.cwd(), owner });
		assert.deepEqual(owned.owner, owner);
		const unattestable = await folderShellLaunchSpec({ slot: "shell:4", cwd: process.cwd(), owner: null });
		assert.equal(unattestable.owner, null);
	});

	it("gives the broker an owner hint it can refuse instead of guess at", async () => {
		// A hint is a whole topology or none: the broker's own argument line must refuse a
		// half-given one, and a half-configured owner helper, rather than starting a shell
		// whose watch quietly does not exist (ADR-0030).
		const spec = await folderShellLaunchSpec({ slot: "shell:1", cwd: process.cwd() });
		const base = [
			"--slot",
			spec.slot,
			"--kind",
			spec.kind,
			"--storage-dir",
			process.cwd(),
			"--tree-digest",
			"a".repeat(64),
			"--file",
			spec.file,
			"--cwd",
			process.cwd(),
		];
		const helpers = [
			"--helper",
			"probe.ps1",
			"--helper-sha256",
			"b".repeat(64),
			"--owner-helper",
			"owner.ps1",
			"--owner-helper-sha256",
			"c".repeat(64),
		];
		const complete = parsePtyBrokerArgs([
			...base,
			...helpers,
			"--owner-host-pid",
			"11",
			"--owner-parent-pid",
			"22",
			"--owner-main-pid",
			"22",
		]);
		const accepted = typeof complete === "string" ? null : complete;
		assert.equal(accepted !== null, true, String(complete));
		assert.deepEqual(accepted?.ownerHint, { extensionHostPid: 11, parentPid: 22, mainPid: 22 });
		// One pid without the others is not a topology.
		assert.match(String(parsePtyBrokerArgs([...base, ...helpers, "--owner-main-pid", "22"])), /must be given together/);
		// A "main" that is the extension host cannot own it.
		assert.match(
			String(parsePtyBrokerArgs([...base, ...helpers, "--owner-host-pid", "22", "--owner-parent-pid", "22", "--owner-main-pid", "22"])),
			/positive process ids/,
		);
		// A half-configured helper is refused rather than dropped.
		assert.match(
			String(parsePtyBrokerArgs([...base, "--helper", "probe.ps1", "--helper-sha256", "b".repeat(64), "--owner-helper", "owner.ps1"])),
			/must be given together/,
		);
	});
});
