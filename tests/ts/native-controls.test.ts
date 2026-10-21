import { expect, test } from 'bun:test'
import { Camera, Control, Recorder } from '../../ts'
import { native, ptr } from '../../ts/ffi'
import {
  encodeNativeControls,
  encodeNativeSnapshot,
} from '../../ts/control-values'
const cam = () =>
  new Camera({ simulate: true, width: 64, height: 48, fifo: true, buffers: 3 })
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
const id = (c: Camera, name: string) =>
  c.controls().records.find((r) => r.name === name)!.id
const state = (c: Camera, name: string) =>
  c.nativeControlSnapshot().controls.records.find((r) => r.name === name)!
    .values[0].value
async function latest(c: Camera, revision: bigint) {
  for (let i = 0; i < 32; i++) {
    using frame = await c.captureRequest()
    if (frame.metadata().controlRevision >= revision)
      return frame.metadataCatalog()
  }
  throw Error('control revision did not arrive')
}
const value = (catalog: Awaited<ReturnType<typeof latest>>, name: string) =>
  catalog.records.find((r) => r.name === name)!.values[0].value

test('typed vendor requests preserve exact integers, arrays, strings, geometry and owned payloads', async () => {
  const c = cam()
  try {
    const bytes = new Uint8Array([0, 1, 255]),
      floats = new Float32Array(Array.from({ length: 64 }, (_, i) => i / 4 - 8))
    const controls = [
      {
        id: id(c, 'SyntheticInt64'),
        kind: 'int64' as const,
        value: 9007199254740993n,
      },
      {
        id: id(c, 'SyntheticText'),
        kind: 'string' as const,
        value: 'mountain\0湖',
      },
      { id: id(c, 'SyntheticBytes'), kind: 'byte' as const, value: bytes },
      { id: id(c, 'SyntheticFloats'), kind: 'float32' as const, value: floats },
      {
        id: id(c, 'SyntheticRectangles'),
        kind: 'rectangle' as const,
        value: [
          { x: 2, y: 3, width: 12, height: 10 },
          { x: 20, y: 4, width: 8, height: 9 },
        ],
      },
      { id: id(c, 'SyntheticUint16'), kind: 'uint16' as const, value: 65535 },
      {
        id: id(c, 'SyntheticUint32'),
        kind: 'uint32' as const,
        value: 4294967295,
      },
      {
        id: id(c, 'SyntheticPoint'),
        kind: 'point' as const,
        value: { x: -300, y: 400 },
      },
      {
        id: id(c, 'SyntheticSize'),
        kind: 'size' as const,
        value: { width: 4056, height: 3040 },
      },
    ]
    const revision = c.setNativeControls(controls)
    bytes.fill(8)
    floats.fill(2)
    expect(state(c, 'SyntheticInt64')).toBe(9007199254740993n)
    const m = await latest(c, revision)
    expect(value(m, 'SyntheticInt64')).toBe(9007199254740993n)
    expect(value(m, 'SyntheticText')).toBe('mountain\0湖')
    expect(value(m, 'SyntheticBytes')).toEqual([0, 1, 255])
    expect(value(m, 'SyntheticFloats')).toEqual(
      Array.from({ length: 64 }, (_, i) => i / 4 - 8),
    )
    expect(value(m, 'SyntheticRectangles')).toEqual([
      { x: 2, y: 3, width: 12, height: 10 },
      { x: 20, y: 4, width: 8, height: 9 },
    ])
    expect(value(m, 'SyntheticUint16')).toBe(65535)
    expect(value(m, 'SyntheticUint32')).toBe(4294967295)
    expect(value(m, 'SyntheticPoint')).toEqual({ x: -300, y: 400 })
    expect(value(m, 'SyntheticSize')).toEqual({ width: 4056, height: 3040 })
  } finally {
    await c.close()
  }
})
test('native batches validate all entries before mutation and preserve revision on rejection', async () => {
  const c = cam()
  try {
    c.setNativeControls([
      { id: id(c, 'SyntheticInt64'), kind: 'int64', value: 123n },
    ])
    const before = c.nativeControlSnapshot(),
      convenience = c.controlSnapshot()
    for (const bad of [
      { id: id(c, 'SyntheticReadOnly'), kind: 'int32' as const, value: 1 },
      { id: id(c, 'SyntheticInt64'), kind: 'int32' as const, value: 1 },
      { id: 0xdeadbeef, kind: 'int64' as const, value: 1n },
      { id: id(c, 'SyntheticFloats'), kind: 'float32' as const, value: [17] },
      {
        id: id(c, 'SyntheticPoint'),
        kind: 'point' as const,
        value: { x: 4097, y: 0 },
      },
      {
        id: id(c, 'SyntheticRectangles'),
        kind: 'rectangle' as const,
        value: [{ x: 60, y: 0, width: 8, height: 8 }],
      },
      {
        id: id(c, 'SyntheticInt64'),
        kind: 'int64' as const,
        value: 1n,
        name: 'wrong',
      },
      {
        id: id(c, 'SyntheticInt64'),
        kind: 'int64' as const,
        value: 1n,
        vendor: 'wrong',
      },
    ]) {
      expect(() =>
        c.setNativeControls([
          { id: Control.brightness, kind: 'float32', value: 0.5 },
          bad,
        ]),
      ).toThrow()
      expect(c.nativeControlSnapshot()).toEqual(before)
      expect(c.controlSnapshot()).toEqual(convenience)
    }
  } finally {
    await c.close()
  }
})
test('the native API rejects malformed float payloads, spoofed app IDs and duplicate native IDs safely', async () => {
  const c = cam()
  try {
    const revision = new BigUint64Array([77n])
    const packet = encodeNativeControls([
      { id: id(c, 'SyntheticFloats'), kind: 'float32', value: [1] },
    ])
    new DataView(packet.buffer).setUint32(packet.length - 4, 0x7f800000, true)
    expect(
      native.zc_set_native_controls(
        c.handle,
        ptr(packet),
        BigInt(packet.length),
        ptr(revision),
      ),
    ).toBe(-1)
    expect(revision[0]).toBe(77n)
    const forged = encodeNativeControls([
      { id: id(c, 'SyntheticInt64'), kind: 'int64', value: 42n },
    ])
    new DataView(forged.buffer).setUint32(28, Control.afMode, true)
    expect(
      native.zc_set_native_controls(
        c.handle,
        ptr(forged),
        BigInt(forged.length),
        ptr(revision),
      ),
    ).toBe(0)
    expect(c.nativeControlSnapshot().controls.records[0].appId).toBe(0)
    expect(c.controlSnapshot().controls).toEqual([])
    expect(() =>
      c.setNativeControls([
        { id: 1, kind: 'boolean', value: true },
        { id: 1, kind: 'boolean', value: false },
      ]),
    ).toThrow(RangeError)
  } finally {
    await c.close()
  }
})
test('native requests overwrite convenience projections and later convenience writes retire typed replay', async () => {
  const c = cam()
  try {
    c.setControls([{ id: Control.exposureTime, type: 'int', values: [1234] }])
    const first = c.setNativeControls([
      { id: Control.exposureTime, kind: 'int32', value: 2345 },
    ])
    expect(
      c.controlSnapshot().controls.find((r) => r.id === Control.exposureTime)
        ?.values,
    ).toEqual([2345])
    expect(c.nativeControlSnapshot().controls.records.length).toBe(1)
    const second = c.setControls([
      { id: Control.exposureTime, type: 'int', values: [3456] },
    ])
    expect(second).toBeGreaterThan(first)
    expect(c.nativeControlSnapshot().controls.records).toEqual([])
    expect((await c.captureMetadata()).exposureUs).toBe(3456)
    c.setNativeControls([
      { id: Control.exposureTimeMode, kind: 'int32', value: 1 },
      { id: Control.analogueGainMode, kind: 'int32', value: 1 },
    ])
    c.setControls([{ id: Control.aeEnable, type: 'bool', values: [1] }])
    expect(c.nativeControlSnapshot().controls.records).toEqual([])
  } finally {
    await c.close()
  }
})
test('mixed typed and convenience settings survive target and temporary-mode replay with exact revisions', async () => {
  const c = cam()
  try {
    c.setControls([
      { id: Control.analogueGain, type: 'float', values: [1.3] },
      { id: Control.exposureTime, type: 'int', values: [2000] },
    ])
    c.setNativeControls([
      { id: id(c, 'SyntheticInt64'), kind: 'int64', value: -9007199254740993n },
      { id: Control.brightness, kind: 'float32', value: 0.25 },
    ])
    const before = c.controlSnapshot(),
      typed = c.nativeControlSnapshot()
    await c.switchMode({ width: 128, height: 96 })
    expect(c.controlSnapshot().controls).toEqual(before.controls)
    expect(c.controlSnapshot().revision).toBeGreaterThan(before.revision)
    expect(c.nativeControlSnapshot().controls).toEqual(typed.controls)
    expect(
      value(await latest(c, c.controlSnapshot().revision), 'SyntheticInt64'),
    ).toBe(-9007199254740993n)
    const result = await c.switchModeAndCaptureMetadata({
      width: 32,
      height: 24,
    })
    expect(result.exposureUs).toBe(2000)
    expect(c.info().width).toBe(128)
    expect(c.nativeControlSnapshot().controls).toEqual(typed.controls)
    expect(c.controlSnapshot().controls).toEqual(before.controls)
  } finally {
    await c.close()
  }
})
test('failed typed replay rolls the camera back with complete previous state', async () => {
  const c = cam()
  try {
    c.setNativeControls([
      {
        id: id(c, 'SyntheticRectangles'),
        kind: 'rectangle',
        value: [{ x: 30, y: 20, width: 20, height: 20 }],
      },
    ])
    c.setControls([{ id: Control.exposureTime, type: 'int', values: [1234] }])
    const before = c.nativeControlSnapshot()
    expect(
      await failure(c.switchMode({ width: 16, height: 16 })),
    ).toMatchObject({ code: -1 })
    expect(c.info().width).toBe(64)
    expect(c.nativeControlSnapshot().controls).toEqual(before.controls)
    expect((await c.captureMetadata()).exposureUs).toBe(1234)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('owned vendor metadata stays tied to retained requests after updates, stop and source close', async () => {
  const c = cam()
  let request: Awaited<ReturnType<Camera['captureRequest']>> | undefined
  try {
    const revision = c.setNativeControls([
      { id: id(c, 'SyntheticInt64'), kind: 'int64', value: 11n },
    ])
    await latest(c, revision)
    request = await c.captureRequest()
    const child = request.retain()
    request.release()
    request = child
    const metadata = request.metadataCatalog()
    c.setNativeControls([
      { id: id(c, 'SyntheticInt64'), kind: 'int64', value: 99n },
    ])
    for (let i = 0; i < 8; i++) await c.captureMetadata()
    expect(value(request.metadataCatalog(), 'SyntheticInt64')).toBe(11n)
    await c.stop()
    expect(request.metadataCatalog()).toEqual(metadata)
    request.release()
    await c.close()
    expect(value(metadata, 'SyntheticInt64')).toBe(11n)
  } finally {
    request?.release()
    await c.close()
  }
})
test('explicit native replay seeds a fresh session and remains retryable after target validation fails', async () => {
  const c = cam()
  let snapshot: ReturnType<Camera['nativeControlSnapshot']>
  try {
    c.setNativeControls([
      {
        id: id(c, 'SyntheticInt64'),
        kind: 'int64',
        value: 0x7fffffffffffffffn,
      },
    ])
    snapshot = c.nativeControlSnapshot()
  } finally {
    await c.close()
  }
  const target = cam()
  try {
    const bad = {
      ...snapshot,
      controls: {
        ...snapshot.controls,
        records: snapshot.controls.records.map((r) => ({
          ...r,
          name: 'wrong',
        })),
      },
    }
    expect(() => target.restoreNativeControls(bad)).toThrow('(-8)')
    expect(target.nativeControlSnapshot().revision).toBe(0n)
    const restored = target.restoreNativeControls(snapshot)
    expect(restored).toBeGreaterThan(snapshot.revision)
    expect(() => target.restoreNativeControls(snapshot)).toThrow('(-2)')
    expect(value(await latest(target, restored), 'SyntheticInt64')).toBe(
      0x7fffffffffffffffn,
    )
  } finally {
    await target.close()
  }
})
test('non-replayed writes affect current frames while prior replay intent resumes after restart', async () => {
  const c = cam()
  try {
    c.setNativeControls([
      { id: id(c, 'SyntheticInt64'), kind: 'int64', value: 7n },
      { id: Control.exposureTime, kind: 'int32', value: 1234 },
    ])
    const snapshot = c.nativeControlSnapshot(),
      revision = c.setNativeControls([
        {
          id: id(c, 'SyntheticInt64'),
          kind: 'int64',
          value: 8n,
          replay: false,
        },
        { id: Control.exposureTime, kind: 'int32', value: 2345, replay: false },
      ])
    const m = await latest(c, revision)
    expect(value(m, 'SyntheticInt64')).toBe(8n)
    expect(c.nativeControlSnapshot().controls).toEqual(snapshot.controls)
    await c.stop()
    c.start()
    expect((await c.captureMetadata()).exposureUs).toBe(1234)
    expect(value(await latest(c, revision), 'SyntheticInt64')).toBe(7n)
  } finally {
    await c.close()
  }
})
test('typed focus controls share autofocus ownership and never replay one-shot commands', async () => {
  const c = cam()
  try {
    c.setNativeControls([{ id: Control.afMode, kind: 'int32', value: 2 }])
    const pause = c.autofocusPauseAsync()
    expect(() =>
      c.setNativeControls([
        { id: Control.lensPosition, kind: 'float32', value: 1 },
      ]),
    ).toThrow('(-4)')
    expect(await pause).toBe(3)
    expect(await c.autofocusResumeAsync()).toBe(3)
    expect((await c.captureFocusLockedMetadata()).afState).toBe(2)
    c.setNativeControls([{ id: Control.afPause, kind: 'int32', value: 1 }])
    expect(
      c
        .nativeControlSnapshot()
        .controls.records.some((r) => r.appId === Control.afPause),
    ).toBe(false)
    await c.switchMode({ width: 128, height: 96 })
    expect(await c.autofocusPauseAsync()).toBe(3)
    expect(await c.autofocusResumeAsync()).toBe(3)
  } finally {
    await c.close()
  }
})
test('typed arrays larger than the compatibility projection are retained and replayed without truncation', async () => {
  const c = cam()
  try {
    const windows = Array.from({ length: 12 }, (_, i) => ({
      x: i,
      y: 0,
      width: 4,
      height: 4,
    }))
    c.setNativeControls([
      { id: Control.afWindows, kind: 'rectangle', value: windows },
    ])
    expect(
      c.controlSnapshot().controls.some((r) => r.id === Control.afWindows),
    ).toBe(false)
    expect(state(c, 'AfWindows')).toEqual(windows)
    await c.switchMode({ width: 128, height: 96 })
    expect(state(c, 'AfWindows')).toEqual(windows)
    c.setNativeControls([
      { id: id(c, 'SyntheticFloats'), kind: 'float32', value: [] },
    ])
    expect(state(c, 'SyntheticFloats')).toEqual([])
  } finally {
    await c.close()
  }
})
test('coordinated recorder mode switches preserve typed vendor state and keep capture ownership bounded', async () => {
  const c = cam(),
    r = new Recorder(null, { width: 64, height: 48 })
  try {
    c.setNativeControls([
      { id: id(c, 'SyntheticInt64'), kind: 'int64', value: 9007199254740995n },
    ])
    c.setControls([{ id: Control.exposureTime, type: 'int', values: [4321] }])
    const recording = c.startRecording(r),
      next = await recording.switchModeAsync(
        { width: 128, height: 96 },
        {},
        null,
      )
    expect(state(c, 'SyntheticInt64')).toBe(9007199254740995n)
    expect(
      value(await latest(c, c.controlSnapshot().revision), 'SyntheticInt64'),
    ).toBe(9007199254740995n)
    await next.flushAsync()
    expect(next.error).toBeUndefined()
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    await r.close()
  }
})

test('native restore revalidates one-shot identity after normalization instead of trusting appId hints', async () => {
  const c = cam()
  try {
    const packet = encodeNativeControls([
        { id: Control.afTrigger, kind: 'int32', value: 0 },
      ]),
      v = new DataView(packet.buffer)
    v.setUint32(8, 5, true) // forge a replay-state packet with no app ID/transient hint
    const revision = new BigUint64Array([99n])
    expect(
      native.zc_restore_native_controls(
        c.handle,
        ptr(packet),
        BigInt(packet.length),
        0n,
        ptr(revision),
      ),
    ).toBe(-1)
    expect(revision[0]).toBe(99n)
    expect(c.nativeControlSnapshot().revision).toBe(0n)
    expect(c.nativeControlSnapshot().controls.records).toEqual([])
  } finally {
    await c.close()
  }
})
test('big-endian native payloads round-trip without precision loss and malformed shapes reject', async () => {
  const c = cam()
  try {
    const packet = encodeNativeControls([
        { id: id(c, 'SyntheticInt64'), kind: 'int64', value: 1n },
      ]),
      v = new DataView(packet.buffer)
    v.setUint32(76, 0, true)
    v.setBigInt64(packet.length - 8, -9007199254740993n, false)
    const revision = new BigUint64Array(1)
    expect(
      native.zc_set_native_controls(
        c.handle,
        ptr(packet),
        BigInt(packet.length),
        ptr(revision),
      ),
    ).toBe(0)
    expect(state(c, 'SyntheticInt64')).toBe(-9007199254740993n)
    expect(value(await latest(c, revision[0]), 'SyntheticInt64')).toBe(
      -9007199254740993n,
    )
    expect(() =>
      c.setNativeControls([
        { id: Control.colourGains, kind: 'float32', value: [1] },
      ]),
    ).toThrow()
    expect(() =>
      c.setNativeControls([
        {
          id: Control.frameDurationLimits,
          kind: 'int64',
          value: [20000n, 10000n],
        },
      ]),
    ).toThrow()
    expect(() =>
      c.setNativeControls([
        {
          id: id(c, 'SyntheticInt64'),
          kind: 'int64',
          value: 0x8000000000000000n,
        },
      ]),
    ).toThrow(RangeError)
    expect(() =>
      c.setNativeControls([
        {
          id: id(c, 'SyntheticInt64'),
          kind: 'int64',
          value: 42 as unknown as bigint,
        },
      ]),
    ).toThrow(RangeError)
  } finally {
    await c.close()
  }
})
test('transient AF mode changes track operating intent and restore prior replay mode on restart', async () => {
  const c = cam()
  try {
    c.setNativeControls([{ id: Control.afMode, kind: 'int32', value: 1 }])
    c.setNativeControls([
      { id: Control.afMode, kind: 'int32', value: 2, replay: false },
    ])
    expect(await c.autofocusPauseAsync()).toBe(3)
    expect(await c.autofocusResumeAsync()).toBe(3)
    await c.stop()
    c.start()
    expect(await failure(c.autofocusPauseAsync())).toMatchObject({ code: -2 })
    expect(state(c, 'AfMode')).toBe(1)
  } finally {
    await c.close()
  }
})

test('bounded encoding checks length before reading elements and does not run caller iterators', async () => {
  const c = cam()
  try {
    let reads = 0
    const large = new Array<number>(2 * 1024 * 1024)
    Object.defineProperty(large, '0', {
      get() {
        reads++
        throw Error('must not read')
      },
    })
    expect(() =>
      c.setNativeControls([
        { id: id(c, 'SyntheticFloats'), kind: 'float32', value: large },
      ]),
    ).toThrow(RangeError)
    expect(reads).toBe(0)
    const bytes = new Uint8Array([1, 2, 3])
    bytes[Symbol.iterator] = () => {
      throw Error('must not iterate')
    }
    c.setNativeControls([
      { id: id(c, 'SyntheticBytes'), kind: 'byte', value: bytes },
    ])
    expect(state(c, 'SyntheticBytes')).toEqual([1, 2, 3])
  } finally {
    await c.close()
  }
})
test('argument getters cannot submit writes after changing mode-job ownership', async () => {
  const c = cam()
  let switching: ReturnType<Camera['switchMode']> | undefined
  try {
    const vendor = id(c, 'SyntheticInt64')
    expect(() =>
      c.setNativeControls([
        {
          id: vendor,
          kind: 'int64',
          get value() {
            switching = c.switchMode({ width: 128, height: 96 })
            return 42n
          },
        },
      ]),
    ).toThrow('camera jobs active')
    await switching
    expect(c.info().width).toBe(128)
    expect(c.nativeControlSnapshot().controls.records).toEqual([])
  } finally {
    await switching
    await c.close()
  }
})

test('total native batch encoding stops at the byte budget before reading later controls', async () => {
  const c = cam()
  try {
    let reads = 0
    const payload = new Uint8Array(3 * 1024 * 1024)
    expect(() =>
      encodeNativeControls([
        { id: 100, kind: 'byte', value: payload },
        { id: 101, kind: 'byte', value: payload },
        {
          id: 102,
          kind: 'byte',
          get value() {
            reads++
            return payload
          },
        },
      ]),
    ).toThrow(RangeError)
    expect(reads).toBe(0)
    expect(c.nativeControlSnapshot().revision).toBe(0n)
  } finally {
    await c.close()
  }
})
test('snapshot replay uses bounded indexed records and rejects oversized data before copying', async () => {
  const source = cam(),
    target = cam()
  try {
    source.setNativeControls([
      {
        id: id(source, 'SyntheticInt64'),
        kind: 'int64',
        value: 9007199254740993n,
      },
    ])
    const snapshot = source.nativeControlSnapshot(),
      records = [...snapshot.controls.records]
    records[Symbol.iterator] = () => {
      throw Error('must not iterate caller records')
    }
    target.restoreNativeControls({
      revision: snapshot.revision,
      controls: { kind: 'control-state', records },
    })
    expect(state(target, 'SyntheticInt64')).toBe(9007199254740993n)
    const oversized = new Uint8Array(4 * 1024 * 1024)
    oversized.slice = () => {
      throw Error('must not copy over-budget data')
    }
    const record = records[0]
    expect(() =>
      encodeNativeSnapshot({
        revision: 0n,
        controls: {
          kind: 'control-state',
          records: [
            { ...record, values: [{ ...record.values[0], bytes: oversized }] },
          ],
        },
      }),
    ).toThrow(RangeError)
  } finally {
    await source.close()
    await target.close()
  }
})
