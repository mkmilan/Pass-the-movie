import { S3Client, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
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
    if(typeof key!=='string'||!/^movies\/[a-zA-Z0-9-]+\/(?:raw|normalized|frames)\/[1-5]\/[a-zA-Z0-9./-]+$/.test(key)||key.includes('..')) throw new Error('STORAGE_KEY_INVALID');
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
    async remove(key){keyCheck(key);await send(new DeleteObjectCommand({Bucket:bucket,Key:key}));},
    close(){client.destroy();}
  };
}
