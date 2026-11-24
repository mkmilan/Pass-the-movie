# Pass the Movie

Five friends. Three seconds each. One unpredictable movie.

A mobile-first web game: five people record one scene each; every new contributor sees only the preceding scene's final frame. The full 15-second movie is revealed after scene five.

## Development status

- Phase 0 Android capture and FFmpeg normalization/assembly demonstrated. iPhone Safari and remaining real-device checks are open.
- Phase 1 foundation in progress: Next.js App Router, Tailwind, Express/Mongoose, shared game rules and state invariants, FFmpeg preflight and local infrastructure configuration.
- No functioning movie creation, uploads, invitations, storage integration, queue or public app yet.
- Camera experiment lives at `spike/` and is independent of the application.

## Local development

Prerequisites: Node 22 (22.12 or newer in that major), npm, Docker Compose, FFmpeg/ffprobe (H.264/AAC encoders).

From the repository root:

1. Copy `.env.example` to `.env`. Choose a local storage username (at least 3 characters) and password (at least 8 characters) for the two blank R2 credential fields. Never commit credentials or expose these development services to the internet.
2. Start local services: `docker compose up -d`.
3. Initialize the single-node test replica set once: `docker compose exec mongo mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'`. Verify `docker compose exec mongo mongosh --quiet --eval 'db.hello().isWritablePrimary'` returns true before starting the API. This is a local test deployment, not a production MongoDB configuration.
4. Open the local storage console at http://127.0.0.1:9001 and create a private bucket named `ptm-local`. No application storage writes are implemented yet.
5. Run `npm install` at the repository root. The first successful installation must produce a reviewed lockfile before we consider builds reproducible.
6. In separate terminals, run `npm run dev:web` and `npm run dev:api`. The web scaffold is at http://localhost:3000; API health is at http://127.0.0.1:4000/healthz.
7. Run `npm test`, `npm run test --workspace @ptm/api`, `npm run check:media`, and `npm run build:web`.

The worker command is a preflight only; it does not start a media queue. All movie API routes return 404 until the authorization and upload implementation is ready. Public launch must remain disabled.

## Verification and limitations

See `spike/portrait-test-notes.md` for device evidence, and `docs/phase-1-status.md` for test and setup status. Local Docker and npm installation were not available in the authoring environment. The development branch is not production-ready. Never commit real participant recordings.
