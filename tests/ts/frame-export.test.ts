import { test, expect } from 'bun:test'
import { Camera, FrameExport, type FrameExportOptions } from '../../ts'
import { fstatSync } from 'node:fs'
import { dlopen, FFIType, toArrayBuffer } from 'bun:ffi'
// Independent POSIX mappings. Darwin shm fds require mmap, not read/write.
const os = dlopen(
  process.platform === 'darwin'
    ? '/usr/lib/libSystem.B.dylib'
    : 'libc.so.6',
  {
    mmap: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.i32,
        FFIType.i32,
        FFIType.i32,
        FFIType.i64,
      ],
      returns: FFIType.ptr,
    },
    munmap: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    getpagesize: { args: [], returns: FFIType.i32 },
  },
).symbols
function mapped<T>(
  plane: { fd: number; offset: bigint; length: bigint },
  writable: boolean,
  run: (bytes: Uint8Array) => T,
): T {
  const page = BigInt(os.getpagesize()),
    start = (plane.offset / page) * page,
    delta = Number(plane.offset - start),
    size = Number(plane.length) + delta
  const base = os.mmap(
    null,
    BigInt(size),
    1 | (writable ? 2 : 0),
    1,
    plane.fd,
    start,
  )
  if (!base || !Number.isSafeInteger(base) || base < 0)
    throw Error('test mmap failed')
  const buffer = toArrayBuffer(base, 0, size),
    bytes = new Uint8Array(buffer, delta, Number(plane.length))
  try {
    return run(bytes)
  } finally {
    structuredClone(buffer, { transfer: [buffer] })
    expect(os.munmap(base, BigInt(size))).toBe(0)
  }
}
const cam = (writable = false) =>
  new Camera({
    simulate: true,
    fifo: true,
    writable,
    width: 18,
    height: 10,
    raw: true,
    unpackedRaw: true,
    lores: { width: 10, height: 6, format: 'NV12' },
    colorSpace: 'rec709',
  })
const formats = [
  'BGR888',
  'RGB888',
  'XBGR8888',
  'XRGB8888',
  'YUV420',
  'YVU420',
  'NV12',
  'NV21',
  'YUYV',
  'YVYU',
  'UYVY',
  'VYUY',
  'BGR161616',
  'RGB161616',
] as const
for (const format of formats)
  test(`${format} exports main raw and lores descriptors with retained metadata and owned close`, async () => {
    const c = new Camera({
      simulate: true,
      fifo: true,
      writable: true,
      width: 18,
      height: 10,
      raw: true,
      unpackedRaw: true,
      format,
      lores: { width: 10, height: 6, format },
    })
    try {
      c.start()
      using frame = c.acquire()
      const source = frame.copyStreams(['main', 'raw', 'lores']),
        metadata = frame.metadata(),
        catalog = frame.metadataCatalog()
      const physical: Partial<
        Record<'main' | 'raw' | 'lores', Uint8Array[]>
      > = {}
      for (const name of ['main', 'raw', 'lores'] as const) {
        using original = frame.mapStream(name)
        physical[name] = original.planes.map((plane) => plane.bytes.slice())
      }
      using loan = frame.exportFrame({ streams: ['lores', 'raw', 'main'] })
      expect(loan).toBeInstanceOf(FrameExport)
      const info = loan.info()
      expect(info.metadata).toEqual(metadata)
      expect(info.streams.map((s) => s.stream)).toEqual([
        'main',
        'raw',
        'lores',
      ])
      expect(info.writable).toBe(false)
      expect(info.staged).toBe(true)
      expect(Object.isFrozen(info.streams)).toBe(true)
      for (const stream of info.streams) {
        const expected = source.streams[stream.stream]!
        expect([stream.width, stream.height, stream.format]).toEqual([
          expected.width,
          expected.height,
          expected.format,
        ])
        const chunks: Uint8Array[] = []
        for (let i = 0; i < stream.planeCount; i++) {
          const plane = info.planes[stream.firstPlane + i]!
          expect(plane.staged).toBe(true)
          expect(plane.writable).toBe(false)
          const data = mapped(plane, false, (bytes) =>
            bytes.slice(0, Number(plane.bytesUsed)),
          )
          expect(Buffer.from(data)).toEqual(
            Buffer.from(physical[stream.stream]![i]!),
          )
          chunks.push(data)
        }
        // Export descriptors preserve strides/padding rather than packing rows.
        expect(
          chunks.reduce((n, b) => n + b.byteLength, 0),
        ).toBeGreaterThanOrEqual(expected.data.byteLength)
      }
      frame.release()
      await c.stop()
      expect(c.stats().leased).toBe(1)
      expect(loan.info().metadata).toEqual(metadata)
      expect(loan.metadataCatalog()).toEqual(catalog)
      const kept = loan.metadataCatalog()
      loan.close()
      expect(c.stats().leased).toBe(0)
      expect(() => loan.info()).toThrow('closed frame export')
      for (const plane of info.planes)
        expect(() => fstatSync(plane.fd)).toThrow()
      await c.close()
      expect(kept).toEqual(catalog)
    } finally {
      await c.close()
    }
  })
test('writable multi-stream export holds one exclusive gate and joins staged writeback before reads', async () => {
  const c = cam(true)
  try {
    c.start()
    using frame = c.acquire()
    using loan = frame.exportFrame({
      streams: ['main', 'raw', 'lores'],
      writable: true,
    })
    const info = loan.info()
    expect(frame.referenceCount).toBe(2)
    expect(() => frame.copyRGB()).toThrow()
    expect(() => frame.retain()).toThrow()
    expect(frame.metadata().sequence).toBe(info.metadata.sequence)
    for (const plane of info.planes)
      mapped(plane, true, (bytes) => {
        bytes[0] = 91
      })
    loan.close()
    expect(frame.referenceCount).toBe(1)
    for (const stream of ['main', 'raw', 'lores'] as const) {
      using mapped = frame.mapStream(stream)
      expect(mapped.row(0)[0]).toBe(91)
    }
  } finally {
    await c.close()
  }
})
test('export admission is bounded reusable and does not retain failed stream or option requests', async () => {
  const c = cam(),
    loans: FrameExport[] = []
  try {
    c.start()
    using frame = c.acquire()
    for (const options of [
      { streams: [] },
      { streams: ['main', 'main'] },
      { streams: ['bogus'] },
      { writable: 1 },
    ])
      expect(() =>
        frame.exportFrame(options as FrameExportOptions),
      ).toThrow()
    expect(() => frame.exportFrame({ writable: true })).toThrow()
    expect(frame.referenceCount).toBe(1)
    for (let i = 0; i < 32; i++) loans.push(frame.exportFrame())
    expect(() => frame.exportFrame()).toThrow()
    expect(frame.referenceCount).toBe(33)
    loans.pop()!.close()
    using replacement = frame.exportFrame()
    replacement.close()
    for (const loan of loans) loan.close()
    expect(frame.referenceCount).toBe(1)
    expect(() =>
      frame.exportFrame({
        get writable() {
          frame.release()
          return false
        },
      }),
    ).toThrow()
  } finally {
    for (const loan of loans) loan.close()
    await c.close()
  }
})
test('unavailable late streams unwind the first map and export remains readable after source camera stop', async () => {
  const c = new Camera({
    simulate: true,
    fifo: true,
    width: 18,
    height: 10,
  })
  try {
    c.start()
    using frame = c.acquire()
    expect(() =>
      frame.exportFrame({ streams: ['main', 'lores'] }),
    ).toThrow()
    expect(frame.referenceCount).toBe(1)
    using loan = frame.exportFrame()
    frame.release()
    await c.stop()
    const info = loan.info(),
      plane = info.planes[0]!
    expect(
      mapped(plane, false, (bytes) => bytes.slice(0, 1)).byteLength,
    ).toBe(1)
    loan.close()
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('camera close reports a retained export and remains retryable after its explicit retirement', async () => {
  const c = cam()
  try {
    c.start()
    using frame = c.acquire()
    using loan = frame.exportFrame()
    frame.release()
    const error = await c.close().then(
      () => undefined,
      (error) => error,
    )
    expect(error).toMatchObject({ code: -4 })
    expect(loan.info().planes.length).toBeGreaterThan(0)
    loan.close()
    await c.close()
    expect(() => c.info()).toThrow()
  } finally {
    await c.close()
  }
})
