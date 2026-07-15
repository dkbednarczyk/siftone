# `@siftone/desktop`

Cross-platform, management-only desktop client built with **Electrobun** and **Svelte**. It connects to a Siftone server; it does not scan files, create symlinks, play music, or edit tags.

## Responsibilities

- Manage named server profiles and store each token in the native OS credential store.
- Show server status, scans, imports, review items, notifications, and generated-library drift.
- Request scans/rescans, suppress or delete imports, resolve collisions, and approve tag-based logical album splits.
- Review artwork candidates and configure safe runtime preferences exposed by the server.
- Display missing-source and validation failures with remediation guidance. Source correction happens outside Siftone.

## Architecture

```text
Electrobun main process
  ├─ native credential-store adapter
  ├─ profile and window lifecycle
  └─ renderer bridge

Svelte renderer
  ├─ management screens and local view state
  ├─ REST client for commands/queries
  └─ SSE client for status, progress, and persisted notifications

@siftone/contracts
  └─ request/response/event schemas shared with server and CLI
```

The renderer uses `electrobun/view`; the main process uses `electrobun/bun`. Do not use Electron APIs.

## Planned screens

- **Profiles and connection:** base URL, named profile, token setup/revocation status.
- **Overview:** server health, watch-root status, active scan, recent notifications.
- **Candidates and review:** validation failures, collisions, warnings, suppression, rescan, and approved tag-based splits.
- **Imports:** managed releases, artwork state, deletion/suppression, and detected generated-tree drift.
- **Settings:** server-owned runtime settings such as scan quiet period, naming template, artwork source allowlist/country, and backup retention.

## Boundaries

- API transport is HTTPS JSON REST plus authenticated SSE; tokens are never put in renderer-local plaintext storage.
- The server owns all mutation and validation rules. UI-provided metadata is never a substitute for source tags.
- No playback, queueing, media serving, transcoding, tag editing, or direct filesystem access belongs here.

## V1 binary targets

Windows x64, macOS x64/ARM64, and Linux x64.

## Existing template commands

```bash
bun run dev
bun run dev:hmr
bun run build:canary
```
