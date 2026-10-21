import { test, expect } from 'bun:test'
import {
  Camera,
  Recorder,
  Control,
  type PreviewOptions,
  type Frame,
} from '../../ts'
import { native } from '../../ts/ffi'
const options = { simulate: true, width: 64, height: 48, fifo: true } as const
const sleep = (ms = 1) => new Promise<void>((r) => setTimeout(r, ms))
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > end) throw Error('headless preview timeout')
    await sleep()
  }
}
const failed = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (e) => e,
  )
function gate() {
  let release!: () => void
  const promise = new Promise<void>((r) => (release = r))
  return { promise, release }
}
test('headless preview drains native requests without SDL, copied RGB or callback work', async () => {
  const c = new Camera(options),
    originals = {
      open: native.zc_preview_open,
      show: native.zc_preview_show,
      overlay: native.zc_preview_set_overlay,
      create: native.zc_preview_overlay_create,
      copy: native.zc_copy_rgb,
    }
  Object.assign(native, {
    zc_preview_open: () => {
      throw Error('SDL open')
    },
    zc_preview_show: () => {
      throw Error('SDL show')
    },
    zc_preview_set_overlay: () => {
      throw Error('SDL overlay')
    },
    zc_preview_overlay_create: () => {
      throw Error('overlay allocation')
    },
    zc_copy_rgb: () => {
      throw Error('pixel copy')
    },
  })
  try {
    c.startPreview({ backend: 'headless', title: '' })
    expect(c.previewInfo()).toEqual({
      backend: 'headless',
      title: '',
      suspended: false,
    })
    const before = c.stats().delivered
    await until(() => c.stats().delivered >= before + 4n)
    expect(c.stats().leased).toBe(0)
    c.setOverlay({ data: new Uint8Array([1, 2, 3, 128]), width: 1, height: 1 })
    c.setOverlay(null)
    expect(() =>
      c.setOverlay({ data: new Uint8Array(3), width: 1, height: 1 }),
    ).toThrow()
    expect(() => c.startPreview({ backend: 'headless' })).toThrow(
      'already active',
    )
    c.stopPreview()
    expect(c.previewInfo()).toBeUndefined()
    const stopped = c.stats().delivered
    await sleep(10)
    expect(c.stats().delivered).toBe(stopped)
  } finally {
    await c.close()
    Object.assign(native, {
      zc_preview_open: originals.open,
      zc_preview_show: originals.show,
      zc_preview_set_overlay: originals.overlay,
      zc_preview_overlay_create: originals.create,
      zc_copy_rgb: originals.copy,
    })
  }
})
test('headless callbacks and retained requests keep explicit ownership while captures share the pump', async () => {
  const c = new Camera(options)
  let callbacks = 0,
    retained: Frame | undefined
  try {
    c.preCallback = (frame) => {
      callbacks++
      retained ??= frame.retain()
    }
    c.startPreview({ backend: 'headless' })
    await until(() => callbacks >= 3)
    const request = await c.captureRequest()
    expect(c.stats().leased).toBe(2)
    request.release()
    retained!.release()
    retained = undefined
    // Stop further retention without stopping callback processing.
    c.setRequestCallbacks({
      post: () => {
        callbacks++
      },
    })
    c.stopPreview()
    const before = callbacks
    await until(() => callbacks > before)
    c.setRequestCallbacks()
    await sleep(5)
    expect(c.stats().leased).toBe(0)
    const stopped = c.stats().delivered
    await sleep(5)
    expect(c.stats().delivered).toBe(stopped)
    c.startPreview({ backend: 'headless' })
    expect((await c.captureRGB()).length).toBe(64 * 48 * 3)
  } finally {
    retained?.release()
    await c.close()
  }
})
test('headless preview is restored through ordinary and temporary modes with runtime controls and CAF', async () => {
  const c = new Camera(options)
  try {
    c.startPreview({ backend: 'headless', title: 'no window' })
    c.setControls([
      { id: Control.exposureTime, type: 'int', values: [3200] },
      { id: Control.aeEnable, type: 'bool', values: [0] },
    ])
    c.startContinuousAutofocus()
    expect(await c.autofocusPauseAsync()).toBe(3)
    expect(await c.autofocusResumeAsync()).toBe(3)
    await c.switchMode({ width: 96, height: 64 }, { autofocusPolicy: 'wait' })
    expect(c.previewInfo()).toEqual({
      backend: 'headless',
      title: 'no window',
      suspended: false,
    })
    const temporary = await c.switchModeAndCaptureRGB({ width: 80, height: 48 })
    expect(temporary.length).toBe(80 * 48 * 3)
    expect(c.info().width).toBe(96)
    expect((await c.captureMetadata()).exposureUs).toBe(3200)
    const focus = await c.captureFocusLockedMetadata()
    expect(focus.afPauseState).toBe(2)
    expect(c.previewInfo()?.suspended).toBe(false)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('cancelling a suspended headless mode joins restoration before resuming the pump', async () => {
  const c = new Camera(options)
  try {
    c.startPreview({ backend: 'headless' })
    const job = c.switchMode(
        { width: 96, height: 64 },
        { dropFrames: 1_000_000, timeoutMs: 10000 },
      ),
      result = failed(job),
      reason = Error('cancel headless mode')
    await until(() => c.previewInfo()?.suspended === true)
    expect(() => c.setOverlay(null)).toThrow('mode change active')
    expect(() => c.stopPreview()).toThrow('mode change active')
    expect(job.cancel(reason)).toBe(true)
    expect(await result).toBe(reason)
    expect(c.info().width).toBe(64)
    expect(c.previewInfo()?.suspended).toBe(false)
    const before = c.stats().delivered
    await until(() => c.stats().delivered > before)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('headless preview survives single and group recorder publication and reports suspension during held preparation', async () => {
  const c = new Camera(options),
    a = await Recorder.open(
      { outputframe() {} },
      {
        width: 64,
        height: 48,
        fps: 25,
        asyncWrites: true,
      },
    ),
    b = await Recorder.open(
      { outputframe() {} },
      {
        width: 96,
        height: 64,
        fps: 25,
        asyncWrites: true,
      },
    ),
    hold = gate()
  let entered = false
  try {
    c.startPreview({ backend: 'headless' })
    c.startRecording(a)
    const single = await c.switchRecordingModeAsync(
      a,
      { width: 96, height: 64 },
      {},
      { outputframe() {} },
    )
    const peer = c.startRecording(b)
    const job = c.switchRecordingsModeAsync({ width: 80, height: 48 }, [
      {
        recording: single,
        output: {
          outputframe() {},
          async start() {
            entered = true
            await hold.promise
          },
        },
      },
      { recording: peer, output: { outputframe() {} } },
    ])
    await until(() => entered)
    expect(c.previewInfo()?.suspended).toBe(true)
    hold.release()
    const next = await job
    expect(next.length).toBe(2)
    expect(c.previewInfo()?.suspended).toBe(false)
    const before = c.stats().delivered
    await until(() => c.stats().delivered > before)
  } finally {
    hold.release()
    await c.close()
    await a.close()
    await b.close()
  }
})
test('failed group output preparation restores headless camera preview without publishing new settings', async () => {
  const c = new Camera(options),
    a = await Recorder.open(
      { outputframe() {} },
      { width: 64, height: 48, asyncWrites: true },
    ),
    b = await Recorder.open(
      { outputframe() {} },
      { width: 64, height: 48, asyncWrites: true },
    )
  try {
    c.startPreview({ backend: 'headless' })
    const x = c.startRecording(a),
      y = c.startRecording(b)
    expect(
      await failed(
        c.switchRecordingsModeAsync({ width: 96, height: 64 }, [
          {
            recording: x,
            output: {
              outputframe() {},
              start() {
                throw Error('candidate output')
              },
            },
          },
          { recording: y },
        ]),
      ),
    ).toBeInstanceOf(Error)
    expect(c.info().width).toBe(64)
    expect([a.width, b.width]).toEqual([64, 64])
    expect(c.previewInfo()?.suspended).toBe(false)
    const before = c.stats().delivered
    await until(() => c.stats().delivered > before)
  } finally {
    await c.close()
    await a.close()
    await b.close()
  }
})
test('headless stop and close join mode cancellation and allow fresh preview sessions', async () => {
  const c = new Camera(options)
  c.startPreview({ backend: 'headless' })
  const job = c.switchMode(
      { width: 96, height: 64 },
      { dropFrames: 1_000_000, timeoutMs: 10000 },
    ),
    result = failed(job)
  await until(() => c.previewInfo()?.suspended === true)
  await c.stop()
  expect(await result).toBeInstanceOf(Error)
  expect(c.previewInfo()).toBeUndefined()
  expect(c.stats().leased).toBe(0)
  c.startPreview({ backend: 'headless' })
  await c.captureMetadata()
  await c.close()
  expect(c.previewInfo()).toBeUndefined()
  await c.close()
})
test('invalid and reentrant preview options never strand a headless owner', async () => {
  const c = new Camera(options),
    start = native.zc_start
  try {
    for (const invalid of [
      null,
      { backend: 'other' },
      { backend: 'headless', title: 'bad\0title' },
      { backend: 'headless', title: 5 },
    ])
      expect(() => c.startPreview(invalid as PreviewOptions)).toThrow()
    expect(c.previewInfo()).toBeUndefined()
    const settings: PreviewOptions = { backend: 'headless', title: 'snapshot' }
    c.startPreview(settings)
    settings.backend = 'sdl'
    settings.title = 'changed'
    const info = c.previewInfo()!
    info.title = 'mutated'
    expect(c.previewInfo()?.title).toBe('snapshot')
    c.stopPreview()
    await c.stop()
    Object.assign(native, { zc_start: () => -6 })
    expect(() => c.startPreview({ backend: 'headless' })).toThrow()
    Object.assign(native, { zc_start: start })
    expect(c.previewInfo()).toBeUndefined()
    const reentry: PreviewOptions = {
      get backend() {
        c.startPreview({ backend: 'headless' })
        return 'headless' as const
      },
    }
    expect(() => c.startPreview(reentry)).toThrow('already active')
    expect(c.previewInfo()?.backend).toBe('headless')
    c.stopPreview()
    c.startPreview({ backend: 'headless' })
    expect(c.previewInfo()?.suspended).toBe(false)
  } finally {
    Object.assign(native, { zc_start: start })
    await c.close()
  }
})
const preview = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
preview(
  'SDL and headless sessions can alternate; stopped overlays are released and SDL setup failure permits a fresh headless start',
  async () => {
    const c = new Camera(options),
      original = native.zc_preview_open
    try {
      c.startPreview({ backend: 'sdl', title: '' })
      c.setOverlay({
        data: new Uint8Array([255, 0, 0, 128]),
        width: 1,
        height: 1,
      })
      c.stopPreview()
      c.startPreview({ backend: 'headless' })
      await c.captureMetadata()
      c.stopPreview()
      Object.assign(native, { zc_preview_open: () => -6 })
      expect(() => c.startPreview()).toThrow()
      expect(c.previewInfo()).toBeUndefined()
      c.startPreview({ backend: 'headless' })
      c.stopPreview()
      Object.assign(native, { zc_preview_open: original })
      c.startPreview('SDL restored')
      expect(c.previewInfo()?.backend).toBe('sdl')
      await c.captureRGB()
    } finally {
      Object.assign(native, { zc_preview_open: original })
      await c.close()
    }
  },
)

test('headless preview continues after a failing callback is quarantined and rejects ownership reentry', async () => {
  const c = new Camera(options)
  try {
    c.preCallback = () => c.stopPreview()
    c.startPreview({ backend: 'headless' })
    await until(() => c.requestCallbackError !== undefined)
    expect(c.requestCallbackError).toBeInstanceOf(Error)
    expect(c.preCallback).toBeUndefined()
    expect(c.previewInfo()?.suspended).toBe(false)
    const before = c.stats().delivered
    await until(() => c.stats().delivered > before)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
