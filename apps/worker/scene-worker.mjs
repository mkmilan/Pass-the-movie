import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaProcessor, MediaError } from './media.mjs';

const MAX_ATTEMPTS=3, LEASE_MS=240000;
const permanent=new Set(['MEDIA_INVALID','MEDIA_UNSUPPORTED','MEDIA_DURATION','MEDIA_AV_OFFSET','MEDIA_TOO_LARGE']);
const updateScope=(movie,t)=>({_id:movie._id,revision:movie.revision,status:'collecting',activeSlot:1,expiresAt:{$gt:t},'slots.0.status':'queued','slots.0.generation':movie.work.generation,'work.jobId':movie.work.jobId,'work.leaseId':movie.work.leaseId,'work.status':'running','work.leaseUntil':{$gt:t}});
export function createSceneWorker({collections:{movies},storage,media=createMediaProcessor(),now=()=>new Date()}) {
  async function claim() {
    const t=now(),leaseId=randomUUID();
    return movies.findOneAndUpdate({status:'collecting',activeSlot:1,expiresAt:{$gt:t},'slots.0.status':'queued','work.type':'normalize','work.slot':1,'work.attempt':{$lt:MAX_ATTEMPTS},$or:[{'work.status':'pending','work.nextRunAt':{$lte:t}},{'work.status':'running','work.leaseUntil':{$lte:t}}]},{$set:{'work.status':'running','work.leaseId':leaseId,'work.leaseUntil':new Date(t.getTime()+LEASE_MS)},$inc:{'work.attempt':1,revision:1}},{sort:{'work.nextRunAt':1},returnDocument:'after'});
  }
  async function cleanOne() {
    const m=await movies.findOne({'cleanupPending.0':{$exists:true}});
    if(!m)return;
    for(const key of m.cleanupPending.slice(0,10)){
      try{await storage.remove(key);await movies.updateOne({_id:m._id},{$pull:{cleanupPending:key}});}
      catch{console.warn('SCENE_CLEANUP_RETRY');}
    }
  }
  async function sweep() {
    const t=now(),stale=new Date(t.getTime()-120000);
    // A timed-out upload reservation is invalidated. Its unique key cannot
    // overwrite a newer take; late writes still require orphan reconciliation.
    const abandoned=await movies.find({status:'collecting',activeSlot:1,'slots.0.status':'uploading','slots.0.uploadStartedAt':{$lte:stale}}).limit(10).toArray();
    for(const m of abandoned){
      const raw=m.slots[0].rawKey;if(!raw)continue;
      await movies.updateOne({_id:m._id,revision:m.revision,'slots.0.status':'uploading'},{$set:{'slots.0.status':'retryable','slots.0.rawKey':null,'slots.0.errorCode':'UPLOAD_INTERRUPTED'},$addToSet:{cleanupPending:raw},$inc:{revision:1}});
    }
    const exhausted=await movies.find({status:'collecting',activeSlot:1,'slots.0.status':'queued','work.status':'running','work.attempt':{$gte:MAX_ATTEMPTS},'work.leaseUntil':{$lte:t}}).limit(10).toArray();
    for(const m of exhausted){
      const raw=m.slots[0].rawKey;if(!raw)continue;
      await movies.updateOne({_id:m._id,revision:m.revision,'work.leaseId':m.work.leaseId,'work.leaseUntil':{$lte:t}},{$set:{'slots.0.status':'retryable','slots.0.rawKey':null,'slots.0.errorCode':'MEDIA_PROCESSING_RETRY',work:null},$addToSet:{cleanupPending:raw},$inc:{revision:1}});
    }
    await cleanOne();
  }
  async function runOne() {
    await sweep();
    const m=await claim();if(!m)return false;
    const raw=m.slots[0].rawKey,job=m.work,base='movies/'+m.publicId+'/',suffix=job.jobId+'/'+job.leaseId;
    const normalizedKey=base+'normalized/1/'+suffix+'.mp4',lastFrameKey=base+'frames/1/'+suffix+'.jpg';
    let dir,accepted=false,lost=false,heartbeatBusy=false;
    const heartbeat=setInterval(async()=>{
      if(heartbeatBusy||lost)return;
      heartbeatBusy=true;
      try{
        const t=now(),r=await movies.updateOne(updateScope(m,t),{$set:{'work.leaseUntil':new Date(t.getTime()+LEASE_MS)}});
        if(r.matchedCount!==1)lost=true;
      }catch{lost=true;}finally{heartbeatBusy=false;}
    },20000);
    heartbeat.unref();
    try{
      if(!raw)throw new Error('RAW_OBJECT_MISSING');
      dir=await mkdtemp(join(tmpdir(),'ptm-normalize-'));
      const input=join(dir,'raw.clip');await storage.get(raw,input);
      if(lost)throw new Error('LEASE_LOST');
      const out=await media.normalizeScene(input,dir);
      if(lost)throw new Error('LEASE_LOST');
      await storage.put(normalizedKey,out.scene,'video/mp4');
      if(lost)throw new Error('LEASE_LOST');
      await storage.put(lastFrameKey,out.still,'image/jpeg');
      if(lost)throw new Error('LEASE_LOST');
      const t=now();
      const commit=await movies.updateOne(updateScope(m,t),{$set:{
        'slots.0.status':'accepted','slots.0.acceptedAt':t,'slots.0.normalizedKey':normalizedKey,'slots.0.lastFrameKey':lastFrameKey,'slots.0.mediaSummary':out.summary,'slots.0.rawKey':null,'slots.0.errorCode':null,
        'slots.1.status':'open',activeSlot:2,work:null
      },$addToSet:{cleanupPending:raw},$inc:{revision:1}});
      accepted=commit.modifiedCount===1;
    }catch(e){
      const code=e instanceof MediaError?e.code:'MEDIA_PROCESSING_RETRY';
      const t=now();
      if(!lost){
        if(!permanent.has(code)&&job.attempt<MAX_ATTEMPTS){
          await movies.updateOne(updateScope(m,t),{$set:{'work.status':'pending','work.leaseId':null,'work.leaseUntil':null,'work.nextRunAt':new Date(t.getTime()+1000*2**job.attempt),'work.lastErrorCode':code},$inc:{revision:1}});
        }else{
          const patch={$set:{'slots.0.status':'retryable','slots.0.errorCode':code,'slots.0.rawKey':null,work:null},$inc:{revision:1}};
          if(raw)patch.$addToSet={cleanupPending:raw};
          await movies.updateOne(updateScope(m,t),patch);
        }
      }
    }finally{
      clearInterval(heartbeat);
      if(!accepted){
        // Do not delete an output if the commit response was lost after success.
        // Check the database first; if unavailable, leave unique keys for reconciliation.
        try{
          const current=await movies.findOne({_id:m._id});
          for(const key of [normalizedKey,lastFrameKey]){
            if(current?.slots[0].normalizedKey===key||current?.slots[0].lastFrameKey===key)continue;
            try{await storage.remove(key);}catch{if(current)await movies.updateOne({_id:m._id},{$addToSet:{cleanupPending:key}});}
          }
        }catch{console.warn('SCENE_OUTPUT_RECONCILIATION_REQUIRED');}
      }
      if(dir)await rm(dir,{recursive:true,force:true});
    }
    await cleanOne();
    return true;
  }
  return {runOne};
}
