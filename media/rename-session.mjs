#!/usr/bin/env bun
/**
 * Rename a *stopped* OMP session's stored title, through OMP's own storage code.
 *
 * This exists because the extension host is Node and the installed agent is
 * TypeScript: `@oh-my-pi/pi-coding-agent/session/session-storage` can only be
 * imported by Bun. The extension host decides *whether* a rename may happen (it
 * holds the exact-file claim and has proven the writer absent) and this helper
 * performs only the native storage write plus the readback that verifies it.
 *
 * It never starts an OMP session, never opens a `SessionManager`, and never edits
 * the transcript: the native `FileSessionStorage.updateSessionTitle` rewrites only
 * OMP's own fixed-width title slot, which is the same slot OMP's loader and history
 * listing read. The recent-session index is updated afterwards on a best-effort
 * basis and its own outcome is reported separately, because it can fail without the
 * title having failed.
 *
 * Usage:
 *   bun rename-session.mjs --package-root <dir> --file <abs.jsonl> --title <text>
 *                          [--session-id <id>]
 *
 * Output is one JSON line on stdout: {ok, verified, title, index, detail}. Any
 * failure exits non-zero with the detail in that same object.
 */
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";

/** Longest title OMP's slot and this extension both accept. */
const MAX_TITLE_CHARS = 200;
/** Bytes of a session file the identity check reads. */
const HEADER_SCAN_BYTES = 64 * 1024;

const argv = process.argv.slice(2);

/** The value after one named argument, or `null`. */
function optionOf(name) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function fail(detail) {
  process.stdout.write(`${JSON.stringify({ ok: false, verified: false, detail })}\n`);
  process.exit(1);
}

/**
 * The title slot and session header of one session file, read the way OMP reads
 * them: the physical first line is a fixed-width title slot when it carries
 * `type: "title"`, and the first `session` record is the header.
 */
function identityOf(text) {
  let slot = null;
  let header = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed[0] !== "{") continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (slot === null && parsed !== null && parsed.type === "title" && parsed.v === 1) {
      slot = typeof parsed.title === "string" ? parsed.title.trim() : "";
      continue;
    }
    if (header === null && parsed !== null && parsed.type === "session") {
      header = {
        id: typeof parsed.id === "string" ? parsed.id : null,
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : null,
        title: typeof parsed.title === "string" ? parsed.title.trim() : null,
      };
      break;
    }
  }
  return { slot, header };
}

const packageRoot = optionOf("package-root");
const file = optionOf("file");
const title = optionOf("title");
const sessionId = optionOf("session-id");
if (packageRoot === null || file === null || title === null) {
  fail("usage: --package-root <dir> --file <abs.jsonl> --title <text> [--session-id <id>]");
}
if (!path.isAbsolute(file) || !path.isAbsolute(packageRoot)) fail("both paths must be absolute");
if (title.length === 0 || title.length > MAX_TITLE_CHARS || /[\u0000-\u001f\u007f-\u009f]/.test(title)) {
  fail("the title must be 1..200 characters with no control characters");
}
try {
  const stats = await stat(file);
  if (!stats.isFile()) fail("the target is not a file");
} catch {
  fail("the target file does not exist");
}

// The exact identity is re-checked here rather than trusted from the caller: this
// process may run after the file changed underneath the extension host.
const before = identityOf((await readFile(file, "utf8")).slice(0, HEADER_SCAN_BYTES));
if (before.header === null) fail("the target has no readable OMP session header");
if (sessionId !== null && before.header.id !== sessionId) {
  fail("the target file's session id does not match the session this rename was requested for");
}

let FileSessionStorage;
try {
  ({ FileSessionStorage } = await import(`${packageRoot}/src/session/session-storage.ts`));
} catch (error) {
  fail(`the installed OMP storage module could not be loaded: ${String(error?.message ?? error)}`);
}
if (typeof FileSessionStorage !== "function") fail("the installed OMP build exports no FileSessionStorage");

try {
  await new FileSessionStorage().updateSessionTitle(file, {
    title,
    source: "user",
    updatedAt: new Date().toISOString(),
  });
} catch (error) {
  fail(`the native title update failed: ${String(error?.message ?? error)}`);
}

// Readback is the only thing that makes this a rename rather than an attempt: the
// slot is what OMP's loader and history listing serve.
const after = identityOf((await readFile(file, "utf8")).slice(0, HEADER_SCAN_BYTES));
const verified = after.slot === title;
if (!verified) {
  fail(`the stored title reads back as ${JSON.stringify(after.slot)} instead of ${JSON.stringify(title)}`);
}

// Best-effort parity for the recent-session index (OMP's own `recordSessionTitle`).
// Its outcome is reported separately: the title slot is already correct, and a
// failed index write must not be presented as a failed rename.
let index = "unsynced";
let indexDetail = null;
try {
  const { recordSessionTitle, lookupSessionTitle } = await import(`${packageRoot}/src/session/session-index.ts`);
  recordSessionTitle(before.header.id ?? "", title);
  index = lookupSessionTitle(before.header.id ?? "") === title ? "synced" : "unsynced";
} catch (error) {
  indexDetail = String(error?.message ?? error);
}

process.stdout.write(
  `${JSON.stringify({ ok: true, verified: true, title: after.slot, index, detail: indexDetail })}\n`,
);
