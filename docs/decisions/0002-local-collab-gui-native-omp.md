---
status: superseded
date: 2026-09-24
---

# ADR-0002: Use a Local Collab Guest for the Native OMP GUI

> Superseded by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md) (2026-09-29, accepted): the Collab guest, its relay and the room/link transport are removed in favour of `omp --mode rpc-ui` on a broker pipe child. The rationale below (native same-process, dialogs and security reasoning, local-only relay) is preserved as history; the earlier narrow supersession by ADR-0024 for hidden-terminal ownership also stands as history.

## Context and Problem Statement

[ADR-0001](0001-native-omp-terminal-gui-bridge.md) chose one native interactive OMP process in a hidden VS Code terminal, with a GUI connected to that live process. It assumed a new in-process OMP extension would provide the main GUI channel. OMP 18.2.11 already has a closer match: a full-control Collab guest receives the host's live transcript and events, can prompt and interrupt, can answer native `select`/`editor` dialogs (including the approval and `ask` paths), and can use host Agent Hub actions. OMP also ships a browser guest, `packages/collab-web` (OMP checkout: `docs/collab.md:124-145,172-184`).

Collab ordinarily connects through `wss://my.omp.sh`. The user chose a **local** Collab route for the MVP; the session must not depend on or silently publish its control capability to an external relay. OMP's source includes a local WebSocket relay for development, but its documentation explicitly does not present it as a production distribution (`docs/collab.md:148-163`).

## Considered Options

- **Local Collab guest (chosen):** reuse OMP's existing transcript, native dialog, and Hub contracts; package a loopback-only relay and connect an in-editor GUI to the host's control room. Requires a supported, hardened local relay and Webview compatibility work.
- **Hosted Collab guest:** fastest route to an existing web client, with encrypted payloads, but depends on an external relay and gives a bearer control link to the GUI.
- **Custom in-process GUI transport from ADR-0001:** avoids a relay, but would need to implement native dialog routing and Hub control that Collab already provides. Observing approval events alone cannot resolve the TUI-owned approval prompt.

## Decision Outcome

Continue to run **native interactive OMP in the hidden VS Code terminal**, revealing that same terminal/process on demand. For the ordinary GUI conversation, start a full-control Collab room on that host and connect the VS Code GUI as a guest through an extension-managed relay restricted to loopback. Reuse the existing Collab guest protocol and client behavior rather than inventing a second transcript or sending keystrokes to the terminal. The host remains the sole executor and writer of its session; a browser guest is not another OMP agent process.

The GUI's control link is a bearer secret. Obtain it only for the intended host/room generation, do not persist it as a session identifier or put it in logs, and bind its use to the extension-owned GUI. The relay must explicitly bind to loopback, isolate rooms, and be packaged/managed as a product component; the source-available development relay is not assumed production-ready. A lost guest connection cannot authorize a pending request; OMP's host remains authoritative for dialog settlement. Reconcile host ownership before starting another process for a saved session.

Carry forward ADR-0001's approval invariant: only an explicit answer to the currently pending request may authorize execution; stale, duplicate, cancelled, or disconnected GUI answers must not. Collab room generation and request identity fence guest responses. The separate host-control channel must also authenticate its peer and bind commands to the intended OMP process and active session generation; a stale GUI cannot control a replacement session.

Collab guests cannot perform host-only operations such as changing the model, resuming/branching, or editing host settings (`docs/collab.md:124-138`). The MVP assumes an installed, already authenticated OMP. It offers host-session model and thinking controls through a narrow, separately authenticated OMP extension channel, plus credential-redacted, read-only configuration values for the matching profile, working directory, and overlays. The design must establish which values actually apply to the host; guest-local `/settings` is not host settings. A full, scope-aware generic settings editor and GUI onboarding are outside the first MVP.

### Consequences

- Positive: reuse already implemented live chat, approvals/`ask` routing, and Hub guest controls while keeping the original native TUI and process.
- Positive: GUI and terminal share one authoritative session without screen scraping, second writers, or approval shortcuts.
- Negative: the relay and browser guest introduce packaging, local network, Webview security, and reconnection work; the bundled development relay cannot be shipped without review and hardening.
- Negative: Collab does not cover every native input method or host-only command; the GUI needs a defined fallback or separate host control for unsupported requests, without claiming full parity.

## Feasibility Gate

Before full GUI implementation, run a local-only end-to-end experiment: hidden native OMP host; explicitly loopback-bound relay; GUI guest in VS Code; prompt, streaming response, `ask` and tool approval resolved in the GUI; Hub observation and one safe action; reveal and use the same native TUI during an active turn and a pending dialog. Verify single settlement, rejection of stale/duplicate/cancelled responses, room-generation changes, no second session writer, and no external relay connection. Prove model and thinking changes reach the host, read back host configuration values without exposing credentials, and reject host-control commands for an obsolete process/session. If Webview or relay integration fails, revisit this decision openly instead of silently substituting the hosted relay or an emulated TUI.

## Related Documents

- Supersedes [ADR-0001](0001-native-omp-terminal-gui-bridge.md). Its native-terminal/same-process requirement remains; this record replaces its custom primary GUI bridge.
- [ADR-0024](0024-own-omp-pty-for-in-tab-terminal.md) supersedes **only** hidden VS Code terminal ownership for newly launched managed hosts. This record's local Collab guest, native same-process writer, authoritative dialogs, protected link, approval and host-control boundaries remain in force; existing hidden terminals are not silently migrated.
- [Product context](../product.md)

## Architecture Review

- Reviewer: architect
- Outcome: reviewed; accepted after addressing material scope and request-lifetime findings without changing the decision.
- Notes: The review required the agreed pre-authorized/basic-settings scope and retention of ADR-0001's stale-response and host-control generation invariants. The local relay, Webview, and host-control paths remain subject to the feasibility gate; acceptance is not implementation evidence.
