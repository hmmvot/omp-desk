/**
 * Tests for the startup/performance diagnostics recorder.
 *
 * The report is an extension-owned document a user may copy elsewhere, so the
 * properties under test are the ones that make it trustworthy: a measurement is
 * either real or explicitly `not observed`, every measurement carries its
 * provenance, nothing is truncated into a wrong value, and no bearer capability
 * can appear in the text.
 *
 * Runner: `node --test src/host/diagnostics.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DIAGNOSTIC_STAGES,
	DiagnosticsRecorder,
	MAX_DIAGNOSTIC_NOTES,
	MAX_DIAGNOSTIC_VALUE_CHARS,
	REDACTED_CAPABILITY,
	WINDOW_DIAGNOSTIC_SUBJECT,
	formatMeasured,
	redactCapabilities,
	type DiagnosticEnvironment,
} from "./diagnostics.ts";

/** A clock the test advances by hand, so a duration is an exact assertion. */
function testClock(start = 1_700_000_000_000) {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const ENVIRONMENT: DiagnosticEnvironment = {
	extensionVersion: "0.0.1",
	vscodeVersion: "1.110.0",
	platform: "win32 x64",
	hostPid: 4242,
	storagePath: "C:\\storage\\omp-desk",
	generatedAt: 1_700_000_100_000,
};

describe("diagnostics measurement", () => {
	it("measures a started stage with the recorder's own clock", () => {
		const clock = testClock();
		const recorder = new DiagnosticsRecorder({ now: clock.now });
		recorder.beginSubject("tab-1", { label: "OMP: repo", kind: "session" });
		recorder.begin("tab-1", "broker-launch");
		clock.advance(37);
		recorder.succeed("tab-1", "broker-launch", { detail: "pid 4242" });

		const subject = recorder.snapshot("tab-1");
		const stage = subject?.stages.find(current => current.id === "broker-launch");
		assert.equal(stage?.state, "ok");
		assert.equal(stage?.durationMs, 37);
		assert.equal(stage?.detail, "pid 4242");
		assert.equal(stage?.provenance, DIAGNOSTIC_STAGES.find(current => current.id === "broker-launch")?.provenance);
	});

	it("never invents a duration for an unobserved stage", () => {
		const recorder = new DiagnosticsRecorder();
		recorder.beginSubject("tab-1", { label: "OMP: repo", kind: "session", cwd: "D:\\repo" });
		recorder.notObserved("tab-1", "resolution", "this window did not launch this host");

		const stage = recorder
			.snapshot("tab-1")
			?.stages.find(current => current.id === "resolution");
		assert.equal(stage?.state, "not-observed");
		assert.equal(stage?.durationMs, null);
		assert.equal(stage?.at, null);

		// Every stage this subject owns is present, so a missing measurement is
		// visible rather than silently narrowing the report.
		const rendered = recorder.render(ENVIRONMENT);
		for (const definition of DIAGNOSTIC_STAGES) {
			if (definition.scope !== "session") continue;
			assert.ok(rendered.includes(definition.label), definition.id);
		}
		assert.ok(!rendered.includes("| 0 ms |"));
	});

	it("keeps a failure distinguishable from a fast success", () => {
		const clock = testClock();
		const recorder = new DiagnosticsRecorder({ now: clock.now });
		recorder.beginSubject("tab-1", { label: "OMP: repo", kind: "session" });
		recorder.begin("tab-1", "chat-live");
		clock.advance(15_000);
		recorder.fail("tab-1", "chat-live", "the session never reached phase=live");

		const stage = recorder.snapshot("tab-1")?.stages.find(current => current.id === "chat-live");
		assert.equal(stage?.state, "failed");
		assert.equal(stage?.durationMs, 15_000);
		assert.ok(recorder.render(ENVIRONMENT).includes("the session never reached phase=live"));
	});

	it("records an externally measured duration with its own provenance", () => {
		const recorder = new DiagnosticsRecorder();
		recorder.beginSubject("tab-1", { label: "OMP: repo", kind: "session" });
		recorder.observe("tab-1", "resolution", {
			durationMs: 118.4,
			detail: "C:\\bun\\omp.exe via PATH",
			provenance: "launcher: measured inside this launch",
		});

		const stage = recorder.snapshot("tab-1")?.stages.find(current => current.id === "resolution");
		assert.equal(stage?.durationMs, 118);
		assert.equal(stage?.provenance, "launcher: measured inside this launch");
	});

	it("derives a since-start offset only from two measured marks", () => {
		const clock = testClock();
		const recorder = new DiagnosticsRecorder({ now: clock.now });
		recorder.beginSubject("tab-1", { label: "OMP: repo", kind: "session" });
		const startedAt = recorder.snapshot("tab-1")?.startedAt ?? 0;
		recorder.begin("tab-1", "chat-live");
		clock.advance(2_400);
		recorder.succeed("tab-1", "chat-live");

		const row = recorder
			.render(ENVIRONMENT)
			.split("\n")
			.find(line => line.startsWith("| Chat live "));
		assert.equal(recorder.snapshot("tab-1")?.startedAt, startedAt);
		assert.ok(row?.includes("| 2.40 s |"));
		// The launch mark and the closing observation are both real, so the
		// derived offset is stated as such.
		const cells = (row ?? "").split(" | ");
		assert.equal(cells[4], "+2.40 s");
	});
});

describe("diagnostics content bounds", () => {
	it("truncates an oversized value instead of reporting it in part as if complete", () => {
		const recorder = new DiagnosticsRecorder();
		recorder.beginSubject("tab-1", { label: "OMP: repo", kind: "session" });
		recorder.fact("tab-1", "room warning", "x".repeat(MAX_DIAGNOSTIC_VALUE_CHARS + 50));

		const value = recorder.snapshot("tab-1")?.facts[0]?.value ?? "";
		assert.equal(value.length, MAX_DIAGNOSTIC_VALUE_CHARS + 1);
		assert.ok(value.endsWith("…"));
	});

	it("drops the oldest notes at the cap and keeps the newest", () => {
		const recorder = new DiagnosticsRecorder();
		recorder.beginSubject("tab-1", { label: "OMP: repo", kind: "session" });
		for (let index = 0; index < MAX_DIAGNOSTIC_NOTES + 5; index += 1) recorder.note("tab-1", `note ${index}`);

		const notes = recorder.snapshot("tab-1")?.notes ?? [];
		assert.equal(notes.length, MAX_DIAGNOSTIC_NOTES);
		assert.equal(notes[0]?.text, "note 5");
		assert.equal(notes[notes.length - 1]?.text, `note ${MAX_DIAGNOSTIC_NOTES + 4}`);
	});

	it("forgets a subject on request", () => {
		const recorder = new DiagnosticsRecorder();
		recorder.beginSubject("tab-1", { label: "OMP: repo", kind: "session" });
		recorder.forget("tab-1");
		assert.equal(recorder.snapshot("tab-1"), null);
		assert.equal(recorder.subjects().length, 0);
	});

	it("keeps the first start mark when a subject is re-announced", () => {
		const clock = testClock();
		const recorder = new DiagnosticsRecorder({ now: clock.now });
		recorder.beginSubject("tab-1", { label: "OMP: repo", kind: "session", sessionFile: null });
		const startedAt = recorder.snapshot("tab-1")?.startedAt;
		clock.advance(5_000);
		recorder.beginSubject("tab-1", { label: "OMP: repo", kind: "session", sessionFile: "D:\\sessions\\a.jsonl" });

		const subject = recorder.snapshot("tab-1");
		assert.equal(subject?.startedAt, startedAt);
		assert.equal(subject?.sessionFile, "D:\\sessions\\a.jsonl");
	});
});

describe("capability redaction", () => {
	it("removes a room path, a bare room key and an explicit token query", () => {
		const link = "ws://127.0.0.1:51234/r/AbCdEfGhIjKlMnOp.Qx9_Room_Key_Material?token=Zm9vYmFyYmF6cXV4";
		const redacted = redactCapabilities(`link ${link} bare AbCdEfGhIjKlMnop02#Qx9_Room_Key_Material`);
		assert.ok(!redacted.includes("/r/"));
		assert.ok(!redacted.includes("token="));
		assert.ok(!redacted.includes("Qx9_Room_Key_Material"));
		assert.ok(redacted.includes(REDACTED_CAPABILITY));
	});

	it("keeps a loopback relay origin, which is not a capability", () => {
		assert.equal(redactCapabilities("ws://127.0.0.1:51234"), "ws://127.0.0.1:51234");
	});

	it("cannot leak a capability through any recorded field", () => {
		const recorder = new DiagnosticsRecorder();
		const link = "ws://127.0.0.1:51234/r/AbCdEfGhIjKlMnop.Qx9_Room_Key_Material";
		recorder.beginSubject("tab-1", { label: "OMP: repo", kind: "session" });
		recorder.fact("tab-1", "link", link);
		recorder.note("tab-1", `delivered ${link}`);
		recorder.observe("tab-1", "chat-live", { durationMs: 10, detail: link });
		recorder.notObserved("tab-1", "resolution", `no link: ${link}`);

		const rendered = recorder.render(ENVIRONMENT);
		assert.ok(!rendered.includes("/r/"));
		assert.ok(!rendered.includes("Qx9_Room_Key_Material"));

		const subject = recorder.snapshot("tab-1");
		const serialized = JSON.stringify(subject);
		assert.ok(!serialized.includes("/r/"));
		assert.ok(!serialized.includes("Qx9_Room_Key_Material"));
	});

	it("states what the report is and is not", () => {
		const recorder = new DiagnosticsRecorder();
		recorder.beginSubject(WINDOW_DIAGNOSTIC_SUBJECT, { label: "window", kind: "window" });
		const rendered = recorder.render(ENVIRONMENT);
		assert.ok(rendered.startsWith("# OMP Desk — diagnostics"));
		assert.ok(rendered.includes("never contains a secret or a bearer capability"));
		assert.ok(rendered.includes("Prewarm: this extension starts nothing ahead of time"));
		assert.ok(rendered.includes("win32 x64"));
		assert.ok(rendered.includes("extension host pid 4242"));
	});

	it("states a stage's unmeasured reason exactly once", () => {
		const recorder = new DiagnosticsRecorder();
		recorder.beginSubject("tab-1", { label: "OMP: repo", kind: "session" });
		recorder.notObserved("tab-1", "chat-live", "the session never reported phase=live");
		const rendered = recorder.render(ENVIRONMENT);
		assert.equal(rendered.split("the session never reported phase=live").length - 1, 1);
	});
});

describe("formatMeasured", () => {
	it("never renders an unmeasured duration as a number", () => {
		assert.equal(formatMeasured(null), "not observed");
		assert.equal(formatMeasured(0), "0 ms");
		assert.equal(formatMeasured(999), "999 ms");
		assert.equal(formatMeasured(1_240), "1.24 s");
		assert.equal(formatMeasured(64_500), "1 m 4.5 s");
	});
});

describe("report redaction is defence in depth, not the rule", () => {
	it("the report redactor keeps the narrower link shapes only", () => {
		// The report's own redaction is a second line of defence, not what makes a
		// surface safe: it recognises link-shaped text and deliberately leaves a bare
		// secret-length run alone. Safety comes from what reaches the report at all:
		// no external identifier is displayed, so no representation of a secret can
		// be carried in one.
		const shaped = "A".repeat(43);

		assert.equal(redactCapabilities(shaped), shaped, "a standalone secret-length run survives the report redactor");
		assert.equal(redactCapabilities(`see /r/${shaped}.${shaped}`), "see [capability removed]", "while a link shape does not");
	});
});
