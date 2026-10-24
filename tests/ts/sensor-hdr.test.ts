import { expect, test } from 'bun:test'
import {
  Camera,
  CameraError,
  Control,
  HdrMode,
  IMX708,
  SensorHdrError,
  getTuningState,
} from '../../ts'
import { native as n, ptr, outPointer, handle } from '../../ts/ffi'
const open = () => new IMX708({ backend: 'synthetic' })
function users() {
  const count = new Uint32Array(1)
  expect(n.zc_sensor_layout_users_get(0, ptr(count))).toBe(0)
  return count[0]
}
function busy(sensor: IMX708) {
  try {
    sensor.setSensorHdrMode(true)
    throw Error('accepted busy mutation')
  } catch (e) {
    expect(e).toBeInstanceOf(SensorHdrError)
    const error = e as SensorHdrError
    expect(error.code).toBe(-4)
    expect(error.state.enabled).toBeUndefined()
    expect(error.state.writeAttempted).toBe(false)
  }
}
async function marker(camera: Camera, revision: bigint) {
  for (let i = 0; i < 32; i++) {
    using request = await camera.captureRequest()
    if (request.metadata().controlRevision >= revision)
      return request
        .metadataCatalog()
        .records.find((r) => r.name === 'SyntheticHdrMode')!.values[0].value
  }
  throw Error('revision did not arrive')
}
test('sensor helpers snapshot selectors once, own identity and preserve mode after close', () => {
  let reads = 0
  using sensor = new IMX708({
    get backend() {
      reads++
      return 'synthetic' as const
    },
    get index() {
      reads++
      return 0
    },
    get cameraId() {
      reads++
      return undefined
    },
  })
  expect(reads).toBe(3)
  expect(sensor.cameraId).toBe('synthetic')
  try {
    const before = sensor.setSensorHdrMode(false)
    expect(before.enabled).toBe(false)
    const changed = sensor.setSensorHdrMode(true)
    expect(changed).toMatchObject({
      backend: 'synthetic',
      previousEnabled: false,
      enabled: true,
      changed: true,
      writeAttempted: true,
      writeSucceeded: true,
      catalogInvalidated: true,
    })
    const same = sensor.setSensorHdrMode(true)
    expect(same).toMatchObject({
      previousEnabled: true,
      enabled: true,
      changed: false,
      writeAttempted: false,
      writeSucceeded: false,
      catalogInvalidated: false,
    })
    sensor.close()
    sensor.close()
    expect(() => sensor.getSensorHdrMode()).toThrow(CameraError)
    using exact = new IMX708({ backend: 'synthetic', cameraId: 'synthetic' })
    expect(exact.getSensorHdrMode().enabled).toBe(true)
    exact.setSensorHdrMode(false)
  } finally {
    using cleanup = open()
    cleanup.setSensorHdrMode(false)
  }
})
test('strict selectors and boolean validation do not consume helper admission', () => {
  for (const source of [
    null,
    { backend: 'wrong' },
    { backend: 'synthetic', index: -1 },
    { backend: 'synthetic', index: 0xffffffff },
    { backend: 'synthetic', cameraId: '' },
    { backend: 'synthetic', cameraId: 'x\0y' },
    { backend: 'synthetic', cameraId: '\ud800' },
    { backend: 'synthetic', index: 0, cameraId: 'synthetic' },
  ])
    expect(() => new IMX708(source as never)).toThrow()
  expect(() => new IMX708({ backend: 'synthetic', index: 1 })).toThrow(
    CameraError,
  )
  const helpers: IMX708[] = []
  try {
    for (let i = 0; i < 16; i++) helpers.push(open())
    expect(() => open()).toThrow(CameraError)
    expect(() => helpers[0].setSensorHdrMode(1 as never)).toThrow(TypeError)
  } finally {
    for (const h of helpers) h.close()
  }
  using next = open()
  expect(next.cameraId).toBe('synthetic')
})
test('stopped cameras and manager watches block layout changes until joined close', async () => {
  using sensor = open()
  sensor.setSensorHdrMode(false)
  const camera = new Camera({
    simulate: true,
    width: 32,
    height: 24,
    fifo: true,
  })
  const held = users()
  try {
    expect(held).toBe(2)
    busy(sensor)
    camera.start()
    await camera.stop()
    busy(sensor)
  } finally {
    await camera.close()
  }
  expect(users()).toBe(0)
  const watch = Camera.watchCameras({ simulate: true })
  try {
    busy(sensor)
  } finally {
    await watch.close()
  }
  sensor.setSensorHdrMode(true)
  try {
    await using c = new Camera({
      simulate: true,
      width: 32,
      height: 24,
      raw: true,
    })
    expect(c.sensorModes()).toEqual([
      { width: 1920, height: 1080, bitDepth: 10, format: 'SRGGB10' },
    ])
    c.start()
    using frame = c.acquire()
    expect(frame.copyStream('raw').format).toBe('SRGGB10')
  } finally {
    sensor.setSensorHdrMode(false)
  }
  await using fresh = new Camera({ simulate: true, width: 32, height: 24 })
  expect(fresh.sensorModes().length).toBe(3)
})
test('logical native scopes protect the zero-manager worker gap independently of tuning ownership', () => {
  using sensor = open()
  sensor.setSensorHdrMode(false)
  const out = outPointer()
  expect(n.zc_sensor_layout_scope_open(0, ptr(out))).toBe(0)
  const scope = handle(out)
  try {
    expect(getTuningState({ simulate: true }).managerUsers).toBe(0)
    expect(users()).toBe(1)
    busy(sensor)
  } finally {
    expect(n.zc_sensor_layout_scope_close(scope)).toBe(0)
  }
  expect(users()).toBe(0)
  sensor.setSensorHdrMode(false)
})
test('runtime ISP HDR is request-local, independent of sensor HDR and replayed across modes', async () => {
  using sensor = open()
  sensor.setSensorHdrMode(false)
  const c = new Camera({ simulate: true, width: 32, height: 24, fifo: true })
  try {
    expect(
      c
        .controls()
        .records.some(
          (r) => r.name === 'HdrMode' && r.appId === Control.hdrMode,
        ),
    ).toBe(true)
    for (const mode of Object.values(HdrMode)) {
      const revision = c.setHdrMode(mode)
      expect(await marker(c, revision)).toBe(mode)
    }
    const revision = c.setHdrMode(HdrMode.singleExposure)
    expect(
      c.controlSnapshot().controls.find((x) => x.id === Control.hdrMode)
        ?.values,
    ).toEqual([1])
    await c.switchMode({ width: 48, height: 32, fifo: true })
    expect(await marker(c, revision)).toBe(1)
    busy(sensor)
    await c.switchModeAndCaptureMetadata({ width: 64, height: 48, fifo: true })
    expect(await marker(c, c.controlSnapshot().revision)).toBe(1)
    expect(sensor.getSensorHdrMode().enabled).toBe(false)
    expect(c.sensorModes().length).toBe(3)
    for (const bad of [-1, 5, 1.1, NaN, '1'])
      expect(() => c.setHdrMode(bad as never)).toThrow(RangeError)
  } finally {
    await c.close()
  }
  expect(users()).toBe(0)
})
test('failed close keeps layout ownership until the retained request is released', async () => {
  using sensor = open()
  sensor.setSensorHdrMode(false)
  const c = new Camera({ simulate: true, width: 32, height: 24, fifo: true })
  c.start()
  const frame = c.acquire()
  try {
    await expect(c.close()).rejects.toBeInstanceOf(CameraError)
    expect(users()).toBe(2)
    busy(sensor)
  } finally {
    frame.release()
    await c.close()
  }
  expect(users()).toBe(0)
})
test('HDR layout rejects unavailable explicit modes without leaking logical ownership', () => {
  using sensor = open()
  sensor.setSensorHdrMode(true)
  try {
    expect(
      () =>
        new Camera({
          simulate: true,
          width: 32,
          height: 24,
          sensor: { width: 640, height: 480, bitDepth: 12 },
        }),
    ).toThrow(CameraError)
    expect(users()).toBe(0)
  } finally {
    sensor.setSensorHdrMode(false)
  }
})
