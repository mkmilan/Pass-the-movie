import array
import json
import math
from pathlib import Path
import subprocess

def verify(movie, recorded):
    def probe(*args):
        return json.loads(subprocess.check_output(["ffprobe", "-v", "error", *args, "-of", "json", str(movie)]))
    info = probe("-show_streams", "-show_format", "-count_frames")
    video, = [s for s in info["streams"] if s["codec_type"] == "video"]
    assert (video["width"], video["height"]) == (720, 1280), video
    frames = probe("-select_streams", "v:0", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time")["frames"]
    seconds = float(frames[-1]["best_effort_timestamp_time"]) - float(frames[0]["best_effort_timestamp_time"])
    assert math.isfinite(seconds) and 13.5 <= seconds <= 16.5, seconds
    assert len(frames) >= 180, len(frames)
    cmd=["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", str(movie)]
    subprocess.run([*cmd, "-f", "null", "-"], check=True)
    colors = subprocess.check_output([*cmd, "-an", "-vf", "fps=1/3,scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
    rgb = [tuple(colors[i:i+3]) for i in range(0,len(colors),3)]
    assert len(rgb)==5 and len(set(rgb)) >= 4 and all(max(c)>30 for c in rgb), rgb
    assert any(s["codec_type"]=="audio" for s in info["streams"]) == recorded
    if recorded:
        samples=array.array("h", subprocess.check_output([*cmd,"-vn","-ar","8000","-ac","1","-f","s16le","-"]))
        for second in (1,4,7,10,13):
            segment=samples[second*8000:(second+1)*8000]
            assert sum(v*v for v in segment)/len(segment) > 100**2, f"silent scene at {second}s"
    print(f"{movie.name}: {video['codec_name']}, 720×1280, {seconds:.2f}s, {len(frames)} decoded frames, five distinct scenes, audio={recorded}", flush=True)
take = Path("mobile-test-results/take-pass-the-movie.video")
device = Path("mobile-test-results/device-pass-the-movie.video")
if device.exists():
    for kind in ("v","a"):
        info=json.loads(subprocess.check_output(["ffprobe","-v","error","-select_streams",kind+":0","-show_frames","-show_entries","frame=best_effort_timestamp_time","-of","json",str(device)]))
        ts=[float(f["best_effort_timestamp_time"]) for f in info["frames"]]
        print(f"Android device-input {kind}: {len(ts)} frames, {ts[0]:.3f}s to {ts[-1]:.3f}s",flush=True)
if take.exists():
    cmd = ["ffmpeg","-nostdin","-v","error","-i",str(take)]
    frames=json.loads(subprocess.check_output(["ffprobe","-v","error","-select_streams","v:0","-show_frames","-show_entries","frame=best_effort_timestamp_time","-of","json",str(take)]))["frames"]
    raw=subprocess.check_output([*cmd,"-an","-vf","scale=1:1","-fps_mode","passthrough","-pix_fmt","rgb24","-f","rawvideo","-"])
    rgb=[tuple(raw[i:i+3]) for i in range(0,len(raw),3)]
    times=[float(f["best_effort_timestamp_time"])-float(frames[0]["best_effort_timestamp_time"]) for f in frames]
    assert len(times)==len(rgb) and 2.45<=times[-1]<3.5, (len(times),times[-1])
    opening=[c for t,c in zip(times,rgb) if t<.55 and c[2]>c[0] and max(c)<100]
    ending=[c for t,c in zip(times,rgb) if t>1.5 and c[0]>2*c[2]]
    assert opening and ending, (rgb[:3],rgb[-3:])
    first,middle=opening[0],ending[-1]
    samples=array.array("h",subprocess.check_output([*cmd,"-t","0.6","-map","0:a:0","-ar","8000","-ac","1","-f","s16le","-"]))
    assert samples and sum(v*v for v in samples)/len(samples)>100**2, "Opening audio is silent"
    spans = subprocess.check_output(["ffprobe","-v","error","-show_entries","stream=codec_type,start_time,duration","-of","compact",str(take)],text=True)
    print(f"Opening cue {first}, middle cue {middle}, audible mic in the opening 0.6s. Streams: {spans}",flush=True)
else:
    for mode in ("sample","recorded"):
        movie, = Path("mobile-test-results").glob(mode+"-pass-the-movie-*")
        verify(movie, mode == "recorded")
