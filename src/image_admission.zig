//! Hosted image owners share the existing four-slot, 512 MiB reservation.
const std = @import("std");
const Registry = @import("home/owned_admission.zig").Registry(4);
pub const Ticket = Registry.Ticket;
var registry: Registry = .{ .max_bytes = 512 * 1024 * 1024, .max_items = 4 };
var mutex: std.Thread.Mutex = .{};
pub fn reserve(bytes: usize) !Ticket {
    mutex.lock();
    defer mutex.unlock();
    return registry.reserve(bytes);
}
pub fn release(ticket: Ticket) void {
    mutex.lock();
    defer mutex.unlock();
    registry.release(ticket) catch unreachable;
}
