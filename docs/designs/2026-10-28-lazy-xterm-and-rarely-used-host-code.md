---
status: accepted
date: 2026-10-28
---

# Load xterm.js and the rarely used host code only when something asks for them

## Problem

Two files are read and evaluated at every window start whether or not the window uses what is in them.

- `media/guest.js` (the Chat page) and `media/shell.js` (the folder-shell page) each carried xterm.js, its addons and its stylesheet. A page opens in chat mode and most never show the terminal, yet every page parsed about 390 KB of renderer. The audit of 2026-10-21 (P5) listed it.
- `out/extension.js` is evaluated by the extension host of every window at start (four windows in the maintainer's setup). Provider login and logout, the Models, Agents and OMP Settings editors and the Desk Settings view are reached from a command, a picker row or a restored editor, and most windows never run them (audit P6). In real window logs the bundle's evaluation took about 1 s under load, so each kilobyte counts.

Reload and VS Code start restore many windows at once; every avoidable byte parsed during that time slows the restore of the tabs.

## Goals and Non-goals

- Goals:
  - xterm.js, its addons and its stylesheet are a script of their own, `media/terminal.js`, that a Chat or shell page adds the first time one of its panes shows a terminal. A page that never shows a terminal never fetches it.
  - A terminal that cannot start (the script missing, a build mismatch, the renderer throwing) is shown as a visible message with what to do, never as an empty pane.
  - The code of provider login, the three settings editors and the Desk Settings view is a file of its own, `out/rare-subsystems.js`, read by the first command, call or restored editor that needs it. Their commands, panel serializers and the view provider are still registered at activation, as VS Code requires.
  - No change to terminal behaviour, to the document policy, to `localResourceRoots`, or to what a command does.
- Non-goals: lazy loading of `host/debug` (it is on the path of every Chat start), of the inventory and context views, of anything else in `extension.ts`; a second host build for another platform; code splitting of the page bundles beyond xterm.

## Current State

- `esbuild.mjs` builds one IIFE per document. `media/mermaid.js` is already a script the Chat page adds on the first diagram (ADR-0069): its URL comes from the folder of the page's own script, it carries the document's nonce, and a failure leaves the code block (`src/webview/lib/mermaid-render.ts`).
- The terminal renderer (`lib/terminal-renderer.ts`) imported `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-unicode11` and `@xterm/addon-web-links` and the css of xterm as text, which the guest and shell targets bundled; `TerminalPane` created it synchronously in an effect.
- `extension.ts` imported `provider-login-flow`, `provider-login-rpc`, `provider-login-ui`, `omp-settings-editor`, `omp-config-editor` and `desk-settings/view` statically; the two editor classes registered their own commands and serializers in their constructors.

## Proposed Design

### P5: `media/terminal.js`

- `src/webview/terminal/entry.ts` is the entry of a new esbuild target (options in `scripts/terminal-bundle.mjs`, which the page tests build from too). It publishes `window.ompTerminal = { contract, createTerminalRenderer }` and imports the renderer together with xterm's stylesheet as text. The first `createTerminalRenderer` call adds that stylesheet as a `<style id="omp-xterm-styles">` in the head, ahead of the page's own rules (the rules `terminal-styles.ts` writes that adjust xterm stay in the page and keep winning). The document already allows this: `adoptNonceForCreatedStyles` (ADR-0028) stamps the nonce on styles created by script.
- `lib/sibling-script.ts` holds the loading code that `mermaid-render.ts` had (the folder of the page's own script, the document's nonce, a failed element removed so a later call retries); both loaders use it.
- `lib/terminal-loader.ts` runs the load once and shares the promise; a failure is not remembered. It checks `contract` (`terminal/contract.ts`, a number bumped whenever the renderer's shape changes), because a reinstall under an open page can leave a page and a renderer from two builds side by side.
- `TerminalPane` creates the renderer after `loadTerminal()` resolves. It attaches to the host and applies frames only from then on: before that no screen was asked for, so none is expected. A failure sets a message in the pane (`The terminal renderer could not be loaded. Reload the window` or `... is out of date ...` or `The terminal could not start: <reason>`).
- `esbuild.mjs` fails the build if `@xterm/` enters the guest or shell bundle, as it already does for mermaid; `terminal` is checked too.

### P6: `out/rare-subsystems.js`

Measured first (see Rollout): the cost of `out/extension.js` at start is parse and top-level evaluation and follows its size, about 0.15 ms per kilobyte in a plain Node process. esbuild can keep a dynamic `import()` in the same file, but then the bytes are still read and parsed at start; only a second file saves them. So:

- `src/wiring/rare-subsystems.ts` re-exports what the rarely used code offers: `SettingsEditors`, `OmpConfigEditors`, `createDeskSettingsView` and the three provider-login modules. It is the entry of a second esbuild target, `rare-subsystems` (`out/rare-subsystems.js`, CommonJS, `vscode` external).
- `src/wiring/rare-subsystems-loader.ts` is the only importer of that file: `rareSubsystems = lazy(() => import("./rare-subsystems.ts"))` (`host/lazy-module.ts`: one load shared by all callers, a failed load retried by the next). An esbuild plugin turns that one import into `require("./rare-subsystems.js")` in the extension build. Type checking and unit tests read the TypeScript module directly.
- `wiring/settings-editors.ts` registers the three commands and the two panel serializers at activation and builds `SettingsEditors` / `OmpConfigEditors` on the first use; `wiring/desk-settings-view.ts` registers the view provider and builds the view on its first `resolveWebviewView`; provider login and logout load their three modules with the first flow. A restored editor panel is revived by its serializer, which loads the module first, so a restored Models editor works as before.
- **One copy of stateful code.** The second bundle carries its own copy of every shared module it imports. For the editors that is wrong for a few modules: `native-terminal` (the OMP path reader and the resolution log the extension sets at activation, the scheduler's background runner), `runtime-assets` / `private-storage` / `win32-native` (the staging and the native module), and `OmpUnavailableError` (an `instanceof` against the second copy of the class says `false`). The extension therefore passes them in: `host/omp-runtime-services.ts` is an object of those functions built in the extension bundle and handed to the editor constructors and to the Desk Settings view; the rarely used code imports only types from the modules behind it (erased at build). After this, the modules that remain in both bundles hold no state the extension depends on (checked: module-level `let`/`Map`/`Set` in each; the few that exist belong to code the second bundle drops as unused).
- The extension build fails if the `out/extension.js` inputs contain one of the rarely used modules, so a stray static import cannot undo the split.

## Alternatives

- **`import()` inside the one bundle.** Implemented first. Measured against the same sources: no saving (the 91 modules still compile with the file, and their top-level evaluation is nearly free), so it was dropped.
- **esbuild `splitting`.** Needs ESM output; the extension's entry is CommonJS and VS Code's extension host loads it with `require`.
- **Externalising the shared stateful modules to the extension bundle at run time** (the second bundle `require`s the first). It keeps one copy of everything but needs the first bundle to export module namespaces, which is a hidden contract that breaks on a rename and cannot be type checked. The explicit services object has the same effect for the few modules that matter, in the type system.
- **Lazy `host/debug`, inventory and context views.** Not done: `debug` is wired into the Chat start path and is on by default; the inventory and context views must register their providers at activation and share state with the wiring around them. Together about 97 KB, a possible later step with its own measurement.
- **Loading xterm from a `<script type="module">` / dynamic `import()`.** The document policy allows classic scripts with the document's nonce; `mermaid.js` does the same, and a module graph would need a second loader contract.

## Risks and Open Questions

- The first terminal of a page waits for a fetch and a parse of 390 KB before it draws (the time is not measured: the file comes from the local extension folder, and the script is parsed once per page). A page that opens in terminal mode pays what it paid before and one extra file read; one that never shows a terminal pays nothing. The folder-shell page always mounts a terminal, so it reads `shell.js` and then `terminal.js` one after the other: its parse work is about what it was and it gains one more file round trip before the first screen, so the `shell.js` figure is a split, not a saving, for that page.
- A failed first read of `out/rare-subsystems.js` is told to the user (an error message with the reason and "Reload the window"), the log gets a line, a restored editor panel is closed, and the next use tries again.
- Class identity: a `SettingsRefusal` the editors throw is a class of the second bundle, so the wiring re-throws it as the extension bundle's class before Chat's `instanceof` sees it (found in the architecture review; the palette path catches inside the second bundle).
- A page and `terminal.js` from different builds refuse to talk (`contract`); the pane says so and the reader reloads the window. The contract number must be bumped with every change to the renderer interface (a comment at the declaration says so).
- The first provider login or settings editor after a window start waits for the read and parse of the second bundle (about 85 KB; see the harness figure below). The extra file lives next to `extension.js` in the VSIX and the update flow already replaces the `out` folder as a whole.
- Not verified in a real VS Code window: the activation-time effect of the lazy loading in an extension host under load (the numbers below are from a Node harness), and the first use of each lazily loaded surface in a packaged build. Page-level tests cover the terminal renderer; no automated test opens the settings editors or provider login from the bundle.
- The duplicated modules in the second bundle are acceptable only while they stay stateless. A new stateful shared module imported by the rarely used code would be silently duplicated; reviewing that import list when the entry changes is part of the entry's contract (comment in `rare-subsystems.ts`).

## Rollout and Verification

Sizes (esbuild, minified, the same options for both sides; the page bundles from the parent commit and this change, the host rows from scratch builds of the parent commit's sources and the same sources plus only this change, because the shared working tree also carries other packages' host changes: a build of the whole tree gives `out/extension.js` 1,502,558 and `out/rare-subsystems.js` 121,809 bytes when the editors still import the stateful modules, so read the host rows as this change's effect and not as the file sizes of the release):

| Bundle | Before | After |
| --- | ---: | ---: |
| `media/guest.js` | 1,728,474 | 1,337,108 |
| `media/shell.js` | 697,847 | 306,399 |
| `media/terminal.js` | - | 397,436 |
| `out/extension.js` (parent sources vs this change's) | 1,552,576 | 1,484,794 |
| `out/rare-subsystems.js` | - | 84,135 |

Host bundle load, a Node process that compiles and evaluates the bundle against a stub `vscode` module, 31 runs per side, medians, two back-to-back sessions: compile 58.5 → 56.3 ms, evaluation 155.5 → 151.4 ms, total 214.0 → 207.4 ms in the first and 218.9 → 207.5 ms in the second (−3 to −5 %). The first use of the second file takes about 50 ms in the same harness (an estimate of what the first provider login or editor adds). Under an extension host's load, where the maintainer's logs show about a second for the evaluation, the same fraction would be some 30 to 50 ms [estimate, not measured in VS Code].

Verification: page tests of the terminal (`src/webview/chat-ui.test.ts`: the renderer is a script of its own, a renderer that cannot load shows the message, the existing native-terminal subtests), the diagram tests after the shared loader refactor (`src/webview/mermaid-ui.test.ts`), `src/wiring/contributions.test.ts` (every command, view and serializer the manifest names still registers), the unit test of `lazy`, `npm run typecheck`, and a build that passes the bundle boundary checks.

## Related Decisions

- [ADR-0085](../decisions/0085-load-the-terminal-renderer-and-rarely-used-host-code-from-files-of-their-own.md)
- [ADR-0069](../decisions/0069-load-mermaid-as-a-separate-local-script-and-show-diagrams-as-svg-images.md): the loading contract this reuses.
- [ADR-0028](../decisions/0028-stamp-document-nonce-on-renderer-created-styles.md): the nonce on styles that script creates.

## Architecture Review

- Reviewer: reviewer (independent read-only task)
- Outcome: accept with changes, applied
- Notes: one pass. Must-fix: `SettingsRefusal` class identity split across the two bundles (Chat's `instanceof` would miss it) - fixed by re-throwing the extension bundle's class in `wiring/settings-editors.ts`. Should-fix, applied: a failed first read of the second file now has a user-visible message and closes a restored panel; the `terminal` build boundary now has a rule; `media/terminal.js*` is Git-ignored; the size table says which tree each row comes from; the shell page's `shell.js` figure is stated as a split; wrong test path; the terminal build writes no source map (as mermaid). Not changed: `rendererFailure` is not cleared on a later success (unreachable today), and an editor created after deactivation began is not disposed (the host is shutting down). The review found the page-script contract, the `TerminalPane` lifecycle and the provider-login, serializer and view-type wiring sound. Not re-reviewed after the fixes.
