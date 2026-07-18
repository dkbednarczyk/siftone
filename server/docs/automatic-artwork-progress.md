# Automatic Artwork Progress

This file is the durable handoff for automatic MusicBrainz/Cover Art Archive
artwork. **Update it immediately after every completed phase** so a later agent
can distinguish completed work from approved but unimplemented scope.

## Status

- Approved by user: 2026-07-16
- Current phase: complete — All approved automatic-artwork phases are
  implemented and validated.
- Phase 1 completed: source output is deleted immediately after a complete scan
  confirms the source release is absent; uncertain observations remain
  non-destructive.
- Phase 2 partial progress: renamed the cover helper from `cover-prototype` to
  `cover`; enforced approved Front JPEGs, 1200→500-only thumbnail fallback,
  500px minimum dimensions, serialized local cover iteration, and URL tie-breaks.
  Added pure metadata-matching and scheduler modules with mocked tests, plus
  owned MusicBrainz/CAA client interfaces and `musicbrainz-api` adapters, plus
  initial injected-scheduler `resolver.ts` and `retry.ts` modules. CAA still
  now uses an injected native-fetch CAA adapter so status/Retry-After are
  observable. Cover downloads now return both qualifying covers and a transient
  failure signal; resolver propagation and focused CAA client tests cover those
  outcomes. The compiled `musicbrainz-test` utility now dogfoods the resolver;
  broader resolver/retry coverage remains pending. `musicbrainz-api@1.2.1`
  internally applies its own `[15, 18]` threshold and passes `retryLimit: 10` to
  its HTTP client; it does not expose `Retry-After`. Its internal HTTP client
  retries 429/503 up to ten times after only 500ms, bypassing any outer
  daemon-wide scheduler. The user approved the explicit compromise: retain the
  library unchanged and rate-limit top-level MusicBrainz calls only. Do not use
  private-field mutation or global fetch monkey-patching. CAA adapter/image
  retries remain controllable.
- Existing prototype: `src/musicbrainz-test.ts` and
  `src/musicbrainz/cover-prototype.ts`; it is not part of imports/publication.

## Approved scope

### Import integration

- Resolve automatic artwork only after publication collision arbitration and
  immediately before publication.
- Releases with selected local artwork continue without remote requests.
  Artless winners may resolve artwork concurrently, but reconciliation must run
  once with the complete winner set; never reconcile a local-art subset alone.
- A failed or unavailable automatic fetch is nonblocking: publish without art
  and persist/log a warning.
- Local selected JPEG/PNG artwork always supersedes automatic artwork. Remove
  its automatic mapping and cache object only after no operation or published
  output still references that object.

### MusicBrainz and Cover Art Archive policy

- `musicbrainz.contact` remains optional. With no configured contact, do not
  make requests and persist `disabled`; retry when any contact becomes defined.
- Use a daemon-wide **in-memory** MusicBrainz scheduler with at least one second
  between every metadata request and retry. Use the configured meaningful User-
  Agent. Use bounded transient retries and honour `Retry-After`.
- Use one daemon-wide serialized lane for Cover Art Archive metadata and image
  requests.
- First accept an exact normalized artist/title release-group match. Otherwise,
  accept the highest MusicBrainz score of at least 95; break equal scores by
  release-group MBID ascending.
- Browse at most 100 release editions. Rank those reporting
  `cover-art-archive.front=true` first, then `Official`, release date ascending,
  and MBID ascending. Skip editions explicitly reporting no Front art.
- Make at most five CAA metadata requests; the cap counts requests, not browse
  results. If exhausted without a qualifying image, persist
  `edition_cap_reached`.
- Select only approved `Front` CAA images. Fetch JPEG thumbnails only: try 1200
  then 500; never originals or 250 thumbnails. Reject non-JPEG content, files
  over 5 MiB, or width or height below 500 pixels.
- Keep the prototype ranking rule: prefer a square image only when its pixel
  area is at least 70% of the largest candidate; otherwise prefer resolution.
  Use stable URL order for ties.

### Persistent outcomes and retries

- Persist and log specific nonblocking statuses: `disabled`, `no_match`,
  `no_eligible_edition`, `no_qualifying_cover`, `edition_cap_reached`,
  `transient_failure`, and `selected`.
- Attempt transient failures three times in the current preparation run before
  publishing without art. Persist exponential-backoff `next_attempt_at` after
  exhaustion.
- Retry terminal outcomes only when the metadata fingerprint or resolver version
  changes. A `disabled` outcome retries when a contact is subsequently defined.
- A missing or SHA-256-invalid cache object is a cache miss: attempt resolution
  again and repair output if successful; otherwise retain a nonblocking failure.

### Cache and state

- Store objects under `cache_root/artwork/sha256/<prefix>/<hash>.jpg`.
- Write temporary file → validate dimensions/type/byte count → hash → atomically
  rename → write SQLite state. Sweep unreferenced objects at startup and after
  reference-changing commits.
- Keep cache artifacts explicitly distinct from immutable watched source files.
  TypeScript publication entries use a discriminated origin union; SQLite stores
  mutually exclusive source-path or cache-object columns with CHECK constraints
  and cache-object foreign keys.
- Proposed tables:
  - `artwork_cache_objects(sha256, relative_path, byte_size, width, height,
    media_type, created_at_ns)`
  - `automatic_artwork(source_release_id, metadata_fingerprint,
    resolver_version, status, cache_sha256, release_group_mbid, release_mbid,
    source_url, failure_detail, attempt_count, attempted_at_ns,
    next_attempt_at_ns)`
- Cache references held by operations and published destinations protect files
  from garbage collection.

### Source removal

- Remove the fixed seven-day source-missing grace period. A complete,
  authoritative scan schedules immediate deletion of absent source output.
- Incomplete scans, watcher loss, permission errors, and I/O errors still never
  authorize destructive deletion.

### State format and non-scope

- Follow the existing pre-release destructive schema-evolution policy; do not
  add a migration layer.
- Do not modify source music trees, tags, or files.
- Do not add playback, tag editing, Beets, Electron, a manual approval stage, or
  a management-client feature in this work.

## Phased implementation checklist

- [x] Phase 1 — Removed source-missing grace period; updated reconciliation
      tests and architecture/user documentation. Focused reconciliation tests,
      typecheck, and Biome passed.
- [x] Phase 2 — Completed production matching, schedulers, retry helper,
      CAA/MB clients, resolver, hardened JPEG cover selection, compiled utility
      integration, and mocked module tests. Full server validation (114 tests),
      typecheck, Biome, frozen install, compiled build, isolated no-contact
      execution, and `git diff --check` passed.
- [x] Phase 3 — Added destructive SQLite schema support for JPEG cache objects,
      automatic-artwork outcomes, and mutually exclusive source/cache-origin
      snapshots. Cache references are indexed and restrictive; source snapshots
      remain frozen without source-file FKs. Added discriminated entry origins,
      source-only runtime compatibility, old-schema rejection, constraint/FK/
      integrity coverage, and cache-reference deletion tests. Focused state and
      reconciliation tests, full server tests (126), typecheck, Biome, frozen
      install, Linux builds, isolated compiled-binary execution, and diff
      check passed.
- [x] Phase 4 — Threaded `cacheRoot` through startup recovery and
      reconciliation into origin-aware staging, snapshot validation, recovery,
      and finalization. Cache-origin snapshots now join cache objects directly,
      never `source_files`; cache paths are confined below `cacheRoot`, manifests
      are order-normalized, and missing cache objects cannot be finalized from a
      recovered stage. Focused tests, full server tests (144), typecheck,
      Biome/ShellCheck, frozen install, both Linux builds, an isolated compiled
      server smoke, and `git diff --check` passed.
- [x] Phase 5 — Resolve automatic artwork only for artless winners after
      contender arbitration; preserve winner order while resolving concurrently,
      then reconcile the complete winner set once. Results now flow through
      `PublicationInput`, selected JPEGs receive minimal content-addressed
      atomic cache installation, and outcomes/cache metadata persist atomically
      with source-release creation or update. Reused outcomes retain attempt
      times; disabled, terminal, and backoff policies avoid unnecessary calls;
      resolution and cache-install failures are nonblocking. Focused integration
      and rollback coverage, full server tests (153), typecheck, Biome/ShellCheck,
      frozen install, isolated Linux compiled builds, an isolated no-contact
      compiled-server health smoke, and `git diff --check` passed.
- [x] Phase 6 — Added reference-aware cache-object sweeping after startup
      recovery and every successful reconciliation commit; automatic-artwork,
      frozen-operation, and published-destination references are protected.
      Local selected art transactionally supersedes automatic mappings only after
      publication, and selected objects are SHA-256-validated before reuse.
      Missing or invalid objects re-resolve nonblockingly; damaged uncommitted
      operations are safely abandoned during recovery so startup continues.
      Focused artwork and reconciliation tests (25), TypeScript typecheck, and
      targeted Biome checks passed.
- [x] Phase 7 — Updated server README, architecture, and runtime-pipeline
      documentation for resolver policy, local-art precedence, cache lifecycle,
      retries, and damaged-cache repair. Frozen install, all 168 server tests,
      TypeScript, Biome, ShellCheck, both Linux builds, isolated native compiled
      health smoke, SQLite schema/integrity coverage, and `git diff --check`
      passed. A configured-contact live resolver smoke completed without printing
      the contact.

## Required validation

After each phase, run focused tests and update its checkbox/status here. Before
completion run frozen install, full tests, typecheck, Biome, compiled builds,
isolated compiled-binary execution, SQLite schema/integrity tests,
`git diff --check`, and a live smoke test using the existing configured contact
without printing it.

## Remaining risks

- CAA selection relies on MusicBrainz browse metadata; provider field changes
  and availability still need operational monitoring.
- A five-request CAA cap deliberately trades coverage for bounded latency and
  load; `edition_cap_reached` remains a visible persisted outcome.
- Cache-object lifecycle is protected by SQLite snapshots and recovery tests;
  filesystem-level faults between atomic cache replacement and SQLite commit
  remain a nonblocking re-resolution path.
