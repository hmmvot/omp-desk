---
status: accepted
date: 2026-09-24
---

# ADR-0003: Control the Native OMP Host through Its Own Authenticated Pipe

> Amended by [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): the pipe's model/thinking mutation, model list and request-id ledger are replaced by rpc commands and deleted; the pipe stays for the config-layer snapshot, the names-only tool catalogue and the file-observation hooks.

> Narrowly amended by [ADR-0051](0051-rewind-chat-in-place-through-a-desk-registered-omp-command.md): the `-e` host-control module also registers one RPC-only internal extension command, `omp-desk-navigate`, which rewinds a Chat conversation in place. The command depends only on the module loading with a non-absent bootstrap, not on the pipe or its key, and its input travels over RPC stdin. The pipe itself stays read-only.

> Narrowly amended by [ADR-0053](0053-merge-a-desk-published-registry-liveness-signal-into-the-agents-row.md): in an RPC child, the `-e` host-control module also publishes a bounded subagent liveness signal through its main session's own `ctx.ui.setStatus`, on RPC stdout. It reads `AgentRegistry.global()` and the subagent bindings' run events. It needs neither the pipe nor its key, and the pipe itself stays read-only.

## Context and Problem Statement

[ADR-0002](0002-local-collab-gui-native-omp.md) uses an OMP Collab guest for conversation, approvals and Hub, but writable guests cannot change the host's model or thinking level. The native OMP process can outlive VS Code's extension host on a window reload. A control listener owned by the latter would disappear, while adding privileged commands to the encrypted Collab relay would mix transport and authorization responsibilities.

OMP's extension API has `setModel`, `getThinkingLevel`, `setThinkingLevel` and a live `ctx.model` (`packages/coding-agent/src/extensibility/extensions/types.ts:1457-1464`; `packages/coding-agent/src/extensibility/extensions/runner.ts:1195-1201` in the OMP checkout). OMP's own Collab registry already uses an authenticated named pipe on Windows (`packages/coding-agent/src/collab/registry.ts:279-335,446-482`), providing an IPC pattern, **not** an authenticated-host-identity protocol. Windows inherited ACLs must not be treated as proof that a runtime directory is private.

## Considered Options

- **OMP extension owns a named-pipe server (chosen):** listener stays with the native host; a reactivated VS Code extension can reconnect and authenticate.
- **VS Code extension host owns a server:** simplest while active, but its listener dies on reload and the surviving OMP process cannot identify a fresh endpoint safely without another rendezvous.
- **Use the Collab relay for privileged commands:** would widen a ciphertext router's authority and the guest protocol beyond its host-enforced command allowlist.
- **Inject native terminal keystrokes:** not a structured control API and races user input or pending dialogs.

## Decision Outcome

Load a narrow OMP `-e` extension into each native TUI process. It serves a randomly named Windows pipe for that process lifetime, accepting bounded/versioned JSON requests. A fresh 256-bit key authenticates both ends. Publish only the pipe name and non-secret process/session-generation metadata atomically after the listener starts; treat the rendezvous as tamperable. Keep the key across extension-host reload in VS Code SecretStorage under an opaque owner nonce; delete it after confirmed native host termination. The key is **not** a Collab link.

The original conditional proposal to carry the key in the terminal's environment is **rejected** by [ADR-0005](0005-preload-control-key-before-omp-startup.md): other extensions can read terminal creation options, and OMP may start children before `-e` loads. [ADR-0006](0006-host-generated-key-peer-verified-pipe.md) supersedes only that bootstrap condition: the host generates its own key, encrypts it to a launch-pinned public recipient and the client verifies the actual named-pipe server PID on the same HMAC connection. Host controls remain unavailable until that design's implementation and runtime gates pass. Never place the plaintext key in argv, terminal environment/input, logs, session index or Webview messages. OMP core changes remain unauthorized.

Authenticate the **server** before disclosing any reusable credential: client sends fresh nonce C; server responds with fresh nonce S and HMAC(key, domain=`host`, C, S, pipe name, process instance, epoch). Verify against the expected metadata before accepting a snapshot. Client then authenticates each request using a separate domain-bound HMAC over C, S, request ID, method and payload digest, never the plaintext key. Replay/nonce reuse is rejected. A replaced rendezvous endpoint without the legitimate key can cause a visible refusal/DoS but cannot impersonate the host; ADR-0006 additionally requires same-connection kernel PID and process-generation verification. The original stronger assumption that arbitrary same-user code could not extract a persisted secret was infeasible with Windows SecretStorage. The user explicitly selected trusting arbitrary code running as the same Windows user for credential confidentiality; public API leaks, fake endpoints without the key, replay, and ownership violations remain in scope.

Allow only `snapshot`, `listModels`, `setModel`, `setThinking`, and `result(requestId)`; no eval, shell, arbitrary settings write or approval response. Reserve each mutation ID+payload digest before dispatch in the live native host. A repeated ID with identical payload returns pending or its recorded terminal outcome **without executing again**; a different payload is a conflict. The result query survives extension-host reload while that OMP process lives. If native outcome is lost, report unknown/reconcile instead of blindly replaying a mutation. Each mutation includes expected process instance, canonical session identity, session epoch and state revision, checked again immediately before commit. Serialize mutations; count native TUI changes in the same revision, and return the actual new model/thinking/revision on success. A native session switch, resume, branch or transition invalidates the old epoch even when the user later returns to the same session ID.

The original design required exclusion between async model changes and native session transitions. OMP 18.2.11 does not expose the needed public settlement signal, and the user explicitly chose not to change OMP. [ADR-0004](0004-best-effort-host-model-transitions.md) supersedes **only** this cross-transition exclusion condition: model/thinking controls must work with the accepted race and actual host readback. Do not claim atomicity across a native `/resume` or similar transition. Pipe authentication, mutation idempotence, generation checks before dispatch and single-writer session ownership remain mandatory.

### Consequences

- Positive: host-only controls survive GUI/Webview reload without putting privileged commands on the Collab guest wire.
- Positive: runtime credential and Collab link remain separate; a stale client cannot mutate another host/session.
- Negative: one small additional local IPC surface, Windows pipe lifecycle and SecretStorage cleanup must be maintained and tested.

## Feasibility Gate

Start the native OMP host, change model/thinking through the authenticated pipe, and read back actual host values. Reload the extension host and reconnect without restarting OMP. Test a fake pipe substituted into rendezvous and a replayed handshake; the key must not be disclosed. Prove bootstrap key absent in child shell/MCP/subagent environments and terminal revival/session metadata, as well as argv/logs/Webview traffic. Verify commit→lost reply→reconnect→result query, concurrent duplicate ID and conflicting payload without a second mutation. Reject obsolete epoch/process and native-TUI revision **before dispatch**. Exercise a simultaneous native session transition and report the actual host value or an explicit uncertain result, as ADR-0004 permits; never imply atomic cross-transition safety.

## Related Documents

- [ADR-0002](0002-local-collab-gui-native-omp.md)
- [ADR-0004](0004-best-effort-host-model-transitions.md) — supersedes only the native session-transition exclusion clause.
- [ADR-0005](0005-preload-control-key-before-omp-startup.md) — rejects the environment/bootstrap input routes.
- [ADR-0006](0006-host-generated-key-peer-verified-pipe.md) — supersedes the bootstrap and original same-user credential-isolation assumption, preserving HMAC and owner checks.
- [Development design](../designs/2026-09-24-omp-vscode-development.md)

## Architecture Review

- Reviewer: architect
- Outcome: reviewed and accepted as the pipe/security design; the later user-approved cross-transition race is recorded separately in ADR-0004.
- Notes: The architect required environment-secret consumption and terminal revival proof, mutual authentication before credential disclosure and exact-once outcome queries. These remain hard gates. A true transition-settlement API would require a forbidden OMP core change, so ADR-0004 accepts that specific race without weakening the other gates.
