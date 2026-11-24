import { spawnSync } from 'node:child_process';
function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH || '/usr/bin:/bin', LC_ALL: 'C' } });
  if (result.error || result.status !== 0) throw new Error('MEDIA_TOOLCHAIN_UNAVAILABLE');
  return result.stdout;
}
try {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
  const version = run(ffmpeg, ['-version']).split('\n')[0];
  const probeVersion = run(ffprobe, ['-version']).split('\n')[0];
  const encoders = run(ffmpeg, ['-hide_banner', '-encoders']);
  if (!/\blibx264\b/.test(encoders) || !/\baac\b/.test(encoders)) throw new Error('MEDIA_ENCODER_UNAVAILABLE');
  console.log(version, '\n' + probeVersion, '\nH.264/AAC encoders available. Preflight passed. No queue started.');
} catch (error) {
  console.error(error.message === 'MEDIA_ENCODER_UNAVAILABLE' ? error.message : 'MEDIA_TOOLCHAIN_UNAVAILABLE');
  process.exitCode = 1;
}
