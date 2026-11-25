import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomBytes } from 'node:crypto';
import { cloudConfig } from '../../packages/server/cloud-config.mjs';
import { createStorage } from '../../packages/server/storage.mjs';
import { cookiePolicy,validBetaStartKey } from '../../packages/server/beta-security.mjs';

const key=randomBytes(32).toString('base64url'),hash=createHash('sha256').update(key).digest('hex');
const sample={
  NODE_ENV:'production',HOST:'0.0.0.0',PUBLIC_LAUNCH_ENABLED:'false',PTM_PRIVATE_BETA_ENABLED:'true',PTM_MEDIA_ENABLED:'false',
  PTM_SITE_DOMAIN:'example.com',WEB_ORIGIN:'https://app.example.com',API_ORIGIN:'https://api.example.com',
  MONGODB_URI:'mongodb+srv://test:dummy@cluster.example.mongodb.net/pass_the_movie_beta?retryWrites=true&w=majority',
  R2_ACCOUNT_ID:'a'.repeat(32),R2_JURISDICTION:'eu',R2_BUCKET:'ptm-beta-fixture',R2_ACCESS_KEY_ID:'dummy-key',R2_SECRET_ACCESS_KEY:'dummy-secret',
  NEW_MOVIES_PAUSED:'true',PTM_BETA_START_KEY_HASH:hash
};
test('cloud mode explicitly opts in and retains the recording gate',()=>{
  assert.equal(cloudConfig({}),null);
  const config=cloudConfig(sample);
  assert.equal(config.mediaEnabled,false);
  assert.equal(config.newMoviesPaused,true);
  assert.equal(config.endpoint,'https://'+sample.R2_ACCOUNT_ID+'.eu.r2.cloudflarestorage.com');
  assert.equal(config.publicLaunchEnabled,false);
  for(const bad of [
    {PTM_MEDIA_ENABLED:'true'},{PUBLIC_LAUNCH_ENABLED:'true'},{NODE_ENV:'development'},{HOST:'127.0.0.1'},
    {SINGLE_SCENE_DEV_ENABLED:'true'},{WEB_ORIGIN:'http://app.example.com'},{API_ORIGIN:'https://random.onrender.com'},
    {PTM_SITE_DOMAIN:'vercel.app',WEB_ORIGIN:'https://app.vercel.app',API_ORIGIN:'https://api.vercel.app'},
    {MONGODB_URI:sample.MONGODB_URI.replace('pass_the_movie_beta','other_app')},
    {MONGODB_URI:sample.MONGODB_URI+'&tlsInsecure=true'},{R2_BUCKET:'shared-bucket'},{R2_JURISDICTION:'invalid'},
    {PTM_BETA_START_KEY_HASH:''},{NEW_MOVIES_PAUSED:undefined}
  ])assert.throws(()=>cloudConfig({...sample,...bad}),undefined,JSON.stringify(Object.keys(bad)));
});
test('starter key verification and beta cookies are distinct from development',()=>{
  assert.equal(validBetaStartKey(key,hash),true);
  assert.equal(validBetaStartKey(randomBytes(32).toString('base64url'),hash),false);
  assert.equal(validBetaStartKey(key,'invalid'),false);
  const cloud=cookiePolicy(cloudConfig(sample));
  assert.equal(cloud.name,'__Host-ptm');
  assert.deepEqual(cloud.options,{httpOnly:true,sameSite:'lax',secure:true,path:'/'});
  assert.equal(cookiePolicy().options.secure,false);
});
test('offline R2 signer constrains key, operation and lifetime',async()=>{
  const config=cloudConfig(sample),storage=createStorage(config);
  try{
    const id='12345678-1234-1234-1234-123456789abc',prefix='movies/'+id+'/',now=new Date('2026-11-25T10:00:00Z');
    const final=prefix+'final/123-abc/456-def.mp4',frame=prefix+'frames/1/123-abc/456-def.jpg';
    const result=await storage.signRead(final,{movieId:id,expiresAt:new Date(now.getTime()+7*86400000),download:true,now});
    const u=new URL(result.url);
    assert.equal(u.origin,config.endpoint);
    assert.equal(u.pathname,'/'+config.bucket+'/'+final);
    assert.equal(u.searchParams.get('X-Amz-Expires'),'60');
    assert.ok(u.searchParams.get('X-Amz-Signature'));
    assert.match(u.searchParams.get('response-content-disposition'),/attachment/);
    assert.equal(result.expiresAt,new Date(now.getTime()+60000).toISOString());
    const still=await storage.signRead(frame,{movieId:id,expiresAt:new Date(now.getTime()+3000),now});
    assert.equal(new URL(still.url).searchParams.get('X-Amz-Expires'),'3');
    for(const bad of [prefix+'raw/1/a.clip',prefix+'normalized/1/a.mp4','movies/other/final/a/b.mp4',prefix+'frames/6/a/b.jpg'])
      await assert.rejects(storage.signRead(bad,{movieId:id,expiresAt:new Date(now.getTime()+60000),now}));
    await assert.rejects(storage.signRead(frame,{movieId:id,expiresAt:new Date(now.getTime()+60000),download:true,now}));
    await assert.rejects(storage.signRead(final,{movieId:id,expiresAt:now,now}));
  }finally{storage.close();}
});

test('direct upload signer binds exact key, length, type, conditional PUT and expiry',async()=>{
  const storage=createStorage(cloudConfig(sample));
  const movieId='12345678-1234-1234-1234-123456789abc',attempt='87654321-4321-4321-4321-cba987654321',key='movies/'+movieId+'/raw/2/'+attempt+'.clip';
  const now=new Date('2026-11-25T10:00:00Z'),opts={movieId,slot:2,bytes:123456,type:'video/mp4',now,expiresAt:new Date(now.getTime()+300000)};
  try{
    const grant=await storage.signWrite(key,opts),url=new URL(grant.url);
    assert.equal(url.pathname,'/'+sample.R2_BUCKET+'/'+key);
    assert.equal(url.searchParams.get('X-Amz-Expires'),'90');
    assert.ok(url.searchParams.get('X-Amz-Signature'));
    for(const name of ['content-length','content-type','if-none-match','host'])assert.ok(url.searchParams.get('X-Amz-SignedHeaders').split(';').includes(name),name);
    assert.deepEqual(grant.headers,{'Content-Type':'video/mp4','If-None-Match':'*'});
    assert.equal((await storage.signWrite(key,{...opts,expiresAt:new Date(now.getTime()+3000)})).expiresAt,new Date(now.getTime()+3000).toISOString());
    const different=await storage.signWrite(key,{...opts,bytes:opts.bytes+1});
    assert.notEqual(new URL(different.url).searchParams.get('X-Amz-Signature'),url.searchParams.get('X-Amz-Signature'));
    for(const bad of [{slot:1},{bytes:0},{bytes:12582913},{type:'image/jpeg'},{expiresAt:now}])await assert.rejects(storage.signWrite(key,{...opts,...bad}));
    await assert.rejects(storage.signWrite('movies/'+movieId+'/final/a/b.mp4',opts));
    await assert.rejects(storage.signWrite(key.replace(attempt+'.clip',attempt+'xclip'),opts));
  }finally{storage.close();}
});
