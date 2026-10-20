import { expect, test } from 'bun:test'
import {
  Camera,
  Recorder,
  Control,
  Recording,
  JobCancelledError,
  type RuntimeControl,
  type CustomOutput,
} from '../../ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const cam = () =>
  new Camera({ simulate: true, width: 64, height: 48, fifo: true })
const pause = () => new Promise<void>((r) => setTimeout(r, 1))
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > end) throw Error('timeout')
    await pause()
  }
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  return { promise, release }
}
function failure(job: PromiseLike<unknown>) {
  return Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
}
const controls = (): RuntimeControl[] => [
  { id: Control.aeEnable, type: 'bool', values: [0] },
  { id: Control.exposureTime, type: 'int', values: [2500] },
  { id: Control.analogueGain, type: 'float', values: [2] },
  { id: Control.awbEnable, type: 'bool', values: [0] },
  { id: Control.colourGains, type: 'float', values: [1.5, 1.25] },
  { id: Control.afMode, type: 'int', values: [0] },
  { id: Control.lensPosition, type: 'float', values: [3] },
  { id: Control.frameDurationLimits, type: 'int', values: [40000, 40000] },
  { id: Control.scalerCrop, type: 'rect', values: [4, 2, 28, 20] },
]
function settings(
  meta: ReturnType<Camera['captureMetadata']> extends Promise<infer T>
    ? T
    : never,
) {
  expect(meta).toMatchObject({
    exposureUs: 2500,
    analogueGain: 2,
    redGain: 1.5,
    blueGain: 1.25,
    lensPosition: 3,
    frameDurationUs: 40000n,
    crop: { x: 4, y: 2, width: 28, height: 20 },
  })
}

test('successful native control state is copied and replayed before the first frame of a permanent mode', async () => {
  const c = cam()
  try {
    const input = controls(),
      revision = c.setControls(input)
    input[1].values[0] = 9999
    const snapshot = c.controlSnapshot()
    expect(snapshot.revision).toBe(revision)
    expect(
      snapshot.controls.find((x) => x.id === Control.exposureTime)?.values,
    ).toEqual([2500])
    snapshot.controls[0].values[0] = 1
    expect(c.controlSnapshot().controls[0].values).toEqual([0])
    expect(() =>
      c.setControls([
        { id: Control.exposureTime, type: 'int', values: [9999] },
        { id: 999, type: 'int', values: [0] },
      ]),
    ).toThrow()
    expect(c.controlSnapshot().revision).toBe(revision)
    await c.switchMode({ width: 32, height: 24, fifo: true })
    using frame = c.acquire()
    expect(frame.sequence).toBe(0n)
    settings(frame.metadata())
    expect(frame.metadata().controlRevision).toBeGreaterThan(revision)
    expect(frame.metadata().controlRevision).toBe(c.controlSnapshot().revision)
  } finally {
    await c.close()
  }
})

test('temporary metadata, RGB, lores and file captures replay settings on target and restored modes', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-controls-'))
  try {
    c.start()
    let revision = c.setControls(controls())
    const meta = await c.switchModeAndCaptureMetadata({
      width: 128,
      height: 96,
      fifo: true,
    })
    settings(meta)
    expect(meta.controlRevision).toBeGreaterThan(revision)
    expect(c.controlSnapshot().revision).toBeGreaterThan(meta.controlRevision)
    revision = c.controlSnapshot().revision
    expect(
      (await c.switchModeAndCaptureRGB({ width: 128, height: 96 })).length,
    ).toBe(128 * 96 * 3)
    const lores = await c.switchModeAndCaptureBuffer(
      { width: 128, height: 96, lores: { width: 18, height: 10 } },
      'lores',
    )
    expect(lores.data.length).toBe(270)
    for (const extension of ['jpg', 'dng']) {
      const path = join(dir, `capture.${extension}`)
      settings(
        await c.switchModeAndCaptureFile(
          { width: 128, height: 96, fifo: true },
          path,
        ),
      )
      expect(readFileSync(path).length).toBeGreaterThan(100)
    }
    expect(c.controlSnapshot().revision).toBeGreaterThan(revision)
    expect(c.info().width).toBe(64)
    using frame = c.acquire()
    settings(frame.metadata())
    expect(c.stats().leased).toBe(1)
    frame.release()
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replay revalidates crop geometry atomically and restores the old controls when a target rejects', async () => {
  const c = cam()
  try {
    c.start()
    c.setControls(controls())
    const revision = c.setControls([
      { id: Control.scalerCrop, type: 'rect', values: [0, 0, 64, 48] },
    ])
    const result = await failure(
      c.switchMode({ width: 32, height: 24, fifo: true }),
    )
    expect(result).toMatchObject({ controlCode: -1, code: -1 })
    expect(c.info().width).toBe(64)
    expect(c.controlSnapshot().revision).toBeGreaterThan(revision)
    using frame = c.acquire()
    expect(frame.metadata()).toMatchObject({
      exposureUs: 2500,
      analogueGain: 2,
      crop: { x: 0, y: 0, width: 64, height: 48 },
    })
  } finally {
    await c.close()
  }
})

test('coordinated recording failures and retries preserve controls through camera and recorder preparation', async () => {
  const c = cam(),
    r = await Recorder.open(
      { outputframe() {} },
      { width: 64, height: 48, fps: 25 },
    )
  let recording: Recording | undefined
  try {
    c.setControls(controls())
    recording = c.startRecording(r)
    await until(() => recording!.frames >= 2)
    const revision = c.controlSnapshot().revision
    const bad: CustomOutput = {
      commit() {
        throw Error('discard prepared recording')
      },
      outputframe() {},
    }
    expect(
      await failure(
        recording.switchModeAsync(
          { width: 128, height: 96, fifo: true },
          {},
          bad,
        ),
      ),
    ).toMatchObject({ message: 'discard prepared recording' })
    expect(c.info().width).toBe(64)
    expect(r.sessionState()).toMatchObject({ id: 0n, phase: 'flushed' })
    expect(c.controlSnapshot().revision).toBeGreaterThan(revision + 1n)
    using old = c.acquire()
    settings(old.metadata())
    old.release()
    recording = await c.switchRecordingModeAsync(
      r,
      { width: 128, height: 96, fifo: true },
      {},
      { outputframe() {} },
    )
    settings(await c.captureMetadata())
    await recording.flushAsync()
    expect(r.sessionState().id).toBe(1n)
    using next = c.acquire()
    settings(next.metadata())
  } finally {
    await recording?.close()
    await c.close()
    await r.close()
  }
})

test('coordinated mode rejects unsupported controls before candidate output hooks and restores the flushed session', async () => {
  const c = cam(),
    r = new Recorder(null, { width: 64, height: 48 })
  let starts = 0
  try {
    c.start()
    c.setControls([
      { id: Control.scalerCrop, type: 'rect', values: [0, 0, 64, 48] },
    ])
    const result = await failure(
      c.switchRecordingModeAsync(
        r,
        { width: 32, height: 24 },
        {},
        {
          start() {
            starts++
          },
          outputframe() {},
        },
      ),
    )
    expect(result).toMatchObject({ controlCode: -1 })
    expect(starts).toBe(0)
    expect(c.info().width).toBe(64)
    expect(r.width).toBe(64)
    expect(r.sessionState().phase).toBe('flushed')
    expect(c.controlSnapshot().controls[0].values).toEqual([0, 0, 64, 48])
  } finally {
    await c.close()
    await r.close()
  }
})

test('warmup cancellation restores control values and carries revisions forward without leaked leases', async () => {
  const c = cam()
  try {
    c.start()
    const revision = c.setControls(controls())
    const job = c.switchMode(
      { width: 128, height: 96 },
      { dropFrames: 1_000_000 },
    )
    const result = failure(job)
    await until(() => job.progress >= 3)
    expect(job.cancel()).toBe(true)
    expect(await result).toBeInstanceOf(JobCancelledError)
    expect(c.info().width).toBe(64)
    expect(c.controlSnapshot().revision).toBeGreaterThan(revision + 1n)
    using frame = c.acquire()
    settings(frame.metadata())
    frame.release()
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})

test('stopped cameras keep accepted control settings while temporary capture restores stopped state', async () => {
  const c = cam()
  try {
    const revision = c.setControls(controls())
    const meta = await c.switchModeAndCaptureMetadata({
      width: 128,
      height: 96,
    })
    settings(meta)
    expect(c.controlSnapshot().revision).toBeGreaterThan(revision + 1n)
    expect(() => c.acquire()).toThrow()
    c.start()
    using frame = c.acquire()
    settings(frame.metadata())
    expect(frame.metadata().controlRevision).toBe(c.controlSnapshot().revision)
  } finally {
    await c.close()
  }
})

test('AF trigger and pause commands are excluded while persistent autofocus mode survives and new jobs still complete', async () => {
  const c = cam()
  try {
    expect(await c.autofocus()).toBe(3)
    c.setControls([{ id: Control.afPause, type: 'int', values: [0] }])
    const snapshot = c.controlSnapshot()
    expect(
      snapshot.controls.find((x) => x.id === Control.afMode)?.values,
    ).toEqual([1])
    expect(
      snapshot.controls.some(
        (x) => x.id === Control.afPause || x.id === Control.afTrigger,
      ),
    ).toBe(false)
    await c.switchMode({ width: 128, height: 96, fifo: true })
    using frame = c.acquire()
    expect(frame.metadata().afState).toBe(0)
    frame.release()
    expect(await c.autofocus()).toBe(3)
    expect(c.controlSnapshot().revision).toBeGreaterThan(snapshot.revision)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})

test('new AeEnable updates clear older mode aliases while same-batch explicit overrides survive replay', async () => {
  const c = cam()
  try {
    c.setControls([
      { id: Control.exposureTimeMode, type: 'int', values: [1] },
      { id: Control.analogueGainMode, type: 'int', values: [1] },
    ])
    c.setControls([{ id: Control.aeEnable, type: 'bool', values: [1] }])
    expect(c.controlSnapshot().controls.map((x) => x.id)).toEqual([
      Control.aeEnable,
    ])
    c.setControls([
      { id: Control.exposureTimeMode, type: 'int', values: [1] },
      { id: Control.aeEnable, type: 'bool', values: [1] },
    ])
    await c.switchMode({ width: 128, height: 96 })
    expect(c.controlSnapshot().controls).toEqual([
      { id: Control.aeEnable, type: 'bool', values: [1] },
      { id: Control.exposureTimeMode, type: 'int', values: [1] },
    ])
  } finally {
    await c.close()
  }
})

test('FIFO mode claims snapshot the latest accepted controls rather than stale admission state', async () => {
  const c = cam()
  try {
    c.setControls(controls())
    const first = c.switchMode({ width: 128, height: 96, fifo: true })
    c.setControls([{ id: Control.exposureTime, type: 'int', values: [3500] }])
    const second = c.switchMode({ width: 96, height: 64, fifo: true })
    await first
    await second
    using frame = c.acquire()
    expect(frame.metadata().exposureUs).toBe(3500)
    expect(
      c.controlSnapshot().controls.find((x) => x.id === Control.exposureTime)
        ?.values,
    ).toEqual([3500])
  } finally {
    await c.close()
  }
})

const previewTest = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
previewTest(
  'preview mode changes preserve runtime settings before the shared pump resumes',
  async () => {
    const c = cam()
    try {
      c.setControls(controls())
      c.startPreview('runtime controls')
      await c.switchMode({ width: 128, height: 96 })
      settings(await c.captureMetadata())
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
    }
  },
)

test('revision exhaustion rejects mode jobs before consuming camera or flushing the recorder', async () => {
  const c = cam(),
    original = c.handle,
    r = new Recorder(null, { width: 64, height: 48 })
  try {
    const { native, ptr } = await import('../../ts/ffi')
    const control = new Uint8Array(144),
      view = new DataView(control.buffer),
      revision = new BigUint64Array(1)
    view.setUint32(0, Control.exposureTime, true)
    view.setUint32(4, 2, true)
    view.setUint32(8, 1, true)
    view.setFloat64(16, 1700, true)
    expect(
      native.zc_restore_controls(
        c.handle,
        ptr(control),
        1,
        0xfffffffffffffffen,
        ptr(revision),
      ),
    ).toBe(0)
    expect(c.controlSnapshot().revision).toBe(0xffffffffffffffffn)
    expect(
      await failure(c.switchMode({ width: 128, height: 96 })),
    ).toMatchObject({ code: -2 })
    expect(
      await failure(c.switchRecordingModeAsync(r, { width: 128, height: 96 })),
    ).toMatchObject({ code: -2 })
    expect(c.handle).toBe(original)
    expect(c.info().width).toBe(64)
    expect(r.sessionState().phase).toBe('open')
    c.start()
    using frame = c.acquire()
    expect(frame.metadata()).toMatchObject({
      controlRevision: 0xffffffffffffffffn,
      exposureUs: 1700,
    })
  } finally {
    await c.close()
    await r.close()
  }
})

test('late signal cleanup from a cancelled mode cannot release a newer coordinated reservation', async () => {
  const c = cam(),
    r = new Recorder(null, { width: 64, height: 48 }),
    callback = gate(),
    entered = gate(),
    held = gate()
  try {
    c.start()
    c.setControls(controls())
    const old = c.switchRecordingModeAsync(
      r,
      { width: 128, height: 96 },
      {},
      null,
      { timeoutMs: 0, signalFunction: () => callback.promise },
    )
    await old.operationDone
    const next = c.switchRecordingModeAsync(
      r,
      { width: 128, height: 96 },
      {},
      {
        commit: async () => {
          entered.release()
          await held.promise
        },
        outputframe() {},
      },
    )
    const result = failure(next)
    await entered.promise
    callback.release()
    await old.cleanupDone
    expect(() => c.controlSnapshot()).toThrow('coordinated')
    expect(() => r.flushAsync()).toThrow('coordinated')
    expect(next.cancel()).toBe(true)
    held.release()
    expect(await result).toBeInstanceOf(JobCancelledError)
    expect(c.info().width).toBe(64)
    using frame = c.acquire()
    settings(frame.metadata())
  } finally {
    callback.release()
    held.release()
    await c.close()
    await r.close()
  }
})
