import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GAME_RULES as R } from '../../packages/shared/rules.mjs';
import { createMediaProcessor, MediaError } from './media.mjs';

const MAX_ATTEMPTS=3,LEASE_MS=240000;
const scope=(m,t)=>({_id:m._id,revision:m.revision,status:'assembling',activeSlot:null,expiresAt:{$gt:t},'work.type':'assemble','work.status':'running','work.jobId':m.work.jobId,'work.leaseId':m.work.leaseId,'work.leaseUntil':{$gt:t}});
export function createAssemblyWorker({collections:{movies},storage,media=createMediaProcessor(),now=()=>new Date()}){
  async function runOne(){
    const t=now();
    // Exhausted leases cannot leave a movie waiting forever.
    await movies.updateMany({status:'assembling','work.type':'assemble','work.status':'running','work.attempt':{$gte:MAX_ATTEMPTS},'work.leaseUntil':{$lte:t}},
      {$set:{status:'failed','work.status':'failed','work.leaseId':null,'work.leaseUntil':null,'work.lastErrorCode':'MOVIE_ASSEMBLY_RETRY'},$inc:{revision:1}});
    const m=await movies.findOneAndUpdate({status:'assembling',activeSlot:null,expiresAt:{$gt:t},'work.type':'assemble','work.attempt':{$lt:MAX_ATTEMPTS},$or:[{'work.status':'pending','work.nextRunAt':{$lte:t}},{'work.status':'running','work.leaseUntil':{$lte:t}}]},
      {$set:{'work.status':'running','work.leaseId':randomUUID(),'work.leaseUntil':new Date(t.getTime()+LEASE_MS)},$inc:{'work.attempt':1,revision:1}},{sort:{'work.nextRunAt':1},returnDocument:'after'});
    if(!m)return false;
    const key='movies/'+m.publicId+'/final/'+m.work.jobId+'/'+m.work.leaseId+'.mp4';
    let dir,published=false,lost=false,heartbeatBusy=false,attemptedPut=false;
    const controller=new AbortController(),processor=media.withSignal?.(controller.signal)||media;
    const loseLease=()=>{lost=true;controller.abort();};
    const heartbeat=setInterval(async()=>{
      if(heartbeatBusy||lost)return;
      heartbeatBusy=true;
      try{const at=now(),r=await movies.updateOne(scope(m,at),{$set:{'work.leaseUntil':new Date(at.getTime()+LEASE_MS)}});if(r.matchedCount!==1)loseLease();}
      catch{loseLease();}finally{heartbeatBusy=false;}
    },20000);heartbeat.unref();
    try{
      if(m.slots.length!==R.sceneCount||m.slots.some((s,i)=>s.number!==i+1||s.status!=='accepted'||!s.normalizedKey))throw new Error('ASSEMBLY_SOURCE_INVALID');
      dir=await mkdtemp(join(tmpdir(),'ptm-assemble-'));
      const inputs=[];
      for(const s of m.slots){
        const path=join(dir,'scene-'+s.number+'.mp4');await storage.get(s.normalizedKey,path);inputs.push(path);
        if(lost)throw new Error('LEASE_LOST');
      }
      const out=await processor.assembleMovie(inputs,dir);
      if(lost)throw new Error('LEASE_LOST');
      attemptedPut=true;await storage.put(key,out.final,'video/mp4');
      if(lost)throw new Error('LEASE_LOST');
      const at=now(),expiresAt=new Date(at.getTime()+R.readyLifetimeMs);
      const set={status:'ready',activeSlot:null,readyAt:at,expiresAt,final:{key,bytes:out.summary.bytes,duration:out.summary.duration,frames:out.summary.frames,publishedAt:at},work:null};
      const obsolete=[];
      for(const [i,s] of m.slots.entries()){
        for(const name of ['rawKey','normalizedKey','lastFrameKey']){
          if(s[name])obsolete.push(s[name]);
          set['slots.'+i+'.'+name]=null;
        }
      }
      const patch={$set:set,$inc:{revision:1}};
      if(obsolete.length)patch.$addToSet={cleanupPending:{$each:obsolete}};
      const result=await movies.updateOne(scope(m,at),patch);
      published=result.modifiedCount===1;
    }catch(e){
      const code=e instanceof MediaError?e.code:'MOVIE_ASSEMBLY_RETRY',at=now();
      if(!lost){
        const change=m.work.attempt<MAX_ATTEMPTS
          ? {'work.status':'pending','work.leaseId':null,'work.leaseUntil':null,'work.nextRunAt':new Date(at.getTime()+1000*2**m.work.attempt),'work.lastErrorCode':code}
          : {status:'failed','work.status':'failed','work.leaseId':null,'work.leaseUntil':null,'work.lastErrorCode':code};
        await movies.updateOne(scope(m,at),{$set:change,$inc:{revision:1}});
      }
    }finally{
      clearInterval(heartbeat);
      if(attemptedPut&&!published){
        // An ambiguous DB commit must not delete its successfully published object.
        try{
          const current=await movies.findOne({_id:m._id});
          if(current?.final?.key!==key){
            try{await storage.remove(key);}
            catch{if(current)await movies.updateOne({_id:m._id},{$addToSet:{cleanupPending:key}});}
          }
        }catch{console.warn('FINAL_OUTPUT_RECONCILIATION_REQUIRED');}
      }
      if(dir)await rm(dir,{recursive:true,force:true});
    }
    return true;
  }
  return {runOne};
}
