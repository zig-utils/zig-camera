const std = @import("std");
pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const libcamera = b.option(bool, "libcamera", "Build the Linux libcamera backend") orelse (target.result.os.tag == .linux);
    const jpeg = b.option(bool, "jpeg", "Use system JPEG acceleration instead of the Home encoder") orelse false;
    if (libcamera and target.result.os.tag != .linux) @panic("libcamera requires Linux");
    const preview = b.option(bool, "preview", "Enable SDL2 windowed preview") orelse false;
    const video = b.option(bool, "video", "Enable Home recording") orelse true;
    const codecs = b.option(bool, "codecs", "Enable Home x264/x265 codecs (system libraries)") orelse false;
    const aac = b.option(bool, "aac", "Enable Home AAC-LC codec (standalone FDK library)") orelse false;
    const audio = b.option(bool, "audio", "Enable Linux ALSA audio capture") orelse false;
    if (audio and target.result.os.tag != .linux) @panic("ALSA capture requires Linux");
    const options = b.addOptions();
    options.addOption(bool, "audio", audio);
    options.addOption(bool, "aac", aac);
    options.addOption(bool, "codecs", codecs);
    options.addOption(bool, "preview", preview);
    options.addOption(bool, "video", video);
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
    mod.addIncludePath(b.path("src/home"));
    if (aac) {
        mod.addCSourceFile(.{ .file = b.path("src/home/native_aac.c"), .flags = &.{ "-std=c11", "-Wall", "-Wextra", "-Werror" } });
        mod.linkSystemLibrary("fdk-aac", .{ .use_pkg_config = .force });
    }
    if (audio) {
        mod.addCSourceFile(.{ .file = b.path("src/home/native_capture.c"), .flags = &.{ "-std=c11", "-Wall", "-Wextra", "-Werror" } });
        mod.linkSystemLibrary("alsa", .{ .use_pkg_config = .force });
    }
    if (codecs) {
        mod.addCSourceFile(.{ .file = b.path("src/home/native_encoder.c"), .flags = &.{ "-std=c11", "-Wall", "-Wextra", "-Werror" } });
        mod.linkSystemLibrary("x264", .{ .use_pkg_config = .force });
        mod.linkSystemLibrary("x265", .{ .use_pkg_config = .force });
    }
    if (libcamera) {
        if (target.result.cpu.arch != @import("builtin").cpu.arch)
            @panic("Build the libcamera backend natively with the target system's C++ toolchain and libcamera packages");
        // libcamera's public API contains STL types. Compile/link its boundary
        // with the distribution C++ runtime, not Zig's bundled libc++.
        const bridge = b.addSystemCommand(&.{ "sh", "-c", "exec \"${CXX:-c++}\" -std=c++17 -O2 -fPIC -shared -Wall -Wextra -Werror -I\"$1\" \"$2\" -Wl,-soname,libzigcamera_driver.so -o \"$3\" $(pkg-config --cflags --libs libcamera)", "--" });
        bridge.addDirectoryArg(b.path("include"));
        bridge.addFileArg(b.path("native/libcamera.cpp"));
        bridge.addFileInput(b.path("include/zig_camera.h"));
        bridge.addFileInput(b.path("include/zig_camera_catalog_bridge.h"));
        const driver_lib = bridge.addOutputFileArg("libzigcamera_driver.so");
        mod.addObjectFile(driver_lib);
        mod.addRPath(driver_lib.dirname());
        mod.addRPathSpecial("$ORIGIN");
        mod.addRPathSpecial("$ORIGIN/../lib");
        b.getInstallStep().dependOn(&b.addInstallFileWithDir(driver_lib, .lib, "libzigcamera_driver.so").step);
    }
    if (jpeg) {
        mod.addCSourceFile(.{ .file = b.path("native/jpeg.c"), .flags = &.{ "-std=c11", "-Wall", "-Wextra", "-Werror" } });
        mod.linkSystemLibrary("libjpeg", .{ .use_pkg_config = .force });
    }
    if (preview) {
        mod.addCSourceFile(.{ .file = b.path("native/preview.c"), .flags = &.{ "-std=c11", "-Wall", "-Wextra", "-Werror" } });
        mod.linkSystemLibrary("sdl2", .{ .use_pkg_config = .force });
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
