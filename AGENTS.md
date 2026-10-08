# AGENTS.md

This project, OMP Desk, is a Windows-only VS Code extension for managing Oh My Pi (`omp`) sessions. It is an independent project, not an official OMP distribution.

- Read [docs/README.md](docs/README.md) before work, then the documents relevant to the task. Write project documentation in English.
- Use `docs/tmp/` for task-local drafts, plans, gathered context, and notes. It is ignored by Git and is not a source of current decisions. Move lasting conclusions to permanent documents and remove obsolete temporary material at task end.
- Prepare a design document before a major change and an ADR before a lasting technical choice. Use the templates and naming conventions in `docs/README.md`.
- Have each new design document and ADR reviewed independently for architecture, by a separate reviewer agent or a person who did not write it. Resolve material findings and then accept the document. If no independent review is available, leave it `proposed`; never claim review happened when it did not.
- Update affected current documentation with code. Keep proposed and implemented states distinct; link to the canonical document instead of duplicating its content.
- Verify the installed OMP interface before relying on it; never assume an OMP API from memory or from another extension.
- Before handing extension work over, build the VSIX and install it in your main VS Code installation, not only in an isolated test profile. Confirm the installation succeeded; never describe a repository build as an installed extension. If installation cannot be completed, report the blocker explicitly.
- Do not commit personal data: absolute local paths, user names, e-mail addresses, private workspace names, or links to artifacts that are not in Git (agent transcripts, screenshots, scratch files). Describe such evidence in prose instead.
- For packaging, release and Marketplace rules, follow [docs/publishing.md](docs/publishing.md). For contributor setup and commands, see [CONTRIBUTING.md](CONTRIBUTING.md).
