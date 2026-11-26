import { basename, dirname, join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const watermark = "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='PASS THE MOVIE':fontsize=25:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=9:x=(w-tw)/2:y=112";
const header=['-nostdin','-hide_banner','-v','error','-xerror','-y','-filter_threads','2','-filter_complex_threads','2'];
const videoArgs=['-r','30','-fps_mode','cfr','-c:v','libx264','-preset','veryfast','-crf','23','-maxrate','3M','-bufsize','6M','-threads','2','-pix_fmt','yuv420p','-color_range','tv'];
const audioArgs=['-c:a','aac','-b:a','96k','-ar','48000','-ac','2'];
const metadata=['-map_metadata','-1','-map_chapters','-1','-movflags','+faststart'];
const fields=['extradata_hash','time_base','codec_tag_string','profile','level','field_order','has_b_frames','color_range','color_space','color_transfer','color_primaries','chroma_location'];
export function videoFingerprint(v) {
  if(!v?.extradata_hash || !v.time_base)return null;
  return JSON.stringify(fields.map(k=>v[k]??null));
}

// Only use concat on worker-owned, same-directory files with compatible H.264
// decoder configuration. Re-encode audio to eliminate per-clip AAC priming.
export async function tryStreamCopy({sources,dir,final,brand,details,run,probe,verifyOutput,inputLimits,rules}) {
  const {sceneSeconds,sceneCount,fps}=rules,seconds=sceneSeconds*sceneCount;
  const same=details[0]?.fingerprint;
  if(!same||details.some(d=>d.fingerprint!==same)||sources.some(p=>dirname(p)!==dir||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(basename(p))))return null;
  const id=randomUUID(),branded=join(dir,'branded-'+id+'.mp4'),list=join(dir,'join-'+id+'.ffconcat');
  const videoSources=[...sources];
  try{
    if(brand){
      await run('ffmpeg',[...header,...inputLimits,'-threads','2','-i',sources.at(-1),'-map','0:v:0','-map','0:a:0','-vf',watermark,'-t',String(sceneSeconds),...videoArgs,'-c:a','copy',...metadata,branded]);
      const verified=await verifyOutput(branded,sceneSeconds,true);
      if(verified.fingerprint!==same)return null;
      videoSources[videoSources.length-1]=branded;
    }
    await writeFile(list,'ffconcat version 1.0\n'+videoSources.map(p=>`file '${basename(p)}'\nduration ${sceneSeconds}\n`).join(''),{flag:'wx'});
    const graph=sources.map((_,i)=>`[${i+1}:a]apad,atrim=end_sample=${sceneSeconds*48000},asetpts=N/SR/TB[a${i}]`).join(';')+';'+sources.map((_,i)=>`[a${i}]`).join('')+`concat=n=${sceneCount}:v=0:a=1[a]`;
    const concatLimits=inputLimits.map(x=>x==='mov,matroska,webm'?'concat,mov,matroska,webm':x);
    await run('ffmpeg',[...header,'-copyts',...concatLimits,'-safe','1','-auto_convert','0','-f','concat','-i',list,...sources.flatMap(p=>[...inputLimits,'-threads','2','-i',p]),'-filter_complex',graph,'-map','0:v:0','-map','[a]','-t',String(seconds),'-c:v','copy',...audioArgs,...metadata,final]);
    const checked=await verifyOutput(final,seconds,true);
    // Validate the whole output (including full decode in verifyOutput) and
    // require an exact, gap-free 30 fps video timeline and aligned audio.
    const packets=await probe(final,['-select_streams','v:0','-show_packets','-show_entries','packet=pts,duration']);
    const [num,den]=String(checked.timeBase).split('/').map(Number),step=den/(num*fps);
    const timeline=(packets.packets||[]).sort((a,b)=>Number(a.pts)-Number(b.pts));
    if(!Number.isInteger(step)||timeline.length!==seconds*fps||timeline.some((p,i)=>Number(p.pts)!==i*step||Number(p.duration)!==step)||!Number.isFinite(checked.audioDuration)||Math.abs(checked.audioDuration-seconds)>.05)return null;
    return checked.summary;
  }catch(e){
    // Compatibility failures may fall back. Never retry a cancellation,
    // resource-limit failure, toolchain failure, or filesystem failure.
    if(!['MEDIA_PROCESSING_FAILED','MEDIA_INVALID','MEDIA_OUTPUT_INVALID'].includes(e?.code))throw e;
    return null;
  }finally{
    await rm(list,{force:true});await rm(branded,{force:true});
  }
}
