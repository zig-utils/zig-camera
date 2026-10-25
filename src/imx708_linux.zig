//! Hosted sysfs association and pinned character-device IO. No camera-manager
//! ownership here; the public owner wraps mutations in the exclusive SDK scope.
const std = @import("std");
const c = @import("abi.zig").c;
const Pinned = @import("sensor_device.zig").Device("imx708");
const Identity = @import("home/device_identity.zig").Identity(c.ZC_MAX_CAMERA_ID);
extern fn zcd_imx708_control(c_int, u32, *u32, *i32) c_int;
fn ioctlError(code: c_int) anyerror {
    return switch (code) {
        c.ZC_BUSY => error.Busy,
        c.ZC_UNSUPPORTED => error.Unsupported,
        c.ZC_DISCONNECTED => error.Disconnected,
        c.ZC_IO => error.InputOutput,
        else => error.Device,
    };
}
pub const Device = struct {
    pinned: Pinned,
    first_errno: i32 = 0,
    pub fn open(id: Identity) !Device {
        var self = Device{ .pinned = try Pinned.open(id) };
        errdefer self.pinned.close();
        try self.validate();
        return self;
    }
    pub fn close(self: *Device) void {
        self.pinned.close();
    }
    pub fn reset(self: *Device) void {
        self.first_errno = 0;
    }
    fn call(self: *Device, operation: u32) !u32 {
        var value: u32 = 0;
        var native_errno: i32 = 0;
        const rc = zcd_imx708_control(self.pinned.file.handle, operation, &value, &native_errno);
        if (rc != c.ZC_OK) {
            if (self.first_errno == 0) self.first_errno = native_errno;
            return ioctlError(rc);
        }
        return value;
    }
    pub fn validate(self: *Device) !void {
        try self.pinned.validate();
        _ = try self.call(0);
    }
    pub fn read(self: *Device) !bool {
        return try self.call(1) != 0;
    }
    pub fn write(self: *Device, value: bool) !void {
        _ = try self.call(if (value) 3 else 2);
    }
};
