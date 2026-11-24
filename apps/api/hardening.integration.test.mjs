import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import mongoose from 'mongoose';
import { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { singleSceneConfig } from '../../packages/server/single-scene-config.mjs';
import { sceneCollections, ensureSceneIndexes } from '../../packages/server/scene-db.mjs';
import { createStorage } from '../../packages/server/storage.mjs';
import { createApp } from './app.mjs';
import { reserveBudget,BUDGET } from '../../packages/server/budget.mjs';
import { GAME_RULES as R } from '../../packages/shared/rules.mjs';
import { createRetentionWorker } from '../worker/retention.mjs';
import { writeFile } from 'node:fs/promises';

const enabled=process.env.PTM_INTEGRATION_TEST==='1';
test('expiry, orphan reconciliation, atomic quotas and report intake', {skip:!enabled,timeout:180000},async()=>{
  const suffix=randomUUID().replaceAll('-',''),dbName='ptm_test_'+suffix,bucket='ptm-test-'+suffix;
  const config=singleSceneConfig({...process.env,NODE_ENV:'test',HOST:'127.0.0.1',SINGLE_SCENE_DEV_ENABLED:'true',MONGODB_URI:'mongodb://127.0.0.1:27017/'+dbName+'?replicaSet=rs0&directConnection=true',R2_BUCKET:bucket,WEB_ORIGIN:'http://127.0.0.1:3000',API_ORIGIN:'http://127.0.0.1:4000'});
  const admin=new S3Client({endpoint:config.endpoint,region:'auto',forcePathStyle:true,credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  let storage,server,dir,created=false;
  try{
    await mongoose.connect(config.mongodbUri,{serverSelectionTimeoutMS:10000});
    const c=sceneCollections(mongoose.connection.db),client=mongoose.connection.getClient();await ensureSceneIndexes(c);
    await admin.send(new CreateBucketCommand({Bucket:bucket}));created=true;storage=createStorage(config);
    let now=new Date();const clock=()=>new Date(now);
    server=createApp({config,collections:c,client,storage,now:clock}).listen(0,'127.0.0.1');await once(server,'listening');
    const base='http://127.0.0.1:'+server.address().port+'/v1';
    async function call(path,{method='GET',json,headers={}}={}){
      return fetch(base+path,{method,headers:{Origin:config.webOrigin,...(json===undefined?{}:{'Content-Type':'application/json'}),...headers},body:json===undefined?undefined:JSON.stringify(json)});
    }
    const response=await call('/movies',{method:'POST',json:{adult:true}});
    assert.equal(response.status,201);const cookie=response.headers.get('set-cookie').split(';')[0],data=await response.json();
    const doc=await c.movies.findOne({publicId:data.publicId});
    const day='day:'+now.toISOString().slice(0,10);
    // Two concurrent callers compete for the last daily creation allowance.
    await c.budgets.updateOne({_id:day},{$set:{movies:BUDGET.moviesPerDay-1}});
    const starts=await Promise.all([call('/movies',{method:'POST',json:{adult:true}}),call('/movies',{method:'POST',json:{adult:true}})]);
    assert.deepEqual(starts.map(r=>r.status).sort(),[201,429]);
    assert.equal((await c.budgets.findOne({_id:day})).movies,BUDGET.moviesPerDay);
    // Upload reservations are charged inside a transaction. Exactly one
    // succeeds when the daily allowance can cover only one more maximum clip.
    await c.budgets.updateOne({_id:day},{$set:{bytes:BUDGET.dailyUploadBytes-R.maxUploadBytes}});
    async function reserve(){
      const session=client.startSession();
      try{await session.withTransaction(()=>reserveBudget(c,session,'upload',clock()));return 'ok';}
      catch(e){return e.code;}finally{await session.endSession();}
    }
    assert.deepEqual((await Promise.all([reserve(),reserve()])).sort(),['DAILY_UPLOAD_LIMIT','ok']);
    assert.equal((await c.budgets.findOne({_id:day})).bytes,BUDGET.dailyUploadBytes);
    const report=await call('/reports',{method:'POST',json:{movieId:data.publicId,reason:'privacy'}});
    assert.equal(report.status,201);const receipt=await report.json();
    assert.equal(receipt.status,'received');
    assert.equal((await c.reports.findOne({reportId:receipt.reportId})).reason,'privacy');
    assert.equal((await call('/reports',{method:'POST',json:{movieId:'https://example.org/#secret',reason:'privacy'}})).status,422);
    assert.equal((await call('/reports',{method:'POST',json:{reason:'other',text:'personal information'}})).status,422);
    assert.equal((await call('/reports',{method:'POST',json:{movieId:randomUUID(),reason:'other'}})).status,201);
    assert.equal((await call('/reports',{method:'POST',json:{reason:'abuse'}})).status,201);
    assert.equal((await call('/reports',{method:'POST',json:{reason:'abuse'}})).status,429);
    dir=await mkdtemp(join(tmpdir(),'ptm-retention-test-'));const dummy=join(dir,'dummy.mp4');await writeFile(dummy,Buffer.from('synthetic retention fixture'));
    const live='movies/'+data.publicId+'/raw/1/current.clip',orphan='movies/'+data.publicId+'/raw/1/old.clip',unknown='movies/'+randomUUID()+'/raw/1/unknown.clip';
    await Promise.all([storage.put(live,dummy,'video/mp4'),storage.put(orphan,dummy,'video/mp4'),storage.put(unknown,dummy,'video/mp4')]);
    await c.movies.updateOne({_id:doc._id},{$set:{'slots.0.rawKey':live}});
    const retention=createRetentionWorker({collections:c,storage,now:clock});
    now=new Date(now.getTime()+3600001);
    await retention.reconcilePage();
    assert.deepEqual((await storage.listPage()).objects.map(o=>o.key),[live]);
    assert.equal((await call('/movies/'+data.publicId,{headers:{Cookie:cookie}})).status,200);
    // Access expires at the deadline even before the worker gets to cleanup.
    now=new Date(doc.expiresAt);
    assert.equal((await call('/movies/'+data.publicId,{headers:{Cookie:cookie}})).status,410);
    await retention.expire();
    assert.equal((await c.movies.findOne({_id:doc._id})).status,'expired');
    // Another empty movie can be due at the same moment: drain due work.
    for(let i=0;i<5;i++)if(!await retention.cleanOne())break;
    assert.equal((await storage.listPage()).objects.length,0);
    now=new Date(now.getTime()+600001);
    for(let i=0;i<5;i++)if(!await retention.cleanOne())break;
    const expired=await c.movies.findOne({_id:doc._id});
    assert.equal(expired.status,'expired');assert.equal(expired.slots,undefined);
    assert.equal(await c.grants.countDocuments({movieId:doc._id}),0);
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));
    storage?.close();
    if(created){
      const list=await admin.send(new ListObjectsV2Command({Bucket:bucket}));
      for(const x of list.Contents||[])await admin.send(new DeleteObjectCommand({Bucket:bucket,Key:x.Key}));
      await admin.send(new DeleteBucketCommand({Bucket:bucket}));
    }
    admin.destroy();
    if(mongoose.connection.db?.databaseName===dbName)await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
    if(dir)await rm(dir,{recursive:true,force:true});
  }
});
