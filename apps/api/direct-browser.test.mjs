import test from 'node:test';
import assert from 'node:assert/strict';
import { sendDirectClip } from '../web/app/scene/api.js';

test('direct browser protocol checks destinations and sends only the clip to storage',async()=>{
  const id='12345678-1234-1234-1234-123456789abc',movie={publicId:id,mySlot:1,csrfToken:'csrf-test'};
  const blob=new Blob(['video-test-blob'],{type:'video/mp4;codecs=avc1.42E01E'});
  const consent={adult:true,permissions:true,combineAndDownload:true,externalSharing:true};
  const restore={window:globalThis.window,fetch:globalThis.fetch,XMLHttpRequest:globalThis.XMLHttpRequest};
  const oldDomain=process.env.NEXT_PUBLIC_PTM_SITE_DOMAIN,oldApi=process.env.NEXT_PUBLIC_API_ORIGIN;
  process.env.NEXT_PUBLIC_PTM_SITE_DOMAIN='example.com';process.env.NEXT_PUBLIC_API_ORIGIN='https://api.example.com';
  globalThis.window={location:new URL('https://app.example.com/scene')};
  const calls=[],puts=[],progress=[],headers={'Content-Type':'video/mp4','If-None-Match':'*'};
  const url='https://'+'a'.repeat(32)+'.eu.r2.cloudflarestorage.com/ptm-beta-test/movies/'+id+'/raw/1/a.clip?X-Amz-Signature=sample&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bif-none-match';
  const good={status:'uploading',url,headers,expiresAt:new Date(Date.now()+90000).toISOString()};
  let grant=good,completeCount=0,missingOnce=false,lostResponse=false;
  globalThis.fetch=async(target,options)=>{
    calls.push({target,options});
    assert.ok(target.startsWith('https://api.example.com/v1/'));
    assert.equal(options.credentials,'include');
    assert.equal(options.headers['X-CSRF-Token'],'csrf-test');
    assert.equal(options.headers['Idempotency-Key'],'attempt-key');
    if(target.endsWith('/start'))return Response.json(grant);
    if(missingOnce&&++completeCount===1)return Response.json({code:'UPLOAD_NOT_FOUND'},{status:409});
    return Response.json({status:'queued'});
  };
  globalThis.XMLHttpRequest=class {
    headers={};upload={};
    open(method,target){this.method=method;this.target=target;}
    setRequestHeader(k,v){this.headers[k]=v;}
    send(body){
      puts.push({method:this.method,target:this.target,headers:this.headers,credentials:this.withCredentials,body});
      this.upload.onprogress({lengthComputable:true,loaded:body.size,total:body.size});
      if(lostResponse){lostResponse=false;this.onerror();}else{this.status=200;this.onload();}
    }
  };
  try{
    lostResponse=true;
    const result=await sendDirectClip(movie,blob,'attempt-key',consent,p=>progress.push(p));
    assert.equal(result.status,'queued');assert.equal(puts.length,1);
    assert.deepEqual(puts[0],{method:'PUT',target:new URL(url).href,headers,credentials:false,body:blob});
    assert.deepEqual(JSON.parse(calls[0].options.body),{bytes:blob.size,type:'video/mp4',consent:{...consent,version:'dev-1'}});
    assert.deepEqual(JSON.parse(calls[1].options.body),{});
    assert.deepEqual(progress,[100]);
    missingOnce=true;
    await sendDirectClip(movie,blob,'attempt-key',consent,()=>{});
    assert.equal(puts.length,3);assert.equal(puts[1].target,puts[2].target);
    for(const bad of [
      {...good,url:good.url.replace('r2.cloudflarestorage.com','evil.example')},
      {...good,url:good.url.replace('/raw/1/','/raw/2/')},
      {...good,url:good.url.replace('content-length%3B','')},
      {...good,headers:{'Content-Type':'video/mp4'}},
      {...good,expiresAt:new Date(Date.now()-1000).toISOString()}
    ]){
      grant=bad;
      await assert.rejects(sendDirectClip(movie,blob,'attempt-key',consent,()=>{}),/UPLOAD_LINK_INVALID/);
    }
    assert.equal(puts.length,3);
    grant={status:'queued',duplicate:true};
    assert.equal((await sendDirectClip(movie,blob,'attempt-key',consent,()=>{})).duplicate,true);
    assert.equal(puts.length,3);
  }finally{
    for(const [k,v] of Object.entries(restore)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}
    if(oldDomain===undefined)delete process.env.NEXT_PUBLIC_PTM_SITE_DOMAIN;else process.env.NEXT_PUBLIC_PTM_SITE_DOMAIN=oldDomain;
    if(oldApi===undefined)delete process.env.NEXT_PUBLIC_API_ORIGIN;else process.env.NEXT_PUBLIC_API_ORIGIN=oldApi;
  }
});
