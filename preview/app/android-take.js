// Android encoders may give camera and microphone tracks different clock origins.
// Timestamp each viewfinder frame from the tap and copy the microphone packets onto that timeline.
import {BlobSource, BufferTarget, VideoSample, VideoSampleSource, EncodedAudioPacketSource, EncodedPacketSink,
  Input, WEBM, Output, Quality, WebMOutputFormat, canEncodeVideo} from 'mediabunny';

const SECONDS=3, FRAME=1/24, AUDIO='audio/webm;codecs=opus';

async function copyMicrophone(blob,destination){
  const input=new Input({source:new BlobSource(blob),formats:[WEBM]});
  try{
    const track=await input.getPrimaryAudioTrack();
    if(!track)throw Error('The microphone recording was empty.');
    const decoderConfig=await track.getDecoderConfig();
    let origin;
    for await(const packet of new EncodedPacketSink(track).packets()){
      origin??=packet.timestamp;
      const timestamp=packet.timestamp-origin;
      if(timestamp>=SECONDS)break;
      await destination.add(packet.clone({timestamp}),{decoderConfig});
    }
    if(origin===undefined)throw Error('The microphone recording was empty.');
  }finally{input.dispose();}
}

export async function prepareAndroidTake(player,stream,width,height,rect){
  const microphone=stream.getAudioTracks()[0];
  const quality=new Quality({bitrate:2_500_000});
  if(microphone&&!MediaRecorder.isTypeSupported(AUDIO))return null;
  if(!await canEncodeVideo('vp8',{width,height,quality}))return null;

  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:false});
  const target=new BufferTarget(),output=new Output({target,format:new WebMOutputFormat()});
  const picture=new VideoSampleSource({codec:'vp8',quality,latencyMode:'quality'});
  output.addVideoTrack(picture,{frameRate:24});
  const sound=microphone?new EncodedAudioPacketSource('opus'):null;
  if(sound)output.addAudioTrack(sound);
  const mic=sound?new MediaRecorder(new MediaStream([microphone]),{mimeType:AUDIO,audioBitsPerSecond:96000}):null;
  await output.start(); // Manual packet sources stay empty until Record is tapped.

  let frame,timer,watchdog,cancelled=false,rejectTake,reader,latest,onInput;
  if(window.MediaStreamTrackProcessor){
    try{
      reader=new MediaStreamTrackProcessor({track:stream.getVideoTracks()[0],maxBufferSize:1}).readable.getReader();
      (async()=>{
        while(reader){
          const {value,done}=await reader.read();
          if(done||!reader){value?.close();break;}
          latest?.close();latest=value;onInput?.();
        }
      })().catch(()=>{});
    }catch{}
  }
  function releaseInput(){
    onInput=null;reader?.cancel().catch(()=>{});reader=null;latest?.close();latest=null;
  }
  function snapshot(timestamp){
    const timing={timestamp,duration:FRAME};
    if(latest&&latest.displayWidth===width&&latest.displayHeight===height&&!latest.rotation){
      return new VideoSample(latest.clone(),timing);
    }
    ctx.drawImage(latest||player,...rect,0,0,width,height);
    return new VideoSample(canvas,timing);
  }
  function cancel(){
    if(cancelled)return;
    cancelled=true;cancelAnimationFrame(frame);clearTimeout(timer);clearTimeout(watchdog);
    releaseInput();
    if(mic?.state==='recording')mic.stop();
    if(output.state==='started')output.cancel().catch(()=>{});
    rejectTake?.(Error('Recording cancelled.'));
  }
  function record(onFinishing){
    return new Promise((resolve,reject)=>{
      rejectTake=reject;
      const start=performance.now(),chunks=[];
      let last=-1,pending=Promise.resolve(),queued=0,finishing=false;
      function fail(error){reject(error);cancel();}
      const micBlob=mic&&new Promise(done=>{
        mic.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
        mic.onerror=()=>fail(Error('Microphone recording failed. Please retake.'));
        mic.onstop=()=>done(new Blob(chunks,{type:AUDIO}));
      });
      // Snapshot before waiting for the encoder. Its initialisation can take
      // longer than a spoken word. Bound the number of outstanding frames.
      function enqueue(time){
        const image=snapshot(time);queued++;
        pending=pending.then(()=>{if(!cancelled)return picture.add(image);})
          .finally(()=>{image.close();queued--;});
        pending.catch(fail);
      }
      function sample(){
        if(cancelled||finishing)return;
        const t=last<0?0:(performance.now()-start)/1000;
        if(queued>=6||t-last<FRAME||t>=SECONDS-FRAME)return;
        try{enqueue(t);last=t;}catch(e){fail(e);}
      }
      function tick(){sample();if(!cancelled&&!finishing)frame=requestAnimationFrame(tick);}
      async function finish(){
        if(cancelled)return;
        finishing=true;cancelAnimationFrame(frame);
        try{
          mic?.stop();enqueue(SECONDS-FRAME);onFinishing();releaseInput();
          watchdog=setTimeout(()=>fail(Error('The phone could not finish saving this take.')),12000);
          await pending;
          if(cancelled)return;
          picture.close();
          if(sound){await copyMicrophone(await micBlob,sound);sound.close();}
          if(cancelled)return;
          await output.finalize();clearTimeout(watchdog);
          resolve(new Blob([target.buffer],{type:'video/webm'}));
        }catch(e){fail(e);}
      }
      try{
        mic?.start();
        timer=setTimeout(finish,SECONDS*1000);
        onInput=sample;tick();
      }catch(e){fail(e);}
    });
  }
  return {record,cancel};
}
