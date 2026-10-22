# Independent video failure evidence

The camera tests use OpenH264/libde265 directly, without FFmpeg/Libav. I420
readback compares every decoded sample against the independent reference and
retains the existing per-component mean absolute error ceiling of four.

At camera c7560cf13598c762c382eb392e1d773efa5a16f8 the APNG, ICC and Exif
matrices passed, as did the x86 and macOS camera jobs. The ARM media job reported
a HEVC RGB lores I420 component mismatch. The old decoder reported no frame,
component or error magnitude, and the owning test removed its input directory.
That observation is not explained or dismissed by successful runs elsewhere.

The independent decoder now reports frame index, component, geometry/stride,
total/mean/maximum absolute error and the coordinate/actual/reference sample at
maximum error. On mismatch, `ZC_DECODED_I420_FAILURE` optionally saves all three
visible planes of that failed frame, with no padding. Plane validation precedes
the diagnostic readback. The original pixel tolerance is unchanged.

`tests/ts/media.ts` sets that dump path per fixture. With
`ZC_MEDIA_FAILURE_DIR`, it copies the closed container, access units, full I420
reference, failed decoded frame (if available), decoder stderr and geometry/frame
manifest before asserting. A retention error cannot replace the original decoder
failure. CI uploads these files on failure and repeats the HEVC RGB lores case
30 times after the full media suite. These are test diagnostics, not a new output
mode or production encoder policy.

Three Bun tests exercise success, evidence survival after source cleanup and a
failed archive destination. Native deliberately wrong AVC/HEVC references verify
the actual C++ measurement/dump path. Local independent decoders were built with
C/C++ only: OpenH264 v2.7.0 at 1bca62311e447fd9c39fc93de2c4b96cd5ce971c
(make, assembly disabled) and libde265 v1.1.3 at
ba62bf4cfb3242f3bf0a45617ff09e35236e4d82 (CMake, static library only).
The Ubuntu CI system decoder/encoder versions are separate coverage. No Python
was executed, no FFmpeg dependency was introduced, and these local tools are not
production dependencies or a claim that the original ARM mismatch is fixed.

This diagnostic revision passes all 968 Bun tests locally with independent image,
ICC, Exif, AVC/HEVC and AAC decoders and SDL, plus 30 repeated HEVC RGB lores cases.
Physical camera/Pi performance remains unmeasured. Reuse audits for this release
are recorded in home-reuse.md and home-os-reuse.md; an unexplained encoder/decoder
mismatch must be investigated with retained evidence before changing a shared
Home codec or relaxing a test.
