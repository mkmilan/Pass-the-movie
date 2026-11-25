import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from './app.mjs';

test('health route is minimal and unfinished routes are unavailable', async t => {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const health = await fetch(base + '/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('x-powered-by'), null);
  assert.deepEqual(await health.json(), { ok: true });
  const movie = await fetch(base + '/v1/movies', { method: 'POST' });
  assert.equal(movie.status, 404);
  assert.deepEqual(await movie.json(), { code: 'NOT_FOUND' });
});
