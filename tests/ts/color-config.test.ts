import { expect, test } from 'bun:test'
import {
  Camera,
  Recorder,
  Control,
  type ColorSpacePreset,
  type ColorSpaceDescription,
} from '../../ts'
import { native } from '../../ts/ffi'
const options = { simulate: true, width: 64, height: 48, fifo: true } as const
const presets: ColorSpacePreset[] = [
  'srgb',
  'sycc',
  'smpte170m',
  'rec709',
  'rec2020',
]
const custom: ColorSpaceDescription = {
  primaries: 'rec709',
  transfer: 'srgb',
  ycbcrEncoding: 'rec709',
  range: 'limited',
}
const pause = () => new Promise<void>((r) => setTimeout(r, 1))
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > end) throw Error('color configuration timeout')
    await pause()
  }
}
const failed = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (e) => e,
  )
function expectedColor(
  preset: ColorSpacePreset,
): ReturnType<Camera['colorSpace']> {
  return {
    present: true,
    primaries:
      preset === 'smpte170m'
        ? 'smpte170m'
        : preset === 'rec2020'
          ? 'rec2020'
          : 'rec709',
    transfer: preset === 'srgb' || preset === 'sycc' ? 'srgb' : 'rec709',
    ycbcrEncoding:
      preset === 'srgb'
        ? 'none'
        : preset === 'sycc' || preset === 'smpte170m'
          ? 'rec601'
          : preset,
    range: preset === 'srgb' || preset === 'sycc' ? 'full' : 'limited',
  }
}
for (const format of ['BGR888', 'YUV420'] as const)
  test(`${format} presets retain requested/effective/actual colors across paired formats`, async () => {
    for (const preset of presets) {
      if (format === 'YUV420' && preset === 'srgb') continue
      const c = new Camera({
        ...options,
        format,
        colorSpace: preset,
        strictColorSpace: true,
        raw: true,
        unpackedRaw: true,
        lores: {
          width: 16,
          height: 12,
          rgb: format === 'YUV420' || preset === 'srgb',
        },
      })
      try {
        const requested = expectedColor(preset),
          actual: ReturnType<Camera['colorSpace']> =
            format === 'BGR888'
              ? { ...requested, ycbcrEncoding: 'none', range: 'full' }
              : requested
        expect(c.colorSpace()).toEqual(actual)
        expect(c.colorNegotiation()).toEqual({
          configured: true,
          strict: true,
          normalized: format === 'BGR888' && preset !== 'srgb',
          adjusted: false,
          format,
          requested,
          effective: actual,
          actual,
        })
        const peer = c.colorNegotiation('lores')
        expect(peer.configured && peer.strict && !peer.adjusted).toBe(true)
        expect(peer.actual.primaries).toBe(requested.primaries)
        expect(peer.actual.transfer).toBe(requested.transfer)
        expect(c.colorSpace('raw')).toMatchObject({
          primaries: 'raw',
          transfer: 'linear',
          ycbcrEncoding: 'none',
          range: 'full',
        })
        const observation = c.colorNegotiation()
        observation.actual.primaries = 'unknown'
        observation.requested!.range = 'unknown'
        expect(c.colorNegotiation().actual).toEqual(actual)
        expect(c.colorNegotiation().requested).toEqual(requested)
        expect((await c.captureRGB()).length).toBe(64 * 48 * 3)
        expect(c.stats().leased).toBe(0)
      } finally {
        await c.close()
      }
    }
  })
test('default color negotiation reports actual metadata without inventing a request', async () => {
  const c = new Camera({ ...options, lores: { width: 16, height: 12 } })
  try {
    expect(c.colorNegotiation()).toEqual({
      configured: false,
      strict: false,
      normalized: false,
      adjusted: false,
      format: 'BGR888',
      actual: c.colorSpace(),
    })
    expect(c.colorNegotiation('lores').actual.ycbcrEncoding).toBe('rec601')
    expect(() => c.colorNegotiation('raw' as never)).toThrow()
  } finally {
    await c.close()
  }
})
test('custom color requests and returned option snapshots are independent copies', async () => {
  const requested = { ...custom },
    c = new Camera({
      ...options,
      format: 'YUV420',
      colorSpace: requested,
      strictColorSpace: true,
    })
  try {
    requested.transfer = 'linear'
    const snapshot = c.options.colorSpace
    expect(typeof snapshot).toBe('object')
    if (snapshot && typeof snapshot === 'object') snapshot.primaries = 'rec2020'
    expect(c.colorSpace()).toMatchObject(custom)
    expect(c.options.colorSpace).toEqual(custom)
    expect(c.colorNegotiation().normalized).toBe(false)
    c.start()
    const f = c.acquire(1000)
    try {
      expect(f.colorSpace()).toMatchObject(custom)
      expect(f.copyRGB().length).toBe(64 * 48 * 3)
    } finally {
      f.release()
    }
  } finally {
    await c.close()
  }
})
test('invalid color requests reject before replacing a live mode or claiming a device', async () => {
  const c = new Camera(options)
  try {
    for (const colorSpace of [
      'raw',
      'unknown',
      '__proto__',
      null,
      [],
      { ...custom, transfer: 'unknown' },
      { ...custom, primaries: 'raw' },
      { ...custom, range: 'unknown' },
    ])
      expect(
        () => new Camera({ ...options, colorSpace: colorSpace as never }),
      ).toThrow()
    expect(() => new Camera({ ...options, strictColorSpace: true })).toThrow(
      'requires a request',
    )
    expect(
      () =>
        new Camera({
          ...options,
          colorSpace: 'sycc',
          strictColorSpace: 1 as never,
        }),
    ).toThrow()
    expect(
      () => new Camera({ ...options, format: 'YUV420', colorSpace: 'srgb' }),
    ).toThrow()
    expect(
      () =>
        new Camera({
          ...options,
          colorSpace: 'srgb',
          lores: { width: 16, height: 12 },
        }),
    ).toThrow()
    expect(() =>
      c.switchMode({ ...options, format: 'YUV420', colorSpace: 'srgb' }),
    ).toThrow()
    expect(c.colorNegotiation().configured).toBe(false)
    expect((await c.captureRGB()).length).toBe(64 * 48 * 3)
  } finally {
    await c.close()
  }
})
test('requested YUV matrix/range drive pixel conversion using negotiated metadata', async () => {
  for (const colorSpace of [
    { ...custom, range: 'full' as const },
    { ...custom },
    { ...custom, ycbcrEncoding: 'rec2020' as const },
  ]) {
    const c = new Camera({
      ...options,
      format: 'YUV420',
      colorSpace,
      writable: true,
    })
    try {
      const frame = await c.captureRequest()
      try {
        frame.withMappedStream((map) => {
          for (let y = 0; y < 48; y++)
            for (let x = 0; x < 64; x++) map.row(y)[x] = 30 + x * 2 + y
          for (let y = 0; y < 24; y++) {
            map.row(y, 1).fill(64 + y)
            map.row(y, 2).fill(160 + y)
          }
        })
        const data = frame.copyStream().data,
          out = frame.copyRGB(),
          kr = colorSpace.ycbcrEncoding === 'rec2020' ? 0.2627 : 0.2126,
          kb = colorSpace.ycbcrEncoding === 'rec2020' ? 0.0593 : 0.0722
        let maxError = 0
        for (let y = 0; y < 48; y++)
          for (let x = 0; x < 64; x++) {
            const i = y * 64 + x,
              j = Math.floor(y / 2) * 32 + Math.floor(x / 2),
              limited = colorSpace.range === 'limited',
              l =
                ((data[i] - (limited ? 16 : 0)) * 255) / (limited ? 219 : 255),
              u = ((data[3072 + j] - 128) * 255) / (limited ? 224 : 255),
              v = ((data[3840 + j] - 128) * 255) / (limited ? 224 : 255)
            const reference = [
              l + 2 * (1 - kr) * v,
              l -
                ((2 * kb * (1 - kb)) / (1 - kr - kb)) * u -
                ((2 * kr * (1 - kr)) / (1 - kr - kb)) * v,
              l + 2 * (1 - kb) * u,
            ]
            for (let k = 0; k < 3; k++)
              maxError = Math.max(
                maxError,
                Math.abs(
                  out[i * 3 + k] -
                    Math.min(255, Math.max(0, Math.round(reference[k]))),
                ),
              )
          }
        expect(maxError).toBeLessThanOrEqual(1)
      } finally {
        frame.release()
      }
    } finally {
      await c.close()
    }
  }
})
for (const format of ['BGR888', 'YUV420'] as const)
  test(`${format} incompatible gamut/transfer rejects manual and camera recording before output mutation`, async () => {
    const c = new Camera({ ...options, format, colorSpace: 'rec2020' }),
      r = await Recorder.open(
        { outputframe() {} },
        { width: 64, height: 48, asyncWrites: true },
      ),
      legacy = native.zc_video_write
    Object.assign(native, {
      zc_video_write: () => {
        throw Error('legacy path accepted incompatible color')
      },
    })
    try {
      expect(() => c.startRecording(r)).toThrow('(-8)')
      const frame = await c.captureRequest()
      try {
        expect(() => r.write(frame, 0n)).toThrow('(-8)')
        expect(() => r.writeAsync(frame, 0n)).toThrow('(-8)')
        expect(() => r.writeAVAsync(frame, [], 0n)).toThrow('(-8)')
      } finally {
        frame.release()
      }
      expect(r.stats().outputFrames).toBe(0n)
      expect(r.producerStats().ownedJobs).toBe(0n)
      expect(c.activeRecordings.length).toBe(0)
      expect((await c.captureRGB()).length).toBe(64 * 48 * 3)
    } finally {
      Object.assign(native, { zc_video_write: legacy })
      await c.close()
      await r.close()
    }
  })
test('legacy RGB color admission caches one actual query per adopted camera handle', async () => {
  const c = new Camera(options),
    r = await Recorder.open({ outputframe() {} }, { width: 64, height: 48 }),
    get = native.zc_get_stream_color_space
  let calls = 0
  Object.assign(native, {
    zc_get_stream_color_space: (...args: Parameters<typeof get>) => {
      calls++
      return get(...args)
    },
  })
  try {
    c.start()
    for (let i = 0; i < 3; i++) {
      const frame = c.acquire(1000)
      try {
        r.write(frame, BigInt(i) * 40_000_000n)
      } finally {
        frame.release()
      }
    }
    expect(calls).toBe(1)
    await c.switchMode({ ...options, colorSpace: 'sycc' })
    const frame = await c.captureRequest()
    try {
      r.write(frame, 120_000_000n)
    } finally {
      frame.release()
    }
    expect(calls).toBe(2)
  } finally {
    Object.assign(native, { zc_get_stream_color_space: get })
    await c.close()
    await r.close()
  }
})
test('color requests restore through temporary and cancelled modes with controls and CAF', async () => {
  const c = new Camera({
    ...options,
    colorSpace: custom,
    format: 'YUV420',
    lores: { width: 16, height: 12, rgb: true },
    strictColorSpace: true,
  })
  try {
    c.startPreview({ backend: 'headless' })
    c.setControls([
      { id: Control.aeEnable, type: 'bool', values: [0] },
      { id: Control.exposureTime, type: 'int', values: [3200] },
    ])
    c.startContinuousAutofocus()
    await c.switchMode({
      ...options,
      colorSpace: 'rec709',
      strictColorSpace: true,
    })
    expect(c.colorSpace()).toMatchObject({
      transfer: 'rec709',
      ycbcrEncoding: 'none',
      range: 'full',
    })
    expect(c.colorNegotiation().normalized).toBe(true)
    expect(
      (
        await c.switchModeAndCaptureRGB({
          ...options,
          format: 'YUV420',
          colorSpace: custom,
          strictColorSpace: true,
        })
      ).length,
    ).toBe(64 * 48 * 3)
    expect(c.options.colorSpace).toBe('rec709')
    expect(c.colorSpace().transfer).toBe('rec709')
    const job = c.switchMode(
        { ...options, colorSpace: 'sycc' },
        { dropFrames: 1_000_000, timeoutMs: 10000 },
      ),
      result = failed(job),
      reason = Error('cancel color switch')
    await until(() => c.previewInfo()?.suspended === true)
    expect(job.cancel(reason)).toBe(true)
    expect(await result).toBe(reason)
    expect(c.colorNegotiation()).toMatchObject({
      configured: true,
      strict: true,
      normalized: true,
      adjusted: false,
      actual: { transfer: 'rec709' },
    })
    expect((await c.captureMetadata()).exposureUs).toBe(3200)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('single and group recording modes publish supported colors and restore unsupported target colors', async () => {
  const c = new Camera({ ...options, colorSpace: 'sycc' }),
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
    c.startRecording(a)
    await c.switchRecordingModeAsync(
      a,
      {
        ...options,
        format: 'YUV420',
        colorSpace: custom,
        strictColorSpace: true,
      },
      {},
      { outputframe() {} },
    )
    expect(c.colorNegotiation()).toMatchObject({
      format: 'YUV420',
      strict: true,
      adjusted: false,
      actual: custom,
    })
    c.startRecording(b)
    const next = await c.switchRecordingsModeAsync(
      { ...options, colorSpace: custom, strictColorSpace: true },
      c.activeRecordings.map((recording) => ({
        recording,
        output: { outputframe() {} },
      })),
    )
    await until(() => next.every((r) => r.stats().completed >= 2n))
    expect(c.colorNegotiation()).toMatchObject({
      format: 'BGR888',
      normalized: true,
      actual: { transfer: 'srgb', ycbcrEncoding: 'none', range: 'full' },
    })
    const result = await failed(
      c.switchRecordingsModeAsync(
        { ...options, colorSpace: 'rec2020', strictColorSpace: true },
        next.map((recording) => ({ recording, output: { outputframe() {} } })),
      ),
    )
    expect(result).toBeInstanceOf(Error)
    expect(c.options.colorSpace).toEqual(custom)
    expect(c.colorSpace()).toMatchObject({
      primaries: 'rec709',
      transfer: 'srgb',
    })
    expect((await c.captureRGB()).length).toBe(64 * 48 * 3)
    expect(c.previewStreamInfo()?.colorSpace?.transfer).toBe('srgb')
  } finally {
    await c.close()
    await a.close()
    await b.close()
  }
})
const preview = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
preview(
  'SDL selected-source color observations follow configured camera modes and preserve overlays',
  async () => {
    const c = new Camera({
      ...options,
      format: 'YUV420',
      colorSpace: custom,
      strictColorSpace: true,
      lores: { width: 16, height: 12 },
    })
    try {
      c.startPreview({ stream: 'lores', transform: { hflip: true } })
      c.setOverlay({
        data: new Uint8Array([0, 255, 0, 128]),
        width: 1,
        height: 1,
      })
      await c.captureMetadata()
      expect(c.previewStreamInfo()?.colorSpace).toMatchObject(custom)
      await c.switchMode({
        ...options,
        colorSpace: 'rec2020',
        strictColorSpace: true,
        lores: { width: 16, height: 12, rgb: true },
      })
      await c.captureMetadata()
      expect(c.previewStreamInfo()?.colorSpace).toMatchObject({
        primaries: 'rec2020',
        transfer: 'rec709',
        ycbcrEncoding: 'none',
        range: 'full',
      })
      expect(c.previewInfo()?.transform?.hflip).toBe(true)
      expect(c.previewError).toBeUndefined()
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
    }
  },
)
for (const codec of ['h264', 'hevc'] as const)
  (process.env.ZC_TEST_CODECS ? test : test.skip)(
    `${codec} configured Rec.709-matrix I420 is remapped without changing transfer or gamut`,
    async () => {
      const { mkdtempSync, rmSync } = await import('node:fs'),
        { tmpdir } = await import('node:os'),
        { join } = await import('node:path'),
        { mp4, decodeVideoI420 } = await import('./media')
      const dir = mkdtempSync(join(tmpdir(), 'zc-color-codec-')),
        path = join(dir, 'color.mp4'),
        c = new Camera({
          ...options,
          format: 'YUV420',
          colorSpace: custom,
          strictColorSpace: true,
          writable: true,
        }),
        r = new Recorder(path, {
          width: 64,
          height: 48,
          codec,
          quality: 100,
          gop: 2,
          fps: 25,
        }),
        expected: Uint8Array[] = []
      try {
        c.start()
        for (let index = 0; index < 4; index++) {
          const frame = c.acquire(1000)
          let pending: PromiseLike<void> | undefined
          try {
            frame.withMappedStream((map) => {
              for (let y = 0; y < 48; y++)
                for (let x = 0; x < 64; x++)
                  map.row(y)[x] = 50 + index * 10 + x + y
              for (let y = 0; y < 24; y++)
                for (let x = 0; x < 32; x++) {
                  map.row(y, 1)[x] = 50 + x + index * 5
                  map.row(y, 2)[x] = 150 + y + index * 5
                }
            })
            const data = frame.copyStream().data,
              out = new Uint8Array(data.length)
            for (let y = 0; y < 48; y++)
              for (let x = 0; x < 64; x++) {
                const i = y * 64 + x,
                  j = Math.floor(y / 2) * 32 + Math.floor(x / 2),
                  l = ((data[i] - 16) * 255) / 219,
                  cb = ((data[3072 + j] - 128) * 255) / 224,
                  cr = ((data[3840 + j] - 128) * 255) / 224
                // No intermediate RGB clamp: both spaces describe the same encoded channels.
                const red = l + 2 * (1 - 0.2126) * cr,
                  blue = l + 2 * (1 - 0.0722) * cb,
                  green =
                    l -
                    ((2 * 0.0722 * (1 - 0.0722)) / (1 - 0.2126 - 0.0722)) * cb -
                    ((2 * 0.2126 * (1 - 0.2126)) / (1 - 0.2126 - 0.0722)) * cr,
                  dy = 0.299 * red + 0.587 * green + 0.114 * blue
                out[i] = Math.min(
                  255,
                  Math.max(0, Math.round(16 + (dy * 219) / 255)),
                )
                out[3072 + j] = Math.min(
                  255,
                  Math.max(
                    0,
                    Math.round(
                      128 + (((blue - dy) / (2 * (1 - 0.114))) * 224) / 255,
                    ),
                  ),
                )
                out[3840 + j] = Math.min(
                  255,
                  Math.max(
                    0,
                    Math.round(
                      128 + (((red - dy) / (2 * (1 - 0.299))) * 224) / 255,
                    ),
                  ),
                )
              }
            expected.push(out)
            if (index % 2)
              pending = r.writeAsync(frame, BigInt(index) * 40_000_000n)
            else r.write(frame, BigInt(index) * 40_000_000n)
          } finally {
            frame.release()
          }
          if (pending) await pending
        }
        await r.close()
        const video = mp4(path).get(1)!
        expect(video.samples.length).toBe(4)
        decodeVideoI420(path, video, expected)
        expect(c.colorSpace()).toMatchObject(custom)
      } finally {
        await c.close()
        await r.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
