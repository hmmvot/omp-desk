---
status: rejected
date: 2026-09-25
---

# Recover open OMP chats after extension-host-only restarts

## Problem

The user develops this extension inside one of its own OMP chat editors. VS Code's **Restart Extensions** replaces the extension host without reviving already-resolved `WebviewPanel` inputs. The old Webview may continue talking directly to native OMP through Collab, but the new extension host has no panel reference: Sessions has no open row and model/thinking/Tools cannot communicate. **Reload Window** does invoke the existing serializer, but the user requires both restart actions to continue the same conversation without manually reopening it. The user accepts an automatically created replacement editor and wants the existing native OMP process reattached, not stopped and relaunched.

VS Code 1.139.1's pinned `MainThreadWebviewPanels` starts with an empty handle store after host replacement; registering a serializer revives only unresolved inputs. The [Webview lifecycle contract](https://code.visualstudio.com/api/extension-guides/webview#lifecycle) says a lost panel reference cannot be regained. The public `TabInputWebview` exposes only `viewType`, not the panel or its saved webview state. All current OMP chat tabs have the same `omp.session` type, so the new host cannot safely assign multiple visible orphan editors to indexed sessions.

## Goals and Non-goals

- Automatically recover each **actually open** OMP chat after Restart Extensions with its exact indexed conversation, prior transcript, a usable new GUI, model/thinking and read-only Tools after verified ownership; no user-side Open/Resume step. Keep native PID/room/session and claims when verified. Never create a second OMP writer merely to repair a panel.
- Preserve the existing serializer path for Reload Window, including lazy saved editors and explicitly closed tabs. Only VS Code's currently open tabs, not all indexed rows or historical files, authorize editor replacement. Preserve editor group and current non-OMP focus where the API permits; exact position, pinned/preview state and unsent composer input are not guaranteed for a replaced editor.
- Fail closed on missing/stale identity, unverified claim/host, unrecognized VS Code tab type, ambiguous legacy generic tabs or a failed tab close. A replacement may show an honest blocked state; it cannot imply that a native host was recovered.
- Do not change native OMP process lifecycle, claim protocol, serialized Webview contents beyond identity, user permissions, Collab write-capability storage, or the folder-scoped launcher. Do not reach into undocumented VS Code RPC/Workbench APIs.

## Current State

`src/extension.ts` registers one serializer for `omp.session`, creates all chat panels with that view type, and records `{version:1,tabId}` in Webview state. It projects Sessions from indexed entries with an actually bound panel and a registered folder. Activation safely reattaches verified fileless drafts as well as materialized sessions (ADR-0021), but only the serializer can give a new host a `WebviewPanel`. After Restart Extensions the old resolved panel is still a VS Code tab yet cannot be re-bound. The public `window.tabGroups.all` exposes each open tab's group and `TabInputWebview.viewType`, and `tabGroups.close(tab, preserveFocus)` can close a captured old tab. A new `createWebviewPanel` is a distinct editor; it does not inherit unsent guest input.

## Proposed Design

Give each newly created chat a versioned, session-specific `WebviewPanel.viewType` derived from its already minted `tab:<uuid>` index ID. No link, file path, token or claim is encoded there: the ID is an **untrusted lookup hint** validated against the current workspace's `SessionIndex`. Persist the same identity-only Webview state. Register the exact per-tab serializer synchronously during activation for known indexed IDs and before creating any new panel. Keep startup activation independent of a dynamic `onWebviewPanel:<id>` event; dynamically keyed saved editors can wait for the registered resolver. Keep the current generic serializer temporarily only to migrate existing panels via their saved identity during a Reload Window. A stale/malformed panel receives an explanation, never an unrelated session or host.

At activation, inspect the **live** `window.tabGroups.all` membership. For an indexed versioned OMP tab whose current activation has not yet adopted its panel, create a replacement editor in the tab's group with `preserveFocus`, then close that exact captured old tab using `tabGroups.close(oldTab,true)`. A successful close, validated against current membership, permits activation of the replacement; a failed close leaves the old tab in place and retires the inactive replacement, with a visible recovery explanation instead of two enabled writers. Do not rely on a time limit to prove an unbound panel is orphaned: a hidden saved editor may deserialize late. The same replacement policy can handle such an unbound saved editor, while a serializer that already bound a valid panel wins and needs no replacement. Ordering and callbacks for each tab must be serialized; concurrent serializer, explicit focus/Open, user close and recovery settle on at most one bound panel and one native restore/attach. Do not close a tab whose type/ID is no longer the one captured, and do not re-create one the user just closed. A replacement is a UI operation only; `startStartupRestore` remains the sole native activation pass, and replacement waits for/replays its result.

**View type mapping gate.** In the installed VS Code 1.139.1 source, `TabInputWebview.viewType` exposes an internal `mainThreadWebview-` prefix in front of the external panel type despite the public description. The type parser must accept only a validated namespaced/versioned OMP identity and an existing index ID, with no label or positional matching; no code may register a serializer using the internal prefix. Before shipping, an isolated real VS Code run must prove enumeration/recognition of a newly created panel and safe targeted close/replacement. If the current editor's mapping cannot be established, leave the tab untouched and report that Reload Window is required, rather than guessing. This is a compatibility gate, not a second hidden session registry.

A legacy `omp.session` tab cannot be assigned to a session from `TabInputWebview` after it is already orphaned. During the first **Reload Window after upgrade**, its current serializer gets the saved `{tabId}` and replaces that generic panel with a versioned one in the same group, without native stop/launch. This one-time window reload is a documented migration, not a manual Open. An already-orphaned generic panel receives clear Reload Window guidance; it must not be paired by title, index order or current active session. Keep the legacy serializer only for this migration while old saved panels may exist; retire it once a future migration decision has evidence no old panels remain.

The restart path must retain the controls' existing exact-file and authenticated-host checks. If a draft has no file, Controls say they are waiting for materialization and the existing post-promotion invalidation requests a fresh snapshot. The new panel never receives Collab links or control keys from saved state or tab identity; the extension's verified runtime generates and delivers its current scoped link.

## Alternatives

- Reload Window only: already uses supported serializer revival, but the user explicitly requires Restart Extensions too.
- Restore the **same** resolved panel: impossible through the public Webview API after its owner host disappears; repeated `omp:ready` or serializer registration cannot revive it.
- Persist an extension-owned open-tab list and recreate every listed index row: duplicates VS Code's editor lifecycle, can reopen deliberately closed tabs, and lacks group membership. Live `TabGroups` is the necessary editor-membership authority.
- Use a resource-backed `CustomReadonlyEditorProvider`: its URI would give a public per-tab ID, but it rewrites the editor model/provider integration and still requires closing/reopening an already-resolved orphan; not a direct restart remedy.
- Guest-to-host loopback control bridge: could keep the chat's direct Collab stream alive but cannot return a lost `WebviewPanel` reference or editor membership. It expands capability/security boundaries without solving this UI requirement.

## Risks and Open Questions

- Dynamic serializer activation depends on normal startup/onView activation; saved hidden panels may wait until activation. Confirm in an installed target, including first load and Reload Window. Never infer orphanhood solely from elapsed time.
- The public `TabInputWebview.viewType` surface and the installed implementation disagree on a prefix; verify actual tab enumeration and avoid closing unrelated tabs when the mapping differs. Exact editor order/stickiness cannot be restored by public creation APIs.
- A callback for a saved panel may race replacement, and a close can race both. Explicit panel identity and per-tab recovery serialization must protect the user's close and the single native restore.
- First upgrade of legacy generic panels requires one Reload Window. An existing orphan from a host-only restart cannot be unambiguously migrated from tab metadata alone.
- An extension update may leave a native process with an older staged host-control module; the chosen behavior reattaches that process and does not promise updated native preload code until the host is stopped separately.

## Rollout and Verification

First prove dynamic type → public `TabInputWebview` mapping, serializer registration on full window reload and targeted tab close in an isolated VS Code 1.139.1 profile, without touching the user's normal window. Add behavioral tests for recognized/open and closed tabs, two concurrent OMP tabs, no other extension tab closed, lazy serializer vs replacement, user close mid-recovery, invalid/legacy identity and failed close; tests must assert editor membership and one native operation rather than mock-message echo. Implement migration and replacement, keeping the validated native attach path. Then install the actual VSIX into isolated VS Code and exercise two folder-scoped chats and an explicitly closed third, an ordinary selected text editor, Reload Window and **Restart Extensions**, including repeated restarts. Observe the same native PID/session/file or safe fileless identity, full prior transcript, a new GUI turn, one tree row per genuinely open session, and model/thinking/Tools recovery after verified promotion. Run typecheck, full tests, build and VSIX packaging against the final baseline, update current docs, then install that VSIX into the ordinary VS Code profile via CLI without controlling the user's window. Do not claim the built-in restart path complete on compilation alone.

## Related Decisions

[ADR-0019](../decisions/0019-vscode-owns-omp-editor-persistence.md) (existing editor authority, to be superseded in the host-only restart case by [ADR-0022](../decisions/0022-replace-orphaned-webview-editors-after-host-restart.md)), [ADR-0021](../decisions/0021-reattach-a-verified-live-draft-on-activation.md) (native attach; no editor-replacement behavior), [ADR-0015](../decisions/0015-serialize-tab-lifecycle-through-one-gate.md) (single-writer lifecycle).

## Architecture Review

- Reviewer: independent read-only architecture reviewer.
- Outcome: **REVISE** — five material gaps in lazy-editor precedence, user-close ordering, legacy migration, stale serializer registration and type/state identity equality.
- Notes: This proposed replacement design was not accepted or implemented. The later [authenticated live-page reconnection design](2026-09-25-reconnect-live-webviews-after-host-restart.md) evaluates a surviving page's independent host channel; the assumption in this document that such a bridge cannot restore controls/tree is false, although it still cannot recreate the lost `WebviewPanel` handle.
