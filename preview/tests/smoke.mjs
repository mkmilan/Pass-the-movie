import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const origin='http://127.0.0.1:3000';
const context=await browser.newContext({viewport:{width:390,height:844},permissions:['camera','microphone'],acceptDownloads:true});
const page=await context.newPage(),external=[],errors=[],dir=await mkdtemp(join(tmpdir(),'ptm-preview-'));
page.on('request',req=>{if(!req.url().startsWith(origin)&&!req.url().startsWith('blob:')&&!req.url().startsWith('data:'))external.push(req.url());});
page.on('pageerror',e=>errors.push(e.message));
const wait=async (text)=>page.getByText(text,{exact:true}).waitFor({timeout:45000});
try{
  let downloads=0;page.on('download',()=>downloads++);
  await page.goto(origin);await wait('FREE PREVIEW');assert.equal(downloads,0);
  // Test the actual camera component with a synthetic browser camera.
  await page.getByRole('button',{name:'Start a movie',exact:true}).click();
  await wait('Scene 1 of 5');
  await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:'Continue to camera'}).click();
  await page.getByRole('button',{name:'Open camera',exact:true}).click();
  await page.getByRole('button',{name:'Record 3 seconds'}).click({timeout:15000});
  await page.getByText('Review your scene or retake.',{exact:true}).waitFor({timeout:15000});
  await page.getByRole('button',{name:'Use this scene',exact:true}).click();
  await wait('Pass the phone!');
  await page.getByRole('button',{name:"I'm the next player"}).click();
  await page.getByRole('img',{name:'Last frame of the previous scene'}).waitFor();
  for(let n=2;n<=5;n++){
    await wait('Scene '+n+' of 5');
    await page.getByRole('button',{name:'Use a sample scene instead'}).click();
    if(n<5){await wait('Pass the phone!');await page.getByRole('button',{name:"I'm the next player"}).click();}
  }
  await wait('The movie is complete.');
  await page.getByRole('checkbox',{name:'Include recorded sound if supported'}).uncheck();
  await page.getByRole('button',{name:'Reveal the movie'}).click();
  await wait('Your movie is ready!');
  assert.equal(downloads,0);
  const result=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:/Download (MP4|WEBM)/}).click()]);
  const file=join(dir,result[0].suggestedFilename());await result[0].saveAs(file);
  const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'}));
  const video=info.streams.find(s=>s.codec_type==='video');assert.equal(video.width,720);assert.equal(video.height,1280);
  if(info.format.duration)assert.ok(Math.abs(Number(info.format.duration)-15)<1.5);
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'Make another movie'}).click();
  await page.getByRole('button',{name:'Try with five sample scenes'}).click();
  await wait('The movie is complete.');
  await page.getByRole('button',{name:'Reveal the movie'}).click();
  await wait('Your movie is ready!');
  assert.equal(downloads,1);
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  console.log('PASS camera, reference frame, five scene handoffs, actual video download, quick sample preview, no network media upload');
}finally{await browser.close();await rm(dir,{recursive:true,force:true});}
