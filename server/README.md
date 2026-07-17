# `@siftone/server`

Linux/POSIX music-management server. It reads one configured root, turns valid FLAC/MP3 release folders into a managed Subsonic-compatible symlink library, records ownership in SQLite, reconciles periodic source snapshots, and exposes health and local reconciliation-testing endpoints.

Read the [architecture guide](./docs/architecture.md) to understand the server's ownership boundaries, lifecycle, and safe extension points. The current HTTP transport uses [Elysia](https://elysiajs.com/) and Bun-native APIs. Route handlers stay thin; scanning, SQLite, filesystem, and import services remain framework-independent.

## Development

```bash
bun run --cwd server dev
bun run --cwd server check
bun run --cwd server typecheck
bun run --cwd server test
bun run --cwd server build:linux-x64
```

## Development prerequisites

The standard server test suite creates real, tagged audio fixtures. Install
`ffmpeg`, `metaflac` (from the FLAC package), and `eyeD3` before running
`bun run --cwd server test`. `bun run --cwd server check` also requires
`ShellCheck` for the Gonic helper script.

The optional Gonic smoke-test helper additionally requires `bash`, `curl`,
`jq`, `sqlite3`, `ss` (from `iproute2`), and a separately installed `gonic`
binary. See [`GONIC.md`](./GONIC.md) for its setup and commands.

The server binds only to `127.0.0.1`. Its TOML `server.port` is optional and defaults to `3000`. `GET /api/v1/health`, `GET /api/v1/reconciliation/status`, and the temporary unauthenticated testing endpoint `POST /api/v1/reconciliation/rescan` are local-only. The POST endpoint accepts no paths or filters and returns `202` with scheduler status. For a real Subsonic-client integration server, use the [Gonic test-server guide](./GONIC.md).

## Boot configuration

The server requires a TOML configuration file before it opens its HTTP socket.
Pass one explicitly with `--config` (either `--config /path/to/config.toml`
or `--config=/path/to/config.toml`). Relative explicit paths are resolved from
the current working directory. Without the flag, Siftone loads `config.toml`
from the current working directory.

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

To restore a verified SQLite snapshot, pass its path with `--backup`:

```bash
bun run --cwd server state:restore /path/to/imports.sqlite
```

```toml
[server]
# Optional; defaults to 300 seconds.
reconciliation_interval_seconds = 300

[paths]
watch_root = "/srv/downloads"
generated_library_root = "/srv/music"

[musicbrainz]
# Required to enable MusicBrainz artwork lookups.
contact = "mailto:you@example.com"
```

Only the source **watch root** and symlink destination **generated library
root** are required. `musicbrainz.contact` is optional and is only checked as
a string. Without it, MusicBrainz artwork lookup is disabled. `server.port` is
optional and defaults to `3000`; when specified it must be an integer from `1`
through `65535`. `server.reconciliation_interval_seconds` defaults to `300` and
controls the periodic complete source snapshot cadence.

The configuration defaults to `config.toml` in the current working directory.
Managed data defaults under `~/.siftone`:

```text
config.toml                    configuration file
~/.siftone/cache               artwork and image cache
~/.siftone/state               SQLite database and runtime state
~/.siftone/backups             SQLite backups
```

Optional TOML overrides are available for `server.port`, `paths.cache_root`,
`paths.state_root`, and `paths.backup_root`. `paths.staging_root` and
`paths.version_root` may also be overridden; both default to hidden siblings of
the generated library root and must share its filesystem. `[publication]`
`version_retention_hours` defaults to 24. A Subsonic server must be able to
resolve the sibling version root with its relative relationship to the library
root.

To test the MusicBrainz client and its Cover Art Archive support, configure
`musicbrainz.contact` and run:

```bash
bun run --cwd server musicbrainz:test \
  --artist "Album Artist" \
  --album "Album Title"
```

The standalone prototype only accepts an exact MusicBrainz release-group match
for the tagged album artist and title, then compares up to 100 matching release
editions. It downloads only `Front`-type archive thumbnails, prefers the `1200`-pixel
JPEG (then `500` and `250`), limits every download to 5 MiB, and writes its
selected file below `paths.cache_root` at `musicbrainz-test/cover.jpg` by
default. Pass a relative `--output` path
ending in `.jpg` or `.jpeg`, or `--config /path/to/config.toml`, to override
those defaults. It does not yet participate in import or publication.

Build the standalone prototype with:

```bash
bun run --cwd server build:musicbrainz-test
```

The TOML schema is strict: unknown top-level, `server`, `paths`, or
`musicbrainz` keys, and values with the wrong type, prevent startup. Every
configured path is non-empty and absolute. The source watch root must already
exist and be a directory. Siftone resolves existing symlinks, creates the
managed generated, cache, staging, state, and backup roots when absent, and
rejects equal, parent/child, or otherwise overlapping roots.

## Current behavior

- Discover each immediate real child of the watch root as a candidate; recurse deterministically within it for FLAC/MP3 and JPEG/PNG sidecars (case-insensitive), with files accepted through eight path components below the candidate root (directories at that boundary are pruned) and a 10,000-entry budget per candidate. Discovery reports a recoverable issue when either limit prunes paths, excludes candidates with no discovered audio, and ignores all source symlinks.
- Read embedded tags and validate the fields required for publication.
- At boot, bind the HTTP listener before opening SQLite or running import work, so
  an unavailable port fails without scanning or changing import state. Health is
  degraded while startup continues with opening the SQLite ownership/state
  database, creating a verified daily backup, recovering interrupted operations,
  preflighting every plan, and reconciling it against generated output. The
  a single-flight scheduler then performs complete periodic source snapshots.
  A new or changed snapshot must remain identical for one configured interval
  before reconciliation; failed or incomplete snapshots degrade health, and a
  later confirmed complete reconciliation restores it.
- Reconciliation rejects invalid or unmanaged generated entries, stages complete
  albums into immutable version directories, and atomically swaps the public
  album-leaf symlink. It records add, replace, repair, and delayed-delete
  operations in SQLite so a rerun can resume after a failure without rolling back
  earlier successful albums.

## Implemented import pipeline

```text
watch-root child
  → startup or periodic complete source snapshot
  → FLAC/MP3 discovery and tag validation
  → exact-ALBUM logical release split and collision arbitration
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

When `ALBUMARTIST` is absent, Siftone uses the shared exact track `ARTIST`; if
multiple exact track artists occur, it uses `Various Artists`. One consistent
explicit `ALBUMARTIST` may be absent from other tracks, but conflicting explicit
values invalidate the whole same-title release. Releases are split by exact
embedded `ALBUM` values, not source folder names. Paths are deterministically
sanitized while preserving Unicode. Competing non-equivalent destinations require
review; an otherwise identical pure-MP3 contender is automatically suppressed when
an equivalent pure-FLAC contender exists.

Each generated album version contains only audio symlinks and an optional
local-artwork symlink, named `cover.jpg` or `cover.png`. The public
`Artist/Album` leaf is an owned relative symlink to that immutable version.
Imports stage and version on the same filesystem, then publish replacements by
an atomic symlink rename; old versions remain for the configured retention
window. Siftone never overwrites, adopts, tracks, or deletes unmanaged entries
in a forced non-empty root. This is a breaking layout change: existing
Siftone-managed real album directories require a rebuilt generated library and
state database; Siftone never migrates them through a visible replacement gap.

Sources are immutable: never write, edit, move, rename, delete, chmod/chown, or
create markers in them. Only the server writes generated-library, cache, staging,
state, and backup roots. SQLite-tracked generated albums are repaired from their
recorded import state; unknown or unsafe generated-tree drift is preserved and
reported for review.

## Source lifecycle

- A single-flight timer scans the complete source tree at the configured cadence.
  It never creates recursive filesystem watches; timer ticks and manual rescan
  requests coalesce rather than overlapping.
- A tracked source absent from two consecutive complete scans is removed through a
  journaled delete operation. Permission/I/O errors and incomplete scans do not
  authorize that deletion.
- Folder path/name is candidate identity. A rename/move is a missing old candidate
  plus a new candidate; no inode/device tracking.
- Immediate notifications, retry policy, and review resolution remain planned.

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

- **SQLite (`bun:sqlite`)** uses the destructive `library-state.sqlite`
  format: source containers/releases/files, imports, published destinations/entries,
  frozen operations, and FK-owned reviews. It uses `STRICT` tables, WAL, foreign
  keys, a busy timeout, and `synchronous=NORMAL`; it has no migration or
  compatibility path.
- Source paths, generated paths, and operation staging paths are canonical
  absolute `/`-separated paths, `BINARY`-compared by SQLite, and are rejected
  when relative, traversing, empty, or backslash-separated. Source-file lookup
  is the `source_files.source_path` primary key; normal fingerprints are
  `size + mtime_ns` stored as SQLite integers/JavaScript `bigint`.
- Every unresolved operation owns one import/source release and claims every
  old/new destination path. Its filesystem checkpoint is only a recovery hint:
  restart inspects staging, destination, and tombstone state before resuming
  idempotently.
- Siftone does not recursively watch source directories. Recursive inotify watches
  consume one watch per directory and can exceed Linux watch limits. Instead, a
  bounded complete directory traversal is reconciled on a timer; this deliberately
  trades notification latency for predictable resource use. Root-only listings were
  rejected because supported candidate directories may be modified in place.
- Keep boot-critical paths/network settings in a server-owned TOML file. Future
  CLI-editable runtime settings will live in SQLite. Daily backups are
  self-contained snapshots named by UTC date.

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
