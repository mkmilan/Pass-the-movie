import mongoose from 'mongoose';
import { cloudConfig } from '../../packages/server/cloud-config.mjs';
import { createStorage } from '../../packages/server/storage.mjs';

// Read-only check of explicitly configured, dedicated staging resources.
// No writes, no credentials, object keys or signed URLs printed.
let storage;
try{
  const config=cloudConfig(process.env);
  if(!config)throw new Error('BETA_CONFIG_REQUIRED');
  await mongoose.connect(config.mongodbUri,{serverSelectionTimeoutMS:8000,maxPoolSize:2});
  const db=mongoose.connection.db;
  await db.command({ping:1});
  const hello=await db.admin().command({hello:1});
  if(!hello.setName&&hello.msg!=='isdbgrid')throw new Error('BETA_TRANSACTION_TOPOLOGY_REQUIRED');
  const session=mongoose.connection.getClient().startSession();
  try{
    session.startTransaction({readConcern:{level:'snapshot'}});
    await db.collection('movies').findOne({_id:null},{session,projection:{_id:1}});
    await session.abortTransaction();
  }finally{await session.endSession();}
  console.log('PASS dedicated Atlas connectivity and read transaction');
  storage=createStorage(config);await storage.ready();await storage.listPage({prefix:'movies/'});
  console.log('PASS dedicated R2 connectivity and bounded listing');
  console.log('Cloud uploads remain disabled. This check does not prove bucket privacy, write/delete, media isolation or mobile compatibility.');
}catch{
  console.error('CLOUD_PREFLIGHT_FAILED');process.exitCode=1;
}finally{
  storage?.close();await mongoose.disconnect().catch(()=>{});
}
