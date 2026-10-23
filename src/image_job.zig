//! Copied still inputs, bounded Home codec workspace and joined workers.
const std = @import("std");
const c = @import("abi.zig").c;
const still = @import("still.zig");
const rgb = @import("stream_rgb.zig");
const pixel = @import("home/pixel_view.zig");
const files = @import("image_file.zig");
const Gate = @import("home/preparation_gate.zig").Gate;
const Budget = @import("home/budget_allocator.zig").Budget;
const Admission = @import("home/owned_admission.zig").Registry(4);
const A = std.heap.c_allocator;
const cap = 256 * 1024 * 1024;
var registry: Admission = .{ .max_bytes = 512 * 1024 * 1024, .max_items = 4 };
var registry_mutex: std.Thread.Mutex = .{};
const Job = struct {
    mutex: std.Thread.Mutex = .{},
    gate: Gate = .{},
    finished: bool = false,
    code: c_int = c.ZC_TIMEOUT,
    thread: ?std.Thread = null,
    ticket: Admission.Ticket,
    data: []u8,
    frame: c.zc_frame,
    raster: ?pixel.View = null,
    color: c.zc_color_space,
    raw: c.zc_raw_metadata,
    scalar: c.zc_metadata,
    catalog: []const u8 = &.{},
    options: c.zc_image_options,
    profile: ?c.zc_image_profile = null,
    metadata: ?c.zc_image_exif = null,
    budget: Budget,
    output_limit: usize,
    output_size: usize = 0,
    blob: ?*still.Blob,
    file: ?*c.zc_image_file,
    fn checkpoint(self: *Job) bool {
        self.mutex.lock();
        const cancelled = self.gate.cancel_requested or self.gate.phase == .cancelled;
        self.mutex.unlock();
        return !cancelled and (self.file == null or !files.cancelled(self.file.?));
    }
    fn encodeBytes(self: *Job, a: std.mem.Allocator) ![]u8 {
        const metadata = if (self.metadata) |*value| value else null;
        const profile = if (self.profile) |*value| value else null;
        if (self.raster) |source| return still.encodeRasterMetadata(a, source, &self.options, profile, @import("exif.zig").bytes(metadata));
        const generated = try @import("remote_exif.zig").generate(a, self.scalar, self.raw, self.frame.main, self.catalog, metadata);
        defer if (generated) |bytes| a.free(bytes);
        var source = if (self.options.format == c.ZC_IMAGE_DNG) rgb.Selected{ .frame = self.frame } else try rgb.Selected.image(a, self.frame, self.frame.main, self.color, self.options.format);
        defer source.deinit(a);
        if (!self.checkpoint()) return error.Cancelled;
        return still.encodeMetadata(a, &source.frame, if (self.options.format == c.ZC_IMAGE_DNG) &self.raw else null, &self.options, profile, generated orelse @import("exif.zig").bytes(metadata));
    }
    fn encode(self: *Job) c_int {
        if (!self.checkpoint()) return c.ZC_CANCELLED;
        const a = self.budget.allocator();
        const encoded = self.encodeBytes(a) catch |err| return if (err == error.Cancelled) c.ZC_CANCELLED else still.status(err);
        var transferred = false;
        defer if (!transferred) a.free(encoded);
        if (encoded.len > self.output_limit) return c.ZC_INVALID;
        if (!self.checkpoint()) return c.ZC_CANCELLED;
        self.output_size = encoded.len;
        if (self.file) |file| return files.write(file, encoded);
        self.blob.?.bytes = encoded;
        transferred = true;
        return c.ZC_OK;
    }
    fn run(self: *Job) void {
        self.mutex.lock();
        const claimed = self.gate.claim();
        self.mutex.unlock();
        var code = if (claimed) self.encode() else c.ZC_CANCELLED;
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
};
fn job(p: *c.zc_image_job) *Job {
    return @ptrCast(@alignCast(p));
}
fn release(ticket: Admission.Ticket) void {
    registry_mutex.lock();
    defer registry_mutex.unlock();
    registry.release(ticket) catch unreachable;
}
pub export fn zc_default_image_job_limits(out: *c.zc_image_job_limits) void {
    out.* = .{ .struct_size = @sizeOf(c.zc_image_job_limits), .reserved = 0, .max_input_bytes = 64 * 1024 * 1024, .max_output_bytes = 64 * 1024 * 1024, .max_working_bytes = 128 * 1024 * 1024 };
}
fn copy(data: []u8, offset: *usize, source: []const u8) []u8 {
    const out = data[offset.*..][0..source.len];
    @memcpy(out, source);
    offset.* += source.len;
    return out;
}
pub fn submit(frame: c.zc_frame, color: c.zc_color_space, raw: c.zc_raw_metadata, scalar: c.zc_metadata, catalog: []const u8, options: *const c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif, supplied: ?*const c.zc_image_job_limits, file: ?*c.zc_image_file, out: *?*c.zc_image_job) c_int {
    return submitOwned(frame, null, color, raw, scalar, catalog, options, profile, metadata, supplied, file, out);
}
pub fn submitRaster(source: pixel.View, options: *const c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif, limits: ?*const c.zc_image_job_limits, file: ?*c.zc_image_file, out: *?*c.zc_image_job) c_int {
    return submitOwned(std.mem.zeroes(c.zc_frame), source, std.mem.zeroes(c.zc_color_space), std.mem.zeroes(c.zc_raw_metadata), std.mem.zeroes(c.zc_metadata), &.{}, options, profile, metadata, limits, file, out);
}
fn submitOwned(frame: c.zc_frame, raster: ?pixel.View, color: c.zc_color_space, raw: c.zc_raw_metadata, scalar: c.zc_metadata, catalog: []const u8, options: *const c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif, supplied: ?*const c.zc_image_job_limits, file: ?*c.zc_image_file, out: *?*c.zc_image_job) c_int {
    out.* = null;
    var defaults: c.zc_image_job_limits = undefined;
    zc_default_image_job_limits(&defaults);
    const limits = supplied orelse &defaults;
    if (limits.struct_size != @sizeOf(c.zc_image_job_limits) or limits.reserved != 0) return c.ZC_INVALID;
    inline for (.{ limits.max_input_bytes, limits.max_output_bytes, limits.max_working_bytes }) |limit| if (limit == 0 or limit > cap) return c.ZC_INVALID;
    const selected = if (options.format == c.ZC_IMAGE_DNG) frame.raw else frame.main;
    var size: usize = 0;
    var row_bytes: usize = 0;
    if (raster) |source| {
        row_bytes = source.validate() catch |err| return still.status(err);
        size = std.math.mul(usize, row_bytes, source.height) catch return c.ZC_INVALID;
    } else {
        if (selected.plane_count == 0 or selected.plane_count > c.ZC_MAX_PLANES) return c.ZC_INVALID;
        for (selected.planes[0..selected.plane_count]) |plane| {
            if (plane.data == null or plane.bytes_used > plane.length or plane.bytes_used > cap) return c.ZC_INVALID;
            size = std.math.add(usize, size, @intCast(plane.bytes_used)) catch return c.ZC_INVALID;
        }
    }
    const profile_bytes: []const u8 = if (profile != null and profile.?.data != null) profile.?.data[0..@intCast(profile.?.length)] else &.{};
    const exif_bytes = @import("exif.zig").bytes(metadata) orelse &.{};
    const capture = metadata != null and metadata.?.flags & c.ZC_IMAGE_EXIF_CAPTURE != 0;
    const catalog_bytes = if (capture) catalog else &.{};
    inline for (.{ profile_bytes, exif_bytes, catalog_bytes }) |bytes| size = std.math.add(usize, size, bytes.len) catch return c.ZC_INVALID;
    if (size > limits.max_input_bytes) return c.ZC_INVALID;
    const charge = size + @as(usize, @intCast(limits.max_working_bytes)) + @sizeOf(Job) + @sizeOf(still.Blob);
    registry_mutex.lock();
    const ticket = registry.reserve(charge) catch |err| {
        registry_mutex.unlock();
        return if (err == error.BufferFull) c.ZC_BUSY else c.ZC_INVALID;
    };
    registry_mutex.unlock();
    var success = false;
    defer if (!success) release(ticket);
    const self = A.create(Job) catch return c.ZC_NOMEM;
    defer if (!success) A.destroy(self);
    const data = A.alloc(u8, size) catch return c.ZC_NOMEM;
    defer if (!success) A.free(data);
    const blob = A.create(still.Blob) catch return c.ZC_NOMEM;
    defer if (!success) A.destroy(blob);
    blob.* = .{ .bytes = &.{} };
    self.* = .{ .ticket = ticket, .data = data, .frame = std.mem.zeroes(c.zc_frame), .color = color, .raw = raw, .scalar = scalar, .options = options.*, .budget = Budget.init(A, @intCast(limits.max_working_bytes)), .output_limit = @intCast(limits.max_output_bytes), .blob = blob, .file = file };
    self.frame.exposure_us = frame.exposure_us;
    self.frame.red_gain = frame.red_gain;
    self.frame.blue_gain = frame.blue_gain;
    const owned = if (options.format == c.ZC_IMAGE_DNG) &self.frame.raw else &self.frame.main;
    owned.* = selected;
    owned.planes = @splat(std.mem.zeroes(c.zc_plane));
    var offset: usize = 0;
    if (raster) |source| {
        self.raster = source;
        for (0..source.height) |y| _ = copy(data, &offset, source.row(y, row_bytes));
        self.raster.?.data = data[0..offset];
        self.raster.?.stride = row_bytes;
    } else {
        for (selected.planes[0..selected.plane_count], owned.planes[0..selected.plane_count]) |plane, *dest| {
            const bytes = copy(data, &offset, plane.data[0..@intCast(plane.bytes_used)]);
            dest.* = .{ .data = bytes.ptr, .length = bytes.len, .bytes_used = bytes.len, .fd = -1 };
        }
    }
    const icc = copy(data, &offset, profile_bytes);
    if (profile) |p| {
        self.profile = p.*;
        self.profile.?.data = if (icc.len == 0) null else icc.ptr;
    }
    const exif = copy(data, &offset, exif_bytes);
    if (metadata) |m| {
        self.metadata = m.*;
        self.metadata.?.data = if (exif.len == 0) null else exif.ptr;
    }
    self.catalog = copy(data, &offset, catalog_bytes);
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
pub export fn zc_image_job_state_get(p: *c.zc_image_job, out: *c.zc_image_job_state) c_int {
    const self = job(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    out.* = .{ .struct_size = @sizeOf(c.zc_image_job_state), .phase = @intFromEnum(self.gate.phase), .finished = @intFromBool(self.finished), .result = if (!self.finished) c.ZC_TIMEOUT else if (self.gate.phase == .cancelled) c.ZC_CANCELLED else self.code, .input_bytes = self.data.len, .output_bytes = if (self.finished) self.output_size else 0, .working_peak = if (self.finished) self.budget.peak else 0, .budget_denials = if (self.finished) self.budget.denied else 0 };
    return c.ZC_OK;
}
pub export fn zc_image_job_cancel(p: *c.zc_image_job) c_int {
    const self = job(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (self.gate.cancel_requested or self.gate.phase == .cancelled or self.gate.phase == .published or self.gate.phase == .failed) return 0;
    if (self.file) |file| if (!files.cancelled(file) and files.zc_image_file_cancel(file) != 1) return 0;
    if (!self.gate.cancel()) return 0;
    if (self.finished) _ = self.gate.cleaned();
    return 1;
}
pub export fn zc_image_job_take_blob(p: *c.zc_image_job, out: *?*c.zc_image_blob) c_int {
    out.* = null;
    const self = job(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (!self.finished) return c.ZC_BUSY;
    if (self.code != 0) return self.code;
    if (self.gate.phase == .cancelled or self.gate.cancel_requested) return c.ZC_CANCELLED;
    if (self.file != null) return c.ZC_UNSUPPORTED;
    if (!self.gate.publish()) return c.ZC_STATE;
    self.budget.disown(self.blob.?.bytes);
    out.* = @ptrCast(self.blob.?);
    self.blob = null;
    return c.ZC_OK;
}
pub export fn zc_image_job_close(p: ?*c.zc_image_job) c_int {
    const self = job(p orelse return c.ZC_OK);
    self.mutex.lock();
    const finished = self.finished;
    self.mutex.unlock();
    if (!finished) return c.ZC_BUSY;
    if (self.thread) |thread| thread.join();
    if (self.blob) |blob| {
        self.budget.allocator().free(blob.bytes);
        A.destroy(blob);
    }
    std.debug.assert(self.budget.live == 0);
    A.free(self.data);
    release(self.ticket);
    A.destroy(self);
    return c.ZC_OK;
}

test "raster jobs copy tight Home rows at native precision independently of source and padding" {
    const t = std.testing;
    for ([_]pixel.Format{ .gray, .rgb, .rgba }) |format| for ([_]u8{ 8, 16 }) |bits| for ([_]std.builtin.Endian{ .little, .big }) |endian| {
        var data: [96]u8 = undefined;
        for (&data, 0..) |*byte, i| byte.* = @truncate(i * 37);
        const row = try pixel.packedRow(2, format, bits);
        const source = pixel.View{ .data = &data, .width = 2, .height = 2, .stride = row + 7, .format = format, .bits = bits, .endian = endian };
        const expected = try still.encodeRasterMetadata(A, source, &testOptions(), null, null);
        defer A.free(expected);
        var limits = testLimits();
        limits.max_input_bytes = row * 2;
        var owner: ?*c.zc_image_job = null;
        try t.expectEqual(c.ZC_OK, submitRaster(source, &testOptions(), null, null, &limits, null, &owner));
        defer testCleanup(owner);
        @memset(&data, 99);
        const state = try testWait(owner.?);
        try t.expectEqual(c.ZC_OK, state.result);
        try t.expectEqual(@as(u64, row * 2), state.input_bytes);
        var blob: ?*c.zc_image_blob = null;
        try t.expectEqual(c.ZC_OK, zc_image_job_take_blob(owner.?, &blob));
        const result: *still.Blob = @ptrCast(@alignCast(blob.?));
        defer {
            A.free(result.bytes);
            A.destroy(result);
        }
        try t.expectEqualSlices(u8, expected, result.bytes);
        limits.max_input_bytes -= 1;
        var rejected: ?*c.zc_image_job = @ptrFromInt(1);
        try t.expectEqual(c.ZC_INVALID, submitRaster(source, &testOptions(), null, null, &limits, null, &rejected));
        try t.expect(rejected == null);
    };
}
fn testOptions() c.zc_image_options {
    return .{ .struct_size = @sizeOf(c.zc_image_options), .format = c.ZC_IMAGE_PNG, .quality = 98, .png_compression = 1, .png_filter = 0 };
}
fn testFrame(data: []u8) c.zc_frame {
    var frame = std.mem.zeroes(c.zc_frame);
    frame.main.width = 2;
    frame.main.height = 2;
    frame.main.stride = 8;
    frame.main.plane_count = 1;
    @memcpy(frame.main.format[0..6], "BGR888");
    frame.main.planes[0] = .{ .data = data.ptr, .length = data.len, .bytes_used = data.len, .fd = -1 };
    return frame;
}
fn testLimits() c.zc_image_job_limits {
    return .{ .struct_size = @sizeOf(c.zc_image_job_limits), .reserved = 0, .max_input_bytes = 4096, .max_output_bytes = 4096, .max_working_bytes = 1024 * 1024 };
}
fn testSubmit(frame: c.zc_frame, limits: *const c.zc_image_job_limits, out: *?*c.zc_image_job) c_int {
    return submit(frame, std.mem.zeroes(c.zc_color_space), std.mem.zeroes(c.zc_raw_metadata), std.mem.zeroes(c.zc_metadata), &.{}, &testOptions(), null, null, limits, null, out);
}
fn testWait(p: *c.zc_image_job) !c.zc_image_job_state {
    var timer = try std.time.Timer.start();
    while (timer.read() < 10 * std.time.ns_per_s) {
        var state: c.zc_image_job_state = undefined;
        _ = zc_image_job_state_get(p, &state);
        if (state.finished != 0) return state;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    return error.TestTimeout;
}
fn testCleanup(p: ?*c.zc_image_job) void {
    if (p) |handle| {
        _ = zc_image_job_cancel(handle);
        _ = testWait(handle) catch unreachable;
        std.debug.assert(zc_image_job_close(handle) == c.ZC_OK);
    }
}
test "image job copies input and owns bounded encoded bytes through a single result transfer" {
    const t = std.testing;
    var pixels: [16]u8 = @splat(73);
    const source = testFrame(&pixels);
    const expected = try still.encode(A, &source, null, &testOptions());
    defer A.free(expected);
    var out: ?*c.zc_image_job = null;
    try t.expectEqual(c.ZC_OK, testSubmit(source, &testLimits(), &out));
    defer testCleanup(out);
    @memset(&pixels, 99);
    const state = try testWait(out.?);
    try t.expectEqual(c.ZC_OK, state.result);
    try t.expectEqual(@as(u64, 16), state.input_bytes);
    try t.expect(state.working_peak <= testLimits().max_working_bytes);
    try t.expect(state.working_peak > state.output_bytes);
    var blob: ?*c.zc_image_blob = null;
    try t.expectEqual(c.ZC_OK, zc_image_job_take_blob(out.?, &blob));
    const owned: *still.Blob = @ptrCast(@alignCast(blob.?));
    defer {
        A.free(owned.bytes);
        A.destroy(owned);
    }
    try t.expectEqualSlices(u8, expected, owned.bytes);
    blob = @ptrFromInt(1);
    try t.expectEqual(c.ZC_STATE, zc_image_job_take_blob(out.?, &blob));
    try t.expect(blob == null);
    try t.expectEqual(@as(c_int, 0), zc_image_job_cancel(out.?));
}
test "image jobs charge completed owners until close and cancellation retires ready results" {
    const t = std.testing;
    var pixels: [16]u8 = @splat(42);
    var owners: [4]?*c.zc_image_job = @splat(null);
    defer for (owners) |owner| testCleanup(owner);
    for (&owners) |*owner| try t.expectEqual(c.ZC_OK, testSubmit(testFrame(&pixels), &testLimits(), owner));
    for (owners) |owner| try t.expectEqual(c.ZC_OK, (try testWait(owner.?)).result);
    var rejected: ?*c.zc_image_job = @ptrFromInt(1);
    try t.expectEqual(c.ZC_BUSY, testSubmit(testFrame(&pixels), &testLimits(), &rejected));
    try t.expect(rejected == null);
    try t.expectEqual(@as(c_int, 1), zc_image_job_cancel(owners[0].?));
    var blob: ?*c.zc_image_blob = null;
    try t.expectEqual(c.ZC_CANCELLED, zc_image_job_take_blob(owners[0].?, &blob));
    try t.expectEqual(c.ZC_OK, zc_image_job_close(owners[0]));
    owners[0] = null;
    try t.expectEqual(c.ZC_OK, testSubmit(testFrame(&pixels), &testLimits(), &owners[0]));
}
test "native PNG workspace budget and output ceiling reject with complete cleanup and no partial result" {
    const t = std.testing;
    var pixels: [16]u8 = @splat(42);
    var limits = testLimits();
    limits.max_working_bytes = 1024;
    var out: ?*c.zc_image_job = null;
    try t.expectEqual(c.ZC_OK, testSubmit(testFrame(&pixels), &limits, &out));
    const denied = try testWait(out.?);
    try t.expectEqual(c.ZC_NOMEM, denied.result);
    try t.expect(denied.budget_denials > 0);
    try t.expect(denied.working_peak <= 1024);
    try t.expectEqual(c.ZC_OK, zc_image_job_close(out));
    limits = testLimits();
    limits.max_output_bytes = 1;
    try t.expectEqual(c.ZC_OK, testSubmit(testFrame(&pixels), &limits, &out));
    defer testCleanup(out);
    try t.expectEqual(c.ZC_INVALID, (try testWait(out.?)).result);
    var blob: ?*c.zc_image_blob = @ptrFromInt(1);
    try t.expectEqual(c.ZC_INVALID, zc_image_job_take_blob(out.?, &blob));
    try t.expect(blob == null);
    limits.max_input_bytes = 15;
    var rejected: ?*c.zc_image_job = @ptrFromInt(1);
    try t.expectEqual(c.ZC_INVALID, testSubmit(testFrame(&pixels), &limits, &rejected));
    try t.expect(rejected == null);
}
