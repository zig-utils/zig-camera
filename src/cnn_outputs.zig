//! Owned request metadata remains in Catalog. Shared Home code validates the
//! complete shape/value relation before any caller descriptor or pixels change.
const std = @import("std");
const c = @import("abi.zig").c;
const catalogs = @import("catalog.zig");
pub const Home = @import("home/cnn_outputs.zig");
const geometry = @import("home/tensor_layout.zig");
pub const max_output_bytes = 64 * 1024 * 1024;
fn limit(bytes: u64) !usize {
    if (bytes < 4 or bytes > max_output_bytes or bytes % 4 != 0) return error.InvalidLimit;
    return @intCast(bytes / 4);
}
fn order(value: u32) !geometry.Order {
    return switch (value) {
        c.ZC_CNN_COLUMN_MAJOR => .column_major,
        c.ZC_CNN_ROW_MAJOR => .row_major,
        else => error.InvalidOrder,
    };
}
fn status(err: anyerror) c_int {
    return switch (err) {
        error.OutOfMemory => c.ZC_NOMEM,
        error.UnsupportedTensorInfo => c.ZC_UNSUPPORTED,
        else => c.ZC_INVALID,
    };
}
fn span(p: ?[*]const u8, length: u64, maximum: usize) ![]const u8 {
    if (length > maximum or (p == null and length != 0)) return error.InvalidSpan;
    return if (length == 0) &.{} else p.?[0..@intCast(length)];
}
fn overlaps(a: []const u8, b: []const u8) bool {
    if (a.len == 0 or b.len == 0) return false;
    const x = @intFromPtr(a.ptr);
    const y = @intFromPtr(b.ptr);
    return if (x >= y) x - y < b.len else y - x < a.len;
}
fn descriptor(model: *const Home.Outputs, target_order: geometry.Order) !c.zc_cnn_outputs_info {
    var result = std.mem.zeroes(c.zc_cnn_outputs_info);
    result.struct_size = @sizeOf(c.zc_cnn_outputs_info);
    result.present = 1;
    result.tensor_count = model.info.count;
    result.frame_count = model.info.frame_count;
    result.network_name_length = model.info.name_length;
    result.order = if (target_order == .row_major) 1 else 0;
    result.value_count = model.info.values;
    @memcpy(&result.network_name, &model.info.network_name);
    for (model.info.tensors[0..model.info.count], 0..) |optional, i| {
        const tensor = optional.?;
        const plan = try geometry.Layout.init(tensor.layout.shape[0..tensor.layout.rank], target_order, model.info.values);
        result.tensors[i].count = @intCast(plan.elements);
        result.tensors[i].rank = plan.rank;
        result.tensors[i].offset = tensor.offset;
        @memcpy(&result.tensors[i].shape, &plan.shape);
        for (plan.strides, 0..) |stride, axis| result.tensors[i].strides[axis] = stride;
    }
    return result;
}
fn emit(model: ?*const Home.Outputs, target_order: geometry.Order, source: []const u8, out_info: ?*c.zc_cnn_outputs_info, output: ?[*]f32, capacity: u64) !void {
    const info = out_info orelse return error.InvalidOutput;
    const count = if (model) |value| value.info.values else 0;
    if ((output == null and capacity != 0) or (output != null and capacity < count)) return error.OutputTooSmall;
    const header_bytes = std.mem.asBytes(info);
    if (overlaps(header_bytes, source)) return error.AliasedOutput;
    if (output) |data| {
        const target = data[0..count];
        if (overlaps(std.mem.sliceAsBytes(target), source) or overlaps(std.mem.sliceAsBytes(target), header_bytes)) return error.AliasedOutput;
    }
    var header = std.mem.zeroes(c.zc_cnn_outputs_info);
    header.struct_size = @sizeOf(c.zc_cnn_outputs_info);
    header.order = if (target_order == .row_major) 1 else 0;
    if (model) |value| {
        header = try descriptor(value, target_order);
        if (output) |data| try value.copy(data[0..count], target_order);
    }
    info.* = header;
}
pub export fn zc_decode_cnn_outputs(info_bytes: ?[*]const u8, info_length: u64, values: ?[*]const u8, values_length: u64, big_endian: u32, target_order: u32, max_bytes: u64, out_info: ?*c.zc_cnn_outputs_info, output: ?[*]f32, capacity: u64) c_int {
    const max_values = limit(max_bytes) catch return c.ZC_INVALID;
    const target = order(target_order) catch return c.ZC_INVALID;
    if (big_endian > 1) return c.ZC_INVALID;
    const bytes = span(info_bytes, info_length, 712) catch return c.ZC_INVALID;
    const data = span(values, values_length, @intCast(max_bytes)) catch return c.ZC_INVALID;
    const model = Home.Outputs.fromRaw(bytes, data, if (big_endian != 0) .big else .little, max_values) catch |err| return status(err);
    if (out_info) |info| {
        if (overlaps(std.mem.asBytes(info), bytes)) return c.ZC_INVALID;
        if (output) |dest| if (capacity >= model.info.values and overlaps(std.mem.sliceAsBytes(dest[0..model.info.values]), bytes)) return c.ZC_INVALID;
    }
    emit(&model, target, data, out_info, output, capacity) catch |err| return status(err);
    return c.ZC_OK;
}
pub export fn zc_cnn_catalog_outputs(raw: ?*const c.zc_catalog, target_order: u32, max_bytes: u64, out_info: ?*c.zc_cnn_outputs_info, output: ?[*]f32, capacity: u64) c_int {
    const max_values = limit(max_bytes) catch return c.ZC_INVALID;
    const target = order(target_order) catch return c.ZC_INVALID;
    const pointer = raw orelse return c.ZC_INVALID;
    const catalog: *const catalogs.Catalog = @ptrCast(@alignCast(pointer));
    const bytes = catalog.writer.finish() catch |err| return status(err);
    if (bytes.len > max_output_bytes + 65536) return c.ZC_INVALID;
    const optional = Home.Outputs.fromCatalog(bytes, max_values) catch |err| return status(err);
    if (optional) |model| emit(&model, target, bytes, out_info, output, capacity) catch |err| {
        return status(err);
    } else emit(null, target, bytes, out_info, output, capacity) catch |err| {
        return status(err);
    };
    return c.ZC_OK;
}
pub export fn zc_cnn_tensor_row_major(raw: ?*const c.zc_cnn_tensor, source_order: u32, source: ?[*]const f32, count: u64, output: ?[*]f32, capacity: u64) c_int {
    const tensor = raw orelse return c.ZC_INVALID;
    if (tensor.rank > 16 or count > max_output_bytes / 4 or count != tensor.count or capacity < count or (source == null and count != 0) or (output == null and count != 0)) return c.ZC_INVALID;
    const selected = order(source_order) catch return c.ZC_INVALID;
    const source_data: []const f32 = if (count != 0) source.?[0..@intCast(count)] else &.{};
    const target_data: []f32 = if (count != 0) output.?[0..@intCast(count)] else &.{};
    if (overlaps(std.mem.asBytes(tensor), std.mem.sliceAsBytes(target_data))) return c.ZC_INVALID;
    Home.copyTensorRowMajor(tensor.shape[0..tensor.rank], source_data, selected, target_data) catch |err| return status(err);
    return c.ZC_OK;
}

test "canonical CNN descriptors and float outputs publish together with atomic rejection" {
    const t = std.testing;
    try t.expectEqual(@as(usize, 208), @sizeOf(c.zc_cnn_tensor));
    try t.expectEqual(@as(usize, 3424), @sizeOf(c.zc_cnn_outputs_info));
    var bytes: [712]u8 = @splat(0);
    @memcpy(bytes[0..3], "cnn");
    std.mem.writeInt(u32, bytes[64..68], 1, .little);
    std.mem.writeInt(u32, bytes[68..72], 6, .little);
    std.mem.writeInt(u32, bytes[72..76], 2, .little);
    std.mem.writeInt(u16, bytes[76..78], 2, .little);
    std.mem.writeInt(u16, bytes[78..80], 3, .little);
    bytes[708] = 19;
    const values = [_]f32{ 0, 1, 2, 3, 4, 5 };
    const data = std.mem.sliceAsBytes(&values);
    var result: c.zc_cnn_outputs_info = undefined;
    try t.expectEqual(c.ZC_OK, zc_decode_cnn_outputs(&bytes, bytes.len, data.ptr, data.len, 0, 0, 24, &result, null, 0));
    try t.expectEqual(@as(u32, 1), result.present);
    try t.expectEqual(@as(u64, 6), result.value_count);
    try t.expectEqual(@as(u64, 2), result.tensors[0].strides[1]);
    var output: [7]f32 = @splat(17);
    try t.expectEqual(c.ZC_OK, zc_decode_cnn_outputs(&bytes, bytes.len, data.ptr, data.len, 0, 1, 24, &result, &output, output.len));
    try t.expectEqualSlices(f32, &.{ 0, 2, 4, 1, 3, 5 }, output[0..6]);
    try t.expectEqual(@as(f32, 17), output[6]);
    try t.expectEqual(@as(u64, 3), result.tensors[0].strides[0]);
    const before = result;
    const old = output;
    try t.expectEqual(c.ZC_INVALID, zc_decode_cnn_outputs(&bytes, bytes.len, data.ptr, data.len, 0, 1, 24, &result, &output, 5));
    try t.expectEqualSlices(u8, std.mem.asBytes(&before), std.mem.asBytes(&result));
    try t.expectEqualSlices(f32, &old, &output);
    try t.expectEqual(c.ZC_INVALID, zc_decode_cnn_outputs(&bytes, bytes.len, data.ptr, data.len, 2, 1, 24, &result, &output, 7));
    try t.expectEqual(c.ZC_INVALID, zc_decode_cnn_outputs(&bytes, bytes.len, data.ptr, data.len, 0, 0, 24, &result, @constCast(&values), 6));
    try t.expectEqual(c.ZC_INVALID, zc_cnn_tensor_row_major(&before.tensors[0], 1, output[0..].ptr, 6, output[0..].ptr, 6));
}
