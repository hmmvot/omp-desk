/**
 * Internal OMP URLs of a reply, proved and opened on the host: a known subagent opens its detail tab, an unknown one is not a
 * link, another session's data is never reached, and a click re-resolves and opens one existing read-only view (fake API).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { handleInternalLink, resolveInternalLink } from "./internal-links.ts";
import type { InternalLinkHost, InternalOpenOutcome, SubagentKnowledge } from "./internal-links.ts";
import type { SessionFileRef } from "./session-file-lookup.ts";
import { parseInternalLink } from "../shared/internal-links.ts";
import type { TerminalLinkRequest } from "../shared/terminal-links.ts";

const HEADER = `${JSON.stringify({ type: "session", version: 3, id: "S-1", timestamp: "2026-10-17T10:00:00.000Z", cwd: "C:\\work" })}\n`;

let root = "";
let session = "";
let foreign = "";
let artifacts = "";

before(async () => {
	root = await mkdtemp(path.join(tmpdir(), "omp-internal-links-"));
	session = path.join(root, "2026-10-17T10-00-00_S-1.jsonl");
	foreign = path.join(root, "2026-10-17T11-00-00_S-2.jsonl");
	artifacts = path.join(root, "2026-10-17T10-00-00_S-1");
	await mkdir(path.join(artifacts, "Parent"), { recursive: true });
	await mkdir(path.join(artifacts, "local"), { recursive: true });
	await mkdir(path.join(root, "2026-10-17T11-00-00_S-2"), { recursive: true });
	await writeFile(session, HEADER);
	await writeFile(foreign, HEADER);
	await writeFile(path.join(artifacts, "FinishedReview.md"), "# Done\n");
	await writeFile(path.join(artifacts, "Parent.md"), "parent");
	await writeFile(path.join(artifacts, "Parent", "Parent.Child.md"), "child");
	await writeFile(path.join(artifacts, "12.bash.log"), "full output\n");
	await writeFile(path.join(artifacts, "local", "plan.md"), "the plan");
	await writeFile(path.join(root, "2026-10-17T11-00-00_S-2", "OtherSessionReview.md"), "not ours");
	await writeFile(path.join(root, "2026-10-17T11-00-00_S-2", "99.bash.log"), "not ours");
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

interface Fake {
	readonly host: InternalLinkHost;
	readonly replies: unknown[];
	readonly calls: string[];
	readonly warnings: string[];
	current: boolean;
	known: Record<string, SubagentKnowledge>;
	sessionFile: string | null;
	tabs: boolean;
	outcome: InternalOpenOutcome;
	failOpen: boolean;
}

function fake(overrides: Partial<Pick<Fake, "known" | "sessionFile" | "tabs">> = {}): Fake {
	const state: Fake = {
		replies: [], calls: [], warnings: [], current: true,
		known: overrides.known ?? {}, sessionFile: overrides.sessionFile === undefined ? session : overrides.sessionFile, tabs: overrides.tabs ?? true,
		outcome: { opened: true }, failOpen: false,
		host: undefined as never,
	};
	const host: InternalLinkHost = {
		isCurrent: () => state.current,
		reply: message => { state.replies.push(message); },
		sessionFile: () => state.sessionFile,
		get tabs() { return state.tabs; },
		knownSubagent: id => state.known[id] ?? null,
		openAgentTab: id => { state.calls.push(`tab ${id}`); },
		openSessionFile: async (sessionFile: string, ref: SessionFileRef) => {
			if (state.failOpen) throw new Error("cannot display");
			state.calls.push(`document ${ref.kind === "agent" ? ref.id : ref.path} of ${path.basename(sessionFile)}`);
			return state.outcome;
		},
		openArtifact: async (sessionFile: string, id: string) => { state.calls.push(`artifact ${id} of ${path.basename(sessionFile)}`); return state.outcome; },
		revealInOs: async (file: string) => { state.calls.push(`os ${path.relative(root, file)}`); },
		warn: message => { state.warnings.push(message); },
	};
	return Object.assign(state, { host });
}

const request = (type: TerminalLinkRequest["type"], target: string, action?: "os" | "reveal"): TerminalLinkRequest => ({ type, requestId: 5, target, ...(action === undefined ? {} : { action }) });
const link = (target: string) => parseInternalLink(target)!;
const validate = async (world: Fake, target: string): Promise<unknown> => {
	world.replies.length = 0;
	await handleInternalLink(request("omp:terminal-link-validate", target), link(target), world.host);
	return world.replies[0];
};
const click = async (world: Fake, target: string, action?: "os" | "reveal"): Promise<void> => {
	world.calls.length = 0;
	await handleInternalLink(request("omp:terminal-link-open", target, action), link(target), world.host);
};
const valid = (value: boolean) => ({ type: "omp:terminal-link-validation", requestId: 5, valid: value });

describe("agent:// in a reply", () => {
	it("is a link when the live roster holds the agent, and a click opens its detail tab", async () => {
		const world = fake({ known: { UniformFieldsReview: "roster" } });
		assert.deepEqual(await validate(world, "agent://UniformFieldsReview"), valid(true));
		await click(world, "agent://UniformFieldsReview");
		assert.deepEqual(world.calls, ["tab UniformFieldsReview"]);
		assert.deepEqual(world.warnings, []);
	});

	it("is not a link for an id the session does not know: it stays plain and a forged click only tells the user", async () => {
		const world = fake({ known: { Other: "roster" } });
		assert.deepEqual(await validate(world, "agent://Nope"), valid(false));
		await click(world, "agent://Nope");
		assert.deepEqual(world.calls, []);
		assert.deepEqual(world.warnings, ['cannot open "agent://Nope": this session has no agent Nope.']);
	});

	it("ignores a JSON-path suffix and takes a nested id as the dotted name", async () => {
		const world = fake({ known: { "Parent.Child": "roster" } });
		const target = "agent://Parent.Child/reports/0/data";
		assert.deepEqual(await validate(world, target), valid(true));
		await click(world, target);
		assert.deepEqual(world.calls, ["tab Parent.Child"]);
	});

	it("opens the published output when the roster does not hold the agent (a stopped or resumed session), also for a nested id", async () => {
		const world = fake();
		assert.deepEqual(await validate(world, "agent://FinishedReview"), valid(true));
		await click(world, "agent://FinishedReview");
		assert.deepEqual(world.calls, ["document FinishedReview of 2026-10-17T10-00-00_S-1.jsonl"]);
		assert.deepEqual(await validate(world, "agent://Parent.Child"), valid(true));
		await click(world, "agent://Parent.Child");
		assert.deepEqual(world.calls, ["document Parent.Child of 2026-10-17T10-00-00_S-1.jsonl"]);
	});

	it("prefers the roster's live tab over the output file, and the output file over a task-result reference that OMP may no longer hold", async () => {
		const world = fake({ known: { FinishedReview: "roster", Parent: "reference", Orphan: "reference" } });
		await click(world, "agent://FinishedReview");
		assert.deepEqual(world.calls, ["tab FinishedReview"]);
		await click(world, "agent://Parent");
		assert.deepEqual(world.calls, ["document Parent of 2026-10-17T10-00-00_S-1.jsonl"]);
		await click(world, "agent://Orphan");
		assert.deepEqual(world.calls, ["tab Orphan"], "a reference with no output yet (a nested agent still running) opens the tab");
	});

	it("never reaches another session's data, however the id is spelled", async () => {
		const world = fake();
		assert.deepEqual(await validate(world, "agent://OtherSessionReview"), valid(false));
		const asForeign = fake({ sessionFile: foreign });
		assert.deepEqual(await validate(asForeign, "agent://OtherSessionReview"), valid(true), "it is the other session's own link");
		assert.deepEqual(await validate(asForeign, "agent://FinishedReview"), valid(false));
		assert.equal(parseInternalLink("agent://../2026-10-17T11-00-00_S-2/OtherSessionReview"), null);
		assert.equal(parseInternalLink("agent://Parent/../../x"), null);
	});

	it("shows no tab where the conversation has none (a terminal editor), and no file where the conversation has no session file yet", async () => {
		const terminal = fake({ known: { Live: "roster", Parent: "roster" }, tabs: false });
		assert.deepEqual(await validate(terminal, "agent://Live"), valid(false));
		await click(terminal, "agent://Parent");
		assert.deepEqual(terminal.calls, ["document Parent of 2026-10-17T10-00-00_S-1.jsonl"], "the output is still a document");
		const unsaved = fake({ known: { Live: "roster" }, sessionFile: null });
		assert.deepEqual(await validate(unsaved, "agent://Live"), valid(true));
		assert.deepEqual(await validate(unsaved, "agent://FinishedReview"), valid(false));
	});

	it("Ctrl+Shift+Click shows the output file in the file manager; a detail tab has no file, so it opens", async () => {
		const world = fake({ known: { Live: "roster" } });
		await click(world, "agent://FinishedReview", "os");
		assert.deepEqual(world.calls, [`os ${path.join("2026-10-17T10-00-00_S-1", "FinishedReview.md")}`]);
		await click(world, "agent://Live", "os");
		assert.deepEqual(world.calls, ["tab Live"]);
		await click(world, "agent://FinishedReview", "reveal");
		assert.deepEqual(world.calls, ["document FinishedReview of 2026-10-17T10-00-00_S-1.jsonl"], "Ctrl+Click is a plain open: there is no folder of the window to reveal it in");
	});
});

describe("history:// in a reply", () => {
	it("is the agent's transcript tab, only for an agent the live session knows; an output file is not a transcript", async () => {
		const world = fake({ known: { Worker: "roster", Referenced: "reference" } });
		assert.deepEqual(await validate(world, "history://Worker"), valid(true));
		assert.deepEqual(await validate(world, "history://Referenced"), valid(true));
		await click(world, "history://Worker");
		assert.deepEqual(world.calls, ["tab Worker"]);
		assert.deepEqual(await validate(world, "history://FinishedReview"), valid(false), "FinishedReview.md is its output, not its history");
		assert.deepEqual(await validate(world, "history://current"), valid(false));
		assert.deepEqual(await validate(fake({ known: { Worker: "roster" }, tabs: false }), "history://Worker"), valid(false));
	});
});

describe("artifact:// and local:// in a reply", () => {
	it("open the existing artifact document and a scratch file of the session, and are plain when the session has none", async () => {
		const world = fake();
		assert.deepEqual(await validate(world, "artifact://12"), valid(true));
		await click(world, "artifact://12");
		assert.deepEqual(world.calls, ["artifact 12 of 2026-10-17T10-00-00_S-1.jsonl"]);
		assert.deepEqual(await validate(world, "artifact://99"), valid(false), "another session's artifact");
		assert.deepEqual(await validate(world, "local://plan.md"), valid(true));
		await click(world, "local://plan.md");
		assert.deepEqual(world.calls, ["document plan.md of 2026-10-17T10-00-00_S-1.jsonl"]);
		assert.deepEqual(await validate(world, "local://missing.md"), valid(false));
		await click(world, "local://missing.md");
		assert.deepEqual(world.warnings.at(-1), 'cannot open "local://missing.md": this session\'s scratch space has no file missing.md.');
		await click(world, "artifact://12", "os");
		assert.deepEqual(world.calls, [`os ${path.join("2026-10-17T10-00-00_S-1", "12.bash.log")}`]);
		assert.deepEqual(await validate(fake({ sessionFile: null }), "artifact://12"), valid(false));
	});

	it("says why when a document cannot be opened, and when opening throws", async () => {
		const world = fake();
		world.outcome = { opened: false, reason: "Artifact 12 could not be opened: no editor." };
		await click(world, "artifact://12");
		assert.deepEqual(world.warnings, ["Artifact 12 could not be opened: no editor."]);
		world.failOpen = true;
		await click(world, "local://plan.md");
		assert.equal(world.warnings.at(-1), 'cannot open "local://plan.md": cannot display');
	});
});

describe("currency", () => {
	it("answers and opens nothing once the document or session that asked was replaced while the disk was read", async () => {
		const world = fake({ known: { Live: "roster" } });
		const stale: InternalLinkHost = { ...world.host, isCurrent: () => false, tabs: true };
		await handleInternalLink(request("omp:terminal-link-validate", "agent://FinishedReview"), link("agent://FinishedReview"), stale);
		await handleInternalLink(request("omp:terminal-link-open", "agent://FinishedReview"), link("agent://FinishedReview"), stale);
		await handleInternalLink(request("omp:terminal-link-open", "agent://Live"), link("agent://Live"), stale);
		assert.deepEqual([world.replies, world.calls, world.warnings], [[], [], []]);
	});

	it("resolves from the host's own state each time, so a page's earlier answer never decides", async () => {
		const world = fake();
		assert.equal(await resolveInternalLink(link("agent://Late"), world.host), null);
		world.known = { Late: "roster" };
		assert.deepEqual(await resolveInternalLink(link("agent://Late"), world.host), { kind: "agent-tab", id: "Late" });
	});
});
