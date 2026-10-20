import { expect, test } from 'bun:test'
import { Camera, Recorder, JobCancelledError } from '../../ts'
import { cameraConfiguration } from '../../ts/config'
import {
  native as n,
  ptr,
  handle,
  outPointer,
  type Pointer,
} from '../../ts/ffi'
import type { ModeRequest, ModeResponse } from '../../ts/mode-worker'
const options = { simulate: true, width: 64, height: 48, fifo: true }
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
function worker(request: ModeRequest) {
  return new Promise<ModeResponse>((resolve, reject) => {
    const w = new Worker(
      new URL('../../ts/mode-worker.ts', import.meta.url).href,
    )
    const timer = setTimeout(() => {
      w.terminate()
      reject(Error('mode worker timeout'))
    }, 10000)
    w.onmessage = (event) => {
      clearTimeout(timer)
      w.terminate()
      resolve(event.data)
    }
    w.onerror = (event) => {
      clearTimeout(timer)
      w.terminate()
      reject(Error(event.message))
    }
    w.postMessage(request)
  })
}

test('camera IDs from discovery select exactly and survive close as owned strings', async () => {
  const [discovered] = Camera.discover({ simulate: true })
  const c = new Camera({ ...options, cameraId: discovered.id })
  try {
    expect(c.cameraId).toBe(discovered.id)
    expect(c.info().cameraId).toBe(discovered.id)
    expect(c.options.cameraId).toBe(discovered.id)
    expect((await c.captureMetadata()).sequence).toBe(0n)
    await c.stop()
    expect(c.cameraId).toBe(discovered.id)
  } finally {
    await c.close()
  }
  expect(c.cameraId).toBe(discovered.id)
  for (const id of [
    'syntheti',
    'synthetic2',
    'Synthetic',
    ' synthetic',
    'synthetic ',
  ])
    expect(() => new Camera({ ...options, cameraId: id })).toThrow('(-9)')
})
test('invalid/ambiguous IDs reject before camera creation and validate UTF8 byte limits', () => {
  for (const cameraId of ['', 'x\0y', '\ud800', 'é'.repeat(2049)])
    expect(() => new Camera({ ...options, cameraId })).toThrow(RangeError)
  // @ts-expect-error JavaScript callers are validated too.
  expect(() => new Camera({ ...options, cameraId: 3 })).toThrow(RangeError)
  expect(
    () => new Camera({ ...options, cameraId: 'synthetic', cameraIndex: 0 }),
  ).toThrow('mutually exclusive')
  expect(
    cameraConfiguration({ cameraId: 'é'.repeat(2048) }).cameraId!.length,
  ).toBe(4096)
})
test('both initial selectors pin ID through queued mode switches, AF and temporary captures', async () => {
  for (const selector of [{ cameraIndex: 0 }, { cameraId: 'synthetic' }]) {
    const c = new Camera({ ...options, ...selector })
    try {
      c.startContinuousAutofocus()
      const first = c.switchMode(
        { width: 128, height: 96 },
        { autofocus: true },
      )
      const second = c.switchMode({ width: 64, height: 48 })
      await first
      await second
      expect(c.cameraId).toBe('synthetic')
      expect(c.info().cameraId).toBe('synthetic')
      const settings = c.controlSnapshot().controls
      const frame = await c.switchModeAndCaptureMetadata(
        { width: 128, height: 96 },
        { autofocus: true },
      )
      expect(frame.afState).toBe(2)
      expect(c.info().width).toBe(64)
      expect(c.options).toMatchObject(selector)
      expect(c.controlSnapshot().controls).toEqual(settings)
    } finally {
      await c.close()
    }
  }
})
test('mode admission rejects identity changes and ambiguous selectors without affecting the source', async () => {
  const c = new Camera({ ...options, cameraId: 'synthetic' })
  try {
    const owned = c.handle
    expect(() => c.switchMode({ cameraId: 'other' })).toThrow('retain camera')
    expect(() => c.switchMode({ cameraIndex: 0 })).toThrow('retain camera')
    expect(() =>
      c.switchMode({ cameraId: 'synthetic', cameraIndex: 0 }),
    ).toThrow('mutually exclusive')
    expect(() => c.switchMode({ cameraId: 'bad\0id' })).toThrow(RangeError)
    expect(c.handle).toBe(owned)
    expect(c.info().width).toBe(64)
    await c.switchMode({ cameraId: 'synthetic', width: 128, height: 96 })
    expect(c.cameraId).toBe('synthetic')
  } finally {
    await c.close()
  }
})
test('failed mode preparation and queued cancellation retain ID and source usability', async () => {
  const c = new Camera({ ...options, cameraId: 'synthetic' })
  try {
    expect(
      await failure(
        c.switchMode({ sensor: { width: 12, height: 12, bitDepth: 12 } }),
      ),
    ).toMatchObject({ code: -8 })
    expect(c.info()).toMatchObject({
      cameraId: 'synthetic',
      width: 64,
      height: 48,
    })
    const first = c.switchMode({ width: 128, height: 96 }),
      second = c.switchMode({ width: 64, height: 48 }),
      rejected = failure(second)
    expect(second.cancel()).toBe(true)
    expect(await rejected).toBeInstanceOf(JobCancelledError)
    await first
    expect(c.info()).toMatchObject({ cameraId: 'synthetic', width: 128 })
    expect((await c.captureMetadata()).sequence).toBeGreaterThanOrEqual(0n)
  } finally {
    await c.close()
  }
})
test('coordinated recording reconfiguration preserves explicitly selected camera identity', async () => {
  const c = new Camera({ ...options, cameraId: 'synthetic' }),
    r = new Recorder(null, { width: 64, height: 48 })
  try {
    c.startContinuousAutofocus()
    const recording = c.startRecording(r)
    expect(() => recording.switchModeAsync({ cameraId: 'other' })).toThrow(
      'retain camera',
    )
    const next = await recording.switchModeAsync(
      { width: 128, height: 96 },
      {},
      null,
      { autofocus: true },
    )
    expect(c.cameraId).toBe('synthetic')
    expect(c.info()).toMatchObject({ cameraId: 'synthetic', width: 128 })
    await next.flushAsync()
    expect(next.error).toBeUndefined()
  } finally {
    await c.close()
    await r.close()
  }
})
for (const failing of [false, true]) {
  test(`mode worker uses pinned ID despite stale indices during ${failing ? 'rollback' : 'target open'}`, async () => {
    const initial = cameraConfiguration({ width: 16, height: 16 }),
      out = outPointer()
    expect(
      n.zc_open_pipeline(ptr(initial.config), ptr(initial.pipeline), ptr(out)),
    ).toBe(0)
    let owned = handle(out)
    try {
      const target = cameraConfiguration(
        failing
          ? {
              width: 32,
              height: 24,
              sensor: { width: 12, height: 12, bitDepth: 12 },
            }
          : { width: 32, height: 24 },
      )
      new DataView(initial.config.buffer).setUint32(12, 999, true)
      new DataView(target.config.buffer).setUint32(12, 777, true)
      const transferred = owned
      owned = 0 as Pointer
      const response = await worker({
        handle: transferred,
        ...target,
        cameraId: new TextEncoder().encode('synthetic'),
        previousConfig: initial.config,
        previousPipeline: initial.pipeline,
        previousStarted: false,
        controls: new Uint8Array(),
        controlCount: 0,
        controlRevision: 0n,
        cancel: new SharedArrayBuffer(8),
        deadline: Date.now() + 5000,
        dropFrames: 0,
      })
      owned = response.handle
      expect(response).toMatchObject({
        code: failing ? -8 : 0,
        restoreCode: 0,
        target: !failing,
      })
      const id = new Uint8Array(9),
        length = new Uint32Array(1)
      expect(n.zc_get_camera_id(owned, ptr(id), id.length, ptr(length))).toBe(0)
      expect(new TextDecoder().decode(id)).toBe('synthetic')
      const info = new Uint8Array(680)
      expect(n.zc_get_info(owned, ptr(info))).toBe(0)
      expect(new DataView(info.buffer).getUint32(8, true)).toBe(
        failing ? 16 : 32,
      )
    } finally {
      if (owned) expect(n.zc_close(owned)).toBe(0)
    }
  })
}
test('mode worker never falls back to a valid numeric camera when the pinned ID is absent', async () => {
  const initial = cameraConfiguration({ width: 16, height: 16 }),
    out = outPointer()
  expect(
    n.zc_open_pipeline(ptr(initial.config), ptr(initial.pipeline), ptr(out)),
  ).toBe(0)
  const response = await worker({
    handle: handle(out),
    ...initial,
    cameraId: new TextEncoder().encode('absent'),
    previousConfig: initial.config,
    previousPipeline: initial.pipeline,
    previousStarted: false,
    controls: new Uint8Array(),
    controlCount: 0,
    controlRevision: 0n,
    cancel: new SharedArrayBuffer(8),
    deadline: Date.now() + 5000,
    dropFrames: 0,
  })
  expect(response).toMatchObject({ code: -9, restoreCode: -9, target: false })
  expect(response.handle).toBe(0 as Pointer)
})
test('native ID copies report exact length, reject short buffers atomically and reject malformed input', async () => {
  const c = new Camera(options),
    length = new Uint32Array(1)
  try {
    expect(n.zc_get_camera_id(c.handle, null, 0, ptr(length))).toBe(0)
    expect(length[0]).toBe(9)
    const data = new Uint8Array(10).fill(0xaa)
    expect(n.zc_get_camera_id(c.handle, ptr(data), 8, ptr(length))).toBe(-1)
    expect(data.every((b) => b === 0xaa)).toBe(true)
    expect(
      n.zc_get_camera_id(c.handle, ptr(data), data.length, ptr(length)),
    ).toBe(0)
    expect(new TextDecoder().decode(data.subarray(0, 9))).toBe('synthetic')
    expect(data[9]).toBe(0xaa)
    const config = cameraConfiguration({}),
      out = outPointer()
    for (const id of [new Uint8Array([255]), new Uint8Array([97, 0, 98])]) {
      expect(
        n.zc_open_id_pipeline(
          ptr(config.config),
          ptr(config.pipeline),
          ptr(id),
          id.length,
          ptr(out),
        ),
      ).toBe(-1)
      expect(out[0]).toBe(0n)
    }
  } finally {
    await c.close()
  }
})

test('constructor snapshots getter-based selectors once before acquisition', async () => {
  let idReads = 0,
    backendReads = 0
  const source = {
    width: 32,
    height: 24,
    get cameraId() {
      return ++idReads === 1 ? 'synthetic' : 'absent'
    },
    get simulate() {
      return ++backendReads === 1
    },
  }
  const c = new Camera(source)
  try {
    expect(idReads).toBe(1)
    expect(backendReads).toBe(1)
    expect(c.options).toMatchObject({ cameraId: 'synthetic', simulate: true })
    expect(c.cameraId).toBe('synthetic')
    await c.switchMode({ width: 64, height: 48 })
    expect(c.info().cameraId).toBe('synthetic')
    expect(idReads).toBe(1)
    expect(backendReads).toBe(1)
  } finally {
    await c.close()
  }
})
