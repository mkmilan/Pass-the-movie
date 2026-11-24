import Busboy from 'busboy';
import { randomUUID, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, open, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GAME_RULES as R } from '../../packages/shared/rules.mjs';
import { fail, SceneError, consentSnapshot } from './scene-access.mjs';

async function readMultipart(req,path) {
  let bb;try{bb=Busboy({headers:req.headers,limits:{fileSize:R.maxUploadBytes+1,files:1,fields:1,parts:2,fieldSize:2048,headerPairs:50}});}
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

export function createSceneUploader({collections:c,storage,now=()=>new Date()}) {
  async function upload(req,{movie,grant}) {
    const key=req.get('Idempotency-Key');
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(key))fail('IDEMPOTENCY_KEY_REQUIRED',422);
    const hash=createHash('sha256').update(key).digest('hex'),s=movie.slots[0],t=now();
    if(s.uploadIdempotencyHash===hash&&['uploading','queued','accepted','retryable'].includes(s.status))
      return {status:s.status,duplicate:true};
    if(movie.status!=='collecting'||movie.activeSlot!==1||!['claimed','retryable'].includes(s.status)||s.reservationUntil<=t)fail('TURN_UNAVAILABLE',409);
    if((s.uploadCount||0)>=3)fail('UPLOAD_LIMIT',429);
    const attempt=randomUUID(),rawKey='movies/'+movie.publicId+'/raw/1/'+attempt+'.clip';
    const scope={_id:movie._id,revision:movie.revision,status:'collecting',activeSlot:1,expiresAt:{$gt:t},'slots.0.grantId':grant.grantId,'slots.0.generation':grant.generation,'slots.0.status':s.status,'slots.0.reservationUntil':{$gt:t}};
    const reserved=await c.movies.updateOne(scope,{$set:{'slots.0.status':'uploading','slots.0.uploadAttemptId':attempt,'slots.0.uploadIdempotencyHash':hash,'slots.0.uploadStartedAt':t,'slots.0.rawKey':rawKey,'slots.0.errorCode':null},$inc:{revision:1,'slots.0.uploadCount':1}});
    if(reserved.modifiedCount!==1)fail('TURN_CONFLICT',409);
    let dir;
    try{
      dir=await mkdtemp(join(tmpdir(),'ptm-upload-'));const path=join(dir,'raw.clip');
      const {type,consent}=await readMultipart(req,path);
      const acceptedConsent=consentSnapshot(consent,now());
      await storage.put(rawKey,path,type);
      const job={jobId:randomUUID(),type:'normalize',slot:1,generation:grant.generation,status:'pending',attempt:0,nextRunAt:now(),leaseId:null,leaseUntil:null,lastErrorCode:null};
      const queued=await c.movies.updateOne({_id:movie._id,revision:movie.revision+1,status:'collecting',activeSlot:1,expiresAt:{$gt:now()},'slots.0.generation':grant.generation,'slots.0.uploadAttemptId':attempt,'slots.0.status':'uploading'},{$set:{'slots.0.status':'queued','slots.0.consent':acceptedConsent,work:job},$inc:{revision:1}});
      if(queued.modifiedCount!==1)fail('TURN_CONFLICT',409);
      return {status:'queued',duplicate:false};
    }catch(e){
      const code=e instanceof SceneError?e.code:'UPLOAD_INTERRUPTED';
      // Unique attempt key: a stale attempt cannot overwrite another attempt.
      // Queue the key for repeatable cleanup; only clear this exact reservation.
      await c.movies.updateOne({_id:movie._id,'slots.0.uploadAttemptId':attempt,'slots.0.status':'uploading'},{$set:{'slots.0.status':'retryable','slots.0.rawKey':null,'slots.0.errorCode':code},$addToSet:{cleanupPending:rawKey},$inc:{revision:1}});
      if(e instanceof SceneError)throw e;
      fail('UPLOAD_INTERRUPTED',503);
    }finally{if(dir)await rm(dir,{recursive:true,force:true});}
  }
  return {upload};
}
