const c = @import("abi.zig").c;
pub const Handle = opaque {};
pub const Callback = *const fn (?*anyopaque, u32, ?*const c.zc_frame, ?*const c.zc_metadata, c_int) callconv(.c) void;
pub extern fn zcd_open(*const c.zc_config, *const c.zc_pipeline_options, ?*anyopaque, Callback, *?*Handle, *c.zc_info, *c.zc_pipeline_info) c_int;
pub extern fn zcd_start(*Handle) c_int;
pub extern fn zcd_queue(*Handle, u32) c_int;
pub extern fn zcd_sync(*Handle, u32, bool) c_int;
pub extern fn zcd_stop(*Handle) c_int;
pub extern fn zcd_close(*Handle) void;
pub const open = zcd_open;
pub const start = zcd_start;
pub const queue = zcd_queue;
pub const sync = zcd_sync;
pub extern fn zcd_enable_writable(*Handle) c_int;
pub const enableWritable = zcd_enable_writable;
pub const stop = zcd_stop;
pub const close = zcd_close;

pub extern fn zcd_metadata(*Handle, u32, *c.zc_raw_metadata) c_int;
pub const metadata = zcd_metadata;

pub extern fn zcd_control_info(*Handle, u32, *c.zc_control_info) c_int;
pub extern fn zcd_set_controls(*Handle, [*]const c.zc_control, u32, *u64) c_int;
pub const controlInfo = zcd_control_info;
pub const setControls = zcd_set_controls;

pub extern fn zcd_sensor_modes(*Handle, ?[*]c.zc_sensor_mode, u32, *u32) c_int;
pub extern fn zcd_lores(*Handle, u32, *c.zc_stream) c_int;
pub const sensorModes = zcd_sensor_modes;
pub const lores = zcd_lores;

pub extern fn zcd_discover(*const @import("catalog.zig").Sink) c_int;
pub extern fn zcd_catalog(*Handle, u32, u32, *const @import("catalog.zig").Sink) c_int;
pub const discover = zcd_discover;
pub const catalog = zcd_catalog;

pub extern fn zcd_open_id(*const c.zc_config, *const c.zc_pipeline_options, [*]const u8, u32, ?*anyopaque, Callback, *?*Handle, *c.zc_info, *c.zc_pipeline_info) c_int;
pub extern fn zcd_camera_id(*Handle, ?[*]u8, u64, *u64) c_int;
pub fn openId(cfg: *const c.zc_config, pipeline: *const c.zc_pipeline_options, id: []const u8, context: ?*anyopaque, callback: Callback, out: *?*Handle, info: *c.zc_info, negotiated: *c.zc_pipeline_info) c_int {
    return zcd_open_id(cfg, pipeline, id.ptr, @intCast(id.len), context, callback, out, info, negotiated);
}
pub const cameraId = zcd_camera_id;

pub const PreparedControls = opaque {};
pub extern fn zcd_prepare_native_controls(*Handle, [*]const @import("native_controls.zig").Input, u32, *const @import("catalog.zig").Sink, *?*PreparedControls) c_int;
pub extern fn zcd_commit_native_controls(*Handle, *PreparedControls, *u64) c_int;
pub extern fn zcd_close_native_controls(*PreparedControls) void;
pub const prepareNative = zcd_prepare_native_controls;
pub const commitNative = zcd_commit_native_controls;
pub const closeNative = zcd_close_native_controls;
