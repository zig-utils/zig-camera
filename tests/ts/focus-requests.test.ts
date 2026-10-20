import { expect, test } from 'bun:test'
import { Camera, Frame, JobCancelledError, Recorder } from '../../ts'
import { native as ffi } from '../../ts/ffi'
const native: {
  zc_autofocus_pause_restore: (
    ...args: Parameters<typeof ffi.zc_autofocus_pause_restore>
  ) => number
  zc_release: (...args: Parameters<typeof ffi.zc_release>) => number
} = ffi
const cam = (buffers = 3) =>
  new Camera({
    simulate: true,
    width: 64,
    height: 48,
    buffers,
    fifo: true,
    raw: true,
    unpackedRaw: true,
    lores: { width: 16, height: 8 },
  })
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
const pause = () => new Promise<void>((r) => setTimeout(r, 1))
async function running(c: Camera) {
  for (let i = 0; i < 64; i++) {
    const m = await c.captureMetadata()
    if (m.afPauseState === 0) return m
  }
  throw Error('CAF did not resume')
}

test('focus-locked requests retain a paused frame through CAF restoration and async processing', async () => {
  const c = cam(2)
  let request: Frame | undefined, child: Frame | undefined
  try {
    c.startContinuousAutofocus()
    const job = c.captureFocusLockedRequestAsync()
    request = await job
    expect(job.cancel()).toBe(false)
    expect(request.referenceCount).toBe(1)
    const m = request.metadata(),
      pixels = request.copyRGB()
    expect(m).toMatchObject({ afState: 2, afPauseState: 2 })
    expect(m.validMask & 33).toBe(33)
    expect(c.controlSnapshot().revision).toBeGreaterThan(m.controlRevision)
    child = request.retain()
    request.release()
    await running(c)
    await pause()
    expect(child.metadata()).toEqual(m)
    expect(child.copyRGB()).toEqual(pixels)
    expect(child.copyStreams(['main', 'raw', 'lores']).metadata).toEqual(m)
    expect(c.stats().leased).toBe(1)
    expect(
      await failure(c.switchMode({ width: 128, height: 96 })),
    ).toMatchObject({ code: -4 })
    child.release()
    expect(c.stats().leased).toBe(0)
    await c.switchMode({ width: 128, height: 96 })
  } finally {
    request?.release()
    child?.release()
    await c.close()
  }
})
test('focus-locked stream bundles copy selected streams from the same focused request', async () => {
  const c = cam()
  try {
    c.startContinuousAutofocus()
    const names: ('main' | 'raw' | 'lores')[] = ['main', 'raw', 'lores']
    const job = c.captureFocusLockedStreamsAsync(names)
    names.splice(0)
    const bundle = await job
    expect(bundle.metadata).toMatchObject({ afState: 2, afPauseState: 2 })
    expect(bundle.streams.main!.data.length).toBe(64 * 48 * 3)
    expect(bundle.streams.raw!.data.length).toBe(64 * 48 * 2)
    expect(bundle.streams.lores!.data.length).toBe(192)
    const original = bundle.streams.main!.data.slice()
    await running(c)
    expect(bundle.streams.main!.data).toEqual(original)
    expect(c.stats().leased).toBe(0)
    expect(() => c.captureFocusLockedStreamsAsync([])).toThrow(RangeError)
    expect(() => c.captureFocusLockedStreamsAsync(['main', 'main'])).toThrow(
      RangeError,
    )
    expect(
      (await c.captureFocusLockedStreams(['lores'])).metadata.afPauseState,
    ).toBe(2)
  } finally {
    await c.close()
  }
})
test('a request captured while already paused preserves paused intent', async () => {
  const c = cam()
  try {
    c.startContinuousAutofocus()
    await c.autofocusPauseAsync()
    using request = await c.captureFocusLockedRequest()
    expect(request.metadata().afPauseState).toBe(2)
    for (let i = 0; i < 6; i++)
      expect((await c.captureMetadata()).afPauseState).toBe(2)
    await c.autofocusResumeAsync()
    expect((await running(c)).afPauseState).toBe(0)
    expect(request.metadata().afPauseState).toBe(2)
  } finally {
    await c.close()
  }
})
test('cancelling a private request during CAF restoration retires its transferred reference', async () => {
  const c = cam(),
    original = native.zc_autofocus_pause_restore
  let cancel: (() => void) | undefined
  let selectedLeases = 0
  try {
    c.startContinuousAutofocus()
    native.zc_autofocus_pause_restore = (...args) => {
      selectedLeases = c.stats().leased
      const rc = original(...args)
      cancel!()
      return rc
    }
    const job = c.captureFocusLockedRequestAsync()
    cancel = () => {
      expect(job.cancel()).toBe(true)
    }
    expect(await failure(job)).toBeInstanceOf(JobCancelledError)
    await job.operationDone
    expect(selectedLeases).toBe(1)
    expect(c.stats().leased).toBe(0)
    native.zc_autofocus_pause_restore = original
    await running(c)
    using next = await c.captureFocusLockedRequest()
    expect(next.metadata().afState).toBe(2)
  } finally {
    native.zc_autofocus_pause_restore = original
    await c.close()
  }
})
test('failed restoration releases unpublished requests and permits explicit recovery', async () => {
  const c = cam(),
    original = native.zc_autofocus_pause_restore
  let captured = false
  try {
    c.startContinuousAutofocus()
    native.zc_autofocus_pause_restore = () => {
      captured = c.stats().leased === 1
      return -6
    }
    expect(await failure(c.captureFocusLockedRequestAsync())).toMatchObject({
      code: -6,
    })
    expect(captured).toBe(true)
    expect(c.stats().leased).toBe(0)
    native.zc_autofocus_pause_restore = original
    expect(await c.autofocusResumeAsync()).toBe(3)
    using request = await c.captureFocusLockedRequest()
    expect(request.metadata().afState).toBe(2)
  } finally {
    native.zc_autofocus_pause_restore = original
    await c.close()
  }
})
test('restoration submission failure during cancellation retires the original pending AF command', async () => {
  const c = cam(),
    original = native.zc_autofocus_pause_restore
  try {
    c.startContinuousAutofocus()
    native.zc_autofocus_pause_restore = () => -6
    const job = c.captureFocusLockedRequestAsync()
    job.cancel()
    expect(await failure(job)).toMatchObject({ restorationError: { code: -6 } })
    native.zc_autofocus_pause_restore = original
    expect(c.stats().leased).toBe(0)
    expect(await c.autofocusResumeAsync()).toBe(3)
  } finally {
    native.zc_autofocus_pause_restore = original
    await c.close()
  }
})
test('private request cleanup preserves both restoration and DMA release errors', async () => {
  const c = cam(),
    restore = native.zc_autofocus_pause_restore,
    release = native.zc_release
  let selected = false
  try {
    c.startContinuousAutofocus()
    native.zc_autofocus_pause_restore = () => {
      selected = true
      return -6
    }
    native.zc_release = (...args) => {
      const rc = release(...args)
      return selected && !rc ? -9 : rc
    }
    const error = await failure(c.captureFocusLockedRequestAsync())
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toMatchObject([{ code: -6 }, { code: -9 }])
    expect(c.stats().leased).toBe(0)
  } finally {
    native.zc_autofocus_pause_restore = restore
    native.zc_release = release
    await c.close()
  }
})
test('restoration backpressure discards the private request without releasing caller-owned frames', async () => {
  const c = cam(2)
  let held: Frame | undefined
  try {
    c.startContinuousAutofocus()
    held = await c.captureRequest()
    expect(
      await failure(c.captureFocusLockedRequestAsync({ restoreTimeoutMs: 10 })),
    ).toMatchObject({ code: -3 })
    expect(c.stats().leased).toBe(1)
    expect(held.referenceCount).toBe(1)
    held.release()
    expect(await c.autofocusResumeAsync()).toBe(3)
    using request = await c.captureFocusLockedRequest()
    expect(request.metadata().afState).toBe(2)
  } finally {
    held?.release()
    await c.close()
  }
})
test('pre-aborted focus requests do not submit controls or acquire leases', async () => {
  const c = cam(),
    controller = new AbortController()
  try {
    c.startContinuousAutofocus()
    const revision = c.controlSnapshot().revision
    controller.abort(Error('not admitted'))
    expect(
      await failure(
        c.captureFocusLockedRequestAsync({ signal: controller.signal }),
      ),
    ).toBe(controller.signal.reason)
    expect(
      await failure(c.captureFocusLockedRequestAsync({ timeoutMs: 0 })),
    ).toMatchObject({ code: -3 })
    expect(c.controlSnapshot().revision).toBe(revision)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('focus request publication does not wait for user completion callbacks', async () => {
  const c = cam()
  let finish!: () => void
  const callback = new Promise<void>((r) => {
    finish = r
  })
  let request: Frame | undefined
  try {
    c.startContinuousAutofocus()
    const job = c.captureFocusLockedRequestAsync({
      signalFunction: async (completed) => {
        expect(completed.value?.metadata().afPauseState).toBe(2)
        await callback
      },
    })
    request = await job
    await job.operationDone
    expect(job.cancel()).toBe(false)
    expect((await running(c)).afPauseState).toBe(0)
    expect(request.metadata().afPauseState).toBe(2)
    request.release()
    finish()
    await job.cleanupDone
    expect(job.callbackError).toBeUndefined()
  } finally {
    finish()
    request?.release()
    await c.close()
  }
})
test('a focus-locked request remains stable while async recording consumes later frames', async () => {
  const c = cam(),
    r = await Recorder.open(
      { outputframe() {} },
      { width: 64, height: 48, asyncWrites: true },
    )
  let request: Frame | undefined
  try {
    c.startContinuousAutofocus()
    const recording = c.startRecording(r)
    request = await c.captureFocusLockedRequest()
    const m = request.metadata(),
      before = recording.frames
    const deadline = performance.now() + 5000
    while (recording.frames < before + 4) {
      if (performance.now() > deadline) throw Error('recording stalled')
      await pause()
    }
    expect(request.metadata()).toEqual(m)
    expect(m.afPauseState).toBe(2)
    request.release()
    await recording.flushAsync()
    expect(recording.error).toBeUndefined()
    expect(BigInt(recording.frames)).toBe(c.stats().delivered)
  } finally {
    request?.release()
    await c.close()
    await r.close()
  }
})

for (const close of [false, true]) {
  test(`camera ${close ? 'close' : 'stop'} joins a private focus request's restoration and discard`, async () => {
    const c = cam(),
      original = native.zc_autofocus_pause_restore
    let teardown: Promise<void> | undefined
    let privateLeases = 0
    try {
      c.startContinuousAutofocus()
      native.zc_autofocus_pause_restore = (...args) => {
        privateLeases = c.stats().leased
        const rc = original(...args)
        teardown = close ? c.close() : c.stop()
        return rc
      }
      const job = c.captureFocusLockedRequestAsync()
      expect(await failure(job)).toMatchObject({ code: -2 })
      await job.operationDone
      await teardown
      expect(privateLeases).toBe(1)
      native.zc_autofocus_pause_restore = original
      if (!close) {
        expect(c.stats().leased).toBe(0)
        c.start()
        using next = await c.captureFocusLockedRequest()
        expect(next.metadata().afState).toBe(2)
      }
    } finally {
      native.zc_autofocus_pause_restore = original
      await teardown
      await c.close()
    }
  })
}

test('focus request handoff requires no extra reference-table entry', async () => {
  const c = cam(2),
    refs: Frame[] = []
  try {
    c.startContinuousAutofocus()
    const first = await c.captureRequest()
    refs.push(first)
    while (true) {
      try {
        refs.push(first.retain())
      } catch (error) {
        expect(error).toMatchObject({ code: -4 })
        break
      }
    }
    expect(refs.length).toBe(255)
    // One remaining table entry can select the request, but no physical buffer
    // remains for restoration. Failure must discard just that private owner.
    expect(
      await failure(c.captureFocusLockedRequestAsync({ restoreTimeoutMs: 10 })),
    ).toMatchObject({ code: -3 })
    expect(first.referenceCount).toBe(255)
    expect(c.stats().leased).toBe(1)
    first.release()
    expect(refs[1].referenceCount).toBe(254)
    for (const ref of refs) ref.release()
    expect(await c.autofocusResumeAsync()).toBe(3)
  } finally {
    for (const ref of refs) ref.release()
    await c.close()
  }
})

test('a frozen cancellation reason preserves restoration errors and releases the private request', async () => {
  const c = cam(),
    original = native.zc_autofocus_pause_restore
  const reason = Object.freeze(Error('frozen abort'))
  let cancel: (() => void) | undefined
  try {
    c.startContinuousAutofocus()
    native.zc_autofocus_pause_restore = () => {
      cancel!()
      return -6
    }
    const job = c.captureFocusLockedRequestAsync()
    cancel = () => {
      job.cancel(reason)
    }
    const error = await failure(job)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors[0]).toBe(reason)
    expect(error.errors[1]).toMatchObject({ code: -6 })
    expect(c.stats().leased).toBe(0)
  } finally {
    native.zc_autofocus_pause_restore = original
    await c.close()
  }
})
