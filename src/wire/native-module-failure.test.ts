/**
 * Why the native module did not load: which cause class each raw error is read as, what each class tells the person, and
 * what "Copy diagnostics" carries. The messages are the ones Windows gives for these causes through `process.dlopen`
 * (Node appends the module's path after the system text). Runner: `node --test src/wire/native-module-failure.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	NATIVE_FAILURE_EFFECT,
	classifyNativeFailure,
	describeNativeFailure,
	nativeDiagnosticsText,
	nativeFailureMessage,
	nativeTroubleshootingAnchor,
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
			assert.match(message, /Troubleshooting in the OMP Desk user guide/);
			assert.ok(message.endsWith(NATIVE_FAILURE_EFFECT));
			assert.match(message, /New Session/);
			assert.match(message, /re-attaching a running Chat/);
			assert.match(message, /saved sessions are still listed/);
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

describe("another account's access to the staged tree", () => {
	const FOLDER = "C:\\Users\\<account>\\AppData\\Roaming\\Code\\User\\globalStorage\\publisher.extension";
	const OTHER = "S-1-5-21-100-200-300-1002";
	const ME = "S-1-5-21-100-200-300-1001";
	const STAGED = (reason: string): string => `the staged runtime tree is not usable: ${reason}`;
	const explicit = STAGED(`the component ${FOLDER} on the path to the store lets ${OTHER} (PC\\OtherUser) replace or re-permission it (2032127: full control, set directly on it); this window runs as ${ME} (PC\\Me)`);

	it("is its own class, whatever words the path holds, and carries the facts", () => {
		for (const raw of [explicit, explicit.replace("<account>", "quarantine-1260-access is denied")]) {
			const failure = classifyNativeFailure(raw);
			assert.equal(failure.kind, "foreign-account-access");
			assert.equal(failure.code, null);
			assert.equal(failure.raw, raw);
			assert.equal(failure.kind === "foreign-account-access" && failure.foreign.principalName, "PC\\OtherUser");
		}
	});

	it("is still recognized in the wording that named only the mask", () => {
		const failure = classifyNativeFailure(STAGED(`the component ${FOLDER} on the path to the store lets ${OTHER} (PC\\OtherUser) replace or re-permission it (2032127)`));
		assert.equal(failure.kind, "foreign-account-access");
		assert.equal(failure.kind === "foreign-account-access" && failure.foreign.inherited, null);
	});

	it("tells the person the folder, the account, the account VS Code runs as, what to do and what does not work", () => {
		const message = nativeFailureMessage(classifyNativeFailure(explicit));
		assert.ok(message.startsWith(`The native module (koffi.node) did not load: another Windows account, PC\\OtherUser, has full control of ${FOLDER}, so it could replace the module that runs as PC\\Me. Remove that account's access to the folder, or run VS Code as the account you are signed in to Windows with, then choose Reload Window. See Troubleshooting in the OMP Desk user guide. Until it loads,`), message);
		assert.ok(message.endsWith(NATIVE_FAILURE_EFFECT));
		assert.doesNotMatch(message, /AppLocker|antivirus/i, "the policy remedy does not apply here");
	});

	it("opens its own section of the troubleshooting, and the other classes keep theirs", () => {
		assert.equal(nativeTroubleshootingAnchor(classifyNativeFailure(explicit)), "another-windows-account-can-reach-omp-desks-folders");
		assert.equal(nativeTroubleshootingAnchor(classifyNativeFailure(LOAD("This program is blocked by group policy."))), "the-native-module-is-blocked-or-missing");
		assert.equal(nativeTroubleshootingAnchor(classifyNativeFailure("the native stage child did not answer in 60000 ms")), "the-native-module-is-blocked-or-missing");
	});

	it("names the cause class and the facts in the diagnostics, after the error", () => {
		const text = nativeDiagnosticsText({
			failure: classifyNativeFailure(explicit),
			shipped: { path: "C:\\ext\\out\\native\\koffi.node", sha256: "a".repeat(64) },
			staged: null,
			vscodeVersion: "1.141.1",
			deskVersion: "0.4.12",
			arch: "x64",
		});
		const lines = text.split("\n");
		assert.deepEqual(lines.map(line => line.split(":")[0]), [
			"OMP Desk native module diagnostics", "Cause class", "Windows error code", "Error",
			"Folder", "Other account", "Its access", "Entry", "VS Code runs as",
			"Shipped koffi.node", "Shipped SHA-256", "Staged koffi.node", "Staged SHA-256", "Architecture", "VS Code", "OMP Desk",
		]);
		assert.equal(lines[1], "Cause class: foreign-account-access");
		assert.equal(lines[4], `Folder: ${FOLDER}`);
		assert.equal(lines[5], `Other account: ${OTHER} (PC\\OtherUser)`);
		assert.equal(lines[6], "Its access: full control (mask 2032127)");
		assert.equal(lines[7], "Entry: set directly on it");
		assert.equal(lines[8], `VS Code runs as: ${ME} (PC\\Me)`);
	});

	it("shows the cause in the detail of a refused check", () => {
		assert.match(nativeUnavailableDetail(explicit), /^the native module is unavailable \(The native module \(koffi\.node\) did not load: another Windows account, PC\\OtherUser, has full control of .*\): See Troubleshooting/);
	});
});
