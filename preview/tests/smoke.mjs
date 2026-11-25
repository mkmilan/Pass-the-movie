import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const origin='http://127.0.0.1:3000';
const context=await browser.newContext({viewport:{width:390,height:844},permissions:['camera','microphone'],acceptDownloads:true});
const page=await context.newPage(),external=[],writes=[],errors=[],dir=await mkdtemp(join(tmpdir(),'ptm-preview-'));
page.on('request',req=>{
  if(!req.url().startsWith(origin)&&!req.url().startsWith('blob:')&&!req.url().startsWith('data:'))external.push(req.url());
  if(!['GET','HEAD','OPTIONS'].includes(req.method()))writes.push(req.method()+' '+req.url());
});
page.on('pageerror',e=>errors.push(e.message));
const wait=async text=>page.getByText(text,{exact:true}).waitFor({timeout:45000});
const button=name=>page.getByRole('button',{name,exact:true});
async function record(){
  await button('Record 3 seconds').click({timeout:15000});
  await wait('Review your scene or retake.');
  await page.locator('video[controls]').waitFor();
}
async function verifyDownload({audio=false}={}){
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:/Download (MP4|WEBM)/}).click()]);
  const file=join(dir,download.suggestedFilename());await download.saveAs(file);
  assert.ok((await stat(file)).size>1000);
  const info=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',file],{encoding:'utf8',timeout:30000}));
  const video=info.streams.find(s=>s.codec_type==='video');
  assert.equal(video.width,720);assert.equal(video.height,1280);
  const duration=Number(info.format.duration??video.duration);
  if(Number.isFinite(duration))assert.ok(Math.abs(duration-15)<1.5,'movie duration: '+duration);
  else{
    const frames=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',file],{encoding:'utf8',timeout:30000})).frames;
    const elapsed=Number(frames.at(-1).best_effort_timestamp_time)-Number(frames[0].best_effort_timestamp_time);
    assert.ok(Math.abs(elapsed-15)<1.5,'video timestamp span: '+elapsed);
  }
  assert.ok(Number(video.nb_read_frames)>=180,'too few decoded frames: '+video.nb_read_frames);
  assert.equal(info.streams.some(s=>s.codec_type==='audio'),audio);
  execFileSync('ffmpeg',['-nostdin','-v','error','-xerror','-i',file,'-f','null','-'],{timeout:30000});
  console.log('PASS export '+download.suggestedFilename()+' / '+video.width+'x'+video.height+' / '+(Number.isFinite(duration)?duration:'timestamp-checked')+'s / '+video.nb_read_frames+' decoded frames / audio='+audio);
}
try{
  let downloads=0;page.on('download',()=>downloads++);
  await page.goto(origin);await wait('FREE PREVIEW');assert.equal(downloads,0);
  await button('Start a movie').click();
  for(let n=1;n<=5;n++){
    await wait('Scene '+n+' of 5');
    if(n>1)await page.getByRole('img',{name:'Last frame of the previous scene'}).waitFor();
    await page.getByRole('checkbox').check();
    await button('Continue to camera').click();
    if(n===1)await page.getByRole('checkbox',{name:'Mic'}).check();
    await button('Open camera').click();
    await record();
    if(n===1){
      await button('Retake').click();
      await record();
      console.log('PASS retake');
    }
    await button('Use this scene').click();
    if(n<5){await wait('Pass the phone!');await button("I'm the next player").click();}
  }
  await wait('The movie is complete.');
  await button('Reveal the movie').click();
  await wait('Making your movie…');
  await page.waitForFunction(()=>Number(document.querySelector('progress')?.value)>0,{},{timeout:15000});
  await button('Cancel export').click();
  await wait('The movie is complete.');
  await wait('Export cancelled. Your five scenes are still available in this tab.');
  assert.equal(await page.locator('video').count(),0);
  assert.equal(downloads,0);
  console.log('PASS cancelled export cleans up video elements and retains all five clips');
  await button('Reveal the movie').click();
  await wait('Your movie is ready!');
  assert.equal(downloads,0);
  await verifyDownload({audio:true});
  await button('Make another movie').click();
  await button('Try with five sample scenes').click();
  await wait('The movie is complete.');
  await button('Reveal the movie').click();
  await wait('Your movie is ready!');
  assert.equal(downloads,1);
  await verifyDownload();
  assert.equal(downloads,2);
  await button('Make another movie').click();
  await button('Start a movie').click();
  await button('Use a sample scene instead').click();await wait('Pass the phone!');
  page.once('dialog',dialog=>dialog.accept());
  await button('Delete demo movie').click();
  await button('Start a movie').waitFor();
  // A high-resolution portrait device can satisfy the browser's ideal
  // constraints with a larger feed. Verify the actual recorded Blob is 720p.
  const high=await context.newPage();
  high.on('pageerror',e=>errors.push(e.message));
  await high.addInitScript(()=>{
    navigator.mediaDevices.getUserMedia=async()=>{
      const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1920;
      const ctx=canvas.getContext('2d');let tick=0;
      const paint=()=>{ctx.fillStyle=tick++%2?'#53657a':'#ad7135';ctx.fillRect(0,0,canvas.width,canvas.height);};
      paint();const timer=setInterval(paint,1000/30);
      const stream=canvas.captureStream(30),track=stream.getVideoTracks()[0],stop=track.stop.bind(track);
      track.stop=()=>{clearInterval(timer);stop();};
      return stream;
    };
  });
  try{
    await high.goto(origin);
    const hb=name=>high.getByRole('button',{name,exact:true});
    await hb('Start a movie').click();await high.getByRole('checkbox').check();await hb('Continue to camera').click();
    await hb('Open camera').click();await hb('Record 3 seconds').click({timeout:15000});
    await high.getByText('Review your scene or retake.',{exact:true}).waitFor({timeout:45000});
    const result=await high.locator('video[controls]').evaluate(async video=>{
      if(!video.videoWidth)await new Promise((resolve,reject)=>{video.addEventListener('loadedmetadata',resolve,{once:true});video.addEventListener('error',reject,{once:true});});
      return [video.videoWidth,video.videoHeight];
    });
    assert.deepEqual(result,[720,1280]);console.log('PASS oversized portrait camera is resized before export/upload');
  }finally{await high.close();}
  assert.deepEqual(external,[]);assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  console.log('PASS five recorded scenes, reference frames, retake, cancel/retry, sound, silent sample export, reset and explicit-only downloads; no media uploads');
}finally{await browser.close();await rm(dir,{recursive:true,force:true});}
