/**
 * Tests for the on-demand, folder-scoped history query.
 *
 * What is worth defending here: that only files whose *own header* records the
 * selected folder are offered (an ambiguous recorded cwd is never resolved into
 * this process's folder), that every supported root is enumerated instead of a
 * bounded slice, that one exact file is offered once with the index's identity
 * when the index owns it, that a missing indexed file stays visible as
 * unavailable, and that every failure mode — unreadable bucket, unreadable or
 * vanished candidate, headerless file, cancellation — is reported distinctly
 * instead of showing a shorter list as if it were complete. Everything runs
 * against a temp tree and an injected OMP layout, so no OMP install, no session
 * store and no network is involved.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { folderHistoryDeletionSubject, inspectSessionFile, scanFolderHistory } from "./folder-history.ts";
import type { FolderHistoryScan } from "./folder-history.ts";

const SESSION_A = "01a00000-0000-7000-8000-00000000000a";
const SESSION_B = "01a00000-0000-7000-8000-00000000000b";
const SESSION_C = "01a00000-0000-7000-8000-00000000000c";
const OLDER = Date.parse("2026-01-01T00:00:00.000Z");
const MIDDLE = Date.parse("2026-02-01T00:00:00.000Z");
const NEWEST = Date.parse("2026-03-01T00:00:00.000Z");

function headerLine(id: string, cwd: string, title: string): string {
	return `${JSON.stringify({ type: "session", id, cwd, title })}\n`;
}

interface Fixture {
	/** Temp root that holds the whole fake install. */
	readonly temp: string;
	/** Injected home directory the OMP config root is derived from. */
	readonly home: string;
	/** `<home>/.omp/agent/sessions` — the ordinary default profile's root. */
	readonly sessions: string;
	/** Absolute folder the sessions under test belong to (never created: only paths are compared). */
	readonly folderA: string;
	readonly folderB: string;
	write(relative: string, content: string, modifiedMs: number): Promise<string>;
}

/** The environment every fixture scan resolves roots against, with XDG off. */
function environmentFor(fixture: Fixture): { home: string; env: Record<string, string>; platform: string } {
	return { home: fixture.home, env: {}, platform: "win32" };
}

/** A tree fingerprint that is sensitive to any creation, write or removal. */
async function treeFingerprint(root: string): Promise<string> {
	const lines: string[] = [];
	const walk = async (dir: string, prefix: string): Promise<void> => {
		const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
		for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
			const relative = path.join(prefix, dirent.name);
			if (dirent.isDirectory()) {
				lines.push(`dir  ${relative}`);
				await walk(path.join(dir, dirent.name), relative);
				continue;
			}
			const stats = await fs.promises.stat(path.join(dir, dirent.name));
			lines.push(`file ${relative} ${stats.size} ${stats.mtimeMs}`);
		}
	};
	await walk(root, "");
	return lines.join("\n");
}

describe("folder-scoped history", () => {
	const tempDirs: string[] = [];

	async function freshTree(): Promise<Fixture> {
		const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-folder-history-"));
		tempDirs.push(temp);
		const home = path.join(temp, "home");
		const sessions = path.join(home, ".omp", "agent", "sessions");
		await fs.promises.mkdir(sessions, { recursive: true });
		return {
			temp,
			home,
			sessions,
			folderA: path.join(temp, "workspaces", "proj-a"),
			folderB: path.join(temp, "workspaces", "proj-b"),
			write: async (relative, content, modifiedMs) => {
				const file = path.join(sessions, relative);
				await fs.promises.mkdir(path.dirname(file), { recursive: true });
				await fs.promises.writeFile(file, content, "utf8");
				const seconds = modifiedMs / 1000;
				await fs.promises.utimes(file, seconds, seconds);
				return file;
			},
		};
	}

	async function scan(fixture: Fixture, options: Partial<Parameters<typeof scanFolderHistory>[0]> = {}): Promise<FolderHistoryScan> {
		return scanFolderHistory({
			cwd: fixture.folderA,
			environment: environmentFor(fixture),
			...options,
		});
	}

	after(async () => {
		for (const dir of tempDirs) await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it("offers only the files whose own header records the folder, newest first", async () => {
		const fixture = await freshTree();
		const older = await fixture.write(
			`--proj-c--/2026-01-01T00-00-00-000Z_${SESSION_A}.jsonl`,
			headerLine(SESSION_A, fixture.folderA, "Older"),
			OLDER,
		);
		const newest = await fixture.write(
			`--proj-a--/2026-03-01T00-00-00-000Z_${SESSION_B}.jsonl`,
			headerLine(SESSION_B, fixture.folderA, "Newest"),
			NEWEST,
		);
		const middle = await fixture.write(
			`--children--/2026-02-20T00-00-00-000Z_${SESSION_A}.jsonl`,
			headerLine(SESSION_A, fixture.folderA, "Middle"),
			MIDDLE,
		);
		await fixture.write(
			`--proj-a--/2026-02-01T00-00-00-000Z_${SESSION_C}.jsonl`,
			headerLine(SESSION_C, fixture.folderB, "Another folder"),
			MIDDLE,
		);
		// A rewrite backup carries a valid header and the right folder, and is still
		// not a session file.
		await fixture.write(
			`--proj-a--/2026-02-01T00-00-00-000Z_${SESSION_C}.jsonl.1770000000.bak`,
			headerLine(SESSION_C, fixture.folderA, "Backup"),
			NEWEST,
		);
		// A session's own storage directory holds its subagent children.
		await fixture.write(
			`--children--/2026-02-20T00-00-00-000Z_${SESSION_A}/child.jsonl`,
			headerLine(SESSION_C, fixture.folderA, "Subagent child"),
			NEWEST,
		);
		// A linked workspace directory is not followed.
		const linked = path.join(fixture.temp, "linked-target");
		await fs.promises.mkdir(linked, { recursive: true });
		await fs.promises.writeFile(
			path.join(linked, `2026-02-25T00-00-00-000Z_${SESSION_B}.jsonl`),
			headerLine(SESSION_B, fixture.folderA, "Behind a link"),
			"utf8",
		);
		await fs.promises.symlink(linked, path.join(fixture.sessions, "--linked--"), "junction");
		// Two files that are readable but are not OMP sessions.
		await fixture.write("--proj-a--/empty.jsonl", "", MIDDLE);
		await fixture.write("--proj-a--/stray.jsonl", '{"hello":"world"}\n', MIDDLE);

		const result = await scan(fixture);

		assert.deepEqual(
			result.candidates.map(candidate => candidate.title),
			["Newest", "Middle", "Older"],
		);
		assert.deepEqual(
			result.candidates.map(candidate => candidate.file),
			[newest, middle, older],
		);
		assert.equal(result.candidates[0]?.verifiedCwd, fixture.folderA);
		assert.equal(result.candidates[0]?.cwd, fixture.folderA);
		assert.equal(result.candidates[0]?.sessionId, SESSION_B);
		assert.equal(result.candidates[0]?.profile, null);
		assert.equal(result.candidates[0]?.tabId, null);
		assert.equal(result.candidates[0]?.source, "discovered");
		assert.equal(
			result.candidates[0]?.sessionDir,
			fixture.sessions,
			"a launch of a discovered file belongs in the root it was found under",
		);
		assert.equal(result.candidates[0]?.available, true);
		assert.ok(result.candidates.every(candidate => candidate.modifiedAt !== null));
		assert.equal(
			new Set(result.candidates.map(candidate => candidate.file)).size,
			result.candidates.length,
			"one row per exact file",
		);
		assert.deepEqual(
			result.issues.map(issue => issue.kind),
			["invalid-header", "invalid-header"],
			"a readable non-session file is reported, not silently dropped",
		);
		assert.equal(result.skippedFiles, 2);
		assert.equal(result.incomplete, false);
		assert.equal(result.cancelled, false);
		assert.deepEqual(result.roots.map(root => root.root), [fixture.sessions]);
	});

	it("covers every workspace bucket instead of a bounded first slice", async () => {
		const fixture = await freshTree();
		const written: string[] = [];
		for (let index = 0; index < 12; index += 1) {
			written.push(
				await fixture.write(
					`--bucket-${String(index).padStart(2, "0")}--/2026-01-01T00-00-00-000Z_${SESSION_A}.jsonl`,
					headerLine(SESSION_A, fixture.folderA, `Session ${index}`),
					OLDER + index * 1000,
				),
			);
		}

		const result = await scan(fixture);

		assert.equal(result.candidates.length, 12);
		assert.deepEqual(
			result.candidates.map(candidate => candidate.file).sort(),
			[...written].sort(),
		);
		assert.equal(result.incomplete, false);
	});

	it("associates a readable indexed file with the folder its own header records, not a stale row cwd", async () => {
		const fixture = await freshTree();
		// The index's row still says folder A; the file itself now records folder B.
		const moved = await fixture.write(
			`--proj-b--/2026-01-01T00-00-00-000Z_${SESSION_A}.jsonl`,
			headerLine(SESSION_A, fixture.folderB, "Moved to another folder"),
			OLDER,
		);
		const indexed = [
			{ tabId: "tab-stale", sessionFile: moved, cwd: fixture.folderA, sessionId: SESSION_A, profile: null },
		];

		const stale = await scan(fixture, { indexed });
		assert.deepEqual(
			stale.candidates,
			[],
			"a readable file must not be offered under a folder its own header does not record",
		);
		assert.equal(stale.incomplete, false);

		const actual = await scanFolderHistory({
			cwd: fixture.folderB,
			environment: environmentFor(fixture),
			indexed,
		});
		assert.equal(actual.candidates.length, 1, "the folder the file itself records is where it belongs");
		assert.equal(actual.candidates[0]?.tabId, "tab-stale");
		assert.equal(actual.candidates[0]?.cwd, fixture.folderB);
		assert.equal(actual.candidates[0]?.verifiedCwd, fixture.folderB);
		assert.equal(actual.candidates[0]?.available, true);
	});

	it("never offers an indexed file that cannot be read or carries no header", async () => {
		const fixture = await freshTree();
		const headerless = await fixture.write("--proj-a--/stray.jsonl", '{"hello":"world"}\n', OLDER);
		const asDirectory = path.join(fixture.sessions, "--proj-a--", "directory.jsonl");
		await fs.promises.mkdir(asDirectory, { recursive: true });

		const result = await scan(fixture, {
			indexed: [
				{ tabId: "tab-stray", sessionFile: headerless, cwd: fixture.folderA, sessionId: null, profile: null },
				{ tabId: "tab-directory", sessionFile: asDirectory, cwd: fixture.folderA, sessionId: null, profile: null },
			],
		});

		assert.deepEqual(result.candidates, []);
		assert.ok(
			result.issues.some(issue => issue.kind === "indexed-file-invalid" && issue.path === headerless),
			JSON.stringify(result.issues),
		);
		assert.ok(
			result.issues.some(issue => issue.kind === "indexed-file-unreadable" && issue.path === asDirectory),
			JSON.stringify(result.issues),
		);
		assert.equal(result.incomplete, true, "a file that cannot be read may hide a session");
		assert.equal(result.skippedFiles, 1);
	});

	it("offers an indexed file once, with the identity the index already owns", async () => {
		const fixture = await freshTree();
		const file = await fixture.write(
			`--proj-a--/2026-01-01T00-00-00-000Z_${SESSION_A}.jsonl`,
			headerLine(SESSION_A, fixture.folderA, "Tracked"),
			OLDER,
		);

		const result = await scan(fixture, {
			indexed: [
				{
					tabId: "tab-tracked",
					sessionFile: file,
					cwd: fixture.folderA,
					sessionId: SESSION_A,
					profile: "work",
					// The same bucket is also scanned as an explicit session directory, so
					// the file is reachable twice and must still be one row.
					sessionDirs: [path.dirname(file)],
				},
			],
		});

		assert.equal(result.candidates.length, 1);
		const candidate = result.candidates[0];
		assert.equal(candidate?.file, file);
		assert.equal(candidate?.tabId, "tab-tracked");
		assert.equal(candidate?.source, "indexed");
		assert.equal(candidate?.profile, "work");
		assert.equal(candidate?.sessionId, SESSION_A);
		assert.equal(candidate?.title, "Tracked");
		assert.equal(candidate?.available, true);
		assert.equal(candidate?.verifiedCwd, fixture.folderA);
		assert.equal(
			candidate?.sessionDir,
			null,
			"an indexed row keeps the scope the index recorded",
		);
		assert.equal(result.incomplete, false);
	});

	it("keeps an indexed file that is gone visible as unavailable", async () => {
		const fixture = await freshTree();
		const bucket = path.join(fixture.sessions, "--proj-a--");
		await fs.promises.mkdir(bucket, { recursive: true });
		const gone = path.join(bucket, `2026-01-01T00-00-00-000Z_${SESSION_A}.jsonl`);

		const result = await scan(fixture, {
			indexed: [
				{ tabId: "tab-gone", sessionFile: gone, cwd: fixture.folderA, sessionId: SESSION_A, profile: null },
			],
		});

		assert.equal(result.candidates.length, 1, "a missing indexed file is still a row");
		const candidate = result.candidates[0];
		assert.equal(candidate?.tabId, "tab-gone");
		assert.equal(candidate?.available, false);
		assert.equal(candidate?.verifiedCwd, null);
		assert.equal(candidate?.modifiedAt, null);
		assert.equal(candidate?.sizeBytes, null);
		assert.equal(candidate?.cwd, fixture.folderA);
		assert.equal(candidate?.sessionId, SESSION_A);
		assert.ok(
			result.issues.some(issue => issue.kind === "indexed-file-missing" && issue.path === gone),
			JSON.stringify(result.issues),
		);
		assert.equal(result.incomplete, false, "an absent indexed file hides no other session");
	});

	it("never resolves an ambiguous recorded cwd into this process's folder", async () => {
		const fixture = await freshTree();
		const bucket = path.join(fixture.sessions, "--proj-a--");
		await fs.promises.mkdir(bucket, { recursive: true });
		const gone = path.join(bucket, `2026-01-01T00-00-00-000Z_${SESSION_C}.jsonl`);

		const ambiguous = await scan(fixture, {
			indexed: [
				{ tabId: "tab-empty", sessionFile: gone, cwd: "", sessionId: null, profile: null },
				// A real absolute path that is not the folder must not match either,
				// even though it is a cwd this process could resolve.
				{ tabId: "tab-host", sessionFile: gone, cwd: process.cwd(), sessionId: null, profile: null },
			],
		});
		assert.deepEqual(ambiguous.candidates, []);
		assert.ok(ambiguous.issues.some(issue => issue.kind === "indexed-file-missing"));

		// The same ambiguous record is still offered when the file's own header
		// proves the folder.
		const present = await fixture.write(
			`--proj-b--/2026-01-01T00-00-00-000Z_${SESSION_C}.jsonl`,
			headerLine(SESSION_C, fixture.folderA, "Header proves the folder"),
			OLDER,
		);
		const proven = await scan(fixture, {
			indexed: [
				{ tabId: "tab-proven", sessionFile: present, cwd: "C:", sessionId: null, profile: null },
			],
		});
		assert.equal(proven.candidates.length, 1);
		assert.equal(proven.candidates[0]?.tabId, "tab-proven");
		assert.equal(proven.candidates[0]?.source, "indexed");
		assert.equal(proven.candidates[0]?.verifiedCwd, fixture.folderA);
	});

	it("treats a trailing separator and this platform's casing as the same folder", async () => {
		const fixture = await freshTree();
		const variant =
			process.platform === "win32" ? fixture.folderA.toUpperCase() : `${fixture.folderA}${path.sep}`;
		const file = await fixture.write(
			`--proj-a--/2026-01-01T00-00-00-000Z_${SESSION_A}.jsonl`,
			headerLine(SESSION_A, variant, "Variant cwd"),
			OLDER,
		);
		if (process.platform === "win32") {
			await fixture.write(
				`--proj-a--/2026-02-01T00-00-00-000Z_${SESSION_B}.jsonl`,
				headerLine(SESSION_B, `${fixture.folderA}${path.sep}`, "Trailing separator"),
				MIDDLE,
			);
		}

		const result = await scan(fixture);

		assert.ok(
			result.candidates.some(candidate => candidate.file === file),
			`${variant} must match ${fixture.folderA}`,
		);
		if (process.platform === "win32") {
			assert.equal(result.candidates.length, 2);
		}
	});

	it("finds the folder's sessions under the ordinary default profile and under a named profile", async () => {
		const fixture = await freshTree();
		const defaultFile = await fixture.write(
			`--proj-a--/2026-01-01T00-00-00-000Z_${SESSION_A}.jsonl`,
			headerLine(SESSION_A, fixture.folderA, "Default profile"),
			OLDER,
		);
		const workRoot = path.join(fixture.home, ".omp", "profiles", "work", "agent", "sessions");
		const workFile = path.join(workRoot, "--proj-a--", `2026-02-01T00-00-00-000Z_${SESSION_B}.jsonl`);
		await fs.promises.mkdir(path.dirname(workFile), { recursive: true });
		await fs.promises.writeFile(workFile, headerLine(SESSION_B, fixture.folderA, "Named profile"), "utf8");

		const result = await scanFolderHistory({
			cwd: fixture.folderA,
			environment: { home: fixture.home, env: { OMP_PROFILE: "work" }, platform: "win32" },
		});

		assert.deepEqual(
			result.candidates.map(candidate => candidate.file).sort(),
			[defaultFile, workFile].sort(),
			"an active named profile must not hide the default profile's own sessions",
		);
		assert.equal(result.candidates.find(candidate => candidate.file === defaultFile)?.profile, null);
		assert.equal(result.candidates.find(candidate => candidate.file === workFile)?.profile, "work");
		assert.equal(result.incomplete, false);
	});

	it("reports an unreadable bucket and still returns what it could read", async () => {
		const fixture = await freshTree();
		const readable = await fixture.write(
			`--proj-a--/2026-01-01T00-00-00-000Z_${SESSION_A}.jsonl`,
			headerLine(SESSION_A, fixture.folderA, "Readable"),
			OLDER,
		);
		const blocked = path.join(fixture.sessions, "--blocked--");
		await fs.promises.mkdir(blocked, { recursive: true });
		await fs.promises.writeFile(
			path.join(blocked, `2026-02-01T00-00-00-000Z_${SESSION_B}.jsonl`),
			headerLine(SESSION_B, fixture.folderA, "Hidden"),
			"utf8",
		);

		const result = await scan(fixture, {
			listDirectory: async target => {
				if (target === blocked) throw new Error("EACCES: permission denied");
				return fs.promises.readdir(target, { withFileTypes: true });
			},
		});

		assert.deepEqual(
			result.candidates.map(candidate => candidate.file),
			[readable],
		);
		const issue = result.issues.find(candidate => candidate.kind === "unreadable-bucket");
		assert.equal(issue?.path, blocked);
		assert.match(issue?.detail ?? "", /EACCES/);
		assert.equal(result.incomplete, true, "an unreadable bucket must not look like an empty folder");
		assert.equal(result.cancelled, false);
	});

	it("reports a candidate that vanished or became unreadable, distinctly from a headerless file", async () => {
		const replaced = await freshTree();
		const replacedFile = await replaced.write(
			`--proj-a--/2026-01-01T00-00-00-000Z_${SESSION_A}.jsonl`,
			headerLine(SESSION_A, replaced.folderA, "Replaced"),
			OLDER,
		);
		const replacedScan = await scan(replaced, {
			listDirectory: async target => {
				const entries = await fs.promises.readdir(target, { withFileTypes: true });
				if (target === path.dirname(replacedFile)) {
					await fs.promises.rm(replacedFile, { force: true });
					await fs.promises.mkdir(replacedFile);
				}
				return entries;
			},
		});
		assert.ok(
			replacedScan.issues.some(issue => issue.kind === "unreadable-file" && issue.path === replacedFile),
			JSON.stringify(replacedScan.issues),
		);
		assert.equal(replacedScan.incomplete, true);
		assert.deepEqual(replacedScan.candidates, []);

		const vanished = await freshTree();
		const vanishedFile = await vanished.write(
			`--proj-a--/2026-01-01T00-00-00-000Z_${SESSION_B}.jsonl`,
			headerLine(SESSION_B, vanished.folderA, "Vanished"),
			OLDER,
		);
		const vanishedScan = await scan(vanished, {
			listDirectory: async target => {
				const entries = await fs.promises.readdir(target, { withFileTypes: true });
				if (target === path.dirname(vanishedFile)) await fs.promises.rm(vanishedFile, { force: true });
				return entries;
			},
		});
		assert.ok(
			vanishedScan.issues.some(issue => issue.kind === "missing-file" && issue.path === vanishedFile),
			JSON.stringify(vanishedScan.issues),
		);
		assert.equal(vanishedScan.incomplete, true, "a session that disappeared mid-pass is not an absent path");
	});

	it("never opens a root the cancellation arrived before", async () => {
		const fixture = await freshTree();
		const kept = await fixture.write(
			`--proj-a--/2026-01-01T00-00-00-000Z_${SESSION_A}.jsonl`,
			headerLine(SESSION_A, fixture.folderA, "Kept"),
			OLDER,
		);
		const unreached = path.join(fixture.temp, "custom-session-dir");
		await fs.promises.mkdir(unreached, { recursive: true });
		const unreachedFile = path.join(unreached, `2026-02-01T00-00-00-000Z_${SESSION_B}.jsonl`);
		await fs.promises.writeFile(unreachedFile, headerLine(SESSION_B, fixture.folderA, "Unreached"), "utf8");
		const controller = new AbortController();
		const firstBucket = path.dirname(kept);

		const result = await scan(fixture, {
			signal: controller.signal,
			// A draft can record the custom session directory it is configured for
			// without owning a file yet, which is how that directory reaches this pass.
			indexed: [
				{ tabId: "tab-draft", sessionFile: null, cwd: fixture.folderA, profile: null, sessionDirs: [unreached] },
			],
			listDirectory: async target => {
				const entries = await fs.promises.readdir(target, { withFileTypes: true });
				// Cancelled while the first root's bucket was being listed, so no
				// candidate of that root had been resolved yet.
				if (target === firstBucket) controller.abort();
				return entries;
			},
		});

		assert.ok(
			!result.candidates.some(candidate => candidate.file === unreachedFile),
			"the second root is never opened",
		);
		assert.equal(result.cancelled, true);
		assert.equal(result.incomplete, true);
		assert.ok(result.issues.some(issue => issue.kind === "cancelled"));
	});

	it("stops inside one workspace bucket when the scan is cancelled", async () => {
		const fixture = await freshTree();
		// One bucket with many sessions: a Cancel must stop between files, not after
		// the whole bucket has been read.
		const total = 20;
		const written: string[] = [];
		for (let index = 0; index < total; index += 1) {
			written.push(
				await fixture.write(
					`--proj-a--/session-${String(index).padStart(2, "0")}.jsonl`,
					headerLine(SESSION_A, fixture.folderA, `Session ${index}`),
					OLDER + index * 1000,
				),
			);
		}
		// A session of another folder shares the bucket and must never be returned.
		await fixture.write(
			"--proj-a--/other-folder.jsonl",
			headerLine(SESSION_B, fixture.folderB, "Other folder"),
			NEWEST,
		);
		let checks = 0;

		const result = await scan(fixture, { isCancelled: () => (checks += 1) >= 10 });

		assert.equal(result.roots.length, 1, "everything came from one root and its single bucket");
		assert.equal(result.cancelled, true);
		assert.equal(result.incomplete, true);
		assert.ok(result.issues.some(issue => issue.kind === "cancelled"));
		// The partial result is the point: not empty, and not the whole bucket. The
		// exact count depends on directory order and on how often the pass asks, so it
		// is bounded rather than pinned.
		assert.ok(result.candidates.length >= 1, "rows resolved before the cancellation are returned");
		assert.ok(result.candidates.length < total, "the pass stopped before reading the whole bucket");
		assert.ok(result.candidates.every(candidate => written.includes(candidate.file)));
	});

	it("refuses a folder path that is not absolute instead of scanning the host's folder", async () => {
		const fixture = await freshTree();
		const result = await scanFolderHistory({ cwd: path.join("relative", "folder"), environment: environmentFor(fixture) });

		assert.deepEqual(result.candidates, []);
		assert.deepEqual(result.roots, []);
		assert.equal(result.issues.length, 1);
		assert.equal(result.issues[0]?.kind, "invalid-folder");
		assert.equal(result.incomplete, true);
	});

	it("never writes: the scanned tree is byte-identical afterwards", async () => {
		const fixture = await freshTree();
		await fixture.write(
			`--proj-a--/2026-01-01T00-00-00-000Z_${SESSION_A}.jsonl`,
			headerLine(SESSION_A, fixture.folderA, "Only session"),
			OLDER,
		);
		const before = await treeFingerprint(fixture.temp);

		const result = await scan(fixture);
		assert.equal(result.candidates.length, 1);

		assert.equal(await treeFingerprint(fixture.temp), before, "a read-only pass changes nothing");
	});
});

describe("session file inspection", () => {
	const tempDirs: string[] = [];

	after(async () => {
		for (const dir of tempDirs) await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it("separates a missing path, an unreadable path and a file without a header", async () => {
		const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-inspect-file-"));
		tempDirs.push(temp);
		const directory = path.join(temp, "dir.jsonl");
		await fs.promises.mkdir(directory);
		const session = path.join(temp, "session.jsonl");
		const content = headerLine(SESSION_A, "D:\\Workfiles\\proj-a", "Session");
		await fs.promises.writeFile(session, content, "utf8");
		const empty = path.join(temp, "empty.jsonl");
		await fs.promises.writeFile(empty, "", "utf8");
		const stray = path.join(temp, "stray.jsonl");
		await fs.promises.writeFile(stray, '{"hello":"world"}\n', "utf8");

		const ok = await inspectSessionFile(session);
		assert.equal(ok.kind, "ok");
		assert.equal(ok.kind === "ok" ? ok.header.cwd : null, "D:\\Workfiles\\proj-a");
		assert.equal(ok.kind === "ok" ? ok.header.title : null, "Session");
		assert.equal(ok.kind === "ok" ? ok.sizeBytes : 0, Buffer.byteLength(content));
		assert.equal((await inspectSessionFile(path.join(temp, "missing.jsonl"))).kind, "missing");
		assert.equal((await inspectSessionFile(directory)).kind, "unreadable");
		assert.equal((await inspectSessionFile(empty)).kind, "invalid");
		assert.equal((await inspectSessionFile(stray)).kind, "invalid");
	});
});

describe("unified Resume candidates", () => {
	const tempDirs: string[] = [];

	after(async () => {
		for (const dir of tempDirs) await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it("offers tracked and untracked files as one list, and addresses both for deletion", async () => {
		const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-folder-history-unified-"));
		tempDirs.push(temp);
		const home = path.join(temp, "home");
		const sessions = path.join(home, ".omp", "agent", "sessions");
		await fs.promises.mkdir(sessions, { recursive: true });
		const folder = path.join(temp, "workspaces", "proj-a");
		const tracked = path.join(sessions, "2026-01-01T00-00-00-tracked.jsonl");
		const untracked = path.join(sessions, "2026-02-01T00-00-00-untracked.jsonl");
		await fs.promises.writeFile(tracked, headerLine(SESSION_A, folder, "Tracked"), "utf8");
		await fs.promises.writeFile(untracked, headerLine(SESSION_B, folder, "Untracked"), "utf8");

		const result = await scanFolderHistory({
			cwd: folder,
			indexed: [{ tabId: "tab:tracked", sessionFile: tracked, cwd: folder, profile: null }],
			environment: { home, env: {}, platform: "win32" },
		});

		// One row per canonical file, both presented alike: provenance is which
		// identity the caller reuses, not a presentation tier.
		assert.equal(result.candidates.length, 2);
		const byFile = new Map(result.candidates.map(candidate => [path.basename(candidate.file), candidate]));
		assert.equal(byFile.get(path.basename(tracked))?.tabId, "tab:tracked");
		assert.equal(byFile.get(path.basename(tracked))?.source, "indexed");
		assert.equal(byFile.get(path.basename(untracked))?.tabId, null);
		assert.equal(byFile.get(path.basename(untracked))?.source, "discovered");
		assert.equal(byFile.get(path.basename(untracked))?.available, true);

		// Both are addressable by the same deletion subject: the exact file, plus the
		// row when one exists, and no provenance flag at all.
		const trackedSubject = folderHistoryDeletionSubject(byFile.get(path.basename(tracked))!);
		assert.deepEqual(trackedSubject, { sessionFile: tracked, profile: null, tabId: "tab:tracked" });
		const untrackedSubject = folderHistoryDeletionSubject(byFile.get(path.basename(untracked))!);
		assert.deepEqual(untrackedSubject, { sessionFile: untracked, profile: null, tabId: null });
	});
});
