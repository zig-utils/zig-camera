const std = @import("std");
const camera = @import("camera");
const help =
    \\zig-camera info|modes|capture|preview|record|bench [options]
    \\  --width N --height N      Processed size; omit both for default still size
    \\  --buffers N              Preallocated request count, 2..32 (default 4)
    \\  --camera N               libcamera camera index (default 0)
    \\  --fifo                   Deliver in order; default discards older ready frames
    \\  --exposure-us N --gain N  Manual exposure (set both); default auto exposure
    \\  --frame-us N             Requested frame duration, microseconds
    \\  --lens N                 Manual lens position in dioptres; default continuous AF if supported
    \\  --sensor-width N --sensor-height N --sensor-depth N   Exact advertised mode
    \\  --lores-width N --lores-height N  Add a paired analysis stream
    \\  --lores-format NAME      YUV420 (default) or BGR888
    \\  --raw                    Add paired native raw stream
    \\  --raw-format NAME        Request exact raw format (e.g. SRGGB12)
    \\  --output PATH            capture: .ppm, .jpg/.jpeg, .dng; record: .mkv/.mp4 (default capture.ppm)
    \\  --fps N                  Preview/record frame rate (default 30)
    \\  --codec NAME             mjpeg (MKV), h264 or hevc (MP4, -Dcodecs=true)
    \\  --bitrate N --gop N       AVC/HEVC bits/sec (0 CRF) and keyframe interval
    \\  --preview                Also display while recording
    \\  --noise-reduction N      0 off, 1 fast, 2 high quality, 3 minimal
    \\  --quality N              Quality 1..100 (still 98, video 90); CRF AVC 51..1, HEVC 51..0
    \\  --warmup N               Frames discarded before capture/bench (default 30)
    \\  --frames N               bench frame count (default 300)
    \\  --timeout-ms N           Frame wait deadline (default 5000)
    \\  --simulate               Explicitly allow a synthetic build (no real camera)
    \\
;
pub fn main() !void {
    run() catch |err| {
        std.debug.print("zig-camera: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };
}
fn run() !void {
    const a = std.heap.page_allocator;
    const args = try std.process.argsAlloc(a);
    defer std.process.argsFree(a, args);
    if (args.len < 2 or std.mem.eql(u8, args[1], "--help")) {
        try std.fs.File.stdout().writeAll(help);
        return;
    }
    const command = args[1];
    if (!eq(command, "modes") and !eq(command, "info") and !eq(command, "capture") and !eq(command, "bench") and !eq(command, "preview") and !eq(command, "record")) return error.InvalidCommand;
    var cfg = camera.defaultConfig();
    var capture_opts: camera.c.zc_capture_options = undefined;
    camera.core.zc_default_capture_options(&capture_opts);
    if (eq(command, "record")) {
        capture_opts.role = camera.c.ZC_VIDEO;
        cfg.policy = camera.c.ZC_FIFO;
    } else if (eq(command, "preview")) capture_opts.role = camera.c.ZC_PREVIEW;
    var pipeline: camera.c.zc_pipeline_options = undefined;
    camera.core.zc_default_pipeline_options(&pipeline);
    var fps: u32 = 30;
    var codec: u32 = camera.c.ZC_MJPEG;
    var bitrate: u32 = 0;
    var gop: u32 = 0;
    var show_preview = eq(command, "preview");
    var output: [:0]const u8 = if (eq(command, "record")) "capture.mkv" else "capture.ppm";
    var simulate = false;
    var warmup: u32 = 30;
    var frames: u32 = 300;
    var quality: u32 = if (eq(command, "record")) 90 else 98;
    var timeout_ms: u32 = 5000;
    var i: usize = 2;
    while (i < args.len) : (i += 1) {
        const key = args[i];
        if (eq(key, "--simulate")) {
            simulate = true;
            continue;
        }
        if (eq(key, "--preview")) {
            show_preview = true;
            continue;
        }
        if (eq(key, "--fifo")) {
            cfg.policy = camera.c.ZC_FIFO;
            continue;
        }
        if (eq(key, "--raw")) {
            cfg.raw = 1;
            continue;
        }
        if (eq(key, "--help")) {
            try std.fs.File.stdout().writeAll(help);
            return;
        }
        i += 1;
        if (i >= args.len) return error.MissingOptionValue;
        const value = args[i];
        if (eq(key, "--lores-format")) {
            pipeline.lores_format = if (eq(value, "YUV420")) camera.c.ZC_YUV420 else if (eq(value, "BGR888")) camera.c.ZC_RGB24 else return error.InvalidLoresFormat;
        } else if (eq(key, "--codec")) {
            codec = if (eq(value, "h264")) camera.c.ZC_H264 else if (eq(value, "hevc")) camera.c.ZC_HEVC else if (eq(value, "mjpeg")) camera.c.ZC_MJPEG else return error.InvalidCodec;
        } else if (eq(key, "--output")) {
            output = value;
        } else if (eq(key, "--raw-format")) {
            if (value.len >= cfg.raw_format.len) return error.InvalidRawFormat;
            @memcpy(cfg.raw_format[0..value.len], value);
            cfg.raw = 1;
        } else if (eq(key, "--gain")) {
            cfg.analogue_gain = try std.fmt.parseFloat(f32, value);
        } else if (eq(key, "--lens")) {
            cfg.lens_position = try std.fmt.parseFloat(f32, value);
        } else {
            const n = try std.fmt.parseInt(u32, value, 10);
            if (eq(key, "--sensor-width")) {
                pipeline.sensor_width = n;
            } else if (eq(key, "--sensor-height")) {
                pipeline.sensor_height = n;
            } else if (eq(key, "--sensor-depth")) {
                pipeline.sensor_bit_depth = n;
            } else if (eq(key, "--lores-width")) {
                pipeline.lores_width = n;
            } else if (eq(key, "--lores-height")) {
                pipeline.lores_height = n;
            } else if (eq(key, "--bitrate")) {
                bitrate = n;
            } else if (eq(key, "--gop")) {
                gop = n;
            } else if (eq(key, "--fps")) {
                fps = n;
            } else if (eq(key, "--noise-reduction")) {
                capture_opts.noise_reduction = n;
            } else if (eq(key, "--width")) {
                cfg.width = n;
            } else if (eq(key, "--height")) {
                cfg.height = n;
            } else if (eq(key, "--buffers")) {
                cfg.buffer_count = n;
            } else if (eq(key, "--camera")) {
                cfg.camera_index = n;
            } else if (eq(key, "--exposure-us")) {
                cfg.exposure_us = n;
            } else if (eq(key, "--frame-us")) {
                cfg.frame_duration_us = n;
            } else if (eq(key, "--warmup")) {
                warmup = n;
            } else if (eq(key, "--frames")) {
                frames = n;
            } else if (eq(key, "--quality")) {
                quality = n;
            } else if (eq(key, "--timeout-ms")) {
                timeout_ms = n;
            } else return error.UnknownOption;
        }
    }
    if ((frames == 0 and !eq(command, "preview")) or quality == 0 or quality > 100 or fps == 0 or fps > 1000) return error.InvalidArgument;
    if (std.mem.endsWith(u8, output, ".dng")) {
        cfg.raw = 1;
        capture_opts.unpacked_raw = 1;
    }
    if (eq(command, "preview") or eq(command, "record")) {
        if (cfg.width == 0) {
            cfg.width = 1280;
            cfg.height = 720;
        }
        if (cfg.frame_duration_us == 0) cfg.frame_duration_us = 1_000_000 / fps;
    }
    pipeline.capture = capture_opts;
    const cam = try camera.Camera.initPipeline(cfg, pipeline);
    defer cam.deinit() catch |err| std.debug.print("close: {s}\n", .{@errorName(err)});
    const info = cam.info();
    if (info.backend == camera.c.ZC_SYNTHETIC and !simulate) return error.SyntheticBackendRequiresSimulateFlag;
    if (info.backend != camera.c.ZC_SYNTHETIC and simulate) return error.SimulateRequiresSyntheticBuild;
    const negotiated = cam.pipelineInfo();
    if (eq(command, "modes")) {
        const modes = try a.alloc(camera.c.zc_sensor_mode, try cam.sensorModes(&.{}));
        defer a.free(modes);
        _ = try cam.sensorModes(modes);
        for (modes) |mode| std.debug.print("{d}x{d} depth={d} format={s}\n", .{ mode.width, mode.height, mode.bit_depth, std.mem.sliceTo(&mode.format, 0) });
        return;
    }
    if (eq(command, "info")) {
        std.debug.print("backend={s} camera={s} main={d}x{d} stride={d} buffers={d} raw={s}\n", .{
            if (info.backend == camera.c.ZC_SYNTHETIC) "synthetic" else "libcamera",
            std.mem.sliceTo(&info.camera_id, 0),
            info.main.width,
            info.main.height,
            info.main.stride,
            info.buffer_count,
            std.mem.sliceTo(&info.raw.format, 0),
        });
        std.debug.print("sensor={d}x{d} depth={d} lores={d}x{d} format={s} stride={d}\n", .{ negotiated.sensor_width, negotiated.sensor_height, negotiated.sensor_bit_depth, negotiated.lores.width, negotiated.lores.height, std.mem.sliceTo(&negotiated.lores.format, 0), negotiated.lores.stride });
        return;
    }
    try cam.start();
    defer cam.stop() catch {};
    for (0..warmup) |_| {
        var f = try cam.acquire(timeout_ms);
        try f.release();
    }
    if (eq(command, "capture")) {
        var frame = try cam.acquire(timeout_ms);
        defer frame.release() catch {};
        if (std.mem.endsWith(u8, output, ".dng")) {
            try frame.saveDng(output);
        } else if (std.mem.endsWith(u8, output, ".ppm")) {
            const file = try std.fs.cwd().createFile(output, .{});
            defer file.close();
            try (try frame.rgb()).savePpm(file);
        } else if (std.mem.endsWith(u8, output, ".jpg") or std.mem.endsWith(u8, output, ".jpeg")) {
            try frame.saveJpeg(output, quality);
        } else return error.UnsupportedOutputExtension;
        if (frame.value.raw.plane_count > 0 and !std.mem.endsWith(u8, output, ".dng")) {
            for (0..frame.value.raw.plane_count) |p| {
                const raw_path = try std.fmt.allocPrint(a, "{s}.raw.{d}", .{ output, p });
                defer a.free(raw_path);
                const file = try std.fs.cwd().createFile(raw_path, .{});
                defer file.close();
                const plane = frame.value.raw.planes[p];
                try file.writeAll(plane.data[0..@intCast(plane.bytes_used)]);
            }
        }
        if (negotiated.lores.width != 0) {
            const lores = try frame.stream(camera.c.ZC_LORES);
            const rgb = std.mem.eql(u8, std.mem.sliceTo(&lores.format, 0), "BGR888");
            const size = @as(usize, lores.width) * lores.height * 3 / @as(usize, if (rgb) 1 else 2);
            const bytes = try a.alloc(u8, size);
            defer a.free(bytes);
            try camera.check(camera.media.zc_copy_stream(&lores, bytes.ptr, bytes.len));
            const path = try std.fmt.allocPrint(a, "{s}.lores.{s}", .{ output, if (rgb) "rgb" else "i420" });
            defer a.free(path);
            const file = try std.fs.cwd().createFile(path, .{});
            defer file.close();
            try file.writeAll(bytes);
        }
        const meta_path = try std.fmt.allocPrint(a, "{s}.json", .{output});
        defer a.free(meta_path);
        const meta_file = try std.fs.cwd().createFile(meta_path, .{});
        defer meta_file.close();
        var meta: [4096]u8 = undefined;
        // Names are fixed libcamera pixel-format identifiers, not arbitrary user input.
        const json = try std.fmt.bufPrint(&meta, "{{\"backend\":\"{s}\",\"sequence\":{d},\"timestamp_ns\":{d},\"width\":{d},\"height\":{d},\"stride\":{d},\"exposure_us\":{d},\"analogue_gain\":{d},\"red_gain\":{d},\"blue_gain\":{d},\"raw_format\":\"{s}\",\"raw_width\":{d},\"raw_height\":{d},\"raw_stride\":{d},\"raw_planes\":{d},\"sensor_width\":{d},\"sensor_height\":{d},\"sensor_bit_depth\":{d},\"lores_width\":{d},\"lores_height\":{d},\"lores_stride\":{d},\"lores_format\":\"{s}\"}}\n", .{ if (info.backend == 0) "synthetic" else "libcamera", frame.value.sequence, frame.value.timestamp_ns, info.main.width, info.main.height, info.main.stride, frame.value.exposure_us, frame.value.analogue_gain, frame.value.red_gain, frame.value.blue_gain, std.mem.sliceTo(&info.raw.format, 0), info.raw.width, info.raw.height, info.raw.stride, frame.value.raw.plane_count, negotiated.sensor_width, negotiated.sensor_height, negotiated.sensor_bit_depth, negotiated.lores.width, negotiated.lores.height, negotiated.lores.stride, std.mem.sliceTo(&negotiated.lores.format, 0) });
        try meta_file.writeAll(json);
        std.debug.print("saved {s} and {s}\n", .{ output, meta_path });
        return;
    }
    if (eq(command, "preview") or eq(command, "record")) {
        var window: ?*camera.c.zc_preview = null;
        if (show_preview) try camera.check(camera.media.zc_preview_open("zig-camera", info.main.width, info.main.height, &window));
        defer if (window) |w| {
            camera.check(camera.media.zc_preview_close(w)) catch {};
        };
        var recorder: ?*camera.c.zc_recorder = null;
        if (eq(command, "record")) {
            var video_cfg: camera.c.zc_video_config = undefined;
            camera.media.zc_default_video_config(&video_cfg);
            video_cfg.width = info.main.width;
            video_cfg.height = info.main.height;
            video_cfg.fps_num = fps;
            video_cfg.quality = quality;
            video_cfg.codec = codec;
            video_cfg.bitrate = bitrate;
            video_cfg.gop = gop;
            try camera.check(camera.media.zc_video_open(output, &video_cfg, &recorder));
        }
        errdefer if (recorder) |r| {
            _ = camera.media.zc_video_close(r);
        };
        var n: u64 = 0;
        while (frames == 0 or n < frames) : (n += 1) {
            var frame = try cam.acquire(timeout_ms);
            defer frame.release() catch {};
            if (window) |w| {
                const status = camera.media.zc_preview_show(w, &frame.value);
                if (status == 1) break;
                try camera.check(status);
            }
            if (recorder) |r| {
                const timestamp = if (info.backend == camera.c.ZC_SYNTHETIC) n * 1_000_000_000 / fps else frame.value.timestamp_ns;
                try camera.check(camera.media.zc_video_write(r, &frame.value, timestamp));
            }
        }
        if (recorder) |r| {
            recorder = null;
            try camera.check(camera.media.zc_video_close(r));
        }
        std.debug.print("processed {d} frames\n", .{n});
        return;
    }
    var timer = try std.time.Timer.start();
    const cpu_start = cpuTime();
    var checksum: u64 = 0;
    var first: u64 = 0;
    var last: u64 = 0;
    var first_timestamp: u64 = 0;
    var last_timestamp: u64 = 0;
    for (0..frames) |n| {
        var f = try cam.acquire(timeout_ms);
        if (n == 0) {
            first = f.value.sequence;
            first_timestamp = f.value.timestamp_ns;
        }
        last = f.value.sequence;
        last_timestamp = f.value.timestamp_ns;
        checksum +%= f.value.main.planes[0].data[0];
        try f.release();
    }
    const ns = timer.read();
    const cpu_ns = cpuTime() - cpu_start;
    const s = cam.stats();
    var buf: [1024]u8 = undefined;
    try std.fs.File.stdout().writeAll(try std.fmt.bufPrint(&buf, "{{\"backend\":\"{s}\",\"mode\":\"lease\",\"format\":\"BGR888\",\"frames\":{d},\"width\":{d},\"height\":{d},\"stride\":{d},\"buffers\":{d},\"wall_ns\":{d},\"cpu_ns\":{d},\"first_sequence\":{d},\"last_sequence\":{d},\"first_timestamp_ns\":{d},\"last_timestamp_ns\":{d},\"dropped_total\":{d},\"checksum\":{d}}}\n", .{ if (info.backend == 0) "synthetic" else "libcamera", frames, info.main.width, info.main.height, info.main.stride, info.buffer_count, ns, cpu_ns, first, last, first_timestamp, last_timestamp, s.dropped, checksum }));
}
fn eq(a: []const u8, b: []const u8) bool {
    return std.mem.eql(u8, a, b);
}
const Timespec = extern struct { sec: c_long, nsec: c_long };
extern "c" fn clock_gettime(c_int, *Timespec) c_int;
fn cpuTime() u64 {
    var ts: Timespec = undefined;
    const id: c_int = if (@import("builtin").os.tag == .macos) 12 else 2;
    if (clock_gettime(id, &ts) != 0) return 0;
    return @as(u64, @intCast(ts.sec)) * 1_000_000_000 + @as(u64, @intCast(ts.nsec));
}
