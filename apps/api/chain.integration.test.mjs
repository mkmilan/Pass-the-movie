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
import { createSceneWorker } from '../worker/scene-worker.mjs';

const enabled=process.env.PTM_INTEGRATION_TEST==='1';
test('five-scene chain: invitation races, replacement, expiry, private references and assembly handoff', {skip:!enabled,timeout:240000}, async()=>{
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
    let now=new Date();const clock=()=>new Date(now);
    const worker=createSceneWorker({collections,storage,now:clock});
    server=createApp({config,collections,client:mongoose.connection.getClient(),storage,now:clock}).listen(0,'127.0.0.1');
    await once(server,'listening');const base='http://127.0.0.1:'+server.address().port+'/v1';
    const makeBrowser=()=>{
      let cookie='',csrf='',slot;
      return {
        async call(path,{method='GET',json,body,headers={},select=false}={}){
          const url=base+path+(select&&slot?'?slot='+slot:'');
          const res=await fetch(url,{method,body:json===undefined?body:JSON.stringify(json),headers:{Origin:config.webOrigin,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(json===undefined?{}:{'Content-Type':'application/json'}),...headers}});
          return res;
        },
        async adopt(res){assert.ok(res.ok,await res.clone().text());const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const data=await res.json();if(data.csrfToken)csrf=data.csrfToken;if(data.mySlot)slot=data.mySlot;return data;},
        get slot(){return slot;}
      };
    };
    const creator=makeBrowser(),anonymous=makeBrowser();
    const createdMovie=await creator.adopt(await creator.call('/movies',{method:'POST',json:{adult:true}}));
    const path='/movies/'+createdMovie.publicId;
    const state=async b=>b.adopt(await b.call(path,{select:true}));
    const invite=async b=>b.adopt(await b.call(path+'/invite',{method:'POST',select:true,json:{}}));
    const claim=(b,token)=>b.call(path+'/claim',{method:'POST',json:{adult:true,inviteToken:token}});
    const reference=(b)=>b.call(path+'/reference',{select:true});
    const replace=(b)=>b.call(path+'/replace-turn',{method:'POST',select:true,json:{confirm:true}});
    assert.equal((await creator.call(path+'/invite',{method:'POST',json:{}})).status,409);
    assert.equal((await anonymous.call(path)).status,401);
    assert.equal((await anonymous.call(path+'/reference')).status,401);
    dir=await mkdtemp(join(tmpdir(),'ptm-chain-integration-'));
    const clips=[];
    for(const [i,color] of ['red','green','blue','yellow','purple'].entries()){
      const file=join(dir,'scene-'+(i+1)+'.mp4');
      execFileSync('ffmpeg',['-nostdin','-v','error','-y','-f','lavfi','-i','color=c='+color+':s=320x568:r=25','-t','3','-c:v','libx264','-threads','2','-an',file],{timeout:30000});
      clips.push(await readFile(file));
    }
    const consent={version:'dev-1',adult:true,permissions:true,combineAndDownload:true,externalSharing:true};
    async function upload(b,n,key=randomUUID()){
      const form=new FormData();form.set('consent',JSON.stringify(consent));form.set('clip',new Blob([clips[n-1]||clips[0]],{type:'video/mp4'}),'scene.mp4');
      return b.call(path+'/scenes/'+n+'/upload',{method:'POST',body:form,headers:{'Idempotency-Key':key}});
    }
    async function checkReference(b,n){
      const res=await reference(b);assert.equal(res.status,200,await res.clone().text());assert.match(res.headers.get('content-type'),/image\/jpeg/);assert.match(res.headers.get('cache-control'),/no-store/);
      const movie=await collections.movies.findOne({publicId:createdMovie.publicId});
      const stored=await admin.send(new GetObjectCommand({Bucket:bucket,Key:movie.slots[n-2].lastFrameKey}));
      assert.deepEqual(Buffer.from(await res.arrayBuffer()),Buffer.from(await stored.Body.transformToByteArray()));
    }
    async function acceptScene(b,n){
      const key=randomUUID(),res=await upload(b,n,key);
      assert.equal(res.status,202,await res.clone().text());
      const repeated=await upload(b,n,key);assert.equal(repeated.status,202);assert.equal((await repeated.json()).duplicate,true);
      assert.equal(await worker.runOne(),true);
      const data=await state(b);assert.equal(data.mySlot,n);assert.equal(data.myScene.status,'accepted');
      assert.equal(data.activeSlot,n===5?null:n+1);
      assert.equal(data.slots.filter(s=>s.status==='accepted').length,n);
      assert.equal((await reference(b)).status,404);
      return data;
    }
    await acceptScene(creator,1);
    // Rotating an unclaimed token makes the old link invalid.
    const oldLink=await invite(creator),freshLink=await invite(creator);
    assert.notEqual(oldLink.inviteToken,freshLink.inviteToken);
    assert.equal((await claim(makeBrowser(),oldLink.inviteToken)).status,404);
    const contenders=[makeBrowser(),makeBrowser()];
    const results=await Promise.all(contenders.map(b=>claim(b,freshLink.inviteToken)));
    assert.deepEqual(results.map(r=>r.status).sort(),[200,404]);
    const i=results.findIndex(r=>r.ok),oldContributor=contenders[i],firstClaim=await oldContributor.adopt(results[i]);
    assert.equal(firstClaim.mySlot,2);
    assert.equal((await claim(makeBrowser(),freshLink.inviteToken)).status,404);
    assert.equal((await claim(oldContributor,freshLink.inviteToken)).status,200);
    await checkReference(oldContributor,2);
    assert.equal((await reference(creator)).status,404);
    assert.equal((await upload(creator,2)).status,404);
    assert.equal((await oldContributor.call(path+'/invite',{method:'POST',json:{}})).status,409);
    const oldMovie=await collections.movies.findOne({publicId:createdMovie.publicId});
    // Replace a queued scene; the old job cannot accept it.
    assert.equal((await upload(oldContributor,2)).status,202);
    const reset=await replace(creator);assert.equal(reset.status,200);
    assert.equal((await oldContributor.call(path,{select:true})).status,404);
    assert.equal((await oldContributor.call(path+'/access',{method:'POST',json:{personalToken:firstClaim.personalToken}})).status,404);
    assert.equal(await worker.runOne(),false);
    let persisted=await collections.movies.findOne({publicId:createdMovie.publicId});
    assert.equal(persisted.slots[1].generation,oldMovie.slots[1].generation+1);
    assert.equal(persisted.slots[1].status,'open');
    assert.equal(persisted.work,null);
    // An idle claim expires and can be reissued; invite expiry is enforced separately.
    const expiredInvite=await invite(creator);
    now=new Date(now.getTime()+86400001);
    assert.equal((await claim(makeBrowser(),expiredInvite.inviteToken)).status,404);
    const idleBrowser=makeBrowser();await idleBrowser.adopt(await claim(idleBrowser,(await invite(creator)).inviteToken));
    now=new Date(now.getTime()+1800001);
    assert.equal((await idleBrowser.call(path,{select:true})).status,410);
    assert.equal(await worker.runOne(),false);
    assert.equal((await state(creator)).canInvite,true);
    const participants=[creator];
    for(let n=2;n<=5;n++){
      const prev=participants.at(-1),b=makeBrowser(),link=await invite(prev),claimed=await b.adopt(await claim(b,link.inviteToken));
      assert.equal(claimed.mySlot,n);assert.equal(claimed.scene1,undefined);
      assert.equal(claimed.canReference,true);
      await checkReference(b,n);
      const restored=makeBrowser();await restored.adopt(await restored.call(path+'/access',{method:'POST',json:{personalToken:claimed.personalToken}}));
      assert.equal(restored.slot,n);
      if(n===3){
        const rotated=await b.adopt(await b.call(path+'/access/rotate',{method:'POST',select:true,json:{}}));
        assert.equal((await makeBrowser().call(path+'/access',{method:'POST',json:{personalToken:claimed.personalToken}})).status,404);
        await makeBrowser().adopt(await makeBrowser().call(path+'/access',{method:'POST',json:{personalToken:rotated.personalToken}}));
      }
      await acceptScene(b,n);participants.push(b);
    }
    persisted=await collections.movies.findOne({publicId:createdMovie.publicId});
    assert.equal(persisted.status,'assembling');assert.equal(persisted.work.type,'assemble');assert.equal(persisted.work.status,'pending');
    assert.equal(persisted.slots.every(s=>s.status==='accepted'),true);
    assert.equal(await worker.runOne(),false);
    for(const b of participants){
      const data=await state(b);assert.equal(data.status,'assembling');assert.equal(data.canInvite,false);assert.equal(data.canReference,false);
      assert.equal((await b.call(path+'/final',{select:true})).status,404);
      assert.equal((await b.call(path+'/invite',{method:'POST',select:true,json:{}})).status,409);
      assert.equal((await b.call(path+'/scenes/6/upload',{method:'POST'})).status,404);
      assert.equal(JSON.stringify(data).includes('normalized/'),false);
    }
    const objects=(await admin.send(new ListObjectsV2Command({Bucket:bucket}))).Contents.map(x=>x.Key);
    assert.equal(objects.length,10);assert.equal(objects.some(k=>k.includes('/raw/')),false);
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
