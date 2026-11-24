'use client';

import { useEffect, useRef, useState } from 'react';
import CameraCapture from './camera';
import FinalReveal from './final-reveal';

const initialConsent={adult:false,permissions:false,combineAndDownload:false,externalSharing:false};
const consentLabels={
  adult:'I am 18 or older.',
  permissions:'I have permission from everyone identifiable in this clip and rights to its content.',
  combineAndDownload:'I agree to combine my clip into the movie and make it downloadable by the other contributors.',
  externalSharing:'I understand other contributors can share the finished movie outside this app.'
};
const scoped=(path,slot)=>path+'?slot='+slot;
function apiBase(){
  const host=window.location.hostname;
  if(!['localhost','127.0.0.1'].includes(host))throw new Error('This flow is local-development only.');
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
    xhr.open('POST',apiBase()+'/movies/'+encodeURIComponent(movie.publicId)+'/scenes/'+movie.mySlot+'/upload');
    xhr.withCredentials=true;xhr.timeout=60000;
    xhr.setRequestHeader('X-CSRF-Token',movie.csrfToken);xhr.setRequestHeader('Idempotency-Key',key);
    xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress(Math.round(e.loaded/e.total*100));};
    xhr.onload=()=>{let data={};try{data=JSON.parse(xhr.responseText);}catch{}if(xhr.status===202)resolve(data);else reject(Error(data.code||'UPLOAD_FAILED'));};
    xhr.onerror=xhr.ontimeout=()=>reject(Error('UPLOAD_INTERRUPTED'));
    xhr.send(form);
  });
}
function ownUrl(movie){
  const u=new URL('/scene',window.location.origin);
  u.searchParams.set('movie',movie.publicId);u.searchParams.set('slot',movie.mySlot);
  return u.pathname+u.search;
}
function linkFor(movie,kind,token){
  const u=new URL('/'+kind+'/'+encodeURIComponent(movie.publicId),window.location.origin);
  u.hash=token;return u.href;
}
export default function ScenePage(){
  const [movie,setMovie]=useState(null),[personal,setPersonal]=useState(''),[invite,setInvite]=useState(null),[join,setJoin]=useState(null),[consent,setConsent]=useState(initialConsent),[blob,setBlob]=useState(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[progress,setProgress]=useState(null),[local,setLocal]=useState(false),[reference,setReference]=useState(null),[invalid,setInvalid]=useState(false);
  const attempt=useRef(null),active=useRef(true);
  const path=movie?'/movies/'+encodeURIComponent(movie.publicId):null;
  const slot=movie?.mySlot,status=movie?.myScene.status;
  const waiting=status==='queued'||status==='uploading';
  const accepted=status==='accepted';
  const canPoll=!!movie&&!invalid&&['collecting','assembling','ready'].includes(movie.status);
  function adopt(data){const {personalToken,...state}=data;setMovie(state);if(personalToken)setPersonal(personalToken);history.replaceState(null,'',ownUrl(state));setConsent(c=>({...c,adult:true}));setJoin(null);setInvalid(false);}
  useEffect(()=>{
    active.current=true;let cancelled=false;
    async function restore(){
      try{
        apiBase();setLocal(true);
        const loc=new URL(window.location.href),parts=loc.pathname.split('/').filter(Boolean),token=loc.hash.slice(1);
        const id=parts.length===2&&['join','access'].includes(parts[0])?parts[1]:loc.searchParams.get('movie');
        if(!id)return;
        if(parts[0]==='join'){
          if(!token)throw new Error('INVITE_INVALID');
          setJoin({id,token});return;
        }
        if(parts[0]==='access'&&!token)throw new Error('ACCESS_REQUIRED');
        const url='/movies/'+encodeURIComponent(id),selected=loc.searchParams.get('slot');
        const data=token?await post(url+'/access',{personalToken:token}):await request(selected?scoped(url,encodeURIComponent(selected)):url);
        if(cancelled)return;
        adopt(data);if(token)setPersonal(token);
      }catch(e){if(!cancelled){setError(e.message);setInvalid(true);}}
      finally{if(!cancelled)setLoading(false);}
    }
    restore();return()=>{cancelled=true;active.current=false;};
  },[]);
  useEffect(()=>{
    if(!path||!canPoll||busy)return;
    let cancelled=false,timer,inFlight=false,terminal=false;
    async function refresh(){
      if(cancelled||document.hidden||inFlight||terminal)return;
      inFlight=true;
      try{
        const data=await request(scoped(path,slot));
        if(!cancelled){setMovie(data);if(!data.canInvite)setInvite(null);if(data.myScene.status==='retryable'&&waiting){setBlob(null);attempt.current=null;}}
      }catch(e){
        if(!cancelled){setError(e.message);if(['NOT_FOUND','TURN_EXPIRED','MOVIE_EXPIRED','ACCESS_REQUIRED'].includes(e.message)){terminal=true;setInvalid(true);setBlob(null);setInvite(null);setPersonal('');}}
      }finally{inFlight=false;if(!cancelled&&!terminal)timer=setTimeout(refresh,waiting||movie.status==='assembling'?2500:15000);}
    }
    const focus=()=>{clearTimeout(timer);refresh();};
    timer=setTimeout(refresh,waiting||movie.status==='assembling'?1500:10000);
    window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    return()=>{cancelled=true;clearTimeout(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  },[path,slot,canPoll,waiting,busy,movie?.status]);
  const canReference=!!movie?.canReference&&!invalid;
  useEffect(()=>{
    if(!path||!canReference){setReference(null);return;}
    const controller=new AbortController();let url;
    setReference(null);
    (async()=>{
      try{
        const res=await fetch(apiBase()+scoped(path+'/reference',slot),{credentials:'include',cache:'no-store',signal:controller.signal});
        if(!res.ok||!res.headers.get('content-type')?.includes('image/jpeg'))throw new Error('REFERENCE_UNAVAILABLE');
        const image=await res.blob();if(controller.signal.aborted)return;
        url=URL.createObjectURL(image);setReference(url);
      }catch(e){if(!controller.signal.aborted)setError(e.message);}
    })();
    return()=>{controller.abort();if(url)URL.revokeObjectURL(url);};
  },[path,slot,canReference]);
  async function action(fn){
    if(busy)return;setBusy(true);setError('');setNotice('');
    try{await fn();}catch(e){if(active.current)setError(e.message);}
    finally{if(active.current)setBusy(false);}
  }
  function start(){if(consent.adult)action(async()=>{const data=await post('/movies',{adult:true});if(active.current)adopt(data);});}
  function accept(){if(join&&consent.adult)action(async()=>{
    const data=await post('/movies/'+encodeURIComponent(join.id)+'/claim',{adult:true,inviteToken:join.token});if(active.current)adopt(data);
  });}
  function onTake(take){setBlob(take);attempt.current=null;setError('');}
  async function submit(){
    if(!movie||!blob||!Object.values(consent).every(Boolean)||busy||waiting||accepted||invalid)return;
    await action(async()=>{
      setProgress(0);if(!attempt.current)attempt.current=crypto.randomUUID();
      try{
        await sendClip(movie,blob,attempt.current,consent,p=>{if(active.current)setProgress(p);});
        const data=await request(scoped(path,slot));if(active.current){setMovie(data);if(data.myScene.status==='retryable'){setBlob(null);attempt.current=null;}}
      }catch(e){
        try{const data=await request(scoped(path,slot));if(active.current){setMovie(data);if(data.myScene.status==='retryable'){setBlob(null);attempt.current=null;}}}catch{}
        throw e;
      }finally{if(active.current)setProgress(null);}
    });
  }
  async function copy(text){await navigator.clipboard.writeText(text);setNotice('Link copied.');}
  function createInvite(){action(async()=>{
    const data=await post(scoped(path+'/invite',slot),{});
    if(active.current)setInvite({url:linkFor(movie,'join',data.inviteToken),slot:data.slot,expiresAt:data.expiresAt});
  });}
  function replace(){if(window.confirm('Replace this unfinished turn? The previous link and any unfinished recording will be revoked.'))action(async()=>{
    const data=await post(scoped(path+'/replace-turn',slot),{confirm:true});if(active.current){setMovie(data);setInvite(null);setNotice('Turn reopened. Create a new invitation.');}
  });}
  function abandon(){if(window.confirm('Abandon this unfinished scene? You will lose access to this turn.'))action(async()=>{
    await post(scoped(path+'/abandon',slot),{confirm:true});if(active.current){setInvalid(true);setBlob(null);setPersonal('');setInvite(null);setNotice('Turn abandoned.');}
  });}
  const allConsent=Object.values(consent).every(Boolean);
  const title=join?'Continue the movie':movie?.canViewFinal?'Your movie is ready!':accepted?'Scene saved!':movie?'Scene '+slot+' of 5':'Start a movie';
  return <main className="mx-auto flex min-h-dvh max-w-[440px] flex-col gap-5 px-5 py-8">
    <header className="flex items-center justify-between"><a href="/" className="font-black">PASS THE MOVIE.</a><span className="text-xs font-bold">LOCAL DEV</span></header>
    <h1 className="text-3xl font-black">{title}</h1>
    <ol aria-label="Movie progress" className="grid grid-cols-5 gap-2">{Array.from({length:5},(_,i)=><li key={i} className="rounded-lg border border-[#24211e] px-1 py-3 text-center text-xs font-bold">{movie?.slots[i].status==='accepted'?'Saved':movie?.activeSlot===i+1?(i+1)+' · 3s':i+1}</li>)}</ol>
    {notice&&<p role="status" className="text-sm">{notice}</p>}
    {error&&<p role="alert" className="rounded-xl border border-[#b63222] p-3 text-sm">Unable to continue: {error}</p>}
    {loading?<p>Checking your session…</p>:!local?<p>This screen is only enabled for local development.</p>:invalid?<p>This turn is unavailable. Reopen your private link or ask the sender for a new invitation.</p>:!movie?<>
      <p>{join?'Accept this turn to see the last frame of the previous scene.':'Five friends. Three seconds each.'} The completed movie will be downloadable by its contributors and may be shared externally.</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={consent.adult} onChange={e=>setConsent({...consent,adult:e.target.checked})}/> I am 18 or older.</label>
      <button className="ptm-primary" disabled={!consent.adult||busy} onClick={join?accept:start}>{join?'Accept turn':'Start a movie'}</button>
    </>:<>
      <p className="text-sm">Movie expires {new Date(movie.expiresAt).toLocaleString()}.{movie.turnExpiresAt&&!waiting?' Record before '+new Date(movie.turnExpiresAt).toLocaleTimeString()+'.':''}</p>
      <details className="rounded-xl border p-3 text-sm"><summary className="font-bold">Save my private access link</summary>
        <p className="my-2">Only for you. Do not send this link as an invitation.</p>
        {personal?<button className="ptm-secondary" disabled={busy} onClick={()=>action(()=>copy(linkFor(movie,'access',personal)))}>Copy private link</button>:
          <button className="ptm-secondary" disabled={busy} onClick={()=>action(async()=>{const data=await post(scoped(path+'/access/rotate',slot),{});setPersonal(data.personalToken);setNotice('New private link created. Copy and keep it.');})}>Create new private link</button>}
      </details>
      {movie.canViewFinal?<FinalReveal movie={movie} apiOrigin={apiBase()}/>:accepted?<section className="flex flex-col gap-3">
        <p>{movie.status==='assembling'?'All five scenes are saved. Your movie is being assembled.':movie.status==='failed'?'The movie could not be assembled after several attempts. Your scenes remain saved; no partial movie has been published.':'Your scene is saved. '+movie.slots.filter(s=>s.status==='accepted').length+' of 5 scenes accepted.'}</p>
        {movie.canInvite&&<button className="ptm-primary" disabled={busy} onClick={createInvite}>{invite?'Replace invitation link':'Invite next person'}</button>}
        {invite&&movie.canInvite&&<div className="rounded-xl border p-3">
          <p className="text-sm">Invitation for scene {invite.slot}. Expires {new Date(invite.expiresAt).toLocaleString()}.</p>
          <button className="ptm-secondary mt-2" disabled={busy} onClick={()=>action(()=>copy(invite.url))}>Copy invitation</button>
          <p className="mt-2 text-xs">For local testing, open in another browser or private window on this computer.</p>
        </div>}
        {movie.canReplace&&!movie.canInvite&&<button className="ptm-secondary" disabled={busy} onClick={replace}>Replace unfinished turn</button>}
      </section>:waiting?<p role="status">Processing your scene. The next turn opens only after verification.</p>:<>
        {slot>1&&<section className="flex flex-col gap-2"><h2 className="font-bold">Continue from this frame</h2>{reference?<img src={reference} alt="Last frame of the previous scene" className="mx-auto max-h-[260px] w-auto rounded-xl object-contain"/>:<p>Loading the previous frame…</p>}</section>}
        {status==='retryable'&&<p role="alert">Scene rejected: {movie.myScene.errorCode}. Please retake.</p>}
        <p className="text-sm">Your clip is uploaded only when you submit. Accepted clips are immutable.</p>
        <div className="flex flex-col gap-2">{Object.entries(consentLabels).map(([key,label])=><label key={key} className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={consent[key]} disabled={busy} onChange={e=>{if(!e.target.checked)onTake(null);setConsent({...consent,[key]:e.target.checked});}}/>{label}</label>)}</div>
        {allConsent&&(slot===1||reference)?<CameraCapture onTake={onTake} disabled={busy}/>:<p className="text-sm">Confirm the recording rules and wait for the reference before opening your camera.</p>}
        <button className="ptm-primary" disabled={busy||!allConsent||!blob||(slot>1&&!reference)} onClick={submit}>Use this scene</button>
        {progress!==null&&<div role="status">Uploading… {progress}%<progress className="w-full" max="100" value={progress}/></div>}
      </>}
      {movie.canAbandon&&<button className="ptm-secondary" disabled={busy} onClick={abandon}>Abandon unfinished turn</button>}
      <p className="text-xs">Synthetic local test only. No public sharing or automatic social posting.</p>
    </>}
  </main>;
}
