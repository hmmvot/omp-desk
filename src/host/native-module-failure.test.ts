/**
 * Why the native module did not load: which cause class each raw error is read as, what each class tells the person, and
 * what "Copy diagnostics" carries. The messages are the ones Windows gives for these causes through `process.dlopen`
 * (Node appends the module's path after the system text). Runner: `node --test src/host/native-module-failure.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	NATIVE_FAILURE_EFFECT,
	classifyNativeFailure,
	describeNativeFailure,
	nativeDiagnosticsText,
	nativeFailureMessage,
	nativeUnavailableDetail,
} from "./native-module-failure.ts";

const LOAD = (system: string): string => `the native module did not load (${system}\r\n\\\\?\\C:\\Users\\someone\\AppData\\Roaming\\Code\\User\\globalStorage\\runtime\\abc\\koffi.node)`;

describe("classifying a native module failure", () => {
	const cases: ReadonlyArray<readonly [string, string, "blocked-by-policy" | "missing-or-quarantined" | "stage-timeout" | "other", number | null]> = [
		["AppLocker/WDAC policy (1260)", LOAD("This program is blocked by group policy. For more information, contact your system administrator."), "blocked-by-policy", 1260],
		["the policy error by name", "LoadLibrary failed: ERROR_ACCESS_DISABLED_BY_POLICY", "blocked-by-policy", 1260],
		["the policy error by HRESULT", "dlopen failed: 0x800704EC", "blocked-by-policy", 1260],
		["a code-integrity block (577)", LOAD("Windows cannot verify the digital signature for this file. A recent hardware or software change might have installed a file that is signed incorrectly or damaged."), "blocked-by-policy", 577],
		["a code-integrity status without a number", "the module was refused by Windows Defender Application Control", "blocked-by-policy", null],
		["a quarantine (225)", LOAD("Operation did not complete successfully because the file contains a virus or potentially unwanted software."), "missing-or-quarantined", 225],
		["a deleted file (226)", "the native module did not load (ERROR_VIRUS_DELETED)", "missing-or-quarantined", 226],
		["a file the system cannot access (1920)", "the native module did not load (The file cannot be accessed by the system.)", "missing-or-quarantined", 1920],
		["a module that cannot be found (126)", LOAD("The specified module could not be found."), "missing-or-quarantined", 126],
		["a packaged file that is gone", "the packaged native module cannot be read (ENOENT: no such file or directory, open 'C:\\x\\koffi.node')", "missing-or-quarantined", 2],
		["a file a scanner holds", "the packaged native module cannot be read (EPERM: operation not permitted, open 'C:\\x\\koffi.node')", "missing-or-quarantined", 5],
		["the stage child's deadline", "the native stage child did not answer in 60000 ms", "stage-timeout", null],
		["a digest mismatch", "the staged native module does not match its digest", "other", null],
		["a wrong architecture", "the staged native module is not a x64 image (PE machine 0xaa64)", "other", null],
		["a message nobody has seen", LOAD("Es kann nichts gefunden werden, das passt."), "other", null],
		["an empty message", "", "other", null],
	];
	for (const [name, raw, kind, code] of cases) {
		it(`reads ${name} as ${kind}`, () => {
			const failure = classifyNativeFailure(raw);
			assert.equal(failure.kind, kind);
			assert.equal(failure.code, code);
			assert.equal(failure.raw, raw, "the raw error is kept whole");
		});
	}

	it("does not read a number inside a path or a digest as a Windows error", () => {
		assert.equal(classifyNativeFailure("did not load (C:\\Users\\u1260\\x225\\koffi.node: 5771260225)").kind, "other");
	});

	it("reads a deadline as a timeout even when its number looks like a Windows error", () => {
		assert.equal(classifyNativeFailure("the native stage child did not answer in 1260 ms").kind, "stage-timeout");
	});
});

describe("what the person is told", () => {
	const raws = {
		"blocked-by-policy": LOAD("This program is blocked by group policy."),
		"missing-or-quarantined": LOAD("The specified module could not be found."),
		"stage-timeout": "the native stage child did not answer in 60000 ms",
		other: "the staged native module does not match its digest",
	} as const;

	for (const [kind, raw] of Object.entries(raws)) {
		it(`says what happened, what to do and what does not work for ${kind}`, () => {
			const message = nativeFailureMessage(classifyNativeFailure(raw));
			assert.match(message, /koffi\.node/);
			assert.match(message, /README/);
			assert.ok(message.endsWith(NATIVE_FAILURE_EFFECT));
			assert.match(message, /New Session/);
			assert.match(message, /re-attaching a running Chat/);
			assert.match(message, /Saved conversations stay readable/);
		});
	}

	it("names the cause and the remedy of each class differently", () => {
		const remedies = Object.values(raws).map(raw => describeNativeFailure(classifyNativeFailure(raw)).remedy);
		assert.equal(new Set(remedies).size, 4);
		assert.match(remedies[0]!, /AppLocker.*by hash/s);
		assert.match(remedies[1]!, /quarantine/);
		assert.match(remedies[2]!, /Reload Window/);
		assert.match(remedies[3]!, /Copy diagnostics/);
	});

	it("quotes the Windows error number when the message names one, and only then", () => {
		assert.match(nativeFailureMessage(classifyNativeFailure(raws["blocked-by-policy"] + " 0x800704EC")), /Windows error 1260/);
		assert.doesNotMatch(nativeFailureMessage(classifyNativeFailure(raws.other)), /Windows error/);
	});
});

describe("the detail of a refused check", () => {
	it("is the plain statement when no load failed", () => {
		assert.equal(nativeUnavailableDetail(null), "the native module is unavailable");
	});

	it("names the cause and points at the troubleshooting when one did", () => {
		const detail = nativeUnavailableDetail(LOAD("This program is blocked by group policy."));
		assert.match(detail, /^the native module is unavailable \(Windows blocked OMP Desk's native module \(koffi\.node\)\): See Troubleshooting/);
	});
});

describe("the diagnostics", () => {
	it("carry every fact an administrator needs, one per line", () => {
		const text = nativeDiagnosticsText({
			failure: classifyNativeFailure(LOAD("This program is blocked by group policy.")),
			shipped: { path: "C:\\ext\\out\\native\\koffi.node", sha256: "a".repeat(64) },
			staged: { path: `C:\\gs\\runtime\\${"a".repeat(64)}\\koffi.node`, sha256: null },
			vscodeVersion: "1.141.1",
			deskVersion: "0.4.3",
			arch: "x64",
		});
		const lines = text.split("\n");
		assert.deepEqual(lines.map(line => line.split(":")[0]), [
			"OMP Desk native module diagnostics",
			"Cause class",
			"Windows error code",
			"Error",
			"Shipped koffi.node",
			"Shipped SHA-256",
			"Staged koffi.node",
			"Staged SHA-256",
			"Architecture",
			"VS Code",
			"OMP Desk",
		]);
		assert.match(text, /Cause class: blocked-by-policy/);
		assert.match(text, /Windows error code: 1260/);
		assert.match(text, new RegExp(`Shipped SHA-256: ${"a".repeat(64)}`));
		assert.match(text, /Staged SHA-256: not present/);
		assert.match(text, /Architecture: x64/);
		assert.match(text, /blocked by group policy/);
	});

	it("say what is unknown rather than leave a blank", () => {
		const text = nativeDiagnosticsText({
			failure: classifyNativeFailure("no such thing"),
			shipped: { path: "C:\\ext\\koffi.node", sha256: null },
			staged: null,
			vscodeVersion: "1.141.1",
			deskVersion: "0.4.3",
			arch: "arm64",
		});
		assert.match(text, /Windows error code: not reported/);
		assert.match(text, /Shipped SHA-256: unreadable/);
		assert.match(text, /Staged koffi\.node: unknown/);
	});
});
