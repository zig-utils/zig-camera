const std = @import("std");
pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const libcamera = b.option(bool, "libcamera", "Build the Linux libcamera backend") orelse (target.result.os.tag == .linux);
    const jpeg = b.option(bool, "jpeg", "Enable system libjpeg encoding") orelse (target.result.os.tag == .linux);
    if (libcamera and target.result.os.tag != .linux) @panic("libcamera requires Linux");
    const options = b.addOptions();
    options.addOption(bool, "libcamera", libcamera);
    options.addOption(bool, "jpeg", jpeg);
    const mod = b.addModule("camera", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    mod.addOptions("options", options);
    mod.addIncludePath(b.path("include"));
    if (libcamera) {
        mod.addCSourceFile(.{ .file = b.path("native/libcamera.cpp"), .flags = &.{ "-std=c++17", "-Wall", "-Wextra", "-Werror" } });
        mod.linkSystemLibrary("libcamera", .{ .use_pkg_config = .force });
        mod.link_libcpp = true;
    }
    if (jpeg) {
        mod.addCSourceFile(.{ .file = b.path("native/jpeg.c"), .flags = &.{ "-std=c11", "-Wall", "-Wextra", "-Werror" } });
        mod.linkSystemLibrary("libjpeg", .{ .use_pkg_config = .force });
    }
    const lib = b.addLibrary(.{ .name = "zigcamera", .linkage = .dynamic, .root_module = mod });
    b.installArtifact(lib);
    lib.installHeader(b.path("include/zig_camera.h"), "zig_camera.h");
    const exe = b.addExecutable(.{ .name = "zig-camera", .root_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "camera", .module = mod }},
    }) });
    b.installArtifact(exe);
    const run = b.addRunArtifact(exe);
    if (b.args) |args| run.addArgs(args);
    b.step("run", "Run the capture CLI").dependOn(&run.step);
    const tests = b.addTest(.{ .root_module = mod });
    b.step("test", "Run core, image and backend tests").dependOn(&b.addRunArtifact(tests).step);
    const bench = b.addExecutable(.{ .name = "camera-bench", .root_module = b.createModule(.{
        .root_source_file = b.path("bench/core.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "camera", .module = mod }},
    }) });
    const benchmark = b.addRunArtifact(bench);
    if (b.args) |args| benchmark.addArgs(args);
    b.step("bench", "Run synthetic ownership and image microbenchmarks").dependOn(&benchmark.step);
}
