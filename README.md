# Pass the Movie

Five friends. Three seconds each. One unpredictable movie.

Mobile-first web game: every new contributor sees only the previous scene's final frame. Five accepted three-second scenes will eventually form the 15-second reveal.

## Development status

- Phase 0: Android capture and FFmpeg mixed-format composition demonstrated; iPhone and further real-device checks remain.
- Phase 1: JavaScript workspaces, state/config tests, Next.js/Tailwind and Express health checks.
- Phase 2: local single-scene API, worker and storage integration passed on GitHub Actions (run 45484100532). Browser checks remain.
- Phase 3: invitation-only chain, five ordered turns, previous-frame access, scoped sessions, turn replacement, expiry and an atomic final-assembly handoff. See `docs/phase-4-status.md`, `docs/phase-3-status.md` for evidence and remaining gates.
- Phase 4: final 15-second MP4 assembly, private reveal, local download and optional native file sharing. See `docs/phase-4-status.md`.
- Phase 5: local deletion, expiry, reporting and transactional budget controls. See `docs/phase-5-status.md` and `docs/production-gates.md`.
- No public launch yet. Camera experiment is separate in `spike/`.

## Local development (developer-only)

Prerequisites: Node 22 (22.12+), npm, Docker Compose, FFmpeg/ffprobe with H.264, AAC and drawtext support, and DejaVu Sans Bold installed at `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`. Use synthetic media until deletion and public-safety controls are finished.

1. Copy `.env.example` to `.env`. Set `SINGLE_SCENE_DEV_ENABLED=true`. Fill the two local R2 credential fields with non-secret dummy credentials, e.g. `local-test-user` and `local-test-password`. Never use actual cloud credentials for this local setup.
2. Run `docker compose up -d`. MongoDB and S3Mock are bound only to loopback. S3Mock automatically creates the `ptm-local` bucket. It is a test double, not an authentication-enforcing production store. Never expose it or use it for personal recordings.
3. Initialize the single-node replica set once: `docker compose exec mongo mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'`. Verify `docker compose exec mongo mongosh --quiet --eval 'db.hello().isWritablePrimary'` returns true. Check `curl -fsS http://127.0.0.1:9000/favicon.ico` for mock readiness.
4. Run `npm install` in the repository root. The dependency lockfile still needs review.
5. In three terminals: `npm run dev:web`, `npm run dev:api`, `npm run dev:worker`. Open http://localhost:3000/scene. API health is at http://localhost:4000/healthz. Use the same hostname in web and API origins.
6. Run `npm test`, `npm run test:media`, `npm run test --workspace @ptm/api`, `npm run check:media`, `npm run build:web`. The integration workflow also starts disposable MongoDB/S3Mock and runs `npm run test:scene --workspace @ptm/api` with `PTM_INTEGRATION_TEST=1` and its local storage environment.
7. Stop local services with `docker compose down`. For disposable synthetic-only test data, `docker compose down -v` deletes local volumes; do not use it against unrelated data.

The single-scene routes and worker fail closed outside localhost or when production mode is selected. The current local cookie is deliberately HTTP-only development configuration (not the production Secure cookie). Public hosting and the real R2 bucket require further authorization, configuration and testing.

See `docs/phase-5-status.md`, `docs/phase-4-status.md`, `docs/phase-3-status.md`, `docs/phase-2-status.md` and `spike/portrait-test-notes.md`. Do not commit actual participant videos.

## Local report review

From `apps/api`, run `node --env-file-if-exists=../../.env reports-admin.mjs list`. For local synthetic reports only, use `close <report-id> --confirm` or `revoke <report-id> --confirm` in place of `list` after review. Revoke schedules whole-movie deletion; never use it as an automatic report response. This is not a production moderation interface.
