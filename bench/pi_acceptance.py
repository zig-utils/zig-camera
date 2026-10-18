#!/usr/bin/env python3
"""Run on a real Pi/camera: ownership, DMA reads, restart and JPEG smoke checks.

Requires PYTHONPATH=python and a real libcamera build. This checks operation,
not optical quality, focus accuracy, colour calibration or weather resistance.
"""
import argparse
import json
from pathlib import Path
import time
from zigcamera import Camera, CameraError


def expect_status(status, function):
    try: function()
    except CameraError as error:
        if error.status != status: raise
    else: raise AssertionError(f"Expected camera status {status}")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--width",type=int,default=1920)
    p.add_argument("--height",type=int,default=1080)
    p.add_argument("--camera",type=int,default=0)
    p.add_argument("--frames",type=int,default=300)
    p.add_argument("--cycles",type=int,default=5)
    p.add_argument("--raw",action="store_true")
    p.add_argument("--output",type=Path,default=Path("pi-acceptance"))
    args = p.parse_args()
    if min(args.frames,args.cycles) < 1: p.error("Frames and cycles must be positive")
    args.output.mkdir(exist_ok=False)
    report = {"started_unix_ns":time.time_ns(),"samples":[],"config":vars(args)|{"output":str(args.output)}}
    try:
        with Camera(width=args.width,height=args.height,camera_index=args.camera,raw=args.raw,policy="fifo") as cam:
            report["info"] = cam.info
            assert cam.info["backend"] == "libcamera"
            for _ in range(args.cycles):
                cam.start()
                held = [cam.acquire() for _ in range(cam.info["buffer_count"])]
                expect_status(-3,lambda: cam.acquire(timeout_ms=10))
                with held[0].plane() as view: before = bytes(view[:64])
                cam.stop()
                with held[0].plane() as view: assert bytes(view[:64]) == before
                expect_status(-4,cam.start)
                expect_status(-4,cam.close)
                for frame in held: frame.release()
            cam.start()
            for _ in range(30):
                with cam.acquire(): pass
            previous = 0
            for i in range(args.frames):
                with cam.acquire() as frame:
                    metadata = frame.metadata
                    assert metadata["timestamp_ns"] > previous
                    previous = metadata["timestamp_ns"]
                    with frame.plane() as plane:
                        assert len(plane) >= (cam.info["main"]["height"]-1)*cam.info["main"]["stride"] + cam.info["main"]["width"]*3
                        _ = plane[0], plane[-1]
                    if i == 0: frame.save_jpeg(args.output/"sample.jpg",98)
                    if i % 30 == 0:
                        report["samples"].append({"frame":i,"metadata":metadata,"stats":cam.stats,
                            "statm":Path("/proc/self/statm").read_text().strip()})
            cam.stop()
            assert cam.stats["leased"] == 0
            assert cam.stats["ready"] == 0
            report["stats"] = cam.stats
        report["complete"] = True
    except Exception as error:
        report.update(complete=False,error=repr(error))
        raise
    finally:
        (args.output/"report.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report["stats"],indent=2))

if __name__ == "__main__": main()
