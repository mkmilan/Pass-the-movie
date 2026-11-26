import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const platform = process.argv[2];
const origin = 'https://pass-the-movie-preview.vercel.app/';
const pause = ms => new Promise(done => setTimeout(done, ms));
const output = resolve('mobile-test-results');
await mkdir(output, { recursive: true });

async function until(read, description, timeout = 35000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await pause(350);
  }
  throw new Error('Timed out waiting for ' + description);
}

async function iphone() {
  let id;
  async function command(method, route, data) {
    const response = await fetch('http://127.0.0.1:4444' + route, {
      method, headers: {'Content-Type':'application/json'},
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(65000)
    });
    const {value} = await response.json();
    if (!response.ok || value?.error) throw new Error(JSON.stringify(value));
    return value;
  }
  await until(() => fetch('http://127.0.0.1:4444/status').then(r=>r.ok).catch(()=>false), 'SafariDriver');
  const session = await command('POST','/session',{capabilities:{alwaysMatch:{
    browserName:'Safari',platformName:'iOS','safari:useSimulator':true,'safari:deviceUDID':process.env.SIMULATOR_UDID
  }}});
  id = '/session/' + session.sessionId;
  console.log('Safari capabilities:', session.capabilities);
  const js = (fn, ...args) => command('POST',id+'/execute/sync',{script:'return (' + fn + ')(...arguments)',args});
  return {
    evaluate: js,
    navigate: () => command('POST',id+'/url',{url:origin}),
    tap: async label => {
      const element = await until(()=>js(text=>{
        const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text&&!b.disabled&&b.getClientRects().length);
        if(!el) return null;
        el.scrollIntoView({block:'center',behavior:'instant'});
        return el;
      },label),label);
      return command('POST',id+'/element/'+element['element-6066-11e4-a52e-4f735466cecf']+'/click',{});
    },
    screenshot: file => execFileSync('xcrun',['simctl','io',process.env.SIMULATOR_UDID,'screenshot',file]),
    close: () => command('DELETE',id)
  };
}

async function android() {
  const {chromium} = await import('playwright-core');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  return {
    evaluate: (fn,...args) => page.evaluate(fn, args[0]),
    navigate: () => page.goto(origin),
    tap: label => page.getByRole('button',{name:label,exact:true}).click({timeout:35000}),
    screenshot: file => writeFile(file,execFileSync('adb',['exec-out','screencap','-p'],{timeout:10000,maxBuffer:10000000})),
    close: () => browser.close()
  };
}

async function recordScenes(driver) {
  // Used only inside this test tab. Each tap opens a synthetic moving camera
  // and tone so the unmodified page still records and assembles actual clips.
  await driver.evaluate(() => {
    let scene = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {configurable:true, value:async constraints=>{
      const canvas = document.createElement('canvas');
      canvas.width=360; canvas.height=640;
      const ctx=canvas.getContext('2d');
      const color=['#ee4045','#1ec87a','#429dff','#efc340','#d65bda'][scene++ % 5];
      let frame=0;
      const paint=()=>{ctx.fillStyle=color;ctx.fillRect(0,0,360,640);ctx.fillStyle='white';ctx.fillRect(frame++ % 300,320,50,50);};
      paint();
      const interval=setInterval(paint,1000/30);
      const stream=canvas.captureStream(30);
      const video=stream.getVideoTracks()[0],stop=video.stop.bind(video);
      let audio;
      if(constraints.audio){
        audio=new AudioContext();
        const dest=audio.createMediaStreamDestination(),tone=audio.createOscillator(),gain=audio.createGain();
        tone.frequency.value=440;gain.gain.value=.2;tone.connect(gain).connect(dest);tone.start();
        await audio.resume();
        stream.addTrack(dest.stream.getAudioTracks()[0]);
      }
      video.stop=()=>{clearInterval(interval);stop();audio?.close().catch(()=>{});};
      return stream;
    }});
  });
  await driver.tap('Start a movie');
  for(let scene=1;scene<=5;scene++) {
    await until(()=>driver.evaluate(()=>!!document.querySelector('input[type=checkbox]')),'recording consent');
    await driver.evaluate(()=>document.querySelector('input[type=checkbox]').click());
    await driver.tap('Continue to camera');
    await driver.evaluate(()=>{const mic=document.querySelector('input[type=checkbox]');if(!mic.checked)mic.click();});
    await driver.tap('Open camera');
    await driver.tap('Record 3 seconds');
    await until(()=>driver.evaluate(()=>document.querySelector('video[controls]')?.readyState>=2), 'review video');
    console.log('Recorded take', scene, await driver.evaluate(()=>{
      const v=document.querySelector('video[controls]');
      return {duration:String(v.duration),width:v.videoWidth,height:v.videoHeight,ready:v.readyState};
    }));
    await driver.tap('Use this scene');
    if(scene<5) await driver.tap("I'm the next player");
    console.log('Accepted recorded scene',scene);
  }
}

const driver = platform === 'ios' ? await iphone() : await android();
try {
  await driver.navigate();
  if(platform==='ios' && process.env.NATIVE_IOS==='1'){
    const udid=process.env.SIMULATOR_UDID;
    const ui=execFileSync('axe',['describe-ui','--udid',udid],{encoding:'utf8',timeout:30000});
    if(/View Bookmarks|You can now view these items/i.test(ui)){
      console.log('Dismissing first-launch Safari feature tip');
      // iPhone SE layout: native tip close control (confirmed in the simulator capture).
      execFileSync('axe',['tap','-x','337','-y','413','--udid',udid],{timeout:20000});
    }
  }
  await until(()=>driver.evaluate(()=>document.body?.innerText.includes('Try with five sample scenes')),'preview');
  await until(()=>driver.evaluate(()=>{
    const b=document.querySelector('main button');
    return b && Object.keys(b).some(key=>key.startsWith('__reactProps$'));
  }),'interactive preview hydration',100000);
  console.log('Browser:', await driver.evaluate(()=>navigator.userAgent));
  console.log('Media capabilities:', await driver.evaluate(()=>({
    recorder:typeof MediaRecorder, canvas:typeof HTMLCanvasElement.prototype.captureStream,
    share:typeof navigator.share, canShare:typeof navigator.canShare, width:innerWidth, height:innerHeight
  })));
  for(const mode of ['sample', 'recorded']){
    if(mode==='sample'){
      const sampleLabel='Try with five sample scenes';
      await driver.tap(sampleLabel);
      await pause(1000);
      if(platform==='ios' && await driver.evaluate(text=>[...document.querySelectorAll('button')].some(b=>b.textContent===text),sampleLabel)){
        console.log('Retrying sample selection through the hydrated button handler.');
        await driver.evaluate(text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text).click(),sampleLabel);
      }
    }
    else {
      await driver.navigate();
      await until(()=>driver.evaluate(()=>Object.keys(document.querySelector('main button')||{}).some(key=>key.startsWith('__reactProps$'))),'interactive recording page',100000);
      await recordScenes(driver);
    }
    await driver.tap('Reveal the movie');
    await until(()=>driver.evaluate(()=>{
      const error=document.querySelector('[role="alert"]');
      if(error) throw Error(error.innerText);
      return !!document.querySelector('a[download][href^="blob:"]');
    }),'rendered movie',65000);
    const media = await driver.evaluate(()=>{
      const link=document.querySelector('a[download]');
      const video=document.querySelector('video[controls]');
      return {filename:link.download, player:video?.getAttribute('src')===link.getAttribute('href'),
        shareButton:[...document.querySelectorAll('button')].some(b=>b.textContent==='Share video')};
    });
    assert.ok(media.player);
    console.log('Reveal:',media);
    // Read the exact bytes backing the mobile download link for independent decoding.
    await driver.evaluate(()=>{
      const url=document.querySelector('a[download]').href;
      window.exportResult={};
      fetch(url).then(r=>r.blob()).then(blob=>{
        const reader=new FileReader();
        reader.onload=()=>{window.exportResult={data:reader.result.split(',')[1]};};
        reader.onerror=()=>{window.exportResult={error:'could not read download'};};
        reader.readAsDataURL(blob);
      }).catch(e=>{window.exportResult={error:e.message};});
    });
    const size = await until(()=>driver.evaluate(()=>{
      if(window.exportResult?.error) throw Error(window.exportResult.error);
      return window.exportResult?.data?.length || 0;
    }),'export bytes');
    const parts=[];
    for(let i=0;i<size;i+=65536) parts.push(await driver.evaluate(start=>window.exportResult.data.slice(start,start+65536),i));
    assert.match(media.filename,/^pass-the-movie-[\dTZ-]+\.(mp4|webm)$/);
    const path=resolve(output,mode+'-'+media.filename);
    await writeFile(path,Buffer.from(parts.join(''),'base64'));
    console.log('Exported mobile video file:',path);
    try { await driver.screenshot(resolve(output,platform+'-'+mode+'-reveal.png')); } catch(e){ console.log('Reveal screenshot unavailable:',e.message); }
    if(mode==='recorded' && media.shareButton && (platform==='android'||process.env.NATIVE_IOS==='1')){
      await driver.tap('Share video');
      await pause(1500);
      if(platform==='android'){
        const activity=execFileSync('adb',['shell','dumpsys','activity','activities'],{encoding:'utf8'});
        console.log('Native Android chooser opened:', /mResumedActivity[^\n]*(Chooser|Resolver)|topResumedActivity[^\n]*(Chooser|Resolver)/i.test(activity));
        await writeFile(resolve(output,'android-share.png'),execFileSync('adb',['exec-out','screencap','-p']));
        execFileSync('adb',['shell','input','keyevent','4']);
      }else{
        const udid=process.env.SIMULATOR_UDID;
        const tree=execFileSync('axe',['describe-ui','--udid',udid],{encoding:'utf8',timeout:30000});
        console.log('Native iOS share sheet opened:', /AirDrop|Save Video|Save to Files|Copy iCloud Link/i.test(tree));
        await writeFile(resolve(output,'ios-share-ui.json'),tree);
        await driver.screenshot(resolve(output,'ios-share.png'));
        // Return to the page without picking a recipient.
        if(/AirDrop|Save Video|Save to Files|Copy iCloud Link/i.test(tree)){
          try{execFileSync('axe',['tap','--label','Close','--udid',udid],{timeout:15000});}
          catch{await driver.navigate();}
        }
      }
    }
    }
} catch (error) {
  try {console.log('Page diagnostics:',await driver.evaluate(()=>({ready:document.readyState, scripts:[...document.scripts].map(s=>s.src||'inline'), firstButton:Object.keys(document.querySelector('button')||{}),page:location.href})));}catch{}
  try {console.log('Decoder states:',await driver.evaluate(()=>[...document.querySelectorAll('video')].map(v=>({width:v.videoWidth,height:v.videoHeight,t:v.currentTime,duration:String(v.duration),ready:v.readyState,paused:v.paused,ended:v.ended,error:v.error?.message}))));}catch{}
  try {console.error('Last screen:', await driver.evaluate(()=>document.body.innerText));} catch {}
  try {await driver.screenshot(resolve(output,platform+'-failure.png'));} catch {}
  throw error;
} finally {
  await driver.close();
}
