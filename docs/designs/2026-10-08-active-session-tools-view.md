---
status: implemented
date: 2026-10-08
---

# Active-session Skills and Tools view

## Problem

Sessions and Processes show lifecycle state but not the capabilities the focused OMP session loaded. A separate read-only tree makes those capabilities discoverable without changing tool selection.

## Goals and Non-goals

- Show Skills and Tools for the active or last-focused OMP Chat or Terminal editor.
- Show plain descriptions and mark tools known to be inactive. Do not invent a skill file path when the runtime does not export one.
- Refresh on OMP editor focus, command-catalogue updates, lifecycle updates and an explicit title action.
- Do not select tools, scan disk for inferred skills, launch stopped sessions, or expose control credentials.

## Current State

At the starting baseline, Chat owned an RPC session and normalized slash-command catalogue, while `get_state.dumpTools` descriptors were discarded. Authenticated host control supplied a bounded names-only `listTools` read. Existing editor recency tracked the last-focused session.

## Proposed Design

Add `omp.tools` in the existing OMP Desk container. A tree provider projects two groups from a host-owned snapshot. The actual active OMP editor wins; otherwise the first still-open OMP panel in this window's `editorRecency` selects the session. Sessions-row/profile recency never selects a different runtime. A passive editor, missing runtime or stopped session produces a short empty-state message instead of stale capabilities.

For Chat, use catalogue entries whose source is `skill`. Installed OMP 18.6.3 builds these in `slash-commands/available-commands.ts` using `getSkillSlashCommandName`, which returns `skill:<skill.name>` (the native loaded name may already be namespaced). The catalogue contains name, description, input hint and source, but no file path. Skill commands can be disabled or shadowed, and the existing catalogue boundary keeps the first 500 entries; therefore the Skills group reports commands, not an exhaustive claim that no other skills loaded. No Open SKILL.md action can be offered with the current metadata; the coordinator accepted this verified limitation rather than a disk scan or unreachable shim.

Retain only bounded names/descriptions from `dumpTools`, not schemas/examples: at most 1,024 descriptors, 128 printable ASCII characters per name and 8,192 characters per description, rejecting malformed, oversized or duplicate inventories as unavailable without rejecting the rest of session state. Read authenticated `listTools` when available. Descriptions come from exact-name RPC matches. Active/inactive status comes only from `listTools`: a name in `all` but absent from `active` is inactive. A descriptor absent from both lists has unknown activation. Names lacking a descriptor say their description is unavailable; an unavailable activation source never invents an inactive mark.

For Terminal, use authenticated names-only host control when available, and explicitly report that skills/descriptions need RPC. Do not start RPC alongside a native writer. Reads happen only while the view is visible, with one request in flight and at most one queued refresh. Catalogue updates refresh the selected Chat; editor focus, lifecycle and manual refresh request fresh state. No polling/token-triggered reads or recovery retries are added. The existing RPC request deadline applies.

Each read is fenced by runtime/session object identity and a generation containing editor slot, conversation id, mode, RPC epoch, bound session file/id and authenticated host instance/epoch/file. Lifecycle changes clear the projection immediately. Before merging a control response, recheck the runtime/client, host epoch and equality of its current file with the RPC-bound file. Old responses cannot populate a newly selected or rebound session.

Descriptions are plain tooltip strings, never trusted Markdown or command links. Tool and skill rows have no invocation command or resource URI. Host-control failures use fixed unavailable sentences; no arbitrary failure prose is rendered.

## Alternatives

- Reconstruct skills from global directories: rejected because it would list discovered rather than loaded skills.
- Treat `dumpTools` as the entire registry: rejected because it is the current provider-facing set and does not identify inactive tools.
- Add a Terminal-only RPC child: rejected because it would duplicate ownership and expose a different session's capabilities.

## Risks and Open Questions

Installed naming and absent paths were verified from OMP source. Authenticated control reads are observations, not proof of settled selection or execution permission. Bounded metadata can be unavailable or incomplete; Skills means the catalogue's reported skill commands, not an exhaustive filesystem inventory.

## Rollout and Verification

Implement bounded parsing, the host projection/tree, registration/actions and focused tests. Run typecheck and targeted parser/session/tree tests after edits settle. Build/package/install an isolated VSIX and prove the view in a real Chat session, preserving screenshots. No main-profile installation or full test suite is part of this assignment. Stop owned sessions and close the isolated window after proof.

## Related Decisions

[ADR-0009](../decisions/0009-read-only-native-tools-until-atomic-selection.md) remains operative, including “The Webview shows names only: no schemas, descriptions, source paths, invocation, approval handling or settings writes.” The existing Webview and names-only host-control channel are unchanged. Descriptions in the separate VS Code tree come from identity-checked RPC `dumpTools`. The user's Tools request (2026-10-08) narrowly amends the older product no-inventory boundary; OMP remains the discovery owner.

## Architecture Review

- Reviewer: architect
- Outcome: accepted after two independent passes; the confirming pass's text-only ADR-scope correction was applied.
- Notes: addressed selection, generation, merge semantics, skill-command wording, visible-only reads and plain-tooltip findings. Removed the unreachable skill-path action after verifying the missing field. Documented the explicit user-requested inventory boundary amendment and the unchanged ADR-0009 Webview/control-channel scope. Retained the required `parseStateData` descriptor extension and strict bounded validation as an accepted deliberate choice. Installed proof is recorded separately.

## Implementation and Installed Evidence

The repaired frozen private source snapshot passed typecheck and all 108 targeted parser, session, runtime, projection and tree tests. The first attempt found two Node strip-only constructor parameter-property failures; replacing them with ordinary field declarations fixed module loading. Two in-flight sibling type errors were repaired by their owner before the passing snapshot. Build, Windows x64 VSIX packaging and exact isolated installation succeeded. The artifact SHA-256 was `7f8600bc2a2085afa9306cea4dd1ca356049622871a55fa51d4f9885491794b6`.

An installed isolated window started a real Chat without a provider prompt. Thirteen locally retained screenshots and host/CDP observations showed Tools beside Sessions and Processes, reported skill commands and tool rows, both description tooltips, the Refresh title action, selection switching between Chat and Terminal editors, and stopped Chat replacing its stale inventory with an empty-state message. Three screenshots were additionally image-inspected by the package owner. Native all/active metadata was unavailable for the fileless proof sessions, so rows honestly showed Activation unknown; inactive marking is covered by focused tests, not claimed as exercised live. OMP exports no skill paths, so no Open SKILL.md action was invented.

Both owned session hosts stopped through authenticated extension controls, their brokers acknowledged shutdown, Processes reached zero rows, and the isolated window closed. The debugging port and owned roots were gone and no profile-bound or broker processes remained. The extension reported its existing uncontained-tree uncertainty; process scans found no leftovers but did not prove containment. The private source snapshot, isolated installation/profile and screenshots remain as acceptance evidence; no process is intentionally left running. Temporary proof scripts were removed. Main-profile installation, full-suite execution and the later combined artifact remain outside this isolated package proof.
