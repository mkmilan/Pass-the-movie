# Phase 0 — media compatibility spike

This is a standalone experiment, not the production app. No backend, cloud storage, account system or upload endpoint. The camera page keeps the recording in browser memory until the user saves a local file. No external requests are needed.

## Run locally

From the repository root:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory spike
# Open http://localhost:8000 in a supported desktop browser.
python3 spike/media-smoke-test.py
```

The synthetic test needs Python 3 and FFmpeg/ffprobe with libx264, libvpx, libvpx-vp9, libopus and AAC encoders. Tested with FFmpeg 7.1.5. The script creates its fixtures in a temporary directory and deletes them on exit. It is not suitable as a validator for arbitrary untrusted uploads.

## Test evidence — 24 November 2026

| Case | Result |
|---|---|
| Portrait VP8/Opus WebM, 24 fps, 3.15 s | Pass |
| Landscape H.264 MP4, no audio, 25 fps, 2.8 s | Pass |
| H.264/AAC MP4 with 90-degree display rotation | Pass |
| Silent VP9 WebM | Pass |
| Fragmented H.264 MP4, 60 fps, no audio | Pass |
| Last-frame JPEG extraction (all five) | Pass: one 720 × 1280 frame |
| Five-scene composition and full decode | Pass: 450 frames, 15 s, H.264/AAC, 720 × 1280, 30 fps |
| Recorder JavaScript syntax | Pass: Node.js syntax check |
| Browser recording and review | Untested: local browser navigation was blocked in the test environment |
| Real Android and iPhone capture, playback and download | Untested |
| Perceptual lip sync, scene order and visual orientation | Untested |
| Production validation, security, resource limits and load | Out of scope for this spike |

## Next device tests

Serve the camera page over an approved HTTPS test environment; plain HTTP from a phone over a LAN is not sufficient for reliable camera access. No paid resource or public deployment is authorized by this spike.

On Android Chrome and iPhone Safari: record with front/rear cameras and with/without microphone, review, retake, save native clips. Record device/OS/browser, displayed MIME, dimensions, bytes and elapsed time. Check permission denial, interrupted recording and orientation changes. Transfer only consented test recordings through a private channel, never commit them. Extend the synthetic pipeline to test the collected native files and validate actual duration, decoded frame count, orientation, audio timing and playback of the mixed 15-second result on both devices.

Phase 0 is not complete until real mobile recordings and the mixed final export are verified. Full Next.js/Express/MongoDB scaffolding begins after the media risk has been addressed.
