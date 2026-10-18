#!/usr/bin/env python3
"""Linux/Pi only: alternate matched real-camera workloads and preserve raw evidence."""
import argparse
import datetime
import json
import os
import platform
from pathlib import Path
import shutil
import statistics
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
RESOURCE = "__ZC_RESOURCE__"

def command_output(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=15)
        return {"command":command, "status":result.returncode, "stdout":result.stdout, "stderr":result.stderr}
    except (OSError, subprocess.TimeoutExpired) as ex:
        return {"command":command, "error":str(ex)}

def state():
    return {"temperature":command_output(["vcgencmd","measure_temp"]),
            "throttling":command_output(["vcgencmd","get_throttled"])}

def measure(command, timeout):
    wrapped = ["/usr/bin/time", "-f", RESOURCE+'{"max_rss_kib":%M}', *command]
    p = subprocess.run(wrapped, text=True, capture_output=True, timeout=timeout, cwd=ROOT)
    if p.returncode:
        raise RuntimeError(f"Command failed ({p.returncode}): {command}\n{p.stdout}\n{p.stderr}")
    result = json.loads(p.stdout)
    for line in p.stderr.splitlines():
        if line.startswith(RESOURCE): result.update(json.loads(line[len(RESOURCE):]))
    result["command"] = command
    result["stderr"] = p.stderr
    if result["backend"] == "synthetic": raise RuntimeError("Synthetic output cannot establish hardware performance")
    return result

def summarize(rows):
    summary = {}
    for label in sorted({r["label"] for r in rows}):
        group = [r for r in rows if r["label"] == label]
        summary[label] = {
            "median_cpu_ns_per_frame": statistics.median(r["cpu_ns"]/r["frames"] for r in group),
            "median_wall_fps": statistics.median(r["frames"]*1e9/r["wall_ns"] for r in group),
            "median_max_rss_kib": statistics.median(r["max_rss_kib"] for r in group),
        }
    native = summary["native-lease"]["median_cpu_ns_per_frame"]
    if native > 0:
        for label in ("picamera2-mapped", "picamera2-copied"):
            summary[label]["cpu_ratio_to_native"] = summary[label]["median_cpu_ns_per_frame"] / native
    return summary

def main():
    p = argparse.ArgumentParser(description=__doc__)
    for key, default in (("width",1920),("height",1080),("frames",300),("warmup",30),("buffers",4),("camera",0),("exposure-us",10000),("frame-us",33333),("repeats",5)):
        p.add_argument("--"+key, type=int, default=default)
    p.add_argument("--gain",type=float,default=1.0)
    p.add_argument("--output",type=Path,default=Path("results.json"))
    args = p.parse_args()
    if platform.system() != "Linux": p.error("Run this hardware comparison on Linux/Pi")
    if not Path("/usr/bin/time").exists(): p.error("Install the time package")
    if min(args.frames, args.repeats, args.width, args.height) < 1: p.error("Sizes, frames and repeats must be positive")
    if args.output.exists(): p.error("Choose a new output path to preserve earlier evidence")
    common = ["--width",str(args.width),"--height",str(args.height),"--frames",str(args.frames),"--warmup",str(args.warmup),
              "--buffers",str(args.buffers),"--camera",str(args.camera),"--exposure-us",str(args.exposure_us),
              "--gain",str(args.gain),"--frame-us",str(args.frame_us)]
    commands = {
        "native-lease": [str(ROOT/"zig-out/bin/zig-camera"), "bench", "--fifo", *common],
        "picamera2-mapped": [sys.executable,str(ROOT/"bench/picamera2_baseline.py"),"--mode","mapped",*common],
        "picamera2-copied": [sys.executable,str(ROOT/"bench/picamera2_baseline.py"),"--mode","copied",*common],
    }
    result = {"created_at":datetime.datetime.now(datetime.timezone.utc).isoformat(), "platform":platform.platform(),
              "python":sys.version, "config":vars(args)|{"output":str(args.output)}, "rows":[],
              "versions":command_output(["pkg-config","--modversion","libcamera"]),
              "cameras":command_output(["rpicam-hello","--list-cameras"]), "before":state(),
              "commit":command_output(["git","rev-parse","HEAD"])}
    geometry = None
    timeout = max(120, (args.frames+args.warmup) * max(args.frame_us,1000000) / 1e6 * 3)
    try:
        for repeat in range(args.repeats):
            labels = list(commands)
            # Rotate order across repeats so the same implementation isn't always cold/first.
            labels = labels[repeat%3:] + labels[:repeat%3]
            for label in labels:
                print(f"repeat {repeat+1}/{args.repeats}: {label}", file=sys.stderr)
                row = measure(commands[label], timeout)
                current = tuple(row[k] for k in ("width","height","stride","buffers","format"))
                if geometry is not None and current != geometry:
                    raise RuntimeError(f"Negotiated configurations differ: {geometry} vs {current}")
                geometry = current
                row.update(label=label, repeat=repeat)
                result["rows"].append(row)
        result["summary"] = summarize(result["rows"])
        result["complete"] = True
    except Exception as ex:
        result["complete"] = False
        result["error"] = str(ex)
        raise
    finally:
        result["after"] = state()
        args.output.write_text(json.dumps(result, indent=2)+"\n")
    print(json.dumps(result["summary"],indent=2))

if __name__ == "__main__": main()
