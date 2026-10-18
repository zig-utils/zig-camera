#!/usr/bin/env python3
"""Matched Picamera2 request baseline. Run with the distribution Python."""
import argparse
import importlib.metadata
import json
import time
from picamera2 import Picamera2, MappedArray
from libcamera import ColorSpace


def run(args):
    picam = Picamera2(args.camera)
    controls = {"AeEnable": False, "ExposureTime": args.exposure_us, "AnalogueGain": args.gain,
                "FrameDurationLimits": (args.frame_us, args.frame_us)}
    supported = picam.camera_controls
    if "NoiseReductionMode" in supported: controls["NoiseReductionMode"] = 2  # HighQuality, matching native
    for mode in ("ExposureTimeMode", "AnalogueGainMode"):
        if mode in supported: controls[mode] = 1
    if "AfMode" in supported: controls["AfMode"] = 2  # continuous
    config = picam.create_still_configuration(main={"size": (args.width,args.height), "format":"BGR888"},
        raw=None, buffer_count=args.buffers, queue=False, colour_space=ColorSpace.Sycc(), controls=controls)
    picam.configure(config)
    actual = picam.camera_configuration()
    main = actual["main"]
    main_stream = picam.stream_map["main"]
    picam.start()
    try:
        for _ in range(args.warmup):
            with picam.captured_request(): pass
        first = last = first_ts = last_ts = 0
        checksum = 0
        cpu_start = time.process_time_ns()
        start = time.perf_counter_ns()
        for i in range(args.frames):
            with picam.captured_request() as request:
                if args.mode == "mapped":
                    with MappedArray(request, "main", write=False) as mapped:
                        checksum += int(mapped.array[0,0,0])
                else:
                    data = request.make_array("main")
                    checksum += int(data[0,0,0])
                sequence = request.request.sequence
                timestamp = request.request.buffers[main_stream].metadata.timestamp
                if i == 0: first, first_ts = sequence, timestamp
                last, last_ts = sequence, timestamp
        wall_ns = time.perf_counter_ns() - start
        cpu_ns = time.process_time_ns() - cpu_start
        return {"backend":"picamera2", "mode":args.mode, "frames":args.frames, "width":main["size"][0],
            "height":main["size"][1], "stride":main["stride"], "format":main["format"], "buffers":actual["buffer_count"],
            "wall_ns":wall_ns, "cpu_ns":cpu_ns, "first_sequence":first, "last_sequence":last,
            "first_timestamp_ns":first_ts, "last_timestamp_ns":last_ts, "checksum":checksum,
            "picamera2_version":importlib.metadata.version("picamera2"), "camera_id":picam.camera.id}
    finally:
        picam.stop()
        picam.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for key, default in (("width",1920),("height",1080),("frames",300),("warmup",30),("buffers",4),("camera",0),("exposure-us",10000),("frame-us",33333)):
        parser.add_argument("--"+key, type=int, default=default)
    parser.add_argument("--gain",type=float,default=1.0)
    parser.add_argument("--mode",choices=("mapped","copied"),required=True)
    args = parser.parse_args()
    if args.frames < 1: parser.error("frames must be positive")
    print(json.dumps(run(args)))
