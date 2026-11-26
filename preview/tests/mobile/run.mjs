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
      const element = await until(()=>js(text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text&&!b.disabled&&b.getClientRects().length)||null,label),label);
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
    screenshot: file => page.screenshot({path:file}),
    close: () => browser.close()
  };
}

const driver = platform === 'ios' ? await iphone() : await android();
try {
  await driver.navigate();
  await until(()=>driver.evaluate(()=>document.body?.innerText.includes('Try with five sample scenes')),'preview');
  console.log('Browser:', await driver.evaluate(()=>navigator.userAgent));
  console.log('Media capabilities:', await driver.evaluate(()=>({
    recorder:typeof MediaRecorder, canvas:typeof HTMLCanvasElement.prototype.captureStream,
    share:typeof navigator.share, canShare:typeof navigator.canShare, width:innerWidth, height:innerHeight
  })));
  await driver.tap('Try with five sample scenes');
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
  const path=resolve(output,media.filename);
  await writeFile(path,Buffer.from(parts.join(''),'base64'));
  console.log('Exported mobile video file:',path);
  await driver.screenshot(resolve(output,platform+'-reveal.png'));
} catch (error) {
  try {console.error('Last screen:', await driver.evaluate(()=>document.body.innerText));} catch {}
  try {await driver.screenshot(resolve(output,platform+'-failure.png'));} catch {}
  throw error;
} finally {
  await driver.close();
}
