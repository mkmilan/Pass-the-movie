import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMediaProcessor } from './media.mjs';

const ff = (...args) => execFileSync('ffmpeg',['-nostdin','-hide_banner','-v','error','-y','-filter_threads','2','-threads','2',...args],{timeout:30000});

test('normalizes mixed native formats and rejects invalid inputs', {timeout:120000}, async () => {
  const dir=await mkdtemp(join(tmpdir(),'ptm-media-test-'));
  try {
    const portrait=join(dir,'portrait.webm'), landscape=join(dir,'landscape.mp4'), rotated=join(dir,'rotated.mp4'), short=join(dir,'short.mp4'), invalid=join(dir,'invalid.mp4'), oversized=join(dir,'oversized.mp4');
    ff('-f','lavfi','-i','testsrc2=size=360x640:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3.15','-c:v','libvpx','-deadline','realtime','-threads','2','-c:a','libopus',portrait);
    ff('-f','lavfi','-i','testsrc2=size=640x360:rate=25','-t','2.8','-c:v','libx264','-threads','2','-color_range','pc','-an',landscape);
    ff('-display_rotation','90','-i',landscape,'-map','0','-c','copy',rotated);
    ff('-f','lavfi','-i','testsrc2=size=320x240:rate=25','-t','1','-c:v','libx264','-threads','2','-an',short);
    await writeFile(invalid,'not a video');
    await writeFile(oversized,Buffer.alloc(12582913));
    const media=createMediaProcessor();
    for(const [i,input] of [portrait,landscape,rotated].entries()) {
      const out=join(dir,'scene-'+i); await mkdir(out);
      const {summary}=await media.normalizeScene(input,out);
      assert.equal(summary.frames,90); assert.equal(summary.duration,3);
      assert.equal(summary.width,720); assert.equal(summary.height,1280);
      assert.equal(summary.audioCodec,'aac');
    }
    const hd=join(dir,'hd.mp4'),fourK=join(dir,'4k.mp4'),hdOut=join(dir,'hd-out');
    ff('-f','lavfi','-i','color=c=blue:s=1080x1920:r=30','-t','3','-c:v','libx264','-preset','ultrafast','-threads','2','-an',hd);
    ff('-f','lavfi','-i','color=c=blue:s=2160x3840:r=30','-t','3','-c:v','libx264','-preset','ultrafast','-threads','2','-an',fourK);
    await mkdir(hdOut);
    const hdResult=await media.normalizeScene(hd,hdOut);
    assert.equal(hdResult.summary.width,720);assert.equal(hdResult.summary.height,1280);
    const fail=join(dir,'fail');await mkdir(fail);
    await assert.rejects(media.normalizeScene(fourK,fail),{code:'MEDIA_UNSUPPORTED'});
    await assert.rejects(media.normalizeScene(short,fail),{code:'MEDIA_DURATION'});
    await assert.rejects(media.normalizeScene(invalid,fail),{code:'MEDIA_INVALID'});
    await assert.rejects(media.normalizeScene(oversized,fail),{code:'MEDIA_TOO_LARGE'});
    await assert.rejects(createMediaProcessor({ffprobe:'/nonexistent/ffprobe'}).normalizeScene(portrait,fail),{code:'MEDIA_TOOLCHAIN_UNAVAILABLE'});
  } finally { await rm(dir,{recursive:true,force:true}); }
});

// Run optimization regressions in the existing media and container test jobs.
import './media-optimization.test.mjs';
