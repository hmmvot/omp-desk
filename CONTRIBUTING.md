# Contributing to OMP Desk

Thanks for your interest in OMP Desk, a VS Code extension for running [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`) sessions. Bug reports, feature requests and pull requests are welcome.

## Platform

OMP Desk is **Windows-only** (x64 and arm64). It depends on Windows ConPTY, PowerShell and named pipes, so it cannot be developed, tested or run on macOS or Linux. The extension does not bundle OMP; install `omp` separately and make sure it is on `PATH` and authenticated.

## Development setup

Requirements:

- Windows 10 or 11
- [Node.js](https://nodejs.org/) 24 (the tests run TypeScript directly through Node's built-in type stripping; CI uses the same version)
- VS Code 1.110 or newer
- OMP (`omp`) installed and logged in

```powershell
git clone https://github.com/hmmvot/omp-desk.git
cd omp-desk
npm ci
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Type-check the whole project (`tsc`, no emit) |
| `npm test` | Run every `src/**/*.test.ts` file with the Node test runner |
| `npm run build` | Bundle the extension host, Webviews, host-control module and PTY broker into `out/` and `media/` |
| `npm run watch` | Rebuild on change |
| `npm run vsix` | Package a VSIX for the current platform with `vsce` |
| `npm run vsix:x64`, `npm run vsix:arm64`, `npm run vsix:all` | Package per-architecture release VSIX files (each contains only its own `node-pty` prebuilds); see [docs/publishing.md](docs/publishing.md) |

Before opening a pull request, run `npm run typecheck`, `npm test` and `npm run build`.

## Trying a change

1. Run `npm run build`, then `npm run vsix`.
2. Install the VSIX into a throwaway VS Code profile, not your everyday one:
   `code --user-data-dir <scratch-dir>\data --extensions-dir <scratch-dir>\ext --install-extension <file>.vsix`, then start VS Code with the same two flags.
3. Open the **OMP Desk** view in the Activity Bar, add a folder and start a session.

The extension writes a log to the **OMP Desk** channel of the Output panel and can print a diagnostics summary with **OMP: Show Diagnostics**.

## Documentation and design conventions

Project documentation lives in [`docs/`](docs/README.md): current architecture, product requirements, design documents and architecture decision records (ADRs). Start with [docs/README.md](docs/README.md); it defines the templates and naming conventions.

- Propose a design document before a major change and an ADR before a lasting technical choice.
- Update the affected documentation in the same pull request as the code.
- Write documentation in English.

[AGENTS.md](AGENTS.md) holds the same guidance for AI coding agents working in this repository.

## Pull requests

- Keep a pull request to one topic and describe the user-visible effect.
- Add or update focused tests for behavior you change.
- Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
- Do not commit personal data: absolute local paths, user names, e-mail addresses or tokens.

## Licensing

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE). If you add or update bundled third-party code, update [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) as well.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
