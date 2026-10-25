//! Shared pinned sysfs/character-device identity. No sensor IO or manager ownership.
const std = @import("std");
const node = @import("home/sensor_node.zig");
const Identity = @import("home/device_identity.zig").Identity(4096);
fn links(dir: std.fs.Dir, index: u32, id: []const u8, comptime expected_driver: []const u8) !bool {
    var path: [96]u8 = undefined;
    var driver: [node.max_path]u8 = undefined;
    var firmware: [node.max_path]u8 = undefined;
    const driver_path = try std.fmt.bufPrint(&path, "v4l-subdev{d}/device/driver", .{index});
    const d = dir.readLink(driver_path, &driver) catch |err| switch (err) {
        error.FileNotFound, error.NotLink => return false,
        else => return err,
    };
    const firmware_path = try std.fmt.bufPrint(&path, "v4l-subdev{d}/device/of_node", .{index});
    const f = dir.readLink(firmware_path, &firmware) catch |err| switch (err) {
        error.FileNotFound, error.NotLink => return false,
        else => return err,
    };
    return node.matches(id, d, f, expected_driver);
}
pub fn findIn(dir: std.fs.Dir, id: []const u8, comptime expected_driver: []const u8, max_entries: usize) !u32 {
    if (!node.validCameraId(id) or max_entries == 0) return error.Unsupported;
    var iterator = dir.iterate();
    var seen: usize = 0;
    var found: ?u32 = null;
    while (try iterator.next()) |entry| {
        if (seen == max_entries) return error.ScanLimit;
        seen += 1;
        const index = node.subdeviceIndex(entry.name) orelse continue;
        if (try links(dir, index, id, expected_driver)) {
            if (found != null) return error.AmbiguousSensor;
            found = index;
        }
    }
    return found orelse error.NoSensorNode;
}
fn find(id: []const u8, comptime expected_driver: []const u8) !u32 {
    var dir = std.fs.openDirAbsolute("/sys/class/video4linux", .{ .iterate = true }) catch |err| switch (err) {
        error.FileNotFound => return error.NoSensorNode,
        else => return err,
    };
    defer dir.close();
    return findIn(dir, id, expected_driver, 4096);
}
fn devicePath(index: u32, storage: []u8) ![]const u8 {
    return std.fmt.bufPrint(storage, "/dev/v4l-subdev{d}", .{index});
}
pub fn Device(comptime expected_driver: []const u8) type {
    return struct {
        const Self = @This();
        file: std.fs.File,
        identity: Identity,
        index: u32,
        rdev: u64,
        pub fn open(id: Identity) !Self {
            const index = try find(id.bytes(), expected_driver);
            var storage: [96]u8 = undefined;
            const device_path = try devicePath(index, &storage);
            const fd = try std.posix.open(device_path, .{ .ACCMODE = .RDWR, .NONBLOCK = true, .CLOEXEC = true, .NOFOLLOW = true }, 0);
            const file = std.fs.File{ .handle = fd };
            errdefer file.close();
            const info = try std.posix.fstat(fd);
            if (!std.posix.S.ISCHR(info.mode)) return error.Unsupported;
            var device = Self{ .file = file, .identity = id, .index = index, .rdev = @intCast(info.rdev) };
            // Recheck links and path identity after open; never accept a symlink or
            // a node replacement between enumeration and descriptor acquisition.
            try device.validate();
            return device;
        }
        pub fn close(self: *Self) void {
            self.file.close();
        }
        pub fn validate(self: *Self) !void {
            const current = find(self.identity.bytes(), expected_driver) catch |err| switch (err) {
                error.NoSensorNode => return error.Disconnected,
                else => return err,
            };
            if (current != self.index) return error.Disconnected;
            var storage: [96]u8 = undefined;
            const device_path = try devicePath(self.index, &storage);
            const actual = try std.posix.fstat(self.file.handle);
            const named = std.posix.fstatat(std.posix.AT.FDCWD, device_path, std.posix.AT.SYMLINK_NOFOLLOW) catch |err| switch (err) {
                error.FileNotFound => return error.Disconnected,
                else => return err,
            };
            if (!std.posix.S.ISCHR(actual.mode) or !std.posix.S.ISCHR(named.mode) or actual.rdev != self.rdev or named.rdev != self.rdev or actual.dev != named.dev or actual.ino != named.ino) return error.Disconnected;
        }
    };
}

fn fixture(dir: std.fs.Dir, index: u32, id: []const u8) !void {
    var storage: [128]u8 = undefined;
    try dir.makePath(try std.fmt.bufPrint(&storage, "v4l-subdev{d}/device", .{index}));
    try dir.symLink("../../../../bus/i2c/drivers/imx708", try std.fmt.bufPrint(&storage, "v4l-subdev{d}/device/driver", .{index}), .{});
    var target: [node.max_path]u8 = undefined;
    const link = try std.fmt.bufPrint(&target, "../../../firmware/devicetree{s}", .{id});
    try dir.symLink(link, try std.fmt.bufPrint(&storage, "v4l-subdev{d}/device/of_node", .{index}), .{});
}
test "sysfs selection scans beyond sixteen nodes matches exact identity and rejects duplicate associations" {
    const t = std.testing;
    var temporary = t.tmpDir(.{ .iterate = true });
    defer temporary.cleanup();
    const id = "/base/axi/rp1/i2c@80000/imx708@1a";
    try fixture(temporary.dir, 2, "/base/axi/rp1/i2c@80000/imx708@1ab");
    try fixture(temporary.dir, 127, id);
    try t.expectEqual(@as(u32, 127), try findIn(temporary.dir, id, "imx708", 4096));
    try t.expectError(error.NoSensorNode, findIn(temporary.dir, "/base/missing/imx708@1a", "imx708", 4096));
    try t.expectError(error.ScanLimit, findIn(temporary.dir, id, "imx708", 1));
    try fixture(temporary.dir, 129, id);
    try t.expectError(error.AmbiguousSensor, findIn(temporary.dir, id, "imx708", 4096));
}
test "sysfs selection refuses driver suffixes malformed links and invalid camera IDs" {
    const t = std.testing;
    var temporary = t.tmpDir(.{ .iterate = true });
    defer temporary.cleanup();
    const id = "/base/soc/i2c@1/imx708@1a";
    try fixture(temporary.dir, 0, id);
    try temporary.dir.deleteFile("v4l-subdev0/device/driver");
    try temporary.dir.symLink("../drivers/imx708fake", "v4l-subdev0/device/driver", .{});
    try t.expectError(error.NoSensorNode, findIn(temporary.dir, id, "imx708", 4096));
    try t.expectError(error.Unsupported, findIn(temporary.dir, "/base/../imx708@1a", "imx708", 4096));
    try temporary.dir.deleteFile("v4l-subdev0/device/driver");
    try temporary.dir.symLink("../drivers/imx708", "v4l-subdev0/device/driver", .{});
    try temporary.dir.deleteFile("v4l-subdev0/device/of_node");
    try t.expectError(error.NoSensorNode, findIn(temporary.dir, id, "imx708", 4096));
}

test "shared pinned association separates exact IMX500 driver and device identity" {
    var temporary = std.testing.tmpDir(.{ .iterate = true });
    defer temporary.cleanup();
    try fixture(temporary.dir, 127, "/base/soc/imx500@1a");
    try temporary.dir.deleteFile("v4l-subdev127/device/driver");
    try temporary.dir.symLink("../drivers/imx500", "v4l-subdev127/device/driver", .{});
    try std.testing.expectEqual(@as(u32, 127), try findIn(temporary.dir, "/base/soc/imx500@1a", "imx500", 4096));
    try std.testing.expectError(error.NoSensorNode, findIn(temporary.dir, "/base/soc/imx500@1a", "imx708", 4096));
    try std.testing.expectError(error.NoSensorNode, findIn(temporary.dir, "/base/soc/imx500@1ab", "imx500", 4096));
}
