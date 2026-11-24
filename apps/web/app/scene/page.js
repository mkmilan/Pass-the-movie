'use client';

import { useEffect, useRef, useState } from 'react';
import CameraCapture from './camera';

const initialConsent={adult:false,permissions:false,combineAndDownload:false,externalSharing:false};
const consentLabels={
  adult:'I am 18 or older.',
  permissions:'I have permission from everyone identifiable in this clip and rights to its content.',
  combineAndDownload:'I agree to combine my clip into the movie and make it downloadable by the other contributors.',
  externalSharing:'I understand other contributors can share the finished movie outside this app.'
};
function apiBase(){
  const host=window.location.hostname;
  if(!['localhost','127.0.0.1'].includes(host))throw new Error('This recording flow is local-development only.');
  const origin=new URL(process.env.NEXT_PUBLIC_API_ORIGIN||('http://'+host+':4000'));
  if(origin.hostname!==host||!['http:','https:'].includes(origin.protocol)||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw new Error('Invalid local API origin.');
  return origin.origin+'/v1';
}
async function request(path,options={}){
  const res=await fetch(apiBase()+path,{credentials:'include',cache:'no-store',...options});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(data.code||'REQUEST_FAILED');
  return data;
}
async function post(path,body){
  const {csrfToken}=await request('/session');
  return request(path,{method:'POST',headers:{'Content-Type':'application/json',...(csrfToken?{'X-CSRF-Token':csrfToken}:{})},body:JSON.stringify(body)});
}
function sendClip(movie,blob,key,consent,onProgress){
  const form=new FormData();
  form.set('consent',JSON.stringify({...consent,version:'dev-1'}));
  form.set('clip',blob,'scene.'+(blob.type.includes('mp4')?'mp4':'webm'));
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open('POST',apiBase()+'/movies/'+encodeURIComponent(movie.publicId)+'/scenes/1/upload');
    xhr.withCredentials=true;xhr.timeout=60000;
    xhr.setRequestHeader('X-CSRF-Token',movie.csrfToken);xhr.setRequestHeader('Idempotency-Key',key);
    xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress(Math.round(e.loaded/e.total*100));};
    xhr.onload=()=>{let data={};try{data=JSON.parse(xhr.responseText);}catch{}if(xhr.status===202)resolve(data);else reject(Error(data.code||'UPLOAD_FAILED'));};
    xhr.onerror=xhr.ontimeout=()=>reject(Error('UPLOAD_INTERRUPTED'));
    xhr.send(form);
  });
}
export default function ScenePage(){
  const [movie,setMovie]=useState(null),[personal,setPersonal]=useState(''),[consent,setConsent]=useState(initialConsent),[blob,setBlob]=useState(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[progress,setProgress]=useState(null),[local,setLocal]=useState(false);
  const attempt=useRef(null),active=useRef(true);
  const path=movie?'/movies/'+encodeURIComponent(movie.publicId):null;
  const status=movie?.scene1.status;
  const waiting=status==='queued'||status==='uploading';
  useEffect(()=>{
    active.current=true;let cancelled=false;
    async function restore(){
      try{
        apiBase();setLocal(true);
        const loc=new URL(window.location.href),id=loc.searchParams.get('movie');
        if(!id)return;
        const token=loc.hash.slice(1);
        const data=token?await post('/movies/'+encodeURIComponent(id)+'/access',{personalToken:token}):await request('/movies/'+encodeURIComponent(id));
        if(cancelled)return;
        if(token){loc.hash='';history.replaceState(null,'',loc.pathname+loc.search);setPersonal(token);}
        setMovie(data);setConsent(c=>({...c,adult:true}));
      }catch(e){if(!cancelled)setError(e.message);}
      finally{if(!cancelled)setLoading(false);}
    }
    restore();return()=>{cancelled=true;active.current=false;};
  },[]);
  useEffect(()=>{
    if(!path||!waiting)return;
    let cancelled=false,timer;
    async function refresh(){
      if(cancelled||document.hidden)return;
      try{const data=await request(path);if(!cancelled)setMovie(data);}
      catch(e){if(!cancelled)setError(e.message);}
      finally{if(!cancelled)timer=setTimeout(refresh,2500);}
    }
    const focus=()=>{clearTimeout(timer);refresh();};
    timer=setTimeout(refresh,1500);window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    return()=>{cancelled=true;clearTimeout(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  },[path,waiting]);
  async function start(){
    if(busy||!consent.adult)return;setBusy(true);setError('');
    try{const data=await post('/movies',{adult:true});if(!active.current)return;const {personalToken,...state}=data;setMovie(state);setPersonal(personalToken);const loc=new URL(window.location.href);loc.searchParams.set('movie',state.publicId);loc.hash='';history.replaceState(null,'',loc.pathname+loc.search);}
    catch(e){if(active.current)setError(e.message);}finally{if(active.current)setBusy(false);}
  }
  function onTake(take){setBlob(take);attempt.current=null;setError('');}
  async function submit(){
    if(!movie||!blob||!Object.values(consent).every(Boolean)||busy||waiting||status==='accepted')return;
    setBusy(true);setError('');setProgress(0);
    if(!attempt.current)attempt.current=crypto.randomUUID();
    try{
      await sendClip(movie,blob,attempt.current,consent,p=>{if(active.current)setProgress(p);});
      const data=await request(path);if(active.current)setMovie(data);
    }catch(e){
      if(active.current)setError(e.message);
      try{const data=await request(path);if(active.current){setMovie(data);if(data.scene1.status==='retryable')attempt.current=null;}}catch{}
    }finally{if(active.current){setBusy(false);setProgress(null);}}
  }
  const allConsent=Object.values(consent).every(Boolean);
  return <main className="mx-auto flex min-h-dvh max-w-[440px] flex-col gap-5 px-5 py-8">
    <header className="flex items-center justify-between"><a href="/" className="font-black">PASS THE MOVIE.</a><span className="text-xs font-bold">LOCAL DEV</span></header>
    <h1 className="text-3xl font-black">{status==='accepted'?'Scene saved!':'Your first scene'}</h1>
    <ol aria-label="Movie progress" className="grid grid-cols-5 gap-2">{Array.from({length:5},(_,i)=><li key={i} className="rounded-lg border border-[#24211e] px-1 py-3 text-center text-xs font-bold">{movie?.slots[i].status==='accepted'?'Saved':i===0?'1 · 3s':i+1}</li>)}</ol>
    {error&&<p role="alert" className="rounded-xl border border-[#b63222] p-3 text-sm">Unable to continue: {error}</p>}
    {loading?<p>Checking your session…</p>:!local?<p>This screen is only enabled for local development.</p>:!movie?<><p>Five friends. Three seconds each. Your movie will be revealed after the fifth scene.</p><label className="flex items-center gap-2"><input type="checkbox" checked={consent.adult} onChange={e=>setConsent({...consent,adult:e.target.checked})}/> I am 18 or older.</label><button className="ptm-primary" disabled={!consent.adult||busy} onClick={start}>Start a movie</button></>:<>
      {personal&&<details className="rounded-xl border p-3 text-sm"><summary className="font-bold">Save my private access link</summary><p className="my-2">Only for you. Anyone holding it can recover your creator access.</p><button className="ptm-secondary" onClick={async()=>{const u=new URL(window.location.href);u.hash=personal;try{await navigator.clipboard.writeText(u.href);}catch{setError('Clipboard unavailable.');}}}>Copy private link</button></details>}
      {status==='accepted'?<><p>Your three-second scene is accepted. Its last frame is ready for the next contributor. Invitations will be implemented in Phase 3.</p><p className="text-sm">{movie.scene1.summary?.width} × {movie.scene1.summary?.height} · {movie.scene1.summary?.frames} frames</p></>:waiting?<p role="status">Processing your scene. The next turn only opens after successful verification.</p>:<>
        <p className="text-sm">This local test saves your clip only after you submit. Accepted clips are immutable.</p>
        {status==='retryable'&&<p role="alert">Scene rejected: {movie.scene1.errorCode}. Please retake.</p>}
        <div className="flex flex-col gap-2">{Object.entries(consentLabels).map(([key,label])=><label key={key} className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={consent[key]} disabled={busy} onChange={e=>setConsent({...consent,[key]:e.target.checked})}/>{label}</label>)}</div>
        {allConsent?<CameraCapture onTake={onTake} disabled={busy}/>:<p className="text-sm">Confirm the recording rules before opening your camera.</p>}
        <button className="ptm-primary" disabled={busy||!allConsent||!blob||status==='retryable'} onClick={submit}>Use this scene</button>
        {status==='retryable'&&blob&&<button className="ptm-secondary" disabled={busy||!allConsent} onClick={()=>{attempt.current=null;submit();}}>Submit this new take</button>}
        {progress!==null&&<div role="status">Uploading… {progress}%<progress className="w-full" max="100" value={progress}/></div>}
      </>}
      <p className="text-xs">Local test only. No public sharing or automatic social posting.</p>
    </>}
  </main>;
}
