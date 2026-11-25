'use client';

import { useEffect, useRef, useState } from 'react';

const W=720,H=1280,MAX=12*1024*1024;
function choices(audio){return audio?['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/mp4','video/webm','']:['video/mp4;codecs=avc1.42E01E','video/webm;codecs=vp8','video/webm;codecs=vp9','video/mp4','video/webm',''];}
function portrait(w,h){return w>0&&h>0&&Math.abs(w/h-W/H)<0.02;}
function needsResize(w,h){return !portrait(w,h)||w>W||h>H;}
function safeNative(w,h){return w>0&&h>0&&w<=1920&&h<=1920&&w*h<=2100000;}
function crop(w,h){const r=W/H;return w/h>r?[(w-h*r)/2,0,h*r,h]:[0,(h-w/r)/2,w,w/r];}
export default function CameraCapture({onTake,disabled=false}) {
  const video=useRef(null),alive=useRef(true),camera=useRef(null),capture=useRef(null),recorder=useRef(null),timer=useRef(null),raf=useRef(null),epoch=useRef(0),url=useRef(null),cancelled=useRef(false);
  const [mode,setMode]=useState('idle'),[facing,setFacing]=useState('user'),[mic,setMic]=useState(false),[message,setMessage]=useState('Open your camera when ready.'),[review,setReview]=useState(null),[count,setCount]=useState(0),[fit,setFit]=useState('cover');
  const busy=mode==='opening'||mode==='countdown'||mode==='recording';
  function stopTracks(){
    cancelAnimationFrame(raf.current);raf.current=null;
    if(capture.current&&capture.current!==camera.current)capture.current.getVideoTracks().forEach(t=>t.stop());
    capture.current=null;
    camera.current?.getTracks().forEach(t=>t.stop());camera.current=null;
    if(video.current)video.current.srcObject=null;
  }
  function releaseReview(){if(url.current)URL.revokeObjectURL(url.current);url.current=null;setReview(null);}
  function interrupt(reason){
    cancelled.current=true;++epoch.current;clearTimeout(timer.current);
    const r=recorder.current;recorder.current=null;
    if(r&&r.state!=='inactive'){r.onstop=null;try{r.stop();}catch{}}
    stopTracks();
    if(alive.current){setCount(0);setMode('idle');setMessage(reason);}
  }
  useEffect(()=>{
    alive.current=true;
    const hide=()=>{if(document.hidden&&(camera.current||!url.current))interrupt('Camera paused. Open it again.');};
    const rotate=()=>{if(recorder.current)interrupt('Keep your phone upright and retake.');};
    document.addEventListener('visibilitychange',hide);window.addEventListener('orientationchange',rotate);
    return()=>{alive.current=false;interrupt('');if(url.current)URL.revokeObjectURL(url.current);document.removeEventListener('visibilitychange',hide);window.removeEventListener('orientationchange',rotate);};
  },[]);
  async function openCamera(nextFacing=facing,nextMic=mic){
    if(disabled||busy)return;
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){setMessage('Use Chrome or Safari on HTTPS or localhost.');return;}
    const ticket=++epoch.current;stopTracks();releaseReview();onTake(null);setMode('opening');setMessage('Opening camera…');setFacing(nextFacing);setMic(nextMic);
    const constraints={video:{facingMode:{ideal:nextFacing},width:{ideal:W},height:{ideal:H},aspectRatio:{ideal:9/16},frameRate:{ideal:30,max:60},resizeMode:'crop-and-scale'},audio:nextMic};
    try{
      let s;
      try{s=await navigator.mediaDevices.getUserMedia(constraints);}catch(e){if(!nextMic)throw e;s=await navigator.mediaDevices.getUserMedia({...constraints,audio:false});if(alive.current)setMic(false);}
      if(!alive.current||ticket!==epoch.current||document.hidden){s.getTracks().forEach(t=>t.stop());return;}
      camera.current=s;s.getTracks().forEach(t=>t.addEventListener('ended',()=>{if(camera.current===s)interrupt('Camera or microphone disconnected.');},{once:true}));
      video.current.srcObject=s;await video.current.play();
      if(ticket!==epoch.current||!alive.current){s.getTracks().forEach(t=>t.stop());return;}
      const w=video.current.videoWidth,h=video.current.videoHeight;
      const needsCrop=needsResize(w,h);
      if(!safeNative(w,h)&&typeof HTMLCanvasElement.prototype.captureStream!=='function'){interrupt('Camera resolution is too high. Use a lower-resolution camera mode or another browser.');return;}
      setFit(needsCrop&&typeof HTMLCanvasElement.prototype.captureStream!=='function'?'contain':'cover');
      setMode('preview');setMessage(needsCrop&&typeof HTMLCanvasElement.prototype.captureStream!=='function'?'Native camera framing; server will fit the video into portrait.':'Ready to record.');
    }catch{if(alive.current&&ticket===epoch.current){stopTracks();setMode('idle');setMessage('Camera unavailable. Check permissions and retry.');}}
  }
  function start(){
    if(disabled||mode!=='preview'||!camera.current)return;
    cancelled.current=false;setMode('countdown');setCount(3);
    const ticket=epoch.current;
    function tick(n){if(ticket!==epoch.current||!camera.current)return;setCount(n);if(n>0)timer.current=setTimeout(()=>tick(n-1),1000);else record(ticket);}
    timer.current=setTimeout(()=>tick(2),1000);
  }
  function record(ticket){
    const s=camera.current,v=video.current;
    if(!s||!v?.videoWidth||ticket!==epoch.current){interrupt('Camera not ready.');return;}
    setMode('recording');setMessage('Recording three seconds…');
    const w=v.videoWidth,h=v.videoHeight;
    let stream=s;
    try{
      if(needsResize(w,h)&&typeof HTMLCanvasElement.prototype.captureStream==='function'){
        const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
        const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw Error();
        const rect=crop(w,h);ctx.drawImage(v,...rect,0,0,W,H);stream=canvas.captureStream(30);
        s.getAudioTracks().forEach(t=>stream.addTrack(t));
        let last=0;const draw=now=>{
          if(ticket!==epoch.current||cancelled.current)return;
          if(v.videoWidth!==w||v.videoHeight!==h){interrupt('Camera orientation changed. Retake.');return;}
          if(now-last>=1000/30-2){ctx.drawImage(v,...rect,0,0,W,H);last=now;}
          raf.current=requestAnimationFrame(draw);
        };raf.current=requestAnimationFrame(draw);
      }
      if(stream===s&&!safeNative(w,h)){interrupt('Camera resolution is too high. Please use another browser.');return;}
      capture.current=stream;
      const audio=stream.getAudioTracks().length>0;
      for(const mime of choices(audio)){
        if(mime&&!MediaRecorder.isTypeSupported(mime))continue;
        let r;
        try{
          r=new MediaRecorder(stream,{...(mime?{mimeType:mime}:{}),videoBitsPerSecond:2500000,...(audio?{audioBitsPerSecond:96000}:{})});
          const chunks=[];let started=0,stopped=0;
          recorder.current=r;
          r.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
          r.onerror=()=>interrupt('Recording failed. Please retake.');
          r.onstop=()=>{
            if(recorder.current!==r||ticket!==epoch.current||cancelled.current||!alive.current)return;
            recorder.current=null;clearTimeout(timer.current);stopTracks();
            const type=r.mimeType||chunks[0]?.type||'',blob=new Blob(chunks,{type});
            if(stopped-started<2700||stopped-started>3500||blob.size<=0||blob.size>MAX||!/^video\/(mp4|webm)(;|$)/i.test(type)){setMode('idle');setMessage('Recording timing or format was invalid. Please retake.');return;}
            url.current=URL.createObjectURL(blob);setReview(url.current);onTake(blob);setMode('review');setMessage('Review your scene or retake.');
          };
          r.start();started=performance.now();timer.current=setTimeout(()=>{if(r.state==='recording'){stopped=performance.now();r.stop();}},3000);return;
        }catch{if(r){r.onstop=null;r.onerror=null;r.ondataavailable=null;}recorder.current=null;}
      }
      throw Error();
    }catch{interrupt('Recording format unavailable. Try another browser.');}
  }
  return <section className="flex flex-col gap-3">
    <div className="relative mx-auto aspect-[9/16] w-full max-w-[260px] overflow-hidden rounded-2xl bg-[#24211e]">
      <video ref={video} autoPlay muted playsInline className="h-full w-full" style={{objectFit:fit,display:review?'none':'block'}} />
      {review&&<video src={review} controls playsInline className="absolute inset-0 h-full w-full object-contain" />}
      {count>0&&<span className="absolute inset-0 grid place-items-center text-6xl font-black text-white">{count}</span>}
      {mode==='recording'&&<span className="absolute left-3 top-3 rounded-full bg-[#b63222] px-3 py-1 text-sm font-bold text-white">REC · 3s</span>}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <button className="ptm-secondary" disabled={disabled||busy||mode==='review'} onClick={()=>openCamera()}>{mode==='preview'?'Restart camera':'Open camera'}</button>
      <button className="ptm-secondary" disabled={disabled||mode!=='preview'} onClick={()=>openCamera(facing==='user'?'environment':'user',mic)}>Flip</button>
      <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={mic} disabled={disabled||busy||mode==='review'} onChange={e=>{const value=e.target.checked;setMic(value);if(mode==='preview')openCamera(facing,value);}}/> Mic</label>
    </div>
    {mode==='review'?<button className="ptm-secondary" disabled={disabled} onClick={()=>openCamera()}>Retake</button>:<button className="ptm-primary" disabled={disabled||mode!=='preview'} onClick={start}>Record 3 seconds</button>}
    <p role="status" className="text-sm">{message}</p>
  </section>;
}
