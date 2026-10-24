//! Manager-lifetime tuning ownership. C++ only notifies acquire/release; Zig
//! owns the snapshot, file, environment restoration and public session tokens.
const std = @import("std");
const c = @import("abi.zig").c;
const Home = @import("home/tuning.zig");
const Env = @import("home/posix_env.zig");
const ManagerGate = @import("home/manager_gate.zig").Gate;
const A = std.heap.c_allocator;
const key = "LIBCAMERA_RPI_TUNING_FILE";
extern "c" fn setenv([*:0]const u8, [*:0]const u8, c_int) c_int;
extern "c" fn unsetenv([*:0]const u8) c_int;
const Profile = struct {
    document: Home.Document,
    path: ?[:0]u8 = null,
    identity: ?std.posix.Stat = null,
    file: ?std.fs.File = null,
};
const State = struct {
    profile: ?*Profile = null,
    users: u32 = 0,
    manager: ManagerGate = .{},
    layout: ManagerGate = .{},
    environment: ?Env.Override = null,
    external_change: bool = false,
    last_error: c_int = c.ZC_OK,
};
pub const Lease = struct { backend: u32 };
var mutex: std.Thread.Mutex = .{};
var states: [2]State = @splat(.{});
// Test-only faults exercise retained cleanup owners without affecting callbacks.
var fail_restore = false;
var fail_unlink = false;
var fail_stage_stat = false;
var fail_stage_write = false;
fn valid(backend: u32) bool {
    return backend <= 1;
}
fn sameEnvironment(s: *const State) bool {
    return if (s.environment) |*guard| guard.matchesCurrent() else false;
}
fn restore(s: *State) c_int {
    if (s.environment) |*guard| {
        if (fail_restore) return c.ZC_IO;
        const result = guard.close() catch return c.ZC_IO;
        if (result == .superseded) s.external_change = true;
        s.environment = null;
    }
    return c.ZC_OK;
}
fn removeProfile(s: *State) c_int {
    const p = s.profile orelse return c.ZC_OK;
    if (p.identity == null and p.file != null) p.identity = std.posix.fstat(p.file.?.handle) catch return c.ZC_IO;
    if (p.path) |path| {
        const found = std.posix.fstatat(std.posix.AT.FDCWD, path, std.posix.AT.SYMLINK_NOFOLLOW) catch |err| {
            if (err == error.FileNotFound) {
                A.free(path);
                p.path = null;
                if (p.file) |file| file.close();
                p.document.deinit();
                A.destroy(p);
                s.profile = null;
                return c.ZC_OK;
            }
            return c.ZC_IO;
        };
        const expected = p.identity orelse return c.ZC_IO;
        if (found.dev == expected.dev and found.ino == expected.ino) {
            if (fail_unlink) return c.ZC_IO;
            std.fs.deleteFileAbsolute(path) catch return c.ZC_IO;
        } else s.external_change = true; // Retire our owner, never a replacement.
        A.free(path);
    }
    if (p.file) |file| file.close();
    p.document.deinit();
    A.destroy(p);
    s.profile = null;
    return c.ZC_OK;
}
fn cleanup(s: *State) c_int {
    if (s.manager.users != 0) return c.ZC_BUSY;
    var rc = restore(s);
    if (rc == c.ZC_OK and s.users == 0) rc = removeProfile(s);
    s.last_error = rc;
    return rc;
}
fn stage(p: *Profile) c_int {
    var random: [16]u8 = undefined;
    std.crypto.random.bytes(&random);
    const path = std.fmt.allocPrintSentinel(A, "/tmp/zc-tuning-{s}.json", .{std.fmt.bytesToHex(random, .lower)}, 0) catch return c.ZC_NOMEM;
    const file = std.fs.createFileAbsolute(path, .{ .exclusive = true, .mode = 0o600 }) catch {
        A.free(path);
        return c.ZC_IO;
    };
    p.file = file;
    p.path = path;
    // Retain a retry owner even if stat/write/fsync fails. The session is not
    // published until all staging completes; global cleanup reports any residue.
    if (fail_stage_stat) return c.ZC_IO;
    p.identity = std.posix.fstat(file.handle) catch return c.ZC_IO;
    if (fail_stage_write) return c.ZC_IO;
    file.writeAll(p.document.bytes) catch return c.ZC_IO;
    file.sync() catch return c.ZC_IO;
    return c.ZC_OK;
}
/// Caller owns a valid Home snapshot; this validates raw ABI input as well.
pub fn create(data: ?[*]const u8, length: u64, backend: u32, out: *?*c.zc_tuning_session) c_int {
    out.* = null;
    if (!valid(backend) or data == null or length == 0 or length > (Home.Limits{}).bytes) return c.ZC_INVALID;
    var document = Home.Document.init(A, data.?[0..@intCast(length)], .{}) catch |err| return if (err == error.OutOfMemory) c.ZC_NOMEM else c.ZC_INVALID;
    var document_owned = true;
    defer if (document_owned) document.deinit();
    const token = A.create(Lease) catch return c.ZC_NOMEM;
    var published = false;
    defer if (!published) A.destroy(token);
    mutex.lock();
    defer mutex.unlock();
    const s = &states[backend];
    if (s.users == 0 and s.manager.users == 0 and s.last_error != c.ZC_OK) {
        const retry = cleanup(s);
        if (retry != c.ZC_OK) return retry;
    }
    if (s.users == std.math.maxInt(u32)) return c.ZC_BUSY;
    if (s.profile) |p| {
        if (!std.mem.eql(u8, p.document.bytes, document.bytes)) return c.ZC_BUSY;
        if (s.environment != null and !sameEnvironment(s)) return c.ZC_BUSY;
    } else {
        if (s.manager.users != 0) return c.ZC_BUSY;
        const p = A.create(Profile) catch return c.ZC_NOMEM;
        p.* = .{ .document = document };
        document_owned = false;
        s.profile = p;
        s.external_change = false;
        s.last_error = if (backend == c.ZC_LIBCAMERA) stage(p) else c.ZC_OK;
        if (s.last_error != c.ZC_OK) {
            const original = s.last_error;
            // Keep the global retry owner if removing a failed stage also fails.
            _ = cleanup(s);
            s.last_error = original;
            return original;
        }
    }
    s.users += 1;
    token.* = .{ .backend = backend };
    out.* = @ptrCast(token);
    published = true;
    return c.ZC_OK;
}
pub export fn zc_tuning_session_close(p: *c.zc_tuning_session) c_int {
    const token: *Lease = @ptrCast(@alignCast(p));
    mutex.lock();
    defer mutex.unlock();
    const s = &states[token.backend];
    std.debug.assert(s.users > 0);
    if (s.users == 1 and s.manager.users == 0) {
        // Decrement only on successful cleanup; failed close retains its token.
        s.users = 0;
        const rc = cleanup(s);
        if (rc != c.ZC_OK) {
            s.users = 1;
            return rc;
        }
    } else s.users -= 1;
    A.destroy(token);
    return c.ZC_OK;
}
pub export fn zc_tuning_cleanup(backend: u32) c_int {
    if (!valid(backend)) return c.ZC_INVALID;
    mutex.lock();
    defer mutex.unlock();
    return cleanup(&states[backend]);
}
pub export fn zc_get_tuning_state(backend: u32, out: *c.zc_tuning_state) c_int {
    out.* = std.mem.zeroes(c.zc_tuning_state);
    if (!valid(backend)) return c.ZC_INVALID;
    mutex.lock();
    defer mutex.unlock();
    const s = &states[backend];
    out.* = .{ .struct_size = @sizeOf(c.zc_tuning_state), .backend = backend, .custom = @intFromBool(s.profile != null), .manager_users = s.manager.users, .session_users = s.users, .environment_active = @intFromBool(s.environment != null), .cleanup_pending = @intFromBool(s.profile != null and s.last_error != c.ZC_OK and s.manager.users == 0), .external_change = @intFromBool(s.external_change or (s.environment != null and !sameEnvironment(s))), .last_error = s.last_error, .reserved = 0, .generation = s.manager.generation, .bytes = if (s.profile) |p| p.document.bytes.len else 0 };
    return c.ZC_OK;
}
pub fn begin(backend: u32) c_int {
    mutex.lock();
    defer mutex.unlock();
    return beginLocked(backend, false);
}
pub fn beginExclusive(backend: u32) c_int {
    mutex.lock();
    defer mutex.unlock();
    return beginLocked(backend, true);
}
fn beginLocked(backend: u32, exclusive: bool) c_int {
    if (backend > c.ZC_LIBCAMERA) return c.ZC_INVALID;
    const s = &states[backend];
    var next_layout = s.layout;
    if (exclusive) _ = next_layout.enterExclusive() catch |err| return if (err == error.Busy) c.ZC_BUSY else c.ZC_STATE;
    var next = s.manager;
    _ = (if (exclusive) next.enterExclusive() else next.enterShared()) catch |err| return if (err == error.Busy) c.ZC_BUSY else c.ZC_STATE;
    if (s.environment != null and !sameEnvironment(s)) return c.ZC_BUSY;
    if (s.manager.users == 0) {
        if (s.last_error != c.ZC_OK) {
            const rc = cleanup(s);
            if (rc != c.ZC_OK) return rc;
        }
        if (backend == c.ZC_LIBCAMERA and s.profile != null) {
            const p = s.profile.?;
            const found = std.posix.fstatat(std.posix.AT.FDCWD, p.path.?, std.posix.AT.SYMLINK_NOFOLLOW) catch return c.ZC_IO;
            const expected = p.identity orelse return c.ZC_IO;
            if (found.dev != expected.dev or found.ino != expected.ino or found.size != p.document.bytes.len) return c.ZC_IO;
            // Profile is pinned before startup and kept through hotplug/IPA work.
            if (s.environment == null)
                s.environment = Env.Override.init(A, key, p.path.?) catch |err| return if (err == error.OutOfMemory) c.ZC_NOMEM else c.ZC_IO;
        }
    }
    s.manager = next;
    s.layout = next_layout;
    return c.ZC_OK;
}

pub fn end(backend: u32) void {
    mutex.lock();
    defer mutex.unlock();
    const s = &states[backend];
    const last = s.manager.leaveShared() catch unreachable;
    if (last) _ = cleanup(s);
}
pub fn endExclusive(backend: u32) c_int {
    mutex.lock();
    defer mutex.unlock();
    if (backend > c.ZC_LIBCAMERA) return c.ZC_INVALID;
    const s = &states[backend];
    var manager = s.manager;
    var layout = s.layout;
    manager.leaveExclusive() catch return c.ZC_STATE;
    layout.leaveExclusive() catch return c.ZC_STATE;
    s.manager = manager;
    s.layout = layout;
    return cleanup(s);
}
// Layout leases span logical clients even when a worker closes its SDK handle.
// They do not count as manager or tuning environment owners.
pub fn beginLayout(backend: u32) c_int {
    if (backend > c.ZC_LIBCAMERA) return c.ZC_INVALID;
    mutex.lock();
    defer mutex.unlock();
    _ = states[backend].layout.enterShared() catch |err| return if (err == error.Busy) c.ZC_BUSY else c.ZC_STATE;
    return c.ZC_OK;
}
pub fn endLayout(backend: u32) void {
    mutex.lock();
    defer mutex.unlock();
    _ = states[backend].layout.leaveShared() catch unreachable;
}
pub fn layoutUsers(backend: u32, count: *u32) c_int {
    count.* = 0;
    if (backend > c.ZC_LIBCAMERA) return c.ZC_INVALID;
    mutex.lock();
    defer mutex.unlock();
    count.* = states[backend].layout.users;
    return c.ZC_OK;
}
// Private bridge symbols: the real manager serializes these around all users.
pub export fn zct_tuning_manager_begin() c_int {
    return begin(c.ZC_LIBCAMERA);
}
pub export fn zct_tuning_manager_end() void {
    end(c.ZC_LIBCAMERA);
}
pub export fn zct_tuning_manager_exclusive_begin() c_int {
    return beginExclusive(c.ZC_LIBCAMERA);
}
pub export fn zct_tuning_manager_exclusive_end() c_int {
    return endExclusive(c.ZC_LIBCAMERA);
}

test "sessions own snapshots share exact data and conflict with live default managers" {
    const t = std.testing;
    const backend = c.ZC_SYNTHETIC;
    try t.expectEqual(c.ZC_OK, begin(backend));
    var a: ?*c.zc_tuning_session = null;
    try t.expectEqual(c.ZC_BUSY, create("{\"one\":1}", 9, backend, &a));
    end(backend);
    try t.expectEqual(c.ZC_OK, create("{\"one\":1}", 9, backend, &a));
    var b: ?*c.zc_tuning_session = null;
    try t.expectEqual(c.ZC_OK, create("{\"one\":1}", 9, backend, &b));
    var invalid: ?*c.zc_tuning_session = null;
    try t.expectEqual(c.ZC_BUSY, create("{\"one\":2}", 9, backend, &invalid));
    try t.expectEqual(c.ZC_OK, begin(backend));
    try t.expectEqual(c.ZC_OK, zc_tuning_session_close(a.?));
    try t.expectEqual(c.ZC_OK, zc_tuning_session_close(b.?));
    var state: c.zc_tuning_state = undefined;
    _ = zc_get_tuning_state(backend, &state);
    try t.expectEqual(@as(u32, 1), state.custom);
    try t.expectEqual(@as(u32, 0), state.session_users);
    end(backend);
    _ = zc_get_tuning_state(backend, &state);
    try t.expectEqual(@as(u32, 0), state.custom);
}
test "real manager environment restoration retains failed cleanup and never clobbers an external value" {
    const t = std.testing;
    const original = if (std.c.getenv(key)) |v| try A.dupeZ(u8, std.mem.span(v)) else null;
    defer {
        if (original) |v| {
            _ = setenv(key, v, 1);
            A.free(v);
        } else _ = unsetenv(key);
    }
    _ = setenv(key, "/previous/profile.json", 1);
    var token: ?*c.zc_tuning_session = null;
    try t.expectEqual(c.ZC_OK, create("{\"one\":1}", 9, c.ZC_LIBCAMERA, &token));
    try t.expectEqual(c.ZC_OK, begin(c.ZC_LIBCAMERA));
    const path = try A.dupe(u8, std.mem.span(std.c.getenv(key).?));
    defer A.free(path);
    const file = try std.fs.openFileAbsolute(path, .{});
    defer file.close();
    const bytes = try file.readToEndAlloc(t.allocator, 1024);
    defer t.allocator.free(bytes);
    try t.expectEqualStrings("{\"one\":1}", bytes);
    fail_restore = true;
    end(c.ZC_LIBCAMERA);
    try t.expectEqual(c.ZC_IO, zc_tuning_session_close(token.?));
    try t.expectEqualStrings(path, std.mem.span(std.c.getenv(key).?));
    fail_restore = false;
    fail_unlink = true;
    try t.expectEqual(c.ZC_IO, zc_tuning_session_close(token.?));
    try t.expectEqualStrings("/previous/profile.json", std.mem.span(std.c.getenv(key).?));
    fail_unlink = false;
    try t.expectEqual(c.ZC_OK, zc_tuning_session_close(token.?));
    try t.expectError(error.FileNotFound, std.fs.openFileAbsolute(path, .{}));
    try t.expectEqual(c.ZC_OK, create("{\"one\":1}", 9, c.ZC_LIBCAMERA, &token));
    try t.expectEqual(c.ZC_OK, begin(c.ZC_LIBCAMERA));
    _ = setenv(key, "/external/new.json", 1);
    try t.expectEqual(c.ZC_BUSY, begin(c.ZC_LIBCAMERA));
    end(c.ZC_LIBCAMERA);
    try t.expectEqualStrings("/external/new.json", std.mem.span(std.c.getenv(key).?));
    try t.expectEqual(c.ZC_OK, zc_tuning_session_close(token.?));
}
test "failed staging keeps identity until cleanup and retries a stranded stage" {
    const t = std.testing;
    var token: ?*c.zc_tuning_session = null;
    fail_stage_stat = true;
    try t.expectEqual(c.ZC_IO, create("{\"one\":1}", 9, c.ZC_LIBCAMERA, &token));
    try t.expectEqual(null, token);
    fail_stage_stat = false;
    try t.expectEqual(null, states[c.ZC_LIBCAMERA].profile);
    fail_stage_write = true;
    fail_unlink = true;
    try t.expectEqual(c.ZC_IO, create("{\"one\":1}", 9, c.ZC_LIBCAMERA, &token));
    try t.expectEqual(c.ZC_IO, create("{\"one\":1}", 9, c.ZC_LIBCAMERA, &token));
    fail_stage_write = false;
    fail_unlink = false;
    try t.expectEqual(c.ZC_OK, create("{\"one\":1}", 9, c.ZC_LIBCAMERA, &token));
    try t.expectEqual(c.ZC_OK, zc_tuning_session_close(token.?));
}
test "absent and empty environment values restore distinctly and replacement inodes survive" {
    const t = std.testing;
    const original = if (std.c.getenv(key)) |v| try A.dupeZ(u8, std.mem.span(v)) else null;
    defer {
        if (original) |v| {
            _ = setenv(key, v, 1);
            A.free(v);
        } else _ = unsetenv(key);
    }
    for ([_]bool{ false, true }) |empty| {
        if (empty) {
            _ = setenv(key, "", 1);
        } else _ = unsetenv(key);
        var token: ?*c.zc_tuning_session = null;
        try t.expectEqual(c.ZC_OK, create("{\"one\":1}", 9, c.ZC_LIBCAMERA, &token));
        try t.expectEqual(c.ZC_OK, begin(c.ZC_LIBCAMERA));
        end(c.ZC_LIBCAMERA);
        if (empty) try t.expectEqualStrings("", std.mem.span(std.c.getenv(key).?)) else try t.expectEqual(null, std.c.getenv(key));
        const path = try A.dupe(u8, states[c.ZC_LIBCAMERA].profile.?.path.?);
        defer A.free(path);
        try std.fs.deleteFileAbsolute(path);
        const replacement = try std.fs.createFileAbsolute(path, .{ .exclusive = true });
        try replacement.writeAll("replacement");
        replacement.close();
        try t.expectEqual(c.ZC_IO, begin(c.ZC_LIBCAMERA));
        try t.expectEqual(c.ZC_OK, zc_tuning_session_close(token.?));
        const saved = try std.fs.openFileAbsolute(path, .{});
        defer saved.close();
        const bytes = try saved.readToEndAlloc(t.allocator, 1024);
        defer t.allocator.free(bytes);
        try t.expectEqualStrings("replacement", bytes);
        try std.fs.deleteFileAbsolute(path);
    }
}

test "exclusive manager mutation excludes shared entry and pins profiles through final cleanup" {
    const t = std.testing;
    const backend = c.ZC_SYNTHETIC;
    const source: []const u8 = "{\"sensor\":true}";
    var session: ?*c.zc_tuning_session = null;
    try t.expectEqual(c.ZC_OK, create(source.ptr, source.len, backend, &session));
    try t.expectEqual(c.ZC_OK, beginExclusive(backend));
    var snapshot: c.zc_tuning_state = undefined;
    _ = zc_get_tuning_state(backend, &snapshot);
    try t.expectEqual(@as(u32, 1), snapshot.manager_users);
    const generation = snapshot.generation;
    try t.expectEqual(c.ZC_BUSY, begin(backend));
    try t.expectEqual(c.ZC_BUSY, beginExclusive(backend));
    try t.expectEqual(c.ZC_BUSY, zc_tuning_cleanup(backend));
    try t.expectEqual(c.ZC_OK, zc_tuning_session_close(session.?));
    session = null;
    _ = zc_get_tuning_state(backend, &snapshot);
    try t.expect(snapshot.custom == 1 and snapshot.session_users == 0 and snapshot.manager_users == 1);
    try t.expectEqual(generation, snapshot.generation);
    try t.expectEqual(c.ZC_OK, endExclusive(backend));
    _ = zc_get_tuning_state(backend, &snapshot);
    try t.expect(snapshot.custom == 0 and snapshot.manager_users == 0);
    try t.expectEqual(c.ZC_STATE, endExclusive(backend));
    try t.expectEqual(c.ZC_OK, begin(backend));
    try t.expectEqual(c.ZC_BUSY, beginExclusive(backend));
    end(backend);
}
