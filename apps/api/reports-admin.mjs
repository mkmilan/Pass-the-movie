import mongoose from 'mongoose';
import { singleSceneConfig } from '../../packages/server/single-scene-config.mjs';
import { sceneCollections } from '../../packages/server/scene-db.mjs';
import { deletionPatch } from '../worker/retention.mjs';

// Local developer-only CLI. Never expose these actions as browser endpoints.
const [command,id,confirm]=process.argv.slice(2);
try{
  const config=singleSceneConfig(process.env);
  if(!config)throw new Error('LOCAL_ONLY');
  if(!['list','close','revoke'].includes(command)||(command!=='list'&&(!/^[0-9a-f-]{36}$/i.test(id||'')||confirm!=='--confirm')))throw new Error('USAGE');
  await mongoose.connect(config.mongodbUri,{serverSelectionTimeoutMS:5000});
  const c=sceneCollections(mongoose.connection.db);
  if(command==='list'){
    const open=await c.reports.find({status:'open'},{projection:{_id:0,reportId:1,reason:1,moviePublicId:1,createdAt:1}}).sort({createdAt:1}).limit(100).toArray();
    console.log(JSON.stringify(open,null,2));
  }else{
    const session=mongoose.connection.getClient().startSession();
    try{
      await session.withTransaction(async()=>{
        const report=await c.reports.findOne({reportId:id,status:'open'},{session});
        if(!report)throw new Error('REPORT_NOT_OPEN');
        const now=new Date();
        if(command==='revoke'){
          if(!report.moviePublicId)throw new Error('REPORT_HAS_NO_MOVIE_ID');
          const m=await c.movies.findOne({publicId:report.moviePublicId,status:{$in:['collecting','assembling','ready','failed']}},{session});
          if(!m)throw new Error('MOVIE_NOT_ACTIVE');
          const result=await c.movies.updateOne({_id:m._id,revision:m.revision,status:m.status},deletionPatch(now),{session});
          if(result.modifiedCount!==1)throw new Error('MOVIE_CHANGED');
          await c.grants.updateMany({movieId:m._id},{$set:{status:'revoked'}},{session});
        }
        await c.reports.updateOne({_id:report._id,status:'open'},{$set:{status:'closed',resolution:command==='revoke'?'removal_requested':'reviewed',closedAt:now,purgeAt:new Date(now.getTime()+30*86400000)}},{session});
      });
      console.log(command==='revoke'?'Access revoked; deletion scheduled.':'Report closed.');
    }finally{await session.endSession();}
  }
}catch(e){
  console.error(['LOCAL_ONLY','USAGE','REPORT_NOT_OPEN','REPORT_HAS_NO_MOVIE_ID','MOVIE_NOT_ACTIVE','MOVIE_CHANGED'].includes(e.message)?e.message:'REPORT_ADMIN_FAILED');
  process.exitCode=1;
}finally{await mongoose.disconnect().catch(()=>{});}
