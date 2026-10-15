/**
 * The message a window shows when the native module cannot load: one message per cause class with its three buttons, what each
 * button does, nothing at all when the load did not fail, and the test hook that simulates each cause. Runner:
 * `node --test src/wiring/native-module-notice.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
	NATIVE_NOTICE_COPY,
	NATIVE_NOTICE_RELOAD,
	NATIVE_NOTICE_TROUBLESHOOTING,
	announceNativeFailure,
	nativeDiagnosticsFor,
	simulatedNativeFailure,
} from "./native-module-notice.ts";
import type { NativeNoticePort } from "./native-module-notice.ts";
import { classifyNativeFailure } from "../host/native-module-failure.ts";
import { recordingLogger } from "../shared/logger.ts";
import type { LoggedLine } from "../shared/logger.ts";

interface Fixture {
	readonly port: NativeNoticePort;
	readonly shown: Array<{ readonly message: string; readonly buttons: readonly string[] }>;
	readonly copied: string[];
	readonly calls: string[];
	readonly logs: LoggedLine[];
}

function fixture(failure: string | null, pick: string | undefined): Fixture {
	const shown: Fixture["shown"] = [];
	const copied: string[] = [];
	const calls: string[] = [];
	const logs: LoggedLine[] = [];
	const port: NativeNoticePort = {
		failure: () => failure,
		showError: async (message, buttons) => {
			shown.push({ message, buttons });
			return pick;
		},
		copy: async text => void copied.push(text),
		openTroubleshooting: async () => void calls.push("troubleshooting"),
		reloadWindow: async () => void calls.push("reload"),
		diagnostics: async f => `diagnostics for ${f.kind}`,
		log: recordingLogger(logs),
	};
	return { port, shown, copied, calls, logs };
}

describe("the native module notice", () => {
	it("shows nothing when the load did not fail", async () => {
		const f = fixture(null, undefined);
		await announceNativeFailure(f.port);
		assert.deepEqual(f.shown, []);
		assert.deepEqual(f.logs, []);
	});

	const raws: ReadonlyArray<readonly [string, string, RegExp]> = [
		["a policy block", simulatedNativeFailure("1260")!, /Windows blocked OMP Desk's native module/],
		["a code-integrity block", simulatedNativeFailure("577")!, /Windows blocked OMP Desk's native module/],
		["a quarantine", simulatedNativeFailure("225")!, /missing or could not be read/],
		["a stage timeout", simulatedNativeFailure("timeout")!, /did not start in time/],
		["an unrecognized cause", simulatedNativeFailure("other")!, /could not be loaded/],
	];
	for (const [name, raw, headline] of raws) {
		it(`shows ${name} once, with the three buttons, what does not work and the cause in the log`, async () => {
			const f = fixture(raw, undefined);
			await announceNativeFailure(f.port);
			assert.equal(f.shown.length, 1);
			assert.deepEqual(f.shown[0]!.buttons, [NATIVE_NOTICE_COPY, NATIVE_NOTICE_TROUBLESHOOTING, NATIVE_NOTICE_RELOAD]);
			assert.match(f.shown[0]!.message, headline);
			assert.match(f.shown[0]!.message, /New Session, Resume, and re-attaching a running Chat/);
			assert.match(f.shown[0]!.message, /Saved conversations stay readable/);
			assert.equal(f.logs.length, 1);
			assert.equal(f.logs[0]!.level, "warn");
			assert.ok(f.logs[0]!.message.includes(raw), "the raw error is in the log");
			assert.ok(f.logs[0]!.message.includes(classifyNativeFailure(raw).kind));
		});
	}

	it("copies the diagnostics for Copy diagnostics and does nothing else", async () => {
		const f = fixture(simulatedNativeFailure("1260"), NATIVE_NOTICE_COPY);
		await announceNativeFailure(f.port);
		assert.deepEqual(f.copied, ["diagnostics for blocked-by-policy"]);
		assert.deepEqual(f.calls, []);
	});

	it("opens the troubleshooting for Open troubleshooting", async () => {
		const f = fixture(simulatedNativeFailure("1260"), NATIVE_NOTICE_TROUBLESHOOTING);
		await announceNativeFailure(f.port);
		assert.deepEqual(f.calls, ["troubleshooting"]);
		assert.deepEqual(f.copied, []);
	});

	it("reloads the window for Reload Window", async () => {
		const f = fixture(simulatedNativeFailure("timeout"), NATIVE_NOTICE_RELOAD);
		await announceNativeFailure(f.port);
		assert.deepEqual(f.calls, ["reload"]);
	});

	it("does nothing when the message is dismissed", async () => {
		const f = fixture(simulatedNativeFailure("1260"), undefined);
		await announceNativeFailure(f.port);
		assert.deepEqual(f.calls, []);
		assert.deepEqual(f.copied, []);
	});

	it("never throws when a button's action fails, and logs it", async () => {
		const f = fixture(simulatedNativeFailure("1260"), NATIVE_NOTICE_COPY);
		const failing: NativeNoticePort = { ...f.port, copy: async () => { throw new Error("clipboard is locked"); } };
		await announceNativeFailure(failing);
		assert.match(f.logs.at(-1)!.message, /clipboard is locked/);
	});
});

describe("the simulated failure", () => {
	it("simulates each class a smoke test needs, and nothing for any other value", () => {
		assert.equal(classifyNativeFailure(simulatedNativeFailure("1260")!).code, 1260);
		assert.equal(classifyNativeFailure(simulatedNativeFailure("577")!).code, 577);
		assert.equal(classifyNativeFailure(simulatedNativeFailure("225")!).kind, "missing-or-quarantined");
		assert.equal(classifyNativeFailure(simulatedNativeFailure("timeout")!).kind, "stage-timeout");
		assert.equal(classifyNativeFailure(simulatedNativeFailure("other")!).kind, "other");
		assert.equal(simulatedNativeFailure(undefined), null);
		assert.equal(simulatedNativeFailure(""), null);
		assert.equal(simulatedNativeFailure("1"), null);
	});
});

describe("the diagnostics of a window", () => {
	it("name the shipped module, its digest, and where the staged copy is", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "omp-native-notice-"));
		try {
			const shipped = path.join(root, "ext", "out", "native", "koffi.node");
			await mkdir(path.dirname(shipped), { recursive: true });
			await writeFile(shipped, "not a real module");
			const sha256 = createHash("sha256").update("not a real module").digest("hex");
			const storageDir = path.join(root, "globalStorage");
			const text = await nativeDiagnosticsFor({
				failure: classifyNativeFailure(simulatedNativeFailure("1260")!),
				shippedPath: shipped,
				storageDir,
				vscodeVersion: "1.141.1",
				deskVersion: "0.4.3",
				arch: "x64",
			});
			assert.ok(text.includes(`Shipped koffi.node: ${shipped}`));
			assert.ok(text.includes(`Shipped SHA-256: ${sha256}`));
			assert.ok(text.includes(`Staged koffi.node: ${path.join(storageDir, "runtime", sha256, "koffi.node")}`));
			assert.ok(text.includes("Staged SHA-256: not present"), "nothing was staged here");
			assert.match(text, /Windows error code: 1260/);

			const staged = path.join(storageDir, "runtime", sha256, "koffi.node");
			await mkdir(path.dirname(staged), { recursive: true });
			await writeFile(staged, "not a real module");
			assert.ok((await nativeDiagnosticsFor({ failure: classifyNativeFailure("x"), shippedPath: shipped, storageDir, vscodeVersion: "v", deskVersion: "d", arch: "x64" })).includes(`Staged SHA-256: ${sha256}`));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("say the shipped module is unreadable and the staged one unknown when it is missing", async () => {
		const text = await nativeDiagnosticsFor({
			failure: classifyNativeFailure("x"),
			shippedPath: path.join(tmpdir(), "omp-native-notice-absent", "koffi.node"),
			storageDir: tmpdir(),
			vscodeVersion: "v",
			deskVersion: "d",
			arch: "arm64",
		});
		assert.match(text, /Shipped SHA-256: unreadable/);
		assert.match(text, /Staged koffi\.node: unknown/);
	});
});
