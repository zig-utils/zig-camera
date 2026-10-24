//! Bounded copied-input Home JPEG workers and transferable decoded ownership.
const std = @import("std");
const c = @import("abi.zig").c;
pub const Decoder = @import("home/jpeg_decoder.zig");
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
        error.UnsupportedCoding, error.UnsupportedPrecision, error.UnsupportedColor => c.ZC_UNSUPPORTED,
        else => c.ZC_INVALID,
    };
}
fn ownerOf(p: *c.zc_jpeg_image) *Owner {
    return @ptrCast(@alignCast(p));
}
fn jobOf(p: *c.zc_jpeg_job) *Job {
    return @ptrCast(@alignCast(p));
}
pub export fn zc_default_jpeg_limits(out: *c.zc_jpeg_limits) void {
    out.* = .{ .struct_size = @sizeOf(c.zc_jpeg_limits), .max_scans = 256, .max_markers = 16384, .upsampling = 0, .max_input_bytes = 64 * 1024 * 1024, .max_output_bytes = 64 * 1024 * 1024, .max_working_bytes = 128 * 1024 * 1024, .max_metadata_bytes = 16 * 1024 * 1024, .max_work_units = 1024 * 1024 * 1024 };
}
fn optionsFor(supplied: ?*const c.zc_jpeg_limits, length: u64) !Decoder.Options {
    var defaults: c.zc_jpeg_limits = undefined;
    zc_default_jpeg_limits(&defaults);
    const limits = supplied orelse &defaults;
    if (limits.struct_size != @sizeOf(c.zc_jpeg_limits) or limits.upsampling > 1 or limits.max_input_bytes > 256 * 1024 * 1024 or limits.max_output_bytes > 256 * 1024 * 1024 or limits.max_working_bytes > 448 * 1024 * 1024 or length > limits.max_input_bytes) return error.InvalidLimits;
    const result = Decoder.Options{ .upsampling = @enumFromInt(limits.upsampling), .limits = .{ .max_input_bytes = @intCast(limits.max_input_bytes), .max_output_bytes = @intCast(limits.max_output_bytes), .max_working_bytes = @intCast(limits.max_working_bytes), .max_metadata_bytes = std.math.cast(usize, limits.max_metadata_bytes) orelse return error.InvalidLimits, .max_work_units = limits.max_work_units, .max_scans = limits.max_scans, .max_markers = limits.max_markers } };
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
pub export fn zc_jpeg_decode(data: ?[*]const u8, length: u64, limits: ?*const c.zc_jpeg_limits, out: *?*c.zc_jpeg_image) c_int {
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
pub export fn zc_jpeg_decode_async(data: ?[*]const u8, length: u64, limits: ?*const c.zc_jpeg_limits, out: *?*c.zc_jpeg_job) c_int {
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
pub export fn zc_jpeg_info_get(p: *c.zc_jpeg_image, out: *c.zc_jpeg_info) c_int {
    const result = &ownerOf(p).result.?;
    out.* = std.mem.zeroes(c.zc_jpeg_info);
    out.struct_size = @sizeOf(c.zc_jpeg_info);
    out.width = result.width;
    out.height = result.height;
    out.components = result.components;
    out.progressive = @intFromBool(result.progressive);
    out.scans = result.scans;
    out.color_model = @intFromEnum(result.color_model);
    out.upsampling = @intFromEnum(result.upsampling);
    for (result.sampling, 0..) |value, i| out.sampling[i] = value;
    out.metadata_flags = @as(u32, @intFromBool(result.icc != null)) | @as(u32, @intFromBool(result.exif != null)) << 1;
    out.adobe_transform = result.adobe_transform orelse std.math.maxInt(u32);
    out.stride = result.stride();
    out.length = result.pixels.len;
    out.working_peak = result.working_peak;
    out.work_units = result.work_units;
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
pub export fn zc_jpeg_pixels_copy(p: *c.zc_jpeg_image, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    return copy(ownerOf(p).result.?.pixels, data, capacity, length);
}
pub export fn zc_jpeg_metadata_copy(p: *c.zc_jpeg_image, kind: u32, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    length.* = 0;
    const result = &ownerOf(p).result.?;
    const bytes = switch (kind) {
        1 => result.icc orelse &.{},
        2 => result.exif orelse &.{},
        else => return c.ZC_INVALID,
    };
    return copy(bytes, data, capacity, length);
}
pub export fn zc_jpeg_close(p: ?*c.zc_jpeg_image) void {
    if (p) |value| ownerOf(value).destroy();
}
pub export fn zc_jpeg_job_state_get(p: *c.zc_jpeg_job, out: *c.zc_image_job_state) c_int {
    const self = jobOf(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    out.* = .{ .struct_size = @sizeOf(c.zc_image_job_state), .phase = @intFromEnum(self.gate.phase), .finished = @intFromBool(self.finished), .result = if (!self.finished) c.ZC_TIMEOUT else if (self.gate.phase == .cancelled) c.ZC_CANCELLED else self.code, .input_bytes = self.data.len, .output_bytes = if (self.finished) self.output_size else 0, .working_peak = if (self.finished) self.peak else 0, .budget_denials = if (self.finished) self.denials else 0 };
    return c.ZC_OK;
}
pub export fn zc_jpeg_job_cancel(p: *c.zc_jpeg_job) c_int {
    const self = jobOf(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (self.gate.cancel_requested or !self.gate.cancel()) return 0;
    if (self.finished) _ = self.gate.cleaned();
    return 1;
}
pub export fn zc_jpeg_job_take_image(p: *c.zc_jpeg_job, out: *?*c.zc_jpeg_image) c_int {
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
pub export fn zc_jpeg_job_close(p: ?*c.zc_jpeg_job) c_int {
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
fn testLimits() c.zc_jpeg_limits {
    var limits: c.zc_jpeg_limits = undefined;
    zc_default_jpeg_limits(&limits);
    limits.max_working_bytes = 1024 * 1024;
    return limits;
}
fn testEncoded() ![]u8 {
    var encoder = @import("home/jpeg_encoder.zig").Encoder.init(A);
    defer encoder.deinit();
    const pixels: [9 * 17][3]u8 = @splat(.{ 213, 74, 31 });
    _ = try encoder.encode(std.mem.asBytes(&pixels), 9, 17, 27, 3, 95);
    return encoder.output.toOwnedSlice(A);
}
fn testWait(p: *c.zc_jpeg_job) !c.zc_image_job_state {
    var timer = try std.time.Timer.start();
    while (timer.read() < 10 * std.time.ns_per_s) {
        var state: c.zc_image_job_state = undefined;
        _ = zc_jpeg_job_state_get(p, &state);
        if (state.finished != 0) return state;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    return error.TestTimeout;
}
fn testCleanup(p: ?*c.zc_jpeg_job) void {
    if (p) |job| {
        _ = zc_jpeg_job_cancel(job);
        _ = testWait(job) catch unreachable;
        std.debug.assert(zc_jpeg_job_close(job) == c.ZC_OK);
    }
}
test "JPEG workers copy encoded source and transfer native result before job retirement" {
    const t = std.testing;
    const encoded = try testEncoded();
    defer A.free(encoded);
    var job: ?*c.zc_jpeg_job = null;
    try t.expectEqual(c.ZC_OK, zc_jpeg_decode_async(encoded.ptr, encoded.len, &testLimits(), &job));
    defer testCleanup(job);
    @memset(encoded, 0);
    try t.expectEqual(c.ZC_OK, (try testWait(job.?)).result);
    var image: ?*c.zc_jpeg_image = null;
    try t.expectEqual(c.ZC_OK, zc_jpeg_job_take_image(job.?, &image));
    defer zc_jpeg_close(image);
    var rejected: ?*c.zc_jpeg_image = @ptrFromInt(1);
    try t.expectEqual(c.ZC_STATE, zc_jpeg_job_take_image(job.?, &rejected));
    try t.expect(rejected == null);
    try t.expectEqual(@as(c_int, 0), zc_jpeg_job_cancel(job.?));
    try t.expectEqual(c.ZC_OK, zc_jpeg_job_close(job.?));
    job = null;
    var info: c.zc_jpeg_info = undefined;
    try t.expectEqual(c.ZC_OK, zc_jpeg_info_get(image.?, &info));
    try t.expectEqual(@as(u32, 9), info.width);
    try t.expectEqual(@as(u32, 17), info.height);
    var bytes: [9 * 17 * 3]u8 = undefined;
    var length: u64 = 0;
    try t.expectEqual(c.ZC_OK, zc_jpeg_pixels_copy(image.?, &bytes, bytes.len, &length));
    try t.expectApproxEqAbs(@as(f64, 213), @as(f64, @floatFromInt(bytes[0])), 3);
}
test "JPEG native admission shares image budgets and holds copied job inputs after transfer" {
    const t = std.testing;
    const encoded = try testEncoded();
    defer A.free(encoded);
    var jobs: [4]?*c.zc_jpeg_job = @splat(null);
    defer for (jobs) |job| testCleanup(job);
    for (&jobs) |*job| {
        try t.expectEqual(c.ZC_OK, zc_jpeg_decode_async(encoded.ptr, encoded.len, &testLimits(), job));
        try t.expectEqual(c.ZC_OK, (try testWait(job.*.?)).result);
        var image: ?*c.zc_jpeg_image = null;
        try t.expectEqual(c.ZC_OK, zc_jpeg_job_take_image(job.*.?, &image));
        zc_jpeg_close(image);
    }
    var output: ?*c.zc_jpeg_image = @ptrFromInt(1);
    try t.expectEqual(c.ZC_BUSY, zc_jpeg_decode(encoded.ptr, encoded.len, &testLimits(), &output));
    try t.expect(output == null);
    const png = try @import("home/raster_encoder.zig").png(A, .{ .data = &.{ 1, 2, 3 }, .width = 1, .height = 1, .stride = 3, .format = .rgb }, .{});
    defer A.free(png);
    var png_image: ?*c.zc_png_image = @ptrFromInt(1);
    try t.expectEqual(c.ZC_BUSY, @import("png_image.zig").zc_png_decode(png.ptr, png.len, null, &png_image));
    try t.expect(png_image == null);
    try t.expectEqual(c.ZC_OK, zc_jpeg_job_close(jobs[0].?));
    jobs[0] = null;
    try t.expectEqual(c.ZC_OK, zc_jpeg_decode(encoded.ptr, encoded.len, &testLimits(), &output));
    zc_jpeg_close(output);
}
test "JPEG cancellation and malformed decode never publish partial output" {
    const t = std.testing;
    const encoded = try testEncoded();
    defer A.free(encoded);
    var job: ?*c.zc_jpeg_job = null;
    try t.expectEqual(c.ZC_OK, zc_jpeg_decode_async(encoded.ptr, encoded.len, &testLimits(), &job));
    defer testCleanup(job);
    _ = try testWait(job.?);
    try t.expectEqual(@as(c_int, 1), zc_jpeg_job_cancel(job.?));
    var image: ?*c.zc_jpeg_image = @ptrFromInt(1);
    try t.expectEqual(c.ZC_CANCELLED, zc_jpeg_job_take_image(job.?, &image));
    try t.expect(image == null);
    try t.expectEqual(c.ZC_OK, zc_jpeg_job_close(job.?));
    job = null;
    var limits = testLimits();
    limits.max_work_units = 10;
    try t.expectEqual(c.ZC_INVALID, zc_jpeg_decode(encoded.ptr, encoded.len, &limits, &image));
    try t.expect(image == null);
    try t.expectEqual(c.ZC_OK, zc_jpeg_decode_async(encoded.ptr, encoded.len - 1, &testLimits(), &job));
    try t.expectEqual(c.ZC_INVALID, (try testWait(job.?)).result);
    try t.expectEqual(c.ZC_INVALID, zc_jpeg_job_take_image(job.?, &image));
    try t.expect(image == null);
}
