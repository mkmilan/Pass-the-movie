# Phase 1 — foundation status

## Implemented in the development branch

- Plain JavaScript npm workspaces: web, API, media preflight; shared domain and server-only configuration.
- Fixed five-slot movie rules, 3-second scenes, 15-second output, seven-day lifetimes, and state invariants.
- Next.js/Tailwind mobile-first development landing page using the agreed warm light palette.
- Express health route, database connection at API startup, no movie/upload routes.
- FFmpeg and ffprobe preflight, H.264/AAC encoder checks; no queue.
- Local MongoDB single-member replica set and MinIO configuration, loopback only.
- Local environment template and ignored secrets/media.

## Evidence

- Ten state-machine invariant cases executed against the pure JavaScript functions before commit; corresponding Node test cases added.
- Five server-configuration tests passed using Node 22.16.0. The committed Git blobs were matched to the locally tested files.
- FFmpeg/ffprobe 7.1.5 preflight passed; missing binary produced a nonzero exit and safe error code. Committed preflight matched the locally tested file.
- Existing Phase 0 test evidence remains in the spike folder. Real Android portrait capture and mixed assembly passed. iPhone Safari, audio sync and further real-device tests remain open.

## Open gates

- The local authoring environment cannot resolve GitHub or the npm registry and does not have Docker installed. Framework installation, Next.js build, Express route integration test, MongoDB transaction connection and local S3 startup are therefore not locally verified.
- Framework and infrastructure scaffold is committed to a separate development branch for verification, not merged or deployed. Dependency ranges are provisional pending successful lockfile generation and review. Docker tags and local configuration need a real startup test.
- A health route is not proof of storage readiness. Storage client, bucket checks, schemas, atomic operations and media queue are still unimplemented.
- Creator scene 1 starts in the claimed state (creator grant is the sole authorized contributor). It remains reserved until collection expiry; the 30-minute reservation applies to subsequent invitation claims. This clarifies the proposed open/claimed initialization ambiguity; actual API authorization and transitions are still future work.
- The exact origin parser rejects credentials, paths, queries and fragments; production requires HTTPS. Same-site deployment and cookie/CSRF controls are future API gates, not implemented by this foundation.
- No new hosting resources, DB or bucket provisioned. Phase 1 is in progress, not passed. Do not begin public upload handling or launch before the remaining safety/compatibility gates.

Next: run framework/dependency checks, produce lockfile, verify local MongoDB + object store, then Phase 2 (one authenticated scene upload and server normalization).
