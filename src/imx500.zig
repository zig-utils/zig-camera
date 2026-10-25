//! Independent bounded IMX500 descriptors. The kernel owns cached controls and
//! replays them at stream start; cached values are not frame-application proof.
const std = @import("std");
const c = @import("abi.zig").c;
const options = @import("options");
const A = std.heap.c_allocator;
const Identity = @import("home/device_identity.zig").Identity(c.ZC_MAX_CAMERA_ID);
const observed = @import("home/observed_control.zig");
const roi = @import("home/imx500_roi.zig");
const region = @import("home/inference_region.zig");
const Linux = @import("imx500_linux.zig");
const state_valid: u32 = 2048;
var registry: std.Thread.Mutex = .{};
var owners: [16]?*Owner = @splat(null);
var synthetic_mutex: std.Thread.Mutex = .{};
var synthetic_cached: roi.Payload = .{ 0, 0, 0, 0 };
const Owner = struct {
    operation: std.Thread.Mutex = .{},
    backend: u32,
    identity: ?Identity = null,
    device: ?Linux.Device = null,
    control: ?c.zc_imx500_control_info = null,
    saved: ?roi.Payload = null,
    revision: u64 = 0,
};
fn owner(p: *c.zc_imx500) *Owner {
    return @ptrCast(@alignCast(p));
}
fn status(err: anyerror) c_int {
    return switch (err) {
        error.OutOfMemory => c.ZC_NOMEM,
        error.NoSavedRoi => c.ZC_STATE,
        error.Busy, error.ScanLimit => c.ZC_BUSY,
        error.Unsupported, error.NoSensorNode, error.NoCamera, error.UnsupportedRoiRange => c.ZC_UNSUPPORTED,
        error.Disconnected => c.ZC_DISCONNECTED,
        error.AmbiguousSensor, error.Device, error.ControlNotApplied, error.InvalidCachedRoi => c.ZC_DEVICE,
        error.EmptyRoi, error.InvalidLimits, error.InvalidGeometry, error.DegenerateCrop, error.InvalidCatalog, error.InvalidIdentity, error.IdentityTooLong, error.InvalidString, error.InvalidStringQuery, error.AmbiguousString => c.ZC_INVALID,
        else => c.ZC_IO,
    };
}
fn reserve(backend: u32) !*Owner {
    registry.lock();
    defer registry.unlock();
    for (&owners) |*slot| if (slot.* == null) {
        const value = try A.create(Owner);
        value.* = .{ .backend = backend };
        slot.* = value;
        return value;
    };
    return error.Busy;
}
fn destroy(self: *Owner) void {
    registry.lock();
    for (&owners) |*slot| if (slot.* == self) {
        slot.* = null;
        break;
    };
    registry.unlock();
    if (self.device) |*device| device.close();
    A.destroy(self);
}
fn identity(self: *Owner, value: Identity) !void {
    registry.lock();
    defer registry.unlock();
    for (owners) |slot| if (slot) |other| if (other != self and other.backend == self.backend) {
        if (other.identity) |*id| if (id.matches(value.bytes())) return error.Busy;
    };
    self.identity = value;
}
fn validate(self: *Owner) !void {
    if (self.backend == c.ZC_SYNTHETIC) {
        self.control = .{ .struct_size = @sizeOf(c.zc_imx500_control_info), .flags = 0x300, .minimum = 0, .maximum = 4032, .step = 1, .default_value = 0 };
    } else if (options.libcamera) self.control = try self.device.?.validate() else return error.Unsupported;
}
fn readRaw(self: *Owner) !roi.Payload {
    if (self.backend == c.ZC_SYNTHETIC) {
        synthetic_mutex.lock();
        defer synthetic_mutex.unlock();
        return synthetic_cached;
    }
    if (options.libcamera) return self.device.?.read();
    return error.Unsupported;
}
fn writeRaw(self: *Owner, value: roi.Payload) !void {
    if (self.backend == c.ZC_SYNTHETIC) {
        synthetic_mutex.lock();
        defer synthetic_mutex.unlock();
        synthetic_cached = value;
    } else if (options.libcamera) try self.device.?.write(value) else return error.Unsupported;
}
fn header(self: *const Owner) c.zc_imx500_state {
    var out = std.mem.zeroes(c.zc_imx500_state);
    out.struct_size = @sizeOf(c.zc_imx500_state);
    out.backend = self.backend;
    if (self.backend == c.ZC_SYNTHETIC) out.flags = c.ZC_IMX500_SYNTHETIC;
    return out;
}
fn payload(out: *c.zc_imx500_state, which: u2, value: roi.Payload) void {
    const flags = [_]u32{ c.ZC_IMX500_PREVIOUS, c.ZC_IMX500_CURRENT, c.ZC_IMX500_SAVED };
    const effective_flags = [_]u32{ c.ZC_IMX500_PREVIOUS_ROI, c.ZC_IMX500_CURRENT_ROI, c.ZC_IMX500_SAVED_ROI };
    const raw = switch (which) {
        0 => &out.previous,
        1 => &out.current,
        else => &out.saved,
    };
    raw.* = value;
    out.flags |= flags[which];
    if (roi.effective(value)) |r| {
        const target = switch (which) {
            0 => &out.previous_roi,
            1 => &out.current_roi,
            else => &out.saved_roi,
        };
        target.* = .{ r.x, r.y, @intCast(r.width), @intCast(r.height) };
        out.flags |= effective_flags[which];
    } else |_| {}
}
fn snapshot(self: *Owner, out: *c.zc_imx500_state) void {
    out.* = header(self);
    out.flags |= state_valid;
    out.revision = self.revision;
    if (self.control) |value| {
        out.control = value;
        out.flags |= c.ZC_IMX500_CAPABILITIES;
    }
    if (self.saved) |value| payload(out, 2, value);
}
fn finish(self: *Owner, out: *c.zc_imx500_state, failure: ?anyerror) c_int {
    out.revision = self.revision;
    if (self.control) |value| {
        out.control = value;
        out.flags |= c.ZC_IMX500_CAPABILITIES;
    }
    if (self.device) |device| out.system_errno = device.first_errno;
    return if (failure) |err| status(err) else c.ZC_OK;
}
fn begin(self: *Owner, out: *c.zc_imx500_state) c_int {
    out.* = header(self);
    if (!self.operation.tryLock()) return c.ZC_BUSY;
    if (self.device) |*device| device.reset();
    self.control = null;
    snapshot(self, out);
    return c.ZC_OK;
}
pub export fn zc_imx500_open(backend: u32, index: u32, id: ?[*]const u8, length: u32, out: *?*c.zc_imx500) c_int {
    out.* = null;
    if (backend > 1 or length > c.ZC_MAX_CAMERA_ID or (id == null) != (length == 0) or (length != 0 and index != std.math.maxInt(u32))) return c.ZC_INVALID;
    if (backend == c.ZC_LIBCAMERA and !options.libcamera) return c.ZC_UNSUPPORTED;
    const requested: ?Identity = if (id) |bytes| Identity.init(bytes[0..length]) catch return c.ZC_INVALID else null;
    const self = reserve(backend) catch |err| return status(err);
    var success = false;
    defer if (!success) destroy(self);
    const selected = @import("sensor_discovery.zig").discover(backend, index, requested, "imx500") catch |err| return status(err);
    identity(self, selected) catch |err| return status(err);
    if (backend == c.ZC_LIBCAMERA) {
        if (options.libcamera) self.device = Linux.Device.open(selected) catch |err| return status(err) else return c.ZC_UNSUPPORTED;
    }
    validate(self) catch |err| return status(err);
    const initial = readRaw(self) catch |err| return status(err);
    if (roi.effective(initial)) |_| self.saved = initial else |_| {}
    out.* = @ptrCast(self);
    success = true;
    return c.ZC_OK;
}
pub export fn zc_imx500_camera_id(p: *c.zc_imx500, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    const self = owner(p);
    if (!self.operation.tryLock()) return c.ZC_BUSY;
    defer self.operation.unlock();
    const bytes = self.identity.?.bytes();
    length.* = bytes.len;
    if (data) |destination| {
        if (capacity < bytes.len) return c.ZC_INVALID;
        @memcpy(destination[0..bytes.len], bytes);
    } else if (capacity != 0) return c.ZC_INVALID;
    return c.ZC_OK;
}
pub export fn zc_imx500_get_roi(p: *c.zc_imx500, out: *c.zc_imx500_state) c_int {
    const self = owner(p);
    const rc = begin(self, out);
    if (rc != 0) return rc;
    defer self.operation.unlock();
    validate(self) catch |err| return finish(self, out, err);
    const current = readRaw(self) catch |err| return finish(self, out, err);
    payload(out, 1, current);
    return finish(self, out, if (out.flags & c.ZC_IMX500_CURRENT_ROI != 0) null else error.InvalidCachedRoi);
}
const Prepared = struct {
    self: *Owner,
    first: ?roi.Payload,
    pub fn validate(_: *@This()) !void {}
    pub fn read(io: *@This()) !roi.Payload {
        if (io.first) |value| {
            io.first = null;
            return value;
        }
        return readRaw(io.self);
    }
    pub fn write(io: *@This(), value: roi.Payload) !void {
        try writeRaw(io.self, value);
    }
};
fn apply(self: *Owner, out: *c.zc_imx500_state, value: roi.Payload, current: roi.Payload, force: bool) c_int {
    if (self.revision == std.math.maxInt(u64)) return finish(self, out, error.Busy);
    var io = Prepared{ .self = self, .first = current };
    const result = observed.apply(roi.Payload, &io, value, force);
    return recordOutcome(self, out, value, result);
}
fn recordOutcome(self: *Owner, out: *c.zc_imx500_state, value: roi.Payload, result: observed.Outcome(roi.Payload)) c_int {
    if (result.previous) |old| payload(out, 0, old);
    out.flags &= ~@as(u32, c.ZC_IMX500_CURRENT | c.ZC_IMX500_CURRENT_ROI);
    if (result.current) |now| payload(out, 1, now);
    if (result.write_attempted) {
        out.flags |= c.ZC_IMX500_WRITE_ATTEMPTED;
        self.revision += 1;
    }
    if (result.write_succeeded) out.flags |= c.ZC_IMX500_WRITE_SUCCEEDED;
    if (result.changed() orelse false) out.flags |= c.ZC_IMX500_CHANGED;
    if (result.failure == null) {
        self.saved = value;
        payload(out, 2, value);
    }
    return finish(self, out, result.failure);
}
fn limits(self: *Owner) roi.Limits {
    const info = self.control.?;
    return .{ .minimum = @intCast(info.minimum), .maximum = @intCast(info.maximum), .step = @intCast(info.step) };
}
fn set(self: *Owner, requested: ?region.Rect, restore: bool, out: *c.zc_imx500_state) c_int {
    const rc = begin(self, out);
    if (rc != 0) return rc;
    defer self.operation.unlock();
    validate(self) catch |err| return finish(self, out, err);
    const current = readRaw(self) catch |err| return finish(self, out, err);
    payload(out, 1, current);
    const value = if (restore) self.saved orelse return finish(self, out, error.NoSavedRoi) else roi.encode(requested.?, limits(self)) catch |err| return finish(self, out, err);
    roi.validate(value, limits(self)) catch |err| return finish(self, out, err);
    return apply(self, out, value, current, restore);
}
pub export fn zc_imx500_set_roi(p: *c.zc_imx500, x: i32, y: i32, width: u32, height: u32, out: *c.zc_imx500_state) c_int {
    return set(owner(p), .{ .x = x, .y = y, .width = width, .height = height }, false, out);
}
pub export fn zc_imx500_set_aspect(p: *c.zc_imx500, width: u32, height: u32, out: *c.zc_imx500_state) c_int {
    const requested = region.centeredAspect(roi.full, .{ .width = width, .height = height }) catch |err| {
        out.* = header(owner(p));
        return status(err);
    };
    return set(owner(p), requested, false, out);
}
pub export fn zc_imx500_restore_roi(p: *c.zc_imx500, out: *c.zc_imx500_state) c_int {
    return set(owner(p), null, true, out);
}
pub export fn zc_imx500_device_id(p: *c.zc_imx500, out: [*]u32) c_int {
    const self = owner(p);
    if (!self.operation.tryLock()) return c.ZC_BUSY;
    defer self.operation.unlock();
    const value: [4]u32 = if (self.backend == c.ZC_SYNTHETIC) .{ 0x53594e54, 0x48455449, 0x43494d58, 0x35303000 } else if (options.libcamera) blk: {
        self.device.?.reset();
        _ = self.device.?.validate() catch |err| return status(err);
        break :blk self.device.?.deviceId() catch |err| return status(err);
    } else return c.ZC_UNSUPPORTED;
    @memcpy(out[0..4], &value);
    return c.ZC_OK;
}
pub export fn zc_imx500_close(p: ?*c.zc_imx500) c_int {
    const self = owner(p orelse return c.ZC_OK);
    if (!self.operation.tryLock()) return c.ZC_BUSY;
    self.operation.unlock();
    destroy(self);
    return c.ZC_OK;
}

test "IMX500 independent descriptors observe ROI sentinel limits restore and duplicate ownership" {
    if (options.libcamera) return error.SkipZigTest;
    const t = std.testing;
    try t.expectEqual(@as(usize, 160), @sizeOf(c.zc_imx500_state));
    var p: ?*c.zc_imx500 = null;
    try t.expectEqual(c.ZC_OK, zc_imx500_open(c.ZC_SYNTHETIC, std.math.maxInt(u32), null, 0, &p));
    defer _ = zc_imx500_close(p);
    var other: ?*c.zc_imx500 = @ptrFromInt(1);
    try t.expectEqual(c.ZC_BUSY, zc_imx500_open(c.ZC_SYNTHETIC, std.math.maxInt(u32), null, 0, &other));
    try t.expect(other == null);
    var state: c.zc_imx500_state = undefined;
    try t.expectEqual(c.ZC_OK, zc_imx500_get_roi(p.?, &state));
    try t.expectEqualSlices(i32, &.{ 0, 0, 4056, 3040 }, &state.current_roi);
    try t.expectEqual(c.ZC_OK, zc_imx500_set_aspect(p.?, 1, 1, &state));
    try t.expectEqualSlices(i32, &.{ 508, 0, 3040, 3040 }, &state.current_roi);
    try t.expectEqual(@as(u64, 1), state.revision);
    try t.expectEqual(c.ZC_OK, zc_imx500_set_aspect(p.?, 1, 1, &state));
    try t.expectEqual(@as(u64, 1), state.revision);
    try writeRaw(owner(p.?), .{ 0, 0, 100, 100 });
    try t.expectEqual(c.ZC_OK, zc_imx500_restore_roi(p.?, &state));
    try t.expectEqualSlices(i32, &.{ 508, 0, 3040, 3040 }, &state.current_roi);
    try t.expectEqual(@as(u64, 2), state.revision);
    try t.expectEqual(c.ZC_UNSUPPORTED, zc_imx500_set_roi(p.?, 0, 0, 4056, 100, &state));
    try t.expect(state.flags & c.ZC_IMX500_WRITE_ATTEMPTED == 0);
    try t.expectEqual(c.ZC_OK, zc_imx500_set_roi(p.?, 0, 0, 4056, 3040, &state));
    try t.expectEqualSlices(u32, &.{ 0, 0, 0, 0 }, &state.current);
}
test "IMX500 busy operations retain descriptor and quota before close" {
    if (options.libcamera) return error.SkipZigTest;
    const t = std.testing;
    var p: ?*c.zc_imx500 = null;
    try t.expectEqual(c.ZC_OK, zc_imx500_open(c.ZC_SYNTHETIC, std.math.maxInt(u32), null, 0, &p));
    const self = owner(p.?);
    self.operation.lock();
    var out: c.zc_imx500_state = undefined;
    try t.expectEqual(c.ZC_BUSY, zc_imx500_get_roi(p.?, &out));
    try t.expectEqual(@as(u32, c.ZC_IMX500_SYNTHETIC), out.flags);
    try t.expectEqual(c.ZC_BUSY, zc_imx500_close(p));
    self.operation.unlock();
    try t.expectEqual(c.ZC_OK, zc_imx500_close(p));
    var reservations: [16]*Owner = undefined;
    for (&reservations) |*slot| slot.* = try reserve(c.ZC_SYNTHETIC);
    try t.expectError(error.Busy, reserve(c.ZC_SYNTHETIC));
    for (reservations) |value| destroy(value);
}

test "IMX500 observations retain failed-write changes without replacing the last saved value" {
    const t = std.testing;
    var self = Owner{ .backend = c.ZC_SYNTHETIC, .saved = .{ 0, 0, 0, 0 } };
    var state: c.zc_imx500_state = undefined;
    snapshot(&self, &state);
    const requested = roi.Payload{ 508, 0, 3040, 3040 };
    try t.expectEqual(c.ZC_IO, recordOutcome(&self, &state, requested, .{ .previous = .{ 0, 0, 0, 0 }, .current = requested, .write_attempted = true, .failure = error.InputOutput }));
    try t.expect(state.flags & c.ZC_IMX500_CHANGED != 0 and state.flags & c.ZC_IMX500_WRITE_SUCCEEDED == 0);
    try t.expectEqualSlices(u32, &.{ 0, 0, 0, 0 }, &state.saved);
    try t.expectEqual(@as(u64, 1), state.revision);
    snapshot(&self, &state);
    try t.expectEqual(c.ZC_IO, recordOutcome(&self, &state, requested, .{ .previous = .{ 0, 0, 0, 0 }, .write_attempted = true, .write_succeeded = true, .failure = error.InputOutput }));
    try t.expect(state.flags & c.ZC_IMX500_CURRENT == 0 and state.flags & c.ZC_IMX500_WRITE_SUCCEEDED != 0);
    try t.expectEqualSlices(u32, &.{ 0, 0, 0, 0 }, &state.saved);
}

test "IMX500 synthetic cache survives descriptor closure without implicit reset" {
    if (options.libcamera) return error.SkipZigTest;
    const t = std.testing;
    var p: ?*c.zc_imx500 = null;
    var state: c.zc_imx500_state = undefined;
    try t.expectEqual(c.ZC_OK, zc_imx500_open(c.ZC_SYNTHETIC, std.math.maxInt(u32), null, 0, &p));
    try t.expectEqual(c.ZC_OK, zc_imx500_set_roi(p.?, 100, 200, 300, 400, &state));
    try t.expectEqual(c.ZC_OK, zc_imx500_close(p));
    p = null;
    try t.expectEqual(c.ZC_OK, zc_imx500_open(c.ZC_SYNTHETIC, std.math.maxInt(u32), null, 0, &p));
    defer _ = zc_imx500_close(p);
    try t.expectEqual(c.ZC_OK, zc_imx500_get_roi(p.?, &state));
    try t.expectEqualSlices(u32, &.{ 100, 200, 300, 400 }, &state.current);
    try t.expectEqual(c.ZC_OK, zc_imx500_set_roi(p.?, 0, 0, 4056, 3040, &state));
}
