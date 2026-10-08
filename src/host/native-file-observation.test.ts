/**
 * Tests for native file observation and the evidence journal.
 *
 * What is worth defending here: that nothing is read or written before explicit
 * consent and a verified store, that unsupported target shapes fail closed
 * instead of being guessed at, that a blob is committed before the record that
 * references it, that a tampered record or a corrupt blob is reported
 * unavailable rather than empty, and that an admission with no witnessed result
 * stays `unknown`. Every case runs against temp trees, almost all with an
 * injected ACL reader, so no machine ACL, no OMP install and no network is
 * involved; the one case that runs this machine's own `icacls` is skipped
 * everywhere but Windows, where the access rules it establishes only exist.
 */
import * as assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
	classifyNativeObservationTarget,
	extractNativeObservationTargets,
	nativeObservationDigestBytes,
	nativeObservationPathDigest,
	observeNativeFileState,
	summarizeNativeFileObservations,
	type NativeFileObservationCommit,
	type NativeFileObservationRecord,
	type NativeObservationTarget,
} from "./native-file-observation.ts";
import {
	NATIVE_FILE_OBSERVATION_DISCLOSURE_ID,
	type NativeFileObservationCommandResult,
	type NativeFileObservationStorageProbe,
	type NativeFileObservationStorePaths,
	disableNativeFileObservationCapture,
	grantNativeFileObservationConsent,
	isPermittedAclPrincipal,
	openNativeFileObservationJournal,
	parseIcaclsAcl,
	readNativeFileObservationConsent,
	resolveNativeFileObservationStorePaths,
	restrictNativeFileObservationStorage,
	verifyNativeFileObservationStorage,
} from "./native-file-observation-storage.ts";
import { permissionsPermitReplacement, posixAccessMarker, posixAccessProblem, readStorageOwners } from "./private-storage.ts";
import { shortDirectoryAlias } from "./short-name-test-support.ts";
import {
	createFileEvidenceHooks,
	createFileEvidenceObserver,
	resolveFileEvidenceNamespace,
	type FileEvidenceStoreRef,
} from "../omp/file-evidence.ts";
import { observationTextState } from "./file-evidence-reader.ts";

const OWNER = "owner-test-01";
const SLOT = "slot-test-01";
const SESSION = "session-000000000001";

let temp = "";
let workspace = "";
let store = "";
/** Roots created outside the temporary directory by the real-tools cases. */
const realRoots: string[] = [];

function refFor(overrides: Partial<FileEvidenceStoreRef> = {}): FileEvidenceStoreRef {
	return {
		storageRoot: store,
		ownerId: OWNER,
		slotId: SLOT,
		workspaceRoot: workspace,
		sessionId: SESSION,
		...overrides,
	};
}

function pathsFor(overrides: Partial<FileEvidenceStoreRef> = {}) {
	const namespace = resolveFileEvidenceNamespace(refFor(overrides));
	if (!namespace.ok) throw new Error(namespace.reason);
	return namespace.paths;
}

/**
 * A private workspace and store per observer case, so a disablement marker or a
 * recorded file from one case can never decide another case's outcome.
 */
async function isolatedRoots(label: string): Promise<{ readonly workspace: string; readonly store: string }> {
	const base = path.join(temp, `case-${label}`);
	const isolatedWorkspace = path.join(base, "ws");
	const isolatedStore = path.join(base, "store");
	await fs.mkdir(path.join(isolatedWorkspace, "src"), { recursive: true });
	await fs.writeFile(path.join(isolatedWorkspace, "src", "a.txt"), "hello");
	return { workspace: isolatedWorkspace, store: isolatedStore };
}

/**
 * The same, under the profile's local application data, for the cases that run this
 * machine's own access tools: the shared temporary directory grants a wider account
 * modify access on this machine, so a store beneath it is correctly refused as a
 * whole and could not exercise the store's own rules.
 */
async function isolatedRealRoots(label: string): Promise<{ readonly workspace: string; readonly store: string }> {
	const base = await fs.mkdtemp(path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "omp-acl-proof-"));
	realRoots.push(base);
	const isolatedWorkspace = path.join(base, `case-${label}`, "ws");
	const isolatedStore = path.join(base, `case-${label}`, "store");
	await fs.mkdir(path.join(isolatedWorkspace, "src"), { recursive: true });
	await fs.writeFile(path.join(isolatedWorkspace, "src", "a.txt"), "hello");
	return { workspace: isolatedWorkspace, store: isolatedStore };
}

/** An `icacls` listing naming exactly the given `principal:(rights)` entries. */
function entryListing(directory: string, entries: readonly string[]): string {
	const lines = entries.map(
		(entry, index) => `${index === 0 ? `${directory} ` : " ".repeat(directory.length + 1)}${entry}`,
	);
	return [...lines, "", "Successfully processed 1 files; Failed processing 0 files", ""].join("\r\n");
}

/** An injected `icacls` listing naming exactly the given principals. */
function aclListing(directory: string, principals: readonly string[]): string {
	return entryListing(
		directory,
		principals.map(principal => `${principal}:(OI)(CI)(F)`),
	);
}

const RESTRICTED_PRINCIPALS = [os.userInfo().username, "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"];

/** The qualified account `whoami` reports for this process, as the rules read it. */
const CURRENT_ACCOUNT = `${os.hostname()}\\${os.userInfo().username}`;

/** The owner read an injected store uses: this test's account owns the temp tree. */
function ownerReport(targets: readonly string[]): NativeFileObservationCommandResult {
	return { ok: true, stdout: targets.map(target => `${target}|${CURRENT_ACCOUNT}`).join("\r\n"), detail: null };
}

/** A Windows seam whose listing for a path is chosen by the case under test. */
function entryProbe(entriesFor: (target: string) => readonly string[]): NativeFileObservationStorageProbe {
	return {
		platform: "win32",
		currentUser: os.userInfo().username,
		currentAccount: CURRENT_ACCOUNT,
		runIcacls: async (directory: string) => ({ ok: true, stdout: entryListing(directory, entriesFor(directory)), detail: null }),
		readOwners: async (targets: readonly string[]) => ownerReport(targets),
	};
}

/** This machine's own `icacls`, used only by the cases that must not be simulated. */
const ICACLS = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");

const runIcacls = promisify(execFile);

/** This machine's real access listing for one directory or file. */
async function realAclOf(target: string): Promise<string> {
	return (await runIcacls(ICACLS, [target, "/Q"], { windowsHide: true })).stdout;
}

/**
 * Put one directory of the test tree on this machine under the same rules the store
 * itself uses, so a case can start from a profile-like carrier instead of the
 * sandbox temporary directory that carries the whole test tree.
 */
async function restrictRealDirectory(directory: string): Promise<void> {
	const applied = await runIcacls(
		ICACLS,
		[
			directory,
			"/inheritance:r",
			"/grant:r",
			`${CURRENT_ACCOUNT}:(OI)(CI)(F)`,
			"*S-1-5-18:(OI)(CI)(F)",
			"*S-1-5-32-544:(OI)(CI)(F)",
			"/Q",
		],
		{ windowsHide: true },
	);
	assert.match(applied.stdout, /Failed processing 0 files/, "the test tree could not be restricted");
}

/** A Windows seam that reports one listing for every path, or no listing at all. */
function probeWith(principals: readonly string[] | null): NativeFileObservationStorageProbe {
	return {
		platform: "win32",
		currentUser: os.userInfo().username,
		currentAccount: CURRENT_ACCOUNT,
		runIcacls: async (directory: string): Promise<NativeFileObservationCommandResult> => {
			if (principals === null) return { ok: false, stdout: "", detail: "icacls is unavailable" };
			return { ok: true, stdout: aclListing(directory, principals), detail: null };
		},
		readOwners: async (targets: readonly string[]) => ownerReport(targets),
	};
}

/** The directories one store namespace owns, in the order the rewrite visits them. */
function namespaceOrder(paths: NativeFileObservationStorePaths): string[] {
	return [
		paths.storageRoot,
		paths.ownerDirectory,
		paths.slotDirectory,
		paths.workspaceDirectory,
		paths.sessionDirectory,
		paths.blobsDirectory,
		paths.recordsDirectory,
		paths.temporaryDirectory,
	];
}

/** An observer ready to capture: consent granted, storage verified by injection. */
async function enabledObserver(
	label: string,
	sessionFile: string | null = null,
): Promise<{
	readonly paths: ReturnType<typeof pathsFor>;
	readonly workspace: string;
	readonly observer: ReturnType<typeof createFileEvidenceObserver>;
}> {
	const roots = await isolatedRoots(label);
	const namespace = resolveFileEvidenceNamespace({
		storageRoot: roots.store,
		ownerId: OWNER,
		slotId: SLOT,
		workspaceRoot: roots.workspace,
		sessionId: SESSION,
	});
	if (!namespace.ok) throw new Error(namespace.reason);
	const paths = namespace.paths;
	const granted = await grantNativeFileObservationConsent({
		paths,
		disclosureId: NATIVE_FILE_OBSERVATION_DISCLOSURE_ID,
		preApprovalCaptureAcknowledged: true,
	});
	assert.equal(granted.granted, true, granted.reason ?? "consent was refused");
	return {
		paths,
		workspace: roots.workspace,
		observer: createFileEvidenceObserver({
			storageRoot: roots.store,
			ownerId: OWNER,
			slotId: SLOT,
			workspaceRoot: roots.workspace,
			processInstanceId: "proctest-01",
			producerEpoch: "epochtest-01",
			session: () => ({ sessionId: SESSION, sessionFile, cwd: roots.workspace }),
			probe: probeWith(RESTRICTED_PRINCIPALS),
		}),
	};
}

function commitFor(
	paths: ReturnType<typeof pathsFor>,
	bytes: Uint8Array,
	overrides: Partial<NativeFileObservationCommit> = {},
): NativeFileObservationCommit {
	const absolute = path.join(workspace, "src", "a.txt");
	return {
		stage: "admission-observed",
		observedAtMs: Date.now(),
		origin: {
			ownerId: paths.ownerId,
			slotId: paths.slotId,
			processInstanceId: "proctest-01",
			producerEpoch: "epochtest-01",
		},
		session: { sessionId: paths.sessionId, sessionFileDigest: null, workspaceDigest: paths.workspaceDigest },
		toolCall: { toolCallId: "call-0001", toolName: "write", occurrence: 0 },
		target: {
			raw: "src/a.txt",
			kind: "regular-local-file",
			pathDigest: nativeObservationPathDigest(absolute),
			displayPath: "src/a.txt",
			unavailableReason: null,
		},
		observation: {
			presence: "file",
			consistency: "stable",
			contentKind: "text",
			byteLength: bytes.length,
			blobId: nativeObservationDigestBytes(bytes),
			elapsedMs: 1,
			comparedFields: ["size"],
			unavailableReason: null,
		},
		toolOutcome: "unknown",
		notes: [],
		...overrides,
	};
}

async function recordFilesOf(paths: ReturnType<typeof pathsFor>): Promise<string[]> {
	return (await fs.readdir(paths.recordsDirectory)).filter(name => name.endsWith(".json"));
}

async function blobFilesOf(paths: ReturnType<typeof pathsFor>): Promise<string[]> {
	return fs.readdir(paths.blobsDirectory).catch(() => []);
}

before(async () => {
	temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-file-evidence-"));
	workspace = path.join(temp, "ws");
	store = path.join(temp, "store");
	await fs.mkdir(path.join(workspace, "src"), { recursive: true });
	await fs.writeFile(path.join(workspace, "src", "a.txt"), "hello");
	await fs.writeFile(path.join(workspace, "empty.txt"), "");
});

after(async () => {
	await fs.rm(temp, { recursive: true, force: true });
	for (const root of realRoots) {
		// The cases rewrite the access rules of their own directories, so the tree is
		// returned to the inherited rules before it is removed.
		await runIcacls(ICACLS, [root, "/reset", "/T", "/C", "/Q"], { windowsHide: true }).catch(() => {});
		await fs.rm(root, { recursive: true, force: true }).catch(() => {});
	}
});

describe("native observation target policy", () => {
	function kindOf(rawPath: string): NativeObservationTarget {
		return classifyNativeObservationTarget({ rawPath, cwd: workspace, workspaceRoot: workspace, platform: "win32" });
	}

	it("refuses every target shape that is not a plain local file", () => {
		const refused: Array<[string, string]> = [
			["xd://memory/notes.md", "internal-url"],
			["local://plans/plan.md", "internal-url"],
			["ssh://host/srv/app.ts", "ssh"],
			["\\\\server\\share\\a.txt", "unc-or-device"],
			["\\\\?\\C:\\ws\\a.txt", "unc-or-device"],
			["//server/share/a.txt", "unc-or-device"],
			["src\\a.txt:stream", "alternate-data-stream"],
			["src\\bundle.zip:inner/app.ts", "archive-member"],
			["src\\state.sqlite:rows", "sqlite-database"],
			["src/*.ts", "unsupported-path-shape"],
			["src\\", "unsupported-path-shape"],
			["C:a.txt", "unsupported-path-shape"],
			["NUL", "unc-or-device"],
			["", "empty-path"],
		];
		for (const [rawPath, expected] of refused) {
			const target = kindOf(rawPath);
			assert.equal(target.kind, expected, `${rawPath} should classify as ${expected}`);
			assert.equal(target.byteCaptureAllowed, false, `${rawPath} must not be byte-capturable`);
			assert.notEqual(target.unavailableReason, null, `${rawPath} needs a reason`);
		}
	});

	it("resolves a plain local path inside the workspace and refuses one outside it", () => {
		const inside = kindOf("src/a.txt");
		assert.equal(inside.kind, "regular-local-file");
		assert.equal(inside.byteCaptureAllowed, true);
		assert.equal(inside.displayPath, "src/a.txt");
		assert.equal(inside.absolutePath, path.join(workspace, "src", "a.txt"));

		const outside = kindOf(path.join(temp, "elsewhere.txt"));
		assert.equal(outside.kind, "outside-workspace");
		assert.equal(outside.byteCaptureAllowed, false);
	});

	it("addresses only the tool forms that name one file", () => {
		const write = extractNativeObservationTargets({ toolName: "write", input: { path: "src/a.txt", content: "x" } });
		assert.deepEqual(write.rawPaths, ["src/a.txt"]);
		assert.equal(write.unaddressableReason, null);

		const edit = extractNativeObservationTargets({ toolName: "edit", input: { path: "src/a.txt" } });
		assert.deepEqual(edit.rawPaths, ["src/a.txt"]);

		const hashline = extractNativeObservationTargets({ toolName: "edit", input: { input: "src/a.txt#ABCD\n..." } });
		assert.deepEqual(hashline.rawPaths, []);
		assert.match(hashline.unaddressableReason ?? "", /patch text/);

		const astEdit = extractNativeObservationTargets({ toolName: "ast_edit", input: { paths: ["src"] } });
		assert.deepEqual(astEdit.rawPaths, []);
		assert.match(astEdit.unaddressableReason ?? "", /patterns/);

		const bash = extractNativeObservationTargets({ toolName: "bash", input: { command: "echo hi > src/a.txt" } });
		assert.deepEqual(bash.rawPaths, []);
		assert.match(bash.unaddressableReason ?? "", /no per-file target contract/);
	});

	it("tells an absent target apart from an empty file", async () => {
		const absent = await observeNativeFileState({
			target: kindOf("src/missing.txt"),
			physicalWorkspaceRoot: await fs.realpath(workspace),
		});
		assert.equal(absent.presence, "absent");
		assert.equal(absent.byteLength, null);
		assert.equal(absent.blobId, null);

		const empty = await observeNativeFileState({
			target: kindOf("empty.txt"),
			physicalWorkspaceRoot: await fs.realpath(workspace),
		});
		assert.equal(empty.presence, "file");
		assert.equal(empty.contentKind, "empty");
		assert.equal(empty.byteLength, 0);
		assert.equal(empty.blobId, nativeObservationDigestBytes(Buffer.alloc(0)));
		assert.deepEqual(empty.bytes, Buffer.alloc(0));
	});

	it("stores no bytes for a file above the observation cap", async () => {
		const big = path.join(workspace, "big.txt");
		await fs.writeFile(big, "x".repeat(64));
		const state = await observeNativeFileState({
			target: kindOf("big.txt"),
			physicalWorkspaceRoot: await fs.realpath(workspace),
			limits: { maxObservedBlobBytes: 8 },
		});
		assert.equal(state.presence, "file");
		assert.equal(state.byteLength, null);
		assert.equal(state.bytes, null);
		assert.match(state.unavailableReason ?? "", /above the 8 byte observation cap/);
	});

	it("refuses a target that resolves outside the workspace through a junction", { skip: process.platform !== "win32" }, async () => {
		const outside = path.join(temp, "outside");
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(path.join(outside, "secret.txt"), "secret");
		const junction = path.join(workspace, "escape");
		await fs.rm(junction, { recursive: true, force: true });
		symlinkSync(outside, junction, "junction");

		const target = kindOf("escape/secret.txt");
		assert.equal(target.kind, "regular-local-file");
		const state = await observeNativeFileState({
			target,
			physicalWorkspaceRoot: await fs.realpath(workspace),
		});
		assert.equal(state.bytes, null);
		assert.equal(state.blobId, null);
		assert.match(state.unavailableReason ?? "", /resolves outside the physical workspace/);
	});
});

describe("native observation storage gates", () => {
	it("holds POSIX paths to an owner-only mode, with a sticky carrier accepted", () => {
		const owned = { uid: 1000, ownerUid: 1000 };
		assert.equal(posixAccessProblem({ target: "/s/root", kind: "directory", mode: 0o40700, ...owned }), null);
		assert.match(
			posixAccessProblem({ target: "/s/root", kind: "directory", mode: 0o40755, ...owned }) ?? "",
			/mode 755, reachable beyond this account/,
		);
		assert.match(
			posixAccessProblem({ target: "/s/root", kind: "directory", mode: 0o40777, ...owned }) ?? "",
			/writable beyond this account/,
		);
		// A file the store hands out is held to the same line as its directories.
		assert.equal(posixAccessProblem({ target: "/s/blob", kind: "file", mode: 0o100600, ...owned }), null);
		assert.match(
			posixAccessProblem({ target: "/s/blob", kind: "file", mode: 0o100644, ...owned }) ?? "",
			/mode 644, reachable beyond this account/,
		);
		assert.match(
			posixAccessProblem({ target: "/s/blob", kind: "file", mode: 0o100666, ...owned }) ?? "",
			/writable beyond this account/,
		);
		// A directory the store is reached through may be shared: the root's sticky
		// temporary directory is accepted, and so is a root-owned one nobody else may
		// write, while a component owned by another account never is.
		assert.equal(posixAccessProblem({ target: "/tmp", kind: "carrier", mode: 0o41777, uid: 0, ownerUid: 1000 }), null);
		assert.equal(posixAccessProblem({ target: "/usr", kind: "carrier", mode: 0o40755, uid: 0, ownerUid: 1000 }), null);
		assert.match(
			posixAccessProblem({ target: "/shared", kind: "carrier", mode: 0o40777, uid: 0, ownerUid: 1000 }) ?? "",
			/on the path to the store is writable beyond this account/,
		);
		// A sticky directory another account owns is not shared safely: its owner can
		// remove what it likes inside it.
		assert.match(
			posixAccessProblem({ target: "/other", kind: "carrier", mode: 0o41777, uid: 4242, ownerUid: 1000 }) ?? "",
			/owned by uid 4242/,
		);
		// An owner can rewrite the permissions of what it owns.
		assert.match(
			posixAccessProblem({ target: "/s/root", kind: "directory", mode: 0o40700, uid: 0, ownerUid: 1000 }) ?? "",
			/owned by uid 0/,
		);
	});

	it("refuses a store inside the workspace it observes", async () => {
		const inside = path.join(workspace, ".omp-evidence");
		const namespace = resolveFileEvidenceNamespace(refFor({ storageRoot: inside }));
		assert.equal(namespace.ok, false);
		assert.match(namespace.ok ? "" : namespace.reason, /inside the workspace/);

		// The verifier refuses independently, so a hand-built path cannot bypass it.
		const paths = pathsFor();
		const readiness = await verifyNativeFileObservationStorage({
			paths: { ...paths, workspaceRoot: temp },
			probe: probeWith(RESTRICTED_PRINCIPALS),
		});
		assert.equal(readiness.ready, false);
		assert.match(readiness.reason ?? "", /inside the workspace/);
	});

	it("refuses an access listing that grants anything beyond the same user", async () => {
		const paths = pathsFor();
		const readiness = await verifyNativeFileObservationStorage({
			paths,
			probe: probeWith([os.userInfo().username, "NT AUTHORITY\\SYSTEM", "BUILTIN\\Users"]),
		});
		assert.equal(readiness.ready, false);
		assert.match(readiness.reason ?? "", /readable by BUILTIN\\Users/);
		assert.deepEqual(readiness.permittedPrincipals, []);
	});

	it("matches the account as a Windows identity, not as a name", async () => {
		const paths = pathsFor({ sessionId: `${SESSION}-identity` });
		const foreign = `SOMEDOMAIN\\${os.userInfo().username}`;
		const readiness = await verifyNativeFileObservationStorage({
			paths,
			probe: probeWith([foreign, "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"]),
		});
		assert.equal(readiness.ready, false, "another domain's account of the same name was accepted");
		assert.match(readiness.reason ?? "", /readable by SOMEDOMAIN/);

		// The qualifier this process was told about is the one that reads as this account.
		const qualified = await verifyNativeFileObservationStorage({
			paths,
			probe: probeWith([CURRENT_ACCOUNT, "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"]),
		});
		assert.equal(qualified.ready, true, qualified.reason ?? "the qualified account was refused");
	});

	it("reads the files it trusts instead of taking their directory's rules for them", async () => {
		const paths = pathsFor({ sessionId: `${SESSION}-files` });
		const granted = await grantNativeFileObservationConsent({
			paths,
			disclosureId: NATIVE_FILE_OBSERVATION_DISCLOSURE_ID,
			preApprovalCaptureAcknowledged: true,
		});
		assert.equal(granted.granted, true, granted.reason ?? "consent was refused");

		// The consent record carries its own entry for another account; the directory
		// that holds it says nothing about that.
		const readiness = await verifyNativeFileObservationStorage({
			paths,
			probe: entryProbe(target =>
				target === paths.consentFile
					? [`${CURRENT_ACCOUNT}:(F)`, "NT AUTHORITY\\SYSTEM:(F)", "BUILTIN\\Users:(RX)"]
					: RESTRICTED_PRINCIPALS.map(principal => `${principal}:(OI)(CI)(F)`),
			),
		});
		assert.equal(readiness.ready, false, "a file with its own wide entry was accepted");
		assert.match(readiness.reason ?? "", /readable by BUILTIN\\Users/);
		assert.match(readiness.reason ?? "", /consent\.json/);
	});

	it("refuses a store it does not own and a carrier another account can replace", async () => {
		const paths = pathsFor({ sessionId: `${SESSION}-carrier` });
		const foreignOwner = await verifyNativeFileObservationStorage({
			paths,
			probe: {
				...probeWith(RESTRICTED_PRINCIPALS),
				readOwners: async (targets: readonly string[]) => ({
					ok: true,
					stdout: targets.map(target => `${target}|SOMEONE-ELSE\\other`).join("\r\n"),
					detail: null,
				}),
			},
		});
		assert.equal(foreignOwner.ready, false, "an owner outside the trusted set was accepted");
		assert.match(foreignOwner.reason ?? "", /owned by SOMEONE-ELSE\\other/);

		const unreadableOwner = await verifyNativeFileObservationStorage({
			paths,
			probe: {
				...probeWith(RESTRICTED_PRINCIPALS),
				readOwners: async () => ({ ok: false, stdout: "", detail: "no owner tool" }),
			},
		});
		assert.equal(unreadableOwner.ready, false, "an unread owner was accepted");
		assert.match(unreadableOwner.reason ?? "", /owner could not be read/);

		// The directory the store is reached through may grant another account read
		// access to what it holds; the right to replace or re-permission it refuses.
		const carrier = path.dirname(paths.storageRoot);
		const readableCarrier = await verifyNativeFileObservationStorage({
			paths,
			probe: entryProbe(target =>
				target === carrier
					? [`${CURRENT_ACCOUNT}:(OI)(CI)(F)`, "NT AUTHORITY\\SYSTEM:(OI)(CI)(F)", "BUILTIN\\Users:(RX)"]
					: RESTRICTED_PRINCIPALS.map(principal => `${principal}:(OI)(CI)(F)`),
			),
		});
		assert.equal(readableCarrier.ready, true, readableCarrier.reason ?? "a read-only component was refused");

		const writableCarrier = await verifyNativeFileObservationStorage({
			paths,
			probe: entryProbe(target =>
				target === carrier
					? [`${CURRENT_ACCOUNT}:(OI)(CI)(F)`, "NT AUTHORITY\\SYSTEM:(OI)(CI)(F)", "BUILTIN\\Users:(M)"]
					: RESTRICTED_PRINCIPALS.map(principal => `${principal}:(OI)(CI)(F)`),
			),
		});
		assert.equal(writableCarrier.ready, false, "a component another account can replace was accepted");
		assert.match(writableCarrier.reason ?? "", /on the path to the store/);
		assert.match(writableCarrier.reason ?? "", /BUILTIN\\Users/);
	});

	it("verifies every component below the volume root and trusts the root itself", async () => {
		const paths = pathsFor({ sessionId: `${SESSION}-chain` });
		const nearest = path.dirname(paths.storageRoot);
		const distant = path.dirname(nearest);
		const volumeRoot = path.parse(paths.storageRoot).root;
		const permitted = RESTRICTED_PRINCIPALS.map(principal => `${principal}:(OI)(CI)(F)`);

		// A distant component is as much part of the path as the nearest one.
		const distantComponent = await verifyNativeFileObservationStorage({
			paths,
			probe: entryProbe(target => (target === distant ? [...permitted, "BUILTIN\\Users:(M)"] : permitted)),
		});
		assert.equal(distantComponent.ready, false, "a distant component another account can replace was accepted");
		assert.match(distantComponent.reason ?? "", /on the path to the store/);
		assert.match(distantComponent.reason ?? "", new RegExp(distant.replace(/\\/g, "\\\\")));

		// The volume root is the platform's trust anchor, so it is not read as a
		// component of the path — it cannot be renamed or deleted.
		const anchored = await verifyNativeFileObservationStorage({
			paths,
			probe: entryProbe(target =>
				target === volumeRoot
					? ["NT AUTHORITY\\Authenticated Users:(M)", "Mandatory Label\\High Mandatory Level:(NW)"]
					: permitted,
			),
		});
		assert.equal(anchored.ready, true, anchored.reason ?? "the volume root was read as a component");
		assert.equal(
			anchored.evidence.some(line => line.includes(volumeRoot) && line.includes("trust anchor")),
			true,
			"the trust anchor is not named in the evidence",
		);
	});

	it("reads an integrity label or a deny entry as no access at all", async () => {
		const paths = pathsFor({ sessionId: `${SESSION}-entries` });
		const permissions = ["F", "RX", "W", "AD", "GW", "M", "D", "DC", "WDAC", "WO", "GA", "XY"];
		const fatal = permissions.filter(permission => permissionsPermitReplacement(permission));
		assert.deepEqual(fatal, ["F", "M", "D", "DC", "WDAC", "WO", "GA", "XY"], "the replacement rule changed");

		// A label grants nothing, and a deny entry takes access away rather than giving
		// it: neither may refuse a store.
		const probe = entryProbe(target =>
			target === path.dirname(paths.storageRoot)
				? [
						`${CURRENT_ACCOUNT}:(OI)(CI)(F)`,
						"NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
						"Mandatory Label\\High Mandatory Level:(NW)",
						"BUILTIN\\Users:(DENY)(F)",
					]
				: RESTRICTED_PRINCIPALS.map(principal => `${principal}:(OI)(CI)(F)`),
		);
		const readiness = await verifyNativeFileObservationStorage({ paths, probe });
		assert.equal(readiness.ready, true, readiness.reason ?? "a label or deny entry refused the store");

		const parsed = parseIcaclsAcl(
			entryListing("C:\\s", [
				"NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
				"BUILTIN\\Users:(DENY)(F)",
				"Mandatory Label\\High Mandatory Level:(NW)",
			]),
			"C:\\s",
		);
		assert.deepEqual(parsed.principals, ["NT AUTHORITY\\SYSTEM"], "only granting entries name principals");
		assert.equal(parsed.entries.length, 2, "the label is not an entry");
		assert.equal(parsed.entries[1]!.denied, true);

		// A system that prints the label in its own language is classified by the rights
		// the entry carries, so a label never refuses a store and never hides one.
		const localized = parseIcaclsAcl(
			entryListing("C:\\s", [
				"NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
				"\\u041c\\u0435\\u0442\\u043a\\u0430 \\u043e\\u0431\\u044f\\u0437\\u0430\\u0442\\u0435\\u043b\\u044c\\u043d\\u043e\\u0441\\u0442\\u0438\\High Mandatory Level:(NW)",
			]),
			"C:\\s",
		);
		assert.deepEqual(localized.principals, ["NT AUTHORITY\\SYSTEM"], "a localized label was read as a grant");
		assert.equal(localized.entries.length, 1);
		// An entry whose rights are a label's is a label even under an unreadable name;
		// anything else keeps its name and rights and is decided by the rules.
		const unclassified = parseIcaclsAcl(
			entryListing("C:\\s", ["SOMEONE\\nobody:(M)", "SOMEONE\\nobody:(NW)"]),
			"C:\\s",
		);
		assert.deepEqual(unclassified.principals, ["SOMEONE\\nobody"], "an unclassifiable entry was dropped");
	});

	it("accepts the owner spelling the tools use for a well-known account", async () => {
		const paths = pathsFor({ sessionId: `${SESSION}-owner-spelling` });
		const readiness = await verifyNativeFileObservationStorage({
			paths,
			probe: {
				...probeWith(RESTRICTED_PRINCIPALS),
				// `dir /q` prints the well-known authority without its `NT ` part.
				readOwners: async (targets: readonly string[]) => ({
					ok: true,
					stdout: targets.map(target => `${target}|AUTHORITY\\SYSTEM`).join("\r\n"),
					detail: null,
				}),
			},
		});
		assert.equal(readiness.ready, true, readiness.reason ?? "AUTHORITY\\SYSTEM was refused as an owner");
	});

	it(
		"reads this machine's real owners and accepts a real chain without a probe",
		{ skip: process.platform !== "win32" },
		async () => {
			const roots = await isolatedRealRoots("real-chain");
			const base = path.dirname(roots.store);
			await restrictRealDirectory(base);
			const namespace = resolveFileEvidenceNamespace({
				storageRoot: roots.store,
				ownerId: OWNER,
				slotId: SLOT,
				workspaceRoot: roots.workspace,
				sessionId: `${SESSION}-real-chain`,
			});
			if (!namespace.ok) throw new Error(namespace.reason);

			// The real reads, no injected seam: whatever this machine's tools answer is
			// what the store must be held to.
			const owners = await readStorageOwners([base, process.env.LOCALAPPDATA ?? base, "C:\\Users"]);
			assert.equal(owners.ok, true, owners.detail ?? "the owner read failed");
			const reported = new Map(
				owners.stdout
					.split(/\r?\n/)
					.filter(line => line.includes("|"))
					.map(line => [line.slice(0, line.indexOf("|")), line.slice(line.indexOf("|") + 1)] as const),
			);
			for (const target of [base, process.env.LOCALAPPDATA ?? base, "C:\\Users"]) {
				const owner = reported.get(target);
				assert.equal(typeof owner, "string", `${target} has no owner in the report`);
				assert.equal(
					isPermittedAclPrincipal(owner ?? "", CURRENT_ACCOUNT),
					true,
					`the owner read reported ${owner} for ${target}, which the rules do not accept`,
				);
			}

			const readiness = await verifyNativeFileObservationStorage({ paths: namespace.paths });

			assert.equal(
				readiness.ready === true || (readiness.reason ?? "").startsWith("the component "),
				true,
				`the store's own paths were refused: ${readiness.reason ?? ""}`,
			);
			if (readiness.ready) {
				assert.equal(
					readiness.evidence.some(line => line.includes("trust anchor")),
					true,
					"the accepted chain does not name the platform trust anchor",
				);
			}
		},
	);

	it("refuses every access marker that can stand for an extended access list", () => {
		// Only a clean mode, or GNU coreutils' context-only `.`, proves no access list.
		assert.equal(posixAccessMarker("-rw------- 1 u g 0 Jan 1 00:00 /s/blob").kind, "none");
		assert.equal(posixAccessMarker("drwx------ 2 u g 64 Jan 1 00:00 /s/root").kind, "none");
		assert.equal(posixAccessMarker("-rw-r--r--. 1 u g 0 Jan 1 00:00 /s/blob").kind, "lsm-context-only");
		// `+` is an access list; `?` means the list could not be read; on Apple, `@`
		// suppresses `+` when attributes coexist with one, and `%` suppresses both.
		for (const marker of ["+", "@", "%", "?", "*"]) {
			const reading = posixAccessMarker(`-rw-------${marker} 1 u g 0 Jan 1 00:00 /s/blob`);
			assert.equal(reading.kind, "ambiguous", `marker ${marker} was accepted`);
			assert.equal(reading.kind === "ambiguous" ? reading.marker : "", marker);
		}
		assert.equal(posixAccessMarker("-rw-------+@ 1 u g 0 Jan 1 00:00 /s/blob").kind, "ambiguous");
		// A listing without a readable mode line is unreadable, never "no ACL".
		assert.equal(posixAccessMarker("ls: /s/blob: No such file or directory").kind, "unreadable");
		assert.equal(posixAccessMarker("").kind, "unreadable");
	});

	it(
		"accepts an owner-only POSIX store where no extended access list exists",
		{ skip: process.platform === "win32" },
		async () => {
			// Real POSIX evidence: a freshly created 0700 tree, this process's own
			// account, and the default ACL-marker read. Runs on a POSIX host only.
			const roots = await isolatedRoots("posix-real");
			const namespace = resolveFileEvidenceNamespace({
				storageRoot: roots.store,
				ownerId: OWNER,
				slotId: SLOT,
				workspaceRoot: roots.workspace,
				sessionId: `${SESSION}-posix-real`,
			});
			if (!namespace.ok) throw new Error(namespace.reason);
			const paths = namespace.paths;
			await fs.mkdir(paths.temporaryDirectory, { recursive: true, mode: 0o700 });
			await fs.chmod(paths.temporaryDirectory, 0o700);

			const readiness = await verifyNativeFileObservationStorage({
				paths,
				probe: { platform: process.platform, ownerUid: process.getuid?.() },
			});

			assert.equal(readiness.ready, true, readiness.reason ?? "an owner-only POSIX store was refused");
			assert.equal(
				readiness.evidence.some(line => line.includes("access marker")),
				true,
				"the access-marker check is not reported in the evidence",
			);
		},
	);

	it("refuses a store path that is a link or reparse point", { skip: process.platform !== "win32" }, async () => {
		const roots = await isolatedRoots("reparse-store");
		const namespace = resolveFileEvidenceNamespace({
			storageRoot: roots.store,
			ownerId: OWNER,
			slotId: SLOT,
			workspaceRoot: roots.workspace,
			sessionId: `${SESSION}-reparse`,
		});
		if (!namespace.ok) throw new Error(namespace.reason);
		const paths = namespace.paths;
		const elsewhere = path.join(roots.store, "elsewhere");
		await fs.mkdir(elsewhere, { recursive: true });
		await fs.mkdir(paths.sessionDirectory, { recursive: true });
		symlinkSync(elsewhere, paths.blobsDirectory, "junction");

		const readiness = await verifyNativeFileObservationStorage({ paths, probe: probeWith(RESTRICTED_PRINCIPALS) });

		assert.equal(readiness.ready, false, "a linked store directory was accepted");
		assert.match(readiness.reason ?? "", /link or reparse point/);
	});

	it(
		"accepts a store spelled through an 8.3 short name, and refuses one reached through a junction above it",
		{ skip: process.platform !== "win32" },
		async t => {
			// A long name, so the volume gives its directory a distinct short one.
			const parent = path.join(temp, "case-short-name-spelled-store-parent");
			await fs.mkdir(parent, { recursive: true });
			const alias = shortDirectoryAlias(parent);
			if (alias === null) {
				t.skip("8.3 short names are unavailable on this volume");
				return;
			}
			const verify = async (storeRoot: string, label: string) => {
				const namespace = resolveFileEvidenceNamespace({
					storageRoot: path.join(storeRoot, "store"),
					ownerId: OWNER,
					slotId: SLOT,
					workspaceRoot: workspace,
					sessionId: `${SESSION}-${label}`,
				});
				if (!namespace.ok) throw new Error(namespace.reason);
				await fs.mkdir(namespace.paths.temporaryDirectory, { recursive: true });
				return verifyNativeFileObservationStorage({ paths: namespace.paths, probe: probeWith(RESTRICTED_PRINCIPALS) });
			};

			const spelled = await verify(alias, "short-name");
			assert.equal(spelled.ready, true, spelled.reason ?? "a store spelled through a short name was refused");

			const junction = path.join(temp, "case-short-name-junction");
			symlinkSync(parent, junction, "junction");
			const redirected = await verify(junction, "short-name-junction");
			assert.equal(redirected.ready, false, "a store reached through a junction was accepted");
			assert.match(redirected.reason ?? "", /link or reparse point/);
		},
	);

	it("refuses when the access listing cannot be read at all", async () => {
		const paths = pathsFor();
		const readiness = await verifyNativeFileObservationStorage({ paths, probe: probeWith(null) });
		assert.equal(readiness.ready, false);
		assert.match(readiness.reason ?? "", /could not be verified/);

		const unreadable = await verifyNativeFileObservationStorage({
			paths,
			probe: { platform: "win32", currentUser: "someone", runIcacls: async () => ({ ok: true, stdout: "no entries here", detail: null }) },
		});
		assert.equal(unreadable.ready, false);
		assert.match(unreadable.reason ?? "", /could not be read/);
	});

	it("accepts an owner-only listing and proves the store writable", async () => {
		const paths = pathsFor();
		const readiness = await verifyNativeFileObservationStorage({ paths, probe: probeWith(RESTRICTED_PRINCIPALS) });
		assert.equal(readiness.ready, true, readiness.reason ?? "store was refused");
		assert.deepEqual(readiness.permittedPrincipals, RESTRICTED_PRINCIPALS);
		assert.equal(readiness.evidence.length >= 3, true);
	});

	it("reads the principal out of a listing whose first line carries the path", () => {
		const directory = "C:\\Users\\someone\\store";
		const report = parseIcaclsAcl(aclListing(directory, RESTRICTED_PRINCIPALS), directory);
		assert.equal(report.parsed, true);
		assert.deepEqual(report.principals, RESTRICTED_PRINCIPALS);
	});

	it("establishes the access rules it requires, then verifies them independently", async () => {
		const paths = pathsFor({ sessionId: `${SESSION}-harden` });
		const applied: Array<{ directory: string; args: readonly string[] }> = [];
		const account = `${os.hostname()}\\${os.userInfo().username}`;
		// The store's root inherits an entry from outside the store; the inheritable
		// grant a rewrite applies replaces it for the root and for everything the root
		// already holds, so no directory below it needs a rewrite of its own.
		let widened = true;
		const restriction = await restrictNativeFileObservationStorage({
			paths,
			probe: {
				...probeWith(RESTRICTED_PRINCIPALS),
				runIcacls: async (directory: string) => ({
					ok: true,
					stdout: aclListing(directory, widened ? [...RESTRICTED_PRINCIPALS, "BUILTIN\\Users"] : RESTRICTED_PRINCIPALS),
					detail: null,
				}),
				applyIcacls: async (directory, args) => {
					applied.push({ directory, args });
					widened = false;
					return { ok: true, stdout: "", detail: null };
				},
			},
		});
		assert.equal(restriction.restricted, true, restriction.reason ?? "the store was not restricted");
		assert.equal(restriction.readiness?.ready, true);
		assert.deepEqual(
			applied.map(entry => entry.directory),
			[paths.storageRoot],
			"only the directory that was not proven limited is rewritten",
		);
		assert.deepEqual([...applied[0]!.args], [
			"/inheritance:r",
			"/grant:r",
			`${account}:(OI)(CI)(F)`,
			"*S-1-5-18:(OI)(CI)(F)",
			"*S-1-5-32-544:(OI)(CI)(F)",
			"/Q",
		]);

		// A directory that kept an entry beyond this account is rewritten from itself;
		// `/T` must never appear, because a recursive rewrite leaves every file it
		// reaches with no access entry at all.
		const retained = pathsFor({ sessionId: `${SESSION}-harden-nested` });
		const nested: string[] = [];
		const nestedRewrite = await restrictNativeFileObservationStorage({
			paths: retained,
			probe: {
				...probeWith(RESTRICTED_PRINCIPALS),
				runIcacls: async (directory: string) => ({
					ok: true,
					stdout: aclListing(
						directory,
						directory === retained.recordsDirectory && !nested.includes(directory)
							? [...RESTRICTED_PRINCIPALS, "BUILTIN\\Users"]
							: RESTRICTED_PRINCIPALS,
					),
					detail: null,
				}),
				applyIcacls: async (directory, args) => {
					assert.equal(args.includes("/T"), false, "a recursive rewrite empties the access list of every file it reaches");
					nested.push(directory);
					return { ok: true, stdout: "", detail: null };
				},
			},
		});
		assert.equal(nestedRewrite.restricted, true, nestedRewrite.reason ?? "the nested store was not restricted");
		assert.deepEqual(nested, [retained.recordsDirectory], "only the directory that was still readable by others is rewritten");

		// A store that is already limited to this account, SYSTEM and Administrators is
		// left exactly as it is: no rewrite is attempted, and nothing can be emptied.
		const untouched = pathsFor({ sessionId: `${SESSION}-harden-none` });
		const noRewrite = await restrictNativeFileObservationStorage({
			paths: untouched,
			probe: {
				...probeWith(RESTRICTED_PRINCIPALS),
				applyIcacls: async () => ({ ok: false, stdout: "", detail: "icacls must not run" }),
			},
		});
		assert.equal(noRewrite.restricted, true, noRewrite.reason ?? "an already limited store was refused");
	});

	it("leaves capture off when the access rewrite or the account lookup fails", async () => {
		const paths = pathsFor({ sessionId: `${SESSION}-harden-fail` });
		const failedRewrite = await restrictNativeFileObservationStorage({
			paths,
			probe: {
				// A directory that is not limited yet is the one the rewrite runs on.
				...probeWith([os.userInfo().username, "NT AUTHORITY\\Authenticated Users"]),
				applyIcacls: async () => ({ ok: false, stdout: "", detail: "icacls exited with 5" }),
			},
		});
		assert.equal(failedRewrite.restricted, false);
		assert.match(failedRewrite.reason ?? "", /could not be restricted/);
		assert.equal(failedRewrite.readiness, null);

		const noAccount = await restrictNativeFileObservationStorage({
			paths,
			probe: { ...probeWith(RESTRICTED_PRINCIPALS), currentAccount: "" },
		});
		assert.equal(noAccount.restricted, false);
		assert.match(noAccount.reason ?? "", /owning account could not be resolved/);

		// A rewrite that leaves an over-broad entry is caught by the verification.
		const stillPermissive = await restrictNativeFileObservationStorage({
			paths,
			probe: {
				...probeWith([os.userInfo().username, "NT AUTHORITY\\Authenticated Users"]),
				applyIcacls: async () => ({ ok: true, stdout: "", detail: null }),
			},
		});
		assert.equal(stillPermissive.restricted, false);
		assert.match(stillPermissive.reason ?? "", /Authenticated Users/);
	});

	it(
		"establishes the access rules and keeps a retained blob and record readable and deletable",
		{ skip: process.platform !== "win32" },
		async () => {
			const roots = await isolatedRealRoots("restrict-real");
			const base = path.dirname(roots.store);
			// The store's own directories must be clean before the case starts, and this
			// machine's shared temporary tree would hand them an entry for another
			// account: the case directory is therefore put on the same footing as a
			// profile directory first, then given the read-only entry a shared profile
			// keeps.
			await restrictRealDirectory(base);
			await runIcacls(ICACLS, [base, "/grant", "BUILTIN\\Users:(OI)(CI)(RX)", "/Q"], { windowsHide: true });
			const namespace = resolveFileEvidenceNamespace({
				storageRoot: roots.store,
				ownerId: OWNER,
				slotId: SLOT,
				workspaceRoot: roots.workspace,
				sessionId: `${SESSION}-restrict-real`,
			});
			if (!namespace.ok) throw new Error(namespace.reason);
			const paths = namespace.paths;
			// An earlier enable left a blob and the record that references it behind, and
			// the directories underneath inherited the carrier's entry.
			await fs.mkdir(paths.blobsDirectory, { recursive: true });
			await fs.mkdir(paths.recordsDirectory, { recursive: true });
			const blobBytes = Buffer.from("retained bytes", "utf8");
			const blob = path.join(paths.blobsDirectory, nativeObservationDigestBytes(blobBytes));
			const record = path.join(
				paths.recordsDirectory,
				`000000000001-${nativeObservationDigestBytes(Buffer.from("{}", "utf8"))}.json`,
			);
			await fs.writeFile(blob, blobBytes);
			await fs.writeFile(record, "{}");
			assert.match(await realAclOf(paths.storageRoot), /BUILTIN\\Users/, "the store inherits an entry beyond this account");

			// No injected seam: this machine's own `icacls` and owner listing run here.
			const restriction = await restrictNativeFileObservationStorage({ paths });

			// The store's own paths are the only place this case controls the rules, so a
			// refusal here may name no more than a component of this machine's profile
			// chain; a refusal naming one of the store's own paths is the defect.
			assert.equal(
				restriction.reason === null || restriction.reason.startsWith("the component "),
				true,
				restriction.reason ?? "",
			);
			if (restriction.reason === null) {
				assert.equal(restriction.readiness?.ready, true, restriction.readiness?.reason ?? "the store was not ready");
			}
			for (const directory of namespaceOrder(paths)) {
				assert.doesNotMatch(
					await realAclOf(directory),
					/BUILTIN\\Users/,
					`${path.basename(directory)} kept an entry beyond this account`,
				);
			}
			// The files the rewrite must never touch kept the access they reach through
			// the directory that holds them: readable, and deletable. This holds whether
			// or not the machine's own profile chain let the store open.
			assert.equal(await fs.readFile(blob, "utf8"), "retained bytes");
			assert.equal(await fs.readFile(record, "utf8"), "{}");
			await fs.rm(blob);
			await fs.rm(record);
			assert.equal(existsSync(blob), false, "a retained blob that cannot be deleted is evidence nobody can remove");
			assert.equal(existsSync(record), false, "a retained record that cannot be deleted is evidence nobody can remove");
			// An observation committed after this enable inherits the same rules.
			const later = path.join(paths.temporaryDirectory, "later.txt");
			await fs.writeFile(later, "later");
			assert.doesNotMatch(await realAclOf(later), /BUILTIN\\Users/, "a file written after the rewrite inherits the access rules");
			await fs.rm(later);
		},
	);

	it(
		"refuses a store whose component on the path to it another account can replace",
		{ skip: process.platform !== "win32" },
		async () => {
			const roots = await isolatedRealRoots("carrier-real");
			const base = path.dirname(roots.store);
			await restrictRealDirectory(base);
			// A component of the path to the store, below the store's own directories and
			// owned by this account, grants another account the right to replace it: the
			// store must stay off. Not inheritable, so the store's own directories stay
			// clean and only the component's own rights can refuse it.
			await runIcacls(ICACLS, [base, "/grant", "BUILTIN\\Users:(M)", "/Q"], { windowsHide: true });
			const namespace = resolveFileEvidenceNamespace({
				storageRoot: roots.store,
				ownerId: OWNER,
				slotId: SLOT,
				workspaceRoot: roots.workspace,
				sessionId: `${SESSION}-carrier-real`,
			});
			if (!namespace.ok) throw new Error(namespace.reason);

			const readiness = await verifyNativeFileObservationStorage({ paths: namespace.paths });

			assert.equal(readiness.ready, false, "a component another account can replace was accepted");
			assert.match(readiness.reason ?? "", /on the path to the store/);
			assert.match(readiness.reason ?? "", /BUILTIN\\Users/);
		},
	);

	it(
		"accepts a component that grants another account read access only",
		{ skip: process.platform !== "win32" },
		async () => {
			const roots = await isolatedRealRoots("carrier-readonly");
			const base = path.dirname(roots.store);
			await restrictRealDirectory(base);
			await runIcacls(ICACLS, [base, "/grant", "BUILTIN\\Users:(RX)", "/Q"], { windowsHide: true });
			const namespace = resolveFileEvidenceNamespace({
				storageRoot: roots.store,
				ownerId: OWNER,
				slotId: SLOT,
				workspaceRoot: roots.workspace,
				sessionId: `${SESSION}-carrier-readonly`,
			});
			if (!namespace.ok) throw new Error(namespace.reason);

			const readiness = await verifyNativeFileObservationStorage({ paths: namespace.paths });

			assert.equal(
				readiness.ready,
				true,
				readiness.reason === undefined ? "" : (readiness.reason ?? "the store was refused"),
			);
		},
	);

	it(
		"reads owners with this machine's own tools, without a PowerShell module",
		{ skip: process.platform !== "win32" },
		async () => {
			const roots = await isolatedRoots("owner-listing");
			const inner = path.join(roots.store, "one");
			await fs.mkdir(inner, { recursive: true });
			const targets = [roots.store, inner];

			const owners = await readStorageOwners(targets);

			assert.equal(owners.ok, true, owners.detail ?? "the listing reported no owner");
			const reported = new Map(
				owners.stdout
					.split(/\r?\n/)
					.filter(line => line.includes("|"))
					.map(line => [line.slice(0, line.indexOf("|")), line.slice(line.indexOf("|") + 1)] as const),
			);
			for (const target of targets) {
				const owner = reported.get(target);
				assert.equal(typeof owner, "string", `${target} has no owner in the listing`);
				assert.equal(isPermittedAclPrincipal(owner ?? "", CURRENT_ACCOUNT), true, `the listing reported ${owner}`);
			}
		},
	);

	it("refuses a namespace that would escape the store root", () => {
		for (const bad of ["../../etc", "..", "", "short"]) {
			const namespace = resolveFileEvidenceNamespace(refFor({ ownerId: bad }));
			assert.equal(namespace.ok, false, `owner id ${bad} must be refused`);
		}
		assert.throws(() => resolveNativeFileObservationStorePaths(refFor({ storageRoot: "\\\\server\\share\\store" })));
	});
});

describe("native observation journal", () => {
	it("commits a blob before the record and validates both on read", async () => {
		const paths = pathsFor({ sessionId: `${SESSION}-journal` });
		const journal = await openNativeFileObservationJournal({ paths });
		const bytes = Buffer.from("hello", "utf8");
		const result = await journal.publish(commitFor(paths, bytes), bytes);
		assert.equal(result.published, true, result.detail ?? "publish was refused");
		assert.notEqual(result.recordId, null);

		const blobs = await blobFilesOf(paths);
		assert.deepEqual(blobs, [nativeObservationDigestBytes(bytes)]);
		assert.equal((await recordFilesOf(paths)).length, 1);

		const read = await journal.read(result.recordId!);
		assert.equal(read.available, true, read.available ? "" : read.detail);
		if (!read.available) return;
		assert.equal(read.record.stage, "admission-observed");
		assert.equal(read.record.observation.blobId, nativeObservationDigestBytes(bytes));
		assert.deepEqual(read.bytes, bytes);
		assert.deepEqual(read.record.origin, {
			ownerId: OWNER,
			slotId: SLOT,
			processInstanceId: "proctest-01",
			producerEpoch: "epochtest-01",
		});
		await journal.close();
	});

	it("reports a tampered record and a corrupt or missing blob as unavailable", async () => {
		const paths = pathsFor({ sessionId: `${SESSION}-tamper` });
		const journal = await openNativeFileObservationJournal({ paths });
		const bytes = Buffer.from("hello", "utf8");
		const published = await journal.publish(commitFor(paths, bytes), bytes);
		assert.equal(published.published, true);
		const recordId = published.recordId!;
		const recordName = (await recordFilesOf(paths))[0]!;
		const recordPath = path.join(paths.recordsDirectory, recordName);
		const blobPath = path.join(paths.blobsDirectory, nativeObservationDigestBytes(bytes));

		// Same length, different bytes: only the digest can catch this.
		await fs.writeFile(blobPath, "xxxxx");
		const corrupt = await journal.read(recordId);
		assert.equal(corrupt.available, false);
		assert.equal(corrupt.available ? "" : corrupt.reason, "corrupt-blob");

		await fs.rm(blobPath, { force: true });
		const missing = await journal.read(recordId);
		assert.equal(missing.available, false);
		assert.equal(missing.available ? "" : missing.reason, "missing-blob");

		const original = JSON.parse(await fs.readFile(recordPath, "utf8")) as Record<string, unknown>;
		original["toolOutcome"] = "success";
		await fs.writeFile(recordPath, JSON.stringify(original));
		const tampered = await journal.read(recordId);
		assert.equal(tampered.available, false);
		assert.equal(tampered.available ? "" : tampered.reason, "corrupt-record");
		await journal.close();
	});

	it("keeps an orphan blob when the record commit fails and collects it later", async () => {
		const paths = pathsFor({ sessionId: `${SESSION}-orphan` });
		const journal = await openNativeFileObservationJournal({ paths });
		const first = Buffer.from("alpha", "utf8");
		assert.equal((await journal.publish(commitFor(paths, first), first)).published, true);

		// Simulate a crash between the blob commit and the record commit by making
		// the record directory unusable.
		await fs.rm(paths.recordsDirectory, { recursive: true, force: true });
		await fs.writeFile(paths.recordsDirectory, "not a directory");

		const second = Buffer.from("beta!", "utf8");
		const failed = await journal.publish(commitFor(paths, second), second);
		assert.equal(failed.published, false);
		assert.equal(failed.reason, "storage-unavailable");
		assert.deepEqual(
			(await blobFilesOf(paths)).sort(),
			[nativeObservationDigestBytes(first), nativeObservationDigestBytes(second)].sort(),
		);

		// A failed scan must not make the retained blobs look orphaned.
		const blocked = await journal.maintain();
		assert.notEqual(blocked.detail, null);
		assert.equal(blocked.removedBlobs, 0);

		await fs.rm(paths.recordsDirectory, { force: true });
		await fs.mkdir(paths.recordsDirectory);
		const collected = await journal.maintain();
		assert.equal(collected.detail, null);
		assert.equal(collected.removedBlobs, 2);
		assert.deepEqual(await blobFilesOf(paths), []);
		await journal.close();
	});

	it("refuses a commit bound to another owner, session or declared bytes", async () => {
		const paths = pathsFor({ sessionId: `${SESSION}-binding` });
		const journal = await openNativeFileObservationJournal({ paths });
		const bytes = Buffer.from("hello", "utf8");

		const foreignSession = await journal.publish(
			commitFor(paths, bytes, {
				session: { sessionId: "another-session", sessionFileDigest: null, workspaceDigest: paths.workspaceDigest },
			}),
			bytes,
		);
		assert.equal(foreignSession.published, false);
		assert.equal(foreignSession.reason, "invalid-commit");
		assert.match(foreignSession.detail ?? "", /another workspace or session/);

		const mismatchedBytes = await journal.publish(
			commitFor(paths, bytes, {
				origin: { ownerId: OWNER, slotId: SLOT, processInstanceId: "proctest-01", producerEpoch: "epochtest-01" },
				toolCall: { toolCallId: "call-0002", toolName: "write", occurrence: 0 },
			}),
			Buffer.from("world", "utf8"),
		);
		assert.equal(mismatchedBytes.published, false);
		assert.match(mismatchedBytes.detail ?? "", /do not match the declared digest/);

		assert.deepEqual(await recordFilesOf(paths), []);
		assert.deepEqual(await blobFilesOf(paths), []);
		await journal.close();
	});

	it("refuses another record's text instead of displaying it for the requested observation", async () => {
		const paths = pathsFor({ sessionId: `${SESSION}-reader-binding` });
		const journal = await openNativeFileObservationJournal({ paths });
		const firstBytes = Buffer.from("first", "utf8");
		const secondBytes = Buffer.from("second", "utf8");
		const first = await journal.publish(commitFor(paths, firstBytes), firstBytes);
		const second = await journal.publish(
			commitFor(paths, secondBytes, { toolCall: { toolCallId: "call-0002", toolName: "write", occurrence: 0 } }),
			secondBytes,
		);
		assert.equal(first.published, true);
		assert.equal(second.published, true);
		const firstRead = await journal.read(first.recordId!);
		const secondRead = await journal.read(second.recordId!);
		assert.equal(firstRead.available, true);
		assert.equal(secondRead.available, true);
		if (firstRead.available && secondRead.available) {
			assert.equal(observationTextState(firstRead.record, firstRead).text, "first");
			assert.equal(observationTextState(firstRead.record, secondRead).readability, "unavailable");
		}
		await journal.close();
	});

	it("derives an unknown resolution for an admission with no witnessed result", async () => {
		const paths = pathsFor({ sessionId: `${SESSION}-summary` });
		const journal = await openNativeFileObservationJournal({ paths });
		const bytes = Buffer.from("hello", "utf8");
		const admission = await journal.publish(commitFor(paths, bytes), bytes);
		assert.equal(admission.published, true);

		const listed = await journal.list();
		assert.equal(listed.records.length, 1);
		const views = summarizeNativeFileObservations(listed.records);
		assert.equal(views.length, 1);
		assert.equal(views[0]!.resolution, "unknown");

		const resultBytes = Buffer.from("world", "utf8");
		await journal.publish(
			commitFor(paths, resultBytes, {
				stage: "observed-post-result",
				toolOutcome: "error",
				toolCall: { toolCallId: "call-0001", toolName: "write", occurrence: 0 },
			}),
			resultBytes,
		);
		const after = summarizeNativeFileObservations((await journal.list()).records);
		assert.equal(after[0]!.resolution, "observed");
		assert.equal(after[0]!.result[0]!.toolOutcome, "error");
		await journal.close();
	});

	it("deletes history only when asked and keeps the disable marker", async () => {
		const paths = pathsFor({ sessionId: `${SESSION}-delete` });
		const journal = await openNativeFileObservationJournal({ paths });
		const bytes = Buffer.from("hello", "utf8");
		await journal.publish(commitFor(paths, bytes), bytes);
		await disableNativeFileObservationCapture({ paths, reason: "test" });

		const removed = await journal.deleteAll();
		assert.equal(removed.removedRecords, 1);
		assert.equal(removed.removedBlobs, 1);
		assert.deepEqual(await recordFilesOf(paths), []);
		const consent = await readNativeFileObservationConsent({ paths });
		assert.equal(consent.state, "absent");
		await journal.close();
	});
});

describe("native file evidence observer", () => {
	it("stays inert and leaves no trace without consent", async () => {
		const roots = await isolatedRoots("inert");
		const observer = createFileEvidenceObserver({
			storageRoot: roots.store,
			ownerId: OWNER,
			slotId: SLOT,
			workspaceRoot: roots.workspace,
			processInstanceId: "proctest-01",
			session: () => ({ sessionId: SESSION, sessionFile: null, cwd: roots.workspace }),
			probe: probeWith(RESTRICTED_PRINCIPALS),
		});
		const outcome = await observer.admitToolCall({
			toolCallId: "call-inert",
			toolName: "write",
			input: { path: "src/a.txt", content: "changed" },
		});
		assert.equal(outcome.outcome, "no-consent");
		assert.equal(outcome.observations.length, 0);
		await assert.rejects(fs.stat(roots.store));
		assert.equal(observer.status().captureEnabled, false);
		await observer.close();
	});

	it("captures nothing while capture is disabled, even with consent", async () => {
		const { paths, observer } = await enabledObserver("disabled");
		await disableNativeFileObservationCapture({ paths, reason: "user turned it off" });

		const outcome = await observer.admitToolCall({
			toolCallId: "call-disabled",
			toolName: "write",
			input: { path: "src/a.txt", content: "changed" },
		});
		assert.equal(outcome.outcome, "disabled");
		assert.match(outcome.reason ?? "", /disabled for this workspace/);

		const reader = await openNativeFileObservationJournal({ paths, mode: "reader" });
		assert.equal((await reader.list()).records.length, 0);
		await reader.close();
		await observer.close();
	});

	it("observes an admission and a result for one edit, and never denies the tool", async () => {
		const sessionFile = path.join(temp, "case-capture", "session.jsonl");
		const { paths, workspace: caseWorkspace, observer } = await enabledObserver("capture", sessionFile);
		const hooks = createFileEvidenceHooks(observer);
		const event = { toolCallId: "call-ok", toolName: "edit", input: { path: "src/a.txt", old_string: "hello", new_string: "goodbye" } };

		const admissionReturn = await hooks.onToolCall(event, {});
		assert.equal(admissionReturn, undefined, "a tool_call hook must never return a cancellation");
		const admissionStatus = observer.status();
		assert.equal(admissionStatus.captureEnabled, true, admissionStatus.reason ?? "capture was not enabled");

		await fs.writeFile(path.join(caseWorkspace, "src", "a.txt"), "goodbye");
		const resultReturn = await hooks.onToolResult({ ...event, isError: false }, {});
		assert.equal(resultReturn, undefined);

		const reader = await openNativeFileObservationJournal({ paths, mode: "reader" });
		const listed = await reader.list();
		assert.equal(listed.records.length, 2, `expected two records, got ${listed.records.length}`);
		const views = summarizeNativeFileObservations(listed.records);
		assert.equal(views[0]!.resolution, "observed");
		const admission = views[0]!.admission[0]!;
		const result = views[0]!.result[0]!;
		assert.equal(admission.stage, "admission-observed");
		assert.equal(admission.toolOutcome, "unknown");
		assert.equal(result.stage, "observed-post-result");
		assert.equal(result.toolOutcome, "success");
		assert.notEqual(admission.observation.blobId, result.observation.blobId);

		const admissionBytes = await reader.read(admission.recordId);
		assert.equal(admissionBytes.available, true);
		if (admissionBytes.available) assert.equal(Buffer.from(admissionBytes.bytes ?? Buffer.alloc(0)).toString("utf8"), "hello");
		const resultBytes = await reader.read(result.recordId);
		assert.equal(resultBytes.available, true);
		if (resultBytes.available) assert.equal(Buffer.from(resultBytes.bytes ?? Buffer.alloc(0)).toString("utf8"), "goodbye");

		await reader.close();
		await observer.close();
	});

	it("does not commit bytes after a file read crosses the observation deadline", async () => {
		const roots = await isolatedRoots("late-read");
		const namespace = resolveFileEvidenceNamespace({
			storageRoot: roots.store,
			ownerId: OWNER,
			slotId: SLOT,
			workspaceRoot: roots.workspace,
			sessionId: SESSION,
		});
		if (!namespace.ok) throw new Error(namespace.reason);
		const granted = await grantNativeFileObservationConsent({
			paths: namespace.paths,
			disclosureId: NATIVE_FILE_OBSERVATION_DISCLOSURE_ID,
			preApprovalCaptureAcknowledged: true,
		});
		assert.equal(granted.granted, true);
		// The third clock read starts the filesystem observation; its completion
		// crosses the deadline. The real timer has not fired, so this defends the
		// producer's post-read fence rather than depending on a slow machine.
		let clockReads = 0;
		const observer = createFileEvidenceObserver({
			storageRoot: roots.store,
			ownerId: OWNER,
			slotId: SLOT,
			workspaceRoot: roots.workspace,
			processInstanceId: "proctest-01",
			session: () => ({ sessionId: SESSION, sessionFile: null, cwd: roots.workspace }),
			probe: probeWith(RESTRICTED_PRINCIPALS),
			now: () => ++clockReads >= 4 ? 4000 : 1000,
		});
		await observer.admitToolCall({
			toolCallId: "call-late-read",
			toolName: "write",
			input: { path: "src/a.txt", content: "changed" },
		});
		const reader = await openNativeFileObservationJournal({ paths: namespace.paths, mode: "reader" });
		assert.deepEqual((await reader.list()).records, []);
		assert.deepEqual(await blobFilesOf(namespace.paths), []);
		await reader.close();
		await observer.close();
	});

	it("answers a malformed tool event with an unavailable outcome instead of a denial", async () => {
		const { observer } = await enabledObserver("malformed");
		const hooks = createFileEvidenceHooks(observer);
		const malformed = await hooks.onToolCall({ toolCallId: 42, toolName: null, input: "not an object" }, {});
		assert.equal(malformed, undefined);
		const outcome = await observer.admitToolCall({ toolCallId: 42, toolName: null, input: null });
		assert.equal(outcome.outcome, "unaddressable");
		assert.match(outcome.reason ?? "", /no usable call identity/);

		const unsupported = await observer.admitToolCall({ toolCallId: "call-bash", toolName: "bash", input: { command: "ls" } });
		assert.equal(unsupported.outcome, "unaddressable");
		assert.match(unsupported.reason ?? "", /no per-file target contract/);
		await observer.close();
	});

	it("records an unsupported target as a metadata-only observation", async () => {
		const { paths, observer } = await enabledObserver("metadata-only");
		const outcome = await observer.admitToolCall({
			toolCallId: "call-url",
			toolName: "write",
			input: { path: "xd://memory/notes.md", content: "x" },
		});
		assert.equal(outcome.outcome, "captured");
		assert.equal(outcome.observations[0]!.storedBytes, false);
		assert.equal(outcome.observations[0]!.kind, "internal-url");

		const reader = await openNativeFileObservationJournal({ paths, mode: "reader" });
		const record = (await reader.list()).records[0]!;
		assert.equal(record.target.kind, "internal-url");
		assert.equal(record.observation.blobId, null);
		assert.equal(record.observation.byteLength, null);
		assert.deepEqual(await blobFilesOf(paths), []);
		await reader.close();
		await observer.close();
	});
});
