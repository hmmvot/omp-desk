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

Amended 2026-10-30: `src/extension-harness.ts` is the second non-test file allowed directly under `src/`. It is a test-only entry: `src/extension-lifecycle.test.ts` bundles it in place of `extension.ts` to reach the private functions of the entry (it replaces a string of access code that the test used to append to `extension.ts`'s source). It imported `extension.ts`, which no layer file may (since the 2026-11-03 amendment it imports `wiring/window.ts` and nothing from `extension.ts`), so `scripts/check-imports.mjs` treats it as a test file for the layer rule (the cycle rule still applies) and adds one rule: no non-test file may import it, so no production module comes to depend on it directly. Any other non-test file directly under `src/` stays a violation.

Amended 2026-10-30 (the `wire` layer): the table above is the table before this amendment; the table now in force is below. `host`, `broker` and `omp` could import each other, which hid that the contracts between the processes lived in `src/host/` (the audit of 2026-10-21, finding A10: twelve `broker`→`host` and seventeen `omp`→`host` module edges, among them into the PTY and control wire protocols, the IPC framing, the identity proofs, the Win32 binding and the OMP settings core). A new layer `src/wire/` now holds the process-boundary contracts and the `vscode`-free primitives they rest on (30 modules and the 26 tests beside them, moved with `git mv`: `pty-protocol`, `pty-ipc`, `pty-identity`, `pty-registry`, `pty-owner-watch`, `control-protocol`, `win32-native`, `win32-security`, `foreign-access`, `call-lane`, `windows-powershell`, `atomic-file`, `local-fs`, `private-storage`, `runtime-assets`, `native-file-observation`, `native-file-observation-storage`, `file-evidence-reader`, `native-activity`, `notifications`, `native-module-failure`, `loop-gauge`, `loop-lag`, `tool-spawn-trace`, `checkout-root`, `session-folder`, `omp-settings-core`, `omp-settings-worker`, `inventory/inventory-model`, `inventory/inventory-runtime`). The set is the closure of what `broker`, `omp` and their tests imported from `host`, plus what those modules import in turn; four of them (`checkout-root`, `session-folder`, `omp-settings-worker`, `inventory/inventory-runtime`) have only test importers in `broker` and `omp`, and moved so that those tests and the modules above keep reading one layer rather than reaching back into `host`. None of them refers to `vscode`. The check forbids `broker`→`host`, `omp`→`host` and every edge from `wire` into `host`, `broker` or `omp`.

| Layer | May import (2026-10-30) |
| --- | --- |
| `src/wire/` | `protocol`, `chat`, `shared` |
| `src/host/` | `wire`, `broker`, `omp`, `protocol`, `chat`, `shared` |
| `src/broker/`, `src/omp/` | `wire`, each other, `protocol`, `chat`, `shared` (not `host`) |
| `src/views/` | `wire`, `host`, `protocol`, `chat`, `shared` |
| `src/runtime/` | `wire`, `host`, `broker`, `omp`, `protocol`, `chat`, `shared` |
| `src/wiring/` | `wire`, `host`, `views`, `runtime`, `protocol`, `chat`, `shared` |

`shared`, `chat`, `protocol`, `webview` and `extension.ts` are unchanged (`extension.ts` may import `wire`). The checker's test suite has a case that rejects a `broker`→`host` and an `omp`→`host` import and every `wire` import of a process layer. Records and designs that name `src/host/<module>` for one of the moved modules were true on their date and are not rewritten (`docs/architecture.md` and the designs' path mentions follow the move): read `src/wire/<module>` for them.

Amended 2026-11-03 (the window factory): the 2026-10-30 harness was the smallest equivalent of a `createWindow(deps)` factory, not that factory; the module-level `windowState()` singleton and about 320 private functions of `extension.ts` (11,170 lines) remained, and the harness re-exported 62 of them. Now `createWindow(deps)` in `src/wiring/window.ts` builds one window: its state (`WindowState`, `TabState` and the other shapes are `src/wiring/window-state.ts`, type-only imports), its `activate`/`deactivate`/`dispose` and every operation as one closure, and returns `{ state, activate, deactivate, dispose, ops }`. `WindowDeps` is `{ context, output?, helpers? }`. `src/extension.ts` shrinks to a 21-line entry that keeps the one instance `activate` created, because VS Code's two entry points are module-level functions that share nothing else; no other module reads it and no other module-level mutable binding of the window remains. `src/extension-harness.ts` stays the test-only entry under the 2026-10-30 rules (the layer table's row for `extension.ts` already names it); it builds a fresh window with `createWindow` per case, sets the fixture's state pieces on `window.state` and forwards 51 of the 61 `ops` through `forwarded(...)` and adapts the rest, so `extension.ts` exports nothing for tests. `dispose()` stops the window's timers and drops its runtime records, which the singleton did implicitly by being replaced. Cohesive blocks that fell out of the closure became `create…(deps)` factories in `src/wiring/` that receive the window functions they call by name: `session-diagnostics.ts`, `file-evidence.ts`, `folder-shells.ts`, `folder-commands.ts`, `session-insertions.ts`, `provider-models.ts`. The layer rule is unchanged: `window.ts` and its factories are `wiring` modules (they may import `runtime`, `host`, `views` and below), and the cycle rule holds (a factory takes the window's types from `window-state.ts`, which imports no factory). What deliberately stays ambient: the `vscode` module (the host's one API, imported by more than fifty non-test files, so an injected copy at the factory would be partial and a second route to the same object), the process-wide services `activate` sets (`setOmpResolutionLog`, `setOmpPathReader`, and `setOmpBackgroundRunner`, which are module state of their own modules by design) and the clock (`Date.now` and the timers, which the tests drive with `mock.timers`). The lifecycle test therefore still substitutes `vscode` and the native transports by import specifier in its esbuild plugin; the factory removes the shared mutable window, not the specifier substitution, and a clock or `vscode` dependency would be added when a test needs a second implementation, not before.

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

### Amendment 2026-10-30 (wire layer)

- Reviewer: reviewer (independent, read-only, 2026-10-30; a separate agent that did not write the amendment)
- Outcome: accepted with four required changes, all applied: the closure statement counts the importing tests and names the four modules that have only test importers, the architecture module lists name `src/wire/` for the moved modules, "the table above" is the table before this amendment, and the test count is 26 for 30 modules; the A10 evidence is qualified as "module edges, among them"
- Notes: the amendment's table matched `ALLOWED` row by row; the 30 modules match the renames of the move commit; no moved module imports `vscode` or, outside tests, `host`, `broker` or `omp`; no other record's body changed. The wire layer's `vscode`-freedom was verified by inspection at review and is now checked by `scripts/check-imports.mjs` (rule R-wire-1: no non-test `src/wire/` file may refer to `vscode`, with a test case)

### Amendment 2026-11-03 (the window factory)

- Reviewer: reviewer (independent, read-only, 2026-11-03; a separate agent that did not write the amendment)
- Outcome: accepted with six changes (five required, one minor set), none functional, all applied: `extension.ts` was 11,170 lines, not 11,168; the harness forwards 51 of the 61 `ops` and adapts the rest; the 2026-10-30 sentence that the harness imports `extension.ts` is marked as superseded; the quote commands live in `session-insertions.ts`; the architecture paragraph names all six factories and counts about 230 operations in the closure; about 790 unused imports that the extraction left in the six new modules and 12 in `window.ts` were deleted (a pruning step that did not remove whole-declaration diagnostics had left them, which also asserted module edges the code never used); two stale comments (`WindowState` documenting the removed module binding, `WindowDeps.context` describing a fixture that does not exist) were rewritten
- Notes: verified against the commits `817b16b` and `5d1b877`: a 21-line entry, 61 `ops`, the `WindowDeps` shape, what `dispose()` ends, no module-level window binding, no test-only export in `extension.ts`, the harness exemption and its containment, `window-state.ts` type-only (zero runtime imports, so a factory taking its types closes no cycle); no initialisation-order hazard (a factory runs no statement when built, the factories are built in dependency order before `createWindowState`, and `windowState()` is unreachable until `state` is assigned); the ambient list (`vscode`, the process-wide setters, the clock) was found honest and sufficient for a real `createWindow(deps)`
