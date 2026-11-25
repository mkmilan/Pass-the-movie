import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaProcessor, MediaError } from './media.mjs';
import { activeSlot, slotPath, resetSlotPatch } from '../../packages/server/turns.mjs';
import { GAME_RULES as R } from '../../packages/shared/rules.mjs';
import { createAssemblyWorker } from './assembly-worker.mjs';

const MAX_ATTEMPTS=3, LEASE_MS=240000;
const permanent=new Set(['MEDIA_INVALID','MEDIA_UNSUPPORTED','MEDIA_DURATION','MEDIA_AV_OFFSET','MEDIA_TOO_LARGE']);
const updateScope=(movie,t)=>({_id:movie._id,revision:movie.revision,status:'collecting',activeSlot:movie.work.slot,expiresAt:{$gt:t},[slotPath(movie.work.slot)+'status']:'queued',[slotPath(movie.work.slot)+'generation']:movie.work.generation,'work.jobId':movie.work.jobId,'work.leaseId':movie.work.leaseId,'work.status':'running','work.leaseUntil':{$gt:t}});
export function createSceneWorker({collections:{movies,grants},storage,media=createMediaProcessor(),now=()=>new Date()}) {
  const assembly=createAssemblyWorker({collections:{movies},storage,media,now});
  async function claim() {
    const t=now(),leaseId=randomUUID();
    return movies.findOneAndUpdate({status:'collecting',activeSlot:{$gte:1,$lte:R.sceneCount},expiresAt:{$gt:t},'slots.status':'queued','work.type':'normalize',$expr:{$eq:['$activeSlot','$work.slot']},'work.attempt':{$lt:MAX_ATTEMPTS},$or:[{'work.status':'pending','work.nextRunAt':{$lte:t}},{'work.status':'running','work.leaseUntil':{$lte:t}}]},{$set:{'work.status':'running','work.leaseId':leaseId,'work.leaseUntil':new Date(t.getTime()+LEASE_MS)},$inc:{'work.attempt':1,revision:1}},{sort:{'work.nextRunAt':1},returnDocument:'after'});
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
    const abandoned=await movies.find({status:'collecting',slots:{$elemMatch:{status:'uploading',uploadStartedAt:{$lte:stale}}}}).limit(10).toArray();
    for(const m of abandoned){
      const slot=activeSlot(m),raw=slot?.rawKey;
      if(!raw||slot.status!=='uploading'||slot.uploadStartedAt>stale)continue;
      const p=slotPath(slot.number);
      await movies.updateOne({_id:m._id,revision:m.revision,status:'collecting',activeSlot:slot.number,[p+'status']:'uploading'},{$set:{[p+'status']:'retryable',[p+'rawKey']:null,[p+'rawETag']:null,[p+'errorCode']:'UPLOAD_INTERRUPTED'},$addToSet:{cleanupPending:raw},$inc:{revision:1}});
    }
    const exhausted=await movies.find({status:'collecting','work.type':'normalize','work.status':'running','work.attempt':{$gte:MAX_ATTEMPTS},'work.leaseUntil':{$lte:t}}).limit(10).toArray();
    for(const m of exhausted){
      const slot=activeSlot(m),raw=slot?.rawKey;if(!raw||slot.number!==m.work.slot||slot.status!=='queued')continue;
      const p=slotPath(slot.number);
      await movies.updateOne({_id:m._id,revision:m.revision,status:'collecting',activeSlot:slot.number,'work.leaseId':m.work.leaseId,'work.leaseUntil':{$lte:t}},{$set:{[p+'status']:'retryable',[p+'rawKey']:null,[p+'rawETag']:null,[p+'errorCode']:'MEDIA_PROCESSING_RETRY',work:null},$addToSet:{cleanupPending:raw},$inc:{revision:1}});
    }
    // An expired idle claim releases the turn; active uploads and queued work
    // retain their bounded processing reservation. Slot generation fences stale grants.
    const idle=await movies.find({status:'collecting',activeSlot:{$gte:2},expiresAt:{$gt:t},slots:{$elemMatch:{status:{$in:['claimed','retryable']},reservationUntil:{$lte:t}}}}).limit(10).toArray();
    for(const m of idle){
      const slot=activeSlot(m);
      if(!slot||!['claimed','retryable'].includes(slot.status)||!slot.reservationUntil||slot.reservationUntil>t)continue;
      const p=slotPath(slot.number),r=await movies.updateOne({_id:m._id,revision:m.revision,status:'collecting',activeSlot:slot.number,[p+'generation']:slot.generation,[p+'status']:slot.status,[p+'reservationUntil']:{$lte:t}},resetSlotPatch(m));
      if(r.modifiedCount===1&&slot.grantId)await grants.updateOne({movieId:m._id,grantId:slot.grantId,generation:slot.generation},{$set:{status:'revoked'}});
    }
    await cleanOne();
  }
  async function runOne() {
    await sweep();
    const m=await claim();if(!m){const didWork=await assembly.runOne();if(didWork)await cleanOne();return didWork;}
    const job=m.work,n=job.slot,p=slotPath(n),raw=m.slots[n-1].rawKey,base='movies/'+m.publicId+'/',suffix=job.jobId+'/'+job.leaseId;
    const normalizedKey=base+'normalized/'+n+'/'+suffix+'.mp4',lastFrameKey=base+'frames/'+n+'/'+suffix+'.jpg';
    let dir,accepted=false,lost=false,heartbeatBusy=false;
    const controller=new AbortController(),processor=media.withSignal?.(controller.signal)||media;
    const loseLease=()=>{lost=true;controller.abort();};
    const heartbeat=setInterval(async()=>{
      if(heartbeatBusy||lost)return;
      heartbeatBusy=true;
      try{
        const t=now(),r=await movies.updateOne(updateScope(m,t),{$set:{'work.leaseUntil':new Date(t.getTime()+LEASE_MS)}});
        if(r.matchedCount!==1)loseLease();
      }catch{loseLease();}finally{heartbeatBusy=false;}
    },20000);
    heartbeat.unref();
    try{
      if(!raw)throw new Error('RAW_OBJECT_MISSING');
      dir=await mkdtemp(join(tmpdir(),'ptm-normalize-'));
      const input=join(dir,'raw.clip');await storage.get(raw,input,{etag:m.slots[n-1].rawETag||undefined});
      if(lost)throw new Error('LEASE_LOST');
      const out=await processor.normalizeScene(input,dir);
      if(lost)throw new Error('LEASE_LOST');
      await storage.put(normalizedKey,out.scene,'video/mp4');
      if(lost)throw new Error('LEASE_LOST');
      await storage.put(lastFrameKey,out.still,'image/jpeg');
      if(lost)throw new Error('LEASE_LOST');
      const t=now();
      const next=n<R.sceneCount
        ? {[slotPath(n+1)+'status']:'open',activeSlot:n+1,work:null}
        : {status:'assembling',activeSlot:null,work:{jobId:randomUUID(),type:'assemble',slot:null,generation:null,status:'pending',attempt:0,nextRunAt:t,leaseId:null,leaseUntil:null,lastErrorCode:null}};
      const commit=await movies.updateOne(updateScope(m,t),{$set:{
        [p+'status']:'accepted',[p+'acceptedAt']:t,[p+'normalizedKey']:normalizedKey,[p+'lastFrameKey']:lastFrameKey,[p+'mediaSummary']:out.summary,[p+'rawKey']:null,[p+'rawETag']:null,[p+'errorCode']:null,...next
      },$addToSet:{cleanupPending:raw},$inc:{revision:1}});
      accepted=commit.modifiedCount===1;
    }catch(e){
      const code=e instanceof MediaError?e.code:'MEDIA_PROCESSING_RETRY';
      const t=now();
      if(!lost){
        if(!permanent.has(code)&&job.attempt<MAX_ATTEMPTS){
          await movies.updateOne(updateScope(m,t),{$set:{'work.status':'pending','work.leaseId':null,'work.leaseUntil':null,'work.nextRunAt':new Date(t.getTime()+1000*2**job.attempt),'work.lastErrorCode':code},$inc:{revision:1}});
        }else{
          const patch={$set:{[p+'status']:'retryable',[p+'errorCode']:code,[p+'rawKey']:null,[p+'rawETag']:null,work:null},$inc:{revision:1}};
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
            if(current?.slots?.[n-1].normalizedKey===key||current?.slots?.[n-1].lastFrameKey===key)continue;
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
