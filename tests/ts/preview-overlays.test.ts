import { test, expect } from 'bun:test'
import { Camera, Recorder, type PreviewOverlay } from '../../ts'
import { native } from '../../ts/ffi'
const preview = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
const options = { simulate: true, width: 64, height: 48, fifo: true } as const
const rgba = (): PreviewOverlay => ({
  data: new Uint8Array([
    255, 0, 0, 0, 0, 200, 0, 128, 99, 99, 99, 99, 0, 0, 255, 255, 9, 10, 11, 1,
  ]),
  width: 2,
  height: 2,
  stride: 12,
})
test('overlay requires an active preview and rejects closed cameras', async () => {
  const c = new Camera(options)
  expect(() => c.setOverlay(null)).toThrow('preview not active')
  await c.close()
  expect(() => c.setOverlay(rgba())).toThrow()
})
preview(
  'owned overlay survives mode changes and temporary capture without modifying captured pixels',
  async () => {
    const c = new Camera(options),
      original = native.zc_preview_set_overlay,
      closed = native.zc_preview_overlay_close,
      applied: unknown[] = [],
      retired: unknown[] = []
    Object.assign(native, {
      zc_preview_set_overlay: (...args: Parameters<typeof original>) => {
        applied.push(args[1])
        return original(...args)
      },
      zc_preview_overlay_close: (...args: Parameters<typeof closed>) => {
        if (args[0]) retired.push(args[0])
        return closed(...args)
      },
    })
    try {
      c.startPreview()
      const input = rgba()
      c.setOverlay(input)
      input.data.fill(0) // Source ownership ends when setOverlay returns.
      const owner = applied[0]
      expect(owner).toBeTruthy()
      await c.switchMode({ width: 96, height: 64 })
      await c.switchModeAndCaptureRGB({ width: 80, height: 48 })
      expect(applied.length).toBeGreaterThanOrEqual(3)
      expect(applied.every((p) => p === owner)).toBe(true)
      const frame = await c.captureRequest()
      try {
        const rgb = frame.copyRGB()
        // Synthetic BGR888 contains the camera sequence, unaffected by the overlay.
        expect(rgb[0]).toBe(0)
        expect(rgb[1]).toBe(0)
        expect(Array.from(rgb.slice(3, 5))).toEqual([1, 0])
      } finally {
        frame.release()
      }
      expect(retired).toEqual([])
      c.stopPreview()
      expect(retired).toEqual([owner])
      c.startPreview()
      expect(applied.length).toBeGreaterThanOrEqual(3)
      c.stopPreview()
      expect(retired).toEqual([owner])
    } finally {
      await c.close()
      Object.assign(native, {
        zc_preview_set_overlay: original,
        zc_preview_overlay_close: closed,
      })
    }
  },
)
preview(
  'overlay validation and failed upload preserve the previous owner; clear retires it once',
  async () => {
    const c = new Camera(options),
      original = native.zc_preview_set_overlay,
      closed = native.zc_preview_overlay_close,
      applied: unknown[] = [],
      retired: unknown[] = []
    let fail = false
    Object.assign(native, {
      zc_preview_set_overlay: (...args: Parameters<typeof original>) => {
        if (fail) return -6
        applied.push(args[1])
        return original(...args)
      },
      zc_preview_overlay_close: (...args: Parameters<typeof closed>) => {
        if (args[0]) retired.push(args[0])
        return closed(...args)
      },
    })
    try {
      c.startPreview()
      c.setOverlay(rgba())
      const owner = applied[0]
      for (const invalid of [
        { ...rgba(), width: 0 },
        { ...rgba(), height: 4097 },
        { ...rgba(), stride: 7 },
        { ...rgba(), data: new Uint8Array(19) },
        { ...rgba(), width: NaN },
        { ...rgba(), height: -1 },
        { ...rgba(), stride: 1.2 },
      ])
        expect(() => c.setOverlay(invalid)).toThrow()
      expect(retired).toEqual([])
      fail = true
      expect(() => c.setOverlay(rgba())).toThrow()
      fail = false
      expect(retired.length).toBe(1)
      expect(retired[0]).not.toBe(owner)
      expect(applied).toEqual([owner])
      c.setOverlay(null)
      expect(retired).toEqual([retired[0], owner])
      c.setOverlay(rgba())
      const replacement = applied.at(-1)
      await c.close()
      expect(retired.at(-1)).toBe(replacement)
      expect(retired.length).toBe(3)
    } finally {
      await c.close()
      Object.assign(native, {
        zc_preview_set_overlay: original,
        zc_preview_overlay_close: closed,
      })
    }
  },
)
preview(
  'failed overlay recreation rolls camera back and retains overlay for the restored preview',
  async () => {
    const c = new Camera(options),
      original = native.zc_preview_set_overlay
    let fail = false
    const applied: unknown[] = []
    Object.assign(native, {
      zc_preview_set_overlay: (...args: Parameters<typeof original>) => {
        if (fail) {
          fail = false
          return -6
        }
        applied.push(args[1])
        return original(...args)
      },
    })
    try {
      c.startPreview()
      c.setOverlay(rgba())
      fail = true
      await expect(
        Promise.resolve(c.switchMode({ width: 96, height: 64 })),
      ).rejects.toThrow()
      expect(c.info().width).toBe(64)
      expect(applied.length).toBe(2)
      expect(applied[0]).toBe(applied[1])
      await c.captureRGB()
      expect(c.stats().leased).toBe(0)
      c.stopPreview()
    } finally {
      await c.close()
      Object.assign(native, { zc_preview_set_overlay: original })
    }
  },
)
preview(
  'single and grouped recording mode jobs reuse the same immutable overlay',
  async () => {
    const c = new Camera(options),
      a = new Recorder(null, {
        width: 64,
        height: 48,
        fps: 25,
        asyncWrites: true,
      }),
      b = new Recorder(null, {
        width: 96,
        height: 64,
        fps: 25,
        asyncWrites: true,
      }),
      original = native.zc_preview_set_overlay,
      applied: unknown[] = []
    Object.assign(native, {
      zc_preview_set_overlay: (...args: Parameters<typeof original>) => {
        applied.push(args[1])
        return original(...args)
      },
    })
    try {
      c.startPreview()
      c.setOverlay(rgba())
      c.startRecording(a)
      const second = await c.switchRecordingModeAsync(a, {
        width: 96,
        height: 64,
      })
      const peer = c.startRecording(b)
      const next = await c.switchRecordingsModeAsync(
        { width: 80, height: 48 },
        [{ recording: second }, { recording: peer }],
      )
      expect(next.length).toBe(2)
      expect(applied.length).toBe(3)
      expect(applied.every((p) => p === applied[0])).toBe(true)
      await c.captureRGB()
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
      await a.close()
      await b.close()
      Object.assign(native, { zc_preview_set_overlay: original })
    }
  },
)
