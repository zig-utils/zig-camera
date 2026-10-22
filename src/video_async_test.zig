//! Ownership/concurrency regression tests use C callbacks, never a language VM.
const std = @import("std");
const v = @import("video.zig");
const c = @import("abi.zig").c;
const A = std.testing.allocator;
const Gate = struct {
    entered: std.Thread.ResetEvent = .{},
    unblock: std.Thread.ResetEvent = .{},
    failed: bool = false,
    fn write(ctx: ?*anyopaque, _: [*c]const u8, _: u64) callconv(.c) c_int {
        const self: *Gate = @ptrCast(@alignCast(ctx.?));
        self.entered.set();
        self.unblock.wait();
        return if (self.failed) c.ZC_IO else c.ZC_OK;
    }
    fn callbacks(self: *Gate) c.zc_output_callbacks {
        var cb = std.mem.zeroes(c.zc_output_callbacks);
        cb.struct_size = @sizeOf(c.zc_output_callbacks);
        cb.format = c.ZC_OUTPUT_MKV;
        cb.context = self;
        cb.write = write;
        cb.file_fd = -1;
        cb.pts_fd = -1;
        cb.secondary_pts_fd = -1;
        return cb;
    }
};
fn count(ctx: ?*anyopaque, _: [*c]const c.zc_output_packet) callconv(.c) c_int {
    const value: *usize = @ptrCast(@alignCast(ctx.?));
    value.* += 1;
    return c.ZC_OK;
}
fn fail(_: ?*anyopaque, _: [*c]const c.zc_output_packet) callconv(.c) c_int {
    return c.ZC_IO;
}
fn packets(value: *usize) c.zc_output_callbacks {
    return .{ .struct_size = @sizeOf(c.zc_output_callbacks), .format = c.ZC_OUTPUT_PACKETS, .context = value, .packet = count, .write = null, .patch = null, .file_fd = -1, .pts_fd = -1, .secondary_pts_fd = -1, .reserved = 0 };
}
fn recorder(value: *usize) !*c.zc_recorder {
    const cfg = c.zc_video_config{ .width = 16, .height = 16, .fps_num = 25, .fps_den = 1, .codec = c.ZC_MJPEG, .bitrate = 0, .quality = 80, .gop = 0 };
    var opts = v.defaultRecordingOptions();
    var out: ?*c.zc_recorder = null;
    try std.testing.expectEqual(c.ZC_OK, v.create(&cfg, &opts, 0, &out));
    var cb = packets(value);
    try std.testing.expectEqual(c.ZC_OK, v.openCallbacks(out.?, &cb));
    return out.?;
}
fn frameWrite(rec: *c.zc_recorder, index: u64) !void {
    var pixels: [16 * 16 * 3]u8 = @splat(100);
    var frame = std.mem.zeroes(c.zc_frame);
    frame.token = 1;
    frame.main.width = 16;
    frame.main.height = 16;
    frame.main.stride = 48;
    frame.main.plane_count = 1;
    @memcpy(frame.main.format[0..6], "BGR888");
    frame.main.planes[0].data = &pixels;
    frame.main.planes[0].length = pixels.len;
    frame.main.planes[0].bytes_used = pixels.len;
    try std.testing.expectEqual(c.ZC_OK, v.write(rec, &frame, index * 40_000_000));
}
fn terminal(rec: *c.zc_recorder, job: *c.zc_preparation_job) !c.zc_preparation_job_state {
    var timer = try std.time.Timer.start();
    while (true) {
        _ = v.pollPreparations(rec);
        var state: c.zc_preparation_job_state = undefined;
        _ = v.preparationState(job, &state);
        if (state.done != 0) return state;
        if (timer.read() > 5_000_000_000) return error.TestTimeout;
        std.Thread.sleep(100_000);
    }
}
test "native preparation blocks neither capture nor healthy peers and cancellation waits for cleanup" {
    var delivered: usize = 0;
    const rec = try recorder(&delivered);
    defer _ = v.close(rec);
    var gate: Gate = .{};
    defer gate.unblock.set();
    var cb = gate.callbacks();
    var job: ?*c.zc_preparation_job = null;
    try std.testing.expectEqual(c.ZC_OK, v.prepareAsync(rec, 0, null, &cb, 0, &job));
    try gate.entered.timedWait(5_000_000_000);
    for (0..6) |i| try frameWrite(rec, i);
    try std.testing.expectEqual(@as(usize, 6), delivered);
    try std.testing.expectEqual(c.ZC_BUSY, v.closePreparation(job.?));
    try std.testing.expectEqual(c.ZC_BUSY, v.removeOutput(rec, 0));
    try std.testing.expectEqual(c.ZC_OK, v.cancelPreparation(job.?));
    try std.testing.expectEqual(c.ZC_STATE, v.cancelPreparation(job.?));
    gate.unblock.set();
    const state = try terminal(rec, job.?);
    try std.testing.expectEqual(c.ZC_STALE, state.error_code);
    try std.testing.expectEqual(@as(u32, c.ZC_PREPARATION_CANCELLED), state.phase);
    try std.testing.expectEqual(c.ZC_OK, v.closePreparation(job.?));
    try frameWrite(rec, 6);
    try std.testing.expectEqual(@as(usize, 7), delivered);
}
test "claimed construction failure wins over cancellation" {
    var delivered: usize = 0;
    const rec = try recorder(&delivered);
    defer _ = v.close(rec);
    var gate: Gate = .{ .failed = true };
    defer gate.unblock.set();
    var cb = gate.callbacks();
    var job: ?*c.zc_preparation_job = null;
    try std.testing.expectEqual(c.ZC_OK, v.prepareAsync(rec, 0, null, &cb, 0, &job));
    try gate.entered.timedWait(5_000_000_000);
    _ = v.cancelPreparation(job.?);
    gate.unblock.set();
    const state = try terminal(rec, job.?);
    try std.testing.expectEqual(c.ZC_IO, state.error_code);
    try std.testing.expectEqual(@as(u32, c.ZC_PREPARATION_FAILED), state.phase);
    _ = v.closePreparation(job.?);
    try frameWrite(rec, 0);
}
test "eight simultaneous preparation workers retain stable IDs and enforce admission" {
    var counts: [8]usize = @splat(0);
    var ids: [8]u64 = @splat(0);
    const rec = try recorder(&counts[0]);
    defer _ = v.close(rec);
    for (1..8) |i| {
        var cb = packets(&counts[i]);
        try std.testing.expectEqual(c.ZC_OK, v.addCallbacks(rec, &cb, &ids[i]));
    }
    var gates: [8]Gate = .{Gate{}} ** 8;
    defer for (&gates) |*gate| gate.unblock.set();
    var jobs: [8]?*c.zc_preparation_job = @splat(null);
    for (0..8) |i| {
        var cb = gates[i].callbacks();
        try std.testing.expectEqual(c.ZC_OK, v.prepareAsync(rec, ids[i], null, &cb, 0, &jobs[i]));
        try gates[i].entered.timedWait(5_000_000_000);
    }
    var duplicate: ?*c.zc_preparation_job = null;
    var cb = gates[0].callbacks();
    try std.testing.expectEqual(c.ZC_BUSY, v.prepareAsync(rec, 0, null, &cb, 0, &duplicate));
    for (0..4) |i| try frameWrite(rec, i);
    for (counts) |value| try std.testing.expectEqual(@as(usize, 4), value);
    for (0..8) |i| {
        _ = v.cancelPreparation(jobs[i].?);
        gates[i].unblock.set();
        _ = try terminal(rec, jobs[i].?);
        _ = v.closePreparation(jobs[i].?);
    }
}
test "recovery headers build independently and fresh publication preserves quarantined generation" {
    var delivered: usize = 0;
    var unused: usize = 0;
    const rec = try recorder(&unused);
    defer _ = v.close(rec);
    try std.testing.expectEqual(c.ZC_OK, v.setIsolation(rec, 1));
    var broken = packets(&unused);
    broken.packet = fail;
    // Replace primary before any input, using the existing synchronous protocol.
    try std.testing.expectEqual(c.ZC_OK, v.closeOutput(rec));
    try std.testing.expectEqual(c.ZC_OK, v.openCallbacks(rec, &broken));
    var healthy = packets(&delivered);
    var id: u64 = 0;
    try std.testing.expectEqual(c.ZC_OK, v.addCallbacks(rec, &healthy, &id));
    try frameWrite(rec, 0);
    var state: c.zc_output_state = undefined;
    _ = v.outputState(rec, 0, &state);
    try std.testing.expectEqual(c.ZC_IO, state.error_code);
    const generation = state.generation;
    var gate: Gate = .{};
    defer gate.unblock.set();
    var cb = gate.callbacks();
    var job: ?*c.zc_preparation_job = null;
    try std.testing.expectEqual(c.ZC_OK, v.prepareAsync(rec, 0, null, &cb, 1, &job));
    try gate.entered.timedWait(5_000_000_000);
    for (1..5) |i| try frameWrite(rec, i);
    _ = v.outputState(rec, 0, &state);
    try std.testing.expectEqual(generation, state.generation);
    try std.testing.expectEqual(@as(usize, 5), delivered);
    gate.unblock.set();
    const result = try terminal(rec, job.?);
    try std.testing.expectEqual(c.ZC_OK, result.error_code);
    _ = v.outputState(rec, 0, &state);
    try std.testing.expectEqual(generation + 1, state.generation);
    try std.testing.expectEqual(c.ZC_OK, state.error_code);
    _ = v.closePreparation(job.?);
    try frameWrite(rec, 5);
}
const Closer = struct {
    rec: *c.zc_recorder,
    result: c_int = c.ZC_TIMEOUT,
    fn run(self: *Closer) void {
        self.result = v.close(self.rec);
    }
};
test "recorder close joins a blocked recipe and job ownership survives recorder destruction" {
    var delivered: usize = 0;
    const rec = try recorder(&delivered);
    var gate: Gate = .{};
    defer gate.unblock.set();
    var cb = gate.callbacks();
    var job: ?*c.zc_preparation_job = null;
    try std.testing.expectEqual(c.ZC_OK, v.prepareAsync(rec, 0, null, &cb, 0, &job));
    try gate.entered.timedWait(5_000_000_000);
    var closer: Closer = .{ .rec = rec };
    const thread = try std.Thread.spawn(.{}, Closer.run, .{&closer});
    gate.unblock.set();
    thread.join();
    try std.testing.expectEqual(c.ZC_OK, closer.result);
    var state: c.zc_preparation_job_state = undefined;
    _ = v.preparationState(job.?, &state);
    try std.testing.expectEqual(@as(u32, 1), state.done);
    try std.testing.expectEqual(c.ZC_STALE, state.error_code);
    try std.testing.expectEqual(c.ZC_OK, v.closePreparation(job.?));
}

test "automatic recovery consumes failed construction once and uses fresh indexed paths" {
    var unused: usize = 0;
    var delivered: usize = 0;
    const rec = try recorder(&unused);
    defer _ = v.close(rec);
    _ = v.setIsolation(rec, 1);
    _ = v.closeOutput(rec);
    var broken = packets(&unused);
    broken.packet = fail;
    _ = v.openCallbacks(rec, &broken);
    var healthy = packets(&delivered);
    var id: u64 = 0;
    _ = v.addCallbacks(rec, &healthy, &id);
    var dir = std.testing.tmpDir(.{});
    defer dir.cleanup();
    const absolute = try dir.dir.realpathAlloc(A, ".");
    defer A.free(absolute);
    const pattern = try std.fmt.allocPrintSentinel(A, "{s}/recovery-{{index}}.mkv", .{absolute}, 0);
    defer A.free(pattern);
    {
        const existing = try dir.dir.createFile("recovery-1.mkv", .{});
        defer existing.close();
        try existing.writeAll("untouched");
    }
    try std.testing.expectEqual(c.ZC_OK, v.setOutputRecovery(rec, 0, 3, 0, 0));
    try std.testing.expectEqual(c.ZC_OK, v.setAutomatic(rec, 0, pattern, 1, 1, 0, 0));
    var generation: u64 = 0;
    var automatic: c.zc_automatic_state = undefined;
    for (0..200) |i| {
        try frameWrite(rec, i);
        std.Thread.sleep(1_000_000);
        _ = v.pollPreparations(rec);
        var state: c.zc_output_state = undefined;
        _ = v.outputState(rec, 0, &state);
        generation = state.generation;
        _ = v.automaticState(rec, 0, &automatic);
        if (generation == 1 and automatic.pending == 0) break;
    }
    try std.testing.expectEqual(@as(u64, 1), generation);
    try std.testing.expectEqual(@as(u64, 3), automatic.next_index);
    var recovery: c.zc_output_recovery_state = undefined;
    _ = v.outputRecovery(rec, 0, &recovery);
    try std.testing.expectEqual(@as(u32, 2), recovery.attempts);
    const existing = try dir.dir.readFileAlloc(A, "recovery-1.mkv", 100);
    defer A.free(existing);
    try std.testing.expectEqualStrings("untouched", existing);
    try std.testing.expect(delivered > 1);
}

test "automatic recovery exhaustion never resets or overwrites a collided target" {
    var unused: usize = 0;
    const rec = try recorder(&unused);
    defer _ = v.close(rec);
    _ = v.setIsolation(rec, 1);
    _ = v.closeOutput(rec);
    var broken = packets(&unused);
    broken.packet = fail;
    _ = v.openCallbacks(rec, &broken);
    var dir = std.testing.tmpDir(.{});
    defer dir.cleanup();
    const absolute = try dir.dir.realpathAlloc(A, ".");
    defer A.free(absolute);
    const pattern = try std.fmt.allocPrintSentinel(A, "{s}/{{index}}.mkv", .{absolute}, 0);
    defer A.free(pattern);
    for (1..4) |i| {
        var name: [20]u8 = undefined;
        const file = try dir.dir.createFile(try std.fmt.bufPrint(&name, "{d}.mkv", .{i}), .{});
        file.close();
    }
    _ = v.setOutputRecovery(rec, 0, 3, 0, 0);
    _ = v.setAutomatic(rec, 0, pattern, 1, 1, 0, 0);
    for (0..50) |i| {
        try frameWrite(rec, i);
        std.Thread.sleep(1_000_000);
    }
    _ = v.pollPreparations(rec);
    var retry: c.zc_output_recovery_state = undefined;
    _ = v.outputRecovery(rec, 0, &retry);
    try std.testing.expectEqual(@as(u32, 3), retry.attempts);
    try std.testing.expectEqual(@as(u32, 1), retry.exhausted);
    var automatic: c.zc_automatic_state = undefined;
    _ = v.automaticState(rec, 0, &automatic);
    try std.testing.expectEqual(@as(u64, 4), automatic.next_index);
    try std.testing.expectEqual(@as(u32, 0), automatic.pending);
    try std.testing.expect(automatic.error_code != c.ZC_OK);
}

const PacketGate = struct {
    entered: std.Thread.ResetEvent = .{},
    unblock: std.Thread.ResetEvent = .{},
    fn packet(ctx: ?*anyopaque, _: [*c]const c.zc_output_packet) callconv(.c) c_int {
        const self: *PacketGate = @ptrCast(@alignCast(ctx.?));
        self.entered.set();
        self.unblock.wait();
        return c.ZC_IO;
    }
};
test "retained split job observes late isolated retirement failure during recorder close" {
    var unused: usize = 0;
    var delivered: usize = 0;
    const rec = try recorder(&unused);
    var gate: PacketGate = .{};
    defer gate.unblock.set();
    _ = v.setIsolation(rec, 1);
    _ = v.closeOutput(rec);
    var broken = packets(&unused);
    broken.packet = PacketGate.packet;
    broken.context = &gate;
    _ = v.openCallbacks(rec, &broken);
    try std.testing.expectEqual(c.ZC_OK, v.setOutputIo(rec, 0, 1024 * 1024, 1000, 0));
    try frameWrite(rec, 0);
    try gate.entered.timedWait(5_000_000_000);
    var healthy = packets(&delivered);
    var job: ?*c.zc_preparation_job = null;
    try std.testing.expectEqual(c.ZC_OK, v.prepareAsync(rec, 0, null, &healthy, 0, &job));
    var timer = try std.time.Timer.start();
    while (true) {
        _ = v.pollPreparations(rec);
        var state: c.zc_preparation_job_state = undefined;
        _ = v.preparationState(job.?, &state);
        if (state.staged != 0) break;
        if (timer.read() > 5_000_000_000) return error.TestTimeout;
        std.Thread.sleep(100_000);
    }
    try frameWrite(rec, 1);
    var closer: Closer = .{ .rec = rec };
    const thread = try std.Thread.spawn(.{}, Closer.run, .{&closer});
    gate.unblock.set();
    thread.join();
    try std.testing.expectEqual(c.ZC_OK, closer.result);
    var state: c.zc_preparation_job_state = undefined;
    _ = v.preparationState(job.?, &state);
    try std.testing.expectEqual(c.ZC_IO, state.error_code);
    try std.testing.expectEqual(@as(u32, 1), state.done);
    _ = v.closePreparation(job.?);
    try std.testing.expect(delivered > 0);
}

test "held preparation admits capture but cannot stage before host header acknowledgement" {
    var old_count: usize = 0;
    var new_count: usize = 0;
    const rec = try recorder(&old_count);
    defer _ = v.close(rec);
    var callbacks = packets(&new_count);
    var job: ?*c.zc_preparation_job = null;
    try std.testing.expectEqual(c.ZC_OK, v.prepareHeld(rec, 0, null, &callbacks, 0, &job));
    var timer = try std.time.Timer.start();
    while (true) {
        _ = v.pollPreparations(rec);
        var state: c.zc_preparation_job_state = undefined;
        _ = v.preparationState(job.?, &state);
        if (state.phase == c.ZC_PREPARATION_READY) break;
        if (timer.read() > 5_000_000_000) return error.TestTimeout;
        std.Thread.sleep(100_000);
    }
    for (0..5) |i| try frameWrite(rec, i);
    try std.testing.expectEqual(@as(usize, 5), old_count);
    try std.testing.expectEqual(@as(usize, 0), new_count);
    try std.testing.expectEqual(c.ZC_OK, v.publishPreparation(job.?));
    _ = v.pollPreparations(rec);
    try frameWrite(rec, 5);
    const state = try terminal(rec, job.?);
    try std.testing.expectEqual(c.ZC_OK, state.error_code);
    try std.testing.expectEqual(@as(usize, 1), new_count);
    _ = v.closePreparation(job.?);
}

test "new output hold excludes media until initial host validation completes" {
    var old_count: usize = 0;
    var held_count: usize = 0;
    const rec = try recorder(&old_count);
    defer _ = v.close(rec);
    var callbacks = packets(&held_count);
    var id: u64 = 0;
    _ = v.addCallbacks(rec, &callbacks, &id);
    try std.testing.expectEqual(c.ZC_OK, v.holdOutput(rec, id, 1));
    for (0..5) |i| try frameWrite(rec, i);
    try std.testing.expectEqual(@as(usize, 5), old_count);
    try std.testing.expectEqual(@as(usize, 0), held_count);
    try std.testing.expectEqual(c.ZC_OK, v.holdOutput(rec, id, 0));
    try frameWrite(rec, 5);
    try std.testing.expectEqual(@as(usize, 1), held_count);
}

fn circular() !*c.zc_recorder {
    const cfg = c.zc_video_config{ .width = 16, .height = 16, .fps_num = 25, .fps_den = 1, .codec = c.ZC_MJPEG, .bitrate = 0, .quality = 80, .gop = 0 };
    const ring = c.zc_buffer_config{ .struct_size = @sizeOf(c.zc_buffer_config), .max_frames = 4, .max_bytes = 65536, .duration_us = 5000000 };
    var rec: ?*c.zc_recorder = null;
    try std.testing.expectEqual(c.ZC_OK, v.openCircular(&cfg, &ring, &rec));
    return rec.?;
}
test "held custom pre-roll owns evicted history and joins live packets exactly once" {
    const rec = try circular();
    defer _ = v.close(rec);
    for (0..4) |i| try frameWrite(rec, i);
    var delivered: usize = 0;
    var cb = packets(&delivered);
    try std.testing.expectEqual(c.ZC_OK, v.openHeldCallbacks(rec, &cb));
    var stats: c.zc_buffer_stats = undefined;
    _ = v.bufferStats(rec, &stats);
    try std.testing.expectEqual(@as(u64, 0), stats.segments);
    var blocked: ?*c.zc_preparation_job = null;
    try std.testing.expectEqual(c.ZC_BUSY, v.prepareAsync(rec, 0, null, &cb, 0, &blocked));
    try std.testing.expectEqual(c.ZC_BUSY, v.splitCallbacks(rec, &cb));
    try std.testing.expectEqual(c.ZC_TIMEOUT, v.publishHeldOutput(rec));
    try std.testing.expectEqual(c.ZC_TIMEOUT, v.stepHeldOutput(rec));
    for (4..7) |i| try frameWrite(rec, i);
    try std.testing.expectEqual(@as(usize, 1), delivered);
    while (v.stepHeldOutput(rec) == c.ZC_TIMEOUT) {}
    try std.testing.expectEqual(@as(usize, 7), delivered);
    try std.testing.expectEqual(c.ZC_OK, v.publishHeldOutput(rec));
    _ = v.bufferStats(rec, &stats);
    try std.testing.expectEqual(@as(u64, 1), stats.segments);
    try frameWrite(rec, 7);
    try std.testing.expectEqual(@as(usize, 8), delivered);
}
test "held replay overflow can be discarded without poisoning healthy consumers" {
    const rec = try circular();
    defer _ = v.close(rec);
    var healthy: usize = 0;
    var peer = packets(&healthy);
    var id: u64 = 0;
    try std.testing.expectEqual(c.ZC_OK, v.addCallbacks(rec, &peer, &id));
    for (0..4) |i| try frameWrite(rec, i);
    var pending: usize = 0;
    var cb = packets(&pending);
    try std.testing.expectEqual(c.ZC_OK, v.openHeldCallbacks(rec, &cb));
    for (4..12) |i| try frameWrite(rec, i);
    try std.testing.expectEqual(c.ZC_BUSY, v.stepHeldOutput(rec));
    try std.testing.expectEqual(c.ZC_OK, v.discardHeldOutput(rec));
    try frameWrite(rec, 12);
    try std.testing.expectEqual(@as(usize, 13), healthy);
    try std.testing.expectEqual(@as(usize, 0), pending);
}

test "callback snapshots share bounded slots, own history across close and step exactly once" {
    const rec = try circular();
    for (0..4) |i| try frameWrite(rec, i);
    var first: ?*c.zc_snapshot = null;
    var second: ?*c.zc_snapshot = null;
    var overflow: ?*c.zc_snapshot = null;
    try std.testing.expectEqual(c.ZC_OK, v.freezeCallbacks(rec, &first));
    defer v.closeSnapshot(first.?);
    try std.testing.expectEqual(c.ZC_OK, v.freezeCallbacks(rec, &second));
    try std.testing.expectEqual(c.ZC_BUSY, v.freezeCallbacks(rec, &overflow));
    v.closeSnapshot(second.?);
    for (4..8) |i| try frameWrite(rec, i);
    try std.testing.expectEqual(c.ZC_OK, v.close(rec));
    var delivered: usize = 0;
    var cb = packets(&delivered);
    try std.testing.expectEqual(c.ZC_OK, v.openSnapshotCallbacks(first.?, null, &cb));
    try std.testing.expectEqual(c.ZC_STATE, v.writeSnapshot(first.?));
    while (v.stepSnapshot(first.?) == c.ZC_TIMEOUT) {}
    try std.testing.expectEqual(@as(usize, 4), delivered);
    try std.testing.expectEqual(c.ZC_STATE, v.stepSnapshot(first.?));
}
fn factoryConfig() c.zc_factory_config {
    return .{ .struct_size = @sizeOf(c.zc_factory_config), .mode = 1, .max_attempts = 3, .reserved = 0, .next_index = 1, .duration_ns = 0, .max_bytes = 1, .initial_ns = 0, .maximum_ns = 0 };
}
test "factory admission reserves native slots and tickets survive reconfiguration" {
    var delivered: usize = 0;
    const rec = try recorder(&delivered);
    defer _ = v.close(rec);
    try frameWrite(rec, 0);
    var cfg = factoryConfig();
    try std.testing.expectEqual(c.ZC_OK, v.setFactory(rec, 0, &cfg));
    var state: c.zc_factory_state = undefined;
    try std.testing.expectEqual(c.ZC_OK, v.claimFactory(rec, 0, &state));
    const first = state.ticket;
    try std.testing.expectEqual(c.ZC_BUSY, v.close(rec));
    try std.testing.expectEqual(c.ZC_BUSY, v.setFactory(rec, 0, null));
    var cb = packets(&delivered);
    var blocked: ?*c.zc_preparation_job = null;
    try std.testing.expectEqual(c.ZC_BUSY, v.prepareAsync(rec, 0, null, &cb, 0, &blocked));
    try std.testing.expectEqual(c.ZC_STALE, v.finishFactory(rec, 0, first + 1, 0));
    try std.testing.expectEqual(c.ZC_OK, v.finishFactory(rec, 0, first, c.ZC_IO));
    try std.testing.expectEqual(c.ZC_TIMEOUT, v.claimFactory(rec, 0, &state));
    try std.testing.expectEqual(c.ZC_OK, v.setFactory(rec, 0, null));
    try std.testing.expectEqual(c.ZC_OK, v.setFactory(rec, 0, &cfg));
    try std.testing.expectEqual(c.ZC_OK, v.claimFactory(rec, 0, &state));
    try std.testing.expect(state.ticket > first);
    try std.testing.expectEqual(c.ZC_STALE, v.finishFactory(rec, 0, first, 0));
    var job: ?*c.zc_preparation_job = null;
    try std.testing.expectEqual(c.ZC_OK, v.prepareFactory(rec, 0, state.ticket, &cb, &job));
    try std.testing.expectEqual(c.ZC_OK, v.cancelPreparation(job.?));
    const result = try terminal(rec, job.?);
    try std.testing.expectEqual(c.ZC_STALE, result.error_code);
    _ = v.closePreparation(job.?);
    try std.testing.expectEqual(c.ZC_OK, v.finishFactory(rec, 0, state.ticket, c.ZC_STALE));
}

test "factory admission does not consume indices when retained native handles fill the pool" {
    var counts: [8]usize = @splat(0);
    const rec = try recorder(&counts[0]);
    defer _ = v.close(rec);
    var ids: [8]u64 = @splat(0);
    for (1..8) |i| {
        var cb = packets(&counts[i]);
        try std.testing.expectEqual(c.ZC_OK, v.addCallbacks(rec, &cb, &ids[i]));
    }
    try frameWrite(rec, 0);
    var jobs: [8]?*c.zc_preparation_job = @splat(null);
    for (0..8) |i| {
        var cb = packets(&counts[i]);
        try std.testing.expectEqual(c.ZC_OK, v.prepareAsync(rec, ids[i], null, &cb, 0, &jobs[i]));
        _ = v.cancelPreparation(jobs[i].?);
        _ = try terminal(rec, jobs[i].?);
    }
    var cfg = factoryConfig();
    try std.testing.expectEqual(c.ZC_OK, v.setFactory(rec, 0, &cfg));
    var state: c.zc_factory_state = undefined;
    try std.testing.expectEqual(c.ZC_TIMEOUT, v.claimFactory(rec, 0, &state));
    try std.testing.expectEqual(@as(u64, 1), state.next_index);
    _ = v.closePreparation(jobs[0].?);
    try std.testing.expectEqual(c.ZC_OK, v.claimFactory(rec, 0, &state));
    var cb = packets(&counts[0]);
    var blocked: ?*c.zc_preparation_job = null;
    try std.testing.expectEqual(c.ZC_BUSY, v.prepareAsync(rec, ids[1], null, &cb, 0, &blocked));
    var job: ?*c.zc_preparation_job = null;
    try std.testing.expectEqual(c.ZC_OK, v.prepareFactory(rec, 0, state.ticket, &cb, &job));
    _ = v.cancelPreparation(job.?);
    _ = try terminal(rec, job.?);
    _ = v.closePreparation(job.?);
    _ = v.finishFactory(rec, 0, state.ticket, c.ZC_STALE);
    for (jobs[1..]) |old| _ = v.closePreparation(old.?);
}

test "producer ABI owns copies, retains exclusive turn through completion and bounds retained inputs" {
    const m = @import("media.zig");
    var delivered: usize = 0;
    const rec = try recorder(&delivered);
    defer std.testing.expectEqual(c.ZC_OK, m.zc_video_close(rec)) catch unreachable;
    try std.testing.expectEqual(c.ZC_OK, m.zc_video_set_producer_limits(rec, 16 * 16 * 3, 1));
    var pixels: [16 * 16 * 3]u8 = @splat(100);
    var frame = std.mem.zeroes(c.zc_frame);
    frame.token = 1;
    frame.main.width = 16;
    frame.main.height = 16;
    frame.main.stride = 48;
    frame.main.plane_count = 1;
    @memcpy(frame.main.format[0..6], "BGR888");
    frame.main.planes[0].data = &pixels;
    frame.main.planes[0].length = pixels.len;
    frame.main.planes[0].bytes_used = pixels.len;
    var job: ?*c.zc_producer_job = null;
    try std.testing.expectEqual(c.ZC_OK, m.zc_video_producer_frame(rec, &frame, 0, &job));
    @memset(&pixels, 250);
    const owned: *@import("producer.zig").Job = @ptrCast(@alignCast(job.?));
    try std.testing.expectEqual(@as(u8, 100), owned.data[0]);
    var overflow: ?*c.zc_producer_job = @ptrFromInt(1);
    try std.testing.expectEqual(c.ZC_BUSY, m.zc_video_producer_frame(rec, &frame, 40_000_000, &overflow));
    try std.testing.expect(overflow == null);
    try std.testing.expectEqual(c.ZC_BUSY, m.zc_video_close(rec));
    try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_start(job.?));
    try std.testing.expectEqual(c.ZC_BUSY, m.zc_video_write(rec, &frame, 40_000_000));
    var state: c.zc_output_state = undefined;
    try std.testing.expectEqual(c.ZC_BUSY, m.zc_video_output_state(rec, 0, &state));
    try std.testing.expectEqual(c.ZC_BUSY, m.zc_producer_job_close(job.?));
    var timer = try std.time.Timer.start();
    var code: c_int = undefined;
    while (m.zc_producer_job_finish(job.?, &code) == c.ZC_TIMEOUT) {
        if (timer.read() > 5_000_000_000) return error.TestTimeout;
        std.Thread.sleep(100_000);
    }
    try std.testing.expectEqual(c.ZC_OK, code);
    try std.testing.expectEqual(@as(usize, 1), delivered);
    try std.testing.expectEqual(c.ZC_OK, m.zc_video_output_state(rec, 0, &state));
    // A completed but retained handle still owns its charged RGB payload.
    try std.testing.expectEqual(c.ZC_BUSY, m.zc_video_producer_frame(rec, &frame, 40_000_000, &overflow));
    try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_close(job.?));
    var stats: c.zc_producer_stats = undefined;
    _ = m.zc_video_producer_stats(rec, &stats);
    try std.testing.expectEqual(@as(u64, 0), stats.owned_jobs);
    try std.testing.expectEqual(@as(u64, 1), stats.completed);
    try std.testing.expectEqual(@as(u64, 2), stats.rejected);
}

test "active AV cancellation finishes entered PCM, skips remaining PCM and frame, and preserves the recorder" {
    const m = @import("media.zig");
    const Context = struct {
        entered: std.Thread.ResetEvent = .{},
        unblock: std.Thread.ResetEvent = .{},
        videos: usize = 0,
        audio_bytes: usize = 0,
        fn packet(ctx: ?*anyopaque, p: [*c]const c.zc_output_packet) callconv(.c) c_int {
            const self: *@This() = @ptrCast(@alignCast(ctx.?));
            if (p.*.codec == c.ZC_PCM_S16LE) {
                self.entered.set();
                self.unblock.wait();
                self.audio_bytes += @intCast(p.*.length);
            } else self.videos += 1;
            return c.ZC_OK;
        }
    };
    var ctx: Context = .{};
    const cfg = c.zc_video_config{ .width = 16, .height = 16, .fps_num = 25, .fps_den = 1, .codec = c.ZC_MJPEG, .bitrate = 0, .quality = 80, .gop = 0 };
    var opts = v.defaultRecordingOptions();
    opts.sample_rate = 48000;
    var rec: ?*c.zc_recorder = null;
    try std.testing.expectEqual(c.ZC_OK, v.create(&cfg, &opts, 0, &rec));
    defer _ = v.close(rec.?);
    var cb = packets(&ctx.videos);
    cb.context = &ctx;
    cb.packet = Context.packet;
    try std.testing.expectEqual(c.ZC_OK, v.openCallbacks(rec.?, &cb));
    try frameWrite(rec.?, 0);
    try frameWrite(rec.?, 1);
    var pcm_bytes: [3840]u8 = @splat(42); // 40ms at 48kHz mono S16LE.
    var pixels: [16 * 16 * 3]u8 = @splat(100);
    var frame = std.mem.zeroes(c.zc_frame);
    frame.token = 1;
    frame.main.width = 16;
    frame.main.height = 16;
    frame.main.stride = 48;
    frame.main.plane_count = 1;
    @memcpy(frame.main.format[0..6], "BGR888");
    frame.main.planes[0].data = &pixels;
    frame.main.planes[0].length = pixels.len;
    frame.main.planes[0].bytes_used = pixels.len;
    const blocks = [_]c.zc_producer_audio_input{
        .{ .data = &pcm_bytes, .length = pcm_bytes.len, .timestamp_ns = 0 },
        .{ .data = &pcm_bytes, .length = pcm_bytes.len, .timestamp_ns = 40_000_000 },
    };
    var job: ?*c.zc_producer_job = null;
    try std.testing.expectEqual(c.ZC_OK, m.zc_video_producer_av(rec.?, &frame, 80_000_000, &blocks, 2, &job));
    try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_start(job.?));
    try ctx.entered.timedWait(5 * std.time.ns_per_s);
    try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_cancel(job.?));
    try std.testing.expectEqual(c.ZC_BUSY, m.zc_producer_job_close(job.?));
    ctx.unblock.set();
    var code: c_int = undefined;
    while (m.zc_producer_job_finish(job.?, &code) == c.ZC_TIMEOUT) std.Thread.sleep(100_000);
    try std.testing.expectEqual(c.ZC_CANCELLED, code);
    try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_close(job.?));
    try std.testing.expectEqual(@as(usize, 2), ctx.videos);
    try std.testing.expectEqual(@as(usize, 3840), ctx.audio_bytes);
    var stats: c.zc_recording_stats = undefined;
    _ = v.recordingStats(rec.?, &stats);
    try std.testing.expectEqual(@as(u64, 1920), stats.audio_frames);
    // Resume from the actual admitted audio prefix; cancelled data was not retried.
    try std.testing.expectEqual(c.ZC_OK, v.writeAudio(rec.?, &pcm_bytes, pcm_bytes.len, 40_000_000));
    try frameWrite(rec.?, 2);
    try std.testing.expectEqual(@as(usize, 3), ctx.videos);
    try std.testing.expectEqual(@as(usize, 7680), ctx.audio_bytes);
}

fn finishProducer(job: *c.zc_producer_job) !c_int {
    const m = @import("media.zig");
    var code: c_int = undefined;
    var timer = try std.time.Timer.start();
    while (m.zc_producer_job_finish(job, &code) == c.ZC_TIMEOUT) {
        if (timer.read() > 5 * std.time.ns_per_s) return error.TestTimeout;
        std.Thread.sleep(100_000);
    }
    return code;
}

test "terminal flush jobs preserve live outputs, reject new input and replay without duplicate packets" {
    const m = @import("media.zig");
    var delivered: usize = 0;
    const rec = try recorder(&delivered);
    defer _ = v.close(rec);
    try frameWrite(rec, 0);
    try frameWrite(rec, 1);
    var invalid: ?*c.zc_producer_job = @ptrFromInt(1);
    try std.testing.expectEqual(c.ZC_INVALID, m.zc_video_producer_barrier(rec, 2, &invalid));
    try std.testing.expect(invalid == null);
    for (0..2) |_| {
        var job: ?*c.zc_producer_job = null;
        try std.testing.expectEqual(c.ZC_OK, m.zc_video_producer_barrier(rec, 1, &job));
        try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_start(job.?));
        try std.testing.expectEqual(c.ZC_STATE, m.zc_producer_job_cancel(job.?));
        try std.testing.expectEqual(c.ZC_OK, try finishProducer(job.?));
        try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_drain_outputs(job.?));
        try std.testing.expectEqual(c.ZC_BUSY, m.zc_video_close(rec));
        try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_close(job.?));
    }
    try std.testing.expectEqual(@as(usize, 2), delivered);
    var cb = packets(&delivered);
    try std.testing.expectEqual(c.ZC_STATE, v.splitCallbacks(rec, &cb));
    var rejected: ?*c.zc_prepared_output = null;
    try std.testing.expectEqual(c.ZC_STATE, v.prepareSplit(rec, 0, null, &cb, &rejected));
    var frame = std.mem.zeroes(c.zc_frame);
    try std.testing.expectEqual(c.ZC_STATE, m.zc_video_producer_frame(rec, &frame, 80_000_000, &invalid));
}

test "native recording barrier retains worker prefixes and later source writes do not extend them" {
    const m = @import("media.zig");
    const Context = struct {
        first: std.Thread.ResetEvent = .{},
        second: std.Thread.ResetEvent = .{},
        release_first: std.Thread.ResetEvent = .{},
        release_second: std.Thread.ResetEvent = .{},
        calls: usize = 0,
        fn packet(ctx: ?*anyopaque, _: [*c]const c.zc_output_packet) callconv(.c) c_int {
            const self: *@This() = @ptrCast(@alignCast(ctx.?));
            self.calls += 1;
            if (self.calls == 1) {
                self.first.set();
                self.release_first.wait();
            }
            if (self.calls == 2) {
                self.second.set();
                self.release_second.wait();
            }
            return c.ZC_OK;
        }
    };
    var ctx: Context = .{};
    var unused: usize = 0;
    const rec = try recorder(&unused);
    defer _ = v.close(rec);
    defer {
        ctx.release_first.set();
        ctx.release_second.set();
    }
    try std.testing.expectEqual(c.ZC_OK, v.closeOutput(rec));
    var cb = packets(&unused);
    cb.context = &ctx;
    cb.packet = Context.packet;
    try std.testing.expectEqual(c.ZC_OK, v.openCallbacks(rec, &cb));
    try std.testing.expectEqual(c.ZC_OK, v.setOutputIo(rec, 0, 32768, 8, 0));
    try frameWrite(rec, 0);
    try ctx.first.timedWait(5 * std.time.ns_per_s);
    var job: ?*c.zc_producer_job = null;
    try std.testing.expectEqual(c.ZC_OK, m.zc_video_producer_barrier(rec, 0, &job));
    try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_start(job.?));
    try std.testing.expectEqual(c.ZC_OK, try finishProducer(job.?));
    try std.testing.expectEqual(c.ZC_TIMEOUT, m.zc_producer_job_drain_outputs(job.?));
    try frameWrite(rec, 1);
    ctx.release_first.set();
    try ctx.second.timedWait(5 * std.time.ns_per_s);
    try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_drain_outputs(job.?));
    try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_close(job.?));
}

fn restartStage(job: *c.zc_producer_job, expected: u32) !void {
    const m = @import("media.zig");
    var timer = try std.time.Timer.start();
    var stage: u32 = 0;
    while (true) {
        _ = m.zc_producer_job_restart_stage(job, &stage);
        if (stage == expected) return;
        if (stage == 4 or timer.read() > 5 * std.time.ns_per_s) return error.TestTimeout;
        std.Thread.sleep(100_000);
    }
}
fn flushSession(rec: *c.zc_recorder) !void {
    const m = @import("media.zig");
    var job: ?*c.zc_producer_job = null;
    try std.testing.expectEqual(c.ZC_OK, m.zc_video_producer_barrier(rec, 1, &job));
    try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_start(job.?));
    try std.testing.expectEqual(c.ZC_OK, try finishProducer(job.?));
    try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_close(job.?));
}
test "restart stages headers, rolls back cancellation and atomically resets media sessions" {
    const m = @import("media.zig");
    var delivered: usize = 0;
    var next_delivered: usize = 0;
    const rec = try recorder(&delivered);
    defer _ = v.close(rec);
    try frameWrite(rec, 0);
    try flushSession(rec);
    var cb = packets(&next_delivered);
    for ([_]bool{ false, true }) |publish| {
        var job: ?*c.zc_producer_job = null;
        try std.testing.expectEqual(c.ZC_OK, m.zc_video_producer_restart(rec, 2, null, &job));
        try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_start(job.?));
        try restartStage(job.?, 1);
        var headers: [8192]u8 = undefined;
        var length: u32 = 0;
        try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_restart_headers(job.?, &headers, headers.len, &length));
        try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_restart_bind(job.?, &cb));
        try restartStage(job.?, 2);
        if (publish) {
            try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_restart_publish(job.?));
            try std.testing.expectEqual(c.ZC_STATE, m.zc_producer_job_cancel(job.?));
        } else try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_cancel(job.?));
        try std.testing.expectEqual(if (publish) c.ZC_OK else c.ZC_CANCELLED, try finishProducer(job.?));
        try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_close(job.?));
        var state: c.zc_session_state = undefined;
        try std.testing.expectEqual(c.ZC_OK, m.zc_video_session_state(rec, &state));
        try std.testing.expectEqual(@as(u64, if (publish) 1 else 0), state.session);
    }
    try frameWrite(rec, 0);
    try flushSession(rec);
    try std.testing.expectEqual(@as(usize, 1), delivered);
    try std.testing.expectEqual(@as(usize, 1), next_delivered);
}
test "cancelled restart removes only its exclusively created path and preserves replacements" {
    const m = @import("media.zig");
    var delivered: usize = 0;
    const rec = try recorder(&delivered);
    defer _ = v.close(rec);
    try frameWrite(rec, 0);
    try flushSession(rec);
    const path = "zig-out/restart-candidate.mkv";
    try std.fs.cwd().makePath("zig-out");
    std.fs.cwd().deleteFile(path) catch {};
    defer std.fs.cwd().deleteFile(path) catch {};
    for ([_]bool{ false, true }) |replace| {
        var job: ?*c.zc_producer_job = null;
        try std.testing.expectEqual(c.ZC_OK, m.zc_video_producer_restart(rec, 1, path, &job));
        try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_start(job.?));
        try restartStage(job.?, 2);
        if (replace) {
            try std.fs.cwd().deleteFile(path);
            try std.fs.cwd().writeFile(.{ .sub_path = path, .data = "replacement" });
        }
        try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_cancel(job.?));
        try std.testing.expectEqual(c.ZC_CANCELLED, try finishProducer(job.?));
        try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_close(job.?));
        if (replace) {
            const bytes = try std.fs.cwd().readFileAlloc(A, path, 100);
            defer A.free(bytes);
            try std.testing.expectEqualStrings("replacement", bytes);
        } else try std.testing.expectError(error.FileNotFound, std.fs.cwd().access(path, .{}));
    }
}

test "session reconfiguration copies settings, preserves rollback and publishes geometry atomically" {
    const m = @import("media.zig");
    var delivered: usize = 0;
    const rec = try recorder(&delivered);
    defer _ = v.close(rec);
    try frameWrite(rec, 0);
    try flushSession(rec);
    var cfg: c.zc_video_config = undefined;
    var opts: c.zc_recording_options = undefined;
    var bitrate: u32 = undefined;
    try std.testing.expectEqual(c.ZC_OK, m.zc_video_session_config(rec, &cfg, &opts, &bitrate));
    const original = cfg;
    for ([_]bool{ false, true }) |publish| {
        var job: ?*c.zc_producer_job = null;
        try std.testing.expectEqual(c.ZC_OK, m.zc_video_producer_restart(rec, 0, null, &job));
        cfg.width = 32;
        cfg.fps_num = 20;
        cfg.quality = 40;
        try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_restart_configure(job.?, &cfg, &opts, 0));
        cfg.width = 0; // Invalid replacement cannot overwrite the copied recipe.
        try std.testing.expectEqual(c.ZC_INVALID, m.zc_producer_job_restart_configure(job.?, &cfg, &opts, 0));
        opts.sample_rate = 0;
        try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_start(job.?));
        try restartStage(job.?, 2);
        try std.testing.expectEqual(c.ZC_STATE, m.zc_producer_job_restart_configure(job.?, &original, &opts, 0));
        try std.testing.expectEqual(c.ZC_BUSY, m.zc_video_session_config(rec, &cfg, &opts, &bitrate));
        if (publish) {
            try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_restart_publish(job.?));
        } else try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_cancel(job.?));
        try std.testing.expectEqual(if (publish) c.ZC_OK else c.ZC_CANCELLED, try finishProducer(job.?));
        try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_close(job.?));
        try std.testing.expectEqual(c.ZC_OK, m.zc_video_session_config(rec, &cfg, &opts, &bitrate));
        try std.testing.expectEqual(@as(u32, if (publish) 32 else 16), cfg.width);
        try std.testing.expectEqual(@as(u32, if (publish) 20 else 25), cfg.fps_num);
    }
    var cb = packets(&delivered);
    try std.testing.expectEqual(c.ZC_OK, v.openCallbacks(rec, &cb));
    // Old geometry is rejected after successful publication.
    var pixels: [16 * 16 * 3]u8 = @splat(100);
    var frame = std.mem.zeroes(c.zc_frame);
    frame.token = 1;
    frame.main.width = 16;
    frame.main.height = 16;
    frame.main.stride = 48;
    frame.main.plane_count = 1;
    @memcpy(frame.main.format[0..6], "BGR888");
    frame.main.planes[0].data = &pixels;
    frame.main.planes[0].length = pixels.len;
    frame.main.planes[0].bytes_used = pixels.len;
    try std.testing.expectEqual(c.ZC_INVALID, v.write(rec, &frame, 0));
    try std.testing.expectEqual(@as(usize, 1), delivered);
}

test "C session resolution preserves settings on geometry or audio failure" {
    const m = @import("media.zig");
    var cfg = c.zc_video_config{ .width = 32, .height = 24, .fps_num = 25, .fps_den = 1, .codec = c.ZC_MJPEG, .bitrate = 0, .quality = 80, .gop = 0 };
    var opts = v.defaultRecordingOptions();
    try std.testing.expectEqual(c.ZC_INVALID, m.zc_video_resolve_session_config(&cfg, &opts, 0, 64, 48, 1));
    try std.testing.expectEqual(@as(u32, 32), cfg.width);
    opts.sample_rate = 48000;
    opts.channels = 3;
    try std.testing.expectEqual(c.ZC_INVALID, m.zc_video_resolve_session_config(&cfg, &opts, 0, 64, 48, 0));
    try std.testing.expectEqual(@as(u32, 32), cfg.width);
    opts.channels = 1;
    try std.testing.expectEqual(c.ZC_OK, m.zc_video_resolve_session_config(&cfg, &opts, 64000, 64, 48, 0));
    try std.testing.expectEqual(@as(u32, 64), cfg.width);
    try std.testing.expectEqual(@as(u32, 48), cfg.height);
    try std.testing.expectEqual(@as(u32, 80), cfg.quality);
}

test "selected I420 admission owns compact planes and color and rejects before output mutation" {
    const m = @import("media.zig");
    var delivered: usize = 0;
    const rec = try recorder(&delivered);
    defer std.testing.expectEqual(c.ZC_OK, m.zc_video_close(rec)) catch unreachable;
    var y: [316]u8 = @splat(80);
    var u: [78]u8 = @splat(90);
    var vplane: [78]u8 = @splat(240);
    var frame = std.mem.zeroes(c.zc_frame);
    frame.token = 1;
    frame.main.width = 16;
    frame.main.height = 16;
    frame.main.stride = 20;
    frame.main.plane_count = 3;
    @memcpy(frame.main.format[0..6], "YUV420");
    for ([_][]u8{ &y, &u, &vplane }, 0..) |bytes, i| frame.main.planes[i] = .{ .data = bytes.ptr, .length = bytes.len, .bytes_used = bytes.len, .offset = 0, .fd = -1 };
    var color = c.zc_color_space{ .struct_size = @sizeOf(c.zc_color_space), .present = 1, .primaries = c.ZC_PRIMARIES_REC709, .transfer = c.ZC_TRANSFER_SRGB, .ycbcr_encoding = c.ZC_YCBCR_REC601, .range = c.ZC_RANGE_FULL };
    try std.testing.expectEqual(c.ZC_OK, m.zc_video_check_input_color(&color, c.ZC_YUV420));
    var bad = color;
    bad.transfer = c.ZC_TRANSFER_REC709;
    var job: ?*c.zc_producer_job = @ptrFromInt(1);
    try std.testing.expectEqual(c.ZC_UNSUPPORTED, m.zc_video_producer_input_av(rec, &frame, &bad, 0, null, 0, &job));
    try std.testing.expectEqual(null, job);
    try std.testing.expectEqual(c.ZC_UNSUPPORTED, m.zc_video_write_input(rec, &frame, &bad, 0));
    frame.main.planes[2].bytes_used -= 1;
    try std.testing.expectEqual(c.ZC_INVALID, m.zc_video_producer_input_av(rec, &frame, &color, 0, null, 0, &job));
    try std.testing.expectEqual(null, job);
    frame.main.planes[2].bytes_used += 1;
    try std.testing.expectEqual(@as(usize, 0), delivered);
    try std.testing.expectEqual(c.ZC_OK, m.zc_video_write_input(rec, &frame, &color, 0));
    try std.testing.expectEqual(@as(usize, 1), delivered);
    try std.testing.expectEqual(c.ZC_OK, m.zc_video_set_producer_limits(rec, 384, 1));
    try std.testing.expectEqual(c.ZC_OK, m.zc_video_producer_input_av(rec, &frame, &color, 40_000_000, null, 0, &job));
    var stats: c.zc_producer_stats = undefined;
    try std.testing.expectEqual(c.ZC_OK, m.zc_video_producer_stats(rec, &stats));
    try std.testing.expectEqual(@as(u64, 384), stats.owned_bytes);
    const owned: *@import("producer.zig").Job = @ptrCast(@alignCast(job.?));
    @memset(&y, 0);
    @memset(&u, 0);
    @memset(&vplane, 0);
    color.transfer = c.ZC_TRANSFER_REC709;
    try std.testing.expectEqual(@as(u8, 80), owned.data[0]);
    try std.testing.expectEqual(@as(u8, 90), owned.data[256]);
    try std.testing.expectEqual(@as(u8, 240), owned.data[320]);
    try std.testing.expectEqual(@as(u32, c.ZC_TRANSFER_SRGB), owned.input_color.?.transfer);
    try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_start(job.?));
    var timer = try std.time.Timer.start();
    var code: c_int = undefined;
    while (m.zc_producer_job_finish(job.?, &code) == c.ZC_TIMEOUT) {
        try std.testing.expect(timer.read() < 5 * std.time.ns_per_s);
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(c.ZC_OK, code);
    try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_close(job.?));
    try std.testing.expectEqual(@as(usize, 2), delivered);
}

test "restart group validates every participant before one irrevocable shared decision" {
    const m = @import("media.zig");
    var counts = [_]usize{0} ** 2;
    const first = try recorder(&counts[0]);
    const second = try recorder(&counts[1]);
    defer _ = v.close(first);
    defer _ = v.close(second);
    try frameWrite(first, 0);
    try frameWrite(second, 0);
    try flushSession(first);
    try flushSession(second);
    var cfg = c.zc_video_config{ .width = 32, .height = 24, .fps_num = 20, .fps_den = 1, .codec = c.ZC_MJPEG, .bitrate = 0, .quality = 60, .gop = 0 };
    var audio = v.defaultRecordingOptions();
    for ([_]bool{ false, true }) |commit| {
        var jobs: [2]?*c.zc_producer_job = @splat(null);
        for ([_]*c.zc_recorder{ first, second }, 0..) |rec, i| {
            try std.testing.expectEqual(c.ZC_OK, m.zc_video_producer_restart(rec, 0, null, &jobs[i]));
            try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_restart_configure(jobs[i].?, &cfg, &audio, 0));
            try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_start(jobs[i].?));
        }
        for (jobs) |job| try restartStage(job.?, 2);
        try std.testing.expectEqual(c.ZC_INVALID, m.zc_producer_jobs_restart_publish(null, 1));
        const duplicate = [_]?*c.zc_producer_job{ jobs[0], jobs[0] };
        try std.testing.expectEqual(c.ZC_INVALID, m.zc_producer_jobs_restart_publish(&duplicate, 2));
        const missing = [_]?*c.zc_producer_job{ jobs[0], null };
        try std.testing.expectEqual(c.ZC_INVALID, m.zc_producer_jobs_restart_publish(&missing, 2));
        try std.testing.expectEqual(c.ZC_INVALID, m.zc_producer_jobs_restart_publish(&jobs, 0));
        if (!commit) try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_cancel(jobs[1].?));
        try std.testing.expectEqual(if (commit) c.ZC_OK else c.ZC_STATE, m.zc_producer_jobs_restart_publish(&jobs, 2));
        if (!commit) {
            var stage: u32 = 0;
            try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_restart_stage(jobs[0].?, &stage));
            try std.testing.expectEqual(@as(u32, 2), stage);
            try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_cancel(jobs[0].?));
        } else for (jobs) |job| try std.testing.expectEqual(c.ZC_STATE, m.zc_producer_job_cancel(job.?));
        for (jobs) |job| {
            try std.testing.expectEqual(if (commit) c.ZC_OK else c.ZC_CANCELLED, try finishProducer(job.?));
            try std.testing.expectEqual(c.ZC_OK, m.zc_producer_job_close(job.?));
        }
        for ([_]*c.zc_recorder{ first, second }) |rec| {
            var result: c.zc_video_config = undefined;
            var options: c.zc_recording_options = undefined;
            var bitrate: u32 = 0;
            try std.testing.expectEqual(c.ZC_OK, m.zc_video_session_config(rec, &result, &options, &bitrate));
            try std.testing.expectEqual(@as(u32, if (commit) 32 else 16), result.width);
        }
    }
}

test "producer copies YVU and NV physical layouts without a producer-side chroma shuffle" {
    const t = std.testing;
    const m = @import("media.zig");
    for ([_]u32{ c.ZC_YVU420, c.ZC_NV12, c.ZC_NV21 }) |format| {
        var delivered: usize = 0;
        const rec = try recorder(&delivered);
        defer t.expectEqual(c.ZC_OK, m.zc_video_close(rec)) catch unreachable;
        try t.expectEqual(c.ZC_OK, m.zc_video_set_producer_limits(rec, 384, 1));
        var y: [316]u8 = @splat(80);
        var u: [78]u8 = @splat(90);
        var vp: [78]u8 = @splat(240);
        var uv: [156]u8 = @splat(99);
        const pf = @import("processed_format.zig");
        var frame = std.mem.zeroes(c.zc_frame);
        frame.token = 1;
        frame.main.width = 16;
        frame.main.height = 16;
        frame.main.stride = 20;
        frame.main.plane_count = pf.planes(format);
        const name = pf.name(format);
        @memcpy(frame.main.format[0..name.len], name);
        frame.main.planes[0] = .{ .data = &y, .length = y.len, .bytes_used = y.len, .fd = -1 };
        if (pf.semi(format)) {
            for (0..8) |row| for (0..8) |x| {
                uv[row * 20 + x * 2] = if (format == c.ZC_NV12) 90 else 240;
                uv[row * 20 + x * 2 + 1] = if (format == c.ZC_NV12) 240 else 90;
            };
            frame.main.planes[1] = .{ .data = &uv, .length = uv.len, .bytes_used = uv.len, .fd = -1 };
        } else {
            frame.main.planes[1] = .{ .data = &vp, .length = vp.len, .bytes_used = vp.len, .fd = -1 };
            frame.main.planes[2] = .{ .data = &u, .length = u.len, .bytes_used = u.len, .fd = -1 };
        }
        var color = c.zc_color_space{ .struct_size = @sizeOf(c.zc_color_space), .present = 1, .primaries = c.ZC_PRIMARIES_REC709, .transfer = c.ZC_TRANSFER_SRGB, .ycbcr_encoding = c.ZC_YCBCR_REC601, .range = c.ZC_RANGE_FULL };
        var job: ?*c.zc_producer_job = null;
        try t.expectEqual(c.ZC_OK, m.zc_video_producer_input_av(rec, &frame, &color, 0, null, 0, &job));
        const owned: *@import("producer.zig").Job = @ptrCast(@alignCast(job.?));
        try t.expectEqualStrings(name, std.mem.sliceTo(&owned.frame.main.format, 0));
        try t.expectEqual(@as(usize, 384), owned.data.len);
        try t.expectEqual(@as(u32, 16), owned.frame.main.stride);
        try t.expectEqual(@as(u32, 1), owned.frame.main.plane_count);
        if (pf.semi(format)) {
            try t.expectEqual(@as(u8, if (format == c.ZC_NV12) 90 else 240), owned.data[256]);
            try t.expectEqual(@as(u8, if (format == c.ZC_NV12) 240 else 90), owned.data[257]);
            try t.expectEqual(owned.data[256], owned.data[382]);
            try t.expectEqual(owned.data[257], owned.data[383]);
        } else {
            try t.expectEqual(@as(u8, 240), owned.data[256]);
            try t.expectEqual(@as(u8, 90), owned.data[320]);
        }
        @memset(&y, 0);
        @memset(&u, 0);
        @memset(&vp, 0);
        @memset(&uv, 0);
        color.range = 0;
        try t.expectEqual(@as(u32, c.ZC_RANGE_FULL), owned.input_color.?.range);
        try t.expectEqual(@as(u8, 80), owned.data[0]);
        try t.expectEqual(c.ZC_OK, m.zc_producer_job_start(job.?));
        var timer = try std.time.Timer.start();
        var result: c_int = undefined;
        while (m.zc_producer_job_finish(job.?, &result) == c.ZC_TIMEOUT) {
            try t.expect(timer.read() < 5 * std.time.ns_per_s);
            std.Thread.sleep(std.time.ns_per_ms);
        }
        try t.expectEqual(c.ZC_OK, result);
        try t.expectEqual(c.ZC_OK, m.zc_producer_job_close(job.?));
        try t.expectEqual(@as(usize, 1), delivered);
    }
}

test "packed 422 producer keeps physical pair bytes and two-byte budget after original source overwrite" {
    const t = std.testing;
    const m = @import("media.zig");
    const pf = @import("processed_format.zig");
    for ([_]u32{ c.ZC_YUYV, c.ZC_YVYU, c.ZC_UYVY, c.ZC_VYUY }) |format| {
        var delivered: usize = 0;
        const rec = try recorder(&delivered);
        defer _ = m.zc_video_close(rec);
        try t.expectEqual(c.ZC_OK, m.zc_video_set_producer_limits(rec, 512, 1));
        var source: [572]u8 = @splat(99);
        const name = pf.name(format);
        const layout = pf.layout422(name).?;
        for (0..16) |y| for (0..8) |x| layout.write(source[y * 36 + x * 4 ..], .{ 80, 90, 100, 240 });
        var frame = std.mem.zeroes(c.zc_frame);
        frame.token = 1;
        frame.main.width = 16;
        frame.main.height = 16;
        frame.main.stride = 36;
        frame.main.plane_count = 1;
        @memcpy(frame.main.format[0..name.len], name);
        frame.main.planes[0] = .{ .data = &source, .length = source.len, .bytes_used = source.len, .fd = -1 };
        var color = c.zc_color_space{ .struct_size = @sizeOf(c.zc_color_space), .present = 1, .primaries = c.ZC_PRIMARIES_REC709, .transfer = c.ZC_TRANSFER_SRGB, .ycbcr_encoding = c.ZC_YCBCR_REC601, .range = c.ZC_RANGE_FULL };
        var job: ?*c.zc_producer_job = null;
        frame.main.planes[0].bytes_used -= 1;
        try t.expectEqual(c.ZC_INVALID, m.zc_video_producer_input_av(rec, &frame, &color, 0, null, 0, &job));
        try t.expectEqual(null, job);
        frame.main.planes[0].bytes_used += 1;
        try t.expectEqual(c.ZC_OK, m.zc_video_producer_input_av(rec, &frame, &color, 0, null, 0, &job));
        const owned: *@import("producer.zig").Job = @ptrCast(@alignCast(job.?));
        try t.expectEqualStrings(name, std.mem.sliceTo(&owned.frame.main.format, 0));
        try t.expectEqual(@as(usize, 512), owned.data.len);
        try t.expectEqual(@as(u32, 32), owned.frame.main.stride);
        for (0..128) |i| try t.expectEqual([4]u8{ 80, 90, 100, 240 }, layout.read(owned.data[i * 4 ..]));
        @memset(&source, 0);
        color.range = 0;
        try t.expectEqual(@as(u32, c.ZC_RANGE_FULL), owned.input_color.?.range);
        try t.expectEqual(c.ZC_OK, m.zc_producer_job_start(job.?));
        var timer = try std.time.Timer.start();
        var result: c_int = undefined;
        while (m.zc_producer_job_finish(job.?, &result) == c.ZC_TIMEOUT) {
            try t.expect(timer.read() < 5 * std.time.ns_per_s);
            std.Thread.sleep(std.time.ns_per_ms);
        }
        try t.expectEqual(c.ZC_OK, result);
        try t.expectEqual(c.ZC_OK, m.zc_producer_job_close(job.?));
        try t.expectEqual(@as(usize, 1), delivered);
    }
}
