# Security Policy

## Supported versions

Security fixes are made in the latest published release of OMP Desk. Please reproduce a problem on the latest version before reporting it.

## Reporting a vulnerability

Please **do not** report security vulnerabilities in public issues, discussions or pull requests.

Report them privately through GitHub Security Advisories:

1. Open <https://github.com/hmmvot/omp-desk/security/advisories/new> (or the repository's **Security** tab, then **Report a vulnerability**).
2. Describe the problem, the affected version, the steps to reproduce it and its impact.
3. Do not include real credentials, tokens or private session content. Redact paths and prompts you do not want to share.

The project is maintained by one person on a best-effort basis. Reports are acknowledged and handled as soon as possible, and the fix and disclosure are coordinated with you through the advisory.

## Scope

OMP Desk starts local processes (your installed `omp`, a pseudo-terminal broker and PowerShell helpers), talks to them over authenticated local named pipes, stores session metadata in VS Code's global storage, and renders content in VS Code Webviews. Issues in these areas are in scope, for example:

- a local process or another user gaining control of a session, pipe or broker;
- credentials or private session content being written to logs, notifications or storage;
- Webview content escaping its sandbox or content-security policy;
- unsafe handling of paths, URIs or terminal links.

Vulnerabilities in OMP itself, VS Code, Node.js or other third-party components should be reported to their respective maintainers.
