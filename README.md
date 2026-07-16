# Siftone

Siftone is a Bun-first music-library management system. It watches a single Linux/POSIX download root, validates FLAC/MP3 releases from embedded tags, and publishes a Subsonic-friendly symlink library without ever modifying source files. It replaces manual link-management workflows; it is not a player, tag editor, or Beets integration.

> **Status:** early implementation. The server validates boot configuration, discovers and validates source candidates, records managed output in SQLite, atomically publishes a symlink library, and reconciles source changes through a watcher. Management APIs and client features remain to be built. See the [server architecture guide](server/docs/architecture.md) for the design and the [Gonic integration-test guide](server/GONIC.md) for real Subsonic-client testing.

## Workspaces

| Workspace | Purpose |
| --- | --- |
| [`server/`](server/README.md) | Linux daemon: scan, validate, publish, state, and source watching (management API and broader artwork pipeline planned). |
| [`cli/`](cli/README.md) | Cross-platform command-line management client. |
| [`packages/contracts/`](packages/contracts/README.md) | Shared API schemas, types, and event contracts. |

## Core invariants

- Source trees are immutable: Siftone never edits tags, moves, renames, deletes, chmods, or writes beside originals.
- Only the server process may mutate generated-library, cache, staging, state, and backup roots; those roots must not overlap source roots.
- Embedded FLAC/MP3 tags are the sole metadata authority. Folder names, CUE/M3U files, and rip logs never override tags and are not published.
- Generated albums contain audio symlinks and optional `cover.{ext}` only. Existing unmanaged generated-library entries are never adopted or changed.
- CLI is a management client only; playback and tag editing belong to other tools.

## Official v1 targets

| Component | Targets |
| --- | --- |
| Server | Linux x64. Linux ARM64 is deferred. |
| CLI | Windows x64, macOS ARM64, Linux x64. |

## Development

```bash
bun install
bun run test
bun run lint
```

See the [server development guide](server/README.md) for configuration,
publication, and Gonic integration-test commands.
