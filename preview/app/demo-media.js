// Browser-only demonstration. No uploads, storage service or FFmpeg calls.
const W=720,H=1280,SECONDS=3,COUNT=5;
const themes=[
  ['#f4c95d','#253c4b','THE FIND'],['#e2e8d6','#294b46','THE CHASE'],
  ['#e8bfa9','#693a38','THE TURN'],['#bed9e9','#293f5b','THE CATCH'],
  ['#f2d89b','#4c3931','THE END']
];
const clamp=(v,a,b)=>Math.max(a,Math.min(v,b));
function check(signal){if(signal?.aborted)throw new Error('Preview cancelled.');}
function canvas(){const c=document.createElement('canvas');c.width=W;c.height=H;return c;}
function fit(ctx,v){
  if(!v.videoWidth||!v.videoHeight||v.readyState<2)throw new Error('A recording could not be decoded.');
  const f=Math.min(W/v.videoWidth,H/v.videoHeight),w=v.videoWidth*f,h=v.videoHeight*f;
  ctx.fillStyle='#181818';ctx.fillRect(0,0,W,H);ctx.drawImage(v,(W-w)/2,(H-h)/2,w,h);
}
function sample(ctx,n,t){
  const [bg,ink,title]=themes[n-1],p=clamp(t/SECONDS,0,1),x=130+460*(n%2?p:1-p),y=720-240*Math.sin(Math.PI*p);
  ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
  ctx.fillStyle=ink;ctx.fillRect(0,980,W,300);
  ctx.strokeStyle=ink;ctx.lineWidth=5;ctx.beginPath();ctx.moveTo(75,830);ctx.quadraticCurveTo(360,380,645,830);ctx.stroke();
  ctx.fillStyle='#b63222';ctx.beginPath();ctx.arc(x,y,74,0,Math.PI*2);ctx.fill();
  ctx.fillStyle=ink;ctx.font='bold 34px system-ui';ctx.textAlign='center';ctx.fillText('SCENE '+n+' / 5',360,200);
  ctx.font='bold 58px system-ui';ctx.fillText(title,360,285);
  ctx.fillStyle='#fff9f0';ctx.font='bold 30px system-ui';ctx.fillText('SAMPLE ANIMATION',360,1130);
}
function label(ctx){ctx.fillStyle='rgba(20,20,20,.62)';ctx.fillRect(222,84,276,48);ctx.font='bold 24px system-ui';ctx.textAlign='center';ctx.fillStyle='white';ctx.fillText('PASS THE MOVIE',360,116);}
function eventWait(target,type,signal,ms=7000){
  return new Promise((resolve,reject)=>{
    let timer;
    const clean=()=>{clearTimeout(timer);target.removeEventListener(type,ok);target.removeEventListener('error',bad);signal?.removeEventListener('abort',abort);};
    const ok=()=>{clean();resolve();},bad=()=>{clean();reject(new Error('Could not read the recorded video. Try a new take.'));},abort=()=>{clean();reject(new Error('Preview cancelled.'));};
    target.addEventListener(type,ok,{once:true});target.addEventListener('error',bad,{once:true});signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>{clean();reject(new Error('Video preparation timed out.'));},ms);
    if(signal?.aborted)abort();
  });
}
async function loadVideo(blob,signal){
  check(signal);const v=document.createElement('video'),url=URL.createObjectURL(blob);
  v.preload='auto';v.playsInline=true;v.muted=true;
  v.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  const cleanup=()=>{v.pause();v.removeAttribute('src');v.load();v.remove();URL.revokeObjectURL(url);};
  try{
    const ready=eventWait(v,'loadeddata',signal);v.src=url;v.load();await ready;
    return {v,cleanup};
  }catch(e){cleanup();throw e;}
}
export async function lastFrame(scene,signal){
  const c=canvas(),ctx=c.getContext('2d');
  if(scene.kind==='sample'){sample(ctx,scene.number,3);return c.toDataURL('image/jpeg',.86);}
  const {v,cleanup}=await loadVideo(scene.blob,signal);
  try{
    fit(ctx,v);
    if(Number.isFinite(v.duration)&&v.duration>.08){
      const end=Math.max(0,v.duration-.04),seek=eventWait(v,'seeked',signal);
      v.currentTime=end;await seek;fit(ctx,v);
    }else{
      // Some MediaRecorder WebM files have no duration metadata. Play them
      // through and keep the last decoded image, bounded by a short timeout.
      await v.play();
      await new Promise((resolve,reject)=>{
        const begin=performance.now();let frame;
        const finish=(error)=>{cancelAnimationFrame(frame);v.pause();error?reject(error):resolve();};
        const tick=()=>{if(signal?.aborted||document.hidden){finish(new Error('Keep the preview open while preparing the frame.'));return;}
          try{if(v.readyState>=2)fit(ctx,v);}catch(e){finish(e);return;}
          if(v.ended||performance.now()-begin>3500){finish();return;}frame=requestAnimationFrame(tick);
        };tick();
      });
    }
    return c.toDataURL('image/jpeg',.86);
  }finally{cleanup();}
}
function recorderFor(stream,audio){
  const types=audio?['video/mp4;codecs=avc1.42E01F,mp4a.40.2','video/webm;codecs=vp8,opus','video/mp4','video/webm','']:['video/mp4;codecs=avc1.42E01F','video/webm;codecs=vp8','video/mp4','video/webm',''];
  for(const type of types){
    if(type&&!MediaRecorder.isTypeSupported(type))continue;
    try{return new MediaRecorder(stream,{...(type?{mimeType:type}:{}),videoBitsPerSecond:2200000,...(audio?{audioBitsPerSecond:96000}:{})});}catch{}
  }
  throw new Error('This browser cannot create a movie file. Try Android Chrome or a desktop browser.');
}
export async function renderMovie(scenes,{sound=false,signal,onProgress=()=>{}}={}){
  if(scenes.length!==COUNT)throw new Error('Five scenes are required.');
  if(!window.MediaRecorder||typeof HTMLCanvasElement.prototype.captureStream!=='function')throw new Error('Video export is not supported in this browser. Try Chrome.');
  if(document.hidden)throw new Error('Keep this tab visible during export.');
  check(signal);
  const c=canvas(),ctx=c.getContext('2d',{alpha:false}),loaded=[],hasClips=scenes.some(s=>s.kind==='clip');
  let audio,stream,recorder,frame,active=-1,timeout,abortHandler,visibilityHandler;
  try{
    // Resume in the user-initiated export action. No microphone is opened here.
    if(sound&&hasClips){
      const Audio=window.AudioContext||window.webkitAudioContext;
      if(!Audio)throw new Error('Sound export is unavailable. Turn off export sound and retry.');
      audio=new Audio();
      await audio.resume();
      if(audio.state!=='running')throw new Error('Sound export is unavailable. Turn off export sound and retry.');
    }
    const dest=audio?.createMediaStreamDestination();
    for(const scene of scenes){
      check(signal);
      if(scene.kind==='clip'){
        const item=await loadVideo(scene.blob,signal);loaded.push(item);
        if(dest){item.v.muted=false;audio.createMediaElementSource(item.v).connect(dest);}else item.v.muted=true;
      }else loaded.push(null);
    }
    check(signal);
    const paint=(n,t)=>{const entry=loaded[n];if(entry)fit(ctx,entry.v);else sample(ctx,scenes[n].number,t);label(ctx);};
    paint(0,0);stream=c.captureStream(30);
    if(dest)for(const track of dest.stream.getAudioTracks())stream.addTrack(track);
    recorder=recorderFor(stream,!!dest);
    const blob=await new Promise((resolve,reject)=>{
      let settled=false,started=0,chunks=[];
      const fail=message=>{
        if(settled)return;settled=true;cancelAnimationFrame(frame);clearTimeout(timeout);
        try{if(recorder.state!=='inactive')recorder.stop();}catch{}
        reject(new Error(message));
      };
      abortHandler=()=>fail('Preview cancelled.');
      visibilityHandler=()=>{if(document.hidden)fail('Keep the app open while it makes the movie. Retry when ready.');};
      signal?.addEventListener('abort',abortHandler,{once:true});document.addEventListener('visibilitychange',visibilityHandler);
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      recorder.onerror=()=>fail('Browser video export failed. Try again or turn off export sound.');
      recorder.onstop=()=>{
        if(settled)return;settled=true;clearTimeout(timeout);
        const type=recorder.mimeType||chunks[0]?.type||'',result=new Blob(chunks,{type});
        if(!/^video\/(mp4|webm)(;|$)/i.test(type)||!result.size||result.size>24*1024*1024){reject(new Error('The browser did not produce a supported movie file.'));return;}
        resolve(result);
      };
      const tick=()=>{
        if(settled)return;
        const elapsed=(performance.now()-started)/1000;
        if(signal?.aborted||document.hidden){fail('Export interrupted. Please retry.');return;}
        if(elapsed>=COUNT*SECONDS){loaded[active]?.v.pause();onProgress(100);recorder.stop();return;}
        const n=Math.min(COUNT-1,Math.floor(elapsed/SECONDS));
        if(n!==active){
          loaded[active]?.v.pause();active=n;
          if(loaded[n])loaded[n].v.play().catch(()=>fail('Browser blocked video playback during export. Try without sound or use Chrome.'));
        }
        try{paint(n,elapsed-n*SECONDS);}catch(e){fail(e.message);return;}
        onProgress(Math.min(99,Math.floor(elapsed/(COUNT*SECONDS)*100)));
        frame=requestAnimationFrame(tick);
      };
      try{recorder.start();started=performance.now();timeout=setTimeout(()=>fail('Export timed out. Please retry.'),24000);tick();}
      catch{fail('The browser could not start video export.');}
    });
    return blob;
  }finally{
    cancelAnimationFrame(frame);clearTimeout(timeout);
    signal?.removeEventListener('abort',abortHandler);document.removeEventListener('visibilitychange',visibilityHandler);
    if(recorder&&recorder.state!=='inactive')try{recorder.stop();}catch{}
    stream?.getTracks().forEach(t=>t.stop());
    for(const entry of loaded)entry?.cleanup();
    if(audio)await audio.close().catch(()=>{});
  }
}
