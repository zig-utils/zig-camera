//! Caller-owned progress only; hosted network ownership lives behind the
//! existing bounded native output mailbox, with Bun owning socket lifecycles.
const std = @import("std");
const c = @import("abi.zig").c;
pub const Home = @import("home/socket_write.zig");
fn cursor(value: c.zc_socket_write_cursor) !Home.Cursor {
    if (value.struct_size != @sizeOf(c.zc_socket_write_cursor) or value.reserved != 0 or value.datagram > 1) return error.InvalidCursor;
    const result = Home.Cursor{ .total = value.total, .offset = value.offset, .chunk = value.chunk_bytes, .mode = if (value.datagram == 1) .datagram else .stream };
    _ = try result.next();
    return result;
}
pub export fn zc_socket_write_init(total: u64, chunk: u32, datagram: u32, out: *c.zc_socket_write_cursor) c_int {
    out.* = std.mem.zeroes(c.zc_socket_write_cursor);
    if (datagram > 1) return c.ZC_INVALID;
    _ = Home.Cursor.init(total, chunk, if (datagram == 1) .datagram else .stream) catch return c.ZC_INVALID;
    out.* = .{ .struct_size = @sizeOf(c.zc_socket_write_cursor), .datagram = datagram, .chunk_bytes = chunk, .reserved = 0, .total = total, .offset = 0 };
    return c.ZC_OK;
}
pub export fn zc_socket_write_next(input: *const c.zc_socket_write_cursor, offset: *u64, size: *u32) c_int {
    offset.* = 0;
    size.* = 0;
    const value = cursor(input.*) catch return c.ZC_INVALID;
    offset.* = value.offset;
    size.* = value.next() catch return c.ZC_INVALID;
    return c.ZC_OK;
}
pub export fn zc_socket_write_accept(input: *c.zc_socket_write_cursor, accepted: u32) c_int {
    var value = cursor(input.*) catch return c.ZC_INVALID;
    value.accept(accepted) catch return c.ZC_INVALID;
    input.offset = value.offset;
    return c.ZC_OK;
}
test "socket ABI validates caller state and keeps rejected progress atomic" {
    var state: c.zc_socket_write_cursor = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_socket_write_init(10, 4, 1, &state));
    try std.testing.expectEqual(@as(usize, 32), @sizeOf(c.zc_socket_write_cursor));
    try std.testing.expectEqual(c.ZC_INVALID, zc_socket_write_accept(&state, 2));
    try std.testing.expectEqual(@as(u64, 0), state.offset);
    try std.testing.expectEqual(c.ZC_OK, zc_socket_write_accept(&state, 4));
    var offset: u64 = 123;
    var size: u32 = 123;
    try std.testing.expectEqual(c.ZC_OK, zc_socket_write_next(&state, &offset, &size));
    try std.testing.expectEqual(@as(u64, 4), offset);
    try std.testing.expectEqual(@as(u32, 4), size);
    state.reserved = 1;
    try std.testing.expectEqual(c.ZC_INVALID, zc_socket_write_next(&state, &offset, &size));
    try std.testing.expectEqual(@as(u64, 0), offset);
    try std.testing.expectEqual(@as(u32, 0), size);
}
