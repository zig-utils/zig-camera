//! Serialized C ownership around Home's bounded tuning-document editor.
const std = @import("std");
const c = @import("abi.zig").c;
pub const home = @import("home/tuning.zig");
const allocator = std.heap.c_allocator;
const Owned = struct { mutex: std.Thread.Mutex = .{}, document: home.Document };
fn owner(p: *c.zc_tuning_document) *Owned {
    return @ptrCast(@alignCast(p));
}
fn status(err: anyerror) c_int {
    return switch (err) {
        error.OutOfMemory => c.ZC_NOMEM,
        error.AlgorithmNotFound => c.ZC_UNSUPPORTED,
        else => c.ZC_INVALID,
    };
}
fn input(data: ?[*]const u8, length: u64) ![]const u8 {
    if (data == null or length == 0 or length > (home.Limits{}).bytes) return error.InvalidInput;
    return data.?[0..@intCast(length)];
}
fn nameInput(data: ?[*]const u8, length: u32) ![]const u8 {
    if (length > home.name_limit) return error.InvalidName;
    return input(data, length);
}
pub export fn zc_tuning_document_open(data: ?[*]const u8, length: u64, out: *?*c.zc_tuning_document) c_int {
    out.* = null;
    const bytes = input(data, length) catch return c.ZC_INVALID;
    var document = home.Document.init(allocator, bytes, .{}) catch |err| return status(err);
    const p = allocator.create(Owned) catch {
        document.deinit();
        return c.ZC_NOMEM;
    };
    p.* = .{ .document = document };
    out.* = @ptrCast(p);
    return c.ZC_OK;
}
pub export fn zc_tuning_document_version(p: *c.zc_tuning_document, out: *u32) c_int {
    out.* = 0;
    const self = owner(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    out.* = self.document.version() catch |err| return status(err);
    return c.ZC_OK;
}
fn copy(bytes: []const u8, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    length.* = bytes.len;
    if (data == null) return if (capacity == 0) c.ZC_OK else c.ZC_INVALID;
    if (capacity < bytes.len) return c.ZC_INVALID;
    @memcpy(data.?[0..bytes.len], bytes);
    return c.ZC_OK;
}
pub export fn zc_tuning_document_copy(p: *c.zc_tuning_document, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    const self = owner(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    return copy(self.document.bytes, data, capacity, length);
}
pub export fn zc_tuning_document_find(p: *c.zc_tuning_document, name: ?[*]const u8, name_length: u32, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    length.* = 0;
    const key = nameInput(name, name_length) catch return c.ZC_INVALID;
    const self = owner(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    const bytes = self.document.algorithmJSON(allocator, key) catch |err| return status(err);
    defer allocator.free(bytes);
    return copy(bytes, data, capacity, length);
}
pub export fn zc_tuning_document_replace(p: *c.zc_tuning_document, name: ?[*]const u8, name_length: u32, data: ?[*]const u8, length: u64) c_int {
    const key = nameInput(name, name_length) catch return c.ZC_INVALID;
    const bytes = input(data, length) catch return c.ZC_INVALID;
    const self = owner(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    self.document.replaceAlgorithm(key, bytes) catch |err| return status(err);
    return c.ZC_OK;
}
pub export fn zc_tuning_document_close(p: ?*c.zc_tuning_document) void {
    if (p) |value| {
        const self = owner(value);
        self.document.deinit();
        allocator.destroy(self);
    }
}
test "tuning ABI owns source bytes copies atomically and preserves failed edits" {
    const t = std.testing;
    var bytes: [64]u8 = @splat(32);
    const original = "{\"version\":2,\"algorithms\":[{\"rpi.agc\":9007199254740993}]}";
    @memcpy(bytes[0..original.len], original);
    var p: ?*c.zc_tuning_document = null;
    try t.expectEqual(c.ZC_OK, zc_tuning_document_open(&bytes, original.len, &p));
    defer zc_tuning_document_close(p);
    @memset(&bytes, 'x');
    var version: u32 = 0;
    try t.expectEqual(c.ZC_OK, zc_tuning_document_version(p.?, &version));
    try t.expectEqual(@as(u32, 2), version);
    var length: u64 = 0;
    var out: [80]u8 = @splat(42);
    try t.expectEqual(c.ZC_OK, zc_tuning_document_find(p.?, "rpi.agc", 7, null, 0, &length));
    try t.expectEqual(@as(u64, 16), length);
    try t.expectEqual(c.ZC_INVALID, zc_tuning_document_find(p.?, "rpi.agc", 7, &out, 1, &length));
    try t.expect(std.mem.allEqual(u8, &out, 42));
    try t.expectEqual(c.ZC_OK, zc_tuning_document_find(p.?, "rpi.agc", 7, &out, out.len, &length));
    try t.expectEqualStrings("9007199254740993", out[0..@intCast(length)]);
    try t.expectEqual(@as(u8, 42), out[@intCast(length)]);
    try t.expectEqual(c.ZC_INVALID, zc_tuning_document_replace(p.?, "rpi.agc", 7, "[", 1));
    try t.expectEqual(c.ZC_OK, zc_tuning_document_copy(p.?, &out, out.len, &length));
    try t.expectEqualStrings(original, out[0..@intCast(length)]);
    try t.expectEqual(c.ZC_UNSUPPORTED, zc_tuning_document_replace(p.?, "missing", 7, "1", 1));
    try t.expectEqual(c.ZC_OK, zc_tuning_document_replace(p.?, "rpi.agc", 7, "true", 4));
    try t.expectEqual(c.ZC_OK, zc_tuning_document_find(p.?, "rpi.agc", 7, &out, out.len, &length));
    try t.expectEqualStrings("true", out[0..@intCast(length)]);
}
