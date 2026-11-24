import express from 'express';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  // No movie creation, upload or media access until authorization is implemented.
  app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND' }));
  return app;
}
