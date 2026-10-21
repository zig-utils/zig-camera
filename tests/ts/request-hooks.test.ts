import { expect, test } from 'bun:test'
import {
  Camera,
  Recorder,
  Frame,
  RequestCallbackError,
  type RequestFrame,
} from '../../ts'
import { native as ffi, ptr, type Pointer } from '../../ts/ffi'
const native: {
  zc_video_write: (...args: Parameters<typeof ffi.zc_video_write>) => number
  zc_video_producer_frame: (
    ...args: Parameters<typeof ffi.zc_video_producer_frame>
  ) => number
  zc_preview_show_stream: (
    ...args: Parameters<typeof ffi.zc_preview_show_stream>
  ) => number
  zc_video_producer_av: (
    ...args: Parameters<typeof ffi.zc_video_producer_av>
  ) => number
} = ffi
const cam = () =>
  new Camera({
    simulate: true,
    writable: true,
    fifo: true,
    width: 34,
    height: 18,
    buffers: 3,
    raw: true,
    unpackedRaw: true,
    lores: { width: 16, height: 8 },
  })
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
async function until(predicate: () => boolean) {
  const end = performance.now() + 5000
  while (!predicate()) {
    if (performance.now() > end) throw Error('callback deadline')
    await Bun.sleep(1)
  }
}
const pixel = (frame: Pointer) => {
  const data = new Uint8Array(34 * 18 * 3)
  expect(ffi.zc_copy_rgb(frame, ptr(data), BigInt(data.length))).toBe(0)
  return [...data.subarray(0, 3)]
}
for (const asyncWrites of [false, true])
  test(`pre/copy/post/encode order is exact with ${asyncWrites ? 'async' : 'sync'} recording and mapped scope cleanup`, async () => {
    const c = cam(),
      recorder = new Recorder(null, { width: 34, height: 18, asyncWrites })
    const write = native.zc_video_write,
      produce = native.zc_video_producer_frame,
      produceAV = native.zc_video_producer_av
    const order: string[] = [],
      encoded: number[][] = []
    let preView: RequestFrame | undefined, escaped: Uint8Array | undefined
    try {
      native.zc_video_write = (...args) => {
        order.push('encode')
        encoded.push(pixel(args[1] as Pointer))
        return write(...args)
      }
      native.zc_video_producer_frame = (...args) => {
        order.push('encode')
        encoded.push(pixel(args[1] as Pointer))
        return produce(...args)
      }
      native.zc_video_producer_av = (...args) => {
        order.push('encode')
        encoded.push(pixel(args[1] as Pointer))
        return produceAV(...args)
      }
      c.setRequestCallbacks({
        pre(request) {
          order.push('pre')
          preView = request
          escaped = request.mapStream().row(0)
          escaped.set([11, 12, 13])
        },
        post(request) {
          order.push('post')
          expect(escaped!.length).toBe(0)
          expect(() => preView!.metadata()).toThrow('expired')
          request.mapStream().row(0).set([81, 82, 83])
        },
      })
      const recording = c.startRecording(recorder)
      const copied = await c.captureAsync((frame) => {
        order.push('capture')
        return frame.copyRGB()
      })
      c.setRequestCallbacks({})
      expect(order.slice(0, 4)).toEqual(['pre', 'capture', 'post', 'encode'])
      expect([...copied.subarray(0, 3)]).toEqual([11, 12, 13])
      expect(encoded[0]).toEqual([81, 82, 83])
      expect(c.stats().leased).toBe(0)
      await recording.flushAsync()
    } finally {
      native.zc_video_write = write
      native.zc_video_producer_frame = produce
      native.zc_video_producer_av = produceAV
      await c.close()
      await recorder.close()
    }
  })
test('retained capture results see post edits while borrowed views expire and explicit retained owners support awaits', async () => {
  const c = cam()
  let view: RequestFrame | undefined, retained: Frame | undefined
  try {
    c.preCallback = (request) => {
      view = request
      request.withMappedStream((map) => map.row(0).fill(9))
    }
    c.postCallback = (request) => {
      request.withMappedStream((map) => map.row(0).fill(7))
      retained ??= request.retain()
    }
    using captured = await c.captureRequest()
    c.setRequestCallbacks({})
    expect(captured.copyRGB()[0]).toBe(7)
    expect(() => view!.retain()).toThrow('expired')
    captured.release()
    await Bun.sleep(1)
    expect(retained!.copyRGB()[0]).toBe(7)
    retained!.release()
    expect(c.stats().leased).toBe(0)
  } finally {
    retained?.release()
    await c.close()
  }
})
test('pre callback errors disable only the failing phase, release maps, and preserve healthy recording/captures', async () => {
  const c = cam(),
    recorder = new Recorder(null, { width: 34, height: 18 })
  const reason = Error('pre edit failed')
  let escaped: Uint8Array | undefined,
    post = 0
  try {
    c.setRequestCallbacks({
      pre(request) {
        escaped = request.mapStream().row(0)
        throw reason
      },
      post() {
        post++
      },
    })
    const recording = c.startRecording(recorder),
      first = c.captureRequestAsync(),
      next = c.captureMetadataAsync()
    const error = await failure(first)
    expect(error).toBeInstanceOf(RequestCallbackError)
    expect(error.cause).toBe(reason)
    expect(error.phase).toBe('pre')
    expect(escaped!.length).toBe(0)
    expect(c.preCallback).toBeUndefined()
    expect(c.postCallback).toBeDefined()
    expect((await next).sequence).toBeGreaterThan(0n)
    expect(post).toBeGreaterThan(0)
    expect(recording.error).toBeUndefined()
    expect(recording.frames).toBeGreaterThan(0)
    c.setRequestCallbacks({})
    expect(c.stats().leased).toBe(0)
    await recording.flushAsync()
  } finally {
    await c.close()
    await recorder.close()
  }
})
test('post callback failure discards an unpublished primary request without consuming another queued capture', async () => {
  const c = cam()
  try {
    c.postCallback = (request) => {
      request.mapStream().row(0)[0] = 23
      throw undefined
    }
    const first = c.captureRequestAsync(),
      next = c.captureMetadataAsync()
    const error = await failure(first)
    expect(error).toBeInstanceOf(RequestCallbackError)
    expect(error.phase).toBe('post')
    expect(error.cause).toBeUndefined()
    expect((await next).sequence).toBeGreaterThan(0n)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('a failed capture operation followed by a failed post hook does not reject the next queue entry', async () => {
  const c = cam(),
    reason = Error('capture operation failure')
  try {
    c.postCallback = () => {
      throw Error('post failed too')
    }
    const first = c.captureAsync(() => {
        throw reason
      }),
      next = c.captureMetadataAsync()
    expect(await failure(first)).toBe(reason)
    expect((await next).sequence).toBeGreaterThan(0n)
    expect(c.requestCallbackError?.phase).toBe('post')
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('async callbacks reject, retire escaped maps and cannot access the borrowed request after await', async () => {
  const c = cam()
  let escaped: Uint8Array | undefined,
    later: Promise<void> | undefined,
    expired: unknown
  try {
    c.preCallback = (request) =>
      (later = (async () => {
        escaped = request.mapStream().row(0)
        await Bun.sleep(1)
        try {
          request.metadata()
        } catch (error) {
          expired = error
        }
      })())
    const error = await failure(c.captureRGBAsync())
    expect(error.cause).toBeInstanceOf(TypeError)
    await later
    expect(escaped!.length).toBe(0)
    expect(expired).toMatchObject({ code: -5 })
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('callback ownership guards reject reentry while metadata, explicit retention and controls stay usable', async () => {
  const c = cam()
  let revision = 0n
  try {
    c.preCallback = (request) => {
      for (const action of [
        () => c.acquire(100),
        () => c.stop(),
        () => c.close(),
        () => c.captureRequestAsync(),
        () => c.switchMode({ width: 64, height: 48 }),
        () => c.autofocusAsync(),
        () => c.startContinuousAutofocus(),
        () => c.setRequestCallbacks({}),
      ])
        expect(action).toThrow('inside request callback')
      expect(request.metadata().sequence).toBe(request.sequence)
      const exposure = request
        .controls()
        .records.find((record) => record.appId === 2)!
      revision = request.setNativeControls([
        { id: exposure.id, kind: 'int32', value: 2345 },
      ])
    }
    await c.captureMetadata()
    c.setRequestCallbacks({})
    let metadata = await c.captureMetadata()
    for (let i = 0; metadata.controlRevision < revision && i < 8; i++)
      metadata = await c.captureMetadata()
    expect(metadata.exposureUs).toBe(2345)
    expect(metadata.controlRevision).toBeGreaterThanOrEqual(revision)
  } finally {
    await c.close()
  }
})
test('cancellation inside pre does not execute a cancelled capture operation', async () => {
  const c = cam()
  let operation = 0
  try {
    const reason = Error('cancel from pre')
    const first = c.captureAsync(() => {
      operation++
    })
    c.preCallback = () => {
      first.cancel(reason)
    }
    expect(await failure(first)).toBe(reason)
    c.setRequestCallbacks({})
    expect(operation).toBe(0)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('callbacks alone drive the started pump, stop cleanly and resume on restart', async () => {
  const c = cam()
  let frames = 0
  try {
    c.preCallback = () => {
      frames++
    }
    await Bun.sleep(2)
    expect(frames).toBe(0)
    c.start()
    await until(() => frames >= 3)
    await c.stop()
    const stopped = frames
    await Bun.sleep(3)
    expect(frames).toBe(stopped)
    c.start()
    await until(() => frames > stopped)
    c.setRequestCallbacks({})
    const cleared = frames
    await Bun.sleep(3)
    expect(frames).toBe(cleared)
  } finally {
    await c.close()
  }
})
test('temporary mode warmup and capture hooks run on the main thread with pre-copy/post-edit order', async () => {
  const c = cam(),
    events: string[] = []
  let escaped: Uint8Array | undefined
  try {
    c.setRequestCallbacks({
      pre(request) {
        events.push(`pre:${request.width}`)
        escaped = request.mapStream().row(0)
        escaped.set([21, 22, 23])
      },
      post(request) {
        events.push(`post:${request.width}`)
        expect(escaped!.length).toBe(0)
        request.withMappedStream((map) => map.row(0).set([91, 92, 93]))
      },
    })
    const data = await c.switchModeAndCaptureRGB(
      { width: 64, height: 48 },
      { dropFrames: 2 },
    )
    expect([...data.subarray(0, 3)]).toEqual([21, 22, 23])
    expect(events).toEqual([
      'pre:64',
      'post:64',
      'pre:64',
      'post:64',
      'pre:64',
      'post:64',
    ])
    expect(c.info().width).toBe(34)
    expect(c.stats().leased).toBe(0)
    c.setRequestCallbacks({})
  } finally {
    await c.close()
  }
})
test('mode hook errors preserve the original cause, close maps and restore the previous camera', async () => {
  const c = cam(),
    reason = Error('temporary edit failed')
  let escaped: Uint8Array | undefined
  try {
    c.preCallback = (request) => {
      escaped = request.mapStream().row(0)
      throw reason
    }
    const error = await failure(
      c.switchModeAndCaptureRGB({ width: 64, height: 48 }),
    )
    expect(error).toBeInstanceOf(RequestCallbackError)
    expect(error.cause).toBe(reason)
    expect(error.restoreCode).toBe(0)
    expect(escaped!.length).toBe(0)
    expect(c.info().width).toBe(34)
    expect(c.stats().leased).toBe(0)
    expect((await c.captureRGB()).length).toBe(34 * 18 * 3)
  } finally {
    await c.close()
  }
})
test('cancellation after a worker callback claim waits for scope retirement before restoring', async () => {
  const c = cam(),
    reason = Error('cancel active mode hook')
  let job: ReturnType<Camera['switchModeAndCaptureRGB']> | undefined,
    escaped: Uint8Array | undefined,
    calls = 0
  try {
    c.preCallback = (request) => {
      calls++
      escaped = request.mapStream().row(0)
      escaped[0] = 71
      expect(job!.cancel(reason)).toBe(true)
      Bun.sleepSync(25)
      expect(escaped[0]).toBe(71)
      expect(request.metadata().sequence).toBe(request.sequence)
    }
    job = c.switchModeAndCaptureRGB({ width: 64, height: 48 })
    expect(await failure(job)).toBe(reason)
    await job.operationDone
    c.setRequestCallbacks({})
    expect(calls).toBe(1)
    expect(escaped!.length).toBe(0)
    expect(c.info().width).toBe(34)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('mode callbacks can change target controls while temporary restoration preserves prior intent', async () => {
  const c = cam()
  let changed = false
  try {
    c.setControls([{ id: 2, type: 'int', values: [1234] }])
    c.preCallback = (request) => {
      if (!changed) {
        const exposure = request
          .controls()
          .records.find((record) => record.appId === 2)!
        request.setNativeControls([
          { id: exposure.id, kind: 'int32', value: 3456 },
        ])
        changed = true
      }
    }
    const metadata = await c.switchModeAndCaptureMetadata(
      { width: 64, height: 48 },
      { dropFrames: 3 },
    )
    expect(metadata.exposureUs).toBe(3456)
    c.setRequestCallbacks({})
    expect((await c.captureMetadata()).exposureUs).toBe(1234)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('retained worker callback requests stay valid when they explicitly prevent mode restoration', async () => {
  const c = cam()
  let retained: Frame | undefined
  try {
    c.preCallback = (request) => {
      retained ??= request.retain()
    }
    const error = await failure(
      c.switchModeAndCaptureRGB({ width: 64, height: 48 }),
    )
    expect(error).toMatchObject({ restoreCode: -4 })
    expect(retained!.width).toBe(64)
    expect(retained!.copyRGB().length).toBe(64 * 48 * 3)
    retained!.release()
    c.setRequestCallbacks({})
    await c.switchMode({ width: 34, height: 18 })
    expect(c.stats().leased).toBe(0)
  } finally {
    retained?.release()
    await c.close()
  }
})

test('unclaimed worker callbacks cancel without using late frame messages', async () => {
  const c = cam(),
    RealWorker = globalThis.Worker,
    reason = Error('cancel unclaimed hook')
  let late: (() => void) | undefined,
    callbacks = 0
  const WrappedWorker = function (url: string | URL, options?: WorkerOptions) {
    const inner = new RealWorker(url, options)
    return new (class {
      onmessage?: (event: MessageEvent) => void
      onerror?: (event: ErrorEvent) => void
      constructor() {
        inner.onmessage = (event) => {
          if (event.data?.kind === 'request-hook' && !late) {
            late = () => this.onmessage?.(event)
            return
          }
          this.onmessage?.(event)
        }
        inner.onerror = (event) => this.onerror?.(event)
      }
      postMessage(value: unknown) {
        inner.postMessage(value)
      }
      terminate() {
        inner.terminate()
      }
    })()
  } as unknown as typeof Worker
  try {
    globalThis.Worker = WrappedWorker
    c.preCallback = () => {
      callbacks++
    }
    const job = c.switchModeAndCaptureRGB({ width: 64, height: 48 })
    await until(() => !!late)
    job.cancel(reason)
    expect(await failure(job)).toBe(reason)
    await job.operationDone
    late!()
    expect(callbacks).toBe(0)
    expect(c.info().width).toBe(34)
    expect(c.stats().leased).toBe(0)
    c.setRequestCallbacks({})
  } finally {
    globalThis.Worker = RealWorker
    await c.close()
  }
})
test('failed scoped cleanup preserves bounded recovery handles across callback replacement', async () => {
  const c = cam()
  let blocked = true,
    escaped: Uint8Array | undefined
  try {
    c.preCallback = (request) => {
      const mapped = request.mapStream(),
        close = mapped.close.bind(mapped)
      escaped = mapped.row(0)
      escaped[0] = 44
      mapped.close = () => {
        if (blocked) throw Error('retirement blocked')
        close()
      }
    }
    const error = await failure(c.captureMetadataAsync())
    expect(error).toBeInstanceOf(RequestCallbackError)
    expect(error.unclosedMappings.length).toBe(1)
    expect(c.requestCallbackMappings.length).toBe(1)
    expect(c.stats().leased).toBe(1)
    expect(escaped![0]).toBe(44)
    c.setRequestCallbacks({})
    expect(c.requestCallbackMappings.length).toBe(1)
    blocked = false
    c.retryRequestCallbackCleanup()
    expect(c.requestCallbackMappings.length).toBe(0)
    expect(escaped!.length).toBe(0)
    expect(c.stats().leased).toBe(0)
  } finally {
    blocked = false
    await c.close()
  }
})
test('stop joins recoverable callback mappings rather than orphaning their native owner', async () => {
  const c = cam()
  let blocked = true,
    escaped: Uint8Array | undefined
  try {
    c.preCallback = (request) => {
      const mapped = request.mapStream(),
        close = mapped.close.bind(mapped)
      escaped = mapped.row(0)
      mapped.close = () => {
        if (blocked) throw Error('blocked')
        close()
      }
    }
    expect(await failure(c.captureMetadataAsync())).toBeInstanceOf(
      RequestCallbackError,
    )
    blocked = false
    await c.stop()
    expect(escaped!.length).toBe(0)
    expect(c.requestCallbackMappings.length).toBe(0)
    expect(c.stats().leased).toBe(0)
  } finally {
    blocked = false
    await c.close()
  }
})
test('post callbacks still run when a temporary capture file fails, before mode restoration', async () => {
  const c = cam(),
    events: string[] = []
  try {
    c.setRequestCallbacks({
      pre: (request) => {
        events.push(`pre:${request.width}`)
      },
      post: (request) => {
        events.push(`post:${request.width}`)
      },
    })
    const error = await failure(
      c.switchModeAndCaptureFile(
        { width: 64, height: 48 },
        '/zig-camera-missing-directory/hooks/test.jpg',
      ),
    )
    expect(error).toMatchObject({ code: -6 })
    expect(events).toEqual(['pre:64', 'post:64'])
    expect(c.info().width).toBe(34)
    c.setRequestCallbacks({})
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('coordinated recorder mode warmup and focus-locked capture use the same callback scopes', async () => {
  const c = cam(),
    recorder = new Recorder(null, { width: 34, height: 18 })
  const seen = new Set<number>()
  try {
    c.preCallback = (request) => {
      seen.add(request.width)
      request.withMappedStream((map) => (map.row(0)[0] = 61))
    }
    const recording = c.startRecording(recorder)
    const next = await recording.switchModeAsync(
      { width: 64, height: 48 },
      {},
      null,
      { dropFrames: 2 },
    )
    expect(seen.has(64)).toBe(true)
    expect((await c.captureRGB())[0]).toBe(61)
    await next.flushAsync()
    c.startContinuousAutofocus()
    expect((await c.captureFocusLockedRGB())[0]).toBe(61)
    c.setRequestCallbacks({})
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    await recorder.close()
  }
})
const previewTest = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
previewTest(
  'preview receives post edits only after mapped scopes close',
  async () => {
    const c = cam(),
      show = native.zc_preview_show_stream
    const seen: number[][] = []
    try {
      native.zc_preview_show_stream = (...args) => {
        const frame = new Uint8Array(456)
        new DataView(frame.buffer).setBigUint64(0, args[2] as bigint, true)
        expect(
          ffi.zc_get_stream(args[1], args[2], args[3], ptr(frame.subarray(40))),
        ).toBe(0)
        expect(ffi.zc_frame_readable(args[1], args[2])).toBe(0)
        seen.push(pixel(ptr(frame)))
        return show(...args)
      }
      c.setRequestCallbacks({
        pre: (request) => {
          request.mapStream().row(0).set([1, 2, 3])
        },
        post: (request) => {
          request.mapStream().row(0).set([4, 5, 6])
        },
      })
      c.startPreview('callback order')
      const rgb = await c.captureRGB()
      c.setRequestCallbacks({})
      expect([...rgb.subarray(0, 3)]).toEqual([1, 2, 3])
      expect(seen[0]).toEqual([4, 5, 6])
    } finally {
      native.zc_preview_show_stream = show
      await c.close()
    }
  },
)

test('mode callback control writes reserve rollback revisions before maximum-u64 exhaustion', async () => {
  const source = cam(),
    c = cam(),
    maximum = 0xffffffffffffffffn
  try {
    source.setNativeControls([{ id: 2, kind: 'int32', value: 1234 }])
    const snapshot = source.nativeControlSnapshot()
    c.restoreNativeControls({
      revision: maximum - 10n,
      controls: snapshot.controls,
    })
    const before = c.nativeControlSnapshot().revision
    c.preCallback = (request) => {
      request.setNativeControls([{ id: 2, kind: 'int32', value: 2345 }])
    }
    const error = await failure(
      c.switchModeAndCaptureMetadata({ width: 64, height: 48 }),
    )
    expect(error).toBeInstanceOf(RequestCallbackError)
    expect(error.cause).toMatchObject({ code: -2 })
    expect(error.restoreCode).toBe(0)
    expect(c.nativeControlSnapshot().revision).toBe(before + 2n)
    expect(c.nativeControlSnapshot().revision).toBeLessThanOrEqual(maximum)
    expect((await c.captureMetadata()).exposureUs).toBe(1234)
  } finally {
    await source.close()
    await c.close()
  }
})
