import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApiConfig } from './config.mjs';
const base = { MONGODB_URI: 'mongodb://localhost:27017/ptm', PUBLIC_LAUNCH_ENABLED: 'false' };
test('development configuration defaults to loopback', () => {
  const c = parseApiConfig(base);
  assert.equal(c.host, '127.0.0.1'); assert.equal(c.port, 4000);
  assert.equal(c.webOrigin, 'http://localhost:3000'); assert.equal(c.apiOrigin, 'http://localhost:4000');
  assert.equal(c.publicLaunchEnabled, false);
});
test('missing URI and invalid port are rejected', () => {
  assert.throws(() => parseApiConfig({}), /MONGODB_URI/);
  for (const PORT of ['0','65536','1.5','oops']) assert.throws(() => parseApiConfig({...base,PORT}), /PORT/);
});
test('origins cannot contain credentials, paths, query or fragment', () => {
  for (const WEB_ORIGIN of ['ftp://example.org','https://secret@example.org','https://example.org/path','https://example.org/?x=1','https://example.org/#key']) assert.throws(() => parseApiConfig({...base, WEB_ORIGIN}), /WEB_ORIGIN/);
});
test('production requires explicit HTTPS origins', () => {
  const prod = {...base, NODE_ENV:'production'};
  assert.throws(() => parseApiConfig(prod), /WEB_ORIGIN/);
  assert.throws(() => parseApiConfig({...prod,WEB_ORIGIN:'http://example.org',API_ORIGIN:'https://api.example.org'}), /WEB_ORIGIN/);
  assert.equal(parseApiConfig({...prod,WEB_ORIGIN:'https://app.example.org',API_ORIGIN:'https://api.example.org'}).nodeEnv,'production');
});
test('public launch is disabled and secrets are not echoed in errors', () => {
  assert.throws(() => parseApiConfig({...base,PUBLIC_LAUNCH_ENABLED:'true'}), /PUBLIC_LAUNCH_ENABLED/);
  assert.throws(() => parseApiConfig({...base,MONGODB_URI:'private-secret'}), e => e.message.includes('MONGODB_URI') && !e.message.includes('private-secret'));
});
