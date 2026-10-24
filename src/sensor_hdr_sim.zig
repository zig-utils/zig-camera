//! Virtual sensor-layout control. Never simulates HDR image fusion or optics.
const std = @import("std");
var mutex: std.Thread.Mutex = .{};
var hdr = false;
pub fn enabled() bool {
    mutex.lock();
    defer mutex.unlock();
    return hdr;
}
pub fn set(value: bool) void {
    mutex.lock();
    defer mutex.unlock();
    hdr = value;
}
