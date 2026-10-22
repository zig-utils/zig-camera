# Sensor raw formats and owned samples

Version 0.80 uses Home's checked sensor views for Bayer and monochrome raw
capture. Every raw format listed in the pinned Picamera2 formats.py catalog is
recognized, alongside existing 14-bit extensions. This is software format
coverage, not proof of physical sensor/backend support.

| Source | Canonical names | Physical row packing |
| --- | --- | --- |
| Bayer unpacked | S + RGGB/BGGR/GRBG/GBRG + 8/10/12/14/16 | u8 or LE u16 |
| Bayer CSI-2 | S + order + 10/12/14 + _CSI2P | 4 samples/5 bytes, 2/3 or 4/7 |
| Mono unpacked | R8/R10/R12/R14/R16 | u8 or LE u16 |
| Mono CSI-2 | R8_CSI2P/R10_CSI2P/R12_CSI2P/R14_CSI2P | u8 or depth-specific groups |
| PiSP COMP1 | RGGB/BGGR/GRBG/GBRG/MONO + _PISP_COMP1 | interleaved two channel words per 8 pixels |

Canonical names are strict. COMP2, unknown layouts and contradictory
unpackedRaw plus packed/COMP1 requests reject. Mono keeps its name across
orientation; Bayer changes CFA phase while retaining depth/packing. Native mode
catalog parsing now includes advertised mono depths. A COMP1 representation's
16-bit reconstruction is not used to invent an ADC depth in the sensor catalog.
Physical libcamera must negotiate the format; CPU leases/DMA ownership stay here.

copyStream/captureStreams and mapped row(y) preserve physical words/blocks,
removing stride padding from owned copies. The final partial CSI-2/COMP1 block
must be present in full; unused samples in that block are ignored by decoding.
Unaligned planes, odd pitch and absent final padding are checked. Escaped Bun
mapping views detach on close. No implicit raw conversion is hidden in bundles.

Frame.copyRaw16(), Camera.captureRaw16() and captureRaw16Async() return owned
Uint16Array samples. C zc_copy_raw16 and Zig Frame.copyRaw16 write tight LE u16
bytes. Unpacked8 becomes values 0..255; 10/12/14-bit samples retain their range.
No scaling/demosaicing/color conversion is applied. COMP1 uses the standard
Raspberry Pi offset 2048, all quantizer cases and saturating 16-bit reconstruction.
Each pair of channel words is decoded once per eight pixels. Nonstandard driver
compression offsets are not inferred. COMP1 is lossy; decoding cannot recover
lost ADC precision. Readable owned output survives release/close and holds no
camera lease. Active writable maps, stale tokens, short output, bad spans and
late invalid unpacked samples reject before output writes.

The decoder is a Zig adaptation of [Picamera2's pinned implementation](https://github.com/raspberrypi/picamera2/blob/5e2a35d3bb230825c98c56d98e01b41ddeb43e86/picamera2/request.py),
with BSD-2-Clause attribution/license retained in Home and camera NOTICE. No
Python is executed or imported. The [PiSP specification](https://datasheets.raspberrypi.com/camera/raspberry-pi-image-signal-processor-specification.pdf)
describes the hardware decompression offset/mode contract; hardware results are
not substituted for the scalar reference tests.

DNG streams decoded rows through one scratch allocation and a bounded TIFF
header. Bayer uses existing calibrated CFA/matrix/neutral tags; mono writes
PhotometricInterpretation LinearRaw, scalar black level from SensorBlackLevels[0],
white level and exposure/model/active-area metadata. Mono requires black-level
metadata but no invented CFA, white balance or color matrix. COMP1 white level is
65535; other formats retain the original sample depth. Existing atomic-file and
staged temporary-mode publication semantics remain. Explicit raw formats survive
temporary encoded/file DNG jobs and CLI --raw-format. Defaults still request
unpacked data when no explicit recipe is supplied.

Home's helper includes 455 scalar upstream-reference words, all legal mode-3
companding-code pairs, all format/depth round trips and checked failure tests.
The simulator now generates unpacked8/CSI-2 and COMP1 data; its COMP1 fixtures
encode deterministic quantizer codes, not a general sensor compressor. Camera
tests also write arbitrary words for all quantizer modes/clipping, compare raw16
and DNG samples, preserve physical rows and verify ownership/modes/orientation.
Linux CI reads DNG samples independently with libtiff and recognizes CLI output
with LibRaw; native old-SDK backend build/load/no-camera tests run on x86/ARM.
Home OS camera/VideoCore stubs do not supply this decoder; shared algorithms live
in Home stdlib per ADR-MC3. Physical raw quality/precision/format negotiation,
black calibration, camera FPS/throughput and additional DNG/compression behavior
remain acceptance work.
