# Owned CNN output tensors

`Frame.cnnOutputs()` selectively copies `CnnOutputTensorInfo` and
`CnnOutputTensor` from the retained request. It returns `null` when both controls
are absent. Partial pairs, ambiguous vendor/direction/roles, unknown packet
layouts, invalid UTF-8 names, inconsistent products/counts and oversized payloads
fail explicitly. It never substitutes an empty result for malformed inference.

```ts
const frame = camera.acquire()
if (frame) {
  try {
    const result = frame.cnnOutputs({ addBatch: true })
    if (result) {
      const tensor = result.tensors[0]
      console.log(result.networkName, tensor.shape, tensor.strides)
      const rowMajor = tensor.toRowMajor()
    }
  } finally { frame.release() }
}
```

Results own a compact float allocation, tensor descriptors, name, frame counter
and the source capture metadata. They survive frame release, stop, mode changes
and camera closure. `tensor.data` is a mutable `Float32Array` view; tensors in
one result share the backing allocation. Shape/stride arrays and the capture
context are frozen. Transferring/detaching that allocation invalidates every
associated view; indexed reads and row copies reject detached storage.

Default storage is column-major, matching Picamera2's `reshape(order='F')`.
`get(...coordinates)` uses explicit strides. `order: 'row-major'` copies into
row order during decoding; `toRowMajor()` creates an independent row copy.
`addBatch` adds a logical leading singleton axis with zero stride without an
extra value copy. Scalars, zero-length tensors, sixteen physical axes and sixteen
tensors have explicit representations. Float payload bits, including NaN and
negative zero, are preserved. `decodeCnnOutputs(info, values, options)` provides
the same validation for exported info bytes and native `Float32Array` storage.
Shared inputs and invalid/detached typed views are rejected before native access.

`maxOutputBytes` defaults to 16 MiB, accepts multiples of four from 4 bytes to
64 MiB, and bounds the float payload. It is not a process heap or working-set
budget. The selective native catalog allows this payload plus 64 KiB of schema
overhead; ordinary catalogs retain their 4 MiB ceiling. C++ preselection skips
unrelated controls before visiting/copying their values. Zig validates and owns
the snapshot; catalog retirement runs even if decoding or Bun adoption throws.
No JS number array is created for the float payload.

The C API exposes `zc_frame_cnn_catalog`, `zc_cnn_catalog_outputs`,
`zc_decode_cnn_outputs` and `zc_cnn_tensor_row_major`. Descriptor sizes are
3424/208 bytes, with explicit integer fields. A null output and zero capacity
queries descriptors; capacities are float elements. Invalid input, short output
or overlapping storage leaves caller headers and values unchanged. Source and
destination pointers must designate live spans; catalog handles must be live.

The producer schema is checked against Raspberry Pi libcamera
[controller.h](https://github.com/raspberrypi/libcamera/blob/c682979b50695b93526adb1e66db33743484b63b/src/ipa/rpi/controller/controller.h)
and [tensor parser](https://github.com/raspberrypi/libcamera/blob/c682979b50695b93526adb1e66db33743484b63b/src/ipa/rpi/cam_helper/imx500_tensor_parser/imx500_tensor_parser.cpp).
The actual header has 16 tensors × 16 dimensions (712 bytes); the control YAML
documents an older 8 × 8 form (264 bytes). Only these exact lengths are accepted,
with little-endian unaligned field reads and a native-independent canonical ABI.
The upstream float control already contains dequantized values; this API does
not decode raw sensor NPU packets or apply model normalization/postprocessing.

Software validation includes shared Home compiler/optimization matrices,
independent C layout/permutation references, native retained-snapshot ownership,
real system SDK ControlValue traversal, Bun lifetime/failure/bounds tests and
the complete synthetic media suite. Fixtures are not physical IMX500 evidence.
Version 0.122 adds [coordinate projection and exact KPI views](inference-regions.md).
Firmware/network loading, intrinsics, input tensor export/injection, hardware ROI
updates, model-specific postprocessing and physical camera acceptance remain
required for full IMX500 parity.
