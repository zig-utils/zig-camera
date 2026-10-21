//! Staged still-file ownership. Encoding/staging run on the capture owner;
//! publication/disposal run on a joined native I/O thread. No frame is retained.
const std = @import("std");
const c = @import("abi.zig").c;
const Gate = @import("home/preparation_gate.zig").Gate;
const A = std.heap.c_allocator;
const File = struct {
    path: [:0]u8,
    mutex: std.Thread.Mutex = .{},
    gate: Gate = .{},
    active: bool = false,
    atom: ?std.fs.AtomicFile = null,
    identity: ?std.posix.Stat = null,
    thread: ?std.Thread = null,
    release: std.Thread.ResetEvent = .{},
    finished: bool = false,
    released: bool = false,
    committed: bool = false,
    publish: bool = false,
    result: c_int = c.ZC_OK,
    cleanup_code: c_int = c.ZC_OK,
    fn sameTemporary(self: *File) !bool {
        const atom = &self.atom.?;
        const expected = self.identity orelse return false;
        const name = std.fmt.hex(atom.random_integer);
        const found = std.posix.fstatat(atom.dir.fd, &name, std.posix.AT.SYMLINK_NOFOLLOW) catch |err| return if (err == error.FileNotFound) false else err;
        return found.dev == expected.dev and found.ino == expected.ino;
    }
    fn dispose(self: *File) void {
        if (self.atom) |*atom| {
            if (atom.file_exists) {
                if (self.identity == null) self.cleanup_code = c.ZC_IO;
                const same = self.sameTemporary() catch blk: {
                    self.cleanup_code = c.ZC_IO;
                    break :blk false;
                };
                if (same) {
                    const name = std.fmt.hex(atom.random_integer);
                    atom.dir.deleteFile(&name) catch |err| {
                        if (err != error.FileNotFound) self.cleanup_code = c.ZC_IO;
                    };
                }
                // AtomicFile.deinit otherwise retries deletion without checking
                // identity and can remove a replacement owned by someone else.
                atom.file_exists = false;
            }
            atom.deinit();
            self.atom = null;
        }
    }
    fn run(self: *File) void {
        self.release.wait();
        if (self.publish) {
            if (self.sameTemporary() catch false) {
                self.atom.?.finish() catch {
                    self.result = c.ZC_IO;
                };
                self.committed = self.result == c.ZC_OK;
            } else self.result = c.ZC_IO;
        }
        self.dispose();
        self.mutex.lock();
        defer self.mutex.unlock();
        if (!self.publish) _ = self.gate.cleaned();
        self.finished = true;
    }
};
fn file(p: *c.zc_image_file) *File {
    return @ptrCast(@alignCast(p));
}
pub export fn zc_image_file_create(path: [*:0]const u8, out: *?*c.zc_image_file) c_int {
    out.* = null;
    const text = std.mem.span(path);
    if (text.len == 0 or text.len > 4096) return c.ZC_INVALID;
    const name = A.dupeZ(u8, text) catch return c.ZC_NOMEM;
    const self = A.create(File) catch {
        A.free(name);
        return c.ZC_NOMEM;
    };
    self.* = .{ .path = name };
    self.thread = std.Thread.spawn(.{}, File.run, .{self}) catch {
        A.free(name);
        A.destroy(self);
        return c.ZC_NOMEM;
    };
    out.* = @ptrCast(self);
    return c.ZC_OK;
}
/// Caller owns a live handle and serializes preparation against close. Other
/// threads may cancel or poll; those operations never wait on encoding/file I/O.
pub fn begin(p: *c.zc_image_file) c_int {
    const self = file(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (self.active or self.released) return c.ZC_BUSY;
    if (!self.gate.claim()) return if (self.gate.cancel_requested or self.gate.phase == .cancelled) c.ZC_STALE else c.ZC_STATE;
    self.active = true;
    return c.ZC_OK;
}
pub fn cancelled(p: *c.zc_image_file) bool {
    const self = file(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    return self.gate.cancel_requested;
}
pub fn open(p: *c.zc_image_file, out: *std.posix.fd_t) c_int {
    const self = file(p);
    if (cancelled(p)) return c.ZC_STALE;
    self.atom = std.fs.cwd().atomicFile(self.path, .{ .write_buffer = &.{} }) catch return c.ZC_IO;
    self.identity = std.posix.fstat(self.atom.?.file_writer.file.handle) catch return c.ZC_IO;
    out.* = self.atom.?.file_writer.file.handle;
    return c.ZC_OK;
}
pub fn write(p: *c.zc_image_file, bytes: []const u8) c_int {
    var fd: std.posix.fd_t = undefined;
    const rc = open(p, &fd);
    if (rc != c.ZC_OK) return rc;
    const self = file(p);
    self.atom.?.file_writer.file.writeAll(bytes) catch return c.ZC_IO;
    return c.ZC_OK;
}
pub fn prepared(p: *c.zc_image_file, code: c_int) c_int {
    const self = file(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    self.active = false;
    self.result = code;
    if (code != c.ZC_OK and !(code == c.ZC_STALE and self.gate.cancel_requested)) _ = self.gate.fail() else if (!self.gate.ready()) return c.ZC_STALE;
    return code;
}
pub export fn zc_image_file_cancel(p: *c.zc_image_file) c_int {
    const self = file(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    return @intFromBool(self.gate.cancel());
}
/// publish=0 always disposes after the capture owner has retired; publish=1
/// irrevocably claims a ready file. Its I/O thread was reserved at creation.
pub export fn zc_image_file_finish(p: *c.zc_image_file, publish: u32) c_int {
    if (publish > 1) return c.ZC_INVALID;
    const self = file(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (self.active or self.released) return c.ZC_BUSY;
    if (publish == 1 and (self.gate.phase != .ready or self.gate.cancel_requested or self.atom == null)) return c.ZC_STATE;
    self.released = true;
    self.publish = publish == 1;
    if (self.publish) {
        std.debug.assert(self.gate.publish());
    } else _ = self.gate.cancel();
    self.release.set();
    return c.ZC_OK;
}
pub export fn zc_image_file_state_get(p: *c.zc_image_file, out: *c.zc_image_file_state) c_int {
    const self = file(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    // Result/cleanup fields belong to the I/O worker until it signals finished.
    out.* = .{ .struct_size = @sizeOf(c.zc_image_file_state), .phase = @intFromEnum(self.gate.phase), .preparing = @intFromBool(self.active), .released = @intFromBool(self.released), .finished = @intFromBool(self.finished), .committed = if (self.finished) @intFromBool(self.committed) else 0, .result = if (self.finished) self.result else c.ZC_TIMEOUT, .cleanup_code = if (self.finished) self.cleanup_code else c.ZC_OK };
    return c.ZC_OK;
}
pub export fn zc_image_file_close(p: ?*c.zc_image_file) c_int {
    const self = file(p orelse return c.ZC_OK);
    self.mutex.lock();
    if (self.active or !self.finished) {
        self.mutex.unlock();
        return c.ZC_BUSY;
    }
    const thread = self.thread;
    self.mutex.unlock();
    if (thread) |worker| worker.join();
    A.free(self.path);
    A.destroy(self);
    return c.ZC_OK;
}

fn waitForTest(p: *c.zc_image_file) !c.zc_image_file_state {
    var timer = try std.time.Timer.start();
    while (timer.read() < 10 * std.time.ns_per_s) {
        var state: c.zc_image_file_state = undefined;
        _ = zc_image_file_state_get(p, &state);
        if (state.finished != 0) return state;
        std.Thread.sleep(100 * std.time.ns_per_us);
    }
    return error.Timeout;
}
fn cleanupForTest(p: *c.zc_image_file) void {
    _ = zc_image_file_finish(p, 0);
    _ = waitForTest(p) catch return;
    _ = zc_image_file_close(p);
}
test "staged file publication owns copied paths and accepts no cancellation after claim" {
    const t = std.testing;
    var tmp = t.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();
    try tmp.dir.writeFile(.{ .sub_path = "photo", .data = "old" });
    const parent = try tmp.dir.realpathAlloc(t.allocator, ".");
    defer t.allocator.free(parent);
    const path = try std.fmt.allocPrintSentinel(t.allocator, "{s}/photo", .{parent}, 0);
    defer t.allocator.free(path);
    var output: ?*c.zc_image_file = null;
    try t.expectEqual(c.ZC_OK, zc_image_file_create(path, &output));
    defer cleanupForTest(output.?);
    @memset(path, 'x'); // Native destination remains its own copy.
    try t.expectEqual(c.ZC_BUSY, zc_image_file_close(output));
    try t.expectEqual(c.ZC_OK, begin(output.?));
    const code = write(output.?, "new");
    try t.expectEqual(c.ZC_OK, prepared(output.?, code));
    const before = try tmp.dir.readFileAlloc(t.allocator, "photo", 1024);
    defer t.allocator.free(before);
    try t.expectEqualStrings("old", before);
    try t.expectEqual(c.ZC_OK, zc_image_file_finish(output.?, 1));
    try t.expectEqual(@as(c_int, 0), zc_image_file_cancel(output.?));
    const result = try waitForTest(output.?);
    try t.expectEqual(@as(u32, 1), result.committed);
    try t.expectEqual(c.ZC_OK, result.result);
    try t.expectEqual(c.ZC_OK, result.cleanup_code);
    const after = try tmp.dir.readFileAlloc(t.allocator, "photo", 1024);
    defer t.allocator.free(after);
    try t.expectEqualStrings("new", after);
}
test "queued and prepared cancellation discard privately without changing the destination" {
    const t = std.testing;
    var tmp = t.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();
    try tmp.dir.writeFile(.{ .sub_path = "photo", .data = "keep" });
    const parent = try tmp.dir.realpathAlloc(t.allocator, ".");
    defer t.allocator.free(parent);
    const path = try std.fmt.allocPrintSentinel(t.allocator, "{s}/photo", .{parent}, 0);
    defer t.allocator.free(path);
    for (0..3) |stage| {
        var output: ?*c.zc_image_file = null;
        try t.expectEqual(c.ZC_OK, zc_image_file_create(path, &output));
        defer cleanupForTest(output.?);
        if (stage != 0) {
            try t.expectEqual(c.ZC_OK, begin(output.?));
            if (stage == 1) try t.expectEqual(@as(c_int, 1), zc_image_file_cancel(output.?));
            const code = write(output.?, "discard");
            try t.expectEqual(if (stage == 1) c.ZC_STALE else c.ZC_OK, prepared(output.?, code));
        }
        try t.expectEqual(@as(c_int, if (stage == 1) 0 else 1), zc_image_file_cancel(output.?));
        try t.expectEqual(c.ZC_STATE, zc_image_file_finish(output.?, 1));
        try t.expectEqual(c.ZC_OK, zc_image_file_finish(output.?, 0));
        const result = try waitForTest(output.?);
        try t.expectEqual(@as(u32, 4), result.phase);
        try t.expectEqual(@as(u32, 0), result.committed);
        try t.expectEqual(c.ZC_OK, result.cleanup_code);
    }
    const bytes = try tmp.dir.readFileAlloc(t.allocator, "photo", 1024);
    defer t.allocator.free(bytes);
    try t.expectEqualStrings("keep", bytes);
    var iterator = tmp.dir.iterate();
    try t.expectEqualStrings("photo", (try iterator.next()).?.name);
    try t.expectEqual(null, try iterator.next());
}
test "temporary replacements are never published or deleted by the staged owner" {
    const t = std.testing;
    var tmp = t.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();
    const parent = try tmp.dir.realpathAlloc(t.allocator, ".");
    defer t.allocator.free(parent);
    for ([_]u32{ 0, 1 }) |publish| {
        const path = try std.fmt.allocPrintSentinel(t.allocator, "{s}/photo-{d}", .{ parent, publish }, 0);
        defer t.allocator.free(path);
        var output: ?*c.zc_image_file = null;
        try t.expectEqual(c.ZC_OK, zc_image_file_create(path, &output));
        defer cleanupForTest(output.?);
        try t.expectEqual(c.ZC_OK, begin(output.?));
        const code = write(output.?, "candidate");
        try t.expectEqual(c.ZC_OK, prepared(output.?, code));
        const atom = &file(output.?).atom.?;
        const name = std.fmt.hex(atom.random_integer);
        const moved = try std.fmt.allocPrint(t.allocator, "moved-{d}", .{publish});
        defer t.allocator.free(moved);
        try atom.dir.rename(&name, moved);
        try atom.dir.writeFile(.{ .sub_path = &name, .data = "replacement" });
        try t.expectEqual(c.ZC_OK, zc_image_file_finish(output.?, publish));
        const result = try waitForTest(output.?);
        try t.expectEqual(@as(u32, 0), result.committed);
        try t.expectEqual(if (publish == 1) c.ZC_IO else c.ZC_OK, result.result);
        const foreign = try tmp.dir.readFileAlloc(t.allocator, &name, 1024);
        defer t.allocator.free(foreign);
        try t.expectEqualStrings("replacement", foreign);
    }
}
test "preparation and rename errors are reported without losing owned cleanup" {
    const t = std.testing;
    var tmp = t.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();
    const parent = try tmp.dir.realpathAlloc(t.allocator, ".");
    defer t.allocator.free(parent);
    for ([_]bool{ false, true }) |rename_failure| {
        const path = try std.fmt.allocPrintSentinel(t.allocator, "{s}/{s}", .{ parent, if (rename_failure) "directory" else "missing/photo" }, 0);
        defer t.allocator.free(path);
        if (rename_failure) try tmp.dir.makeDir("directory");
        var output: ?*c.zc_image_file = null;
        try t.expectEqual(c.ZC_OK, zc_image_file_create(path, &output));
        defer cleanupForTest(output.?);
        try t.expectEqual(c.ZC_OK, begin(output.?));
        const code = write(output.?, "candidate");
        try t.expectEqual(if (rename_failure) c.ZC_OK else c.ZC_IO, prepared(output.?, code));
        try t.expectEqual(c.ZC_OK, zc_image_file_finish(output.?, @intFromBool(rename_failure)));
        const result = try waitForTest(output.?);
        try t.expectEqual(c.ZC_IO, result.result);
        try t.expectEqual(c.ZC_OK, result.cleanup_code);
        try t.expectEqual(@as(u32, 0), result.committed);
    }
}

test "claimed preparation stays owned while a second thread polls cancels and attempts close" {
    const t = std.testing;
    var tmp = t.tmpDir(.{});
    defer tmp.cleanup();
    const parent = try tmp.dir.realpathAlloc(t.allocator, ".");
    defer t.allocator.free(parent);
    const path = try std.fmt.allocPrintSentinel(t.allocator, "{s}/photo", .{parent}, 0);
    defer t.allocator.free(path);
    var output: ?*c.zc_image_file = null;
    try t.expectEqual(c.ZC_OK, zc_image_file_create(path, &output));
    defer cleanupForTest(output.?);
    const Owner = struct {
        output: *c.zc_image_file,
        entered: std.Thread.ResetEvent = .{},
        release: std.Thread.ResetEvent = .{},
        result: c_int = c.ZC_STATE,
        fn run(self: *@This()) void {
            self.result = begin(self.output);
            self.entered.set();
            self.release.wait();
            if (self.result == c.ZC_OK) self.result = prepared(self.output, write(self.output, "discard"));
        }
    };
    var owner = Owner{ .output = output.? };
    const thread = try std.Thread.spawn(.{}, Owner.run, .{&owner});
    var joined = false;
    defer {
        owner.release.set();
        if (!joined) thread.join();
    }
    owner.entered.wait();
    var state: c.zc_image_file_state = undefined;
    try t.expectEqual(c.ZC_OK, zc_image_file_state_get(output.?, &state));
    try t.expectEqual(@as(u32, 1), state.preparing);
    try t.expectEqual(c.ZC_BUSY, zc_image_file_close(output));
    try t.expectEqual(c.ZC_BUSY, zc_image_file_finish(output.?, 0));
    try t.expectEqual(@as(c_int, 1), zc_image_file_cancel(output.?));
    owner.release.set();
    thread.join();
    joined = true;
    try t.expectEqual(c.ZC_STALE, owner.result);
    try t.expectEqual(c.ZC_OK, zc_image_file_finish(output.?, 0));
    const result = try waitForTest(output.?);
    try t.expectEqual(@as(u32, 4), result.phase);
    try t.expectEqual(@as(u32, 0), result.committed);
    try t.expectError(error.FileNotFound, tmp.dir.openFile("photo", .{}));
}
