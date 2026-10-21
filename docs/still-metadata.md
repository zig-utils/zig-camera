# Still-image metadata work

The shared ICC profile foundation is implemented and independently tested.
Camera-facing ICC embedding and Exif capture options are still outstanding;
existing encoded still-image behavior is unchanged by this foundation commit.

Home's `createSRGBProfile` now writes a deterministic ICC v2.4 RGB matrix/TRC
profile with D50-adapted colorants, chromatic adaptation, complete description
and copyright tags, and a shared 4096-sample piecewise sRGB curve. The old
generator used gamma 2.2. Parsed profiles own their curve bytes and preserve
sampled/parametric curves rather than reducing them to that approximation.

The camera keeps the canonical Home modules verbatim under `src/home/metadata`.
Their structural validator checks complete declared size, tag-table bounds,
unique signatures, alignment, shared-body versus partial overlap, supported
curve payloads and localized-text geometry before allocation. Validation bounds
input to 16 MiB / 1024 tags. Owned parsing applies a conservative 64 MiB budget
so shared wire bodies cannot amplify copies arbitrarily. Unknown tag types are
retained without interpretation. This is not a complete ICC conformance checker
or a general LUT-based color-management engine.

`tests/home_icc_profile.zig` covers every truncated prefix, allocation failures,
shared-body amplification, ownership after source mutation, Unicode, malformed
curves and inverse behavior at flat endpoints. `tests/home_icc_lcms.c` reads the
serialized profile with Little CMS, tests 196,608 channel values and transforms
4,913 RGB patches against independent piecewise-transfer and D50 references.
The same curve check fails against Home's previous generator. Little CMS is only
a test dependency. This establishes serialized-profile behavior, not sensor,
display, optical, physical chart or Pi performance acceptance.

Run the portable tests from the repository root:

```sh
zig test src/home/metadata/icc.zig
zig test --dep icc -Mroot=tests/home_icc_profile.zig -Micc=src/home/metadata/icc.zig
zig build-obj -O ReleaseSafe -fcompiler-rt -lc --dep icc -Mroot=tests/home_icc_fixture.zig -Micc=src/home/metadata/icc.zig -femit-bin=/tmp/home-icc.o
cc -std=c11 -Wall -Wextra -Werror tests/home_icc_lcms.c /tmp/home-icc.o $(pkg-config --cflags --libs lcms2) -lm -o /tmp/home-icc-test
/tmp/home-icc-test
```

The dedicated workflow covers pinned/development Zig, Debug/ReleaseSafe, Linux
x86/ARM and macOS. Production still encoding has no new runtime dependency.
The independent C fixture object includes Zig compiler-runtime helpers so the
system linker resolves x86 stack probes while keeping runtime safety enabled.
Home's Actions service currently rejects dispatch as disabled, so its local
validation and the camera's independent copied-source CI are recorded separately.

Next integration requirements remain: bounded copied profile options for queued
captures, JPEG APP2/PNG iCCP/TIFF tag embedding with independent extraction and
pixel-decode checks, rejection of a built-in profile that mismatches the source
gamut/transfer, and hardened Exif writing with actual capture metadata. Attaching
an ICC profile must never be presented as transforming image pixels.

References: [Home shared implementation](https://github.com/home-lang/home/commit/2c0d4c5be72b3c271d2b1e8988757fde1d932f64),
[ICC sRGB interpretation](https://registry.color.org/rgb-registry/files/sRGB.pdf).
