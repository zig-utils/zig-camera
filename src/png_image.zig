//! Bounded copied-input PNG workers and transferable decoded ownership.
const std = @import("std");
const c = @import("abi.zig").c;
pub const Decoder = @import("home/png_decoder.zig");
const Budget = @import("home/budget_allocator.zig").Budget;
const Admission = @import("image_admission.zig");
const Gate = @import("home/preparation_gate.zig").Gate;
const A = std.heap.c_allocator;
const Owner = struct {
    ticket: Admission.Ticket,
    budget: Budget,
    result: ?Decoder.Result = null,
    refs: std.atomic.Value(u32) = std.atomic.Value(u32).init(1),
    fn retain(self: *Owner) void {
        const previous = self.refs.fetchAdd(1, .monotonic);
        std.debug.assert(previous == 1);
    }
    fn release(self: *Owner) void {
        const previous = self.refs.fetchSub(1, .acq_rel);
        std.debug.assert(previous > 0);
        if (previous == 1) {
            std.debug.assert(self.budget.live == 0);
            const ticket = self.ticket;
            A.destroy(self);
            Admission.release(ticket);
        }
    }
    fn destroy(self: *Owner) void {
        if (self.result) |*result| result.deinit();
        std.debug.assert(self.budget.live == 0);
        self.result = null;
        self.release();
    }
};
const Job = struct {
    mutex: std.Thread.Mutex = .{},
    gate: Gate = .{},
    finished: bool = false,
    code: c_int = c.ZC_TIMEOUT,
    thread: ?std.Thread = null,
    data: []u8,
    options: Decoder.Options,
    owner: ?*Owner,
    reservation: *Owner,
    output_size: usize = 0,
    peak: usize = 0,
    denials: usize = 0,
    fn checkpoint(context: ?*anyopaque) bool {
        const self: *Job = @ptrCast(@alignCast(context.?));
        self.mutex.lock();
        defer self.mutex.unlock();
        return !self.gate.cancel_requested and self.gate.phase != .cancelled;
    }
    fn run(self: *Job) void {
        self.mutex.lock();
        const claimed = self.gate.claim();
        self.mutex.unlock();
        const owner = self.owner.?;
        var code: c_int = c.ZC_CANCELLED;
        if (claimed) {
            self.options.checkpoint = .{ .context = self, .call = checkpoint };
            if (Decoder.decode(owner.budget.allocator(), self.data, self.options)) |result| {
                owner.result = result;
                self.output_size = result.ownedBytes();
                code = c.ZC_OK;
            } else |err| code = status(err);
        }
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.gate.cancel_requested or self.gate.phase == .cancelled) {
            if (code == c.ZC_OK or code == c.ZC_CANCELLED) {
                code = c.ZC_CANCELLED;
                _ = self.gate.cleaned();
            } else _ = self.gate.fail();
        } else if (code != c.ZC_OK) {
            _ = self.gate.fail();
        } else if (!self.gate.ready()) code = c.ZC_STATE;
        self.peak = owner.budget.peak;
        self.denials = owner.budget.denied;
        self.code = code;
        self.finished = true;
    }
};
fn status(err: anyerror) c_int {
    return switch (err) {
        error.OutOfMemory => c.ZC_NOMEM,
        error.Cancelled => c.ZC_CANCELLED,
        else => c.ZC_INVALID,
    };
}
fn ownerOf(p: *c.zc_png_image) *Owner {
    return @ptrCast(@alignCast(p));
}
fn jobOf(p: *c.zc_png_job) *Job {
    return @ptrCast(@alignCast(p));
}
pub export fn zc_default_png_limits(out: *c.zc_png_limits) void {
    out.* = .{ .struct_size = @sizeOf(c.zc_png_limits), .max_frames = 256, .max_chunks = 16384, .reserved = 0, .max_input_bytes = 64 * 1024 * 1024, .max_output_bytes = 64 * 1024 * 1024, .max_working_bytes = 128 * 1024 * 1024, .max_metadata_bytes = 16 * 1024 * 1024 };
}
fn optionsFor(supplied: ?*const c.zc_png_limits, length: u64) !Decoder.Options {
    var defaults: c.zc_png_limits = undefined;
    zc_default_png_limits(&defaults);
    const limits = supplied orelse &defaults;
    if (limits.struct_size != @sizeOf(c.zc_png_limits) or limits.reserved != 0 or limits.max_input_bytes > 256 * 1024 * 1024 or limits.max_output_bytes > 256 * 1024 * 1024 or limits.max_working_bytes > 256 * 1024 * 1024 or length > limits.max_input_bytes) return error.InvalidLimits;
    const result = Decoder.Options{ .expand_palette = true, .limits = .{ .max_input_bytes = @intCast(limits.max_input_bytes), .max_output_bytes = @intCast(limits.max_output_bytes), .max_working_bytes = @intCast(limits.max_working_bytes), .max_metadata_bytes = std.math.cast(usize, limits.max_metadata_bytes) orelse return error.InvalidLimits, .max_frames = limits.max_frames, .max_chunks = limits.max_chunks } };
    try result.limits.validate();
    return result;
}
fn create(options: Decoder.Options, input_size: usize) !*Owner {
    const charge = try std.math.add(usize, options.limits.max_working_bytes, input_size + @sizeOf(Owner) + @sizeOf(Job));
    const ticket = try Admission.reserve(charge);
    errdefer Admission.release(ticket);
    const owner = try A.create(Owner);
    owner.* = .{ .ticket = ticket, .budget = Budget.init(A, options.limits.max_working_bytes) };
    return owner;
}
fn admissionStatus(err: anyerror) c_int {
    return if (err == error.BufferFull) c.ZC_BUSY else status(err);
}
pub export fn zc_png_decode(data: ?[*]const u8, length: u64, limits: ?*const c.zc_png_limits, out: *?*c.zc_png_image) c_int {
    out.* = null;
    const options = optionsFor(limits, length) catch return c.ZC_INVALID;
    if (data == null) return c.ZC_INVALID;
    const owner = create(options, @intCast(length)) catch |err| return admissionStatus(err);
    var success = false;
    defer if (!success) owner.destroy();
    owner.result = Decoder.decode(owner.budget.allocator(), data.?[0..@intCast(length)], options) catch |err| return status(err);
    out.* = @ptrCast(owner);
    success = true;
    return c.ZC_OK;
}
pub export fn zc_png_decode_async(data: ?[*]const u8, length: u64, limits: ?*const c.zc_png_limits, out: *?*c.zc_png_job) c_int {
    out.* = null;
    const options = optionsFor(limits, length) catch return c.ZC_INVALID;
    if (data == null) return c.ZC_INVALID;
    const owner = create(options, @intCast(length)) catch |err| return admissionStatus(err);
    var success = false;
    defer if (!success) owner.destroy();
    const self = A.create(Job) catch return c.ZC_NOMEM;
    defer if (!success) A.destroy(self);
    const copied = A.dupe(u8, data.?[0..@intCast(length)]) catch return c.ZC_NOMEM;
    defer if (!success) A.free(copied);
    self.* = .{ .data = copied, .options = options, .owner = owner, .reservation = owner };
    // The result and job storage each retain the admission reservation.
    owner.retain();
    defer if (!success) owner.release();
    self.thread = std.Thread.spawn(.{}, Job.run, .{self}) catch return c.ZC_NOMEM;
    out.* = @ptrCast(self);
    success = true;
    return c.ZC_OK;
}
pub export fn zc_png_info_get(p: *c.zc_png_image, out: *c.zc_png_info) c_int {
    const result = &ownerOf(p).result.?;
    const m = result.metadata;
    out.* = std.mem.zeroes(c.zc_png_info);
    out.struct_size = @sizeOf(c.zc_png_info);
    out.frame_count = @intCast(result.frames.len);
    out.default_is_frame = @intFromBool(result.default_is_frame);
    out.plays = result.plays;
    out.source_depth = result.source_depth;
    out.source_color = result.source_color;
    out.interlaced = @intFromBool(result.interlaced);
    out.palette_count = result.palette_count;
    out.metadata_flags = @as(u32, @intFromBool(m.icc != null)) | @as(u32, @intFromBool(m.exif != null)) << 1 | @as(u32, @intFromBool(m.srgb != null)) << 2 | @as(u32, @intFromBool(m.gamma != null)) << 3 | @as(u32, @intFromBool(m.chromaticities != null)) << 4 | @as(u32, @intFromBool(m.cicp != null)) << 5;
    out.srgb = m.srgb orelse 0;
    out.gamma = m.gamma orelse 0;
    out.chromaticities = m.chromaticities orelse @splat(0);
    if (m.cicp) |values| for (values, 0..) |value, i| {
        out.cicp[i] = value;
    };
    return c.ZC_OK;
}
fn frameOf(result: *const Decoder.Result, slot: u32) ?Decoder.Frame {
    if (slot == 0) return .{ .raster = result.default_image, .control = .{ .width = result.default_image.width, .height = result.default_image.height } };
    if (slot > result.frames.len) return null;
    return result.frames[slot - 1];
}
pub export fn zc_png_frame_get(p: *c.zc_png_image, slot: u32, out: *c.zc_png_frame_info) c_int {
    out.* = std.mem.zeroes(c.zc_png_frame_info);
    const frame = frameOf(&ownerOf(p).result.?, slot) orelse return c.ZC_INVALID;
    const raster = frame.raster;
    const control = frame.control;
    out.* = .{ .struct_size = @sizeOf(c.zc_png_frame_info), .width = raster.width, .height = raster.height, .format = @intFromEnum(raster.format), .bits = raster.bits, .x = control.x, .y = control.y, .delay_num = control.delay_num, .delay_den = control.delay_den, .dispose = control.dispose, .blend = control.blend, .reserved = 0, .stride = raster.stride, .length = raster.pixels.len };
    return c.ZC_OK;
}
fn copy(bytes: []const u8, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    length.* = bytes.len;
    if (data) |dest| {
        if (capacity < bytes.len) return c.ZC_INVALID;
        @memcpy(dest[0..bytes.len], bytes);
    }
    return c.ZC_OK;
}
pub export fn zc_png_frame_copy(p: *c.zc_png_image, slot: u32, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    length.* = 0;
    const frame = frameOf(&ownerOf(p).result.?, slot) orelse return c.ZC_INVALID;
    return copy(frame.raster.pixels, data, capacity, length);
}
pub export fn zc_png_metadata_copy(p: *c.zc_png_image, kind: u32, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    length.* = 0;
    const result = &ownerOf(p).result.?;
    const bytes: []const u8 = switch (kind) {
        1 => result.metadata.icc orelse &.{},
        2 => result.metadata.exif orelse &.{},
        3 => result.palette[0 .. @as(usize, result.palette_count) * 4],
        else => return c.ZC_INVALID,
    };
    return copy(bytes, data, capacity, length);
}
pub export fn zc_png_close(p: ?*c.zc_png_image) void {
    if (p) |value| ownerOf(value).destroy();
}
pub export fn zc_png_job_state_get(p: *c.zc_png_job, out: *c.zc_image_job_state) c_int {
    const self = jobOf(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    out.* = .{ .struct_size = @sizeOf(c.zc_image_job_state), .phase = @intFromEnum(self.gate.phase), .finished = @intFromBool(self.finished), .result = if (!self.finished) c.ZC_TIMEOUT else if (self.gate.phase == .cancelled) c.ZC_CANCELLED else self.code, .input_bytes = self.data.len, .output_bytes = if (self.finished) self.output_size else 0, .working_peak = if (self.finished) self.peak else 0, .budget_denials = if (self.finished) self.denials else 0 };
    return c.ZC_OK;
}
pub export fn zc_png_job_cancel(p: *c.zc_png_job) c_int {
    const self = jobOf(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (self.gate.cancel_requested or !self.gate.cancel()) return 0;
    if (self.finished) _ = self.gate.cleaned();
    return 1;
}
pub export fn zc_png_job_take_image(p: *c.zc_png_job, out: *?*c.zc_png_image) c_int {
    out.* = null;
    const self = jobOf(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (!self.finished) return c.ZC_BUSY;
    if (self.gate.cancel_requested or self.gate.phase == .cancelled) return c.ZC_CANCELLED;
    if (self.code != c.ZC_OK) return self.code;
    if (!self.gate.publish()) return c.ZC_STATE;
    out.* = @ptrCast(self.owner.?);
    self.owner = null;
    return c.ZC_OK;
}
pub export fn zc_png_job_close(p: ?*c.zc_png_job) c_int {
    const self = jobOf(p orelse return c.ZC_OK);
    self.mutex.lock();
    const finished = self.finished;
    self.mutex.unlock();
    if (!finished) return c.ZC_BUSY;
    if (self.thread) |thread| thread.join();
    A.free(self.data);
    if (self.owner) |owner| owner.destroy();
    const reservation = self.reservation;
    A.destroy(self);
    reservation.release();
    return c.ZC_OK;
}

fn testLimits() c.zc_png_limits {
    var limits: c.zc_png_limits = undefined;
    zc_default_png_limits(&limits);
    limits.max_working_bytes = 1024 * 1024;
    return limits;
}
fn testEncoded() ![]u8 {
    return @import("home/raster_encoder.zig").png(A, .{ .data = &.{ 0x34, 0x12, 0x78, 0x56, 0xbc, 0x9a }, .width = 1, .height = 1, .stride = 6, .format = .rgb, .bits = 16 }, .{});
}
fn testWait(p: *c.zc_png_job) !c.zc_image_job_state {
    var timer = try std.time.Timer.start();
    while (timer.read() < 10 * std.time.ns_per_s) {
        var state: c.zc_image_job_state = undefined;
        _ = zc_png_job_state_get(p, &state);
        if (state.finished != 0) return state;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    return error.TestTimeout;
}
fn testCleanup(p: ?*c.zc_png_job) void {
    if (p) |value| {
        _ = zc_png_job_cancel(value);
        _ = testWait(value) catch unreachable;
        std.debug.assert(zc_png_job_close(value) == c.ZC_OK);
    }
}
test "PNG workers copy encoded inputs and transfer an owner beyond joined job close exactly once" {
    const t = std.testing;
    const encoded = try testEncoded();
    defer A.free(encoded);
    var job: ?*c.zc_png_job = null;
    try t.expectEqual(c.ZC_OK, zc_png_decode_async(encoded.ptr, encoded.len, &testLimits(), &job));
    defer testCleanup(job);
    @memset(encoded, 0xff);
    const state = try testWait(job.?);
    try t.expectEqual(c.ZC_OK, state.result);
    try t.expect(state.working_peak > 6 and state.working_peak <= testLimits().max_working_bytes);
    var image: ?*c.zc_png_image = null;
    try t.expectEqual(c.ZC_OK, zc_png_job_take_image(job.?, &image));
    defer zc_png_close(image);
    var again: ?*c.zc_png_image = @ptrFromInt(1);
    try t.expectEqual(c.ZC_STATE, zc_png_job_take_image(job.?, &again));
    try t.expect(again == null);
    try t.expectEqual(@as(c_int, 0), zc_png_job_cancel(job.?));
    try t.expectEqual(c.ZC_OK, zc_png_job_close(job));
    job = null;
    var info: c.zc_png_frame_info = undefined;
    try t.expectEqual(c.ZC_OK, zc_png_frame_get(image.?, 0, &info));
    try t.expectEqual(@as(u32, 16), info.bits);
    var bytes: [6]u8 = undefined;
    var length: u64 = 0;
    try t.expectEqual(c.ZC_OK, zc_png_frame_copy(image.?, 0, &bytes, bytes.len, &length));
    try t.expectEqualSlices(u8, &.{ 0x34, 0x12, 0x78, 0x56, 0xbc, 0x9a }, &bytes);
    @memset(&bytes, 0x77);
    try t.expectEqual(c.ZC_INVALID, zc_png_frame_copy(image.?, 0, &bytes, 5, &length));
    try t.expectEqualSlices(u8, &(@as([6]u8, @splat(0x77))), &bytes);
    try t.expectEqual(c.ZC_INVALID, zc_png_frame_get(image.?, 1, &info));
}
test "PNG owners and encoding share admission and taken owners retain tickets after job closure" {
    const t = std.testing;
    const encoded = try testEncoded();
    defer A.free(encoded);
    var images: [4]?*c.zc_png_image = @splat(null);
    defer for (images) |image| zc_png_close(image);
    for (&images) |*image| {
        var job: ?*c.zc_png_job = null;
        try t.expectEqual(c.ZC_OK, zc_png_decode_async(encoded.ptr, encoded.len, &testLimits(), &job));
        defer testCleanup(job);
        try t.expectEqual(c.ZC_OK, (try testWait(job.?)).result);
        try t.expectEqual(c.ZC_OK, zc_png_job_take_image(job.?, image));
    }
    var rejected: ?*c.zc_png_image = @ptrFromInt(1);
    try t.expectEqual(c.ZC_BUSY, zc_png_decode(encoded.ptr, encoded.len, &testLimits(), &rejected));
    try t.expect(rejected == null);
    var raster_job: ?*c.zc_image_job = @ptrFromInt(1);
    const source = @import("home/pixel_view.zig").View{ .data = &.{ 11, 22, 33 }, .width = 1, .height = 1, .stride = 3, .format = .rgb };
    const opts = c.zc_image_options{ .struct_size = @sizeOf(c.zc_image_options), .format = c.ZC_IMAGE_PNG, .quality = 90, .png_compression = 1, .png_filter = 0 };
    try t.expectEqual(c.ZC_BUSY, @import("image_job.zig").submitRaster(source, &opts, null, null, null, null, &raster_job));
    try t.expect(raster_job == null);
    zc_png_close(images[0]);
    images[0] = null;
    try t.expectEqual(c.ZC_OK, zc_png_decode(encoded.ptr, encoded.len, &testLimits(), &images[0]));
}
test "PNG cancelled ready and active workers publish no owner and validation retains no admission" {
    const t = std.testing;
    const encoded = try testEncoded();
    defer A.free(encoded);
    for (0..12) |iteration| {
        var job: ?*c.zc_png_job = null;
        try t.expectEqual(c.ZC_OK, zc_png_decode_async(encoded.ptr, encoded.len, &testLimits(), &job));
        defer testCleanup(job);
        if (iteration % 2 == 0) _ = try testWait(job.?);
        try t.expectEqual(@as(c_int, 1), zc_png_job_cancel(job.?));
        try t.expectEqual(@as(c_int, 0), zc_png_job_cancel(job.?));
        try t.expectEqual(c.ZC_CANCELLED, (try testWait(job.?)).result);
        var image: ?*c.zc_png_image = @ptrFromInt(1);
        try t.expectEqual(c.ZC_CANCELLED, zc_png_job_take_image(job.?, &image));
        try t.expect(image == null);
    }
    for (0..5) |field| {
        var limits = testLimits();
        switch (field) {
            0 => limits.struct_size = 0,
            1 => limits.reserved = 1,
            2 => limits.max_input_bytes = encoded.len - 1,
            3 => limits.max_frames = 257,
            4 => limits.max_metadata_bytes = 0,
            else => unreachable,
        }
        var image: ?*c.zc_png_image = @ptrFromInt(1);
        try t.expectEqual(c.ZC_INVALID, zc_png_decode(encoded.ptr, encoded.len, &limits, &image));
        try t.expect(image == null);
    }
    var limits = testLimits();
    limits.max_output_bytes = 5;
    var image: ?*c.zc_png_image = @ptrFromInt(1);
    try t.expectEqual(c.ZC_INVALID, zc_png_decode(encoded.ptr, encoded.len, &limits, &image));
    try t.expect(image == null);
    limits = testLimits();
    limits.max_working_bytes = 1;
    try t.expectEqual(c.ZC_INVALID, zc_png_decode(encoded.ptr, encoded.len, &limits, &image));
    try t.expect(image == null);
    try t.expectEqual(c.ZC_OK, zc_png_decode(encoded.ptr, encoded.len, &testLimits(), &image));
    zc_png_close(image);
}

test "PNG image-first and concurrent close keep admission through both storage owners" {
    const t = std.testing;
    const encoded = try testEncoded();
    defer A.free(encoded);
    var jobs: [4]?*c.zc_png_job = @splat(null);
    defer for (jobs) |p| testCleanup(p);
    for (&jobs) |*p| {
        try t.expectEqual(c.ZC_OK, zc_png_decode_async(encoded.ptr, encoded.len, &testLimits(), p));
        try t.expectEqual(c.ZC_OK, (try testWait(p.*.?)).result);
        var image: ?*c.zc_png_image = null;
        try t.expectEqual(c.ZC_OK, zc_png_job_take_image(p.*.?, &image));
        zc_png_close(image);
    }
    var blocked: ?*c.zc_png_image = @ptrFromInt(1);
    try t.expectEqual(c.ZC_BUSY, zc_png_decode(encoded.ptr, encoded.len, &testLimits(), &blocked));
    try t.expect(blocked == null);
    for (&jobs) |*p| {
        try t.expectEqual(c.ZC_OK, zc_png_job_close(p.*));
        p.* = null;
    }
    const Closer = struct {
        fn close(p: *c.zc_png_image) void {
            zc_png_close(p);
        }
    };
    for (0..16) |_| {
        var p: ?*c.zc_png_job = null;
        try t.expectEqual(c.ZC_OK, zc_png_decode_async(encoded.ptr, encoded.len, &testLimits(), &p));
        defer testCleanup(p);
        try t.expectEqual(c.ZC_OK, (try testWait(p.?)).result);
        var image: ?*c.zc_png_image = null;
        try t.expectEqual(c.ZC_OK, zc_png_job_take_image(p.?, &image));
        const thread = std.Thread.spawn(.{}, Closer.close, .{image.?}) catch |err| {
            zc_png_close(image);
            return err;
        };
        try t.expectEqual(c.ZC_OK, zc_png_job_close(p));
        p = null;
        thread.join();
    }
    var available: ?*c.zc_png_image = null;
    try t.expectEqual(c.ZC_OK, zc_png_decode(encoded.ptr, encoded.len, &testLimits(), &available));
    zc_png_close(available);
}
