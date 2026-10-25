// Setup-only host benchmark: no camera, buffers, capture rate or Pi speed claim.
// Pass explicit shared-library filenames; never overwrite a loaded image.
import { dlopen, FFIType as t, ptr, type Pointer } from 'bun:ffi'
import { resolve } from 'node:path'

const sources = process.argv.slice(2)
if (!sources.length) throw new Error('Pass one or more explicit library paths')
const iterations = 100, trials = 21, warmup = 100
const libraries = sources.map(source => {
  const library = dlopen(resolve(source), {
    zc_default_capture_allocator_config: { args: [t.ptr], returns: t.void },
    zc_capture_allocator_open: { args: [t.ptr, t.ptr, t.u32, t.ptr], returns: t.i32 },
    zc_capture_allocator_close: { args: [t.ptr], returns: t.i32 },
  })
  const native = library.symbols
  const config = new Uint8Array(24), out = new BigUint64Array(1)
  native.zc_default_capture_allocator_config(ptr(config))
  return {
    path: resolve(source), rows: [] as number[], library,
    once() {
      const opened = native.zc_capture_allocator_open(ptr(config), null, 0, ptr(out))
      if (opened !== 0) throw new Error(`allocator open: ${opened}`)
      const closed = native.zc_capture_allocator_close(Number(out[0]) as Pointer)
      if (closed !== 0) throw new Error(`allocator close: ${closed}`)
    },
  }
})
try {
  for (const library of libraries) for (let i = 0; i < warmup; i++) library.once()
  for (let trial = 0; trial < trials; trial++) {
    // Rotate first position so one candidate does not always run cold/last.
    for (let position = 0; position < libraries.length; position++) {
      const library = libraries[(position + trial) % libraries.length]
      const start = performance.now()
      for (let i = 0; i < iterations; i++) library.once()
      library.rows.push((performance.now() - start) * 1e6 / iterations)
    }
  }
  for (const library of libraries) console.log(JSON.stringify({
    library: library.path, operation: 'managed allocator open-close; no camera or frame',
    unit: 'ns/op', iterations, trials, warmup, rows: library.rows,
    bun: Bun.version, platform: process.platform, architecture: process.arch,
  }))
} finally {
  for (const library of libraries) library.library.close()
}
