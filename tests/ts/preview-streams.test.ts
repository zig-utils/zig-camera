import { test, expect } from 'bun:test'
import { Camera, Recorder, type PreviewStream } from '../../ts'
import { native } from '../../ts/ffi'
const options = {
  simulate: true,
  width: 64,
  height: 48,
  lores: { width: 16, height: 12 },
  fifo: true,
} as const
const preview = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
const pause = (ms = 1) => new Promise<void>((r) => setTimeout(r, ms))
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > end) throw Error('preview stream timeout')
    await pause()
  }
}
const failed = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (e) => e,
  )
test('headless selected streams snapshot negotiated geometry/color and support background without rendering', async () => {
  const c = new Camera(options),
    render = native.zc_preview_show_stream,
    background = native.zc_preview_show_background
  Object.assign(native, {
    zc_preview_show_stream: () => {
      throw Error('headless rendering')
    },
    zc_preview_show_background: () => {
      throw Error('headless background')
    },
  })
  try {
    c.startPreview({ backend: 'headless', stream: 'lores' })
    const info = c.previewStreamInfo()!
    expect(info).toMatchObject({
      stream: 'lores',
      width: 16,
      height: 12,
      format: 'YUV420',
      colorSpace: { present: true, ycbcrEncoding: 'rec601', range: 'full' },
      suspended: false,
    })
    info.width = 999
    info.colorSpace!.range = 'unknown'
    expect(c.previewStreamInfo()?.width).toBe(16)
    expect(c.previewStreamInfo()?.colorSpace?.range).toBe('full')
    c.setPreviewStream(null)
    expect(c.previewStreamInfo()).toEqual({
      stream: null,
      width: 64,
      height: 48,
      suspended: false,
    })
    c.setPreviewStream('main')
    expect(c.previewStreamInfo()?.format).toBe('BGR888')
    expect(c.previewInfo()?.stream).toBe('main')
    await c.captureMetadata()
    expect(c.stats().leased).toBe(0)
    c.stopPreview()
    expect(c.previewStreamInfo()).toBeUndefined()
  } finally {
    await c.close()
    Object.assign(native, {
      zc_preview_show_stream: render,
      zc_preview_show_background: background,
    })
  }
})
test('disabled and invalid preview streams reject before replacing a live owner', async () => {
  const c = new Camera({ simulate: true, width: 64, height: 48 })
  try {
    expect(() =>
      c.startPreview({ backend: 'headless', stream: 'lores' }),
    ).toThrow('lores stream disabled')
    expect(c.previewInfo()).toBeUndefined()
    for (const stream of ['raw', 'other', 1] as unknown as PreviewStream[])
      expect(() => c.startPreview({ backend: 'headless', stream })).toThrow(
        'invalid preview stream',
      )
    c.startPreview({ backend: 'headless' })
    const before = c.previewStreamInfo()
    expect(() => c.setPreviewStream('lores')).toThrow('lores stream disabled')
    expect(c.previewStreamInfo()).toEqual(before)
    expect(() =>
      c.setPreviewStream(undefined as unknown as PreviewStream),
    ).toThrow('explicit preview stream required')
  } finally {
    await c.close()
  }
})
test('live source/view preparation is atomic and rejects accessor reentry', async () => {
  const c = new Camera(options)
  try {
    c.startPreview({
      backend: 'headless',
      overlay: { rectangle: { x: 20, y: 10, width: 20, height: 20 } },
    })
    expect(() => c.setPreviewStream('lores')).toThrow()
    expect(c.previewStreamInfo()?.stream).toBe('main')
    c.setPreviewStream('lores', {
      overlay: { rectangle: { x: 0, y: 0, width: 8, height: 8 } },
      transform: { hflip: true },
    })
    expect(c.previewStreamInfo()?.stream).toBe('lores')
    expect(c.previewInfo()?.overlay?.rectangle?.width).toBe(8)
    expect(() =>
      c.setPreviewStream('main', {
        get keepAspect() {
          c.setPreviewStream(null)
          return true
        },
      }),
    ).toThrow('preview changed')
    expect(c.previewStreamInfo()?.stream).toBe(null)
  } finally {
    await c.close()
  }
})
for (const format of ['YUV420', 'BGR888'] as const) {
  preview(
    `SDL ${format} lores display uses negotiated source and leaves main captures unchanged`,
    async () => {
      const c = new Camera({
        ...options,
        lores: { width: 16, height: 12, rgb: format === 'BGR888' },
      })
      try {
        c.startPreview({ stream: 'lores', transform: { rotation: 90 } })
        const before = c.stats().delivered
        await until(() => c.stats().delivered > before + 2n)
        expect(c.previewError).toBeUndefined()
        expect(c.previewStreamInfo()).toMatchObject({
          stream: 'lores',
          width: 16,
          height: 12,
          format,
        })
        const f = await c.captureRequest()
        try {
          expect([f.width, f.height]).toEqual([64, 48])
          expect(Array.from(f.copyRGB().slice(0, 2))).toEqual([0, 0])
        } finally {
          f.release()
        }
        c.setPreviewStream('main')
        await c.captureMetadata()
        expect(c.previewStreamInfo()?.width).toBe(64)
        expect(c.stats().leased).toBe(0)
      } finally {
        await c.close()
      }
    },
  )
}
for (const backend of ['headless', 'sdl'] as const) {
  const run = backend === 'sdl' ? preview : test
  run(
    `${backend} selected lores survives temporary modes and rolls back disabled target input`,
    async () => {
      const c = new Camera(options)
      try {
        c.startPreview({ backend, stream: 'lores' })
        await c.switchMode({
          width: 96,
          height: 64,
          lores: { width: 24, height: 16 },
        })
        expect(c.previewStreamInfo()).toMatchObject({
          stream: 'lores',
          width: 24,
          height: 16,
          suspended: false,
        })
        await c.switchModeAndCaptureRGB({
          width: 80,
          height: 48,
          lores: { width: 20, height: 12, rgb: true },
        })
        expect(c.previewStreamInfo()).toMatchObject({
          stream: 'lores',
          width: 24,
          height: 16,
          format: 'YUV420',
        })
        expect(
          await failed(c.switchMode({ width: 64, height: 48 })),
        ).toBeInstanceOf(Error)
        expect(c.info().width).toBe(96)
        expect(c.previewStreamInfo()).toMatchObject({
          stream: 'lores',
          width: 24,
          height: 16,
          suspended: false,
        })
        expect(c.stats().leased).toBe(0)
      } finally {
        await c.close()
      }
    },
  )
}
preview(
  'background-only preview never accesses source pixels and can resume a live source',
  async () => {
    const c = new Camera(options),
      show = native.zc_preview_show_stream,
      background = native.zc_preview_show_background
    let backgrounds = 0
    Object.assign(native, {
      zc_preview_show_stream: () => {
        throw Error('unexpected image read')
      },
      zc_preview_show_background: (...args: Parameters<typeof background>) => {
        backgrounds++
        return background(...args)
      },
    })
    try {
      c.startPreview({ stream: null })
      c.setOverlay({
        data: new Uint8Array([0, 255, 0, 128]),
        width: 1,
        height: 1,
      })
      await until(() => backgrounds >= 3)
      expect(c.previewError).toBeUndefined()
      Object.assign(native, { zc_preview_show_stream: show })
      c.setPreviewStream('lores')
      await c.captureMetadata()
      expect(c.previewStreamInfo()?.stream).toBe('lores')
      expect(c.previewError).toBeUndefined()
    } finally {
      await c.close()
      Object.assign(native, {
        zc_preview_show_stream: show,
        zc_preview_show_background: background,
      })
    }
  },
)
preview(
  'failed source preparation and old-display retirement preserve the previous live preview',
  async () => {
    const c = new Camera(options),
      open = native.zc_preview_open,
      close = native.zc_preview_close
    let failedClose = false
    try {
      c.startPreview()
      const old = c.previewStreamInfo()
      Object.assign(native, { zc_preview_open: () => -6 })
      expect(() => c.setPreviewStream('lores')).toThrow()
      expect(c.previewStreamInfo()).toEqual(old)
      Object.assign(native, {
        zc_preview_open: open,
        zc_preview_close: (...args: Parameters<typeof close>) => {
          if (!failedClose) {
            failedClose = true
            return -6
          }
          return close(...args)
        },
      })
      expect(() => c.setPreviewStream('lores')).toThrow('old preview close')
      expect(c.previewStreamInfo()).toEqual(old)
      Object.assign(native, { zc_preview_close: close })
      await c.captureMetadata()
      expect(c.previewError).toBeUndefined()
      c.setPreviewStream('lores')
      await c.captureMetadata()
      expect(c.previewStreamInfo()?.width).toBe(16)
    } finally {
      Object.assign(native, { zc_preview_open: open, zc_preview_close: close })
      await c.close()
    }
  },
)
preview(
  'display failure is observable while healthy recording and capture continue',
  async () => {
    const c = new Camera(options),
      r = await Recorder.open(
        { outputframe() {} },
        { width: 64, height: 48, asyncWrites: true },
      ),
      show = native.zc_preview_show_stream
    let fail = false
    Object.assign(native, {
      zc_preview_show_stream: (...args: Parameters<typeof show>) =>
        fail ? -6 : show(...args),
    })
    try {
      c.startPreview({ stream: 'lores' })
      const recording = c.startRecording(r)
      await until(() => recording.stats().completed >= 2n)
      fail = true
      await until(() => c.previewError !== undefined)
      expect(c.previewError).toMatchObject({ code: -6 })
      expect(c.previewInfo()).toBeUndefined()
      expect(c.previewStreamInfo()).toBeUndefined()
      const count = recording.stats().completed
      await until(() => recording.stats().completed > count)
      expect(recording.error).toBeUndefined()
      expect(c.activeRecordings.length).toBe(1)
      expect((await c.captureRGB()).length).toBe(64 * 48 * 3)
      fail = false
      c.startPreview({ stream: 'main' })
      await c.captureMetadata()
      expect(c.previewError).toBeUndefined()
    } finally {
      await c.close()
      await r.close()
      Object.assign(native, { zc_preview_show_stream: show })
    }
  },
)
preview(
  'coordinated recorder modes and continuous AF preserve selected preview input',
  async () => {
    const c = new Camera(options),
      r = await Recorder.open(
        { outputframe() {} },
        { width: 64, height: 48, asyncWrites: true },
      )
    try {
      c.startPreview({ stream: 'lores' })
      c.startContinuousAutofocus()
      expect(await c.autofocusPauseAsync()).toBe(3)
      expect(await c.autofocusResumeAsync()).toBe(3)
      c.startRecording(r)
      await c.switchRecordingModeAsync(
        r,
        { width: 96, height: 64, lores: { width: 24, height: 16 } },
        {},
        { outputframe() {} },
      )
      expect(c.previewStreamInfo()).toMatchObject({
        stream: 'lores',
        width: 24,
        height: 16,
        suspended: false,
      })
      await c.captureMetadata()
      expect(c.previewError).toBeUndefined()
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
      await r.close()
    }
  },
)
preview(
  'recording group mode publication and rejected lores removal restore the selected source',
  async () => {
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
      c.startPreview({ stream: 'lores' })
      c.setOverlay({
        data: new Uint8Array([10, 20, 30, 128]),
        width: 1,
        height: 1,
      })
      const x = c.startRecording(a),
        y = c.startRecording(b)
      const next = await c.switchRecordingsModeAsync(
        { width: 96, height: 64, lores: { width: 24, height: 16, rgb: true } },
        [{ recording: x }, { recording: y }],
      )
      expect(c.previewStreamInfo()).toMatchObject({
        stream: 'lores',
        width: 24,
        height: 16,
        format: 'BGR888',
        suspended: false,
      })
      await until(() => next.every((r) => r.stats().completed >= 2n))
      expect(next.every((r) => r.error === undefined)).toBe(true)
      expect(
        await failed(
          c.switchRecordingsModeAsync(
            { width: 64, height: 48 },
            next.map((recording) => ({ recording })),
          ),
        ),
      ).toBeInstanceOf(Error)
      expect(c.info().width).toBe(96)
      expect(c.previewStreamInfo()).toMatchObject({
        stream: 'lores',
        width: 24,
        height: 16,
        format: 'BGR888',
        suspended: false,
      })
      await c.captureMetadata()
      expect(c.previewError).toBeUndefined()
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
      await a.close()
      await b.close()
    }
  },
)
test('cancelled selected-source mode jobs restore negotiated input before resuming the pump', async () => {
  const c = new Camera(options)
  try {
    c.startPreview({ backend: 'headless', stream: 'lores' })
    const job = c.switchMode(
        { width: 96, height: 64, lores: { width: 24, height: 16, rgb: true } },
        { dropFrames: 1_000_000, timeoutMs: 10000 },
      ),
      result = failed(job),
      reason = Error('cancel selected preview mode')
    await until(() => c.previewStreamInfo()?.suspended === true)
    expect(() => c.setPreviewStream('main')).toThrow()
    expect(job.cancel(reason)).toBe(true)
    expect(await result).toBe(reason)
    expect(c.previewStreamInfo()).toMatchObject({
      stream: 'lores',
      width: 16,
      height: 12,
      format: 'YUV420',
      suspended: false,
    })
    await c.captureMetadata()
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
