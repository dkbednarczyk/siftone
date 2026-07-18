# Server runtime pipeline

This page traces the normal server process from its executable entry point to an
idle reconciliation scheduler, then through a confirmed import cycle. It
reflects the current implementation; `src/index.ts` is authoritative when it
differs from higher-level design documentation.

```text
Bun entry point
  -> parse CLI and validate TOML
  -> bind local HTTP listener
  -> open SQLite -> daily backup -> recover journaled operations -> sweep cache
  -> observe source snapshot -> scheduler idle (degraded pending confirmation)
  -> later identical complete snapshot
  -> discover -> tag/read/validate -> plan/arbitrate -> artwork
  -> journal -> stage -> immutable version -> atomic public symlink swap
  -> retain old versions -> scheduler idle (healthy when state is clear)
```

## Startup to initial idle

1. **Parse command** — `main` and `createServerCommand` read `--config` and
   `--backup`. Backup mode calls `restoreState` and exits.
2. **Load configuration** — `loadServerConfig` parses strict TOML,
   canonicalizes paths, creates managed roots, and rejects unsafe or overlapping
   roots.
3. **Bind transport** — `runServer` calls `createApp().listen`, binding Elysia
   to `127.0.0.1` before opening SQLite or scanning. `/health` is initially
   `degraded`; reconciliation endpoints are not ready yet.
4. **Open state** — `openImportState` validates the SQLite ownership database.
   It refuses a non-empty generated/version root with no state, preventing
   adoption of unmanaged output.
5. **Preserve, recover, and sweep** — `createDailyBackup` creates a verified
   daily SQLite backup; `recoverInterruptedOperations` resumes durable work left
   by an earlier interrupted run, then sweeps DB-known artwork cache objects with
   no automatic-artwork, published-destination, or frozen-operation reference.
6. **Observe source** — `observeSource` and `observeSourceManifest` hash
   immediate real source containers. A complete snapshot is pending; an
   incomplete one marks reconciliation required. This step does not validate
   tags, plan, reconcile, or publish.
7. **Enter first idle** — `startSourceWatcher` starts the timer and `ready`
   becomes true. The scheduler reports `idle`, but health remains `degraded`
   until an interval-separated identical complete snapshot is confirmed.

The listener is intentionally bound before import work: an unavailable port
therefore fails startup without opening mutable state, writing a backup, or
changing generated output.

## Confirmed reconciliation cycle

On the next timer tick (default: 300 seconds), or after a coalesced manual
rescan request, the scheduler performs one serial run:

1. **Observe and confirm** — `observeSource` creates fresh container manifests;
   `observeSourceManifest` confirms each only if it matches the pending
   manifest and has existed for at least the configured interval. Changed or
   incomplete observations mark reconciliation required and do no destructive
   work.
2. **Prepare a desired library (read-only)** — `preparePublication` calls:
   - `discoverCandidates` for bounded recursive FLAC/MP3 and artwork discovery;
   - `splitTagGroups` to split a source container by exact embedded `ALBUM`;
   - the metadata reader and `validateCandidate` for required tags, track
     ordering, artist resolution, and qualifying local artwork;
   - `planPublication` for sanitized, deterministic symlink destinations; and
   - global collision arbitration, which prefers equivalent FLAC over MP3 and
     sends non-equivalent collisions for review rather than choosing a winner.
3. **Resolve optional automatic artwork** — `resolvePublicationArtwork` adds
   eligible cache-backed artwork inputs without mutating the source tree. Local
   selected art bypasses lookup; a missing or SHA-256-invalid selected cache
   object is re-resolved nonblockingly before reconciliation.
4. **Reconcile the desired state** — `reconcileImports` compares plans with
   SQLite and the owned generated tree. It schedules journaled **add**,
   **replace**, **repair**, or delayed **delete** operations. Invalid or
   incomplete containers are excluded from deletion; an absent source needs two
   complete observations before deletion is scheduled.
5. **Publish each operation safely** — `executeOperation` persists and advances
   phases `planned -> staged -> versioned -> swapped -> finalized`. It stages a
   complete album on the destination filesystem, renames it into an immutable
   version directory, then atomically renames a temporary public album-leaf
   symlink into place. It refuses unmanaged destinations and records unsafe
   conditions as `attention_required` reviews.
6. **Collect retired versions and cache objects** — `collectRetiredVersions`
   removes only unreferenced, expired immutable versions. After every successful
   operation, artwork sweeping removes only cache objects with no durable
   automatic-artwork, published-destination, or frozen-operation reference. A
   complete issue-free reconciliation clears the degraded requirement.

## Idle, failures, and shutdown

`SourceReconciliationSchedulerImpl` deliberately uses timer-driven full
snapshots rather than recursive filesystem watches. It allows only one run at a
time: timer ticks and `POST /api/v1/reconciliation/rescan` requests coalesce;
a request during a run queues one follow-up run. A thrown run failure marks the
state degraded and schedules exponential backoff, capped at one hour. A manual
request can start a run immediately but cannot bypass source-snapshot
confirmation.

After a successful run, the scheduler clears its running state and waits for
the next timer, reporting `idle`. `/api/v1/health` is `ok` only when startup is
ready and SQLite has no reconciliation-required, attention-required operation,
or attention-required review state. On `SIGINT` or `SIGTERM`, the process
closes the scheduler, stops HTTP, then closes SQLite.

## Primary implementation references

- `server/src/index.ts:54-247` — server composition, startup, health state,
  periodic callback, and signal shutdown.
- `server/src/app.ts:11-69` — local health, reconciliation status, and rescan
  transport.
- `server/src/state/watcher.ts:17-161` — serial scheduling, coalescing, idle
  status, and backoff.
- `server/src/state/source-observer.ts:109-142` and
  `server/src/state/import-state.ts:187-268` — observation and confirmation
  state.
- `server/src/publication/prepare.ts:384-480` — discovery, validation, planning,
  and collision preparation.
- `server/src/state/reconcile/index.ts:83-320` — operation classification and
  reconciliation.
- `server/src/state/reconcile/execute-operation.ts:261-468` — staged versioning,
  atomic symlink swap, finalization, and failure handling.
