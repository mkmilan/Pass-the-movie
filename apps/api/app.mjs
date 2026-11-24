import express from 'express';
import { createSceneRouter } from './scene-routes.mjs';

export function createApp(scene = null) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy','no-referrer');
    res.set('X-Robots-Tag','noindex, nofollow');
    res.set('X-Frame-Options','DENY');
    res.set('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  // Enabled only by the local-only single-scene configuration.
  if (scene) app.use('/v1', createSceneRouter(scene));
  app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND' }));
  return app;
}
