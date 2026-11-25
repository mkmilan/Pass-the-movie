import { S3Client, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GAME_RULES as R } from '../shared/rules.mjs';

export function createStorage(config) {
  const client = new S3Client({
    endpoint:config.endpoint, region:'auto', forcePathStyle:true,
    credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},
    maxAttempts:2, requestChecksumCalculation:'WHEN_REQUIRED', responseChecksumValidation:'WHEN_REQUIRED'
  });
  const bucket=config.bucket;
  const send=command=>client.send(command,{abortSignal:AbortSignal.timeout(20000)});
  function keyCheck(key) {
    if(typeof key!=='string'||!/^movies\/[a-zA-Z0-9-]+\/(?:(?:raw|normalized|frames)\/[1-5]\/|final\/)[a-zA-Z0-9./-]+$/.test(key)||key.includes('..')) throw new Error('STORAGE_KEY_INVALID');
  }
  return {
    async ready(){ await send(new HeadBucketCommand({Bucket:bucket})); },
    async put(key,path,type) {
      keyCheck(key);const f=await stat(path);
      if(!f.isFile()||f.size<=0||f.size>R.maxUploadBytes) throw new Error('STORAGE_SIZE_INVALID');
      await send(new PutObjectCommand({Bucket:bucket,Key:key,Body:createReadStream(path),ContentLength:f.size,ContentType:type,CacheControl:'private, no-store'}));
      const head=await send(new HeadObjectCommand({Bucket:bucket,Key:key}));
      if(head.ContentLength!==f.size) throw new Error('STORAGE_SIZE_MISMATCH');
    },
    async get(key,path) {
      keyCheck(key);const object=await send(new GetObjectCommand({Bucket:bucket,Key:key}));
      const size=object.ContentLength;
      if(!Number.isInteger(size)||size<=0||size>R.maxUploadBytes){object.Body?.destroy();throw new Error('STORAGE_SIZE_INVALID');}
      let bytes=0;
      const limiter=new Transform({transform(chunk,_enc,cb){bytes+=chunk.length;cb(bytes>size?new Error('STORAGE_SIZE_MISMATCH'):null,chunk);}});
      await pipeline(object.Body,limiter,createWriteStream(path,{flags:'wx',mode:0o600}),{signal:AbortSignal.timeout(20000)});
      if(bytes!==size)throw new Error('STORAGE_SIZE_MISMATCH');
    },
    async signRead(key,{movieId,expiresAt,download=false,now=new Date()}){
      keyCheck(key);
      if(config.mode!=='beta'||typeof movieId!=='string'||!(/^[a-f0-9-]{36}$/.test(movieId)))throw new Error('SIGNED_READ_INVALID');
      const prefix='movies/'+movieId+'/';
      const relative=key.slice(prefix.length);
      if(!key.startsWith(prefix)||!(/^(?:frames\/[1-5]\/[a-f0-9-]+\/[a-f0-9-]+\.jpg|final\/[a-f0-9-]+\/[a-f0-9-]+\.mp4)$/.test(relative)))throw new Error('SIGNED_READ_INVALID');
      if(download&&!relative.startsWith('final/'))throw new Error('SIGNED_READ_INVALID');
      const lifetime=Math.min(60,Math.floor((new Date(expiresAt).getTime()-now.getTime())/1000));
      if(!Number.isInteger(lifetime)||lifetime<1)throw new Error('SIGNED_READ_EXPIRED');
      const command=new GetObjectCommand({Bucket:bucket,Key:key,
        ...(download?{ResponseContentDisposition:'attachment; filename="pass-the-movie-'+movieId+'.mp4"'}:{})});
      const url=await getSignedUrl(client,command,{expiresIn:lifetime,signingDate:now});
      return {url,expiresAt:new Date(now.getTime()+lifetime*1000).toISOString()};
    },
    async remove(key){keyCheck(key);await send(new DeleteObjectCommand({Bucket:bucket,Key:key}));},
    async listPage({prefix='movies/',cursor}={}){
      if(prefix!=='movies/'&&!/^movies\/[a-zA-Z0-9-]+\/$/.test(prefix))throw new Error('STORAGE_PREFIX_INVALID');
      const response=await send(new ListObjectsV2Command({Bucket:bucket,Prefix:prefix,MaxKeys:100,...(cursor?{ContinuationToken:cursor}:{})}));
      const objects=(response.Contents||[]).map(o=>({key:o.Key,lastModified:o.LastModified}));
      for(const o of objects){keyCheck(o.key);if(!o.key.startsWith(prefix))throw new Error('STORAGE_PREFIX_MISMATCH');}
      if(response.IsTruncated&&!response.NextContinuationToken)throw new Error('STORAGE_CURSOR_MISSING');
      return {objects,cursor:response.IsTruncated?response.NextContinuationToken:null};
    },
    close(){client.destroy();}
  };
}
