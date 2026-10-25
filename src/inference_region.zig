//! Guarded C projection of shared Home geometry. Inputs are snapshotted before
//! publication, so successful in-place value projection is supported.
const std = @import("std");
const c = @import("abi.zig").c;
pub const Home = @import("home/inference_region.zig");
fn size(s: c.zc_inference_size) Home.Size {
    return .{ .width = s.width, .height = s.height };
}
fn rect(r: c.zc_inference_rect) Home.Rect {
    return .{ .x = r.x, .y = r.y, .width = r.width, .height = r.height };
}
fn output(r: Home.Rect) c.zc_inference_rect {
    return .{ .x = r.x, .y = r.y, .width = r.width, .height = r.height };
}
fn plan(raw: ?*const c.zc_inference_geometry) !Home.Plan {
    const p = (raw orelse return error.InvalidGeometry).*;
    if (p.struct_size != @sizeOf(c.zc_inference_geometry) or p.flags & ~@as(u32, 1) != 0) return error.InvalidGeometry;
    return Home.Plan.init(size(p.full_sensor), size(p.sensor_output), size(p.isp_output), rect(p.scaler_crop), if (p.flags & 1 != 0) rect(p.roi) else null);
}
pub export fn zc_inference_project(raw: ?*const c.zc_inference_geometry, object: ?*const c.zc_inference_rect, destination: ?*c.zc_inference_rect) c_int {
    const out = destination orelse return c.ZC_INVALID;
    const source = (object orelse return c.ZC_INVALID).*;
    const projection = plan(raw) catch return c.ZC_INVALID;
    const result = projection.project(rect(source)) catch return c.ZC_INVALID;
    out.* = output(result);
    return c.ZC_OK;
}
pub export fn zc_inference_convert(raw: ?*const c.zc_inference_geometry, coordinates: ?[*]const f64, destination: ?*c.zc_inference_rect) c_int {
    const out = destination orelse return c.ZC_INVALID;
    const source = coordinates orelse return c.ZC_INVALID;
    const values = source[0..4].*;
    const projection = plan(raw) catch return c.ZC_INVALID;
    const result = projection.normalized(values) catch return c.ZC_INVALID;
    out.* = output(result);
    return c.ZC_OK;
}
pub export fn zc_inference_roi(raw: ?*const c.zc_inference_geometry, destination: ?*c.zc_inference_rect) c_int {
    const out = destination orelse return c.ZC_INVALID;
    const projection = plan(raw) catch return c.ZC_INVALID;
    const result = projection.roiScaled() catch return c.ZC_INVALID;
    out.* = output(result);
    return c.ZC_OK;
}
pub export fn zc_inference_aspect(full: ?*const c.zc_inference_size, ratio: ?*const c.zc_inference_size, destination: ?*c.zc_inference_rect) c_int {
    const out = destination orelse return c.ZC_INVALID;
    const f = (full orelse return c.ZC_INVALID).*;
    const r = (ratio orelse return c.ZC_INVALID).*;
    const result = Home.centeredAspect(size(f), size(r)) catch return c.ZC_INVALID;
    out.* = output(result);
    return c.ZC_OK;
}
test "inference C geometry snapshots values and rejects invalid inputs before output writes" {
    const t = std.testing;
    try t.expectEqual(@as(usize, 64), @sizeOf(c.zc_inference_geometry));
    var p = std.mem.zeroes(c.zc_inference_geometry);
    p.struct_size = @sizeOf(c.zc_inference_geometry);
    p.full_sensor = .{ .width = 100, .height = 80 };
    p.sensor_output = p.full_sensor;
    p.isp_output = .{ .width = 50, .height = 40 };
    p.scaler_crop = .{ .x = 0, .y = 0, .width = 100, .height = 80 };
    var r: c.zc_inference_rect = .{ .x = 20, .y = 20, .width = 40, .height = 40 };
    try t.expectEqual(c.ZC_OK, zc_inference_project(&p, &r, &r));
    try t.expectEqual(@as(u32, 20), r.width);
    const old = r;
    const coordinates = [_]f64{ 0, std.math.nan(f64), 1, 1 };
    try t.expectEqual(c.ZC_INVALID, zc_inference_convert(&p, &coordinates, &r));
    try t.expectEqualDeep(old, r);
    p.flags = 2;
    try t.expectEqual(c.ZC_INVALID, zc_inference_roi(&p, &r));
    try t.expectEqualDeep(old, r);
    try t.expectEqual(c.ZC_INVALID, zc_inference_project(null, &r, &r));
    try t.expectEqualDeep(old, r);
}
