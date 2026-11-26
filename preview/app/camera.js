'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './camera.module.css';

const W=720,H=1280,MAX=12*1024*1024;
const ROTATE_MESSAGE='Please rotate your phone to portrait mode.';
function landscapeNow(){
  // Viewport orientation works across mobile browsers. On touch devices also
  // consult the available screen orientation API; it may not exist on iOS.
  if(window.matchMedia('(orientation: landscape)').matches)return true;
  if(!window.matchMedia('(pointer: coarse)').matches)return false;
  const type=window.screen?.orientation?.type;
  if(type)return type.startsWith('landscape');
  return Math.abs(Number(window.orientation))===90;
}
function choices(audio){
  const avc=audio?'video/mp4;codecs=avc1.42E01E,mp4a.40.2':'video/mp4;codecs=avc1.42E01E';
  const vp8=audio?'video/webm;codecs=vp8,opus':'video/webm;codecs=vp8';
  const vp9=audio?'video/webm;codecs=vp9,opus':'video/webm;codecs=vp9';
  // Some Android AVC encoders deliver buffered frames long after the tap.
  const preferred=/Android/i.test(navigator.userAgent)?[vp8,avc]:[avc,vp8];
  return [...preferred,vp9,'video/mp4','video/webm',''];
}
function portrait(w,h){return w>0&&h>0&&Math.abs(w/h-W/H)<0.02;}
function needsResize(w,h){return !portrait(w,h)||w>W||h>H;}
function safeNative(w,h){return w>0&&h>0&&w<=1920&&h<=1920&&w*h<=2100000;}
function crop(w,h){const r=W/H;return w/h>r?[(w-h*r)/2,0,h*r,h]:[0,(h-w/r)/2,w,w/r];}
export default function CameraCapture({onTake,disabled=false,children}) {
  const video=useRef(null),alive=useRef(true),camera=useRef(null),capture=useRef(null),recorder=useRef(null),timer=useRef(null),raf=useRef(null),epoch=useRef(0),url=useRef(null),framingSize=useRef(null);
  const orientationBlocked=useRef(false),makeStream=useRef(null),frameWriter=useRef(null);
  const [landscape,setLandscape]=useState(false);
  const [mode,setMode]=useState('idle'),[facing,setFacing]=useState('user'),[mic,setMic]=useState(true),[message,setMessage]=useState('Open your camera when ready.'),[review,setReview]=useState(null),[fit,setFit]=useState('cover');
  const busy=mode==='opening'||mode==='recording';
  function stopTracks(){
    cancelAnimationFrame(raf.current);raf.current=null;
    frameWriter.current?.close().catch(()=>{});frameWriter.current=null;
    if(capture.current&&capture.current!==camera.current)capture.current.getVideoTracks().forEach(t=>t.stop());
    capture.current=null;framingSize.current=null;makeStream.current=null;
    camera.current?.getTracks().forEach(t=>t.stop());camera.current=null;
    if(video.current)video.current.srcObject=null;
  }
  function releaseReview(){if(url.current)URL.revokeObjectURL(url.current);url.current=null;setReview(null);}
  function interrupt(reason){
    ++epoch.current;clearTimeout(timer.current);
    const r=recorder.current;recorder.current=null;
    if(r&&r.state!=='inactive'){r.onstop=null;try{r.stop();}catch{}}
    stopTracks();
    if(alive.current){setMode('idle');setMessage(reason);}
  }
  useEffect(()=>{
    alive.current=true;
    const hide=()=>{if(document.hidden&&(camera.current||!url.current))interrupt('Camera paused. Open it again.');};
    const query=window.matchMedia('(orientation: landscape)'),screenOrientation=window.screen?.orientation;
    const syncOrientation=()=>{
      const next=landscapeNow(),previous=orientationBlocked.current;
      orientationBlocked.current=next;setLandscape(next);
      if(next&&!previous&&!url.current)interrupt('Camera paused. Open it again.');
      else if(!next&&previous&&!url.current&&!camera.current)setMessage('Open your camera when ready.');
    };
    const rotate=()=>{
      // Cancel even if the browser updates its orientation media query a little
      // later. A completed portrait take stays available for review.
      if(!url.current&&(camera.current||recorder.current))interrupt('Camera paused. Open it again.');
      syncOrientation();
    };
    syncOrientation();
    if(query.addEventListener)query.addEventListener('change',syncOrientation);
    else query.addListener?.(syncOrientation);
    screenOrientation?.addEventListener?.('change',rotate);
    window.addEventListener('resize',syncOrientation);
    const resize=()=>{const size=framingSize.current,v=video.current;if(size&&v&&(v.videoWidth!==size[0]||v.videoHeight!==size[1]))interrupt('Camera orientation changed. Retake.');};
    const pageHide=()=>{if(camera.current||recorder.current)interrupt('Camera paused. Open it again.');};
    const player=video.current;
    player?.addEventListener('resize',resize);
    document.addEventListener('visibilitychange',hide);window.addEventListener('orientationchange',rotate);window.addEventListener('pagehide',pageHide);
    return()=>{
      if(query.removeEventListener)query.removeEventListener('change',syncOrientation);
      else query.removeListener?.(syncOrientation);
      screenOrientation?.removeEventListener?.('change',rotate);
      window.removeEventListener('resize',syncOrientation);
      alive.current=false;interrupt('');if(url.current)URL.revokeObjectURL(url.current);player?.removeEventListener('resize',resize);document.removeEventListener('visibilitychange',hide);window.removeEventListener('orientationchange',rotate);window.removeEventListener('pagehide',pageHide);};
  },[]);
  async function openCamera(nextFacing=facing,nextMic=mic){
    if(disabled||busy||landscapeNow())return;
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){setMessage('Use Chrome or Safari on HTTPS or localhost.');return;}
    const ticket=++epoch.current;stopTracks();releaseReview();onTake(null);setMode('opening');setMessage('Opening camera…');setFacing(nextFacing);setMic(nextMic);
    const constraints={video:{facingMode:{ideal:nextFacing},width:{ideal:W},height:{ideal:H},aspectRatio:{ideal:9/16},frameRate:{ideal:30,max:60},resizeMode:'crop-and-scale'},audio:nextMic};
    try{
      const s=await navigator.mediaDevices.getUserMedia(constraints);
      if(!alive.current||ticket!==epoch.current||document.hidden||landscapeNow()){s.getTracks().forEach(t=>t.stop());if(alive.current&&ticket===epoch.current&&landscapeNow())interrupt('Camera paused. Open it again.');return;}
      camera.current=s;s.getTracks().forEach(t=>t.addEventListener('ended',()=>{if(camera.current===s)interrupt('Camera or microphone disconnected.');},{once:true}));
      if(nextMic&&!s.getAudioTracks().some(track=>track.readyState==='live'&&track.enabled)){
        interrupt('No microphone input. Allow microphone access, or switch Mic off.');return;
      }
      video.current.srcObject=s;await video.current.play();
      if(ticket!==epoch.current||!alive.current){s.getTracks().forEach(t=>t.stop());return;}
      if(landscapeNow()){interrupt('Camera paused. Open it again.');return;}
      const w=video.current.videoWidth,h=video.current.videoHeight;
      const needsCrop=needsResize(w,h);
      if((!safeNative(w,h)||!portrait(w,h))&&typeof HTMLCanvasElement.prototype.captureStream!=='function'){interrupt('This camera cannot record in portrait format. Try another browser.');return;}
      setFit(needsCrop&&typeof HTMLCanvasElement.prototype.captureStream!=='function'?'contain':'cover');
      prepareCapture(s,video.current,ticket);
      setMode('preview');setMessage('Ready to record.');
    }catch(error){
      if(alive.current&&ticket===epoch.current){
        interrupt(error.name==='NotAllowedError'||error.name==='NotFoundError'
          ? (nextMic?'Allow access to your camera and microphone, or switch Mic off and retry.':'Allow camera access and retry.')
          : 'Could not open the camera. Check the device and retry.');
      }
    }
  }
  function prepareCapture(source,player,ticket){
    const w=player.videoWidth,h=player.videoHeight;
    framingSize.current=[w,h];
    const android=/Android/i.test(navigator.userAgent);
    if((!android&&!needsResize(w,h))||typeof HTMLCanvasElement.prototype.captureStream!=='function'){
      makeStream.current=()=>source;return;
    }
    const canvas=document.createElement('canvas'),resize=needsResize(w,h);
    canvas.width=resize?W:w;canvas.height=resize?H:h;
    const ctx=canvas.getContext('2d',{alpha:false}),rect=crop(w,h);
    if(!ctx)throw Error('Canvas unavailable');
    // Keep the live preview warm. Its recording track must be new at the tap,
    // otherwise mobile browsers can encode preview frames from before the take.
    makeStream.current=()=>{
      let output,writer;
      if(android&&window.MediaStreamTrackGenerator&&window.VideoFrame){
        try{
          const track=new MediaStreamTrackGenerator({kind:'video'});
          writer=track.writable.getWriter();frameWriter.current=writer;
          output=new MediaStream([track]);
        }catch{writer=null;}
      }
      output??=canvas.captureStream(30);
      capture.current=output;
      source.getAudioTracks().forEach(track=>output.addTrack(track));
      let last=-Infinity,pending=false;
      function draw(now){
        if(ticket!==epoch.current)return;
        if(!pending&&now-last>=1000/30-2){
          ctx.drawImage(player,...rect,0,0,canvas.width,canvas.height);last=now;
          if(writer){
            // Supply a fresh frame and clock explicitly. Detached canvas capture
            // can stop producing pictures while the Android microphone keeps going.
            const frame=new VideoFrame(canvas,{timestamp:Math.round(now*1000)});
            pending=true;
            writer.write(frame).catch(()=>{
              if(ticket===epoch.current&&frameWriter.current===writer)interrupt('Camera frames stopped. Please retake.');
            }).finally(()=>{frame.close();pending=false;});
          }
        }
        raf.current=requestAnimationFrame(draw);
      }
      draw(performance.now());return output;
    };
  }
  function record(){
    const source=camera.current,v=video.current,ticket=epoch.current;
    if(disabled||mode!=='preview'||recorder.current||!makeStream.current||!v?.videoWidth)return;
    if(landscapeNow()){interrupt('Camera paused. Open it again.');return;}
    if(mic&&!source?.getAudioTracks().some(track=>track.readyState==='live'&&track.enabled&&!track.muted)){
      interrupt('No microphone input. Check your microphone, or switch Mic off.');return;
    }
    try{
      const stream=makeStream.current();capture.current=stream;
      const audio=stream.getAudioTracks().length>0;
      for(const mime of choices(audio)){
        if(mime&&!MediaRecorder.isTypeSupported(mime))continue;
        let r;
        try{
          r=new MediaRecorder(stream,{...(mime?{mimeType:mime}:{}),videoBitsPerSecond:2500000,...(audio?{audioBitsPerSecond:96000}:{})});
          const chunks=[];let started=0,stopped=0;
          recorder.current=r;
          r.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
          r.onerror=()=>{if(recorder.current===r)interrupt('Recording failed. Please retake.');};
          r.onstop=()=>{
            if(recorder.current!==r||ticket!==epoch.current||!alive.current)return;
            if(landscapeNow()){interrupt('Camera paused. Open it again.');return;}
            recorder.current=null;clearTimeout(timer.current);stopTracks();
            const type=r.mimeType||chunks[0]?.type||'',blob=new Blob(chunks,{type});
            if(stopped-started<2700||stopped-started>3500||blob.size<=0||blob.size>MAX||!/^video\/(mp4|webm)(;|$)/i.test(type)){setMode('idle');setMessage('Recording timing or format was invalid. Please retake.');return;}
            url.current=URL.createObjectURL(blob);setReview(url.current);onTake(blob);setMode('review');setMessage('Review your scene or retake.');
          };
          // Encoders can emit the start event well after capturing the opening frames.
          // Time the take from the successful start call in the user's tap handler.
          r.start();
          started=performance.now();
          setMode('recording');setMessage('Recording three seconds…');
          timer.current=setTimeout(()=>{
            if(landscapeNow()){interrupt('Camera paused. Open it again.');return;}
            if(r.state!=='recording'){interrupt('Recording stopped early. Please retake.');return;}
            stopped=performance.now();r.stop();
            timer.current=setTimeout(()=>interrupt('Could not finish recording. Please retake.'),6000);
          },3000);
          return;
        }catch{if(r){r.onstop=null;r.onerror=null;r.ondataavailable=null;}recorder.current=null;}
      }
      throw Error();
    }catch{interrupt('Recording format unavailable. Try another browser.');}
  }
  return <section className={styles.camera} aria-label="Scene camera">
    <div className={styles.frame}>
      <video ref={video} autoPlay muted playsInline aria-label="Live camera" style={{objectFit:fit,display:review?'none':'block'}} />
      {review&&<video src={review} controls playsInline aria-label="Recorded scene" onError={()=>{if(url.current!==review)return;releaseReview();onTake(null);setMode('idle');setMessage('This recording could not be played. Please retake.');}} />}
      {mode==='idle'&&<span className={styles.framing} aria-hidden="true"/>}
      {mode==='recording'&&<span className={styles.recording}>● REC</span>}
    </div>
    <p role="status" className={styles.status}>{landscape?ROTATE_MESSAGE:message}</p>
    {mode==='review'?<div className={styles.actions}>
      <button className="ptm-secondary" disabled={disabled||landscape} onClick={()=>openCamera()}>Retake</button>
      {children}
    </div>:<>
      <div className={styles.tools}>
        <label><input type="checkbox" aria-label="Mic" checked={mic} disabled={disabled||landscape||busy} onChange={e=>{const value=e.target.checked;setMic(value);if(mode==='preview')openCamera(facing,value);}}/>Mic {mic?'on':'off'}</label>
        <button type="button" disabled={disabled||landscape||mode!=='preview'} onClick={()=>openCamera(facing==='user'?'environment':'user',mic)}>Flip camera</button>
      </div>
      {mode==='idle'||mode==='opening'
        ? <button className="ptm-primary" disabled={disabled||landscape||busy} onClick={()=>openCamera()}>{mode==='opening'?'Opening camera…':'Open camera'}</button>
        : <button className="ptm-primary" disabled={disabled||landscape||mode!=='preview'} onClick={record}>{mode==='recording'?'Recording…':'Record 3 seconds'}</button>}
    </>}
  </section>;
}
