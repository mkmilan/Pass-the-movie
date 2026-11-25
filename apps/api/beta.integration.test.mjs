import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes,createHash } from 'node:crypto';
import { once } from 'node:events';
import mongoose from 'mongoose';
import { createApp } from './app.mjs';
import { sceneCollections,ensureSceneIndexes } from '../../packages/server/scene-db.mjs';

test('beta HTTP flow requires a private key and refuses all uploads',{skip:process.env.PTM_INTEGRATION_TEST!=='1',timeout:60000},async()=>{
  // Deliberately inject local disposable MongoDB for testing; no cloud connection.
  const name='ptm_test_'+randomUUID().replaceAll('-','');
  const key=randomBytes(32).toString('base64url');
  const config={mode:'beta',secureCookies:true,mediaEnabled:false,newMoviesPaused:false,webOrigin:'https://app.example.com',apiOrigin:'https://api.example.com',startKeyHash:createHash('sha256').update(key).digest('hex')};
  let server;
  try{
    await mongoose.connect('mongodb://127.0.0.1:27017/'+name+'?replicaSet=rs0&directConnection=true',{serverSelectionTimeoutMS:5000});
    const collections=sceneCollections(mongoose.connection.db);await ensureSceneIndexes(collections);
    const storage=new Proxy({},{get(){throw Error('STORAGE_MUST_NOT_BE_ACCESSED');}});
    server=createApp({config,collections,client:mongoose.connection.getClient(),storage}).listen(0,'127.0.0.1');await once(server,'listening');
    const base='http://127.0.0.1:'+server.address().port+'/v1';
    const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{Origin:config.webOrigin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    assert.equal((await post('/movies',{adult:true})).status,403);
    assert.equal((await post('/movies',{adult:true,betaStartKey:key},{Origin:'https://other.example.com'})).status,403);
    const created=await post('/movies',{adult:true,betaStartKey:key});
    assert.equal(created.status,201,await created.clone().text());
    const cookie=created.headers.get('set-cookie');assert.match(cookie,/^__Host-ptm=/);assert.match(cookie,/; Secure/i);assert.match(cookie,/; HttpOnly/i);assert.match(cookie,/; Path=\//i);assert.doesNotMatch(cookie,/;\s*Domain=/i);
    const data=await created.json();
    const headers={Cookie:cookie.split(';')[0],'X-CSRF-Token':data.csrfToken};
    const blocked=await post('/movies/'+data.publicId+'/scenes/1/upload',{},headers);
    assert.equal(blocked.status,503);assert.equal((await blocked.json()).code,'BETA_MEDIA_DISABLED');
    const movie=await collections.movies.findOne({publicId:data.publicId});
    assert.equal(movie.slots[0].status,'claimed');assert.equal(movie.work,null);
    assert.equal((await collections.budgets.findOne({_id:'day:'+new Date().toISOString().slice(0,10)})).bytes,0);
    assert.equal((await post('/movies/'+data.publicId+'/scenes/1/upload',{}, {...headers,'X-CSRF-Token':'wrong'})).status,403);
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));
    if(mongoose.connection.db?.databaseName===name)await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }
});
