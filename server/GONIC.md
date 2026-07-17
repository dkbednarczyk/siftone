# Gonic Subsonic test server

Gonic is the integration-test server for real Subsonic clients. It serves only
Siftone's generated library, never the immutable source watch root.

## Prerequisites

This setup was validated with Gonic `v0.22.0`. The helper also requires
`bash`, `curl`, `jq`, `sqlite3`, and `ss` (from `iproute2`). Install Gonic
separately; it is not a Bun dependency. On startup, the helper checks the
listener with `ss`.

## Configuration and runtime data

- [`gonic.example.conf`](./gonic.example.conf) is Gonic's **flagconf** file,
  not TOML. Its `music-path` is `/home/damian/Music`, the current
  `paths.generated_library_root` in [`config.toml`](./config.toml).
- All Gonic-owned state is fixed under `~/.gonic`: database, caches, temporary
  files, playlists, podcasts, PID, and log.
- The test listener is local only: `http://127.0.0.1:4747`.
- HTTP request logging is disabled so Gonic does not write plaintext Subsonic
  query credentials to its local log. The listener is still plain HTTP and
  must remain local-only unless separately protected.
- Gonic's initial account is `admin` / `admin`. Change it in Gonic before
  exposing this beyond localhost. The helper accepts `GONIC_USER` and
  `GONIC_PASSWORD` overrides after changing it.

## Helper commands

From the repository root:

```bash
server/scripts/gonic-test.sh start
server/scripts/gonic-test.sh status
server/scripts/gonic-test.sh ping
server/scripts/gonic-test.sh tracks
server/scripts/gonic-test.sh verify
server/scripts/gonic-test.sh scan
server/scripts/gonic-test.sh logs
server/scripts/gonic-test.sh stop
```

`start` creates `~/.gonic/{cache,tmp,podcasts,playlists}`, sets
`TMPDIR=~/.gonic/tmp`, writes `~/.gonic/gonic.pid` and
`~/.gonic/gonic.log`, and waits for the Subsonic ping endpoint. The configured
filesystem watcher and one-minute scan timer pick up generated-library changes;
`scan` invokes Gonic's Subsonic `startScan` endpoint for an immediate scan.
`verify` checks ping, obtains one indexed track through Gonic's public
Subsonic API, and performs a 4 KiB ranged Subsonic stream request. `tracks`
remains a direct SQLite diagnostic when an exact count is useful.

## Start the integration stack

1. Start or restart Gonic first:

   ```bash
   server/scripts/gonic-test.sh restart
   ```

2. Start Siftone. Its boot publication pass validates every source candidate,
   rejects any invalid or unmanaged generated entry, stages complete album
directories in `.siftone-staging`, moves each immutable album version into
`.siftone-versions`, and atomically swaps each public album-leaf symlink into
`/home/damian/Music`.

   ```bash
   bun run --cwd server start
   ```

   Keep that process running while testing. A repeat start is idempotent only
   when every existing generated album exactly matches the current plan.

3. Verify Gonic picked up the generated library:

   ```bash
   # Public album pointers (track links live beneath the sibling version root).
   find /home/damian/Music -mindepth 2 -maxdepth 2 -type l | wc -l
   server/scripts/gonic-test.sh tracks
   server/scripts/gonic-test.sh verify
   ```

4. Configure a real Subsonic client with server `127.0.0.1`, port `4747`, and
   the Gonic credentials. Use its normal HTTPS setting only when a local TLS
   proxy has been deliberately configured; this test server itself is HTTP.

## Known-good integration

At the last verification, Gonic `v0.22.0` indexed 149 tracks from 11 albums
published as 149 valid symlinks. A real Subsonic client browsed and streamed the
library successfully, including the multi-disc *Minecraft – Volume Beta* by
C418. Recompute the live counts rather than relying on these snapshots:

```bash
find /home/damian/Music -mindepth 2 -maxdepth 2 -type l | wc -l
find -L /home/damian/Music -xtype l | wc -l # broken public album links
server/scripts/gonic-test.sh tracks
server/scripts/gonic-test.sh verify
```

## Publication safety and recovery

- Never point Gonic at `/mnt/f`; it must serve only the generated-library root.
- Do not create, edit, or delete symlinks manually. Siftone refuses partial,
  mismatched, or unmanaged generated entries rather than adopting or repairing
  them. Run only one Siftone process for a generated-library root; publication
  assumes its server process is the sole writer, not a security boundary
  against external concurrent mutation.
- Each replacement at an unchanged public album leaf swaps one symlink atomically;
  an entire multi-album boot pass is **not** batch-atomic. Immutable versions and
  staging live below the generated root at `.siftone/versions` and
  `.siftone/staging`, so the server must permit resolution of hidden directories.
  Metadata path changes are delete/add, not gapless. If a later album
  fails, earlier exact albums remain published, staging is cleaned, and a rerun
  resumes the remaining plans once the failure is resolved. A failed commit may
  leave an empty expected artist directory, which is safe for a rerun.
- If publication preflight fails, correct the source tags or review the
  conflicting generated entry; Siftone will not overwrite it.
