---
status: superseded
date: 2026-09-25
---

# ADR-0016: Bind a recording to the room its session's own link addresses

> Superseded by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): there is no Collab room, link or recorder after the rpc-ui cutover. Preserved as history of how a room identity was bound.

## Context and Problem Statement

The raw Collab receive recorder binds each epoch to an immutable identity, and one
of its fields is the Collab room the guest is pinned to. The guest's own receive
tap refuses to submit anything until the room it joined and the welcome it accepted
match the epoch's expected room and session, and a mismatch stops the epoch
permanently with `identity-mismatch`.

That field was filled from the *native host's* `instanceId`
(`rawRecorderFactsFor` in `src/extension.ts`). Those are two different identities:

- `instanceId` is the Collab subsystem's own **controller instance id**: installed
  OMP's Collab controller mints a 16-hex value once, when the controller is
  constructed, and retains it across room rotations; the `generation` it publishes
  increments per room. `omp collab list` publishes both.
- `roomId` is a random room identifier carried in a link's `/r/<roomId>` path. It
  is what the guest joins and what the relay routes on.

A real isolated window produced the defect: host-control verified the exact process,
the native link for that host named a different room (`u1RH3McuQZ9Gbv-SwF7i5g`), the
consent dialog completed and the epoch was created, and the tap stopped it three
seconds later with `identity-mismatch` and zero recorded frames. Nothing was unsafe —
the mismatch was refused, as designed — but the recorder could never record anything
on a real session.

> **Correction (2026-09-25).** The paragraph above, and the decision text below,
> described `instanceId` as *process* identity that the authenticated host-control
> channel verifies. That premise is false, and the live acceptance run proved it:
> the host-control server mints its **own** `inst-<uuid>` inside the native process
> (`src/omp/host-control.ts`), installed OMP's Collab controller independently mints
> its own 16-hex instance id (`installed/src/collab/controller.ts`), and nothing
> makes the two values equal. The first revision of this decision therefore added an
> equality between them, and every real session refused with "the Collab link this
> session holds was not issued for the host this window verified".
>
> The identity these two subsystems *do* share is the native OS **process**, and the
> rule now uses it: the Collab-published host PID must be the PID the authenticated
> channel proved on its own pipe handle (`ControlPeerProof.serverPid`), while the
> link is still paired to the published `(instanceId, generation)` within the Collab
> domain. The choice recorded here — bind the recording to the room the session's own
> link addresses — is unchanged; what changed is how the link is proven to belong to
> this window's host. The rule itself is in `src/host/collab-room-identity.ts`.

The recorder therefore has to derive the room from the link the guest is actually
given, and it has to do so host-side, where the consent facts are built.

## Considered Options

- **Option 1 — derive the room id from the session's own link, in a host-side
  module that extracts it from the link's room path.** The link is the exact
  capability this window acquired and handed that guest (`CollabControlLink`: the
  Collab host instance id, the room generation it was issued for, and the URL), so its
  `/r/<roomId>` is by construction the room the guest joins. The derivation refuses a
  missing link, a room whose published host is not the process the authenticated
  host-control channel proved on its own pipe handle, a link whose host or room
  generation is not the pair this window recorded, and a link that is not a local room
  link at all. (Corrected 2026-09-25: an earlier revision required the link's host
  instance id to equal the *host-control* instance id, which are independent mints.)
- **Option 2 — import the guest's vendored parser (`parseLocalCollabLink`) into the
  host derivation.** One grammar, no mirroring. Rejected because the host must not
  depend on the guest bundle, and because this rule is *extraction* under a
  loopback-only policy rather than the guest's general-purpose link reader: the
  derivation keeps its own dependency-free module that `node --test` can load directly.
  Its local wrapper does enforce loopback, so importing it would not have reintroduced a
  hosted-relay fallback; the objection is the dependency and module boundary, not the
  policy. (Corrected 2026-09-25: an earlier revision also objected that the parser's
  module imports `@oh-my-pi/pi-wire` runtime constants from TypeScript source and could
  not load under `node --test`. That was true when it was written and is no longer: the
  vendored file now imports its own `./wire-constants.ts` for exactly that reason, which
  is why conformance against the parser *is* executed in the tests below.) (Corrected
  2026-09-25: an earlier revision listed `http(s)` wrappers as leniency to be excluded. They are the
  form the native `omp collab link` command actually emits, so the host now unwraps
  them — see the Correction below.)
- **Option 3 — keep the host `instanceId` and make the guest accept it.** Rejected:
  it would weaken the guest's welcome check to a value the room never carries, so a
  recording could be admitted for a room nobody verified. The mismatch is the check
  working, not the check being wrong.
- **Option 4 — let the guest report the room it joined and bind to that.**
  Rejected: a Webview-supplied value must never authorize what is recorded
  (the recorder's rule is that facts come from extension-owned records), and it
  would make the expected room equal to the observed room by construction, which is
  no check at all.

## Decision Outcome

Option 1. `src/host/collab-room-identity.ts` owns the derivation:
`roomIdForVerifiedLink({ link, publishedRoom, verifiedNativePid })` returns the room
id carried by the session's own link, or a refusal reason, and `rawRecorderFactsFor`
uses it for `roomId` while keeping the host-control channel's own instance/PID/slot,
the owner generation, the canonical session file and the panel document. Three of its
facts are now sourced differently, and that is part of the correction:

- the proof must come from a channel that is **still open**: the recorder facts read
  `ControlPeerProof` from the same client as the binding, and that accessor refuses
  once the channel has closed, so a retained binding can never authorize a fact;
- `nativeGeneration` is the kernel creation time the authenticated channel proved
  (`ControlPeerProof.serverCreationTime`), for a fresh launch *and* for a restored
  attach, where the reattached runtime's own `processCreation` is deliberately null;
- the consent tuple additionally compares that native generation and the Collab room
  generation (`sameRecorderConsentIdentity` in `src/host/raw-recorder-policy.ts`), so a
  reused PID — the same PID with another kernel creation time — or a rotated room is a
  different target. The workspace root is compared as a canonical path, as the session
  file already was. This remains a post-dialog snapshot comparison, not an atomic
  arm-time fence, and the cached-pair limit below is unchanged.

A control attempt is fenced by the **exact runtime it started for**, not by a PID: an
OS can hand the same PID to a later process, so a stale attempt that verified a process
which has since exited could otherwise publish its channel into the tab that replaced
it (or report a failure that clears the replacement's channel). The marker is captured
at the attempt's *entry point* — `connectHostControl` and `reconnectHostControl` build
a `ControlAttemptPlan` before their own first await (persisting a launch record,
reading the stored recipient and proven key) — and passed into the connection work, so
every fence compares that captured runtime *object* against the tab's current runtime: a
fresh object for every launch and every attach, including a restored runtime whose own
`processCreation` is null, with the PID as a consistency check. A channel-less failure
must find a tab that holds no channel, and a held channel whose client has closed counts
as no channel, so a dead attempt cannot block the tab's next one.

The generation change is scoped to the **recorder** facts: the separate file-evidence
and deletion paths keep their own conservative handling of the runtime's
`processCreation` and refuse process-generation exclusion when it is absent, and
changing that availability behaviour is separate scope.

The provenance chain it relies on (as corrected above): the link is acquired through
native Collab discovery and link retrieval (`omp collab list`, then `omp collab link
<instance> --json`), which matches the answer to the published host instance and room
generation before returning it; the derivation then requires that `(instanceId,
generation)` pair to be the one this window recorded, requires the published host's
PID to be the PID the independently authenticated host-control channel proved on its
own pipe handle, and requires that PID to be the process this window launched. The
two subsystems' *instance ids* are never compared — they are independent mints. It
does not claim that the authenticated pipe issued the URL, nor that the Collab
registry's PID text is a kernel proof: the authenticated channel is what proves the
process, and the registry PID is matched against it.

The extraction is deliberately narrow, and it is *extraction*, not link validation:
`ws:`/`wss:` links on loopback hosts — plus their `http(s)` wrapper spelling, see the
Correction below — with a `/r/<roomId>` path and a present, unpadded base64url secret
of exactly 43 (32-byte view key) or 64 (32-byte key plus 16-byte write token)
characters; the scheme-less form this extension writes, the legacy `#`/`%23` fragment
key and the wrapper's fragment are read the way the guest's parser reads them.
Non-URL deep-link fragments and bare links the guest's general parser also handles
are refused here, and a padded or wrong-length secret is rejected by both parsers.
The secret's characters and length are inspected but it is never decoded to secret
bytes, and the refusal reasons never quote the link. The guest parser and welcome
check remain the final admission gates: rejection cannot authorize frames from that
link, and it does not itself guarantee that an armed
epoch closes — a link the guest cannot parse is reported as an error before the tap
is attached, and an armed tap with no verified connection stays paused.

### Consequences

- Positive: a recording is bound to the room the guest actually joins, so the
  documented live flow — consent, arm, prompt, at least one retained frame — can
  happen at all.
- Positive: the refusal surface is larger and fail-closed: no room published, no
  link yet, a host or room generation that is not the recorded pair, a host the
  authenticated channel did not verify, and a malformed, wrong-length,
  non-loopback or non-`/r/` link each refuse with a reason, instead of silently
  binding a value the guest will never match.
- Negative: the link grammar now exists in two places (the guest's vendored parser
  and this narrower extraction). The extraction has boundary coverage of its
  supported direct local forms and its excluded or malformed ones, and the tap test
  simulates the old and the new binding with the fixture's own room. (Corrected
  2026-09-25: this paragraph said parser conformance was not executed because the
  parser's module loads TypeScript from `node_modules`. The vendored module was changed
  to import its own `./wire-constants.ts` — its header records that change precisely so
  the module and its tests load under `node --test` — so conformance *is* executed now:
  a host-side corpus test imports the guest's local admission parser and requires the
  same room. See the second Correction below.)
- Negative: the pair check is *cached* consistency, not current-generation
  discovery. `refreshLink` re-acquires the pair only when the cached link is
  missing, so a room that rotates while a link is cached is not noticed here; the
  cached pair is what the recorder arms. If the panel refreshes before consent, the
  new pair is what a fresh consent would bind, and a room that changed between the
  two consent snapshots cancels the recording through the existing
  `sameSessionFacts` comparison. An undetected stale pair leaves the epoch armed
  for a room the guest cannot join: it can stay paused or end in a terminal
  connection failure, and zero stored frames is the expected but not guaranteed
  outcome — frames already admitted are never relabelled. No proactive rotation
  detection and no atomic cancellation through epoch creation is claimed.
- Negative: a session whose host published no Collab room can no longer be
  recorded at all. It has no guest connection, so it could never have produced
  frames; the pre-consent refusal now says so instead of binding a process identity.
- Negative: the derivation's hygiene is about what *it* handles — the key and link
  are never decoded, returned, stored or echoed in a reason. The surrounding guest
  and CLI error paths are not covered by that statement: the vendored parser's
  `Invalid collab link: <link>` message can reach a user-visible error and the log
  through the guest's error report, and CLI failure diagnostics can carry stderr.
  That is pre-existing, is not introduced or repaired here, and is recorded as a
  follow-up for the maintainer rather than silently covered by this decision.

## Related Documents

> Update (2026-09-25): the rejected Option 2 rationale above describes the link module's former runtime import of `@oh-my-pi/pi-wire`. [ADR-0017](0017-never-forward-capability-bearing-error-text.md) replaced that import with a local constants module (`src/webview/lib/wire-constants.ts`) so the parser and its tests load under `node --test`; the decision recorded here is unchanged.

- [Raw session recorder design](../designs/2026-09-24-raw-session-recorder.md) — the
  consent, binding and revalidation contract this decision refines.
- [ADR-0002: Local Collab guest for native OMP GUI](0002-local-collab-gui-native-omp.md)
  — the loopback-only relay this decision's link rule relies on.
- [ADR-0007: Native file evidence with guarded restore](0007-native-file-evidence-and-guarded-restore.md)
  — the recorder's separate evidence/restore limits.

## Architecture Review

- Reviewer: architect, read-only
  against the first revision (2026-09-25).
- Outcome: accepted. The confirmation pass on the revised record found one
  MATERIAL wording issue (R1) and two NON-MATERIAL ones (R2, R3), all corrected
  here without any implementation change:
  - R1 (MATERIAL) the record and the module doc promised that a helper-accepted but
    guest-rejected link "ends as a stopped epoch with no stored frame"; a link the
    guest cannot parse is reported as an error before the tap is attached, so
    rejection cannot authorize frames but does not itself close an armed epoch →
    both now say the parser and welcome check are final admission gates whose
    rejection cannot authorize frames and does not itself guarantee closure, with
    the paused-versus-terminal explanation kept.
  - R2 (NON-MATERIAL) padded secrets are rejected by the guest parser too, not only
    here; the supported scheme-less and legacy `#`/`%23` forms were missing from the
    description; and "the secret is never read" was imprecise → the record and the
    module now say a padded or wrong-length secret is rejected by both parsers, list
    the supported forms, and say the secret's characters and length are inspected
    but never decoded to secret bytes.
  - R3 (NON-MATERIAL) "both are pinned by tests" and "strict subset … for the direct
    loopback forms" exceeded the proof → the record now claims boundary coverage of
    the extraction's supported and excluded forms plus a tap-level simulation, states
    that parser conformance was not executed with the direct runner, and names the
    intended claim as agreement on the supported forms; the boundary test was renamed
    to match.
- Notes: the reviewer kept Option 1 and the guest admission gate and raised four
  MATERIAL and three NON-MATERIAL findings in its first pass, all addressed here:
  - F1 (MATERIAL) the extraction accepted any base64url-shaped key, so it was not a
    subset of the parser's validation, and the record promised malformed-link
    refusal it did not keep → the extraction now requires the two unpadded secret
    lengths the parser decodes to (43/64), the module and this record say plainly
    that this is room *extraction* rather than complete link validation, the
    deliberate exclusions (bare links, padded secrets) are named, a non-`http(s)`
    carrier whose own path names a room is stated to resolve *that* path rather than its
    fragment, and the boundary matrix is tested.
  - F2 (MATERIAL) the rotation guarantees were overstated → the record now describes
    cached pair consistency, what a refreshed pair means for a new consent, the
    existing snapshot comparison, and a stale pair's paused-or-failed outcome
    instead of promising zero frames.
  - F3 (MATERIAL) the record attributed link issuance to the host-control pipe →
    the provenance chain is now stated as native discovery/link retrieval matched
    to its published host and generation, cross-checked against the independently
    authenticated identity.
  - F4 (MATERIAL) the capability-hygiene statement needed scope → it now covers
    exactly what the derivation handles, distinguishes the room id metadata the
    disclosure and viewer legitimately show from the link and key, and records the
    pre-existing parser/CLI error paths as an unresolved follow-up rather than a
    covered guarantee.
  - F5 (NON-MATERIAL) the test claims were stronger than the tests → the record and
    the artifact describe helper-derivation coverage plus a tap-level simulation of
    the old and new bindings, and state that no extension-callsite regression and no
    cross-parser conformance can be executed here.
  - F6 (NON-MATERIAL) Option 2's rationale conflated a bundle limitation with the
    test runner's, and implied a hosted-fallback risk → corrected to dependency
    isolation and direct-node-test compatibility, with the parser's loopback wrapper
    acknowledged.
  - F7 (NON-MATERIAL) related wording lagged the decision and the live observation →
    the recorder design's binding paragraph names this decision, its implementation
    status records the failed live attempt, `docs/architecture.md` gains the
    link-derived room identity and this ADR's link, and `docs/README.md` lists this
    record.

## Correction 2026-09-25 (second): the wrapper the native command actually emits

A live isolated run after the identity correction still refused Start Recording with
`Collab link … not a usable local room link`. The cause was this record's factual claim
about the link grammar, not the identity rule: the installed native
`omp collab link <host> --json` command reports an **`http:` loopback URL whose fragment
carries the whole `ws:` loopback room link** (`…/r/<roomId>.<secret>`, room id 22
characters, secret 64 characters = 32-byte key plus 16-byte write token, no query).
The guest's parser unwraps exactly that wrapper and joins the room it names, while the
host derivation refused every `http(s)` link as "wrapper leniency" — so the two sides
read different links and no real session could ever be bound.

The derivation now follows the guest's own selection order, under these rules:

- **A fragment that resolves to a room decides the link, whether or not that room is
  local.** Only a fragment that is no link at all lets an enclosing layer's own path be
  read. The guest selects a room first and applies its local-only policy to the *whole*
  link afterwards, so treating a hosted inner link as "no link here" — the first
  version of this correction did — fell back to the wrapper's own path and bound a
  recording to a room the guest never joins.
- `http(s)` is read as the wrapper spelling of `ws(s)`, so a wrapper's own path is
  judged under the same policy when the fragment names no room.
- **Locality is recorded, never used to select.** The room the link names is what must
  be local; a hosted room — inner, outer or bare — refuses the whole link, and never
  causes another room to be chosen. A hosted carrier whose fragment resolves to a
  loopback room resolves to *that local room*, which is what the guest joins.
- A bare `<roomId>.<key>` resolves against the guest's public default relay, so it
  selects a hosted room and is refused whole.
- A non-`http(s)` carrier whose own path names no room hands its fragment to the walk,
  exactly as the guest's deep-link handling does; a carrier whose path names a room does
  not, and an unsupported scheme (for example a `vscode:` permalink) is no link at all —
  the guest refuses it before its fragment is ever considered.
- The walk is **bounded** (two layers) where the guest recurses without a bound. Past
  the bound the whole link is refused and the refusal propagates through every enclosing
  layer, so nothing inside a too-deep chain is ever resolved — not the innermost room
  and not an enclosing layer's path.
- Padded or wrong-length secrets, empty or malformed wrappers and keys that are not one
  of the two accepted lengths stay refused; the secret is still never decoded, returned,
  logged or serialized, and no refusal reason quotes the link.

The property the tests hold down is that **the room the host derives is always the room
the guest's local admission parser selects**, compared against that parser itself over a
corpus; the only divergence is a refusal, never a different room. In that corpus the
bound was the sole source of such refusals — measured, not asserted: over 12,960
structured combinations the derivation and `parseLocalCollabLink` disagreed on **no**
room, and every one of the 504 host-only refusals was a chain past the bound (the guest
would resolve it). Sampled agreement is not proof over all strings, so the invariant to
keep is the property itself, and the differential corpus should be kept as a regression
precisely because this derivation mirrors the guest's selection logic and can drift when
that parser changes. The
production-shaped wrapper is a regression — without the unwrapping branch six tests
fail — and each precedence case failed against the pre-repair walk.

Two later findings in the same review are part of this correction. The guest's own
allowlist was read for *truthiness* (`!LOCAL_HOSTNAMES[hostname]`), so an inherited
property name such as `constructor` passed its plain-ws check while the local admission
wrapper — and this derivation — refused it: a carrier whose inner link was
`ws://constructor/…` made the guest refuse the link whole while the host bound the
carrier's own room. The vendored allowlist is now a null-prototype record read for exact
membership (a local edit, recorded in that file's header), so both sides select the same
room. A bare `<roomId>.<key>` is likewise validated before it is treated as a room, so a
malformed secret falls through to an enclosing layer exactly as the guest's does. The
secret is still never decoded here: any 43- or 64-character base64url key is accepted
without inspecting its bytes, which the guest's decode also accepts, so that asymmetry
produces no divergence either.
