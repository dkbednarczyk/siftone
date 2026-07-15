# Server documentation

This directory contains durable conceptual documentation for the server.

| Document | Use it for |
| --- | --- |
| [Architecture guide](./architecture.md) | Understanding ownership, lifecycle, safety boundaries, and where a change belongs. |
| [`../README.md`](../README.md) | Setup, configuration, operational commands, and the current feature boundary. |
| [`../GONIC.md`](../GONIC.md) | Testing against a real Subsonic-compatible server. |

## Tooling decision

Plain Markdown is the right documentation system for the current scope. The
server has a small, repository-local audience and three documents that are read
alongside code. Markdown keeps documentation reviewable in the same pull request,
works in GitHub and local editors, and is easy for both people and AI tools to
navigate without a build, deployment, or versioning workflow.

Docusaurus or another generator would be premature today. Reconsider one when at
least one of these becomes true:

- documentation grows into multiple guides for distinct user or contributor
  audiences;
- versioned, independently deployed documentation is needed;
- site navigation, full-text search, API reference generation, or published
  tutorials become a sustained need;
- a team owns the site's build, theme, hosting, and dependency maintenance.

Until then, add focused Markdown pages here and link them from this index. Keep
configuration details in `server/README.md`, integration instructions in
`server/GONIC.md`, and architectural rationale in `architecture.md`.
