import mongoose from 'mongoose';
import { singleSceneConfig } from '../../packages/server/single-scene-config.mjs';
import { createStorage } from '../../packages/server/storage.mjs';
import { sceneCollections, ensureSceneIndexes } from '../../packages/server/scene-db.mjs';
import { createMediaProcessor } from './media.mjs';
import { createSceneWorker } from './scene-worker.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

let stopping=false, storage;
process.once('SIGINT',()=>{stopping=true;});
process.once('SIGTERM',()=>{stopping=true;});
try{
  const config=singleSceneConfig(process.env);
  if(!config)throw new Error('SINGLE_SCENE_DEV_ONLY');
  await mongoose.connect(config.mongodbUri,{serverSelectionTimeoutMS:5000,maxPoolSize:5});
  const collections=sceneCollections(mongoose.connection.db);
  await ensureSceneIndexes(collections);
  storage=createStorage(config);await storage.ready();
  const media=createMediaProcessor({ffmpeg:process.env.FFMPEG_PATH||'ffmpeg',ffprobe:process.env.FFPROBE_PATH||'ffprobe'});
  const worker=createSceneWorker({collections,storage,media});
  console.log('Local single-scene worker started');
  while(!stopping){
    try{if(!await worker.runOne())await sleep(1000);}
    catch{console.error('WORKER_RETRY');await sleep(2000);}
  }
}catch{
  console.error('WORKER_STARTUP_FAILED');
  process.exitCode=1;
}finally{
  storage?.close();
  await mongoose.disconnect().catch(()=>{});
}
