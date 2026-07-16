# Automatic Artwork Progress

This file is the durable handoff for automatic MusicBrainz/Cover Art Archive
artwork. **Update it immediately after every completed phase** so a later agent
can distinguish completed work from approved but unimplemented scope.

## Status

- Approved by user: 2026-07-16
- Current phase: 3 — SQLite state evolution is next.
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
- [ ] Phase 3 — Update SQLite schema for cache objects, automatic-artwork
      outcomes, and explicit source/cache entry origins; update state tests.
- [ ] Phase 4 — Thread `cacheRoot` through reconciliation, operation staging,
      recovery, snapshots, and finalization; ensure cache entries never depend
      on `source_files`.
- [ ] Phase 5 — Resolve art after contender arbitration and before the single
      complete reconciliation; carry results through `PublicationInput` and
      persist them once source-release IDs exist.
- [ ] Phase 6 — Add atomic object writes, reference-aware cleanup, startup/post-
      commit sweeping, local-art supersession, and damaged-cache repair.
- [ ] Phase 7 — Update documentation; run full validation and a live smoke test
      without exposing the configured MusicBrainz contact.

## Required validation

After each phase, run focused tests and update its checkbox/status here. Before
completion run frozen install, full tests, typecheck, Biome, compiled builds,
isolated compiled-binary execution, SQLite schema/integrity tests,
`git diff --check`, and a live smoke test using the existing configured contact
without printing it.

## Remaining risks

- CAA selection relies on MusicBrainz browse metadata; response fields and CAA
  availability must be mocked thoroughly and confirmed in the final smoke test.
- A five-request CAA cap trades coverage for bounded latency/load; expose
  `edition_cap_reached` clearly.
- Cache-object lifecycle must remain safe across staged, published, replacement,
  repair, and delete operations.
