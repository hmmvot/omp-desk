---
status: rejected
date: 2026-09-24
---

# ADR-0005: Reject Secret Bootstrap via Terminal Environment or Plaintext Input

## Context and Problem Statement

[ADR-0003](0003-native-host-control-pipe.md) conditionally proposed a per-host secret in the environment of a transient native OMP terminal. OMP 18.2.11 loads `-e` extensions after settings/auth discovery, which may start child processes. A Bun-installed `omp.exe` shim spawns a different PID from the terminal's process. Native process identity and key confidentiality must hold without OMP core modifications.

## Considered Options

- **Leave the key in `TerminalOptions.env` until `-e` or a Bun wrapper clears it:** rejected. Other extensions can enumerate hidden terminals and read `Terminal.creationOptions.env` (`@types/vscode/index.d.ts:7681-7694,12505-12517`). Bun-side deletion cannot erase the VS Code options object or a child environment copied before `-e` loads.
- **Launch a Bun wrapper that imports and calls `runCli`:** rejected as an equivalent native OMP entrypoint. The published CLI gates its worker-host registration and lifecycle on `import.meta.main`/`Bun.main` (`pi-coding-agent/src/cli.ts:61,511-519,597-615`). A wrapper changes those properties. A throwaway wrapper probe verified only process identity and module-cache reuse, not full native worker behavior.
- **Use `bun --preload` and send the plaintext key once via raw/no-echo `Terminal.sendText`:** rejected. A real OMP 18.2.11/Bun 1.4.0 throwaway probe confirmed `Bun.main` remains the installed CLI and `-e` reused the preloaded module's lexical canary in the same PID. It also showed that terminal-control bytes may precede the frame and a raw PTY did not echo the canary. **None of that proves VS Code secrecy**: upstream VS Code `terminalInstance.ts` logs the `sendText` argument at debug level *before* the PTY write. A co-resident extension can inject its own key into the hidden terminal; a first-valid-frame policy can advance OMP and leave the later real key to echo as ordinary TUI input. A tamperable ready marker and matching PID do not prove raw mode is actually active. A clean captured stdout is insufficient.
- **Pass a key in argv, plaintext file, Webview message or Collab URL:** rejected because those surfaces expose or persist reusable control credentials.

## Decision Outcome

**Reject both the environment and plaintext terminal-input bootstrap. Do not wire the existing host-control pipe to a real OMP process through either route.** Keep model/thinking host controls unavailable until an extension-only bootstrap authenticates the actual native process without exposing the key to other extensions, logs, argv, inherited children or tamperable rendezvous. A possible investigation is for the native Bun CLI to generate its own key in an extension-owned `--preload` module, encrypt it to an extension-host ephemeral public key (only the public key appears in terminal launch options), and cryptographically bind the ciphertext to the *actual* host rather than trusting a user-writable marker or substituted pipe. Peer-PID proof must cover the same pipe connection used for authentication, not a separately checked path. No implementation or security acceptance is claimed for that investigation.

This rejects only the bootstrap candidates, not [ADR-0003](0003-native-host-control-pipe.md)'s pipe authentication, exact-once mutation and owner checks, nor [ADR-0004](0004-best-effort-host-model-transitions.md)'s narrowly accepted native transition race. No OMP core changes are authorized. Direct Bun launch with the published CLI entry remains a useful independently proved native process-identity path for the **Collab guest**, without host-control secrets.

### Consequences

- Positive: a false no-echo or terminal-persistence claim cannot silently disclose a reusable credential through VS Code logs or another extension's API.
- Negative: host-only model/thinking controls remain blocked; an authenticated alternative requires process-bound key delivery and empirical verification.

## Related Documents

- [ADR-0003](0003-native-host-control-pipe.md) — its environment bootstrap remains conditional and is not satisfied by these rejected approaches.
- [ADR-0004](0004-best-effort-host-model-transitions.md).
- [Development design](../designs/2026-09-24-omp-vscode-development.md).

## Architecture Review

- Reviewer: architect
- Outcome: rejected after material security and entrypoint findings
- Notes: The independent review of the first proposed environment/wrapper approach found readable `Terminal.creationOptions.env` and non-equivalent imported CLI entry behavior. A subsequent architect assessment of the raw-stdin alternative identified public terminal `sendText` debug logging, input preemption and forged readiness; the resulting decision is rejection, not an accepted bootstrap design.
