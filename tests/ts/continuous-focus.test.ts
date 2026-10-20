import { expect, test } from 'bun:test'
import { Camera, Control, Recorder, JobCancelledError } from '../../ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const cam = (buffers = 4) =>
  new Camera({
    simulate: true,
    width: 64,
    height: 48,
    fifo: true,
    buffers,
    lores: { width: 16, height: 8 },
    raw: true,
    unpackedRaw: true,
  })
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
const pause = () => new Promise<void>((r) => setTimeout(r, 1))
async function until(fn: () => boolean) {
  const deadline = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > deadline) throw Error('timeout')
    await pause()
  }
}
async function metadata(
  c: Camera,
  predicate: (m: Awaited<ReturnType<Camera['captureMetadata']>>) => boolean,
) {
  for (let i = 0; i < 64; i++) {
    const m = await c.captureMetadata()
    if (predicate(m)) return m
  }
  throw Error('expected metadata did not arrive')
}

test('continuous pause/resume jobs require explicit CAF mode and acknowledge current metadata', async () => {
  const c = cam()
  try {
    expect(await failure(c.autofocusPauseAsync())).toMatchObject({ code: -2 })
    c.startContinuousAutofocus()
    const before = c.controlSnapshot().revision
    const job = c.autofocusPauseAsync()
    expect(await job).toBe(3)
    expect(job.done).toBe(true)
    const m = await metadata(
      c,
      (m) => m.afPauseState === 2 && m.controlRevision > before,
    )
    expect(m.validMask & 32).toBe(32)
    expect(m.afState).toBe(2)
    expect(await c.autofocusResumeAsync()).toBe(3)
    expect(
      (await metadata(c, (m) => m.afPauseState === 0)).validMask & 32,
    ).toBe(32)
    expect(
      c.controlSnapshot().controls.some((x) => x.id === Control.afPause),
    ).toBe(false)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('immediate pause can freeze an incomplete scan without claiming focus success', async () => {
  const c = cam(2)
  try {
    c.startContinuousAutofocus()
    expect(await c.autofocusPauseAsync({ immediate: true })).toBe(3)
    const m = await metadata(c, (m) => m.afPauseState === 2)
    expect(m.afState).toBe(1)
    expect(await c.autofocusResumeAsync()).toBe(3)
    expect((await metadata(c, (m) => m.afState === 2)).afPauseState).toBe(0)
  } finally {
    await c.close()
  }
})
test('active pause cancellation restores prior running intent and releases native ownership', async () => {
  const c = cam()
  try {
    c.startContinuousAutofocus()
    const job = c.autofocusPauseAsync(),
      result = failure(job)
    expect(() => c.autofocusResumeAsync()).toThrow('camera jobs active')
    expect(job.cancel()).toBe(true)
    expect(await result).toBeInstanceOf(JobCancelledError)
    expect((await metadata(c, (m) => m.afPauseState === 0)).afPauseState).toBe(
      0,
    )
    expect(await c.autofocusPauseAsync()).toBe(3)
    expect(await c.autofocusResumeAsync()).toBe(3)
  } finally {
    await c.close()
  }
})
test('pause and resume jobs participate in mode-switch wait and cancel policies', async () => {
  const c = cam()
  try {
    c.startContinuousAutofocus()
    const first = c.autofocusPauseAsync()
    await c.switchMode({ width: 128, height: 96 }, { autofocusPolicy: 'wait' })
    expect(await first).toBe(3)
    expect((await metadata(c, (m) => m.afPauseState === 0)).afPauseState).toBe(
      0,
    )
    const next = c.autofocusPauseAsync(),
      result = failure(next)
    await c.switchMode({ width: 64, height: 48 })
    expect(await result).toBeInstanceOf(JobCancelledError)
    expect(await c.autofocusPauseAsync()).toBe(3)
    expect(await c.autofocusResumeAsync()).toBe(3)
  } finally {
    await c.close()
  }
})
test('focus-locked metadata capture returns a focused paused frame and restores running intent', async () => {
  const c = cam()
  try {
    c.startContinuousAutofocus()
    const original = c.controlSnapshot().revision
    const job = c.captureFocusLockedMetadata()
    expect(() =>
      c.setControls([{ id: Control.afMode, type: 'int', values: [0] }]),
    ).toThrow('focus-locked')
    expect(() => c.switchMode({ width: 128, height: 96 })).toThrow(
      'camera jobs active',
    )
    const m = await job
    expect(m.afState).toBe(2)
    expect(m.afPauseState).toBe(2)
    expect(m.validMask & 33).toBe(33)
    expect(m.controlRevision).toBeGreaterThan(original)
    expect(c.controlSnapshot().revision).toBeGreaterThan(m.controlRevision)
    expect((await metadata(c, (m) => m.afPauseState === 0)).afPauseState).toBe(
      0,
    )
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('owned RGB, lores and JPEG/DNG focus-locked results share the lock and restore contract', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-caf-'))
  try {
    c.startContinuousAutofocus()
    expect((await c.captureFocusLockedRGB()).length).toBe(64 * 48 * 3)
    expect((await c.captureFocusLockedBuffer('lores')).data.length).toBe(192)
    for (const extension of ['jpg', 'dng']) {
      const path = join(dir, `focus.${extension}`),
        m = await c.captureFocusLockedFile(path)
      expect(m.afPauseState).toBe(2)
      expect(m.afState).toBe(2)
      expect(readFileSync(path).length).toBeGreaterThan(100)
    }
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('focus lock restores an already paused source to paused rather than unconditionally resuming', async () => {
  const c = cam()
  try {
    c.startContinuousAutofocus()
    await c.autofocusPauseAsync()
    expect((await c.captureFocusLockedMetadata()).afPauseState).toBe(2)
    expect(
      (
        await metadata(
          c,
          (m) => m.controlRevision === c.controlSnapshot().revision,
        )
      ).afPauseState,
    ).toBe(2)
    await c.autofocusResumeAsync()
  } finally {
    await c.close()
  }
})
test('immediate locked capture explicitly permits unfocused frozen frames only when requested', async () => {
  const c = cam(2)
  try {
    c.startContinuousAutofocus()
    expect(
      await failure(c.captureFocusLockedMetadata({ immediate: true })),
    ).toMatchObject({ code: -2 })
    expect((await metadata(c, (m) => m.afPauseState === 0)).afPauseState).toBe(
      0,
    )
    await c.stop()
    c.start()
    const m = await c.captureFocusLockedMetadata({
      immediate: true,
      requireFocused: false,
    })
    expect(m.afPauseState).toBe(2)
    expect(m.afState).toBe(1)
  } finally {
    await c.close()
  }
})
test('callback errors release the selected lease and restore CAF before rejection', async () => {
  const c = cam()
  try {
    c.startContinuousAutofocus()
    const reason = Error('capture failed'),
      result = await failure(
        c.captureFocusLockedAsync(() => {
          throw reason
        }),
      )
    expect(result).toBe(reason)
    expect((await metadata(c, (m) => m.afPauseState === 0)).afPauseState).toBe(
      0,
    )
    expect(c.stats().leased).toBe(0)
    expect((await c.captureFocusLockedMetadata()).afState).toBe(2)
  } finally {
    await c.close()
  }
})
test('active focus-lock cancellation restores CAF before operationDone', async () => {
  const c = cam()
  try {
    c.startContinuousAutofocus()
    const job = c.captureFocusLockedMetadata(),
      result = failure(job)
    expect(job.cancel()).toBe(true)
    expect(await result).toBeInstanceOf(JobCancelledError)
    await job.operationDone
    expect((await metadata(c, (m) => m.afPauseState === 0)).afPauseState).toBe(
      0,
    )
    expect((await c.captureFocusLockedMetadata()).afState).toBe(2)
  } finally {
    await c.close()
  }
})
test('pre-cancelled jobs and invalid options do not submit pause commands', async () => {
  const c = cam(),
    controller = new AbortController()
  try {
    c.startContinuousAutofocus()
    const revision = c.controlSnapshot().revision
    controller.abort(Error('aborted'))
    expect(
      await failure(
        c.captureFocusLockedMetadata({ signal: controller.signal }),
      ),
    ).toBe(controller.signal.reason)
    expect(
      await failure(c.autofocusPauseAsync({ timeoutMs: 0 })),
    ).toMatchObject({ code: -3 })
    expect(() =>
      c.captureFocusLockedMetadata({ restoreTimeoutMs: NaN }),
    ).toThrow(RangeError)
    // @ts-expect-error Validate JavaScript callers too.
    expect(() => c.autofocusPauseAsync({ immediate: 'yes' })).toThrow(
      RangeError,
    )
    expect(c.controlSnapshot().revision).toBe(revision)
  } finally {
    await c.close()
  }
})
for (const close of [false, true]) {
  test(`camera ${close ? 'close' : 'stop'} joins pause and focus-capture cleanup before releasing the handle`, async () => {
    for (const capture of [false, true]) {
      const c = cam()
      try {
        c.startContinuousAutofocus()
        const job = capture
            ? c.captureFocusLockedMetadata()
            : c.autofocusPauseAsync(),
          result = failure(job)
        if (close) await c.close()
        else await c.stop()
        expect(await result).toMatchObject({ code: -2 })
        expect(job.done).toBe(true)
        if (!close) {
          c.start()
          expect((await c.captureFocusLockedMetadata()).afState).toBe(2)
        }
      } finally {
        await c.close()
      }
    }
  })
}
test('focus-locked capture shares recording frames and preserves async producer progress', async () => {
  const c = cam(),
    r = await Recorder.open(
      { outputframe() {} },
      { width: 64, height: 48, asyncWrites: true },
    )
  try {
    c.startContinuousAutofocus()
    const recording = c.startRecording(r)
    await until(() => recording.frames > 1)
    const before = recording.frames
    expect((await c.captureFocusLockedMetadata()).afPauseState).toBe(2)
    await until(() => recording.frames > before + 2)
    await recording.flushAsync()
    expect(recording.error).toBeUndefined()
    expect(BigInt(recording.frames)).toBe(c.stats().delivered)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    await r.close()
  }
})
const preview = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
preview(
  'continuous AF lock and restore coexist with the SDL preview pump',
  async () => {
    const c = cam()
    try {
      c.startContinuousAutofocus()
      c.startPreview('CAF lock')
      expect((await c.captureFocusLockedMetadata()).afPauseState).toBe(2)
      expect(await c.autofocusPauseAsync()).toBe(3)
      expect(await c.autofocusResumeAsync()).toBe(3)
    } finally {
      await c.close()
    }
  },
)

test('focus restoration deadlines retire native jobs and expose a usable explicit resume path', async () => {
  const c = cam()
  try {
    c.startContinuousAutofocus()
    const result = await failure(
      c.captureFocusLockedMetadata({ restoreTimeoutMs: 0 }),
    )
    expect(result).toMatchObject({ code: -3 })
    expect(c.stats().leased).toBe(0)
    expect(await c.autofocusResumeAsync()).toBe(3)
    expect((await c.captureFocusLockedMetadata()).afPauseState).toBe(2)
  } finally {
    await c.close()
  }
})
test('async capture callbacks reject without retaining leases and CAF is restored', async () => {
  const c = cam()
  try {
    c.startContinuousAutofocus()
    expect(
      await failure(c.captureFocusLockedAsync(async () => 42)),
    ).toBeInstanceOf(TypeError)
    expect((await metadata(c, (m) => m.afPauseState === 0)).afPauseState).toBe(
      0,
    )
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('cancellation after pause acknowledgement skips the capture callback and restores CAF', async () => {
  const c = cam()
  try {
    c.startContinuousAutofocus()
    let calls = 0
    const job = c.captureFocusLockedAsync(() => {
        calls++
      }),
      result = failure(job)
    // FFI observers consume no frame; the Bun continuation has not yet selected
    // its capture when the acknowledgement becomes visible during frame release.
    const { native, ptr } = await import('../../ts/ffi'),
      state = new Uint32Array(1)
    for (let i = 0; i < 20; i++) {
      using frame = c.acquire()
      frame.release()
      if (native.zc_autofocus_wait(c.handle, 1n, 0, ptr(state)) === 0) break
    }
    expect(state[0]).toBe(3)
    expect(job.cancel()).toBe(true)
    expect(await result).toBeInstanceOf(JobCancelledError)
    expect(calls).toBe(0)
    expect((await metadata(c, (m) => m.afPauseState === 0)).afPauseState).toBe(
      0,
    )
  } finally {
    await c.close()
  }
})
test('coordinated recording mode waits for continuous AF acknowledgement and reopens CAF running', async () => {
  const c = cam(),
    r = new Recorder(null, { width: 64, height: 48 })
  try {
    c.startContinuousAutofocus()
    const recording = c.startRecording(r),
      paused = c.autofocusPauseAsync()
    const next = await recording.switchModeAsync(
      { width: 128, height: 96 },
      {},
      null,
      { autofocusPolicy: 'wait' },
    )
    expect(await paused).toBe(3)
    expect((await metadata(c, (m) => m.afPauseState === 0)).afPauseState).toBe(
      0,
    )
    await next.flushAsync()
    expect(await c.autofocusPauseAsync()).toBe(3)
    expect(await c.autofocusResumeAsync()).toBe(3)
  } finally {
    await c.close()
    await r.close()
  }
})
test('focus lock reserves enough revisions for pause, restoration and cancellation before submitting commands', async () => {
  const c = cam()
  try {
    const { native, ptr } = await import('../../ts/ffi'),
      revision = new BigUint64Array(1)
    const control = new Uint8Array(144),
      v = new DataView(control.buffer)
    v.setUint32(0, Control.afMode, true)
    v.setUint32(4, 2, true)
    v.setUint32(8, 1, true)
    v.setFloat64(16, 2, true)
    expect(
      native.zc_restore_controls(
        c.handle,
        ptr(control),
        1,
        0xfffffffffffffffdn,
        ptr(revision),
      ),
    ).toBe(0)
    const before = c.controlSnapshot().revision
    expect(await failure(c.captureFocusLockedMetadata())).toMatchObject({
      code: -2,
    })
    expect(c.controlSnapshot().revision).toBe(before)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
