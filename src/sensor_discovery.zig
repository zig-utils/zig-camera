//! Shared exact discovery/model selection; all IDs and namespaces are validated.
const std = @import("std");
const c = @import("abi.zig").c;
const options = @import("options");
const Catalog = @import("catalog.zig");
const Wire = Catalog.wire;
const Identity = @import("home/device_identity.zig").Identity(c.ZC_MAX_CAMERA_ID);
pub fn selected(reader: Wire.Reader, backend: u32, index: u32, requested: ?Identity, expected_model: []const u8) !Identity {
    if (reader.catalog_kind != c.ZC_CATALOG_DISCOVERY) return error.InvalidCatalog;
    var identities: [64]Identity = undefined;
    var count: usize = 0;
    var selection: ?Identity = null;
    var records = reader.records();
    while (try records.next()) |record| {
        if (!std.mem.eql(u8, record.info.name, "CameraId")) continue;
        if (record.info.group != count or count == identities.len) return error.InvalidCatalog;
        const id = try reader.findString(.{ .group = record.info.group, .name = "CameraId", .vendors = &.{ "", "libcamera", "synthetic" } }) orelse return error.InvalidCatalog;
        const key = try Identity.init(id);
        for (identities[0..count]) |*previous| if (previous.matches(id)) return error.InvalidCatalog;
        identities[count] = key;
        count += 1;
        const model = try reader.findString(.{ .group = record.info.group, .name = "Model", .vendors = &.{ "", "libcamera", "synthetic" } });
        const matches = if (requested) |*value| value.matches(id) else index == std.math.maxInt(u32) or index == record.info.group;
        if (!matches) continue;
        const supported = if (backend == c.ZC_SYNTHETIC) key.matches("synthetic") else model != null and std.mem.eql(u8, model.?, expected_model);
        if (!supported) {
            if (requested != null or index != std.math.maxInt(u32)) return error.Unsupported;
            continue;
        }
        if (selection == null) selection = key;
    }
    return selection orelse error.NoCamera;
}
pub fn discover(backend: u32, index: u32, requested: ?Identity, expected_model: []const u8) !Identity {
    const snapshot = try Catalog.Catalog.create(c.ZC_CATALOG_DISCOVERY);
    defer snapshot.destroy();
    const sink = snapshot.sink();
    const rc = if (backend == c.ZC_SYNTHETIC) @import("synthetic.zig").discover(&sink) else if (options.libcamera) @import("real.zig").discover(&sink) else c.ZC_UNSUPPORTED;
    if (rc != c.ZC_OK) return switch (rc) {
        c.ZC_BUSY => error.Busy,
        c.ZC_NOMEM => error.OutOfMemory,
        c.ZC_UNSUPPORTED => error.Unsupported,
        else => error.Device,
    };
    return selected(try Wire.Reader.init(try snapshot.writer.finish()), backend, index, requested, expected_model);
}
