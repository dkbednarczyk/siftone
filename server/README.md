# `@siftone/server`

Linux/POSIX music-management server. It reads one configured root, turns valid FLAC/MP3 release folders into a managed Subsonic-compatible symlink library, records ownership in SQLite, reconciles source changes through a watcher, and exposes a health endpoint. The management API remains planned.

Read the [architecture guide](./docs/architecture.md) to understand the server's ownership boundaries, lifecycle, and safe extension points. The current HTTP transport uses [Elysia](https://elysiajs.com/) and Bun-native APIs. Route handlers stay thin; scanning, SQLite, filesystem, and import services remain framework-independent.

## Development

```bash
bun run --cwd server dev
bun run --cwd server check
bun run --cwd server typecheck
bun run --cwd server test
bun run --cwd server scan:dry-run
bun run --cwd server build:linux-x64
```

The server binds only to `127.0.0.1`. Its TOML `server.port` is optional and defaults to `3000`. `GET /api/v1/health` is the current unauthenticated health endpoint. For a real Subsonic-client integration server, use the [Gonic test-server guide](./GONIC.md).

## Boot configuration

The server requires a TOML configuration file before it opens its HTTP socket.
Pass one explicitly with `--config` (either `--config /path/to/config.toml`
or `--config=/path/to/config.toml`). Relative explicit paths are resolved from
the current working directory. Without the flag, Siftone loads `config.toml`
beside the executable.

For development with the repository's `server/config.toml`:

```bash
bun run --cwd server dev
```

The `dev` script already supplies that config file. To use another one, invoke
its entrypoint directly so `--config` appears exactly once:

```bash
cd server
bun --watch src/index.ts --config /path/to/config.toml
```

Use `--dry-run` to report publication candidates without changing state. To
restore a verified SQLite snapshot, pass its path with `--backup`; it cannot be
combined with `--dry-run`:

```bash
bun run --cwd server state:restore /path/to/imports.sqlite
```

```toml
[paths]
watch_root = "/srv/downloads"
generated_library_root = "/srv/music"
```

Only the source **watch root** and symlink destination **generated library
root** are required. `server.port` is optional and defaults to `3000`; when
specified it must be an integer from `1` through `65535`.

The configuration defaults beside the executable. Managed data defaults under
`~/.siftone`:

```text
config.toml                    configuration file
~/.siftone/cache               artwork and image cache
~/.siftone/state               SQLite database and runtime state
~/.siftone/backups             SQLite backups
```

Optional TOML overrides are available for `server.port`, `paths.cache_root`,
`paths.state_root`, and `paths.backup_root`. `paths.staging_root` may also be
overridden; by default it is a `.siftone-staging` sibling of the generated
library root, rather than beside the executable, because atomic publication
requires it to share the library filesystem.

The TOML schema is strict: unknown top-level, `server`, or `paths` keys,
and values with the wrong type, prevent startup. Every configured path is
non-empty and absolute. The source watch root must already exist and be a
directory. Siftone resolves existing symlinks, creates the managed generated,
cache, staging, state, and backup roots when absent, and rejects equal,
parent/child, or otherwise overlapping roots.

## Current behavior

- Discover each immediate real child of the watch root as a candidate; recurse deterministically within it for FLAC/MP3 and JPEG/PNG sidecars (case-insensitive), with files accepted through eight path components below the candidate root (directories at that boundary are pruned) and a 10,000-entry budget per candidate. Discovery reports a recoverable issue when either limit prunes paths, excludes candidates with no discovered audio, and ignores all source symlinks.
- Read embedded tags and validate the fields required for publication. `bun run --cwd server scan:dry-run` emits the proposed destination links and validation issues without writing any directories or symlinks.
- At boot, open the SQLite ownership/state database, create a verified daily backup, recover interrupted operations, preflight every plan, and reconcile it against generated output. The watcher then coalesces source changes by immediate watch-root child and performs targeted reconciliation; lost events or incomplete scans degrade health and require a later full reconciliation.
- Reconciliation rejects invalid or unmanaged generated entries, stages complete
  albums on the generated-library filesystem, and atomically publishes each album
  directory. It records add, replace, repair, and delayed-delete operations in
  SQLite so a rerun can resume after a failure without rolling back earlier
  successful albums.

## Implemented import pipeline

```text
watch-root child
  → full scan or quiet-period watcher snapshot
  → FLAC/MP3 discovery and tag validation
  → tag-based logical release split and collision arbitration
  → SQLite operation journal + same-filesystem staging directory
  → atomically publish or repair generated album
```

Required tags: every track needs `TITLE`, `ARTIST`, and `TRACKNUMBER`; all
tracks in a release need one non-empty `ALBUM`. Embedded tags are the only
metadata authority. Incomplete or conflicting tags require external correction
and rescan. Mixed non-audio files and CUE files are ignored; Siftone does not
split single-image releases into track-level output because generated output is
symlink-only.

Multi-disc tracks are flattened and continuously numbered by disc then track:
`01 Title.ext`, `02 Title.ext`, and so on. The current validator defaults an
absent `DISCNUMBER` to disc one and rejects duplicate disc/track pairs;
directory-based disc inference remains to be built.

## Generated library

The current fixed layout is:

```text
{AlbumArtistOrArtist}/{Album}/{TrackNumber} {Title}.{ext}
```

Use the shared track artist if `ALBUMARTIST` is absent; releases with differing
track artists require `ALBUMARTIST`. Paths are deterministically sanitized while
preserving Unicode. Competing non-equivalent destinations require review; an
otherwise identical pure-MP3 contender is automatically suppressed when an
equivalent pure-FLAC contender exists.

Each generated album contains only audio symlinks and an optional local-artwork
symlink, named `cover.jpg` or `cover.png`. Imports stage on the same filesystem
and publish by atomic rename. Siftone never overwrites, adopts, tracks, or deletes
unmanaged entries in a forced non-empty root.

Sources are immutable: never write, edit, move, rename, delete, chmod/chown, or
create markers in them. Only the server writes generated-library, cache, staging,
state, and backup roots. SQLite-tracked generated albums are repaired from their
recorded import state; unknown or unsafe generated-tree drift is preserved and
reported for review.

## Source lifecycle

- Source changes wait for a quiet period, revalidate, and reconcile their
  immediate watch-root child. Conflicts and incomplete scans suppress destructive
  changes and mark full reconciliation required.
- A tracked source missing from a complete scan is recorded as missing. After the
  current fixed seven-day grace period, its generated links are eligible for a
  journaled delete operation. Permission/I/O errors and incomplete scans do not
  authorize that deletion.
- Folder path/name is candidate identity. A rename/move is a missing old candidate
  plus a new candidate; no inode/device tracking.
- Immediate notifications, retry policy, configurable grace periods, and review
  resolution remain planned.

## Artwork

Qualifying JPEG/PNG sidecar artwork is implemented: Siftone ranks `cover.{ext}`
first, then conservative normalized album-name matches in the candidate root
or a
directory containing validated audio. It publishes the first as an unchanged
`cover.jpg` or `cover.png` symlink and reports ignored alternatives as warnings.

Embedded-art extraction into the managed cache and remote artwork lookup through
`https://covers.musichoarders.xyz/api/search` remain planned. The planned
conversion policy is JPEG for opaque art and PNG for transparent art, without
upscaling and with a configurable maximum resolution (default `3000×3000`). CUE,
M3U, and rip logs are never published or trusted as metadata.

## State and recovery

- **SQLite (`bun:sqlite`)** uses the destructive `library-state-v2.sqlite`
  format: source containers/releases/files, imports, published destinations/entries,
  frozen operations, and FK-owned reviews. It uses `STRICT` tables, WAL, foreign
  keys, a busy timeout, and `synchronous=NORMAL`; it has no migration or
  compatibility path.
- Source paths and generated paths are canonical `/`-separated relative paths,
  `BINARY`-compared by SQLite, and are rejected when absolute, traversing, empty,
  or backslash-separated. Source-file lookup is the `source_files.source_path`
  primary key; normal fingerprints are `size + mtime_ns` stored as SQLite
  integers/JavaScript `bigint`.
- Every unresolved operation owns one import/source release and claims every
  old/new destination path. Its filesystem checkpoint is only a recovery hint:
  restart inspects staging, destination, and tombstone state before resuming
  idempotently.
- `chokidar` is the filesystem-watching dependency. Node/Bun watchers do not offer
  a reliable portable recursive watcher with the operational error surface needed
  here; chokidar provides that established layer. Events merely coalesce immediate
  source containers for targeted reconciliation. A watcher error marks full
  reconciliation required; startup performs that reconciliation after operation
  recovery because the source may have changed while Siftone was offline.
- Keep boot-critical paths/network settings in a server-owned TOML file. Future
  desktop/CLI-editable runtime settings will live in SQLite. Daily backups are
  self-contained v2 snapshots named by UTC date.

## Planned API and security

Expose JSON REST for commands/queries and authenticated SSE for progress and
persisted notifications. Use a long random named token per client; store only token
hashes and permit individual revocation. Initial tokens are created by a local
server-admin command and shown once.

The server runs as a normal foreground process with stdout/stderr logs and graceful
signals. It accepts a configurable TOML port but always binds to localhost; HTTPS
is terminated by the hosting provider or another local reverse proxy.

Bound request body sizes, throttle failed authentication, allow one active
scan/reconciliation per candidate, cap artwork concurrency, and return `429` with
retry guidance.

## V1 binary targets

Linux x64. Linux ARM64 is deferred.

## Non-goals

No Beets integration, playback, media serving, tag edits, source mutation,
automatic merge/overwrite, Docker/systemd requirement, or filesystem identity
tracking.
