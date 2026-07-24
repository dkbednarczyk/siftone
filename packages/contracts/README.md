# `@siftone/contracts`

Shared TypeScript contracts for the Siftone server and CLI. This package is the single definition of API payloads and SSE event shapes; it contains no platform adapters, UI code, filesystem access, database access, or import business logic.

## Planned contents

```text
src/
  api/       REST request/response schemas
  events/    SSE event schemas
  models/    candidates, imports, artwork, notifications, profiles
  errors/    stable machine-readable error codes
  version/   contract version and compatibility helpers
```

## Contract rules

- Validate all untrusted REST/SSE payloads at both transport boundaries.
- Include stable IDs, timestamps, operation state, and machine-readable error/review reasons where applicable.
- Keep server tokens and filesystem implementation details out of payloads.
- Model explicit confirmation for destructive actions, force-import, suppression, review resolution, and artwork selection.
- Version additive changes compatibly; coordinate breaking changes across all three clients before release.
- REST owns commands and point-in-time queries; SSE owns progress, state changes, and persisted-notification delivery. SSE must be reconnectable from an event cursor.
