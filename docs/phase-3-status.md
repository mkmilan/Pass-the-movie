# Phase 3 — five-person chain

## Scope

The local-only Phase 2 baseline passed CI run 45484100532. This branch adds role-specific creator/contributor access, single-use invite capabilities, rotation, 24-hour invitation lifetime, 30-minute idle claim reservation, generation-fenced replacement and abandonment, and private recovery links. A consumed invitation alone does not recover a grant; same authenticated browser retry can recover its existing turn. A lost claim response without a session requires the sender to replace the unaccepted turn.

The React flow implements explicit invite acceptance, previous-frame display, consent, capture, upload, waiting room, invitation copy and private access-link copy. Join and recovery capabilities are URL fragments. Invitations are not consumed by a GET request or link preview.

All five slots use the same bounded media pipeline. Accepted scenes are immutable. The fifth acceptance atomically creates one pending assembly job. No final video is available yet; assembly and final reveal are Phase 4.

## Verification

CI now runs the Phase 2 regression suite and a new five-scene integration suite on disposable MongoDB and S3Mock. It tests concurrent claim, used/rotated links, role and reference isolation, replacement of a queued turn, expired invitation and idle reservation, private-link rotation, sequential acceptance and fifth-slot handoff. Reference JPEG bytes are compared with the previous stored frame. Tests use generated clips only.

Do not mark Phase 3 passed until the new integration run succeeds. Actual mobile/browser end-to-end behavior, real iPhone compatibility, audio synchronization and social export are still open.

## Local decisions and limitations

- Local testing serves the authorized JPEG through Express (after rechecking authorization), not a signed R2 URL. Production uses short-lived signed reads after the cloud storage security review.
- The local same-site HTTP session and loopback S3Mock are not production security. No personal recordings in mock storage.
- An expired idle turn is reopened by the worker; active upload and processing have bounded leases. Reset increments generation and revokes access immediately. Late/orphan object reconciliation and complete deletion remain Phase 5.
- A browser can hold multiple grants. Requests select their own slot explicitly; ambiguous session requests are rejected. No verified real-person uniqueness without accounts.
- No public upload, deployment, paid service, merge, or monetization.
