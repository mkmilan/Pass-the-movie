import { randomUUID, createHash } from 'node:crypto';
import { GAME_RULES as R } from '../../packages/shared/rules.mjs';
import { reserveBudget } from '../../packages/server/budget.mjs';
import { slotPath } from '../../packages/server/turns.mjs';
import { fail, consentSnapshot } from './scene-access.mjs';

// A signed upload is deliberately shorter than the worker's 120-second
// abandoned-upload deadline. No client-controlled storage keys or renewed leases.
const SIGN_MS=90000, COMPLETE_MS=120000;
function idempotency(req){
  const key=req.get('Idempotency-Key');
  if(typeof key!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(key))fail('IDEMPOTENCY_KEY_REQUIRED',422);
  return createHash('sha256').update(key).digest('hex');
}
function metadata(body){
  const {bytes,type}=body||{};
  if(!Number.isInteger(bytes)||bytes<12)fail('MEDIA_INVALID',422);
  if(bytes>R.maxUploadBytes)fail('MEDIA_TOO_LARGE',413);
  if(!['video/mp4','video/webm'].includes(type))fail('MEDIA_UNSUPPORTED',422);
  return {bytes,type};
}
export function createDirectUploader({collections:c,client,storage,now=()=>new Date(),onReserve=()=>{}}){
  const identity=(movie,grant)=>({_id:movie._id,status:'collecting',activeSlot:grant.slotNumber,
    [slotPath(grant.slotNumber)+'grantId']:grant.grantId,[slotPath(grant.slotNumber)+'generation']:grant.generation});
  async function sign(movie,n,slot,at){
    const end=new Date(Math.min(movie.expiresAt.getTime(),slot.uploadStartedAt.getTime()+SIGN_MS));
    if(end<=at)fail('UPLOAD_LINK_EXPIRED',409);
    return {status:'uploading',...(await storage.signWrite(slot.rawKey,{movieId:movie.publicId,slot:n,
      bytes:slot.directUpload.bytes,type:slot.directUpload.type,expiresAt:end,now:at}))};
  }
  async function start(req,{movie,grant}){
    const hash=idempotency(req),n=grant.slotNumber,p=slotPath(n),s=movie.slots[n-1],at=now();
    const info=metadata(req.body),consent=consentSnapshot(req.body?.consent,at);
    if(s.uploadIdempotencyHash===hash&&s.directUpload&&['uploading','queued','accepted','retryable'].includes(s.status)){
      if(s.directUpload.bytes!==info.bytes||s.directUpload.type!==info.type)fail('UPLOAD_METADATA_MISMATCH',409);
      if(s.status!=='uploading')return {status:s.status,duplicate:true};
      return {...await sign(movie,n,s,at),duplicate:true};
    }
    if(movie.status!=='collecting'||movie.activeSlot!==n||!['claimed','retryable'].includes(s.status)||s.reservationUntil<=at)fail('TURN_UNAVAILABLE',409);
    if((s.uploadCount||0)>=3)fail('UPLOAD_LIMIT',429);
    const attempt=randomUUID(),rawKey='movies/'+movie.publicId+'/raw/'+n+'/'+attempt+'.clip';
    const reserved={...s,rawKey,uploadStartedAt:at,directUpload:info};
    // Construct the signed URL before reserving; it is not disclosed unless the
    // transaction commits. Signing itself performs no cloud write.
    const signed=await sign(movie,n,reserved,at);
    onReserve(req,grant);
    const session=client.startSession();
    try{
      await session.withTransaction(async()=>{
        await reserveBudget(c,session,'upload',at);
        const result=await c.movies.updateOne({...identity(movie,grant),revision:movie.revision,
          expiresAt:{$gt:at},[p+'status']:s.status,[p+'reservationUntil']:{$gt:at}},
          {$set:{[p+'status']:'uploading',[p+'uploadAttemptId']:attempt,[p+'uploadIdempotencyHash']:hash,
            [p+'uploadStartedAt']:at,[p+'rawKey']:rawKey,[p+'rawETag']:null,[p+'directUpload']:info,
            [p+'consent']:consent,[p+'errorCode']:null},$inc:{revision:1,[p+'uploadCount']:1}},{session});
        if(result.modifiedCount!==1)fail('TURN_CONFLICT',409);
      });
    }finally{await session.endSession();}
    return {...signed,duplicate:false};
  }
  async function complete(req,{movie,grant}){
    const hash=idempotency(req),n=grant.slotNumber,p=slotPath(n),s=movie.slots[n-1],at=now();
    if(s.uploadIdempotencyHash!==hash||!s.directUpload)fail('UPLOAD_ATTEMPT_INVALID',409);
    if(['queued','accepted','retryable'].includes(s.status))return {status:s.status,duplicate:true};
    if(s.status!=='uploading'||!s.rawKey||movie.status!=='collecting'||movie.activeSlot!==n||
      at.getTime()>=s.uploadStartedAt.getTime()+COMPLETE_MS)fail('TURN_UNAVAILABLE',409);
    const object=await storage.inspectUpload(s.rawKey);
    if(!object)fail('UPLOAD_NOT_FOUND',409);
    if(object.bytes!==s.directUpload.bytes||object.type!==s.directUpload.type||!object.etag)fail('UPLOAD_METADATA_MISMATCH',422);
    const t=now();
    if(t.getTime()>=s.uploadStartedAt.getTime()+COMPLETE_MS)fail('TURN_UNAVAILABLE',409);
    const job={jobId:randomUUID(),type:'normalize',slot:n,generation:grant.generation,status:'pending',attempt:0,nextRunAt:t,leaseId:null,leaseUntil:null,lastErrorCode:null};
    const result=await c.movies.updateOne({...identity(movie,grant),revision:movie.revision,expiresAt:{$gt:t},
      [p+'status']:'uploading',[p+'uploadAttemptId']:s.uploadAttemptId,[p+'rawKey']:s.rawKey},
      {$set:{[p+'status']:'queued',[p+'rawETag']:object.etag,work:job},$inc:{revision:1}});
    if(result.modifiedCount!==1)fail('TURN_CONFLICT',409);
    return {status:'queued',duplicate:false};
  }
  return {start,complete};
}
