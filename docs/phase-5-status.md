# Phase 5 — local hardening and production gates

## Verified baseline

Phase 4 passed the full local integration workflow (run 45496498512) and frontend build (run 45496498365). Five accepted scenes produce a verified 15-second H.264/AAC movie, with identical private downloads for all five participant grants.

## Implemented in this branch

- Creator or accepted contributor can request deletion of the entire movie after confirmation. Atomic state change invalidates work and access; grants are revoked. Unaccepted contributors can abandon only their own turn.
- Seven-day collection and publication deadlines are enforced by the API. The worker periodically marks expired movies, removes and verifies their storage prefixes, checks again after a ten-minute quiet interval, clears grants and participant metadata, and retains a minimal tombstone for seven days with repeated checks before purge. A late object extends the cleanup horizon.
- Periodic bounded orphan reconciliation protects live referenced objects and current media lease output keys. Failed cleanup retries with backoff. Mongo TTL does not delete movie records ahead of verified storage cleanup.
- Creation and upload reservations share a Mongo transaction with global budget accounting. Fixed local caps: 50 movies/day, 100 active collecting/assembling movies, 100 queued/uploading/assembling movies, and 500 MiB/day upload reservation budget. Each nonduplicate reservation charges the full 12 MiB; no refund on rejection, so at most 41 such attempts fit within the daily budget. Three upload attempts per grant are still enforced.
- Local process limits: 300 API requests/minute/IP; 10 creates/minute/IP; 30 capability exchanges/minute/IP; 3 new upload reservations/minute/grant and 30/minute/IP (shared-network tolerance); five report attempts per ten minutes/IP and 100 reports/day. Rate buckets use salted hashes and bounded memory, not stored raw addresses. The restart-controlled NEW_MOVIES_PAUSED flag blocks creation without stopping cleanup.
- Report category plus optional movie identifier; no free text, clips, contact information or private links. Local operator CLI can list and close reports or explicitly request whole-movie takedown. Open local reports have a 90-day expiry; closed reports have 30 days. These periods and operator review process must be confirmed for the actual service.
- Local privacy/recording rules and reporting form; explicit deletion warning; no-referrer, no-index and framing restrictions. Downloaded external copies cannot be recalled.

## Verification

The new CI suite checks contributor withdrawal, access revocation, prefix deletion, late writes, metadata scrubbing and final tombstone purge; automatic expiry; orphan protection; concurrent quota races and report intake. Foundation and existing chain/render regression tests still run. Check the final branch CI result before marking the local stage verified.

## Not complete: public and private-beta hosting gates

The current app remains **localhost only**, and S3Mock is a synthetic test double, not a secure cloud bucket. Do not expose it or store personal recordings in it. No public or beta services are deployed in this phase.

Production-specific items still require implementation and verification: HTTPS same-site deployment, Secure host-only cookies, real private R2 and short-lived signed access, independent network/credential isolation of untrusted FFmpeg processes, pinned image/dependency versions, distributed limits and proxy configuration, cleanup/usage alerting, production-equivalent CPU and memory benchmarks, operator contact/legal bases/vendor agreements, and real iPhone/Android end-to-end tests. See production-gates.md. Do not treat these development safeguards as legal compliance or a complete production security audit.

No new paid services, public deployment, or actual participant footage committed.
