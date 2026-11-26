import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const browser=await chromium.launch({headless:true,executablePath:process.env.PTM_CHROMIUM_PATH,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
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
async function checkWatermarkOption({ escape = false } = {}) {
  const trigger = page.getByRole('button', {name: /Remove watermark/});
  await trigger.click();
  const dialog = page.getByRole('dialog', {name: 'Remove watermark'});
  await dialog.waitFor();
  await dialog.getByText('With watermark', {exact: true}).waitFor();
  await dialog.getByText('Without watermark', {exact: true}).waitFor();
  assert.ok(await dialog.getByRole('button', {name: 'Continue to payment'}).isDisabled());
  if (escape) await page.keyboard.press('Escape');
  else await dialog.getByRole('button', {name: 'Continue for free'}).click();
  await dialog.waitFor({state: 'hidden'});
  assert.ok(await trigger.evaluate(el => el === document.activeElement));
}
async function controlsFit(){
  const positions=await page.locator('main button:visible,main a:visible,main input:visible').evaluateAll(nodes=>
    nodes.filter(el=>!el.closest('dialog:not([open])')).map(el=>{
      const r=el.getBoundingClientRect();
      return {name:el.textContent||el.getAttribute('aria-label'),fits:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth};
    })
  );
  assert.deepEqual(positions.filter(el=>!el.fits),[],'controls outside the viewport');
  assert.equal(await page.evaluate(()=>scrollY),0,'the user should not need to scroll');
}
async function record(){
  await button('Record 3 seconds').click({timeout:15000});
  await wait('Review your scene or retake.');
  await page.locator('video[controls]').waitFor();
  const delay=await page.evaluate(()=>window.recorderDelay);
  assert.ok(delay>=0&&delay<150,'recorder start after tap: '+delay+' ms');
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
  if(audio){
    const pcm=execFileSync('ffmpeg',['-nostdin','-v','error','-i',file,'-t','3','-map','0:a:0','-ac','1','-ar','16000','-f','s16le','pipe:1']);
    let peak=0;
    for(let i=0;i+1<pcm.length;i+=2)peak=Math.max(peak,Math.abs(pcm.readInt16LE(i)));
    assert.ok(peak>250,'the microphone signal must survive export, peak='+peak);
  }
  console.log('PASS export '+download.suggestedFilename()+' / '+video.width+'x'+video.height+' / '+(Number.isFinite(duration)?duration:'timestamp-checked')+'s / '+video.nb_read_frames+' decoded frames / audio='+audio);
}
try{
  await page.addInitScript(()=>{
    document.addEventListener('click',e=>{
      if(e.target.closest('button')?.textContent==='Record 3 seconds')window.recordTap=performance.now();
    },true);
    const start=MediaRecorder.prototype.start;
    MediaRecorder.prototype.start=function(...args){
      window.recorderDelay=performance.now()-window.recordTap;
      return start.apply(this,args);
    };
  });
  await page.setViewportSize({width:360,height:640});
  let downloads=0;page.on('download',()=>downloads++);
  await page.goto(origin);await wait('FREE PREVIEW');assert.equal(downloads,0);
  await button('Start a movie').click();
  for(let n=1;n<=5;n++){
    await wait('Scene '+n+' of 5');
    if(n>1)await page.getByRole('img',{name:'Last frame of the previous scene'}).waitFor();
    await controlsFit();
    await page.getByRole('checkbox').check();
    await button('Continue to camera').click();
    await controlsFit();
    if(n===2){
      await button('Previous frame').click();
      await page.getByRole('dialog',{name:'Previous frame'}).getByRole('img').waitFor();
      await button('Close').click();
    }
    if(n===1){
      const rotateMessage='Please rotate your phone to portrait mode.';
      const landscape=()=>page.setViewportSize({width:844,height:390});
      const portrait=()=>page.setViewportSize({width:360,height:640});
      async function assertBlocked(){
        await wait(rotateMessage);
        assert.equal(await button('Open camera').isDisabled(),true);
        assert.equal(await button('Record 3 seconds').count(),0);
        assert.equal(await button('Use this scene').count(),0);
        assert.equal(await page.locator('video[controls]').count(),0);
      }
      await landscape();await assertBlocked();
      await portrait();await button('Open camera').click();
      await wait('Ready to record.');
      await landscape();await assertBlocked();
      await portrait();await button('Open camera').click();
      await button('Record 3 seconds').click();
      await landscape();await assertBlocked();
      await portrait();await button('Open camera').click();
      await button('Record 3 seconds').click();
      await wait('Recording three seconds…');
      await landscape();await assertBlocked();
      // Returning to portrait must not auto-resume a cancelled recording.
      await portrait();await wait('Open your camera when ready.');
      assert.equal(await button('Record 3 seconds').count(),0);
      assert.ok(await page.getByRole('checkbox',{name:'Mic'}).isChecked());
      console.log('PASS landscape blocks camera; rotation cancels preview and active capture');
    }
    await button('Open camera').click();
    await controlsFit();
    await record();
    await controlsFit();
    if(n===1){
      // A finished portrait clip remains available after rotation, but no
      // retake can begin until portrait orientation is restored.
      await page.setViewportSize({width:844,height:390});
      await wait('Please rotate your phone to portrait mode.');
      assert.equal(await button('Retake').isDisabled(),true);
      assert.equal(await button('Use this scene').isEnabled(),true);
      assert.equal(await page.locator('video[controls]').count(),1);
      await page.setViewportSize({width:390,height:844});
      await button('Retake').click();
      await record();
      console.log('PASS retake');
    }
    await controlsFit();
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
  await checkWatermarkOption();
  assert.equal(await page.locator('video').count(), 0);
  assert.equal(await page.getByRole('link', {name: /Download/}).count(), 0);
  await page.evaluate(() => {
    Object.defineProperties(navigator, {
      canShare: {configurable: true, value: ({files}) => files.length === 1},
      share: {configurable: true, value: async ({files}) => { window.sharedMovie = files[0]; }},
    });
  });
  await button('Reveal the movie').click();
  await wait('Your movie is ready!');
  await page.setViewportSize({width:360,height:640});
  await controlsFit();
  await checkWatermarkOption({escape: true});
  assert.equal(downloads,1);
  assert.equal(await page.evaluate(() => Boolean(window.sharedMovie)), false);
  await button('Share video').click();
  const filename = await page.getByRole('link', {name: /Download/}).getAttribute('download');
  assert.equal(await page.evaluate(() => window.sharedMovie.name), filename);
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
    let tapAt=Infinity;
    document.addEventListener('click',e=>{
      if(e.target.closest('button')?.textContent==='Record 3 seconds')tapAt=performance.now();
    },true);
    window.mediaRequests=[];
    navigator.mediaDevices.getUserMedia=async constraints=>{
      window.mediaRequests.push(constraints.audio);
      if(constraints.audio)throw new DOMException('Microphone denied','NotAllowedError');
      const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1920;
      const ctx=canvas.getContext('2d');
      const paint=()=>{ctx.fillStyle=performance.now()<tapAt+500?'#ed2034':'#2448df';ctx.fillRect(0,0,canvas.width,canvas.height);};
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
    await hb('Open camera').click();
    await high.getByText('Allow access to your camera and microphone, or switch Mic off and retry.').waitFor();
    assert.deepEqual(await high.evaluate(()=>window.mediaRequests),[true]);
    assert.equal(await hb('Record 3 seconds').count(),0);
    await high.getByRole('checkbox',{name:'Mic'}).uncheck();
    await hb('Open camera').click();await hb('Record 3 seconds').click({timeout:15000});
    await high.getByText('Review your scene or retake.',{exact:true}).waitFor({timeout:45000});
    const result=await high.locator('video[controls]').evaluate(async video=>{
      if(!video.videoWidth)await new Promise((resolve,reject)=>{video.addEventListener('loadedmetadata',resolve,{once:true});video.addEventListener('error',reject,{once:true});});
      return [video.videoWidth,video.videoHeight];
    });
    assert.deepEqual(result,[720,1280]);
    const encoded=await high.locator('video[controls]').evaluate(async el=>{
      const blob=await (await fetch(el.src)).blob();
      return new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(blob);});
    });
    const clip=join(dir,'opening-test.video');
    await writeFile(clip,Buffer.from(encoded,'base64'));
    const pixelAt=t=>execFileSync('ffmpeg',['-v','error','-i',clip,'-ss',t,'-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    const first=pixelAt('0'),later=pixelAt('1.5');
    assert.ok(first[0]>2*first[2],'the first half-second must be in the recording');
    assert.ok(later[2]>2*later[0],'the scene must continue after the opening moment');
    const tracks=execFileSync('ffprobe',['-v','error','-select_streams','a','-show_entries','stream=index','-of','csv=p=0',clip]);
    assert.equal(tracks.length,0,'choosing Mic off must record video only');
    console.log('PASS permission denial, explicit silent take, opening half-second captured and portrait resize');
  }finally{await high.close();}
  assert.deepEqual(external,[]);assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  console.log('PASS five recorded scenes, reference frames, retake, cancel/retry, sound, silent sample export, reset and explicit-only downloads; no media uploads');
}finally{await browser.close();await rm(dir,{recursive:true,force:true});}
