import { dirname,basename,resolve,isAbsolute,join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const binaries=new Set(['ffmpeg','ffprobe','/usr/bin/ffmpeg','/usr/bin/ffprobe']);
// Candidate Linux isolation for a dedicated worker image. No fallback to an
// ordinary subprocess if the host denies the namespace setup.
export async function isolatedMediaCommand(bin,args){
  if(!binaries.has(bin))throw new Error('SANDBOX_BINARY_INVALID');
  const paths=args.filter(arg=>typeof arg==='string'&&isAbsolute(arg));
  if(!paths.length)throw new Error('SANDBOX_JOB_REQUIRED');
  const dir=dirname(paths[0]),root=await realpath(tmpdir());
  if(await realpath(dir)!==dir||dirname(dir)!==root||!/^ptm-(normalize|assemble|sandbox)-[A-Za-z0-9]+$/.test(basename(dir)))throw new Error('SANDBOX_JOB_INVALID');
  for(const path of paths){
    if(dirname(path)!==dir||resolve(path)!==path||!(/^[A-Za-z0-9._-]+$/.test(basename(path))))throw new Error('SANDBOX_PATH_INVALID');
    // Existing input files must not be symlinks; a not-yet-created output is OK.
    try{if(await realpath(path)!==path)throw new Error('SANDBOX_PATH_INVALID');}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const translated=args.map(arg=>typeof arg==='string'&&isAbsolute(arg)?join('/work',basename(arg)):arg);
  return {file:'/usr/bin/bwrap',args:[
    '--unshare-all','--disable-userns','--die-with-parent','--new-session','--cap-drop','ALL',
    '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
    '--dev','/dev','--proc','/proc','--tmpfs','/tmp','--dir','/etc',
    '--ro-bind-try','/etc/fonts','/etc/fonts','--ro-bind-try','/etc/ld.so.cache','/etc/ld.so.cache',
    '--bind',dir,'/work','--chdir','/work','--clearenv','--setenv','PATH','/usr/bin','--setenv','HOME','/tmp','--setenv','LC_ALL','C',
    '--','/usr/bin/prlimit','--as=2147483648','--cpu=60:65','--fsize=16777216','--nofile=128','--core=0','--','/usr/bin/'+basename(bin),...translated
  ]};
}
