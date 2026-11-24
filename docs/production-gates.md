# Private beta and public-launch preparation

This is an engineering and operational checklist, not an approval to provision services or a legal compliance finding.

## Architecture and deployment

Keep one isolated staging environment: Vercel frontend, Render API and FFmpeg worker, dedicated MongoDB Atlas database, private Cloudflare R2 bucket. Recheck actual plan terms and prices before creating anything billable. Do not share credentials or storage with unrelated apps.

- Approve a monthly spending ceiling and owner-controlled budget alerts before creating paid resources. Measure worker CPU, memory, duration, queue age, API bandwidth and storage usage; the previous compute estimate is illustrative only.
- Select a common same-site HTTPS domain arrangement or a single origin. Configure exact allowed origin, CSRF, Secure HttpOnly host-only session cookie, strict CSP compatible with Next.js, no external scripts on capability pages and no request-body/token logging. Never simply turn off the localhost gate.
- Configure real R2 private bucket, least-privilege API/worker credentials, CORS for allowed playback and short-lived signed GETs. Test access denial, Range/attachment, expiry, actual prefix deletion and orphan reconciliation. Configure a 15-day lifecycle safety net. Verify actual data region and vendor terms.
- Package patched FFmpeg/ffprobe, the licensed font and required codecs in a reviewed, pinned worker image. Non-root, read-only base, bounded scratch, memory, CPU, process count and job wall time. Isolate media subprocesses from network and database/storage credentials. Protocol restrictions and sanitized environment alone do not prove isolation; validate the actual hosting runtime or use a separately isolated encoder service. Kill jobs on lease loss where feasible.
- Review and commit dependency lockfiles. Run clean builds and vulnerability checks. Keep staging isolated from production. Verify backup retention and deletion restoration behavior.
- Use durable transactional spending quotas plus trusted-proxy-aware, distributed request limits where necessary. Review upload/queue limits, cleanup throughput, kill switch, alerts and rollback. Test with synthetic inputs before opening the controlled beta.

## Private beta gate

1. Owner authorizes infrastructure and the test group. No open creation or indexing.
2. Verify HTTPS and secure grants, actual R2 storage, deletion and media isolation using synthetic inputs.
3. Record and export from real Android Chrome and iPhone Safari, front/rear cameras, sound/mute, interruption, orientation and in-app browser fallback. Verify perceptual audio synchronization, 15-second final output, local save and manual TikTok/Instagram/FB import.
4. Complete five-person chains with informed adult testers; test invitation expiry, replacement, deletion and recovery. Monitor errors, costs and cleanup. No unrelated personal recordings.
5. Document operator support/report process, incident contact, response expectations and escalation. Establish the correct privacy and legal arrangements for actual tester data before recording it.

## Public release gate

The local /privacy page is a development notice, not the published legal documents. Before public release, establish the real operator/controller and required business/contact details, the applicable jurisdictions, processing purposes and lawful bases, handling of third-party recorded people, retention and backups, actual processors and contracts/transfers, rights and withdrawal procedures, and moderation/notice/takedown requirements. Obtain appropriate legal review. A report category form and a local review CLI do not by themselves satisfy platform obligations.

Publish finalized privacy notice, terms, acceptable-use rules and a reachable support/report channel. Recheck the cost ceiling and provider terms, test alerts and rollback, and obtain explicit public-launch approval. Payments, ads, AI, public feed and analytics remain out of scope.
