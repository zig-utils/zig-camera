import { test, expect } from 'bun:test'
import {
  Camera,
  Recorder,
  type PreviewViewOptions,
  type PreviewTransform,
} from '../../ts'
import { native } from '../../ts/ffi'
const options = { simulate: true, width: 64, height: 48, fifo: true } as const
const view: PreviewViewOptions = {
  window: { x: 10, y: 20, width: 120, height: 100 },
  transform: { rotation: 90 },
  keepAspect: false,
  overlay: {
    rectangle: { x: 1, y: 2, width: 20, height: 30 },
    transform: { hflip: true },
  },
}
const failed = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (e) => e,
  )
const preview = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
test('headless view validates and snapshots nested display settings without SDL', async () => {
  const c = new Camera(options),
    original = native.zc_preview_set_view
  Object.assign(native, {
    zc_preview_set_view: () => {
      throw Error('headless SDL update')
    },
  })
  try {
    const input: PreviewViewOptions = structuredClone(view)
    c.startPreview({ backend: 'headless', ...input })
    input.window!.width = 1
    input.transform!.rotation = 0
    input.overlay!.rectangle!.width = 999
    const info = c.previewInfo()!
    expect(info.window).toEqual({ x: 10, y: 20, width: 120, height: 100 })
    expect(info.transform?.rotation).toBe(90)
    expect(info.overlay?.rectangle?.width).toBe(20)
    info.window!.width = 999
    info.transform!.hflip = true
    info.overlay!.rectangle!.x = 999
    expect(c.previewInfo()?.window?.width).toBe(120)
    expect(c.previewInfo()?.transform?.hflip).toBe(false)
    expect(c.previewInfo()?.overlay?.rectangle?.x).toBe(1)
    c.setPreviewView({ keepAspect: true, transform: { transpose: true } })
    expect(c.previewInfo()?.keepAspect).toBe(true)
    expect(c.previewInfo()?.window).toBeUndefined()
    c.setPreviewView()
    expect(c.previewInfo()).toEqual({
      backend: 'headless',
      title: 'zig-camera',
      suspended: false,
    })
    expect((await c.captureRGB()).length).toBe(64 * 48 * 3)
  } finally {
    await c.close()
    Object.assign(native, { zc_preview_set_view: original })
  }
})
test('invalid display settings reject before start and preserve an active headless view', async () => {
  const c = new Camera(options)
  const invalid: unknown[] = [
    { window: { width: 0, height: 1 } },
    { window: { width: 16385, height: 1 } },
    { window: { width: 1, height: 1, x: 1000001 } },
    { window: { width: 1, height: 1, y: NaN } },
    { transform: { rotation: 45 } },
    { transform: { hflip: 1 } },
    { transform: { strict: true } },
    { keepAspect: 1 },
    { overlay: { rectangle: { x: 0, y: 0, width: 0, height: 1 } } },
    { overlay: { rectangle: { x: 1, y: 0, width: 0xffffffff, height: 1 } } },
    { overlay: { transform: { rotation: 1 } } },
    { overlay: null },
    { window: [] },
    { transform: null },
  ]
  try {
    for (const input of invalid) {
      expect(() =>
        c.startPreview({
          backend: 'headless',
          ...(input as PreviewViewOptions),
        }),
      ).toThrow()
      expect(c.previewInfo()).toBeUndefined()
    }
    c.startPreview({ backend: 'headless', ...view })
    const before = c.previewInfo()
    for (const input of invalid) {
      expect(() => c.setPreviewView(input as PreviewViewOptions)).toThrow()
      expect(c.previewInfo()).toEqual(before)
    }
    c.stopPreview()
    expect(() => c.setPreviewView()).toThrow('preview not active')
  } finally {
    await c.close()
  }
})
test('reentrant view accessors cannot update another preview owner', async () => {
  const c = new Camera(options)
  try {
    c.startPreview({ backend: 'headless' })
    expect(() =>
      c.setPreviewView({
        get window() {
          c.stopPreview()
          c.startPreview({ backend: 'headless', title: 'replacement' })
          return { width: 20, height: 20 }
        },
      }),
    ).toThrow('preview changed')
    expect(c.previewInfo()).toEqual({
      backend: 'headless',
      title: 'replacement',
      suspended: false,
    })
    const inner = { keepAspect: false }
    expect(() =>
      c.setPreviewView({
        get keepAspect() {
          c.setPreviewView(inner)
          return true
        },
      }),
    ).toThrow('preview changed')
    expect(c.previewInfo()?.keepAspect).toBe(false)
  } finally {
    await c.close()
  }
})
for (const backend of ['headless', 'sdl'] as const) {
  const run = backend === 'sdl' ? preview : test
  run(
    `${backend} preview reapplies display view across modes and rejects target rectangles before publication`,
    async () => {
      const c = new Camera(options)
      try {
        c.startPreview({ backend, ...view })
        await c.switchMode({ width: 96, height: 64 })
        const before = c.previewInfo()
        expect(before?.transform?.rotation).toBe(90)
        expect(before?.overlay?.rectangle).toEqual(view.overlay!.rectangle)
        await c.switchModeAndCaptureRGB({ width: 80, height: 48 })
        expect(c.previewInfo()).toEqual(before)
        expect(
          await failed(c.switchMode({ width: 8, height: 8 })),
        ).toBeInstanceOf(Error)
        expect(c.info().width).toBe(96)
        expect(c.previewInfo()).toEqual(before)
        expect(c.previewInfo()?.suspended).toBe(false)
        expect(c.stats().leased).toBe(0)
      } finally {
        await c.close()
      }
    },
  )
}
preview(
  'live SDL view updates preserve overlay texture and reject failed updates without changing metadata',
  async () => {
    const c = new Camera(options),
      original = native.zc_preview_set_view,
      upload = native.zc_preview_set_overlay
    let calls = 0
    Object.assign(native, {
      zc_preview_set_overlay: (...args: Parameters<typeof upload>) => {
        calls++
        return upload(...args)
      },
    })
    try {
      c.startPreview({ backend: 'sdl' })
      c.setOverlay({
        data: new Uint8Array([255, 0, 0, 128]),
        width: 1,
        height: 1,
      })
      c.setPreviewView(view)
      expect(calls).toBe(1)
      const before = c.previewInfo()
      Object.assign(native, { zc_preview_set_view: () => -6 })
      expect(() => c.setPreviewView({ keepAspect: true })).toThrow()
      expect(c.previewInfo()).toEqual(before)
      Object.assign(native, { zc_preview_set_view: original })
      c.setPreviewView()
      expect(c.previewInfo()).toEqual({
        backend: 'sdl',
        title: 'zig-camera',
        suspended: false,
      })
      expect(calls).toBe(1)
      await c.captureRGB()
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
      Object.assign(native, {
        zc_preview_set_view: original,
        zc_preview_set_overlay: upload,
      })
    }
  },
)
preview(
  'all display transforms keep camera orientation and capture bytes unchanged',
  async () => {
    const c = new Camera(options)
    try {
      c.startPreview({ backend: 'sdl', window: { width: 96, height: 96 } })
      for (const rotation of [0, 90, 180, 270] as const)
        for (const hflip of [false, true]) {
          const transform: PreviewTransform = { rotation, hflip }
          c.setPreviewView({
            transform,
            overlay: { transform: { vflip: true } },
          })
          const f = await c.captureRequest()
          try {
            const rgb = f.copyRGB()
            expect(Array.from(rgb.slice(0, 2))).toEqual([0, 0])
            expect(Array.from(rgb.slice(3, 5))).toEqual([1, 0])
          } finally {
            f.release()
          }
          expect(c.orientation().actual).toBe(1)
        }
    } finally {
      await c.close()
    }
  },
)
preview(
  'recorder group reconfiguration preserves independent preview view and overlay settings',
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
      c.startPreview({ backend: 'sdl', ...view })
      c.setOverlay({
        data: new Uint8Array([0, 255, 0, 128]),
        width: 1,
        height: 1,
      })
      const x = c.startRecording(a),
        y = c.startRecording(b)
      await c.switchRecordingsModeAsync({ width: 96, height: 64 }, [
        { recording: x },
        { recording: y },
      ])
      expect(c.previewInfo()?.window).toEqual(view.window)
      expect(c.previewInfo()?.overlay?.rectangle).toEqual(
        view.overlay!.rectangle,
      )
      expect(c.previewInfo()?.suspended).toBe(false)
      expect(c.info().width).toBe(96)
      await c.captureMetadata()
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
      await a.close()
      await b.close()
    }
  },
)
