# Beta preparation — staged hosting, not launch

## Implemented

- Explicit cloud staging configuration validates a dedicated Atlas database, dedicated R2 bucket naming, EU/default R2 endpoint, and paired HTTPS app/api hosts under a registrable domain. No automatic fallback to an unrelated app's settings.
- Cloud sessions use Secure, HttpOnly, host-only cookies. Movie creation requires a private 256-bit starter key (only its SHA-256 hash is configured) and remains paused by default. Origin, CSRF and participant authorization checks remain in place.
- The R2 adapter signs only authorized previous-frame JPEGs and completed MP4s; links last at most 60 seconds and never exceed the movie/turn deadline. Existing links can survive revocation until expiry or object deletion. Direct browser reads omit cookies. Real R2 CORS, attachment and revocation behavior must still be checked.
- The media subprocesses can be aborted on lease loss. A candidate Linux bubblewrap wrapper restricts the executable, mounts only the job directory plus system files, clears inherited environment, unshares namespaces and applies resource limits. If requested isolation fails, the encoder fails; it never retries outside the sandbox.
- A non-root Dockerfile candidate installs FFmpeg, the font and isolation tools and checks that Ghostscript/ImageMagick executables are absent. CI can build it with a generated lockfile and run a networkless synthetic smoke test. A production deployment still needs a reviewed committed lockfile, pinned image digest, dependency/OS vulnerability review, actual hosting resource bounds and proof of sandbox behavior.
- `npm run check:cloud` is a read-only staging connectivity check. It does not provision resources or verify write/delete, privacy, CORS or production isolation.

## Hard gate

The cloud config rejects PTM_MEDIA_ENABLED=true. Cloud API uploads are refused before reading bytes, and the cloud worker runs retention only. The browser does not open the camera in cloud mode. Local synthetic recording and processing remain unchanged. The actual hosted encoder isolation must be demonstrated before a separate reviewed code change can open controlled beta recording. No public launch, production credentials, real footage or paid infrastructure in this branch.

## Setup after explicit owner approval

1. Use an owner-approved registered domain with app.<domain> on Vercel and api.<domain> on Render, or review a single-origin alternative. Do not use unrelated *.vercel.app and *.onrender.com as if they were same-site.
2. Create an isolated staging Atlas database named pass_the_movie_beta with a database-scoped user. Create a dedicated private R2 Standard bucket named ptm-beta-<suffix>, preferably EU jurisdiction; public access off, 15-day lifecycle backup, exact frontend CORS GET/HEAD. Use bucket-scoped credentials, separate API and worker credentials where practical. Verify permissions and no cross-app access. References: https://developers.cloudflare.com/r2/api/tokens/ and https://developers.cloudflare.com/r2/buckets/cors/
3. Choose approved Render/Vercel plans; no provider resource is created by these files. Configure secrets in service settings, not in chat or Git. Generate a 32-byte random starter key privately and configure its SHA-256 hex digest; retain the raw key only for approved movie starters. Run read-only preflight and then a controlled synthetic object write/read/delete test.
4. Build and verify the worker image and actual sandbox on the intended runtime. Render may disallow user namespaces; if so, retain the upload gate and choose a separately isolated encoder runtime. Do not weaken isolation to make a deployment succeed.
5. Verify secure cookies, signed links, deletion and quotas with synthetic data; review proxy/rate controls, CSP, reporting, legal documents, costs and operational alerts. Then approve an informed adult beta and test actual Android/iPhone recording/export.

## Provider security note

The media pipeline uses FFmpeg, not Ghostscript. Review both runtime and transitive OS/npm dependencies; an absent gs executable is not a full vulnerability audit. Keep images and dependencies patched. See docs/production-gates.md.
