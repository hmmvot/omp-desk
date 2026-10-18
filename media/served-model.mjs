#!/usr/bin/env bun
/**
 * Decide, for each (provider, requested, served) triple read from stdin, whether the provider served a
 * different model than requested, by the rule of the OMP terminal UI's served-model marker
 * (`detectServedModelMismatch` in pi-tui's `chat/served-model-marker.ts`): the installed OMP's own
 * `classifyModel` compares the two ids, so a snapshot suffix or a gateway prefix is the same model, a
 * different family or revision is a substitution, and an id it cannot classify is unverifiable.
 *
 * The extension host is Node and the classifier is TypeScript in the installed agent's catalog package, so it
 * can only be imported by Bun. This helper only imports and computes; it starts no session and writes nothing.
 *
 * Usage:  echo '{"pairs":[{"provider","requested","served"}]}' | bun served-model.mjs --package-root <dir>
 * Output: one JSON line on stdout, `{ok:true, verdicts:["same"|"mismatch"|"unknown", ...]}` or `{ok:false}`
 *         (exit code 1).
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_PAIRS = 8;
const MAX_TEXT = 256;
const MAX_INPUT_BYTES = 64 * 1024;

const argv = process.argv.slice(2);
const index = argv.indexOf("--package-root");
const root = index < 0 ? undefined : argv[index + 1];

function answer(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail() {
  answer({ ok: false });
  process.exit(1);
}

/** The request's pairs, or `null` when anything about them is out of bounds. */
function parsePairs(text) {
  const value = JSON.parse(text);
  if (value === null || typeof value !== "object" || !Array.isArray(value.pairs)) return null;
  if (value.pairs.length < 1 || value.pairs.length > MAX_PAIRS) return null;
  const pairs = [];
  for (const pair of value.pairs) {
    if (pair === null || typeof pair !== "object") return null;
    for (const key of ["provider", "requested", "served"]) {
      const text = pair[key];
      if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT) return null;
    }
    pairs.push({ provider: pair.provider, requested: pair.requested, served: pair.served });
  }
  return pairs;
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

try {
  if (root === undefined || !path.isAbsolute(root)) fail();
  const text = await readInput();
  const pairs = text === null ? null : parsePairs(text);
  if (pairs === null) fail();
  // The catalog package is a sibling of the agent package or nested under it, depending on the install:
  // Bun's own resolution from the package root finds either.
  const identity = await import(pathToFileURL(Bun.resolveSync("@oh-my-pi/pi-catalog/identity", root)).href);
  if (typeof identity.classifyModel !== "function") fail();
  const verdicts = pairs.map(({ provider, requested, served }) => {
    if (served === requested) return "same";
    const wanted = identity.classifyModel(provider, requested, { lenient: true });
    const actual = identity.classifyModel(provider, served, { lenient: true });
    if (wanted.class === "unknown" || actual.class === "unknown") return "unknown";
    const sameModel =
      wanted.class === actual.class &&
      wanted.family === actual.family &&
      (wanted.revision === undefined || actual.revision === undefined || wanted.revision === actual.revision);
    return sameModel ? "same" : "mismatch";
  });
  answer({ ok: true, verdicts });
  process.exit(0);
} catch {
  fail();
}
