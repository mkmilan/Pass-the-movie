# Phase 2 — single scene

## Implemented

- Local-only MongoDB creator grant and browser session, hashed personal recovery capability, exact origin/CSRF checks and sanitized status DTOs.
- Consent, portrait camera, countdown, local review/retake, manual submission with progress and status polling.
- Bounded multipart upload (12 MiB), idempotency reservation and server-generated raw object key.
- S3-compatible storage adapter (bounded file transfers, head verification, unique private keys; no public object read endpoint).
- Embedded normalization work with lease, heartbeat, conditional acceptance and next slot opening, bounded retries and raw cleanup.
- FFmpeg probe, decoded-duration and codec checks, 720×1280/30 fps/90 frames, stereo AAC, frame-89 JPEG and complete decode.
- Local developer gate defaults off; refuses production and non-loopback services.

## Verified evidence

- Media module tested locally with FFmpeg 7.1.5 using both previously supplied Android files: both produced 90 frames, 3.000 s, H.264/AAC portrait output and valid JPEG. Explicit full-range to limited-range conversion fixed the first sample.
- Synthetic media tests passed locally and in GitHub Actions run 45483693290, including VP8 WebM, rotated and silent MP4, short, invalid and oversized files, and missing ffprobe. All 18 foundation unit tests also passed.
- Foundation CI passed for commit e24159557ae8c81653ccc699785894f5b35df174, including the updated web build.
- The first integration attempt could not start the retired Docker Hub MinIO image. Local testing now uses the maintained S3Mock 5.2.3 image, bound to loopback. This is deliberately a test double, not proof of Cloudflare R2 access policies. Revised integration CI needs confirmation.

## Open gates

- Confirm MongoDB transaction, storage, end-to-end API and worker integration in GitHub Actions.
- Actual first-scene browser capture/submit still needs a running integration environment; previous standalone Android capture is not evidence of the new React flow.
- iPhone Safari, audio sync, front/rear capture, in-app browsers and social export remain Phase 0 checks.
- No production-ready sandbox, real R2 access controls, secure same-site production cookies, comprehensive abuse quotas, deletion/expiry reconciliation or deployment. Local S3Mock lacks authentication enforcement; never expose it or store personal recordings there. The worker prevents stale job acceptance but does not yet kill FFmpeg immediately on lease loss; late orphan reconciliation is outstanding.
- Source validation initially excludes HEVC/HDR, rejects missing audio start-time metadata and conservatively bounds timestamps/dimensions. Broader format/variable-frame-rate cases and frame identity/perceptual sync tests remain.
- Dependency lockfile needs generation/review. The local-only upload cap is three attempts per creator movie, not the final per-window policy. Local oversized multipart transport can terminate the request at its total byte cap.

No paid service, public app deployment, real-media commit or merge. Phase 3 invitations should follow verified single-scene acceptance, not a speculative build.
