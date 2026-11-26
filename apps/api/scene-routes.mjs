import express from 'express';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSceneAccess, movieDto, SceneError } from './scene-access.mjs';
import { createSceneUploader } from './scene-upload.mjs';
import { createDirectUploader } from './direct-upload.mjs';
import { createRateLimiter, RateError } from '../../packages/server/rate-limit.mjs';
import { BudgetError } from '../../packages/server/budget.mjs';
import { createReporter } from './reports.mjs';

export function createSceneRouter({config,collections,client,storage,now}) {
  const router=express.Router(),access=createSceneAccess({collections,client,config,now});
  const limiter=createRateLimiter({now});
  const source=req=>req.socket.remoteAddress||'unknown';
  function onReserve(req,grant){
    limiter.check('upload-grant',grant.grantId,3,60000);
    limiter.check('upload-ip',source(req),30,60000);
  }
  const uploader=createSceneUploader({collections,client,storage,now,onReserve});
  const direct=createDirectUploader({collections,client,storage,now,onReserve});
  const report=createReporter({collections,client,now});
  router.use((req,res,next)=>{
    const origin=req.get('Origin');
    if(origin!==config.webOrigin && origin!==config.apiOrigin) return res.status(403).json({code:'ORIGIN_INVALID'});
    res.set('Vary','Origin');
    res.set('Access-Control-Allow-Origin',origin);
    res.set('Access-Control-Allow-Credentials','true');
    res.set('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers','Content-Type, X-CSRF-Token, Idempotency-Key');
    if(req.method==='OPTIONS')return res.sendStatus(204);
    limiter.check('api',source(req),300,60000);
    if(req.method==='POST'&&/\/(claim|access)$/.test(req.path))limiter.check('capability',source(req),30,60000);
    next();
  });
  const json=express.json({limit:'4kb',strict:true});
  router.get('/session',async(req,res)=>res.json(await access.sessionInfo(req)));
  router.post('/movies',json,async(req,res)=>{
    if(config.newMoviesPaused)throw new SceneError('CREATION_PAUSED',503);
    limiter.check('creation',source(req),10,60000);
    res.status(201).json(await access.create(req,res));
  });
  router.post('/reports',json,async(req,res)=>{
    limiter.check('report',source(req),5,600000);
    res.status(201).json(await report(req));
  });
  router.delete('/movies/:id',json,async(req,res)=>res.status(202).json(await access.deleteMovie(req,await access.authorize(req,{mutation:true}))));
  router.post('/movies/:id/access',json,async(req,res)=>res.json(await access.recover(req,res)));
  router.get('/movies/:id',async(req,res)=>{
    const {movie,token,grant}=await access.authorize(req);res.json(movieDto(movie,token,grant));
  });
  router.post('/movies/:id/scenes/:slot/upload',async(req,res)=>{
    if(!/^[1-5]$/.test(req.params.slot))return res.status(404).json({code:'NOT_FOUND'});
    const context=await access.authorize(req,{mutation:true,slotNumber:Number(req.params.slot)});
    if(config.mode==='beta'&&!config.mediaEnabled)throw new SceneError('BETA_MEDIA_DISABLED',503);
    if(config.mode==='beta')throw new SceneError('DIRECT_UPLOAD_REQUIRED',409);
    res.status(202).json(await uploader.upload(req,context));
  });
  for(const phase of ['start','complete']){
    router.post('/movies/:id/scenes/:slot/upload/'+phase,json,async(req,res)=>{
      if(!/^[1-5]$/.test(req.params.slot))return res.status(404).json({code:'NOT_FOUND'});
      const context=await access.authorize(req,{mutation:true,slotNumber:Number(req.params.slot)});
      if(config.mode==='beta'&&!config.mediaEnabled)throw new SceneError('BETA_MEDIA_DISABLED',503);
      limiter.check('direct-'+phase,context.grant.grantId,12,60000);
      res.status(202).json(await direct[phase](req,context));
    });
  }
  router.post('/movies/:id/invite',json,async(req,res)=>res.status(201).json(await access.issueInvite(await access.authorize(req,{mutation:true}))));
  router.post('/movies/:id/claim',json,async(req,res)=>res.json(await access.claim(req,res)));
  router.post('/movies/:id/replace-turn',json,async(req,res)=>res.json(await access.replace(req,await access.authorize(req,{mutation:true}))));
  router.post('/movies/:id/abandon',json,async(req,res)=>res.json(await access.replace(req,await access.authorize(req,{mutation:true}),{abandon:true})));
  router.post('/movies/:id/access/rotate',json,async(req,res)=>res.json(await access.rotateAccess(await access.authorize(req,{mutation:true}))));
  router.get('/movies/:id/reference',async(req,res)=>{
    function keyFor({movie,grant}){
      const n=grant.slotNumber,slot=movie.slots[n-1],previous=movie.slots[n-2];
      if(movie.status!=='collecting'||n<2||movie.activeSlot!==n||!['claimed','retryable','uploading','queued'].includes(slot.status)||previous?.status!=='accepted'||!previous.lastFrameKey)throw new SceneError('NOT_FOUND',404);
      return previous.lastFrameKey;
    }
    const context=await access.authorize(req),key=keyFor(context);
    if(config.mode==='beta'){
      const at=now?now():new Date(),slot=context.movie.slots[context.grant.slotNumber-1];
      // For an idle claimed turn do not outlive its reservation. Queued work
      // has its own lease; all links remain bounded by the movie expiry.
      const deadline=['claimed','retryable'].includes(slot.status)?new Date(Math.min(context.movie.expiresAt.getTime(),slot.reservationUntil.getTime())):context.movie.expiresAt;
      const signed=await storage.signRead(key,{movieId:context.movie.publicId,expiresAt:deadline,now:at});
      const latest=await access.authorize(req);
      if(latest.grant.grantId!==context.grant.grantId||latest.grant.generation!==context.grant.generation||keyFor(latest)!==key)throw new SceneError('NOT_FOUND',404);
      return res.json(signed);
    }
    const dir=await mkdtemp(join(tmpdir(),'ptm-reference-'));
    try{
      const path=join(dir,'reference.jpg');await storage.get(key,path);
      const image=await readFile(path);
      if(image.length<4||image[0]!==255||image[1]!==216||image.at(-2)!==255||image.at(-1)!==217)throw new SceneError('REFERENCE_UNAVAILABLE',503);
      const latest=await access.authorize(req);
      if(latest.grant.grantId!==context.grant.grantId||latest.grant.generation!==context.grant.generation||keyFor(latest)!==key)throw new SceneError('NOT_FOUND',404);
      res.set('Cache-Control','private, no-store');res.type('jpeg').send(image);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  router.get('/movies/:id/final',async(req,res)=>{
    function finalFor({movie,grant}){
      if(movie.status!=='ready'||movie.slots[grant.slotNumber-1]?.status!=='accepted'||!movie.final?.key)throw new SceneError('NOT_FOUND',404);
      return movie.final;
    }
    const context=await access.authorize(req),final=finalFor(context);
    if(config.mode==='beta'){
      const signed=await storage.signRead(final.key,{movieId:context.movie.publicId,expiresAt:context.movie.expiresAt,download:req.query.download==='1',now:now?now():new Date()});
      const latest=await access.authorize(req);
      if(latest.grant.grantId!==context.grant.grantId||latest.grant.generation!==context.grant.generation||finalFor(latest).key!==final.key)throw new SceneError('NOT_FOUND',404);
      return res.json(signed);
    }
    const dir=await mkdtemp(join(tmpdir(),'ptm-final-'));
    try{
      const path=join(dir,'final.mp4');await storage.get(final.key,path);
      const file=await stat(path);
      if(!file.isFile()||file.size!==final.bytes)throw new SceneError('FINAL_UNAVAILABLE',503);
      const latest=await access.authorize(req);
      if(latest.grant.grantId!==context.grant.grantId||latest.grant.generation!==context.grant.generation||finalFor(latest).key!==final.key)throw new SceneError('NOT_FOUND',404);
      res.set('Cache-Control','private, no-store');
      res.type('video/mp4');
      if(req.query.download==='1')res.attachment('pass-the-movie-'+context.movie.publicId+'.mp4');
      // sendFile handles byte ranges for local playback; no raw object URL is exposed.
      await new Promise((resolve,reject)=>res.sendFile(path,{cacheControl:false,lastModified:false,acceptRanges:true},err=>err?reject(err):resolve()));
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  // Individual scene videos remain inaccessible.
  router.use((err,req,res,next)=>{
    if(res.headersSent)return next(err);
    if(err instanceof RateError){res.set('Retry-After',String(err.retryAfter));return res.status(429).json({code:err.code});}
    if(err instanceof SceneError||err instanceof BudgetError)return res.status(err.status).json({code:err.code});
    if(err.type==='entity.too.large')return res.status(413).json({code:'REQUEST_TOO_LARGE'});
    if(err.type==='entity.parse.failed')return res.status(422).json({code:'INVALID_JSON'});
    console.error('SINGLE_SCENE_REQUEST_FAILED');
    return res.status(503).json({code:'SERVICE_UNAVAILABLE'});
  });
  return router;
}
