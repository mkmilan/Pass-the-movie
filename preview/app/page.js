'use client';

import {useEffect,useRef,useState} from 'react';
import CameraCapture from './camera';
import {lastFrame,renderMovie} from './demo-media';

const samples=()=>Array.from({length:5},(_,i)=>({number:i+1,kind:'sample'}));
export default function Preview(){
  const [stage,setStage]=useState('home'),[scenes,setScenes]=useState([]),[take,setTake]=useState(null),[ref,setRef]=useState(''),[accepted,setAccepted]=useState(false),[permission,setPermission]=useState(false),[busy,setBusy]=useState(false),[progress,setProgress]=useState(0),[sound,setSound]=useState(true),[movie,setMovie]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const job=useRef(null),fileUrl=useRef('');
  const slot=Math.min(5,scenes.length+1);
  useEffect(()=>()=>{job.current?.abort();if(fileUrl.current)URL.revokeObjectURL(fileUrl.current);},[]);
  function reset(){
    job.current?.abort();job.current=null;
    if(fileUrl.current)URL.revokeObjectURL(fileUrl.current);fileUrl.current='';
    setMovie(null);setScenes([]);setTake(null);setRef('');setAccepted(false);setPermission(false);setBusy(false);setError('');setNotice('');setProgress(0);setStage('home');
  }
  function start(sampleOnly=false){
    setError('');setNotice('');setAccepted(false);setPermission(false);
    setScenes(sampleOnly?samples():[]);setStage(sampleOnly?'assemble':'record');
  }
  async function useScene(kind){
    if(job.current||busy||scenes.length>=5||(kind==='clip'&&(!take||!permission)))return;
    const controller=new AbortController();job.current=controller;setBusy(true);setError('');
    const next={number:slot,kind,...(kind==='clip'?{blob:take}:{})};
    try{
      const image=await lastFrame(next,controller.signal);
      if(controller.signal.aborted)return;
      setRef(image);setScenes(old=>[...old,next]);setTake(null);setPermission(false);setAccepted(false);
      setStage(slot===5?'assemble':'handoff');
    }catch(e){if(!controller.signal.aborted)setError(e.message||'Unable to prepare the scene.');}
    finally{if(job.current===controller){setBusy(false);job.current=null;}}
  }
  async function assemble(){
    if(job.current||busy||scenes.length!==5)return;
    const controller=new AbortController();job.current=controller;setBusy(true);setError('');setNotice('');setProgress(0);setStage('rendering');
    try{
      const blob=await renderMovie(scenes,{sound,signal:controller.signal,onProgress:value=>{if(job.current===controller&&!controller.signal.aborted)setProgress(value);}});
      if(controller.signal.aborted)throw new Error('Export cancelled.');
      const ext=blob.type.includes('mp4')?'mp4':'webm',filename='pass-the-movie-'+new Date().toISOString().replace(/[:.]/g,'-')+'.'+ext;
      const file=new File([blob],filename,{type:ext==='mp4'?'video/mp4':'video/webm'}),url=URL.createObjectURL(file);
      if(fileUrl.current)URL.revokeObjectURL(fileUrl.current);fileUrl.current=url;
      let shareable=false;try{shareable=!!navigator.share&&!!navigator.canShare?.({files:[file]});}catch{}
      setMovie({file,url,ext,filename,shareable});setScenes([]);setRef('');setStage('reveal');
    }catch(e){
      if(job.current===controller){
        setError(controller.signal.aborted?'Export cancelled. Your five scenes are still available in this tab.':e.message||'Movie export failed.');
        setNotice('');setStage('assemble');
      }
    }
    finally{if(job.current===controller){setBusy(false);job.current=null;}}
  }
  function cancelRender(){
    if(!job.current||job.current.signal.aborted)return;
    job.current.abort();
    setNotice('Cleaning up the cancelled export…');
  }
  function share(){
    if(!movie?.shareable)return;
    try{navigator.share({files:[movie.file],title:'Pass the Movie'}).catch(e=>{if(e.name!=='AbortError')setError('Sharing unavailable. Download the video instead.');});}catch{setError('Sharing unavailable. Download the video instead.');}
  }
  const complete=stage==='reveal'?5:scenes.length;
  return <main className="mx-auto flex min-h-dvh max-w-[460px] flex-col gap-5 px-5 py-7">
    <header className="flex items-center justify-between gap-2"><span className="ptm-brand">PASS THE MOVIE<span className="text-ptm-accent">.</span></span><span className="rounded-full bg-ptm-signal px-3 py-1 text-[11px] font-black tracking-wide">FREE PREVIEW</span></header>
    {stage==='home'?<>
      <div className="pt-4"><p className="mb-3 ptm-eyebrow uppercase text-ptm-accent">The three-second movie game</p>
      <h1 className="ptm-hero">Five friends.<br/>Three seconds each.<br/><span className="text-ptm-accent">One movie.</span></h1></div>
      <div className="grid grid-cols-5 gap-2" aria-label="Five three-second scenes">{[1,2,3,4,5].map((n)=><div key={n} className="relative flex aspect-[9/16] flex-col items-center justify-center rounded-xl border-2 border-ptm-ink bg-ptm-tile"><span className="absolute top-2 text-[10px] tracking-[.2em]">•••</span><b className="text-3xl">{n}</b><span className="text-xs font-bold">3s</span><span className="absolute bottom-2 text-[10px] tracking-[.2em]">•••</span></div>)}</div>
      <p className="ptm-lead">Make a story together. Each player sees only the last frame from the person before them. At the end, watch the whole film.</p>
      <button className="ptm-primary" onClick={()=>start(false)}>Start a movie</button>
      <button className="ptm-secondary" onClick={()=>start(true)}>Try with five sample scenes</button>
      <section className="rounded-2xl border border-ptm-line bg-white/90 p-4 ptm-detail"><b>What this preview can do</b><p className="mt-2">Record and pass the same phone to the next player. Export a real movie in your browser. No account, uploads, cloud database or paid worker. The shared invitation links between phones are not connected in this demo.</p></section>
    </>:<>
      <div className="grid grid-cols-5 gap-2" aria-label={complete+' of 5 scenes accepted'}>{[1,2,3,4,5].map(n=><div key={n} className={'rounded-xl border px-1 py-3 text-center ptm-tile-caption font-bold '+(n<=complete?'border-ptm-accent bg-ptm-accent text-white':stage==='record'&&n===slot?'border-ptm-accent bg-ptm-tile text-ptm-accent':'border-ptm-line')}><div className="text-lg">{n<=complete?'✓':n}</div>{n<=complete?'Saved':n===slot?'3 sec':'—'}</div>)}</div>
      {stage==='record'&&<>
        <h1 className="ptm-heading">Scene {slot} of 5</h1>
        {slot>1&&<section className="rounded-2xl border border-ptm-line bg-white/90 p-3"><div className="mb-2 flex items-center justify-between"><b className="ptm-detail">Continue from this frame</b><span className="text-xs">Scene {slot-1}</span></div>{ref&&<img src={ref} alt="Last frame of the previous scene" className="mx-auto max-h-[230px] w-auto rounded-lg object-contain"/>}</section>}
        <p className="ptm-detail">{slot===1?'Start the story with anything you like.':'What happens next? Use the previous frame as inspiration.'} You have three seconds.</p>
        {!accepted?<><label className="flex items-start gap-3 rounded-xl border border-ptm-line p-3 ptm-detail"><input type="checkbox" checked={permission} onChange={e=>setPermission(e.target.checked)} className="mt-1"/><span>I am 18 or older and have permission from anyone I record. I understand clips stay in this tab, but saved exports can be shared.</span></label><button className="ptm-primary" disabled={!permission} onClick={()=>setAccepted(true)}>Continue to camera</button></>:<>
          <CameraCapture key={slot} onTake={setTake} disabled={busy}/>
          <button className="ptm-primary" disabled={!take||busy} onClick={()=>useScene('clip')}>{busy?'Preparing your last frame…':'Use this scene'}</button>
        </>}
        <button className="ptm-secondary" disabled={busy} onClick={()=>useScene('sample')}>Use a sample scene instead</button>
      </>}
      {stage==='handoff'&&<>
        <div className="rounded-2xl bg-ptm-signal p-5"><p className="text-xs font-black uppercase tracking-widest">Scene {scenes.length} accepted</p><h1 className="mt-2 ptm-heading">Pass the phone!</h1><p className="mt-2 ptm-detail">Give the phone to the next person. They'll see only your last frame.</p></div>
        <p className="ptm-detail">In the real app, you'll send a private invitation link. In this preview, the next person plays on this device.</p>
        <button className="ptm-primary" onClick={()=>{setStage('record');setError('');}}>I'm the next player</button>
      </>}
      {stage==='assemble'&&<>
        <h1 className="ptm-heading">The movie is complete.</h1>
        <p>All five scenes are ready. Time to see the story you made together.</p>
        <section className="rounded-xl border border-ptm-line p-4 ptm-detail"><p>This test exports the movie using your browser, not our production FFmpeg worker. Target: 15 seconds, vertical 9:16 video. Keep the screen on.</p>
          {scenes.some(s=>s.kind==='clip')&&<label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={sound} onChange={e=>setSound(e.target.checked)}/> Include recorded sound if supported</label>}
        </section>
        <button className="ptm-primary" disabled={busy} onClick={assemble}>Reveal the movie</button>
      </>}
      {stage==='rendering'&&<>
        <h1 className="ptm-heading">Making your movie…</h1>
        <p>Keep this tab visible. Your browser is joining all five scenes.</p>
        <progress aria-label="Movie export progress" value={progress} max="100" className="h-3 w-full accent-ptm-accent"/>
        <p className="text-center ptm-detail font-bold">{progress}%</p>
        <button className="ptm-secondary" onClick={cancelRender}>Cancel export</button>
      </>}
      {stage==='reveal'&&movie&&<>
        <div className="rounded-xl bg-ptm-signal p-3 text-center ptm-detail font-black tracking-wide">FIVE SCENES. ONE MOVIE.</div>
        <h1 className="ptm-heading">Your movie is ready!</h1>
        <video src={movie.url} controls playsInline preload="metadata" className="mx-auto aspect-[9/16] w-full max-w-[280px] rounded-2xl bg-ptm-player object-contain"/>
        <a className="ptm-primary" href={movie.url} download={movie.filename}>Download {movie.ext.toUpperCase()}</a>
        {movie.shareable&&<button className="ptm-secondary" onClick={share}>Share video</button>}
        <p className="ptm-caption text-ptm-muted">Browser export may use MP4 or WebM and may vary slightly in timing. The server version will normalize every movie to 15 seconds of H.264/AAC MP4.</p>
        <button className="ptm-secondary" onClick={reset}>Make another movie</button>
      </>}
      {error&&<p role="alert" className="rounded-xl border border-ptm-alert p-3 ptm-detail text-ptm-alert">{error}</p>}
      {notice&&<p role="status">{notice}</p>}
      {stage!=='reveal'&&stage!=='rendering'&&<button className="self-center ptm-detail underline" disabled={busy} onClick={()=>{if(window.confirm('Discard all scenes in this tab?'))reset();}}>Delete demo movie</button>}
    </>}
    <footer className="mt-auto border-t border-ptm-line pt-4 ptm-caption text-ptm-muted">Private on this device · Clips are held in memory only. Reloading or closing the page discards the unfinished movie. No automatic downloads. Previously saved files remain on your device.</footer>
  </main>;
}
