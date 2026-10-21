import { expect, test } from 'bun:test'
import { Camera, Control } from '../../ts'
import { decodeCatalog, readCatalog } from '../../ts/catalog'
import { native as ffi, ptr, outPointer, handle } from '../../ts/ffi'
const native: {
  zc_catalog_copy: (...args: Parameters<typeof ffi.zc_catalog_copy>) => number
  zc_catalog_close: (...args: Parameters<typeof ffi.zc_catalog_close>) => void
} = ffi
const cam = () =>
  new Camera({
    simulate: true,
    width: 32,
    height: 24,
    raw: true,
    unpackedRaw: true,
    buffers: 3,
    fifo: true,
  })
const current = (catalog: ReturnType<Camera['controls']>, name: string) =>
  catalog.records
    .find((r) => r.name === name)!
    .values.find((v) => v.role === 'current')!
const u32 = (value: number) => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, value, true)
  return b
}
const join = (...parts: Uint8Array[]) => {
  const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    b.set(p, offset)
    offset += p.length
  }
  return b
}
const utf8 = (s: string) => new TextEncoder().encode(s)
function entry(
  kind: number,
  data: Uint8Array,
  count = 1,
  flags = 2,
  role = 0,
  label = '',
) {
  const name = utf8(label)
  return join(
    ...[
      28 + name.length + data.length,
      role,
      kind,
      99,
      flags,
      count,
      name.length,
    ].map(u32),
    name,
    data,
  )
}
function wire(values: Uint8Array[], kind = 4) {
  const name = utf8('fixture'),
    vendor = utf8('test')
  const record = join(
    ...[
      44 +
        name.length +
        vendor.length +
        values.reduce((n, p) => n + p.length, 0),
      0,
      123,
      0,
      99,
      8 | 16 | 32 | 64,
      0,
      255,
      name.length,
      vendor.length,
      values.length,
    ].map(u32),
    name,
    vendor,
    ...values,
  )
  return join(utf8('HCAT'), u32(1), u32(kind), u32(1), record)
}

test('explicit virtual discovery returns stable IDs and advertised properties without opening a camera', () => {
  const [camera] = Camera.discover({ simulate: true })
  expect(camera).toMatchObject({
    id: 'synthetic',
    index: 0,
    backend: 'synthetic',
  })
  expect(
    camera.properties.find((r) => r.name === 'Model')!.values[0].value,
  ).toBe('zig-camera synthetic')
  expect(
    camera.properties.find((r) => r.name === 'PixelArraySize')!.values[0].value,
  ).toEqual({ width: 4056, height: 3040 })
  expect(
    camera.properties.find((r) => r.name === 'PixelArrayActiveAreas')!.values[0]
      .value,
  ).toEqual([{ x: 0, y: 0, width: 4056, height: 3040 }])
  // @ts-expect-error JavaScript callers also receive validation.
  expect(() => Camera.discover({ simulate: 1 })).toThrow(RangeError)
  expect(() => Camera.discover()).toThrow('(-8)')
})
test('catalogs advertise every virtual control with typed ranges and allowed values', async () => {
  const c = cam()
  try {
    const controls = c.controls()
    expect(controls.kind).toBe('controls')
    expect(controls.records.length).toBe(40)
    const exposure = controls.records.find((r) => r.name === 'ExposureTime')!
    expect(exposure).toMatchObject({
      appId: Control.exposureTime,
      kind: 'int32',
      input: true,
      output: false,
      vendor: 'synthetic',
      isArray: false,
      extent: 0,
    })
    expect(exposure.values.map((v) => [v.role, v.value])).toEqual([
      ['minimum', 1],
      ['maximum', 1000000],
      ['default', 10000],
    ])
    expect(
      controls.records.find((r) => r.name === 'FrameDurationLimits')!.values[0]
        .value,
    ).toEqual([1n, 1n])
    expect(
      controls.records
        .find((r) => r.name === 'AfMode')!
        .values.filter((v) => v.role === 'choice')
        .map((v) => v.value),
    ).toEqual([0, 1, 2])
    expect(controls.records.find((r) => r.name === 'AfWindows')).toMatchObject({
      isArray: true,
      extent: null,
    })
    expect(Object.isFrozen(controls.records)).toBe(true)
    expect(c.properties().kind).toBe('properties')
    c.setControls([{ id: Control.exposureTime, type: 'int', values: [2345] }])
    expect(c.controls()).toEqual(controls)
  } finally {
    await c.close()
  }
})
test('full metadata owns exact timestamps, arrays and opaque values from one retained request', async () => {
  const c = cam()
  let request: Awaited<ReturnType<Camera['captureRequest']>> | undefined
  try {
    c.startContinuousAutofocus()
    request = await c.captureRequest()
    const child = request.retain()
    request.release()
    request = child
    const compact = request.metadata(),
      metadata = request.metadataCatalog()
    expect(metadata.kind).toBe('metadata')
    expect(current(metadata, 'SensorTimestamp').value).toBe(compact.timestampNs)
    expect(compact.timestampNs).toBeGreaterThan(9007199254740992n)
    expect(current(metadata, 'ExposureTime').value).toBe(compact.exposureUs)
    expect(current(metadata, 'ColourGains').value).toEqual([
      compact.redGain,
      compact.blueGain,
    ])
    expect(current(metadata, 'ScalerCrop').value).toEqual(compact.crop)
    expect(current(metadata, 'AfPauseState').value).toBe(compact.afPauseState)
    expect(current(metadata, 'ColourCorrectionMatrix').value).toEqual([
      1, 0, 0, 0, 1, 0, 0, 0, 1,
    ])
    expect(current(metadata, 'SensorBlackLevels').value).toEqual([
      1024, 1024, 1024, 1024,
    ])
    expect(current(metadata, 'SyntheticOpaque')).toMatchObject({
      kind: 'opaque',
      count: 2,
    })
    expect(current(metadata, 'SyntheticOpaque').bytes).toEqual(
      new Uint8Array([0, 255, 127]),
    )
    for (let i = 0; i < 8; i++) await c.captureMetadata()
    expect(request.metadataCatalog()).toEqual(metadata)
    await c.stop()
    expect(request.metadataCatalog()).toEqual(metadata)
    request.release()
    expect(() => request!.metadataCatalog()).toThrow('released')
    await c.close()
    expect(current(metadata, 'SensorTimestamp').value).toBe(compact.timestampNs)
  } finally {
    request?.release()
    await c.close()
  }
})
test('properties and control snapshots survive mode changes and source close independently', async () => {
  const c = cam()
  const props = c.properties(),
    controls = c.controls()
  await c.switchMode({ width: 64, height: 48 })
  const crop = c.controls().records.find((r) => r.name === 'ScalerCrop')!
  expect(crop.values.find((v) => v.role === 'maximum')!.value).toEqual({
    x: 0,
    y: 0,
    width: 64,
    height: 48,
  })
  expect(
    controls.records
      .find((r) => r.name === 'ScalerCrop')!
      .values.find((v) => v.role === 'maximum')!.value,
  ).toEqual({ x: 0, y: 0, width: 32, height: 24 })
  await c.close()
  expect(props.kind).toBe('properties')
  expect(() => c.controls()).toThrow('unavailable')
})
test('C snapshot copies reject short buffers atomically and invalidate failed out handles', () => {
  const out = outPointer(),
    length = new BigUint64Array(1)
  expect(ffi.zc_discover(0, ptr(out))).toBe(0)
  const owned = handle(out)
  try {
    expect(ffi.zc_catalog_copy(owned, null, 0n, ptr(length))).toBe(0)
    const bytes = new Uint8Array(Number(length[0])).fill(0xaa)
    expect(
      ffi.zc_catalog_copy(owned, ptr(bytes), length[0] - 1n, ptr(length)),
    ).toBe(-1)
    expect(bytes.every((b) => b === 0xaa)).toBe(true)
    expect(ffi.zc_catalog_copy(owned, ptr(bytes), length[0], ptr(length))).toBe(
      0,
    )
    expect(decodeCatalog(bytes).kind).toBe('discovery')
  } finally {
    ffi.zc_catalog_close(owned)
  }
  expect(ffi.zc_discover(99, ptr(out))).toBe(-1)
  expect(out[0]).toBe(0n)
})
test('all portable types decode exact payloads in either byte order with owned bytes', () => {
  const integer = new Uint8Array(8),
    integerView = new DataView(integer.buffer)
  integerView.setBigInt64(0, -9007199254740993n, false)
  const float = new Uint8Array(4)
  new DataView(float.buffer).setFloat32(0, NaN, true)
  const fixture = wire([
    entry(0, new Uint8Array(), 0),
    entry(1, new Uint8Array([1])),
    entry(2, new Uint8Array([255])),
    entry(3, new Uint8Array([255, 255, 255, 255])),
    entry(4, integer, 1, 0),
    entry(5, float),
    entry(6, utf8('lake'), 4, 1),
    entry(7, join(u32(0xffffffff), u32(2), u32(3), u32(4))),
    entry(8, join(u32(640), u32(480))),
    entry(9, new Uint8Array([255, 255])),
    entry(10, u32(0xffffffff)),
    entry(11, join(u32(0xfffffffe), u32(7))),
    entry(255, new Uint8Array([8, 9]), 37, 1),
    entry(3, new Uint8Array(), 0, 3),
    entry(3, u32(2), 1, 2, 5, 'Paused'),
  ])
  const result = decodeCatalog(fixture),
    values = result.records[0].values
  expect(values.map((v) => v.value)).toEqual([
    null,
    true,
    255,
    -1,
    -9007199254740993n,
    NaN,
    'lake',
    { x: -1, y: 2, width: 3, height: 4 },
    { width: 640, height: 480 },
    65535,
    4294967295,
    { x: -2, y: 7 },
    new Uint8Array([8, 9]),
    [],
    2,
  ])
  expect(values[14]).toMatchObject({
    role: 'enumerator',
    label: 'Paused',
    nativeType: 99,
  })
  fixture.fill(0)
  expect(values[12].bytes).toEqual(new Uint8Array([8, 9]))
})
test('decoder rejects every truncation, excessive lengths/counts, bad booleans and malformed UTF8 names', () => {
  const bytes = wire([entry(1, new Uint8Array([1]))])
  for (let length = 0; length < bytes.length; length++)
    expect(() => decodeCatalog(bytes.subarray(0, length))).toThrow()
  for (const offset of [4, 8, 12, 16, 44, 48, 52, 56, 71, 79, 91, 95]) {
    const corrupt = bytes.slice()
    if (offset + 4 > corrupt.length) continue
    new DataView(corrupt.buffer).setUint32(offset, 0xffffffff, true)
    expect(() => decodeCatalog(corrupt)).toThrow()
  }
  const invalidName = bytes.slice()
  invalidName[60] = 255
  expect(() => decodeCatalog(invalidName)).toThrow()
  expect(() => decodeCatalog(wire([entry(1, new Uint8Array([2]))]))).toThrow()
  expect(() => decodeCatalog(wire([entry(4, new Uint8Array(7))]))).toThrow()
  expect(() => decodeCatalog(join(bytes, new Uint8Array([0])))).toThrow()
})
test('native snapshots always close when a size query fails', () => {
  const original = native.zc_catalog_close,
    copy = native.zc_catalog_copy
  let closes = 0
  native.zc_catalog_close = (...args) => {
    closes++
    original(...args)
  }
  native.zc_catalog_copy = () => -6
  try {
    expect(() => readCatalog((out) => ffi.zc_discover(0, out))).toThrow('(-6)')
  } finally {
    native.zc_catalog_close = original
    native.zc_catalog_copy = copy
  }
  expect(closes).toBe(1)
})
