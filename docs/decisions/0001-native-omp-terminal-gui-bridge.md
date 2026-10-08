---
status: superseded
date: 2026-09-24
---

# ADR-0001: Run Native OMP in a Hidden VS Code Terminal with a GUI Bridge

## Context and Problem Statement

The extension must offer a GUI for ordinary OMP use while allowing the user to open VS Code's integrated terminal and continue in the **native OMP TUI, in the same live process**. A terminal-like view implemented by the extension is not equivalent to running `omp` in a terminal. Restoring the same session file in another process preserves history but is not a live-process switch.

In OMP 18.2.11, interactive and `rpc-ui` are distinct startup modes (`packages/coding-agent/src/main.ts:2309-2314` in the OMP checkout). The interactive extension API exposes message/tool events and `sendUserMessage` (`packages/coding-agent/src/extensibility/extensions/types.ts:1263-1287,1418-1437`), but native tool approvals currently use the TUI-owned UI context (`packages/coding-agent/src/extensibility/extensions/wrapper.ts:325-339`). All OMP source paths here are relative to its checkout, not this extension repository. These APIs establish a possible bridge, not proven GUI parity.

VS Code can start a normal integrated terminal with `TerminalOptions.hideFromUser` and reveal it later with `Terminal.show()` ([VS Code API](https://code.visualstudio.com/api/references/vscode-api#TerminalOptions)). A hidden terminal is not automatically restored when the workspace reopens.

## Considered Options

- **Native OMP TUI from startup, hidden integrated terminal, in-process GUI bridge (chosen):** preserves the actual TUI and live process; requires a separate structured GUI channel and routing of interactive requests.
- **`omp --mode rpc-ui` with an extension-owned pseudo-terminal:** enables a GUI and a textual terminal view of one process, but the terminal view is not OMP's native TUI.
- **GUI RPC process followed by `omp --resume` in a normal terminal:** provides the native TUI and saved conversation, but replaces the live process and cannot preserve an in-flight turn as a continuous process.

## Decision Outcome

The extension starts an ordinary interactive OMP process in a VS Code integrated terminal at session creation and initially keeps that terminal hidden. The GUI is the initial visible surface. On request, the extension reveals **that same terminal and process**; it does not launch another OMP instance or turn RPC output into a TUI.

An OMP extension loaded into that interactive process will provide a separate, structured communication channel for GUI observation and actions. The GUI must not screen-scrape terminal output, inject keystrokes as its control protocol, or open another process writing concurrently to the same session file. The bridge transport and detailed GUI protocol are not selected by this ADR.

The bridge must restrict its controlling peer and bind actions to the intended process and session. Native interactive requests retain one authoritative lifecycle across both surfaces: only an explicit response to the current pending request may resolve it; duplicate, stale, or cancelled responses cannot authorize execution, and disconnection must not imply approval. A reviewed design must specify request ownership, cancellation, and recovery without weakening OMP approval semantics.

This decision applies to switching surfaces while VS Code and the OMP process remain alive. After a full VS Code restart, recovery may need to open the persisted session in a **new** native OMP process; restored history must not be presented as continuation of the old live process. Before starting any replacement writer, reconcile whether an OMP terminal/process survived a window reload or was restored or relaunched by VS Code.

### Consequences

- Positive: terminal users see the unmodified OMP TUI, and switching to it does not interrupt a live turn.
- Positive: the GUI and terminal can address one in-memory session instead of coordinating two file-backed writers.
- Negative: OMP's existing `rpc-ui` transport cannot directly serve as the GUI backend for this interactive process; an in-process bridge and extension-side lifecycle management are required.
- Negative: GUI control is incomplete until native UI requests, especially `ask` and tool approvals, can be presented and resolved while the terminal is hidden. Native approval semantics must remain fail-closed throughout a surface switch.
- Negative: hidden VS Code terminals are not restored automatically; process ownership and session-file restoration require explicit reconciliation across reload and restart.

## Feasibility Gate

Before committing to the full GUI implementation, demonstrate one native OMP process started in a hidden terminal, a prompt sent through the bridge, streaming updates shown in the GUI, and an `ask` and a tool approval resolved in the GUI without revealing the terminal. Then reveal and interact with the native TUI **while a turn is streaming**, verifying the same process and uninterrupted turn. Also reveal it while an `ask` or approval is pending; verify one authoritative resolution and reject a late duplicate or cancelled GUI answer. If OMP's current extension API cannot safely redirect a native UI request, identify the necessary OMP change in a design document rather than claim this ADR already supplies that capability.

## Related Documents

- [Product context](../product.md)
- [Current architecture](../architecture.md) — implementation status only; this ADR records intended architecture.
- Superseded by [ADR-0002](0002-local-collab-gui-native-omp.md), which retains the hidden native OMP process but uses a local Collab guest for the primary GUI channel.

## Architecture Review

- Reviewer: architect
- Outcome: reviewed; accepted after addressing two material findings without changing the decision.
- Notes: The review identified a missing bridge trust/request-lifetime invariant and an insufficient live-switch feasibility gate; both are now explicit above. Acceptance records the architectural direction, not demonstrated bridge feasibility or implemented behavior.
