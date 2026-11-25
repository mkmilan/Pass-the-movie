import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,symlink,rm,realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedMediaCommand } from './media-sandbox.mjs';
import { createMediaProcessor } from './media.mjs';

test('sandbox command limits executable, mounts, paths, network and environment',async()=>{
  const root=await realpath(tmpdir()),dir=await mkdtemp(join(root,'ptm-sandbox-'));
  try{
    const input=join(dir,'raw.mp4'),output=join(dir,'final.mp4');
    await writeFile(input,'fixture');
    const command=await isolatedMediaCommand('ffmpeg',['-i',input,output]);
    assert.equal(command.file,'/usr/bin/bwrap');
    for(const arg of ['--unshare-all','--disable-userns','--die-with-parent','--clearenv','--cap-drop','ALL','--as=2147483648'])assert.ok(command.args.includes(arg));
    assert.deepEqual(command.args.slice(-4),['/usr/bin/ffmpeg','-i','/work/raw.mp4','/work/final.mp4']);
    await assert.rejects(isolatedMediaCommand('sh',[input]));
    await assert.rejects(isolatedMediaCommand('ffmpeg',['-i',input,'/etc/passwd']));
    await symlink('/etc/passwd',join(dir,'link.mp4'));
    await assert.rejects(isolatedMediaCommand('ffprobe',[join(dir,'link.mp4')]));
    // Aborting before invoking the encoder must not touch the input.
    const controller=new AbortController();controller.abort();
    await assert.rejects(createMediaProcessor({signal:controller.signal,isolate:true}).verifyScene(input),{code:'MEDIA_CANCELLED'});
  }finally{await rm(dir,{recursive:true,force:true});}
});
