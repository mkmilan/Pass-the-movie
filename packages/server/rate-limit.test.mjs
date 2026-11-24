import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter,RateError } from './rate-limit.mjs';
import { protectedKeys,deletionPatch } from '../../apps/worker/retention.mjs';
test('local limits reset at their deadline and isolate categories',()=>{
  let t=0;const limiter=createRateLimiter({now:()=>new Date(t),capacity:4});
  limiter.check('upload','test-grant',2,1000);limiter.check('upload','test-grant',2,1000);
  assert.throws(()=>limiter.check('upload','test-grant',2,1000),e=>e instanceof RateError&&e.retryAfter===1);
  limiter.check('read','test-grant',2,1000);t=1000;limiter.check('upload','test-grant',2,1000);
});
test('limiter fails closed at bounded map capacity',()=>{
  let t=0;const limiter=createRateLimiter({now:()=>new Date(t),capacity:1});
  limiter.check('read','a',2,1000);
  assert.throws(()=>limiter.check('read','b',2,1000),RateError);
  t=1001;limiter.check('read','b',2,1000);
});
test('orphan reconciliation protects live inputs and current lease outputs',()=>{
  const base='movies/id/';
  const m={publicId:'id',slots:[{rawKey:base+'raw/1/input.clip'}],work:{status:'running',type:'normalize',slot:1,jobId:'job',leaseId:'lease'}};
  assert.deepEqual([...protectedKeys(m)].sort(),[base+'raw/1/input.clip',base+'normalized/1/job/lease.mp4',base+'frames/1/job/lease.jpg'].sort());
  assert.deepEqual([...protectedKeys({...m,work:null,slots:[],final:{key:base+'final/job/lease.mp4'}})],[base+'final/job/lease.mp4']);
  assert.equal(protectedKeys(null).size,0);
});
test('deletion atomically fences media work',()=>{
  const at=new Date(1000),patch=deletionPatch(at,'expired');
  assert.equal(patch.$set.status,'expired');assert.equal(patch.$set.work,null);assert.equal(patch.$inc.revision,1);
  assert.equal(patch.$set.cleanup.nextRunAt,at);assert.throws(()=>deletionPatch(at,'ready'));
});
