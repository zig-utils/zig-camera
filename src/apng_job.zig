//! Bounded copied APNG input and joined native compression/file staging. Home
//! supplies the codec, admission accounting and preparation state machine.
const std = @import("std");
const c = @import("abi.zig").c;
const codec = @import("home/apng_encoder.zig");
const Gate = @import("home/preparation_gate.zig").Gate;
const Admission = @import("home/owned_admission.zig").Registry(4);
const files = @import("image_file.zig");
const Blob = @import("still.zig").Blob;
const A = std.heap.c_allocator;
const cap: usize = 256 * 1024 * 1024;
var registry: Admission = .{ .max_bytes = 512 * 1024 * 1024, .max_items = 4 };
var registry_mutex: std.Thread.Mutex = .{};
const Job = struct {
    allocator: std.mem.Allocator,
    mutex: std.Thread.Mutex = .{},
    gate: Gate = .{},
    finished: bool = false,
    code: c_int = c.ZC_TIMEOUT,
    thread: ?std.Thread = null,
    ticket: Admission.Ticket,
    data: []u8,
    frames: []codec.Frame,
    animation: codec.Animation,
    blob: ?*Blob,
    file: ?*c.zc_image_file,
    limit: usize,
    written: std.atomic.Value(u64) = .init(0),

    fn checkpoint(self: *Job) !void {
        self.mutex.lock();
        const cancelled = self.gate.cancel_requested or self.gate.phase == .cancelled;
        self.mutex.unlock();
        if (cancelled or (self.file != null and files.cancelled(self.file.?))) return error.Cancelled;
    }
    fn run(self: *Job) void {
        self.mutex.lock();
        const claimed = self.gate.claim();
        self.mutex.unlock();
        var code: c_int = if (claimed) self.encode() else c.ZC_CANCELLED;
        if (self.file) |file| code = files.prepared(file, code);
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.gate.cancel_requested or self.gate.phase == .cancelled) {
            if (code == c.ZC_OK or code == c.ZC_CANCELLED or code == c.ZC_STALE) {
                code = c.ZC_CANCELLED;
                _ = self.gate.cleaned();
            } else _ = self.gate.fail();
        } else if (code != c.ZC_OK) {
            _ = self.gate.fail();
        } else if (!self.gate.ready()) code = c.ZC_STATE;
        self.code = code;
        self.finished = true;
    }
    fn encode(self: *Job) c_int {
        var sink = Sink{ .owner = self };
        defer sink.bytes.deinit(self.allocator);
        if (self.file) |file| {
            var fd: std.posix.fd_t = undefined;
            const rc = files.open(file, &fd);
            if (rc != 0) return rc;
            sink.file = .{ .handle = fd };
        }
        codec.write(self.allocator, self.animation, &sink) catch |err| return status(err);
        if (self.file == null) self.blob.?.bytes = sink.bytes.toOwnedSlice(self.allocator) catch return c.ZC_NOMEM;
        return c.ZC_OK;
    }
};
const Sink = struct {
    owner: *Job,
    file: ?std.fs.File = null,
    bytes: std.ArrayList(u8) = .empty,
    count: usize = 0,
    pub fn checkpoint(self: *Sink) !void {
        try self.owner.checkpoint();
    }
    pub fn writeAll(self: *Sink, bytes: []const u8) !void {
        try self.checkpoint();
        if (bytes.len > self.owner.limit - self.count) return error.OutputTooLarge;
        if (self.file) |file| file.writeAll(bytes) catch return error.FileWriteFailed else try self.bytes.appendSlice(self.owner.allocator, bytes);
        self.count += bytes.len;
        self.owner.written.store(self.count, .monotonic);
    }
};
fn job(p: *c.zc_apng_job) *Job {
    return @ptrCast(@alignCast(p));
}
fn status(err: anyerror) c_int {
    return switch (err) {
        error.Cancelled => c.ZC_CANCELLED,
        error.OutOfMemory => c.ZC_NOMEM,
        error.FileWriteFailed, error.CompressionFailed => c.ZC_IO,
        error.BufferFull => c.ZC_BUSY,
        else => c.ZC_INVALID,
    };
}
pub export fn zc_default_apng_config(out: *c.zc_apng_config) void {
    out.* = .{ .struct_size = @sizeOf(c.zc_apng_config), .width = 0, .height = 0, .plays = 0, .png_compression = 1, .png_filter = 0, .max_input_bytes = 64 * 1024 * 1024, .max_output_bytes = 64 * 1024 * 1024 };
}
fn raster(value: *const c.zc_apng_raster) !codec.raster.View {
    if (value.struct_size != @sizeOf(c.zc_apng_raster) or value.format > 2 or (value.bits != 8 and value.bits != 16) or value.big_endian > 1 or value.stride > std.math.maxInt(usize) or value.length > std.math.maxInt(usize) or value.data == null) return error.InvalidDescriptor;
    const result = codec.raster.View{ .data = value.data[0..@intCast(value.length)], .width = value.width, .height = value.height, .stride = @intCast(value.stride), .format = @enumFromInt(value.format), .bits = @intCast(value.bits), .endian = if (value.big_endian == 1) .big else .little };
    _ = try result.validate();
    return result;
}
fn compactSize(value: codec.raster.View) !usize {
    return std.math.mul(usize, try value.validate(), value.height);
}
fn copy(value: codec.raster.View, data: []u8, offset: *usize) codec.raster.View {
    const row: usize = @as(usize, value.width) * value.format.channels() * (value.bits / 8);
    const size = row * value.height;
    const dest = data[offset.*..][0..size];
    for (0..value.height) |y| @memcpy(dest[y * row ..][0..row], value.data[y * value.stride ..][0..row]);
    offset.* += size;
    var result = value;
    result.data = dest;
    result.stride = row;
    return result;
}
fn release(ticket: Admission.Ticket) void {
    registry_mutex.lock();
    defer registry_mutex.unlock();
    registry.release(ticket) catch unreachable;
}
pub export fn zc_apng_encode_async(cfg: *const c.zc_apng_config, source: ?[*]const c.zc_apng_frame, count: u32, poster: ?*const c.zc_apng_raster, file: ?*c.zc_image_file, out: *?*c.zc_apng_job) c_int {
    out.* = null;
    return submit(A, cfg, source orelse return c.ZC_INVALID, count, poster, file, out);
}
fn submit(allocator: std.mem.Allocator, cfg: *const c.zc_apng_config, source: [*]const c.zc_apng_frame, count: u32, poster: ?*const c.zc_apng_raster, file: ?*c.zc_image_file, out: *?*c.zc_apng_job) c_int {
    out.* = null;
    if (cfg.struct_size != @sizeOf(c.zc_apng_config) or count == 0 or count > 256 or cfg.png_compression > 9 or cfg.png_filter > 5 or cfg.max_input_bytes == 0 or cfg.max_input_bytes > cap or cfg.max_output_bytes == 0 or cfg.max_output_bytes > cap) return c.ZC_INVALID;
    var descriptors: [256]codec.Frame = undefined;
    var input: usize = 0;
    for (source[0..count], descriptors[0..count]) |value, *frame| {
        if (value.delay_num > 65535 or value.delay_den > 65535 or value.dispose > 2 or value.blend > 1) return c.ZC_INVALID;
        const view = raster(&value.raster) catch |err| return status(err);
        frame.* = .{ .view = view, .x = value.x, .y = value.y, .delay = .{ .numerator = @intCast(value.delay_num), .denominator = @intCast(value.delay_den) }, .dispose = @enumFromInt(value.dispose), .blend = @enumFromInt(value.blend) };
        input = std.math.add(usize, input, compactSize(view) catch return c.ZC_INVALID) catch return c.ZC_INVALID;
    }
    const default_image = if (poster) |p| raster(p) catch |err| return status(err) else null;
    if (default_image) |p| input = std.math.add(usize, input, compactSize(p) catch return c.ZC_INVALID) catch return c.ZC_INVALID;
    const animation = codec.Animation{ .width = cfg.width, .height = cfg.height, .frames = descriptors[0..count], .default_image = default_image, .plays = cfg.plays, .options = .{ .compression = cfg.png_compression, .filter = @enumFromInt(cfg.png_filter) } };
    animation.validate() catch |err| return status(err);
    if (input > cfg.max_input_bytes) return c.ZC_INVALID;
    const charge = input + @as(usize, @intCast(cfg.max_output_bytes)) + @sizeOf(Job) + count * @sizeOf(codec.Frame);
    registry_mutex.lock();
    const ticket = registry.reserve(charge) catch |err| {
        registry_mutex.unlock();
        return status(err);
    };
    registry_mutex.unlock();
    return create(allocator, cfg, animation, input, file, ticket, out);
}
fn create(allocator: std.mem.Allocator, cfg: *const c.zc_apng_config, animation: codec.Animation, input: usize, file: ?*c.zc_image_file, ticket: Admission.Ticket, out: *?*c.zc_apng_job) c_int {
    var success = false;
    defer if (!success) release(ticket);
    const self = allocator.create(Job) catch return c.ZC_NOMEM;
    defer if (!success) allocator.destroy(self);
    const data = allocator.alloc(u8, input) catch return c.ZC_NOMEM;
    defer if (!success) allocator.free(data);
    const frames = allocator.dupe(codec.Frame, animation.frames) catch return c.ZC_NOMEM;
    defer if (!success) allocator.free(frames);
    const blob = allocator.create(Blob) catch return c.ZC_NOMEM;
    defer if (!success) allocator.destroy(blob);
    blob.* = .{ .bytes = &.{} };
    var offset: usize = 0;
    for (frames) |*frame| frame.view = copy(frame.view, data, &offset);
    var owned = animation;
    owned.frames = frames;
    if (animation.default_image) |p| owned.default_image = copy(p, data, &offset);
    self.* = .{ .allocator = allocator, .ticket = ticket, .data = data, .frames = frames, .animation = owned, .file = file, .blob = blob, .limit = @intCast(cfg.max_output_bytes) };
    if (file) |f| {
        const rc = files.begin(f);
        if (rc != 0) return rc;
    }
    self.thread = std.Thread.spawn(.{}, Job.run, .{self}) catch {
        if (file) |f| _ = files.prepared(f, c.ZC_NOMEM);
        return c.ZC_NOMEM;
    };
    out.* = @ptrCast(self);
    success = true;
    return c.ZC_OK;
}
pub export fn zc_apng_job_state_get(p: *c.zc_apng_job, out: *c.zc_apng_job_state) c_int {
    const self = job(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    out.* = .{ .struct_size = @sizeOf(c.zc_apng_job_state), .phase = @intFromEnum(self.gate.phase), .finished = @intFromBool(self.finished), .result = if (!self.finished) c.ZC_TIMEOUT else if (self.gate.phase == .cancelled) c.ZC_CANCELLED else self.code, .input_bytes = self.data.len, .output_bytes = self.written.load(.monotonic) };
    return c.ZC_OK;
}
pub export fn zc_apng_job_cancel(p: *c.zc_apng_job) c_int {
    const self = job(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (self.gate.cancel_requested or self.gate.phase == .cancelled or self.gate.phase == .published or self.gate.phase == .failed) return 0;
    // File publication has its own owner/gate. Win that cancellation decision
    // before accepting job cancellation, including after encoding is ready.
    if (self.file) |file| {
        if (!files.cancelled(file) and files.zc_image_file_cancel(file) != 1) return 0;
    }
    if (!self.gate.cancel()) return 0;
    if (self.finished) _ = self.gate.cleaned();
    return 1;
}
pub export fn zc_apng_job_take_blob(p: *c.zc_apng_job, out: *?*c.zc_image_blob) c_int {
    out.* = null;
    const self = job(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (!self.finished) return c.ZC_BUSY;
    if (self.code != 0) return self.code;
    if (self.gate.phase == .cancelled or self.gate.cancel_requested) return c.ZC_CANCELLED;
    if (self.file != null) return c.ZC_UNSUPPORTED;
    if (!self.gate.publish()) return c.ZC_STATE;
    out.* = @ptrCast(self.blob.?);
    self.blob = null;
    return c.ZC_OK;
}
pub export fn zc_apng_job_close(p: ?*c.zc_apng_job) c_int {
    const self = job(p orelse return c.ZC_OK);
    self.mutex.lock();
    const finished = self.finished;
    self.mutex.unlock();
    if (!finished) return c.ZC_BUSY;
    if (self.thread) |thread| thread.join();
    const allocator = self.allocator;
    if (self.blob) |blob| {
        allocator.free(blob.bytes);
        allocator.destroy(blob);
    }
    allocator.free(self.frames);
    allocator.free(self.data);
    release(self.ticket);
    allocator.destroy(self);
    return c.ZC_OK;
}

fn testConfig() c.zc_apng_config {
    var cfg: c.zc_apng_config = undefined;
    zc_default_apng_config(&cfg);
    cfg.width = 2;
    cfg.height = 2;
    cfg.max_input_bytes = 1024;
    cfg.max_output_bytes = 4096;
    return cfg;
}
fn testFrame(data: []const u8) c.zc_apng_frame {
    return .{ .raster = .{ .struct_size = @sizeOf(c.zc_apng_raster), .width = 2, .height = 2, .format = c.ZC_APNG_RGB, .bits = 8, .big_endian = 0, .stride = 8, .length = data.len, .data = data.ptr }, .x = 0, .y = 0, .delay_num = 1, .delay_den = 25, .dispose = 0, .blend = 0 };
}
fn testWait(p: *c.zc_apng_job) !c.zc_apng_job_state {
    var timer = try std.time.Timer.start();
    while (timer.read() < 10 * std.time.ns_per_s) {
        var state: c.zc_apng_job_state = undefined;
        _ = zc_apng_job_state_get(p, &state);
        if (state.finished != 0) return state;
        std.Thread.sleep(100 * std.time.ns_per_us);
    }
    return error.Timeout;
}
fn testClose(p: *c.zc_apng_job) void {
    _ = zc_apng_job_cancel(p);
    _ = testWait(p) catch return;
    std.debug.assert(zc_apng_job_close(p) == c.ZC_OK);
}
test "APNG native submission preflights all frame spans rectangles limits and late controls" {
    const t = std.testing;
    var cfg = testConfig();
    const source = [_]u8{ 1, 2, 3, 4, 5, 6, 99, 99, 7, 8, 9, 10, 11, 12 };
    var frames = [_]c.zc_apng_frame{ testFrame(&source), testFrame(&source) };
    var out: ?*c.zc_apng_job = null;
    frames[1].raster.length = 13;
    try t.expectEqual(c.ZC_INVALID, submit(t.failing_allocator, &cfg, &frames, 2, null, null, &out));
    try t.expect(out == null);
    frames[1] = frames[0];
    frames[1].x = 1;
    try t.expectEqual(c.ZC_INVALID, submit(t.failing_allocator, &cfg, &frames, 2, null, null, &out));
    frames[1] = frames[0];
    frames[1].dispose = 3;
    try t.expectEqual(c.ZC_INVALID, submit(t.failing_allocator, &cfg, &frames, 2, null, null, &out));
    frames[1] = frames[0];
    cfg.max_input_bytes = 23;
    try t.expectEqual(c.ZC_INVALID, submit(t.failing_allocator, &cfg, &frames, 2, null, null, &out));
    cfg = testConfig();
    cfg.png_filter = 6;
    try t.expectEqual(c.ZC_INVALID, submit(t.failing_allocator, &cfg, &frames, 2, null, null, &out));
}
test "APNG native jobs compact-copy rows and ready cancellation cannot publish a blob" {
    const t = std.testing;
    var bytes = [_]u8{ 1, 2, 3, 4, 5, 6, 99, 99, 7, 8, 9, 10, 11, 12 };
    const cfg = testConfig();
    const frame = testFrame(&bytes);
    var out: ?*c.zc_apng_job = null;
    try t.expectEqual(c.ZC_OK, zc_apng_encode_async(&cfg, @ptrCast(&frame), 1, null, null, &out));
    defer testClose(out.?);
    @memset(&bytes, 0xee);
    try t.expectEqualSlices(u8, &.{ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 }, job(out.?).data);
    try t.expectEqual(c.ZC_OK, (try testWait(out.?)).result);
    try t.expectEqual(@as(c_int, 1), zc_apng_job_cancel(out.?));
    var blob: ?*c.zc_image_blob = null;
    try t.expectEqual(c.ZC_CANCELLED, zc_apng_job_take_blob(out.?, &blob));
    try t.expect(blob == null);
    try t.expectEqual(c.ZC_CANCELLED, (try testWait(out.?)).result);
}
test "APNG completed native jobs retain count admission until joined close" {
    const t = std.testing;
    const cfg = testConfig();
    const bytes = [_]u8{ 1, 2, 3, 4, 5, 6, 99, 99, 7, 8, 9, 10, 11, 12 };
    const frame = testFrame(&bytes);
    var jobs: [4]?*c.zc_apng_job = @splat(null);
    defer for (jobs) |p| if (p) |owned| testClose(owned);
    for (&jobs) |*out| {
        try t.expectEqual(c.ZC_OK, zc_apng_encode_async(&cfg, @ptrCast(&frame), 1, null, null, out));
        _ = try testWait(out.*.?);
    }
    var rejected: ?*c.zc_apng_job = null;
    try t.expectEqual(c.ZC_BUSY, zc_apng_encode_async(&cfg, @ptrCast(&frame), 1, null, null, &rejected));
    try t.expect(rejected == null);
}
fn allocationCase(allocator: std.mem.Allocator) !void {
    const cfg = testConfig();
    const bytes = [_]u8{ 1, 2, 3, 4, 5, 6, 99, 99, 7, 8, 9, 10, 11, 12 };
    const frame = testFrame(&bytes);
    var out: ?*c.zc_apng_job = null;
    const rc = submit(allocator, &cfg, @ptrCast(&frame), 1, null, null, &out);
    if (rc == c.ZC_NOMEM) return error.OutOfMemory;
    if (rc != 0) return error.SubmissionFailed;
    defer testClose(out.?);
    const result = (try testWait(out.?)).result;
    if (result == c.ZC_NOMEM) return error.OutOfMemory;
    if (result != 0) return error.EncodingFailed;
}
test "APNG native owner and worker allocation failures release admission and copied payloads" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationCase, .{});
}
test "APNG output payload caps fail without exposing partial encoded ownership" {
    const t = std.testing;
    var cfg = testConfig();
    cfg.max_output_bytes = 16;
    const bytes = [_]u8{ 1, 2, 3, 4, 5, 6, 99, 99, 7, 8, 9, 10, 11, 12 };
    const frame = testFrame(&bytes);
    var out: ?*c.zc_apng_job = null;
    try t.expectEqual(c.ZC_OK, zc_apng_encode_async(&cfg, @ptrCast(&frame), 1, null, null, &out));
    defer testClose(out.?);
    try t.expectEqual(c.ZC_INVALID, (try testWait(out.?)).result);
    var blob: ?*c.zc_image_blob = null;
    try t.expectEqual(c.ZC_INVALID, zc_apng_job_take_blob(out.?, &blob));
    try t.expect(blob == null);
}

fn testFileClose(file: *c.zc_image_file) void {
    _ = files.zc_image_file_finish(file, 0);
    var timer = std.time.Timer.start() catch return;
    while (timer.read() < 10 * std.time.ns_per_s) {
        var state: c.zc_image_file_state = undefined;
        _ = files.zc_image_file_state_get(file, &state);
        if (state.finished != 0) {
            std.debug.assert(files.zc_image_file_close(file) == c.ZC_OK);
            return;
        }
        std.Thread.sleep(100 * std.time.ns_per_us);
    }
}
test "APNG native ready-file cancellation prevents publication and published files reject late cancellation" {
    const t = std.testing;
    var tmp = t.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(.{ .sub_path = "image", .data = "old" });
    const parent = try tmp.dir.realpathAlloc(t.allocator, ".");
    defer t.allocator.free(parent);
    const path = try std.fmt.allocPrintSentinel(t.allocator, "{s}/image", .{parent}, 0);
    defer t.allocator.free(path);
    const bytes = [_]u8{ 1, 2, 3, 4, 5, 6, 99, 99, 7, 8, 9, 10, 11, 12 };
    const frame = testFrame(&bytes);
    const cfg = testConfig();
    for ([_]bool{ true, false }) |cancel| {
        var file: ?*c.zc_image_file = null;
        try t.expectEqual(c.ZC_OK, files.zc_image_file_create(path, &file));
        defer testFileClose(file.?);
        var out: ?*c.zc_apng_job = null;
        try t.expectEqual(c.ZC_OK, zc_apng_encode_async(&cfg, @ptrCast(&frame), 1, null, file, &out));
        defer testClose(out.?);
        try t.expectEqual(c.ZC_OK, (try testWait(out.?)).result);
        if (cancel) {
            try t.expectEqual(@as(c_int, 1), zc_apng_job_cancel(out.?));
            try t.expectEqual(c.ZC_STATE, files.zc_image_file_finish(file.?, 1));
            const old = try tmp.dir.readFileAlloc(t.allocator, "image", 100);
            defer t.allocator.free(old);
            try t.expectEqualStrings("old", old);
        } else {
            try t.expectEqual(c.ZC_OK, files.zc_image_file_finish(file.?, 1));
            try t.expectEqual(@as(c_int, 0), zc_apng_job_cancel(out.?));
            try t.expectEqual(c.ZC_OK, (try testWait(out.?)).result);
        }
    }
}
