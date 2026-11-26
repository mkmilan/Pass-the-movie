import json
import math
from pathlib import Path
import subprocess

movie, = [p for p in Path("mobile-test-results").glob("pass-the-movie-*") if p.suffix in (".mp4", ".webm")]
def probe(*args):
    return json.loads(subprocess.check_output(["ffprobe", "-v", "error", *args, "-of", "json", str(movie)]))
info = probe("-show_streams", "-show_format", "-count_frames")
video, = [s for s in info["streams"] if s["codec_type"] == "video"]
assert (video["width"], video["height"]) == (720, 1280), video
frames = probe("-select_streams", "v:0", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time")["frames"]
seconds = float(frames[-1]["best_effort_timestamp_time"]) - float(frames[0]["best_effort_timestamp_time"])
assert math.isfinite(seconds) and 13.5 <= seconds <= 16.5, seconds
assert len(frames) >= 180, len(frames)
subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", str(movie), "-f", "null", "-"], check=True)
print(f"Verified {video['codec_name']}, 720×1280, {seconds:.2f}s, {len(frames)} decoded frames")
