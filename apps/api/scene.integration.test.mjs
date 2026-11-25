import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import mongoose from 'mongoose';
import { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { singleSceneConfig } from '../../packages/server/single-scene-config.mjs';
import { sceneCollections, ensureSceneIndexes } from '../../packages/server/scene-db.mjs';
import { createStorage } from '../../packages/server/storage.mjs';
import { createApp } from './app.mjs';
import { createSceneWorker } from '../worker/scene-worker.mjs';

const enabled=process.env.PTM_INTEGRATION_TEST==='1';
test('local MongoDB and private object store: authenticated upload through verified acceptance', {skip:!enabled,timeout:180000}, async()=>{
  const suffix=randomUUID().replaceAll('-',''),dbName='ptm_test_'+suffix,bucket='ptm-test-'+suffix;
  const config=singleSceneConfig({...process.env,NODE_ENV:'test',HOST:'127.0.0.1',SINGLE_SCENE_DEV_ENABLED:'true',MONGODB_URI:'mongodb://127.0.0.1:27017/'+dbName+'?replicaSet=rs0&directConnection=true',R2_BUCKET:bucket,WEB_ORIGIN:'http://127.0.0.1:3000',API_ORIGIN:'http://127.0.0.1:4000'});
  assert.ok(config);
  const admin=new S3Client({endpoint:config.endpoint,region:'auto',forcePathStyle:true,credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  let storage,server,dir,created=false;
  try{
    await mongoose.connect(config.mongodbUri,{serverSelectionTimeoutMS:10000});
    const collections=sceneCollections(mongoose.connection.db);await ensureSceneIndexes(collections);
    await admin.send(new CreateBucketCommand({Bucket:bucket}));created=true;
    storage=createStorage(config);await storage.ready();
    const worker=createSceneWorker({collections,storage});
    server=createApp({config,collections,client:mongoose.connection.getClient(),storage}).listen(0,'127.0.0.1');
    await once(server,'listening');const base='http://127.0.0.1:'+server.address().port+'/v1';
    let cookie='',csrf='';
    async function call(path,{method='GET',body,headers={},auth=true,origin=config.webOrigin}={}){
      return fetch(base+path,{method,body,headers:{Origin:origin,...(auth&&cookie?{Cookie:cookie}:{}),...(auth&&csrf?{'X-CSRF-Token':csrf}:{}),...headers}});
    }
    const json={'Content-Type':'application/json'};
    assert.equal((await call('/movies',{method:'POST',headers:json,body:'{"adult":true}',origin:'https://example.org'})).status,403);
    assert.equal((await call('/movies',{method:'POST',headers:json,body:'{}'})).status,422);
    const start=await call('/movies',{method:'POST',headers:json,body:'{"adult":true}'});
    assert.equal(start.status,201);cookie=start.headers.get('set-cookie').split(';')[0];
    assert.match(start.headers.get('set-cookie'),/HttpOnly/i);
    const data=await start.json();csrf=data.csrfToken;
    assert.equal(data.scene1.status,'claimed');assert.equal(data.slots.length,5);
    const url='/movies/'+data.publicId;
    assert.equal((await call(url,{auth:false})).status,401);
    assert.equal((await call(url)).status,200);
    assert.equal((await call(url+'/access',{method:'POST',auth:false,headers:json,body:JSON.stringify({personalToken:'wrong'})})).status,404);
    const recovery=await call(url+'/access',{method:'POST',auth:false,headers:json,body:JSON.stringify({personalToken:data.personalToken})});
    assert.equal(recovery.status,200);
    const recovered=await recovery.json();
    assert.equal(recovered.publicId,data.publicId);
    assert.equal((await call(url+'/scenes/1/upload',{method:'POST',headers:{'X-CSRF-Token':'wrong'}})).status,403);
    const dbMovie=await collections.movies.findOne({publicId:data.publicId});
    const grant=await collections.grants.findOne({movieId:dbMovie._id});
    assert.notEqual(grant.capabilityHash,data.personalToken);
    assert.ok(!JSON.stringify(dbMovie).includes(data.personalToken));
    dir=await mkdtemp(join(tmpdir(),'ptm-scene-integration-'));
    const good=join(dir,'good.mp4'),short=join(dir,'short.mp4');
    for(const [file,duration] of [[good,'3'],[short,'1']]){
      execFileSync('ffmpeg',['-nostdin','-v','error','-y','-f','lavfi','-i','testsrc2=size=320x568:rate=25','-t',duration,'-c:v','libx264','-threads','2','-an',file],{timeout:30000});
    }
    const consent={version:'dev-1',adult:true,permissions:true,combineAndDownload:true,externalSharing:true};
    async function upload(path,key,terms=consent){
      const form=new FormData();form.set('consent',JSON.stringify(terms));form.set('clip',new Blob([await readFile(path)],{type:'video/mp4'}),'scene.mp4');
      return call(url+'/scenes/1/upload',{method:'POST',body:form,headers:{'Idempotency-Key':key}});
    }
    const bad=await upload(short,randomUUID());
    assert.equal(bad.status,202,await bad.clone().text());assert.equal(await worker.runOne(),true);
    let state=await (await call(url)).json();assert.equal(state.scene1.status,'retryable');assert.equal(state.scene1.errorCode,'MEDIA_DURATION');
    const key=randomUUID(),submitted=await upload(good,key);
    assert.equal(submitted.status,202,await submitted.clone().text());
    const repeated=await upload(good,key);assert.equal(repeated.status,202);assert.equal((await repeated.json()).duplicate,true);
    const conflict=await upload(good,randomUUID());assert.equal(conflict.status,409);
    const workers=await Promise.all([worker.runOne(),worker.runOne()]);
    assert.equal(workers.filter(Boolean).length,1);
    state=await (await call(url)).json();assert.equal(state.scene1.status,'accepted');assert.equal(state.activeSlot,2);assert.equal(state.slots[1].status,'open');assert.equal(state.scene1.summary.frames,90);
    assert.equal((await call(url+'/reference')).status,404);assert.equal((await call(url+'/final')).status,404);
    const persisted=await collections.movies.findOne({publicId:data.publicId});
    assert.equal(persisted.work,null);assert.equal(persisted.slots[0].rawKey,null);assert.equal(persisted.cleanupPending.length,0);
    assert.ok(persisted.slots[0].normalizedKey&&persisted.slots[0].lastFrameKey);
    assert.ok(!JSON.stringify(state).includes(persisted.slots[0].normalizedKey));
    const keys=(await admin.send(new ListObjectsV2Command({Bucket:bucket}))).Contents.map(x=>x.Key).sort();
    assert.deepEqual(keys,[persisted.slots[0].normalizedKey,persisted.slots[0].lastFrameKey].sort());
    await collections.movies.updateOne({_id:persisted._id},{$set:{expiresAt:new Date(Date.now()-1000)}});
    assert.equal((await call(url)).status,410);
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
