const std = @import("std");
const camera = @import("camera");
const help =
    \\zig-camera list|info|modes|capture|preview|record|bench [options]
    \\  --width N --height N      Processed size; omit both for default still size
    \\  --buffers N              Preallocated request count, 2..32 (default 4)
    \\  --camera N               libcamera camera index (default 0)
    \\  --camera-id ID           Exact backend ID from list; mutually exclusive with --camera
    \\  --fifo                   Deliver in order; default discards older ready frames
    \\  --exposure-us N --gain N  Manual exposure (set both); default auto exposure
    \\  --frame-us N             Requested frame duration, microseconds
    \\  --lens N                 Manual lens position in dioptres; default continuous AF if supported
    \\  --sensor-width N --sensor-height N --sensor-depth N   Exact advertised mode
    \\  --lores-width N --lores-height N  Add a paired analysis stream
    \\  --main-format NAME       BGR888 (default, RGB bytes) or YUV420
    \\  --lores-format NAME      YUV420 (default) or BGR888
    \\  --rotation N --hflip --vflip  Clockwise 0/90/180/270, then output-axis flips
    \\  --strict-transform       Reject adjusted camera orientation
    \\  --transpose              Final diagonal transpose after rotation/flips
    \\  --raw                    Add paired native raw stream
    \\  --raw-format NAME        Request exact raw format (e.g. SRGGB12)
    \\  --output PATH            capture: .ppm/.jpg/.png/.bmp/.tif/.dng; record: .mkv/.mp4
    \\  --image-format NAME      Override still-file extension (jpeg/png/bmp/tiff/ppm/dng)
    \\  --image-stream NAME      Select main/lores for images, raw for DNG
    \\  --record-stream NAME     Select main/lores for video, independent of preview
    \\  --png-compression N --png-filter NAME  zlib 0..9; adaptive/none/sub/up/average/paeth
    \\  --preview-stream NAME    main (default), lores or none (background/overlay only)
    \\  --fps N                  Preview/record frame rate (default 30)
    \\  --codec NAME             mjpeg (MKV), h264 or hevc (MP4, -Dcodecs=true)
    \\  --bitrate N --gop N       AVC/HEVC bits/sec (0 CRF) and keyframe interval
    \\  --rotate-pattern PATH    Exclusive indexed outputs, e.g. trail-{index:03}.mp4
    \\  --rotate-ms N --rotate-bytes N  Soft duration/size rotation limits
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
    if (eq(command, "list")) {
        var simulate = false;
        for (args[2..]) |arg| {
            if (eq(arg, "--simulate")) simulate = true else return error.UnknownOption;
        }
        var snapshot = try camera.discover(if (simulate) camera.c.ZC_SYNTHETIC else camera.c.ZC_LIBCAMERA);
        defer snapshot.deinit();
        const bytes = try snapshot.copy(a);
        defer a.free(bytes);
        const catalog = try camera.catalog_format.Reader.init(bytes);
        var records = catalog.records();
        while (try records.next()) |record| {
            if (record.info.id != 0 or !eq(record.info.name, "CameraId")) continue;
            var values = record.values();
            const id = (try values.next()) orelse return error.InvalidCatalog;
            if (id.kind != .string) return error.InvalidCatalog;
            const line = try std.fmt.allocPrint(a, "{d}\t{s}\n", .{ record.info.group, id.data });
            defer a.free(line);
            try std.fs.File.stdout().writeAll(line);
        }
        return;
    }

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
    var preview_stream: ?u32 = camera.c.ZC_MAIN;
    var main_format: u32 = camera.c.ZC_RGB24;
    var codec: u32 = camera.c.ZC_MJPEG;
    var bitrate: u32 = 0;
    var gop: u32 = 0;
    var rotate_pattern: ?[:0]const u8 = null;
    var rotate_ns: u64 = 0;
    var rotate_bytes: u64 = 0;
    var show_preview = eq(command, "preview");
    var output: [:0]const u8 = if (eq(command, "record")) "capture.mkv" else "capture.ppm";
    var simulate = false;
    var camera_id: ?[:0]const u8 = null;
    var camera_index_set = false;
    var warmup: u32 = 30;
    var frames: u32 = 300;
    var quality: u32 = if (eq(command, "record")) 90 else 98;
    var timeout_ms: u32 = 5000;
    var image_options = camera.defaultImageOptions();
    var image_format: ?u32 = null;
    var image_stream: ?u32 = null;
    var record_stream: u32 = camera.c.ZC_MAIN;
    var rotation: u32 = 0;
    var hflip = false;
    var vflip = false;
    var strict_transform = false;
    var transpose = false;
    var i: usize = 2;
    while (i < args.len) : (i += 1) {
        const key = args[i];
        if (eq(key, "--transpose")) {
            transpose = true;
            continue;
        }
        if (eq(key, "--hflip")) {
            hflip = true;
            continue;
        }
        if (eq(key, "--vflip")) {
            vflip = true;
            continue;
        }
        if (eq(key, "--strict-transform")) {
            strict_transform = true;
            continue;
        }
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
        if (eq(key, "--image-format")) {
            image_format = try camera.still.formatFromName(value);
        } else if (eq(key, "--image-stream")) {
            image_stream = if (eq(value, "main")) camera.c.ZC_MAIN else if (eq(value, "lores")) camera.c.ZC_LORES else if (eq(value, "raw")) camera.c.ZC_RAW else return error.InvalidImageStream;
        } else if (eq(key, "--main-format")) {
            main_format = if (eq(value, "BGR888")) camera.c.ZC_RGB24 else if (eq(value, "YUV420")) camera.c.ZC_YUV420 else return error.InvalidMainFormat;
        } else if (eq(key, "--preview-stream")) {
            preview_stream = if (eq(value, "main")) camera.c.ZC_MAIN else if (eq(value, "lores")) camera.c.ZC_LORES else if (eq(value, "none")) null else return error.InvalidPreviewStream;
        } else if (eq(key, "--record-stream")) {
            record_stream = if (eq(value, "main")) camera.c.ZC_MAIN else if (eq(value, "lores")) camera.c.ZC_LORES else return error.InvalidRecordingStream;
        } else if (eq(key, "--png-filter")) {
            image_options.png_filter = @intFromEnum(std.meta.stringToEnum(camera.still.PngFilter, value) orelse return error.InvalidPngFilter);
        } else if (eq(key, "--lores-format")) {
            pipeline.lores_format = if (eq(value, "YUV420")) camera.c.ZC_YUV420 else if (eq(value, "BGR888")) camera.c.ZC_RGB24 else return error.InvalidLoresFormat;
        } else if (eq(key, "--camera-id")) {
            camera_id = value;
        } else if (eq(key, "--codec")) {
            codec = if (eq(value, "h264")) camera.c.ZC_H264 else if (eq(value, "hevc")) camera.c.ZC_HEVC else if (eq(value, "mjpeg")) camera.c.ZC_MJPEG else return error.InvalidCodec;
        } else if (eq(key, "--output")) {
            output = value;
        } else if (eq(key, "--rotate-pattern")) {
            rotate_pattern = value;
        } else if (eq(key, "--rotate-ms")) {
            rotate_ns = try std.math.mul(u64, try std.fmt.parseInt(u64, value, 10), 1_000_000);
        } else if (eq(key, "--rotate-bytes")) {
            rotate_bytes = try std.fmt.parseInt(u64, value, 10);
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
            if (eq(key, "--png-compression")) {
                image_options.png_compression = n;
            } else if (eq(key, "--rotation")) {
                rotation = n;
            } else if (eq(key, "--sensor-width")) {
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
                camera_index_set = true;
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
    var rotation_name: [4097]u8 = undefined;
    if (rotate_pattern) |pattern| {
        if (!eq(command, "record") or (rotate_ns == 0 and rotate_bytes == 0)) return error.InvalidRotation;
        output = try (try @import("camera").recording_path.Pattern.init(pattern)).format(&rotation_name, 0);
    } else if (rotate_ns != 0 or rotate_bytes != 0) return error.MissingRotationPattern;
    if ((frames == 0 and !eq(command, "preview")) or quality == 0 or quality > 100 or fps == 0 or fps > 1000) return error.InvalidArgument;
    if (eq(command, "capture")) {
        image_options.format = image_format orelse try camera.still.formatFromPath(output);
        image_options.quality = quality;
        if (!camera.still.valid(&image_options)) return error.InvalidImageOptions;
        image_stream = image_stream orelse if (image_options.format == camera.c.ZC_IMAGE_DNG) camera.c.ZC_RAW else camera.c.ZC_MAIN;
        if ((image_options.format == camera.c.ZC_IMAGE_DNG) != (image_stream.? == camera.c.ZC_RAW)) return error.InvalidImageStream;
    }
    if (eq(command, "capture") and image_options.format == camera.c.ZC_IMAGE_DNG) {
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
    if (camera_id != null and camera_index_set) return error.AmbiguousCameraSelector;
    var transform = try camera.ImageTransform.fromRotation(rotation, hflip, vflip);
    if (transpose) transform.transpose = !transform.transpose;
    const cam = if (camera_id) |id| try camera.Camera.initFormattedPipelineId(cfg, pipeline, main_format, transform, strict_transform, id) else try camera.Camera.initFormattedPipeline(cfg, pipeline, main_format, transform, strict_transform);
    defer cam.deinit() catch |err| std.debug.print("close: {s}\n", .{@errorName(err)});
    const info = cam.info();
    if (info.backend == camera.c.ZC_SYNTHETIC and !simulate) return error.SyntheticBackendRequiresSimulateFlag;
    if (info.backend != camera.c.ZC_SYNTHETIC and simulate) return error.SimulateRequiresSyntheticBuild;
    const negotiated = cam.pipelineInfo();
    const video_geometry = if (record_stream == camera.c.ZC_MAIN) info.main else negotiated.lores;
    if (eq(command, "record") and record_stream == camera.c.ZC_LORES) {
        if (video_geometry.plane_count == 0) return error.Unsupported;
        const color = try cam.colorSpace(record_stream);
        try camera.check(camera.media.zc_video_check_input_color(&color, if (std.mem.eql(u8, std.mem.sliceTo(&video_geometry.format, 0), "YUV420")) camera.c.ZC_YUV420 else camera.c.ZC_RGB24));
    }
    if (eq(command, "modes")) {
        const modes = try a.alloc(camera.c.zc_sensor_mode, try cam.sensorModes(&.{}));
        defer a.free(modes);
        _ = try cam.sensorModes(modes);
        for (modes) |mode| std.debug.print("{d}x{d} depth={d} format={s}\n", .{ mode.width, mode.height, mode.bit_depth, std.mem.sliceTo(&mode.format, 0) });
        return;
    }
    if (eq(command, "info")) {
        const orientation = try cam.orientation();
        std.debug.print("orientation=requested:{d} actual:{d} adjusted:{d}\n", .{ orientation.requested, orientation.actual, orientation.adjusted });
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
        const selected_stream = try frame.stream(image_stream.?);
        const selected_color = try frame.colorSpace(image_stream.?);
        try frame.saveStreamImage(output, image_stream.?, image_options);
        if (frame.value.raw.plane_count > 0 and image_options.format != camera.c.ZC_IMAGE_DNG) {
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
        const json = try std.fmt.bufPrint(&meta, "{{\"backend\":\"{s}\",\"sequence\":{d},\"timestamp_ns\":{d},\"width\":{d},\"height\":{d},\"stride\":{d},\"main_format\":\"{s}\",\"exposure_us\":{d},\"analogue_gain\":{d},\"red_gain\":{d},\"blue_gain\":{d},\"raw_format\":\"{s}\",\"raw_width\":{d},\"raw_height\":{d},\"raw_stride\":{d},\"raw_planes\":{d},\"sensor_width\":{d},\"sensor_height\":{d},\"sensor_bit_depth\":{d},\"lores_width\":{d},\"lores_height\":{d},\"lores_stride\":{d},\"lores_format\":\"{s}\"}}\n", .{ if (info.backend == 0) "synthetic" else "libcamera", frame.value.sequence, frame.value.timestamp_ns, info.main.width, info.main.height, info.main.stride, std.mem.sliceTo(&info.main.format, 0), frame.value.exposure_us, frame.value.analogue_gain, frame.value.red_gain, frame.value.blue_gain, std.mem.sliceTo(&info.raw.format, 0), info.raw.width, info.raw.height, info.raw.stride, frame.value.raw.plane_count, negotiated.sensor_width, negotiated.sensor_height, negotiated.sensor_bit_depth, negotiated.lores.width, negotiated.lores.height, negotiated.lores.stride, std.mem.sliceTo(&negotiated.lores.format, 0) });
        try meta_file.writeAll(json[0 .. json.len - 2]);
        const extra = try std.fmt.bufPrint(&meta, ",\"image_stream\":{d},\"image_width\":{d},\"image_height\":{d},\"source_color_space\":{{\"present\":{d},\"primaries\":{d},\"transfer\":{d},\"ycbcr_encoding\":{d},\"range\":{d}}}}}\n", .{ image_stream.?, selected_stream.width, selected_stream.height, selected_color.present, selected_color.primaries, selected_color.transfer, selected_color.ycbcr_encoding, selected_color.range });
        try meta_file.writeAll(extra);
        std.debug.print("saved {s} and {s}\n", .{ output, meta_path });
        return;
    }
    if (eq(command, "preview") or eq(command, "record")) {
        var window: ?*camera.c.zc_preview = null;
        if (show_preview) {
            const display = if (preview_stream == camera.c.ZC_LORES) negotiated.lores else info.main;
            if (display.width == 0 or display.height == 0) return error.InvalidPreviewStream;
            if (preview_stream) |which| {
                var space: camera.c.zc_color_space = undefined;
                try camera.check(camera.core.zc_get_stream_color_space(cam.handle, which, &space));
                const format = std.mem.sliceTo(&display.format, 0);
                const pixel_format: u32 = if (eq(format, "BGR888")) camera.c.ZC_RGB24 else if (eq(format, "YUV420")) camera.c.ZC_YUV420 else return error.InvalidPreviewStream;
                try camera.check(camera.preview_input.zc_preview_check_color(pixel_format, &space));
            }
            try camera.check(if (preview_stream == null) camera.media.zc_preview_open_background("zig-camera", display.width, display.height, &window) else camera.media.zc_preview_open("zig-camera", display.width, display.height, &window));
        }
        defer if (window) |w| {
            camera.check(camera.media.zc_preview_close(w)) catch {};
        };
        var recorder: ?*camera.c.zc_recorder = null;
        if (eq(command, "record")) {
            var video_cfg: camera.c.zc_video_config = undefined;
            camera.media.zc_default_video_config(&video_cfg);
            video_cfg.width = video_geometry.width;
            video_cfg.height = video_geometry.height;
            video_cfg.fps_num = fps;
            video_cfg.quality = quality;
            video_cfg.codec = codec;
            video_cfg.bitrate = bitrate;
            video_cfg.gop = gop;
            var recording_opts: camera.c.zc_recording_options = undefined;
            camera.media.zc_default_recording_options(&recording_opts);
            recording_opts.exclusive = @intFromBool(rotate_pattern != null);
            try camera.check(camera.media.zc_video_open_ex(output, &video_cfg, &recording_opts, &recorder));
            if (rotate_pattern) |pattern| {
                const code = camera.media.zc_video_set_automatic(recorder.?, 0, pattern, 1, 0, rotate_ns, rotate_bytes);
                if (code != camera.c.ZC_OK) {
                    _ = camera.media.zc_video_close(recorder.?);
                    recorder = null;
                    try camera.check(code);
                }
            }
        }
        errdefer if (recorder) |r| {
            _ = camera.media.zc_video_close(r);
        };
        var n: u64 = 0;
        while (frames == 0 or n < frames) : (n += 1) {
            // Synthetic media time can outrun the async file/header worker. Wait
            // without a camera lease so rotation fixtures exercise publication,
            // rather than depending on host scheduling. Real capture stays soft.
            if (simulate and rotate_pattern != null) try waitSyntheticRotation(recorder.?, timeout_ms);
            var frame = try cam.acquire(timeout_ms);
            defer frame.release() catch {};
            if (window) |w| {
                const status = if (preview_stream) |which| camera.preview_input.zc_preview_show_stream(w, cam.handle, frame.value.token, which) else camera.preview_input.zc_preview_show_background(w);
                if (status == 1) break;
                try camera.check(status);
            }
            if (recorder) |r| {
                const timestamp = if (info.backend == camera.c.ZC_SYNTHETIC) n * 1_000_000_000 / fps else frame.value.timestamp_ns;
                try frame.writeVideo(r, record_stream, timestamp);
            }
        }
        if (recorder) |r| {
            var rotation_error: c_int = camera.c.ZC_OK;
            if (rotate_pattern != null) {
                _ = camera.media.zc_video_poll_preparations(r);
                var state: camera.c.zc_automatic_state = undefined;
                try camera.check(camera.media.zc_video_automatic_state(r, 0, &state));
                rotation_error = state.error_code;
            }
            recorder = null;
            try camera.check(camera.media.zc_video_close(r));
            try camera.check(rotation_error);
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
    try std.fs.File.stdout().writeAll(try std.fmt.bufPrint(&buf, "{{\"backend\":\"{s}\",\"mode\":\"lease\",\"format\":\"{s}\",\"frames\":{d},\"width\":{d},\"height\":{d},\"stride\":{d},\"buffers\":{d},\"wall_ns\":{d},\"cpu_ns\":{d},\"first_sequence\":{d},\"last_sequence\":{d},\"first_timestamp_ns\":{d},\"last_timestamp_ns\":{d},\"dropped_total\":{d},\"checksum\":{d}}}\n", .{ if (info.backend == 0) "synthetic" else "libcamera", std.mem.sliceTo(&info.main.format, 0), frames, info.main.width, info.main.height, info.main.stride, info.buffer_count, ns, cpu_ns, first, last, first_timestamp, last_timestamp, s.dropped, checksum }));
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

fn waitSyntheticRotation(recorder: *camera.c.zc_recorder, timeout_ms: u32) !void {
    var timer = try std.time.Timer.start();
    while (true) {
        try camera.check(camera.media.zc_video_poll_preparations(recorder));
        var automatic: camera.c.zc_automatic_state = undefined;
        try camera.check(camera.media.zc_video_automatic_state(recorder, 0, &automatic));
        try camera.check(automatic.error_code);
        if (automatic.pending == 0) return;
        var output: camera.c.zc_output_state = undefined;
        try camera.check(camera.media.zc_video_output_state(recorder, 0, &output));
        if (output.split_state == 1) return;
        if (timer.read() >= @as(u64, timeout_ms) * 1_000_000) return error.Timeout;
        std.Thread.sleep(1_000_000);
    }
}
