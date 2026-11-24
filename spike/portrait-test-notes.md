# Phase 0 — portrait recording follow-up

## First real Android sample, 24 November 2026

- Front camera, microphone off, review and local download successful according to tester.
- Actual file: H.264 baseline in MP4, 932,239 bytes, 1440 × 810 landscape, no display rotation metadata, 2.963933 seconds, 81 decoded frames, no audio. Camera track reported 1280 × 720 at 30 fps; actual encoded dimensions differ.
- FFmpeg 7.1.5 normalized the sample with the existing fit-and-pad filter and silent AAC track. Verified 720 × 1280 H.264, 30 fps, 90 decoded frames, stereo 48 kHz AAC, 3.000 seconds, complete decode.
- No recording, screenshot or device identifier committed.

## V2 camera decision

Request 9:16 and crop-and-scale as preferences, then use decoded preview dimensions rather than reported camera settings. Native 9:16-ish capture uses the native stream. For other aspect ratios with canvas capture support, center-crop to 720 × 1280 before MediaRecorder, matching the visible portrait preview; keep original microphone track if enabled. If canvas capture is unavailable, show the native frame with an explicit diagnostic warning. Do not silently change the server's fit-and-pad rule. Center cropping discards edges and can reduce image detail; it is intentional only when the preview shows that same crop. This is a prototype choice pending tester feedback. Output diagnostics exclude camera/group identifiers and report the recorded video dimensions separately.

Node syntax and crop rectangle calculations passed for landscape, 9:16 and tall portrait inputs. Browser automation navigation was blocked in the local environment, so no live V2 camera test is claimed. Android retest with front/rear and microphone, iPhone Safari, actual canvas video frame rate and audio synchronization, plus mixed real-file assembly, remain pending.
