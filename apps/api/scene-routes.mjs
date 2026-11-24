import express from 'express';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSceneAccess, movieDto, SceneError } from './scene-access.mjs';
import { createSceneUploader } from './scene-upload.mjs';

export function createSceneRouter({config,collections,client,storage,now}) {
  const router=express.Router(),access=createSceneAccess({collections,client,now}),uploader=createSceneUploader({collections,storage,now});
  router.use((req,res,next)=>{
    const origin=req.get('Origin');
    if(origin!==config.webOrigin && origin!==config.apiOrigin) return res.status(403).json({code:'ORIGIN_INVALID'});
    res.set('Vary','Origin');
    res.set('Access-Control-Allow-Origin',origin);
    res.set('Access-Control-Allow-Credentials','true');
    res.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers','Content-Type, X-CSRF-Token, Idempotency-Key');
    if(req.method==='OPTIONS')return res.sendStatus(204);
    next();
  });
  const json=express.json({limit:'4kb',strict:true});
  router.get('/session',async(req,res)=>res.json(await access.sessionInfo(req)));
  router.post('/movies',json,async(req,res)=>res.status(201).json(await access.create(req,res)));
  router.post('/movies/:id/access',json,async(req,res)=>res.json(await access.recover(req,res)));
  router.get('/movies/:id',async(req,res)=>{
    const {movie,token,grant}=await access.authorize(req);res.json(movieDto(movie,token,grant));
  });
  router.post('/movies/:id/scenes/:slot/upload',async(req,res)=>{
    if(!/^[1-5]$/.test(req.params.slot))return res.status(404).json({code:'NOT_FOUND'});
    const context=await access.authorize(req,{mutation:true,slotNumber:Number(req.params.slot)});
    res.status(202).json(await uploader.upload(req,context));
  });
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
  // Phase 3 exposes only the previous JPEG, never scene video or final files.
  router.use((err,req,res,next)=>{
    if(res.headersSent)return next(err);
    if(err instanceof SceneError)return res.status(err.status).json({code:err.code});
    if(err.type==='entity.too.large')return res.status(413).json({code:'REQUEST_TOO_LARGE'});
    if(err.type==='entity.parse.failed')return res.status(422).json({code:'INVALID_JSON'});
    console.error('SINGLE_SCENE_REQUEST_FAILED');
    return res.status(503).json({code:'SERVICE_UNAVAILABLE'});
  });
  return router;
}
