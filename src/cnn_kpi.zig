const std = @import("std");
const c = @import("abi.zig").c;
const catalogs = @import("catalog.zig");
pub const Home = @import("home/cnn_kpi.zig");
pub fn descriptor(value: ?Home.Info) c.zc_cnn_kpi_info {
    var result = std.mem.zeroes(c.zc_cnn_kpi_info);
    result.struct_size = @sizeOf(c.zc_cnn_kpi_info);
    if (value) |info| {
        const ms = info.picameraMilliseconds();
        result.present = 1;
        result.dnn_raw = info.dnn_raw;
        result.dsp_raw = info.dsp_raw;
        result.picamera_dnn_ms = ms[0];
        result.picamera_dsp_ms = ms[1];
    }
    return result;
}
pub export fn zc_decode_cnn_kpi(raw: ?[*]const u8, length: u64, big_endian: u32, destination: ?*c.zc_cnn_kpi_info) c_int {
    const out = destination orelse return c.ZC_INVALID;
    if (raw == null or length != 8 or big_endian > 1) return c.ZC_INVALID;
    const info = Home.Info.fromRaw(raw.?[0..8], if (big_endian != 0) .big else .little) catch return c.ZC_INVALID;
    out.* = descriptor(info);
    return c.ZC_OK;
}
pub export fn zc_cnn_kpi_catalog(raw: ?*const c.zc_catalog, destination: ?*c.zc_cnn_kpi_info) c_int {
    const out = destination orelse return c.ZC_INVALID;
    const pointer = raw orelse return c.ZC_INVALID;
    const owner: *const catalogs.Catalog = @ptrCast(@alignCast(pointer));
    const bytes = owner.writer.finish() catch return c.ZC_INVALID;
    const value = Home.Info.fromCatalog(bytes) catch return c.ZC_INVALID;
    out.* = descriptor(value);
    return c.ZC_OK;
}
test "KPI C descriptor preserves signed counters conversion and destination on rejection" {
    const t = std.testing;
    try t.expectEqual(@as(usize, 32), @sizeOf(c.zc_cnn_kpi_info));
    const raw = [_]u8{ 0x88, 0x13, 0, 0, 0xe8, 3, 0, 0 };
    var result: c.zc_cnn_kpi_info = undefined;
    try t.expectEqual(c.ZC_OK, zc_decode_cnn_kpi(&raw, 8, 0, &result));
    try t.expectEqual(@as(i32, 5000), result.dnn_raw);
    try t.expectEqual(@as(f64, 5), result.picamera_dnn_ms);
    const old = result;
    try t.expectEqual(c.ZC_INVALID, zc_decode_cnn_kpi(&raw, 7, 0, &result));
    try t.expectEqualDeep(old, result);
}
