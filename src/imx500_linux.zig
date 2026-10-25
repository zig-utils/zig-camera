//! Pinned descriptor plus system-header IO. Kernel control cache survives
//! stream restarts; no libcamera manager or camera-buffer ownership is taken.
const std = @import("std");
const c = @import("abi.zig").c;
const Pinned = @import("sensor_device.zig").Device("imx500");
const Identity = @import("home/device_identity.zig").Identity(c.ZC_MAX_CAMERA_ID);
pub const roi_id = 0x00982900;
pub const device_id = 0x00982902;
extern fn zcd_imx500_query(c_int, u32, *c.zc_imx500_control_info, *i32) c_int;
extern fn zcd_imx500_transfer(c_int, u32, u32, ?[*]const u32, ?[*]u32, *i32) c_int;
fn failure(code: c_int) anyerror {
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
        return .{ .pinned = try Pinned.open(id) };
    }
    pub fn close(self: *Device) void {
        self.pinned.close();
    }
    pub fn reset(self: *Device) void {
        self.first_errno = 0;
    }
    fn query(self: *Device, id: u32) !c.zc_imx500_control_info {
        var info: c.zc_imx500_control_info = undefined;
        var native_errno: i32 = 0;
        const rc = zcd_imx500_query(self.pinned.file.handle, id, &info, &native_errno);
        if (rc != c.ZC_OK) {
            if (self.first_errno == 0) self.first_errno = native_errno;
            return failure(rc);
        }
        return info;
    }
    pub fn validate(self: *Device) !c.zc_imx500_control_info {
        try self.pinned.validate();
        return self.query(roi_id);
    }
    fn transfer(self: *Device, id: u32, input: ?[4]u32) ![4]u32 {
        var out: [4]u32 = undefined;
        var native_errno: i32 = 0;
        const rc = zcd_imx500_transfer(self.pinned.file.handle, id, @intFromBool(input != null), if (input) |*value| value else null, &out, &native_errno);
        if (rc != c.ZC_OK) {
            if (self.first_errno == 0) self.first_errno = native_errno;
            return failure(rc);
        }
        return if (input) |value| value else out;
    }
    pub fn read(self: *Device) ![4]u32 {
        return self.transfer(roi_id, null);
    }
    pub fn write(self: *Device, value: [4]u32) !void {
        _ = try self.transfer(roi_id, value);
    }
    pub fn deviceId(self: *Device) ![4]u32 {
        _ = try self.query(device_id);
        return self.transfer(device_id, null);
    }
};
