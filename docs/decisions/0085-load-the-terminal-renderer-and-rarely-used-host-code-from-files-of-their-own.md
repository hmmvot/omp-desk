---
status: accepted
date: 2026-10-28
---

# ADR-0085: Load the terminal renderer and rarely used host code from files of their own

## Context and Problem Statement

Every Chat and shell page parsed xterm.js (about 390 KB minified) although most never show a terminal, and every window's extension host evaluated provider login, the settings editors and the Desk Settings view although most windows never use them. Reload and VS Code start run many windows at once, so parse time that buys nothing slows the restore. ADR-0069 already loads the diagram renderer as a separate local script; the question is whether the same contract extends to the terminal renderer, and how the host can defer code without breaking the singletons it shares with the rest of the extension.

## Considered Options

- Keep one bundle per document and one host bundle: nothing to maintain, nothing saved.
- Dynamic `import()` inside the same bundle: measured no saving, since the bytes are still read and compiled.
- Separate files loaded on first use (the ADR-0069 contract for pages; a second CommonJS bundle `required` on first use for the host): saves the parse; costs a second file and a rule about shared modules.
- Share the module instances of the first host bundle with the second through exports of the first: one copy of everything, but a hidden, untyped contract.

## Decision Outcome

Separate files loaded on first use.

- **Pages.** `media/terminal.js` (xterm.js, its addons, its stylesheet) is added by `guest.js` and `shell.js` with the loading rules of ADR-0069 (script URL from the folder of the page's own script, the document's nonce, no change to the document policy, to `localResourceRoots` or to any message). The loader code is shared with the diagram renderer (`lib/sibling-script.ts`). The page and the script agree on a numeric `contract`; a mismatch, a failed load or a renderer that throws is shown in the pane with what to do. The pane asks the host for its screen only after the renderer exists. The build fails if `@xterm/` enters either page bundle.
- **Host.** `out/rare-subsystems.js` holds provider login and logout, the Models, Agents and OMP Settings editors and the Desk Settings view; `lazy(() => import(...))` in `wiring/rare-subsystems-loader.ts`, rewritten by the build to a `require` of that file, loads it once, and a failed load is retried. Commands, panel serializers and the view provider are still registered at activation. The build fails if any of those modules enters `out/extension.js`.
- **Shared state stays single.** The second bundle carries its own copy of every module it imports, so the modules whose state or class identity the extension relies on (`native-terminal`, `runtime-assets` and the private storage and native module behind it, `OmpUnavailableError`) are passed in as `OmpRuntimeServices` (`host/omp-runtime-services.ts`) and the rarely used code imports only their types. A module that holds state and is imported by the rarely used code must be handed over the same way.

### Consequences

- Positive: `guest.js` −391 KB (−22.6 %), `shell.js` −391 KB (−56 %); `out/extension.js` −68 KB (this change alone) (−4.4 %), host bundle load in a Node harness −3 to −5 % (6 to 11 ms of about 215); a page without a terminal and a window without those surfaces read less.
- Negative: the first terminal of a page and the first provider login or settings editor of a window wait for a file read and parse; two more files to ship; a stale page next to a new `terminal.js` shows a message until the window reloads; a rule (above) for state shared with the extension, enforced by review and by the typed services object, not by the build.

## Related Documents

- [Design: lazy xterm and rarely used host code](../designs/2026-10-28-lazy-xterm-and-rarely-used-host-code.md)
- [ADR-0069](0069-load-mermaid-as-a-separate-local-script-and-show-diagrams-as-svg-images.md): the page-script loading contract this extends (amendment 2026-10-28).
- [ADR-0028](0028-stamp-document-nonce-on-renderer-created-styles.md): the nonce on styles created by script.

## Architecture Review

- Reviewer: reviewer (independent read-only task)
- Outcome: accept with changes, applied
- Notes: see the design's Architecture Review. The class-identity rule above covers `SettingsRefusal` too (the wiring re-throws it as the extension bundle's class). The folder-shell page loads `shell.js` and then `terminal.js`, so its size figure is a split of work, not a saving.
