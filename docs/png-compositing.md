# APNG display frames

Version 0.107 adds an explicit sequential display compositor over Home's decoded
animation rectangles. It closes the raw-rectangle-to-display gap; the overall
Picamera2 worklist, image/color transforms and physical acceptance remain open.
The reference Picamera2 `request.py` returns Pillow images and delegates general
image operations/saves. This implements an image operation through Home/Bun;
it does not promise a Pillow API or every Pillow animation feature.

```ts
import { loadPngAsync } from '@zig-utils/camera'

using decoded = await loadPngAsync('trail.apng')
using display = decoded.compositor({ maxWorkingBytes: 32 * 1024 * 1024 })
for (const frame of display) {
  using image = frame.image
  // Independently owned full-canvas RGBA8/16, with exact delay fraction.
  await image.saveAsync(`rendered-${frame.index}.png`)
}
```

Keep the decoded rectangle images open until iteration finishes. Each displayed
`CapturedImage` is separately owned and survives closing both decoded source and
compositor. Close every displayed image. `next()` is synchronous; it does not
schedule playback or wait for a frame delay. Zero denominator means 100 for a
caller scheduling the retained fraction. Play count remains on `decoded.plays`.
One compositor renders one play, starting from transparent black. Create another
to replay. Static PNG has no animation frames and yields nothing.

SOURCE replaces all channels, including hidden RGB under zero alpha. OVER uses
straight-alpha native-precision integer arithmetic, nearest rounding and widened
intermediates. It performs composition in encoded sample space, without gamma,
gamut, ICC, Exif-orientation or temporal conversion. Output is RGBA at the decoded
8/16-bit depth, little endian, without invented camera/color provenance; metadata
remains separately available on the decoded source.

An excluded default poster never initializes animation pixels. NONE retains the
last display; BACKGROUND clears only its rectangle; PREVIOUS restores its previous
rectangle. Disposal occurs before the next valid frame, after the prior display
was available to copy. First-frame PREVIOUS means BACKGROUND. These rules follow
the [PNG3 frame-control specification](https://www.w3.org/TR/png-3/#fcTL-chunk).
No animation rectangle or input palette is modified.

The native owner preallocates exactly two full RGBA canvases, checks the complete
working limit before allocation, and allocates nothing during push/reset. The
default limit is 128 MiB with a 256 MiB hard ceiling. Source decoded storage and
caller-retained display copies are separate from that limit. Global native image
admission is shared with PNG decoding and image jobs: four owners and 512 MiB.
There is no waiting queue or hidden growing display list. Invalid geometry, depth,
stride, controls or aliasing cannot apply pending disposal or alter any pixels.

`close()` is idempotent. Exhaustion, iterator `return()`, `for-of` break and errors
close native ownership. Use `using`/`finally` when manually calling `next()` or
abandoning an iterator. Closing source rectangles early makes the next feed fail
and retires the compositor; already returned displays remain valid. No finalizer
or garbage-collector timing is required for correctness.

Zig exports `ApngCompositor.Canvas`; its `view()` is borrowed until push/reset/
deinit and must be copied to retain a display. The C open/push/copy/reset/close API
is externally serialized, borrows source pixels only during push, and follows
the same image admission. NULL/zero copy queries the exact byte size; an
undersized copy writes no prefix.

Tests cover included/excluded defaults, alpha blending at both precisions, exact
rectangular disposal/restore, replay initialization, owned snapshots after source
closure and encoding, iterator break/error/exhaustion, shared owner saturation,
limits, native words/endian/stride, overlap rejection and allocation failures.
Home's 10,000 double-precision comparisons independently check integer blend
rounding. CI compares shared sources and exercises Debug/ReleaseSafe with both
Zig versions on Linux x86/ARM and macOS; camera C/Bun integration uses pinned Zig.
No hardware or performance superiority is inferred from these software tests.
