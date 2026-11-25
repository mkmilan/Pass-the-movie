# Phase 4 — final reveal and export

## Baseline

Phase 3 CI passed: foundation run 45495358184 and integration run 45495358043.

## Implemented

- Verify five canonical input clips; concatenate in slot order using decoded video and audio with sample trimming/padding, re-encode H.264/AAC MP4 at 720×1280, 30 fps, 450 frames, 15 seconds. A fixed small PASS THE MOVIE overlay uses DejaVu Sans Bold. Full output verification/decode and bounded storage upload precede publishing.
- Assembly worker uses leases, heartbeats, bounded retries, attempt-specific keys and atomic publication. Failed attempts preserve accepted scenes and do not expose partial video. Publication sets seven days of access from readyAt and enqueues intermediate cleanup. The existing movie-derived access check extends accepted grants without premature grant TTL.
- Only accepted participants can retrieve the same final file when ready. Local API streams authorized MP4, handles byte ranges, and supports attachment download. No individual videos or object paths in client state.
- Frontend waits for ready, then offers inline playback, explicit download with movie-specific name, and optional native file share using a prepared File and user tap. No automatic download or social posting.

## Verification

CI extends the five-participant integration test to verify a forced assembly failure and retry, concurrent worker claim, all five identical final downloads, isolation, byte ranges, exact media profile, color order and audio tone/silent-scene order, cleanup and expiration. Confirm the actual run before calling Phase 4 passed.

## Deliberate local-only decisions and remaining work

The development API proxies the bounded final MP4 rather than issuing production R2 signed GETs. Local S3Mock cannot prove actual R2 access policy. The frontend fetches a bounded file before enabling sharing, so seeking uses the local Blob. The fixed font path is a Linux test prerequisite; production worker packaging must include the properly licensed font and drawtext support. No provider resources or paid services created. A real-device five-person flow, iPhone Safari, perceptual lip-sync, platform import, security isolation, deletion/orphan reconciliation, actual R2 signing, production hosting and legal gates remain open. Native share targets depend on OS/browser support. No final media, secrets or personal recordings committed.
