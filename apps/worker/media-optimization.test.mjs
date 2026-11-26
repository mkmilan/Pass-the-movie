import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, rename, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMediaProcessor } from './media.mjs';
const ff=(...args)=>execFileSync('ffmpeg',['-nostdin','-hide_banner','-v','error','-y','-filter_threads','2','-threads','2',...args],{timeout:30000,maxBuffer:4*1024*1024});
const probe=(file,...args)=>JSON.parse(execFileSync('ffprobe',['-v','error',...args,'-of','json',file],{timeout:30000,maxBuffer:4*1024*1024}));
const hashes=file=>probe(file,'-select_streams','v:0','-show_packets','-show_data_hash','sha256','-show_entries','packet=pts,data_hash').packets.sort((a,b)=>a.pts-b.pts).map(p=>p.data_hash);
function audioCheck(file){
  for(let i=0;i<5;i++){
    const data=ff('-ss',String(i*3+0.5),'-i',file,'-t','0.25','-vn','-ac','1','-ar','48000','-f','s16le','-');assert.equal(data.length,24000);
    let sum=0,crossings=0,previous=0;
    for(let j=0;j<data.length;j+=2){const n=data.readInt16LE(j);sum+=n*n;if(n>=0&&previous<0)crossings++;previous=n;}
    const rms=Math.sqrt(sum/(data.length/2));
    if(i===2)assert.ok(rms<10,'silent scene stays silent');
    else {assert.ok(rms>100,'audio remains audible');assert.ok(Math.abs(crossings*4-(440+110*i))<12,'audio scene order');}
  }
}
function timeline(file){
  const info=probe(file,'-show_streams');const v=info.streams.find(s=>s.codec_type==='video'),a=info.streams.find(s=>s.codec_type==='audio');
  assert.equal(Number(v.duration),15);assert.equal(Number(a.duration),15);assert.equal(Number(v.start_time),0);assert.equal(Number(a.start_time),0);
  const [n,d]=v.time_base.split('/').map(Number),step=d/n/30;
  const packets=probe(file,'-select_streams','v:0','-show_packets','-show_entries','packet=pts,duration').packets.sort((a,b)=>a.pts-b.pts);
  assert.equal(packets.length,450);packets.forEach((p,i)=>{assert.equal(Number(p.pts),i*step);assert.equal(Number(p.duration),step);});
}
test('fast assembly preserves packets, audio, exact timeline and clean scenes; incompatible streams fall back',{timeout:240000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ptm-media-opt-'));
  try{
    const media=createMediaProcessor(),sources=[];
    for(let i=0;i<5;i++){
      const raw=join(dir,'raw-'+i+'.mp4'),out=join(dir,'normalize-'+i);await mkdir(out);
      const tone=i===2?[]:['-f','lavfi','-i',`sine=frequency=${440+110*i}:sample_rate=48000`];
      ff('-f','lavfi','-i',`testsrc2=size=360x640:rate=${i%2?25:30}`,...tone,'-t','3','-c:v','libx264','-threads','2',...(tone.length?['-c:a','aac']:['-an']),raw);
      const normalized=await media.normalizeScene(raw,out);const path=join(dir,'scene-'+i+'.mp4');await rename(normalized.scene,path);sources.push(path);
    }
    const original=sources.map(hashes),all=original.flat();
    const paid=await media.assembleMovie(sources,dir,{brand:false});assert.equal(paid.summary.frames,450);assert.deepEqual(hashes(paid.final),all,'all paid video packets are copied unchanged');timeline(paid.final);audioCheck(paid.final);
    const free=await media.assembleMovie(sources,dir);assert.equal(free.summary.frames,450);const freeHashes=hashes(free.final);
    assert.deepEqual(freeHashes.slice(0,360),all.slice(0,360),'first four free scenes are copied unchanged');assert.notDeepEqual(freeHashes.slice(360),all.slice(360));timeline(free.final);audioCheck(free.final);
    const white=(file,at)=>{const raw=ff('-ss',String(at),'-i',file,'-frames:v','1','-vf','crop=260:48:230:100,format=gray','-f','rawvideo','-threads','1','-');return raw.reduce((n,b)=>n+(b>242),0);};
    assert.ok(white(free.final,12.5)>white(sources[4],0.5)+100,'watermark is rendered');
    assert.deepEqual(sources.map(hashes),original,'original scenes never change');
    assert.ok(!(await readdir(dir)).some(n=>/^(branded-|join-)/.test(n)),'temporary files removed');
    const alternate=join(dir,'alternate.mp4');
    ff('-i',sources[0],'-map','0:v:0','-map','0:a:0','-c:v','libx264','-profile:v','baseline','-bf','0','-threads','2','-c:a','copy',alternate);
    const fallbackSources=[alternate,...sources.slice(1)];
    const fallback=await media.assembleMovie(fallbackSources,dir,{brand:false});assert.equal(fallback.summary.frames,450);timeline(fallback.final);audioCheck(fallback.final);assert.notDeepEqual(hashes(fallback.final).slice(90,180),original[1]);
    const fallbackBrand=await media.assembleMovie(fallbackSources,dir);timeline(fallbackBrand.final);audioCheck(fallbackBrand.final);assert.ok(white(fallbackBrand.final,12.5)>white(sources[4],0.5)+100);
    await assert.rejects(media.assembleMovie(sources.slice(1),dir),{code:'MOVIE_SCENE_COUNT'});
    const broken=join(dir,'broken.mp4');await writeFile(broken,'invalid');await assert.rejects(media.assembleMovie([broken,...sources.slice(1)],dir),{code:'MEDIA_INVALID'});
    const controller=new AbortController();controller.abort();await assert.rejects(media.withSignal(controller.signal).assembleMovie(sources,dir),{code:'MEDIA_CANCELLED'});
  }finally{await rm(dir,{recursive:true,force:true});}
});
