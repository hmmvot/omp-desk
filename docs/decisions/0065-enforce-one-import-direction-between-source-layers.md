---
status: accepted
date: 2026-10-12
---

# ADR-0065: Enforce one import direction between the source layers with a checked script

## Context and Problem Statement

OMP Desk's source runs in four places: the extension host (`src/extension.ts`, `src/host/`, `src/views/`), the detached broker (`src/broker/`), the OMP process (`src/omp/`) and the webview pages (`src/webview/`), with `src/chat/` shared by host and page. Nothing states which directory may import which. As of 2026-10-12 the host and broker import page modules at runtime in eleven places (for example `src/broker/pty-screen.ts:53`, `src/host/rpc/session.ts:85`, `src/host/chat-runtime.ts:34`) and the page imports host modules in seven (`src/webview/lib/chat-client.ts`, `src/webview/lib/activity.ts`, `src/webview/desk-settings/page-state.ts` and others). Every such module is pure today, so the bundles work, but a DOM reference added to `src/webview/lib/*` would break the host at runtime and no check would say so before a user did; a reader cannot tell a wire contract from a page helper by its path; and five import cycles are closed through `import type`.

A rule is only worth stating if it is checked where the build already fails: `npm run typecheck`, which CI and the release checklist run.

## Considered Options

- **A dependency linter** (dependency-cruiser, eslint with `eslint-plugin-import`): mature rule languages and cycle detection; a new devDependency and configuration dialect for one rule, and an `npm run lint` step the repository does not have.
- **A short script in `scripts/`** (Node, no dependency): walks `src/`, reads static import specifiers, maps files to layers by their first path segment, checks an allow-list matrix and finds cycles by depth-first search; about a hundred lines with its own test; runs in `typecheck`. Only static ESM specifiers are seen (the repository has no dynamic cross-layer imports outside tests).
- **TypeScript project references** (one `tsconfig` per layer with `references`): the compiler itself enforces direction; but the repository builds with esbuild from one root, the layers are directories not packages, and references change `tsc` output and incremental behaviour for every contributor.
- **Convention only** (document the layers, no check): no cost; the current state shows how long a convention holds without a check.

## Decision Outcome

Proposed: the script. The layers and the rule it enforces:

| Layer | May import |
| --- | --- |
| `src/shared/` | nothing else in `src/` |
| `src/chat/` | `shared` |
| `src/protocol/` | `chat`, `shared` |
| `src/host/`, `src/broker/`, `src/omp/` | `protocol`, `chat`, `shared`, and each other |
| `src/views/` | `host`, `protocol`, `chat`, `shared` |
| `src/webview/` | `protocol`, `chat`, `shared` |
| `src/wiring/` | `host`, `views`, `protocol`, `chat`, `shared` |
| `src/extension.ts` | every layer except `webview`; the only non-test file directly under `src/`, with `src/extension-harness.ts` (a test-only entry, see the 2026-10-30 amendment) as the one other file allowed there (any other non-test root module is a violation and belongs to a layer) |

A module may always import its own layer. `import type` counts as an import: a type-only edge is a dependency of the reader and the cycle it closes is real. Any import cycle fails the check, inside a layer too. Test files (`*.test.ts`, `*.test.tsx`), the test stubs and `test/**` are exempt from the layer rule (a host test may use a page parser as a fixture) but not from the cycle rule. The script fails with one line per violation naming both files and the rule broken, and `npm run typecheck` runs it after `tsc`.

Amended 2026-10-12, after the implementation review: the table first let `src/extension.ts` import everything, which left the host bundle's own entry able to import page code and contradicted the first consequence below; three page modules it imported (`prompt-history.ts`, `rewind-mode.ts`, `terminal-theme.ts`) moved to `src/chat/` and `src/shared/`, and the row now excludes `webview`.

Amended 2026-10-30: `src/extension-harness.ts` is the second non-test file allowed directly under `src/`. It is a test-only entry: `src/extension-lifecycle.test.ts` bundles it in place of `extension.ts` to reach the private functions of the entry (it replaces a string of access code that the test used to append to `extension.ts`'s source). It imports `extension.ts`, which no layer file may, so `scripts/check-imports.mjs` treats it as a test file for the layer rule (the cycle rule still applies) and adds one rule: no non-test file may import it, so no production module comes to depend on it directly. Any other non-test file directly under `src/` stays a violation.

Reasons: the check lives where the build already fails and costs nothing to run; the rule is small enough to read in the script; moving a module to the lowest layer both sides may see is the one remedy for every violation, so the fix is never a configuration exception.

### Consequences

- Positive: a page dependency can no longer enter the host or broker bundle unnoticed; a module's path says what may use it; contracts have one home (`src/protocol/`); cycles cannot return.
- Negative: a helper two layers need must move to `src/shared/`, `src/chat/` or `src/protocol/` even when it is one function; the first application moves about twenty modules and rewrites their import paths; a new layer needs a row in the matrix and a sentence in `docs/architecture.md`.

## Related Documents

- [Design: extension host module structure](../designs/2026-10-12-extension-host-module-structure.md), §1 (the layers), which this record decides.
- [ADR-0038](0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md): the shared chat reducer that `src/chat/` holds for both sides.

## Architecture Review

- Reviewer: architect (independent, read-only, 2026-10-12; a separate agent that did not write the record)
- Outcome: accepted with one change, applied
- Notes: the record and the design's tables were found consistent and the options fairly stated; the one material finding was the missing policy for modules directly under `src/` (`guards.ts`, `runtime-assets.ts`, `bridge-protocol.ts`, `bridge-fragments.ts`, `bridge-identity.ts`), which the table now covers: only `extension.ts` may live there.

### Amendment 2026-10-30 (test entry)

- Reviewer: reviewer (independent, read-only, 2026-10-30; a separate agent that did not write the amendment)
- Outcome: accepted with three minor changes, all applied: the layer-table row names the harness, the wording says "non-test" file, and the containment claim says "directly" because the rule checks direct edges only
- Notes: no functional finding; the checker matched the amendment, and the harness is in neither the extension bundle nor the VSIX (`esbuild.mjs` names only `src/extension.ts`, `.vscodeignore` excludes `src/**`)
