import { expect, test } from 'bun:test'
import {
  Camera,
  CameraWatch,
  CameraError,
  type MappedStream,
  type Frame,
} from '../../ts'
import { native as n } from '../../ts/ffi'
const options = {
  simulate: true,
  writable: true,
  width: 16,
  height: 16,
  buffers: 2,
  lores: { width: 8, height: 8, rgb: true },
}
const fast = { initialDelayMs: 0, maximumDelayMs: 0, pollMs: 2 }
async function until(check: () => boolean) {
  const end = performance.now() + 5000
  while (!check()) {
    if (performance.now() > end) throw Error('preview recovery deadline')
    await Bun.sleep(1)
  }
}

test('lost headless preview suspends its recipe and reconnect restores independent lores pumping', async () => {
  const old = new Camera(options)
  let fresh: Camera | undefined
  try {
    old.startPreview({
      backend: 'headless',
      stream: 'lores',
      title: 'trails',
      transform: { rotation: 90 },
      keepAspect: false,
    })
    await until(() => old.stats().delivered > 0n)
    old.simulateDisconnect()
    await until(() => !!old.deviceError)
    expect(old.previewInfo()).toMatchObject({
      title: 'trails',
      suspended: true,
      stream: 'lores',
    })
    fresh = await old.reconnect(fast)
    expect(fresh.previewInfo()).toMatchObject({
      title: 'trails',
      suspended: false,
      stream: 'lores',
      transform: { rotation: 90 },
    })
    expect(fresh.previewStreamInfo()).toMatchObject({
      width: 8,
      height: 8,
      stream: 'lores',
    })
    await until(() => fresh!.stats().delivered > 0n)
    await old.close()
    expect(fresh.previewInfo()?.suspended === false).toBe(true)
  } finally {
    await fresh?.close()
    await old.close()
  }
})

test('explicit preview opt-out can recover stopped without recreating the old display', async () => {
  const old = new Camera(options)
  let fresh: Camera | undefined
  try {
    old.startPreview({ backend: 'headless' })
    old.simulateDisconnect()
    expect(() => old.reconnect({ ...fast, start: false })).toThrow(RangeError)
    fresh = await old.reconnect({ ...fast, preview: false, start: false })
    expect(fresh.previewInfo()).toBeUndefined()
    expect(fresh.deviceState().running).toBe(false)
    expect(old.previewInfo()?.suspended).toBe(true)
    old.stopPreview()
    expect(old.previewInfo()).toBeUndefined()
  } finally {
    await fresh?.close()
    await old.close()
  }
})

test('preview preparation failure retires the candidate and preserves the source recovery recipe', async () => {
  const old = new Camera(options),
    original = n.zc_preview_check_view
  const mutable = n as unknown as {
    zc_preview_check_view: (...args: Parameters<typeof original>) => number
  }
  try {
    old.startPreview({ backend: 'headless', keepAspect: false })
    old.simulateDisconnect()
    mutable.zc_preview_check_view = () => -6
    await expect(old.reconnect(fast).wait()).rejects.toMatchObject({
      code: -6,
    })
    expect(old.previewInfo()).toMatchObject({
      suspended: true,
      keepAspect: false,
    })
  } finally {
    mutable.zc_preview_check_view = original
  }
  try {
    const fresh = await old.reconnect(fast)
    expect(fresh.previewInfo()?.suspended === false).toBe(true)
    await fresh.close()
  } finally {
    await old.close()
  }
})

const previewTest = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
previewTest(
  'SDL recovery owns an overlay snapshot after explicit old preview close and caller mutation',
  async () => {
    const old = new Camera(options),
      discover = CameraWatch.prototype.discover
    let fresh: Camera | undefined,
      copies = 0,
      uploads: number[][] = []
    const clone = n.zc_preview_overlay_clone,
      upload = n.zc_preview_set_overlay
    const mutable = n as unknown as {
      zc_preview_overlay_clone: (...args: Parameters<typeof clone>) => number
      zc_preview_set_overlay: (...args: Parameters<typeof upload>) => number
    }
    try {
      old.startPreview({
        title: 'overlay',
        stream: null,
        overlay: { rectangle: { x: 1, y: 2, width: 4, height: 4 } },
      })
      const pixels = new Uint8Array([1, 2, 3, 128, 4, 5, 6, 255])
      old.setOverlay({ data: pixels, width: 2, height: 1 })
      old.simulateDisconnect()
      CameraWatch.prototype.discover = () => []
      mutable.zc_preview_overlay_clone = (...args) => {
        copies++
        return clone(...args)
      }
      const job = old.reconnect(fast)
      expect(copies).toBe(1)
      pixels.fill(0)
      old.stopPreview()
      CameraWatch.prototype.discover = discover
      mutable.zc_preview_set_overlay = (...args) => {
        uploads.push(args.map((value) => Number(value)))
        return upload(...args)
      }
      fresh = await job
      expect(fresh.previewInfo()).toMatchObject({
        stream: null,
        overlay: { rectangle: { x: 1, y: 2, width: 4, height: 4 } },
      })
      expect(uploads.some((args) => args[1] !== 0)).toBe(true)
      await old.close()
      await fresh.switchMode({ width: 16, height: 16, lores: options.lores })
      expect(fresh.previewInfo()?.suspended === false).toBe(true)
      expect(uploads.filter((args) => args[1] !== 0).length).toBeGreaterThan(1)
    } finally {
      CameraWatch.prototype.discover = discover
      mutable.zc_preview_overlay_clone = clone
      mutable.zc_preview_set_overlay = upload
      await fresh?.close()
      await old.close()
    }
  },
)
