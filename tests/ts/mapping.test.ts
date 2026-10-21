import { expect, test } from 'bun:test'
import { Camera, Recorder, Frame, MappedStream } from '../../ts'
import { native as ffi, ptr } from '../../ts/ffi'
const cam = (writable = true) =>
  new Camera({
    simulate: true,
    writable,
    width: 34,
    height: 18,
    buffers: 3,
    fifo: true,
    raw: true,
    unpackedRaw: true,
    lores: { width: 16, height: 8 },
  })
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
const native: {
  zc_frame_map_close: (
    ...args: Parameters<typeof ffi.zc_frame_map_close>
  ) => number
} = ffi

test('exclusive mapped RGB edits are zero-copy, stride aware and visible after close', async () => {
  const c = cam()
  let frame: Frame | undefined
  try {
    frame = await c.captureRequest()
    const before = frame.copyRGB()
    const mapped = frame.mapStream(),
      row = mapped.row(1),
      alias = row.subarray(0, 3),
      dataView = new DataView(row.buffer)
    expect(mapped.stride).toBeGreaterThan(34 * 3)
    expect(mapped.planes[0].bytes[0]).toBe(before[0])
    row.set([201, 202, 203], 0)
    expect(mapped.planes[0].bytes[mapped.stride]).toBe(201)
    expect(() => frame!.copyRGB()).toThrow('(-4)')
    expect(() => frame!.copyStream()).toThrow('(-4)')
    expect(() => frame!.retain()).toThrow('(-4)')
    expect(frame.metadata().sequence).toBe(frame.sequence)
    mapped.close()
    mapped.close()
    expect(row.length).toBe(0)
    expect(alias.length).toBe(0)
    expect(() => dataView.getUint8(0)).toThrow()
    expect(() => mapped.row(0)).toThrow('closed mapping')
    expect(frame.copyRGB().slice(34 * 3, 34 * 3 + 3)).toEqual(
      new Uint8Array([201, 202, 203]),
    )
    expect(frame.referenceCount).toBe(1)
  } finally {
    frame?.release()
    await c.close()
  }
})
test('mapped owners outlive source release and stop while close/restart/modes preserve live storage', async () => {
  const c = cam()
  let map: MappedStream | undefined, frame: Frame | undefined
  try {
    frame = await c.captureRequest()
    map = frame.mapStream()
    map.row(0)[0] = 77
    frame.release()
    await c.stop()
    expect(map.row(0)[0]).toBe(77)
    expect(() => c.start()).toThrow('(-4)')
    expect(await failure(c.close())).toMatchObject({ code: -4 })
    expect(map.row(0)[0]).toBe(77)
    map.close()
    expect(c.stats().leased).toBe(0)
    c.start()
    using next = await c.captureRequest()
    expect(next.token).not.toBe(0n)
  } finally {
    map?.close()
    frame?.release()
    await c.close()
  }
})
test('shared references and active map scopes prevent conflicting writable access', async () => {
  const c = cam()
  let frame: Frame | undefined,
    child: Frame | undefined,
    map: MappedStream | undefined
  try {
    frame = await c.captureRequest()
    child = frame.retain()
    expect(() => frame!.mapStream()).toThrow('(-4)')
    expect(frame.referenceCount).toBe(2)
    child.release()
    map = frame.mapStream()
    expect(() => frame!.mapStream('raw')).toThrow('(-4)')
    expect(() => frame!.retain()).toThrow('(-4)')
    map.close()
    child = frame.retain()
    expect(child.copyRGB()).toEqual(frame.copyRGB())
  } finally {
    map?.close()
    child?.release()
    frame?.release()
    await c.close()
  }
})
test('read-only sessions reject writable mapping without affecting ordinary capture', async () => {
  const c = cam(false)
  try {
    using frame = await c.captureRequest()
    expect(() => frame.mapStream()).toThrow('(-8)')
    expect(frame.referenceCount).toBe(1)
    expect(frame.copyRGB().length).toBe(34 * 18 * 3)
  } finally {
    await c.close()
  }
})
test('mapped I420 logical component rows and Bayer rows retain format geometry without copies', async () => {
  const c = cam()
  try {
    using frame = await c.captureRequest()
    let escaped: Uint8Array | undefined
    frame.withMappedStream((mapped) => {
      expect(mapped.format).toBe('YUV420')
      expect(mapped.row(0).length).toBe(16)
      expect(mapped.row(3, 1).length).toBe(8)
      mapped.row(2, 1).fill(90)
      mapped.row(3, 2).fill(100)
      escaped = mapped.row(3, 2)
      expect(() => mapped.row(4, 1)).toThrow(RangeError)
      expect(() => mapped.row(0, 3)).toThrow()
    }, 'lores')
    expect(escaped!.length).toBe(0)
    const copied = frame.copyStream('lores').data
    expect(copied.slice(16 * 8 + 2 * 8, 16 * 8 + 3 * 8)).toEqual(
      new Uint8Array(8).fill(90),
    )
    expect(copied.slice(16 * 8 + 8 * 4 + 3 * 8)).toEqual(
      new Uint8Array(8).fill(100),
    )
    frame.withMappedStream((mapped) => {
      expect(mapped.row(0).length).toBe(34 * 2)
      new DataView(
        mapped.row(0).buffer,
        mapped.row(0).byteOffset,
        mapped.row(0).byteLength,
      ).setUint16(0, 1234, true)
    }, 'raw')
    expect(
      new DataView(frame.copyStream('raw').data.buffer).getUint16(0, true),
    ).toBe(1234)
  } finally {
    await c.close()
  }
})
test('scoped callbacks close on throw or thenable and explicit mapped objects support awaits', async () => {
  const c = cam()
  try {
    using frame = await c.captureRequest()
    let escaped: Uint8Array | undefined
    expect(() =>
      frame.withMappedStream((mapped) => {
        escaped = mapped.row(0)
        throw Error('edit failure')
      }),
    ).toThrow('edit failure')
    expect(escaped!.length).toBe(0)
    expect(frame.referenceCount).toBe(1)
    expect(() =>
      frame.withMappedStream(async (mapped) => {
        escaped = mapped.row(0)
        await Bun.sleep(1)
      }),
    ).toThrow('must be synchronous')
    expect(escaped!.length).toBe(0)
    using mapped = frame.mapStream()
    await Bun.sleep(1)
    mapped.row(0)[0] = 55
    expect(mapped.row(0)[0]).toBe(55)
  } finally {
    await c.close()
  }
})
test('mapped views detach even when native retirement reports an error and the close is not retried', async () => {
  const c = cam(),
    old = native.zc_frame_map_close
  let frame: Frame | undefined
  try {
    frame = await c.captureRequest()
    const mapped = frame.mapStream(),
      row = mapped.row(0)
    let calls = 0
    native.zc_frame_map_close = (handle) => {
      calls++
      expect(old(handle)).toBe(0)
      return -6
    }
    expect(() => mapped.close()).toThrow('(-6)')
    mapped.close()
    expect(calls).toBe(1)
    expect(row.length).toBe(0)
    expect(mapped.closed).toBe(true)
    expect(frame.referenceCount).toBe(1)
  } finally {
    native.zc_frame_map_close = old
    frame?.release()
    await c.close()
  }
})
test('mapping blocks safe recorder inputs until the writer closes', async () => {
  const c = cam(),
    recorder = new Recorder(null, { width: 34, height: 18 })
  let frame: Frame | undefined, mapped: MappedStream | undefined
  try {
    frame = await c.captureRequest()
    mapped = frame.mapStream()
    expect(() => recorder.write(frame!)).toThrow('(-4)')
    expect(() => recorder.writeAsync(frame!)).toThrow('(-4)')
    expect(() => recorder.writeAVAsync(frame!, [])).toThrow('(-4)')
    mapped.close()
    await recorder.writeAsync(frame)
    await recorder.flushAsync()
    expect(recorder.producerStats().ownedJobs).toBe(0n)
  } finally {
    mapped?.close()
    frame?.release()
    await c.close()
    await recorder.close()
  }
})
test('writable policy survives permanent, temporary and failed mode switches, with explicit opt-out', async () => {
  const c = cam()
  try {
    await c.switchMode({ width: 64, height: 48 })
    using first = await c.captureRequest()
    first.withMappedStream((mapped) => {
      mapped.row(0)[0] = 1
    })
    first.release()
    await c.switchModeAndCaptureRGB({ width: 96, height: 64, writable: false })
    using restored = await c.captureRequest()
    restored.withMappedStream((mapped) => {
      mapped.row(0)[0] = 2
    })
    restored.release()
    expect(await failure(c.switchMode({ width: 1, height: 0 }))).toMatchObject({
      code: -1,
    })
    using recovered = await c.captureRequest()
    recovered.withMappedStream((mapped) => {
      mapped.row(0)[0] = 3
    })
    recovered.release()
    await c.switchMode({ width: 32, height: 24, writable: false })
    using readonly = await c.captureRequest()
    expect(() => readonly.mapStream()).toThrow('(-8)')
  } finally {
    await c.close()
  }
})
test('mapping admission validates stream and writable options before touching ownership', async () => {
  expect(
    () => new Camera({ simulate: true, writable: 1 as unknown as boolean }),
  ).toThrow(RangeError)
  const c = cam()
  try {
    using frame = await c.captureRequest()
    expect(() => frame.mapStream('other' as 'main')).toThrow(RangeError)
    expect(frame.referenceCount).toBe(1)
    frame.release()
    expect(() => frame.mapStream()).toThrow('released')
    const out = new BigUint64Array([123n])
    expect(ffi.zc_frame_map_open(c.handle, 0n, 0, 1, ptr(out))).toBe(-5)
    expect(out[0]).toBe(0n)
  } finally {
    await c.close()
  }
})
