# Server architecture

Siftone is a Linux/POSIX daemon that turns immutable source releases into a
Subsonic-friendly generated music library. It reads tags from FLAC and MP3 files,
then publishes a separate tree of symlinks. The source tree is never changed.

This document is deliberately organized around **ownership and flows** rather
than implementation details. Human readers can start with the diagrams and module
map. AI-assisted readers should use the stable paths and exported entry points in
[Where to make a change](#where-to-make-a-change) before reading implementations.

## System at a glance

```text
                  immutable source tree
                  (watch_root)
                         |
                         v
       discover -> read tags -> validate -> make safe plan
                         |                      |
                         |                incomplete input
                         |                      v
                         |              preserve output; report state
                         v
                reconcile desired state <---- SQLite state
                         |
                         v
                 stage on same filesystem
                         |
                         v
                atomic rename publication
                         |
                         v
       generated symlink library (generated_library_root)

HTTP/API endpoints <----- application lifecycle -----> reconciliation scheduler
```

The server has two halves with a narrow join:

- **Preparation** (`candidates/`, `metadata/`, `publication/prepare.ts`, and
  `publication/plan.ts`) is read-only. It decides which source releases could
  safely become generated albums.
- **Reconciliation** (`state/` and `publication/publish.ts`) compares that desired
  result with recorded state and makes durable filesystem changes. It owns recovery
  and never treats an existing generated directory as safe merely because it exists.

Keeping planning separate from mutation makes dry runs trustworthy, concentrates
filesystem safety checks, and allows scheduled snapshots to reuse the same path as startup.

## Design rules that constrain every change

| Rule | Why it exists |
| --- | --- |
| Source files are immutable. | Siftone is safe to point at a downloader or existing collection; tags and source layout remain the user's authority. |
| Embedded audio tags are the metadata authority. | Folder names and sidecar text files are inconsistent and must not silently redefine a release. |
| The generated library is owned, not discovered. | The server must not adopt, overwrite, or delete an unmanaged destination. This protects users' existing music trees. |
| A generated album is complete or absent. | Albums are staged on the generated library filesystem and published by rename, avoiding visible partial output. |
| Uncertain input suppresses destructive work. | Invalid, incomplete, or conflicting input must not cause removal of prior output. |
| State records intent as well as results. | A crash can occur between filesystem steps; operations make restart recovery deterministic. |
| Boundaries stay framework-independent. | Elysia, Commander, and `music-metadata` are adapters. Import, publication, and state decisions should remain usable without a transport. |

## Startup, steady state, and shutdown

`src/index.ts` is the composition root and the only normal process entry point.
It selects one of three modes:

- `--dry-run` calls `runDryRun` and stops before opening state or changing files.
- `--backup` calls `restoreState` and stops after a validated state restore.
- Normal mode loads configuration and calls the internal `runServer` lifecycle.

Normal startup is intentionally ordered as follows:

```text
load and validate TOML
  -> bind HTTP listener (health is degraded while startup runs)
  -> open SQLite ownership/state
  -> make a verified daily backup
  -> resume interrupted operations
  -> prepare a complete source snapshot
  -> reconcile snapshot with recorded output
  -> start the reconciliation scheduler
  -> report healthy /api/v1/health
```

Binding the listener before import work makes an unavailable port fail startup
without opening SQLite, writing a backup, or scanning and reconciling imports.

Recovery happens before a fresh scan so an interrupted operation can be resolved
from its durable record rather than guessed from whatever happens to be on disk.
A full snapshot is reconciled before scheduled scans begin to cover changes made
while Siftone was stopped. On `SIGINT` or `SIGTERM`, the server closes the
scheduler and HTTP listener before closing SQLite.

The health handler in `src/app.ts` is intentionally thin. It asks state whether
Siftone is degraded and exposes `ok` or `degraded`; business logic does not live
in route handlers.

## Import and publication flow

### Full scan

```text
immediate child of watch root
  -> recursive bounded discovery of supported audio/artwork
  -> split tag-based logical releases when required
  -> validate required tags and artwork choice
  -> calculate deterministic symlink destinations
  -> arbitrate equivalent/colliding candidates
  -> reconcile desired plans with SQLite and disk
```

A source directory is a **container**, while exact embedded `ALBUM` tags may
divide its audio into one or more **logical releases**. Validation then resolves
the album artist from `ALBUMARTIST` or the track artists; source folder names
never define a release. This preserves directory-level containment while allowing
tags to define publishable albums. Discovery is bounded by depth and entry
budgets so a pathological tree cannot make a scan unbounded.

The preparation phase marks source containers incomplete when discovery,
validation, or collision arbitration cannot safely form a plan. Reconciliation
excludes those containers from removal decisions. Equivalent FLAC and MP3 plans
can be deterministically reduced; competing non-equivalent output requires review
rather than a winner chosen by accident.

### Scheduled reconciliation

`state/watcher.ts` deliberately does not recursively watch the source tree. Linux
inotify consumes one watch per directory, so large trees can exhaust
`fs.inotify.max_user_watches`. Instead it serializes full, bounded snapshots:

```text
timer or POST rescan -> complete discovery -> prepare all candidates
  -> global arbitration -> reconcile desired state
```

Timer ticks and manual requests coalesce, avoiding overlapping scans. A new or
changed snapshot must match a later observation at least one configured interval
away before it is reconciled; an early manual request cannot accelerate that
confirmation. A failed or incomplete snapshot marks health degraded and never
authorizes cleanup from an uncertain observation. Global scan failures back off
up to one hour; a manual request bypasses that delay.

### Reconciliation and atomic publish

Reconciliation classifies each desired release against state and disk as one of:

- **add**: no tracked import exists;
- **replace**: its destination or recorded input manifest changed;
- **repair**: tracked output drifted from its recorded entries;
- **delete**: a previously present source is absent from a complete scan.

For each change, state first persists an operation with destination claims,
entries, and an immutable version path. It stages an album into that version,
then atomically renames an adjacent temporary `Artist/Album` symlink over the
existing owned album symlink. The public leaf therefore never disappears during
a same-path replacement. Old versions are retained for the configured grace
period and collected only after they are unreferenced. Staging, versions, and
the generated library share a filesystem. A restart resumes an unfinished
operation or records that it needs attention; this recovery guarantee excludes
power loss because directory fsync is deliberately not required.

`publication/publish.ts` is also a small standalone publisher used by focused
tests. The normal runtime uses the richer operation journal in `state/reconcile/`.
Both preserve the same central rule: no replacement or adoption of unknown output.

## State, ownership, and recovery

`state/import-state.ts` opens exactly one destructive SQLite database,
`library-state.sqlite`. It configures SQLite for durable local state and rejects
a non-empty generated library when no matching state exists. This is a
safety boundary, not a convenience limitation.

The schema in `state/schema.ts` records:

| Records | Architectural role |
| --- | --- |
| `source_containers`, `source_releases`, `source_files` | The observed source identity, availability, and immutable file fingerprint. |
| `artwork_cache_objects`, `automatic_artwork` | Managed JPEG cache objects and durable automatic-artwork outcomes for source releases. |
| `imports`, `published_destinations`, `destination_entries` | What Siftone owns and the exact published manifest it expects; entries explicitly identify immutable-source versus cache-object origin. |
| `operations`, claims, and entries | A durable checkpoint for add/replace/delete/repair across a crash, with the same explicit entry origin. |
| `reviews` and `reconciliation_state` | Conditions that need attention and whether observation is trustworthy enough to reconcile. |

Persisted filesystem paths use canonical POSIX absolute form, enforced both by
`state/canonical-path.ts` and SQLite constraints. This prevents traversal,
platform separator ambiguity, and unsafe reconstruction of filesystem paths.

State is not a cache that may be casually deleted. It is the proof that generated
output is Siftone-owned. `state/backup.ts` writes a verified self-contained SQLite
snapshot once per UTC day; `restore.ts` validates and restores a compatible
snapshot. Restore is an administrative, one-shot command and is not a concurrency
coordination mechanism.

## Module map

| Area | Owns | Why it is separate |
| --- | --- | --- |
| `src/index.ts` | CLI modes, process lifecycle, dependency composition | Keeps application wiring out of domain logic. |
| `src/config.ts` | Strict TOML loading, root creation/canonicalization, non-overlap checks | Validates filesystem safety before the HTTP listener or mutable state opens. |
| `src/app.ts` | Elysia health and local reconciliation transport | HTTP stays a replaceable edge adapter. |
| `src/dry-run.ts`, `src/restore.ts` | One-shot operational commands | Reuse normal preparation/state rules without joining the service lifecycle. |
| `src/candidates/` | Bounded source discovery and metadata validation | Defines what may enter the pipeline, without publishing it. |
| `src/metadata/tags.ts` | Read-only adapter around `music-metadata` | Makes embedded tags the single source of metadata and keeps third-party parsing at the edge. |
| `src/publication/plan.ts` | Deterministic sanitized album/entry layout | Lets destination conflicts be found before filesystem writes. |
| `src/publication/prepare.ts` | Scan orchestration, logical-release grouping, collision arbitration | Converts source observations into safe desired publication plans. |
| `src/publication/publish.ts` | Standalone preflight/stage/publish primitive | Provides a narrow atomic publisher for direct use and tests. |
| `src/state/import-state.ts`, `schema.ts` | SQLite lifecycle, ownership guard, database format | Contains the durable source of truth for managed output. |
| `src/state/reconcile/` | Desired-vs-recorded comparison, operation journal, resume logic | Coordinates filesystem and database transitions at one safety boundary. |
| `src/state/watcher.ts` | Single-flight timer scheduling and retry backoff | Triggers complete bounded re-observation without recursive filesystem watches. |
| `src/state/*-paths.ts`, `publication-snapshot.ts`, `reconcile/types.ts` | Path safety, manifests, and reconciliation vocabulary | Keeps the critical reconciler readable and its invariants reusable. |
| `src/state/backup.ts` | Verified daily snapshot and restore primitive | Keeps backup validity independent of CLI presentation. |
| `src/**/*.test.ts` | Boundary tests | Keep expected behavior near the owning code. |

## Where to make a change

| Desired change | Start here | Also verify |
| --- | --- | --- |
| Add a server command or change lifecycle order | `src/index.ts` | `src/index.test.ts`, `src/config.ts`, this document's lifecycle section |
| Change TOML fields or filesystem-root rules | `src/config.ts` | `src/config.test.ts`, `server/README.md` |
| Support a source format or alter discovery bounds | `src/candidates/discover.ts` | `discover.test.ts`, `metadata/tags.ts`, validation behavior |
| Change metadata requirements or artwork selection | `src/candidates/validate.ts` | `validate.test.ts`, `server/README.md` |
| Change generated naming/layout | `src/publication/plan.ts` | `plan.test.ts`, collision arbitration in `prepare.ts` |
| Change duplicate/collision policy | `src/publication/prepare.ts` | `prepare.test.ts`, incomplete-input safeguards |
| Change publication filesystem behavior | `src/state/reconcile/` and `src/publication/publish.ts` | `publish.test.ts`, `reconcile/reconcile.test.ts`, recovery cases |
| Change database data or recovery phases | `src/state/schema.ts`, `import-state.ts`, `reconcile/types.ts` | `reconcile/reconcile.test.ts`, `import-state.test.ts`, backup compatibility |
| Change reconciliation cadence | `src/state/watcher.ts` | `watcher.test.ts`, degraded-state behavior in `index.ts` |
| Add an HTTP endpoint | `src/app.ts` | Keep transport thin; use a framework-independent module. |

## Testing and safe change workflow

Tests are deliberately colocated with the boundary they protect. Prefer extending
the closest existing test before adding an end-to-end test:

- candidate tests cover bounded discovery and tag validity;
- publication tests cover naming, preflight, staging, and unmanaged-output refusal;
- state tests cover schema ownership, recovery, reconciliation, backups, and watcher
  scheduling;
- `app.test.ts` and `index.test.ts` cover transport and command/lifecycle wiring.

For a typical server change:

1. Read the relevant section above and the named module's nearest tests.
2. Change the smallest owning layer; do not bypass it from an adapter.
3. Add or update a behavioral test that protects the safety rule.
4. Run `bun run --cwd server check`, `typecheck`, and `test`.
5. Update this guide when ownership, ordering, persistence, safety rules, or an
   external dependency changed.

## Current scope and intentionally open boundaries

Implemented today: configuration validation, periodic complete scans, tag-based
planning, SQLite ownership/state, crash recovery, daily backups, scheduled
reconciliation, atomic symlink publication, dry runs, restore, health, and local
reconciliation-testing routes.

Not yet implemented: the authenticated management REST API, SSE, CLI
management flows, review resolution UI/API, most artwork cache/remote-artwork
work, and the broader policy described as planned in `server/README.md`.

Do not add playback, media serving, tag editing, Beets integration, source-tree
writes, automatic adoption of output, or Electron APIs. Those violate Siftone's
product and safety boundaries.

## Keeping this document useful

Update this guide in the same change when any of these change:

- a module or directory gains/loses ownership;
- startup, shutdown, scan, publish, or recovery ordering changes;
- the SQLite schema/version, operation phases, or path format changes;
- a safety invariant, failure/degraded-state rule, or external adapter changes.

Keep detailed configuration in `server/README.md` and Gonic-specific setup in
`server/GONIC.md`; link instead of duplicating them here. Prefer updating an
existing table or flow over adding a chronological changelog. That keeps this
page navigable for both a person skimming it and a tool retrieving one section.
