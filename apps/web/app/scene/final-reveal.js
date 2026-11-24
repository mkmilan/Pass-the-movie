'use client';

import { useEffect, useState } from 'react';

export default function FinalReveal({movie,apiOrigin}){
  const [file,setFile]=useState(null),[url,setUrl]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true),[shareable,setShareable]=useState(false),[reload,setReload]=useState(0);
  const id=movie.publicId,slot=movie.mySlot,expiresAt=movie.expiresAt;
  const filename='pass-the-movie-'+id+'.mp4';
  useEffect(()=>{
    const controller=new AbortController();let objectUrl,expired=false;
    setLoading(true);setFile(null);setUrl('');setShareable(false);setError('');
    const expire=()=>{expired=true;controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);setFile(null);setUrl('');setShareable(false);setLoading(false);setError('This movie has expired. Previously saved copies are outside the app.');};
    const remaining=Date.parse(expiresAt)-Date.now();
    if(!Number.isFinite(remaining)||remaining<=0){expire();return;}
    const timer=setTimeout(expire,remaining);
    (async()=>{
      try{
        const response=await fetch(apiOrigin+'/movies/'+encodeURIComponent(id)+'/final?slot='+slot,{credentials:'include',cache:'no-store',signal:controller.signal});
        if(!response.ok||!response.headers.get('content-type')?.includes('video/mp4'))throw new Error('FINAL_UNAVAILABLE');
        const blob=await response.blob();
        if(blob.size<=0||blob.size>12*1024*1024||blob.size!==movie.final.bytes)throw new Error('FINAL_UNAVAILABLE');
        if(controller.signal.aborted||expired)return;
        const prepared=new File([blob],filename,{type:'video/mp4'});
        objectUrl=URL.createObjectURL(prepared);setUrl(objectUrl);setFile(prepared);
        try{setShareable(!!navigator.share&&!!navigator.canShare?.({files:[prepared]}));}catch{setShareable(false);}
      }catch(e){if(!controller.signal.aborted)setError('Could not load the movie. Retry while your access is valid.');}
      finally{if(!controller.signal.aborted)setLoading(false);}
    })();
    return()=>{clearTimeout(timer);controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[id,slot,expiresAt,apiOrigin,movie.final.bytes,filename,reload]);
  function share(){
    if(!file||!shareable||Date.now()>=Date.parse(expiresAt))return;
    // Invoke directly inside the tap; the file is already prepared.
    try{navigator.share({files:[file],title:'Pass the Movie'}).catch(e=>{if(e.name!=='AbortError')setError('Sharing unavailable. Use Download MP4 instead.');});}
    catch{setError('Sharing unavailable. Use Download MP4 instead.');}
  }
  return <section className="flex flex-col gap-4">
    <div className="rounded-xl bg-[#e6b84d] p-3 text-center font-black">FIVE SCENES. ONE MOVIE.</div>
    <p>Everyone who contributed can now watch the same 15-second film.</p>
    {loading&&<p role="status">Loading your movie…</p>}
    {url&&<video src={url} controls playsInline preload="metadata" className="mx-auto aspect-[9/16] w-full max-w-[300px] rounded-2xl bg-[#24211e] object-contain"/>}
    {error&&<p role="alert" className="text-sm">{error}</p>}
    {!loading&&!url&&Date.now()<Date.parse(expiresAt)&&<button className="ptm-secondary" onClick={()=>setReload(n=>n+1)}>Retry movie loading</button>}
    {url&&<a className="ptm-primary" href={url} download={filename}>Download MP4</a>}
    {shareable&&<button className="ptm-secondary" onClick={share}>Share video</button>}
    {url&&<p className="text-xs">Save the file to upload it manually to TikTok, Instagram or another app. No automatic posting.</p>}
    <a className="ptm-secondary" href="/scene">Start a new movie</a>
  </section>;
}
