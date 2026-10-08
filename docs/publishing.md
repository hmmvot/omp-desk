# Publishing OMP Desk

This is the permanent checklist for packaging, releasing and publishing OMP Desk to the [Visual Studio Marketplace](https://marketplace.visualstudio.com/vscode) and GitHub. Rules are taken from the official documentation listed under [Sources](#sources), read on 2026-10-07; re-read the linked pages when `vsce` or the Marketplace changes.

## Identity

| Item | Value |
| --- | --- |
| Product name (`displayName`) | OMP Desk |
| Extension name (`name`) | `omp-desk` |
| Publisher (`publisher`) | `hmmvot` |
| Extension ID | `hmmvot.omp-desk` |
| Repository | <https://github.com/hmmvot/omp-desk> |
| License | MIT, `Copyright (c) 2026 hmmvot` |
| Platforms | Windows only: `win32-x64` and `win32-arm64`, one VSIX per target |

The Marketplace requires `name` and `displayName` to be unique across all extensions, and a removed extension's name is reserved permanently. Confirm that `OMP Desk` and `omp-desk` are free before the first publish. The publisher ID cannot be changed after creation.

## Constraints the tooling enforces

`vsce package` and `vsce publish` reject or warn about the following ([publishing docs](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publishing-extensions)):

- The `icon` must be a PNG of at least 128×128 pixels (256×256 for Retina); it must not be an SVG.
- Image URLs in `README.md` and `CHANGELOG.md` must resolve to `https`. SVG images are rejected unless they come from a [trusted badge provider](https://code.visualstudio.com/api/references/extension-manifest#approved-badges).
- `badges` in `package.json` must come from the approved providers (for example `img.shields.io`, `badgen.net`, or `github.com` workflow badges) unless they are PNG/JPEG.
- `keywords` is limited to 30 entries.
- `categories` must come from the allowed list: Programming Languages, Snippets, Linters, Themes, Debuggers, Formatters, Keymaps, SCM Providers, Other, Extension Packs, Language Packs, Data Science, Machine Learning, Visualization, Notebooks, Education, Testing. Use only values that fit; this extension uses `Other`.
- `engines.vscode` is required and cannot be `*`.
- `repository` should point to the public GitHub repository. `vsce` then rewrites relative links and images in the README to GitHub URLs (branch `main` by default; override with `--githubBranch`). Never package a release with `--no-rewrite-relative-links`.
- A `LICENSE` file must exist (or pass `--skip-license`); `vsce` prompts if it is missing.
- `activationEvents: ["*"]` is refused without `--allow-star-activation`; `vsce` also scans the package for secrets and refuses to package `.env` files.
- The Marketplace page is the `README.md`; `CHANGELOG.md` becomes the Changelog tab. Both are read from the repository root.

## Pre-release checklist

1. **Manifest** ([manifest reference](https://code.visualstudio.com/api/references/extension-manifest)): `name`, `displayName`, `description`, `version`, `publisher`, `author`, `license`, `repository`, `bugs`, `homepage`, `categories`, `keywords`, `icon`, `galleryBanner`, `engines.vscode`, `preview` are all set and accurate. `private` is removed.
2. **Marketplace presentation** ([tips](https://code.visualstudio.com/api/references/extension-manifest#marketplace-presentation-tips)): the README leads with what the extension does, what it needs (installed OMP, Windows) and how to start; screenshots are committed and use `https`-resolvable relative paths; the banner color suits the icon.
3. **UX** ([UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/overview)): commands carry the `OMP` category, contributions sit in the right containers (Activity Bar view, editor title actions, Command Palette), and notifications and settings follow the platform conventions.
4. **Version and changelog**: bump `version` ([SemVer](https://semver.org/spec/v2.0.0.html)), move the `Unreleased` entries of [CHANGELOG.md](../CHANGELOG.md) under the new version heading with its release date ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)), and update the comparison links at the bottom.
5. **Third-party notices**: [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt) matches `package-lock.json` for every package bundled into or shipped next to the extension.
6. **No private data**: no absolute local paths, user names, e-mail addresses, private workspace names, or references to files that are not tracked in Git (see [AGENTS.md](../AGENTS.md)).
7. **Repository health** ([community profile](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories)): `README.md`, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, issue forms under `.github/ISSUE_TEMPLATE/`, and a CI workflow are present. Enable [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) in the repository settings so the `SECURITY.md` link works. Optionally add a code of conduct.
8. **Quality gates**: `npm run typecheck`, `npm test` and `npm run build` pass on a clean checkout (`npm ci`), and the CI workflow is green.

## Versioning and release channels

- Versions follow [SemVer](https://semver.org/spec/v2.0.0.html); before 1.0.0 any minor version may change behavior. The Marketplace accepts only `major.minor.patch`: SemVer pre-release tags such as `-beta.1` are not supported.
- `"preview": true` flags the extension as Preview on the Marketplace page. It is independent of the pre-release channel and is the recommended flag for early versions.
- The pre-release channel (`vsce package --pre-release`, `vsce publish --pre-release`) needs a version distinct from every regular release, and VS Code moves users to the highest version available. The documented convention is `major.EVEN.patch` for releases and `major.ODD.patch` for pre-releases ([pre-release extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#pre-release-extensions)). Version 0.1.0 is published as a regular Preview release; adopt the even/odd convention only when a separate pre-release channel is wanted.

## Release steps

Run every step on a clean checkout of the commit to be released.

```powershell
npm ci
npm run typecheck
npm run build
npm test
npm run vsix:all
```

1. `npm run vsix:x64` and `npm run vsix:arm64` run `scripts/package-vsix.mjs`, which calls `vsce package --target <target> --no-dependencies` with `OMP_DESK_TARGET` set. `vscode:prepublish` runs `npm run build`, so the output always matches the sources; `esbuild.mjs` reads `OMP_DESK_TARGET` and copies only that target's `node-pty` prebuilds. `--no-dependencies` is correct because everything is bundled by esbuild and the `node-pty` package is copied into `out/pty/` by the build. Run `npm run build` again afterwards for an ordinary local build.
2. Each command writes `omp-desk-<target>-<version>.vsix`. A package is built for one platform ([platform-specific extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platform-specific-extensions)); VS Code 1.61+ selects the one matching the user's platform.
3. Inspect each package before publishing (see [Verifying](#verifying)).
4. Publish both packages to the Marketplace (see [Authentication](#authentication)).
5. Tag the released commit `v<version>` and push the tag (`git tag v0.1.0`, `git push origin v0.1.0`). The [Release workflow](../.github/workflows/release.yml) then checks that the tag matches `version` in `package.json`, runs the quality gates, builds both VSIX files and creates the GitHub Release with them attached and the matching CHANGELOG section as its notes (`scripts/release-notes.mjs`). It does not publish to the Marketplace.

Publishing a version cannot be undone: a published version number cannot be reused, and the latest version cannot be deleted. Unpublish or remove a version from the [management page](https://marketplace.visualstudio.com/manage) only for emergencies; ship a fixed patch version instead.

## Authentication

- Create a publisher `hmmvot` on the [management page](https://marketplace.visualstudio.com/manage) with the Microsoft account that will own it.
- For 0.1.0, publish by uploading the two VSIX files on that management page; no token is involved.
- Planned automation is [trusted publishing](https://github.com/microsoft/vscode-vsce#trusted-publishing): `vsce publish --oidc` from the Release workflow, with no stored secret, once a vsce release ships that flag (3.9.2 and 4.0.0 do not).
- Never commit a token or add a Marketplace secret to the repository.

## Verifying

Before publishing:

- `tar -tf omp-desk-win32-x64-0.1.0.vsix` (and the arm64 file) lists each package's contents; `npx vsce ls --no-dependencies` lists the working tree as a build without `OMP_DESK_TARGET` would package it. Each VSIX must contain `extension/README.md`, `extension/CHANGELOG.md`, `extension/LICENSE.txt`, `extension/THIRD_PARTY_NOTICES.txt`, `extension/licenses/paseo/`, `extension/media/` (without `media/readme/`) and `extension/out/`, and must not contain `src/`, `docs/`, `.github/`, `scripts/`, source maps, test files, `*.vsix`, or `node_modules/` other than `out/pty/node_modules/node-pty`. The `node-pty` tree of the x64 package holds only `prebuilds/win32-x64`, and the arm64 package only `prebuilds/win32-arm64`.
- Both packages build without `vsce` warnings; read every warning.
- Install each package into a throw-away VS Code profile (`code --user-data-dir <dir> --extensions-dir <dir> --install-extension <file>`) and check that the Sessions view opens, a Chat session and a Terminal session start against a real `omp`, and the OMP output channel shows no errors. The arm64 package can only be checked on an arm64 machine.
- Re-read the README as rendered by `vsce`'s link rewriting: every image and link must resolve on GitHub.

After publishing:

- `npx vsce show hmmvot.omp-desk` lists the new version and both targets.
- Open the Marketplace page and check the title, icon, banner, Preview flag, README, Changelog tab and the Resources links (Issues, Repository, Homepage, License).
- Install `hmmvot.omp-desk` from the Marketplace into a clean profile on Windows and start a session.

## Moving from the unpublished local build

Local builds made before the first release used a different extension ID (publisher and name were both `omp-vscode`) and were never published. VS Code keys an extension's global storage, secrets and Memento state by extension ID, so `hmmvot.omp-desk` starts with its own empty state. The one thing that is carried over is the registered folder list: on first activation OMP Desk reads `globalStorage/omp-vscode.omp-vscode/catalog/v1/catalog.json` (read-only) and adds those folders to its own catalog once (`src/host/predecessor-import.ts`; the ledger entry `predecessor:omp-vscode.omp-vscode` prevents a removed folder from coming back). Session rows, claims, broker slots and shell records are deliberately not imported: they describe processes and ownership of the old build. Only the maintainer's machines are affected. To move a machine over:

1. In the old build, close every running session from the Sessions view, so no detached broker or OMP child is left that the new extension cannot adopt.
2. Uninstall the old build. It must go first: both builds contribute the same commands and views.
3. Install OMP Desk and open the Sessions view. The folders appear automatically; session history lives in OMP's own files and reappears through each folder's **Resume Session**.
4. Optionally delete the old extension's folder inside VS Code's `globalStorage` directory once nothing needs it.

The `omp.*` settings keep their names, so user settings carry over unchanged.

## Sources

- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension): `vsce`, PATs, publisher, pre-release, platform-specific extensions, `.vscodeignore`, FAQ.
- [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest): fields, categories, keywords limit, `galleryBanner`, approved badges.
- [UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/overview): containers, items and common UI elements.
- [Continuous Integration](https://code.visualstudio.com/api/working-with-extensions/continuous-integration): publishing from CI.
- [`@vscode/vsce`](https://github.com/microsoft/vscode-vsce): CLI reference and trusted publishing.
- [About community profiles for public repositories](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories): recommended community health files.
- [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).
