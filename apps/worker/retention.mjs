import { randomUUID } from 'node:crypto';

const DAY=86400000, QUIET_MS=10*60*1000, TOMBSTONE_MS=7*DAY, LEASE_MS=5*60*1000, ORPHAN_AGE=60*60*1000;
const liveStates=['collecting','assembling','ready','failed'];
const terminalStates=['deleting','deleted','expired'];

export function deletionPatch(now,status='deleting'){
  if(!['deleting','expired'].includes(status))throw new Error('DELETION_STATUS_INVALID');
  return {$set:{status,activeSlot:null,work:null,cleanup:{status:'pending',nextRunAt:now,attempt:0}},$inc:{revision:1}};
}
// Protect every referenced object and every possible output of the current lease,
// including files uploaded before the acceptance/publication CAS.
export function protectedKeys(movie){
  const keys=new Set();
  for(const s of movie?.slots||[])for(const field of ['rawKey','normalizedKey','lastFrameKey'])if(s[field])keys.add(s[field]);
  if(movie?.final?.key)keys.add(movie.final.key);
  const w=movie?.work;
  if(w?.status==='running'&&w.jobId&&w.leaseId){
    const base='movies/'+movie.publicId+'/',suffix=w.jobId+'/'+w.leaseId;
    if(w.type==='normalize'){
      keys.add(base+'normalized/'+w.slot+'/'+suffix+'.mp4');
      keys.add(base+'frames/'+w.slot+'/'+suffix+'.jpg');
    }else if(w.type==='assemble')keys.add(base+'final/'+suffix+'.mp4');
  }
  return keys;
}

export function createRetentionWorker({collections:{movies,grants,sessions},storage,now=()=>new Date()}){
  let cursor=null;
  async function expire(){
    const t=now();
    await movies.updateMany({status:{$in:liveStates},expiresAt:{$lte:t}},deletionPatch(t,'expired'));
  }
  async function revoke(m){
    await grants.updateMany({movieId:m._id},{$set:{status:'revoked'}});
  }
  async function clearGrants(m){
    // Iterate bounded pages so a large number of replaced grants does not
    // create an unbounded MongoDB update or retain unnecessary identifiers.
    for(let i=0;i<20;i++){
      const page=await grants.find({movieId:m._id},{projection:{grantId:1}}).limit(100).toArray();
      if(!page.length)return;
      const ids=page.map(g=>g.grantId);
      await sessions.updateMany({grantIds:{$in:ids}},{$pull:{grantIds:{$in:ids}}});
      await grants.deleteMany({movieId:m._id,grantId:{$in:ids}});
    }
    if(await grants.countDocuments({movieId:m._id}))throw new Error('GRANT_CLEANUP_MORE');
  }
  async function removePrefix(prefix){
    let found=false;
    // Always re-list the first page after deletions. This avoids skipping
    // keys when a storage implementation invalidates continuation positions.
    for(let i=0;i<20;i++){
      const page=await storage.listPage({prefix});
      if(!page.objects.length){if(page.cursor)throw new Error('STORAGE_PAGE_INVALID');return found;}
      found=true;
      for(const {key} of page.objects)await storage.remove(key);
    }
    const remaining=await storage.listPage({prefix});
    if(remaining.objects.length||remaining.cursor)throw new Error('PREFIX_CLEANUP_MORE');
    return found;
  }
  async function cleanOne(){
    const t=now(),lease=randomUUID();
    const m=await movies.findOneAndUpdate({
      status:{$in:terminalStates},
      $or:[
        {'cleanup.status':{$in:['pending','tombstone']},'cleanup.nextRunAt':{$lte:t}},
        {'cleanup.status':'running','cleanup.leaseUntil':{$lte:t}}
      ]
    },{$set:{'cleanup.status':'running','cleanup.leaseId':lease,'cleanup.leaseUntil':new Date(t.getTime()+LEASE_MS)},$inc:{'cleanup.attempt':1}},
    {sort:{'cleanup.nextRunAt':1},returnDocument:'after'});
    if(!m)return false;
    const scope={_id:m._id,status:{$in:terminalStates},'cleanup.status':'running','cleanup.leaseId':lease};
    try{
      await revoke(m);
      const found=await removePrefix('movies/'+m.publicId+'/'),at=now();
      const alreadyScrubbed=!!m.purgeAt;
      if(alreadyScrubbed){
        // A late object resets the tombstone horizon. Re-check before purging.
        if(!found&&m.purgeAt<=at){
          await clearGrants(m);
          await movies.deleteOne(scope);
        }else{
          const purgeAt=found?new Date(at.getTime()+TOMBSTONE_MS):m.purgeAt;
          await movies.updateOne(scope,{$set:{purgeAt,cleanup:{status:'tombstone',nextRunAt:new Date(Math.min(purgeAt.getTime(),at.getTime()+DAY)),attempt:0}},$unset:{cleanupPending:''}});
        }
      }else if(found||!m.cleanup.emptySince||at.getTime()-m.cleanup.emptySince.getTime()<QUIET_MS){
        // Leave a quiet interval for bounded in-flight uploads/encodes to finish.
        const emptySince=found||!m.cleanup.emptySince?at:m.cleanup.emptySince;
        await movies.updateOne(scope,{$set:{cleanup:{status:'pending',emptySince,nextRunAt:new Date(emptySince.getTime()+QUIET_MS),attempt:0}},$unset:{cleanupPending:''}});
      }else{
        await clearGrants(m);
        // After storage is empty on two separated checks, retain only a
        // minimal ID and cleanup schedule, not consent or participant data.
        await movies.updateOne(scope,{$set:{status:m.status==='expired'?'expired':'deleted',purgeAt:new Date(at.getTime()+TOMBSTONE_MS),cleanup:{status:'tombstone',nextRunAt:new Date(at.getTime()+DAY),attempt:0}},
          $unset:{slots:'',creatorGrantId:'',createdAt:'',expiresAt:'',readyAt:'',final:'',work:'',cleanupPending:'',activeSlot:'',revision:'',schemaVersion:''}});
      }
    }catch{
      const delay=Math.min(DAY,30000*2**Math.min(m.cleanup.attempt,10));
      await movies.updateOne(scope,{$set:{'cleanup.status':m.purgeAt?'tombstone':'pending','cleanup.nextRunAt':new Date(now().getTime()+delay),'cleanup.lastError':'CLEANUP_RETRY'},$unset:{'cleanup.leaseId':'','cleanup.leaseUntil':''}});
      console.warn('MOVIE_CLEANUP_RETRY');
    }
    return true;
  }
  async function reconcilePage(){
    // Periodic, bounded orphan sweep. Unknown or stale keys are not removed
    // until old enough; re-read the movie for each key to protect live work.
    const page=await storage.listPage({cursor});
    const cutoff=now().getTime()-ORPHAN_AGE;
    for(const object of page.objects){
      if(!(object.lastModified instanceof Date)||!Number.isFinite(object.lastModified.getTime())||object.lastModified.getTime()>cutoff)continue;
      const id=object.key.split('/')[1];
      const m=await movies.findOne({publicId:id});
      if(m&&liveStates.includes(m.status)&&protectedKeys(m).has(object.key))continue;
      // Terminal cleanup is handled by the prefix pass and its tombstone.
      if(m&&terminalStates.includes(m.status))continue;
      await storage.remove(object.key);
    }
    cursor=page.cursor;
  }
  async function tick(){
    await expire();
    await cleanOne();
    await reconcilePage();
  }
  return {expire,cleanOne,reconcilePage,tick};
}
