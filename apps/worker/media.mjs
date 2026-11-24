import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { GAME_RULES as R } from '../../packages/shared/rules.mjs';

const exec = promisify(execFile);
const inputLimits = ['-protocol_whitelist','file','-format_whitelist','mov,matroska,webm','-max_alloc','67108864','-probesize','5000000','-analyzeduration','5000000'];
const videoFilter = 'setpts=PTS-STARTPTS,fps=30,scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2:out_range=tv,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.5,trim=end_frame=90,setpts=PTS-STARTPTS';
const audioFilter = 'asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=end_sample=144000,asetpts=N/SR/TB';
export class MediaError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const reject = code => { throw new MediaError(code); };
function finite(value) { return value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)); }
function rate(value) { const [a,b] = String(value).split('/').map(Number); return b > 0 ? a/b : NaN; }
function validVideo(s) {
  return ['h264','vp8','vp9'].includes(s.codec_name) && !s.disposition?.attached_pic && Number.isInteger(s.width) && Number.isInteger(s.height) && s.width>0 && s.height>0 && s.width<=1920 && s.height<=1920 && s.width*s.height<=2100000 && ['yuv420p','yuvj420p','yuv422p','yuvj422p','yuv444p','yuvj444p'].includes(s.pix_fmt) && !['smpte2084','arib-std-b67'].includes(s.color_transfer) && (!s.sample_aspect_ratio || ['1:1','N/A','0:1'].includes(s.sample_aspect_ratio));
}
export function validateSource(info, frames) {
  const streams=info.streams || [], vs=streams.filter(s=>s.codec_type==='video'), as=streams.filter(s=>s.codec_type==='audio');
  if(vs.length!==1 || as.length>1 || streams.length!==vs.length+as.length || !validVideo(vs[0])) reject('MEDIA_UNSUPPORTED');
  const v=vs[0], a=as[0];
  const format=String(info.format?.format_name||'').split(',');
  if(!format.some(f=>['mov','mp4','matroska','webm'].includes(f))) reject('MEDIA_UNSUPPORTED');
  if(a && (!['aac','opus'].includes(a.codec_name) || !Number.isInteger(a.channels) || a.channels<1 || a.channels>2 || !finite(a.sample_rate) || Number(a.sample_rate)<8000 || Number(a.sample_rate)>96000)) reject('MEDIA_UNSUPPORTED');
  const rotation=v.side_data_list?.find(x=>finite(x.rotation))?.rotation ?? 0;
  if(![0,90,-90,180,-180,270,-270,360,-360].includes(Number(rotation))) reject('MEDIA_UNSUPPORTED');
  if(!Array.isArray(frames)||frames.length<2||frames.length>212) reject('MEDIA_DURATION');
  const times=frames.map(f=>finite(f.best_effort_timestamp_time)?Number(f.best_effort_timestamp_time):NaN);
  if(times.some((t,i)=>!Number.isFinite(t)||Math.abs(t)>10||(i&&t<=times[i-1]))) reject('MEDIA_DURATION');
  if(frames.some(f=>f.width!==v.width||f.height!==v.height||f.pix_fmt!==v.pix_fmt)) reject('MEDIA_UNSUPPORTED');
  const last=frames.at(-1), gaps=times.slice(1).map((t,i)=>t-times[i]);
  const gap=gaps.at(-1), durationField=last.duration_time??last.pkt_duration_time;
  const tail=finite(durationField)&&Number(durationField)>0?Number(durationField):gap;
  const duration=times.at(-1)-times[0]+tail;
  const avg=frames.length/duration;
  if(duration<R.sourceMinSeconds||duration>R.sourceMaxSeconds||avg>61||avg<1||tail>0.5||gaps.some(g=>g>0.5)) reject('MEDIA_DURATION');
  if(a && (!finite(a.start_time)||Math.abs(Number(a.start_time)-times[0])>0.150)) reject('MEDIA_AV_OFFSET');
  return {hasAudio:!!a,duration,frames:frames.length,width:v.width,height:v.height,codec:v.codec_name};
}
export function createMediaProcessor({ffmpeg='ffmpeg',ffprobe='ffprobe',timeoutMs=20000}={}) {
  async function run(bin,args,code='MEDIA_PROCESSING_FAILED') {
    try { const result=await exec(bin,args,{timeout:timeoutMs,killSignal:'SIGKILL',maxBuffer:2*1024*1024,env:{PATH:process.env.PATH||'/usr/bin:/bin',LC_ALL:'C'}}); return result.stdout; }
    catch(e) { if(e.code==='ENOENT'||e.code==='EACCES') reject('MEDIA_TOOLCHAIN_UNAVAILABLE'); if(e.killed||e.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject('MEDIA_RESOURCE_LIMIT'); reject(code); }
  }
  async function probe(path,options=[],restricted=true) {
    const out=await run(ffprobe,['-v','error',...(restricted?inputLimits:[]),'-threads','2',...options,'-of','json',path],'MEDIA_INVALID');
    try{return JSON.parse(out);}catch{reject('MEDIA_INVALID');}
  }
  async function verifyScene(path) {
    const info=await probe(path,['-count_frames','-show_format','-show_streams']);
    const v=info.streams?.find(s=>s.codec_type==='video'), a=info.streams?.find(s=>s.codec_type==='audio');
    if(info.streams?.length!==2||!v||!a||v.codec_name!=='h264'||v.width!==720||v.height!==1280||v.pix_fmt!=='yuv420p'||v.sample_aspect_ratio!=='1:1'||rate(v.avg_frame_rate)!==30||Number(v.nb_read_frames)!==90||v.side_data_list?.some(x=>finite(x.rotation))||a.codec_name!=='aac'||Number(a.sample_rate)!==48000||a.channels!==2||!finite(info.format?.duration)||Math.abs(Number(info.format.duration)-3)>.05||[v,a].some(s=>!finite(s.start_time)||Math.abs(Number(s.start_time))>.001)) reject('MEDIA_OUTPUT_INVALID');
    const file=await stat(path); if(file.size<=0||file.size>R.maxUploadBytes) reject('MEDIA_OUTPUT_INVALID');
    await run(ffmpeg,['-nostdin','-hide_banner','-v','error','-xerror',...inputLimits,'-threads','2','-i',path,'-f','null','-'],'MEDIA_OUTPUT_INVALID');
    return {width:720,height:1280,frames:90,duration:3,codec:'h264',audioCodec:'aac',bytes:file.size};
  }
  async function normalizeScene(input,dir) {
    const src=resolve(input), dest=resolve(dir), scene=join(dest,'scene.mp4'), still=join(dest,'last.jpg');
    if(src===scene||src===still) reject('MEDIA_INVALID');
    const inputStat=await stat(src); if(!inputStat.isFile()||inputStat.size<=0||inputStat.size>R.maxUploadBytes) reject('MEDIA_TOO_LARGE');
    const info=await probe(src,['-show_streams','-show_format']);
    // Bound decode by timeout, allocation and output limits even if duration metadata is absent or false.
    const frames=(await probe(src,['-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time,duration_time,pkt_duration_time,width,height,pix_fmt'])).frames;
    const source=validateSource(info,frames);
    const audioArgs=source.hasAudio?[]:['-f','lavfi','-i','anullsrc=r=48000:cl=stereo'];
    await run(ffmpeg,['-nostdin','-hide_banner','-v','error','-xerror','-y','-filter_threads','2','-filter_complex_threads','2',...inputLimits,'-threads','2','-i',src,...audioArgs,'-map','0:v:0','-map',source.hasAudio?'0:a:0':'1:a:0','-vf',videoFilter,'-af',audioFilter,'-r','30','-fps_mode','cfr','-t','3','-c:v','libx264','-preset','veryfast','-crf','23','-maxrate','3M','-bufsize','6M','-threads','2','-pix_fmt','yuv420p','-color_range','tv','-c:a','aac','-b:a','96k','-ar','48000','-ac','2','-map_metadata','-1','-map_chapters','-1','-movflags','+faststart',scene]);
    const summary=await verifyScene(scene);
    await run(ffmpeg,['-nostdin','-hide_banner','-v','error','-xerror','-y',...inputLimits,'-threads','2','-i',scene,'-vf','select=eq(n\\,89)','-frames:v','1','-q:v','2',still]);
    const jpg=await readFile(still); if(jpg.length<4||jpg[0]!==255||jpg[1]!==216||jpg.at(-2)!==255||jpg.at(-1)!==217) reject('MEDIA_OUTPUT_INVALID');
    const image=await probe(still,['-count_frames','-show_streams'],false), frame=image.streams?.[0];
    if(image.streams?.length!==1||frame?.codec_name!=='mjpeg'||frame.width!==720||frame.height!==1280||Number(frame.nb_read_frames)!==1) reject('MEDIA_OUTPUT_INVALID');
    return {scene,still,summary};
  }
  return {normalizeScene,verifyScene};
}
