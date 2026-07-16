# `@siftone/cli`

Cross-platform command-line management client for the Siftone server.

## V1 command scope

- Show server status and active scan state.
- List candidates, review items, imports, drift, and notifications.
- Request scan/rescan operations.
- Suppress candidates and delete/suppress generated imports.
- Create, list, and revoke named API tokens where authorized.

Exact command names and output schemas will be defined with `@siftone/contracts` before implementation.

## Architecture

```text
CLI command parser
  ├─ named profile resolver
  ├─ native credential-store lookup / environment override
  ├─ REST command/query client
  ├─ SSE progress/notification consumer
  └─ deterministic human or machine-readable output
```

Profiles hold a name, server base URL, and a credential-store reference. Native credential stores are preferred; an environment variable supports headless automation. Tokens are never kept in normal plaintext configuration files.

## Behavior

- All filesystem mutation is requested through the server API.
- Long-running operations show progress from SSE and can reconnect to persisted notifications.
- Exit codes distinguish validation, authentication, transport, conflict/review, and server failures.
- Commands must be scriptable; structured output will be available where useful.

## V1 binary targets

Windows x64, macOS x64/ARM64, and Linux x64.

## Non-goals

No local music scanning, direct symlink manipulation, playback, tag editing, or separate business rules. The CLI is not a replacement API and must stay in contract parity with the server.
