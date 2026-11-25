import Busboy from 'busboy';
import { randomUUID, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, open, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GAME_RULES as R } from '../../packages/shared/rules.mjs';
import { reserveBudget } from '../../packages/server/budget.mjs';
import { slotPath } from '../../packages/server/turns.mjs';
import { fail, SceneError, consentSnapshot } from './scene-access.mjs';

async function readMultipart(req,path) {
  let bb;try{bb=Busboy({headers:req.headers,limits:{fileSize:R.maxUploadBytes+1,files:1,fields:1,parts:3,fieldSize:2048,headerPairs:50}});}
  catch{fail('MULTIPART_REQUIRED',422);}
  let filePromise=null,consent,problem=null,total=0;
  const error=code=>{problem ||= code;};
  bb.on('file',(name,stream)=>{
    if(name!=='clip'||filePromise){error('MULTIPART_INVALID');stream.resume();return;}
    stream.on('limit',()=>error('MEDIA_TOO_LARGE'));
    filePromise=pipeline(stream,createWriteStream(path,{flags:'wx',mode:0o600}));
    filePromise.catch(()=>error('UPLOAD_INTERRUPTED'));
  });
  bb.on('field',(name,value,info)=>{
    if(name!=='consent'||consent!==undefined||info.valueTruncated){error('MULTIPART_INVALID');return;}
    try{consent=JSON.parse(value);}catch{error('CONSENT_REQUIRED');}
  });
  for(const event of ['filesLimit','fieldsLimit','partsLimit'])bb.on(event,()=>error('MULTIPART_INVALID'));
  const limiter=new Transform({transform(chunk,_enc,cb){
    total+=chunk.length;cb(total>R.maxUploadBytes+16384?new SceneError('MEDIA_TOO_LARGE',413):null,chunk);
  }});
  try{await pipeline(req,limiter,bb,{signal:AbortSignal.timeout(20000)});if(filePromise)await filePromise;}
  catch(e){if(filePromise)await filePromise.catch(()=>{});if(e instanceof SceneError)throw e;fail(problem||'UPLOAD_INTERRUPTED',problem==='MEDIA_TOO_LARGE'?413:422);}
  if(problem)fail(problem,problem==='MEDIA_TOO_LARGE'?413:422);
  if(!filePromise)fail('MULTIPART_INVALID',422);
  const size=(await stat(path)).size;if(size>R.maxUploadBytes)fail('MEDIA_TOO_LARGE',413);
  if(size<12)fail('MEDIA_INVALID',422);
  const fh=await open(path,'r');
  let magic;
  try{magic=Buffer.alloc(12);await fh.read(magic,0,12,0);}finally{await fh.close();}
  const type=magic.subarray(4,8).toString()==='ftyp'?'video/mp4':magic.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))?'video/webm':null;
  if(!type)fail('MEDIA_UNSUPPORTED',422);
  return {type,consent};
}

export function createSceneUploader({collections:c,client,storage,now=()=>new Date(),onReserve=()=>{}}) {
  async function upload(req,{movie,grant}) {
    const key=req.get('Idempotency-Key');
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(key))fail('IDEMPOTENCY_KEY_REQUIRED',422);
    const hash=createHash('sha256').update(key).digest('hex'),n=grant.slotNumber,p=slotPath(n),s=movie.slots[n-1],t=now();
    if(s.uploadIdempotencyHash===hash&&['uploading','queued','accepted','retryable'].includes(s.status))
      return {status:s.status,duplicate:true};
    if(movie.status!=='collecting'||movie.activeSlot!==n||!['claimed','retryable'].includes(s.status)||s.reservationUntil<=t)fail('TURN_UNAVAILABLE',409);
    if((s.uploadCount||0)>=3)fail('UPLOAD_LIMIT',429);
    const attempt=randomUUID(),rawKey='movies/'+movie.publicId+'/raw/'+n+'/'+attempt+'.clip';
    const scope={_id:movie._id,revision:movie.revision,status:'collecting',activeSlot:n,expiresAt:{$gt:t},[p+'grantId']:grant.grantId,[p+'generation']:grant.generation,[p+'status']:s.status,[p+'reservationUntil']:{$gt:t}};
    onReserve(req,grant);
    const session=client.startSession();
    try{
      await session.withTransaction(async()=>{
        await reserveBudget(c,session,'upload',t);
        const reserved=await c.movies.updateOne(scope,{$set:{[p+'status']:'uploading',[p+'uploadAttemptId']:attempt,[p+'uploadIdempotencyHash']:hash,[p+'uploadStartedAt']:t,[p+'rawKey']:rawKey,[p+'errorCode']:null},$inc:{revision:1,[p+'uploadCount']:1}},{session});
        if(reserved.modifiedCount!==1)fail('TURN_CONFLICT',409);
      });
    }finally{await session.endSession();}
    let dir;
    try{
      dir=await mkdtemp(join(tmpdir(),'ptm-upload-'));const path=join(dir,'raw.clip');
      const {type,consent}=await readMultipart(req,path);
      const acceptedConsent=consentSnapshot(consent,now());
      await storage.put(rawKey,path,type);
      const job={jobId:randomUUID(),type:'normalize',slot:n,generation:grant.generation,status:'pending',attempt:0,nextRunAt:now(),leaseId:null,leaseUntil:null,lastErrorCode:null};
      const queued=await c.movies.updateOne({_id:movie._id,revision:movie.revision+1,status:'collecting',activeSlot:n,expiresAt:{$gt:now()},[p+'generation']:grant.generation,[p+'uploadAttemptId']:attempt,[p+'status']:'uploading'},{$set:{[p+'status']:'queued',[p+'consent']:acceptedConsent,work:job},$inc:{revision:1}});
      if(queued.modifiedCount!==1)fail('TURN_CONFLICT',409);
      return {status:'queued',duplicate:false};
    }catch(e){
      const code=e instanceof SceneError?e.code:'UPLOAD_INTERRUPTED';
      // Unique attempt key: a stale attempt cannot overwrite another attempt.
      // Queue the key for repeatable cleanup; only clear this exact reservation.
      // If the turn was replaced during object upload, schedule its unique key
      // after the storage call has settled. Never remove a successfully queued key.
      const rollback=await c.movies.updateOne({_id:movie._id,status:'collecting',activeSlot:n,[p+'uploadAttemptId']:attempt,[p+'generation']:grant.generation,[p+'status']:'uploading'},{$set:{[p+'status']:'retryable',[p+'rawKey']:null,[p+'errorCode']:code},$addToSet:{cleanupPending:rawKey},$inc:{revision:1}});
      if(rollback.modifiedCount!==1){
        const current=await c.movies.findOne({_id:movie._id});
        if(current&&current.slots?.[n-1]?.rawKey!==rawKey)await c.movies.updateOne({_id:movie._id},{$addToSet:{cleanupPending:rawKey}});
      }
      if(e instanceof SceneError)throw e;
      fail('UPLOAD_INTERRUPTED',503);
    }finally{if(dir)await rm(dir,{recursive:true,force:true});}
  }
  return {upload};
}
