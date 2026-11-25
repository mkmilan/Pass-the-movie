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

test('direct uploads: five anonymous participants, authorization, retries, assembly and cleanup',
 {skip:process.env.PTM_INTEGRATION_TEST!=='1',timeout:240000},async()=>{
  const suffix=randomUUID().replaceAll('-',''),dbName='ptm_test_'+suffix,bucket='ptm-test-'+suffix;
  const config=singleSceneConfig({...process.env,NODE_ENV:'test',HOST:'127.0.0.1',SINGLE_SCENE_DEV_ENABLED:'true',
    MONGODB_URI:'mongodb://127.0.0.1:27017/'+dbName+'?replicaSet=rs0&directConnection=true',R2_BUCKET:bucket,
    WEB_ORIGIN:'http://127.0.0.1:3000',API_ORIGIN:'http://127.0.0.1:4000'});
  const admin=new S3Client({endpoint:config.endpoint,region:'auto',forcePathStyle:true,credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  let storage,server,dir,created=false;
  try{
    await mongoose.connect(config.mongodbUri,{serverSelectionTimeoutMS:10000});
    const collections=sceneCollections(mongoose.connection.db);await ensureSceneIndexes(collections);
    await admin.send(new CreateBucketCommand({Bucket:bucket}));created=true;
    storage=createStorage(config);const worker=createSceneWorker({collections,storage});
    server=createApp({config,collections,client:mongoose.connection.getClient(),storage}).listen(0,'127.0.0.1');
    await once(server,'listening');const base='http://127.0.0.1:'+server.address().port+'/v1';
    function browser(){
      let cookie='',csrf='';
      return {
        call(path,body,key,extra={}){
          return fetch(base+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)}),
            headers:{Origin:config.webOrigin,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),
              ...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{}),...extra}});
        },
        async adopt(response){assert.ok(response.ok,await response.clone().text());const value=await response.json();
          if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
          if(value.csrfToken)csrf=value.csrfToken;return value;}
      };
    }
    const players=[browser(),browser(),browser(),browser(),browser()],anonymous=browser();
    const m=await players[0].adopt(await players[0].call('/movies',{adult:true})),path='/movies/'+m.publicId;
    const consent={version:'dev-1',adult:true,permissions:true,combineAndDownload:true,externalSharing:true};
    dir=await mkdtemp(join(tmpdir(),'ptm-direct-'));
    const file=join(dir,'scene.mp4'),badFile=join(dir,'short.mp4');
    for(const [f,t] of [[file,'3'],[badFile,'1']])execFileSync('ffmpeg',['-nostdin','-v','error','-y','-f','lavfi','-i','testsrc2=size=320x568:rate=30','-t',t,'-c:v','libx264','-threads','2','-an',f],{timeout:30000});
    const clip=await readFile(file),short=await readFile(badFile);
    const startPath=n=>path+'/scenes/'+n+'/upload/start',finishPath=n=>path+'/scenes/'+n+'/upload/complete';
    const body=(data,terms=consent)=>({bytes:data.length,type:'video/mp4',consent:terms});
    const first=players[0],wrong=randomUUID();
    assert.equal((await anonymous.call(startPath(1),body(clip),wrong)).status,401);
    assert.equal((await first.call(startPath(1),body(clip),wrong,{'X-CSRF-Token':'wrong'})).status,403);
    assert.equal((await first.call(startPath(1),{...body(clip),bytes:12582913},wrong)).status,413);
    assert.equal((await first.call(startPath(1),{...body(clip),type:'image/jpeg'},wrong)).status,422);
    assert.equal((await first.call(startPath(1),body(clip,{}),wrong)).status,422);
    assert.equal((await first.call(finishPath(1),{},wrong)).status,409);
    async function direct(b,n,data,{check=false}={}){
      const key=randomUUID(),start=await b.adopt(await b.call(startPath(n),body(data),key));
      assert.equal(start.status,'uploading');
      assert.equal(new URL(start.url).origin,config.endpoint);
      if(check){
        const missing=await b.call(finishPath(n),{},key);assert.equal(missing.status,409);assert.equal((await missing.json()).code,'UPLOAD_NOT_FOUND');
        const repeat=await b.adopt(await b.call(startPath(n),body(data),key));assert.equal(repeat.duplicate,true);
        assert.equal(new URL(repeat.url).pathname,new URL(start.url).pathname);
        assert.equal((await b.call(startPath(n),{...body(data),bytes:data.length+1},key)).status,409);
        assert.equal((await b.call(startPath(n),body(data),randomUUID())).status,409);
        assert.equal((await b.call(finishPath(n),{},randomUUID())).status,409);
      }
      const put=await fetch(start.url,{method:'PUT',headers:start.headers,body:data});
      assert.ok(put.ok,await put.text());
      const finished=await b.adopt(await b.call(finishPath(n),{},key));assert.equal(finished.status,'queued');
      const repeatFinish=await b.adopt(await b.call(finishPath(n),{},key));assert.equal(repeatFinish.duplicate,true);
      const persisted=await collections.movies.findOne({publicId:m.publicId});assert.ok(persisted.slots[n-1].rawETag);
      assert.equal(await worker.runOne(),true);
      return b.adopt(await b.call(path+'?slot='+n));
    }
    const rejected=await direct(first,1,short,{check:true});
    assert.equal(rejected.myScene.status,'retryable');assert.equal(rejected.myScene.errorCode,'MEDIA_DURATION');
    for(let n=1;n<=5;n++){
      const b=players[n-1];
      if(n>1){
        const previous=players[n-2],invite=await previous.adopt(await previous.call(path+'/invite?slot='+(n-1),{}));
        await b.adopt(await b.call(path+'/claim',{adult:true,inviteToken:invite.inviteToken}));
        const reference=await b.call(path+'/reference?slot='+n);assert.equal(reference.status,200);assert.match(reference.headers.get('content-type'),/image\/jpeg/);
        assert.equal((await previous.call(startPath(n),body(clip),randomUUID())).status,404);
      }
      const state=await direct(b,n,clip);
      assert.equal(state.myScene.status,'accepted');
      assert.equal(state.myScene.summary.frames,90);
    }
    assert.equal(await worker.runOne(),true);
    for(let i=0;i<5;i++){
      const result=await players[i].adopt(await players[i].call(path+'?slot='+(i+1)));
      assert.equal(result.status,'ready');assert.equal(result.final.frames,450);assert.equal(result.final.duration,15);
      const final=await players[i].call(path+'/final?slot='+(i+1));assert.equal(final.status,200);await final.arrayBuffer();
    }
    assert.equal((await anonymous.call(path+'/final')).status,401);
    const persisted=await collections.movies.findOne({publicId:m.publicId});
    const keys=(await admin.send(new ListObjectsV2Command({Bucket:bucket}))).Contents.map(o=>o.Key);
    assert.deepEqual(keys,[persisted.final.key]);
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));storage?.close();
    if(created){const list=await admin.send(new ListObjectsV2Command({Bucket:bucket}));for(const x of list.Contents||[])await admin.send(new DeleteObjectCommand({Bucket:bucket,Key:x.Key}));await admin.send(new DeleteBucketCommand({Bucket:bucket}));}
    admin.destroy();if(mongoose.connection.db?.databaseName===dbName)await mongoose.connection.db.dropDatabase();await mongoose.disconnect();if(dir)await rm(dir,{recursive:true,force:true});
  }
});
