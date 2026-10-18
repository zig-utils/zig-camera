const std = @import("std");
const camera = @import("camera");
pub fn main() !void {
    var cfg = camera.defaultConfig();
    cfg.width = 1920;
    cfg.height = 1080;
    cfg.policy = camera.c.ZC_FIFO;
    const cam = try camera.Camera.init(cfg);
    defer cam.deinit() catch {};
    if (cam.info().backend != camera.c.ZC_SYNTHETIC) return error.UseSyntheticBuildForMicrobenchmarks;
    try cam.start();
    defer cam.stop() catch {};
    const n = 100_000;
    var timer = try std.time.Timer.start();
    var checksum: u64 = 0;
    for (0..n) |_| {
        var f = try cam.acquire(0);
        checksum +%= f.value.sequence;
        try f.release();
    }
    const lease_ns = timer.lap();
    var f = try cam.acquire(0);
    defer f.release() catch {};
    const view = try f.rgb();
    const gray = try std.heap.page_allocator.alloc(u8, cfg.width * cfg.height);
    defer std.heap.page_allocator.free(gray);
    const copy = try std.heap.page_allocator.alloc(u8, view.data.len);
    defer std.heap.page_allocator.free(copy);
    timer.reset();
    for (0..100) |_| {
        @memcpy(copy, view.data);
        std.mem.doNotOptimizeAway(copy.ptr);
    }
    const copy_ns = timer.lap();
    for (0..100) |_| {
        try view.grayscale(gray, cfg.width);
        std.mem.doNotOptimizeAway(gray.ptr);
    }
    const gray_ns = timer.lap();
    std.debug.print("synthetic only; hardware speedup is UNMEASURED\nlease/release: {d} ns/op ({d} iterations)\n1080p RGB copy: {d} ns/frame\n1080p luma: {d} ns/frame\nchecksum: {d}\n", .{ lease_ns / n, n, copy_ns / 100, gray_ns / 100, checksum });
}
