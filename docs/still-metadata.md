# Still-image ICC profiles

Version 0.56 adds optional ICC embedding in JPEG, PNG and classic TIFF through
Zig/C, Bun and the CLI. Main and lores RGB/I420 captures use the same encoding
path, including async, focus-locked and temporary-mode file/encoded captures.
Exif capture metadata/options remain outstanding on the parity plan.

```ts
await camera.captureFile('photo.jpg', { iccProfile: 'srgb' })
const bytes = await camera.captureEncodedImage({
  format: 'png', stream: 'lores', iccProfile: customRgbProfileBytes,
})
```

`iccProfile: 'srgb'` uses Home's independently tested deterministic ICC v2.4
profile. It requires the actual selected source to have Rec709 primaries and
sRGB transfer. YUV matrix/range are converted by the existing Home converter;
gamut and transfer are preserved. Rec709 transfer, Rec2020 primaries, unknown
metadata and other mismatches reject before creating/replacing a destination.
Embedding describes the samples; it never changes their gamut or transfer.

Custom `Uint8Array` RGB ICC bytes are copied and validated at submission, so
later mutations do not affect queued or worker-mode captures. Inputs are bounded
to 16 MiB / 1024 tags, and JPEG additionally has a 255-part APP2 limit. Invalid
profile sizes, tag geometry, duplicate signatures, overlaps and supported curve
payloads reject before queuing. RGB with XYZ/Lab PCS is required. The validator
is not a complete ICC conformance checker or LUT engine; the caller must ensure
a custom profile matches the source. BMP/PPM/DNG embedding is unsupported.
Omitting the option retains existing behavior and unprofiled JPEG fast paths.
Profiled JPEG uses Home's owned JPEG encoder before embedding.

```sh
zig-camera capture --icc-profile srgb --output photo.jpg
zig-camera capture --icc-profile ./camera-rgb.icc --output photo.png
```

The native ABI adds a separate 24-byte `zc_image_profile` descriptor; the existing
20-byte `zc_image_options` remains unchanged. Flags `ZC_IMAGE_PROFILE_SRGB` use
null data/zero length. Flags zero supply borrowed raw bytes/length for the
synchronous call. `zc_check_image_profile` checks options/profile structure;
`zc_encode_stream_image_profile` and `zc_save_stream_image_profile` also check
actual source compatibility and lease access. Native returned blobs own their
encoded bytes and survive request/camera disposal. Zig exposes
`srgbImageProfile`, `customImageProfile`, `Frame.encodeStreamImageProfile` and
`Frame.saveStreamImageProfile`. Callers retain custom bytes until the call ends.
File writes use the existing atomic replacement and preserve prior files on
profile, source or encoding failure. Cancellation before a queued capture runs
leaves the destination untouched. A running temporary-mode worker can commit a
file before cancellation or a later callback/restoration error is reported;
coordinating that file commit with job publication remains parity work.

Home's shared embedding helper preserves encoded pixel payloads. JPEG profiles
are split into numbered APP2 segments after APP0, replacing prior pre-scan ICC
markers. PNG inserts compressed iCCP after IHDR and removes conflicting iCCP,
sRGB/gAMA/cHRM, cICP and HDR-signaling chunks while preserving IDAT bytes. TIFF
appends a sorted primary IFD with tag 34675 and repoints the header, preserving
strip data/offsets and the next-page link. Both TIFF byte orders are supported;
BigTIFF is unsupported. Unreachable old TIFF metadata remains in the file.
JPEG entropy/scans and TIFF page chains are not fully decoded by this helper.

The shared ICC generator preserves the sRGB toe with one shared 4096-sample
curve, D50 colorants and chromatic adaptation. Owned parsing retains sampled
and parametric curves and Unicode descriptions. Little CMS independently tests
196,608 channel values and 4,913 RGB-to-XYZ patches. The embedding tests cover
allocation failures, multi-segment JPEG, PNG CRCs/decompression, TIFF byte orders,
sorting/replacement and retained next-IFD pointers. Bun tests cover owned and
atomic outputs, custom-profile copying across queues/workers, mode rollback,
color rejection, cancellation and focus-locked capture. Independent libjpeg,
libpng and libtiff extract profiles which Little CMS opens; platform image
decoders compare profiled/unprofiled samples. These are software/container
checks, not sensor/color-chart or physical image-quality acceptance.

`home-icc.yml` covers pinned/development Zig in Debug/ReleaseSafe on Linux
x86/ARM and macOS. Full camera CI additionally covers the optional system-JPEG
build and the real Linux backend build/load/no-camera smoke test. Little CMS and
the independent image readers are test-only dependencies. Home Actions rejects
dispatch as disabled, so shared-source CI runs through the camera's copied code.

References: [ICC embedding note](https://archive.color.org/files/technotes/ICC-Technote-ProfileEmbedding.pdf),
[PNG specification](https://www.w3.org/TR/png-3/),
[ICC sRGB interpretation](https://registry.color.org/rgb-registry/files/sRGB.pdf).
