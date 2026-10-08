---
status: superseded
date: 2026-09-25
---

# ADR-0017: Give every owned diagnostic surface a bounded vocabulary instead of untrusted text

> Superseded by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) for every Collab-specific surface (link parser categories, `omp collab` CLI outcomes, relay/host prose, guest status text): those surfaces are removed. The bounded-vocabulary principle is kept for extension-owned surfaces of the rpc-ui design (fixed phases and codes; child stderr appears only in the user-invoked diagnostics document). Preserved as history.

## Context and Problem Statement

A Collab room link is a bearer capability: its URL path carries the room id and a
secret (a 32-byte key, plus a 16-byte write token for a full-control link), and
whoever holds it can join the room. Text this extension did not author — a Collab
CLI's stderr, a host or relay message, an identifier from a listing — can be a
capability or quote one, and it can be *represented* in ways no pattern recognises:
percent-escaped per character, split across fields, re-encoded.

Two review rounds produced seven reachable leaks, and every one of them was an
instance of the same structural gap — a surface that carried text from outside and
relied on a pattern, a substitution list or a per-field filter to make it safe:

1. **COLLAB-001** a host `transcript` refusal's `error` text was resolved unchanged
   and composed into the Hub's refusal line.
2. **COLLAB-002** a host-controlled `state.model.id` was copied into `omp:status`
   and recorded in the `guest-live` diagnostics detail, where the report's own
   narrower redaction let a bare 43-character secret-shaped id through.
3. **COLLAB-003** reconciliation and stop outcome messages interpolated a CLI-listed
   room instance id directly, reaching session details, logs and notifications.
4. **COLLAB-004** a host `error` frame that gave the key as individual percent
   escapes beside the plain room id was reconstructable as a link and matched
   neither the exact-removal list nor the four-shape detector.
5. **V4-M1** a valid host `bye` frame's `reason` went straight to the panel as the
   guest's `endedReason`; it is diagnostic text and needs no malformed frame.
6. **V4-M2** the "bounded enumerations and numbers" were TypeScript assumptions, not
   validated inputs: wire JSON is cast, not schema-checked, so a `notice` level or a
   retry count could be any value and was interpolated; the frame-application failure
   path echoed an exception's message.
7. **V4-M3** a per-field identifier allow-list could not establish what it claimed:
   two externally chosen fields that each look identifier-shaped can carry one secret
   *between* them (the first 21 characters of a key in one field, the remaining 22 in
   another).

The maintainer's instruction was explicit: do not silently accept a residual,
prefer bounded structured categories with fail-closed treatment for arbitrary
host/relay prose, preserve safe fixed diagnostics, and make represented or encoded
secrets impossible to echo rather than chasing patterns.

## Considered Options

- **Option 1 — a bounded vocabulary per owned surface.** A diagnostic surface this
  window owns may carry only fixed text this extension or its guest authored, bounded
  enumerations the wire or this extension defines, and numbers this window observed
  or validated. An externally chosen string is not carried at all — not filtered, not
  truncated, not split across fields. Nothing is transformed, so no representation
  can survive, and nothing is per-field, so a split secret has no path.
- **Option 2 — sanitize every string (patterns, literal removal, per-field filters).**
  The first two revisions of this decision. Each round found the same secret reaching
  a surface in a representation the filter did not anticipate (COLLAB-004), or across
  fields a filter could not correlate (V4-M3). Kept only where it already existed as
  defence in depth (the diagnostics report's own `redactCapabilities`).
- **Option 3 — suppress everything from the Collab boundary.** Rejected: the panel
  must still say *why* a join failed, and a session's own content is the thing the
  user asked to read. Option 1 keeps those and drops only unvouched-for strings.
- **Option 4 — keep displaying external identifiers with an approved narrower
  guarantee.** Rejected by the maintainer: the threat model that rejects an encoded
  secret also rejects a split one, and a per-field lexical bound cannot speak for the
  information carried across fields.

## Decision Outcome

Option 1.

- `src/capability-text.ts` owns the vocabulary: `CAPABILITY_WITHHELD` (what a caller
  records or shows instead of untrusted text), `HOST_TEXT_WITHHELD` (what a guest
  shows instead of the host's or relay's own message) and the fixed builders for
  Collab CLI failures and reattach outcomes. **No builder takes an external
  identifier**, and there is no lexical filter: a string chosen outside this window is
  not displayed in whole or in part. The shape detector, the literal-removal helper
  and the identifier allow-list of earlier revisions are **deleted**.
- **Guest** (`src/webview/lib/client.ts`): no host or relay prose is rendered or
  forwarded. A pre-welcome `error` frame ends the connection with
  `HOST_TEXT_WITHHELD`; a post-welcome error notice carries that fixed text; a
  `transcript` refusal keeps its `kind: "error"` and carries the fixed text
  (COLLAB-001); a `bye` ends the connection with a fixed sentence this guest authored
  (V4-M1); a `notice` level is validated against the three levels the wire defines
  and falls back to `info`, and a retry's counts are interpolated only when they are
  small integers (V4-M2); a frame-application failure reports a fixed category and
  neither the exception nor its message (V4-M2); a close reason is either the
  socket's own fixed text for a known close code or a fixed sentence this guest
  composes, and the recorder's close *metadata* carries the fixed form while admitted
  payloads stay exactly as received.
- **Message boundary** (`src/webview/messages.ts`): the guest's `omp:status` detail
  and `omp:error` message are replaced by `CAPABILITY_WITHHELD` at the parse, so
  every consumer — the log, the diagnostics report, the notification, the launcher
  row — is downstream of a value that is never the guest's or the host's text. The
  status message carries no `model` id either: it is the host's own string and this
  message feeds diagnostics (COLLAB-002). The bounded facts that remain are the
  phase, the code and the link kind.
- **Host** (`src/host/native-terminal.ts`, `src/extension.ts`): the Collab
  diagnostic projections carry no externally chosen identifier. The CLI failure
  messages name the command, the
  exit code and the error-output note; the reattach outcomes carry the process id and
  the room generation (numbers this window observed or read as numbers); the
  reconciliation verdicts, the failed-stop detail, the `control link obtained` log
  and the diagnostics report's room fact use fixed labels ("this tab's room", "the
  host this window asked about") instead of the listing's ids (COLLAB-003, V4-M3).
  Identity comparisons keep the original values.

### Scope of this decision

The guarantee is **exclusion of externally supplied diagnostic strings from the
Collab error/status/notice/refusal and CLI-outcome projections this decision
changes**, not universal information-flow secrecy, and it is not a claim that no
identifier is ever displayed by this extension:

- room, session and process identity remain visible where they are the subject the
  user is looking at — the raw recorder's consent disclosure and its viewer's binding
  header, and the launcher's session rows — as [ADR-0016](0016-bind-recording-to-link-room-identity.md)
  deliberately preserves;
- the separately owned host-control diagnostics (an authenticated channel's own
  identity read-back) are untouched by this decision;
- bounded facts this decision *does* keep observable on purpose: an exit code, a
  schema version, an access level, a phase, an error code, a process id, a room
  generation, a retry count.

### Consequences

- Positive: the seven findings are closed by construction, and so is the class they
  belong to within the scope above. No external string is carried on those
  projections, so neither a single encoded value nor a secret split across several
  fields has a path into one, and there is no filter left to argue about (V4-M3).
- Positive: ordinary diagnostics survive as bounded facts — an exit code, a schema
  mismatch, a phase, an event kind, an error code, a process id, a room generation —
  so a failure is still reportable.
- Negative: a panel no longer shows the host's own wording for a notice, a retry
  failure, a compaction, a refusal, a `bye` reason or a close reason; it shows a
  fixed sentence. A Collab CLI failure no longer shows OMP's own message, and these
  diagnostics no longer show a room, session or model identifier. That is the
  accepted cost of not carrying external strings: the identifiers remain in this
  window's own index and in the identity surfaces listed under *Scope*, and a
  maintainer who needs the CLI's text can run the command.
- Negative: the diagnostics report's own `redactCapabilities` remains narrower than
  this policy and is now explicitly defence in depth, not the mechanism that makes
  the report safe.
- Negative, and deliberately outside this decision: the chat panel's own **session
  content** — transcript entries, tool output, the model's text — is shown as the
  host sent it, and the raw recorder's admitted payloads are kept exactly as
  received. That is the session the user asked to read; a secret someone wrote into a
  session is visible in it. This policy governs diagnostics, not session content.
- Negative, out of scope and recorded rather than fixed: the OMP binary resolution
  path still forwards its own `--version` stderr, and unrelated CLI ingresses
  (provider usage, host-control helper hints) are untouched.

## Related Documents

- [ADR-0016: Bind a recording to the room its session's own link addresses](0016-bind-recording-to-link-room-identity.md)
  — whose review recorded the original exposure as unresolved, and whose rejected
  Option 2 rationale described the link module's former runtime import (replaced here
  by a local constants module).
- [ADR-0002: Local Collab guest for native OMP GUI](0002-local-collab-gui-native-omp.md)
  — the loopback-only relay and capability handling this decision refines.
- [Architecture](../architecture.md) — the diagnostics and recorder sections that
  describe what this window records and shows.

## Architecture Review

- Reviewer: architect, read-only
  against the live working tree.
- Outcome: the first pass found six MATERIAL and three NON-MATERIAL findings, all
  repaired; two confirmation passes then found R1–R5 (attach outcomes, the scheme
  claim, test evidence, stale wording, the launch-stage detail), all repaired; the
  review of the bounded-vocabulary revision found V4-M1–V4-M3 and V4-N1, all repaired
  here, and the confirmation of that revision found the scope correction only
  partially landed; both documentation corrections are now in place and the reviewer
  confirmed no further implementation finding. This record is `accepted` on that
  outcome, as an architecture decision only — not as GUI or end-to-end certification.
- Notes, V4 round:
  - V4-M1 the `bye` reason reached the panel → it is now a fixed sentence, with a
    client-level regression using the percent-escaped key fixture.
  - V4-M2 bounded kinds and numbers were unvalidated → the notice level is checked
    against the wire's three levels with an `info` fallback, retry counts are
    interpolated only when they are small integers, and a frame-application failure
    reports a fixed category without the exception or its message; client-level
    regressions cover a malformed level, a malformed count and the failure path.
  - V4-M3 the identifier allow-list could not exclude a split secret → no external
    identifier is displayed anywhere; the builders take numbers and fixed labels
    only, and the allow-list is deleted.
  - V4-N1 the evidence is described as client/policy/message-boundary coverage; the
    constant-inspection test is deleted, and the new consumer-visible cases live in
    the client suite.
- Notes, V5 round (confirmation of this revision):
  - V5-M1 (MATERIAL) the record claimed that no externally chosen identifier is
    displayed anywhere, which exceeded this package's boundary: identity metadata is
    deliberately visible in the recorder's consent disclosure, its viewer's binding
    header and the launcher's rows (ADR-0016), and the host-control diagnostics are a
    separate subsystem → the *Scope of this decision* section now states exactly what
    this decision changes, what it leaves in place, and that the guarantee is
    exclusion of externally supplied diagnostic strings rather than universal
    secrecy.
  - V5-N1 (NON-MATERIAL) the claimed frame-application-failure regression was absent
    → added: a malformed frame reaches the catch path, the notice is the fixed
    category and `console.warn` receives only the fixed string.
  - V5-N2 (NON-MATERIAL) the constant-inspection test was still present and two
    comments were stale → the test is deleted and both comments corrected.
  - Confirmation of that revision found V5-M1 only partially landed: the scope
    section and the architecture clause had not actually been written into the files.
    Both are now in place (the section above; the architecture sentence now reads
    "these Collab diagnostic projections do not display externally chosen
    identifiers"), and the reviewer confirmed V5-N1 and V5-N2 resolved with no further
    implementation finding.
