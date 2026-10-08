---
status: accepted
date: 2026-10-08
---

# ADR-0049: Intercept the Stats browser opener through a verified child preload

## Context and Problem Statement

Actual `omp stats` starts the normal usage dashboard and standalone Frustration judge, but unconditionally opens a system browser. An editor iframe needs that exact dashboard without an extra browser tab. Neither installed runtime exposes the stats package as an embedded extension import. The package installation supports explicit Bun `--preload`; the separately installed compiled runtime does not honour it. An environment-only preload was ignored and caused an unintended desktop browser side effect during investigation; it is not used by the implementation.

## Considered Options

- Request a native `omp stats --no-open` flag: preferred upstream solution, unavailable today.
- Import the stats server and standalone judge inside a minimal OMP extension: the stats package is not in the compiled extension module registry, so the real probes failed.
- Run a standalone stats package entry: changes the command, loses the CLI's standalone judge and requires a package tree unavailable to compiled installations.
- Modify PATH, SystemRoot or browser registration: rejected as global or unrelated behavior changes.
- Use a narrowly matched child-local preload where proven, with explicit user consent before native fallback: chosen.

## Decision Outcome

Before every fresh dashboard launch, stage the extension's plain ESM preload into verified private content-addressed storage and run a harmless **version** invocation with the preload flag before the resolved launch prefix. Only exit zero plus the preload's exact installation marker admits a suppressed launch; no version guess, environment flag or real dashboard is used to test capability.

The preload observes the current process's exact `Dashboard available at:` console line (stripping ANSI color only). It wraps Bun's spawn for the exact five-argument Windows PowerShell opener shape and suppresses only the decoded `Start-Process` URL equal to that process's printed loopback dashboard URL. Other URLs, commands, altered scripts, extra flags and pre-readiness spawns pass through unchanged. The substituted child is a real short-lived `powershell -Command 'exit 0'`, preserving the actual Bun subprocess/result contract without fabricated PID or exit state. The host records the observed suppression marker or a fixed unconfirmed/fallback diagnostic. No dashboard proxy or OMP source modification is involved.

If capability is absent or staging/probing fails, show a modal: **This OMP build opens the dashboard in your browser as well. Start it?** Start runs native `omp stats` without a preload; Cancel launches nothing and opens no editor. Consent is not remembered. The next click while a compatible dashboard already runs only reveals/opens the editor, so it neither probes launch capability nor asks again. This fallback is a product choice for explicit user starts, not permission to exercise an unproven browser-opening path in automated proof.

### Consequences

- Positive: preserves the real command, database, port/reuse semantics and Frustration judge; avoids the browser for supported runtimes; unsupported runtimes remain usable after explicit side-effect consent.
- Negative: private output/opener formatting and a writable Bun API are fragile. A capability marker proves installation, not every future opener shape; a changed native opener safely passes through and can still open a browser, with unconfirmed suppression logged. The workaround should be removed when a supported native no-open flag exists.
- An observed definite unchanged-opener marker is cached for that command, prefix and reported version during the window lifetime. Its next fresh launch requires the fallback modal; this remembers a capability miss, never user consent. Missing or unreadable observation remains explicitly unconfirmed.
- Native OMP's port reclamation remains its own behavior: extension preflight refuses known incompatible listeners, but an independently started listener racing preflight may be reclaimed by OMP. The broker row owns the started process, not a separately started server it might reuse.

## Related Documents

- [Stats dashboard design](../designs/2026-10-08-stats-dashboard.md)
- [ADR-0047](0047-host-stats-in-the-existing-pty-broker.md)

## Architecture Review

- Reviewer: architect
- Outcome: accepted after independent architecture review.
- Notes: exact printed-URL matching, harmless capability probing and per-start fallback admission were accepted. The recommended capability-miss memory was adopted; environment-only preload remains excluded after the reconciled investigation side effect.
