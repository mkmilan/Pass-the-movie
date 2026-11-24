import express from 'express';
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
    const {movie,token}=await access.authorize(req);res.json(movieDto(movie,token));
  });
  router.post('/movies/:id/scenes/1/upload',async(req,res)=>{
    const context=await access.authorize(req,{mutation:true});
    res.status(202).json(await uploader.upload(req,context));
  });
  // No media downloads, arbitrary object routes, invites or fifth-scene actions yet.
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
