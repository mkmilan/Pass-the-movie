// Android encoders may give camera and microphone tracks different clock origins.
// Timestamp each viewfinder frame from the tap and copy the microphone packets onto that timeline.
import {BlobSource, BufferTarget, CanvasSource, EncodedAudioPacketSource, EncodedPacketSink,
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

export async function prepareAndroidTake(player,microphone,width,height,rect){
  const quality=new Quality({bitrate:2_500_000});
  if(microphone&&!MediaRecorder.isTypeSupported(AUDIO))return null;
  if(!await canEncodeVideo('vp8',{width,height,quality}))return null;

  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:false});
  const target=new BufferTarget(),output=new Output({target,format:new WebMOutputFormat()});
  const picture=new CanvasSource(canvas,{codec:'vp8',quality,latencyMode:'quality'});
  output.addVideoTrack(picture,{frameRate:24});
  const sound=microphone?new EncodedAudioPacketSource('opus'):null;
  if(sound)output.addAudioTrack(sound);
  const mic=sound?new MediaRecorder(new MediaStream([microphone]),{mimeType:AUDIO,audioBitsPerSecond:96000}):null;
  await output.start(); // Manual packet sources stay empty until Record is tapped.

  let frame,timer,watchdog,cancelled=false,rejectTake;
  function cancel(){
    if(cancelled)return;
    cancelled=true;cancelAnimationFrame(frame);clearTimeout(timer);clearTimeout(watchdog);
    if(mic?.state==='recording')mic.stop();
    if(output.state==='started')output.cancel().catch(()=>{});
    rejectTake?.(Error('Recording cancelled.'));
  }
  function record(onFinishing){
    return new Promise((resolve,reject)=>{
      rejectTake=reject;
      const start=performance.now(),chunks=[];
      let last=-1,pending=Promise.resolve(),writing=false,finishing=false;
      function fail(error){reject(error);cancel();}
      const micBlob=mic&&new Promise(done=>{
        mic.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
        mic.onerror=()=>fail(Error('Microphone recording failed. Please retake.'));
        mic.onstop=()=>done(new Blob(chunks,{type:AUDIO}));
      });
      const paint=()=>ctx.drawImage(player,...rect,0,0,width,height);
      function sample(){
        if(cancelled||finishing)return;
        const t=last<0?0:(performance.now()-start)/1000;
        if(!writing&&t-last>=FRAME&&t<SECONDS-FRAME){
          try{
            paint();last=t;writing=true;
            pending=picture.add(t,FRAME).then(()=>{writing=false;});
            pending.catch(fail);
          }catch(e){fail(e);return;}
        }
        frame=requestAnimationFrame(sample);
      }
      async function finish(){
        if(cancelled)return;
        finishing=true;cancelAnimationFrame(frame);
        try{
          mic?.stop();paint();onFinishing();
          watchdog=setTimeout(()=>fail(Error('The phone could not finish saving this take.')),12000);
          await pending;
          if(cancelled)return;
          await picture.add(SECONDS-FRAME,FRAME);
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
        sample();
      }catch(e){fail(e);}
    });
  }
  return {record,cancel};
}
