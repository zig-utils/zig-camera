# HEVC picture geometry

Version 0.72 uses Home's shared CTU32 encoder policy for simultaneous tiny and
larger HEVC streams. Existing even I420 dimensions of at least 16x16 remain
admitted. A level 5.0 ceiling can admit 3840x2160 at 30 fps, while 4K60 exceeds
that ceiling. No hardware acceleration or Pi throughput is established here.

```ts
const main = new Recorder('main.mp4', {
  width: 3840, height: 2160, codec: 'hevc', limits: { level: 50 },
})
const lores = new Recorder('lores.mp4', {
  width: 32, height: 24, codec: 'hevc', limits: { level: 20 },
})
```

Home-managed instances use the same maximum coding-tree size for their whole
lifetime. This avoids x265's process-global CTU conflicts as sessions open,
replace encoders, encode together and close in different orders. Other direct
x265 users in the same process must obey the vendor's global constraint too.
This does not make unsafe concurrent calls on one recorder supported.

If either input dimension is smaller than 32, the bridge allocates an owned I420
buffer with each axis at least 32, extends the right/bottom edges, and feeds the
padded planes to x265. Its SPS retains existing vendor alignment crops and adds
right/bottom conformance offsets for the exact requested visible dimensions.
The copy occurs only on that tiny-input path. Each admitted axis is at most 8192,
so padding scratch is bounded. Larger inputs retain the existing borrowed-plane
path; format conversion and caller-side plane packing have their own costs.

Home's bounded, allocation-free Zig SPS editor validates the supported layer-zero,
single-temporal-layer, 8-bit I420 prefix, emulation prevention and expected visible
geometry. It preserves the opaque suffix (including VUI) through the stop bit.
The editor is not a complete HEVC parser or malformed-tail validator. Its 2048-byte
input and 4096-byte output limits bound work and scratch during header preparation;
invalid input/capacity does not partially overwrite the destination.

The bridge generates and caches HEVC parameter sets once during construction.
Repeated header generation in supported x265 builds appends duplicate parameter
sets; level checking and public reads now use the stable cache. Packet scratch
is separate. In-band repeated headers remain disabled. Destruction frees the
cache and any padded planes. Existing scalar C configuration layouts stay intact.
C-only Home bridge builds additionally link the shared Zig crop helper object;
Zig and zig-camera builds include it automatically.

The native fixture holds 16x16, 32x24, 18x50, 34x18 and 3840x2160 encoders at once,
checks keyframe requests, frame timestamps, drains and stable header bytes. The
Bun MP4 fixture holds seven sizes together, checks container/header policy and
passes spatially varied visible Y/U/V references to the independent Linux HEVC
decoder. Codec construction, synthetic frames and software decoding do not verify
camera negotiation, physical 4K capture, image quality or sustained Pi performance.
