import test from 'node:test';
import assert from 'node:assert/strict';
import { GAME_RULES as rules, OUTPUT, MOVIE_STATUS, SLOT_STATUS } from './rules.mjs';

test('fixed portrait movie profile', () => {
  assert.equal(rules.sceneCount, 5);
  assert.equal(rules.sceneSeconds, 3);
  assert.equal(rules.width, 720);
  assert.equal(rules.height, 1280);
  assert.equal(rules.fps, 30);
  assert.deepEqual(OUTPUT, { sceneFrames: 90, movieSeconds: 15, movieFrames: 450 });
});

test('upload and expiration limits', () => {
  assert.equal(rules.maxUploadBytes, 12 * 1024 * 1024);
  assert.equal(rules.sourceMinSeconds, 2.7);
  assert.equal(rules.sourceMaxSeconds, 3.5);
  assert.equal(rules.collectLifetimeMs, 604800000);
  assert.equal(rules.readyLifetimeMs, 604800000);
  assert.equal(rules.inviteLifetimeMs, 86400000);
  assert.equal(rules.turnLifetimeMs, 1800000);
});

test('state names agree with the specification and cannot be mutated', () => {
  assert.deepEqual(MOVIE_STATUS, ['collecting','assembling','ready','failed','deleting','deleted','expired']);
  assert.deepEqual(SLOT_STATUS, ['locked','open','claimed','uploading','queued','accepted','retryable']);
  for (const value of [rules, OUTPUT, MOVIE_STATUS, SLOT_STATUS]) assert.ok(Object.isFrozen(value));
});
