# Home APNG foundation

`camera.ApngEncoder` reuses Home's checked animation encoder. It accepts borrowed
`raster.View` descriptors or explicitly owned capture copies; it does not retain
camera handles, request leases, pointers or sinks after the synchronous call.
Keep every input alive until `encode`/`write` returns. Capture copies can outlive
the source camera. `Frame.copyStreamRgb` supplies tight RGB8 bytes;
`Frame.copyStreamRgb16` supplies canonical RGB16 little-endian bytes. Main/lores
selection and conversion continue to follow those methods' existing contracts.

```zig
const apng = camera.ApngEncoder;
// rgb_a/rgb_b are owned copies, alive through this call. Staging/capture
// scheduling and release of those copies remain the application's responsibility.
const encoded = try apng.encode(allocator, .{
    .width = width,
    .height = height,
    .frames = &.{
        .{ .view = .{ .data = rgb_a, .width = width, .height = height,
            .stride = @as(usize, width) * 3 },
           .delay = try apng.Delay.fromMilliseconds(40) },
        .{ .view = .{ .data = rgb_b, .width = width, .height = height,
            .stride = @as(usize, width) * 3 },
           .delay = try apng.Delay.fromMilliseconds(40) },
    },
});
defer allocator.free(encoded);
```

Views support 8/16-bit gray/RGB/RGBA, per-frame endian and padded rows without
final-row padding. All frames share format/depth, fit the canvas and may specify
rectangles, x/y positions, rational delays, none/background/previous disposal and
source/over blend. `Delay.fromMilliseconds` reduces exact fractions or rejects
unrepresentable delays. A zero denominator explicitly means hundredths of a
second. There is no silent clamping. With no separate `default_image`, frame zero
is IDAT and must cover the canvas at (0,0); a separate full-canvas static image
excludes that image from playback and puts every animation frame in fdAT.

All spans, geometry, frame formats, play counts and compression options validate
before allocation or streaming writes. `write` sends a complete APNG to a
synchronous `writeAll` sink using the existing Home row filters, network byte
order and pinned streaming zlib owner. Scratch memory is two rows plus bounded
compression state. Each frame has an independent zlib stream; compressed chunks
are not copied into another full-frame buffer. A failed streaming sink can own a
prefix; callers stage or dispose it. Owned `encode` publishes a slice only after
complete success. No asynchronous ownership or file publication is implied.

Home contribution 924bbf199cc3a7ffed382fb5c8d44f891eb8b786 fixes its Image PNG
adapter's first-frame pixel source, short-frame handling, 16-bit byte order,
rectangle dimensions and long delays. Indexed input expands validated palette
entries to RGBA so alpha survives. This camera reuse copies the portable encoder,
shared raster module and independent fixtures verbatim; the Home Image object
adapter and generic decoders remain in Home. Existing camera single-frame PNG
encoding uses the same refactored row/chunk functions, with unchanged pixel and
file-format selection contracts.

Seven APNG tests plus existing raster/zlib tests pass pinned/development Zig in
Debug/ReleaseSafe, covering every host allocation and sink write failure boundary
and bounded Zig scratch with 20,000 rows. The test-only C/libpng harness checks
216 fixtures per build: exact frame samples, CRC/order/sequences, controls,
subrectangles, both default layouts, all filters, depth/channel combinations,
mixed endian, padding/unaligned source and source retirement. It decodes
reconstructed static frames and does not claim independent APNG compositing.
The public Zig test encodes two copied RGB8/RGB16 synthetic captures after their
camera and leases retire. Dedicated CI runs Linux x86/ARM and macOS for both Zig
versions; normal camera CI retains the real-backend no-camera smoke test.

Bun/C animation capture, joined capture-to-animation jobs, atomic animated file
publication, animation metadata, GIF capture, general animation decoding and
compositing remain required work in parity-plan.md. This foundation does not
complete the still-media family or physical camera acceptance. No Python or
FFmpeg runtime/tool is added; libpng is an independent test decoder only.
