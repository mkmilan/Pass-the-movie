#!/usr/bin/env python3
"""Synthetic media only; not a production upload validator."""
import json, subprocess, tempfile
from pathlib import Path

VF = 'setpts=PTS-STARTPTS,fps=30,scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.5,trim=end_frame=90,setpts=PTS-STARTPTS'
AF = 'asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=end_sample=144000,asetpts=N/SR/TB'
ENC = '-r 30 -fps_mode cfr -c:v libx264 -preset veryfast -crf 23 -maxrate 3M -bufsize 6M -threads 2 -pix_fmt yuv420p -c:a aac -b:a 96k -ar 48000 -ac 2 -map_metadata -1 -map_chapters -1 -movflags +faststart'.split()

def ff(*args):
    subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-y','-filter_threads','2','-filter_complex_threads','2',*map(str,args)],check=True,timeout=90)

def probe(p):
    return json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-show_streams','-show_format','-of','json',str(p)],timeout=30))

def verify(p,seconds):
    info=probe(p); streams=info['streams']; assert len(streams)==2
    v=next(s for s in streams if s['codec_type']=='video'); a=next(s for s in streams if s['codec_type']=='audio')
    assert (v['codec_name'],v['width'],v['height'],v['pix_fmt'],v['sample_aspect_ratio'],v['avg_frame_rate'],int(v['nb_read_frames']))==('h264',720,1280,'yuv420p','1:1','30/1',30*seconds),v
    assert not any('rotation' in s for s in v.get('side_data_list',[]))
    assert (a['codec_name'],a['sample_rate'],a['channels'])==('aac','48000',2)
    assert abs(float(info['format']['duration'])-seconds)<=.05
    assert all(abs(float(s['start_time']))<=.001 for s in streams)
    ff('-xerror','-i',p,'-f','null','-')
    print(f'PASS {p.name}: {30*seconds} frames, {seconds} s, H.264/AAC',flush=True)

def normalize(src,dst):
    audio=any(s['codec_type']=='audio' for s in probe(src)['streams'])
    extra=[] if audio else ['-f','lavfi','-i','anullsrc=r=48000:cl=stereo']
    ff('-i',src,*extra,'-map','0:v:0','-map','0:a:0' if audio else '1:a:0','-vf',VF,'-af',AF,'-t','3',*ENC,dst)
    verify(dst,3)
    still=dst.with_suffix('.jpg')
    ff('-i',dst,'-vf',r'select=eq(n\,89)','-frames:v','1','-q:v','2',still)
    v=probe(still)['streams'][0]; assert (v['width'],v['height'],int(v['nb_read_frames']))==(720,1280,1)

def main():
    with tempfile.TemporaryDirectory(prefix='ptm-test-') as tmp:
        p=Path(tmp)
        ff('-f','lavfi','-i','testsrc2=size=360x640:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3.15','-c:v','libvpx','-deadline','realtime','-threads','2','-c:a','libopus',p/'portrait.webm')
        ff('-f','lavfi','-i','testsrc2=size=640x360:rate=25','-t','2.8','-c:v','libx264','-threads','2','-an',p/'silent.mp4')
        ff('-f','lavfi','-i','testsrc2=size=640x360:rate=30','-f','lavfi','-i','sine=frequency=880:sample_rate=44100','-t','3','-c:v','libx264','-threads','2','-c:a','aac',p/'base.mp4')
        ff('-display_rotation','90','-i',p/'base.mp4','-map','0','-c','copy',p/'rotated.mp4')
        ff('-f','lavfi','-i','testsrc2=size=360x640:rate=30','-t','3','-c:v','libvpx-vp9','-deadline','realtime','-threads','2','-an',p/'vp9.webm')
        ff('-f','lavfi','-i','testsrc2=size=360x640:rate=60','-t','3','-c:v','libx264','-threads','2','-movflags','+frag_keyframe+empty_moov','-an',p/'fragmented.mp4')
        sources=['portrait.webm','silent.mp4','rotated.mp4','vp9.webm','fragmented.mp4']
        scenes=[p/f'scene-{i}.mp4' for i in range(5)]
        for src,dst in zip(sources,scenes): normalize(p/src,dst)
        inputs=[x for scene in scenes for x in ('-i',scene)]
        graph=';'.join(f'[{i}:v]setpts=PTS-STARTPTS[v{i}];[{i}:a]apad,atrim=end_sample=144000,asetpts=N/SR/TB[a{i}]' for i in range(5))+';'+''.join(f'[v{i}][a{i}]' for i in range(5))+'concat=n=5:v=1:a=1[v][a]'
        ff(*inputs,'-filter_complex',graph,'-map','[v]','-map','[a]','-t','15',*ENC,p/'final.mp4')
        verify(p/'final.mp4',15)
        print('Synthetic checks passed. Real phone and perceptual A/V tests remain.',flush=True)

if __name__=='__main__': main()
