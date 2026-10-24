const std = @import("std");
const c = @import("abi.zig").c;
pub const Tail = @import("home/byte_tail.zig").Tail;
pub const Wire = @import("home/process_output_wire.zig");
fn tail(state: c.zc_byte_tail_state, arena: ?[*]const u8, capacity: u64) !Tail {
    if (state.struct_size != @sizeOf(c.zc_byte_tail_state) or state.reserved != 0 or state.capacity != capacity or capacity > 1024 * 1024 or state.length > capacity or state.head > capacity or (capacity != 0 and arena == null)) return error.InvalidState;
    const bytes: []u8 = if (capacity == 0) @constCast(&.{}) else @constCast(arena.?[0..@intCast(capacity)]);
    const result = Tail{ .arena = bytes, .head = @intCast(state.head), .len = @intCast(state.length), .total = state.total };
    try result.validate();
    return result;
}
pub export fn zc_byte_tail_init(capacity: u64, out: *c.zc_byte_tail_state) c_int {
    out.* = std.mem.zeroes(c.zc_byte_tail_state);
    if (capacity > 1024 * 1024) return c.ZC_INVALID;
    out.* = .{ .struct_size = @sizeOf(c.zc_byte_tail_state), .reserved = 0, .capacity = capacity, .head = 0, .length = 0, .total = 0 };
    return c.ZC_OK;
}
pub export fn zc_byte_tail_append(state: *c.zc_byte_tail_state, arena: ?[*]u8, capacity: u64, input: ?[*]const u8, length: u64) c_int {
    if (length > 16 * 1024 * 1024 or (length != 0 and input == null)) return c.ZC_INVALID;
    var value = tail(state.*, arena, capacity) catch return c.ZC_INVALID;
    value.append(if (length == 0) &.{} else input.?[0..@intCast(length)]) catch return c.ZC_INVALID;
    state.head = value.head;
    state.length = value.len;
    state.total = value.total;
    return c.ZC_OK;
}
pub export fn zc_byte_tail_copy(state: *const c.zc_byte_tail_state, arena: ?[*]const u8, capacity: u64, output: ?[*]u8, output_capacity: u64, length: *u64) c_int {
    length.* = 0;
    const value = tail(state.*, arena, capacity) catch return c.ZC_INVALID;
    length.* = value.len;
    if (output == null) return if (output_capacity == 0) c.ZC_OK else c.ZC_INVALID;
    if (output_capacity < value.len) return c.ZC_INVALID;
    _ = value.copy(output.?[0..value.len]) catch return c.ZC_INVALID;
    return c.ZC_OK;
}
pub export fn zc_process_output_decode(input: ?[*]const u8, length: u32, out: *c.zc_process_output_message) c_int {
    out.* = std.mem.zeroes(c.zc_process_output_message);
    if (input == null or length != Wire.size) return c.ZC_INVALID;
    const value = Wire.decode(input.?[0..length]) catch return c.ZC_INVALID;
    out.* = .{ .struct_size = @sizeOf(c.zc_process_output_message), .kind = @intFromEnum(value.kind), .status = value.status, .reserved = 0, .supervisor_pid = value.supervisor, .consumer_pid = value.consumer };
    return c.ZC_OK;
}
test "diagnostic tail C ABI preserves query, short destination and invalid state" {
    var state: c.zc_byte_tail_state = undefined;
    var arena: [4]u8 = undefined;
    var output: [4]u8 = @splat(0xa5);
    var length: u64 = 0;
    try std.testing.expectEqual(@as(usize, 40), @sizeOf(c.zc_byte_tail_state));
    try std.testing.expectEqual(c.ZC_OK, zc_byte_tail_init(4, &state));
    try std.testing.expectEqual(c.ZC_OK, zc_byte_tail_append(&state, &arena, 4, "abcdef", 6));
    try std.testing.expectEqual(c.ZC_OK, zc_byte_tail_copy(&state, &arena, 4, null, 0, &length));
    try std.testing.expectEqual(@as(u64, 4), length);
    try std.testing.expectEqual(c.ZC_INVALID, zc_byte_tail_copy(&state, &arena, 4, &output, 3, &length));
    for (output) |byte| try std.testing.expectEqual(@as(u8, 0xa5), byte);
    try std.testing.expectEqual(c.ZC_OK, zc_byte_tail_copy(&state, &arena, 4, &output, 4, &length));
    try std.testing.expectEqualStrings("cdef", &output);
    state.reserved = 1;
    try std.testing.expectEqual(c.ZC_INVALID, zc_byte_tail_copy(&state, &arena, 4, &output, 4, &length));
    try std.testing.expectEqual(@as(u64, 0), length);
}
test "supervisor C ABI validates records before publishing PID or exit fields" {
    const bytes = try Wire.encode(.{ .kind = .result, .status = 42, .supervisor = 123, .consumer = 456 });
    var out: c.zc_process_output_message = undefined;
    try std.testing.expectEqual(@as(usize, 32), @sizeOf(c.zc_process_output_message));
    try std.testing.expectEqual(c.ZC_OK, zc_process_output_decode(&bytes, bytes.len, &out));
    try std.testing.expectEqual(@as(u32, 42), out.status);
    try std.testing.expectEqual(@as(u64, 456), out.consumer_pid);
    try std.testing.expectEqual(c.ZC_INVALID, zc_process_output_decode(&bytes, 31, &out));
    try std.testing.expectEqual(@as(u64, 0), out.consumer_pid);
}
